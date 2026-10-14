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
Feito pelo dba em 2026-10-14 (sem commit; a sessão principal commita). Os dois pontos da revisão ficaram como a spec revisada já diz: o aviso dos fluxos pulados é o próprio `ai_budget_alert`, e o uso dos fluxos conta no `user` de quem acionou e no `flows`.

**Migration `database/migrations/0044_ai_budgets_and_usage_panel.sql`**
- **`ai_budgets`**: `id`, `scope` `user|agent|flows|global`, `user_id`/`agent_id` (FKs CASCADE), `currency` `USD|BRL` (padrão USD), `monthly_limit_micros` > 0, `alert_percent` 1–99 (padrão 80), `is_active` (padrão true) e datas.
  - CHECKs `23514`: `ai_budgets_scope_check`, `ai_budgets_target_check` (`user_id` só e sempre em `user`, `agent_id` só e sempre em `agent`, nenhum nos outros dois), `ai_budgets_currency_check`, `ai_budgets_monthly_limit_micros_check`, `ai_budgets_alert_percent_check`.
  - Unicidade: `ai_budgets_active_key`, índice único parcial `(scope, user_id, agent_id, currency) NULLS NOT DISTINCT WHERE is_active` (`23505`). Dois `global` ou dois `flows` ativos da mesma moeda colidem; os inativos e outra moeda, não.
  - Auditada por `audit_row()`; `set_updated_at`; DML para `moneyflow_app`.
- **O que é fluxo**: `ai_usage_is_flow(finalidade_do_uso, finalidade_da_conversa)`.
  - Com conversa: é fluxo se a conversa tem `purpose <> 'chat'`.
  - Sem conversa (nula ou excluída): é fluxo se a finalidade do uso não é um tipo de chamada (`chat`, `title`, `embedding`, `vision_describe`, `transcription`, `speech`).
  - É definido pela finalidade, sem lista de fluxos: os da 032 (`scheduled_task`, `reconcile_statement`) entram sozinhos.
- **`ai_budget_status(p_month date DEFAULT NULL)`**: um registro por orçamento ativo, na ordem global, flows, agent, user. O mês é qualquer dia dele; nulo = o mês corrente em São Paulo.
  - Colunas: `budget_id, scope, user_id, agent_id, currency, monthly_limit_micros, alert_percent, month, spent_micros, unpriced_calls, percent, status`.
  - `spent_micros` soma `cost_micros` no mês de São Paulo, só na moeda do orçamento. `unpriced_calls` conta as chamadas sem preço do escopo (para "N chamadas sem preço").
  - `percent` tem 2 casas. `status`: `blocked` com gasto ≥ valor, `alert` com gasto ≥ valor × aviso ÷ 100, senão `ok`.
- **`ai_budget_check(p_user_id uuid, p_agent_id uuid, p_is_flow boolean)`**: as mesmas colunas, só dos orçamentos ativos **estourados** (`blocked`) no mês corrente que valem para a execução: global, o do usuário, o do agente e, com `p_is_flow`, o `flows`. Nenhuma linha = pode seguir.
  - O escopo `user` soma todo o uso com `user_id` do usuário, os fluxos inclusive. `agent` soma o uso com `agent_id` do agente. `global` soma tudo, embeddings inclusive.
  - Apoio interno: `ai_budget_usage` e `ai_budget_state`, com uma consulta por escopo, cada uma no seu índice de `ai_usage` (`created_at`; `user_id, created_at`; `agent_id, created_at`).
- **`ai_usage_daily`** (visão `security_invoker`): dia em São Paulo × provedor × **modelo** × agente × usuário × finalidade × moeda.
  - O modelo vai além da spec: serve à tabela "por modelo" num período qualquer; quem não precisa dele soma.
  - Colunas: `calls`, `runs`, `conversations`, os quatro tokens, `audio_seconds`, `characters`, `cost_micros` e `has_unpriced`.
  - Índice de expressão novo `ai_usage_sp_day_idx`: filtrar por `day` usa o índice (conferido no EXPLAIN).
- **`ai_usage_top_conversations(p_from date, p_to date, p_limit integer DEFAULT 20, p_provider_id uuid DEFAULT NULL, p_agent_id uuid DEFAULT NULL, p_user_id uuid DEFAULT NULL, p_purpose text DEFAULT NULL)`**: as N conversas mais caras **por moeda** no período (datas de São Paulo, inclusivas).
  - Colunas: `rank` (por moeda), `conversation_id`, `title`, `conversation_purpose`, `owner_user_id`, `conversation_agent_id`, `archived_at`, `currency`, `cost_micros`, `calls`, `runs`, os quatro tokens, `audio_seconds`, `characters`, `unpriced_calls` e `last_used_at`.
  - Só o uso com preço entra no custo e nos totais da linha; o uso sem conversa fica de fora.
  - `22023` com período nulo ou invertido, acima de 3660 dias, ou com limite fora de 1–100.
- **Visões mensais**: `ai_usage_monthly_by_user`, `_by_agent` e `_by_purpose` ganham `audio_seconds` (numeric) e `characters` (bigint) no fim.
- **`ai_budget_alert`**:
  - entra em `notifications_kind_check`, `message_subscriptions_event_kind_check` e `message_outbox_event_kind_check`;
  - em `message_subscription_params_valid`, aceita só `{}`.
- **`app_setting_valid`**: aceita `ai.runs_per_minute` e `ai.flow_runs_per_minute`, número inteiro JSON de 1 a 1000 (sem aspas nem casas decimais).
- **Down**: apaga as notificações, assinaturas e mensagens `ai_budget_alert` e as duas chaves de `app_settings`, e volta CHECKs, funções e visões. A tabela sai.

**Seed** (`database/seeds/dev.sql`): o kit "Padrão" passou a ter as 145 tools do registro atual (`tools.ts` 49 + `tools-operation.ts` 41 + `tools-admin.ts` 55), lidas de `AGENT_TOOLS` por script.
- Cada tool entra no `suggestedMode` dela: 52 `allow` (as leituras, `notify_user` e `refresh_mcp_tools`) e 93 `ask`.
- As 8 tools com `secrets` ficam em `ask`.
- Não usa mais `ai_legacy_tool_registry()`. Continua idempotente: um kit que já existe ganha as que faltam e as que já estão nele ficam como o admin deixou. Conferido duas vezes no banco de desenvolvimento.

**Testes**
- `database/tests/0044_ai_budgets_and_usage_panel.sql`, 167 testes:
  - estrutura, privilégios e `ai_usage_is_flow`;
  - CHECKs e FK;
  - unicidade com alvo nulo (global e flows) e por usuário e agente; reativar um duplicado dá `23505`; outra moeda e inativos não colidem;
  - auditoria com o ator;
  - status `ok`/`alert`/`blocked` nas fronteiras (50% com aviso 50, 100%);
  - uso sem preço e em BRL fora do gasto em USD; o sem preço contado em `unpriced_calls`;
  - fluxo com e sem conversa e a descrição de imagem dentro do fluxo; os fluxos contando no `user` e no `flows`;
  - mês anterior (até o último segundo em São Paulo) e o parâmetro de mês;
  - checagem combinando global, flows, agent e user; orçamentos desligados não bloqueiam;
  - visão diária e mensais com áudio e caracteres;
  - ranking por moeda, limite, filtros e `22023`;
  - notificação, assinatura e outbox `ai_budget_alert`;
  - chaves novas válidas e inválidas, gravação e `app_settings_value_check`;
  - papel da aplicação; CASCADE com o agente.
- `make -C database test`: 40 arquivos, 2972 testes, PASS (inclui o down da 0044). `make dump` rodado (`database/schema.sql`).
- Docs: [016](../docs/016-banco-de-dados.md) (Mensagens, Notificações, Configurações, Auditoria, Uso e o item novo *Orçamentos e painel de uso*) e o resumo da 016 no [INDEX](../docs/INDEX.md). A spec 028 lista as dimensões de `ai_usage_daily` sem o modelo; o modelo foi acrescentado (ver acima) e ajustar a spec fica com o principal, se quiser.

**Para a aplicação (031)**
- `pnpm db:pull`: entram `ai_budgets` e as colunas novas das visões. Atenção a `SELECT u.*` em `ai-admin.ts` (l. 1042–1048): as mensais trazem `audio_seconds` (numeric, chega como string no `pg`) e `characters` (bigint).
- Antes de criar execução, no runner antes de cada chamada e nos fluxos: `SELECT * FROM ai_budget_check($user, $agent, $isFlow)`. `$isFlow` = `purpose <> 'chat'` da conversa.
  - Linhas devolvidas = 429, "Orçamento de IA do mês atingido: <escopo>", com o `scope` da primeira linha; o runner termina `failed` com `budget_exceeded`.
  - A isenção do admin que aciona é da aplicação: o banco devolve os estourados de qualquer um.
- Avisos no `message-worker`: `ai_budget_status()` dá `status` e `percent` de cada orçamento ativo.
  - Notificação `kind = 'ai_budget_alert'` com `ON CONFLICT (user_id, dedup_key) DO NOTHING`, e mensagem com `event_kind = 'ai_budget_alert'` e `ON CONFLICT (destination_id, dedup_key) DO NOTHING`.
  - Sugestão de `dedup_key`: `ai_budget_alert:<budget_id>:<YYYY-MM>:<80|100>`, com o percentual de aviso do orçamento no lugar de 80. A assinatura do evento tem `params = {}`.
- Painel:
  - `ai_usage_daily WHERE day BETWEEN $de AND $ate` e filtros (gráficos e tabela por modelo e por finalidade);
  - `ai_usage_top_conversations($de, $ate, 20, provedor, agente, usuário, finalidade)`, top 20 por moeda;
  - `ai_budget_status($mes)` para as barras, junto com `ai_provider_health`;
  - para o usuário comum: `ai_usage_monthly_by_user` e as linhas de `ai_budget_status()` com `scope = 'user' AND user_id = eu` (e `global`, se a tela mostrar).
- Limites por minuto: ler `app_settings` `ai.runs_per_minute` e `ai.flow_runs_per_minute`. O banco vence a variável; o valor é número JSON, e fora de 1–1000 dá `23514 app_settings_value_check`.
- Erros a traduzir em `errors.ts`:
  - `23505 ai_budgets_active_key`: já existe um orçamento ativo para esse escopo, alvo e moeda;
  - `23514` com `ai_budgets_target_check`, `ai_budgets_monthly_limit_micros_check`, `ai_budgets_alert_percent_check`, `ai_budgets_currency_check` ou `ai_budgets_scope_check`;
  - `22023` do ranking (período ou limite).
- Backup: `ai_budgets` entra no JSON completo pelo catálogo genérico (tem `id` e FKs para `users` e `ai_agents`), sem segredo, sem cluster e sem chave composta.
  - Um orçamento ativo que colide com um cadastrado volta como conflito (`23505`).
  - Se quiser que ele case com o cadastrado em vez de virar conflito: `NATURAL_KEYS.ai_budgets = [['scope', 'user_id', 'agent_id', 'currency']]`. A recomendação é deixar como conflito, porque os inativos podem repetir a chave.
  - Incluir `ai_budgets` no teste de backup.
- Mudanças em `packages/shared`:
  - espelhar `ai_budget_alert` em `messages.ts`, nos tipos de notificação e nos textos;
  - criar as tools `list_ai_budgets`, `create_ai_budget`, `update_ai_budget` e `delete_ai_budget`;
  - quando entrarem no registro, acrescentar as quatro ao kit "Padrão" do `database/seeds/dev.sql` (pedir ao dba).
