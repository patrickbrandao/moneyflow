import { defineConfig } from 'vitest/config';

/*
 * Testes de integração da API contra PostgreSQL 18 real, com as migrations de
 * database/ aplicadas (test/global-setup.ts sobe um container Testcontainers
 * com a imagem do banco). Para usar um banco já migrado, defina
 * MONEYFLOW_TEST_DATABASE_URL (conexão como moneyflow_app).
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
