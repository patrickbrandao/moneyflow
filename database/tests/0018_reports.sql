-- Testes de 0018_reports: despesa/receita por categoria, totais por entidade e fluxo projetado.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_function('report_category_totals', ARRAY['uuid[]', 'date', 'date', 'text', 'uuid[]']);
SELECT has_function('report_entity_totals', ARRAY['uuid[]', 'date', 'date', 'text', 'uuid[]']);
SELECT has_function('report_cash_projection', ARRAY['uuid[]', 'date', 'integer[]', 'uuid[]']);
SELECT hasnt_function('report_category_totals', ARRAY['uuid[]', 'date', 'date', 'text']);
SELECT hasnt_function('report_cash_projection', ARRAY['uuid[]', 'date', 'integer[]']);

-- Dados base ---------------------------------------------------------------------------------------------
-- Casa (Patrick) e Empresa; cartão Nubank (Nu Pagamentos) pago pela Empresa por padrão.
INSERT INTO entities (id, kind, name, trade_name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick', NULL),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa Ltda', NULL),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA', NULL),
  ('00000000-0000-7000-8000-00000000e007', 'company', 'Posto Shell Ltda', 'Posto Shell'),
  ('00000000-0000-7000-8000-00000000e008', 'company', 'Cliente X', NULL),
  ('00000000-0000-7000-8000-00000000e010', 'company', 'Nu Pagamentos', NULL);
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0002', 500000, 3, 10, '1234');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú', '2026-09-01', 100000),
  ('00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-0000000c0002', 'checking', 'Inter PJ', '2026-09-01', 200000);
INSERT INTO categories (id, kind, name, parent_id) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia', NULL),
  ('00000000-0000-7000-8000-00000000ca03', 'expense', 'Transporte', NULL),
  ('00000000-0000-7000-8000-00000000ca04', 'expense', 'Pessoal', NULL),
  ('00000000-0000-7000-8000-00000000ca05', 'expense', 'Fatura de cartão', NULL),
  ('00000000-0000-7000-8000-00000000ca10', 'income', 'Salário', NULL),
  ('00000000-0000-7000-8000-00000000ca11', 'income', 'Fatura a receber', NULL),
  ('00000000-0000-7000-8000-00000000ca12', 'income', 'Vendas', NULL),
  ('00000000-0000-7000-8000-00000000ca13', 'income', 'Rendimentos', NULL);
INSERT INTO categories (id, kind, name, parent_id) VALUES
  ('00000000-0000-7000-8000-00000000ca02', 'expense', 'Energia', '00000000-0000-7000-8000-00000000ca01');

-- Títulos comuns
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents) VALUES
  -- Casa: energia de outubro paga com juros; energia de novembro em aberto; cancelado; estornado (volta a aberto).
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca02', 'Energia 10', '2026-10-01', '2026-10-05', 30000),
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca02', 'Energia 11', '2026-11-01', '2026-11-05', 20000),
  ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Cancelado', '2026-10-01', '2026-10-20', 1000),
  ('00000000-0000-7000-8000-0000000b0005', '00000000-0000-7000-8000-0000000c0001', 'payable', '00000000-0000-7000-8000-00000000e005',
   '00000000-0000-7000-8000-00000000ca01', 'Taxa (baixa estornada)', '2026-10-01', '2026-10-08', 4000),
  -- Empresa: venda recebida em parte.
  ('00000000-0000-7000-8000-0000000b0004', '00000000-0000-7000-8000-0000000c0002', 'receivable', '00000000-0000-7000-8000-00000000e008',
   '00000000-0000-7000-8000-00000000ca12', 'Venda', '2026-10-01', '2026-10-20', 80000);
UPDATE titles SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-0000000b0003';

-- Par espelhado: a Empresa paga o salário do Patrick (a pagar na Empresa, a receber na Casa).
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  ('00000000-0000-7000-8000-0000000b0010', '00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e001',
   '00000000-0000-7000-8000-00000000ca04', 'Salário', '2026-10-01', '2026-10-10', 50000,
   '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000b0011', NULL),
  ('00000000-0000-7000-8000-0000000b0011', '00000000-0000-7000-8000-0000000c0001', 'receivable', '00000000-0000-7000-8000-00000000e002',
   '00000000-0000-7000-8000-00000000ca10', 'Salário', '2026-10-01', '2026-10-10', 50000,
   '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000b0010', 'accepted');

INSERT INTO settlements (id, title_id, settled_on, amount_cents, interest_cents, financial_account_id, mirror_settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000d0001', '00000000-0000-7000-8000-0000000b0001', '2026-10-05', 30000, 500,
   '00000000-0000-7000-8000-0000000a0001', NULL),
  ('00000000-0000-7000-8000-0000000d0004', '00000000-0000-7000-8000-0000000b0004', '2026-10-20', 30000, 0,
   '00000000-0000-7000-8000-0000000a0003', NULL),
  ('00000000-0000-7000-8000-0000000d0005', '00000000-0000-7000-8000-0000000b0005', '2026-10-08', 4000, 0,
   '00000000-0000-7000-8000-0000000a0001', NULL),
  ('00000000-0000-7000-8000-0000000d0010', '00000000-0000-7000-8000-0000000b0010', '2026-10-10', 50000, 0,
   '00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-0000000d0011'),
  ('00000000-0000-7000-8000-0000000d0011', '00000000-0000-7000-8000-0000000b0011', '2026-10-10', 50000, 0,
   '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000d0010');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-05', -30500, 'settlement', '00000000-0000-7000-8000-0000000d0001'),
  ('00000000-0000-7000-8000-0000000a0003', '2026-10-20', 30000, 'settlement', '00000000-0000-7000-8000-0000000d0004'),
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-08', -4000, 'settlement', '00000000-0000-7000-8000-0000000d0005'),
  ('00000000-0000-7000-8000-0000000a0003', '2026-10-10', -50000, 'settlement', '00000000-0000-7000-8000-0000000d0010'),
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-10', 50000, 'settlement', '00000000-0000-7000-8000-0000000d0011');
-- Estorno da taxa: a baixa deixa de contar e sai o movimento oposto.
UPDATE settlements SET reversed_at = now(), reversal_reason = 'cobrança indevida'
 WHERE id = '00000000-0000-7000-8000-0000000d0005';
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-09', 4000, 'settlement', '00000000-0000-7000-8000-0000000d0005');

-- Ajustes (rendimento categorizado; tarifa sem categoria para a Energia) e um lançamento futuro.
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, category_id, entity_id, description) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-02', 2000, 'adjustment', '00000000-0000-7000-8000-00000000ca13', NULL, 'Rendimento'),
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-25', -1500, 'adjustment', NULL, '00000000-0000-7000-8000-00000000e005', 'Tarifa'),
  ('00000000-0000-7000-8000-0000000a0003', '2026-11-15', -3000, 'adjustment', '00000000-0000-7000-8000-00000000ca05', NULL, 'Agendado');

-- Transferência Casa → Empresa (não é receita nem despesa).
INSERT INTO transfers (id, from_account_id, to_account_id, amount_cents, transferred_on) VALUES
  ('00000000-0000-7000-8000-0000000f0001', '00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000a0003', 7000, '2026-10-15');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, transfer_id) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '2026-10-15', -7000, 'transfer', '00000000-0000-7000-8000-0000000f0001'),
  ('00000000-0000-7000-8000-0000000a0003', '2026-10-15', 7000, 'transfer', '00000000-0000-7000-8000-0000000f0001');

-- Cartão: fatura 10/2026 (compra de setembro) fechada e paga pela Empresa; fatura 11/2026 aberta com
-- compra de 120,00 e estorno de 40,00 (Empresa) e compra de 50,00 (Casa).
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-0000000c0010', '2026-10-01', '2026-10-03', '2026-10-10'),
  ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-0000000c0010', '2026-11-01', '2026-11-03', '2026-11-10');
INSERT INTO card_purchases (id, card_caixa_id, kind, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents,
                            refunded_purchase_id) VALUES
  ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-0000000c0010', 'purchase', '00000000-0000-7000-8000-0000000c0002',
   '00000000-0000-7000-8000-00000000e007', '00000000-0000-7000-8000-00000000ca03', '2026-09-25', 'Combustível set', 10000, NULL),
  ('00000000-0000-7000-8000-00000001b002', '00000000-0000-7000-8000-0000000c0010', 'purchase', '00000000-0000-7000-8000-0000000c0002',
   '00000000-0000-7000-8000-00000000e007', '00000000-0000-7000-8000-00000000ca03', '2026-10-12', 'Combustível out', 12000, NULL),
  ('00000000-0000-7000-8000-00000001b003', '00000000-0000-7000-8000-0000000c0010', 'refund', '00000000-0000-7000-8000-0000000c0002',
   '00000000-0000-7000-8000-00000000e007', '00000000-0000-7000-8000-00000000ca03', '2026-10-20', 'Estorno', 4000,
   '00000000-0000-7000-8000-00000001b002'),
  ('00000000-0000-7000-8000-00000001b004', '00000000-0000-7000-8000-0000000c0010', 'purchase', '00000000-0000-7000-8000-0000000c0001',
   '00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-00000000ca02', '2026-10-15', 'Energia no cartão', 5000, NULL);
INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents) VALUES
  ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b001', 1, '00000000-0000-7000-8000-0000000c0002', 10000),
  ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b002', 1, '00000000-0000-7000-8000-0000000c0002', 12000),
  ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b003', 1, '00000000-0000-7000-8000-0000000c0002', -4000),
  ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b004', 1, '00000000-0000-7000-8000-0000000c0001', 5000);
UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a610';
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                    origin, card_invoice_id, counterparty_caixa_id, mirror_title_id, mirror_status) VALUES
  ('00000000-0000-7000-8000-00000001c101', '00000000-0000-7000-8000-0000000c0010', 'receivable', '00000000-0000-7000-8000-00000000e002',
   '00000000-0000-7000-8000-00000000ca11', 'Fatura 10/2026', '2026-10-01', '2026-10-10', 10000, 'card_invoice',
   '00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000001c102', NULL),
  ('00000000-0000-7000-8000-00000001c102', '00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-00000000ca05', 'Fatura 10/2026', '2026-10-01', '2026-10-10', 10000, 'card_invoice',
   '00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-00000001c101', 'accepted');
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id, mirror_settlement_id) VALUES
  ('00000000-0000-7000-8000-00000001d102', '00000000-0000-7000-8000-00000001c102', '2026-10-10', 10000,
   '00000000-0000-7000-8000-0000000a0003', '00000000-0000-7000-8000-00000001d101'),
  ('00000000-0000-7000-8000-00000001d101', '00000000-0000-7000-8000-00000001c101', '2026-10-10', 10000, NULL,
   '00000000-0000-7000-8000-00000001d102');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id) VALUES
  ('00000000-0000-7000-8000-0000000a0003', '2026-10-10', -10000, 'settlement', '00000000-0000-7000-8000-00000001d102');
SELECT pg_temp.commit_check();

CREATE TEMP TABLE ids AS SELECT ARRAY['00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000c0002',
                                      '00000000-0000-7000-8000-0000000c0010']::uuid[] AS all_ids;

-- Por categoria, competência ------------------------------------------------------------------------------
SELECT results_eq($$
  SELECT month, caixa_id, card_caixa_id, kind, group_category_id, category_id, source, is_internal, amount_cents, entries
    FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')
   ORDER BY caixa_id, kind, category_id, source$$,
  $$VALUES
    ('2026-10-01'::date, '00000000-0000-7000-8000-0000000c0001'::uuid, NULL::uuid, 'expense',
     '00000000-0000-7000-8000-00000000ca01'::uuid, '00000000-0000-7000-8000-00000000ca01'::uuid, 'title', false, 4000::bigint, 1),
    ('2026-10-01', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000c0010', 'expense',
     '00000000-0000-7000-8000-00000000ca01', '00000000-0000-7000-8000-00000000ca02', 'card_purchase', false, 5000, 1),
    ('2026-10-01', '00000000-0000-7000-8000-0000000c0001', NULL, 'expense',
     '00000000-0000-7000-8000-00000000ca01', '00000000-0000-7000-8000-00000000ca02', 'title', false, 30000, 1),
    ('2026-10-01', '00000000-0000-7000-8000-0000000c0001', NULL, 'income',
     '00000000-0000-7000-8000-00000000ca10', '00000000-0000-7000-8000-00000000ca10', 'title', true, 50000, 1),
    ('2026-10-01', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000c0010', 'expense',
     '00000000-0000-7000-8000-00000000ca03', '00000000-0000-7000-8000-00000000ca03', 'card_purchase', false, 8000, 2),
    ('2026-10-01', '00000000-0000-7000-8000-0000000c0002', NULL, 'expense',
     '00000000-0000-7000-8000-00000000ca04', '00000000-0000-7000-8000-00000000ca04', 'title', true, 50000, 1),
    ('2026-10-01', '00000000-0000-7000-8000-0000000c0002', NULL, 'income',
     '00000000-0000-7000-8000-00000000ca12', '00000000-0000-7000-8000-00000000ca12', 'title', false, 80000, 1)$$,
  'competência: títulos pela competência (sem cancelado nem fatura), compras do cartão com estorno, espelho interno');

SELECT is((SELECT count(*)::int FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')
            WHERE source = 'title' AND category_id IN ('00000000-0000-7000-8000-00000000ca05', '00000000-0000-7000-8000-00000000ca11')),
          0, 'competência: títulos card_invoice ficam de fora nos dois lados');
SELECT results_eq($$SELECT month, amount_cents FROM report_category_totals((SELECT all_ids FROM ids), '2026-09-01', '2026-11-30')
                     WHERE source = 'card_purchase' AND caixa_id = '00000000-0000-7000-8000-0000000c0002' ORDER BY month$$,
                  $$VALUES ('2026-09-01'::date, 10000::bigint), ('2026-10-01'::date, 8000::bigint)$$,
                  'competência: compra pela data da compra, não pela fatura');
SELECT is((SELECT count(*)::int FROM report_category_totals(ARRAY['00000000-0000-7000-8000-0000000c0010'::uuid], '2026-10-01', '2026-10-31')
            WHERE source = 'card_purchase'), 2, 'compras entram também quando só o cartão está na lista');
SELECT is((SELECT is_internal FROM report_category_totals(ARRAY['00000000-0000-7000-8000-0000000c0002'::uuid], '2026-10-01', '2026-10-31')
            WHERE category_id = '00000000-0000-7000-8000-00000000ca04'), false, 'espelho sem a outra caixa na lista não é interno');
SELECT is((SELECT count(*)::int FROM report_category_totals(ARRAY[]::uuid[], '2026-10-01', '2026-10-31')), 0, 'lista vazia: nada');

-- Por categoria, caixa -----------------------------------------------------------------------------------
SELECT results_eq($$
  SELECT caixa_id, card_caixa_id, kind, category_id, source, is_internal, amount_cents, entries
    FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash')
   ORDER BY caixa_id, kind, category_id NULLS FIRST, source$$,
  $$VALUES
    ('00000000-0000-7000-8000-0000000c0001'::uuid, NULL::uuid, 'expense', NULL::uuid, 'adjustment', false, 1500::bigint, 1),
    ('00000000-0000-7000-8000-0000000c0001', NULL, 'expense', '00000000-0000-7000-8000-00000000ca01', 'settlement', false, 0, 2),
    ('00000000-0000-7000-8000-0000000c0001', NULL, 'expense', '00000000-0000-7000-8000-00000000ca02', 'settlement', false, 30500, 1),
    ('00000000-0000-7000-8000-0000000c0001', NULL, 'income', '00000000-0000-7000-8000-00000000ca10', 'settlement', true, 50000, 1),
    ('00000000-0000-7000-8000-0000000c0001', NULL, 'income', '00000000-0000-7000-8000-00000000ca13', 'adjustment', false, 2000, 1),
    ('00000000-0000-7000-8000-0000000c0002', NULL, 'expense', '00000000-0000-7000-8000-00000000ca04', 'settlement', true, 50000, 1),
    ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000c0010', 'expense', '00000000-0000-7000-8000-00000000ca05',
     'card_invoice_payment', false, 10000, 1),
    ('00000000-0000-7000-8000-0000000c0002', NULL, 'income', '00000000-0000-7000-8000-00000000ca12', 'settlement', false, 30000, 1)$$,
  'caixa: movimentos pela data (juros incluídos, estorno anula), pagamento de fatura explícito, sem transferências');
SELECT is((SELECT sum(amount_cents)::bigint FROM report_category_totals((SELECT all_ids FROM ids), '2026-11-01', '2026-11-30', 'cash')),
          3000::bigint, 'caixa: lançamento futuro conta no mês dele');

SELECT throws_ok($$SELECT * FROM report_category_totals(ARRAY[]::uuid[], '2026-10-31', '2026-10-01')$$, '22023', NULL, 'período invertido');
SELECT throws_ok($$SELECT * FROM report_category_totals(ARRAY[]::uuid[], '2010-01-01', '2026-10-01')$$, '22023', NULL, 'período longo demais');
SELECT throws_ok($$SELECT * FROM report_category_totals(ARRAY[]::uuid[], '2026-10-01', '2026-10-31', 'accrual')$$, '22023', NULL,
                 'regime desconhecido');

-- Por entidade ----------------------------------------------------------------------------------------------
SELECT results_eq($$
  SELECT entity_id, caixa_id, card_caixa_id, source, is_internal, outflow_cents, inflow_cents, entries
    FROM report_entity_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')
   ORDER BY entity_id, caixa_id, source$$,
  $$VALUES
    ('00000000-0000-7000-8000-00000000e001'::uuid, '00000000-0000-7000-8000-0000000c0002'::uuid, NULL::uuid, 'title', true, 50000::bigint, 0::bigint, 1),
    ('00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-0000000c0001', NULL, 'title', true, 0, 50000, 1),
    ('00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000c0010',
     'card_purchase', false, 5000, 0, 1),
    ('00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-0000000c0001', NULL, 'title', false, 34000, 0, 2),
    ('00000000-0000-7000-8000-00000000e007', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000c0010',
     'card_purchase', false, 8000, 0, 2),
    ('00000000-0000-7000-8000-00000000e008', '00000000-0000-7000-8000-0000000c0002', NULL, 'title', false, 0, 80000, 1)$$,
  'entidade, competência: recebedor final das compras do cartão (pagadora → cartão → lojista)');
SELECT results_eq($$
  SELECT entity_id, caixa_id, card_caixa_id, source, is_internal, outflow_cents, inflow_cents, entries
    FROM report_entity_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash')
   ORDER BY entity_id, caixa_id, source$$,
  $$VALUES
    ('00000000-0000-7000-8000-00000000e001'::uuid, '00000000-0000-7000-8000-0000000c0002'::uuid, NULL::uuid, 'settlement', true, 50000::bigint, 0::bigint, 1),
    ('00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-0000000c0001', NULL, 'settlement', true, 0, 50000, 1),
    ('00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-0000000c0001', NULL, 'adjustment', false, 1500, 0, 1),
    ('00000000-0000-7000-8000-00000000e005', '00000000-0000-7000-8000-0000000c0001', NULL, 'settlement', false, 30500, 0, 3),
    ('00000000-0000-7000-8000-00000000e008', '00000000-0000-7000-8000-0000000c0002', NULL, 'settlement', false, 0, 30000, 1),
    ('00000000-0000-7000-8000-00000000e010', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000c0010',
     'card_invoice_payment', false, 10000, 0, 1)$$,
  'entidade, caixa: baixas (estorno anula), ajuste com entidade e pagamento de fatura ao emissor');
SELECT throws_ok($$SELECT * FROM report_entity_totals(ARRAY[]::uuid[], NULL, '2026-10-01')$$, '22023', NULL, 'entidade: período nulo');

-- Fluxo projetado --------------------------------------------------------------------------------------------
-- Hoje 31/10. Itaú: 100000 − 30500 + 50000 + 2000 − 1500 − 7000 − 4000 + 4000 = 113000.
-- Inter: 200000 + 30000 − 50000 − 10000 + 7000 = 177000; −3000 lançado para 15/11.
-- Casa: a pagar energia 20000 (05/11), taxa vencida 4000, fatura aberta 5000 (10/11).
-- Empresa: a receber 50000 vencido; fatura aberta 12000 − 4000 = 8000 (10/11).
SELECT results_eq($$
  SELECT caixa_id, financial_account_id, horizon_days, until, balance_today_cents, scheduled_movements_cents,
         overdue_receivable_cents, overdue_payable_cents, receivable_cents, payable_cents, projected_cents
    FROM report_cash_projection((SELECT all_ids FROM ids), '2026-10-31', '{10,30}')$$,
  $$VALUES
    ('00000000-0000-7000-8000-0000000c0001'::uuid, NULL::uuid, 10, '2026-11-10'::date, 113000::bigint, 0::bigint, 0::bigint, 4000::bigint,
     0::bigint, 29000::bigint, 84000::bigint),
    ('00000000-0000-7000-8000-0000000c0001', NULL, 30, '2026-11-30', 113000, 0, 0, 4000, 0, 29000, 84000),
    ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000a0001', 10, '2026-11-10', 113000, 0, 0, 0, 0, 0, 113000),
    ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000a0001', 30, '2026-11-30', 113000, 0, 0, 0, 0, 0, 113000),
    ('00000000-0000-7000-8000-0000000c0002', NULL, 10, '2026-11-10', 177000, 0, 50000, 0, 50000, 8000, 219000),
    ('00000000-0000-7000-8000-0000000c0002', NULL, 30, '2026-11-30', 177000, -3000, 50000, 0, 50000, 8000, 216000),
    ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000a0003', 10, '2026-11-10', 177000, 0, 0, 0, 0, 0, 177000),
    ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000a0003', 30, '2026-11-30', 177000, -3000, 0, 0, 0, 0, 174000)$$,
  'projeção por caixa e conta: saldo de hoje, lançados no futuro, títulos (vencidos inclusive) e faturas abertas');
SELECT results_eq($$SELECT payable_cents FROM report_cash_projection(ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], '2026-10-31', '{4}')
                     WHERE financial_account_id IS NULL$$,
                  $$VALUES (4000::bigint)$$, 'horizonte curto: só o vencido');
SELECT is((SELECT count(*)::int FROM report_cash_projection((SELECT all_ids FROM ids), '2026-10-31')
            WHERE financial_account_id IS NULL), 6, 'padrão 30/60/90 dias; cartão fora');
SELECT throws_ok($$SELECT * FROM report_cash_projection(ARRAY[]::uuid[], '2026-10-31', '{0}')$$, '22023', NULL, 'horizonte zero');
SELECT throws_ok($$SELECT * FROM report_cash_projection(ARRAY[]::uuid[], '2026-10-31', '{}')$$, '22023', NULL, 'sem horizontes');

-- Filtro por entidade (p_entity_ids, F6) ------------------------------------------------------------------------
-- Energia SA (e005): títulos da Casa, compra no cartão da Casa e a tarifa (ajuste com entidade).
SELECT results_eq($$
  SELECT caixa_id, card_caixa_id, category_id, source, amount_cents, entries
    FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'competence',
                                ARRAY['00000000-0000-7000-8000-00000000e005'::uuid])
   ORDER BY category_id, source$$,
  $$VALUES
    ('00000000-0000-7000-8000-0000000c0001'::uuid, NULL::uuid, '00000000-0000-7000-8000-00000000ca01'::uuid, 'title', 4000::bigint, 1),
    ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-00000000ca02',
     'card_purchase', 5000, 1),
    ('00000000-0000-7000-8000-0000000c0001', NULL, '00000000-0000-7000-8000-00000000ca02', 'title', 30000, 1)$$,
  'filtro, competência: títulos da entidade e compras pelo recebedor final');
SELECT results_eq($$
  SELECT category_id, source, amount_cents, entries
    FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash',
                                ARRAY['00000000-0000-7000-8000-00000000e005'::uuid])
   ORDER BY category_id NULLS FIRST, source$$,
  $$VALUES (NULL::uuid, 'adjustment', 1500::bigint, 1),
           ('00000000-0000-7000-8000-00000000ca01', 'settlement', 0, 2),
           ('00000000-0000-7000-8000-00000000ca02', 'settlement', 30500, 1)$$,
  'filtro, caixa: baixas dos títulos e ajustes da entidade; ajuste sem entidade sai');
SELECT is((SELECT count(*)::int FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash',
                                                            ARRAY['00000000-0000-7000-8000-00000000e010'::uuid])),
          0, 'filtro: o pagamento de fatura (card_invoice_payment) sai mesmo com o emissor na lista');
SELECT is((SELECT count(*)::int FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'competence',
                                                            ARRAY[]::uuid[])), 0, 'filtro com lista vazia: nada');
SELECT is((SELECT count(*)::int FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash', NULL)),
          8, 'p_entity_ids NULL: sem filtro');
SELECT results_eq($$
  SELECT entity_id, source, outflow_cents, entries
    FROM report_entity_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'competence',
                              ARRAY['00000000-0000-7000-8000-00000000e007'::uuid])$$,
  $$VALUES ('00000000-0000-7000-8000-00000000e007'::uuid, 'card_purchase', 8000::bigint, 2)$$,
  'filtro por entidade: rastreio do cartão pelo recebedor final');
SELECT results_eq($$
  SELECT entity_id, source, inflow_cents
    FROM report_entity_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash',
                              ARRAY['00000000-0000-7000-8000-00000000e008', '00000000-0000-7000-8000-00000000e010']::uuid[])$$,
  $$VALUES ('00000000-0000-7000-8000-00000000e008'::uuid, 'settlement', 30000::bigint)$$,
  'filtro por entidade, caixa: só as da lista, sem o pagamento de fatura');
-- Projeção: saldo de hoje inteiro; títulos só da entidade; faturas abertas e o "Agendado" sem entidade saem.
SELECT results_eq($$
  SELECT caixa_id, financial_account_id, balance_today_cents, scheduled_movements_cents, overdue_receivable_cents,
         overdue_payable_cents, receivable_cents, payable_cents, projected_cents
    FROM report_cash_projection((SELECT all_ids FROM ids), '2026-10-31', '{30}', ARRAY['00000000-0000-7000-8000-00000000e005'::uuid])$$,
  $$VALUES
    ('00000000-0000-7000-8000-0000000c0001'::uuid, NULL::uuid, 113000::bigint, 0::bigint, 0::bigint, 4000::bigint, 0::bigint,
     24000::bigint, 89000::bigint),
    ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000a0001', 113000, 0, 0, 0, 0, 0, 113000),
    ('00000000-0000-7000-8000-0000000c0002', NULL, 177000, 0, 0, 0, 0, 0, 177000),
    ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000a0003', 177000, 0, 0, 0, 0, 0, 177000)$$,
  'projeção filtrada: saldo de hoje inteiro, títulos da entidade, sem faturas abertas nem lançado sem entidade');
INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, entity_id, description) VALUES
  ('00000000-0000-7000-8000-0000000a0003', '2026-11-12', -2000, 'adjustment', '00000000-0000-7000-8000-00000000e008', 'Desconto');
SELECT results_eq($$
  SELECT scheduled_movements_cents, overdue_receivable_cents, receivable_cents, payable_cents, projected_cents
    FROM report_cash_projection((SELECT all_ids FROM ids), '2026-10-31', '{30}', ARRAY['00000000-0000-7000-8000-00000000e008'::uuid])
   WHERE caixa_id = '00000000-0000-7000-8000-0000000c0002' AND financial_account_id IS NULL$$,
  $$VALUES (-2000::bigint, 50000::bigint, 50000::bigint, 0::bigint, 225000::bigint)$$,
  'projeção filtrada: lançado futuro com a entidade conta');
SELECT is((SELECT count(*)::int FROM report_cash_projection((SELECT all_ids FROM ids), '2026-10-31', '{30}', ARRAY[]::uuid[])
            WHERE receivable_cents + payable_cents + scheduled_movements_cents <> 0), 0, 'projeção com lista vazia: só saldos');
SELECT is(movement_counterparty('transfer', NULL, NULL), NULL::uuid, 'transferência não tem contraparte');

-- Privilégios
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['report_category_totals(uuid[], date, date, text, uuid[])', 'report_entity_totals(uuid[], date, date, text, uuid[])',
                    'report_cash_projection(uuid[], date, integer[], uuid[])']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['report_category_totals(uuid[], date, date, text, uuid[])', 'report_entity_totals(uuid[], date, date, text, uuid[])',
                    'report_cash_projection(uuid[], date, integer[], uuid[])', 'report_check_period(text, date, date, text)']) f;
GRANT SELECT ON ids TO moneyflow_app;
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$SELECT * FROM report_category_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31', 'cash')$$, 'app: categorias');
SELECT lives_ok($$SELECT * FROM report_entity_totals((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')$$, 'app: entidades');
SELECT lives_ok($$SELECT * FROM report_cash_projection((SELECT all_ids FROM ids))$$, 'app: projeção');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
