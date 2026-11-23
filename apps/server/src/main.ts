import { createDb, createPool } from '@moneyflow/db';
import { buildApp } from './app';
import { ensureInitialAdmin } from './auth/bootstrap';
import { insecureCookieWarning, loadConfig } from './config';
import { loggableError } from './errors';
import { workerLogger } from './log';
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
    const log = workerLogger(config);
    const stop = startWorker(db, config, log);
    const shutdown = async () => {
      await stop();
      await pool.end();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return;
  }
  if (mode !== 'api') throw new Error(`Modo desconhecido: ${mode} (use api ou worker)`);

  const app = await buildApp({ db, config });
  const cookieWarning = insecureCookieWarning(config);
  if (cookieWarning) app.log.warn(cookieWarning);
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
  // Sem os parâmetros da consulta: uma falha do ensureInitialAdmin levaria o ADMIN_PASSWORD (tarefa 070).
  console.error(loggableError(error));
  process.exit(1);
});
