-- Testes de 0007_recurrence_rules: calendário de recorrência e parcelamento.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('recurrence_rules');
SELECT columns_are('recurrence_rules', ARRAY['id', 'frequency', 'interval_count', 'anchor_day', 'starts_on', 'ends_on',
                                             'installments_total', 'created_at', 'updated_at']);
SELECT col_default_is('recurrence_rules', 'interval_count', '1');
SELECT has_trigger('recurrence_rules', 'recurrence_rules_set_updated_at');

-- Regras válidas
SELECT lives_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('monthly', 10, '2026-10-10')$$,
                'mensal no dia 10, sem fim');
SELECT lives_ok($$INSERT INTO recurrence_rules (frequency, interval_count, anchor_day, starts_on, ends_on)
                  VALUES ('weekly', 2, 1, '2026-10-12', '2027-10-12')$$, 'quinzenal às segundas com fim');
SELECT lives_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on, installments_total)
                  VALUES ('monthly', 31, '2026-10-31', 12)$$, 'parcelado em 12 no dia 31');
SELECT lives_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('yearly', 15, '2027-03-15')$$,
                'anual');

-- Restrições
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('daily', 1, '2026-10-10')$$,
                 '23514', NULL, 'frequência só weekly|monthly|yearly');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('weekly', 8, '2026-10-10')$$,
                 '23514', NULL, 'semanal: dia da semana 1–7');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('weekly', 0, '2026-10-10')$$,
                 '23514', NULL, 'semanal: dia da semana >= 1');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on) VALUES ('monthly', 32, '2026-10-10')$$,
                 '23514', NULL, 'mensal: dia do mês 1–31');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, interval_count, anchor_day, starts_on) VALUES ('monthly', 0, 1, '2026-10-10')$$,
                 '23514', NULL, 'intervalo >= 1');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on, ends_on) VALUES ('monthly', 1, '2026-10-10', '2026-10-09')$$,
                 '23514', NULL, 'fim não antes do início');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on, installments_total) VALUES ('monthly', 1, '2026-10-10', 1)$$,
                 '23514', NULL, 'parcelamento tem ao menos 2 parcelas');
SELECT throws_ok($$INSERT INTO recurrence_rules (frequency, anchor_day, starts_on, ends_on, installments_total)
                   VALUES ('monthly', 1, '2026-10-10', '2027-10-10', 12)$$,
                 '23514', NULL, 'fim por data e total de parcelas são exclusivos');

-- Privilégios
SELECT table_privs_are('recurrence_rules', 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

SELECT * FROM finish();
ROLLBACK;
