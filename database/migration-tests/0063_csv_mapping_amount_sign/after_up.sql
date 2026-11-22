-- Conferências depois de subir a 0063 sobre o fixture (:pass = 1 na primeira subida, 2 depois de descer e subir; a
-- conversão é a mesma nas duas).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_column('statement_csv_mappings', 'amount_sign');
SELECT col_not_null('statement_csv_mappings', 'amount_sign');
SELECT col_default_is('statement_csv_mappings', 'amount_sign', 'as_is');
SELECT hasnt_function('csv_cell_negative_0063', ARRAY['text'], 'o auxiliar da conversão saiu');

SELECT results_eq(
  $$SELECT name, amount_sign FROM statement_csv_mappings ORDER BY name$$,
  $$VALUES ('M1 Nubank', 'invert'), ('M2 Inter', 'as_is'), ('M3 C6 sem lote', 'invert'), ('M4 Corrente', 'as_is'),
           ('M5 Nubank inteiro', 'invert'), ('M6 Inter dois lotes', 'invert'), ('M7 C6 três lotes', 'as_is')$$,
  'sinal pelo que os lotes mostram (cartão), as_is na conta, invert sem evidência no cartão');
SELECT is((SELECT count(*)::int FROM statement_lines), 20, 'as linhas não mudam');
SELECT is((SELECT sum(amount_cents)::bigint FROM statement_lines), 1910::bigint, 'os valores gravados não mudam');

SELECT lives_ok($$INSERT INTO statement_csv_mappings (card_caixa_id, name, columns)
                  VALUES ('00000000-0000-7000-8000-63000000c010', 'Novo', '{"date": 0, "description": 1, "amount": 2}')$$,
                'mapeamento novo sem o sinal');
SELECT is((SELECT amount_sign FROM statement_csv_mappings WHERE name = 'Novo'), 'as_is', 'padrão as_is');
SELECT throws_ok($$UPDATE statement_csv_mappings SET amount_sign = 'auto' WHERE name = 'Novo'$$, '23514', NULL, 'só as_is ou invert');
SELECT ok(has_column_privilege('moneyflow_app', 'statement_csv_mappings', 'amount_sign', p), 'app: ' || p || ' em amount_sign')
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;

SELECT * FROM finish();
ROLLBACK;
