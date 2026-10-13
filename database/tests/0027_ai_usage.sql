-- Testes de 0027_ai_usage: custo estimado pelo preço vigente, totais da execução e agregados.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_table('ai_usage');
SELECT has_view(v) FROM unnest(ARRAY['ai_message_usage', 'ai_usage_monthly_by_user', 'ai_usage_monthly_by_agent']) v;
SELECT fk_ok('ai_usage', 'run_id', 'ai_runs', 'id');
SELECT fk_ok('ai_usage', 'price_id', 'ai_model_prices', 'id');
SELECT ok(NOT has_table_privilege('moneyflow_app', 'ai_usage', 'UPDATE'), 'app não altera o uso');
SELECT ok(has_table_privilege('moneyflow_app', 'ai_usage', 'INSERT'), 'app grava o uso');

-- Dados base
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key, embedding_model) VALUES
  ('00000000-0000-7000-8000-0000000a1001', 'Claude', 'anthropic', 'sk-ant-api03-abcdefgh', NULL),
  ('00000000-0000-7000-8000-0000000a1002', 'OpenAI', 'openai', 'sk-proj-abcdefgh', 'text-embedding-3-small');
INSERT INTO ai_model_prices (id, provider_id, model, input_price_per_million, output_price_per_million,
                             cache_write_price_per_million, cache_read_price_per_million, valid_from) VALUES
  ('00000000-0000-7000-8000-0000000a2001', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', 3, 15, 3.75, 0.30, '2026-01-01'),
  ('00000000-0000-7000-8000-0000000a2002', '00000000-0000-7000-8000-0000000a1002', 'text-embedding-3-small', 0.02, 0, NULL, NULL, '2026-01-01');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000a3001', 'Assistente', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5');
INSERT INTO ai_conversations (id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001'),
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
INSERT INTO ai_messages (id, conversation_id, role, content, run_id) VALUES
  ('00000000-0000-7000-8000-0000000b1001', '00000000-0000-7000-8000-0000000b0001', 'assistant', '[{"type": "text", "text": "ok"}]',
   '00000000-0000-7000-8000-0000000b2001'),
  ('00000000-0000-7000-8000-0000000b1002', '00000000-0000-7000-8000-0000000b0002', 'user', '[{"type": "text", "text": "oi"}]', NULL);

-- Custo: 1000 entrada × 3 + 500 saída × 15 + 2000 cache write × 3,75 + 10000 cache read × 0,30 = 21 000 micros (US$ 0,021)
INSERT INTO ai_usage (id, run_id, message_id, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens) VALUES
  ('00000000-0000-7000-8000-0000000b4001', '00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000b1001',
   1000, 500, 2000, 10000);
SELECT results_eq($$SELECT conversation_id, user_id, agent_id, provider_id, model, price_id, cost_micros, currency FROM ai_usage
                     WHERE id = '00000000-0000-7000-8000-0000000b4001'$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b0001'::uuid, '00000000-0000-7000-8000-0000000000a2'::uuid,
                            '00000000-0000-7000-8000-0000000a3001'::uuid, '00000000-0000-7000-8000-0000000a1001'::uuid,
                            'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000a2001'::uuid, 21000::bigint, 'USD')$$,
                  'completa da execução e calcula o custo pelo preço vigente');
INSERT INTO ai_usage (run_id, purpose, input_tokens, output_tokens) VALUES
  ('00000000-0000-7000-8000-0000000b2001', 'title', 200, 10);
SELECT results_eq($$SELECT input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_micros, cost_currency FROM ai_runs
                     WHERE id = '00000000-0000-7000-8000-0000000b2001'$$,
                  $$VALUES (1200::bigint, 510::bigint, 2000::bigint, 10000::bigint, 21750::bigint, 'USD')$$,
                  'totais da execução somados');

-- Sem preço: custo desconhecido
INSERT INTO ai_usage (id, provider_id, model, input_tokens) VALUES
  ('00000000-0000-7000-8000-0000000b4003', '00000000-0000-7000-8000-0000000a1001', 'claude-opus-4-1', 100);
SELECT results_eq($$SELECT price_id, cost_micros, currency FROM ai_usage WHERE id = '00000000-0000-7000-8000-0000000b4003'$$,
                  $$VALUES (NULL::uuid, NULL::bigint, NULL::text)$$, 'sem preço cadastrado: custo nulo');
-- Embeddings, sem agente nem usuário
INSERT INTO ai_usage (provider_id, model, purpose, input_tokens) VALUES
  ('00000000-0000-7000-8000-0000000a1002', 'text-embedding-3-small', 'embedding', 1000000);
SELECT is((SELECT cost_micros FROM ai_usage WHERE purpose = 'embedding'), 20000::bigint, 'embedding: 1 M tokens × US$ 0,02');

SELECT throws_ok($$INSERT INTO ai_usage (run_id, message_id) VALUES ('00000000-0000-7000-8000-0000000b2001',
                   '00000000-0000-7000-8000-0000000b1002')$$, '23514', NULL, 'mensagem de outra conversa');
SELECT throws_ok($$INSERT INTO ai_usage (provider_id, model, price_id) VALUES ('00000000-0000-7000-8000-0000000a1001', 'outro',
                   '00000000-0000-7000-8000-0000000a2001')$$, '23514', NULL, 'preço de outro modelo');
SELECT throws_ok($$INSERT INTO ai_usage (provider_id, model, input_tokens) VALUES ('00000000-0000-7000-8000-0000000a1001', 'x', -1)$$,
                 '23514', NULL, 'tokens não negativos');
SELECT throws_ok($$INSERT INTO ai_usage (model) VALUES ('x')$$, '23502', NULL, 'sem execução, provedor obrigatório');
SELECT throws_ok($$DELETE FROM ai_model_prices WHERE id = '00000000-0000-7000-8000-0000000a2001'$$, '23503', NULL, 'preço usado não é excluído');

-- Agregados
SELECT results_eq($$SELECT calls, input_tokens, output_tokens, cost_micros, has_unpriced FROM ai_message_usage
                     WHERE message_id = '00000000-0000-7000-8000-0000000b1001'$$,
                  $$VALUES (1, 1000::bigint, 500::bigint, 21000::bigint, false)$$, 'por mensagem');
SELECT results_eq($$SELECT month, currency, calls, runs, cost_micros, has_unpriced FROM ai_usage_monthly_by_user
                     WHERE user_id = '00000000-0000-7000-8000-0000000000a2' ORDER BY currency NULLS LAST$$,
                  $$VALUES (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date, 'USD', 2, 1, 21750::bigint, false)$$,
                  'por usuário e mês');
SELECT results_eq($$SELECT currency, calls, cost_micros, has_unpriced FROM ai_usage_monthly_by_user WHERE user_id IS NULL ORDER BY currency NULLS LAST$$,
                  $$VALUES ('USD', 1, 20000::bigint, false), (NULL, 1, NULL::bigint, true)$$,
                  'sem usuário (sistema), separado por moeda; sem preço marcado');
SELECT results_eq($$SELECT agent_id, model, calls, users FROM ai_usage_monthly_by_agent WHERE currency = 'USD' ORDER BY model$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000a3001'::uuid, 'claude-sonnet-4-5', 2, 1),
                           (NULL::uuid, 'text-embedding-3-small', 1, 0)$$, 'por agente e mês');

-- Finalidade (0033) ------------------------------------------------------------------------------------------------
SELECT has_view('ai_usage_monthly_by_purpose');
SELECT ok(has_table_privilege('moneyflow_app', 'ai_usage_monthly_by_purpose', 'SELECT'), 'app lê o uso por finalidade');
SELECT ok((SELECT 'security_invoker=true' = ANY (reloptions) FROM pg_class WHERE relname = 'ai_usage_monthly_by_purpose'),
          'visão por finalidade é security_invoker');
INSERT INTO ai_conversations (id, user_id, agent_id, purpose, archived_at) VALUES
  ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'document_reading', now());
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b2003', '00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
INSERT INTO ai_usage (id, run_id, input_tokens) VALUES
  ('00000000-0000-7000-8000-0000000b4010', '00000000-0000-7000-8000-0000000b2003', 1000);
SELECT is((SELECT purpose FROM ai_usage WHERE id = '00000000-0000-7000-8000-0000000b4010'), 'document_reading',
          'chat numa conversa de fluxo assume a finalidade da conversa');
INSERT INTO ai_usage (id, run_id, purpose, input_tokens) VALUES
  ('00000000-0000-7000-8000-0000000b4011', '00000000-0000-7000-8000-0000000b2003', 'title', 1000);
SELECT is((SELECT purpose FROM ai_usage WHERE id = '00000000-0000-7000-8000-0000000b4011'), 'title', 'title fica title');
SELECT lives_ok(format($$INSERT INTO ai_usage (provider_id, model, purpose) VALUES ('00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', %L)$$, p),
                'finalidade aceita: ' || p)
  FROM unnest(ARRAY['classify_lines', 'contract_reading', 'contract_markdown']) p;
SELECT lives_ok($$INSERT INTO ai_usage (run_id, purpose) VALUES ('00000000-0000-7000-8000-0000000b2001', 'document_reading')$$,
                'finalidade explícita gravada pela aplicação');
SELECT is((SELECT count(*)::int FROM ai_usage WHERE run_id = '00000000-0000-7000-8000-0000000b2001' AND purpose = 'chat'), 1,
          'chat numa conversa comum continua chat');
SELECT throws_ok($$INSERT INTO ai_usage (provider_id, model, purpose) VALUES ('00000000-0000-7000-8000-0000000a1001', 'x', 'document')$$,
                 '23514', 'new row for relation "ai_usage" violates check constraint "ai_usage_purpose_check"', 'finalidade fora da lista');
SELECT results_eq($$SELECT purpose, calls, runs, users, input_tokens, cost_micros FROM ai_usage_monthly_by_purpose
                     WHERE currency = 'USD' ORDER BY purpose$$,
                  $$VALUES ('chat', 1, 1, 1, 1000::bigint, 21000::bigint),
                           ('classify_lines', 1, 0, 0, 0::bigint, 0::bigint),
                           ('contract_markdown', 1, 0, 0, 0::bigint, 0::bigint),
                           ('contract_reading', 1, 0, 0, 0::bigint, 0::bigint),
                           ('document_reading', 2, 2, 1, 1000::bigint, 3000::bigint),
                           ('embedding', 1, 0, 0, 1000000::bigint, 20000::bigint),
                           ('title', 2, 2, 1, 1200::bigint, 3750::bigint)$$,
                  'uso por mês e finalidade');

-- Excluir a conversa: o uso fica, sem as ligações
DELETE FROM ai_conversations WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT results_eq($$SELECT run_id, message_id, conversation_id, user_id, cost_micros FROM ai_usage WHERE id = '00000000-0000-7000-8000-0000000b4001'$$,
                  $$VALUES (NULL::uuid, NULL::uuid, NULL::uuid, '00000000-0000-7000-8000-0000000000a2'::uuid, 21000::bigint)$$,
                  'uso sobrevive à exclusão da conversa');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_usage'), 0, 'fora da auditoria');

SELECT * FROM finish();
ROLLBACK;
