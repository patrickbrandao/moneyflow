-- Testes de 0017_calendar: itens por vencimento e saldo diário realizado/projetado.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_function('calendar_items', ARRAY['uuid[]', 'date', 'date', 'date']);
SELECT has_function('account_daily_balances', ARRAY['uuid', 'date', 'date']);
SELECT has_function('caixa_daily_balances', ARRAY['uuid', 'date', 'date', 'date']);

-- Dados base -------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA'),
  ('00000000-0000-7000-8000-00000000e010', 'company', 'Nu Pagamentos');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0002', 500000, 3, 10, '1234');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú', '2026-10-01', 100000),
  ('00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000c0001', 'cash', 'Cofre', '2026-10-03', 5000),
  ('00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-0000000c0002', 'checking', 'Inter PJ', '2026-10-01', 0);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca10', 'income', 'Aluguel'),
  ('00000000-0000-7000-8000-00000000ca11', 'income', 'Fatura a receber'),
  ('00000000-0000-7000-8000-00000000ca12', 'expense', 'Fatura de cartão');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Energia (vencida)', '2026-10-01', '2026-10-05', 30000),
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000c0001', 'receivable', '00000000-0000-7000-8000-00000000e002',
   '00000000-0000-7000-8000-00000000ca10', 'Aluguel', '2026-10-01', '2026-10-15', 50000),
  ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Água (paga)', '2026-10-01', '2026-10-12', 10000),
  ('00000000-0000-7000-8000-0000000b0004', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Cancelado', '2026-10-01', '2026-10-20', 1000),
  ('00000000-0000-7000-8000-0000000b0005', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Arquivado', '2026-10-01', '2026-10-21', 1000),
  ('00000000-0000-7000-8000-0000000b0006', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Gás (parcial)', '2026-10-01', '2026-10-25', 20000);
UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0004';
UPDATE titles SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000b0005';
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id) VALUES
  ('00000000-0000-7000-8000-0000000d0003', '00000000-0000-7000-8000-0000000b0003', '2026-10-08', 10000, '00000000-0000-7000-8000-0000000a0001'),
  ('00000000-0000-7000-8000-0000000d0006', '00000000-0000-7000-8000-0000000b0006', '2026-10-09', 5000, '00000000-0000-7000-8000-0000000a0001');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id, description) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-08', -10000, 'settlement', '00000000-0000-7000-8000-0000000d0003', NULL),
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-09', -5000, 'settlement', '00000000-0000-7000-8000-0000000d0006', NULL);
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-02', 2000, 'adjustment', 'Rendimento');

-- Cartão: fatura 11/2026 aberta com uma compra de 30,00 e 10,00 antecipados.
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-0000000c0010', '2026-11-01', '2026-11-03', '2026-11-10');
INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
        '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', '2026-10-05', 'Compra', 3000);
INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b001', 1, '00000000-0000-7000-8000-0000000c0002', 3000);
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, card_invoice_id, counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  ('00000000-0000-7000-8000-00000001c111', '00000000-0000-7000-8000-0000000c0010', 'receivable', '00000000-0000-7000-8000-00000000e002',
   '00000000-0000-7000-8000-00000000ca11', 'Antecipação', '2026-10-01', '2026-10-09', 1000, 'card_invoice',
   '00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000001c112', NULL),
  ('00000000-0000-7000-8000-00000001c112', '00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-00000000ca12', 'Antecipação', '2026-10-01', '2026-10-09', 1000, 'card_invoice',
   '00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-00000001c111', 'accepted');
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id, mirror_settlement_id) VALUES
  ('00000000-0000-7000-8000-00000001d112', '00000000-0000-7000-8000-00000001c112', '2026-10-09', 1000,
   '00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-00000001d111'),
  ('00000000-0000-7000-8000-00000001d111', '00000000-0000-7000-8000-00000001c111', '2026-10-09', 1000, NULL,
   '00000000-0000-7000-8000-00000001d112');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000a0003', '2026-10-09', -1000, 'settlement', '00000000-0000-7000-8000-00000001d112');
SELECT pg_temp.commit_check();

-- Itens do calendário -----------------------------------------------------------------------------------
SELECT results_eq($$SELECT title_id, due_date, open_cents, status, calendar_status
                     FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-01', '2026-10-31', '2026-10-10')$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b0001'::uuid, '2026-10-05'::date, 30000::bigint, 'open', 'overdue'),
                           ('00000000-0000-7000-8000-0000000b0003'::uuid, '2026-10-12'::date, 0::bigint, 'paid', 'paid'),
                           ('00000000-0000-7000-8000-0000000b0002'::uuid, '2026-10-15'::date, 50000::bigint, 'open', 'receivable'),
                           ('00000000-0000-7000-8000-0000000b0006'::uuid, '2026-10-25'::date, 15000::bigint, 'partial', 'payable')$$,
                  'títulos por vencimento, sem cancelados nem arquivados, com status de calendário');
SELECT is((SELECT count(*)::int FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-13', '2026-10-20',
                                                     '2026-10-10')), 1, 'filtro por período');
SELECT is((SELECT count(*)::int FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0002'::uuid], '2026-10-01', '2026-10-31',
                                                     '2026-10-10')), 0, 'antecipação de fatura aberta não aparece como título');
SELECT results_eq($$SELECT item_kind, caixa_id, direction, entity_id, amount_cents, reference_month, description, calendar_status
                     FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0002'::uuid, '00000000-0000-7000-8000-0000000c0010'::uuid],
                                         '2026-11-01', '2026-11-30', '2026-10-10')
                    ORDER BY direction$$,
                  $$VALUES ('card_invoice', '00000000-0000-7000-8000-0000000c0002'::uuid, 'payable', '00000000-0000-7000-8000-00000000e010'::uuid,
                            2000::bigint, '2026-11-01'::date, 'Nubank PJ', 'payable'),
                           ('card_invoice', '00000000-0000-7000-8000-0000000c0010'::uuid, 'receivable', '00000000-0000-7000-8000-00000000e002'::uuid,
                            2000::bigint, '2026-11-01'::date, 'Nubank PJ', 'receivable')$$,
                  'fatura aberta: previsão (itens − antecipação) na pagadora e no cartão');
SELECT is((SELECT count(*)::int FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-11-01', '2026-11-30')),
          0, 'a fatura não aparece em caixa que não é pagadora');
SELECT throws_ok($$SELECT * FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-31', '2026-10-01')$$,
                 '22023', NULL, 'período invertido');
SELECT throws_ok($$SELECT * FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-01-01', '2029-12-31')$$,
                 '22023', NULL, 'período longo demais');

-- Saldo por dia da conta ---------------------------------------------------------------------------------
SELECT results_eq($$SELECT day, balance_cents FROM account_daily_balances('00000000-0000-7000-8000-0000000a0002', '2026-10-01', '2026-10-04')$$,
                  $$VALUES ('2026-10-01'::date, NULL::bigint), ('2026-10-02'::date, NULL::bigint),
                           ('2026-10-03'::date, 5000::bigint), ('2026-10-04'::date, 5000::bigint)$$, 'NULL antes da abertura');
SELECT results_eq($$SELECT day, balance_cents FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-07', '2026-10-09')$$,
                  $$VALUES ('2026-10-07'::date, 102000::bigint), ('2026-10-08'::date, 92000::bigint), ('2026-10-09'::date, 87000::bigint)$$,
                  'saldo no fim de cada dia, contando o que veio antes do período');
SELECT is((SELECT count(*)::int FROM account_daily_balances('00000000-0000-7000-8000-00000000ffff', '2026-10-01', '2026-10-04')), 0,
          'conta inexistente: nenhuma linha');
SELECT ok((SELECT bool_and(balance_cents = financial_account_balance_at('00000000-0000-7000-8000-0000000a0001', day))
             FROM account_daily_balances('00000000-0000-7000-8000-0000000a0001', '2026-10-01', '2026-10-31')),
          'bate com financial_account_balance_at em todos os dias');

-- Saldo realizado e projetado da caixa ----------------------------------------------------------------------
-- Realizado: Itaú 100000 (01/10) + 2000 (02/10) − 10000 (08/10) − 5000 (09/10); Cofre 5000 a partir de 03/10.
-- Previsto a partir de 10/10: energia vencida −30000 (entra em 10/10), aluguel +50000 (15/10), gás −15000 (25/10).
SELECT results_eq($$SELECT day, realized_cents, scheduled_cents, projected_cents
                     FROM caixa_daily_balances('00000000-0000-7000-8000-0000000c0001', '2026-10-01', '2026-10-31', '2026-10-10')
                    WHERE day IN ('2026-10-01', '2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10', '2026-10-15', '2026-10-25', '2026-10-31')$$,
                  $$VALUES ('2026-10-01'::date, 100000::bigint, 0::bigint, 100000::bigint),
                           ('2026-10-02'::date, 102000::bigint, 0::bigint, 102000::bigint),
                           ('2026-10-03'::date, 107000::bigint, 0::bigint, 107000::bigint),
                           ('2026-10-09'::date, 92000::bigint, 0::bigint, 92000::bigint),
                           ('2026-10-10'::date, 92000::bigint, -30000::bigint, 62000::bigint),
                           ('2026-10-15'::date, 92000::bigint, 20000::bigint, 112000::bigint),
                           ('2026-10-25'::date, 92000::bigint, 5000::bigint, 97000::bigint),
                           ('2026-10-31'::date, 92000::bigint, 5000::bigint, 97000::bigint)$$,
                  'realizado, previsto acumulado e projetado por dia');
SELECT is((SELECT count(*)::int FROM caixa_daily_balances('00000000-0000-7000-8000-0000000c0001', '2026-10-01', '2026-10-31')), 31,
          'uma linha por dia');
SELECT results_eq($$SELECT day, realized_cents, scheduled_cents, projected_cents
                     FROM caixa_daily_balances('00000000-0000-7000-8000-0000000c0001', '2026-10-20', '2026-10-21', '2026-10-10')$$,
                  $$VALUES ('2026-10-20'::date, 92000::bigint, 20000::bigint, 112000::bigint),
                           ('2026-10-21'::date, 92000::bigint, 20000::bigint, 112000::bigint)$$,
                  'período que começa depois de hoje acumula o previsto anterior');
SELECT results_eq($$SELECT day, realized_cents, scheduled_cents, projected_cents
                     FROM caixa_daily_balances('00000000-0000-7000-8000-0000000c0002', '2026-11-09', '2026-11-10', '2026-10-10')$$,
                  $$VALUES ('2026-11-09'::date, -1000::bigint, 0::bigint, -1000::bigint),
                           ('2026-11-10'::date, -1000::bigint, -2000::bigint, -3000::bigint)$$,
                  'pagadora: fatura aberta prevista no vencimento');
SELECT throws_ok($$SELECT * FROM caixa_daily_balances('00000000-0000-7000-8000-0000000c0001', '2026-10-31', '2026-10-01')$$,
                 '22023', NULL, 'período inválido');

-- Privilégios
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['calendar_items(uuid[], date, date, date)', 'account_daily_balances(uuid, date, date)',
                    'caixa_daily_balances(uuid, date, date, date)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['calendar_items(uuid[], date, date, date)', 'account_daily_balances(uuid, date, date)',
                    'caixa_daily_balances(uuid, date, date, date)']) f;
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$SELECT * FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-01', '2026-10-31')$$,
                'app consulta o calendário');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
