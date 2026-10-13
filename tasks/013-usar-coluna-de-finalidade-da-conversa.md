---
status: concluida
tipo: debito-tecnico
origem: agente
autor: triage
responsavel: app
prioridade: baixa
criada: 2026-10-13
commit: 1ee173c
---

# Usar `ai_conversations.purpose` em vez de `screen_context.purpose` (depois da 003)

## Descrição
Parte da aplicação da tarefa 003. Com a coluna `ai_conversations.purpose` no banco, a aplicação grava e lê a finalidade das conversas dos fluxos pela coluna e deixa de usar a chave `purpose` do `screen_context`.

**Começa só depois da 003 concluída pelo dba.**

## Como reproduzir
`grep -rn "purpose" apps/server/src` (lê `screen_context->>'purpose'`).

## Análise (triagem)
- Gravação: `services/conversations.ts` → `createConversation` recebe `purpose` no `extra` (em vez de enfiar no `screenContext`). Os chamadores são `services/ai-flows.ts` (`document_reading`, `classify_lines`) e `services/contract-documents.ts` (`contract_reading`, `contract_markdown`). Os dados de que o fluxo precisa (`fileName`, `importId`, `lineIds`) podem continuar no `screen_context`.
- Leitura: `NOT_FLOW` em `conversations.ts` (`c.purpose = 'chat'`), `agents/runner.ts` (finalidade da execução; `buildSystemPrompt` deixa de filtrar a chave `purpose`) e `agents/events-hub.ts` (`SYNC_FLOW_PURPOSES`).
- Com isso, `sendMessage` substituir o `screen_context` deixa de apagar a finalidade (ver a análise da 003).
- `pnpm db:pull`. Spec 011 (frase "`screen_context.purpose`").
- Testes: os de fluxo em `agents.test.ts` continuam passando. Acrescentar: mandar mensagem com `screenContext` numa conversa de fluxo não a faz aparecer na lista.

Ordem: 001 + 003 (dba) → 013 → 011. Esforço: pequeno (~1 h).

## Resolução (executor)
Feito em 2026-10-13. A finalidade das conversas dos fluxos sai do `screen_context` e vai para a coluna `ai_conversations.purpose` (migration 0033/0034 do dba).

- Gravação: `createConversation` (`apps/server/src/services/conversations.ts`) recebe `purpose` no `extra` e o grava no INSERT (a coluna é imutável depois). Os chamadores passam a finalidade fora do `screen_context`: `services/ai-flows.ts` (`document_reading`, `classify_lines`) e `services/contract-documents.ts` (`contract_reading`, `contract_markdown`); o `screen_context` guarda só `fileName`, `importId` e `lineIds`.
- Leitura: `NOT_FLOW` virou `c.purpose = 'chat'` (usa o índice parcial do dba na lista e na busca); `agents/runner.ts` lê a finalidade da coluna e `buildSystemPrompt` não filtra mais a chave `purpose`; `agents/events-hub.ts` lê `c.purpose` para não avisar no sino os fluxos síncronos.
- Efeito: mandar mensagem com `screenContext` numa conversa de fluxo substitui o contexto sem tirá-la do fluxo.

Teste: `apps/server/test/agents.test.ts` → "a finalidade da conversa do fluxo fica na coluna: mandar mensagem com screenContext não a põe na lista (tarefa 013)" (coluna `document_reading`, `screen_context` sem `purpose`, mensagem com `screenContext` não muda a finalidade nem põe a conversa na lista, arquivadas ou não, e o UPDATE da finalidade é recusado pelo banco). Spec 011 atualizada.
