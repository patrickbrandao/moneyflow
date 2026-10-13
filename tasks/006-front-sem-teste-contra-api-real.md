---
status: em-andamento
tipo: debito-tecnico
origem: agente
autor: app
responsavel: app
prioridade: media
criada: 2026-10-11
commit:
---

# Cobrir no e2e os fluxos do agente ainda sem teste contra a API real

## Descrição
Fluxos do frontend dos agentes que não foram exercitados contra a API real: reconexão do SSE após queda (Last-Event-ID), Recusar com motivo, modo somente leitura do admin ao abrir conversa de outro usuário e a tela de sugestões da conciliação (aprovar/descartar em lote). Também não há teste com provedor de embeddings (o fake responde `/v1/embeddings`, mas nada o usa). Pedido: testes e2e/integração para esses casos e corrigir o que falhar.

## Como reproduzir
Ver `e2e/tests/agentes.spec.ts` e `apps/server/test/agents.test.ts`.

## Análise (triagem)
**Procede** (conferido em 2026-10-13). A API já tem integração para quase tudo. O que falta é o **frontend contra a API real** e os **embeddings**:

| Caso | API (`apps/server/test/agents.test.ts`) | Front (`e2e/tests/agentes.spec.ts`) |
|---|---|---|
| SSE com `Last-Event-ID` | coberto ("tool de leitura … SSE com Last-Event-ID") | não coberto; a reconexão fica em `apps/web/src/agents/stream.ts` |
| Recusar com motivo | coberto ("escrita rejeitada … com o motivo") | não coberto (`ConversationPane.tsx`, `useConversation.ts`) |
| Admin abre conversa de outro usuário (somente leitura) | coberto (`readOnly: true`) | não coberto (`AgentsMenu.tsx`, `AgentWindows.tsx`, `ConversationPane.tsx`) |
| Sugestões da conciliação: aprovar/descartar em lote | só aprovar, 1 linha | não coberto (`components/reconciliation/ImportDetail.tsx`) |
| Embeddings (`agents/embeddings.ts`, `search.ts`, `embedTexts`) | **nenhum teste** | — |

O e2e de agentes tem um único cenário (conversar, aprovar, ancorar, minimizar). O provedor falso (`e2e/fakes/fake-llm.ts`) já responde `/v1/embeddings` com vetores determinísticos e lista `fake-embedding`.

Executor: app. Escopo:
1. e2e (Playwright, provedor falso): (a) recusar com motivo e ver a resposta do agente; (b) admin abre pela lista "todos" a conversa de outro usuário e vê o compositor desabilitado, sem aprovar/recusar; (c) importar um OFX com o agente ativo, esperar as sugestões, aprovar uma e descartar outra em lote na tela; (d) reconexão do SSE: derrubar o stream no meio (`page.route` abortando `/api/runs/*/events` uma vez, ou `context.setOffline`) e conferir que a conversa termina sem mensagem duplicada nem perdida.
2. Integração: provedor de embeddings ativo apontando para o falso (OpenAI-compatível). Indexar, conferir as linhas em `ai_embeddings` e o `ai_usage` com `purpose = 'embedding'`, e a busca semântica devolvendo o registro esperado.
3. Herdado da 005: no teste "conciliação recebe sugestões", afirmar que o `audit_log` da linha sugerida tem `actor_kind = 'agent'` e `agent_run_id` da execução.
4. O que falhar vira correção nesta tarefa. Se a falha for do banco, abrir tarefa para o dba.

Desde as tarefas 008–010, o agente também concilia e estorna pelas tools. Isso já tem integração (`agents.test.ts`, "lote na conta…", "casamento errado…") e não entra aqui.

Risco: médio (pode revelar bugs no front, especialmente na reconexão do SSE). Verificação: `pnpm e2e` com a pilha da raiz e o provedor falso (`E2E_LLM_PORT`), e `pnpm test:integration`.

Ordem: independente. Pode rodar depois de 013/011, para o teste de embeddings já ver a finalidade nova no `ai_usage`, mas não depende delas. Prioridade média. Esforço: grande (~1 dia).

## Resolução (executor)
