import { createDb, createPool, type Database, pg } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { translateDbError } from '../src/errors';

/*
 * O pool da aplicação (tarefas 102 e 108): os prazos de cada conexão no Postgres, a tradução do prazo
 * esgotado para 503 e a queda de uma conexão (ociosa ou emprestada) que não derruba o processo.
 */

const url = inject('databaseUrl');
const pools: pg.Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
});

function pool(...args: Parameters<typeof createPool> extends [string, ...infer R] ? R : never) {
  const created = createPool(url, ...args);
  pools.push(created);
  return created;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(25);
  return check();
}

/** Encerra o backend `pid` por outra conexão (o moneyflow_app pode sinalizar os próprios backends). */
async function terminate(pid: number) {
  const other = new pg.Client({ connectionString: url });
  await other.connect();
  try {
    await other.query('SELECT pg_terminate_backend($1)', [pid]);
  } finally {
    await other.end();
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('a consulta devia ter falhado');
}

describe('prazos do pool (tarefa 102)', () => {
  it('cada conexão sai com os prazos padrão', async () => {
    const db = createDb(pool(1));
    const result = await db.execute<{ statement: string; lock: string; idle: string }>(sql`
      SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock,
             current_setting('idle_in_transaction_session_timeout') AS idle`);
    expect(result.rows[0]).toEqual({ statement: '1min', lock: '30s', idle: '5min' });
  });

  it('a configuração chega às conexões (DB_*_MS)', async () => {
    const config = loadConfig({
      DATABASE_URL: url,
      DB_STATEMENT_TIMEOUT_MS: '45000',
      DB_LOCK_TIMEOUT_MS: '7000',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000',
      DB_CONNECTION_TIMEOUT_MS: '3000',
    });
    expect(config.dbTimeouts).toEqual({
      statementTimeoutMs: 45_000,
      lockTimeoutMs: 7000,
      idleInTransactionTimeoutMs: 120_000,
      connectionTimeoutMs: 3000,
    });
    const db = createDb(pool(1, config.dbTimeouts));
    const result = await db.execute<{ statement: string; lock: string; idle: string }>(sql`
      SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock,
             current_setting('idle_in_transaction_session_timeout') AS idle`);
    expect(result.rows[0]).toEqual({ statement: '45s', lock: '7s', idle: '2min' });
  });

  it('a consulta acima do statement_timeout é cancelada (57014) e vira 503; a conexão volta ao pool', async () => {
    const db = createDb(pool(1, { statementTimeoutMs: 200 }));
    const error = await rejection(db.execute(sql`SELECT pg_sleep(2)`));
    const translated = translateDbError(error);
    expect(translated).toMatchObject({ status: 503, code: 'pg_57014' });
    expect(translated?.message).toMatch(/demorou demais/);
    expect(translated?.headers).toEqual({ 'retry-after': '5' });
    // A mesma (única) conexão segue usável.
    expect((await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`)).rows[0]).toEqual({ ok: 1 });
  });

  it('o SET LOCAL de uma transação vence o prazo do pool só nela', async () => {
    const db = createDb(pool(1, { statementTimeoutMs: 200 }));
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout', '5s', true)`);
      await tx.execute(sql`SELECT pg_sleep(0.4)`);
    });
    expect(translateDbError(await rejection(db.execute(sql`SELECT pg_sleep(0.4)`)))).toMatchObject({ code: 'pg_57014' });
  });

  it('a espera por um lock acima do lock_timeout falha (55P03) e vira 503', async () => {
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      // Um advisory lock, como o das séries e o da decisão das confirmações: a espera por ele também tem prazo.
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(102, 102)');
      const db = createDb(pool(1, { lockTimeoutMs: 200 }));
      const error = await rejection(db.execute(sql`SELECT pg_advisory_xact_lock(102, 102)`));
      expect(translateDbError(error)).toMatchObject({ status: 503, code: 'pg_55P03' });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  });

  it('o pool esgotado responde no connectionTimeoutMillis, com 503, em vez de esperar para sempre', async () => {
    const busy = pool(1, { connectionTimeoutMs: 200 });
    const held = await busy.connect();
    try {
      const started = Date.now();
      const error = await rejection(createDb(busy).execute(sql`SELECT 1`));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(translateDbError(error)).toMatchObject({ status: 503, code: 'db_busy' });
    } finally {
      held.release();
    }
  });

  it('a API responde 503 com a mensagem quando a consulta passa do prazo', async () => {
    const real = createDb(pool(2, { statementTimeoutMs: 200 }));
    let slow = false;
    // O banco de verdade, mas a próxima consulta dorme acima do prazo do pool.
    const db = new Proxy(real, {
      get(target, key, receiver) {
        if (key === 'execute' && slow) {
          slow = false;
          return () => target.execute(sql`SELECT pg_sleep(2)`);
        }
        return Reflect.get(target, key, receiver);
      },
    }) as Database;
    const app = await buildApp({ db, config: loadConfig({ DATABASE_URL: url }), logger: false });
    try {
      slow = true;
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json().error).toMatchObject({ code: 'pg_57014' });
    } finally {
      await app.close();
    }
  });
});

describe('queda de conexão do pool (tarefa 108)', () => {
  it('a conexão ociosa encerrada pelo servidor só avisa: o processo segue e a próxima consulta abre outra', async () => {
    const errors: Error[] = [];
    const idle = pool(1, { onError: (error) => errors.push(error) });
    const db = createDb(idle);
    const first = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    const pid = first.rows[0]!.pid;
    await terminate(pid);
    expect(await until(() => errors.length > 0)).toBe(true);
    expect(errors[0]?.message).toMatch(/terminating connection|Connection terminated/);
    const next = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    expect(next.rows[0]!.pid).not.toBe(pid);
  });

  it('a transação parada além do idle_in_transaction_session_timeout falha sem derrubar o processo', async () => {
    const errors: Error[] = [];
    const db = createDb(pool(1, { idleInTransactionTimeoutMs: 300, onError: (error) => errors.push(error) }));
    const error = await rejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        // A transação fica parada (uma chamada externa no meio, um bug): o servidor a encerra.
        await sleep(1000);
        await tx.execute(sql`SELECT 1`);
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(await until(() => errors.length > 0)).toBe(true);
    expect((await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`)).rows[0]).toEqual({ ok: 1 });
  });
});
