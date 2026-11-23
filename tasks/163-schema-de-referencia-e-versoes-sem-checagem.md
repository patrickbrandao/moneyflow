---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit:
---

# `schema.sql` sem privilégios e sem conferência no CI, e imagens do banco sem versão fixa

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** DX
- **Subcategoria:** reprodutibilidade e referência do schema
- **Arquivos afetados:** `.github/workflows/ci.yml:32-39`, `database/Makefile:58-60`, `database/docker/Dockerfile:2-5`, `database/docker-compose.yml:33`, `docker-compose.yml:48`, `packages/db/package.json:10`, `docs/016-banco-de-dados.md:11,20`, `database/AGENTS.md:18`
- **Depende de / relacionado a:** tarefa 069 (listas de leitores de segredo)
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
O arquivo `schema.sql` é a "foto" do banco que os agentes e os revisores consultam. Hoje nada garante que a foto está atualizada, e ela não mostra quem pode ler cada coluna, justamente a parte que protege senhas e chaves. Além disso, as imagens do banco usadas no desenvolvimento, no CI e no deploy pegam sempre a versão mais nova disponível, então dois ambientes podem rodar versões diferentes sem ninguém saber.

### Evidência e análise técnica
- **Sem conferência**: o job `database` do CI (`ci.yml:32-39`) roda só `make -C database test`. Nenhum passo regenera `schema.sql` (`make dump`) nem o schema Drizzle (`pnpm db:pull`, `packages/db/package.json:10`) para comparar com o que está no git. A regra "regerado a cada mudança e commitado" (`docs/016:20`) depende só de disciplina.
- **Sem privilégios**: `make dump` usa `pg_dump --schema-only --no-owner --no-privileges` (`Makefile:58-60`). Os `GRANT SELECT` por coluna e os `REVOKE` que blindam `users.password`, `bot_token`, `api_key`, `secret_headers`, `token_hash`, `webhook_secret_hash` e `code_hash` (`docs/016:31-39`) não aparecem na referência. Quem revisa ou altera precisa reconstruir a fronteira lendo as 56 migrations. Foi o que a auditoria de 2026-11-07 (lote E) teve de fazer, e o que a tarefa 069 corrigiu só na documentação.
- **Versões flutuantes**: `FROM pgvector/pgvector:pg18` (`Dockerfile:2`) segue a última versão menor do Postgres 18 e a última do pgvector; `postgresql-18-pgtap` vem do apt sem versão (`Dockerfile:4-5`); o dbmate é `ghcr.io/amacneil/dbmate:2` (`database/docker-compose.yml:33`, `docker-compose.yml:48`). O `ai_embeddings_search` depende de `hnsw.iterative_scan` (pgvector 0.8 ou mais novo, `docs/016:187`), e o dump e a restauração dependem de o `postgresql-client-18` da imagem da aplicação (`Dockerfile` da raiz) ser compatível com o servidor.

### Verificação (tentativa de refutação)
- Conferi que o `schema.sql` atual bate com a 0056 (comentário de `telegram_update_seen`, `schema.sql:9596`) e tem a função da 0055 (`schema.sql:8623`). Hoje está em dia: o achado é de processo.
- Os testes de integração rodam contra o banco migrado e pegam parte do desvio do schema Drizzle (coluna que sumiu). Não pegam `schema.sql` velho nem coluna nova esquecida no Drizzle.
- Os privilégios são testados no pgTAP; a falta é na referência, não no banco.

### Impacto
Agentes e revisores trabalhando sobre uma referência possivelmente velha e sem a fronteira de segurança; ambientes com versões diferentes de Postgres, pgvector e pgTAP sem registro.

## Como reproduzir
1. Mude uma migration local sem rodar `make dump` e abra um PR: o CI passa.
2. `rg -n "GRANT|REVOKE" database/schema.sql` não acha nada.
3. Faça `docker pull pgvector/pgvector:pg18` em dois dias diferentes e compare `SELECT extversion FROM pg_extension WHERE extname = 'vector'`.

## Solução proposta
1. dba: `make dump` sem `--no-privileges` (mantendo `--no-owner`), ou um segundo arquivo `database/privileges.sql` gerado por `pg_dump --schema-only --no-owner` filtrado nas linhas `GRANT`/`REVOKE`/`ALTER DEFAULT PRIVILEGES`.
2. dba: fixar as versões (`pgvector/pgvector:0.8.x-pg18-bookworm` ou o digest, `postgresql-18-pgtap=<versão>`, `dbmate:2.x.y`) e registrá-las na `docs/016` (Motor e imagem).
3. app (CI): no job `database`, depois do `make test`, rodar `make dump` e `git diff --exit-code database/schema.sql`; no job `check`, `pnpm db:pull` contra o banco migrado e `git diff --exit-code packages/db/src/generated`.

## Critérios de aceite
- [ ] O CI falha quando `schema.sql` ou `packages/db/src/generated` não batem com as migrations.
- [ ] Os privilégios por coluna aparecem num arquivo de referência versionado.
- [ ] Imagem do Postgres, pgvector, pgTAP e dbmate com versão fixa, documentada.

## Testes recomendados
- O próprio passo novo do CI, com um PR de prova que esquece o `make dump`.

## Limitações e suposições
Nada foi executado. A imagem do banco de produção (projeto externo) não foi vista; ela pode já ter versão fixa.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado:
- `make dump` usava `--no-privileges`, e nenhum `GRANT`/`REVOKE` aparecia no `schema.sql`;
- o `Dockerfile` usava `pgvector/pgvector:pg18` e o pgTAP do apt sem versão;
- o dbmate era `ghcr.io/amacneil/dbmate:2`;
- o job `database` do CI só roda `make -C database test`.

Os `pg18` e `0.8.7-pg18` do Docker Hub apontam hoje para o mesmo digest, o da imagem em uso: PostgreSQL 18.7, pgvector 0.8.7, Debian bookworm. O `0.8.7-pg18` é republicado a cada versão menor do Postgres. Para isso, a tag sozinha não basta, e o digest também foi fixado.

## Resolução (executor)

### Banco (dba)

- `database/docker/Dockerfile`, com um comentário de como atualizar:
  - `FROM pgvector/pgvector:0.8.7-pg18-bookworm@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782`;
  - `postgresql-18-pgtap=1.3.4-1.pgdg12+2` e `libtap-parser-sourcehandler-pgtap-perl=3.37-1.pgdg120+1`. São as versões que já estavam instaladas.
  - Decisão: fixar também o apt do pgTAP. Quando o PGDG tirar essa versão do repositório, o build falha e a troca vira deliberada. Isso não muda o que roda em produção, porque o pgTAP só serve aos testes.
- `database/docker-compose.yml`: o serviço `dbmate` usa `ghcr.io/amacneil/dbmate:2.38.2`, a mesma versão que o `:2` resolvia.
- `make dump`:
  - continua gravando o `schema.sql` sem os privilégios, para não dobrar o arquivo;
  - passa a gravar também `database/privileges.sql`, só com as linhas `GRANT`/`REVOKE`/`ALTER DEFAULT PRIVILEGES` do `pg_dump --schema-only --no-owner`, na ordem dele. São 693 linhas hoje, inclusive os `GRANT SELECT(col)` por coluna que blindam `users.password`, `bot_token`, `api_key`, `secret_headers`, `token_hash`, `webhook_secret_hash` e `code_hash`;
  - os dois comandos rodam com `pipefail`;
  - rodar `make dump` duas vezes dá o mesmo arquivo.
- Rebuild: o container `moneyflow-db-postgres-1` foi reconstruído uma única vez, com o volume mantido, para as versões fixas e para o `02-app-role.sh` da tarefa 102.
  - Conferido depois: PostgreSQL 18.7 (Debian bookworm), pgvector 0.8.7, pgTAP 1.3.4.
  - O `make test` completo passou: 68 arquivos, 4308 testes.
- `docs/016` (Motor e imagem, Migrations e testes) e `database/AGENTS.md` (Estrutura, Comandos, Fluxo) registram as versões e o `privileges.sql`.

### Pendente na aplicação

1. `.github/workflows/ci.yml`, no job `database`, depois do `make -C database test`:
   - `make -C database dump && git diff --exit-code database/schema.sql database/privileges.sql`. Falha se a migration nova veio sem o `make dump`.
2. No job `check`, com o banco migrado: `pnpm db:pull && git diff --exit-code packages/db/src/generated`. Ele pode subir o banco por `make -C database migrate` e usar a URL do banco de desenvolvimento.
3. `docker-compose.yml` da raiz: o serviço `migrate` com `ghcr.io/amacneil/dbmate:2.38.2`, no lugar do `:2`. O `lock_timeout` da tarefa 102 também vai na `DATABASE_URL` dele.
4. `Dockerfile` da raiz: confirmar que o `postgresql-client-18` instalado é da mesma versão principal do servidor (18). Opcional: fixar a versão do apt e registrá-la na `docs/001`.
5. O deploy de produção (projeto externo) usa a imagem do banco com a mesma tag e o mesmo digest, ou registra as versões dele.

### Aplicação (app)

1. **`schema.sql`/`privileges.sql` no CI**: no job `database` do `ci.yml`, depois do `make -C database test`, `make -C database dump` e `git diff --exit-code database/schema.sql database/privileges.sql`. Conferido à mão: o `pg_dump` do banco modelo desta frente (migrado do zero) bate com os dois arquivos commitados, fora a `schema_migrations`, que lá não existe porque o modelo é migrado sem o dbmate (no CI é o dbmate).
2. **Schema Drizzle**: decisão de não usar `git diff --exit-code` depois do `pnpm db:pull`. A saída do drizzle-kit muda de ordem conforme o banco de onde sai: tabelas, imports e até as classes de operador dos índices. O `db:pull` do banco de desenvolvimento e o do banco modelo, ambos na 0072, deram arquivos diferentes com o mesmo conteúdo. No lugar dele entrou `apps/server/test/generated-schema.test.ts`, que roda na integração do job `check` e no modo local:
   - compara pelo catálogo (`pg_class`/`pg_attribute`, que o papel da aplicação lê mesmo sem acesso às colunas de segredo) as tabelas e visões do `public` com as do schema gerado (`getTableConfig`/`getViewConfig`);
   - nas tabelas, confere colunas, tipo normalizado e `NOT NULL`; nas visões, só as colunas, porque o drizzle-kit perde o `[]` das colunas de array das visões;
   - falha com a lista legível do que falta.
   Ele achou o schema gerado defasado desde 2026-10-21, sem `ai_embedding_index_stats.complete_at`, `ai_embedding_indexes.complete_at`, `financial_account_balances.balance_today_cents`, `message_outbox.deferrals`, `statement_csv_mappings.amount_sign` e `statement_import_balances.interval_difference_cents`. O `packages/db/src/generated` foi regenerado pelo `pnpm db:pull` contra o banco modelo migrado. O diff é grande porque a ordem mudou; o typecheck de todos os pacotes passou.
3. **dbmate da raiz**: `docker-compose.yml`, serviço `migrate`, com `ghcr.io/amacneil/dbmate:2.38.2` e o `lock_timeout` de 10 s da tarefa 102 na `DATABASE_URL`, como no `database/docker-compose.yml`. O `scripts/check-versions.mjs` (tarefa 184) confere que as duas versões batem e são completas.
4. **Cliente do Postgres da imagem**: o `Dockerfile` instala `postgresql-client-18`, a major do servidor. Decisão: sem fixar a versão menor do apt, porque o PGDG só mantém a mais nova e um pin quebraria o build. A chave do repositório passou a ser conferida pelo sha256 (tarefa 184), e o comentário do `Dockerfile` registra isso.
5. **Produção**: a `docs/018` (Como publicar → Versões fixas) pede ao projeto externo a imagem do banco com a mesma tag e o mesmo digest de `database/docker/Dockerfile`, ou o registro das versões dele.

Testes: `test/generated-schema.test.ts`, com o caso do banco e um caso da comparação (coluna nova, coluna a menos, tipo trocado). Antes da regeneração, ele falhou com as seis colunas acima; depois, passou no Postgres local. `scripts/check-versions.test.mjs` cobre o dbmate. Verificação: rápida, `pnpm verify:quick --base 290403d` (só o que esta frente mudou; o portão do lint, o typecheck de todos os pacotes e os testes de integração tocados no Postgres local), `pnpm test:scripts` e o build do servidor com o target `node26`.
