-- Testes de 0028_user_api_tokens: tokens pessoais (só o hash, blindado), autenticação e auditoria.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_table('user_api_tokens');
SELECT has_function('api_token_authenticate', ARRAY['text', 'inet']);
SELECT fk_ok('user_api_tokens', 'user_id', 'users', 'id');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'api_token_authenticate(text, inet)'::regprocedure), 'SECURITY DEFINER');
SELECT ok(has_function_privilege('moneyflow_app', 'api_token_authenticate(text, inet)', 'EXECUTE'), 'app executa');
SELECT ok(NOT has_function_privilege('public', 'api_token_authenticate(text, inet)', 'EXECUTE'), 'PUBLIC não executa');
SELECT ok(NOT has_column_privilege('moneyflow_app', 'user_api_tokens', 'token_hash', 'SELECT'), 'app não lê o hash');
SELECT ok(has_column_privilege('moneyflow_app', 'user_api_tokens', 'token_hash', 'INSERT'), 'app grava o hash');
SELECT is_empty($$
  SELECT a.attname FROM pg_attribute a
   WHERE a.attrelid = 'user_api_tokens'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'token_hash'
     AND NOT has_column_privilege('moneyflow_app', 'user_api_tokens', a.attname, 'SELECT')
$$, 'app lê todas as colunas menos o hash');

INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user');

-- Token "mf_bia_token_1" e "mf_bia_token_2" (o app guarda só o SHA-256)
INSERT INTO user_api_tokens (id, user_id, name, token_hash, token_prefix) VALUES
  ('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000000a2', 'Claude Desktop',
   encode(sha256('mf_bia_token_1'::bytea), 'hex'), 'mf_bia');
INSERT INTO user_api_tokens (id, user_id, name, token_hash, token_prefix, created_at, expires_at) VALUES
  ('00000000-0000-7000-8000-0000000d0002', '00000000-0000-7000-8000-0000000000a2', 'Expirado',
   encode(sha256('mf_bia_token_2'::bytea), 'hex'), 'mf_bia', now() - interval '2 days', now() - interval '1 day');

SELECT results_eq($$SELECT user_id, token_id FROM api_token_authenticate(encode(sha256('mf_bia_token_1'::bytea), 'hex'), '10.0.0.1')$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000000a2'::uuid, '00000000-0000-7000-8000-0000000d0001'::uuid)$$,
                  'autentica pelo hash');
SELECT results_eq($$SELECT last_used_at IS NOT NULL, last_used_ip FROM user_api_tokens WHERE id = '00000000-0000-7000-8000-0000000d0001'$$,
                  $$VALUES (true, '10.0.0.1'::inet)$$, 'registra o uso');
SELECT is((SELECT user_id FROM api_token_authenticate(upper(encode(sha256('mf_bia_token_1'::bytea), 'hex')))),
          '00000000-0000-7000-8000-0000000000a2'::uuid, 'hash em maiúsculas também');
SELECT is_empty($$SELECT * FROM api_token_authenticate(encode(sha256('outro'::bytea), 'hex'))$$, 'token desconhecido: nada');
SELECT is_empty($$SELECT * FROM api_token_authenticate(NULL)$$, 'nulo: nada');
SELECT is_empty($$SELECT * FROM api_token_authenticate(encode(sha256('mf_bia_token_2'::bytea), 'hex'))$$, 'expirado: nada');

SELECT throws_ok($$INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', 'claude desktop', repeat('a', 64), 'mf_x')$$, '23505', NULL,
                 'nome único entre os válidos');
SELECT throws_ok($$INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', 'Hash ruim', 'mf_token_em_claro', 'mf_x')$$, '23514', NULL,
                 'só hash SHA-256 em hex');
SELECT throws_ok($$INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', 'Repetido', encode(sha256('mf_bia_token_1'::bytea), 'hex'), 'mf_x')$$,
                 '23505', NULL, 'hash único');
SELECT throws_ok($$INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', 'Prefixo', repeat('b', 64), 'mf')$$, '23514', NULL, 'prefixo 4–16');
SELECT throws_ok($$UPDATE user_api_tokens SET token_hash = repeat('c', 64) WHERE id = '00000000-0000-7000-8000-0000000d0001'$$,
                 '23514', NULL, 'hash imutável');

-- Usuário desativado não autentica; revogado também não (e é irreversível)
UPDATE users SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000000a2';
SELECT is_empty($$SELECT * FROM api_token_authenticate(encode(sha256('mf_bia_token_1'::bytea), 'hex'))$$, 'usuário inativo: nada');
UPDATE users SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000000a2';
UPDATE user_api_tokens SET revoked_at = now() WHERE id = '00000000-0000-7000-8000-0000000d0001';
SELECT is_empty($$SELECT * FROM api_token_authenticate(encode(sha256('mf_bia_token_1'::bytea), 'hex'))$$, 'revogado: nada');
SELECT throws_ok($$UPDATE user_api_tokens SET revoked_at = NULL WHERE id = '00000000-0000-7000-8000-0000000d0001'$$, '23514', NULL,
                 'revogação irreversível');
SELECT lives_ok($$INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES
                  ('00000000-0000-7000-8000-0000000000a2', 'Claude Desktop', repeat('d', 64), 'mf_novo')$$,
                'nome livre de novo depois de revogar');

-- Auditoria sem o hash; uso não gera linha
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'user_api_tokens'), 'tokens são auditados');
SELECT is_empty($$SELECT 1 FROM audit_log WHERE table_name = 'user_api_tokens' AND (old_data ? 'token_hash' OR new_data ? 'token_hash')$$,
                'o hash nunca vai para o audit_log');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'user_api_tokens' AND changed_columns && ARRAY['last_used_at']), 0,
          'o uso sozinho não gera linha');

-- O papel da aplicação
SET LOCAL ROLE moneyflow_app;
SELECT throws_ok($$SELECT token_hash FROM user_api_tokens$$, '42501', NULL, 'app: SELECT do hash negado');
SELECT lives_ok($$SELECT id, name, token_prefix, last_used_at FROM user_api_tokens$$, 'app: colunas públicas');
SELECT lives_ok($$INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES
                  ('00000000-0000-7000-8000-0000000000a2', 'CLI', encode(sha256('mf_cli'::bytea), 'hex'), 'mf_cli')$$, 'app: cria');
SELECT is((SELECT user_id FROM api_token_authenticate(encode(sha256('mf_cli'::bytea), 'hex'))),
          '00000000-0000-7000-8000-0000000000a2'::uuid, 'app: autentica');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
