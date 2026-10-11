import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pg } from '@moneyflow/db';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const DATABASE_DIR = resolve(import.meta.dirname, '../../../database');

/** Parte `-- migrate:up` de uma migration dbmate. */
function upSection(sql: string): string {
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  return sql.slice(start + '-- migrate:up'.length, end === -1 ? undefined : end);
}

async function migrate(ownerUrl: string) {
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

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject) {
  const external = process.env.MONEYFLOW_TEST_DATABASE_URL;
  if (external) {
    project.provide('databaseUrl', external);
    return;
  }
  const image = await GenericContainer.fromDockerfile(DATABASE_DIR, 'docker/Dockerfile')
    .withCache(true)
    .build('moneyflow-postgres:test', { deleteOnExit: false });
  container = await image
    .withEnvironment({
      POSTGRES_USER: 'moneyflow',
      POSTGRES_PASSWORD: 'moneyflow',
      POSTGRES_DB: 'moneyflow',
      APP_DB_PASSWORD: 'moneyflow_app',
      TZ: 'America/Sao_Paulo',
    })
    .withExposedPorts(5432)
    .withTmpFs({ '/var/lib/postgresql': 'rw' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  await migrate(`postgres://moneyflow:moneyflow@${host}:${port}/moneyflow`);
  project.provide('databaseUrl', `postgres://moneyflow_app:moneyflow_app@${host}:${port}/moneyflow`);
}

export async function teardown() {
  await container?.stop();
}
