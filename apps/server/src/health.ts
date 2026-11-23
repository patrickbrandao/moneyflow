import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Saúde do processo na imagem (tarefa 107). O worker não tem porta: a cada
 * passada do laço de mensagens que chega ao banco, ele grava o instante num
 * arquivo; o healthcheck da imagem (healthcheck.ts, `dist/healthcheck.mjs`)
 * descobre o modo pelo mesmo critério do main.ts (argumento ou MODE) e, no
 * worker, confere a idade desse arquivo; na API, chama /api/health.
 * Sem dependências: o healthcheck roda a cada 15 s.
 */

/** Arquivo do batimento do worker (WORKER_HEARTBEAT_FILE; padrão na pasta temporária). */
export const heartbeatFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.WORKER_HEARTBEAT_FILE?.trim() || join(tmpdir(), 'moneyflow-worker-heartbeat');

export function writeHeartbeat(file: string, now = Date.now()) {
  writeFileSync(file, String(now));
}

/** O instante gravado (ms), ou null sem arquivo ou com conteúdo inválido. */
export function readHeartbeat(file: string): number | null {
  try {
    const value = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Idade máxima do batimento: 3 intervalos do laço de mensagens, nunca menos de 90 s. */
export const heartbeatMaxAgeMs = (messageIntervalMs: number) => Math.max(90_000, 3 * messageIntervalMs);

export const heartbeatHealthy = (at: number | null, now: number, messageIntervalMs: number) =>
  at !== null && now - at <= heartbeatMaxAgeMs(messageIntervalMs);

/** Modo como o main.ts decide: o argumento depois do script, senão MODE, senão api. */
export function resolveMode(argAfterScript: string | undefined, env: NodeJS.ProcessEnv): string {
  return argAfterScript ?? env.MODE ?? 'api';
}

/**
 * O argumento depois do script na linha de comando do processo principal (`/proc/1/cmdline`, separada por
 * NUL), para o healthcheck, que é outro processo: `node … /app/main.mjs worker` → `worker`.
 */
export function argAfterScript(cmdline: string): string | undefined {
  const args = cmdline.split('\0').filter(Boolean);
  const script = args.findIndex((arg) => /main\.(mjs|js|ts)$/.test(arg));
  return script >= 0 ? args[script + 1] : undefined;
}
