---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: dba, app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# O dono do banco usado no dump e na restauração é superusuário do Postgres

- **Severidade:** baixa (média se a produção também usar um superusuário em `DATABASE_OWNER_URL`)
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** privilégio excessivo (admin da aplicação → superusuário do cluster)
- **Arquivos afetados:** `docker-compose.yml:79-82`, `database/docker-compose.yml:10-11`, `database/docker/initdb/02-app-role.sh`, `apps/server/src/config.ts:107`, `apps/server/src/services/backup/dump.ts:195-241,243-263`, `.env.example:17`, `docs/016-banco-de-dados.md:30-36`, `docs/019-backup-e-restauracao.md:37`
- **Depende de / relacionado a:** 048 (com o XSS, uma sessão de admin sequestrada chega aqui)
- **Esforço estimado:** M
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
O botão de restaurar o backup usa a senha mestra do servidor de banco, não uma senha limitada ao banco do MoneyFlow. Restaurar é rodar o conteúdo do arquivo. Quem subir um arquivo de backup forjado como admin passa a mandar no servidor de banco inteiro, e não só nos dados do app.

### Evidência e análise técnica
- Só o serviço `api` recebe `DATABASE_OWNER_URL: postgres://${POSTGRES_USER:-moneyflow}:...` (`docker-compose.yml:81-82`). O worker não recebe.
- Na imagem `pgvector/pgvector:pg18`, o `POSTGRES_USER` (`database/docker-compose.yml:10-11`) é criado como SUPERUSER. `02-app-role.sh` cria só o `moneyflow_app`. Não existe um papel dono sem SUPERUSER.
- A restauração roda `pg_restore --clean --if-exists --single-transaction --exit-on-error --no-owner` com `pgEnv(ownerDatabaseUrl)` (`dump.ts:256-261`). O arquivo é conferido só pelo cabeçalho/zip (`:195-218`) e pela versão em `schema_migrations` (`:221-241`), que o atacante copia de um dump legítimo. Um dump custom forjado pode trazer SQL livre, por exemplo `COPY ... TO PROGRAM`.

### Verificação (tentativa de refutação)
- Usar o dono para dump e restore é intencional e documentado (`docs/016:36`, `docs/019:37`, comentário em `dump.ts:15-24`). Que o dono seja **superusuário** não é decisão documentada: é efeito do compose.
- A parte "a URL do dono anula a blindagem dos segredos" foi refutada: com a API comprometida, o `moneyflow_app` já lê os segredos pelos `admin_*`, que confiam no ator por decisão documentada (`0002_users.sql:124-126`). O ganho real é outro: superusuário do cluster, com comandos no container, os outros bancos, triggers e auditoria desligáveis.
- Proteções existentes: `assertAdmin` (`dump.ts:244`), a confirmação `RESTAURAR`, e o restore fora das tools (`docs/019:41`).

### Impacto
Um admin, ou uma sessão de admin sequestrada, ganha execução de comandos no container do Postgres e acesso a todo o cluster, inclusive para apagar a trilha de auditoria.

## Como reproduzir
Não executado. Com o compose padrão, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user` pela `DATABASE_OWNER_URL` devolve true.

## Solução proposta
- **dba:** criar um papel `moneyflow_owner` LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB, dono do banco e do schema `public`, e rodar as migrations com ele. As extensões ficam com o superusuário só no initdb. Migrar a posse nos bancos existentes.
- **app:** usar esse papel em `DATABASE_OWNER_URL` no compose e no `.env.example`. Opcional: recusar a restauração se a conexão do dono tiver `rolsuper`.
- Documentar em `docs/016`, `docs/019` e `database/AGENTS.md` que o dono não pode ser superusuário.
- Sequência: primeiro o dba, depois o app.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/database/docker/initdb/02-app-role.sh
+++ b/database/docker/initdb/02-app-role.sh
@@
     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moneyflow_app') THEN
       CREATE ROLE moneyflow_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
     END IF;
+    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moneyflow_owner') THEN
+      CREATE ROLE moneyflow_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${OWNER_DB_PASSWORD}';
+    END IF;
   END
   \$\$;
+  ALTER DATABASE "${POSTGRES_DB}" OWNER TO moneyflow_owner;
+  ALTER SCHEMA public OWNER TO moneyflow_owner;
--- a/docker-compose.yml
+++ b/docker-compose.yml
@@
-      DATABASE_OWNER_URL: postgres://${POSTGRES_USER:-moneyflow}:${POSTGRES_PASSWORD:-moneyflow}@postgres:5432/${POSTGRES_DB:-moneyflow}?sslmode=disable
+      DATABASE_OWNER_URL: postgres://moneyflow_owner:${OWNER_DB_PASSWORD:?defina}@postgres:5432/${POSTGRES_DB:-moneyflow}?sslmode=disable
```

## Critérios de aceite
- [ ] Pela `DATABASE_OWNER_URL` do compose, `rolsuper` é false.
- [ ] Dump e restauração continuam funcionando.
- [ ] Um dump com `COPY ... TO PROGRAM` falha com 42501, e nada muda (transação única).
- [ ] Specs 016 e 019 e `database/AGENTS.md` atualizados.

## Testes recomendados
pgTAP: o papel dono existe sem `rolsuper`, `rolcreaterole` e `rolcreatedb`. Integração em `apps/server/test/backup.test.ts`: ida e volta do dump com o dono não superusuário. Nada disso foi executado nesta auditoria.

## Limitações e suposições
- **Hipótese não testada:** `pg_restore --clean` emite `DROP/CREATE EXTENSION` para `vector`, `pg_trgm` e `citext`. Sem superusuário, isso só funciona se as extensões forem trusted ou forem do dono. Pode ser preciso tirá-las do dump ou do restore.
- A configuração de produção não foi vista.
- Mesmo sem superusuário, o dono continua podendo trocar todos os dados: é o próprio recurso.

## Análise (triagem)

Confirmado (dba, 2026-11-07): o `POSTGRES_USER` da imagem é o superusuário de bootstrap e era dono de tudo; a `DATABASE_OWNER_URL` do compose o usava. Testado num container descartável: a hipótese das extensões procede (`vector` não é trusted; `pg_restore --clean` como dono falha em `DROP EXTENSION IF EXISTS vector`: "must be owner of extension vector"). Achado novo, mais grave e independente do papel: **a restauração do dump hoje derruba a blindagem por coluna dos segredos**. O pg_dump grava os GRANTs em relação ao padrão embutido do Postgres; com `--clean`, as tabelas são recriadas num banco que já tem o `ALTER DEFAULT PRIVILEGES` da 0001 e nascem com `SELECT, INSERT, UPDATE, DELETE` na tabela inteira para `moneyflow_app`. Reproduzido também com o superusuário e as flags atuais do `dump.ts`: depois do restore, `has_column_privilege('moneyflow_app','users','password','SELECT')` e o mesmo para `message_destinations.bot_token` dão `true`. Executor: dba (banco, feito) e depois app (compose, `.env.example`, `dump.ts`, docs/019, testes).

## Resolução (executor)

Parte do banco (dba), feita e testada:
- `database/docker/initdb/03-owner-role.sh` (novo, idempotente): cria `moneyflow_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS` com a senha `OWNER_DB_PASSWORD` (padrão de dev `moneyflow_owner`; num papel existente só garante os atributos); para cada banco de `OWNER_DBS` (padrão `<db>` e `<db>_test`): dono do banco e do schema `public`, as extensões `vector`, `pg_trgm` e `citext` criadas pelo superusuário, e, num banco já migrado (volume antigo), a posse de tabelas, visões, sequences, funções e tipos passada ao dono, os privilégios padrão da 0001 refeitos para o dono e os do superusuário devolvidos ao padrão (senão o dump levaria um `ALTER DEFAULT PRIVILEGES FOR ROLE <superusuário>` que o dono não restaura).
- `database/docker-compose.yml`: `OWNER_DB_PASSWORD` no serviço `postgres`; o `dbmate` conecta como `moneyflow_owner` (`DATABASE_URL` e `TEST_DATABASE_URL`). `database/Makefile`: alvo `make owner` (roda o script no container); `migrate`/`rollback`/`status`/`test`/`reset` dependem dele; `test` e `reset` recriam o banco pelo superusuário já com `OWNER moneyflow_owner` (o dono não tem CREATEDB) e migram como o dono. `database/.env.example`: `OWNER_DB_PASSWORD`.
- `database/migrations/0055_restore_default_privileges.sql`: função `restore_reset_default_privileges()` (`EXECUTE` só do dono; revogado de `moneyflow_app` e PUBLIC), que zera os privilégios padrão do papel que chama neste banco; chamada no início da mesma transação do restore, os objetos recriados recebem exatamente os GRANTs do dump e as entradas `DEFAULT ACL` do dump devolvem os privilégios padrão no fim. Down: `DROP FUNCTION`.
- pgTAP: `database/tests/0055_restore_default_privileges.sql` (o papel existe, faz login, sem `rolsuper`/`rolcreaterole`/`rolcreatedb`/replicação/bypassrls, sem ser membro de outro papel; dono do banco, do `public`, das tabelas e funções das migrations; `moneyflow_app` sem acesso à `schema_migrations`; a função zera os privilégios padrão e não é do app). `database/tests/0001_base.sql`: o teste dos privilégios padrão cria os objetos com `SET LOCAL ROLE moneyflow_owner` (quem roda as migrations).
- Docs: `docs/016` (Segurança: o dono não é superusuário, extensões do superusuário, a receita da restauração; Motor e imagem), `docs/INDEX.md` (resumo da 016) e `database/AGENTS.md` (estrutura, `make owner`, Segurança).

Testes:
- Container descartável (imagem nova, volume novo, porta 55499): o initdb criou o papel e passou a posse; `dbmate up`, `rollback` e `up` de todas as migrations como o dono; todo o pgTAP (51 arquivos, 3955 testes) passou num banco migrado pelo dono; restore com as flags atuais falhou em `DROP EXTENSION` (como previsto); a receita abaixo restaurou sem erro e as ACLs de todas as tabelas, colunas, funções e privilégios padrão ficaram idênticas às de um banco recém-migrado (1028 linhas comparadas), `users.password` e `ai_providers.api_key` seguem sem SELECT para o app; um dump com `COPY (SELECT 1) TO PROGRAM 'id'` no fim falhou com "permission denied to COPY to or from an external program" e as ACLs ficaram intactas (transação desfeita); um banco migrado pelo superusuário e convertido pelo script ficou com as ACLs idênticas às do banco novo, migrou/fez rollback como o dono e restaurou pela receita.
- Banco de desenvolvimento (5432, volume mantido): `make up` recriou o container (env e porta mudaram) e o `make owner` converteu `moneyflow` e `moneyflow_test` (dados intactos, `pnpm dev` com `moneyflow_app` inalterado). `make test T="/tests/0001_base.sql /tests/0054_ai_provider_api_key_readers.sql /tests/0055_restore_default_privileges.sql"` (rápido): PASS (91 testes). `make dump` aplicou 0054 e 0055 no banco de desenvolvimento e regravou `schema.sql`.

**O que o app precisa mudar** (nada disso foi feito pelo dba):
1. `docker-compose.yml` da raiz:
   - serviço `api`: `DATABASE_OWNER_URL: postgres://moneyflow_owner:${OWNER_DB_PASSWORD:-moneyflow_owner}@postgres:5432/${POSTGRES_DB:-moneyflow}?sslmode=disable` (ou `:?` para exigir a senha fora do dev);
   - serviço `migrate`: `DATABASE_URL` com o mesmo `moneyflow_owner:${OWNER_DB_PASSWORD:-moneyflow_owner}` — migration rodada pelo superusuário deixa objetos dele e a restauração pelo dono falha. O `OWNER_DB_PASSWORD` já chega ao Postgres pelo `database/docker-compose.yml` incluído.
   - Volume já existente da pilha: rebuildar a imagem do Postgres e rodar uma vez `docker compose exec postgres bash /docker-entrypoint-initdb.d/03-owner-role.sh` (idempotente) antes do `migrate` como o dono.
2. `.env.example` da raiz: `OWNER_DB_PASSWORD=moneyflow_owner` (dev) e o comentário de que em produção a `DATABASE_OWNER_URL` usa um papel dono sem SUPERUSER/CREATEROLE/CREATEDB, dono do banco, do `public` e dos objetos, com as extensões criadas pelo superusuário.
3. `apps/server/src/services/backup/dump.ts`, `restoreDump` (corrige também o vazamento dos GRANTs, que existe hoje):
   - lista sem extensões: `pg_restore -l <dump>`, filtrar fora as linhas que casam `/^\d+; \d+ \d+ (EXTENSION|COMMENT - EXTENSION) /`, gravar o arquivo (0600) no diretório temporário;
   - trocar o `pg_restore --single-transaction --exit-on-error --dbname=…` por um pipe: `pg_restore --clean --if-exists --no-owner -L <lista> -f - <dump>` → stdin de `psql -X -q --single-transaction -v ON_ERROR_STOP=1 -c 'SELECT restore_reset_default_privileges()' -f -` com o `pgEnv(ownerDatabaseUrl)` (+ `PGOPTIONS=-c lock_timeout=30s`) nos dois; sucesso só com os dois códigos 0 (o erro sai no stderr do `psql`). O `-c` antes do `-f -` roda na mesma transação, antes do SQL do dump.
   - opcional (critério da tarefa): antes de restaurar, recusar se `SELECT rolsuper FROM pg_roles WHERE rolname = current_user` for true pela conexão do dono.
   - o `pg_dump` não muda (as extensões continuam no dump; a lista as tira no restore, o que também cobre dumps já gerados).
4. Testes do app: `apps/server/test/global-setup.ts` hoje passa `postgres://moneyflow:moneyflow@…` como `ownerDatabaseUrl`; passar `moneyflow_owner` (o initdb da imagem já cria o papel com `OWNER_DB_PASSWORD`, padrão `moneyflow_owner`) e aplicar as migrations como ele. O `freshDatabase()` precisa de CREATEDB: criar os bancos pelo superusuário com `OWNER moneyflow_owner` e as três extensões (o script `03-owner-role.sh` com `OWNER_DBS=<banco>` faz isso). Em `test/backup.test.ts`, a ida e volta do dump pelo dono não superusuário e a conferência de que, depois do restore, `has_column_privilege('moneyflow_app','users','password','SELECT')` continua false (pega a regressão dos GRANTs). O modo local (`local-db.ts`, `MONEYFLOW_TEST_LOCAL_OWNER_URL`) segue com o superusuário para criar bancos; os bancos `moneyflow_it*` não foram convertidos.
5. `docs/019-backup-e-restauracao.md`: o dono não é superusuário, a restauração não toca nas extensões e zera os privilégios padrão na transação (docs/016 já descreve).
6. `pnpm db:pull` para pegar a função nova (0055) e o comentário (0054).

Parte do app (app), feita, seguindo o recado acima:
1. `docker-compose.yml` da raiz: `migrate` (`DATABASE_URL`) e `api` (`DATABASE_OWNER_URL`) como `moneyflow_owner:${OWNER_DB_PASSWORD:-moneyflow_owner}`, com o comentário do volume antigo (`docker compose exec postgres bash /docker-entrypoint-initdb.d/03-owner-role.sh` uma vez antes). `docker compose config` confere as duas URLs.
2. `.env.example`: `OWNER_DB_PASSWORD=moneyflow_owner`, a `DATABASE_OWNER_URL` de dev como `moneyflow_owner` e o comentário de produção (papel dono sem SUPERUSER/CREATEROLE/CREATEDB, dono do banco, do `public` e dos objetos, rodando as migrations; extensões pelo superusuário; um superusuário ainda funciona, com aviso).
3. `services/backup/dump.ts`, `restoreDump`: `pg_restore --list` filtrado sem `EXTENSION`/`COMMENT - EXTENSION` (arquivo 0600 no diretório temporário) e o pipe `pg_restore --clean --if-exists --no-owner -L <lista> -f - <dump>` → `psql -X -q --single-transaction -v ON_ERROR_STOP=1 -c 'SELECT restore_reset_default_privileges()' -f -`, com `pgEnv(DATABASE_OWNER_URL)` + `PGOPTIONS=-c lock_timeout=30s`; sucesso só com os dois códigos 0 (o stderr do psql vai primeiro na mensagem). **Superusuário não é recusado** (a produção hoje usa um): a restauração consulta `rolsuper` pela conexão do dono e só registra um aviso no log. `dumpAvailability` também exige o `psql` (`t.backup.errors.noPsql`). O `pg_dump` não mudou.
4. Testes: `test/global-setup.ts` (Testcontainers com `OWNER_DB_PASSWORD`, migrations como `moneyflow_owner`, `ownerDatabaseUrl` do dono e o novo `superDatabaseUrl`); `test/migrate.ts` (`createOwnedDatabase`: banco criado pelo superusuário com `OWNER moneyflow_owner`, `public` do dono e as três extensões, como o `03-owner-role.sh`); `test/local-db.ts` (o modo local também: o modelo `moneyflow_it_tpl` e o `moneyflow_it` do dono, migrados por ele — `MONEYFLOW_TEST_LOCAL_SUPER_URL` cria, `MONEYFLOW_TEST_LOCAL_OWNER_URL` agora é o dono; o hash do modelo ganhou o sal `owner-v1`, então o modelo antigo é refeito); `test/helpers.ts` (`freshDatabaseUrls({ migrateAs })` e `freshDatabase()` sobre ele; `dropFreshDatabases` pelo superusuário). Em `test/backup.test.ts`, `describe('backup: dump e restauração pelo dono (tarefa 054)')`: (a) o dono não é superusuário nem CREATEDB, e a ida e volta do dump pela API num banco novo do dono (uma categoria criada depois do dump some na restauração) mantém `has_column_privilege('moneyflow_app', …, 'SELECT')` false para `users.password`, `message_destinations.bot_token` e `ai_providers.api_key`, e as ACLs de tabelas, colunas, funções e privilégios padrão iguais às de antes; (b) o mesmo com o superusuário na `DATABASE_OWNER_URL` num banco migrado por ele (o arranjo da produção de hoje). Sem `pg_dump`/`psql` 18 (`PG_BIN_DIR` ou `PATH`), os dois ficam pulados. Conferido que o teste (a) falha sem a chamada a `restore_reset_default_privileges()` (`users.password: true`).
5. `docs/019` (a restauração pelo psql sem as extensões, os privilégios padrão zerados na transação, o dono sem superusuário e o aviso), `docs/INDEX.md`, `docs/018` (o que a produção precisa para trocar o superusuário) e `AGENTS.md` (bancos de teste do dono; o teste do dump precisa do cliente 18).
6. `pnpm db:pull` rodado: o Drizzle não gera funções nem comentários, e a única diferença foi a ordem do catálogo (que mudou com a troca de posse e fazia o `postpull` omitir FKs em ciclo diferentes). Revertido: `packages/db/src/generated` sem mudança.

Resultados: `test/backup.test.ts` inteiro no Postgres local com `PG_BIN_DIR=/opt/homebrew/opt/libpq/bin` (25 passed) e os testes do dump e "recursos num sistema novo" no Testcontainers (18 passed). Não testado: o dump forjado com `COPY … TO PROGRAM` pela API (o dba o testou no container; com o dono, falha com 42501 e nada muda) e a restauração cruzada (dump de um banco cujos objetos e privilégios padrão são do superusuário, restaurado pelo `moneyflow_owner`), que pode falhar nas entradas DEFAULT ACL do superusuário — registrado em `docs/018`.

