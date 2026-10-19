-- Testes de 0048_statement_lines_created_entry: o lançamento criado a partir da linha conciliada
-- (checagens e a inferência usada no backfill das linhas já conciliadas).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura -------------------------------------------------------------------------------------------
SELECT has_column('statement_lines', 'created_entry');
SELECT col_type_is('statement_lines', 'created_entry', 'text');
SELECT col_is_null('statement_lines', 'created_entry');
SELECT col_hasnt_default('statement_lines', 'created_entry');
SELECT has_function('statement_line_inferred_created_entry', ARRAY['uuid']);
SELECT ok(NOT has_function_privilege('moneyflow_app', 'statement_line_inferred_created_entry(uuid)', 'EXECUTE'),
          'a inferência do backfill não é da aplicação');
SELECT ok(has_column_privilege('moneyflow_app', 'statement_lines', 'created_entry', 'SELECT')
          AND has_column_privilege('moneyflow_app', 'statement_lines', 'created_entry', 'INSERT')
          AND has_column_privilege('moneyflow_app', 'statement_lines', 'created_entry', 'UPDATE'),
          'a aplicação lê e grava created_entry');

-- Dados base -------------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000480e1', 'person', 'Titular 48'),
  ('00000000-0000-7000-8000-0000000480e2', 'company', 'Fornecedor 48'),
  ('00000000-0000-7000-8000-0000000480e3', 'company', 'Banco Cartão 48');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000480c1', 'Casa 48', 'general', '00000000-0000-7000-8000-0000000480e1', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000480c2', 'Cartão 48', 'credit_card', '00000000-0000-7000-8000-0000000480e3',
   '00000000-0000-7000-8000-0000000480c1', 500000, 3, 10, '4848');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000480a1', '00000000-0000-7000-8000-0000000480c1', 'checking', 'Corrente 48', '2026-01-01', 100000);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000048ca01', 'expense', 'Despesa 48');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-00000048a701', 'extrato.ofx', 'application/x-ofx', '\x4f4658'),
  ('00000000-0000-7000-8000-00000048a702', 'fatura.csv', 'text/csv', '\x6661740a');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end) VALUES
  ('00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1', 'ofx',
   '00000000-0000-7000-8000-00000048a701', '2026-10-01', '2026-10-31');

-- Lançamentos: os "novos" nascem nesta transação (created_at = now()); os antigos, um dia antes.
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, description, created_at) VALUES
  ('00000000-0000-7000-8000-00000048f001', '00000000-0000-7000-8000-0000000480a1', '2026-10-05', -1000, 'adjustment', 'Tarifa', now()),
  ('00000000-0000-7000-8000-00000048f002', '00000000-0000-7000-8000-0000000480a1', '2026-10-05', -2000, 'adjustment', 'Antigo',
   now() - interval '1 day');

-- Título criado pela linha (e a baixa dele); título antigo baixado pela linha; baixa antiga.
INSERT INTO titles (id, caixa_id, direction, entity_id, category_id, description, competence_date, due_date, amount_cents, created_at) VALUES
  ('00000000-0000-7000-8000-00000048b001', '00000000-0000-7000-8000-0000000480c1', 'payable', '00000000-0000-7000-8000-0000000480e2',
   '00000000-0000-7000-8000-00000048ca01', 'Novo', '2026-10-01', '2026-10-06', 3000, now()),
  ('00000000-0000-7000-8000-00000048b002', '00000000-0000-7000-8000-0000000480c1', 'payable', '00000000-0000-7000-8000-0000000480e2',
   '00000000-0000-7000-8000-00000048ca01', 'Em aberto', '2026-10-01', '2026-10-07', 4000, now() - interval '1 day'),
  ('00000000-0000-7000-8000-00000048b003', '00000000-0000-7000-8000-0000000480c1', 'payable', '00000000-0000-7000-8000-0000000480e2',
   '00000000-0000-7000-8000-00000048ca01', 'Já baixado', '2026-10-01', '2026-10-08', 5000, now() - interval '2 days');
INSERT INTO settlements (id, title_id, settled_on, amount_cents, financial_account_id, created_at) VALUES
  ('00000000-0000-7000-8000-00000048d001', '00000000-0000-7000-8000-00000048b001', '2026-10-06', 3000,
   '00000000-0000-7000-8000-0000000480a1', now()),
  ('00000000-0000-7000-8000-00000048d002', '00000000-0000-7000-8000-00000048b002', '2026-10-07', 4000,
   '00000000-0000-7000-8000-0000000480a1', now()),
  ('00000000-0000-7000-8000-00000048d003', '00000000-0000-7000-8000-00000048b003', '2026-10-08', 5000,
   '00000000-0000-7000-8000-0000000480a1', now() - interval '1 day');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, settlement_id, created_at) VALUES
  ('00000000-0000-7000-8000-00000048f003', '00000000-0000-7000-8000-0000000480a1', '2026-10-06', -3000, 'settlement',
   '00000000-0000-7000-8000-00000048d001', now()),
  ('00000000-0000-7000-8000-00000048f004', '00000000-0000-7000-8000-0000000480a1', '2026-10-07', -4000, 'settlement',
   '00000000-0000-7000-8000-00000048d002', now()),
  ('00000000-0000-7000-8000-00000048f005', '00000000-0000-7000-8000-0000000480a1', '2026-10-08', -5000, 'settlement',
   '00000000-0000-7000-8000-00000048d003', now() - interval '1 day');

-- Cartão: compra criada pela linha e compra antiga.
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000048a610', '00000000-0000-7000-8000-0000000480c2', '2026-10-01', '2026-10-03', '2026-10-10');
INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents, created_at) VALUES
  ('00000000-0000-7000-8000-00000048b101', '00000000-0000-7000-8000-0000000480c2', '00000000-0000-7000-8000-0000000480c1',
   '00000000-0000-7000-8000-0000000480e2', '00000000-0000-7000-8000-00000048ca01', '2026-09-20', 'Nova', 6000, now()),
  ('00000000-0000-7000-8000-00000048b102', '00000000-0000-7000-8000-0000000480c2', '00000000-0000-7000-8000-0000000480c1',
   '00000000-0000-7000-8000-0000000480e2', '00000000-0000-7000-8000-00000048ca01', '2026-09-21', 'Antiga', 7000,
   now() - interval '1 day');
INSERT INTO card_invoice_items (id, card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents) VALUES
  ('00000000-0000-7000-8000-00000048f101', '00000000-0000-7000-8000-00000048a610', '00000000-0000-7000-8000-00000048b101',
   1, '00000000-0000-7000-8000-0000000480c1', 6000),
  ('00000000-0000-7000-8000-00000048f102', '00000000-0000-7000-8000-00000048a610', '00000000-0000-7000-8000-00000048b102',
   1, '00000000-0000-7000-8000-0000000480c1', 7000);
INSERT INTO statement_imports (id, card_caixa_id, card_invoice_id, format, attachment_id, period_start, period_end) VALUES
  ('00000000-0000-7000-8000-00000048ac02', '00000000-0000-7000-8000-0000000480c2', '00000000-0000-7000-8000-00000048a610',
   'csv', '00000000-0000-7000-8000-00000048a702', '2026-09-04', '2026-10-03');

-- Linhas: conciliadas nesta transação (matched_at = now()), mais uma nova.
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, movement_id, matched_at) VALUES
  ('00000000-0000-7000-8000-00000048ad01', '00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1',
   1, '2026-10-05', -1000, 'TARIFA', 'h1', 'matched', '00000000-0000-7000-8000-00000048f001', now()),
  ('00000000-0000-7000-8000-00000048ad02', '00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1',
   2, '2026-10-05', -2000, 'ANTIGO', 'h2', 'matched', '00000000-0000-7000-8000-00000048f002', now()),
  ('00000000-0000-7000-8000-00000048ad03', '00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1',
   3, '2026-10-06', -3000, 'NOVO', 'h3', 'matched', '00000000-0000-7000-8000-00000048f003', now()),
  ('00000000-0000-7000-8000-00000048ad04', '00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1',
   4, '2026-10-07', -4000, 'EM ABERTO', 'h4', 'matched', '00000000-0000-7000-8000-00000048f004', now()),
  ('00000000-0000-7000-8000-00000048ad05', '00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1',
   5, '2026-10-08', -5000, 'JA BAIXADO', 'h5', 'matched', '00000000-0000-7000-8000-00000048f005', now());
INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents, description,
                             dedup_hash) VALUES
  ('00000000-0000-7000-8000-00000048ad06', '00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1',
   6, '2026-10-09', -9000, 'SEM PAR', 'h6');
INSERT INTO statement_lines (id, statement_import_id, card_caixa_id, line_number, posted_on, amount_cents, description,
                             dedup_hash, status, card_invoice_item_id, matched_at) VALUES
  ('00000000-0000-7000-8000-00000048ad11', '00000000-0000-7000-8000-00000048ac02', '00000000-0000-7000-8000-0000000480c2',
   1, '2026-09-20', -6000, 'NOVA', 'c1', 'matched', '00000000-0000-7000-8000-00000048f101', now()),
  ('00000000-0000-7000-8000-00000048ad12', '00000000-0000-7000-8000-00000048ac02', '00000000-0000-7000-8000-0000000480c2',
   2, '2026-09-21', -7000, 'ANTIGA', 'c2', 'matched', '00000000-0000-7000-8000-00000048f102', now());
SELECT pg_temp.commit_check();

SELECT is((SELECT count(*)::int FROM statement_lines WHERE created_entry IS NOT NULL
             AND statement_import_id IN ('00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-00000048ac02')), 0,
          'sem a aplicação gravar, created_entry fica nulo');

-- Inferência do backfill ------------------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT l.line_number, l.card_caixa_id IS NOT NULL, statement_line_inferred_created_entry(l.id)
      FROM statement_lines l
     WHERE l.statement_import_id IN ('00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-00000048ac02')
     ORDER BY l.card_caixa_id IS NOT NULL, l.line_number$$,
  $$VALUES (1, false, 'adjustment'::text), (2, false, NULL), (3, false, 'title'), (4, false, 'settlement'),
           (5, false, NULL), (6, false, NULL), (1, true, 'purchase'), (2, true, NULL)$$,
  'adjustment, title, settlement e purchase pelo instante da conciliação; lançamento antigo ou linha nova: nulo');
SELECT is(statement_line_inferred_created_entry('00000000-0000-7000-8000-0000000000ff'), NULL, 'linha inexistente: nulo');

-- O mesmo UPDATE do backfill passa nas checagens.
SELECT lives_ok($$UPDATE statement_lines l SET created_entry = x.created_entry
                    FROM (SELECT id, statement_line_inferred_created_entry(id) AS created_entry
                            FROM statement_lines WHERE status = 'matched') x
                   WHERE l.id = x.id AND x.created_entry IS NOT NULL$$, 'backfill grava os valores inferidos');
SELECT results_eq(
  $$SELECT id, created_entry FROM statement_lines WHERE created_entry IS NOT NULL
      AND statement_import_id IN ('00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-00000048ac02') ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-00000048ad01'::uuid, 'adjustment'::text),
           ('00000000-0000-7000-8000-00000048ad03'::uuid, 'title'),
           ('00000000-0000-7000-8000-00000048ad04'::uuid, 'settlement'),
           ('00000000-0000-7000-8000-00000048ad11'::uuid, 'purchase')$$,
  'só as linhas que criaram o lançamento ficam marcadas');

-- Checagens ---------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$UPDATE statement_lines SET created_entry = 'transfer' WHERE id = '00000000-0000-7000-8000-00000048ad02'$$),
          '23514 statement_lines_created_entry_check', 'valor fora da lista');
SELECT is(pg_temp.err($$UPDATE statement_lines SET created_entry = 'adjustment' WHERE id = '00000000-0000-7000-8000-00000048ad06'$$),
          '23514 statement_lines_created_entry_check', 'só em linha matched');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'new', movement_id = NULL, matched_at = NULL
                         WHERE id = '00000000-0000-7000-8000-00000048ad01'$$),
          '23514 statement_lines_created_entry_check', 'desfazer sem limpar created_entry é recusado');
SELECT is(pg_temp.err($$UPDATE statement_lines SET status = 'ignored', movement_id = NULL, matched_at = NULL
                         WHERE id = '00000000-0000-7000-8000-00000048ad03'$$),
          '23514 statement_lines_created_entry_check', 'ignorar sem limpar created_entry é recusado');
SELECT is(pg_temp.err($$UPDATE statement_lines SET created_entry = 'purchase' WHERE id = '00000000-0000-7000-8000-00000048ad02'$$),
          '23514 statement_lines_created_entry_links_check', 'purchase exige o item de fatura');
SELECT results_eq(
  $$SELECT v, pg_temp.err(format('UPDATE statement_lines SET created_entry = %L WHERE id = %L', v,
                                 '00000000-0000-7000-8000-00000048ad12'))
      FROM unnest(ARRAY['adjustment', 'title', 'settlement']) v$$,
  $$VALUES ('adjustment', '23514 statement_lines_created_entry_links_check'),
           ('title', '23514 statement_lines_created_entry_links_check'),
           ('settlement', '23514 statement_lines_created_entry_links_check')$$,
  'adjustment, title e settlement exigem o movimento');
SELECT is(pg_temp.err($$INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents,
                                                     description, dedup_hash, created_entry)
                        VALUES ('00000000-0000-7000-8000-00000048ac01', '00000000-0000-7000-8000-0000000480a1', 7, '2026-10-09',
                                -1, 'X', 'h7', 'adjustment')$$),
          '23514 statement_lines_created_entry_check', 'linha nova não nasce marcada');

-- A aplicação grava e limpa ------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$UPDATE statement_lines SET status = 'new', movement_id = NULL, matched_at = NULL, created_entry = NULL
                   WHERE id = '00000000-0000-7000-8000-00000048ad01'$$, 'desfazer limpando created_entry (pela aplicação)');
SELECT lives_ok($$UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-00000048f001',
                                             matched_at = now(), created_entry = 'adjustment'
                   WHERE id = '00000000-0000-7000-8000-00000048ad01'$$, 'conciliar marcando created_entry (pela aplicação)');
SELECT lives_ok($$UPDATE statement_lines SET created_entry = NULL WHERE id = '00000000-0000-7000-8000-00000048ad11'$$,
                'limpar a marca de uma compra (pela aplicação)');
SELECT throws_ok($$SELECT statement_line_inferred_created_entry('00000000-0000-7000-8000-00000048ad01')$$, '42501', NULL,
                 'a aplicação não executa a inferência');
RESET ROLE;
SELECT is((SELECT created_entry FROM statement_lines WHERE id = '00000000-0000-7000-8000-00000048ad01'), 'adjustment',
          'marca gravada pela aplicação');
SELECT ok((SELECT 'created_entry' = ANY (changed_columns) FROM audit_log
            WHERE table_name = 'statement_lines' AND record_id = '00000000-0000-7000-8000-00000048ad11'
            ORDER BY created_at DESC, id DESC LIMIT 1), 'a mudança da marca é auditada');

SELECT * FROM finish();
ROLLBACK;
