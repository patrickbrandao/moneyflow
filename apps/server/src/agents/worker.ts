import type { Database } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { requestRetentionDays } from '../services/ai-requests';
import { type IndexState, indexEmbeddings, purgeEmbeddingIndexes } from './embeddings';
import { type ClaimedRun, processRun } from './runner';
import { claimTranscriptions, processTranscription } from './transcriptions';

/*
 * Laço dos agentes no worker (spec 011): reserva execuções (ai_run_claim, SKIP
 * LOCKED; também retoma as de um worker que caiu, até max_attempts) e roda até
 * AGENT_CONCURRENCY ao mesmo tempo. Num segundo ritmo, a manutenção: retenção
 * dos eventos de streaming, expiração de confirmações esquecidas, limpeza de
 * embeddings órfãos, a purga das requisições ao provedor (spec 023: prazo do
 * banco ou de AI_REQUEST_RETENTION_DAYS, em lotes) e os embeddings (spec
 * 024): a indexação de cada par (provedor, modelo) em uso por algum agente
 * ativo e a purga dos pares parados há mais de 7 dias. No mesmo ritmo da
 * fila de execuções, a fila das transcrições (spec 025: ai_transcription_claim,
 * até TRANSCRIPTION_CONCURRENCY ao mesmo tempo).
 */

const TRANSCRIPTION_CONCURRENCY = 2;

const PURGE_BATCH = 1000;

/** Purga as requisições mais velhas que o prazo, em lotes, até um lote vir incompleto. Devolve quantas. */
export async function purgeAiRequests(db: Database, config: Config): Promise<number> {
  const { days } = await requestRetentionDays(db, config);
  let total = 0;
  for (let round = 0; round < 1000; round += 1) {
    const result = await db.execute<{ n: number }>(sql`SELECT ai_requests_purge(${days}::int, ${PURGE_BATCH}::int) AS n`);
    const n = Number(result.rows[0]?.n ?? 0);
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

export type AgentWorkerOptions = { pollMs?: number; concurrency?: number; maintenanceMs?: number; staleAfter?: string };

export function startAgentWorker(db: Database, config: Config, log: FastifyBaseLogger, opts: AgentWorkerOptions = {}) {
  const pollMs = opts.pollMs ?? config.agentPollMs;
  const concurrency = opts.concurrency ?? config.agentConcurrency;
  const staleAfter = opts.staleAfter ?? '2 minutes';
  const active = new Set<Promise<void>>();
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
        const job = processRun({ db, config, log }, run)
          .catch((error) => log.error({ err: error, runId: run.id }, 'agente: erro inesperado'))
          .finally(() => {
            active.delete(job);
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

  const pollTimer = setInterval(() => {
    void claim();
    void claimTranscription();
  }, pollMs);
  void claim();
  void claimTranscription();

  const indexState: IndexState = { since: new Map() };
  let maintaining = false;
  const maintenance = async () => {
    if (maintaining || stopped) return;
    maintaining = true;
    try {
      const result = await db.execute<{ purged: number; expired: number; orphans: number }>(sql`
        SELECT ai_run_events_purge(interval '7 days') AS purged, ai_runs_expire_awaiting(interval '7 days') AS expired,
               ai_embeddings_purge_orphans() AS orphans`);
      const row = result.rows[0];
      if (row && (Number(row.purged) || Number(row.expired) || Number(row.orphans))) log.info(row, 'agente: manutenção');
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
  const maintenanceTimer = setInterval(() => void maintenance(), opts.maintenanceMs ?? config.agentMaintenanceMs);
  void maintenance();

  return async () => {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(maintenanceTimer);
    await Promise.allSettled([...active, ...transcribing]);
  };
}
