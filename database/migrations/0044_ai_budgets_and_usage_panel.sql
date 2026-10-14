-- migrate:up
-- F14, orçamentos, limites e painel de uso (spec 028; tarefa 030).
--   * ai_budgets: orçamento mensal por escopo (user, agent, flows, global), moeda, valor em micros, percentual de aviso
--     e interruptor; no máximo um ativo por (escopo, alvo, moeda), com NULLS NOT DISTINCT (alvo nulo em flows/global).
--     Auditada por audit_row().
--   * ai_usage_is_flow(finalidade do uso, finalidade da conversa): "fluxo" é o uso de conversa com purpose <> chat; sem
--     conversa (excluída ou nunca houve), vale a finalidade do próprio uso, que não seja um tipo de chamada (chat,
--     title, embedding, vision_describe, transcription, speech).
--   * ai_budget_usage / ai_budget_state (internas, de apoio), ai_budget_status(mês) e ai_budget_check(usuário, agente,
--     é_fluxo): gasto no mês de São Paulo, na moeda do orçamento (uso sem preço e noutra moeda não contam; o sem preço
--     é contado à parte), percentual e situação ok|alert|blocked.
--   * ai_usage_daily (dia em São Paulo × provedor × modelo × agente × usuário × finalidade × moeda) e
--     ai_usage_top_conversations(de, até, limite, filtros): o ranking de conversas por custo, por moeda.
--   * As visões mensais (ai_usage_monthly_by_user/_agent/_purpose) passam a somar audio_seconds e characters.
--   * Notificação e evento de mensagens ai_budget_alert (sem parâmetros).
--   * app_setting_valid aceita ai.runs_per_minute e ai.flow_runs_per_minute (inteiros de 1 a 1000).

-- Orçamentos ---------------------------------------------------------------------------------------------------------
CREATE TABLE ai_budgets (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  scope                text NOT NULL,
  user_id              uuid REFERENCES users (id) ON DELETE CASCADE,
  agent_id             uuid REFERENCES ai_agents (id) ON DELETE CASCADE,
  currency             text NOT NULL DEFAULT 'USD',
  monthly_limit_micros bigint NOT NULL,
  alert_percent        integer NOT NULL DEFAULT 80,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_budgets_scope_check CHECK (scope IN ('user', 'agent', 'flows', 'global')),
  CONSTRAINT ai_budgets_target_check CHECK (
    CASE scope
      WHEN 'user' THEN user_id IS NOT NULL AND agent_id IS NULL
      WHEN 'agent' THEN agent_id IS NOT NULL AND user_id IS NULL
      ELSE user_id IS NULL AND agent_id IS NULL
    END),
  CONSTRAINT ai_budgets_currency_check CHECK (currency IN ('USD', 'BRL')),
  CONSTRAINT ai_budgets_monthly_limit_micros_check CHECK (monthly_limit_micros > 0),
  CONSTRAINT ai_budgets_alert_percent_check CHECK (alert_percent BETWEEN 1 AND 99)
);

CREATE UNIQUE INDEX ai_budgets_active_key ON ai_budgets (scope, user_id, agent_id, currency) NULLS NOT DISTINCT
  WHERE is_active;
CREATE INDEX ai_budgets_user_id_idx ON ai_budgets (user_id);
CREATE INDEX ai_budgets_agent_id_idx ON ai_budgets (agent_id);

CREATE TRIGGER ai_budgets_set_updated_at BEFORE UPDATE ON ai_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ai_budgets_audit AFTER INSERT OR UPDATE OR DELETE ON ai_budgets
  FOR EACH ROW EXECUTE FUNCTION audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_budgets TO moneyflow_app;

COMMENT ON TABLE ai_budgets IS
  'Orçamento mensal de IA (spec 028). Gasto = soma de ai_usage.cost_micros no mês de America/Sao_Paulo, na moeda do '
  'orçamento (uso sem preço e uso noutra moeda não contam), no escopo: user (o uso do usuário, inclusive o dos fluxos '
  'que ele acionou), agent (o uso do agente), flows (o uso de conversas com purpose <> chat, ai_usage_is_flow) ou '
  'global (todo o uso). No máximo um ativo por (escopo, alvo, moeda): ai_budgets_active_key, 23505. Situação por '
  'ai_budget_status(mês); estourados que valem para uma execução por ai_budget_check(usuário, agente, é_fluxo). '
  'Auditada.';
COMMENT ON COLUMN ai_budgets.scope IS
  'user (user_id obrigatório), agent (agent_id obrigatório), flows ou global (sem alvo): ai_budgets_target_check.';
COMMENT ON COLUMN ai_budgets.user_id IS 'Usuário coberto (só no escopo user). Some com o usuário (CASCADE).';
COMMENT ON COLUMN ai_budgets.agent_id IS 'Agente coberto (só no escopo agent). Some com o agente (CASCADE).';
COMMENT ON COLUMN ai_budgets.currency IS 'USD ou BRL, a moeda dos preços (ai_model_prices.currency). Só o uso nessa moeda conta.';
COMMENT ON COLUMN ai_budgets.monthly_limit_micros IS
  'Valor do mês em milionésimos da moeda (> 0; ex.: 50000000 = US$ 50). Gasto >= valor = blocked.';
COMMENT ON COLUMN ai_budgets.alert_percent IS 'Percentual de aviso, 1 a 99 (padrão 80). Gasto >= valor × percentual ÷ 100 = alert.';
COMMENT ON COLUMN ai_budgets.is_active IS 'Desligado, o orçamento não aparece em ai_budget_status nem bloqueia; sai da unicidade.';

-- O que é fluxo ------------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_usage_is_flow(p_usage_purpose text, p_conversation_purpose text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p_conversation_purpose <> 'chat',
                  p_usage_purpose <> ALL (ARRAY['chat', 'title', 'embedding', 'vision_describe', 'transcription',
                                                'speech']))
$$;

COMMENT ON FUNCTION ai_usage_is_flow(text, text) IS
  'true se o uso é de um fluxo automático (spec 028): a conversa dele tem purpose <> chat; sem conversa (nula ou '
  'excluída), a finalidade do uso não é um tipo de chamada (chat, title, embedding, vision_describe, transcription, '
  'speech), ou seja, é a finalidade de um fluxo. Finalidades de fluxo novas entram sozinhas; um tipo de chamada novo '
  'precisa entrar na lista.';

-- Gasto e situação ---------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_budget_usage(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text,
                                p_from timestamptz, p_to timestamptz)
RETURNS TABLE (spent_micros bigint, unpriced_calls integer)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- Uma consulta por escopo, para cada uma usar o seu índice (created_at; user_id, created_at; agent_id, created_at).
  CASE p_scope
    WHEN 'global' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
       WHERE u.created_at >= p_from AND u.created_at < p_to;
    WHEN 'user' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
       WHERE u.user_id = p_user_id AND u.created_at >= p_from AND u.created_at < p_to;
    WHEN 'agent' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
       WHERE u.agent_id = p_agent_id AND u.created_at >= p_from AND u.created_at < p_to;
    WHEN 'flows' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
        LEFT JOIN ai_conversations c ON c.id = u.conversation_id
       WHERE u.created_at >= p_from AND u.created_at < p_to
         AND ai_usage_is_flow(u.purpose, c.purpose);
    ELSE
      RAISE EXCEPTION 'ai_budget_usage: unknown scope %', p_scope USING ERRCODE = 'invalid_parameter_value';
  END CASE;
END
$$;

COMMENT ON FUNCTION ai_budget_usage(text, uuid, uuid, text, timestamptz, timestamptz) IS
  'Apoio de ai_budget_status/ai_budget_check: gasto (soma de cost_micros na moeda informada) e chamadas sem preço '
  '(qualquer moeda) do escopo no intervalo [de, até). 22023 com escopo desconhecido.';

CREATE FUNCTION ai_budget_state(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text,
                                p_limit_micros bigint, p_alert_percent integer, p_month date)
RETURNS TABLE (month date, spent_micros bigint, unpriced_calls integer, percent numeric, status text)
LANGUAGE sql STABLE AS $$
  SELECT m.month, s.spent_micros, s.unpriced_calls,
         round(s.spent_micros::numeric * 100 / p_limit_micros, 2),
         CASE WHEN s.spent_micros >= p_limit_micros THEN 'blocked'
              WHEN s.spent_micros::numeric * 100 >= p_limit_micros::numeric * p_alert_percent THEN 'alert'
              ELSE 'ok'
         END
    FROM (SELECT coalesce(date_trunc('month', p_month::timestamp),
                          date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'))::date
                   AS month) m
   CROSS JOIN LATERAL ai_budget_usage(p_scope, p_user_id, p_agent_id, p_currency,
                                      m.month::timestamp AT TIME ZONE 'America/Sao_Paulo',
                                      (m.month + interval '1 month') AT TIME ZONE 'America/Sao_Paulo') s
$$;

COMMENT ON FUNCTION ai_budget_state(text, uuid, uuid, text, bigint, integer, date) IS
  'Apoio de ai_budget_status/ai_budget_check: mês (1º dia; nulo = o mês corrente em America/Sao_Paulo), gasto, sem '
  'preço, percentual (2 casas) e situação: blocked com gasto >= valor, alert com gasto >= valor × aviso ÷ 100, senão ok.';

CREATE FUNCTION ai_budget_status(p_month date DEFAULT NULL)
RETURNS TABLE (budget_id uuid, scope text, user_id uuid, agent_id uuid, currency text, monthly_limit_micros bigint,
               alert_percent integer, month date, spent_micros bigint, unpriced_calls integer, percent numeric,
               status text)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros, b.alert_percent,
         st.month, st.spent_micros, st.unpriced_calls, st.percent, st.status
    FROM ai_budgets b
   CROSS JOIN LATERAL ai_budget_state(b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros,
                                      b.alert_percent, p_month) st
   WHERE b.is_active
   ORDER BY array_position(ARRAY['global', 'flows', 'agent', 'user'], b.scope), b.currency, b.id
$$;

COMMENT ON FUNCTION ai_budget_status(date) IS
  'Situação de cada orçamento ativo no mês de p_month (qualquer dia do mês; nulo = o mês corrente em '
  'America/Sao_Paulo): gasto em micros na moeda do orçamento (uso sem preço e noutra moeda não contam), chamadas sem '
  'preço do escopo (unpriced_calls, para "N chamadas sem preço"), percentual e status ok|alert|blocked. Ordem: '
  'global, flows, agent, user.';

CREATE FUNCTION ai_budget_check(p_user_id uuid, p_agent_id uuid, p_is_flow boolean)
RETURNS TABLE (budget_id uuid, scope text, user_id uuid, agent_id uuid, currency text, monthly_limit_micros bigint,
               alert_percent integer, month date, spent_micros bigint, unpriced_calls integer, percent numeric,
               status text)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros, b.alert_percent,
         st.month, st.spent_micros, st.unpriced_calls, st.percent, st.status
    FROM ai_budgets b
   CROSS JOIN LATERAL ai_budget_state(b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros,
                                      b.alert_percent, NULL) st
   WHERE b.is_active
     AND (b.scope = 'global'
          OR (b.scope = 'flows' AND coalesce(p_is_flow, false))
          OR (b.scope = 'user' AND b.user_id = p_user_id)
          OR (b.scope = 'agent' AND b.agent_id = p_agent_id))
     AND st.status = 'blocked'
   ORDER BY array_position(ARRAY['global', 'flows', 'agent', 'user'], b.scope), b.currency, b.id
$$;

COMMENT ON FUNCTION ai_budget_check(uuid, uuid, boolean) IS
  'Orçamentos ativos estourados (gasto >= valor no mês corrente de America/Sao_Paulo) que valem para uma execução: '
  'global, o do usuário (p_user_id; o uso dos fluxos dele conta), o do agente (p_agent_id) e, com p_is_flow '
  '(conversa com purpose <> chat), o flows. Nenhuma linha = pode seguir. A isenção do admin que aciona é da aplicação.';

-- Visões de uso ------------------------------------------------------------------------------------------------------
-- O dia em São Paulo, para o filtro de período do painel (a visão diária e as consultas do painel).
CREATE INDEX ai_usage_sp_day_idx ON ai_usage (((created_at AT TIME ZONE 'America/Sao_Paulo')::date));

CREATE VIEW ai_usage_daily WITH (security_invoker = true) AS
SELECT (u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
       u.provider_id,
       u.model,
       u.agent_id,
       u.user_id,
       u.purpose,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       count(DISTINCT u.conversation_id)::integer AS conversations,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.audio_seconds) AS audio_seconds,
       sum(u.characters)::bigint AS characters,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 GROUP BY 1, u.provider_id, u.model, u.agent_id, u.user_id, u.purpose, u.currency;

GRANT SELECT ON ai_usage_daily TO moneyflow_app;

COMMENT ON VIEW ai_usage_daily IS
  'Uso por dia (America/Sao_Paulo), provedor, modelo, agente, usuário, finalidade e moeda (spec 028, painel de uso). '
  'currency nula = chamadas sem preço (cost_micros nulo). Taxa de acerto do cache = cache_read_tokens ÷ (input_tokens + '
  'cache_write_tokens + cache_read_tokens). Filtre por day (índice ai_usage_sp_day_idx).';

CREATE FUNCTION ai_usage_top_conversations(p_from date, p_to date, p_limit integer DEFAULT 20,
                                           p_provider_id uuid DEFAULT NULL, p_agent_id uuid DEFAULT NULL,
                                           p_user_id uuid DEFAULT NULL, p_purpose text DEFAULT NULL)
RETURNS TABLE (rank integer, conversation_id uuid, title text, conversation_purpose text, owner_user_id uuid,
               conversation_agent_id uuid, archived_at timestamptz, currency text, cost_micros bigint, calls integer,
               runs integer, input_tokens bigint, output_tokens bigint, cache_write_tokens bigint,
               cache_read_tokens bigint, audio_seconds numeric, characters bigint, unpriced_calls integer,
               last_used_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION 'ai_usage_top_conversations: invalid period % .. % (up to 3660 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'ai_usage_top_conversations: limit must be between 1 and 100'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT x.conversation_id, x.currency, x.cost_micros, x.run_id, x.input_tokens, x.output_tokens,
           x.cache_write_tokens, x.cache_read_tokens, x.audio_seconds, x.characters, x.created_at
      FROM ai_usage x
     WHERE x.conversation_id IS NOT NULL
       AND x.created_at >= p_from::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND x.created_at < (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND (p_provider_id IS NULL OR x.provider_id = p_provider_id)
       AND (p_agent_id IS NULL OR x.agent_id = p_agent_id)
       AND (p_user_id IS NULL OR x.user_id = p_user_id)
       AND (p_purpose IS NULL OR x.purpose = p_purpose)
  ), unpriced AS (
    SELECT u.conversation_id, count(*)::integer AS n FROM u WHERE u.cost_micros IS NULL GROUP BY u.conversation_id
  ), agg AS (
    SELECT u.conversation_id, u.currency,
           sum(u.cost_micros)::bigint AS cost_micros,
           count(*)::integer AS calls,
           count(DISTINCT u.run_id)::integer AS runs,
           sum(u.input_tokens)::bigint AS input_tokens,
           sum(u.output_tokens)::bigint AS output_tokens,
           sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
           sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
           sum(u.audio_seconds) AS audio_seconds,
           sum(u.characters)::bigint AS characters,
           max(u.created_at) AS last_used_at
      FROM u
     WHERE u.currency IS NOT NULL
     GROUP BY u.conversation_id, u.currency
  ), ranked AS (
    SELECT agg.*, row_number() OVER (PARTITION BY agg.currency
                                     ORDER BY agg.cost_micros DESC, agg.last_used_at DESC, agg.conversation_id) AS rn
      FROM agg
  )
  SELECT r.rn::integer, r.conversation_id, c.title, c.purpose, c.user_id, c.agent_id, c.archived_at, r.currency,
         r.cost_micros, r.calls, r.runs, r.input_tokens, r.output_tokens, r.cache_write_tokens, r.cache_read_tokens,
         r.audio_seconds, r.characters, coalesce(p.n, 0), r.last_used_at
    FROM ranked r
    JOIN ai_conversations c ON c.id = r.conversation_id
    LEFT JOIN unpriced p ON p.conversation_id = r.conversation_id
   WHERE r.rn <= p_limit
   ORDER BY r.currency, r.rn;
END
$$;

COMMENT ON FUNCTION ai_usage_top_conversations(date, date, integer, uuid, uuid, uuid, text) IS
  'Ranking das conversas (sessões e fluxos) por custo no período [p_from, p_to] (datas em America/Sao_Paulo, até 3660 '
  'dias) com os filtros opcionais do painel (provedor, agente, usuário, finalidade do uso): as p_limit (1–100, padrão '
  '20) mais caras de cada moeda, rank 1, 2, 3… por moeda; desempate pelo uso mais recente. Só o uso com preço entra no '
  'custo e nos totais da linha; unpriced_calls = chamadas sem preço da conversa no período. Uso sem conversa (embeddings '
  'ou conversa excluída) fica de fora. 22023 com período ou limite inválidos. O admin vê todas; a aplicação restringe.';

-- Visões mensais com áudio e caracteres (colunas acrescentadas no fim) ----------------------------------------------
CREATE OR REPLACE VIEW ai_usage_monthly_by_user WITH (security_invoker = true) AS
SELECT (date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS month,
       u.user_id,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced,
       sum(u.audio_seconds) AS audio_seconds,
       sum(u.characters)::bigint AS characters
  FROM ai_usage u
 GROUP BY 1, u.user_id, u.currency;

CREATE OR REPLACE VIEW ai_usage_monthly_by_agent WITH (security_invoker = true) AS
SELECT (date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS month,
       u.agent_id,
       u.provider_id,
       u.model,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       count(DISTINCT u.user_id)::integer AS users,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced,
       sum(u.audio_seconds) AS audio_seconds,
       sum(u.characters)::bigint AS characters
  FROM ai_usage u
 GROUP BY 1, u.agent_id, u.provider_id, u.model, u.currency;

CREATE OR REPLACE VIEW ai_usage_monthly_by_purpose WITH (security_invoker = true) AS
SELECT (date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS month,
       u.purpose,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       count(DISTINCT u.user_id)::integer AS users,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced,
       sum(u.audio_seconds) AS audio_seconds,
       sum(u.characters)::bigint AS characters
  FROM ai_usage u
 GROUP BY 1, u.purpose, u.currency;

COMMENT ON VIEW ai_usage_monthly_by_user IS
  'Uso por mês (America/Sao_Paulo), usuário e moeda, com segundos de áudio e caracteres de fala. user_id nulo = sistema '
  '(embeddings) ou usuário excluído.';
COMMENT ON VIEW ai_usage_monthly_by_agent IS
  'Uso por mês (America/Sao_Paulo), agente, provedor, modelo e moeda, com segundos de áudio e caracteres de fala. '
  'agent_id nulo = embeddings (sem agente).';
COMMENT ON VIEW ai_usage_monthly_by_purpose IS
  'Uso por mês (America/Sao_Paulo), finalidade (ai_usage.purpose) e moeda, com segundos de áudio e caracteres de fala; '
  'currency nula = chamadas sem preço.';

-- Notificação e evento ai_budget_alert ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
  max_days int := 60;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN false;
  END IF;

  CASE p_event_kind
    WHEN 'due_reminder' THEN allowed := '{days_before,send_at}'; required := '{days_before,send_at}';
    WHEN 'overdue' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'daily_summary' THEN allowed := '{send_at}'; required := '{send_at}';
    WHEN 'weekly_summary' THEN allowed := '{send_at,weekday}'; required := '{send_at,weekday}';
    WHEN 'card_limit' THEN allowed := '{thresholds_percent}'; required := '{thresholds_percent}';
    WHEN 'reconciliation_divergence' THEN allowed := '{min_difference_cents}'; required := '{}';
    WHEN 'invoice_closed', 'agent_completed', 'agent_message', 'ai_budget_alert' THEN allowed := '{}'; required := '{}';
    WHEN 'contract_notice_deadline', 'contract_ending' THEN
      allowed := '{days_before,send_at}'; required := '{days_before,send_at}'; max_days := 180;
    WHEN 'contract_renewal_pending' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'contract_readjustment' THEN allowed := '{send_at}'; required := '{send_at}';
    ELSE RETURN false;
  END CASE;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k <> ALL (allowed))
     OR NOT (p_params ?& required) THEN
    RETURN false;
  END IF;

  IF p_params ? 'send_at' AND (jsonb_typeof(p_params -> 'send_at') <> 'string' OR p_params ->> 'send_at' !~ hhmm) THEN
    RETURN false;
  END IF;
  IF p_params ? 'weekday' AND (jsonb_typeof(p_params -> 'weekday') <> 'number'
                               OR (p_params ->> 'weekday') !~ '^[1-7]$') THEN
    RETURN false;
  END IF;
  IF p_params ? 'repeat_every_days' AND (jsonb_typeof(p_params -> 'repeat_every_days') <> 'number'
                                         OR (p_params ->> 'repeat_every_days') !~ '^[0-9]{1,2}$'
                                         OR (p_params ->> 'repeat_every_days')::int NOT BETWEEN 1 AND 30) THEN
    RETURN false;
  END IF;
  IF p_params ? 'min_difference_cents' AND (jsonb_typeof(p_params -> 'min_difference_cents') <> 'number'
                                            OR (p_params ->> 'min_difference_cents') !~ '^[0-9]{1,15}$') THEN
    RETURN false;
  END IF;

  -- Listas de inteiros: 1–10 valores distintos dentro da faixa.
  FOREACH arr IN ARRAY ARRAY[p_params -> 'days_before', p_params -> 'thresholds_percent'] LOOP
    CONTINUE WHEN arr IS NULL;
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(arr) e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[0-9]{1,3}$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(arr) e) <> jsonb_array_length(arr) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_params ? 'days_before'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > max_days) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent '
  '1–200; repeat_every_days 1–30; invoice_closed, agent_completed, agent_message e ai_budget_alert sem parâmetros). '
  'Usada no CHECK de message_subscriptions.';

ALTER TABLE message_subscriptions
  DROP CONSTRAINT message_subscriptions_event_kind_check,
  ADD CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert'));

ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'test'));

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert'));

COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos '
  '(spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), '
  'contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base); '
  'ai_budget_alert (spec 028: orçamento de IA cruzou o aviso ou chegou a 100%; sem parâmetros).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending, contract_readjustment ou ai_budget_alert (spec 028; dedup por orçamento, mês e limiar).';

-- Configurações: limites por minuto -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_setting_valid(p_key text, p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_key = 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           WHEN p_key IN ('ai.runs_per_minute', 'ai.flow_runs_per_minute') THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,4}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 1000
                  ELSE false
             END
           ELSE false
         END
$$;

COMMENT ON FUNCTION app_setting_valid(text, jsonb) IS
  'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: '
  'ai.request_retention_days (número inteiro de 1 a 365) e, na F14 (spec 028), ai.runs_per_minute e '
  'ai.flow_runs_per_minute (número inteiro de 1 a 1000), sempre sem aspas nem casas decimais. A fase 029 acrescenta '
  'chaves.';

-- migrate:down

DELETE FROM app_settings WHERE key IN ('ai.runs_per_minute', 'ai.flow_runs_per_minute');

CREATE OR REPLACE FUNCTION app_setting_valid(p_key text, p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key
           WHEN 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           ELSE false
         END
$$;

COMMENT ON FUNCTION app_setting_valid(text, jsonb) IS
  'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: '
  'ai.request_retention_days (número inteiro de 1 a 365, sem aspas nem casas decimais). As fases 028 e 029 acrescentam '
  'chaves.';

DELETE FROM notifications WHERE kind = 'ai_budget_alert';
DELETE FROM message_outbox WHERE event_kind = 'ai_budget_alert';
DELETE FROM message_subscriptions WHERE event_kind = 'ai_budget_alert';

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment'));
ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment', 'test'));
ALTER TABLE message_subscriptions
  DROP CONSTRAINT message_subscriptions_event_kind_check,
  ADD CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment'));

COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos '
  '(spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), '
  'contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending ou contract_readjustment.';

CREATE OR REPLACE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
  max_days int := 60;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN false;
  END IF;

  CASE p_event_kind
    WHEN 'due_reminder' THEN allowed := '{days_before,send_at}'; required := '{days_before,send_at}';
    WHEN 'overdue' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'daily_summary' THEN allowed := '{send_at}'; required := '{send_at}';
    WHEN 'weekly_summary' THEN allowed := '{send_at,weekday}'; required := '{send_at,weekday}';
    WHEN 'card_limit' THEN allowed := '{thresholds_percent}'; required := '{thresholds_percent}';
    WHEN 'reconciliation_divergence' THEN allowed := '{min_difference_cents}'; required := '{}';
    WHEN 'invoice_closed', 'agent_completed', 'agent_message' THEN allowed := '{}'; required := '{}';
    WHEN 'contract_notice_deadline', 'contract_ending' THEN
      allowed := '{days_before,send_at}'; required := '{days_before,send_at}'; max_days := 180;
    WHEN 'contract_renewal_pending' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'contract_readjustment' THEN allowed := '{send_at}'; required := '{send_at}';
    ELSE RETURN false;
  END CASE;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k <> ALL (allowed))
     OR NOT (p_params ?& required) THEN
    RETURN false;
  END IF;

  IF p_params ? 'send_at' AND (jsonb_typeof(p_params -> 'send_at') <> 'string' OR p_params ->> 'send_at' !~ hhmm) THEN
    RETURN false;
  END IF;
  IF p_params ? 'weekday' AND (jsonb_typeof(p_params -> 'weekday') <> 'number'
                               OR (p_params ->> 'weekday') !~ '^[1-7]$') THEN
    RETURN false;
  END IF;
  IF p_params ? 'repeat_every_days' AND (jsonb_typeof(p_params -> 'repeat_every_days') <> 'number'
                                         OR (p_params ->> 'repeat_every_days') !~ '^[0-9]{1,2}$'
                                         OR (p_params ->> 'repeat_every_days')::int NOT BETWEEN 1 AND 30) THEN
    RETURN false;
  END IF;
  IF p_params ? 'min_difference_cents' AND (jsonb_typeof(p_params -> 'min_difference_cents') <> 'number'
                                            OR (p_params ->> 'min_difference_cents') !~ '^[0-9]{1,15}$') THEN
    RETURN false;
  END IF;

  -- Listas de inteiros: 1–10 valores distintos dentro da faixa.
  FOREACH arr IN ARRAY ARRAY[p_params -> 'days_before', p_params -> 'thresholds_percent'] LOOP
    CONTINUE WHEN arr IS NULL;
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(arr) e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[0-9]{1,3}$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(arr) e) <> jsonb_array_length(arr) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_params ? 'days_before'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > max_days) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent '
  '1–200; repeat_every_days 1–30). Usada no CHECK de message_subscriptions.';

-- As visões mensais voltam sem audio_seconds e characters (CREATE OR REPLACE não remove colunas).
DROP VIEW ai_usage_monthly_by_user;
DROP VIEW ai_usage_monthly_by_agent;
DROP VIEW ai_usage_monthly_by_purpose;

CREATE VIEW ai_usage_monthly_by_user WITH (security_invoker = true) AS
SELECT (date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS month,
       u.user_id,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 GROUP BY 1, u.user_id, u.currency;

CREATE VIEW ai_usage_monthly_by_agent WITH (security_invoker = true) AS
SELECT (date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS month,
       u.agent_id,
       u.provider_id,
       u.model,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       count(DISTINCT u.user_id)::integer AS users,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 GROUP BY 1, u.agent_id, u.provider_id, u.model, u.currency;

CREATE VIEW ai_usage_monthly_by_purpose WITH (security_invoker = true) AS
SELECT (date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS month,
       u.purpose,
       u.currency,
       count(*)::integer AS calls,
       count(DISTINCT u.run_id)::integer AS runs,
       count(DISTINCT u.user_id)::integer AS users,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 GROUP BY 1, u.purpose, u.currency;

GRANT SELECT ON ai_usage_monthly_by_user, ai_usage_monthly_by_agent, ai_usage_monthly_by_purpose TO moneyflow_app;

COMMENT ON VIEW ai_usage_monthly_by_user IS
  'Uso por mês (America/Sao_Paulo), usuário e moeda. user_id nulo = sistema (embeddings) ou usuário excluído.';
COMMENT ON VIEW ai_usage_monthly_by_agent IS
  'Uso por mês (America/Sao_Paulo), agente, provedor, modelo e moeda. agent_id nulo = embeddings (sem agente).';
COMMENT ON VIEW ai_usage_monthly_by_purpose IS
  'Uso por mês (America/Sao_Paulo), finalidade (ai_usage.purpose) e moeda; currency nula = chamadas sem preço.';

DROP FUNCTION ai_usage_top_conversations(date, date, integer, uuid, uuid, uuid, text);
DROP VIEW ai_usage_daily;
DROP INDEX ai_usage_sp_day_idx;
DROP FUNCTION ai_budget_check(uuid, uuid, boolean);
DROP FUNCTION ai_budget_status(date);
DROP FUNCTION ai_budget_state(text, uuid, uuid, text, bigint, integer, date);
DROP FUNCTION ai_budget_usage(text, uuid, uuid, text, timestamptz, timestamptz);
DROP FUNCTION ai_usage_is_flow(text, text);
DROP TABLE ai_budgets;
