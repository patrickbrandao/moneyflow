-- Testes de 0024_ai_providers_and_agents: provedores (chave blindada), preços com vigência, agentes e auditoria.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['ai_providers', 'ai_model_prices', 'ai_agents']) t;
SELECT has_function('admin_ai_provider_api_key', ARRAY['uuid', 'uuid']);
SELECT has_function('ai_embedding_credentials', ARRAY[]::text[]);
SELECT has_function('ai_model_price_at', ARRAY['uuid', 'text', 'timestamp with time zone']);
SELECT has_function('ai_agent_params_valid', ARRAY['jsonb']);
SELECT has_function('ai_tool_list_valid', ARRAY['text[]']);
SELECT fk_ok('ai_agents', 'provider_id', 'ai_providers', 'id');
SELECT fk_ok('ai_model_prices', 'provider_id', 'ai_providers', 'id');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' é SECURITY DEFINER')
  FROM unnest(ARRAY['admin_ai_provider_api_key(uuid, uuid)', 'ai_embedding_credentials()']) f;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['admin_ai_provider_api_key(uuid, uuid)', 'ai_embedding_credentials()',
                    'ai_model_price_at(uuid, text, timestamp with time zone)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['admin_ai_provider_api_key(uuid, uuid)', 'ai_embedding_credentials()']) f;

-- Dados base
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user');

-- Provedores --------------------------------------------------------------------------------------------------
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000a1001', 'Claude', 'anthropic', 'sk-ant-api03-SEGREDOabcd1234');
INSERT INTO ai_providers (id, name, kind, api_key, embedding_model) VALUES
  ('00000000-0000-7000-8000-0000000a1002', 'OpenAI', 'openai', 'sk-proj-SEGREDOwxyz9876', 'text-embedding-3-small');
INSERT INTO ai_providers (id, name, kind, base_url) VALUES
  ('00000000-0000-7000-8000-0000000a1003', 'Ollama local', 'openai', 'http://ollama:11434/v1');

SELECT is((SELECT api_key_hint FROM ai_providers WHERE id = '00000000-0000-7000-8000-0000000a1001'), '…1234',
          'api_key_hint mostra só os 4 últimos');
SELECT is((SELECT api_key_hint FROM ai_providers WHERE id = '00000000-0000-7000-8000-0000000a1003'), NULL, 'sem chave, sem hint');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind) VALUES ('Sem nada', 'anthropic')$$, '23514', NULL,
                 'precisa de chave ou base_url');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, api_key) VALUES ('Gemini', 'google', 'abcdefghij')$$, '23514', NULL,
                 'kind anthropic|openai');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, api_key) VALUES ('CLAUDE', 'anthropic', 'abcdefghij')$$, '23505', NULL,
                 'nome único sem distinção de maiúsculas');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, api_key) VALUES ('Curta', 'anthropic', 'abc')$$, '23514', NULL,
                 'chave curta demais');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, api_key) VALUES ('Espaço', 'anthropic', 'abc defghij')$$, '23514', NULL,
                 'chave sem espaços');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, base_url) VALUES ('URL ruim', 'openai', 'ftp://x')$$, '23514', NULL,
                 'base_url http(s)');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, api_key, embedding_model) VALUES ('Emb anthropic', 'anthropic', 'abcdefghij', 'x')$$,
                 '23514', NULL, 'embeddings só em kind openai');
SELECT throws_ok($$INSERT INTO ai_providers (name, kind, api_key, embedding_model) VALUES ('Outro emb', 'openai', 'abcdefghij', 'text-embedding-3-small')$$,
                 '23505', NULL, 'no máximo um provedor de embeddings ativo');
SELECT lives_ok($$INSERT INTO ai_providers (name, kind, api_key, embedding_model, is_active) VALUES ('Emb inativo', 'openai', 'abcdefghij', 'text-embedding-3-small', false)$$,
                'um inativo com embeddings pode existir');
SELECT throws_ok($$UPDATE ai_providers SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000a1003'$$, '23514', NULL,
                 'arquivado não fica ativo');

-- Blindagem da chave
SELECT ok(NOT has_column_privilege('moneyflow_app', 'ai_providers', 'api_key', 'SELECT'), 'app não lê api_key');
SELECT ok(has_column_privilege('moneyflow_app', 'ai_providers', 'api_key', 'INSERT'), 'app grava api_key');
SELECT ok(has_column_privilege('moneyflow_app', 'ai_providers', 'api_key', 'UPDATE'), 'app troca api_key');
SELECT is_empty($$
  SELECT a.attname FROM pg_attribute a
   WHERE a.attrelid = 'ai_providers'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'api_key'
     AND NOT has_column_privilege('moneyflow_app', 'ai_providers', a.attname, 'SELECT')
$$, 'app lê todas as colunas menos a chave');

SELECT is(admin_ai_provider_api_key('00000000-0000-7000-8000-0000000a1001', '00000000-0000-7000-8000-0000000000a1'),
          'sk-ant-api03-SEGREDOabcd1234', 'admin lê a chave pela função');
SELECT throws_ok($$SELECT admin_ai_provider_api_key('00000000-0000-7000-8000-0000000a1001', '00000000-0000-7000-8000-0000000000a2')$$,
                 '42501', NULL, 'não admin: 42501');
SELECT throws_ok($$SELECT admin_ai_provider_api_key('00000000-0000-7000-8000-0000000a1fff', '00000000-0000-7000-8000-0000000000a1')$$,
                 'P0002', NULL, 'provedor inexistente: P0002');
SELECT results_eq($$SELECT provider_id, kind, api_key, embedding_model FROM ai_embedding_credentials()$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000a1002'::uuid, 'openai', 'sk-proj-SEGREDOwxyz9876', 'text-embedding-3-small')$$,
                  'credenciais de embeddings do provedor ativo');

-- Preços ----------------------------------------------------------------------------------------------------------
INSERT INTO ai_model_prices (id, provider_id, model, input_price_per_million, output_price_per_million,
                             cache_write_price_per_million, cache_read_price_per_million, valid_from) VALUES
  ('00000000-0000-7000-8000-0000000a2001', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', 3, 15, 3.75, 0.30, '2026-01-01'),
  ('00000000-0000-7000-8000-0000000a2002', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', 2.5, 12, NULL, NULL, '2026-09-01');
SELECT is((ai_model_price_at('00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', '2026-08-31')).id,
          '00000000-0000-7000-8000-0000000a2001'::uuid, 'preço vigente antes da troca');
SELECT is((ai_model_price_at('00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', '2026-10-01')).id,
          '00000000-0000-7000-8000-0000000a2002'::uuid, 'preço vigente depois da troca');
SELECT is((ai_model_price_at('00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', '2025-01-01')).id, NULL,
          'antes de qualquer preço: nulo');
SELECT is((SELECT currency FROM ai_model_prices WHERE id = '00000000-0000-7000-8000-0000000a2001'), 'USD', 'moeda padrão USD');
SELECT throws_ok($$INSERT INTO ai_model_prices (provider_id, model, input_price_per_million, output_price_per_million, valid_from)
                   VALUES ('00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5', 1, 1, '2026-01-01')$$,
                 '23505', NULL, 'uma vigência por modelo e instante');
SELECT throws_ok($$INSERT INTO ai_model_prices (provider_id, model, input_price_per_million, output_price_per_million)
                   VALUES ('00000000-0000-7000-8000-0000000a1001', 'x', -1, 1)$$, '23514', NULL, 'preço não negativo');
SELECT throws_ok($$INSERT INTO ai_model_prices (provider_id, model, currency, input_price_per_million, output_price_per_million)
                   VALUES ('00000000-0000-7000-8000-0000000a1001', 'x', 'EUR', 1, 1)$$, '23514', NULL, 'moeda USD|BRL');

-- Agentes ---------------------------------------------------------------------------------------------------------
SELECT ok(ai_agent_params_valid(p::jsonb), 'parâmetros válidos: ' || p)
  FROM unnest(ARRAY['{}', '{"temperature": 0.7}', '{"temperature": 0, "top_p": 1}', '{"max_tokens": 4096, "max_tool_iterations": 20}',
                    '{"thinking_budget_tokens": 0}', '{"reasoning_effort": "high"}']) p;
SELECT ok(NOT ai_agent_params_valid(p::jsonb), 'parâmetros inválidos: ' || p)
  FROM unnest(ARRAY['[]', '{"temperature": 2.5}', '{"temperature": "0.5"}', '{"top_p": 0}', '{"max_tokens": 0}',
                    '{"max_tokens": 1.5}', '{"max_tool_iterations": 201}', '{"reasoning_effort": "max"}', '{"seed": 1}']) p;
SELECT ok(ai_tool_list_valid(NULL), 'NULL = todas');
SELECT ok(ai_tool_list_valid('{}'), 'vazia = nenhuma');
SELECT ok(ai_tool_list_valid('{list_titles,create_title,github.search-code}'), 'nomes de tool');
SELECT ok(NOT ai_tool_list_valid('{a,a}'), 'sem repetição');
SELECT ok(NOT ai_tool_list_valid(ARRAY['a', NULL]), 'sem nulos');
SELECT ok(NOT ai_tool_list_valid('{"com espaço"}'), 'formato do nome');

INSERT INTO ai_agents (id, name, system_prompt, provider_id, model, params, color_slot, icon) VALUES
  ('00000000-0000-7000-8000-0000000a3001', 'Assistente', 'Você ajuda.', '00000000-0000-7000-8000-0000000a1001',
   'claude-sonnet-4-5', '{"temperature": 0.3}', 3, 'bot');
-- enabled_tools e require_write_confirmation saíram na 0038 (kit de ferramentas; testes em 0038_ai_tool_kits.sql).
SELECT results_eq($$SELECT is_active, tool_kit_id IS NULL FROM ai_agents
                     WHERE id = '00000000-0000-7000-8000-0000000a3001'$$,
                  $$VALUES (true, true)$$, 'ativo e, por padrão, sem kit');
SELECT lives_ok($$INSERT INTO ai_agents (name, is_active) VALUES ('Rascunho', false)$$, 'agente inativo sem provedor');
SELECT throws_ok($$INSERT INTO ai_agents (name) VALUES ('Sem provedor')$$, '23514', NULL, 'ativo exige provedor e modelo');
SELECT throws_ok($$INSERT INTO ai_agents (name, provider_id, is_active) VALUES ('Sem modelo', '00000000-0000-7000-8000-0000000a1001', true)$$,
                 '23514', NULL, 'ativo exige modelo');
SELECT throws_ok($$INSERT INTO ai_agents (name, is_active) VALUES ('assistente', false)$$, '23505', NULL, 'nome único');
SELECT throws_ok($$INSERT INTO ai_agents (name, is_active, color_slot) VALUES ('Cor', false, 13)$$, '23514', NULL, 'color_slot 1–12');
SELECT throws_ok($$INSERT INTO ai_agents (name, is_active, icon) VALUES ('Ícone', false, 'Bot')$$, '23514', NULL, 'ícone lucide kebab-case');
SELECT throws_ok($$INSERT INTO ai_agents (name, is_active, params) VALUES ('Params', false, '{"temperature": 3}')$$, '23514', NULL,
                 'parâmetros validados');
SELECT throws_ok($$UPDATE ai_agents SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000a3001'$$, '23514', NULL,
                 'arquivado não fica ativo');
SELECT throws_ok($$DELETE FROM ai_providers WHERE id = '00000000-0000-7000-8000-0000000a1001'$$, '23503', NULL,
                 'provedor em uso não é excluído');

-- Agente dos fluxos (0034) -----------------------------------------------------------------------------------------
SELECT has_column('ai_agents', 'use_for_flows');
SELECT col_not_null('ai_agents', 'use_for_flows');
SELECT col_default_is('ai_agents', 'use_for_flows', 'false');
SELECT has_index('ai_agents', 'ai_agents_use_for_flows_key');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000a3002', 'Leitor', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5');
SELECT lives_ok($$UPDATE ai_agents SET use_for_flows = true WHERE id = '00000000-0000-7000-8000-0000000a3002'$$, 'marca um agente');
SELECT throws_ok($$UPDATE ai_agents SET use_for_flows = true WHERE id = '00000000-0000-7000-8000-0000000a3001'$$, '23505',
                 'duplicate key value violates unique constraint "ai_agents_use_for_flows_key"', 'no máximo um marcado');
SELECT throws_ok($$INSERT INTO ai_agents (name, is_active, use_for_flows) VALUES ('Inativo marcado', false, true)$$, '23514',
                 'new row for relation "ai_agents" violates check constraint "ai_agents_use_for_flows_check"', 'marcado precisa estar ativo');
SELECT throws_ok($$UPDATE ai_agents SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000a3002'$$, '23514',
                 'new row for relation "ai_agents" violates check constraint "ai_agents_use_for_flows_check"',
                 'desativar o marcado exige desmarcar');
SELECT throws_ok($$UPDATE ai_agents SET is_active = false, archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000a3002'$$,
                 '23514', NULL, 'arquivar o marcado exige desmarcar');
SELECT lives_ok($$UPDATE ai_agents SET use_for_flows = false, is_active = false, archived_at = now()
                   WHERE id = '00000000-0000-7000-8000-0000000a3002'$$, 'desmarca e arquiva na mesma operação');
SELECT lives_ok($$UPDATE ai_agents SET use_for_flows = true WHERE id = '00000000-0000-7000-8000-0000000a3001'$$,
                'troca o marcado');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'ai_agents' AND record_id = '00000000-0000-7000-8000-0000000a3001'
                    AND changed_columns = ARRAY['use_for_flows']), 'a marca é auditada');
UPDATE ai_agents SET use_for_flows = false WHERE id = '00000000-0000-7000-8000-0000000a3001';

-- Auditoria sem a chave ---------------------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = t), t || ' é auditada')
  FROM unnest(ARRAY['ai_providers', 'ai_model_prices', 'ai_agents']) t;
SELECT is_empty($$SELECT 1 FROM audit_log WHERE table_name = 'ai_providers'
                    AND (old_data ? 'api_key' OR new_data ? 'api_key'
                         OR coalesce(old_data::text, '') LIKE '%SEGREDO%' OR coalesce(new_data::text, '') LIKE '%SEGREDO%')$$,
                'a chave nunca vai para o audit_log');
UPDATE ai_providers SET api_key = 'sk-ant-api03-OUTROSEGREDO5678' WHERE id = '00000000-0000-7000-8000-0000000a1001';
SELECT results_eq($$SELECT changed_columns, old_data ? 'api_key', new_data ? 'api_key' FROM audit_log
                     WHERE table_name = 'ai_providers' AND record_id = '00000000-0000-7000-8000-0000000a1001' AND action = 'update'$$,
                  $$VALUES (ARRAY['api_key', 'api_key_hint'], false, false)$$, 'troca de chave registrada sem o valor');

-- O papel da aplicação ------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT throws_ok($$SELECT api_key FROM ai_providers$$, '42501', NULL, 'app: SELECT da chave negado');
SELECT throws_ok($$SELECT * FROM ai_providers$$, '42501', NULL, 'app: SELECT * negado (liste as colunas)');
SELECT lives_ok($$SELECT id, name, kind, base_url, api_key_hint FROM ai_providers$$, 'app: colunas públicas');
SELECT lives_ok($$INSERT INTO ai_providers (name, kind, api_key) VALUES ('Pelo app', 'anthropic', 'sk-ant-xxxxxxxxxx')$$, 'app: cria');
SELECT lives_ok($$UPDATE ai_providers SET api_key = 'sk-ant-yyyyyyyyyy' WHERE name = 'Pelo app'$$, 'app: troca a chave');
SELECT is(admin_ai_provider_api_key((SELECT id FROM ai_providers WHERE name = 'Pelo app'), '00000000-0000-7000-8000-0000000000a1'),
          'sk-ant-yyyyyyyyyy', 'app: admin lê pela função');
SELECT lives_ok($$SELECT * FROM ai_agents$$, 'app: lê agentes');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
