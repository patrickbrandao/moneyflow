import type { Database } from '@moneyflow/db';
import type { FastifyBaseLogger } from 'fastify';
import { purgeExpiredSessions } from './auth/session';
import type { Config } from './config';
import { materializeAll } from './services/recurrence';

/**
 * Modo worker: materializa as séries (recorrências e parcelas) até 12 meses à
 * frente e limpa sessões vencidas. Roda ao subir e a cada WORKER_INTERVAL_MS.
 * Vários workers podem rodar juntos: cada série usa advisory lock.
 */
export function startWorker(db: Database, config: Config, log: FastifyBaseLogger) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await materializeAll(db);
      await purgeExpiredSessions(db);
      log.info(result, 'worker: séries materializadas');
    } catch (error) {
      log.error(error, 'worker: falha na passada');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, config.workerIntervalMs);
  return () => clearInterval(timer);
}
