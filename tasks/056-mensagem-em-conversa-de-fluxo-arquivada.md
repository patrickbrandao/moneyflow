---
status: concluida
tipo: bug
origem: agente
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-11-07
commit: 9991a6b
---

# Conversa de fluxo arquivada aceita mensagem pela API, e o `screenContext` apaga o escopo da receita

- **Severidade:** baixa
- **Confiança:** confirmado
- **Categoria:** incoerência
- **Subcategoria:** contorno do escopo da receita e da trava do lote
- **Arquivos afetados:** `apps/server/src/services/conversations.ts:553-560,572-584`, `apps/server/src/routes/agents.ts:105`, `apps/server/src/agents/runner.ts:140,352-357`, `apps/server/src/services/reconcile-recipes.ts:453-459`, `packages/shared/src/agents/schemas.ts:409-418`, `docs/030-receitas-de-conciliacao.md:32-35,100`
- **Depende de / relacionado a:** 057
- **Esforço estimado:** P
- **Auditoria:** 2026-11-07, commit `1ebb073` (problem-finder)

## Descrição

### Explicação para leigos
A "sessão da receita" deveria mexer só nas linhas escolhidas do extrato, e só uma conciliação por vez no lote. Mandando uma mensagem pela API para essa sessão já encerrada, o usuário faz o agente rodar de novo sem esse limite e sem a trava.

### Evidência e análise técnica
- `conversations.ts:554-556` só barra `purpose === 'chat' && archived_at`. Conversas `reconcile_statement`, `scheduled_task` e de fluxo JSON arquivadas aceitam mensagem nova e criam execução.
- `conversations.ts:573-575`: `UPDATE ai_conversations SET screen_context = ${JSON.stringify(input.screenContext)}::jsonb` substitui o objeto inteiro.
- A sessão de receita nasce arquivada com `screen_context = { importId, recipeId, lineIds }` (`reconcile-recipes.ts:453-459`). O runner tira o escopo só daí (`runner.ts:140,352-357`).
- O `screenContextInput` é `.strict()` e não tem `recipeId`/`lineIds` (`schemas.ts:409-418`). Por isso o input só consegue **apagar** o escopo, transformando a execução numa conciliação genérica.
- A execução nova não passa por `ai_reconcile_import_lock`/`busy`.

### Verificação (tentativa de refutação)
- A rota repassa direto (`routes/agents.ts:105`), e não há trigger no banco que barre mensagem em conversa não-chat arquivada. O índice `ai_runs_conversation_active_key` impede só duas execuções ativas na mesma conversa.
- A interface trata a conversa de fluxo como somente leitura (`apps/web/src/agents/ConversationPane.tsx:74-76`), então o caminho é só por chamada direta.
- Não há escalada de privilégio: o `Access` do usuário e o kit continuam valendo. Mas a spec diz que o escopo é garantido no servidor (`docs/030:32-34`) e que há uma execução por lote (`:35,100`).

### Impacto
As garantias de escopo e de exclusividade da spec 030 são contornáveis pelo próprio usuário, com possibilidade de duas execuções concorrentes no mesmo lote.

## Como reproduzir
Dar o play numa receita, esperar o fim e fazer `POST /api/conversations/<id da sessão da receita>/messages` com qualquer `screenContext`. Uma execução nova nasce sem `recipeId`/`lineIds`.

## Solução proposta
- Recusar, na rota, a mensagem do usuário para conversa com `purpose ≠ 'chat'`.
- Os chamadores internos que usam `sendMessage` em conversas de fluxo precisam continuar funcionando: `contract-documents.ts:357`, `ai-flows.ts:81,187`, `statement-supersede.ts:475`. Por isso a recusa vai atrás de uma opção `fromUser`.
- Registrar em `docs/026` ou `docs/030` que conversa de fluxo não recebe mensagem pela API.

### Diff/patch proposto — NÃO APLICADO
```diff
--- a/apps/server/src/services/conversations.ts
+++ b/apps/server/src/services/conversations.ts
@@
-export type SendOptions = { origin?: AiRunEvent };
+export type SendOptions = { origin?: AiRunEvent; fromUser?: boolean };
@@
   if (conversation.purpose === 'chat' && conversation.archived_at) {
     throw new AppError(409, 'session_finished', t.agents.errors.sessionFinished);
   }
+  if (opts.fromUser && conversation.purpose !== 'chat') {
+    throw new AppError(409, 'session_finished', t.agents.errors.sessionFinished);
+  }
--- a/apps/server/src/routes/agents.ts
+++ b/apps/server/src/routes/agents.ts
@@
-  app.post('/api/conversations/:id/messages', (r: Req) => conversations.sendMessage(r.ctx, id(r), parse(messageSendInput, r.body)));
+  app.post('/api/conversations/:id/messages', (r: Req) =>
+    conversations.sendMessage(r.ctx, id(r), parse(messageSendInput, r.body), { fromUser: true }),
+  );
```

## Critérios de aceite
- [ ] O POST para uma conversa `reconcile_statement`, `scheduled_task` ou de fluxo JSON responde 409 sem criar execução, e o `screen_context` fica intacto.
- [ ] Os fluxos internos, o Telegram e as tarefas continuam funcionando.
- [ ] Spec atualizada.

## Testes recomendados
`test/reconcile-recipes.test.ts`: play, fim, POST com `screenContext`, esperando 409 e o `screen_context` igual. O mesmo para `scheduled_task` em `test/autonomous.test.ts`. Nada disso foi executado nesta auditoria.

## Limitações e suposições
É preciso confirmar que o Telegram e as tarefas usam `sendToAgent`/serviço, e não essa rota.

## Análise (triagem)

Sem triage (auditoria verificada; a sessão principal designou o app). Causa confirmada no código atual: `sendMessage` (`services/conversations.ts`) só barrava `purpose = 'chat'` arquivada, e a rota `POST /api/conversations/:id/messages` repassava direto; o `UPDATE … screen_context` trocava o objeto inteiro, apagando `recipeId`/`lineIds`. O Telegram usa `sendToAgent` e as tarefas inserem a execução no próprio serviço: nenhum dos dois passa pela rota. Executor: app.

## Resolução (executor)

Decisão da sessão principal (2026-11-07): recusar com 409 a mensagem do usuário pela rota para conversa `purpose ≠ 'chat'`, pela opção `fromUser`, mantendo os chamadores internos.

- `SendOptions.fromUser` em `apps/server/src/services/conversations.ts`: com ela, conversa de fluxo responde 409 `flow_conversation` (`t.agents.errors.flowConversation`) antes de qualquer gravação; a rota `POST /api/conversations/:id/messages` (`routes/agents.ts`) passa `{ fromUser: true }`. Os fluxos internos (`ai-flows.ts`, `contract-documents.ts`, `statement-supersede.ts`) e o `sendToAgent` não mudam.
- Testes: `test/agents.test.ts` (o caso da tarefa 013, que mandava mensagem pela rota numa conversa de leitura de documento, agora espera o 409 com a finalidade e o `screen_context` intactos); `test/reconcile-recipes.test.ts` ("na execução da receita as tools de lote e de receita são recusadas; a sessão dela não recebe mensagem pela API") — POST com `screenContext` na sessão da receita: 409, nenhuma execução nova e o `screen_context` igual; `test/autonomous.test.ts` ("a sessão da tarefa não recebe mensagem pela API") para `scheduled_task`.
- Specs: `docs/030-receitas-de-conciliacao.md` (a sessão não recebe mensagem pela API) e `docs/026-sessoes-dos-agentes.md` (conversas de fluxo).
