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

# Tarefas agendadas, conciliação com IA e Telegram de entrada no banco (F15)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [029](../docs/029-fluxos-autonomos.md), seção "Banco (dba)". O que fazer: `ai_scheduled_tasks` e `ai_scheduled_task_runs` (claim, `next_run_at` em SP), finalidades `scheduled_task`/`reconcile_statement`, `ai_auto_reconcile` em contas e cartões, entrada no destino Telegram com `webhook_secret` write-only e `telegram_webhook_authenticate`, `telegram_links`, `telegram_pairing_codes`, `telegram_updates_seen`, notificação `ai_task_awaiting_approval`, chave `telegram.public_base_url`.

Ordem: Depois da F14; depois vem a 033. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

Acréscimo (2026-10-14): o kit "Padrão" de `database/seeds/dev.sql` deve ganhar as tools novas das F14 (orçamentos) e F15 (tarefas agendadas) no `suggestedMode`, como a 030 fez com as F13a/F13b.

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
Feito pelo dba em 2026-10-14 (sem commit; a sessão principal commita). Os três pontos da triagem ficaram como recomendado: `caixas.ai_auto_reconcile` com CHECK de `credit_card`, índice único parcial em `bot_id` entre os destinos com entrada ligada, e a importação trazendo `inbound_enabled = false`. Decisões do dba: `next_run_at` e o limite de 20 ativas ficam **no banco**; a coluna do segredo chama-se `webhook_secret_hash` (guarda o hash, como `token_hash`); entrada ligada exige destino ativo. A spec 029 cita `webhook_secret`: trocar pelo nome real fica com o principal.

**Migration `database/migrations/0045_ai_autonomous_flows.sql`**
- **Finalidades**: `scheduled_task` e `reconcile_statement` em `ai_conversations_purpose_check`, `ai_usage_purpose_check` e `ai_requests_purpose_check` (não há outro CHECK do vocabulário). `ai_usage_is_flow` não mudou e as trata como fluxo, com e sem conversa (testado). O índice da sessão ativa (`purpose = 'chat'`) já as deixa de fora.
- **`ai_auto_reconcile boolean NOT NULL DEFAULT false`** em `financial_accounts` (só `checking`/`savings`: `financial_accounts_ai_auto_reconcile_check`) e em `caixas` (só `credit_card`: `caixas_ai_auto_reconcile_check`).
- **Agenda** (`schedule jsonb`, `ai_schedule_valid`): `{"kind":"daily","time":"HH:MM"}`, `{"kind":"weekly","time","weekdays":[1–7 ISO, 1 = segunda]}`, `{"kind":"monthly","time","day":1–31 | "last"}`; só essas chaves, todas obrigatórias. Fuso America/Sao_Paulo. Dia que o mês não tem = último dia do mês (como a recorrência). `ai_schedule_next_run(agenda, depois_de)` e `ai_schedule_prev_run(agenda, em)`.
- **`ai_scheduled_tasks`**: colunas da spec. O trigger calcula `next_run_at` ao criar, ligar ou mudar a agenda (nulo se desligada) e aplica o limite de 20 ativas por usuário (`23514 ai_scheduled_tasks_active_limit_check`, com trava por usuário). Dono imutável (`ai_scheduled_tasks_user_immutable_check`); agente sem `ON DELETE` (`23503`). Auditada, menos `next_run_at`/`last_run_at`.
- **`ai_scheduled_task_runs`**: colunas da spec mais `trigger_kind` (`schedule|manual`). Único por (`task_id`, `scheduled_for`). `conversation_id`/`run_id` `ON DELETE SET NULL`. Checks: `reason_check`, `run_check`, `links_check`, `immutable_check`, `status_transition_check`. Fora da auditoria e do backup.
- **Claim e "Rodar agora"**: `ai_scheduled_task_claim(limite, atraso_máximo)` (SKIP LOCKED; vários perdidos viram um; pula com `missed_window`, `user_inactive`, `agent_inactive`, `previous_run_active`) e `ai_scheduled_task_run_now(tarefa)`.
- **Telegram de entrada**: `message_destinations.inbound_enabled`, `inbound_agent_id`, `webhook_secret_hash`, com `GRANT SELECT` só nas duas primeiras. CHECKs `message_destinations_inbound_check` e `message_destinations_webhook_secret_hash_check`; índice `message_destinations_inbound_bot_key`. Funções `telegram_secret_hash`, `telegram_webhook_authenticate` e `admin_message_destination_webhook_secret`.
- **Pareamento**: `telegram_links`, `telegram_pairing_codes` (`code_hash` sem SELECT), `telegram_pairing_code_create` e `telegram_pairing_consume`. Os dois são auditados (o `@username` sozinho não gera linha).
- **Dedup**: `telegram_updates_seen`, `telegram_update_seen` e `telegram_updates_seen_purge` (7 dias).
- **`audit_row()`**: `webhook_secret_hash` e `code_hash` entram na lista de segredos.
- **`ai_awaiting_approval`**: notificação, assinatura (só `{}`) e outbox.
- **`app_setting_valid`**: `telegram.public_base_url`, texto `https://host[:porta][/caminho]` sem barra no fim, query nem fragmento, até 500.
- **Down**: as finalidades novas voltam a `chat` no uso e nas requisições; a sessão de tarefa vira `chat` finalizada e a conciliação, `classify_lines`. Apaga as linhas `ai_awaiting_approval` e a chave nova. Conferido com dados no banco de teste.

**Seed** (`database/seeds/dev.sql`): o kit "Padrão" ganhou `list_ai_budgets` e `list_agent_tasks` em `allow`; `create_ai_budget`, `update_ai_budget`, `delete_ai_budget`, `create_agent_task`, `update_agent_task`, `delete_agent_task` e `run_agent_task_now` em `ask`. São 154 tools: as 149 do registro atual mais as 5 da F15. Carregado no banco de desenvolvimento.

**Testes**
- `database/tests/0045_ai_autonomous_flows.sql`, 265 testes, entre eles:
  - claim sem repetição e o horário já disparado que não volta;
  - `next_run_at` diário, semanal, mensal, dia 31 em meses curtos, último dia em ano bissexto e a hora de SP;
  - único por (tarefa, horário);
  - `telegram_webhook_authenticate` certo, errado e nulo;
  - `moneyflow_app` sem SELECT no segredo e no hash (`42501`);
  - código que expira e é de uso único;
  - auditoria sem os segredos.
- Ajustados os testes antigos que listam colunas e tabelas: 0004 (colunas), 0015 (tabelas fora da auditoria) e 0020 (colunas legíveis).
- `make -C database test`: 41 arquivos, 3237 testes, PASS (inclui o down da 0045). Também conferido à mão, com duas sessões, que o claim concorrente não bloqueia nem duplica.
- `make dump` rodado. Docs: [016](../docs/016-banco-de-dados.md) e o resumo no [INDEX](../docs/INDEX.md).

**Para a aplicação (033)**: o relatório do dba à sessão principal lista as funções, assinaturas, erros e o backup.
