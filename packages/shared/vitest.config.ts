import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Cobertura (tarefa 126): só com `--coverage` (`pnpm test:coverage`); o CI publica o resumo, ainda sem piso.
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text-summary', 'json-summary'] },
  },
});
