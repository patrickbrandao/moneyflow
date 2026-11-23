-- Conferências depois de descer a 0063: a coluna sai, os mapeamentos e as linhas ficam.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT hasnt_column('statement_csv_mappings', 'amount_sign');
SELECT is((SELECT count(*)::int FROM statement_csv_mappings), 7, 'os mapeamentos ficam');
SELECT is((SELECT sum(amount_cents)::bigint FROM statement_lines), 1910::bigint, 'as linhas ficam como estavam');

SELECT * FROM finish();
ROLLBACK;
