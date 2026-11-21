---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
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

## Resolução (executor)
