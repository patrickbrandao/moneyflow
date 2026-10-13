---
status: concluida
tipo: banco
origem: agente
autor: app
responsavel: dba
prioridade: baixa
criada: 2026-10-11
commit:
---

# Coluna própria para a finalidade da conversa

## Descrição
As conversas criadas pelos fluxos (documento, classificação) são marcadas por `screen_context.purpose` (jsonb) e arquivadas para sumir da lista. Pedido: `ai_conversations.purpose` (`chat|document|classification`, padrão `chat`) com índice, para filtrar sem depender do jsonb; depois o `app` migra o uso.

## Como reproduzir
Consultar `ai_conversations` com `screen_context->>'purpose'`.

## Análise (triagem)
**Procede** (conferido em 2026-10-13). A finalidade continua só em `ai_conversations.screen_context->>'purpose'` (jsonb, `0026_ai_conversations_and_runs.sql`), lida em quatro pontos:
- `apps/server/src/services/conversations.ts`: `NOT_FLOW` (`screen_context ? 'purpose'`) esconde as conversas dos fluxos da lista e da busca.
- `apps/server/src/agents/runner.ts`: decide se a execução é de fluxo (sem tools, sem MCP, uma iteração, `applyFlowResult`).
- `apps/server/src/agents/events-hub.ts`: não avisa no sino os fluxos síncronos (`SYNC_FLOW_PURPOSES`).
- Gravação: `services/ai-flows.ts` e `services/contract-documents.ts` (`createConversation(..., { screenContext: { purpose, ... }, archived: true })`).

Os valores agora são quatro: `document_reading`, `classify_lines`, `contract_reading` e `contract_markdown` (`agents/flows.ts`).

Há também uma fragilidade real, além do índice: `sendMessage` (`conversations.ts`) **substitui** `screen_context` inteiro quando a mensagem traz contexto da tela. O dono de uma conversa de fluxo (o id volta na resposta da leitura de documento) pode mandar uma mensagem nela e apagar a finalidade. A conversa passa a aparecer na lista e a rodar como chat com tools. O impacto é baixo (é a conversa do próprio usuário), mas some com a coluna própria. Do mesmo jeito, `ai_conversation_fork` copia o `screen_context`, e com ele a finalidade.

**Parte do banco (esta tarefa, dba):**
1. `ai_conversations.purpose text NOT NULL DEFAULT 'chat'`, CHECK `IN ('chat','document_reading','classify_lines','contract_reading','contract_markdown')` (mesmo vocabulário da 001) e índice (ex.: parcial `WHERE purpose <> 'chat'`, ou `(user_id, purpose)` se servir à listagem).
2. Backfill: `purpose = screen_context->>'purpose'` quando o valor estiver na lista.
3. Recomendado: a finalidade é imutável depois do INSERT (trigger ou REVOKE UPDATE da coluna), e `ai_conversation_fork` cria a cópia como `chat` ou recusa bifurcar conversa de fluxo (o dba escolhe; a cópia como `chat` é a opção mais simples).
4. pgTAP (0026), `COMMENT ON` e spec 016.

Fazer na mesma migration da 001. Depois: **tarefa 013** (app) troca as leituras do jsonb pela coluna.

Risco: baixo (coluna nova com padrão; o backfill é determinístico). Verificação: `make -C database test`; as conversas de fluxo existentes ficam com a finalidade certa; um UPDATE da finalidade falha.

Ordem: 001 + 003 (dba) → 013 → 011 (app). Esforço: pequeno a médio (~1–2 h).

## Resolução (executor)
Feito em 2026-10-13 (dba), na migration `database/migrations/0033_ai_purpose.sql` (junto com a 001).

- `ai_conversations.purpose text NOT NULL DEFAULT 'chat'`, `ai_conversations_purpose_check` com `chat`, `document_reading`, `classify_lines`, `contract_reading`, `contract_markdown` (mesmo vocabulário de `ai_usage.purpose`).
- Backfill: `purpose = screen_context->>'purpose'` quando o valor está na lista (sem mexer em `updated_at`); o resto fica `chat`. O `screen_context` não é alterado.
- Imutável depois do INSERT, por trigger (`ai_conversations_purpose_immutable`, `BEFORE UPDATE OF purpose` só quando o valor muda): `23514` com `CONSTRAINT = 'ai_conversations_purpose_immutable_check'`. REVOKE de coluna não serviria (o papel tem UPDATE na tabela inteira).
- `ai_conversation_fork` cria a cópia sempre como `chat` e tira a chave `purpose` do `screen_context` copiado (não recusa bifurcar conversa de fluxo).
- Índices: `ai_conversations_chat_user_idx (user_id, last_message_at DESC NULLS LAST) WHERE purpose = 'chat'` (lista e busca do usuário) e `ai_conversations_purpose_idx (purpose, created_at) WHERE purpose <> 'chat'` (manutenção das conversas dos fluxos).
- `COMMENT ON`, spec 016, pgTAP em `database/tests/0026_ai_conversations_and_runs.sql`, `schema.sql` e `packages/db/src/generated` regenerados.

Verificação: `make -C database test` verde; backfill conferido à mão (finalidade válida copiada, inválida ou ausente fica `chat`). Próximo: tarefa 013 (app).
