---
status: aberta
tipo: banco
origem: usuario
autor: principal
responsavel: dba
prioridade: baixa
criada: 2026-10-14
commit:
---

# Tarefas agendadas, conciliação com IA e Telegram de entrada no banco (F15)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [029](../docs/029-fluxos-autonomos.md), seção "Banco (dba)". O que fazer: `ai_scheduled_tasks` e `ai_scheduled_task_runs` (claim, `next_run_at` em SP), finalidades `scheduled_task`/`reconcile_statement`, `ai_auto_reconcile` em contas e cartões, entrada no destino Telegram com `webhook_secret` write-only e `telegram_webhook_authenticate`, `telegram_links`, `telegram_pairing_codes`, `telegram_updates_seen`, notificação `ai_task_awaiting_approval`, chave `telegram.public_base_url`.

Ordem: Depois da F14; depois vem a 033. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [029](../docs/029-fluxos-autonomos.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migrations novas, pgTAP e `schema.sql`.
- Pontos de `schema.sql` que mudam:
  - CHECK de `ai_conversations.purpose` (l. 5404) e de `ai_usage.purpose` (l. 5616), e o `purpose` de `ai_requests` (020);
  - os CHECKs de notificação e de evento (l. 8816 e l. 8723);
  - `message_destinations` (l. 8610);
  - `caixas` (l. ~6616).

**Riscos e observações**
- **`message_destinations` guarda segredo** (`bot_token`):
  - `inbound_enabled` e `inbound_agent_id` precisam de `GRANT SELECT` explícito;
  - `webhook_secret` (hash) fica sem SELECT, entra na lista `secrets` de `audit_row()` (l. 1621) e ganha um leitor `admin_*` para o backup (database/AGENTS.md).
- **Um bot só aceita um webhook**: dois destinos com o mesmo bot e a entrada ligada se sobrescrevem no `setWebhook`. A coluna gerada `bot_id` já existe (l. 8617).
- **"O equivalente no cartão"**: o cartão é uma caixa com `kind = 'credit_card'`. A coluna fica em `caixas`, com CHECK, e a spec não diz isso.
- **`telegram_pairing_codes`**: o hash do código é segredo, tratado como `token_hash`.
- **`telegram_links`**: único parcial em (`destination_id`, `chat_id`) `WHERE revoked_at IS NULL`.
- **`ai_scheduled_task_runs`**: `conversation_id`/`run_id` com `ON DELETE SET NULL`, para que excluir a sessão não apague o histórico da tarefa.
- **`next_run_at` em São Paulo**: inclui "último dia" e o dia 31 em meses curtos.
- **`telegram_updates_seen`**: purga em 7 dias.

**Dependências**
- Depois da F14 (`app_settings` vem da 020).
- O `scheduled_task` fica fora do índice de sessão ativa da 026. A 033 vem depois.

**Como verificar**
- `make -C database test`.
- pgTAP:
  - claim sem repetição;
  - `next_run_at` (diário, semanal, mensal, último dia);
  - único por (tarefa, horário);
  - `telegram_webhook_authenticate` certo e errado;
  - `moneyflow_app` não lê o segredo nem o hash;
  - o código expira e é de uso único;
  - auditoria sem o segredo.

**Pontos para a revisão da spec**
1. (029, Banco) A spec não diz onde fica a coluna do cartão. Recomendação: `caixas.ai_auto_reconcile` com CHECK `kind = 'credit_card' OR NOT ai_auto_reconcile`.
2. (029, Telegram) Falta a unicidade do webhook por bot. Recomendação: índice único parcial em `bot_id` `WHERE inbound_enabled`.
3. (029, Backup) Restaurar `webhook_secret` (hash) noutra instância não reativa o webhook, porque o segredo precisa ser reenviado ao Telegram. Recomendação: importar com `inbound_enabled = false`.

## Resolução (executor)
