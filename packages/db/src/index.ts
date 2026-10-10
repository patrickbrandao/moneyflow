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

export function createPool(url: string, max = 10) {
  return new pg.Pool({ connectionString: url, max, application_name: 'moneyflow' });
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
