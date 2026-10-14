---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-10-14
commit:
---

# Sessão ativa única por usuário e agente no banco (F12)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [026](../docs/026-sessoes-dos-agentes.md), seção "Banco (dba)". O que fazer: Índice único parcial da sessão ativa, migração que arquiva as conversas extras (sem apagar), `ai_conversation_fork` arquivando a ativa, recusa de arquivar com execução ativa, destino de `pinned_at`.

Ordem: Depois da F11; depois vem a 027. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [026](../docs/026-sessoes-dos-agentes.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, `database/tests/0026_ai_conversations_and_runs.sql` e `schema.sql`.
- Estado atual:
  - `ai_conversations` tem `pinned_at` e `archived_at` (`schema.sql` l. 5388) e o índice `ai_conversations_chat_user_idx`;
  - `ai_conversation_fork(p_message_id, p_user_id, p_title)` (l. 324) cria a cópia `chat` para `p_user_id`.

**Riscos e observações**
- **Ordem da migração**: primeiro arquivar as extras (a ativa é a de `last_message_at` mais recente; com nulos, vale `created_at`), depois criar o índice único parcial.
- **Fork**: arquiva a ativa de (`p_user_id`, agente) antes do INSERT. Se a ativa tem execução ativa, a recusa 23514 se aplica, então a aplicação precisa parar a execução antes.
- **"Não voltam a ser ativas"**: hoje desarquivar é permitido (`updateConversation` na aplicação), e a spec não pede trava no banco.
- **`pinned_at`**: decisão do dba. Remover exige mudar a aplicação (027) na mesma branch.
- **Backup**: `ai_conversations` entra no JSON completo (não está em `EXCLUDED_TABLES`). Importar sessões ativas de outro arquivo pode bater no índice único (23505). É um ajuste de linha no `import.ts` (aplicação), que o dba documenta na 016.

**Dependências**
- Depois da F11. A 027 vem depois.
- A 032 usa a finalidade `scheduled_task`, que fica fora do índice (`purpose = 'chat'`).

**Como verificar**
- `make -C database test`.
- pgTAP:
  - a segunda ativa é recusada (23505);
  - a migração deixa uma ativa por par e não apaga mensagens;
  - o fork arquiva a ativa;
  - arquivar com execução ativa é recusado (23514).

**Pontos para a revisão da spec**
1. (026, Regras) "Não voltam a ser ativas" não tem trava no banco. Recomendação: um trigger que recusa `archived_at` voltar a NULL em `purpose = 'chat'`.
2. (026, Banco) A importação do backup pode trazer duas ativas para o mesmo par. Recomendação: um ajuste de linha no import que arquiva a importada quando já existe uma ativa, como o ajuste "finalidade das conversas de arquivos antigos".
3. (026, Sem execução ativa) A interação com o "Finalizar" está detalhada na 027, ponto 1.

## Resolução (executor)
Feito pelo dba em 2026-10-14 (sem commit; a sessão principal commita). Os pontos da revisão ficaram como a triagem recomendou e a spec já pede: trava no banco para a finalizada não voltar e o ajuste de linha no import do backup (descrito na 016 e abaixo, para o app).

**Migration `database/migrations/0043_ai_agent_sessions.sql`**
- **`ai_conversations.archived_reason`** (a marca técnica, numa coluna e não no `screen_context`, que vai ao prompt e é copiado pelo fork): `finished` (o usuário finalizou), `forked`, `migrated_from_multi` ou `import_conflict`; nulo = arquivada antes da F12 ou sem motivo. `ai_conversations_archived_reason_check` (vocabulário) e `ai_conversations_archived_reason_archived_check` (só com `archived_at`), as duas `23514`.
- **`ai_chat_sessions_consolidate()`** (só o dono do banco, sem `EXECUTE` para o app; idempotente), chamada pela migração antes do índice:
  - por (usuário, agente), fica ativa a `chat` de `last_message_at` mais recente (nulos por último; empate por `created_at` e `id`);
  - as outras são arquivadas com `migrated_from_multi`; nenhuma mensagem é apagada e o `screen_context` não muda;
  - as execuções ativas delas são encerradas: `queued`/`awaiting_confirmation` viram `canceled`, `running` recebe `cancel_requested_at` (o worker encerra no próximo heartbeat). Sem isso, a própria trava abaixo barraria a migração.
- **`ai_conversations_active_chat_key`**: índice único parcial `(user_id, agent_id) WHERE purpose = 'chat' AND archived_at IS NULL`; a segunda ativa dá `23505`.
- **Trigger `ai_conversations_archive_guard`** (`BEFORE UPDATE OF archived_at`, só `purpose = 'chat'`):
  - `archived_at` não volta a nulo: `23514 ai_conversations_unarchive_check`;
  - arquivar com execução `queued|running|awaiting_confirmation` sem `cancel_requested_at`: `23514 ai_conversations_archive_active_run_check`;
  - mudar o `archived_at` de uma finalizada para outro instante e renomear continuam livres; conversas de fluxo ficam fora (podem ser desarquivadas e arquivadas com execução ativa, como antes).
- **`ai_conversation_fork`**: antes do INSERT, arquiva com `forked` a sessão ativa de (`p_user_id`, agente da origem), que pode ser a própria origem; a cópia vira a ativa. Com execução ativa sem cancelamento pedido, `23514` e nada muda; criação concorrente do mesmo par, `23505`.
- **`pinned_at` saiu** (`DROP COLUMN`): o "fixar" deixou de existir na spec e manter a coluna sem uso só sobraria no Drizzle e no backup. Arquivos de backup antigos com `pinned_at` continuam importáveis (o import filtra as colunas pelo catálogo).
- Down: volta `pinned_at` (vazio), o fork antigo e remove índice, trigger, função e `archived_reason`; o que foi arquivado ou cancelado fica assim.

**Testes**
- `database/tests/0043_ai_agent_sessions.sql` (57 testes): estrutura e privilégios; a consolidação reproduzida sem o índice (uma ativa por par, a mais recente; sem mensagem, a criada por último; já arquivada e de fluxo intactas; mensagens e contexto preservados; execução na fila cancelada e rodando com o pedido; idempotente); a segunda ativa (`23505`), finalizada e de fluxo entram; motivo inválido ou sem `archived_at`; finalizada não volta (`23514`); finalizar com execução na fila ou rodando (`23514`) e, com o cancelamento pedido na mesma transação, finaliza e a próxima sessão abre; execução encerrada não impede; fork de uma finalizada, da própria ativa, para outro usuário, de uma conversa de fluxo e recusado com execução ativa.
- Ajustados `tests/0026_ai_conversations_and_runs.sql`, `0027_ai_usage.sql` e `0040_ai_requests_and_app_settings.sql`: as fixtures criavam duas conversas `chat` ativas do mesmo par; a segunda passou a nascer arquivada (ou com outro agente).
- `make -C database test`: 39 arquivos, 2805 testes, PASS. `make dump` rodado (`database/schema.sql`).
- Docs: [016](../docs/016-banco-de-dados.md) (*Conversas* e o item novo *Sessões*) e o resumo da 016 no [INDEX](../docs/INDEX.md).

**Para a aplicação (027)**
- `pnpm db:pull` (sai `pinned_at`, entra `archived_reason`). Até a 027, o `pnpm test` da API quebra onde o código usa `pinned_at` ou cria duas conversas `chat` ativas do mesmo par.
- Tirar o "fixar": `pinned_at` em `conversations.ts`, nas rotas, em `packages/shared/src/agents/{schemas,types}.ts`, no `AgentsMenu`/`useConversationActions`/`AgentWindows`, nos textos e em `agents.test.ts`.
- Erros a traduzir em `errors.ts`:
  - `23505 ai_conversations_active_chat_key`: já existe uma sessão ativa com o agente (corrida entre duas abas, ou fork concorrente); o `POST /api/agents/:agentId/messages` pode reler a ativa e usar ela;
  - `23514 ai_conversations_unarchive_check`: sessão finalizada não volta; bifurque. Tirar o desarquivar de `updateConversation` para `chat`;
  - `23514 ai_conversations_archive_active_run_check`: há execução ativa sem o parar pedido.
- **Finalizar** (`POST /api/conversations/:id/finish`), numa transação só: na execução ativa da sessão, `queued`/`awaiting_confirmation` → `status = 'canceled'` com `cancel_requested_at = now()` (sem isso ficariam paradas até expirar), `running` → só `cancel_requested_at = now()`; depois `archived_at = now(), archived_reason = 'finished'`.
- **Bifurcar**: `ai_conversation_fork` já finaliza a ativa (`forked`); se a ativa tem execução, peça o parar antes, na mesma transação, como no finalizar, ou devolva o erro.
- **Mensagem sem sessão ativa**: `INSERT` da conversa `chat`; com `23505`, releia a ativa.
- **Excluir**: a regra "a ativa precisa ser finalizada antes" fica na aplicação (o banco não recusa o `DELETE` da ativa).
- **Execução nova numa finalizada**: o banco não recusa; a aplicação só cria execução na sessão ativa (a finalizada é somente leitura).
- **Backup (`import.ts`)**, ajuste de linha em `ai_conversations`, depois do da finalidade: se a linha é `chat` (ou sem `purpose`, que vira `chat`) e `archived_at` é nulo, e já existe no banco — na mesma transação, inclusive as entradas antes no mesmo arquivo — uma `chat` ativa de outro id para o mesmo `user_id`/`agent_id`, grave a importada com `archived_at = now()` e `archived_reason = 'import_conflict'`. Arquivos anteriores à 0043 podem trazer várias ativas do mesmo par: fica ativa a primeira importada (ordenar as `chat` ativas do arquivo por `last_message_at` desc, nulos por último, deixa a mais recente, como a migração). `pinned_at` desses arquivos é ignorado. Teste em `backup.test.ts`: importar uma sessão ativa num banco que já tem a ativa do par.
- Nas listas: finalizadas por `archived_at IS NOT NULL` com `purpose = 'chat'`; a ativa por (`user_id`, `agent_id`) usa o índice único.
