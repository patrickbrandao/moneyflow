import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { DATABASE_DIR, migrate } from './migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    /** Conexão do dono (cria bancos novos para os testes de backup); vazia sem ela. */
    ownerDatabaseUrl: string;
  }
}

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject) {
  const external = process.env.MONEYFLOW_TEST_DATABASE_URL;
  if (external) {
    project.provide('databaseUrl', external);
    project.provide('ownerDatabaseUrl', process.env.MONEYFLOW_TEST_OWNER_URL ?? '');
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
  project.provide('ownerDatabaseUrl', `postgres://moneyflow:moneyflow@${host}:${port}/moneyflow`);
}

export async function teardown() {
  await container?.stop();
}
