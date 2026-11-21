---
status: aberta
tipo: bug
origem: agente
autor: principal
responsavel:
prioridade: alta
criada: 2026-11-21
commit:
---

# Erro temporário do provedor devolve a execução à fila para sempre

- **Severidade:** alta
- **Confiança:** confirmado
- **Categoria:** bug
- **Subcategoria:** laço de retentativa sem limite
- **Arquivos afetados:** `apps/server/src/agents/runner.ts:332-341`, `database/schema.sql:2809-2811`, `database/schema.sql:2453`, `apps/server/src/agents/worker.ts:70-77`, `apps/server/src/agents/llm/anthropic.ts:134-147`, `apps/server/src/agents/llm/openai.ts:97-108`, `docs/023-requisicoes-ao-provedor.md:34-35`, `docs/011-agentes-de-ia.md:87`, `apps/server/test/agents.test.ts:380-389`
- **Depende de / relacionado a:** tarefa 150
- **Executor sugerido:** app
- **Esforço estimado:** P
- **Revisão:** 2026-11-21, commit `7f0984f`

## Descrição

### Explicação para leigos
Quando o provedor de IA fica fora do ar, responde "limite atingido" (429) ou está com o endereço errado, o agente não desiste nunca. A conversa fica "pensando" sem fim, o sistema bate no provedor a cada poucos segundos e enche o registro de requisições, até alguém clicar em Parar. Nas tarefas agendadas, receitas, leitura de documento e Telegram, ninguém está olhando, então isso pode durar dias.

### Evidência e análise técnica
- `runner.ts:334`: depois de esgotar as tentativas do invólucro (`request-log.ts`, até `AI_REQUEST_MAX_ATTEMPTS`), um `LlmError` com `retryable` devolve a execução à fila se `claimed.attempts < claimed.max_attempts`:
  ```ts
  if (error instanceof LlmError && error.retryable && claimed.attempts < claimed.max_attempts) {
    await db.execute(sql`UPDATE ai_runs SET status = 'queued' WHERE id = ${runId} AND status = 'running' AND lock_token = ${token}::uuid`)
  ```
- O trigger `ai_runs_validate` (`schema.sql:2809-2811`) zera o contador nessa transição: `IF OLD.status = 'running' AND NEW.status IN ('queued', 'awaiting_confirmation') THEN NEW.attempts := 0`. O comentário da coluna (`schema.sql:2453`) confirma: `attempts` são as "reservas da vez atual" e servem para limitar a retomada após a queda do worker, não as retentativas do provedor.
- Resultado: cada reserva devolve `attempts = 1` (`ai_run_claim` soma 1 a 0), e `1 < 3` é sempre verdadeiro. A condição de parada nunca é atingida.
- `worker.ts:72-76`: o `.finally` do job chama `claim()` na hora, sem espera. O ciclo dura só o backoff interno (1 s + 2 s com jitter, ou o `retry-after` até 60 s).
- São `retryable`: 408, 409, 429, 5xx e 529, e também `status === null` (`anthropic.ts:141`, `openai.ts:103`), que inclui conexão recusada, DNS e `base_url` errada, além de qualquer queda no meio do stream (`anthropic.ts:146`, `openai.ts:107`). A descrição de imagem pelo provedor de visão (`run-attachments.ts:201-220`) passa pelo mesmo caminho.
- Nada mais limita o laço: a falha não grava `ai_usage`, então o orçamento (`exceededBudget`, `runner.ts:241`) não bloqueia; o limite por minuto conta execuções criadas, não reservas; o contador de voltas (`runner.ts:232`) conta mensagens do assistente, e nenhuma é gravada.

### Verificação (tentativa de refutação)
- O banco não tem outro limite: `ai_run_claim` (`schema.sql:2481-2512`) só olha `attempts` na reserva velha (`running` → `running`), que não passa pelo zeramento. A expiração automática (`ai_runs_expire_awaiting`) só vale para `awaiting_confirmation`.
- Testes: `ai-requests.test.ts:156-182` cobre só uma volta (três 5xx e depois sucesso). O teste `agents.test.ts:380` se chama "erro 500 repetido termina como failed", mas a fila dele usa `status: 400`, que não é repetível. Com 500, o teste não chegaria a `failed`. Nenhum teste cobre a falha persistente.
- Spec: `docs/023:34` diz "a execução volta à fila até `max_attempts`". O código promete esse limite, mas o contrato do banco o anula.

### Impacto
- Provedor fora, chave sem crédito (a OpenAI responde 429 `insufficient_quota`) ou um Ollama desligado: cada execução afetada faz cerca de mil requisições por hora, grava as tentativas em `ai_requests`/`ai_request_attempts` e solta um evento `error` por ciclo.
- Com 429, o laço mantém a conta no limite e atrasa as outras execuções.
- Tarefa agendada: os disparos seguintes saem `previous_run_active`. Receita: a fila do lote para, porque `closeFinishedRecipeRuns` espera o fim. Telegram: o "digitando…" fica para sempre. Fluxo síncrono que estourou a espera: segue rodando sem ninguém ver.
- Ocupa uma vaga de `AGENT_CONCURRENCY` (4) por execução presa.

## Como reproduzir
1. Com o provedor falso, configure `llm.queue` com 30 respostas `{ status: 503 }`.
2. `POST /api/conversations/:id/messages` e rode `processOnce()` (de `ai-requests.test.ts`) dez vezes.
3. Depois de cada volta, a execução está `queued` com `attempts = 0`. Ela nunca vira `failed`, e há 3 requisições `error` por volta em `ai_requests`.

## Solução proposta
1. Contar as devoluções à fila por um contador que o trigger não zere. Sem mudar o banco: gravar o evento `error` com `code: 'provider_retry'` e contar esses eventos da execução (a purga só apaga eventos de execuções terminadas). Com o dba: uma coluna `provider_requeues`.
2. Passado o limite (por exemplo 2 devoluções, que dão 3 chamadas lógicas, como diz a spec), encerrar `failed` com a mensagem do provedor.
3. Esperar antes de devolver à fila: um backoff curto no próprio worker, ou um `not_before` na reserva (com o dba). Assim o ciclo não recomeça na hora pelo `.finally` do `claim()`.
4. Opcional: tratar `status === null` vindo de `ECONNREFUSED`/`ENOTFOUND` como não repetível na execução (já foi repetido dentro da chamada).

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/agents/runner.ts
+++ b/apps/server/src/agents/runner.ts
@@
-    if (error instanceof LlmError && error.retryable && claimed.attempts < claimed.max_attempts) {
+    const requeues = error instanceof LlmError && error.retryable
+      ? Number((await db.execute<{ n: number }>(sql`
+          SELECT count(*)::int AS n FROM ai_run_events
+           WHERE run_id = ${runId} AND event_type = 'error' AND payload ->> 'code' = 'provider_retry'`)).rows[0]?.n ?? 0)
+      : Number.POSITIVE_INFINITY;
+    if (requeues < PROVIDER_REQUEUES) {
       // Volta à fila para nova tentativa (a reserva conta as tentativas).
       await db
         .execute(sql`UPDATE ai_runs SET status = 'queued' WHERE id = ${runId} AND status = 'running' AND lock_token = ${token}::uuid`)
         .catch(() => {});
-      await appendEvent(db, runId, { type: 'error', message }).catch(() => {});
+      await appendEvent(db, runId, { type: 'error', message, code: 'provider_retry' }).catch(() => {});
       return;
     }
```

## Critérios de aceite
- [ ] Com o provedor sempre em 503, a execução termina `failed` depois de no máximo `PROVIDER_REQUEUES + 1` chamadas lógicas, com a mensagem do provedor.
- [ ] O caso atual de `ai-requests.test.ts` (três 5xx e depois 200) continua concluindo.
- [ ] Entre duas devoluções à fila há uma espera mínima.
- [ ] `docs/011` e `docs/023` dizem quantas devoluções à fila acontecem.

## Testes recomendados
- `apps/server/test/ai-requests.test.ts`: "5xx persistente: a execução falha depois de N devoluções à fila", com `llm.queue` de 5xx repetidos e `drain()`, conferindo o status `failed` e o número de requisições `error`.
- `apps/server/test/agents.test.ts:380`: trocar a fila para `{ status: 500 }`, como o nome do teste promete.
- Um caso com `base_url` para uma porta fechada (`status === null`).

## Limitações e suposições
Nada foi executado; o comportamento vem da leitura do runner e do trigger. A quantidade "mil por hora" é uma estimativa com o backoff padrão (`AI_REQUEST_BACKOFF_MS = 1000`).

## Análise (triagem)

## Resolução (executor)
