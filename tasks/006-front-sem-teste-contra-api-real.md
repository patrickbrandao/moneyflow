---
status: concluida
tipo: debito-tecnico
origem: agente
autor: app
responsavel: app
prioridade: media
criada: 2026-10-11
commit: 9b29f08
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
Feito em 2026-10-13 (app).

**Testes novos**
- e2e (`e2e/tests/agentes.spec.ts`, provedor falso na 18082), além do cenário que já havia:
  - recusar uma escrita com motivo: o cartão some, nada é gravado, a tool fica "recusada", o agente responde com o motivo e o provedor recebe o `tool_result` com erro e o motivo;
  - reconexão do SSE: a 1ª conexão de `/api/runs/*/events` é cortada na metade dos `text_delta` (`page.route` + `route.fetch`, sem o `done`); o console reconecta com `Last-Event-ID` = último id entregue, a resposta final aparece inteira uma vez só e bate com o histórico da API;
  - admin lê a conversa de outro usuário (editor de uma caixa, com escrita esperando confirmação) pela lista "Todos os usuários": aviso de somente leitura, sem compositor, sem aprovar/recusar, sem ações de dono; a API recusa a decisão do admin;
  - "Usar nos fluxos automáticos" em /admin/ai (tarefa 012) marcado pela tela (badge "Fluxos", `useForFlows` só nele) e, com ele, importar um OFX: as sugestões do agente aparecem sozinhas na tela do lote; duas aprovadas em lote pela seleção, uma descartada; as demais seguem do agente.
- Integração (`apps/server/test/agents.test.ts`):
  - embeddings: provedor OpenAI-compatível com `embeddingModel` apontando para o falso; indexação (`syncEmbeddingSources` + `embedPending`) grava a linha em `ai_embeddings` com vetor, a chamada a `/v1/embeddings` leva a chave e o modelo, `ai_usage` com `purpose = 'embedding'` (indexação sem usuário; consulta com o usuário) e a tool `semantic_search` devolve a entidade em modo `embeddings` com score 1;
  - herdado da 005: a sugestão em `statement_lines` sai no `audit_log` com `actor_kind = 'agent'`, o `agent_run_id` da execução `classify_lines` e o usuário que importou;
  - escrita rejeitada: com a execução encerrada, o detalhe da conversa ainda traz a confirmação `rejected` com o motivo.

**Bugs achados e corrigidos**
1. Sugestões da conciliação não apareciam depois do import: a sugestão automática é enfileirada no worker, mas a tela do lote não recarregava (só o botão "Sugerir com IA" tinha recargas em 5/12/25 s, que podiam chegar antes da execução terminar). Agora a resposta do `POST /api/statement-imports` traz `aiSuggestion` (`queued`, `runId`, `lines`), e a tela do lote segue o SSE da execução (`followRun`), com o aviso "O agente está sugerindo…", e recarrega as linhas quando ela termina; o "Sugerir com IA" usa o mesmo caminho (`ImportDetail.tsx`, `StatementImportPanel.tsx`, `routes/statements.ts`).
2. Tool recusada aparecia como "Erro" no histórico: o detalhe da conversa só trazia as confirmações pendentes da execução ativa, então, terminada a execução, a recusa sumia e a tela marcava a tool como erro. Agora `getConversation` devolve as pendentes da execução ativa e as já decididas de todas as execuções da conversa (`loadConversationConfirmations` em `agents/store.ts`).
3. A suíte e2e passava do limite de login (`LOGIN_RATE_LIMIT`, 10 por minuto): com os cenários novos, os testes do fim falhavam com `rate_limited`. O `e2e/global-setup.ts` abre a sessão do admin uma vez (`e2e/.auth/`, no `.gitignore`) e backup, visão, operação e agentes a reaproveitam (`loginAsAdmin` em `e2e/support/session.ts`); o login pela tela continua em fluxo-principal e contratos. A suíte agora roda duas vezes seguidas sem bater no limite.

Nada no banco. Specs: 011 (reconexão do SSE, confirmações decididas no detalhe, `aiSuggestion` e a tela seguindo a execução). AGENTS.md: lista de e2e e a sessão compartilhada.

Verificação: `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 111, server 94) e `pnpm build` passam; `pnpm e2e` completo (16 testes) passa contra a pilha deste worktree (`TELEGRAM_API_BASE=http://host.docker.internal:18081 docker compose up --build -d`), duas vezes seguidas.
