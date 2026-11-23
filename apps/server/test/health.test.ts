import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { argAfterScript, heartbeatFile, heartbeatHealthy, readHeartbeat, resolveMode, writeHeartbeat } from '../src/health';
import { settleWithin } from '../src/shutdown';

/* Healthcheck da imagem e parada com prazo (tarefa 107), sem banco. */

const dir = mkdtempSync(join(tmpdir(), 'mf-health-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('healthcheck (tarefa 107)', () => {
  it('o modo pelo mesmo critério do main.ts: argumento do processo principal, senão MODE, senão api', () => {
    const cmdline = (...args: string[]) => `${args.join('\0')}\0`;
    // docker run … worker: ENTRYPOINT node --enable-source-maps /app/main.mjs + CMD worker, sem MODE.
    expect(resolveMode(argAfterScript(cmdline('node', '--enable-source-maps', '/app/main.mjs', 'worker')), {})).toBe('worker');
    // Compose: MODE=worker e o argumento.
    expect(resolveMode(argAfterScript(cmdline('node', '/app/main.mjs')), { MODE: 'worker' })).toBe('worker');
    // Sem argumento nem MODE: api (o padrão da imagem).
    expect(resolveMode(argAfterScript(cmdline('node', '--enable-source-maps', '/app/main.mjs')), {})).toBe('api');
    // Com init (tini) na frente, o script ainda é achado.
    expect(argAfterScript(cmdline('/sbin/docker-init', '--', 'node', '/app/main.mjs', 'worker'))).toBe('worker');
    expect(argAfterScript('')).toBeUndefined();
  });

  it('o worker é saudável com o batimento de até 3 intervalos (mínimo 90 s); sem arquivo, não', () => {
    const file = join(dir, 'beat');
    expect(readHeartbeat(file)).toBeNull();
    expect(heartbeatHealthy(readHeartbeat(file), Date.now(), 30_000)).toBe(false);
    const now = Date.now();
    writeHeartbeat(file, now - 80_000);
    expect(heartbeatHealthy(readHeartbeat(file), now, 30_000)).toBe(true);
    writeHeartbeat(file, now - 95_000);
    expect(heartbeatHealthy(readHeartbeat(file), now, 30_000)).toBe(false);
    // Intervalo longo: 3 intervalos valem mais que o mínimo.
    expect(heartbeatHealthy(now - 150_000, now, 60_000)).toBe(true);
    writeFileSync(file, 'lixo');
    expect(readHeartbeat(file)).toBeNull();
    expect(heartbeatFile({ WORKER_HEARTBEAT_FILE: ' /x/beat ' })).toBe('/x/beat');
    expect(heartbeatFile({})).toBe(join(tmpdir(), 'moneyflow-worker-heartbeat'));
  });

  it('a parada espera até o prazo e segue sem o que não terminou', async () => {
    const quick = new Promise((resolve) => setTimeout(resolve, 20));
    expect(await settleWithin([quick, Promise.reject(new Error('falhou'))], 1000)).toBe(true);
    const start = Date.now();
    expect(await settleWithin([new Promise(() => {})], 150)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
