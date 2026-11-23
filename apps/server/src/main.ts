import { createDb, createPool } from '@moneyflow/db';
import { buildApp } from './app';
import { ensureInitialAdmin } from './auth/bootstrap';
import { insecureCookieWarning, loadConfig } from './config';
import { loggableError } from './errors';
import { resolveMode } from './health';
import { workerLogger } from './log';
import { startWorker } from './worker';

/*
 * Um artefato, dois modos: `api` (HTTP + SPA) e `worker` (jobs periódicos).
 * Modo: primeiro argumento ou MODE (padrão api).
 */
const mode = resolveMode(process.argv[2], process.env);
const config = loadConfig();
/*
 * Conexão ociosa que cai (tarefa 108: o banco reiniciou, a rede caiu): o pool a descarta e a próxima consulta abre
 * outra; aqui só o aviso, pelo logger do modo quando ele existe (antes disso, no stderr, sem os parâmetros).
 */
let poolWarn = (error: Error) => console.warn('banco: conexão ociosa caiu', loggableError(error));
const pool = createPool(config.databaseUrl, 10, { ...config.dbTimeouts, onError: (error) => poolWarn(error) });
const db = createDb(pool);

/*
 * Parada (tarefa 107): os sinais são ouvidos desde o início (como PID 1, o Node ignora o SIGTERM sem
 * handler e o `docker stop` esperaria o SIGKILL); a parada roda uma vez só (o segundo sinal não refaz
 * o `pool.end()`), dentro de SHUTDOWN_GRACE_MS, e, passada a folga, o processo sai mesmo assim.
 */
let stopServices: (() => Promise<void>) | null = null;
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), config.shutdownGraceMs + 1500).unref();
  void (async () => {
    try {
      await stopServices?.();
    } catch (error) {
      console.error(loggableError(error));
    }
    await pool.end().catch(() => {});
    process.exit(0);
  })();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function main() {
  if (mode === 'worker') {
    const log = workerLogger(config);
    poolWarn = (error) => log.warn({ err: error }, 'banco: conexão ociosa caiu');
    const stop = startWorker(db, config, log);
    stopServices = async () => {
      log.info('worker: parando');
      await stop();
    };
    return;
  }
  if (mode !== 'api') throw new Error(`Modo desconhecido: ${mode} (use api ou worker)`);

  const app = await buildApp({ db, config });
  poolWarn = (error) => app.log.warn({ err: error }, 'banco: conexão ociosa caiu');
  // Fecha o servidor: os streams SSE abertos são encerrados antes (preClose em routes/agents.ts).
  stopServices = () => app.close();
  if (stopping) return;
  const cookieWarning = insecureCookieWarning(config);
  if (cookieWarning) app.log.warn(cookieWarning);
  await ensureInitialAdmin(db, config, app.log);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  // Sem os parâmetros da consulta: uma falha do ensureInitialAdmin levaria o ADMIN_PASSWORD (tarefa 070).
  console.error(loggableError(error));
  process.exit(1);
});
