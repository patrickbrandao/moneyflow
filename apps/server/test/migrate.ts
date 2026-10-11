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
