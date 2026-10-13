---
status: rejeitada
tipo: banco
origem: agente
autor: app
responsavel: dba
prioridade: baixa
criada: 2026-10-11
commit:
---

# Rastro de ator nas sugestões do agente em linhas de extrato

## Descrição
`statement_lines` está fora da auditoria, então as sugestões do agente (entidade/categoria) gravadas nas linhas de extrato não registram quem as fez. Pedido: avaliar `audit_row` em `statement_lines`, ignorando colunas de alto volume/ruído, para que `actor_kind = agent` e `agent_run_id` apareçam no log.

## Como reproduzir
Gerar sugestões com IA numa importação e procurar o registro no `audit_log`.

## Análise (triagem)
**Não procede: já é atendido pelo código atual.** A premissa ("`statement_lines` está fora da auditoria") não confere.

Evidência:
- `database/migrations/0015_audit_log.sql`: `statement_lines` está no laço que cria `<tabela>_audit AFTER INSERT OR UPDATE OR DELETE ... EXECUTE FUNCTION audit_row()`. `database/schema.sql` tem `CREATE TRIGGER statement_lines_audit`. Nenhuma migration posterior remove o trigger.
- `0030_audit_agent_run.sql`: `audit_write` grava `actor_kind` e `agent_run_id` (validado contra `ai_runs`) a partir de `app.actor_kind` / `app.agent_run_id`.
- `apps/server/src/agents/runner.ts` monta o `ServiceContext` da execução com `actorKind: 'agent', agentRunId: runId`. `applyFlowResult` → `suggestClassifications` (`services/reconciliation.ts`) escreve por `withTx(ctx, …)`.
- Reproduzido: `MONEYFLOW_TEST_DATABASE_URL=…/moneyflow_test pnpm --filter @moneyflow/server exec vitest run test/agents.test.ts -t "conciliação recebe sugestões"` passou. Depois, `audit_log` tem linhas `table_name = 'statement_lines'`, `action = 'update'`, `actor_kind = 'agent'`, `agent_run_id` de uma execução existente e `changed_columns = {category_id, classification_source, entity_id}`. Aprovar ou descartar sai como `user`, pelo mesmo trigger.

Sem mudança no banco. A asserção de regressão (o `audit_log` da linha sugerida com `actor_kind = agent` e `agent_run_id`) foi passada para a **tarefa 006**, que já mexe nesse teste. Sobre ruído: o INSERT da importação grava `raw` no log. Se o volume incomodar, isso é outro assunto (`audit_row('raw')` não ajuda no INSERT); abrir tarefa própria se for o caso.

## Resolução (executor)
