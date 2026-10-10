-- Testes de 0006_category_color_slot: cor da categoria como slot do design system (--port-1 … --port-12).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_column('categories', 'color_slot');
SELECT col_type_is('categories', 'color_slot', 'smallint');
SELECT col_is_null('categories', 'color_slot');
SELECT hasnt_column('categories', 'color');

SELECT throws_ok($$INSERT INTO categories (kind, name, color_slot) VALUES ('expense', 'X', 0)$$,
                 '23514', NULL, 'slot de cor >= 1');
SELECT throws_ok($$INSERT INTO categories (kind, name, color_slot) VALUES ('expense', 'X', 13)$$,
                 '23514', NULL, 'slot de cor <= 12');
SELECT lives_ok($$INSERT INTO categories (kind, name, color_slot) VALUES ('expense', 'Um', 1), ('expense', 'Doze', 12)$$,
                'slots 1 e 12 são válidos');
SELECT lives_ok($$INSERT INTO categories (kind, name) VALUES ('expense', 'Sem cor')$$, 'cor é opcional');

SELECT * FROM finish();
ROLLBACK;
