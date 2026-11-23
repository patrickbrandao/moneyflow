import type { Database } from '@moneyflow/db';
import { todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { startAgentWorker } from './agents/worker';
import { purgeExpiredSessions } from './auth/session';
import type { Config } from './config';
import { heartbeatFile, writeHeartbeat } from './health';
import { cardMaintenance } from './services/cards';
import { contractMaintenance } from './services/contract-worker';
import { logMessageTick, type MessageLoopState, messageTick, recipientsByCaixa } from './services/message-worker';
import { materializeAll } from './services/recurrence';
import { settleWithin, tracked } from './shutdown';

/**
 * Modo worker: materializa as séries (recorrências e parcelas) até 12 meses à
 * frente, mantém criadas as faturas futuras dos cartões (e, com
 * CARD_AUTO_CLOSE=true, fecha as que passaram da data de fechamento; sem isso
 * a tela só sugere o fechamento) e limpa sessões vencidas. Roda ao subir e a cada WORKER_INTERVAL_MS.
 * Vários workers podem rodar juntos: cada série usa advisory lock.
 *
 * Um segundo laço, a cada MESSAGE_INTERVAL_MS (padrão 30 s), cuida das
 * mensagens (spec 013) e do sino: produz os eventos do horário com dedup,
 * cria as notificações, dispara os lembretes das anotações (spec 035) e
 * consome a outbox (Telegram), com retry e backoff. Cada passada que chega ao
 * banco grava o batimento do healthcheck da imagem (tarefa 107).
 *
 * O terceiro é o dos agentes de IA (agents/worker.ts): a fila de execuções
 * (AGENT_POLL_MS) e a manutenção (AGENT_MAINTENANCE_MS).
 *
 * A parada (tarefa 107) não começa passada nova e espera as em andamento (o
 * envio do Telegram termina marcado) e os agentes, tudo dentro de SHUTDOWN_GRACE_MS.
 */
export function startWorker(db: Database, config: Config, log: FastifyBaseLogger) {
  const hourly = startHourlyLoop(db, config, log);
  const messages = startMessageLoop(db, config, log);
  // Agentes de IA (spec 011): execuções, manutenção e embeddings.
  const stopAgents = startAgentWorker(db, config, log);
  return async (graceMs = config.shutdownGraceMs) => {
    await Promise.all([hourly(graceMs), messages(graceMs), stopAgents(graceMs)]);
  };
}

/** Uma função de parada: para de agendar e espera a passada em andamento até o prazo. */
type StopLoop = (graceMs?: number) => Promise<void>;

/** Séries, cartões, contratos e sessões, ao subir e a cada WORKER_INTERVAL_MS. */
function startHourlyLoop(db: Database, config: Config, log: FastifyBaseLogger): StopLoop {
  const passes = new Set<Promise<unknown>>();
  let running = false;
  let stopping = false;
  // Cada etapa isolada (tarefa 104): uma que falha é logada com o nome e as seguintes rodam.
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    if (stopping) return null;
    try {
      return await fn();
    } catch (error) {
      log.error({ err: error, step: name }, 'worker: etapa da passada falhou');
      return null;
    }
  };
  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try {
      const result = await step('series', () => materializeAll(db));
      if (result) log.info(result, 'worker: séries materializadas');
      const cards = await step('cards', () => cardMaintenance(db, { autoClose: config.cardAutoClose }));
      if (cards) log.info(cards, 'worker: faturas de cartão');
      // Contratos (spec 034): renova sozinho (renovação automática, com aviso) ou encerra quem passou do fim.
      const contracts = await step('contracts', () => contractMaintenance(db, todayIso(), (ids) => recipientsByCaixa(db, ids)));
      if (contracts && (contracts.renewed || contracts.ended || contracts.failed)) log.info(contracts, 'worker: contratos');
      await step('sessions', () => purgeExpiredSessions(db));
    } finally {
      running = false;
    }
  };
  void tracked(passes, tick());
  const timer = setInterval(() => void tracked(passes, tick()), config.workerIntervalMs);
  return async (graceMs = config.shutdownGraceMs) => {
    stopping = true;
    clearInterval(timer);
    if (!(await settleWithin(passes, graceMs))) log.warn('worker: prazo da parada esgotado na passada das séries');
  };
}

/**
 * O laço de mensagens (exportado para os testes). `heartbeat`: o arquivo do batimento (padrão
 * WORKER_HEARTBEAT_FILE ou a pasta temporária; null não grava).
 */
export function startMessageLoop(
  db: Database,
  config: Config,
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  opts: { heartbeat?: string | null } = {},
): StopLoop {
  const file = opts.heartbeat === undefined ? heartbeatFile() : opts.heartbeat;
  const passes = new Set<Promise<unknown>>();
  let sending = false;
  let stopping = false;
  // Entre as passadas: quando os blocos caros do sino rodaram (tarefa 166).
  const state: MessageLoopState = {};
  const pass = async () => {
    if (sending || stopping) return;
    sending = true;
    try {
      logMessageTick(log, await messageTick(db, config, undefined, state));
      // O batimento só com o banco respondendo: as etapas isoladas não lançam com o banco fora.
      await db.execute(sql`SELECT 1`);
      if (file) writeHeartbeat(file);
    } catch (error) {
      log.error(error, 'worker: falha no laço de mensagens');
    } finally {
      sending = false;
    }
  };
  void tracked(passes, pass());
  const timer = setInterval(() => void tracked(passes, pass()), config.messageIntervalMs);
  return async (graceMs = config.shutdownGraceMs) => {
    stopping = true;
    clearInterval(timer);
    if (!(await settleWithin(passes, graceMs))) log.warn('worker: prazo da parada esgotado no laço de mensagens');
  };
}
