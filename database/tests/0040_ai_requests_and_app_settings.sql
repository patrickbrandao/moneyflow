-- Testes de 0040_ai_requests_and_app_settings: configurações do sistema (app_settings, app_setting_valid, auditoria),
-- registro de requisições ao provedor (metadados sempre, corpos só com log_bodies, credenciais omitidas, vínculos pela
-- execução, ciclo running → final e imutabilidade, FKs SET NULL), tentativas (CASCADE e contador), ai_usage.request_id
-- (FK NOT VALID, coerência e limpeza das órfãs), purga, saúde por provedor e modelo, e o papel da aplicação.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Executa um comando e devolve "SQLSTATE constraint" do erro (ou 'ok').
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

-- Estrutura ----------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['app_settings', 'ai_requests', 'ai_request_attempts']) t;
SELECT columns_are('app_settings', ARRAY['key', 'value', 'updated_by_user_id', 'created_at', 'updated_at']);
SELECT columns_are('ai_requests', ARRAY['id', 'provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id', 'operation',
  'purpose', 'model', 'method', 'path', 'streaming', 'status', 'http_status', 'error_message', 'started_at', 'finished_at',
  'duration_ms', 'first_byte_ms', 'attempts', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens',
  'request_bytes', 'response_bytes', 'request_headers', 'request_body', 'response_headers', 'response_body',
  'response_stream', 'created_at', 'updated_at']);
SELECT columns_are('ai_request_attempts', ARRAY['request_id', 'attempt', 'started_at', 'duration_ms', 'http_status',
  'error_type', 'error_message', 'retry_after_ms', 'rate_limit_headers', 'response_body', 'created_at', 'updated_at']);
SELECT col_is_pk('app_settings', 'key');
SELECT col_is_pk('ai_requests', 'id');
SELECT col_is_pk('ai_request_attempts', ARRAY['request_id', 'attempt']);
SELECT col_not_null('ai_requests', c) FROM unnest(ARRAY['operation', 'method', 'path', 'streaming', 'status', 'started_at',
  'attempts', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens']) c;
SELECT col_is_null('ai_requests', c) FROM unnest(ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id',
  'purpose', 'model', 'request_body', 'response_body', 'response_stream']) c;
SELECT col_default_is('ai_requests', 'status', 'running');
SELECT is((SELECT attgenerated::text FROM pg_attribute WHERE attrelid = 'ai_requests'::regclass AND attname = 'duration_ms'),
          's', 'duration_ms é gerada pelo banco');
SELECT has_column('ai_providers', 'log_bodies');
SELECT col_not_null('ai_providers', 'log_bodies');
SELECT col_default_is('ai_providers', 'log_bodies', 'false');
SELECT has_column('ai_usage', 'request_id');
SELECT col_is_null('ai_usage', 'request_id');
SELECT results_eq($$SELECT conname::text COLLATE "default", confdeltype::text, convalidated FROM pg_constraint
                     WHERE contype = 'f'
                       AND (conrelid IN ('app_settings'::regclass, 'ai_requests'::regclass, 'ai_request_attempts'::regclass)
                            OR conname = 'ai_usage_request_id_fkey')
                     ORDER BY 1$$,
                  $$VALUES ('ai_request_attempts_request_id_fkey', 'c', true),
                           ('ai_requests_agent_id_fkey', 'n', true),
                           ('ai_requests_conversation_id_fkey', 'n', true),
                           ('ai_requests_provider_id_fkey', 'n', true),
                           ('ai_requests_run_id_fkey', 'n', true),
                           ('ai_requests_user_id_fkey', 'n', true),
                           ('ai_usage_request_id_fkey', 'n', false),
                           ('app_settings_updated_by_user_id_fkey', 'n', true)$$,
                  'FKs: SET NULL nas requisições e no uso (NOT VALID, por causa do dump), CASCADE nas tentativas');
SELECT has_index('ai_requests', i) FROM unnest(ARRAY['ai_requests_provider_id_idx', 'ai_requests_started_at_idx',
  'ai_requests_run_id_idx', 'ai_requests_agent_id_idx', 'ai_requests_user_id_idx', 'ai_requests_conversation_id_idx']) i;
SELECT has_index('ai_usage', 'ai_usage_request_id_idx');
SELECT has_index('app_settings', 'app_settings_updated_by_user_id_idx');
SELECT is((SELECT pg_get_indexdef('ai_requests_provider_id_idx'::regclass) ~ '\(provider_id, started_at DESC, id DESC\)'), true,
          'lista por provedor: (provider_id, started_at desc)');
SELECT has_trigger('app_settings', t) FROM unnest(ARRAY['app_settings_audit', 'app_settings_before_write',
                                                       'app_settings_set_updated_at']) t;
SELECT has_trigger('ai_requests', t) FROM unnest(ARRAY['ai_requests_before_write', 'ai_requests_set_updated_at']) t;
SELECT has_trigger('ai_request_attempts', t) FROM unnest(ARRAY['ai_request_attempts_before_write',
  'ai_request_attempts_after_insert', 'ai_request_attempts_set_updated_at']) t;
SELECT has_trigger('ai_usage', 'ai_usage_request_check');
SELECT hasnt_trigger('ai_requests', 'ai_requests_audit');
SELECT has_function(f) FROM unnest(ARRAY['app_setting_valid', 'ai_requests_purge', 'ai_provider_health',
                                         'ai_usage_unlink_missing_requests', 'ai_request_headers_redact']) f;

-- Privilégios
SELECT ok(has_table_privilege('moneyflow_app', 'app_settings', p), 'app: ' || p || ' em app_settings')
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
SELECT ok(has_table_privilege('moneyflow_app', t, p), 'app: ' || p || ' em ' || t)
  FROM unnest(ARRAY['ai_requests', 'ai_request_attempts']) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;
SELECT ok(NOT has_table_privilege('moneyflow_app', t, 'DELETE'), 'app não apaga ' || t || ' (só a purga)')
  FROM unnest(ARRAY['ai_requests', 'ai_request_attempts']) t;
SELECT ok(has_column_privilege('moneyflow_app', 'ai_providers', 'log_bodies', p), 'app: ' || p || ' em ai_providers.log_bodies')
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;
SELECT ok(NOT has_column_privilege('moneyflow_app', 'ai_providers', 'api_key', 'SELECT'), 'app continua sem ler api_key');
SELECT ok(NOT has_table_privilege('moneyflow_app', 'ai_usage', 'UPDATE'), 'app continua sem alterar o uso');
SELECT ok(NOT has_function_privilege(r, 'app_settings_audit_row()', 'EXECUTE'), r || ' não executa app_settings_audit_row')
  FROM unnest(ARRAY['public', 'moneyflow_app']) r;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'public não executa ' || f)
  FROM unnest(ARRAY['ai_requests_purge(integer, integer)', 'ai_usage_unlink_missing_requests()']) f;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_requests_purge(integer, integer)', 'ai_usage_unlink_missing_requests()',
                    'ai_provider_health(integer, uuid)', 'app_setting_valid(text, jsonb)']) f;
SELECT is((SELECT prosecdef FROM pg_proc WHERE proname = 'ai_requests_purge'), true, 'a purga é SECURITY DEFINER');

-- app_setting_valid ----------------------------------------------------------------------------------------------
SELECT is(app_setting_valid('ai.request_retention_days', v::jsonb), true, 'retenção válida: ' || v)
  FROM unnest(ARRAY['1', '30', '365']) v;
SELECT is(app_setting_valid('ai.request_retention_days', v::jsonb), false, 'retenção inválida: ' || v)
  FROM unnest(ARRAY['0', '366', '-1', '30.5', '30.0', '"30"', 'true', 'null', '[30]', '{"days": 30}', '1000']) v;
SELECT is(app_setting_valid('ai.request_retention_days', NULL), false, 'valor nulo é inválido');
SELECT is(app_setting_valid('ai.desconhecida', '30'), false, 'chave desconhecida é inválida');
SELECT is(app_setting_valid(NULL, '30'), false, 'chave nula é inválida');

-- Dados base -----------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'admin40', 'admin40@example.com', 'segredo', 'admin'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia40', 'bia40@example.com', 'segredo', 'user'),
  ('00000000-0000-7000-8000-0000000000a3', 'caio40', 'caio40@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key, log_bodies) VALUES
  ('00000000-0000-7000-8000-00000000f101', 'Sem registro', 'anthropic', 'sk-ant-api03-aaaaaaaa', false),
  ('00000000-0000-7000-8000-00000000f102', 'Com registro', 'anthropic', 'sk-ant-api03-bbbbbbbb', true),
  ('00000000-0000-7000-8000-00000000f103', 'Descartável', 'openai', 'sk-proj-cccccccc', false),
  ('00000000-0000-7000-8000-00000000f104', 'Saúde', 'openai', 'sk-proj-dddddddd', false);
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-00000000f201', 'Agente 40', '00000000-0000-7000-8000-00000000f102', 'claude-sonnet-4-5');
INSERT INTO ai_conversations (id, user_id, agent_id, purpose) VALUES
  ('00000000-0000-7000-8000-00000000f301', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000f201', 'chat'),
  ('00000000-0000-7000-8000-00000000f302', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000f201',
   'document_reading'),
  ('00000000-0000-7000-8000-00000000f303', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000f201', 'chat');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-00000000f401', '00000000-0000-7000-8000-00000000f301', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-00000000f201'),
  ('00000000-0000-7000-8000-00000000f403', '00000000-0000-7000-8000-00000000f303', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-00000000f201');

-- app_settings ---------------------------------------------------------------------------------------------------
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
INSERT INTO app_settings (key, value) VALUES ('ai.request_retention_days', '45');
SELECT results_eq($$SELECT value, updated_by_user_id FROM app_settings WHERE key = 'ai.request_retention_days'$$,
                  $$VALUES ('45'::jsonb, '00000000-0000-7000-8000-0000000000a1'::uuid)$$,
                  'grava a retenção com o autor da transação');
SELECT is(pg_temp.err($$INSERT INTO app_settings (key, value) VALUES ('ai.desconhecida', '1')$$),
          '23514 app_settings_value_check', 'chave desconhecida recusada');
SELECT is(pg_temp.err($$INSERT INTO app_settings (key, value) VALUES ('Retencao', '1')$$),
          '23514 app_settings_key_check', 'chave fora do formato area.nome');
SELECT is(pg_temp.err($$UPDATE app_settings SET value = '0' WHERE key = 'ai.request_retention_days'$$),
          '23514 app_settings_value_check', 'retenção 0 recusada');
SELECT is(pg_temp.err($$UPDATE app_settings SET value = '"30"' WHERE key = 'ai.request_retention_days'$$),
          '23514 app_settings_value_check', 'retenção como texto recusada');
SELECT is(pg_temp.err($$INSERT INTO app_settings (key, value) VALUES ('ai.request_retention_days', '10')$$),
          '23505 app_settings_pkey', 'uma linha por chave');
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a3', true);
UPDATE app_settings SET value = '60', updated_by_user_id = '00000000-0000-7000-8000-0000000000a2'
 WHERE key = 'ai.request_retention_days';
SELECT is((SELECT updated_by_user_id FROM app_settings), '00000000-0000-7000-8000-0000000000a3'::uuid,
          'updated_by_user_id = app.user_id (vence o informado)');
UPDATE app_settings SET value = '60' WHERE key = 'ai.request_retention_days';
DELETE FROM app_settings WHERE key = 'ai.request_retention_days';
SELECT results_eq($$SELECT action, user_id, old_data ->> 'value', new_data ->> 'value', changed_columns FROM audit_log
                     WHERE table_name = 'app_settings' AND record_id = md5('ai.request_retention_days')::uuid
                     ORDER BY created_at, id$$,
                  $$VALUES ('insert', '00000000-0000-7000-8000-0000000000a1'::uuid, NULL, '45', NULL::text[]),
                           ('update', '00000000-0000-7000-8000-0000000000a3'::uuid, '45', '60',
                            ARRAY['updated_by_user_id', 'value']),
                           ('delete', '00000000-0000-7000-8000-0000000000a3'::uuid, '60', NULL, NULL::text[])$$,
                  'auditada com record_id = md5(key); regravar o mesmo valor não gera linha');
SELECT set_config('app.user_id', '', true);
INSERT INTO app_settings (key, value, updated_by_user_id)
VALUES ('ai.request_retention_days', '7', '00000000-0000-7000-8000-0000000000a3');
SELECT is((SELECT updated_by_user_id FROM app_settings), '00000000-0000-7000-8000-0000000000a3'::uuid,
          'sem app.user_id, vale o autor informado');
DELETE FROM users WHERE id = '00000000-0000-7000-8000-0000000000a3';
SELECT is((SELECT updated_by_user_id FROM app_settings), NULL, 'autor excluído vira nulo');
DELETE FROM app_settings;

-- log_bodies auditado
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
UPDATE ai_providers SET log_bodies = true WHERE id = '00000000-0000-7000-8000-00000000f103';
SELECT results_eq($$SELECT changed_columns, (new_data ->> 'log_bodies')::boolean, new_data ? 'api_key' FROM audit_log
                     WHERE table_name = 'ai_providers' AND record_id = '00000000-0000-7000-8000-00000000f103'
                       AND action = 'update'$$,
                  $$VALUES (ARRAY['log_bodies'], true, false)$$, 'ligar log_bodies é auditado (sem a chave)');
UPDATE ai_providers SET log_bodies = false WHERE id = '00000000-0000-7000-8000-00000000f103';
SELECT set_config('app.user_id', '', true);

-- Requisições: corpos, cabeçalhos e vínculos ---------------------------------------------------------------------
INSERT INTO ai_requests (id, provider_id, operation, purpose, model, path, request_bytes, request_headers, request_body,
                         response_headers, response_body, response_stream) VALUES
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000f101', 'title', 'title', 'claude-haiku-4-5',
   '/v1/messages', 1234, '{"content-type": "application/json"}', '{"messages": []}', '{}', '{"ok": true}', 'data: x');
SELECT results_eq($$SELECT request_bytes, request_headers, request_body, response_headers, response_body, response_stream,
                           status, attempts, finished_at, duration_ms
                      FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e001'$$,
                  $$VALUES (1234::bigint, NULL::jsonb, NULL::text, NULL::jsonb, NULL::text, NULL::text, 'running', 0,
                            NULL::timestamptz, NULL::integer)$$,
                  'sem log_bodies: metadados ficam, cabeçalhos e corpos são descartados; nasce running');

INSERT INTO ai_requests (id, run_id, operation, purpose, path, streaming, request_headers, request_body, attempts) VALUES
  ('00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000f401', 'chat', 'chat', '/v1/messages', true,
   '{"Authorization": "Bearer sk-x", "X-Api-Key": "sk-ant-api03-bbbbbbbb", "API-KEY": "k", "Content-Type": "application/json",
     "anthropic-version": "2023-06-01"}',
   '{"messages": [{"role": "user", "content": [{"type": "image", "source": {"data": "iVBORw0KGgo="}}]}]}', 5);
SELECT results_eq($$SELECT conversation_id, user_id, agent_id, provider_id, model, attempts FROM ai_requests
                     WHERE id = '00000000-0000-7000-8000-00000000e002'$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f301'::uuid, '00000000-0000-7000-8000-0000000000a2'::uuid,
                            '00000000-0000-7000-8000-00000000f201'::uuid, '00000000-0000-7000-8000-00000000f102'::uuid,
                            'claude-sonnet-4-5', 0)$$,
                  'completa os vínculos pela execução; o contador de tentativas é do banco');
SELECT is((SELECT request_headers FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e002'),
          '{"Authorization": "[omitido]", "X-Api-Key": "[omitido]", "API-KEY": "[omitido]",
            "Content-Type": "application/json", "anthropic-version": "2023-06-01"}'::jsonb,
          'credenciais omitidas sem distinção de maiúsculas; o resto fica');
SELECT is((SELECT request_body FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e002'),
          '{"messages": [{"role": "user", "content": [{"type": "image", "source": {"data": "iVBORw0KGgo="}}]}]}',
          'com log_bodies: corpo completo, inclusive o base64');

SELECT is(pg_temp.err($$INSERT INTO ai_requests (run_id, conversation_id, operation, purpose, path)
                        VALUES ('00000000-0000-7000-8000-00000000f401', '00000000-0000-7000-8000-00000000f303', 'chat', 'chat', '/x')$$),
          '23514 ai_requests_links_check', 'execução de outra conversa');
INSERT INTO ai_requests (id, conversation_id, provider_id, operation, purpose, path) VALUES
  ('00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-00000000f302', '00000000-0000-7000-8000-00000000f101',
   'chat', 'chat', '/v1/messages');
SELECT is((SELECT purpose FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e003'), 'document_reading',
          'chat numa conversa de fluxo vira a finalidade dela');

-- Operação e finalidade
SELECT is(pg_temp.err(format($$INSERT INTO ai_requests (provider_id, operation, purpose, path) VALUES (%L, %L, %s, '/x')$$,
                             '00000000-0000-7000-8000-00000000f101', o, coalesce(quote_literal(p), 'NULL'))), 'ok',
          'aceita ' || o || '/' || coalesce(p, 'nula'))
  FROM (VALUES ('chat', 'classify_lines'), ('embedding', 'embedding'), ('vision_describe', 'chat'),
               ('transcription', 'chat'), ('speech', 'chat'), ('test_connection', NULL), ('list_models', NULL),
               ('title', 'contract_markdown')) x (o, p);
SELECT is(pg_temp.err(format($$INSERT INTO ai_requests (provider_id, operation, purpose, path) VALUES (%L, %L, %s, '/x')$$,
                             '00000000-0000-7000-8000-00000000f101', o, coalesce(quote_literal(p), 'NULL'))), e,
          'recusa ' || o || '/' || coalesce(p, 'nula'))
  FROM (VALUES ('test_connection', 'chat', '23514 ai_requests_purpose_null_check'),
               ('chat', NULL, '23514 ai_requests_purpose_null_check'),
               ('chat', 'outra', '23514 ai_requests_purpose_check'),
               ('completion', 'chat', '23514 ai_requests_operation_check')) x (o, p, e);
INSERT INTO ai_requests (operation, path) VALUES ('test_connection', 'https://api.example.com/v1/models');
SELECT is((SELECT count(*)::int FROM ai_requests WHERE provider_id IS NULL AND operation = 'test_connection'), 1,
          'testar conexão de provedor ainda não salvo: sem provedor nem finalidade');
SELECT is(pg_temp.err(c), e, 'recusa: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_requests (operation, purpose, path) VALUES ('title', 'title', 'com espaço')$$, '23514 ai_requests_path_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, method) VALUES ('title', 'title', '/x', 'HEAD')$$, '23514 ai_requests_method_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, model) VALUES ('title', 'title', '/x', ' x')$$, '23514 ai_requests_model_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, status, finished_at)
       VALUES ('title', 'title', '/x', 'done', clock_timestamp() + interval '1 second')$$, '23514 ai_requests_status_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, status) VALUES ('title', 'title', '/x', 'ok')$$, '23514 ai_requests_finished_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, finished_at) VALUES ('title', 'title', '/x', now())$$, '23514 ai_requests_finished_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, status, started_at, finished_at)
       VALUES ('title', 'title', '/x', 'ok', now(), now() - interval '1 second')$$, '23514 ai_requests_finished_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, http_status) VALUES ('title', 'title', '/x', 99)$$, '23514 ai_requests_http_status_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, status, finished_at, error_message)
       VALUES ('title', 'title', '/x', 'ok', clock_timestamp() + interval '1 second', 'erro')$$, '23514 ai_requests_error_message_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, error_message) VALUES ('title', 'title', '/x', repeat('e', 4001))$$,
     '23514 ai_requests_error_message_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, first_byte_ms) VALUES ('title', 'title', '/x', -1)$$, '23514 ai_requests_first_byte_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, output_tokens) VALUES ('title', 'title', '/x', -1)$$, '23514 ai_requests_tokens_check'),
    ($$INSERT INTO ai_requests (operation, purpose, path, response_bytes) VALUES ('title', 'title', '/x', -1)$$, '23514 ai_requests_bytes_check'),
    ($$INSERT INTO ai_requests (provider_id, operation, purpose, path, request_headers)
       VALUES ('00000000-0000-7000-8000-00000000f102', 'title', 'title', '/x', '["a"]')$$, '23514 ai_requests_headers_check'),
    ($$INSERT INTO ai_requests (provider_id, operation, purpose, path)
       VALUES ('00000000-0000-7000-8000-00000000ffff', 'title', 'title', '/x')$$, '23503 ai_requests_provider_id_fkey')
  ) x (c, e);

-- Ciclo de vida e imutabilidade ----------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE ai_requests SET path = '/v2' WHERE id = '00000000-0000-7000-8000-00000000e002'$$),
          '23514 ai_requests_immutable_check', 'em andamento: o caminho não muda');
SELECT is(pg_temp.err($$UPDATE ai_requests SET operation = 'title', purpose = 'title' WHERE id = '00000000-0000-7000-8000-00000000e002'$$),
          '23514 ai_requests_immutable_check', 'em andamento: a operação não muda');
SELECT is(pg_temp.err($$UPDATE ai_requests SET provider_id = '00000000-0000-7000-8000-00000000f101'
                        WHERE id = '00000000-0000-7000-8000-00000000e002'$$),
          '23514 ai_requests_immutable_check', 'a FK não troca de valor');
UPDATE ai_requests
   SET status = 'ok', http_status = 200, finished_at = started_at + interval '1234.6 milliseconds', first_byte_ms = 321,
       input_tokens = 10, output_tokens = 20, response_bytes = 99, response_headers = '{"x-api-key": "k", "request-id": "req_1"}',
       response_body = '{"content": []}', response_stream = 'event: message_start'
 WHERE id = '00000000-0000-7000-8000-00000000e002';
SELECT results_eq($$SELECT status, duration_ms, first_byte_ms, response_headers, response_body, response_stream
                      FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e002'$$,
                  $$VALUES ('ok', 1234, 321, '{"x-api-key": "[omitido]", "request-id": "req_1"}'::jsonb, '{"content": []}',
                            'event: message_start')$$,
                  'termina ok: duração gerada, resposta e stream gravados, credencial omitida');
SELECT is(pg_temp.err(format($$UPDATE ai_requests SET %s WHERE id = '00000000-0000-7000-8000-00000000e002'$$, s)),
          '23514 ai_requests_immutable_check', 'terminada é imutável: ' || s)
  FROM unnest(ARRAY['status = ''error''', 'status = ''running'', finished_at = NULL', 'http_status = 500',
                    'output_tokens = 21', 'response_body = ''{}''', 'finished_at = finished_at + interval ''1 second''',
                    'error_message = NULL, request_body = NULL']) s;

-- Corpo chegando com a flag desligada no meio da chamada
UPDATE ai_providers SET log_bodies = true WHERE id = '00000000-0000-7000-8000-00000000f101';
INSERT INTO ai_requests (id, provider_id, operation, purpose, path, request_body) VALUES
  ('00000000-0000-7000-8000-00000000e004', '00000000-0000-7000-8000-00000000f101', 'title', 'title', '/v1/messages', 'enviado');
UPDATE ai_providers SET log_bodies = false WHERE id = '00000000-0000-7000-8000-00000000f101';
UPDATE ai_requests SET status = 'error', finished_at = clock_timestamp(), error_message = 'falhou', response_body = 'recebido'
 WHERE id = '00000000-0000-7000-8000-00000000e004';
SELECT results_eq($$SELECT request_body, response_body, status FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e004'$$,
                  $$VALUES ('enviado', NULL::text, 'error')$$,
                  'flag desligada no meio: o corpo já gravado fica, o novo é descartado');

-- Tentativas -----------------------------------------------------------------------------------------------------
INSERT INTO ai_request_attempts (request_id, attempt, duration_ms, http_status, error_type, error_message, retry_after_ms,
                                 rate_limit_headers, response_body) VALUES
  ('00000000-0000-7000-8000-00000000e002', 1, 50, 429, 'rate_limit', 'limite', 2000,
   '{"anthropic-ratelimit-requests-remaining": "0", "Authorization": "Bearer x"}', '{"error": {"type": "rate_limit_error"}}'),
  ('00000000-0000-7000-8000-00000000e002', 2, 1200, 200, NULL, NULL, NULL, NULL, NULL);
SELECT is((SELECT attempts FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e002'), 2,
          'o contador acompanha as tentativas (mesmo depois de terminada)');
SELECT results_eq($$SELECT rate_limit_headers, response_body FROM ai_request_attempts
                     WHERE request_id = '00000000-0000-7000-8000-00000000e002' AND attempt = 1$$,
                  $$VALUES ('{"anthropic-ratelimit-requests-remaining": "0", "Authorization": "[omitido]"}'::jsonb,
                            '{"error": {"type": "rate_limit_error"}}')$$,
                  'com log_bodies: corpo do erro e cabeçalhos de rate limit');
INSERT INTO ai_request_attempts (request_id, attempt, http_status, error_type, rate_limit_headers, response_body) VALUES
  ('00000000-0000-7000-8000-00000000e001', 1, 529, 'overloaded', '{"retry-after": "3"}', '{"error": "overloaded"}');
SELECT results_eq($$SELECT rate_limit_headers, response_body FROM ai_request_attempts
                     WHERE request_id = '00000000-0000-7000-8000-00000000e001'$$,
                  $$VALUES ('{"retry-after": "3"}'::jsonb, NULL::text)$$,
                  'sem log_bodies: rate limit fica, o corpo do erro não');
SELECT is(pg_temp.err(c), e, 'tentativa recusada: ' || e)
  FROM (VALUES
    ($$INSERT INTO ai_request_attempts (request_id, attempt) VALUES ('00000000-0000-7000-8000-00000000e001', 1)$$,
     '23505 ai_request_attempts_pkey'),
    ($$INSERT INTO ai_request_attempts (request_id, attempt) VALUES ('00000000-0000-7000-8000-00000000e001', 0)$$,
     '23514 ai_request_attempts_attempt_check'),
    ($$INSERT INTO ai_request_attempts (request_id, attempt, error_type) VALUES ('00000000-0000-7000-8000-00000000e001', 2, 'Rede')$$,
     '23514 ai_request_attempts_error_type_check'),
    ($$INSERT INTO ai_request_attempts (request_id, attempt, retry_after_ms) VALUES ('00000000-0000-7000-8000-00000000e001', 2, -1)$$,
     '23514 ai_request_attempts_retry_after_check'),
    ($$INSERT INTO ai_request_attempts (request_id, attempt, rate_limit_headers) VALUES ('00000000-0000-7000-8000-00000000e001', 2, '"x"')$$,
     '23514 ai_request_attempts_headers_check'),
    ($$INSERT INTO ai_request_attempts (request_id, attempt) VALUES ('00000000-0000-7000-8000-00000000ffff', 1)$$,
     '23503 ai_request_attempts_request_id_fkey')
  ) x (c, e);

-- Exclusões: FKs SET NULL e CASCADE --------------------------------------------------------------------------------
INSERT INTO ai_requests (id, provider_id, operation, path, status, finished_at) VALUES
  ('00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000f103', 'list_models', '/v1/models', 'ok', clock_timestamp() + interval '1 second');
DELETE FROM ai_providers WHERE id = '00000000-0000-7000-8000-00000000f103';
SELECT is((SELECT provider_id FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e005'), NULL,
          'provedor excluído: a requisição terminada fica, sem provedor');
INSERT INTO ai_requests (id, run_id, operation, purpose, path) VALUES
  ('00000000-0000-7000-8000-00000000e006', '00000000-0000-7000-8000-00000000f403', 'chat', 'chat', '/v1/messages');
DELETE FROM ai_conversations WHERE id = '00000000-0000-7000-8000-00000000f303';
SELECT results_eq($$SELECT conversation_id, run_id, user_id, agent_id FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e006'$$,
                  $$VALUES (NULL::uuid, NULL::uuid, '00000000-0000-7000-8000-0000000000a2'::uuid,
                            '00000000-0000-7000-8000-00000000f201'::uuid)$$,
                  'conversa excluída (com a execução): vínculos anulados, a requisição fica');
DELETE FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT is((SELECT count(*)::int FROM ai_request_attempts WHERE request_id = '00000000-0000-7000-8000-00000000e001'), 0,
          'tentativas somem com a requisição (CASCADE)');

-- ai_usage.request_id ----------------------------------------------------------------------------------------------
INSERT INTO ai_usage (id, run_id, request_id, input_tokens, output_tokens) VALUES
  ('00000000-0000-7000-8000-00000000d001', '00000000-0000-7000-8000-00000000f401', '00000000-0000-7000-8000-00000000e002', 10, 20);
SELECT is((SELECT request_id FROM ai_usage WHERE id = '00000000-0000-7000-8000-00000000d001'),
          '00000000-0000-7000-8000-00000000e002'::uuid, 'o uso aponta para a requisição');
SELECT is(pg_temp.err($$INSERT INTO ai_usage (provider_id, model, purpose, request_id)
                        VALUES ('00000000-0000-7000-8000-00000000f101', 'claude-sonnet-4-5', 'title',
                                '00000000-0000-7000-8000-00000000e002')$$),
          '23514 ai_usage_links_check', 'requisição de outro provedor');
SELECT is(pg_temp.err($$INSERT INTO ai_usage (provider_id, model, purpose, request_id)
                        VALUES ('00000000-0000-7000-8000-00000000f101', 'x', 'title', '00000000-0000-7000-8000-00000000ffff')$$),
          '23503 ai_usage_request_id_fkey', 'NOT VALID ainda checa as linhas novas');
INSERT INTO ai_usage (id, provider_id, model, purpose, request_id) VALUES
  ('00000000-0000-7000-8000-00000000d002', '00000000-0000-7000-8000-00000000f101', 'claude-haiku-4-5', 'title',
   '00000000-0000-7000-8000-00000000e004');

-- Órfã como a que sobra de um pg_restore (dados de ai_requests fora do dump).
SET LOCAL session_replication_role = replica;
INSERT INTO ai_usage (id, provider_id, model, purpose, request_id) VALUES
  ('00000000-0000-7000-8000-00000000d003', '00000000-0000-7000-8000-00000000f101', 'claude-haiku-4-5', 'title',
   '00000000-0000-7000-8000-00000000eeee');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE moneyflow_app;
SELECT is(ai_usage_unlink_missing_requests(), 1, 'anula o vínculo órfão');
SELECT is(ai_usage_unlink_missing_requests(), 0, 'idempotente');
RESET ROLE;
SELECT results_eq($$SELECT id, request_id FROM ai_usage WHERE id IN ('00000000-0000-7000-8000-00000000d001',
                     '00000000-0000-7000-8000-00000000d002', '00000000-0000-7000-8000-00000000d003') ORDER BY id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000d001'::uuid, '00000000-0000-7000-8000-00000000e002'::uuid),
                           ('00000000-0000-7000-8000-00000000d002'::uuid, '00000000-0000-7000-8000-00000000e004'::uuid),
                           ('00000000-0000-7000-8000-00000000d003'::uuid, NULL::uuid)$$,
                  'só a órfã foi anulada');

-- Purga ------------------------------------------------------------------------------------------------------------
-- Envelhece duas requisições terminadas (o guarda recusaria; triggers desligados só para montar o cenário).
SELECT is(pg_temp.err($$UPDATE ai_requests SET started_at = started_at - interval '40 days'
                        WHERE id = '00000000-0000-7000-8000-00000000e002'$$),
          '23514 ai_requests_immutable_check', 'terminada: o início não muda');
SET LOCAL session_replication_role = replica;
UPDATE ai_requests SET started_at = started_at - interval '40 days', finished_at = finished_at - interval '40 days'
 WHERE id IN ('00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-00000000e004');
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.err('SELECT ai_requests_purge(0)'), '22023 ', 'dias < 1');
SELECT is(pg_temp.err('SELECT ai_requests_purge(30, 0)'), '22023 ', 'limite < 1');
SELECT is(pg_temp.err('SELECT ai_requests_purge(30, 100001)'), '22023 ', 'limite acima de 100000');
SELECT set_config('test.total', (SELECT count(*) FROM ai_requests)::text, true);
SET LOCAL ROLE moneyflow_app;
SELECT is(pg_temp.err($$DELETE FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e002'$$), '42501 ',
          'a aplicação não apaga requisição direto');
SELECT is(ai_requests_purge(30, 1), 1, 'em lotes: apaga até o limite');
SELECT is(ai_requests_purge(30), 1, 'o resto do que passou do prazo');
SELECT is(ai_requests_purge(30), 0, 'nada mais a apagar');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM ai_requests), current_setting('test.total')::int - 2, 'as recentes ficam');
SELECT is((SELECT count(*)::int FROM ai_requests WHERE id IN ('00000000-0000-7000-8000-00000000e002',
                                                              '00000000-0000-7000-8000-00000000e004')), 0,
          'as mais velhas que o prazo saíram');
SELECT is((SELECT count(*)::int FROM ai_request_attempts WHERE request_id = '00000000-0000-7000-8000-00000000e002'), 0,
          'as tentativas saíram junto');
SELECT results_eq($$SELECT id, request_id, input_tokens FROM ai_usage
                     WHERE id IN ('00000000-0000-7000-8000-00000000d001', '00000000-0000-7000-8000-00000000d002') ORDER BY id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000d001'::uuid, NULL::uuid, 10::bigint),
                           ('00000000-0000-7000-8000-00000000d002'::uuid, NULL::uuid, 0::bigint)$$,
                  'o uso fica, com o vínculo nulo');

-- Saúde ------------------------------------------------------------------------------------------------------------
INSERT INTO ai_requests (id, provider_id, operation, purpose, model, path, status, started_at, finished_at, first_byte_ms,
                         error_message) VALUES
  ('00000000-0000-7000-8000-00000000c001', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'ok',
   now() - interval '1 hour', now() - interval '1 hour' + interval '100 ms', 10, NULL),
  ('00000000-0000-7000-8000-00000000c002', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'ok',
   now() - interval '2 hours', now() - interval '2 hours' + interval '200 ms', 20, NULL),
  ('00000000-0000-7000-8000-00000000c003', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'ok',
   now() - interval '3 hours', now() - interval '3 hours' + interval '300 ms', 30, NULL),
  ('00000000-0000-7000-8000-00000000c004', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'ok',
   now() - interval '4 hours', now() - interval '4 hours' + interval '400 ms', 50, NULL),
  ('00000000-0000-7000-8000-00000000c005', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'error',
   now() - interval '5 hours', now() - interval '5 hours' + interval '9000 ms', NULL, '503'),
  ('00000000-0000-7000-8000-00000000c006', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'canceled',
   now() - interval '6 hours', now() - interval '6 hours' + interval '50 ms', NULL, NULL),
  ('00000000-0000-7000-8000-00000000c007', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'running',
   now() - interval '1 minute', NULL, NULL, NULL),
  ('00000000-0000-7000-8000-00000000c008', '00000000-0000-7000-8000-00000000f104', 'chat', 'chat', 'gpt-5', '/v1/x', 'error',
   now() - interval '8 days', now() - interval '8 days' + interval '1 s', NULL, 'velho'),
  ('00000000-0000-7000-8000-00000000c009', '00000000-0000-7000-8000-00000000f104', 'embedding', 'embedding',
   'text-embedding-3-small', '/v1/embeddings', 'ok', now() - interval '1 hour', now() - interval '1 hour' + interval '80 ms',
   NULL, NULL);
INSERT INTO ai_request_attempts (request_id, attempt)
SELECT r.id, n FROM ai_requests r, generate_series(1, 2) n
 WHERE r.provider_id = '00000000-0000-7000-8000-00000000f104' AND r.model = 'gpt-5'
   AND (n = 1 OR r.id = '00000000-0000-7000-8000-00000000c005');
SELECT results_eq($$SELECT model, requests, ok, errors, canceled, error_rate, p50_ms, p95_ms, p50_first_byte_ms,
                           p95_first_byte_ms, avg_attempts, last_error_at
                      FROM ai_provider_health(7, '00000000-0000-7000-8000-00000000f104')$$,
                  $$VALUES ('gpt-5', 6, 4, 1, 1, 0.2000, 250, 385, 25, 47, 1.17,
                            (SELECT finished_at FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000c005')),
                           ('text-embedding-3-small', 1, 1, 0, 0, 0.0000, 80, 80, NULL, NULL, 0.00, NULL)$$,
                  'saúde por modelo em 7 dias: sem as em andamento nem as antigas; taxa sem as canceladas');
SELECT is((SELECT requests FROM ai_provider_health(30, '00000000-0000-7000-8000-00000000f104') WHERE model = 'gpt-5'), 7,
          'o período conta (30 dias pega a antiga)');
SELECT ok(NOT EXISTS (SELECT 1 FROM ai_provider_health(7, '00000000-0000-7000-8000-00000000f104')
                       WHERE provider_id IS DISTINCT FROM '00000000-0000-7000-8000-00000000f104'),
          'filtrada por provedor');
SELECT ok((SELECT count(DISTINCT provider_id) FROM ai_provider_health()) >= 1, 'sem provedor: todos (padrão 7 dias)');
SELECT is(pg_temp.err('SELECT * FROM ai_provider_health(0)'), '22023 ', 'dias < 1');
SELECT is(pg_temp.err('SELECT * FROM ai_provider_health(366)'), '22023 ', 'dias > 365');

-- Papel da aplicação ----------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
INSERT INTO app_settings (key, value) VALUES ('ai.request_retention_days', '15')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
SELECT is((SELECT value FROM app_settings WHERE key = 'ai.request_retention_days'), '15'::jsonb, 'app grava a configuração');
DELETE FROM app_settings WHERE key = 'ai.request_retention_days';
SELECT is((SELECT count(*)::int FROM app_settings), 0, 'app apaga ("Usar o padrão")');
SELECT is((SELECT log_bodies FROM ai_providers WHERE id = '00000000-0000-7000-8000-00000000f102'), true, 'app lê log_bodies');
UPDATE ai_providers SET log_bodies = false WHERE id = '00000000-0000-7000-8000-00000000f102';
SELECT is(pg_temp.err('SELECT api_key FROM ai_providers'), '42501 ', 'app continua sem ler a chave');
INSERT INTO ai_requests (id, provider_id, operation, purpose, model, path) VALUES
  ('00000000-0000-7000-8000-00000000e100', '00000000-0000-7000-8000-00000000f102', 'title', 'title', 'claude-haiku-4-5', '/v1/messages');
INSERT INTO ai_request_attempts (request_id, attempt, duration_ms, http_status) VALUES
  ('00000000-0000-7000-8000-00000000e100', 1, 10, 200);
UPDATE ai_requests SET status = 'ok', http_status = 200, finished_at = clock_timestamp(), input_tokens = 3
 WHERE id = '00000000-0000-7000-8000-00000000e100';
SELECT results_eq($$SELECT status, attempts FROM ai_requests WHERE id = '00000000-0000-7000-8000-00000000e100'$$,
                  $$VALUES ('ok', 1)$$, 'app registra a requisição, a tentativa e o fim');
INSERT INTO ai_usage (provider_id, model, purpose, request_id, input_tokens) VALUES
  ('00000000-0000-7000-8000-00000000f102', 'claude-haiku-4-5', 'title', '00000000-0000-7000-8000-00000000e100', 3);
SELECT is((SELECT count(*)::int FROM ai_provider_health(7, '00000000-0000-7000-8000-00000000f102')), 1, 'app lê a saúde');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name IN ('ai_requests', 'ai_request_attempts')), 0,
          'requisições e tentativas fora da auditoria');

SELECT * FROM finish();
ROLLBACK;
