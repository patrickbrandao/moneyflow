---
status: concluida
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: media
criada: 2026-10-16
commit:
---

# Receitas de conciliação no banco (F16)

## Descrição
Lacuna entre o banco atual (migration 0046) e a spec [030](../docs/030-receitas-de-conciliacao.md), seção "Banco (dba)". O que fazer: uma migration nova com `ai_reconcile_recipes` (dona caixa ou global, agente, instrução até 20 mil, `run_on_import`, `position`, ativo, arquivamento, auditada), `ai_reconcile_recipe_targets` (conta corrente/poupança **ou** cartão, exatamente um; alvo da caixa dona quando a receita não é global; `run_on_import` exige alvo, checado no COMMIT), `ai_reconcile_recipe_runs` (fila e histórico, fora da auditoria), os limites (50 ativas por dona, 10 com `run_on_import` por conta) e a função de reserva da próxima execução `queued` de um lote (`SKIP LOCKED`, só sem execução ativa em conversa `reconcile_statement` do lote). Grants para `moneyflow_app`. Sem finalidade nova em `purpose`.

Ordem: primeira da F16; a [036](036-receitas-de-conciliacao-na-aplicacao.md) depende desta. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec e a [016](../docs/016-banco-de-dados.md) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: pgTAP **simples** (estrutura, os CHECKs principais, os limites e a reserva da fila) passando em `make -C database test`. O usuário pediu testes simples.

## Análise (triagem)
Designada direto pela sessão principal (recurso especificado pelo usuário em 2026-10-16).

**Executor designado: dba.**

## Resolução (executor)
Migration `database/migrations/0047_ai_reconcile_recipes.sql`, teste `database/tests/0047_ai_reconcile_recipes.sql` (simples: estrutura, grants, alvo, limites, COMMIT e a fila) e `0015_audit_log.sql` com `ai_reconcile_recipe_runs` entre as tabelas fora da auditoria. `make test` completo: 43 arquivos, 3307 testes, PASS; `schema.sql` regravado. Detalhes na [016](../docs/016-banco-de-dados.md) ("Receitas de conciliação"); a [030](../docs/030-receitas-de-conciliacao.md) ganhou as escolhas abaixo.

- **`ai_reconcile_recipes`**: `id`, `caixa_id` (nulo = global; imutável, `ai_reconcile_recipes_owner_immutable_check`), `agent_id`, `name` (1–120), `description` (≤ 2000), `instruction` (1–20 mil), `run_on_import`, `position` (0–100000), `is_active`, `archived_at` (arquivada não fica ativa: `ai_reconcile_recipes_active_check`), `created_by_user_id`, `created_at`, `updated_at`. Limite de 50 não arquivadas por dona: `23514 ai_reconcile_recipes_active_limit_check`. Auditada (`audit_row()`). App: SELECT/INSERT/UPDATE (DELETE revogado).
- **`ai_reconcile_recipe_targets`**: `id` (escolha: id próprio em vez de chave composta, porque uma das duas colunas é sempre nula; o backup a trata como tabela comum, sem `COMPOSITE_KEYS`), `recipe_id`, `financial_account_id`, `card_caixa_id`, timestamps. `ai_reconcile_recipe_targets_target_check` (exatamente um), `…_kind_check` (conta checking/savings, cartão credit_card), `…_owner_check` (conta da caixa dona; cartão = a própria dona **ou com a dona como `default_payer_caixa_id`**), únicos `…_account_key`/`…_card_key`, limite de 10 com `run_on_import` por alvo `23514 ai_reconcile_recipe_targets_import_limit_check`. `run_on_import` sem alvo falha no COMMIT: `23514 ai_reconcile_recipes_run_on_import_check` (constraint triggers deferidas nas duas tabelas). Auditada com `record_id = recipe_id`. App: DML completo. FKs CASCADE (receita, conta, cartão).
- **`ai_reconcile_recipe_runs`**: `id`, `recipe_id`, `import_id`, `user_id`, `trigger_kind` (`manual|import`), `position` (só e sempre em `import`), `line_ids uuid[]`, `status` (`queued|started|completed|skipped|failed`; `queued` só em `import`), `skip_reason`, `conversation_id`, `run_id`, mais `started_at` e `finished_at` (preenchidos pelo banco), timestamps. Transições `…_status_transition_check`, imutáveis `…_immutable_check`, vínculos `…_links_check` (sessão `reconcile_statement` de `user_id`), uma por receita na fila do import (`ai_reconcile_recipe_runs_import_queue_key`). Fora da auditoria. App: SELECT/INSERT/UPDATE.
- **Funções**: `ai_reconcile_import_lock(import_id)` (advisory lock do lote; use também no play e na conciliação genérica), `ai_reconcile_import_busy(import_id)` (para o 409), `ai_reconcile_recipe_claim(import_id)` → (`recipe_run_id`, `recipe_id`, `import_id`, `user_id`, `agent_id`, `recipe_name`, `instruction`, `position`), que pula como skipped `recipe_inactive`/`agent_inactive`/`user_inactive`, e `ai_reconcile_recipe_pending_imports(limite = 20)` → `import_id` (lotes com fila e livres). Índice `ai_conversations_reconcile_import_idx` em `screen_context->>'importId'`.
- Para a 036: `pnpm db:pull`; a aplicação grava `no_lines` (e os demais motivos) em `skip_reason`, passa a `completed`/`failed` ao fim da execução e põe `ai_reconcile_recipe_runs` em `EXCLUDED_TABLES` do backup.
