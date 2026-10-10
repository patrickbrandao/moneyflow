-- Testes de 0005_categories (com a cor por slot da 0006): plano de categorias em dois níveis e categorias ocultas por caixa.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('categories');
SELECT has_table('caixa_hidden_categories');
SELECT columns_are('categories', ARRAY['id', 'kind', 'parent_id', 'name', 'color_slot', 'icon', 'archived_at',
                                       'created_at', 'updated_at']);
SELECT fk_ok('categories', 'parent_id', 'categories', 'id');
SELECT fk_ok('caixa_hidden_categories', 'caixa_id', 'caixas', 'id');
SELECT fk_ok('caixa_hidden_categories', 'category_id', 'categories', 'id');
SELECT has_index('categories', 'categories_parent_id_idx');
SELECT has_index('categories', 'categories_sibling_name_key');
SELECT has_index('caixa_hidden_categories', 'caixa_hidden_categories_category_id_idx');
SELECT has_trigger('categories', 'categories_validate');
SELECT has_trigger('categories', 'categories_set_updated_at');

-- Dados
INSERT INTO categories (id, kind, name, color_slot, icon) VALUES
  ('00000000-0000-7000-8000-00000000ca01', 'expense', 'Moradia', 8, 'house'),
  ('00000000-0000-7000-8000-00000000ca02', 'expense', 'Transporte', 3, 'car'),
  ('00000000-0000-7000-8000-00000000ca03', 'income', 'Salário', 5, 'wallet'),
  ('00000000-0000-7000-8000-00000000ca05', 'income', 'Outros', NULL, NULL),
  ('00000000-0000-7000-8000-00000000ca06', 'expense', 'Outros', NULL, NULL);
INSERT INTO categories (id, kind, parent_id, name) VALUES
  ('00000000-0000-7000-8000-00000000cb01', 'expense', '00000000-0000-7000-8000-00000000ca01', 'Aluguel'),
  ('00000000-0000-7000-8000-00000000cb02', 'expense', '00000000-0000-7000-8000-00000000ca01', 'Energia'),
  ('00000000-0000-7000-8000-00000000cb03', 'expense', '00000000-0000-7000-8000-00000000ca02', 'Combustível'),
  ('00000000-0000-7000-8000-00000000cb04', 'expense', '00000000-0000-7000-8000-00000000ca02', 'Energia');
SELECT pass('grupos e subcategorias; "Outros" em receita e despesa; "Energia" em grupos diferentes');

SELECT throws_ok($$INSERT INTO categories (kind, name) VALUES ('expense', 'moradia')$$,
                 '23505', NULL, 'nome de grupo único por kind, sem distinção de maiúsculas');
SELECT throws_ok($$INSERT INTO categories (kind, parent_id, name) VALUES ('expense', '00000000-0000-7000-8000-00000000ca01', 'ALUGUEL')$$,
                 '23505', NULL, 'nome de subcategoria único entre irmãos');
SELECT throws_ok($$INSERT INTO categories (kind, name) VALUES ('transfer', 'X')$$, '23514', NULL, 'kind só income|expense');
SELECT throws_ok($$INSERT INTO categories (kind, name) VALUES ('expense', ' X')$$, '23514', NULL, 'nome sem espaços nas pontas');
SELECT throws_ok($$INSERT INTO categories (kind, name) VALUES ('expense', '')$$, '23514', NULL, 'nome não vazio');
SELECT throws_ok($$INSERT INTO categories (kind, name, icon) VALUES ('expense', 'X', 'Shopping Cart')$$,
                 '23514', NULL, 'ícone em kebab-case');
SELECT lives_ok($$INSERT INTO categories (kind, name, color_slot, icon) VALUES ('expense', 'Compras', 10, 'shopping-cart')$$,
                'cor e ícone válidos');

-- Dois níveis e mesmo kind (trigger)
SELECT throws_ok($$INSERT INTO categories (kind, parent_id, name) VALUES ('expense', '00000000-0000-7000-8000-00000000cb01', 'Neto')$$,
                 '23514', 'categories: parent 00000000-0000-7000-8000-00000000cb01 is already a subcategory (max two levels)',
                 'não há terceiro nível');
SELECT throws_ok($$INSERT INTO categories (kind, parent_id, name) VALUES ('income', '00000000-0000-7000-8000-00000000ca01', 'Reembolso')$$,
                 '23514', 'categories: kind income differs from parent kind expense', 'filho tem o kind do pai');
SELECT throws_ok($$UPDATE categories SET parent_id = '00000000-0000-7000-8000-00000000ca02' WHERE id = '00000000-0000-7000-8000-00000000ca01'$$,
                 '23514', 'categories: 00000000-0000-7000-8000-00000000ca01 has subcategories and cannot become a subcategory',
                 'grupo com filhos não vira subcategoria');
SELECT throws_ok($$UPDATE categories SET parent_id = '00000000-0000-7000-8000-00000000ca03' WHERE id = '00000000-0000-7000-8000-00000000ca06'$$,
                 '23514', NULL, 'mover para pai de outro kind é bloqueado');
SELECT throws_ok($$UPDATE categories SET kind = 'income' WHERE id = '00000000-0000-7000-8000-00000000ca06'$$,
                 '23514', 'categories: kind cannot change (category 00000000-0000-7000-8000-00000000ca06)', 'kind é imutável');
SELECT throws_ok($$UPDATE categories SET parent_id = id WHERE id = '00000000-0000-7000-8000-00000000ca06'$$,
                 '23514', NULL, 'categoria não é pai de si mesma');
SELECT throws_ok($$UPDATE categories SET parent_id = '00000000-0000-7000-8000-00000000ca02' WHERE id = '00000000-0000-7000-8000-00000000cb02'$$,
                 '23505', NULL, 'mover subcategoria para grupo com irmão de mesmo nome é bloqueado');
SELECT lives_ok($$UPDATE categories SET parent_id = '00000000-0000-7000-8000-00000000ca02' WHERE id = '00000000-0000-7000-8000-00000000cb01'$$,
                'subcategoria muda de grupo do mesmo kind');
SELECT lives_ok($$UPDATE categories SET parent_id = '00000000-0000-7000-8000-00000000ca01' WHERE id = '00000000-0000-7000-8000-00000000ca06'$$,
                'grupo sem filhos vira subcategoria de outro grupo do mesmo kind');
SELECT throws_ok($$DELETE FROM categories WHERE id = '00000000-0000-7000-8000-00000000ca02'$$,
                 '23503', NULL, 'grupo com subcategorias não pode ser excluído');

-- Categorias ocultas
INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick');
INSERT INTO caixas (id, name, kind, holder_entity_id) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001');
INSERT INTO caixa_hidden_categories (caixa_id, category_id) VALUES
  ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-00000000ca03');
SELECT throws_ok($$INSERT INTO caixa_hidden_categories (caixa_id, category_id) VALUES ('00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-00000000ca03')$$,
                 '23505', NULL, 'ocultar a mesma categoria duas vezes');
DELETE FROM categories WHERE id = '00000000-0000-7000-8000-00000000ca03';
SELECT is((SELECT count(*)::int FROM caixa_hidden_categories), 0, 'excluir a categoria remove o ocultamento');

-- Privilégios
SELECT table_privs_are(t, 'moneyflow_app', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  FROM unnest(ARRAY['categories', 'caixa_hidden_categories']) t;

SELECT * FROM finish();
ROLLBACK;
