-- Testes de 0019_flow_graph: linhas, arestas e nós do canvas de fluxo; posições salvas por usuário.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_function('flow_graph_lines', ARRAY['uuid[]', 'date', 'date']);
SELECT has_function('flow_graph_edges', ARRAY['uuid[]', 'date', 'date']);
SELECT has_function('flow_graph_nodes', ARRAY['uuid[]', 'date', 'date']);
SELECT has_table('canvas_node_positions');
SELECT columns_are('canvas_node_positions', ARRAY['id', 'user_id', 'layout', 'node_kind', 'node_id', 'x', 'y', 'created_at', 'updated_at']);
SELECT fk_ok('canvas_node_positions', 'user_id', 'users', 'id');

-- Mesmo cenário de 0018_reports.
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

-- Arestas com as três caixas ------------------------------------------------------------------------------
-- Casa c0001, Empresa c0002, cartão c0010.
SELECT results_eq($$
  SELECT source_kind, source_id, target_kind, target_id, edge_kind, payer_caixa_id, realized_cents, forecast_cents, lines
    FROM flow_graph_edges((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')
   ORDER BY edge_kind, source_id, target_id, payer_caixa_id$$,
  $$VALUES
    ('caixa', '00000000-0000-7000-8000-0000000c0002'::uuid, 'caixa', '00000000-0000-7000-8000-0000000c0010'::uuid, 'card_invoice',
     '00000000-0000-7000-8000-0000000c0002'::uuid, 10000::bigint, 0::bigint, 1),
    ('caixa', '00000000-0000-7000-8000-0000000c0010', 'entity', '00000000-0000-7000-8000-00000000e005', 'card_purchase',
     '00000000-0000-7000-8000-0000000c0001', 5000, 0, 1),
    ('caixa', '00000000-0000-7000-8000-0000000c0010', 'entity', '00000000-0000-7000-8000-00000000e007', 'card_purchase',
     '00000000-0000-7000-8000-0000000c0002', 8000, 0, 2),
    ('caixa', '00000000-0000-7000-8000-0000000c0001', 'entity', '00000000-0000-7000-8000-00000000e005', 'payment',
     NULL, 32000, 4000, 3),
    ('caixa', '00000000-0000-7000-8000-0000000c0002', 'caixa', '00000000-0000-7000-8000-0000000c0001', 'payment',
     NULL, 50000, 0, 1),
    ('entity', '00000000-0000-7000-8000-00000000e008', 'caixa', '00000000-0000-7000-8000-0000000c0002', 'receipt',
     NULL, 30000, 50000, 2),
    ('caixa', '00000000-0000-7000-8000-0000000c0001', 'caixa', '00000000-0000-7000-8000-0000000c0002', 'transfer',
     NULL, 7000, 0, 1)$$,
  'arestas: espelho uma vez só (lado a pagar), fatura pagadora → cartão, compras cartão → lojista, transferência');

SELECT results_eq($$
  SELECT ref_kind, ref_id, occurred_on, realized_cents, forecast_cents, category_id
    FROM flow_graph_lines((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')
   WHERE edge_kind = 'payment' AND source_id = '00000000-0000-7000-8000-0000000c0001'
   ORDER BY occurred_on$$,
  $$VALUES ('settlement', '00000000-0000-7000-8000-0000000d0001'::uuid, '2026-10-05'::date, 30500::bigint, 0::bigint,
            '00000000-0000-7000-8000-00000000ca02'::uuid),
           ('title', '00000000-0000-7000-8000-0000000b0005', '2026-10-08', 0, 4000, '00000000-0000-7000-8000-00000000ca01'),
           ('movement', (SELECT id FROM movements WHERE description = 'Tarifa'), '2026-10-25', 1500, 0, NULL)$$,
  'linhas da aresta: baixa em dinheiro, saldo aberto previsto (baixa estornada não conta) e ajuste com entidade');

-- Só a Empresa: as outras caixas viram o titular ---------------------------------------------------------
SELECT results_eq($$
  SELECT source_kind, source_id, target_kind, target_id, edge_kind, realized_cents, forecast_cents
    FROM flow_graph_edges(ARRAY['00000000-0000-7000-8000-0000000c0002'::uuid], '2026-10-01', '2026-10-31')
   ORDER BY edge_kind, source_id, target_id$$,
  $$VALUES
    ('caixa', '00000000-0000-7000-8000-0000000c0002'::uuid, 'entity', '00000000-0000-7000-8000-00000000e010'::uuid, 'card_invoice',
     10000::bigint, 0::bigint),
    ('caixa', '00000000-0000-7000-8000-0000000c0002', 'entity', '00000000-0000-7000-8000-00000000e001', 'payment', 50000, 0),
    ('entity', '00000000-0000-7000-8000-00000000e008', 'caixa', '00000000-0000-7000-8000-0000000c0002', 'receipt', 30000, 50000),
    ('entity', '00000000-0000-7000-8000-00000000e001', 'caixa', '00000000-0000-7000-8000-0000000c0002', 'transfer', 7000, 0)$$,
  'caixa fora da lista aparece como o titular; compras do cartão só com o cartão na lista');
SELECT results_eq($$
  SELECT source_id, target_kind, target_id, edge_kind, payer_caixa_id, forecast_cents
    FROM flow_graph_edges(ARRAY['00000000-0000-7000-8000-0000000c0002'::uuid], '2026-11-01', '2026-11-30')$$,
  $$VALUES ('00000000-0000-7000-8000-0000000c0002'::uuid, 'entity', '00000000-0000-7000-8000-00000000e010'::uuid, 'card_invoice',
            '00000000-0000-7000-8000-0000000c0002'::uuid, 8000::bigint)$$,
  'fatura aberta: previsão (itens − estorno) da pagadora para o emissor');
SELECT results_eq($$
  SELECT source_kind, source_id, target_id, edge_kind, forecast_cents
    FROM flow_graph_edges(ARRAY['00000000-0000-7000-8000-0000000c0010'::uuid], '2026-11-01', '2026-11-30')
   ORDER BY source_id$$,
  $$VALUES ('entity', '00000000-0000-7000-8000-00000000e001'::uuid, '00000000-0000-7000-8000-0000000c0010'::uuid, 'card_invoice', 5000::bigint),
           ('entity', '00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-0000000c0010', 'card_invoice', 8000)$$,
  'só o cartão: previsão chega das pagadoras (como titulares)');

-- Nós --------------------------------------------------------------------------------------------------------
SELECT results_eq($$
  SELECT node_kind, node_id, name, caixa_kind, entity_kind, balance_cents, card_used_cents, main_category_id, main_group_category_id,
         realized_in_cents, realized_out_cents, forecast_in_cents, forecast_out_cents
    FROM flow_graph_nodes((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')$$,
  $$VALUES
    ('caixa', '00000000-0000-7000-8000-0000000c0001'::uuid, 'Casa', 'general', NULL::text, 113000::bigint, NULL::bigint,
     NULL::uuid, NULL::uuid, 50000::bigint, 39000::bigint, 0::bigint, 4000::bigint),
    ('caixa', '00000000-0000-7000-8000-0000000c0002', 'Minha Empresa', 'general', NULL, 177000, NULL, NULL, NULL, 37000, 60000, 50000, 0),
    ('caixa', '00000000-0000-7000-8000-0000000c0010', 'Nubank PJ', 'credit_card', NULL, NULL, 13000, NULL, NULL, 10000, 13000, 0, 0),
    ('entity', '00000000-0000-7000-8000-00000000e008', 'Cliente X', NULL, 'company', NULL, NULL,
     '00000000-0000-7000-8000-00000000ca12', '00000000-0000-7000-8000-00000000ca12', 0, 30000, 0, 50000),
    ('entity', '00000000-0000-7000-8000-00000000e005', 'Energia SA', NULL, 'company', NULL, NULL,
     '00000000-0000-7000-8000-00000000ca02', '00000000-0000-7000-8000-00000000ca01', 37000, 0, 4000, 0),
    ('entity', '00000000-0000-7000-8000-00000000e007', 'Posto Shell', NULL, 'company', NULL, NULL,
     '00000000-0000-7000-8000-00000000ca03', '00000000-0000-7000-8000-00000000ca03', 8000, 0, 0, 0)$$,
  'nós: caixas com saldo/limite usado e entidades com categoria principal e totais');

SELECT throws_ok($$SELECT * FROM flow_graph_edges(ARRAY[]::uuid[], '2026-10-31', '2026-10-01')$$, '22023', NULL, 'período inválido');
SELECT is((SELECT count(*)::int FROM flow_graph_nodes(ARRAY[]::uuid[], '2026-10-01', '2026-10-31')), 0, 'lista vazia: nenhum nó');

-- Posições ---------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'x'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'x');
INSERT INTO canvas_node_positions (user_id, node_kind, node_id, x, y) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'caixa', '00000000-0000-7000-8000-0000000c0001', 10, 20),
  ('00000000-0000-7000-8000-0000000000a2', 'caixa', '00000000-0000-7000-8000-0000000c0001', 99, 99);
SELECT lives_ok($$
  INSERT INTO canvas_node_positions (user_id, node_kind, node_id, x, y)
  VALUES ('00000000-0000-7000-8000-0000000000a1', 'caixa', '00000000-0000-7000-8000-0000000c0001', 15.5, -3)
  ON CONFLICT (user_id, layout, node_kind, node_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y
$$, 'upsert da posição');
SELECT results_eq($$SELECT layout, x, y FROM canvas_node_positions WHERE user_id = '00000000-0000-7000-8000-0000000000a1'$$,
                  $$VALUES ('default', 15.5::double precision, -3::double precision)$$, 'uma posição por usuário, layout e nó');
SELECT lives_ok($$INSERT INTO canvas_node_positions (user_id, layout, node_kind, node_id, x, y)
                  VALUES ('00000000-0000-7000-8000-0000000000a1', 'Visão empresa', 'category_group',
                          '00000000-0000-7000-8000-00000000ca01', 0, 0)$$, 'layout nomeado e grupo de categoria');
SELECT throws_ok($$INSERT INTO canvas_node_positions (user_id, node_kind, node_id, x, y)
                   VALUES ('00000000-0000-7000-8000-0000000000a1', 'account', '00000000-0000-7000-8000-0000000a0001', 0, 0)$$,
                 '23514', NULL, 'tipo de nó inválido');
SELECT throws_ok($$INSERT INTO canvas_node_positions (user_id, layout, node_kind, node_id, x, y)
                   VALUES ('00000000-0000-7000-8000-0000000000a1', ' ', 'caixa', '00000000-0000-7000-8000-0000000c0002', 0, 0)$$,
                 '23514', NULL, 'layout em branco');
SELECT throws_ok($$INSERT INTO canvas_node_positions (user_id, node_kind, node_id, x, y)
                   VALUES ('00000000-0000-7000-8000-0000000000a1', 'caixa', '00000000-0000-7000-8000-0000000c0002', 'NaN', 0)$$,
                 '23514', NULL, 'coordenada inválida');
DELETE FROM users WHERE id = '00000000-0000-7000-8000-0000000000a2';
SELECT is((SELECT count(*)::int FROM canvas_node_positions WHERE user_id = '00000000-0000-7000-8000-0000000000a2'), 0,
          'excluir o usuário leva as posições');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'canvas_node_positions'), 0, 'posições ficam fora da auditoria');

-- Privilégios
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['flow_graph_lines(uuid[], date, date)', 'flow_graph_edges(uuid[], date, date)',
                    'flow_graph_nodes(uuid[], date, date)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['flow_graph_lines(uuid[], date, date)', 'flow_graph_edges(uuid[], date, date)',
                    'flow_graph_nodes(uuid[], date, date)']) f;
SELECT ok(has_table_privilege('moneyflow_app', 'canvas_node_positions', p), 'app tem ' || p || ' nas posições')
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
GRANT SELECT ON ids TO moneyflow_app;
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$SELECT * FROM flow_graph_nodes((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')$$, 'app: nós');
SELECT lives_ok($$SELECT * FROM flow_graph_edges((SELECT all_ids FROM ids), '2026-10-01', '2026-10-31')$$, 'app: arestas');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
