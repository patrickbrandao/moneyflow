import type { Database } from '@moneyflow/db';
import { todayIso } from '@moneyflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import { startAgentWorker } from './agents/worker';
import { purgeExpiredSessions } from './auth/session';
import type { Config } from './config';
import { cardMaintenance } from './services/cards';
import { contractMaintenance } from './services/contract-worker';
import { logMessageTick, type MessageLoopState, messageTick, recipientsByCaixa } from './services/message-worker';
import { materializeAll } from './services/recurrence';

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
 * consome a outbox (Telegram), com retry e backoff.
 *
 * O terceiro é o dos agentes de IA (agents/worker.ts): a fila de execuções
 * (AGENT_POLL_MS) e a manutenção (AGENT_MAINTENANCE_MS).
 */
export function startWorker(db: Database, config: Config, log: FastifyBaseLogger) {
  let running = false;
  // Cada etapa isolada (tarefa 104): uma que falha é logada com o nome e as seguintes rodam.
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      log.error({ err: error, step: name }, 'worker: etapa da passada falhou');
      return null;
    }
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await step('series', () =>
        materializeAll(db, undefined, (failure) => log.warn(failure, 'worker: série não materializada')),
      );
      if (result) log.info(result, 'worker: séries materializadas');
      const cards = await step('cards', () =>
        cardMaintenance(db, {
          autoClose: config.cardAutoClose,
          onError: (failure) => log.warn(failure, 'worker: fatura de cartão não atualizada'),
        }),
      );
      if (cards) log.info(cards, 'worker: faturas de cartão');
      // Contratos (spec 034): renova sozinho (renovação automática, com aviso) ou encerra quem passou do fim.
      const contracts = await step('contracts', () =>
        contractMaintenance(
          db,
          todayIso(),
          (ids) => recipientsByCaixa(db, ids),
          (failure) => log.warn(failure, 'worker: contrato não renovado nem encerrado'),
        ),
      );
      if (contracts && (contracts.renewed || contracts.ended || contracts.failed)) log.info(contracts, 'worker: contratos');
      await step('sessions', () => purgeExpiredSessions(db));
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, config.workerIntervalMs);

  let sending = false;
  // Entre as passadas: quando os blocos caros do sino rodaram (tarefa 166).
  const messageState: MessageLoopState = {};
  const messages = async () => {
    if (sending) return;
    sending = true;
    try {
      logMessageTick(log, await messageTick(db, config, undefined, messageState));
    } catch (error) {
      log.error(error, 'worker: falha no laço de mensagens');
    } finally {
      sending = false;
    }
  };
  void messages();
  const messageTimer = setInterval(messages, config.messageIntervalMs);

  // Agentes de IA (spec 011): execuções, manutenção e embeddings.
  const stopAgents = startAgentWorker(db, config, log);
  return async () => {
    clearInterval(timer);
    clearInterval(messageTimer);
    await stopAgents();
  };
}
