---
status: concluida
tipo: banco
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-21
commit: 0d8d59c
---

# Requisição ao provedor interrompida por queda do processo fica "em andamento" até a purga

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** ciclo de `ai_requests` (spec 023)
- **Arquivos afetados:** `apps/server/src/agents/llm/request-log.ts:6-22,545-558`, `database/schema.sql:2214-2292` (`ai_requests_before_write`), `database/schema.sql:2306-2330` (`ai_requests_purge`), `database/schema.sql:1651-1690` (`ai_provider_health`), `apps/server/src/agents/worker.ts:188-194`, `docs/023-requisicoes-ao-provedor.md`
- **Depende de / relacionado a:** —
- **Executor sugerido:** dba e depois app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Cada chamada à IA vira uma linha na tela Requisições, que começa "em andamento" e é fechada quando a resposta chega. Se o worker for reiniciado no meio da resposta (um deploy, por exemplo), essa linha nunca é fechada e fica "em andamento" por 30 dias, até ser apagada. O admin vê chamadas fantasmas e não sabe que elas caíram.

### Evidência e análise técnica
- A requisição nasce `running` no INSERT e só é fechada pelo `UPDATE … WHERE id = … AND status = 'running'` do fim da chamada (`request-log.ts:545-558`). Se esse UPDATE falhar, a falha vira só um aviso no log (`request-log.ts:21,556-557`).
- Com o processo morto (SIGKILL no `docker stop` depois do prazo, OOM, queda), ninguém fecha a linha. O worker espera as execuções em andamento ao parar (`agents/worker.ts:188-194`), mas um streaming longo passa do prazo padrão de 10 s do `docker stop`.
- `ai_run_claim` retoma a execução com reserva velha e cria requisições novas. A antiga continua `running`.
- O banco não tem reaper: `ai_requests_purge` (`schema.sql:2306-2330`) apaga pela idade, sem olhar o status; `ai_provider_health` ignora as `running` (`schema.sql:1675`). Nenhuma função ou laço passa `running` velha a `error`/`canceled`.

### Verificação (tentativa de refutação)
- O trigger permite o fechamento depois (`running` → final, com `finished_at`; `ai_requests_before_write`, `schema.sql:2263-2289`), então a correção não exige mudar a imutabilidade.
- A saúde do provedor não é distorcida (as `running` ficam de fora), mas também não registra a falha.
- Não há teste de integração para requisição órfã em `apps/server/test/ai-requests.test.ts` (o arquivo nem menciona o status `running`); o pgTAP da 0040 cobre só o ciclo normal e a imutabilidade.

### Impacto
A tela Requisições e o detalhe do provedor mostram, por até `AI_REQUEST_RETENTION_DAYS`, chamadas "em andamento" que já morreram, uma por chamada interrompida em cada deploy ou queda. A taxa de erro do provedor não conta essas falhas.

## Como reproduzir
1. Com o provedor falso (`e2e/fakes/fake-llm.ts`) respondendo devagar, inicie uma conversa.
2. Mate o worker no meio do streaming (`docker kill moneyflow-worker-1`) e suba de novo.
3. Em /admin/ai → Requisições, a primeira chamada continua "em andamento"; a execução foi retomada com outra requisição.

## Solução proposta
1. dba: `ai_requests_close_stale(p_after interval DEFAULT '30 minutes')` passa a `error` (mensagem `interrupted: worker stopped`, `finished_at` = agora) as `running` iniciadas há mais que o prazo, em lote com `FOR UPDATE SKIP LOCKED`, e devolve quantas. O prazo fica acima do maior timeout de chamada (o `AI_DOCUMENT_TIMEOUT_MS` e o do streaming).
2. app: chamar no laço de manutenção (`agents/worker.ts`), junto da purga das requisições.
3. `docs/023` (Ciclo) e `docs/016` (Requisições): a regra do fechamento.

## Critérios de aceite
- [ ] Requisição `running` mais velha que o prazo vira `error` com motivo e `finished_at`.
- [ ] Requisição em andamento dentro do prazo não é tocada.
- [ ] A saúde do provedor passa a contar essas falhas.

## Testes recomendados
- pgTAP em `database/tests/0040_ai_requests_and_app_settings.sql`: `running` antiga fecha, recente fica, terminada não muda, limite respeitado.
- `apps/server/test/ai-requests.test.ts`: uma requisição inserida `running` com `started_at` antigo some da lista de em andamento depois da manutenção.

## Limitações e suposições
Nada foi executado. O `stop_grace_period` do compose de produção não foi visto; com um prazo maior, o caso fica mais raro, mas a queda por OOM continua.

## Análise (triagem)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o dba).

Confirmado no `schema.sql`: a requisição nasce `running` e só o `UPDATE … WHERE status = 'running'` do fim da chamada a fecha. `ai_requests_purge` apaga pela idade, sem olhar o status, e `ai_provider_health` ignora as `running`. Nenhuma função passava uma `running` velha a final. O trigger `ai_requests_before_write` já permite `running` → final com `finished_at`, então a correção não mexe na imutabilidade.

## Resolução (executor)

### Banco (dba)

Migration `database/migrations/0067_ai_requests_close_stale.sql`; teste `database/tests/0067_ai_requests_close_stale.sql`.

- Função nova `ai_requests_close_stale(p_after interval DEFAULT '1 hour', p_limit integer DEFAULT 1000) RETURNS integer`, `SECURITY INVOKER` (a aplicação já tem UPDATE em `ai_requests`), com `EXECUTE` para `moneyflow_app`.
  - Passa a `error` até `p_limit` requisições `running` iniciadas há mais de `p_after`, as mais velhas primeiro, pulando as travadas (`FOR UPDATE SKIP LOCKED`). Grava `finished_at` = agora e `error_message` = `interrupted: the process stopped before the request finished`, e devolve quantas fechou.
  - Prazo mínimo de 10 minutos e limite de 1 a 100000. Fora disso, `22023`.
- Decisão: o prazo padrão é 1 hora, e não os 30 minutos sugeridos. Não há timeout de streaming na aplicação, e uma resposta longa com raciocínio pode passar de 30 minutos. Fechar uma chamada viva a gravaria como erro, e o UPDATE do fim dela não acharia mais a linha.
- Índice parcial novo `ai_requests_running_idx (started_at) WHERE status = 'running'`.
- As fechadas passam a contar como erro em `ai_provider_health`.

Testes:
- os parâmetros fora da faixa;
- em lotes, a mais velha primeiro, até zerar;
- motivo, `finished_at` e duração das fechadas;
- a recente fica `running`, e a terminada não muda;
- a saúde conta as interrompidas;
- a fechada não volta a `ok`;
- o prazo de 15 minutos alcança a de 20.

Verificação:
- `make test T=/tests/0067_ai_requests_close_stale.sql` passou, com o down da 0067.
- `0040` passou de novo.
- `docs/016` (Requisições ao provedor) atualizada. `make dump` rodado.

### Pendente na aplicação

1. `pnpm db:pull`. Não há coluna nova; só a função e o índice.
2. `apps/server/src/agents/worker.ts`, no laço de manutenção e junto da purga das requisições (`purgeAiRequests`): chamar `SELECT ai_requests_close_stale(interval '1 hour', 1000) AS n` em lotes, cada lote na sua transação, até devolver menos que 1000. Fica antes da purga, para a requisição fechada ainda aparecer na saúde.
   - O prazo pode ir para a configuração (por exemplo `AI_REQUEST_STALE_MINUTES`, mínimo 10), mas tem de ficar acima do maior tempo de uma chamada: o `AI_DOCUMENT_TIMEOUT_MS` e um streaming longo.
3. Na tela Requisições (`RequestsTable`/`RequestDrawer`), mostrar o `error_message` que começa por `interrupted:` como "Interrompida (o processo parou antes do fim)", em `t`.
4. Teste em `apps/server/test/ai-requests.test.ts`: uma requisição inserida `running` com `started_at` de 2 horas atrás vira `error` depois da manutenção. Uma de agora fica `running`.
5. `docs/023` (Ciclo): registrar o fechamento das interrompidas pela manutenção.

### Aplicação (app)

Sem triage (revisão de 2026-11-21 verificada; a sessão principal designou o app). Confirmado: nada chamava `ai_requests_close_stale`.

1. `pnpm db:pull`: nada a gerar (só função e índice).
2. `apps/server/src/agents/worker.ts`: `closeStaleAiRequests(db, after = '1 hour')` chama `ai_requests_close_stale(after, 1000)` em lotes, cada um na sua transação (autocommit), até um lote vir incompleto; no laço de manutenção, antes de `purgeAiRequests`, com o total no log como aviso.
   - Decisão: o prazo fica fixo em 1 hora no código (`STALE_REQUEST_AFTER`), sem variável nova: está acima do maior prazo de uma chamada (`AI_DOCUMENT_CONVERT_TIMEOUT_MS`, até 30 min), e o streaming não tem prazo.
3. Tela: `isInterruptedRequest` e `INTERRUPTED_REQUEST_PREFIX` em `packages/shared/src/agents/requests.ts`; a `RequestsTable` mostra "Interrompida" ao lado da situação Erro (com o texto completo no `title`) e a `RequestDrawer` troca a mensagem crua por "Interrompida (o processo parou antes do fim)" (`t.agentsUi.admin.requests.interrupted`/`interruptedShort`).
4. Spec 023 (O que é registrado): o fechamento das interrompidas pela manutenção, o prazo e a tela.

Testes:
- `test/ai-requests.test.ts`: a requisição `running` de 2 horas vira `error` com `finished_at` e o motivo reconhecido por `isInterruptedRequest`, aparece na lista filtrada por erro, e a de agora fica `running`;
- `test/maintenance.test.ts`: a primeira passada do laço de manutenção fecha uma requisição presa de 3 horas;
- `packages/shared/test/ai-requests.test.ts`: `isInterruptedRequest` só pelo começo da mensagem.

Verificação: rápida, `pnpm verify:quick --base HEAD`.
