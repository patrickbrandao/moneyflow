import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { prepareLocalDatabase } from './local-db';
import { DATABASE_DIR, migrate } from './migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    /** Conexão do dono sem SUPERUSER (moneyflow_owner: migrations, dump e restauração); vazia sem ela. */
    ownerDatabaseUrl: string;
    /** Conexão do superusuário (cria os bancos novos dos testes de backup, tarefa 054); vazia = usa a do dono. */
    superDatabaseUrl: string;
  }
}

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject) {
  const external = process.env.MONEYFLOW_TEST_DATABASE_URL;
  if (external) {
    project.provide('databaseUrl', external);
    project.provide('ownerDatabaseUrl', process.env.MONEYFLOW_TEST_OWNER_URL ?? '');
    project.provide('superDatabaseUrl', process.env.MONEYFLOW_TEST_SUPER_URL ?? '');
    return;
  }
  if (process.env.MONEYFLOW_TEST_DB === 'local') {
    const { superUrl, ownerUrl, appUrl } = await prepareLocalDatabase();
    project.provide('databaseUrl', appUrl);
    project.provide('ownerDatabaseUrl', ownerUrl);
    project.provide('superDatabaseUrl', superUrl);
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
      OWNER_DB_PASSWORD: 'moneyflow_owner',
      TZ: 'America/Sao_Paulo',
    })
    .withExposedPorts(5432)
    .withTmpFs({ '/var/lib/postgresql': 'rw' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  // As migrations rodam como o dono sem SUPERUSER, criado pelo initdb da imagem (tarefa 054).
  await migrate(`postgres://moneyflow_owner:moneyflow_owner@${host}:${port}/moneyflow`);
  project.provide('databaseUrl', `postgres://moneyflow_app:moneyflow_app@${host}:${port}/moneyflow`);
  project.provide('ownerDatabaseUrl', `postgres://moneyflow_owner:moneyflow_owner@${host}:${port}/moneyflow?sslmode=disable`);
  project.provide('superDatabaseUrl', `postgres://moneyflow:moneyflow@${host}:${port}/moneyflow`);
}

export async function teardown() {
  await container?.stop();
}
