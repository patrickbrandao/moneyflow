import { createDb, createPool } from '@moneyflow/db';
import pino from 'pino';
import { buildApp } from './app';
import { ensureInitialAdmin } from './auth/bootstrap';
import { loadConfig } from './config';
import { startWorker } from './worker';

/*
 * Um artefato, dois modos: `api` (HTTP + SPA) e `worker` (jobs periódicos).
 * Modo: primeiro argumento ou MODE (padrão api).
 */
const mode = process.argv[2] ?? process.env.MODE ?? 'api';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDb(pool);

async function main() {
  if (mode === 'worker') {
    const log = pino({ level: config.logLevel, base: { mode: 'worker' } });
    const stop = startWorker(db, config, log);
    const shutdown = async () => {
      stop();
      await pool.end();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return;
  }
  if (mode !== 'api') throw new Error(`Modo desconhecido: ${mode} (use api ou worker)`);

  const app = await buildApp({ db, config });
  await ensureInitialAdmin(db, config, app.log);
  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
