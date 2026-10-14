---
status: concluida
tipo: melhoria
origem: usuario
autor: principal
responsavel: app
prioridade: baixa
criada: 2026-10-14
commit: (sem commit; a sessão principal commita)
---

# Fio por agente, finalizar sessão e sessões anteriores (F12)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [026](../docs/026-sessoes-dos-agentes.md), seção "Aplicação (app)". O que fazer: Rotas por agente (`threads`, `sessions`, `finish`), menu Agentes por agente, uma janela por agente, "Finalizar sessão", sessões anteriores em leitura com "Bifurcar daqui", conversão do `localStorage`, textos "sessão"; testes e e2e.

Ordem: Depois da 026. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [026](../docs/026-sessoes-dos-agentes.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: app.** Tipo confirmado: melhoria.

**Arquivos afetados**
- **`services/conversations.ts`**:
  - listar e criar;
  - `sendMessage` (l. ~295);
  - `updateConversation` (fixar e arquivar);
  - `forkConversation` e `deleteConversation`.
- **`routes/agents.ts`**: as rotas novas por agente. As rotas por conversa continuam.
- **Shared**: `agents/schemas.ts` e `agents/types.ts`.
- **Web**:
  - `AgentsMenu.tsx`, `AgentWindows.tsx`, `AgentSidePanel.tsx`, `useConversation.ts` e `useConversationActions.tsx`;
  - `AgentsProvider.tsx`: a conversão do `localStorage` `moneyflow:agents-ui`;
  - textos em `agents-ui.ts`.
- **Backup**: `backup/import.ts` (veja a 026, ponto 2).
- **e2e existentes que mudam**: conversa, ancorar, minimizar, reconexão do SSE e o admin lendo outra conversa.
- **Banco**: `pnpm db:pull` depois da 026.

**Riscos e observações**
- É a maior reorganização do front dos agentes, e vários e2e dependem de "uma janela por conversa".
- **"Finalizar" com execução `running`**:
  - o `cancelRun` só cancela na hora quando a execução está na fila ou esperando confirmação;
  - rodando, o worker encerra na próxima batida (até 3 s);
  - até lá, arquivar é recusado (23514).

**Dependências**
- Depende da 026.
- A 033 (Telegram na sessão ativa e `/nova`) depende desta.

**Como verificar**
- Os testes da 026: segunda ativa, mensagem sem ativa, finalizar com execução, fork e só a sessão ativa indo ao modelo.
- O e2e de finalizar e bifurcar.

**Pontos para a revisão da spec**
1. (026, Finalizar sessão) "Se houver execução em andamento, ela é parada antes" não é imediato quando a execução está rodando. Recomendação: o banco aceita arquivar quando a execução já tem o cancelamento pedido (`ai_runs.cancel_requested_at`), ou a rota espera o cancelamento com um timeout curto e devolve 409 se ele não vier.

## Resolução (executor)
Feito pelo app em 2026-10-14, na branch `spec/f7-agentes-ia`, sem commit (a sessão principal commita). O ponto da revisão ("finalizar" com execução rodando) ficou como o banco já aceita: o parar é pedido na mesma transação e a sessão é arquivada na hora.

**Banco e schema**
- `pnpm db:pull` (sai `pinned_at`, entra `archived_reason`). A nova ordem das tabelas no schema gerado criou um ciclo de três FKs (`ai_runs → ai_conversations → ai_messages → ai_runs`) que o `postpull.mjs` não cortava (só ciclos de duas): agora ele remove a referência adiante que fecha um ciclo de qualquer tamanho (alcançabilidade pelo grafo de FKs).

**API** (`services/conversations.ts`, `routes/agents.ts`, shared `agents/{schemas,types}.ts`)
- "Fixar" removido (DTO sem `pinnedAt`, com `archivedReason`); o PATCH só aceita o título (sem arquivar/desarquivar).
- Rotas novas: `GET /api/agents/threads` (com `userId`/`all` para o admin), `GET /api/agents/:agentId/thread`, `GET /api/agents/:agentId/sessions` (finalizadas, `limit`/`offset`/`hasMore`, `q`, `userId`), `POST /api/agents/:agentId/sessions` (ativa ou nova, para anexar antes da 1ª mensagem), `POST /api/agents/:agentId/messages` e `POST /api/conversations/:id/finish`.
- Serviço reutilizável da sessão ativa do par: `activeSessionId`, `ensureActiveSession` (com `23505 ai_conversations_active_chat_key` relê a ativa) e `sendToAgent`, para o Telegram e as tarefas agendadas (F15).
- Finalizar: numa transação, `stopConversationRuns` (na fila/esperando confirmação → `canceled` com `cancel_requested_at`, fechando os tool_use pendentes; rodando → só `cancel_requested_at`) e `archived_at = now(), archived_reason = 'finished'`; idempotente. O "parar" virou `stopRun(tx, …)`, usado também pelo `cancelRun`.
- Bifurcar: pede o parar da execução da ativa do par na mesma transação, antes de `ai_conversation_fork` (que a finaliza com `forked`).
- Regras só da aplicação: a ativa não se exclui (422 `session_active`); a finalizada não recebe mensagem nem execução (409 `session_finished`). A busca cobre todas as sessões (ativas e finalizadas).
- Erros traduzidos em `DB_CONSTRAINT_MESSAGES`: `ai_conversations_active_chat_key` (409), `ai_conversations_unarchive_check`, `ai_conversations_archive_active_run_check`, `ai_conversations_archived_reason_check` e `ai_conversations_archived_reason_archived_check`; textos de erro com "sessão".
- Backup (`backup/import.ts`): `oneActiveSessionPerPair` (arquivo antigo com várias ativas do par: fica a de `last_message_at` mais recente, nulos por último, empate por `created_at` e id; as outras `import_conflict`) e `sessionConflict` na gravação (já há outra ativa do par no banco, inclusive gravada antes na mesma importação → `import_conflict`). `pinned_at` de arquivos antigos é ignorado pelo filtro do catálogo.

**Web** (`apps/web/src/agents/`)
- `AgentsProvider`: janelas por agente (`kind: 'agent'`, chave = agente, `conversationId` = a ativa) e de leitura (`kind: 'session'`); `openAgent`, `openConversation` (a ativa do próprio usuário vai para a janela do agente), `openById` (sino e requisições do admin); `localStorage` versão 2 com `normalizeUiState` e a conversão das janelas antigas por conversa (inclusive a ancorada) quando a API responde; `sessionsVersion` para a janela do agente reler depois de bifurcar.
- `useConversation` com alvo (fio do agente ou sessão fixa): fio vazio ("Nova sessão"), envio pelo agente, anexo que abre a sessão, `finish`.
- `AgentsMenu`: lista de agentes com última atividade, título da sessão ativa, indicador de execução e "Sessões anteriores"; busca em todas as sessões; admin com "Todos os usuários" (abre em leitura). `PreviousSessions.tsx`: finalizadas com busca e "Carregar mais", abrir, bifurcar e excluir (no menu e num modal da janela).
- Cabeçalho (`AgentWindows`/`AgentSidePanel`): "Finalizar sessão" (confirmação), "Sessões anteriores", modo áudio (F11); a de leitura tem "Bifurcar daqui"; o menu "…" mostra o id da sessão com copiar, renomear e excluir (finalizada). Aviso de sessão finalizada e de agente desativado; textos "conversa" → "sessão" (também no uso, nas requisições e no backup).

**Testes**
- `test/agents.test.ts`, `describe('sessões (spec 026)')`: corrida de duas abas na mesma ativa, segunda ativa recusada (409), mensagem pelo agente na ativa, finalizar com execução rodando (parar pedido, arquivada na hora, termina `canceled`), finalizar de novo, finalizada sem mensagem (409) e sem voltar (23514 traduzido), mensagem sem ativa criando a sessão nova, o modelo sem o histórico da finalizada, fios/sessões/busca/paginação/thread, fork da finalizada com a ativa na fila (cancelada, `forked`), admin lendo os fios e sessões de outro e o usuário comum recusado; o teste antigo das conversas virou renomear/buscar/bifurcar/excluir só a finalizada.
- `test/backup.test.ts`: importar ativas num banco que já tem a ativa do par e um arquivo antigo com várias ativas do mesmo par.
- A migração (uma ativa por par) é coberta pelo pgTAP da 026 (`database/tests/0043_ai_agent_sessions.sql`).
- `newSession()` em `test/helpers.ts` (finaliza a ativa do par) nos testes que começam do zero (agents, agent-prompts, ai-requests, capabilities, chat-media).
- Pendência da F11: `freshDatabase()` registra os bancos `moneyflow_bk_*` e `dropFreshDatabases()` (no `afterAll` do `backup.test.ts`) os apaga com `DROP DATABASE … WITH (FORCE)`; nenhum sobrou depois do `pnpm test` contra o banco externo.
- e2e `agentes.spec.ts`: os casos usam `freshSession()` (finaliza a ativa e abre o agente pelo ícone); novos: conversar, finalizar, a próxima mensagem numa sessão nova, abrir a anterior em leitura e bifurcar; e a conversão do `localStorage` antigo. 15 passaram com a pilha (mais `tema` e `backup`).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 132, server 164, contra o banco de teste recriado e migrado) e `pnpm build` passaram.

**Specs**: [026](../docs/026-sessoes-dos-agentes.md) (as escolhas do banco — `archived_reason` como marca e `pinned_at` removida —, as rotas, erros e regras da aplicação, o `localStorage` e os testes), [011](../docs/011-agentes-de-ia.md) (sessões no lugar de fixar/arquivar, F12 entregue), [INDEX](../docs/INDEX.md) e `AGENTS.md`.
