# packages/db — client do banco

Guia da pasta `packages/db` (`@moneyflow/db`). O banco em si é do dba (`database/`); aqui fica só o lado da aplicação. As regras gerais estão no [AGENTS.md da raiz](../../AGENTS.md).

- `src/index.ts`: o client Drizzle (`createDb`), o pool com os prazos de cada conexão (`createPool`, `DEFAULT_POOL_TIMEOUTS`: `DB_*_MS`, tarefa 102) e `userColumns` (todas as colunas de `users` menos `password`, que o papel `moneyflow_app` não lê). Testes: `apps/server/test/db-pool.test.ts`, `generated-schema.test.ts`.
- `src/generated/` (`schema.ts`, `relations.ts`): o schema gerado por `pnpm db:pull` (drizzle-kit pull) a partir do banco migrado. Nunca edite à mão: depois de uma migration nova, rode `pnpm db:pull`; o `apps/server/test/generated-schema.test.ts` confere que o gerado bate com as migrations (tarefa 163).
- `scripts/postpull.mjs`: o ajuste do que o pull não traduz (`citext`, `bytea`, `tsvector` e as FKs em ciclo), pelos tipos de `src/citext.ts`, `src/bytea.ts` e `src/tsvector.ts` (a coluna `tsvector` é gerada no banco: nunca selecione nem grave).
- `drizzle.config.ts`: a conexão do pull, pela `DATABASE_OWNER_URL`.
