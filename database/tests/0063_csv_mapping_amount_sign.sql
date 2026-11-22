-- Testes de 0063_csv_mapping_amount_sign (tarefa 091): o sinal dos valores é do mapeamento CSV (as_is | invert). A
-- conversão dos mapeamentos existentes, com dados, está em migration-tests/0063_csv_mapping_amount_sign.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_column('statement_csv_mappings', 'amount_sign');
SELECT col_not_null('statement_csv_mappings', 'amount_sign');
SELECT col_default_is('statement_csv_mappings', 'amount_sign', 'as_is');
SELECT col_has_check('statement_csv_mappings', 'amount_sign');
SELECT hasnt_function('csv_cell_negative_0063', ARRAY['text'], 'o auxiliar da conversão não fica no schema');
SELECT ok(has_column_privilege('moneyflow_app', 'statement_csv_mappings', 'amount_sign', p), 'app: ' || p || ' em amount_sign')
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;

INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-00000063e001', 'person', 'Patrick'), ('00000000-0000-7000-8000-00000063e004', 'company', 'Nu');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-00000063c001', 'Casa', 'general', '00000000-0000-7000-8000-00000063e001', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day, card_last4) VALUES
  ('00000000-0000-7000-8000-00000063c010', 'Nubank', 'credit_card', '00000000-0000-7000-8000-00000063e004',
   '00000000-0000-7000-8000-00000063c001', 500000, 3, 10, '1111');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-00000063a001', '00000000-0000-7000-8000-00000063c001', 'checking', 'Corrente', '2026-01-01');

SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO statement_csv_mappings (id, card_caixa_id, name, columns, amount_sign)
                  VALUES ('00000000-0000-7000-8000-000000630001', '00000000-0000-7000-8000-00000063c010', 'Fatura',
                          '{"date": "Data", "description": "Descrição", "amount": "Valor"}', 'invert')$$,
                'cartão com as compras positivas: invert');
SELECT lives_ok($$INSERT INTO statement_csv_mappings (id, financial_account_id, name, columns)
                  VALUES ('00000000-0000-7000-8000-000000630002', '00000000-0000-7000-8000-00000063a001', 'Extrato',
                          '{"date": "Data", "description": "Descrição", "amount": "Valor"}')$$,
                'conta sem o sinal: as_is');
SELECT results_eq($$SELECT name, amount_sign FROM statement_csv_mappings ORDER BY name$$,
                  $$VALUES ('Extrato', 'as_is'), ('Fatura', 'invert')$$, 'o sinal gravado');
SELECT lives_ok($$UPDATE statement_csv_mappings SET amount_sign = 'invert' WHERE id = '00000000-0000-7000-8000-000000630002'$$,
                'conta com o débito positivo também inverte');
SELECT throws_ok($$UPDATE statement_csv_mappings SET amount_sign = 'auto' WHERE id = '00000000-0000-7000-8000-000000630001'$$,
                 '23514', NULL, 'só as_is ou invert');
SELECT throws_ok($$UPDATE statement_csv_mappings SET amount_sign = NULL WHERE id = '00000000-0000-7000-8000-000000630001'$$,
                 '23502', NULL, 'o sinal é obrigatório');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
