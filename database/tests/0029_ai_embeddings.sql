-- Testes de 0029_ai_embeddings: vetores de 1536, HNSW por cosseno, marcação de reindexação, busca e limpeza.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_table('ai_embeddings');
SELECT has_function(f) FROM unnest(ARRAY['ai_embeddings_search', 'ai_embedding_store', 'ai_embeddings_purge_orphans', 'ai_text_sha256']) f;
SELECT col_type_is('ai_embeddings', 'embedding', 'vector(1536)');
SELECT is((SELECT amname::text FROM pg_class c JOIN pg_am a ON a.oid = c.relam WHERE c.relname = 'ai_embeddings_embedding_idx'),
          'hnsw', 'índice HNSW');
SELECT ok((SELECT pg_get_indexdef('ai_embeddings_embedding_idx'::regclass) LIKE '%vector_cosine_ops%'), 'por cosseno');
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_embeddings_search(vector, text, uuid[], text[], integer)', 'ai_embedding_store(uuid, text, vector)',
                    'ai_embeddings_purge_orphans()']) f;
SELECT is(ai_text_sha256('ação'), encode(sha256(convert_to('ação', 'UTF8')), 'hex'), 'sha256 do texto em UTF-8');

-- Vetores de teste: base canônica e1/e2 e uma mistura
CREATE TEMP TABLE v AS
SELECT (SELECT array_agg(CASE WHEN i = 1 THEN 1 ELSE 0 END ORDER BY i) FROM generate_series(1, 1536) i)::vector(1536) AS e1,
       (SELECT array_agg(CASE WHEN i = 2 THEN 1 ELSE 0 END ORDER BY i) FROM generate_series(1, 1536) i)::vector(1536) AS e2,
       (SELECT array_agg(CASE WHEN i = 1 THEN 0.9 WHEN i = 2 THEN 0.1 ELSE 0 END ORDER BY i) FROM generate_series(1, 1536) i)::vector(1536) AS mix;

INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'company', 'Energisa');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true),
  ('00000000-0000-7000-8000-0000000c0002', 'Empresa', 'general', '00000000-0000-7000-8000-00000000e001', false);

INSERT INTO ai_embeddings (id, object_type, object_id, caixa_id, model, source_text) VALUES
  ('00000000-0000-7000-8000-0000000e0001', 'entity', '00000000-0000-7000-8000-00000000e001', NULL, 'text-embedding-3-small',
   'Energisa — distribuidora de energia elétrica'),
  ('00000000-0000-7000-8000-0000000e0002', 'caixa', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000c0001',
   'text-embedding-3-small', 'Casa'),
  ('00000000-0000-7000-8000-0000000e0003', 'caixa', '00000000-0000-7000-8000-0000000c0002', '00000000-0000-7000-8000-0000000c0002',
   'text-embedding-3-small', 'Empresa');
SELECT results_eq($$SELECT needs_reindex, source_hash = ai_text_sha256(source_text) FROM ai_embeddings WHERE id = '00000000-0000-7000-8000-0000000e0001'$$,
                  $$VALUES (true, true)$$, 'sem vetor: precisa indexar; hash gerado');
SELECT throws_ok($$INSERT INTO ai_embeddings (object_type, object_id, model, source_text) VALUES
                   ('entity', '00000000-0000-7000-8000-00000000e001', 'text-embedding-3-small', 'outro')$$, '23505', NULL,
                 'um por objeto e modelo');
SELECT lives_ok($$INSERT INTO ai_embeddings (object_type, object_id, model, source_text) VALUES
                  ('entity', '00000000-0000-7000-8000-00000000e001', 'nomic-embed-text', 'Energisa')$$, 'outro modelo, outra linha');
SELECT throws_ok($$INSERT INTO ai_embeddings (object_type, object_id, model, source_text) VALUES
                   ('ai_message', gen_random_uuid(), 'm', 'x')$$, '23514', NULL, 'tipo de objeto conhecido');
SELECT throws_ok($$INSERT INTO ai_embeddings (object_type, object_id, model, source_text) VALUES
                   ('title', gen_random_uuid(), 'm', '  ')$$, '23514', NULL, 'texto não vazio');
SELECT throws_ok($$UPDATE ai_embeddings SET embedding = '[1,2,3]' WHERE id = '00000000-0000-7000-8000-0000000e0001'$$, '22000', NULL,
                 'dimensão fixa 1536');
SELECT throws_ok($$UPDATE ai_embeddings SET embedding = (SELECT e1 FROM v) WHERE id = '00000000-0000-7000-8000-0000000e0001'$$,
                 '23514', NULL, 'vetor anda com embedded_hash e embedded_at');

-- Gravação otimista pelo hash
SELECT ok(ai_embedding_store('00000000-0000-7000-8000-0000000e0001', ai_text_sha256('Energisa — distribuidora de energia elétrica'),
                             (SELECT e1 FROM v)), 'grava o vetor do texto atual');
SELECT ok(ai_embedding_store('00000000-0000-7000-8000-0000000e0002', ai_text_sha256('Casa'), (SELECT e2 FROM v)), 'grava');
SELECT ok(ai_embedding_store('00000000-0000-7000-8000-0000000e0003', ai_text_sha256('Empresa'), (SELECT mix FROM v)), 'grava');
SELECT is((SELECT needs_reindex FROM ai_embeddings WHERE id = '00000000-0000-7000-8000-0000000e0001'), false, 'indexado');
UPDATE ai_embeddings SET source_text = 'Energisa MT — energia elétrica' WHERE id = '00000000-0000-7000-8000-0000000e0001';
SELECT results_eq($$SELECT needs_reindex, embedding IS NOT NULL FROM ai_embeddings WHERE id = '00000000-0000-7000-8000-0000000e0001'$$,
                  $$VALUES (true, true)$$, 'texto mudou: precisa reindexar, vetor velho continua');
SELECT ok(NOT ai_embedding_store('00000000-0000-7000-8000-0000000e0001', ai_text_sha256('Energisa — distribuidora de energia elétrica'),
                                 (SELECT e1 FROM v)), 'vetor de texto velho não é gravado');
SELECT is((SELECT count(*)::int FROM ai_embeddings WHERE needs_reindex), 2, 'fila de reindexação');

-- Busca: filtra pelas caixas e ordena por distância
SELECT results_eq($$SELECT object_type, object_id FROM ai_embeddings_search((SELECT e1 FROM v), 'text-embedding-3-small',
                     ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid, '00000000-0000-7000-8000-0000000c0002'::uuid])$$,
                  $$VALUES ('entity', '00000000-0000-7000-8000-00000000e001'::uuid),
                           ('caixa', '00000000-0000-7000-8000-0000000c0002'::uuid),
                           ('caixa', '00000000-0000-7000-8000-0000000c0001'::uuid)$$, 'mais parecidos primeiro');
SELECT results_eq($$SELECT object_id FROM ai_embeddings_search((SELECT e1 FROM v), 'text-embedding-3-small',
                     ARRAY['00000000-0000-7000-8000-0000000c0001'::uuid], ARRAY['caixa'])$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000c0001'::uuid)$$, 'só caixas permitidas e tipos pedidos');
SELECT results_eq($$SELECT object_id FROM ai_embeddings_search((SELECT e1 FROM v), 'text-embedding-3-small', NULL)$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000e001'::uuid)$$, 'sem caixas: só o cadastro global');
SELECT is_empty($$SELECT * FROM ai_embeddings_search((SELECT e1 FROM v), 'outro-modelo', NULL)$$, 'só do mesmo modelo');
SELECT throws_ok($$SELECT * FROM ai_embeddings_search(NULL, 'x', NULL)$$, '22023', NULL, 'vetor obrigatório');

-- Órfãos e caixa excluída
UPDATE ai_embeddings SET object_id = gen_random_uuid() WHERE model = 'nomic-embed-text';
SELECT is(ai_embeddings_purge_orphans(), 1::bigint, 'apaga o embedding de objeto inexistente');
DELETE FROM caixas WHERE id = '00000000-0000-7000-8000-0000000c0002';
SELECT is((SELECT count(*)::int FROM ai_embeddings WHERE caixa_id = '00000000-0000-7000-8000-0000000c0002'), 0, 'caixa excluída leva os seus');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_embeddings'), 0, 'fora da auditoria');

SELECT * FROM finish();
ROLLBACK;
