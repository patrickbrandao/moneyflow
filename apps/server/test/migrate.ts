import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pg } from '@moneyflow/db';

export const DATABASE_DIR = resolve(import.meta.dirname, '../../../database');

/** Parte `-- migrate:up` de uma migration dbmate. */
function upSection(sql: string): string {
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  return sql.slice(start + '-- migrate:up'.length, end === -1 ? undefined : end);
}

/** Aplica todas as migrations (como o dono do banco), sem dbmate. */
export async function migrate(ownerUrl: string) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const dir = join(DATABASE_DIR, 'migrations');
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      await client.query('BEGIN');
      await client.query(upSection(readFileSync(join(dir, file), 'utf8')));
      await client.query('COMMIT');
    }
  } finally {
    await client.end();
  }
}

/** O papel dono do banco, sem SUPERUSER (tarefa 054): roda as migrations e o dump/restauração. */
export const OWNER_ROLE = 'moneyflow_owner';

export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Cria o banco `name` pelo superusuário como faz o initdb (database/docker/initdb/03-owner-role.sh):
 * dono `moneyflow_owner`, schema public dele e as extensões criadas pelo superusuário (a `vector`
 * não é trusted). As migrations rodam depois como o dono. Opções de CREATE DATABASE (TEMPLATE…) em `extra`.
 */
export async function createOwnedDatabase(superUrl: string, name: string, extra = '') {
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER ${OWNER_ROLE} ${extra}`);
  } finally {
    await admin.end();
  }
  if (extra.includes('TEMPLATE')) return;
  const db = new pg.Client({ connectionString: withDatabase(superUrl, name) });
  await db.connect();
  try {
    await db.query(`ALTER SCHEMA public OWNER TO ${OWNER_ROLE}`);
    for (const ext of ['vector', 'pg_trgm', 'citext']) await db.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
  } finally {
    await db.end();
  }
}
