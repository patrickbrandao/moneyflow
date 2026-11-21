---
status: aberta
tipo: banco
origem: agente
autor: principal
responsavel:
prioridade: media
criada: 2026-11-21
commit:
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

## Resolução (executor)
