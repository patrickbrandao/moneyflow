import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pg } from '@moneyflow/db';
import { DATABASE_DIR, migrate } from './migrate';

/*
 * Banco de teste local para a verificação rápida (MONEYFLOW_TEST_DB=local):
 * em vez de subir um container, usa o Postgres de desenvolvimento
 * (make -C database up, porta 5432). As migrations ficam num banco modelo
 * (moneyflow_it_tpl), refeito só quando database/migrations muda (o hash fica
 * no COMMENT do banco); a cada execução o banco dos testes (moneyflow_it) é
 * recriado por cópia do modelo, então começa limpo em menos de um segundo.
 * Não usa moneyflow_test, que é do pgTAP (make -C database test).
 */

const TEMPLATE = 'moneyflow_it_tpl';
const TARGET = 'moneyflow_it';

function migrationsHash(): string {
  const dir = join(DATABASE_DIR, 'migrations');
  const hash = createHash('sha256');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(dir, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Prepara o banco local e devolve as conexões do dono e da aplicação. */
export async function prepareLocalDatabase(): Promise<{ ownerUrl: string; appUrl: string }> {
  const ownerBase = process.env.MONEYFLOW_TEST_LOCAL_OWNER_URL ?? 'postgres://moneyflow:moneyflow@localhost:5432/postgres';
  const appBase = process.env.MONEYFLOW_TEST_LOCAL_APP_URL ?? 'postgres://moneyflow_app:moneyflow_app@localhost:5432/postgres';
  const admin = new pg.Client({ connectionString: ownerBase });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres local indisponível em ${new URL(ownerBase).host}: rode \`make -C database up\` (${(err as Error).message})`);
  }
  try {
    const hash = migrationsHash();
    const current = await admin.query<{ comment: string | null }>(
      'SELECT shobj_description(oid, $1) AS comment FROM pg_database WHERE datname = $2',
      ['pg_database', TEMPLATE],
    );
    if (current.rows[0]?.comment !== hash) {
      await admin.query(`DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEMPLATE}`);
      try {
        await migrate(withDatabase(ownerBase, TEMPLATE));
      } catch (err) {
        await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
        throw err;
      }
      await admin.query(`COMMENT ON DATABASE ${TEMPLATE} IS '${hash}'`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TARGET} TEMPLATE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  return { ownerUrl: withDatabase(ownerBase, TARGET), appUrl: withDatabase(appBase, TARGET) };
}
