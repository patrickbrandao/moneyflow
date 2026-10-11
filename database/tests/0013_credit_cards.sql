-- Testes de 0013_credit_cards: faturas, compras parceladas, estornos, encargos,
-- fechamento com títulos espelhados, pagamento parcial com saldo rolado,
-- antecipação, reabertura e limite.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['card_invoices', 'card_purchases', 'card_invoice_items', 'card_purchase_attachments']) t;
SELECT has_view(v) FROM unnest(ARRAY['card_invoice_payer_totals', 'card_invoice_summaries', 'card_invoice_lines', 'card_limits']) v;
SELECT columns_are('card_invoices', ARRAY['id', 'card_caixa_id', 'reference_month', 'closing_date', 'due_date', 'closed_at',
                                          'notes', 'created_at', 'updated_at']);
SELECT columns_are('card_purchases', ARRAY['id', 'card_caixa_id', 'kind', 'charge_kind', 'payer_caixa_id', 'entity_id',
                                           'category_id', 'purchased_on', 'description', 'amount_cents', 'installments_total',
                                           'first_installment', 'refunded_purchase_id', 'notes', 'created_at', 'updated_at']);
SELECT columns_are('card_invoice_items', ARRAY['id', 'card_invoice_id', 'kind', 'card_purchase_id', 'installment_number',
                                               'carried_from_invoice_id', 'payer_caixa_id', 'amount_cents', 'description',
                                               'created_at', 'updated_at']);
SELECT has_column('titles', 'card_invoice_id');
SELECT fk_ok('card_invoices', 'card_caixa_id', 'caixas', 'id');
SELECT fk_ok('card_purchases', 'card_caixa_id', 'caixas', 'id');
SELECT fk_ok('card_purchases', 'payer_caixa_id', 'caixas', 'id');
SELECT fk_ok('card_purchases', 'entity_id', 'entities', 'id');
SELECT fk_ok('card_purchases', 'category_id', 'categories', 'id');
SELECT fk_ok('card_purchases', 'refunded_purchase_id', 'card_purchases', 'id');
SELECT fk_ok('card_invoice_items', 'card_invoice_id', 'card_invoices', 'id');
SELECT fk_ok('card_invoice_items', 'card_purchase_id', 'card_purchases', 'id');
SELECT fk_ok('card_invoice_items', 'carried_from_invoice_id', 'card_invoices', 'id');
SELECT fk_ok('card_invoice_items', 'payer_caixa_id', 'caixas', 'id');
SELECT fk_ok('titles', 'card_invoice_id', 'card_invoices', 'id');
SELECT has_index('card_purchases', i) FROM unnest(ARRAY['card_purchases_card_caixa_id_purchased_on_idx',
  'card_purchases_payer_caixa_id_idx', 'card_purchases_entity_id_idx', 'card_purchases_category_id_idx',
  'card_purchases_refunded_purchase_id_idx']) i;
SELECT has_index('card_invoice_items', i) FROM unnest(ARRAY['card_invoice_items_card_invoice_id_payer_idx',
  'card_invoice_items_payer_caixa_id_idx']) i;
SELECT has_index('titles', 'titles_card_invoice_id_idx');
SELECT has_trigger('card_invoices', t) FROM unnest(ARRAY['card_invoices_validate', 'card_invoices_integrity_check']) t;
SELECT has_trigger('card_purchases', t) FROM unnest(ARRAY['card_purchases_validate', 'card_purchases_integrity_check']) t;
SELECT has_trigger('card_invoice_items', t) FROM unnest(ARRAY['card_invoice_items_validate', 'card_invoice_items_integrity_check']) t;
SELECT has_trigger('titles', t) FROM unnest(ARRAY['titles_validate_card_invoice', 'titles_card_invoice_integrity_check',
                                                  'titles_mirror_check']) t;

-- Dados base -----------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Minha Empresa'),
  ('00000000-0000-7000-8000-00000000e010', 'company', 'Nu Pagamentos'),
  ('00000000-0000-7000-8000-00000000e020', 'company', 'Posto Shell'),
  ('00000000-0000-7000-8000-00000000e021', 'company', 'Kalunga');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', '00000000-0000-7000-8000-00000000e002', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0002', 2000000, 3, 10, '1234'),
  ('00000000-0000-7000-8000-0000000c0011', 'Outro cartão', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0002', 100000, 5, 12, '9999');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000c0002', 'checking', 'Inter PJ', '2026-01-01', 1000000);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Combustível'),
  ('00000000-0000-7000-8000-00000000ca02', 'expense', 'Escritório'),
  ('00000000-0000-7000-8000-00000000ca03', 'expense', 'Juros'),
  ('00000000-0000-7000-8000-00000000ca10', 'income', 'Fatura de cartão a receber'),
  ('00000000-0000-7000-8000-00000000ca11', 'expense', 'Fatura de cartão');

INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date)
SELECT ('00000000-0000-7000-8000-00000001a' || to_char(m, 'YMM'))::uuid, '00000000-0000-7000-8000-0000000c0010',
       m, m + 2, m + 9
  FROM generate_series(date '2026-09-01', date '2027-02-01', interval '1 month') g (m0)
 CROSS JOIN LATERAL (SELECT m0::date AS m) x;
-- ids: …1a609 (09/2026), …1a610, …1a611, …1a612, …1a701 (01/2027), …1a702

-- Fatura -----------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM card_invoices), 6, 'seis faturas futuras');
SELECT throws_ok($$INSERT INTO card_invoices (card_caixa_id, reference_month, closing_date, due_date)
                   VALUES ('00000000-0000-7000-8000-0000000c0002', '2026-09-01', '2026-09-03', '2026-09-10')$$,
                 '23514', 'card_invoices: caixa 00000000-0000-7000-8000-0000000c0002 is not a credit card', 'fatura só em caixa de cartão');
SELECT throws_ok($$INSERT INTO card_invoices (card_caixa_id, reference_month, closing_date, due_date)
                   VALUES ('00000000-0000-7000-8000-0000000c0011', '2026-09-15', '2026-09-03', '2026-09-10')$$,
                 '23514', NULL, 'competência é o 1º dia do mês');
SELECT throws_ok($$INSERT INTO card_invoices (card_caixa_id, reference_month, closing_date, due_date)
                   VALUES ('00000000-0000-7000-8000-0000000c0011', '2026-09-01', '2026-09-10', '2026-09-03')$$,
                 '23514', NULL, 'vencimento não antes do fechamento');
SELECT throws_ok($$INSERT INTO card_invoices (card_caixa_id, reference_month, closing_date, due_date)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', '2026-09-01', '2026-09-03', '2026-09-10')$$,
                 '23505', NULL, 'uma fatura por cartão e competência');
SELECT throws_ok($$UPDATE card_invoices SET reference_month = '2026-08-01' WHERE id = '00000000-0000-7000-8000-00000001a609'$$,
                 '23514', NULL, 'competência imutável');
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000002a610', '00000000-0000-7000-8000-0000000c0011', '2026-10-01', '2026-10-05', '2026-10-12');

-- Compras: regras imediatas -----------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000c0002',
                           '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'X', 100)$$,
                 '23514', 'card_purchases: caixa 00000000-0000-7000-8000-0000000c0002 is not a credit card', 'compra só em caixa de cartão');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0011',
                           '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'X', 100)$$,
                 '23514', 'card_purchases: payer 00000000-0000-7000-8000-0000000c0011 must be a general caixa', 'pagadora é caixa general');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
                           '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca10', '2026-09-05', 'X', 100)$$,
                 '23514', NULL, 'categoria de despesa');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, kind, charge_kind, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', 'charge', 'interest', '00000000-0000-7000-8000-0000000c0002',
                           '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca03', '2026-09-05', 'Juros', 100)$$,
                 '23514', 'card_purchases: issuer charge must be paid to the card issuer 00000000-0000-7000-8000-00000000e010',
                 'encargo é do emissor');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, kind, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', 'refund', '00000000-0000-7000-8000-0000000c0002',
                           '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'X', 100)$$,
                 '23514', NULL, 'estorno exige a compra original');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, kind, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', 'charge', '00000000-0000-7000-8000-0000000c0002',
                           '00000000-0000-7000-8000-00000000e010', '00000000-0000-7000-8000-00000000ca03', '2026-09-05', 'X', 100)$$,
                 '23514', NULL, 'encargo exige o tipo (juros, IOF, multa…)');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents, installments_total, first_installment)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
                           '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'X', 100, 2, 3)$$,
                 '23514', NULL, 'primeira parcela ≤ N');

-- Compras: parcelas checadas no COMMIT ------------------------------------------------------------
SELECT throws_like($$
  INSERT INTO card_purchases (card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Sem itens', 100);
  SELECT pg_temp.commit_check();
$$, '%requires installments 1..1%', 'compra sem item de fatura');
SELECT throws_like($$
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b999', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Valor errado', 100);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b999', 1, '00000000-0000-7000-8000-0000000c0002', 99);
  SELECT pg_temp.commit_check();
$$, '%summing 100 (found 99)%', 'itens somam o valor da compra');
SELECT throws_like($$
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b999', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Fatura já fechada', 100);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a609', '00000000-0000-7000-8000-00000001b999', 1, '00000000-0000-7000-8000-0000000c0002', 100);
  SELECT pg_temp.commit_check();
$$, '%first closing on or after 2026-09-05%', 'a primeira parcela cai numa fatura que fecha depois da compra');
SELECT throws_like($$
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents, installments_total)
  VALUES ('00000000-0000-7000-8000-00000001b999', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Pula mês', 200, 2);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents) VALUES
    ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b999', 1, '00000000-0000-7000-8000-0000000c0002', 100),
    ('00000000-0000-7000-8000-00000001a612', '00000000-0000-7000-8000-00000001b999', 2, '00000000-0000-7000-8000-0000000c0002', 100);
  SELECT pg_temp.commit_check();
$$, '%consecutive invoices%', 'parcelas em faturas consecutivas');
SELECT throws_like($$
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b999', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Outra pagadora', 100);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b999', 1, '00000000-0000-7000-8000-0000000c0001', 100);
  SELECT pg_temp.commit_check();
$$, '%for payer 00000000-0000-7000-8000-0000000c0002%', 'item com a pagadora da compra');
SELECT throws_like($$
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b999', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Outro cartão', 100);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000002a610', '00000000-0000-7000-8000-00000001b999', 1, '00000000-0000-7000-8000-0000000c0002', 100);
  SELECT pg_temp.commit_check();
$$, '%consecutive invoices of its card%', 'item numa fatura do mesmo cartão');

-- Compras válidas (exemplo da spec 007)
SELECT lives_ok($$
  -- Kalunga: 7.200,00 em 6 × 1.200,00, comprada em 12/08 (1/6 na fatura 09/2026).
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description,
                              amount_cents, installments_total)
  VALUES ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e021', '00000000-0000-7000-8000-00000000ca02', '2026-08-12', 'Kalunga', 720000, 6);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  SELECT v.id, '00000000-0000-7000-8000-00000001b001', n, '00000000-0000-7000-8000-0000000c0002', 120000
    FROM generate_series(1, 6) n
    JOIN card_invoices v ON v.card_caixa_id = '00000000-0000-7000-8000-0000000c0010'
                        AND v.reference_month = date '2026-09-01' + make_interval(months => n - 1);
  -- Posto Shell 350,00 em 05/09 (fatura 10/2026).
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b002', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e020', '00000000-0000-7000-8000-00000000ca01', '2026-09-05', 'Posto Shell', 35000);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b002', 1, '00000000-0000-7000-8000-0000000c0002', 35000);
  -- Estorno Kalunga −80,00 em 20/09 (fatura 10/2026).
  INSERT INTO card_purchases (id, card_caixa_id, kind, refunded_purchase_id, payer_caixa_id, entity_id, category_id,
                              purchased_on, description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b003', '00000000-0000-7000-8000-0000000c0010', 'refund',
          '00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e021',
          '00000000-0000-7000-8000-00000000ca02', '2026-09-20', 'Estorno Kalunga', 8000);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b003', 1, '00000000-0000-7000-8000-0000000c0002', -8000);
  SELECT pg_temp.commit_check();
$$, 'compra parcelada, compra à vista e estorno');
SELECT results_eq($$SELECT installment_number, installments_total, reference_month, amount_cents FROM card_invoice_lines
                     WHERE card_purchase_id = '00000000-0000-7000-8000-00000001b001' ORDER BY 1 LIMIT 2$$,
                  $$VALUES (1::smallint, 6::smallint, '2026-09-01'::date, 120000::bigint),
                           (2::smallint, 6::smallint, '2026-10-01'::date, 120000::bigint)$$, 'parcelas n de N nas faturas');

SELECT throws_like($$
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b003', 1, '00000000-0000-7000-8000-0000000c0002', 8000);
$$, '%duplicate key%', 'uma parcela n por compra');
SELECT throws_like($$
  UPDATE card_invoice_items SET amount_cents = 8000 WHERE card_purchase_id = '00000000-0000-7000-8000-00000001b003';
  SELECT pg_temp.commit_check();
$$, '%signed by kind%', 'parcela do estorno é negativa');
SELECT throws_like($$
  UPDATE card_purchases SET amount_cents = 730000 WHERE id = '00000000-0000-7000-8000-00000001b003';
  UPDATE card_invoice_items SET amount_cents = -730000 WHERE card_purchase_id = '00000000-0000-7000-8000-00000001b003';
  SELECT pg_temp.commit_check();
$$, '%refunds of 00000000-0000-7000-8000-00000001b001 exceed its amount 720000%', 'estornos não passam do valor da compra');
SELECT throws_like($$
  UPDATE card_purchases SET entity_id = '00000000-0000-7000-8000-00000000e020' WHERE id = '00000000-0000-7000-8000-00000001b003';
  SELECT pg_temp.commit_check();
$$, '%must keep its entity, category and payer%', 'estorno com o recebedor da compra original');
SELECT throws_like($$
  UPDATE card_purchases SET category_id = '00000000-0000-7000-8000-00000000ca01' WHERE id = '00000000-0000-7000-8000-00000001b001';
  SELECT pg_temp.commit_check();
$$, '%must keep its entity, category and payer%', 'mudar a original sem levar o estorno');
SELECT lives_ok($$
  UPDATE card_purchases SET category_id = '00000000-0000-7000-8000-00000000ca01'
   WHERE id IN ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-00000001b003');
  UPDATE card_purchases SET category_id = '00000000-0000-7000-8000-00000000ca02'
   WHERE id IN ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-00000001b003');
  SELECT pg_temp.commit_check();
$$, 'recategorizar a compra junto com o estorno');
SELECT throws_ok($$UPDATE card_purchases SET kind = 'charge', charge_kind = 'fee' WHERE id = '00000000-0000-7000-8000-00000001b002'$$,
                 '23514', 'card_purchases: card and kind of purchase 00000000-0000-7000-8000-00000001b002 cannot change', 'tipo imutável');
SELECT throws_ok($$INSERT INTO card_purchases (card_caixa_id, kind, refunded_purchase_id, payer_caixa_id, entity_id, category_id,
                                              purchased_on, description, amount_cents)
                   VALUES ('00000000-0000-7000-8000-0000000c0010', 'refund', '00000000-0000-7000-8000-00000001b003',
                           '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e021',
                           '00000000-0000-7000-8000-00000000ca02', '2026-09-21', 'Estorno do estorno', 100)$$,
                 '23514', 'card_purchases: refund must point to a purchase or charge of the same card', 'não se estorna um estorno');

-- Começar no meio de um parcelamento: parcelas 5 e 6 de 6.
SELECT lives_ok($$
  INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description,
                              amount_cents, installments_total, first_installment)
  VALUES ('00000000-0000-7000-8000-00000001b005', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0002',
          '00000000-0000-7000-8000-00000000e021', '00000000-0000-7000-8000-00000000ca02', '2026-05-12', 'Cadeira (5/6 e 6/6)',
          20000, 6, 5);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents) VALUES
    ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b005', 5, '00000000-0000-7000-8000-0000000c0002', 10000),
    ('00000000-0000-7000-8000-00000001a612', '00000000-0000-7000-8000-00000001b005', 6, '00000000-0000-7000-8000-0000000c0002', 10000);
  SELECT pg_temp.commit_check();
$$, 'parcelamento iniciado antes do app (first_installment = 5)');
SELECT throws_like($$
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b005', 4, '00000000-0000-7000-8000-0000000c0002', 1);
  SELECT pg_temp.commit_check();
$$, '%requires installments 5..6%', 'parcela anterior à primeira registrada');
DELETE FROM card_purchases WHERE id = '00000000-0000-7000-8000-00000001b005';

-- Fechamento da fatura 09/2026 ---------------------------------------------------------------------
CREATE FUNCTION pg_temp.invoice_pair(card_title uuid, payer_title uuid, invoice uuid, amount bigint, due date) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, card_invoice_id, counterparty_caixa_id, mirror_title_id)
  VALUES (card_title, '00000000-0000-7000-8000-0000000c0010', 'receivable', '00000000-0000-7000-8000-00000000e002',
          '00000000-0000-7000-8000-00000000ca10', 'Fatura Nubank', date_trunc('month', due)::date, due, amount,
          'card_invoice', invoice, '00000000-0000-7000-8000-0000000c0002', payer_title);
  INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, card_invoice_id, counterparty_caixa_id, mirror_title_id, mirror_status)
  VALUES (payer_title, '00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e010',
          '00000000-0000-7000-8000-00000000ca11', 'Fatura Nubank', date_trunc('month', due)::date, due, amount,
          'card_invoice', invoice, '00000000-0000-7000-8000-0000000c0010', card_title, 'accepted');
$$;

-- Pagamento: perna na pagadora com conta, perna do cartão sem conta (cartão não tem contas).
CREATE FUNCTION pg_temp.pay(card_leg uuid, payer_leg uuid, card_title uuid, payer_title uuid, amount bigint, paid_on date)
RETURNS void
LANGUAGE sql AS $$
  INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id, mirror_settlement_id)
  VALUES (payer_leg, payer_title, paid_on, amount, '00000000-0000-7000-8000-0000000a0002', card_leg),
         (card_leg, card_title, paid_on, amount, NULL, payer_leg);
  INSERT INTO movements (financial_account_id, occurred_on, amount_cents, kind, settlement_id)
  VALUES ('00000000-0000-7000-8000-0000000a0002', paid_on, -amount, 'settlement', payer_leg);
$$;

SELECT throws_like($$
  UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a609';
  SELECT pg_temp.commit_check();
$$, '%closed invoice%totals 120000 but titles sum 0 and carried over 0%', 'fechar sem gerar os títulos');
SELECT throws_like($$
  UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a609';
  SELECT pg_temp.invoice_pair('00000000-0000-7000-8000-00000001c091', '00000000-0000-7000-8000-00000001c092',
                              '00000000-0000-7000-8000-00000001a609', 100000, '2026-09-10');
  SELECT pg_temp.commit_check();
$$, '%totals 120000 but titles sum 100000%', 'título com valor diferente da soma da pagadora');
SELECT throws_ok($$
  INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, card_invoice_id, counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', 'receivable', '00000000-0000-7000-8000-00000000e010',
          '00000000-0000-7000-8000-00000000ca10', 'X', '2026-09-01', '2026-09-10', 1, 'card_invoice',
          '00000000-0000-7000-8000-00000001a609', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-00000001c099')
$$, '23514', 'titles: invoice title must be receivable in the card caixa 00000000-0000-7000-8000-0000000c0010 and payable in a general payer caixa',
   'na pagadora a fatura é a pagar');
SELECT throws_ok($$
  INSERT INTO titles (caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents,
                      origin, card_invoice_id, counterparty_caixa_id, mirror_title_id)
  VALUES ('00000000-0000-7000-8000-0000000c0002', 'payable', '00000000-0000-7000-8000-00000000e010',
          '00000000-0000-7000-8000-00000000ca11', 'X', '2026-09-01', '2026-09-10', 1, 'manual',
          '00000000-0000-7000-8000-00000001a609', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-00000001c099')
$$, '23514', NULL, 'título manual não aponta para fatura');
SELECT lives_ok($$
  UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a609';
  SELECT pg_temp.invoice_pair('00000000-0000-7000-8000-00000001c091', '00000000-0000-7000-8000-00000001c092',
                              '00000000-0000-7000-8000-00000001a609', 120000, '2026-09-10');
  SELECT pg_temp.commit_check();
$$, 'fechar 09/2026: a receber no cartão, espelhada a pagar na pagadora');
SELECT throws_ok($$
  UPDATE titles SET card_invoice_id = '00000000-0000-7000-8000-00000001a610' WHERE id = '00000000-0000-7000-8000-00000001c092';
  SELECT pg_temp.commit_check();
$$, '23514', NULL, 'os dois lados apontam para a mesma fatura');

SELECT throws_ok($$INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
                   VALUES ('00000000-0000-7000-8000-00000001a609', '00000000-0000-7000-8000-00000001b002', 2,
                           '00000000-0000-7000-8000-0000000c0002', 1)$$,
                 '23514', 'card_invoice_items: invoice 00000000-0000-7000-8000-00000001a609 is closed', 'fatura fechada não recebe item');
SELECT throws_ok($$UPDATE card_invoice_items SET amount_cents = 1 WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a609'$$,
                 '23514', NULL, 'item de fatura fechada não muda');
SELECT throws_ok($$DELETE FROM card_purchases WHERE id IN ('00000000-0000-7000-8000-00000001b003', '00000000-0000-7000-8000-00000001b001')$$,
                 '23514', NULL, 'compra com parcela em fatura fechada não é excluída');
SELECT throws_ok($$UPDATE card_invoices SET due_date = '2026-09-11' WHERE id = '00000000-0000-7000-8000-00000001a609'$$,
                 '23514', 'card_invoices: dates of closed invoice 00000000-0000-7000-8000-00000001a609 cannot change (reopen it first)',
                 'datas da fatura fechada não mudam');
SELECT throws_like($$
  UPDATE card_purchases SET payer_caixa_id = '00000000-0000-7000-8000-0000000c0001'
   WHERE id IN ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-00000001b003');
  SELECT pg_temp.commit_check();
$$, '%for payer 00000000-0000-7000-8000-0000000c0001%', 'trocar a pagadora com parcela já faturada');

-- Reabrir sem pagamento: a aplicação exclui (ou cancela) os títulos na mesma transação.
SELECT throws_like($$
  UPDATE card_invoices SET closed_at = NULL WHERE id = '00000000-0000-7000-8000-00000001a609';
  SELECT pg_temp.commit_check();
$$, '%open invoice%can only have fully paid titles%', 'reabrir sem tirar os títulos');
SELECT lives_ok($$
  UPDATE card_invoices SET closed_at = NULL WHERE id = '00000000-0000-7000-8000-00000001a609';
  UPDATE titles SET status = 'canceled' WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a609';
  SELECT pg_temp.commit_check();
$$, 'reabrir cancelando os títulos');
SELECT lives_ok($$
  UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a609';
  DELETE FROM titles WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a609';
  SELECT pg_temp.invoice_pair('00000000-0000-7000-8000-00000001c091', '00000000-0000-7000-8000-00000001c092',
                              '00000000-0000-7000-8000-00000001a609', 120000, '2026-09-10');
  SELECT pg_temp.commit_check();
$$, 'fechar de novo');
SELECT is((SELECT status FROM card_invoice_summaries WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a609'),
          'closed', 'fatura fechada em aberto');

-- Pagamento integral de 09/2026
SELECT lives_ok($$
  SELECT pg_temp.pay('00000000-0000-7000-8000-00000001d091', '00000000-0000-7000-8000-00000001d092',
                     '00000000-0000-7000-8000-00000001c091', '00000000-0000-7000-8000-00000001c092', 120000, '2026-09-10');
  SELECT pg_temp.commit_check();
$$, 'pagar a fatura: a perna do cartão fica sem conta');
SELECT results_eq($$SELECT status, total_cents, billed_cents, settled_cents, open_cents FROM card_invoice_summaries
                     WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a609'$$,
                  $$VALUES ('paid', 120000::bigint, 120000::bigint, 120000::bigint, 0::bigint)$$, 'fatura paga');
SELECT throws_ok($$UPDATE card_invoices SET closed_at = NULL WHERE id = '00000000-0000-7000-8000-00000001a609'$$,
                 '23514', 'card_invoices: invoice 00000000-0000-7000-8000-00000001a609 has payments and cannot be reopened',
                 'fatura com pagamento não reabre');

-- Fatura 10/2026: pagamento parcial e saldo rolado com juros -----------------------------------------
SELECT results_eq($$SELECT sum(amount_cents)::bigint FROM card_invoice_lines
                     WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a610'
                       AND payer_caixa_id = '00000000-0000-7000-8000-0000000c0002'$$,
                  $$VALUES (147000::bigint)$$, 'fatura 10/2026 = 350 + 1.200 (2/6) − 80 = 1.470,00');
SELECT results_eq($$SELECT description, entity_id FROM card_invoice_lines
                     WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a610' AND purchase_kind = 'refund'$$,
                  $$VALUES ('Estorno Kalunga', '00000000-0000-7000-8000-00000000e021'::uuid)$$, 'linha rastreia o recebedor final');
SELECT lives_ok($$
  UPDATE card_invoices SET closed_at = now() WHERE id = '00000000-0000-7000-8000-00000001a610';
  SELECT pg_temp.invoice_pair('00000000-0000-7000-8000-00000001c101', '00000000-0000-7000-8000-00000001c102',
                              '00000000-0000-7000-8000-00000001a610', 147000, '2026-10-10');
  SELECT pg_temp.commit_check();
  SELECT pg_temp.pay('00000000-0000-7000-8000-00000001d101', '00000000-0000-7000-8000-00000001d102',
                     '00000000-0000-7000-8000-00000001c101', '00000000-0000-7000-8000-00000001c102', 100000, '2026-10-10');
  SELECT pg_temp.commit_check();
$$, 'fechar 10/2026 e pagar 1.000,00 de 1.470,00');
SELECT throws_ok($$INSERT INTO card_invoice_items (card_invoice_id, kind, carried_from_invoice_id, payer_caixa_id, amount_cents)
                   VALUES ('00000000-0000-7000-8000-00000001a611', 'carryover', '00000000-0000-7000-8000-00000001a612',
                           '00000000-0000-7000-8000-0000000c0002', 47000)$$,
                 '23514', 'card_invoice_items: carryover must come from an earlier closed invoice of the same card',
                 'rolar só de fatura fechada anterior');
SELECT throws_like($$
  INSERT INTO card_invoice_items (card_invoice_id, kind, carried_from_invoice_id, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a611', 'carryover', '00000000-0000-7000-8000-00000001a610',
          '00000000-0000-7000-8000-0000000c0002', 47000);
  SELECT pg_temp.commit_check();
$$, '%totals 147000 but titles sum 147000 and carried over 47000%', 'rolar sem reduzir o título');
SELECT lives_ok($$
  UPDATE titles SET amount_cents = 100000
   WHERE id IN ('00000000-0000-7000-8000-00000001c101', '00000000-0000-7000-8000-00000001c102');
  INSERT INTO card_invoice_items (card_invoice_id, kind, carried_from_invoice_id, payer_caixa_id, amount_cents, description)
  VALUES ('00000000-0000-7000-8000-00000001a611', 'carryover', '00000000-0000-7000-8000-00000001a610',
          '00000000-0000-7000-8000-0000000c0002', 47000, 'Saldo da fatura 10/2026');
  INSERT INTO card_purchases (id, card_caixa_id, kind, charge_kind, payer_caixa_id, entity_id, category_id, purchased_on,
                              description, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001b004', '00000000-0000-7000-8000-0000000c0010', 'charge', 'interest',
          '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-00000000e010', '00000000-0000-7000-8000-00000000ca03',
          '2026-10-15', 'Juros do rotativo', 2000);
  INSERT INTO card_invoice_items (card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
  VALUES ('00000000-0000-7000-8000-00000001a611', '00000000-0000-7000-8000-00000001b004', 1, '00000000-0000-7000-8000-0000000c0002', 2000);
  SELECT pg_temp.commit_check();
$$, 'restante rola para 11/2026 com juros do emissor');
SELECT results_eq($$SELECT status, total_cents, billed_cents, settled_cents, open_cents, carried_out_cents FROM card_invoice_summaries
                     WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a610'$$,
                  $$VALUES ('closed', 147000::bigint, 100000::bigint, 100000::bigint, 0::bigint, 47000::bigint)$$,
                  '10/2026: paga em parte, saldo rolado');
SELECT is((SELECT status FROM titles WHERE id = '00000000-0000-7000-8000-00000001c102'), 'paid', 'título reduzido ao pago fica quitado');
SELECT throws_ok($$UPDATE card_invoices SET closed_at = NULL WHERE id = '00000000-0000-7000-8000-00000001a610'$$,
                 '23514', NULL, 'fatura com saldo rolado não reabre');
SELECT throws_ok($$INSERT INTO card_invoice_items (card_invoice_id, kind, carried_from_invoice_id, payer_caixa_id, amount_cents)
                   VALUES ('00000000-0000-7000-8000-00000001a612', 'carryover', '00000000-0000-7000-8000-00000001a610',
                           '00000000-0000-7000-8000-0000000c0002', 1)$$,
                 '23505', NULL, 'um saldo rolado por fatura e pagadora');

-- Antecipação na fatura aberta 11/2026 ---------------------------------------------------------------
SELECT throws_like($$
  SELECT pg_temp.invoice_pair('00000000-0000-7000-8000-00000001c111', '00000000-0000-7000-8000-00000001c112',
                              '00000000-0000-7000-8000-00000001a611', 20000, '2026-10-20');
  SELECT pg_temp.commit_check();
$$, '%open invoice%can only have fully paid titles%', 'fatura aberta não tem título a pagar pendente');
SELECT lives_ok($$
  SELECT pg_temp.invoice_pair('00000000-0000-7000-8000-00000001c111', '00000000-0000-7000-8000-00000001c112',
                              '00000000-0000-7000-8000-00000001a611', 20000, '2026-10-20');
  SELECT pg_temp.pay('00000000-0000-7000-8000-00000001d111', '00000000-0000-7000-8000-00000001d112',
                     '00000000-0000-7000-8000-00000001c111', '00000000-0000-7000-8000-00000001c112', 20000, '2026-10-20');
  SELECT pg_temp.commit_check();
$$, 'pagamento antecipado: título já pago na fatura aberta');
SELECT results_eq($$SELECT items_cents, billed_cents, settled_cents FROM card_invoice_payer_totals
                     WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a611'$$,
                  $$VALUES (169000::bigint, 20000::bigint, 20000::bigint)$$,
                  '11/2026: 1.200 (3/6) + 470 rolado + 20 juros; 200 antecipados');
SELECT is((SELECT status FROM card_invoice_summaries WHERE card_invoice_id = '00000000-0000-7000-8000-00000001a611'), 'open',
          'fatura com antecipação continua aberta');

-- Limite comprometido --------------------------------------------------------------------------------
-- Parcelas: 7.200 + 350 − 80 + 20 (juros) = 7.490,00; pago: 1.200 + 1.000 + 200 = 2.400,00.
SELECT results_eq($$SELECT credit_limit_cents, used_cents, available_cents FROM card_limits
                     WHERE card_caixa_id = '00000000-0000-7000-8000-0000000c0010'$$,
                  $$VALUES (2000000::bigint, 509000::bigint, 1491000::bigint)$$, 'limite, usado e disponível');
SELECT results_eq($$SELECT used_cents FROM card_limits WHERE card_caixa_id = '00000000-0000-7000-8000-0000000c0011'$$,
                  $$VALUES (0::bigint)$$, 'cartão sem lançamentos');
SELECT is((SELECT count(*)::int FROM card_limits WHERE card_caixa_id = '00000000-0000-7000-8000-0000000c0002'), 0,
          'card_limits só lista cartões');

-- Anexos de compra
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'nota.pdf', 'application/pdf', '\x25504446');
SELECT lives_ok($$INSERT INTO card_purchase_attachments (card_purchase_id, attachment_id)
                  VALUES ('00000000-0000-7000-8000-00000001b002', '00000000-0000-7000-8000-0000000a7001')$$, 'anexo na compra');
SELECT results_eq($$SELECT target_kind FROM attachment_links WHERE attachment_id = '00000000-0000-7000-8000-0000000a7001'$$,
                  $$VALUES ('card_purchase')$$, 'attachment_links inclui compras');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['card_invoices', 'card_purchases', 'card_invoice_items', 'card_purchase_attachments']) t;
SELECT ok(has_table_privilege('moneyflow_app', v, 'SELECT'), 'app lê ' || v)
  FROM unnest(ARRAY['card_invoice_payer_totals', 'card_invoice_summaries', 'card_invoice_lines', 'card_limits']) v;

SELECT * FROM finish();
ROLLBACK;
