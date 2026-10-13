import type { Database } from '@moneyflow/db';
import { todayIso } from '@moneyflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import { startAgentWorker } from './agents/worker';
import { purgeExpiredSessions } from './auth/session';
import type { Config } from './config';
import { cardMaintenance } from './services/cards';
import { contractMaintenance } from './services/contract-worker';
import { messageTick } from './services/message-worker';
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
 * cria as notificações e consome a outbox (Telegram), com retry e backoff.
 *
 * O terceiro é o dos agentes de IA (agents/worker.ts): a fila de execuções
 * (AGENT_POLL_MS) e a manutenção (AGENT_MAINTENANCE_MS).
 */
export function startWorker(db: Database, config: Config, log: FastifyBaseLogger) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await materializeAll(db);
      log.info(result, 'worker: séries materializadas');
      const cards = await cardMaintenance(db, { autoClose: config.cardAutoClose });
      log.info(cards, 'worker: faturas de cartão');
      // Contratos (spec 020): abre as tarefas de renovação e encerra os vencidos; nunca lança parcelas.
      const contracts = await contractMaintenance(db, todayIso());
      if (contracts.opened || contracts.ended || contracts.failed) log.info(contracts, 'worker: contratos');
      await purgeExpiredSessions(db);
    } catch (error) {
      log.error(error, 'worker: falha na passada');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, config.workerIntervalMs);

  let sending = false;
  const messages = async () => {
    if (sending) return;
    sending = true;
    try {
      const result = await messageTick(db, config);
      if (result.queued || result.created || result.sent || result.failed || result.retried) log.info(result, 'worker: mensagens');
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
