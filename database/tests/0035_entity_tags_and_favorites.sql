-- Testes de 0035_entity_tags_and_favorites: catálogo de tags, ligações, tag arquivada, favoritas, busca por prefixo
-- do documento e auditoria.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Executa um comando e devolve "SQLSTATE constraint" do erro (ou 'ok').
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

-- Estrutura ----------------------------------------------------------------------------------------------
SELECT has_table('entity_tags');
SELECT has_table('entity_tag_links');
SELECT columns_are('entity_tags', ARRAY['id', 'name', 'color_slot', 'archived_at', 'created_at', 'updated_at']);
SELECT columns_are('entity_tag_links', ARRAY['entity_id', 'tag_id', 'created_at', 'updated_at']);
SELECT col_type_is('entity_tags', 'name', 'citext');
SELECT col_is_pk('entity_tag_links', ARRAY['entity_id', 'tag_id']);
SELECT fk_ok('entity_tag_links', 'entity_id', 'entities', 'id');
SELECT fk_ok('entity_tag_links', 'tag_id', 'entity_tags', 'id');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'entity_tag_links'::regclass
            AND confrelid = 'entities'::regclass), 'c', 'FK para entities é CASCADE');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'entity_tag_links'::regclass
            AND confrelid = 'entity_tags'::regclass), 'a', 'FK para entity_tags restringe (NO ACTION: 23503)');
SELECT has_index('entity_tag_links', 'entity_tag_links_tag_id_idx');
SELECT has_column('entities', 'is_favorite');
SELECT col_not_null('entities', 'is_favorite');
SELECT col_default_is('entities', 'is_favorite', 'false');
SELECT has_index('entities', 'entities_is_favorite_idx');
SELECT has_index('entities', 'entities_document_prefix_idx');
SELECT has_trigger('entity_tags', 'entity_tags_audit');
SELECT has_trigger('entity_tag_links', 'entity_tag_links_audit');
SELECT has_trigger('entity_tag_links', 'entity_tag_links_tag_active_check');

-- Dados ---------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'admin', 'admin@example.com', 'x', 'admin');
INSERT INTO entities (id, kind, name, document) VALUES
  ('00000000-0000-7000-8000-00000000e001', 'person', 'Ana', NULL),
  ('00000000-0000-7000-8000-00000000e002', 'company', 'Empresa Alfa', '12ABC34501DE35'),
  ('00000000-0000-7000-8000-00000000e003', 'company', 'Empresa Num', '11222333000181');
INSERT INTO entity_tags (id, name, color_slot) VALUES
  ('00000000-0000-7000-8000-0000000007a1', 'Cliente', 1),
  ('00000000-0000-7000-8000-0000000007a2', 'Fornecedor', 2);

-- Nome e cor ----------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('CLIENTE', 3)$$), '23505 entity_tags_name_key',
          'nome único sem distinção de maiúsculas');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('', 3)$$), '23514 entity_tags_name_check', 'nome vazio');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES (' VIP', 3)$$), '23514 entity_tags_name_check',
          'espaço no início');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('VIP ', 3)$$), '23514 entity_tags_name_check',
          'espaço no fim');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES (repeat('a', 41), 3)$$), '23514 entity_tags_name_check',
          '41 caracteres');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES (repeat('ç', 40), 3)$$), 'ok', '40 caracteres');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('Prestador de serviço', 3)$$), 'ok',
          'espaço no meio');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('Sem cor', NULL)$$), '23502 ', 'cor obrigatória');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('Cor 0', 0)$$), '23514 entity_tags_color_slot_check',
          'cor 0');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('Cor 13', 13)$$), '23514 entity_tags_color_slot_check',
          'cor 13');

-- Ligações ------------------------------------------------------------------------------------------------
INSERT INTO entity_tag_links (entity_id, tag_id) VALUES
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-0000000007a1'),
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-0000000007a2'),
  ('00000000-0000-7000-8000-00000000e002', '00000000-0000-7000-8000-0000000007a1');
SELECT is(pg_temp.err($$INSERT INTO entity_tag_links (entity_id, tag_id) VALUES
                          ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-0000000007a1')$$),
          '23505 entity_tag_links_pkey', 'sem repetição');

-- Arquivar: a ligação existente fica; ligar de novo é recusado.
UPDATE entity_tags SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000007a1';
SELECT is((SELECT count(*)::int FROM entity_tag_links WHERE tag_id = '00000000-0000-7000-8000-0000000007a1'), 2,
          'ligações sobrevivem ao arquivamento');
SELECT is(pg_temp.err($$INSERT INTO entity_tag_links (entity_id, tag_id) VALUES
                          ('00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000007a1')$$),
          '23514 entity_tag_links_tag_active_check', 'tag arquivada não é ligada');
SELECT is(pg_temp.err($$UPDATE entity_tag_links SET tag_id = '00000000-0000-7000-8000-0000000007a1'
                          WHERE entity_id = '00000000-0000-7000-8000-00000000e001'
                            AND tag_id = '00000000-0000-7000-8000-0000000007a2'$$),
          '23514 entity_tag_links_tag_active_check', 'nem trocando a tag da ligação');
SELECT is(pg_temp.err($$DELETE FROM entity_tag_links WHERE entity_id = '00000000-0000-7000-8000-00000000e002'
                          AND tag_id = '00000000-0000-7000-8000-0000000007a1'$$), 'ok', 'tag arquivada pode ser removida');
SELECT is(pg_temp.err($$DELETE FROM entity_tags WHERE id = '00000000-0000-7000-8000-0000000007a1'$$),
          '23503 entity_tag_links_tag_id_fkey', 'tag em uso não é apagada');
SELECT is(pg_temp.err($$INSERT INTO entity_tags (name, color_slot) VALUES ('cliente', 5)$$), '23505 entity_tags_name_key',
          'nome único com as arquivadas');
-- Restaurar devolve a tag ao uso.
UPDATE entity_tags SET archived_at = NULL WHERE id = '00000000-0000-7000-8000-0000000007a1';
SELECT is(pg_temp.err($$INSERT INTO entity_tag_links (entity_id, tag_id) VALUES
                          ('00000000-0000-7000-8000-00000000e003', '00000000-0000-7000-8000-0000000007a1')$$),
          'ok', 'tag restaurada volta a ser ligada');
-- Tag sem uso é apagada; entidade apagada leva as ligações.
INSERT INTO entity_tags (id, name, color_slot) VALUES ('00000000-0000-7000-8000-0000000007a9', 'Temporária', 9);
SELECT is(pg_temp.err($$DELETE FROM entity_tags WHERE id = '00000000-0000-7000-8000-0000000007a9'$$), 'ok', 'tag sem uso é apagada');
DELETE FROM entities WHERE id = '00000000-0000-7000-8000-00000000e003';
SELECT is((SELECT count(*)::int FROM entity_tag_links WHERE entity_id = '00000000-0000-7000-8000-00000000e003'), 0,
          'ligações somem com a entidade');

-- Favoritas -----------------------------------------------------------------------------------------------
SELECT is((SELECT is_favorite FROM entities WHERE id = '00000000-0000-7000-8000-00000000e001'), false, 'padrão: não favorita');
UPDATE entities SET is_favorite = true WHERE id IN ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000e002');
UPDATE entities SET archived_at = now() WHERE id = '00000000-0000-7000-8000-00000000e002';
SELECT is((SELECT is_favorite FROM entities WHERE id = '00000000-0000-7000-8000-00000000e002'), true, 'arquivada mantém a marca');
SELECT is((SELECT pg_get_expr(i.indpred, i.indrelid) FROM pg_index i
            WHERE i.indexrelid = 'entities_is_favorite_idx'::regclass), '(is_favorite AND (archived_at IS NULL))',
          'índice parcial das favoritas ativas');
SELECT results_eq($$SELECT name FROM entities WHERE is_favorite AND archived_at IS NULL ORDER BY name$$,
                  $$VALUES ('Ana'::text)$$, 'favoritas ativas');

-- Busca por prefixo do documento (CNPJ alfanumérico) -----------------------------------------------------
SELECT results_eq($$SELECT name FROM entities WHERE document LIKE '12ABC%'$$, $$VALUES ('Empresa Alfa'::text)$$,
                  'prefixo do CNPJ alfanumérico');
CREATE FUNCTION pg_temp.plan(q text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  s text := '';
BEGIN
  FOR r IN EXECUTE 'EXPLAIN ' || q LOOP
    s := s || r."QUERY PLAN" || ' ';
  END LOOP;
  RETURN s;
END
$$;
SET LOCAL enable_seqscan = off;
SELECT ok(pg_temp.plan($$SELECT id FROM entities WHERE document LIKE '12ABC%'$$) LIKE '%entities_document_prefix_idx%',
          'LIKE prefixo usa o índice text_pattern_ops');
SET LOCAL enable_seqscan = on;

-- Auditoria -----------------------------------------------------------------------------------------------
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
INSERT INTO entity_tags (id, name, color_slot) VALUES ('00000000-0000-7000-8000-0000000007b1', 'Auditada', 4);
INSERT INTO entity_tag_links (entity_id, tag_id) VALUES
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-0000000007b1');
DELETE FROM entity_tag_links WHERE entity_id = '00000000-0000-7000-8000-00000000e001'
   AND tag_id = '00000000-0000-7000-8000-0000000007b1';
UPDATE entities SET is_favorite = false WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT results_eq($$SELECT action, user_id, actor_kind FROM audit_log
                     WHERE table_name = 'entity_tags' AND record_id = '00000000-0000-7000-8000-0000000007b1'$$,
                  $$VALUES ('insert'::text, '00000000-0000-7000-8000-0000000000a1'::uuid, 'human'::text)$$,
                  'criar tag é auditado com o ator');
SELECT results_eq($$SELECT action, coalesce(new_data, old_data) ->> 'tag_id', user_id FROM audit_log
                     WHERE table_name = 'entity_tag_links' AND record_id = '00000000-0000-7000-8000-00000000e001'
                       AND coalesce(new_data, old_data) ->> 'tag_id' = '00000000-0000-7000-8000-0000000007b1'
                     ORDER BY id$$,
                  $$VALUES ('insert'::text, '00000000-0000-7000-8000-0000000007b1'::text, '00000000-0000-7000-8000-0000000000a1'::uuid),
                           ('delete', '00000000-0000-7000-8000-0000000007b1', '00000000-0000-7000-8000-0000000000a1')$$,
                  'atribuir e remover tag: rastro com o ator e record_id = entidade');
SELECT results_eq($$SELECT changed_columns FROM audit_log
                     WHERE table_name = 'entities' AND record_id = '00000000-0000-7000-8000-00000000e001'
                       AND action = 'update' ORDER BY id DESC LIMIT 1$$,
                  $$VALUES (ARRAY['is_favorite'])$$, 'favoritar é auditado como alteração da entidade');

-- Privilégios ---------------------------------------------------------------------------------------------
SELECT ok(has_table_privilege('moneyflow_app', t, p), 'app: ' || p || ' em ' || t)
  FROM unnest(ARRAY['entity_tags', 'entity_tag_links']) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
SELECT ok(NOT has_function_privilege('moneyflow_app', 'entity_tag_links_audit_row()', 'EXECUTE'), 'app não chama o trigger de auditoria');
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO entity_tag_links (entity_id, tag_id) VALUES
                    ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-0000000007b1')$$, 'app liga tag');
SELECT lives_ok($$UPDATE entity_tags SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000007b1'$$, 'app arquiva tag');
SELECT lives_ok($$UPDATE entities SET is_favorite = true WHERE id = '00000000-0000-7000-8000-00000000e001'$$, 'app favorita');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
