-- Testes de 0004_caixas: caixas (geral e cartão), membros e contas financeiras.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('caixas');
SELECT has_table('caixa_members');
SELECT has_table('financial_accounts');
SELECT columns_are('caixas', ARRAY['id', 'name', 'kind', 'holder_entity_id', 'is_primary', 'description',
                                   'default_payer_caixa_id', 'credit_limit_cents', 'closing_day', 'due_day',
                                   'card_last4', 'archived_at', 'created_at', 'updated_at']);
SELECT columns_are('financial_accounts', ARRAY['id', 'caixa_id', 'kind', 'name', 'bank_code', 'ispb', 'branch',
                                               'account_number', 'opening_balance_cents', 'opening_date',
                                               'archived_at', 'created_at', 'updated_at']);
SELECT col_type_is('caixas', 'credit_limit_cents', 'bigint');
SELECT col_type_is('financial_accounts', 'opening_balance_cents', 'bigint');
SELECT fk_ok('caixas', 'holder_entity_id', 'entities', 'id');
SELECT fk_ok('caixas', 'default_payer_caixa_id', 'caixas', 'id');
SELECT fk_ok('caixa_members', 'user_id', 'users', 'id');
SELECT fk_ok('caixa_members', 'caixa_id', 'caixas', 'id');
SELECT fk_ok('financial_accounts', 'caixa_id', 'caixas', 'id');
SELECT has_index('caixas', 'caixas_holder_entity_id_idx');
SELECT has_index('caixas', 'caixas_default_payer_caixa_id_idx');
SELECT has_index('caixas', 'caixas_holder_primary_key');
SELECT has_index('caixa_members', 'caixa_members_caixa_id_idx');
SELECT has_index('financial_accounts', 'financial_accounts_caixa_id_idx');
SELECT has_trigger('caixas', 'caixas_validate');
SELECT has_trigger('financial_accounts', 'financial_accounts_validate');

-- Dados base
INSERT INTO entities (id, kind, name, document) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick', '52998224725'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa', '11222333000181'),
  ('00000000-0000-7000-8000-00000000e003', 'company', 'Nu Pagamentos', '18236120000158');
INSERT INTO users (id, username, email, password) VALUES
  ('00000000-0000-7000-8000-000000000001', 'patrick', 'patrick@example.com', 'x'),
  ('00000000-0000-7000-8000-000000000002', 'maria', 'maria@example.com', 'x');

-- Caixas gerais e principal ------------------------------------------------------------------
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa Cidade', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Casa Praia', 'general', '00000000-0000-7000-8000-00000000e001', false),
  ('00000000-0000-7000-8000-0000000c0003', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true);
SELECT pass('titular com várias caixas, uma principal');

SELECT throws_ok($$UPDATE caixas SET is_primary = true WHERE id = '00000000-0000-7000-8000-0000000c0002'$$,
                 '23505', NULL, 'no máximo uma caixa principal por titular');
SELECT throws_ok($$UPDATE caixas SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000c0001'$$,
                 '23514', NULL, 'caixa principal não pode ser arquivada');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id) VALUES ('X', 'wallet', '00000000-0000-7000-8000-00000000e001')$$,
                 '23514', NULL, 'kind só general|credit_card');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id) VALUES (' ', 'general', '00000000-0000-7000-8000-00000000e001')$$,
                 '23514', NULL, 'nome não pode ser vazio');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, credit_limit_cents) VALUES ('X', 'general', '00000000-0000-7000-8000-00000000e001', 100)$$,
                 '23514', NULL, 'caixa general não tem campos de cartão');
SELECT throws_ok($$DELETE FROM entities WHERE id = '00000000-0000-7000-8000-00000000e002'$$,
                 '23503', NULL, 'titular com caixa não pode ser excluído');

-- Cartão -------------------------------------------------------------------------------------
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
VALUES ('00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', '00000000-0000-7000-8000-00000000e003',
        '00000000-0000-7000-8000-0000000c0003', 2000000, 3, 10, '1234');
SELECT pass('cartão com todos os campos e pagadora general');

SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, credit_limit_cents, closing_day, due_day, card_last4)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', 100, 3, 10, '1234')$$,
                 '23514', NULL, 'cartão exige pagadora padrão');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000c0003', 100, 3, 10)$$,
                 '23514', NULL, 'cartão exige final do cartão');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000c0010', 100, 3, 10, '1234')$$,
                 '23514', 'caixas: default payer 00000000-0000-7000-8000-0000000c0010 must be a general caixa',
                 'pagadora padrão precisa ser caixa general (trigger)');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000c0003', 100, 0, 10, '1234')$$,
                 '23514', NULL, 'dia de fechamento entre 1 e 31');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000c0003', 100, 3, 32, '1234')$$,
                 '23514', NULL, 'dia de vencimento entre 1 e 31');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000c0003', -1, 3, 10, '1234')$$,
                 '23514', NULL, 'limite não negativo');
SELECT throws_ok($$INSERT INTO caixas (name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4)
                   VALUES ('X', 'credit_card', '00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000c0003', 100, 3, 10, '12a4')$$,
                 '23514', NULL, 'final do cartão com 4 dígitos');
SELECT throws_ok($$UPDATE caixas SET default_payer_caixa_id = id WHERE id = '00000000-0000-7000-8000-0000000c0010'$$,
                 '23514', NULL, 'cartão não paga a si mesmo');
SELECT lives_ok($$UPDATE caixas SET default_payer_caixa_id = '00000000-0000-7000-8000-0000000c0001' WHERE id = '00000000-0000-7000-8000-0000000c0010'$$,
                'troca de pagadora padrão para outra caixa general');
SELECT throws_ok($$UPDATE caixas SET kind = 'credit_card', default_payer_caixa_id = '00000000-0000-7000-8000-0000000c0003',
                     credit_limit_cents = 1, closing_day = 1, due_day = 1, card_last4 = '0000'
                   WHERE id = '00000000-0000-7000-8000-0000000c0002'$$,
                 '23514', 'caixas: kind cannot change (caixa 00000000-0000-7000-8000-0000000c0002)', 'kind da caixa é imutável');
SELECT throws_ok($$DELETE FROM caixas WHERE id = '00000000-0000-7000-8000-0000000c0001'$$,
                 '23503', NULL, 'caixa usada como pagadora não pode ser excluída');

-- Membros ------------------------------------------------------------------------------------
INSERT INTO caixa_members (user_id, caixa_id, role) VALUES
  ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-0000000c0001', 'editor'),
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-0000000c0001', 'viewer');
SELECT pass('membros editor e viewer');
SELECT throws_ok($$INSERT INTO caixa_members (user_id, caixa_id, role) VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-0000000c0001', 'viewer')$$,
                 '23505', NULL, 'um papel por usuário e caixa');
SELECT throws_ok($$INSERT INTO caixa_members (user_id, caixa_id, role) VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-0000000c0002', 'owner')$$,
                 '23514', NULL, 'role só editor|viewer');
DELETE FROM users WHERE id = '00000000-0000-7000-8000-000000000002';
SELECT is((SELECT count(*)::int FROM caixa_members), 1, 'excluir o usuário remove os papéis dele');

-- Contas financeiras -------------------------------------------------------------------------
INSERT INTO financial_accounts (id, caixa_id, kind, name, bank_code, ispb, branch, account_number, opening_balance_cents, opening_date) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0003', 'checking', 'Inter PJ', '077', '00416968', '0001', '1234567-8', -50000, '2026-01-01');
INSERT INTO financial_accounts (caixa_id, kind, name, opening_balance_cents, opening_date) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'cash', 'Cofre', 10000, '2026-01-01'),
  ('00000000-0000-7000-8000-0000000c0001', 'savings', 'Poupança', 0, '2026-01-01');
SELECT pass('contas corrente (saldo negativo), cofre e poupança');

SELECT throws_ok($$INSERT INTO financial_accounts (caixa_id, kind, name, opening_date) VALUES ('00000000-0000-7000-8000-0000000c0010', 'checking', 'X', '2026-01-01')$$,
                 '23514', 'financial_accounts: caixa 00000000-0000-7000-8000-0000000c0010 must be a general caixa',
                 'conta só em caixa general (trigger)');
SELECT throws_ok($$UPDATE financial_accounts SET caixa_id = '00000000-0000-7000-8000-0000000c0010' WHERE id = '00000000-0000-7000-8000-0000000a0001'$$,
                 '23514', NULL, 'mover conta para caixa de cartão é bloqueado');
SELECT throws_ok($$INSERT INTO financial_accounts (caixa_id, kind, name, bank_code, opening_date) VALUES ('00000000-0000-7000-8000-0000000c0001', 'cash', 'X', '341', '2026-01-01')$$,
                 '23514', NULL, 'cofre não tem dados bancários');
SELECT throws_ok($$INSERT INTO financial_accounts (caixa_id, kind, name, opening_balance_cents, opening_date) VALUES ('00000000-0000-7000-8000-0000000c0001', 'cash', 'X', -1, '2026-01-01')$$,
                 '23514', NULL, 'cofre não começa negativo');
SELECT throws_ok($$INSERT INTO financial_accounts (caixa_id, kind, name, opening_date) VALUES ('00000000-0000-7000-8000-0000000c0001', 'investment', 'X', '2026-01-01')$$,
                 '23514', NULL, 'kind só checking|cash|savings');
SELECT throws_ok($$INSERT INTO financial_accounts (caixa_id, kind, name) VALUES ('00000000-0000-7000-8000-0000000c0001', 'cash', 'X')$$,
                 '23502', NULL, 'opening_date é obrigatória');
SELECT throws_ok($$INSERT INTO financial_accounts (caixa_id, kind, name, bank_code, opening_date) VALUES ('00000000-0000-7000-8000-0000000c0001', 'checking', 'X', '77', '2026-01-01')$$,
                 '23514', NULL, 'COMPE com 3 dígitos');
SELECT throws_ok($$DELETE FROM caixas WHERE id = '00000000-0000-7000-8000-0000000c0003'$$,
                 '23503', NULL, 'caixa com contas não pode ser excluída');
SELECT lives_ok($$DELETE FROM caixas WHERE id = '00000000-0000-7000-8000-0000000c0002'$$,
                'caixa sem vínculos pode ser excluída');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['caixas', 'caixa_members', 'financial_accounts']) t;

SELECT * FROM finish();
ROLLBACK;
