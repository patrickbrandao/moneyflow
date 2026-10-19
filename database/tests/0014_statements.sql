-- Testes de 0014_statements: lotes de import, linhas, dedup, conciliação, mapeamentos CSV e regras.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.commit_check() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; END $$;

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['statement_csv_mappings', 'statement_imports', 'statement_lines', 'classification_rules']) t;
SELECT has_view('statement_import_balances');
SELECT has_function('classification_rule_for', ARRAY['uuid', 'text', 'bigint']);
SELECT columns_are('statement_imports', ARRAY['id', 'financial_account_id', 'card_caixa_id', 'card_invoice_id', 'format',
                                              'attachment_id', 'csv_mapping_id', 'period_start', 'period_end', 'bank_balance_cents',
                                              'bank_balance_on', 'imported_by_user_id', 'notes', 'created_at', 'updated_at']);
SELECT columns_are('statement_lines', ARRAY['id', 'statement_import_id', 'financial_account_id', 'card_caixa_id', 'line_number',
                                            'posted_on', 'amount_cents', 'description', 'fitid', 'dedup_hash', 'status',
                                            'movement_id', 'title_id', 'card_invoice_item_id', 'entity_id', 'category_id',
                                            'classification_rule_id', 'classification_source', 'raw', 'matched_at',
                                            'created_at', 'updated_at', 'created_entry']);
SELECT columns_are('classification_rules', ARRAY['id', 'caixa_id', 'match_kind', 'pattern', 'direction', 'entity_id',
                                                 'category_id', 'priority', 'origin', 'created_from_line_id', 'created_by_user_id',
                                                 'usage_count', 'last_used_at', 'archived_at', 'created_at', 'updated_at']);
SELECT columns_are('statement_csv_mappings', ARRAY['id', 'financial_account_id', 'card_caixa_id', 'name', 'delimiter', 'encoding',
                                                   'has_header', 'skip_rows', 'date_format', 'decimal_separator', 'columns',
                                                   'is_default', 'created_at', 'updated_at']);
SELECT fk_ok('statement_imports', 'financial_account_id', 'financial_accounts', 'id');
SELECT fk_ok('statement_imports', 'card_caixa_id', 'caixas', 'id');
SELECT fk_ok('statement_imports', 'card_invoice_id', 'card_invoices', 'id');
SELECT fk_ok('statement_imports', 'attachment_id', 'attachments', 'id');
SELECT fk_ok('statement_imports', 'csv_mapping_id', 'statement_csv_mappings', 'id');
SELECT fk_ok('statement_lines', 'statement_import_id', 'statement_imports', 'id');
SELECT fk_ok('statement_lines', 'movement_id', 'movements', 'id');
SELECT fk_ok('statement_lines', 'title_id', 'titles', 'id');
SELECT fk_ok('statement_lines', 'card_invoice_item_id', 'card_invoice_items', 'id');
SELECT fk_ok('statement_lines', 'classification_rule_id', 'classification_rules', 'id');
SELECT fk_ok('classification_rules', 'created_from_line_id', 'statement_lines', 'id');
SELECT has_index('statement_lines', i) FROM unnest(ARRAY['statement_lines_account_dedup_key', 'statement_lines_card_dedup_key',
  'statement_lines_movement_matched_key', 'statement_lines_card_item_matched_key', 'statement_lines_movement_id_idx',
  'statement_lines_title_id_idx', 'statement_lines_card_invoice_item_id_idx', 'statement_lines_entity_id_idx',
  'statement_lines_category_id_idx', 'statement_lines_classification_rule_id_idx']) i;
SELECT has_index('statement_imports', i) FROM unnest(ARRAY['statement_imports_financial_account_id_idx',
  'statement_imports_card_caixa_id_idx', 'statement_imports_card_invoice_id_idx', 'statement_imports_attachment_id_idx']) i;
SELECT has_trigger('movements', 'movements_validate_statement');

-- Dados base -----------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick'),
  ('00000000-0000-7000-8000-00000000e005', 'company', 'Energia SA'),
  ('00000000-0000-7000-8000-00000000e006', 'company', 'Uber'),
  ('00000000-0000-7000-8000-00000000e010', 'company', 'Nu Pagamentos');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-0000000c0010', 'Nubank', 'credit_card', '00000000-0000-7000-8000-00000000e010',
   '00000000-0000-7000-8000-0000000c0001', 500000, 3, 10, '1234');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, opening_balance_cents) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú', '2026-01-01', 100000),
  ('00000000-0000-7000-8000-0000000a0002', '00000000-0000-7000-8000-0000000c0001', 'savings', 'Poupança', '2026-01-01', 0),
  ('00000000-0000-7000-8000-0000000a0011', '00000000-0000-7000-8000-0000000c0001', 'cash', 'Cofre', '2026-01-01', 0);
INSERT INTO categories (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia'),
  ('00000000-0000-7000-8000-00000000ca02', 'expense', 'Transporte'),
  ('00000000-0000-7000-8000-00000000ca10', 'income', 'Salário');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'extrato.ofx', 'application/x-ofx', '\x4f4658'),
  ('00000000-0000-7000-8000-0000000a7002', 'extrato.csv', 'text/csv', '\x6373760a'),
  ('00000000-0000-7000-8000-0000000a7003', 'fatura.csv', 'text/csv', '\x6661740a');
INSERT INTO movements (id, financial_account_id, occurred_on, amount_cents, kind, description) VALUES
  ('00000000-0000-7000-8000-0000000f0001', '00000000-0000-7000-8000-0000000a0001', '2026-10-05', -15000, 'adjustment', 'Energia'),
  ('00000000-0000-7000-8000-0000000f0002', '00000000-0000-7000-8000-0000000a0001', '2026-10-06', -2500, 'adjustment', 'Uber'),
  ('00000000-0000-7000-8000-0000000f0003', '00000000-0000-7000-8000-0000000a0002', '2026-10-06', 2500, 'adjustment', 'Rendimento');

-- Mapeamentos de CSV ----------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO statement_csv_mappings (id, financial_account_id, name, columns, is_default)
                  VALUES ('00000000-0000-7000-8000-0000000ab001', '00000000-0000-7000-8000-0000000a0001', 'Itaú padrão',
                          '{"date": 0, "description": 1, "amount": 3}', true)$$, 'mapeamento salvo na conta');
SELECT lives_ok($$INSERT INTO statement_csv_mappings (financial_account_id, name, delimiter, columns)
                  VALUES ('00000000-0000-7000-8000-0000000a0001', 'Itaú débito/crédito', ',',
                          '{"date": "Data", "description": "Histórico", "debit": "Débito", "credit": "Crédito"}')$$,
                'débito e crédito em colunas separadas');
SELECT throws_ok($$INSERT INTO statement_csv_mappings (financial_account_id, name, columns)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'itaú PADRÃO', '{"date": 0, "description": 1, "amount": 3}')$$,
                 '23505', NULL, 'nome único por conta, sem distinção de maiúsculas');
SELECT throws_ok($$INSERT INTO statement_csv_mappings (financial_account_id, name, columns, is_default)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'Outro', '{"date": 0, "description": 1, "amount": 3}', true)$$,
                 '23505', NULL, 'um padrão por conta');
SELECT throws_ok($$INSERT INTO statement_csv_mappings (financial_account_id, name, columns)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'Sem valor', '{"date": 0, "description": 1}')$$,
                 '23514', NULL, 'mapeamento exige data, descrição e valor (ou débito + crédito)');
SELECT throws_ok($$INSERT INTO statement_csv_mappings (financial_account_id, name, delimiter, columns)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'X', ':', '{"date": 0, "description": 1, "amount": 2}')$$,
                 '23514', NULL, 'separador , ; tab ou |');
SELECT throws_ok($$INSERT INTO statement_csv_mappings (financial_account_id, card_caixa_id, name, columns)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0010', 'X',
                           '{"date": 0, "description": 1, "amount": 2}')$$, '23514', NULL, 'conta ou cartão, não os dois');
SELECT throws_ok($$INSERT INTO statement_csv_mappings (financial_account_id, name, columns)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', 'Cofre', '{"date": 0, "description": 1, "amount": 2}')$$,
                 '23514', NULL, 'cofre não importa extrato');
SELECT lives_ok($$INSERT INTO statement_csv_mappings (card_caixa_id, name, columns)
                  VALUES ('00000000-0000-7000-8000-0000000c0010', 'Fatura Nubank', '{"date": 0, "description": 1, "amount": 2}')$$,
                'mapeamento de fatura de cartão');

-- Lotes -------------------------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end,
                                                 bank_balance_cents, bank_balance_on)
                  VALUES ('00000000-0000-7000-8000-0000000ac001', '00000000-0000-7000-8000-0000000a0001', 'ofx',
                          '00000000-0000-7000-8000-0000000a7001', '2026-10-01', '2026-10-31', 80000, '2026-10-31')$$,
                'lote OFX com saldo do banco');
SELECT throws_ok($$INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end)
                   VALUES ('00000000-0000-7000-8000-0000000a0011', 'csv', '00000000-0000-7000-8000-0000000a7002', '2026-10-01', '2026-10-31')$$,
                 '23514', 'statement_imports: account 00000000-0000-7000-8000-0000000a0011 does not import statements (only checking/savings)',
                 'cofre não importa extrato');
SELECT throws_ok($$INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end, csv_mapping_id)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'ofx', '00000000-0000-7000-8000-0000000a7002', '2026-10-01',
                           '2026-10-31', '00000000-0000-7000-8000-0000000ab001')$$, '23514', NULL, 'mapeamento só em CSV');
SELECT throws_ok($$INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end, csv_mapping_id)
                   VALUES ('00000000-0000-7000-8000-0000000a0002', 'csv', '00000000-0000-7000-8000-0000000a7002', '2026-10-01',
                           '2026-10-31', '00000000-0000-7000-8000-0000000ab001')$$,
                 '23514', 'statement_imports: CSV mapping 00000000-0000-7000-8000-0000000ab001 belongs to another account/card',
                 'mapeamento da própria conta');
SELECT throws_ok($$INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'pdf', '00000000-0000-7000-8000-0000000a7002', '2026-10-01', '2026-10-31')$$,
                 '23514', NULL, 'formato ofx|csv');
SELECT throws_ok($$INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'csv', '00000000-0000-7000-8000-0000000a7002', '2026-10-31', '2026-10-01')$$,
                 '23514', NULL, 'período invertido');
SELECT throws_ok($$INSERT INTO statement_imports (financial_account_id, format, attachment_id, period_start, period_end, bank_balance_cents)
                   VALUES ('00000000-0000-7000-8000-0000000a0001', 'csv', '00000000-0000-7000-8000-0000000a7002', '2026-10-01', '2026-10-31', 1)$$,
                 '23514', NULL, 'saldo do banco exige a data');
SELECT throws_ok($$UPDATE statement_imports SET financial_account_id = '00000000-0000-7000-8000-0000000a0002'
                    WHERE id = '00000000-0000-7000-8000-0000000ac001'$$, '23514', NULL, 'conta do lote imutável');
SELECT throws_ok($$DELETE FROM attachments WHERE id = '00000000-0000-7000-8000-0000000a7001'$$,
                 '23503', NULL, 'o arquivo do lote não é apagado');

-- Linhas ---------------------------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents,
                                               description, fitid, dedup_hash, raw)
                  VALUES ('00000000-0000-7000-8000-0000000ad001', '00000000-0000-7000-8000-0000000ac001',
                          '00000000-0000-7000-8000-0000000a0001', 1, '2026-10-05', -15000, 'PAG ENERGIA SA', 'F1', 'fitid:F1',
                          '{"TRNTYPE": "DEBIT"}'),
                         ('00000000-0000-7000-8000-0000000ad002', '00000000-0000-7000-8000-0000000ac001',
                          '00000000-0000-7000-8000-0000000a0001', 2, '2026-10-06', -2500, 'UBER *TRIP', 'F2', 'fitid:F2', NULL),
                         ('00000000-0000-7000-8000-0000000ad003', '00000000-0000-7000-8000-0000000ac001',
                          '00000000-0000-7000-8000-0000000a0001', 3, '2026-10-07', 500000, 'SALARIO', 'F3', 'fitid:F3', NULL)$$,
                'linhas novas');
SELECT throws_ok($$INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents,
                                                description, dedup_hash)
                   VALUES ('00000000-0000-7000-8000-0000000ac001', '00000000-0000-7000-8000-0000000a0002', 9, '2026-10-05', -1, 'X', 'h9')$$,
                 '23514', 'statement_lines: line must belong to the account/card of import 00000000-0000-7000-8000-0000000ac001',
                 'a linha é da conta do lote');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end)
VALUES ('00000000-0000-7000-8000-0000000ac002', '00000000-0000-7000-8000-0000000a0001', 'csv',
        '00000000-0000-7000-8000-0000000a7002', '2026-10-01', '2026-10-31');
SELECT throws_ok($$INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents,
                                                description, dedup_hash)
                   VALUES ('00000000-0000-7000-8000-0000000ac002', '00000000-0000-7000-8000-0000000a0001', 1, '2026-10-05', -15000,
                           'PAG ENERGIA SA', 'fitid:F1')$$, '23505', NULL, 'dedup: a mesma linha em outro lote da conta');
INSERT INTO statement_imports (id, financial_account_id, format, attachment_id, period_start, period_end)
VALUES ('00000000-0000-7000-8000-0000000ac003', '00000000-0000-7000-8000-0000000a0002', 'ofx',
        '00000000-0000-7000-8000-0000000a7001', '2026-10-01', '2026-10-31');
SELECT lives_ok($$INSERT INTO statement_lines (id, statement_import_id, financial_account_id, line_number, posted_on, amount_cents,
                                               description, dedup_hash)
                  VALUES ('00000000-0000-7000-8000-0000000ad031', '00000000-0000-7000-8000-0000000ac003',
                          '00000000-0000-7000-8000-0000000a0002', 1, '2026-10-06', 2500, 'RENDIMENTO', 'fitid:F1')$$,
                'o mesmo hash em outra conta');
SELECT throws_ok($$INSERT INTO statement_lines (statement_import_id, financial_account_id, line_number, posted_on, amount_cents,
                                                description, dedup_hash)
                   VALUES ('00000000-0000-7000-8000-0000000ac001', '00000000-0000-7000-8000-0000000a0001', 4, '2026-10-05', 0, 'X', 'h4')$$,
                 '23514', NULL, 'valor ≠ 0');
SELECT throws_ok($$UPDATE statement_lines SET amount_cents = -1 WHERE id = '00000000-0000-7000-8000-0000000ad001'$$,
                 '23514', 'statement_lines: imported data of line 00000000-0000-7000-8000-0000000ad001 cannot change',
                 'dados importados imutáveis');

-- Estados e vínculos
SELECT throws_ok($$UPDATE statement_lines SET status = 'matched', matched_at = now() WHERE id = '00000000-0000-7000-8000-0000000ad001'$$,
                 '23514', NULL, 'conciliada exige o movimento');
SELECT throws_ok($$UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-0000000f0001'
                    WHERE id = '00000000-0000-7000-8000-0000000ad001'$$, '23514', NULL, 'conciliada exige matched_at');
SELECT lives_ok($$UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-0000000f0001', matched_at = now()
                   WHERE id = '00000000-0000-7000-8000-0000000ad001'$$, 'concilia com o movimento de mesmo valor');
SELECT throws_ok($$UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-0000000f0002', matched_at = now()
                    WHERE id = '00000000-0000-7000-8000-0000000ad003'$$,
                 '23514', 'statement_lines: movement 00000000-0000-7000-8000-0000000f0002 must be on the same account (and amount, when matched)',
                 'valor diferente não concilia');
SELECT throws_ok($$UPDATE statement_lines SET status = 'suggested', movement_id = '00000000-0000-7000-8000-0000000f0003'
                    WHERE id = '00000000-0000-7000-8000-0000000ad003'$$, '23514', NULL, 'movimento de outra conta');
SELECT lives_ok($$UPDATE statement_lines SET status = 'suggested', movement_id = '00000000-0000-7000-8000-0000000f0002'
                   WHERE id = '00000000-0000-7000-8000-0000000ad002'$$, 'sugestão de casamento');
SELECT throws_ok($$UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-0000000f0001', matched_at = now()
                    WHERE id = '00000000-0000-7000-8000-0000000ad002'$$, '23514', NULL, 'outro valor');
SELECT throws_ok($$UPDATE statement_lines SET status = 'new' WHERE id = '00000000-0000-7000-8000-0000000ad002'$$,
                 '23514', NULL, 'nova não tem vínculo');
SELECT throws_ok($$UPDATE movements SET amount_cents = -15001 WHERE id = '00000000-0000-7000-8000-0000000f0001'$$,
                 '23514', 'movements: movement 00000000-0000-7000-8000-0000000f0001 is reconciled with a statement line',
                 'movimento conciliado não muda de valor');
SELECT throws_ok($$DELETE FROM movements WHERE id = '00000000-0000-7000-8000-0000000f0001'$$,
                 '23503', NULL, 'movimento conciliado não é excluído');
SELECT lives_ok($$UPDATE movements SET description = 'Energia outubro' WHERE id = '00000000-0000-7000-8000-0000000f0001'$$,
                'descrição do movimento conciliado muda');
SELECT throws_ok($$UPDATE statement_lines SET category_id = '00000000-0000-7000-8000-00000000ca10'
                    WHERE id = '00000000-0000-7000-8000-0000000ad001'$$,
                 '23514', NULL, 'saída sugere categoria de despesa');
SELECT lives_ok($$UPDATE statement_lines SET category_id = '00000000-0000-7000-8000-00000000ca10', entity_id = '00000000-0000-7000-8000-00000000e001',
                                             classification_source = 'user'
                   WHERE id = '00000000-0000-7000-8000-0000000ad003'$$, 'entrada sugere categoria de receita');
SELECT lives_ok($$UPDATE statement_lines SET status = 'ignored', movement_id = NULL WHERE id = '00000000-0000-7000-8000-0000000ad031'$$,
                'linha ignorada');

-- Cartão: linhas da fatura viram compras
INSERT INTO categories (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000ca03', 'expense', 'Aplicativos');
INSERT INTO card_invoices (id, card_caixa_id, reference_month, closing_date, due_date) VALUES
  ('00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-0000000c0010', '2026-10-01', '2026-10-03', '2026-10-10');
INSERT INTO card_purchases (id, card_caixa_id, payer_caixa_id, entity_id, category_id, purchased_on, description, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001b001', '00000000-0000-7000-8000-0000000c0010', '00000000-0000-7000-8000-0000000c0001',
        '00000000-0000-7000-8000-00000000e006', '00000000-0000-7000-8000-00000000ca03', '2026-09-20', 'Uber', 3000);
INSERT INTO card_invoice_items (id, card_invoice_id, card_purchase_id, installment_number, payer_caixa_id, amount_cents)
VALUES ('00000000-0000-7000-8000-00000001f001', '00000000-0000-7000-8000-00000001a610', '00000000-0000-7000-8000-00000001b001',
        1, '00000000-0000-7000-8000-0000000c0001', 3000);
SELECT pg_temp.commit_check();
SELECT throws_ok($$INSERT INTO statement_imports (card_caixa_id, card_invoice_id, format, attachment_id, period_start, period_end)
                   VALUES ('00000000-0000-7000-8000-0000000c0001', NULL, 'csv', '00000000-0000-7000-8000-0000000a7003', '2026-09-04', '2026-10-03')$$,
                 '23514', 'statement_imports: caixa 00000000-0000-7000-8000-0000000c0001 is not a credit card', 'import de fatura só em cartão');
SELECT lives_ok($$INSERT INTO statement_imports (id, card_caixa_id, card_invoice_id, format, attachment_id, period_start, period_end)
                  VALUES ('00000000-0000-7000-8000-0000000ac010', '00000000-0000-7000-8000-0000000c0010',
                          '00000000-0000-7000-8000-00000001a610', 'csv', '00000000-0000-7000-8000-0000000a7003', '2026-09-04', '2026-10-03')$$,
                'import de fatura do cartão');
SELECT lives_ok($$INSERT INTO statement_lines (id, statement_import_id, card_caixa_id, line_number, posted_on, amount_cents, description, dedup_hash)
                  VALUES ('00000000-0000-7000-8000-0000000ad101', '00000000-0000-7000-8000-0000000ac010',
                          '00000000-0000-7000-8000-0000000c0010', 1, '2026-09-20', -3000, 'UBER *TRIP', 'h1'),
                         ('00000000-0000-7000-8000-0000000ad102', '00000000-0000-7000-8000-0000000ac010',
                          '00000000-0000-7000-8000-0000000c0010', 2, '2026-09-21', -4500, 'IFOOD', 'h2')$$, 'linhas da fatura');
SELECT throws_ok($$UPDATE statement_lines SET status = 'matched', movement_id = '00000000-0000-7000-8000-0000000f0002', matched_at = now()
                    WHERE id = '00000000-0000-7000-8000-0000000ad101'$$, '23514', NULL, 'linha de cartão não casa com movimento');
SELECT lives_ok($$UPDATE statement_lines SET status = 'matched', card_invoice_item_id = '00000000-0000-7000-8000-00000001f001', matched_at = now()
                   WHERE id = '00000000-0000-7000-8000-0000000ad101'$$, 'linha casa com a parcela (valor oposto)');
SELECT throws_ok($$UPDATE statement_lines SET status = 'matched', card_invoice_item_id = '00000000-0000-7000-8000-00000001f001', matched_at = now()
                    WHERE id = '00000000-0000-7000-8000-0000000ad102'$$, '23514', NULL, 'valor diferente da parcela');
SELECT throws_ok($$UPDATE statement_lines SET category_id = '00000000-0000-7000-8000-00000000ca10'
                    WHERE id = '00000000-0000-7000-8000-0000000ad102'$$, '23514', NULL, 'no cartão a categoria é de despesa');
SELECT throws_ok($$INSERT INTO statement_lines (statement_import_id, card_caixa_id, line_number, posted_on, amount_cents, description, dedup_hash)
                   VALUES ('00000000-0000-7000-8000-0000000ac010', '00000000-0000-7000-8000-0000000c0010', 3, '2026-09-20', -3000, 'X', 'h1')$$,
                 '23505', NULL, 'dedup por cartão');

-- Regras de classificação ------------------------------------------------------------------------------
SELECT lives_ok($$INSERT INTO classification_rules (id, match_kind, pattern, direction, entity_id, category_id, origin, created_from_line_id)
                  VALUES ('00000000-0000-7000-8000-0000000ae001', 'contains', 'uber', 'out', '00000000-0000-7000-8000-00000000e006',
                          '00000000-0000-7000-8000-00000000ca02', 'correction', '00000000-0000-7000-8000-0000000ad002')$$,
                'regra global aprendida de uma correção');
SELECT lives_ok($$INSERT INTO classification_rules (id, caixa_id, match_kind, pattern, direction, entity_id, category_id, priority)
                  VALUES ('00000000-0000-7000-8000-0000000ae002', '00000000-0000-7000-8000-0000000c0001', 'starts_with', 'UBER *',
                          'out', NULL, '00000000-0000-7000-8000-00000000ca03', 100),
                         ('00000000-0000-7000-8000-0000000ae003', NULL, 'regex', '^PAG ENERGIA', 'out', NULL,
                          '00000000-0000-7000-8000-00000000ca01', 50),
                         ('00000000-0000-7000-8000-0000000ae004', NULL, 'exact', 'salario', NULL,
                          '00000000-0000-7000-8000-00000000e001', NULL, 100)$$,
                'regras por caixa, regex e exata (só entidade, qualquer direção)');
SELECT throws_ok($$INSERT INTO classification_rules (pattern, direction) VALUES ('sem alvo', 'out')$$,
                 '23514', NULL, 'regra sem entidade nem categoria');
SELECT throws_ok($$INSERT INTO classification_rules (pattern, entity_id) VALUES ('  ', '00000000-0000-7000-8000-00000000e006')$$,
                 '23514', NULL, 'padrão vazio');
SELECT throws_ok($$INSERT INTO classification_rules (pattern, category_id) VALUES ('x', '00000000-0000-7000-8000-00000000ca01')$$,
                 '23514', NULL, 'categoria exige direção');
SELECT throws_ok($$INSERT INTO classification_rules (pattern, direction, category_id) VALUES ('x', 'in', '00000000-0000-7000-8000-00000000ca01')$$,
                 '23514', 'classification_rules: in rule requires income category', 'entrada com categoria de receita');
SELECT throws_ok($$INSERT INTO classification_rules (match_kind, pattern, entity_id) VALUES ('regex', '([a-', '00000000-0000-7000-8000-00000000e006')$$,
                 '23514', 'classification_rules: invalid regular expression ([a-', 'regex inválida');
SELECT throws_ok($$INSERT INTO classification_rules (match_kind, pattern, direction, entity_id)
                   VALUES ('contains', 'UBER', 'out', '00000000-0000-7000-8000-00000000e001')$$,
                 '23505', NULL, 'padrão repetido no mesmo escopo');
SELECT is(classification_rule_for('00000000-0000-7000-8000-0000000c0001', 'UBER *TRIP SAO PAULO', -2500),
          '00000000-0000-7000-8000-0000000ae002'::uuid, 'mesma prioridade: regra da caixa vence a global');
SELECT is(classification_rule_for(NULL, 'UBER *TRIP SAO PAULO', -2500),
          '00000000-0000-7000-8000-0000000ae001'::uuid, 'sem caixa: só regras globais');
SELECT is(classification_rule_for('00000000-0000-7000-8000-0000000c0001', 'uber reembolso', 2500), NULL,
          'direção da regra filtra (saída ≠ entrada)');
SELECT is(classification_rule_for('00000000-0000-7000-8000-0000000c0001', 'PAG ENERGIA SA', -15000),
          '00000000-0000-7000-8000-0000000ae003'::uuid, 'regex com prioridade menor vence');
SELECT is(classification_rule_for('00000000-0000-7000-8000-0000000c0001', '  Salario ', 500000),
          '00000000-0000-7000-8000-0000000ae004'::uuid, 'exata ignora maiúsculas e espaços nas pontas');
SELECT is(classification_rule_for('00000000-0000-7000-8000-0000000c0001', 'Salario maio', 500000), NULL,
          'exata não casa com texto maior');
SELECT lives_ok($$UPDATE classification_rules SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000ae002'$$, 'arquiva regra');
SELECT is(classification_rule_for('00000000-0000-7000-8000-0000000c0001', 'UBER *TRIP', -2500),
          '00000000-0000-7000-8000-0000000ae001'::uuid, 'regra arquivada não classifica');
SELECT lives_ok($$UPDATE statement_lines SET classification_rule_id = '00000000-0000-7000-8000-0000000ae001', classification_source = 'rule',
                                             entity_id = '00000000-0000-7000-8000-00000000e006', category_id = '00000000-0000-7000-8000-00000000ca02'
                   WHERE id = '00000000-0000-7000-8000-0000000ad002'$$, 'linha classificada por regra');
SELECT throws_ok($$UPDATE statement_lines SET classification_source = 'agent' WHERE id = '00000000-0000-7000-8000-0000000ad002'$$,
                 '23514', NULL, 'com regra, a origem é rule');
SELECT lives_ok($$DELETE FROM classification_rules WHERE id = '00000000-0000-7000-8000-0000000ae001'$$, 'excluir a regra solta a linha');
SELECT is((SELECT classification_rule_id FROM statement_lines WHERE id = '00000000-0000-7000-8000-0000000ad002'), NULL,
          'linha mantém a classificação sem a regra');

-- Divergência de saldo ------------------------------------------------------------------------------------
-- Itaú: 100000 − 15000 − 2500 = 82500 no app; banco informou 80000.
SELECT results_eq($$SELECT bank_balance_cents, app_balance_cents, difference_cents, lines, matched_lines, suggested_lines, new_lines
                     FROM statement_import_balances WHERE statement_import_id = '00000000-0000-7000-8000-0000000ac001'$$,
                  $$VALUES (80000::bigint, 82500::bigint, -2500::bigint, 3, 1, 1, 1)$$, 'saldo do banco × app e contagem por status');
SELECT results_eq($$SELECT app_balance_cents, lines FROM statement_import_balances WHERE statement_import_id = '00000000-0000-7000-8000-0000000ac010'$$,
                  $$VALUES (NULL::bigint, 2)$$, 'fatura de cartão não tem saldo');

SELECT results_eq($$SELECT target_kind, count(*)::int FROM attachment_links WHERE target_kind = 'statement_import' GROUP BY 1$$,
                  $$VALUES ('statement_import', 4)$$, 'arquivo de cada lote em attachment_links');

-- Excluir o lote leva as linhas
SELECT lives_ok($$DELETE FROM statement_imports WHERE id = '00000000-0000-7000-8000-0000000ac003'$$, 'exclui o lote');
SELECT is((SELECT count(*)::int FROM statement_lines WHERE statement_import_id = '00000000-0000-7000-8000-0000000ac003'), 0, 'linhas excluídas');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['statement_csv_mappings', 'statement_imports', 'statement_lines', 'classification_rules']) t;
SELECT ok(has_table_privilege('moneyflow_app', 'statement_import_balances', 'SELECT'), 'app lê statement_import_balances');
SELECT function_privs_are('classification_rule_for', ARRAY['uuid', 'text', 'bigint'], 'moneyflow_app', ARRAY['EXECUTE']);

SELECT * FROM finish();
ROLLBACK;
