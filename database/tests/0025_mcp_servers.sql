-- Testes de 0025_mcp_servers: servidores MCP (cabeçalhos blindados), vínculos com agentes e a visão efetiva.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['mcp_servers', 'agent_mcp_servers']) t;
SELECT has_view('effective_agent_mcp_servers');
SELECT has_function('mcp_server_merge_headers', ARRAY['uuid', 'jsonb', 'text[]']);
SELECT has_function('admin_mcp_server_headers', ARRAY['uuid', 'uuid']);
SELECT fk_ok('agent_mcp_servers', 'agent_id', 'ai_agents', 'id');
SELECT fk_ok('agent_mcp_servers', 'mcp_server_id', 'mcp_servers', 'id');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' é SECURITY DEFINER')
  FROM unnest(ARRAY['mcp_server_merge_headers(uuid, jsonb, text[])', 'admin_mcp_server_headers(uuid, uuid)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['mcp_server_merge_headers(uuid, jsonb, text[])', 'admin_mcp_server_headers(uuid, uuid)']) f;

-- Dados base
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000a1001', 'Claude', 'anthropic', 'sk-ant-api03-abcdefgh');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000a3001', 'Assistente', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5'),
  ('00000000-0000-7000-8000-0000000a3002', 'Fiscal', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5');

-- Cabeçalhos ----------------------------------------------------------------------------------------------------
SELECT ok(mcp_headers_valid(h::jsonb), 'cabeçalhos válidos: ' || h)
  FROM unnest(ARRAY['{}', '{"Authorization": "Bearer abc"}', '{"X-Api-Key": "k", "X-Org": "1"}']) h;
SELECT ok(NOT mcp_headers_valid(h::jsonb), 'cabeçalhos inválidos: ' || h)
  FROM unnest(ARRAY['[]', '{"Authorization": 1}', '{"Com espaço": "x"}', '{"X-A": "linha\nquebrada"}',
                    '{"Host": "evil"}', '{"content-type": "x"}', '{"Mcp-Session-Id": "x"}',
                    '{"Authorization": "a", "authorization": "b"}']) h;

INSERT INTO mcp_servers (id, name, url, secret_headers, visibility) VALUES
  ('00000000-0000-7000-8000-0000000c1001', 'GitHub', 'https://api.githubcopilot.com/mcp/',
   '{"Authorization": "Bearer ghp_SEGREDO123", "X-Org": "tm"}', 'public'),
  ('00000000-0000-7000-8000-0000000c1002', 'Docs', 'https://docs.example.com/mcp', '{}', 'global'),
  ('00000000-0000-7000-8000-0000000c1003', 'Interno', 'http://interno:8080/mcp', '{"X-Api-Key": "SEGREDO-int"}', 'private');

SELECT is((SELECT secret_header_names FROM mcp_servers WHERE id = '00000000-0000-7000-8000-0000000c1001'),
          ARRAY['Authorization', 'X-Org'], 'só os nomes dos cabeçalhos ficam visíveis');
SELECT throws_ok($$INSERT INTO mcp_servers (name, url) VALUES ('github', 'https://x.example.com/mcp')$$, '23505', NULL, 'nome único');
SELECT throws_ok($$INSERT INTO mcp_servers (name, url) VALUES ('stdio', 'npx some-server')$$, '23514', NULL, 'só URL http(s)');
SELECT throws_ok($$INSERT INTO mcp_servers (name, url, visibility) VALUES ('Vis', 'https://x.example.com', 'secret')$$, '23514', NULL,
                 'visibilidade global|public|private');
SELECT throws_ok($$INSERT INTO mcp_servers (name, url, secret_headers) VALUES ('Hdr', 'https://x.example.com', '{"Host": "x"}')$$,
                 '23514', NULL, 'cabeçalhos validados');
SELECT throws_ok($$UPDATE mcp_servers SET tools_cache = '[]' WHERE id = '00000000-0000-7000-8000-0000000c1001'$$, '23514', NULL,
                 'cache exige a data');

-- Troca parcial e leitura pelo admin
SELECT is(mcp_server_merge_headers('00000000-0000-7000-8000-0000000c1001', '{"authorization": "Bearer ghp_NOVO456"}', '{x-org}'),
          ARRAY['authorization'], 'merge: redefine sem distinção de maiúsculas e remove');
SELECT is(admin_mcp_server_headers('00000000-0000-7000-8000-0000000c1001', '00000000-0000-7000-8000-0000000000a1'),
          '{"authorization": "Bearer ghp_NOVO456"}'::jsonb, 'admin lê os cabeçalhos');
SELECT is(mcp_server_merge_headers('00000000-0000-7000-8000-0000000c1001', '{"X-Extra": "1"}'),
          ARRAY['authorization', 'X-Extra'], 'merge: acrescenta mantendo os outros');
SELECT throws_ok($$SELECT mcp_server_merge_headers('00000000-0000-7000-8000-0000000c1001', '{"Host": "x"}')$$, '23514', NULL,
                 'merge: resultado validado');
SELECT throws_ok($$SELECT mcp_server_merge_headers('00000000-0000-7000-8000-0000000c1001', '[]')$$, '22023', NULL,
                 'merge: p_set é objeto');
SELECT throws_ok($$SELECT mcp_server_merge_headers('00000000-0000-7000-8000-0000000c1fff', '{}')$$, 'P0002', NULL,
                 'merge: servidor inexistente');
SELECT throws_ok($$SELECT admin_mcp_server_headers('00000000-0000-7000-8000-0000000c1001', '00000000-0000-7000-8000-0000000000a2')$$,
                 '42501', NULL, 'não admin: 42501');
SELECT throws_ok($$SELECT admin_mcp_server_headers('00000000-0000-7000-8000-0000000c1fff', '00000000-0000-7000-8000-0000000000a1')$$,
                 'P0002', NULL, 'servidor inexistente: P0002');

-- Blindagem
SELECT ok(NOT has_column_privilege('moneyflow_app', 'mcp_servers', 'secret_headers', 'SELECT'), 'app não lê secret_headers');
SELECT ok(has_column_privilege('moneyflow_app', 'mcp_servers', 'secret_headers', 'INSERT'), 'app grava secret_headers');
SELECT ok(has_column_privilege('moneyflow_app', 'mcp_servers', 'secret_headers', 'UPDATE'), 'app troca secret_headers');
SELECT is_empty($$
  SELECT a.attname FROM pg_attribute a
   WHERE a.attrelid = 'mcp_servers'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'secret_headers'
     AND NOT has_column_privilege('moneyflow_app', 'mcp_servers', a.attname, 'SELECT')
$$, 'app lê todas as colunas menos os cabeçalhos');

-- Vínculos e visão efetiva ---------------------------------------------------------------------------------------
UPDATE mcp_servers SET tools_cache = '[{"name": "search_code"}, {"name": "create_issue"}, {"name": "list_prs"}]',
                       tools_cached_at = now()
 WHERE id = '00000000-0000-7000-8000-0000000c1001';
INSERT INTO agent_mcp_servers (agent_id, mcp_server_id, enabled_tools) VALUES
  ('00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000c1001', '{list_prs,search_code}'),
  ('00000000-0000-7000-8000-0000000a3002', '00000000-0000-7000-8000-0000000c1003', NULL);
SELECT throws_ok($$INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES
                   ('00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000c1001')$$, '23505', NULL,
                 'um vínculo por agente e servidor');
SELECT throws_ok($$INSERT INTO agent_mcp_servers (agent_id, mcp_server_id, enabled_tools) VALUES
                   ('00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000c1003', '{a,a}')$$, '23514', NULL,
                 'tools do vínculo validadas');

SELECT results_eq($$SELECT agent_id, mcp_server_id, visibility, linked FROM effective_agent_mcp_servers ORDER BY 1, 2$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000a3001'::uuid, '00000000-0000-7000-8000-0000000c1001'::uuid, 'public', true),
                           ('00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000c1002', 'global', false),
                           ('00000000-0000-7000-8000-0000000a3002', '00000000-0000-7000-8000-0000000c1002', 'global', false),
                           ('00000000-0000-7000-8000-0000000a3002', '00000000-0000-7000-8000-0000000c1003', 'private', true)$$,
                  'global em todos; public e private só vinculados');
SELECT is((SELECT tools FROM effective_agent_mcp_servers
            WHERE agent_id = '00000000-0000-7000-8000-0000000a3001' AND mcp_server_id = '00000000-0000-7000-8000-0000000c1001'),
          '[{"name": "search_code"}, {"name": "list_prs"}]'::jsonb, 'tools do cache filtradas pelo vínculo, na ordem do cache');
UPDATE mcp_servers SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000c1002';
SELECT is((SELECT count(*)::int FROM effective_agent_mcp_servers WHERE mcp_server_id = '00000000-0000-7000-8000-0000000c1002'), 0,
          'servidor inativo sai de todos');

-- Auditoria -------------------------------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = t), t || ' é auditada')
  FROM unnest(ARRAY['mcp_servers', 'agent_mcp_servers']) t;
SELECT is_empty($$SELECT 1 FROM audit_log WHERE table_name = 'mcp_servers'
                    AND (old_data ? 'secret_headers' OR new_data ? 'secret_headers'
                         OR coalesce(old_data::text, '') LIKE '%SEGREDO%' OR coalesce(new_data::text, '') LIKE '%ghp_%')$$,
                'os cabeçalhos nunca vão para o audit_log');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'mcp_servers' AND changed_columns @> ARRAY['secret_headers']),
          'a troca de cabeçalhos aparece em changed_columns');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'mcp_servers' AND changed_columns && ARRAY['tools_cache']), 0,
          'atualizar o cache de tools não gera linha');

-- O papel da aplicação ------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT throws_ok($$SELECT secret_headers FROM mcp_servers$$, '42501', NULL, 'app: SELECT dos cabeçalhos negado');
SELECT lives_ok($$SELECT id, name, url, secret_header_names, tools_cache FROM mcp_servers$$, 'app: colunas públicas');
SELECT lives_ok($$SELECT * FROM effective_agent_mcp_servers$$, 'app: lê a visão efetiva');
SELECT is(mcp_server_merge_headers('00000000-0000-7000-8000-0000000c1003', '{"X-Api-Key": "novo-valor"}'),
          ARRAY['X-Api-Key'], 'app: troca um cabeçalho sem ler');
SELECT throws_ok($$UPDATE mcp_servers SET secret_headers = secret_headers || '{"A": "b"}' WHERE id = '00000000-0000-7000-8000-0000000c1003'$$,
                 '42501', NULL, 'app: não lê o valor atual nem num UPDATE');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
