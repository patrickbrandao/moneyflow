-- Testes de 0002_users: usuários, sessões e blindagem da senha.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('users');
SELECT has_table('sessions');
SELECT columns_are('users', ARRAY['id', 'username', 'email', 'password', 'role', 'is_active',
                                  'last_login_at', 'created_at', 'updated_at']);
SELECT columns_are('sessions', ARRAY['id', 'user_id', 'expires_at', 'created_at', 'last_seen_at',
                                     'ip', 'user_agent']);
SELECT col_type_is('users', 'username', 'citext');
SELECT col_type_is('users', 'email', 'citext');
SELECT col_not_null('users', 'password');
SELECT col_type_is('sessions', 'ip', 'inet');
SELECT has_pk('users');
SELECT has_pk('sessions');
SELECT fk_ok('sessions', 'user_id', 'users', 'id');
SELECT has_index('sessions', 'sessions_user_id_idx');
SELECT has_index('sessions', 'sessions_expires_at_idx');
SELECT has_trigger('users', 'users_set_updated_at');
SELECT has_trigger('users', 'users_revoke_sessions_on_deactivate');
SELECT is_definer('auth_login', ARRAY['text', 'text']);
SELECT is_definer('admin_reveal_password', ARRAY['uuid', 'uuid']);

-- Dados de teste
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-000000000001', 'admin', 'admin@example.com', 'adm-secret', 'admin'),
  ('00000000-0000-7000-8000-000000000002', 'Maria', 'Maria@Example.com', 'Segredo#1', 'user'),
  ('00000000-0000-7000-8000-000000000003', 'joao', 'joao@example.com', 'joao-pw', 'user');

SELECT is((SELECT role FROM users WHERE username = 'joao'), 'user', 'role padrão é user');
SELECT is((SELECT is_active FROM users WHERE username = 'joao'), true, 'is_active padrão é true');

-- Unicidade sem distinção de maiúsculas
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('MARIA', 'outra@example.com', 'x')$$,
                 '23505', NULL, 'username é único sem distinção de maiúsculas');
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('outra', 'maria@EXAMPLE.com', 'x')$$,
                 '23505', NULL, 'email é único sem distinção de maiúsculas');

-- CHECKs
SELECT throws_ok($$INSERT INTO users (username, email, password, role) VALUES ('x1x', 'x1@example.com', 'x', 'root')$$,
                 '23514', NULL, 'role só admin|user');
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('a@b.com', 'x2@example.com', 'x')$$,
                 '23514', NULL, 'username não pode conter @');
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('ab', 'x3@example.com', 'x')$$,
                 '23514', NULL, 'username tem ao menos 3 caracteres');
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('com espaco', 'x4@example.com', 'x')$$,
                 '23514', NULL, 'username não tem espaços');
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('x5x', 'sem-arroba', 'x')$$,
                 '23514', NULL, 'email precisa ter formato de email');
SELECT throws_ok($$INSERT INTO users (username, email, password) VALUES ('x6x', 'x6@example.com', '')$$,
                 '23514', NULL, 'senha não pode ser vazia');
SELECT throws_ok($$INSERT INTO users (username, email) VALUES ('x7x', 'x7@example.com')$$,
                 '23502', NULL, 'senha é obrigatória');

-- updated_at
UPDATE users SET updated_at = '2000-01-01', email = 'joao2@example.com' WHERE username = 'joao';
SELECT is((SELECT updated_at FROM users WHERE username = 'joao'), now(), 'updated_at é mantido pelo trigger');

-- Sessões
INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES
  (repeat('a', 64), '00000000-0000-7000-8000-000000000002', now() + interval '30 days', '10.0.0.1', 'test'),
  (repeat('b', 64), '00000000-0000-7000-8000-000000000002', now() + interval '30 days', NULL, NULL),
  (repeat('c', 64), '00000000-0000-7000-8000-000000000003', now() + interval '30 days', NULL, NULL);

SELECT throws_ok($$INSERT INTO sessions (id, user_id, expires_at) VALUES ('curto', '00000000-0000-7000-8000-000000000003', now() + interval '1 day')$$,
                 '23514', NULL, 'id da sessão tem ao menos 32 caracteres');
SELECT throws_ok($$INSERT INTO sessions (id, user_id, expires_at) VALUES (repeat('d', 64), '00000000-0000-7000-8000-000000000003', now() - interval '1 day')$$,
                 '23514', NULL, 'expires_at precisa ser posterior a created_at');
SELECT throws_ok($$INSERT INTO sessions (id, user_id, expires_at) VALUES (repeat('e', 64), '00000000-0000-7000-8000-0000000000ff', now() + interval '1 day')$$,
                 '23503', NULL, 'sessão exige usuário existente');

UPDATE users SET email = 'maria@example.com' WHERE username = 'maria';
SELECT is((SELECT count(*)::int FROM sessions WHERE user_id = '00000000-0000-7000-8000-000000000002'), 2,
          'atualizar outros campos não mexe nas sessões');
UPDATE users SET is_active = false WHERE username = 'maria';
SELECT is((SELECT count(*)::int FROM sessions WHERE user_id = '00000000-0000-7000-8000-000000000002'), 0,
          'desativar o usuário apaga as sessões dele');
SELECT is((SELECT count(*)::int FROM sessions WHERE user_id = '00000000-0000-7000-8000-000000000003'), 1,
          'sessões de outros usuários continuam');
UPDATE users SET is_active = true WHERE username = 'maria';

DELETE FROM users WHERE username = 'joao';
SELECT is((SELECT count(*)::int FROM sessions), 0, 'excluir o usuário apaga as sessões (CASCADE)');

-- Privilégios do moneyflow_app sobre users
SELECT ok(NOT has_column_privilege('moneyflow_app', 'users', 'password', 'SELECT'), 'app não tem SELECT em users.password');
SELECT ok(has_column_privilege('moneyflow_app', 'users', 'password', 'INSERT'), 'app tem INSERT em users.password');
SELECT ok(has_column_privilege('moneyflow_app', 'users', 'password', 'UPDATE'), 'app tem UPDATE em users.password');
SELECT ok(has_column_privilege('moneyflow_app', 'users', 'username', 'SELECT'), 'app tem SELECT em users.username');
SELECT ok(NOT has_table_privilege('moneyflow_app', 'users', 'SELECT'), 'app não tem SELECT na tabela users inteira');
SELECT ok(has_table_privilege('moneyflow_app', 'users', 'DELETE'), 'app pode excluir usuários');
SELECT table_privs_are('sessions', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
SELECT ok(NOT has_function_privilege('public', 'auth_login(text, text)', 'EXECUTE'), 'PUBLIC não executa auth_login');
SELECT ok(NOT has_function_privilege('public', 'admin_reveal_password(uuid, uuid)', 'EXECUTE'), 'PUBLIC não executa admin_reveal_password');

-- Como a aplicação ----------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;

SELECT throws_ok('SELECT password FROM users', '42501', NULL, 'app: SELECT password falha');
SELECT throws_ok('SELECT * FROM users', '42501', NULL, 'app: SELECT * em users falha');
SELECT throws_ok($$UPDATE users SET is_active = is_active RETURNING password$$, '42501', NULL,
                 'app: RETURNING password falha');
SELECT lives_ok($$SELECT id, username, email, role, is_active, last_login_at, created_at, updated_at FROM users$$,
                'app: SELECT das colunas públicas funciona');
SELECT lives_ok($$INSERT INTO users (username, email, password) VALUES ('novo', 'novo@example.com', 'pw-novo') RETURNING id$$,
                'app: cria usuário com senha');
SELECT lives_ok($$UPDATE users SET password = 'pw-trocada' WHERE username = 'novo'$$,
                'app: troca a senha');

SELECT is(auth_login('admin', 'adm-secret'), '00000000-0000-7000-8000-000000000001'::uuid, 'auth_login por username');
SELECT is(auth_login('ADMIN@example.COM', 'adm-secret'), '00000000-0000-7000-8000-000000000001'::uuid,
          'auth_login por email sem distinção de maiúsculas');
SELECT is(auth_login('MARIA', 'Segredo#1'), '00000000-0000-7000-8000-000000000002'::uuid,
          'auth_login por username sem distinção de maiúsculas');
SELECT is(auth_login('novo', 'pw-trocada'), (SELECT id FROM users WHERE username = 'novo'), 'auth_login com a senha trocada');
SELECT is(auth_login('novo', 'pw-novo'), NULL, 'auth_login com a senha antiga falha');
SELECT is(auth_login('maria', 'segredo#1'), NULL, 'a senha distingue maiúsculas');
SELECT is(auth_login('ninguem', 'x'), NULL, 'auth_login de usuário inexistente devolve NULL');
SELECT ok((SELECT last_login_at FROM users WHERE username = 'admin') IS NOT NULL, 'auth_login atualiza last_login_at');

SELECT is(admin_reveal_password('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001'),
          'Segredo#1', 'admin ativo revela a senha');
SELECT throws_ok($$SELECT admin_reveal_password('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002')$$,
                 '42501', NULL, 'usuário comum não revela senha');
SELECT throws_ok($$SELECT admin_reveal_password('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-0000000000ff')$$,
                 '42501', NULL, 'actor inexistente não revela senha');
SELECT throws_ok($$SELECT admin_reveal_password('00000000-0000-7000-8000-0000000000ff', '00000000-0000-7000-8000-000000000001')$$,
                 'P0002', NULL, 'alvo inexistente dá erro');

UPDATE users SET is_active = false WHERE username = 'maria';
SELECT is(auth_login('maria', 'Segredo#1'), NULL, 'usuário inativo não autentica');

RESET ROLE;
UPDATE users SET is_active = false WHERE username = 'admin';
SET LOCAL ROLE moneyflow_app;
SELECT throws_ok($$SELECT admin_reveal_password('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001')$$,
                 '42501', NULL, 'admin inativo não revela senha');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
