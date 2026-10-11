-- Testes de 0022_invoice_status_and_calendar_mirror: status carried_over da fatura e lado do espelho no calendário.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

SELECT has_function('calendar_items', ARRAY['uuid[]', 'date', 'date', 'date']);

-- Mesmo cenário de 0017_calendar (Casa, Empresa e cartão com fatura 11/2026 aberta e antecipação).
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


-- Par espelhado comum: a Casa cobra aluguel da Empresa; o espelho (a pagar na Empresa) aguarda aceite.
INSERT INTO categories (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000ca13', 'expense', 'Aluguel pago');
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  ('00000000-0000-7000-8000-0000000b0020', '00000000-0000-7000-8000-0000000c0001', 'receivable', '00000000-0000-7000-8000-00000000e002',
   '00000000-0000-7000-8000-00000000ca10', 'Aluguel sala', '2026-10-01', '2026-10-28', 70000,
   '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0021', NULL),
  ('00000000-0000-7000-8000-0000000b0021', '00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e001',
   '00000000-0000-7000-8000-00000000ca13', 'Aluguel sala', '2026-10-01', '2026-10-28', 70000,
   '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000b0020', 'pending');
SELECT pg_temp.commit_check();

-- (b) calendar_items: lado do espelho e mirror_status ------------------------------------------------------------
SELECT results_eq($$
  SELECT title_id, mirror_side, mirror_status
    FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid, '00000000-0000-7000-8000-0000000c0002'::uuid],
                        '2026-10-01', '2026-10-31', '2026-10-10')
   ORDER BY title_id$$,
  $$VALUES ('00000000-0000-7000-8000-0000000b0001'::uuid, NULL::text, NULL::text),
           ('00000000-0000-7000-8000-0000000b0002', NULL, NULL),
           ('00000000-0000-7000-8000-0000000b0003', NULL, NULL),
           ('00000000-0000-7000-8000-0000000b0006', NULL, NULL),
           ('00000000-0000-7000-8000-0000000b0020', 'original', NULL),
           ('00000000-0000-7000-8000-0000000b0021', 'mirror', 'pending')$$,
  'títulos: original, espelho (com mirror_status) ou sem espelho');
SELECT results_eq($$
  SELECT caixa_id, direction, mirror_side, mirror_status
    FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0002'::uuid, '00000000-0000-7000-8000-0000000c0010'::uuid],
                        '2026-11-01', '2026-11-30', '2026-10-10')
   ORDER BY direction$$,
  $$VALUES ('00000000-0000-7000-8000-0000000c0002'::uuid, 'payable', 'mirror', NULL::text),
           ('00000000-0000-7000-8000-0000000c0010', 'receivable', 'original', NULL)$$,
  'fatura aberta: pagadora é o lado espelho, cartão o original');
SELECT results_eq($$
  SELECT item_kind, title_id, calendar_status, open_cents
    FROM calendar_items(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-01', '2026-10-31', '2026-10-10')
   ORDER BY due_date, title_id$$,
  $$VALUES ('title', '00000000-0000-7000-8000-0000000b0001'::uuid, 'overdue', 30000::bigint),
           ('title', '00000000-0000-7000-8000-0000000b0003', 'paid', 0),
           ('title', '00000000-0000-7000-8000-0000000b0002', 'receivable', 50000),
           ('title', '00000000-0000-7000-8000-0000000b0006', 'payable', 15000),
           ('title', '00000000-0000-7000-8000-0000000b0020', 'receivable', 70000)$$,
  'as colunas anteriores não mudam');

-- (a) card_invoice_summaries: carried_over ------------------------------------------------------------------------
-- Fatura 10/2026 fechada sem pagamento: tudo rolou para 11/2026 (título cancelado, item carryover).
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-0000000c0010', '2026-10-01', '2026-10-03', '2026-10-10');
INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001b010', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
        '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca01', '2026-09-20', 'Compra set', 9000);
INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b010', 1, '00000000-0000-7000-8000-0000000c0002', 9000);
SELECT pg_temp.commit_check();
SELECT is((SELECT status FROM card_invoice_summaries WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a610'), 'open', 'aberta');
UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a610';
INSERT INTO card_invoice_items (card_invoice_id, kind, carried_from_invoice_id, payer_caixa_id, amount_cents, description)
VALUES ('00000000-0000-7000-8000-00000001a611', 'carryover', '00000000-0000-7000-8000-00000001a610',
        '00000000-0000-7000-8000-0000000c0002', 9000, 'Saldo anterior');
SELECT pg_temp.commit_check();
SELECT results_eq($$SELECT status, open_cents, carried_out_cents FROM card_invoice_summaries
                     WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a610'$$,
                  $$VALUES ('carried_over', 0::bigint, 9000::bigint)$$, 'fechada sem saldo aberto e com saldo rolado: carried_over');
SELECT is((SELECT status FROM card_invoice_summaries WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a611'), 'open',
          'a seguinte continua aberta');
-- Fatura 09/2026 fechada e quitada: paid.
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000001a609', '00000000-0000-7000-8000-0000000c0010', '2026-09-01', '2026-09-03', '2026-09-10');
UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a609';
SELECT pg_temp.commit_check();
SELECT is((SELECT status FROM card_invoice_summaries WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a609'), 'paid',
          'fechada sem saldo nem rolagem: paid');

SELECT * FROM finish();
ROLLBACK;
