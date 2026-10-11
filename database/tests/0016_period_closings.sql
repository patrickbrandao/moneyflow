-- Testes de 0016_period_closings: mês fechado bloqueia títulos, baixas, movimentos e compras; reabrir só admin.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_table('period_closings');
SELECT columns_are('period_closings', ARRAY['id', 'caixa_id', 'month', 'closed_by_user_id', 'notes', 'created_at', 'updated_at']);
SELECT fk_ok('period_closings', 'caixa_id', 'caixas', 'id');
SELECT fk_ok('period_closings', 'closed_by_user_id', 'users', 'id');
SELECT has_function('period_is_closed', ARRAY['uuid', 'date']);
SELECT has_function('period_assert_open', ARRAY['uuid', 'date', 'text']);
SELECT has_trigger(t, t || '_period_lock') FROM unnest(ARRAY['titles', 'settlements', 'movements', 'card_purchases',
                                                             'financial_accounts']) t;
SELECT has_trigger('period_closings', t) FROM unnest(ARRAY['period_closings_validate', 'period_closings_audit']) t;

-- Dados base --------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'admin', 'admin@example.com', 'x', 'admin'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'x', 'user');
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA'),
  ('00000000-0000-7000-8000-00000000e010', 'company', 'Nu Pagamentos');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0001', 500000, 3, 10, '1234');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú', '2026-01-01', 100000);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca02', 'expense', 'Energia');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0009', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca02', 'Energia 09/2026', '2026-09-01', '2026-10-05', 30000),
  ('00000000-0000-7000-8000-0000000b0010', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca02', 'Energia 10/2026', '2026-10-01', '2026-11-05', 30000),
  ('00000000-0000-7000-8000-0000000b0011', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Aluguel 08/2026', '2026-08-01', '2026-09-10', 100000);
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000b0011', '2026-09-10', 100000, '00000000-0000-7000-8000-0000000a0001');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000f0001', '00000000-0000-7000-8000-0000000a0001', '2026-09-10', -100000, 'settlement',
   '00000000-0000-7000-8000-0000000d0001');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000f0002', '00000000-0000-7000-8000-0000000a0001', '2026-09-25', -500, 'adjustment', 'Tarifa');
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-0000000c0010', '2026-10-01', '2026-10-03', '2026-10-10');
INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0001',
        '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Compra', 1000);
INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b001', 1, '00000000-0000-7000-8000-0000000c0001', 1000);
SELECT pg_temp.commit_check();

-- Fechar setembro na Casa ------------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000c0001', '2026-09-15')$$,
                 '23514', NULL, 'mês = 1º dia');
SELECT lives_ok($$INSERT INTO period_closings (id, caixa_id, month, closed_by_user_id)
                  VALUES ('00000000-0000-7000-8000-0000000fc001', '00000000-0000-7000-8000-0000000c0001', '2026-09-01',
                          '00000000-0000-7000-8000-0000000000a2')$$, 'editor fecha setembro');
SELECT throws_ok($$INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000c0001', '2026-09-01')$$,
                 '23505', NULL, 'um fechamento por caixa e mês');
SELECT ok(period_is_closed('00000000-0000-7000-8000-0000000c0001', '2026-09-30'), 'setembro fechado');
SELECT ok(NOT period_is_closed('00000000-0000-7000-8000-0000000c0001', '2026-10-01'), 'outubro aberto');
SELECT ok(NOT period_is_closed('00000000-0000-7000-8000-0000000c0010', '2026-09-30'), 'outra caixa aberta');

-- Títulos (pela competência)
SELECT throws_ok($$INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
                           '00000000-0000-7000-8000-00000000ca02', 'Atrasado', '2026-09-20', '2026-10-20', 1)$$,
                 '23514', 'titles: month 2026-09 is closed in caixa 00000000-0000-7000-8000-0000000c0001',
                 'novo título com competência fechada');
SELECT throws_ok($$UPDATE titles SET amount_cents = 31000 WHERE id = '00000000-0000-7000-8000-0000000b0009'$$,
                 '23514', NULL, 'valor de título do mês fechado');
SELECT throws_ok($$UPDATE titles SET category_id = '00000000-0000-7000-8000-00000000ca01' WHERE id = '00000000-0000-7000-8000-0000000b0009'$$,
                 '23514', NULL, 'categoria de título do mês fechado');
SELECT throws_ok($$UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0009'$$,
                 '23514', NULL, 'cancelar título do mês fechado');
SELECT throws_ok($$DELETE FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0009'$$, '23514', NULL, 'excluir título do mês fechado');
SELECT throws_ok($$UPDATE titles SET competence_date = '2026-09-30' WHERE id = '00000000-0000-7000-8000-0000000b0010'$$,
                 '23514', NULL, 'mover título para o mês fechado');
SELECT throws_ok($$UPDATE titles SET competence_date = '2026-10-01' WHERE id = '00000000-0000-7000-8000-0000000b0009'$$,
                 '23514', NULL, 'tirar título do mês fechado');
SELECT lives_ok($$UPDATE titles SET due_date = '2026-10-06', description = 'Energia set/2026', notes = 'reagendado'
                   WHERE id = '00000000-0000-7000-8000-0000000b0009'$$, 'vencimento, descrição e notas continuam livres');
SELECT lives_ok($$UPDATE titles SET amount_cents = 32000 WHERE id = '00000000-0000-7000-8000-0000000b0010'$$, 'outubro livre');

-- Baixas (pela data da baixa) e movimentos (pela data)
SELECT throws_ok($$INSERT INTO settlements (title_id, settled_on, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000b0010', '2026-09-30', 100)$$,
                 '23514', 'settlements: month 2026-09 is closed in caixa 00000000-0000-7000-8000-0000000c0001', 'baixa em mês fechado');
SELECT lives_ok($$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id)
  VALUES ('00000000-0000-7000-8000-0000000d0002', '00000000-0000-7000-8000-0000000b0009', '2026-10-05', 30000,
          '00000000-0000-7000-8000-0000000a0001');
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-05', -30000, 'settlement', '00000000-0000-7000-8000-0000000d0002');
  SELECT pg_temp.commit_check();
$$, 'título de competência fechada é baixado em outubro');
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-0000000b0009'), 'paid', 'e o status acompanha');
SELECT throws_ok($$INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-09-30', 1, 'adjustment')$$,
                 '23514', 'movements: month 2026-09 is closed in caixa 00000000-0000-7000-8000-0000000c0001', 'movimento em mês fechado');
SELECT throws_ok($$UPDATE movements SET amount_cents = -600 WHERE id = '00000000-0000-7000-8000-0000000f0002'$$,
                 '23514', NULL, 'valor de movimento do mês fechado');
SELECT throws_ok($$UPDATE movements SET occurred_on = '2026-10-01' WHERE id = '00000000-0000-7000-8000-0000000f0002'$$,
                 '23514', NULL, 'tirar movimento do mês fechado');
SELECT throws_ok($$DELETE FROM movements WHERE id = '00000000-0000-7000-8000-0000000f0002'$$, '23514', NULL, 'excluir movimento do mês fechado');
SELECT lives_ok($$UPDATE movements SET description = 'Tarifa pacote' WHERE id = '00000000-0000-7000-8000-0000000f0002'$$,
                'descrição do movimento continua livre');
SELECT lives_ok($$
  UPDATE settlements SET reversed_at = now(), reversal_reason = 'devolvido' WHERE id = '00000000-0000-7000-8000-0000000d0001';
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0001', '2026-10-02', 100000, 'settlement', '00000000-0000-7000-8000-0000000d0001');
  SELECT pg_temp.commit_check();
$$, 'estorno de baixa de setembro com o movimento em outubro');
SELECT throws_ok($$DELETE FROM settlements WHERE id = '00000000-0000-7000-8000-0000000d0001'$$,
                 '23514', 'settlements: month 2026-09 is closed in caixa 00000000-0000-7000-8000-0000000c0001',
                 'excluir baixa do mês fechado');

-- Compras no cartão: mês fechado na pagadora (ou no cartão)
SELECT lives_ok($$UPDATE card_purchases SET description = 'Compra X', notes = 'ok' WHERE id = '00000000-0000-7000-8000-00000001b001'$$,
                'descrição da compra continua livre');
SELECT throws_ok($$UPDATE card_purchases SET category_id = '00000000-0000-7000-8000-00000000ca02' WHERE id = '00000000-0000-7000-8000-00000001b001'$$,
                 '23514', 'card_purchases: month 2026-09 is closed in caixa 00000000-0000-7000-8000-0000000c0001',
                 'recategorizar compra do mês fechado na pagadora');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0001',
                           '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', '2026-09-28', 'Nova', 1)$$,
                 '23514', NULL, 'nova compra no mês fechado da pagadora');
INSERT INTO period_closings (caixa_id, month) VALUES ('00000000-0000-7000-8000-0000000c0010', '2026-10-01');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0001',
                           '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', '2026-10-02', 'Nova', 1)$$,
                 '23514', 'card_purchases: month 2026-10 is closed in caixa 00000000-0000-7000-8000-0000000c0010',
                 'nova compra no mês fechado do cartão');

-- Abertura da conta
SELECT throws_ok($$UPDATE financial_accounts SET opening_balance_cents = 1 WHERE id = '00000000-0000-7000-8000-0000000a0001'$$,
                 '23514', NULL, 'saldo inicial com mês fechado depois da abertura');
SELECT lives_ok($$UPDATE financial_accounts SET name = 'Itaú PF' WHERE id = '00000000-0000-7000-8000-0000000a0001'$$,
                'nome da conta continua livre');

-- Reabrir: só admin ativo ----------------------------------------------------------------------------------
SELECT throws_ok($$UPDATE period_closings SET month = '2026-08-01' WHERE id = '00000000-0000-7000-8000-0000000fc001'$$,
                 '23514', NULL, 'caixa e mês imutáveis');
SELECT lives_ok($$UPDATE period_closings SET notes = 'conciliado com o extrato' WHERE id = '00000000-0000-7000-8000-0000000fc001'$$,
                'notas do fechamento');
SELECT throws_ok($$DELETE FROM period_closings WHERE id = '00000000-0000-7000-8000-0000000fc001'$$,
                 '42501', 'period_closings: only an active admin (app.user_id) can reopen a closed month', 'reabrir sem usuário');
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a2', true);
SELECT throws_ok($$DELETE FROM period_closings WHERE id = '00000000-0000-7000-8000-0000000fc001'$$,
                 '42501', NULL, 'usuário comum não reabre');
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
UPDATE users SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000000a1';
SELECT throws_ok($$DELETE FROM period_closings WHERE id = '00000000-0000-7000-8000-0000000fc001'$$,
                 '42501', NULL, 'admin inativo não reabre');
UPDATE users SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000000a1';
SELECT lives_ok($$DELETE FROM period_closings WHERE id = '00000000-0000-7000-8000-0000000fc001'$$, 'admin reabre setembro');
SELECT lives_ok($$UPDATE movements SET amount_cents = -600 WHERE id = '00000000-0000-7000-8000-0000000f0002'$$,
                'mês reaberto volta a aceitar edição');
SELECT results_eq($$SELECT action, user_id FROM audit_log WHERE table_name = 'period_closings'
                     AND record_id = '00000000-0000-7000-8000-0000000fc001' ORDER BY id$$,
                  $$VALUES ('insert', NULL::uuid), ('update', NULL::uuid),
                           ('delete', '00000000-0000-7000-8000-0000000000a1'::uuid)$$,
                  'fechamento, nota e reabertura ficam na auditoria');
SELECT set_config('app.user_id', '', true);

-- Privilégios
SELECT table_privs_are('period_closings', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
SELECT function_privs_are('period_is_closed', ARRAY['uuid', 'date'], 'moneyflow_app', ARRAY['EXECUTE']);
SELECT ok(NOT has_function_privilege('public', 'period_is_closed(uuid, date)', 'EXECUTE'), 'PUBLIC não executa');

SELECT * FROM finish();
ROLLBACK;
