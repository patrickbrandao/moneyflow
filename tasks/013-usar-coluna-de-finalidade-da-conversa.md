---
status: em-andamento
tipo: debito-tecnico
origem: agente
autor: triage
responsavel: app
prioridade: baixa
criada: 2026-10-13
commit:
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
