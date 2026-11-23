import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as relations from './generated/relations';
import * as schema from './generated/schema';

/*
 * Client do banco para a aplicação. O schema em ./generated é gerado por
 * `pnpm db:pull` (drizzle-kit pull) a partir do banco migrado — nunca edite.
 *
 * A aplicação conecta como `moneyflow_app` (só DML). `users.password` não é
 * legível por esse papel: liste colunas explicitamente (veja `userColumns`).
 */

// bigint (int8) vira number: dinheiro em centavos cabe com folga em 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// numeric (somas): idem — os valores são sempre inteiros em centavos.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
// date fica como texto 'YYYY-MM-DD' (sem fuso).
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const dbSchema = { ...schema, ...relations };
export type Database = NodePgDatabase<typeof dbSchema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Banco ou transação: os serviços aceitam os dois. */
export type Executor = Database | Tx;

/**
 * Prazos de cada conexão do pool (tarefa 102), em ms: nada da aplicação espera sem limite. O que
 * precisa de mais tempo levanta o `statement_timeout` só na própria transação (SET LOCAL).
 */
export type PoolTimeouts = {
  /** Consulta mais longa que isso é cancelada pelo servidor (57014). */
  statementTimeoutMs: number;
  /** Espera por um lock (linha, tabela, advisory) mais longa que isso falha (55P03). */
  lockTimeoutMs: number;
  /** Transação aberta e parada mais que isso é encerrada pelo servidor. */
  idleInTransactionTimeoutMs: number;
  /** Espera por uma conexão (pool esgotado ou banco que não responde) mais longa que isso falha. */
  connectionTimeoutMs: number;
};

export const DEFAULT_POOL_TIMEOUTS: PoolTimeouts = {
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 300_000,
  connectionTimeoutMs: 10_000,
};

/** Texto do pg-pool quando a espera por uma conexão passa do `connectionTimeoutMillis`. */
export const POOL_CONNECT_TIMEOUT_MESSAGES = ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout'];

/**
 * Pool da aplicação, com os prazos (padrão DEFAULT_POOL_TIMEOUTS). `onError` recebe a queda de uma
 * conexão (tarefa 108: o banco reiniciou, a rede caiu, a transação parada encerrada pelo servidor): o
 * pool descarta o cliente e a próxima consulta abre outro; sem um ouvinte de `error`, o EventEmitter
 * lançaria e o processo cairia.
 */
export function createPool(url: string, max = 10, options: Partial<PoolTimeouts> & { onError?: (error: Error) => void } = {}) {
  const { onError, ...own } = options;
  const timeouts = { ...DEFAULT_POOL_TIMEOUTS, ...own };
  const pool = new pg.Pool({
    connectionString: url,
    max,
    application_name: 'moneyflow',
    statement_timeout: timeouts.statementTimeoutMs,
    lock_timeout: timeouts.lockTimeoutMs,
    idle_in_transaction_session_timeout: timeouts.idleInTransactionTimeoutMs,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
    keepAlive: true,
  });
  // A queda chega ao ouvinte do próprio cliente, ocioso ou emprestado (a transação parada que o servidor encerra
  // pelo idle_in_transaction_session_timeout: o pg-pool tira o ouvinte dele do cliente emprestado). O do pool só
  // evita a exceção da ociosa, que chega aos dois.
  pool.on('connect', (client) => client.on('error', (error) => onError?.(error)));
  pool.on('error', () => {});
  return pool;
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema: dbSchema });
}

export * from './generated/schema';
export { pg };

/** Colunas de `users` legíveis pelo papel da aplicação (tudo menos a senha). */
export const userColumns = {
  id: schema.users.id,
  username: schema.users.username,
  email: schema.users.email,
  role: schema.users.role,
  isActive: schema.users.isActive,
  lastLoginAt: schema.users.lastLoginAt,
  createdAt: schema.users.createdAt,
  updatedAt: schema.users.updatedAt,
};
