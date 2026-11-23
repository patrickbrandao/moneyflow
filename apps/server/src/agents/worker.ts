import type { Database } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { tasksTick } from '../services/agent-tasks';
import { requestRetentionDays } from '../services/ai-requests';
import { recipesTick } from '../services/reconcile-recipes';
import { settleWithin, tracked } from '../shutdown';
import { type IndexState, indexEmbeddings, purgeEmbeddingIndexes } from './embeddings';
import { type ClaimedRun, processRun } from './runner';
import { claimTranscriptions, processTranscription } from './transcriptions';

/*
 * Laço dos agentes no worker (spec 011): reserva execuções (ai_run_claim, SKIP
 * LOCKED; também retoma as de um worker que caiu, até max_attempts) e roda até
 * AGENT_CONCURRENCY ao mesmo tempo. Num segundo ritmo, a manutenção: retenção
 * dos eventos de streaming, expiração de confirmações esquecidas, limpeza de
 * embeddings órfãos, a retenção operacional de hora em hora (tarefa 103:
 * operational_purge), o fechamento das requisições ao provedor presas em
 * running (tarefa 162) e a purga delas (spec 023: prazo do
 * banco ou de AI_REQUEST_RETENTION_DAYS, em lotes) e os embeddings (spec
 * 024): a indexação de cada par (provedor, modelo) em uso por algum agente
 * ativo e a purga dos pares parados há mais de 7 dias. No mesmo ritmo da
 * fila de execuções, a fila das transcrições (spec 025: ai_transcription_claim,
 * até TRANSCRIPTION_CONCURRENCY ao mesmo tempo). E o laço das tarefas agendadas
 * (spec 029, AGENT_TASK_INTERVAL_MS) e a purga da dedup do webhook do Telegram.
 * No ritmo da fila e ao fim de cada execução, a fila das receitas de conciliação
 * ao importar (spec 030, recipesTick).
 *
 * A parada (tarefa 107) tem prazo: o sinal de desligamento corta a chamada ao
 * modelo em andamento e o runner devolve a execução à fila na hora (o worker
 * seguinte a reserva sem esperar a reserva velha); a parada espera as
 * execuções, as transcrições e os laços em andamento até o prazo.
 */

const TRANSCRIPTION_CONCURRENCY = 2;

const PURGE_BATCH = 1000;
/** Teto de lotes por passada das purgas e do fechamento das requisições presas (o resto fica para a seguinte). */
const MAX_ROUNDS = 1000;
/** Ritmo da retenção operacional (tarefa 103): os prazos são de dias, uma vez por hora basta. */
const OPERATIONAL_PURGE_EVERY_MS = 3_600_000;
/** Lotes de 1000 por passada da retenção operacional. */
const OPERATIONAL_PURGE_ROUNDS = 20;
/**
 * A requisição `running` mais velha que isso foi interrompida (tarefa 162: o processo parou no meio): acima do
 * maior tempo de uma chamada (AI_DOCUMENT_CONVERT_TIMEOUT_MS é de até 30 min; o streaming não tem prazo, e uma
 * resposta longa com raciocínio passa de muitos minutos).
 */
const STALE_REQUEST_AFTER = '1 hour';

/**
 * Fecha como erro ("interrupted: …") as requisições ao provedor que ficaram `running` porque o processo parou no
 * meio (tarefa 162), em lotes, cada um na sua transação, até um lote vir incompleto. Devolve quantas.
 */
export async function closeStaleAiRequests(db: Database, after = STALE_REQUEST_AFTER): Promise<number> {
  let total = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await db.execute<{ n: number }>(sql`SELECT ai_requests_close_stale(${after}::interval, ${PURGE_BATCH}::int) AS n`);
    const n = Number(result.rows[0]?.n ?? 0);
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

/**
 * Retenção operacional (tarefa 103): `operational_purge` apaga, em lotes, o que passou do prazo (anexos sem vínculo,
 * outbox, sino, disparos de lembrete, códigos de pareamento, histórico das tarefas e das receitas). Cada lote numa
 * transação própria, sem `app.user_id` (a exclusão dos anexos sai como `system` na auditoria), repetindo enquanto
 * alguma tabela devolver o lote cheio, até OPERATIONAL_PURGE_ROUNDS. Devolve as contagens diferentes de zero.
 */
export async function purgeOperational(db: Database): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (let round = 0; round < OPERATIONAL_PURGE_ROUNDS; round += 1) {
    const rows = await db.transaction(async (tx) => {
      const result = await tx.execute<{ target: string; deleted: number }>(
        sql`SELECT target, deleted FROM operational_purge(${PURGE_BATCH}::int)`,
      );
      return result.rows;
    });
    let full = false;
    for (const row of rows) {
      const n = Number(row.deleted);
      if (n > 0) totals[row.target] = (totals[row.target] ?? 0) + n;
      if (n >= PURGE_BATCH) full = true;
    }
    if (!full) break;
  }
  return totals;
}

/** Purga as requisições mais velhas que o prazo, em lotes, até um lote vir incompleto. Devolve quantas. */
export async function purgeAiRequests(db: Database, config: Config): Promise<number> {
  const { days } = await requestRetentionDays(db, config);
  let total = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await db.execute<{ n: number }>(sql`SELECT ai_requests_purge(${days}::int, ${PURGE_BATCH}::int) AS n`);
    const n = Number(result.rows[0]?.n ?? 0);
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

export type AgentWorkerOptions = {
  pollMs?: number;
  concurrency?: number;
  maintenanceMs?: number;
  staleAfter?: string;
  taskIntervalMs?: number;
};

export function startAgentWorker(db: Database, config: Config, log: FastifyBaseLogger, opts: AgentWorkerOptions = {}) {
  const pollMs = opts.pollMs ?? config.agentPollMs;
  const concurrency = opts.concurrency ?? config.agentConcurrency;
  const staleAfter = opts.staleAfter ?? '2 minutes';
  const active = new Set<Promise<void>>();
  // Laços em andamento (reserva, manutenção, tarefas, receitas): a parada os espera dentro do prazo.
  const loops = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  let stopped = false;
  let claiming = false;

  const claim = async () => {
    if (stopped || claiming || active.size >= concurrency) return;
    claiming = true;
    try {
      while (!stopped && active.size < concurrency) {
        const result = await db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, ${staleAfter}::interval)`);
        const run = result.rows[0];
        if (!run) break;
        log.info({ runId: run.id, attempt: run.attempts }, 'agente: execução reservada');
        const job = processRun({ db, config, log, shutdown: shutdown.signal }, run)
          .catch((error) => log.error({ err: error, runId: run.id }, 'agente: erro inesperado'))
          .finally(() => {
            active.delete(job);
            // Uma execução terminou: a fila das receitas do lote (spec 030) pode andar.
            void recipes();
            void claim();
          });
        active.add(job);
      }
    } catch (error) {
      log.error({ err: error }, 'agente: falha ao reservar execuções');
    } finally {
      claiming = false;
    }
  };
  const transcribing = new Set<Promise<void>>();
  let claimingTranscriptions = false;
  const claimTranscription = async () => {
    if (stopped || claimingTranscriptions || transcribing.size >= TRANSCRIPTION_CONCURRENCY) return;
    claimingTranscriptions = true;
    try {
      while (!stopped && transcribing.size < TRANSCRIPTION_CONCURRENCY) {
        const [item] = await claimTranscriptions(db, 1);
        if (!item) break;
        const job = processTranscription({ db, config, log }, item)
          .then((outcome) => log.info({ transcriptionId: item.id, outcome }, 'transcrição: processada'))
          .catch((error) => log.error({ err: error, transcriptionId: item.id }, 'transcrição: erro inesperado'))
          .finally(() => {
            transcribing.delete(job);
            void claimTranscription();
          });
        transcribing.add(job);
      }
    } catch (error) {
      log.error({ err: error }, 'transcrição: falha ao reservar');
    } finally {
      claimingTranscriptions = false;
    }
  };

  // Fila das receitas de conciliação ao importar (spec 030): fecha o status das execuções terminadas e começa a
  // próxima receita de cada lote livre (uma por vez por lote).
  let recipesRunning = false;
  const recipes = async () => {
    if (recipesRunning || stopped) return;
    recipesRunning = true;
    try {
      const result = await recipesTick(db, config, log);
      if (result.started) {
        log.info(result, 'agente: receitas de conciliação');
        void claim();
      }
    } catch (error) {
      log.error({ err: error }, 'agente: falha na fila das receitas de conciliação');
    } finally {
      recipesRunning = false;
    }
  };

  const poll = () => {
    void tracked(loops, claim());
    void tracked(loops, claimTranscription());
    void tracked(loops, recipes());
  };
  const pollTimer = setInterval(poll, pollMs);
  poll();

  const indexState: IndexState = { since: new Map() };
  let maintaining = false;
  // A retenção operacional (tarefa 103) roda na primeira manutenção e depois a cada hora.
  let operationalAt = 0;
  const maintenance = async () => {
    if (maintaining || stopped) return;
    maintaining = true;
    try {
      const result = await db.execute<{ purged: number; expired: number; orphans: number; telegram: number }>(sql`
        SELECT ai_run_events_purge(interval '7 days') AS purged, ai_runs_expire_awaiting(interval '7 days') AS expired,
               ai_embeddings_purge_orphans() AS orphans, telegram_updates_seen_purge(interval '7 days') AS telegram`);
      const row = result.rows[0];
      if (row && (Number(row.purged) || Number(row.expired) || Number(row.orphans) || Number(row.telegram))) {
        log.info(row, 'agente: manutenção');
      }
      if (Date.now() - operationalAt >= OPERATIONAL_PURGE_EVERY_MS) {
        operationalAt = Date.now();
        try {
          const purged = await purgeOperational(db);
          if (Object.keys(purged).length > 0) log.info(purged, 'manutenção: retenção operacional');
        } catch (error) {
          // Isolada: uma falha aqui não segura o resto da manutenção (tenta de novo na hora seguinte).
          log.error({ err: error, step: 'operational_purge' }, 'manutenção: retenção operacional falhou');
        }
      }
      // Antes da purga: a requisição fechada como interrompida ainda conta na saúde do provedor.
      const stale = await closeStaleAiRequests(db);
      if (stale) log.warn({ requests: stale }, 'agente: requisições ao provedor interrompidas fechadas');
      const requests = await purgeAiRequests(db, config);
      if (requests) log.info({ requests }, 'agente: requisições ao provedor purgadas');
      const index = await indexEmbeddings(db, config, indexState);
      if (index.sources || index.embedded) log.info({ sources: index.sources, embedded: index.embedded }, 'agente: embeddings');
      for (const failure of index.errors) log.warn({ err: failure.error, ...failure.pair }, 'agente: indexação de embeddings falhou');
      const purged = await purgeEmbeddingIndexes(db);
      if (purged) log.info({ purged }, 'agente: índices de embeddings parados apagados');
    } catch (error) {
      log.error({ err: error }, 'agente: falha na manutenção');
    } finally {
      maintaining = false;
    }
  };
  const maintenanceTimer = setInterval(() => void tracked(loops, maintenance()), opts.maintenanceMs ?? config.agentMaintenanceMs);
  void tracked(loops, maintenance());

  // Tarefas agendadas (spec 029): dispara as vencidas (reserva + sessão + execução numa transação) e acorda a fila.
  let ticking = false;
  const tasks = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const result = await tasksTick(db, config, log);
      if (result.started || result.skipped || result.failed) {
        log.info(result, 'agente: tarefas agendadas');
        void claim();
      }
    } catch (error) {
      log.error({ err: error }, 'agente: falha no laço das tarefas agendadas');
    } finally {
      ticking = false;
    }
  };
  const tasksTimer = setInterval(() => void tracked(loops, tasks()), opts.taskIntervalMs ?? config.agentTaskIntervalMs);
  void tracked(loops, tasks());

  /** Para de reservar, corta as chamadas ao modelo (as execuções voltam à fila) e espera o resto até o prazo. */
  return async (graceMs = config.shutdownGraceMs) => {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(maintenanceTimer);
    clearInterval(tasksTimer);
    shutdown.abort();
    const settled = await settleWithin([...active, ...transcribing, ...loops], graceMs);
    if (!settled) {
      log.warn({ runs: active.size, transcriptions: transcribing.size }, 'agente: prazo da parada esgotado com trabalho em andamento');
    }
  };
}
