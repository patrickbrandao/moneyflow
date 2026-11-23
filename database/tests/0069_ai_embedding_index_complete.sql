-- Testes de 0069_ai_embedding_index_complete (tarefa 161): o worker marca o par completo ao fim de uma passada sem fila
-- (ai_embedding_index_mark) e a busca pergunta ai_embedding_index_ready, sem contar as fontes: pronto = marcado e sem
-- vetor em needs_reindex.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  EXECUTE cmd;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  RETURN st;
END
$$;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000069' || p)::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(text) TO moneyflow_app;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_column('ai_embedding_indexes', 'complete_at');
SELECT col_is_null('ai_embedding_indexes', 'complete_at');
SELECT col_type_is('ai_embedding_indexes', 'complete_at', 'timestamp with time zone');
SELECT has_column('ai_embedding_index_stats', 'complete_at');
SELECT has_function('ai_embedding_index_mark', ARRAY['uuid', 'text', 'boolean']);
SELECT has_function('ai_embedding_index_ready', ARRAY['uuid', 'text']);
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_embedding_index_mark(uuid, text, boolean)', 'ai_embedding_index_ready(uuid, text)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['ai_embedding_index_mark(uuid, text, boolean)', 'ai_embedding_index_ready(uuid, text)']) f;
SELECT ok(NOT prosecdef, 'SECURITY INVOKER: ' || proname) FROM pg_proc
 WHERE proname IN ('ai_embedding_index_mark', 'ai_embedding_index_ready');

-- Dados -------------------------------------------------------------------------------------------------------------------
INSERT INTO ai_providers (id, name, kind, api_key) VALUES (pg_temp.u('f101'), 'OpenAI69', 'openai', 'sk-SEGREDO69');
INSERT INTO ai_embedding_indexes (provider_id, model) VALUES
  (pg_temp.u('f101'), 'text-embedding-3-small'),
  (pg_temp.u('f101'), 'text-embedding-3-large');
-- Dois vetores prontos (texto atual) no par small; nenhum no large.
INSERT INTO ai_embeddings (object_type, object_id, provider_id, model, source_text, embedding, embedded_hash, embedded_at)
SELECT 'title', pg_temp.u('d00' || g), pg_temp.u('f101'), 'text-embedding-3-small', 'Título ' || g,
       array_fill(0.1::real, ARRAY[1536])::vector(1536), ai_text_sha256('Título ' || g), now()
  FROM generate_series(1, 2) g;

SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-small'), false, 'nunca marcado: não está pronto');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'outro-modelo'), false, 'par não registrado: não está pronto');

-- O worker, como a aplicação ------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT is(ai_embedding_index_mark(pg_temp.u('f101'), 'text-embedding-3-small', true), true, 'passada sem fila: marca completo');
SELECT ok((SELECT complete_at IS NOT NULL FROM ai_embedding_indexes
            WHERE provider_id = pg_temp.u('f101') AND model = 'text-embedding-3-small'), 'complete_at gravado');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-small'), true, 'marcado e sem fila: pronto');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-large'), false, 'o outro par segue sem marca');
SELECT is((SELECT complete_at IS NOT NULL FROM ai_embedding_index_stats
            WHERE provider_id = pg_temp.u('f101') AND model = 'text-embedding-3-small'), true, 'a visão mostra a marca');

-- O texto de um título mudou: o vetor volta à fila e o índice deixa de estar pronto, sem desmarcar.
UPDATE ai_embeddings SET source_text = 'Título 1 editado' WHERE object_id = pg_temp.u('d001');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-small'), false, 'vetor em needs_reindex: não está pronto');
SELECT is(ai_embedding_index_mark(pg_temp.u('f101'), 'text-embedding-3-small', true), false,
          'marcar com vetor na fila não marca (e limpa a marca)');
SELECT ok((SELECT complete_at IS NULL FROM ai_embedding_indexes
            WHERE provider_id = pg_temp.u('f101') AND model = 'text-embedding-3-small'), 'complete_at limpo');

-- O worker calcula o vetor do texto novo e fecha a passada.
UPDATE ai_embeddings SET embedded_hash = ai_text_sha256('Título 1 editado'), embedded_at = now() WHERE object_id = pg_temp.u('d001');
SELECT is(ai_embedding_index_mark(pg_temp.u('f101'), 'text-embedding-3-small', true), true, 'fila vazia de novo: marca');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-small'), true, 'pronto de novo');

-- Uma fonte nova sincronizada (linha sem vetor) tira o pronto até a próxima passada.
INSERT INTO ai_embeddings (object_type, object_id, provider_id, model, source_text)
VALUES ('title', pg_temp.u('d003'), pg_temp.u('f101'), 'text-embedding-3-small', 'Título 3');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-small'), false, 'fonte nova na fila: não está pronto');

-- Desmarcar explicitamente.
DELETE FROM ai_embeddings WHERE object_id = pg_temp.u('d003');
SELECT is(ai_embedding_index_mark(pg_temp.u('f101'), 'text-embedding-3-small', false), false, 'false desmarca');
SELECT is(ai_embedding_index_ready(pg_temp.u('f101'), 'text-embedding-3-small'), false, 'desmarcado: não está pronto');
RESET ROLE;

SELECT is(pg_temp.err($$SELECT ai_embedding_index_mark('00000000-0000-7000-8000-00000069ffff', 'x', true)$$), 'P0002',
          'par não registrado');
SELECT is(pg_temp.err($$SELECT ai_embedding_index_mark('00000000-0000-7000-8000-00000069f101', 'text-embedding-3-small', NULL)$$),
          '22023', 'completo nulo');

-- O touch do worker não mexe na marca.
SELECT ai_embedding_index_mark(pg_temp.u('f101'), 'text-embedding-3-small', true);
SELECT lives_ok($$SELECT * FROM ai_embedding_indexes_touch()$$, 'touch roda');
SELECT ok((SELECT complete_at IS NOT NULL FROM ai_embedding_indexes
            WHERE provider_id = pg_temp.u('f101') AND model = 'text-embedding-3-small'), 'o touch mantém complete_at');

SELECT * FROM finish();
ROLLBACK;
