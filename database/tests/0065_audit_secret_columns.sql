-- Testes de 0065_audit_secret_columns (tarefa 159): os segredos saem do audit_log em audit_write, para qualquer trigger
-- de auditoria; toda coluna auditada que a aplicação não lê está na lista; e os caches do MCP ficam fora do corpo.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000065' || p)::uuid $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('audit_secret_columns', ARRAY[]::text[]);
SELECT is((SELECT provolatile::text FROM pg_proc WHERE proname = 'audit_secret_columns'), 'i', 'a lista é IMMUTABLE');
SELECT is(audit_secret_columns(),
          ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash', 'webhook_secret_hash', 'code_hash'],
          'os segredos de hoje');
SELECT ok(NOT has_function_privilege('public', 'audit_secret_columns()', 'EXECUTE'), 'PUBLIC não executa a lista');
SELECT ok(NOT has_function_privilege('moneyflow_app', 'audit_write(text, text, jsonb, jsonb, text[], uuid)', 'EXECUTE'),
          'a aplicação continua sem audit_write');

-- Só audit_write grava em audit_log: qualquer trigger de auditoria passa pelo corte.
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~* 'insert\s+into\s+(public\.)?audit_log\M'),
          ARRAY['audit_write'], 'só audit_write insere em audit_log');

-- Toda coluna que a aplicação não lê (o segredo blindado por coluna) de uma tabela auditada está na lista.
SELECT is((SELECT array_agg(DISTINCT c.relname || '.' || a.attname ORDER BY c.relname || '.' || a.attname)
             FROM pg_trigger tg
             JOIN pg_proc p ON p.oid = tg.tgfoid
             JOIN pg_class c ON c.oid = tg.tgrelid
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE NOT tg.tgisinternal AND p.prosrc ~ 'audit_write\('
              AND c.relnamespace = 'public'::regnamespace
              AND NOT has_column_privilege('moneyflow_app', c.oid, a.attnum, 'SELECT')
              AND a.attname <> ALL (audit_secret_columns())),
          NULL, 'nenhuma coluna sem SELECT para a aplicação fica fora da lista de segredos');
SELECT ok((SELECT count(*) FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
            WHERE NOT tg.tgisinternal AND p.prosrc ~ 'audit_write\(') > 50, 'a conferência percorre os triggers de auditoria');

-- audit_write direto: o corte vale para qualquer chamador -----------------------------------------------------------------
SELECT audit_write('teste_0065', 'update', jsonb_build_object('id', pg_temp.u('0001'), 'name', 'a', 'api_key', 'velha'),
                   jsonb_build_object('id', pg_temp.u('0001'), 'name', 'b', 'api_key', 'nova', 'token_hash', 'h'),
                   ARRAY['api_key', 'name', 'token_hash']);
SELECT results_eq($$SELECT old_data, new_data, changed_columns FROM audit_log WHERE table_name = 'teste_0065'$$,
                  $$VALUES (jsonb_build_object('id', pg_temp.u('0001'), 'name', 'a'),
                            jsonb_build_object('id', pg_temp.u('0001'), 'name', 'b'),
                            ARRAY['api_key', 'name', 'token_hash'])$$,
                  'audit_write tira os segredos do antes e do depois; a troca fica em changed_columns');

-- O roteiro da tarefa: tabela com api_key auditada por audit_row_keyed (um trigger próprio) -------------------------------
CREATE TEMP TABLE segredo_0065 (id uuid PRIMARY KEY, name text, api_key text, updated_at timestamptz DEFAULT now());
CREATE TRIGGER segredo_0065_audit AFTER INSERT OR UPDATE OR DELETE ON segredo_0065
  FOR EACH ROW EXECUTE FUNCTION audit_row_keyed('id');
INSERT INTO segredo_0065 (id, name, api_key) VALUES (pg_temp.u('0002'), 'x', 'sk-SEGREDO');
UPDATE segredo_0065 SET api_key = 'sk-OUTRO' WHERE id = pg_temp.u('0002');
DELETE FROM segredo_0065;
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'segredo_0065'), 3, 'insert, update e delete gravados');
SELECT is((SELECT count(*)::int FROM audit_log
            WHERE table_name = 'segredo_0065' AND (old_data ? 'api_key' OR new_data ? 'api_key')), 0,
          'audit_row_keyed não grava o api_key');
SELECT is((SELECT changed_columns FROM audit_log WHERE table_name = 'segredo_0065' AND action = 'update'),
          ARRAY['api_key'], 'a troca do segredo aparece só pelo nome');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'segredo_0065'
            AND (old_data::text LIKE '%SEGREDO%' OR new_data::text LIKE '%SEGREDO%' OR new_data::text LIKE '%OUTRO%'
                 OR old_data::text LIKE '%OUTRO%')), 0, 'o valor não aparece em lugar nenhum');

-- audit_row() continua tirando os segredos ---------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES (pg_temp.u('0a01'), 'ana65', 'ana65@example.com', 'segredo-65', 'admin');
UPDATE users SET password = 'outra-65', role = 'user' WHERE id = pg_temp.u('0a01');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'users' AND record_id = pg_temp.u('0a01')
            AND (old_data ? 'password' OR new_data ? 'password')), 0, 'users: a senha fica fora');

-- mcp_servers: os caches ficam fora do corpo --------------------------------------------------------------------------------
SELECT matches((SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'mcp_servers_audit'),
               $re$audit_row\('tools_cache,tools_cached_at,tools_error,instructions_cache', 'tools_cache,instructions_cache'\)$re$,
               'o trigger de mcp_servers leva as colunas silenciosas e as volumosas');

INSERT INTO mcp_servers (id, name, url, secret_headers, visibility) VALUES
  (pg_temp.u('0c01'), 'Docs65', 'https://docs65.example.com/mcp', '{"X-Api-Key": "SEGREDO-65"}', 'global');
UPDATE mcp_servers SET tools_cache = '[{"name": "busca"}]', tools_cached_at = now(), instructions_cache = repeat('i', 500)
 WHERE id = pg_temp.u('0c01');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'mcp_servers' AND record_id = pg_temp.u('0c01')), 1,
          'só o cache mudou: nenhuma linha nova (continua silencioso)');
UPDATE mcp_servers SET name = 'Docs 65' WHERE id = pg_temp.u('0c01');
SELECT results_eq($$SELECT changed_columns, old_data ? 'tools_cache', new_data ? 'tools_cache',
                           old_data ? 'instructions_cache', new_data ? 'instructions_cache',
                           old_data ->> 'name', new_data ->> 'name', new_data ? 'tools_cached_at'
                      FROM audit_log WHERE table_name = 'mcp_servers' AND record_id = pg_temp.u('0c01') AND action = 'update'$$,
                  $$VALUES (ARRAY['name'], false, false, false, false, 'Docs65', 'Docs 65', true)$$,
                  'renomear não grava tools_cache nem instructions_cache no antes e no depois');
UPDATE mcp_servers SET visibility = 'public', tools_cache = '[]' WHERE id = pg_temp.u('0c01');
SELECT results_eq($$SELECT changed_columns, new_data ? 'tools_cache', new_data ->> 'visibility'
                      FROM audit_log WHERE table_name = 'mcp_servers' AND record_id = pg_temp.u('0c01') AND action = 'update'
                     ORDER BY id DESC LIMIT 1$$,
                  $$VALUES (ARRAY['tools_cache', 'visibility'], false, 'public')$$,
                  'o cache que muda junto aparece só em changed_columns');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'mcp_servers' AND record_id = pg_temp.u('0c01')
            AND (old_data ? 'secret_headers' OR new_data ? 'secret_headers')), 0, 'os cabeçalhos secretos continuam fora');
DELETE FROM mcp_servers WHERE id = pg_temp.u('0c01');
SELECT is((SELECT old_data ? 'tools_cache' FROM audit_log
            WHERE table_name = 'mcp_servers' AND record_id = pg_temp.u('0c01') AND action = 'delete'), false,
          'excluir também grava sem o cache');

SELECT * FROM finish();
ROLLBACK;
