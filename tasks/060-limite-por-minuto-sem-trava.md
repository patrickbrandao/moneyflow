---
status: concluida
tipo: debito-tecnico
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit:
---

# O limite de execuções por minuto conta e depois insere, sem trava (TOCTOU)

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** ponto fraco
- **Subcategoria:** condição de corrida no rate limit
- **Arquivos afetados:** `apps/server/src/services/ai-budgets.ts:205-221`, `apps/server/src/services/conversations.ts:560,572-584`, `docs/028-limites-e-uso.md:16-19`
- **Depende de / relacionado a:** 059
- **Esforço estimado:** M
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
Se o usuário disparar várias conversas exatamente ao mesmo tempo, algumas passam do limite por minuto, porque a contagem e o registro da execução não acontecem juntos e trancados.

### Evidência e análise técnica
`assertRunRate` (`ai-budgets.ts:205-215`) faz `SELECT count(*) FROM ai_runs WHERE ... created_at > now() - interval '1 minute'` em `ctx.db`, fora da transação. O `INSERT INTO ai_runs` vem depois, em `withTx` (`conversations.ts:572-580`), sem advisory lock.

### Verificação (tentativa de refutação)
- Não há trava nem trigger de taxa no banco.
- O índice único `ai_runs_conversation_active_key` permite só uma execução ativa por conversa, e há no máximo uma sessão de chat ativa por (usuário, agente). Por isso o excesso fica limitado ao número de conversas distintas que o usuário consegue mirar ao mesmo tempo. Os fluxos, como a leitura de documento, criam conversa nova a cada vez.
- O orçamento mensal continua valendo. `docs/028:16-19` define o limite "para conter abuso e loops", sem prometer exatidão.

### Impacto
Algumas execuções a mais por minuto, limitadas pelo número de agentes e de fluxos.

## Como reproduzir
`ai.runs_per_minute = 2`, três agentes e três `POST /api/agents/:id/messages` simultâneos (`Promise.all`): os três passam.

## Solução proposta
- Fazer a contagem dentro da transação do INSERT, depois de um `pg_advisory_xact_lock` por usuário e tipo, ou numa função do banco (nesse caso com o dba).
- Centralizar nos pontos que criam execução: `sendMessage`, `insertReconcileSession`, tarefas e fluxos.
- Opcional: uma frase na `docs/028` sobre a exatidão.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/conversations.ts
+++ b/apps/server/src/services/conversations.ts
@@
     return await withTx(ctx, async (tx) => {
+      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_run_rate:' || ${ctx.access.actor.id}))`);
+      await assertRunRate(tx, ctx.config, ctx.access.actor.id, conversation.purpose !== 'chat');
       if (input.screenContext) {
```

## Critérios de aceite
- [ ] N requisições concorrentes para agentes diferentes, com limite 2, criam exatamente 2 execuções.

## Testes recomendados
`test/budgets.test.ts`: o cenário de "Como reproduzir", esperando dois 200 e um 429. Nada disso foi executado nesta auditoria.

## Limitações e suposições
O lock serializa a criação de execuções do mesmo usuário, a um custo desprezível.

## Análise (triagem)

Sem triage (auditoria verificada; a sessão principal designou o app). Confirmado: `assertRunRate` contava em `ctx.db`, fora da transação do INSERT, em `sendMessage` e nos fluxos (o play e a conciliação genérica, via `assertCanStartRun`); os disparos das tarefas e da fila das receitas já contavam dentro da transação, mas sem trava. Pontos que inserem em `ai_runs`: `sendMessage`, `insertReconcileSession` e `agent-tasks.startClaimed`. Executor: app (sem mudança no banco: `pg_advisory_xact_lock` é público).

## Resolução (executor)

Decisão da sessão principal (2026-11-07): advisory lock por usuário + contagem dentro da transação do INSERT, num helper usado por todos os pontos que criam execução.

- `lockRunRate(tx, config, userId, isFlow)` em `apps/server/src/services/ai-budgets.ts`: `pg_advisory_xact_lock(hashtextextended('ai_run_rate:<usuário>:<chat|flow>', 0))` e o `assertRunRate` na mesma transação. Usado em `sendMessage` (início da transação), em `insertReconcileSession` (que agora recebe o `config`; cobre o play, a fila do import e a conciliação genérica) e nos `startClaimed` das tarefas e das receitas (no lugar do `assertRunRate`, mantendo o "pulado por limite"). Os fluxos JSON (leitura de documento, sugestões, contratos, troca do provisório) criam a execução por `sendMessage`. O `assertCanStartRun` antes continua como checagem rápida.
- Teste: `test/budgets.test.ts` ("limite por minuto com trava (tarefa 060)") — limite 2, três agentes e três POST simultâneos: dois 200, um 429 e duas execuções. Conferido que o teste falha sem o lock (`[200, 200, 200]`).
- Spec: `docs/028-limites-e-uso.md` (exatidão com pedidos simultâneos).
