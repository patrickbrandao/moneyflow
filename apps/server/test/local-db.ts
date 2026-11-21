import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pg } from '@moneyflow/db';
import { createOwnedDatabase, DATABASE_DIR, migrate, withDatabase } from './migrate';

/*
 * Banco de teste local para a verificação rápida (MONEYFLOW_TEST_DB=local):
 * em vez de subir um container, usa o Postgres de desenvolvimento
 * (make -C database up, porta 5432). As migrations ficam num banco modelo
 * (moneyflow_it_tpl), refeito só quando database/migrations muda (o hash fica
 * no COMMENT do banco); a cada execução o banco dos testes (moneyflow_it) é
 * recriado por cópia do modelo, então começa limpo em menos de um segundo.
 * Não usa moneyflow_test, que é do pgTAP (make -C database test).
 *
 * Como no initdb (tarefa 054), os bancos são criados pelo superusuário
 * (MONEYFLOW_TEST_LOCAL_SUPER_URL) com dono moneyflow_owner e as extensões, e
 * as migrations rodam como o dono (MONEYFLOW_TEST_LOCAL_OWNER_URL), que também
 * faz o dump e a restauração nos testes de backup.
 */

// MONEYFLOW_TEST_LOCAL_DB separa execuções locais simultâneas (worktrees): cada nome tem o seu modelo.
const TARGET = process.env.MONEYFLOW_TEST_LOCAL_DB ?? 'moneyflow_it';
if (!/^[a-z_][a-z0-9_]{0,50}$/.test(TARGET)) throw new Error(`MONEYFLOW_TEST_LOCAL_DB inválido: ${TARGET}`);
const TEMPLATE = `${TARGET}_tpl`;

function migrationsHash(): string {
  const dir = join(DATABASE_DIR, 'migrations');
  // O sal muda quando o jeito de montar o modelo muda (owner-v1: dono moneyflow_owner, tarefa 054).
  const hash = createHash('sha256').update('owner-v1\0');
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

/** Prepara o banco local e devolve as conexões do dono e da aplicação. */
export async function prepareLocalDatabase(): Promise<{ superUrl: string; ownerUrl: string; appUrl: string }> {
  const superBase = process.env.MONEYFLOW_TEST_LOCAL_SUPER_URL ?? 'postgres://moneyflow:moneyflow@localhost:5432/postgres';
  const ownerBase = process.env.MONEYFLOW_TEST_LOCAL_OWNER_URL ?? 'postgres://moneyflow_owner:moneyflow_owner@localhost:5432/postgres';
  const appBase = process.env.MONEYFLOW_TEST_LOCAL_APP_URL ?? 'postgres://moneyflow_app:moneyflow_app@localhost:5432/postgres';
  const admin = new pg.Client({ connectionString: superBase });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres local indisponível em ${new URL(superBase).host}: rode \`make -C database up\` (${(err as Error).message})`);
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
      await createOwnedDatabase(superBase, TEMPLATE);
      try {
        await migrate(withDatabase(ownerBase, TEMPLATE));
      } catch (err) {
        await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
        throw err;
      }
      await admin.query(`COMMENT ON DATABASE ${TEMPLATE} IS '${hash}'`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)`);
    await createOwnedDatabase(superBase, TARGET, `TEMPLATE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  return { superUrl: withDatabase(superBase, TARGET), ownerUrl: withDatabase(ownerBase, TARGET), appUrl: withDatabase(appBase, TARGET) };
}
