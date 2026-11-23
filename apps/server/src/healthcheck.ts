import { readFileSync } from 'node:fs';
import { argAfterScript, heartbeatFile, heartbeatHealthy, readHeartbeat, resolveMode } from './health';

/*
 * Healthcheck da imagem (tarefa 107; `HEALTHCHECK … node /app/healthcheck.mjs`): sai com 0 se o
 * processo do container está bem. O modo vem do processo principal (argumento ou MODE, como no
 * main.ts), então `docker run … worker` sem MODE também é conferido como worker.
 *  - worker: o batimento gravado pelo laço de mensagens tem até 3 intervalos (mínimo 90 s);
 *  - api: GET /api/health responde 2xx.
 */

function mainArg(): string | undefined {
  try {
    return argAfterScript(readFileSync('/proc/1/cmdline', 'utf8'));
  } catch {
    return undefined;
  }
}

const mode = resolveMode(mainArg(), process.env);
if (mode === 'worker') {
  const interval = Number(process.env.MESSAGE_INTERVAL_MS);
  const ok = heartbeatHealthy(readHeartbeat(heartbeatFile()), Date.now(), Number.isFinite(interval) && interval > 0 ? interval : 30_000);
  process.exit(ok ? 0 : 1);
} else {
  fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((response) => process.exit(response.ok ? 0 : 1))
    .catch(() => process.exit(1));
}
