-- Testes de 0031_backup_functions: leitores de segredos do admin para o backup e a versão do schema.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_function('admin_message_destination_token', ARRAY['uuid', 'uuid']);
SELECT has_function('admin_api_token_hash', ARRAY['uuid', 'uuid']);
SELECT has_function('app_schema_version', ARRAY[]::text[]);
SELECT function_returns('admin_message_destination_token', ARRAY['uuid', 'uuid'], 'text');
SELECT function_returns('admin_api_token_hash', ARRAY['uuid', 'uuid'], 'text');
SELECT function_returns('app_schema_version', ARRAY[]::text[], 'text');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' é SECURITY DEFINER')
  FROM unnest(ARRAY['admin_message_destination_token(uuid, uuid)', 'admin_api_token_hash(uuid, uuid)',
                    'app_schema_version()']) f;
SELECT ok((SELECT proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'] FROM pg_proc WHERE oid = f::regprocedure),
          f || ' tem search_path fixo')
  FROM unnest(ARRAY['admin_message_destination_token(uuid, uuid)', 'admin_api_token_hash(uuid, uuid)',
                    'app_schema_version()']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['admin_message_destination_token(uuid, uuid)', 'admin_api_token_hash(uuid, uuid)',
                    'app_schema_version()']) f;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'moneyflow_app executa ' || f)
  FROM unnest(ARRAY['admin_message_destination_token(uuid, uuid)', 'admin_api_token_hash(uuid, uuid)',
                    'app_schema_version()']) f;

-- Dados base
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin', true),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000000a3', 'caio', 'caio@example.com', 'segredo', 'admin', false);
INSERT INTO message_destinations (id, name, owner_user_id, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000de001', 'Meu Telegram', '00000000-0000-7000-8000-0000000000a2',
   '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '987654321');
INSERT INTO user_api_tokens (id, user_id, name, token_hash, token_prefix) VALUES
  ('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000000a2', 'Claude Desktop',
   encode(sha256('mf_bia_token_1'::bytea), 'hex'), 'mf_bia');

-- Pelo papel da aplicação
SET LOCAL ROLE moneyflow_app;

SELECT is(admin_message_destination_token('00000000-0000-7000-8000-0000000de001', '00000000-0000-7000-8000-0000000000a1'),
          '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'admin lê o bot token');
SELECT throws_ok($$SELECT admin_message_destination_token('00000000-0000-7000-8000-0000000de001', '00000000-0000-7000-8000-0000000000a2')$$,
                 '42501', NULL, 'bot token: não admin, 42501');
SELECT throws_ok($$SELECT admin_message_destination_token('00000000-0000-7000-8000-0000000de001', '00000000-0000-7000-8000-0000000000a3')$$,
                 '42501', NULL, 'bot token: admin inativo, 42501');
SELECT throws_ok($$SELECT admin_message_destination_token('00000000-0000-7000-8000-0000000de001', '00000000-0000-7000-8000-0000000000ff')$$,
                 '42501', NULL, 'bot token: ator inexistente, 42501');
SELECT throws_ok($$SELECT admin_message_destination_token('00000000-0000-7000-8000-0000000defff', '00000000-0000-7000-8000-0000000000a1')$$,
                 'P0002', NULL, 'bot token: destino inexistente, P0002');
SELECT throws_ok($$SELECT admin_message_destination_token('00000000-0000-7000-8000-0000000defff', '00000000-0000-7000-8000-0000000000a2')$$,
                 '42501', NULL, 'bot token: não admin não descobre se o destino existe');

SELECT is(admin_api_token_hash('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000000a1'),
          encode(sha256('mf_bia_token_1'::bytea), 'hex'), 'admin lê o hash do token');
SELECT throws_ok($$SELECT admin_api_token_hash('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000000a2')$$,
                 '42501', NULL, 'hash: não admin (nem o dono do token), 42501');
SELECT throws_ok($$SELECT admin_api_token_hash('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000000a3')$$,
                 '42501', NULL, 'hash: admin inativo, 42501');
SELECT throws_ok($$SELECT admin_api_token_hash('00000000-0000-7000-8000-0000000d0fff', '00000000-0000-7000-8000-0000000000a1')$$,
                 'P0002', NULL, 'hash: token inexistente, P0002');

-- Versão do schema: a última migration do dbmate, sem SELECT direto do papel da aplicação
SELECT ok(NOT has_table_privilege('moneyflow_app', 'public.schema_migrations', 'SELECT'),
          'moneyflow_app não lê schema_migrations');
SELECT throws_ok($$SELECT version FROM schema_migrations$$, '42501', NULL, 'app: SELECT direto negado');
SELECT ok(app_schema_version() >= '0031', 'versão do schema é a última migration (>= 0031)');

RESET ROLE;
SELECT is(app_schema_version(), (SELECT max(version)::text FROM schema_migrations), 'versão = max(version)');

-- Sem a tabela do dbmate (banco migrado por outro meio): NULL, sem erro
ALTER TABLE schema_migrations RENAME TO schema_migrations_hidden;
SET LOCAL ROLE moneyflow_app;
SELECT is(app_schema_version(), NULL, 'sem schema_migrations: NULL');
RESET ROLE;
ALTER TABLE schema_migrations_hidden RENAME TO schema_migrations;

SELECT * FROM finish();
ROLLBACK;
