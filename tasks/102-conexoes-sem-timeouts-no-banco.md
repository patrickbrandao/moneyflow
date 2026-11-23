---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: media
criada: 2026-11-21
commit: 09b0ea7
---

# Papel da aplicação, pool e migrations sem nenhum timeout no Postgres

- **Severidade:** média
- **Confiança:** provável
- **Categoria:** ponto fraco
- **Subcategoria:** disponibilidade (timeouts e fila de locks)
- **Arquivos afetados:** `packages/db/src/index.ts:27-29`, `apps/server/src/main.ts:14`, `database/docker/initdb/02-app-role.sh:4-12`, `docker-compose.yml:47-58`, `database/docker-compose.yml:32-45`, `apps/server/src/services/backup/dump.ts:357`, `docs/016-banco-de-dados.md:31-39`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** M
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Se uma consulta demorar demais, ou uma transação ficar aberta por engano, ela segura uma das poucas conexões do sistema para sempre. E, durante uma atualização de versão, uma migration pode esperar indefinidamente por uma tabela ocupada, enfileirando atrás dela todas as telas que usam a mesma tabela. Nos dois casos, o sistema "trava" sem dar erro.

### Evidência e análise técnica
- **Pool**: `createPool` (`packages/db/src/index.ts:27-29`) cria `new pg.Pool({ connectionString, max, application_name })`, sem `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` nem `connectionTimeoutMillis`. O node-postgres instalado (`pg@8.23.1`, `lib/connection-parameters.js:121-123`) aceita os três primeiros direto na configuração. Com `connectionTimeoutMillis = 0` (padrão), quem pede conexão a um pool esgotado espera para sempre. Um processo tem 10 conexões (`main.ts:14`). O worker divide essas 10 entre até `AGENT_CONCURRENCY` execuções, 2 transcrições, o laço de mensagens, as tarefas e a manutenção.
- **Papel**: `02-app-role.sh` só cria `moneyflow_app LOGIN PASSWORD …`, sem `ALTER ROLE … SET statement_timeout …`. Nenhuma migration, nem o compose, define esses parâmetros (procurei `statement_timeout|idle_in_transaction|lock_timeout` em `database/` e na raiz).
- **Migrations**: o serviço `migrate` (`docker-compose.yml:47-58`) roda `dbmate up` como `moneyflow_owner`, sem `lock_timeout`. No `docker compose up -d` de uma versão nova, a API e o worker antigos tendem a continuar no ar enquanto o `migrate` roda, porque dependem dele e só são recriados depois (o deploy de produção, por script externo, não foi visto). Um `ALTER TABLE` que espera o lock de uma transação longa do worker antigo (a materialização das séries, um export de backup) bloqueia todas as consultas seguintes àquela tabela, enquanto espera.
- O projeto já conhece o problema num ponto: a restauração do dump roda com `PGOPTIONS: '-c lock_timeout=30s'` (`dump.ts:357`).

### Verificação (tentativa de refutação)
- A regra "nunca segurar transação durante a chamada ao modelo" (AGENTS.md) evita o caso mais comum de transação ociosa, mas não cobre bug nem consulta lenta. O `setWebhook` dentro da transação (`messages.ts:222-227`) tem o timeout do Telegram (10 s), então é limitado.
- O Fastify não cancela a consulta quando o cliente desiste: um relatório de 1100 dias ou uma busca do admin em todas as conversas (`ai_conversation_search` com `p_user_id` nulo) seguem até o fim mesmo com a aba fechada.
- O compose de produção fica num projeto externo e não foi visto. Ele pode já definir parâmetros no `postgresql.conf`. Por isso a confiança é provável.

### Impacto
Indisponibilidade parcial ou total da API ou do worker sem mensagem de erro: o pool esgotado, ou consultas presas na fila de lock atrás de uma migration. É raro, mas o momento mais provável é o deploy.

## Como reproduzir
1. Num banco local, abra `psql` como `moneyflow_app`, rode `BEGIN; SELECT 1 FROM titles LIMIT 1 FOR UPDATE;` e deixe aberto.
2. Rode uma migration com `ALTER TABLE titles ADD COLUMN x int;` pelo dbmate: ela espera sem limite.
3. Em outra sessão, `SELECT * FROM titles LIMIT 1` também espera, atrás do `ACCESS EXCLUSIVE` pedido.
4. Para o pool: abra 10 requisições lentas ao mesmo tempo e veja a 11ª pendurada sem erro.

## Solução proposta
1. app (`packages/db/src/index.ts`): `createPool` com `statement_timeout` (ex.: 60 s, configurável por variável), `idle_in_transaction_session_timeout` (ex.: 5 min), `connectionTimeoutMillis` (ex.: 10 s) e `lock_timeout` com folga (ex.: 30 s, maior que as esperas legítimas de advisory lock). O backup JSON e a busca do admin podem usar `SET LOCAL statement_timeout` maior na própria transação.
2. dba: `lock_timeout` nas migrations, por `?options=-c%20lock_timeout%3D10s` na `DATABASE_URL` do `migrate` (raiz e `database/`), ou `SET lock_timeout` no topo das migrations novas (regra em `database/AGENTS.md`). Opcional: `ALTER ROLE moneyflow_app SET idle_in_transaction_session_timeout = '5min'` no `02-app-role.sh`, como rede de segurança fora da aplicação.
3. Documentar os valores na `docs/016` (seção Segurança) e no guia de deploy de produção.

## Critérios de aceite
- [ ] Uma consulta do papel da aplicação acima do limite falha com `57014`, e a API responde 503 ou 500 com mensagem, sem segurar a conexão.
- [ ] Uma transação ociosa da aplicação é encerrada pelo servidor depois do prazo.
- [ ] Uma migration que não consegue o lock falha em segundos (o deploy para, sem enfileirar a API).
- [ ] Pool esgotado dá erro em `connectionTimeoutMillis`, não espera infinita.

## Testes recomendados
- `apps/server/test/` (integração, modo local): `SELECT pg_sleep(…)` acima do `statement_timeout` configurado no teste devolve erro traduzido; `SHOW idle_in_transaction_session_timeout` numa conexão do pool devolve o valor configurado.
- pgTAP não se aplica (parâmetro de sessão); conferir no `make test` que `dbmate up` com a URL nova continua passando.

## Limitações e suposições
Nada foi executado. A configuração do Postgres de produção (projeto externo) não foi vista. Os valores sugeridos são pontos de partida e dependem do tempo das operações mais longas (backup, relatórios).

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado:
- Nem `database/` (migrations, `docker/initdb`, compose) nem o papel `moneyflow_app` definiam `statement_timeout`, `lock_timeout` ou `idle_in_transaction_session_timeout`.
- O serviço `dbmate` daqui e o `migrate` da raiz conectavam sem `lock_timeout`.
- Verifiquei que o dbmate 2.38.2 (lib/pq) repassa o parâmetro `options` da URL à sessão. Uma migration de prova que recusa `lock_timeout <> '10s'` passou com `options=-c%20lock_timeout%3D10s` e falhou sem ele (`lock_timeout = 0`). A prova rodou num banco descartável, já apagado.
- Achado ligado, para a aplicação: o `PGOPTIONS: '-c lock_timeout=30s'` da restauração (`dump.ts:357`) não vale. O SQL que o `pg_restore -f -` gera começa com `SET lock_timeout = 0` (e `statement_timeout`, `idle_in_transaction_session_timeout` e `transaction_timeout` = 0), que vence o `PGOPTIONS`. O mesmo cabeçalho aparece no topo do `schema.sql`.

## Resolução (executor)

### Banco (dba)

- `database/docker-compose.yml`: o `DATABASE_URL` e o `TEST_DATABASE_URL` do serviço `dbmate` levam `&options=-c%20lock_timeout%3D10s`. A migration que não consegue o lock falha em 10 s, em vez de esperar sem limite e enfileirar as consultas da aplicação àquela tabela. Sem `statement_timeout`, porque a migration de dados pode demorar.
- `database/docker/initdb/02-app-role.sh` (agora idempotente): `ALTER ROLE moneyflow_app SET idle_in_transaction_session_timeout = '5min'`, como rede de segurança fora da aplicação.
  - Decisão: o papel não recebe `statement_timeout` nem `lock_timeout`. Um padrão no papel derrubaria as esperas legítimas (advisory locks do worker, a trava do fechamento de mês da 0059, o backup), e esses prazos ficam no pool, com exceções por transação.
- `database/Makefile`: `make owner` roda também o `02-app-role.sh`, para um volume antigo ganhar a configuração. O `make test` já depende de `owner`.
- O container foi reconstruído uma vez, junto com a tarefa 163, porque o `02-app-role.sh` faz parte da imagem. Conferido: `SHOW idle_in_transaction_session_timeout` como `moneyflow_app` devolve `5min`.
- pgTAP: `tests/0001_base.sql` confere a configuração do papel em `pg_db_role_setting`.
- `docs/016` (Segurança, "Prazos no Postgres") registra os prazos e o cabeçalho do `pg_dump`.
- `make test` completo (68 arquivos, 4308 testes) passou.

### Pendente na aplicação

1. `packages/db/src/index.ts` (`createPool`): passar ao `pg.Pool`
   - `statement_timeout` (por exemplo 60 s, por variável, como `DB_STATEMENT_TIMEOUT_MS`);
   - `lock_timeout` (por exemplo 30 s, acima das esperas legítimas por advisory lock e pela trava do fechamento de mês);
   - `idle_in_transaction_session_timeout` (5 min);
   - `connectionTimeoutMillis` (por exemplo 10 s).

   O node-postgres aceita os três primeiros direto na configuração. O que precisa de mais tempo usa `SET LOCAL statement_timeout` maior na própria transação: o export do backup JSON, a busca do admin em todas as conversas (`ai_conversation_search` com `p_user_id` nulo) e os relatórios longos.
2. `apps/server/src/errors.ts`: traduzir `57014` (cancelado pelo `statement_timeout`), `55P03` (`lock_not_available`) e o erro de espera por conexão do pool para 503 com mensagem em pt-BR.
3. `docker-compose.yml` da raiz (serviço `migrate`): `DATABASE_URL` com `&options=-c%20lock_timeout%3D10s`, como o de `database/`. O deploy de produção (projeto externo) faz o mesmo, e roda `ALTER ROLE moneyflow_app SET idle_in_transaction_session_timeout = '5min'` uma vez, porque lá o `initdb` daqui não roda.
4. `apps/server/src/services/backup/dump.ts` (restauração): o `PGOPTIONS` com `lock_timeout=30s` é anulado pelo `SET lock_timeout = 0` do SQL do `pg_restore`. Para limitar a espera, troque essa linha no fluxo, de `SET lock_timeout = 0;` para `SET lock_timeout = '30s';` entre o `pg_restore` e o `psql`, ou aceite a espera sem limite e retire o `PGOPTIONS`. Precisa de teste em `test/backup.test.ts`.
5. Testes de integração (modo local):
   - `SHOW statement_timeout`, `lock_timeout` e `idle_in_transaction_session_timeout` numa conexão do pool devolvem os valores configurados;
   - `SELECT pg_sleep(…)` acima do `statement_timeout` do teste devolve o erro traduzido.

### Aplicação (app)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: `createPool` sem nenhum prazo, nenhum tratamento de 57014/55P03 e o `SET lock_timeout = 0` do SQL do `pg_restore` anulando o `PGOPTIONS` da restauração.

1. **Pool** (`packages/db/src/index.ts`): `createPool(url, max, { statementTimeoutMs, lockTimeoutMs, idleInTransactionTimeoutMs, connectionTimeoutMs, onError })`, com os padrões em `DEFAULT_POOL_TIMEOUTS` (60 s, 30 s, 5 min, 10 s) e `keepAlive`. A configuração (`config.dbTimeouts`) lê `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` e `DB_CONNECTION_TIMEOUT_MS` (no `.env.example`), e o `main.ts` os passa ao pool.
   - Prazo maior só na própria transação: `longRead(db, prazo, fn)` em `services/tx.ts` (só leitura, `set_config('statement_timeout', …, true)`), usado no export do backup JSON (30 min), na busca do admin em todas as conversas (`listConversations` com `userId: 'all'`, 5 min) e nas três consultas dos relatórios (5 min).
2. **Tradução** (`errors.ts`): `57014` e `55P03` viram `503` (`pg_57014`, `pg_55P03`) com `retry-after: 5` e a mensagem em `DB_CODE_MESSAGES`; a espera por conexão do pool (o pg-pool não dá código: `isPoolTimeout` pela mensagem, `POOL_CONNECT_TIMEOUT_MESSAGES`) vira `503 db_busy` (`t.errors.databaseBusy`). O tratador da API manda os cabeçalhos do erro traduzido e loga o 503 como aviso.
3. **Compose da raiz**: conferido, o `migrate` já tem `&options=-c%20lock_timeout%3D10s` (frente de infraestrutura). O deploy de produção (URL do dbmate e o `ALTER ROLE` uma vez) ficou registrado na `docs/018` (Ambientes).
4. **Restauração** (`services/backup/dump.ts`): `restoreLockTimeout(ms)`, uma passagem entre o `pg_restore` e o `psql`, troca a linha `SET lock_timeout = 0;` do cabeçalho por `SET lock_timeout = '<ms>ms';` (procura nos primeiros 64 KB; o resto passa igual). O prazo é o mesmo do pool (`DB_LOCK_TIMEOUT_MS`), também no `PGOPTIONS`. Com a passagem no meio, o `pg_restore` não via o `psql` sair: quando o consumidor fecha antes, a ponta de leitura é fechada e ele recebe o EPIPE (sem isso, a restauração que falha ficava pendurada).
   - Decisão: limitar a espera (e não retirar o `PGOPTIONS`): a restauração que espera um lock falha no prazo, com a transação desfeita.
5. Docs: `docs/016` (Prazos no Postgres: valores, `longRead`, 503 e a troca na restauração) e `docs/018`.

Testes:
- `test/db-pool.test.ts` (novo): os prazos padrão e os da configuração numa conexão do pool (`current_setting`); `pg_sleep` acima do prazo → `57014` traduzido para 503, e a conexão volta usável; o `SET LOCAL` vencendo o prazo só na transação; a espera por advisory lock → `55P03` → 503; o pool esgotado responde em `connectionTimeoutMillis` com `db_busy`; a API responde 503 com `retry-after` quando a consulta passa do prazo.
- `test/backup.test.ts`: a passagem troca só a linha do cabeçalho, mesmo com a entrada partida em pedaços de 1 e 7 bytes, e deixa intacto o SQL sem ela; a restauração com um lock segurado por outra transação falha em segundos com `DB_LOCK_TIMEOUT_MS=1000` (422 `restore_failed`, "lock timeout") e não muda nada. Rodado aqui com o cliente do PostgreSQL 19 (`PG_BIN_DIR=/opt/homebrew/opt/libpq/bin`): a ida e volta do dump também passou.
- `test/config.test.ts`: os padrões e as faixas das variáveis novas.

Verificação: rápida, `pnpm verify:quick --base f2f6e4d` (com `MONEYFLOW_TEST_LOCAL_DB=moneyflow_it_p2b`).
