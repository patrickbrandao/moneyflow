import { Writable } from 'node:stream';
import { createDb, createPool, type Database } from '@moneyflow/db';
import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { errorText, loggableError } from '../src/errors';
import { logHooks, logSerializers } from '../src/log';
import { logMessageTick } from '../src/services/message-worker';

/* Segredos fora do log quando uma consulta falha (tarefa 070) e o id da requisição no 500 (tarefa 186). */

const SECRET = 'Segredo-Do-Login-123';

/** O erro do Postgres na recusa de uma linha: o DETAIL repete a linha, com o segredo. */
const pgError = () =>
  Object.assign(new Error('new row for relation "users" violates check constraint "users_email_check"'), {
    code: '23514',
    severity: 'ERROR',
    constraint: 'users_email_check',
    table: 'users',
    detail: `Failing row contains (admin, x@, ${SECRET}).`,
  });

const queryError = (cause: Error = new Error('Connection terminated unexpectedly')) =>
  new DrizzleQueryError('select auth_login($1, $2) as id', ['admin', SECRET], cause);

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream, text: () => lines.join('') };
}

describe('erros no log sem os parâmetros da consulta (tarefa 070)', () => {
  it('o serializador tira os parâmetros da mensagem, da pilha e das propriedades, e mantém o SQL e o código', () => {
    const raw = queryError(pgError());
    expect(String(raw.message)).toContain(SECRET);
    const out = JSON.stringify(logSerializers.err(raw));
    expect(out).not.toContain(SECRET);
    expect(out).toContain('auth_login');
    const serialized = logSerializers.err(raw) as Record<string, any>;
    expect(serialized.type).toBe('DrizzleQueryError');
    expect(serialized.pg).toMatchObject({ code: '23514', constraint: 'users_email_check' });
    expect(serialized.message).toContain('violates check constraint');
    // O original continua intacto (o tratamento de erro ainda o traduz pela causa).
    expect(raw.params).toEqual(['admin', SECRET]);
  });

  it('vale para o erro embrulhado como causa e para o erro do Postgres solto', () => {
    const wrapped = new Error('falha no laço', { cause: queryError() });
    expect(JSON.stringify(logSerializers.err(wrapped))).not.toContain(SECRET);
    const pg = JSON.stringify(logSerializers.err(pgError()));
    expect(pg).not.toContain(SECRET);
    expect(pg).toContain('23514');
    // Um erro comum passa igual.
    const plain = new Error('nada de segredo');
    expect(loggableError(plain)).toBe(plain);
  });

  it('errorText: o texto curto tem a mensagem do Postgres e o SQL, nunca os parâmetros', () => {
    const text = errorText(queryError(pgError()));
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(/violates check constraint.*auth_login/);
    expect(errorText(new Error(`Failed query: select 1\nparams: ${SECRET}`))).not.toContain(SECRET);
    expect(errorText('texto')).toBe('texto');
  });

  it('o log do worker (pino com os serializadores) e o aviso da assinatura que falhou não levam o segredo', () => {
    const { stream, text } = capture();
    const log = pino({ level: 'info', serializers: logSerializers, hooks: logHooks }, stream);
    log.error({ err: queryError() }, 'worker: falha');
    log.error(queryError(), 'worker: falha no laço');
    log.error(queryError());
    log.warn({ err: queryError() });
    logMessageTick(log, {
      subscriptionErrors: [{ subscriptionId: 'x', eventKind: 'due_reminder', error: errorText(queryError()) }],
    });
    expect(text()).toContain('auth_login');
    expect(text()).not.toContain(SECRET);
  });
});

describe('o 500 da API (tarefas 070 e 186)', () => {
  let app: FastifyInstance;
  let failNext = false;
  const logs = capture();
  const pool = createPool(inject('databaseUrl'), 3);
  const real = createDb(pool);
  // O banco de verdade, mas a próxima consulta falha como numa queda de conexão.
  const db = new Proxy(real, {
    get(target, key, receiver) {
      if (key === 'execute') {
        return (...args: unknown[]) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(queryError());
          }
          return (target.execute as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  }) as Database;

  beforeAll(async () => {
    const config = loadConfig({ DATABASE_URL: inject('databaseUrl'), LOGIN_RATE_LIMIT: '1000', LOG_LEVEL: 'info' });
    app = await buildApp({ db, config, logger: { level: 'info', stream: logs.stream } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('a falha do banco no login responde 500 com o id da requisição; o log tem o SQL e o id, sem a senha', async () => {
    failNext = true;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: SECRET } });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe('internal');
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    expect(res.body).not.toContain(SECRET);
    const text = logs.text();
    expect(text).toContain('auth_login');
    expect(text).toContain(body.error.requestId);
    expect(text).not.toContain(SECRET);
  });
});
