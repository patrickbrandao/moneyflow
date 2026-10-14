-- Testes de 0044_ai_budgets_and_usage_panel (spec 028, F14): orçamentos (escopos, alvo, unicidade com alvo nulo,
-- auditoria), o que é fluxo, situação ok|alert|blocked no mês de São Paulo (uso sem preço e noutra moeda não contam),
-- checagem que combina os escopos, visão diária e mensais com áudio e caracteres, ranking de conversas por custo,
-- notificação e evento ai_budget_alert e as chaves de limite por minuto em app_setting_valid.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;

-- Estrutura ----------------------------------------------------------------------------------------------------------
SELECT has_table('ai_budgets');
SELECT columns_are('ai_budgets', ARRAY['id', 'scope', 'user_id', 'agent_id', 'currency', 'monthly_limit_micros',
  'alert_percent', 'is_active', 'created_at', 'updated_at']);
SELECT col_is_pk('ai_budgets', 'id');
SELECT col_not_null('ai_budgets', c) FROM unnest(ARRAY['scope', 'currency', 'monthly_limit_micros', 'alert_percent',
  'is_active']) c;
SELECT col_default_is('ai_budgets', 'currency', 'USD');
SELECT col_default_is('ai_budgets', 'alert_percent', '80');
SELECT col_default_is('ai_budgets', 'is_active', 'true');
SELECT results_eq($$SELECT conname::text COLLATE "default", confdeltype::text FROM pg_constraint
                     WHERE contype = 'f' AND conrelid = 'ai_budgets'::regclass ORDER BY 1$$,
                  $$VALUES ('ai_budgets_agent_id_fkey', 'c'), ('ai_budgets_user_id_fkey', 'c')$$,
                  'o orçamento some com o usuário ou o agente (CASCADE)');
SELECT has_index('ai_budgets', i) FROM unnest(ARRAY['ai_budgets_active_key', 'ai_budgets_user_id_idx',
  'ai_budgets_agent_id_idx']) i;
SELECT is((SELECT pg_get_indexdef('ai_budgets_active_key'::regclass)
                  ~ 'UNIQUE INDEX .*\(scope, user_id, agent_id, currency\) NULLS NOT DISTINCT WHERE is_active'),
          true, 'um ativo por (escopo, alvo, moeda), alvo nulo igual a nulo');
SELECT has_trigger('ai_budgets', t) FROM unnest(ARRAY['ai_budgets_audit', 'ai_budgets_set_updated_at']) t;
SELECT has_index('ai_usage', 'ai_usage_sp_day_idx');
SELECT has_view('ai_usage_daily');
SELECT ok((SELECT 'security_invoker=true' = ANY (reloptions) FROM pg_class WHERE relname = 'ai_usage_daily'),
          'ai_usage_daily é security_invoker');
SELECT has_column(v, c) FROM unnest(ARRAY['ai_usage_monthly_by_user', 'ai_usage_monthly_by_agent',
  'ai_usage_monthly_by_purpose', 'ai_usage_daily']) v, unnest(ARRAY['audio_seconds', 'characters']) c;
SELECT has_function(f) FROM unnest(ARRAY['ai_usage_is_flow', 'ai_budget_usage', 'ai_budget_state', 'ai_budget_status',
  'ai_budget_check', 'ai_usage_top_conversations']) f;

-- Privilégios
SELECT ok(has_table_privilege('moneyflow_app', 'ai_budgets', p), 'app: ' || p || ' em ai_budgets')
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
SELECT ok(has_table_privilege('moneyflow_app', 'ai_usage_daily', 'SELECT'), 'app lê ai_usage_daily');
SELECT ok(has_table_privilege('moneyflow_app', v, 'SELECT'), 'app continua lendo ' || v)
  FROM unnest(ARRAY['ai_usage_monthly_by_user', 'ai_usage_monthly_by_agent', 'ai_usage_monthly_by_purpose']) v;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_budget_status(date)', 'ai_budget_check(uuid, uuid, boolean)', 'ai_usage_is_flow(text, text)',
                    'ai_usage_top_conversations(date, date, integer, uuid, uuid, uuid, text)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'public não executa ' || f)
  FROM unnest(ARRAY['ai_budget_status(date)', 'ai_budget_check(uuid, uuid, boolean)',
                    'ai_usage_top_conversations(date, date, integer, uuid, uuid, uuid, text)']) f;

-- O que é fluxo ------------------------------------------------------------------------------------------------------
SELECT is(ai_usage_is_flow(u, c), e, format('is_flow(%s, %s) = %s', u, c, e))
  FROM (VALUES ('chat', 'chat', false), ('title', 'chat', false), ('document_reading', 'document_reading', true),
               ('vision_describe', 'classify_lines', true), ('transcription', 'contract_reading', true),
               ('embedding', NULL, false), ('title', NULL, false), ('speech', NULL, false),
               ('transcription', NULL, false), ('vision_describe', NULL, false), ('chat', NULL, false),
               ('classify_lines', NULL, true), ('contract_markdown', NULL, true),
               ('scheduled_task', NULL, true), ('scheduled_task', 'scheduled_task', true)) AS v (u, c, e);

-- Dados base ---------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'admin44', 'admin44@example.com', 'segredo', 'admin'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia44', 'bia44@example.com', 'segredo', 'user'),
  ('00000000-0000-7000-8000-0000000000a3', 'caio44', 'caio44@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000f1001', 'Dólar', 'anthropic', 'sk-ant-api03-aaaaaaaa'),
  ('00000000-0000-7000-8000-0000000f1002', 'Real', 'openai', 'sk-proj-bbbbbbbb');
-- 1 por milhão de tokens de entrada: custo em micros = tokens de entrada.
INSERT INTO ai_model_prices (provider_id, model, currency, input_price_per_million, output_price_per_million, valid_from)
VALUES ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', 'USD', 1, 0, '2020-01-01'),
       ('00000000-0000-7000-8000-0000000f1002', 'gpt-5', 'BRL', 1, 0, '2020-01-01');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000f2001', 'Chat 44', '00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5'),
  ('00000000-0000-7000-8000-0000000f2002', 'Fluxos 44', '00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5');
INSERT INTO ai_conversations (id, user_id, agent_id, purpose, title) VALUES
  ('00000000-0000-7000-8000-0000000f3001', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2001',
   'chat', 'Conversa da Bia'),
  ('00000000-0000-7000-8000-0000000f3002', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2002',
   'document_reading', 'Leitura de boleto'),
  ('00000000-0000-7000-8000-0000000f3003', '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000f2001',
   'chat', 'Conversa do Caio');

-- Uso do mês corrente (created_at = now()). Totais em USD: global 7000; fluxos 3900 (3000 + 500 + 400);
-- Bia 4900 (1000 + 3000 + 500 + 400); Caio 2000; agente Chat 3000; agente Fluxos 3500.
INSERT INTO ai_usage (provider_id, model, conversation_id, user_id, agent_id, purpose, input_tokens) VALUES
  -- Bia no chat
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000f3001',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2001', 'chat', 1000),
  -- Fluxo da Bia (chat vira document_reading) e a descrição de imagem dentro dele
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000f3002',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2002', 'chat', 3000),
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000f3002',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2002', 'vision_describe', 500),
  -- Caio no chat
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000f3003',
   '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000f2001', 'chat', 2000),
  -- Embedding do sistema (sem usuário, agente nem conversa)
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', NULL, NULL, NULL, 'embedding', 100),
  -- Fluxo sem conversa (classify_lines), acionado pela Bia
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', NULL, '00000000-0000-7000-8000-0000000000a2', NULL,
   'classify_lines', 400),
  -- Noutra moeda: não entra nos orçamentos em USD
  ('00000000-0000-7000-8000-0000000f1002', 'gpt-5', '00000000-0000-7000-8000-0000000f3001',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2001', 'chat', 7000),
  -- Sem preço (modelo sem tabela): não entra no gasto, conta em unpriced_calls
  ('00000000-0000-7000-8000-0000000f1001', 'claude-opus-4-1', '00000000-0000-7000-8000-0000000f3001',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2001', 'chat', 999999);
-- Mês anterior em São Paulo: não entra no mês corrente.
INSERT INTO ai_usage (provider_id, model, conversation_id, user_id, agent_id, purpose, input_tokens, created_at) VALUES
  ('00000000-0000-7000-8000-0000000f1001', 'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000f3001',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2001', 'chat', 9999,
   (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 second') AT TIME ZONE 'America/Sao_Paulo');

SELECT results_eq($$SELECT count(*)::int FROM ai_usage WHERE cost_micros IS NULL$$, $$VALUES (1)$$, 'um uso sem preço');
SELECT results_eq($$SELECT purpose FROM ai_usage WHERE input_tokens = 3000$$, $$VALUES ('document_reading'::text)$$,
                  'o chat na conversa de fluxo vira a finalidade dela');

-- CHECKs e unicidade -------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err(cmd), e, regexp_replace(cmd, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros) VALUES ('team', 1)$$, '23514 ai_budgets_scope_check'),
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros) VALUES ('user', 1)$$, '23514 ai_budgets_target_check'),
    ($$INSERT INTO ai_budgets (scope, user_id, agent_id, monthly_limit_micros) VALUES ('user',
       '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000f2001', 1)$$, '23514 ai_budgets_target_check'),
    ($$INSERT INTO ai_budgets (scope, user_id, monthly_limit_micros) VALUES ('agent',
       '00000000-0000-7000-8000-0000000000a2', 1)$$, '23514 ai_budgets_target_check'),
    ($$INSERT INTO ai_budgets (scope, user_id, monthly_limit_micros) VALUES ('flows',
       '00000000-0000-7000-8000-0000000000a2', 1)$$, '23514 ai_budgets_target_check'),
    ($$INSERT INTO ai_budgets (scope, agent_id, monthly_limit_micros) VALUES ('global',
       '00000000-0000-7000-8000-0000000f2001', 1)$$, '23514 ai_budgets_target_check'),
    ($$INSERT INTO ai_budgets (scope, currency, monthly_limit_micros) VALUES ('global', 'EUR', 1)$$,
     '23514 ai_budgets_currency_check'),
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros) VALUES ('global', 0)$$,
     '23514 ai_budgets_monthly_limit_micros_check'),
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros, alert_percent) VALUES ('global', 1, 0)$$,
     '23514 ai_budgets_alert_percent_check'),
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros, alert_percent) VALUES ('global', 1, 100)$$,
     '23514 ai_budgets_alert_percent_check'),
    ($$INSERT INTO ai_budgets (scope, user_id, monthly_limit_micros) VALUES ('user',
       '00000000-0000-7000-8000-0000000000ff', 1)$$, '23503 ai_budgets_user_id_fkey')
  ) AS v (cmd, e);

-- Orçamentos do teste. O ator vem da sessão, para a auditoria.
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
INSERT INTO ai_budgets (id, scope, user_id, agent_id, currency, monthly_limit_micros, alert_percent, is_active) VALUES
  ('00000000-0000-7000-8000-0000000fb001', 'global', NULL, NULL, 'USD', 10000, 80, true),   -- 7000 = 70%: ok
  ('00000000-0000-7000-8000-0000000fb002', 'global', NULL, NULL, 'BRL', 8000, 80, true),    -- 7000 = 87,5%: alert
  ('00000000-0000-7000-8000-0000000fb003', 'flows', NULL, NULL, 'USD', 4000, 80, true),     -- 3900 = 97,5%: alert
  ('00000000-0000-7000-8000-0000000fb004', 'user', '00000000-0000-7000-8000-0000000000a2', NULL, 'USD', 4900, 80, true),
                                                                                             -- 4900 = 100%: blocked
  ('00000000-0000-7000-8000-0000000fb005', 'user', '00000000-0000-7000-8000-0000000000a3', NULL, 'USD', 10000, 80, true),
                                                                                             -- 2000 = 20%: ok
  ('00000000-0000-7000-8000-0000000fb006', 'agent', NULL, '00000000-0000-7000-8000-0000000f2001', 'USD', 6000, 50, true),
                                                                                             -- 3000 = 50%: alert
  ('00000000-0000-7000-8000-0000000fb007', 'agent', NULL, '00000000-0000-7000-8000-0000000f2002', 'USD', 3500, 50, true),
                                                                                             -- 3500 = 100%: blocked
  ('00000000-0000-7000-8000-0000000fb008', 'user', '00000000-0000-7000-8000-0000000000a2', NULL, 'USD', 1, 80, false);
                                                                                             -- inativo: fora

SELECT is(pg_temp.err(cmd), e, regexp_replace(cmd, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros) VALUES ('global', 5)$$, '23505 ai_budgets_active_key'),
    ($$INSERT INTO ai_budgets (scope, monthly_limit_micros) VALUES ('flows', 5)$$, '23505 ai_budgets_active_key'),
    ($$INSERT INTO ai_budgets (scope, user_id, monthly_limit_micros) VALUES ('user',
       '00000000-0000-7000-8000-0000000000a2', 5)$$, '23505 ai_budgets_active_key'),
    ($$INSERT INTO ai_budgets (scope, agent_id, monthly_limit_micros) VALUES ('agent',
       '00000000-0000-7000-8000-0000000f2002', 5)$$, '23505 ai_budgets_active_key'),
    ($$UPDATE ai_budgets SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000fb008'$$,
     '23505 ai_budgets_active_key')
  ) AS v (cmd, e);
SELECT lives_ok($$INSERT INTO ai_budgets (id, scope, user_id, currency, monthly_limit_micros, is_active) VALUES
                  ('00000000-0000-7000-8000-0000000fb0e1', 'flows', NULL, 'BRL', 5, true),
                  ('00000000-0000-7000-8000-0000000fb0e2', 'global', NULL, 'USD', 5, false),
                  ('00000000-0000-7000-8000-0000000fb0e3', 'global', NULL, 'USD', 6, false),
                  ('00000000-0000-7000-8000-0000000fb0e4', 'user', '00000000-0000-7000-8000-0000000000a2', 'BRL', 5, true)$$,
                'outra moeda e os inativos não colidem');
DELETE FROM ai_budgets WHERE id::text LIKE '00000000-0000-7000-8000-0000000fb0e%';

-- Auditoria
SELECT results_eq($$SELECT action, user_id, new_data ->> 'scope' FROM audit_log
                     WHERE table_name = 'ai_budgets' AND record_id = '00000000-0000-7000-8000-0000000fb004'$$,
                  $$VALUES ('insert'::text, '00000000-0000-7000-8000-0000000000a1'::uuid, 'user'::text)$$,
                  'criar orçamento gera auditoria com o ator');
UPDATE ai_budgets SET monthly_limit_micros = 4900 WHERE id = '00000000-0000-7000-8000-0000000fb004';
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_budgets'
             AND record_id = '00000000-0000-7000-8000-0000000fb004' AND action = 'update'),
          0, 'regravar o mesmo valor não gera linha');
UPDATE ai_budgets SET alert_percent = 90 WHERE id = '00000000-0000-7000-8000-0000000fb005';
SELECT is((SELECT changed_columns FROM audit_log WHERE table_name = 'ai_budgets'
             AND record_id = '00000000-0000-7000-8000-0000000fb005' AND action = 'update'),
          ARRAY['alert_percent'], 'mudar o aviso gera auditoria');
UPDATE ai_budgets SET alert_percent = 80 WHERE id = '00000000-0000-7000-8000-0000000fb005';

-- Situação no mês corrente -------------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT budget_id, scope, currency, spent_micros, unpriced_calls, percent, status,
           month = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date
      FROM ai_budget_status()$$,
  $$VALUES ('00000000-0000-7000-8000-0000000fb002'::uuid, 'global'::text, 'BRL'::text, 7000::bigint, 1, 87.50::numeric,
            'alert'::text, true),
           ('00000000-0000-7000-8000-0000000fb001', 'global', 'USD', 7000, 1, 70.00, 'ok', true),
           ('00000000-0000-7000-8000-0000000fb003', 'flows', 'USD', 3900, 0, 97.50, 'alert', true),
           ('00000000-0000-7000-8000-0000000fb006', 'agent', 'USD', 3000, 1, 50.00, 'alert', true),
           ('00000000-0000-7000-8000-0000000fb007', 'agent', 'USD', 3500, 0, 100.00, 'blocked', true),
           ('00000000-0000-7000-8000-0000000fb004', 'user', 'USD', 4900, 1, 100.00, 'blocked', true),
           ('00000000-0000-7000-8000-0000000fb005', 'user', 'USD', 2000, 0, 20.00, 'ok', true)$$,
  'status: gasto na moeda do orçamento, sem preço à parte, fluxos no flows e no usuário, inativo fora');

SELECT results_eq(
  $$SELECT spent_micros, status FROM ai_budget_status((now() AT TIME ZONE 'America/Sao_Paulo')::date)
     WHERE budget_id = '00000000-0000-7000-8000-0000000fb004'$$,
  $$VALUES (4900::bigint, 'blocked'::text)$$, 'qualquer dia do mês corrente dá o mesmo mês');
SELECT results_eq(
  $$SELECT month, spent_micros, unpriced_calls, status
      FROM ai_budget_status((date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '10 days')::date)
     WHERE budget_id = '00000000-0000-7000-8000-0000000fb004'$$,
  $$VALUES ((date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 month')::date, 9999::bigint, 0,
            'blocked'::text)$$,
  'mês anterior: só o uso dele (até o último segundo do mês em São Paulo)');

-- Checagem antes de executar: os escopos que valem, só os estourados ------------------------------------------------
SELECT results_eq($$SELECT budget_id FROM ai_budget_check('00000000-0000-7000-8000-0000000000a2',
                                                          '00000000-0000-7000-8000-0000000f2001', false)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000fb004'::uuid)$$,
                  'Bia no chat: o orçamento dela (100%) bloqueia');
SELECT is_empty($$SELECT * FROM ai_budget_check('00000000-0000-7000-8000-0000000000a3',
                                                '00000000-0000-7000-8000-0000000f2001', false)$$,
                'Caio no chat: nada estourado (alert não bloqueia)');
SELECT results_eq($$SELECT budget_id, scope, status FROM ai_budget_check('00000000-0000-7000-8000-0000000000a3',
                                                                         '00000000-0000-7000-8000-0000000f2002', true)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000fb007'::uuid, 'agent'::text, 'blocked'::text)$$,
                  'Caio num fluxo com o agente dos fluxos: o do agente bloqueia');
SELECT is_empty($$SELECT * FROM ai_budget_check(NULL, NULL, true)$$, 'fluxo sem usuário nem agente: flows em 97,5%');

-- O flows chega a 100%: vale só para fluxo.
UPDATE ai_budgets SET monthly_limit_micros = 3900 WHERE id = '00000000-0000-7000-8000-0000000fb003';
SELECT is_empty($$SELECT * FROM ai_budget_check('00000000-0000-7000-8000-0000000000a3',
                                                '00000000-0000-7000-8000-0000000f2001', false)$$,
                'o flows estourado não vale para o chat');
SELECT results_eq($$SELECT scope FROM ai_budget_check('00000000-0000-7000-8000-0000000000a3',
                                                      '00000000-0000-7000-8000-0000000f2001', true)$$,
                  $$VALUES ('flows'::text)$$, 'o flows estourado vale para o fluxo');
SELECT results_eq($$SELECT scope FROM ai_budget_check('00000000-0000-7000-8000-0000000000a2',
                                                      '00000000-0000-7000-8000-0000000f2002', true)$$,
                  $$VALUES ('flows'::text), ('agent'), ('user')$$,
                  'combina flows, agente e usuário, nessa ordem');
-- O global em USD estoura: vale para todos.
UPDATE ai_budgets SET monthly_limit_micros = 7000 WHERE id = '00000000-0000-7000-8000-0000000fb001';
SELECT results_eq($$SELECT budget_id FROM ai_budget_check('00000000-0000-7000-8000-0000000000a3',
                                                          '00000000-0000-7000-8000-0000000f2001', false)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000fb001'::uuid)$$, 'o global vale para todos');
SELECT results_eq($$SELECT budget_id FROM ai_budget_check(NULL, NULL, false)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000fb001'::uuid)$$, 'o global vale até sem usuário');
-- Desligado, não bloqueia.
UPDATE ai_budgets SET is_active = false
 WHERE id IN ('00000000-0000-7000-8000-0000000fb001', '00000000-0000-7000-8000-0000000fb004');
SELECT is_empty($$SELECT * FROM ai_budget_check('00000000-0000-7000-8000-0000000000a2',
                                                '00000000-0000-7000-8000-0000000f2001', false)$$,
                'orçamentos desligados não bloqueiam');
SELECT is((SELECT count(*)::int FROM ai_budget_status()), 5, 'nem aparecem na situação');
UPDATE ai_budgets SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000fb004';

-- Visões de uso ------------------------------------------------------------------------------------------------------
INSERT INTO ai_usage (provider_id, model, user_id, purpose, audio_seconds, characters) VALUES
  ('00000000-0000-7000-8000-0000000f1002', 'whisper-1', '00000000-0000-7000-8000-0000000000a2', 'transcription', 12.5, 0),
  ('00000000-0000-7000-8000-0000000f1002', 'whisper-1', '00000000-0000-7000-8000-0000000000a2', 'transcription', 2.25, 0),
  ('00000000-0000-7000-8000-0000000f1002', 'tts-1', '00000000-0000-7000-8000-0000000000a2', 'speech', 0, 300);

SELECT results_eq(
  $$SELECT model, calls, conversations, audio_seconds, characters, cost_micros, has_unpriced FROM ai_usage_daily
     WHERE day = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND purpose IN ('transcription', 'speech')
     ORDER BY model$$,
  $$VALUES ('tts-1'::text, 1, 0, 0::numeric, 300::bigint, NULL::bigint, true),
           ('whisper-1', 2, 0, 14.750, 0, NULL, true)$$,
  'diária: soma segundos de áudio e caracteres');
SELECT results_eq(
  $$SELECT agent_id, purpose, currency, calls, input_tokens, cost_micros FROM ai_usage_daily
     WHERE day = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND user_id = '00000000-0000-7000-8000-0000000000a2'
       AND provider_id = '00000000-0000-7000-8000-0000000f1001' AND currency IS NOT NULL
     ORDER BY input_tokens$$,
  $$VALUES (NULL::uuid, 'classify_lines'::text, 'USD'::text, 1, 400::bigint, 400::bigint),
           ('00000000-0000-7000-8000-0000000f2002', 'vision_describe', 'USD', 1, 500, 500),
           ('00000000-0000-7000-8000-0000000f2001', 'chat', 'USD', 1, 1000, 1000),
           ('00000000-0000-7000-8000-0000000f2002', 'document_reading', 'USD', 1, 3000, 3000)$$,
  'diária: por dia, provedor, agente, usuário, finalidade e moeda');
SELECT is((SELECT sum(calls)::int FROM ai_usage_daily WHERE day = (now() AT TIME ZONE 'America/Sao_Paulo')::date),
          11, 'diária: todas as chamadas do dia');
SELECT results_eq(
  $$SELECT audio_seconds, characters FROM ai_usage_monthly_by_user
     WHERE user_id = '00000000-0000-7000-8000-0000000000a2' AND currency IS NULL
       AND month = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date$$,
  $$VALUES (14.750::numeric, 300::bigint)$$, 'mensal por usuário: áudio e caracteres');
SELECT results_eq(
  $$SELECT model, audio_seconds, characters FROM ai_usage_monthly_by_agent
     WHERE agent_id IS NULL AND currency IS NULL AND model IN ('whisper-1', 'tts-1')
       AND month = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY model$$,
  $$VALUES ('tts-1'::text, 0::numeric, 300::bigint), ('whisper-1', 14.750, 0)$$, 'mensal por agente: áudio e caracteres');
SELECT results_eq(
  $$SELECT purpose, audio_seconds, characters FROM ai_usage_monthly_by_purpose
     WHERE purpose IN ('transcription', 'speech')
       AND month = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY purpose$$,
  $$VALUES ('speech'::text, 0::numeric, 300::bigint), ('transcription', 14.750, 0)$$,
  'mensal por finalidade: áudio e caracteres');

-- Ranking de conversas por custo -------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT rank, conversation_id, title, conversation_purpose, currency, cost_micros, calls, unpriced_calls
      FROM ai_usage_top_conversations((now() AT TIME ZONE 'America/Sao_Paulo')::date,
                                      (now() AT TIME ZONE 'America/Sao_Paulo')::date)$$,
  $$VALUES (1, '00000000-0000-7000-8000-0000000f3001'::uuid, 'Conversa da Bia'::text, 'chat'::text, 'BRL'::text,
            7000::bigint, 1, 1),
           (1, '00000000-0000-7000-8000-0000000f3002', 'Leitura de boleto', 'document_reading', 'USD', 3500, 2, 0),
           (2, '00000000-0000-7000-8000-0000000f3003', 'Conversa do Caio', 'chat', 'USD', 2000, 1, 0),
           (3, '00000000-0000-7000-8000-0000000f3001', 'Conversa da Bia', 'chat', 'USD', 1000, 1, 1)$$,
  'ranking por moeda; sem conversa fica de fora; sem preço só no contador');
SELECT results_eq(
  $$SELECT currency, conversation_id FROM ai_usage_top_conversations(
      (now() AT TIME ZONE 'America/Sao_Paulo')::date - 40, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 1)$$,
  $$VALUES ('BRL'::text, '00000000-0000-7000-8000-0000000f3001'::uuid),
           ('USD', '00000000-0000-7000-8000-0000000f3001')$$,
  'limite por moeda; o período pega o mês anterior (9999 da Bia)');
SELECT results_eq(
  $$SELECT conversation_id, cost_micros FROM ai_usage_top_conversations(
      (now() AT TIME ZONE 'America/Sao_Paulo')::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 20,
      p_user_id => '00000000-0000-7000-8000-0000000000a3')$$,
  $$VALUES ('00000000-0000-7000-8000-0000000f3003'::uuid, 2000::bigint)$$, 'filtro por usuário');
SELECT results_eq(
  $$SELECT conversation_id, cost_micros FROM ai_usage_top_conversations(
      (now() AT TIME ZONE 'America/Sao_Paulo')::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 20,
      p_purpose => 'document_reading')$$,
  $$VALUES ('00000000-0000-7000-8000-0000000f3002'::uuid, 3000::bigint)$$, 'filtro por finalidade do uso');
SELECT results_eq(
  $$SELECT count(*)::int FROM ai_usage_top_conversations(
      (now() AT TIME ZONE 'America/Sao_Paulo')::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 20,
      p_provider_id => '00000000-0000-7000-8000-0000000f1002')$$,
  $$VALUES (1)$$, 'filtro por provedor');
SELECT is_empty($$SELECT * FROM ai_usage_top_conversations('2020-01-01', '2020-01-31')$$, 'período sem uso: vazio');
SELECT is(pg_temp.err(cmd), '22023 ', cmd)
  FROM unnest(ARRAY[
    $$SELECT * FROM ai_usage_top_conversations('2026-02-01', '2026-01-01')$$,
    $$SELECT * FROM ai_usage_top_conversations(NULL, '2026-01-01')$$,
    $$SELECT * FROM ai_usage_top_conversations('2016-01-01', '2026-12-31')$$,
    $$SELECT * FROM ai_usage_top_conversations('2026-01-01', '2026-01-31', 0)$$,
    $$SELECT * FROM ai_usage_top_conversations('2026-01-01', '2026-01-31', 101)$$]) cmd;

-- Notificação e evento ai_budget_alert -------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO notifications (user_id, kind, title, link, data, dedup_key) VALUES
                  ('00000000-0000-7000-8000-0000000000a1', 'ai_budget_alert', 'Orçamento de IA em 80%', '/admin/ai',
                   '{"budget_id": "00000000-0000-7000-8000-0000000fb001", "threshold": 80}',
                   'ai_budget_alert:00000000-0000-7000-8000-0000000fb001:2026-10:80')$$,
                'notificação ai_budget_alert');
SELECT is(message_subscription_params_valid('ai_budget_alert', p::jsonb), e, 'params ' || p)
  FROM (VALUES ('{}', true), ('{"send_at": "08:00"}', false), ('{"thresholds_percent": [80]}', false)) AS v (p, e);
INSERT INTO message_destinations (id, name, owner_user_id, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000fd001', 'Telegram 44', '00000000-0000-7000-8000-0000000000a1',
   '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '987654321');
SELECT lives_ok($$INSERT INTO message_subscriptions (id, destination_id, event_kind, params) VALUES
                  ('00000000-0000-7000-8000-0000000fd101', '00000000-0000-7000-8000-0000000fd001', 'ai_budget_alert', '{}')$$,
                'assinatura do evento ai_budget_alert, sem parâmetros');
SELECT is(pg_temp.err($$INSERT INTO message_subscriptions (destination_id, event_kind, params) VALUES
                        ('00000000-0000-7000-8000-0000000fd001', 'budget', '{}')$$),
          '23514 message_subscriptions_event_kind_check', 'evento desconhecido continua recusado');
SELECT lives_ok($$INSERT INTO message_outbox (destination_id, subscription_id, event_kind, dedup_key, payload) VALUES
                  ('00000000-0000-7000-8000-0000000fd001', '00000000-0000-7000-8000-0000000fd101', 'ai_budget_alert',
                   'ai_budget_alert:fb001:2026-10:100', '{"text": "Orçamento de IA atingido"}')$$,
                'mensagem ai_budget_alert na fila');

-- Limites por minuto em app_settings ---------------------------------------------------------------------------------
SELECT is(app_setting_valid(k, v::jsonb), true, k || ' válido: ' || v)
  FROM unnest(ARRAY['ai.runs_per_minute', 'ai.flow_runs_per_minute']) k, unnest(ARRAY['1', '10', '30', '1000']) v;
SELECT is(app_setting_valid(k, v::jsonb), false, k || ' inválido: ' || v)
  FROM unnest(ARRAY['ai.runs_per_minute', 'ai.flow_runs_per_minute']) k,
       unnest(ARRAY['0', '1001', '-1', '10.5', '10.0', '"10"', 'true', 'null', '[10]', '{"n": 10}', '10000']) v;
SELECT is(app_setting_valid('ai.request_retention_days', '30'), true, 'a retenção continua valendo');
SELECT is(app_setting_valid('ai.request_retention_days', '1000'), false, 'retenção continua até 365');
SELECT is(app_setting_valid('ai.runs_per_minutes', '10'), false, 'chave parecida continua desconhecida');
SELECT lives_ok($$INSERT INTO app_settings (key, value) VALUES ('ai.runs_per_minute', '15'),
                  ('ai.flow_runs_per_minute', '45')$$, 'grava os dois limites');
SELECT is(pg_temp.err($$UPDATE app_settings SET value = '0' WHERE key = 'ai.runs_per_minute'$$),
          '23514 app_settings_value_check', 'limite fora da faixa é recusado');

-- Papel da aplicação -------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO ai_budgets (scope, agent_id, currency, monthly_limit_micros) VALUES
                  ('agent', '00000000-0000-7000-8000-0000000f2001', 'BRL', 1000000)$$, 'app cria orçamento');
SELECT is((SELECT count(*)::int FROM ai_budget_status()), 7, 'app lê a situação');
SELECT is((SELECT count(*)::int FROM ai_budget_check('00000000-0000-7000-8000-0000000000a2',
                                                    '00000000-0000-7000-8000-0000000f2001', false)), 1,
          'app checa antes de executar');
SELECT ok((SELECT count(*) FROM ai_usage_daily) > 0, 'app lê a diária');
SELECT ok((SELECT count(*) FROM ai_usage_top_conversations('2020-01-01', '2030-01-01')) > 0, 'app lê o ranking');
RESET ROLE;

-- CASCADE: o orçamento some com o agente (o uso dele restringe a exclusão; sai antes).
DELETE FROM ai_usage WHERE agent_id = '00000000-0000-7000-8000-0000000f2001';
DELETE FROM ai_conversations WHERE agent_id = '00000000-0000-7000-8000-0000000f2001';
DELETE FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000f2001';
SELECT is((SELECT count(*)::int FROM ai_budgets WHERE agent_id = '00000000-0000-7000-8000-0000000f2001'), 0,
          'excluir o agente leva os orçamentos dele');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_budgets' AND action = 'delete'
             AND old_data ->> 'agent_id' = '00000000-0000-7000-8000-0000000f2001'), 2, 'com auditoria');

SELECT * FROM finish();
ROLLBACK;
