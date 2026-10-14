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

# Orçamentos, visões de uso e avisos no banco (F14)

## Descrição
Lacuna entre o código atual (v0.1.7) e a spec [028](../docs/028-limites-e-uso.md), seção "Banco (dba)". O que fazer: `ai_budgets`, `ai_budget_status`/`ai_budget_check`, `ai_usage_daily` e ranking por conversa, notificação e evento `ai_budget_alert`, chaves `ai.runs_per_minute`/`ai.flow_runs_per_minute` em `app_setting_valid`.

Ordem: Depois da F13; depois vem a 031. A spec é a fonte da verdade: decisões que mudarem durante a execução atualizam a spec (e a [016](../docs/016-banco-de-dados.md), quando for banco) na mesma mudança.

Acréscimo (2026-10-14, pendência das 023/025): as visões mensais de uso (`ai_usage_monthly_*`) e a nova `ai_usage_daily` devem somar também `audio_seconds` e `characters`.

Acréscimo (2026-10-14, pendência das 028/029): o kit "Padrão" de `database/seeds/dev.sql` deve incluir todas as tools do registro (`packages/shared/src/agents/tools*.ts`, inclusive as das F13a/F13b) no modo sugerido de cada uma (`suggestedMode`), sem as de segredo, que ficam sempre `ask`.

## Como reproduzir
Não se aplica (recurso novo). Critério de pronto: os testes listados na seção "Testes" da spec [028](../docs/028-limites-e-uso.md) que cabem a esta tarefa passam, junto com `pnpm lint`, `pnpm typecheck` e `pnpm test` (e `make -C database test` no banco).

## Análise (triagem)
Specs revisadas em 2026-10-14: os "pontos para a revisão da spec" foram resolvidos nas specs pelas recomendações da triagem (segredos digitados no cartão de aprovação; `restore_dump` fora das tools; `{{usuario.nome}}` = login e caixa principal escolhida em `user_ai_settings.primary_caixa_id`). Em caso de divergência, vale a spec (não entregue ao executor). Triagem em 2026-10-14.

**Executor designado: dba.** Tipo confirmado: banco.

**Arquivos afetados**
- Migration nova, pgTAP e `schema.sql`.
- Base existente:
  - `app_settings` e `app_setting_valid` (020);
  - `ai_usage.cost_micros` e `currency` (`schema.sql` l. 5608–5614);
  - os CHECKs `notifications_kind_check` (l. 8816) e `message_subscriptions_event_kind_check` (l. 8723), mais `message_subscription_params_valid`.
- O espelho dos eventos em `packages/shared/src/messages.ts` é da aplicação (031).

**Riscos e observações**
- **"No máximo um ativo por (escopo, alvo, moeda)"**: nos escopos `flows` e `global` o alvo é nulo. O índice único precisa de `NULLS NOT DISTINCT` ou de `coalesce`.
- **O que é fluxo**: em `ai_budget_check(user, agent, is_flow)`, "fluxos" são as conversas com finalidade ≠ `chat`, o que inclui `scheduled_task` e `reconcile_statement`, que só chegam na 032. Definir pela finalidade, não por uma lista fixa.
- **Mês em São Paulo**: `created_at AT TIME ZONE 'America/Sao_Paulo'`.
- **Desempenho**: a checagem antes de cada chamada ao modelo soma o `ai_usage` do mês. Precisa de índice em (`created_at`) mais as chaves de escopo, ou de agregados.
- **Ranking de sessões por custo**: uma função com período, porque uma view não recebe parâmetro.

**Dependências**
- Depois da F13. Usa a 020. A 031 vem depois.

**Como verificar**
- `make -C database test`.
- pgTAP:
  - status `ok`/`alert`/`blocked`;
  - uso sem preço e uso em outra moeda não contam;
  - a checagem combina os escopos;
  - as chaves novas em `app_setting_valid`;
  - unicidade com o alvo nulo.

**Pontos para a revisão da spec**
1. (028, Bloqueio) "A conciliação e as tarefas agendadas são puladas, com notificação" não diz qual notificação. Recomendação: o próprio `ai_budget_alert`.
2. (028, Vários orçamentos) Não está claro se os fluxos acionados por um usuário contam no orçamento `user` dele. Recomendação: contam no `user` e no `flows`.

## Resolução (executor)
