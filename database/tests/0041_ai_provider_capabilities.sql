-- Testes de 0041_ai_provider_capabilities: flags e modelos padrão dos provedores (padrões pelo tipo e pela base_url,
-- Anthropic compatível com modelo de texto), inferências por agente (flag exigida e flag em uso), derivados de anexo
-- e de mensagem (origem, unicidade, fila, áudio gerado em attachment_links e apagado com o derivado), índices de
-- embeddings por par (pares em uso, touch, purga, busca filtrada com hnsw.iterative_scan), credenciais, finalidades
-- novas, custo de áudio e o papel da aplicação.
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
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;

-- O DETAIL do erro (ou NULL).
CREATE FUNCTION pg_temp.err_detail(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  d text;
BEGIN
  EXECUTE cmd;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
  RETURN d;
END
$$;

-- Estrutura ----------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['ai_agent_inferences', 'ai_attachment_derivatives', 'ai_embedding_indexes']) t;
SELECT has_view(v) FROM unnest(ARRAY['ai_embedding_pairs_in_use', 'ai_embedding_index_stats']) v;
SELECT has_column('ai_providers', c) FROM unnest(ARRAY['capabilities', 'default_models', 'prompt_cache_enabled', 'thinking_enabled']) c;
SELECT col_not_null('ai_providers', c) FROM unnest(ARRAY['capabilities', 'default_models', 'prompt_cache_enabled', 'thinking_enabled']) c;
SELECT col_type_is('ai_providers', 'capabilities', 'text[]');
SELECT col_type_is('ai_providers', 'default_models', 'jsonb');
SELECT hasnt_column('ai_providers', 'embedding_model');
SELECT hasnt_index('ai_providers', 'ai_providers_embedding_key');
SELECT columns_are('ai_agent_inferences', ARRAY['agent_id', 'capability', 'provider_id', 'model', 'voice', 'created_at', 'updated_at']);
SELECT col_is_pk('ai_agent_inferences', ARRAY['agent_id', 'capability']);
SELECT fk_ok('ai_agent_inferences', 'agent_id', 'ai_agents', 'id');
SELECT fk_ok('ai_agent_inferences', 'provider_id', 'ai_providers', 'id');
SELECT columns_are('ai_attachment_derivatives', ARRAY['id', 'attachment_id', 'message_id', 'block_index', 'kind', 'provider_id',
  'model', 'voice', 'content', 'result_attachment_id', 'status', 'error', 'attempts', 'locked_at', 'created_at', 'updated_at']);
SELECT fk_ok('ai_attachment_derivatives', 'attachment_id', 'attachments', 'id');
SELECT fk_ok('ai_attachment_derivatives', 'message_id', 'ai_messages', 'id');
SELECT fk_ok('ai_attachment_derivatives', 'provider_id', 'ai_providers', 'id');
SELECT fk_ok('ai_attachment_derivatives', 'result_attachment_id', 'attachments', 'id');
SELECT columns_are('ai_embedding_indexes', ARRAY['provider_id', 'model', 'last_in_use_at', 'created_at', 'updated_at']);
SELECT col_is_pk('ai_embedding_indexes', ARRAY['provider_id', 'model']);
SELECT fk_ok('ai_embedding_indexes', 'provider_id', 'ai_providers', 'id');
SELECT col_not_null('ai_embeddings', 'provider_id');
SELECT fk_ok('ai_embeddings', ARRAY['provider_id', 'model'], 'ai_embedding_indexes', ARRAY['provider_id', 'model']);
SELECT has_index('ai_embeddings', i) FROM unnest(ARRAY['ai_embeddings_pair_idx', 'ai_embeddings_reindex_idx']) i;
SELECT has_index('ai_agent_inferences', 'ai_agent_inferences_provider_id_idx');
SELECT has_index('ai_attachment_derivatives', i)
  FROM unnest(ARRAY['ai_attachment_derivatives_message_id_idx', 'ai_attachment_derivatives_provider_id_idx',
                    'ai_attachment_derivatives_result_attachment_id_idx', 'ai_attachment_derivatives_queue_idx']) i;
SELECT is((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ai_attachment_derivatives_key'),
          'UNIQUE NULLS NOT DISTINCT (attachment_id, message_id, block_index, kind, provider_id, model, voice)',
          'derivado único com NULLS NOT DISTINCT');
SELECT is((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ai_embeddings_object_key'),
          'UNIQUE (object_type, object_id, provider_id, model)', 'um vetor por objeto e par');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conname = c), d, c || ': ON DELETE')
  FROM (VALUES ('ai_agent_inferences_agent_id_fkey', 'c'), ('ai_agent_inferences_provider_id_fkey', 'a'),
               ('ai_attachment_derivatives_attachment_id_fkey', 'c'), ('ai_attachment_derivatives_message_id_fkey', 'c'),
               ('ai_attachment_derivatives_provider_id_fkey', 'c'), ('ai_attachment_derivatives_result_attachment_id_fkey', 'c'),
               ('ai_embedding_indexes_provider_id_fkey', 'c'), ('ai_embeddings_index_fkey', 'c')) x (c, d);

SELECT has_function('ai_embedding_credentials', ARRAY['uuid']);
SELECT hasnt_function('ai_embedding_credentials', ARRAY[]::text[]);
SELECT has_function('ai_capability_credentials', ARRAY['uuid', 'text', 'uuid']);
SELECT has_function('ai_embeddings_search', ARRAY['vector', 'uuid', 'text', 'uuid[]', 'text[]', 'integer']);
SELECT hasnt_function('ai_embeddings_search', ARRAY['vector', 'text', 'uuid[]', 'text[]', 'integer']);
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' é SECURITY DEFINER')
  FROM unnest(ARRAY['ai_embedding_credentials(uuid)', 'ai_capability_credentials(uuid, text, uuid)']) f;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_embedding_credentials(uuid)', 'ai_capability_credentials(uuid, text, uuid)',
                    'ai_embeddings_search(vector, uuid, text, uuid[], text[], integer)', 'ai_embedding_indexes_touch()',
                    'ai_embedding_indexes_purge(interval)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['ai_embedding_credentials(uuid)', 'ai_capability_credentials(uuid, text, uuid)']) f;
SELECT ok(NOT has_function_privilege('moneyflow_app', 'ai_agent_inferences_audit_row()', 'EXECUTE'), 'app não executa o trigger de auditoria');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'ai_embeddings_search(vector, uuid, text, uuid[], text[], integer)'::regprocedure),
          ARRAY['hnsw.iterative_scan=relaxed_order'], 'busca roda com hnsw.iterative_scan = relaxed_order');
SELECT ok(has_column_privilege('moneyflow_app', 'ai_providers', c, 'SELECT'), 'app lê ' || c)
  FROM unnest(ARRAY['capabilities', 'default_models', 'prompt_cache_enabled', 'thinking_enabled']) c;
SELECT ok(NOT has_column_privilege('moneyflow_app', 'ai_providers', 'api_key', 'SELECT'), 'app continua sem ler api_key');

-- Dados base ----------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin', true),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000000a3', 'caio', 'caio@example.com', 'segredo', 'user', false);

-- Provedores: padrões ------------------------------------------------------------------------------------------
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-00000000f101', 'Claude', 'anthropic', 'sk-ant-SEGREDO-1111'),
  ('00000000-0000-7000-8000-00000000f102', 'OpenAI', 'openai', 'sk-proj-SEGREDO-2222');
INSERT INTO ai_providers (id, name, kind, base_url, default_models) VALUES
  ('00000000-0000-7000-8000-00000000f103', 'GLM', 'anthropic', 'https://api.z.ai/api/anthropic', '{"text": "glm-4.6"}'),
  ('00000000-0000-7000-8000-00000000f104', 'Ollama', 'openai', 'http://ollama:11434/v1', '{}');
SELECT results_eq($$SELECT name, capabilities, prompt_cache_enabled, thinking_enabled FROM ai_providers
                     WHERE id IN ('00000000-0000-7000-8000-00000000f101', '00000000-0000-7000-8000-00000000f102',
                                  '00000000-0000-7000-8000-00000000f103', '00000000-0000-7000-8000-00000000f104') ORDER BY id$$,
                  $$VALUES ('Claude', ARRAY['text', 'vision'], true, true),
                           ('OpenAI', ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech'], true, true),
                           ('GLM', ARRAY['text', 'vision'], false, false),
                           ('Ollama', ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech'], false, false)$$,
                  'flags pelo tipo; cache e raciocínio ligados só sem base_url');
INSERT INTO ai_providers (id, name, kind, api_key, capabilities, prompt_cache_enabled, thinking_enabled) VALUES
  ('00000000-0000-7000-8000-00000000f105', 'Só embeddings', 'openai', 'sk-proj-SEGREDO-5555', '{speech,embeddings}', false, true);
SELECT results_eq($$SELECT capabilities, prompt_cache_enabled, thinking_enabled FROM ai_providers
                     WHERE id = '00000000-0000-7000-8000-00000000f105'$$,
                  $$VALUES (ARRAY['embeddings', 'speech'], false, true)$$, 'valores informados valem; flags em ordem canônica');
UPDATE ai_providers SET default_models = '{"embeddings": "text-embedding-3-small", "speech": "gpt-4o-mini-tts", "speech_voice": "nova"}'
 WHERE id = '00000000-0000-7000-8000-00000000f105';
SELECT is(pg_temp.err(c), e, 'provedor: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_providers (name, kind, api_key, capabilities) VALUES ('X1', 'openai', 'abcdefghij', '{text,ocr}')$$,
     '23514 ai_providers_capabilities_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, capabilities) VALUES ('X2', 'openai', 'abcdefghij', '{text,text}')$$,
     '23514 ai_providers_capabilities_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, capabilities) VALUES ('X3', 'openai', 'abcdefghij', ARRAY['text', NULL])$$,
     '23514 ai_providers_capabilities_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, capabilities) VALUES ('X4', 'anthropic', 'abcdefghij', '{text,embeddings}')$$,
     '23514 ai_providers_capabilities_kind_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, capabilities) VALUES ('X5', 'anthropic', 'abcdefghij', '{text,transcription}')$$,
     '23514 ai_providers_capabilities_kind_check'),
    ($$UPDATE ai_providers SET kind = 'anthropic' WHERE id = '00000000-0000-7000-8000-00000000f102'$$,
     '23514 ai_providers_capabilities_kind_check'),
    ($$UPDATE ai_providers SET capabilities = NULL WHERE id = '00000000-0000-7000-8000-00000000f104'$$, '23502 '),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X6', 'anthropic', 'abcdefghij', '{"embeddings": "x"}')$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X7', 'anthropic', 'abcdefghij', '{"speech_voice": "alloy"}')$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X8', 'openai', 'abcdefghij', '{"chat": "gpt"}')$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X9', 'openai', 'abcdefghij', '{"text": 1}')$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X10', 'openai', 'abcdefghij', '{"text": " gpt"}')$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X11', 'openai', 'abcdefghij', '{"speech_voice": "a b"}')$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('X12', 'openai', 'abcdefghij', '[]')$$,
     '23514 ai_providers_default_models_check'),
    ($$UPDATE ai_providers SET capabilities = '{embeddings}' WHERE id = '00000000-0000-7000-8000-00000000f105'$$,
     '23514 ai_providers_default_models_check'),
    ($$INSERT INTO ai_providers (name, kind, api_key, default_models) VALUES ('Y1', 'openai', 'abcdefghij',
       '{"text": "gpt-4.1", "vision": "gpt-4.1", "embeddings": "text-embedding-3-small", "transcription": "gpt-4o-transcribe",
         "speech": "gpt-4o-mini-tts", "speech_voice": "alloy"}')$$, 'ok'),
    ($$INSERT INTO ai_providers (name, kind, base_url) VALUES ('Y2', 'openai', 'http://local:1234/v1')$$, 'ok')
  ) x (c, e);

-- Anthropic compatível: modelo de texto padrão
SELECT is(pg_temp.err(c), e, 'compatível: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_providers (name, kind, base_url) VALUES ('C1', 'anthropic', 'https://api.minimax.io/anthropic')$$,
     '23514 ai_providers_text_model_check'),
    ($$INSERT INTO ai_providers (name, kind, base_url, default_models) VALUES ('C2', 'anthropic', 'https://api.minimax.io/anthropic',
       '{"vision": "MiniMax-M2"}')$$, '23514 ai_providers_text_model_check'),
    ($$INSERT INTO ai_providers (name, kind, base_url, capabilities, default_models) VALUES ('C3', 'anthropic', 'http://x:1/',
       '{vision}', '{}')$$, 'ok'),
    ($$UPDATE ai_providers SET default_models = '{}' WHERE id = '00000000-0000-7000-8000-00000000f103'$$,
     '23514 ai_providers_text_model_check'),
    ($$UPDATE ai_providers SET base_url = 'https://openrouter.ai/api' WHERE id = '00000000-0000-7000-8000-00000000f101'$$,
     '23514 ai_providers_text_model_check'),
    ($$UPDATE ai_providers SET base_url = 'https://openrouter.ai/api', default_models = '{"text": "anthropic/claude-sonnet-4.5"}'
        WHERE name = 'Y1'$$, 'ok')
  ) x (c, e);
-- Provedor de antes da 0041 sem o modelo: ativar, desativar e arquivar ainda funcionam; mexer no que afeta, não.
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_validate;
INSERT INTO ai_providers (id, name, kind, base_url, capabilities, prompt_cache_enabled, thinking_enabled) VALUES
  ('00000000-0000-7000-8000-00000000f106', 'Legado', 'anthropic', 'http://proxy:8080', '{text,vision}', false, false);
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_validate;
SELECT is(pg_temp.err($$UPDATE ai_providers SET is_active = false, notes = 'parado' WHERE id = '00000000-0000-7000-8000-00000000f106'$$),
          'ok', 'legado sem modelo: desativar passa');
SELECT is(pg_temp.err($$UPDATE ai_providers SET capabilities = '{text}' WHERE id = '00000000-0000-7000-8000-00000000f106'$$),
          '23514 ai_providers_text_model_check', 'legado sem modelo: trocar as flags exige o modelo');

-- Agentes e inferências ---------------------------------------------------------------------------------------
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-00000000a201', 'Assistente', '00000000-0000-7000-8000-00000000f101', 'claude-sonnet-4-5'),
  ('00000000-0000-7000-8000-00000000a202', 'Leitor', '00000000-0000-7000-8000-00000000f102', 'gpt-4.1');
INSERT INTO ai_agents (id, name, provider_id, model, is_active, archived_at) VALUES
  ('00000000-0000-7000-8000-00000000a203', 'Velho', '00000000-0000-7000-8000-00000000f104', 'llama3', false, now());
SELECT is(pg_temp.err(c), e, 'agente: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_agents (name, provider_id, model) VALUES ('Sem texto', '00000000-0000-7000-8000-00000000f105', 'x')$$,
     '23514 ai_agents_provider_text_check'),
    ($$UPDATE ai_agents SET provider_id = '00000000-0000-7000-8000-00000000f105' WHERE id = '00000000-0000-7000-8000-00000000a202'$$,
     '23514 ai_agents_provider_text_check'),
    ($$UPDATE ai_agents SET description = 'ok' WHERE id = '00000000-0000-7000-8000-00000000a202'$$, 'ok')
  ) x (c, e);

SET LOCAL app.user_id = '00000000-0000-7000-8000-0000000000a1';
INSERT INTO ai_agent_inferences (agent_id, capability, provider_id, model, voice) VALUES
  ('00000000-0000-7000-8000-00000000a201', 'vision', '00000000-0000-7000-8000-00000000f101', NULL, NULL),
  ('00000000-0000-7000-8000-00000000a201', 'embeddings', '00000000-0000-7000-8000-00000000f105', NULL, NULL),
  ('00000000-0000-7000-8000-00000000a201', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1', NULL),
  ('00000000-0000-7000-8000-00000000a201', 'speech', '00000000-0000-7000-8000-00000000f105', NULL, NULL),
  ('00000000-0000-7000-8000-00000000a202', 'embeddings', '00000000-0000-7000-8000-00000000f102', 'text-embedding-3-large', NULL),
  ('00000000-0000-7000-8000-00000000a202', 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1', 'onyx'),
  ('00000000-0000-7000-8000-00000000a203', 'vision', '00000000-0000-7000-8000-00000000f104', NULL, NULL);
SELECT results_eq($$SELECT action, record_id, user_id FROM audit_log
                     WHERE table_name = 'ai_agent_inferences' AND new_data ->> 'capability' = 'transcription'$$,
                  $$VALUES ('insert', '00000000-0000-7000-8000-00000000a201'::uuid, '00000000-0000-7000-8000-0000000000a1'::uuid)$$,
                  'inferência auditada no histórico do agente (record_id = agent_id)');
UPDATE ai_agent_inferences SET model = 'gpt-4o-transcribe'
 WHERE agent_id = '00000000-0000-7000-8000-00000000a201' AND capability = 'transcription';
SELECT is((SELECT changed_columns FROM audit_log WHERE table_name = 'ai_agent_inferences' AND action = 'update'),
          ARRAY['model'], 'troca de modelo auditada');
SET LOCAL app.user_id = '';

SELECT is(pg_temp.err(c), e, 'inferência: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id) VALUES
       ('00000000-0000-7000-8000-00000000a202', 'vision', '00000000-0000-7000-8000-00000000f105')$$,
     '23514 ai_agent_inferences_provider_capability_check'),
    ($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id) VALUES
       ('00000000-0000-7000-8000-00000000a202', 'transcription', '00000000-0000-7000-8000-00000000f101')$$,
     '23514 ai_agent_inferences_provider_capability_check'),
    ($$UPDATE ai_agent_inferences SET provider_id = '00000000-0000-7000-8000-00000000f101'
        WHERE agent_id = '00000000-0000-7000-8000-00000000a202' AND capability = 'embeddings'$$,
     '23514 ai_agent_inferences_provider_capability_check'),
    ($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id) VALUES
       ('00000000-0000-7000-8000-00000000a202', 'text', '00000000-0000-7000-8000-00000000f102')$$,
     '23514 ai_agent_inferences_capability_check'),
    ($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id, voice) VALUES
       ('00000000-0000-7000-8000-00000000a202', 'transcription', '00000000-0000-7000-8000-00000000f102', 'alloy')$$,
     '23514 ai_agent_inferences_voice_check'),
    ($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000a202', 'transcription', '00000000-0000-7000-8000-00000000f102', 'com espaço')$$,
     '23514 ai_agent_inferences_model_check'),
    ($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id) VALUES
       ('00000000-0000-7000-8000-00000000a201', 'vision', '00000000-0000-7000-8000-00000000f102')$$,
     '23505 ai_agent_inferences_pkey'),
    ($$DELETE FROM ai_providers WHERE id = '00000000-0000-7000-8000-00000000f105'$$,
     '23503 ai_agent_inferences_provider_id_fkey')
  ) x (c, e);

-- Flag em uso não sai (arquivado conta)
SELECT is(pg_temp.err(c), e, 'flag em uso: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$UPDATE ai_providers SET capabilities = '{vision}' WHERE id = '00000000-0000-7000-8000-00000000f101'$$,
     '23514 ai_providers_capability_in_use_check'),
    ($$UPDATE ai_providers SET capabilities = '{text}' WHERE id = '00000000-0000-7000-8000-00000000f101'$$,
     '23514 ai_providers_capability_in_use_check'),
    ($$UPDATE ai_providers SET capabilities = '{text,embeddings,transcription,speech}' WHERE id = '00000000-0000-7000-8000-00000000f104'$$,
     '23514 ai_providers_capability_in_use_check'),
    ($$UPDATE ai_providers SET capabilities = '{text,vision,embeddings,speech}', default_models = '{"embeddings": "text-embedding-3-small"}'
        WHERE id = '00000000-0000-7000-8000-00000000f102'$$,
     '23514 ai_providers_capability_in_use_check'),
    ($$UPDATE ai_providers SET capabilities = '{text,vision,embeddings,transcription,speech}', is_active = false
        WHERE id = '00000000-0000-7000-8000-00000000f102'$$, 'ok')
  ) x (c, e);
UPDATE ai_providers SET is_active = true WHERE id = '00000000-0000-7000-8000-00000000f102';
SELECT is(pg_temp.err_detail($$UPDATE ai_providers SET capabilities = '{embeddings}' WHERE id = '00000000-0000-7000-8000-00000000f102'$$),
          'Assistente, Leitor', 'DETAIL traz os agentes que usam as flags');
SELECT is(pg_temp.err_detail($$UPDATE ai_providers SET capabilities = '{text}' WHERE id = '00000000-0000-7000-8000-00000000f104'$$),
          'Velho', 'o agente arquivado conta');
DELETE FROM ai_agent_inferences WHERE agent_id = '00000000-0000-7000-8000-00000000a203';
SELECT is(pg_temp.err($$UPDATE ai_providers SET capabilities = '{text}' WHERE id = '00000000-0000-7000-8000-00000000f104'$$), 'ok',
          'sem o vínculo, a flag sai');

-- Credenciais -------------------------------------------------------------------------------------------------
SELECT results_eq($$SELECT k.provider_id, k.kind, k.api_key, k.model, k.voice
                      FROM unnest(ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech']) WITH ORDINALITY u (c, o),
                           ai_capability_credentials('00000000-0000-7000-8000-00000000a201', u.c, '00000000-0000-7000-8000-0000000000a2') k
                     ORDER BY u.o$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f101'::uuid, 'anthropic', 'sk-ant-SEGREDO-1111', 'claude-sonnet-4-5', NULL::text),
                           ('00000000-0000-7000-8000-00000000f101'::uuid, 'anthropic', 'sk-ant-SEGREDO-1111', NULL, NULL),
                           ('00000000-0000-7000-8000-00000000f105'::uuid, 'openai', 'sk-proj-SEGREDO-5555', 'text-embedding-3-small', NULL),
                           ('00000000-0000-7000-8000-00000000f102'::uuid, 'openai', 'sk-proj-SEGREDO-2222', 'gpt-4o-transcribe', NULL),
                           ('00000000-0000-7000-8000-00000000f105'::uuid, 'openai', 'sk-proj-SEGREDO-5555', 'gpt-4o-mini-tts', 'nova')$$,
                  'credenciais por capacidade: texto do agente, padrões do provedor quando nulos, voz só no speech');
SELECT results_eq($$SELECT model, voice FROM ai_capability_credentials('00000000-0000-7000-8000-00000000a202', 'speech',
                                                                        '00000000-0000-7000-8000-0000000000a2')$$,
                  $$VALUES ('tts-1', 'onyx')$$, 'modelo e voz da inferência vencem o padrão');
SELECT is(pg_temp.err(format('SELECT * FROM ai_capability_credentials(%L, %L, %L)', a, c, u)), e, d)
  FROM (VALUES
    ('00000000-0000-7000-8000-00000000a201', 'ocr', '00000000-0000-7000-8000-0000000000a2', '22023 ', 'capacidade desconhecida'),
    ('00000000-0000-7000-8000-00000000a201', 'vision', '00000000-0000-7000-8000-0000000000a3', '42501 ', 'ator inativo'),
    ('00000000-0000-7000-8000-00000000a201', 'vision', '00000000-0000-7000-8000-0000000000ff', '42501 ', 'ator inexistente'),
    ('00000000-0000-7000-8000-00000000a2ff', 'vision', '00000000-0000-7000-8000-0000000000a2', 'P0002 ', 'agente inexistente'),
    ('00000000-0000-7000-8000-00000000a203', 'text', '00000000-0000-7000-8000-0000000000a2', '42501 ', 'agente arquivado'),
    ('00000000-0000-7000-8000-00000000a202', 'vision', '00000000-0000-7000-8000-0000000000a2', 'P0002 ', 'sem provedor para a capacidade')
  ) x (a, c, u, e, d);
UPDATE ai_providers SET is_active = false WHERE id = '00000000-0000-7000-8000-00000000f105';
SELECT is(pg_temp.err($$SELECT * FROM ai_capability_credentials('00000000-0000-7000-8000-00000000a201', 'embeddings',
                                                                 '00000000-0000-7000-8000-0000000000a2')$$), '42501 ', 'provedor inativo: 42501');
SELECT is(pg_temp.err($$SELECT * FROM ai_embedding_credentials('00000000-0000-7000-8000-00000000f105')$$), '42501 ',
          'embeddings de provedor inativo: 42501');
UPDATE ai_providers SET is_active = true WHERE id = '00000000-0000-7000-8000-00000000f105';
-- Sem a flag (só chega aqui contornando o trigger, mas a função não confia nele).
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_validate;
UPDATE ai_providers SET capabilities = '{text}', default_models = '{}' WHERE id = '00000000-0000-7000-8000-00000000f102';
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_validate;
SELECT is(pg_temp.err($$SELECT * FROM ai_capability_credentials('00000000-0000-7000-8000-00000000a201', 'transcription',
                                                                 '00000000-0000-7000-8000-0000000000a2')$$), '42501 ', 'provedor sem a flag: 42501');
SELECT is(pg_temp.err($$SELECT * FROM ai_embedding_credentials('00000000-0000-7000-8000-00000000f102')$$), '42501 ',
          'embeddings sem a flag: 42501');
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_validate;
UPDATE ai_providers SET capabilities = '{vision}' WHERE id = '00000000-0000-7000-8000-00000000f101';
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_validate;
SELECT is(pg_temp.err($$SELECT * FROM ai_capability_credentials('00000000-0000-7000-8000-00000000a201', 'text',
                                                                 '00000000-0000-7000-8000-0000000000a2')$$), '42501 ', 'texto sem a flag: 42501');
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_validate;
UPDATE ai_providers SET capabilities = '{text,vision}' WHERE id = '00000000-0000-7000-8000-00000000f101';
UPDATE ai_providers SET capabilities = '{text,vision,embeddings,transcription,speech}' WHERE id = '00000000-0000-7000-8000-00000000f102';
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_validate;
SELECT results_eq($$SELECT provider_id, kind, api_key, default_model FROM ai_embedding_credentials('00000000-0000-7000-8000-00000000f105')$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f105'::uuid, 'openai', 'sk-proj-SEGREDO-5555', 'text-embedding-3-small')$$,
                  'credenciais de embeddings do provedor, com o modelo padrão');
SELECT is(pg_temp.err($$SELECT * FROM ai_embedding_credentials('00000000-0000-7000-8000-00000000ffff')$$), 'P0002 ',
          'provedor inexistente: P0002');

-- A execução lê só provedor de texto
INSERT INTO ai_conversations (id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-00000000c301', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000a201');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-00000000c401', '00000000-0000-7000-8000-00000000c301', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-00000000a201');
SELECT is((SELECT count(*)::int FROM ai_run_claim(1)), 1, 'execução reservada');
SELECT is((SELECT model FROM ai_run_provider_credentials('00000000-0000-7000-8000-00000000c401')), 'claude-sonnet-4-5',
          'credenciais da execução');
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_validate;
UPDATE ai_providers SET capabilities = '{vision}' WHERE id = '00000000-0000-7000-8000-00000000f101';
SELECT is(pg_temp.err($$SELECT * FROM ai_run_provider_credentials('00000000-0000-7000-8000-00000000c401')$$), '42501 ',
          'execução com provedor sem text: 42501');
UPDATE ai_providers SET capabilities = '{text,vision}' WHERE id = '00000000-0000-7000-8000-00000000f101';
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_validate;

-- Derivados ----------------------------------------------------------------------------------------------------
INSERT INTO ai_messages (id, conversation_id, role, content) VALUES
  ('00000000-0000-7000-8000-00000000c501', '00000000-0000-7000-8000-00000000c301', 'assistant', '[{"type": "text", "text": "Olá"}]');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-00000000d001', 'nota.png', 'image/png', '\x89504e47'),
  ('00000000-0000-7000-8000-00000000d002', 'boleto.pdf', 'application/pdf', '\x25504446'),
  ('00000000-0000-7000-8000-00000000d003', 'fala-1.mp3', 'audio/mpeg', '\x494433'),
  ('00000000-0000-7000-8000-00000000d004', 'fala-2.mp3', 'audio/mpeg', '\x494434'),
  ('00000000-0000-7000-8000-00000000d005', 'fala-3.mp3', 'audio/mpeg', '\x494435'),
  ('00000000-0000-7000-8000-00000000d006', 'audio.ogg', 'audio/ogg', '\x4f676753');
INSERT INTO ai_attachment_derivatives (id, attachment_id, message_id, block_index, kind, provider_id, model, voice, status, content,
                                       result_attachment_id) VALUES
  ('00000000-0000-7000-8000-00000000d101', '00000000-0000-7000-8000-00000000d001', NULL, NULL, 'description',
   '00000000-0000-7000-8000-00000000f102', 'gpt-4.1', NULL, 'done', 'Uma nota fiscal.', NULL),
  ('00000000-0000-7000-8000-00000000d102', '00000000-0000-7000-8000-00000000d002', NULL, NULL, 'pdf_text',
   NULL, NULL, NULL, 'done', 'Boleto de energia', NULL),
  ('00000000-0000-7000-8000-00000000d103', '00000000-0000-7000-8000-00000000d006', NULL, NULL, 'transcription',
   '00000000-0000-7000-8000-00000000f102', 'gpt-4o-transcribe', NULL, 'pending', NULL, NULL),
  ('00000000-0000-7000-8000-00000000d104', NULL, '00000000-0000-7000-8000-00000000c501', 0, 'speech',
   '00000000-0000-7000-8000-00000000f102', 'tts-1', 'onyx', 'done', NULL, '00000000-0000-7000-8000-00000000d003');
SELECT is(pg_temp.err(c), e, 'derivado: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000d001', 'description', '00000000-0000-7000-8000-00000000f102', 'gpt-4.1')$$,
     '23505 ai_attachment_derivatives_key'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000d001', 'description', '00000000-0000-7000-8000-00000000f102', 'gpt-4.1-mini')$$, 'ok'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind) VALUES ('00000000-0000-7000-8000-00000000d002', 'pdf_text')$$,
     '23505 ai_attachment_derivatives_key'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model, voice) VALUES
       ('00000000-0000-7000-8000-00000000c501', 0, 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1', 'onyx')$$,
     '23505 ai_attachment_derivatives_key'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000c501', 0, 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1')$$, 'ok'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000c501', 0, 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1')$$,
     '23505 ai_attachment_derivatives_key'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model, voice) VALUES
       ('00000000-0000-7000-8000-00000000c501', 1, 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1', 'onyx')$$, 'ok'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, message_id, block_index, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000d001', '00000000-0000-7000-8000-00000000c501', 0, 'speech',
        '00000000-0000-7000-8000-00000000f102', 'tts-1')$$, '23514 ai_attachment_derivatives_origin_check'),
    ($$INSERT INTO ai_attachment_derivatives (kind, provider_id, model) VALUES ('description', '00000000-0000-7000-8000-00000000f102', 'x')$$,
     '23514 ai_attachment_derivatives_origin_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1')$$,
     '23514 ai_attachment_derivatives_origin_check'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000c501', 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1')$$,
     '23514 ai_attachment_derivatives_origin_check'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000c501', 0, 'transcription', '00000000-0000-7000-8000-00000000f102', 'x')$$,
     '23514 ai_attachment_derivatives_origin_check'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000c501', 10000, 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1')$$,
     '23514 ai_attachment_derivatives_block_index_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000d002', 'pdf_text', '00000000-0000-7000-8000-00000000f102', 'x')$$,
     '23514 ai_attachment_derivatives_provider_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102')$$,
     '23514 ai_attachment_derivatives_provider_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, model) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', 'whisper-1')$$,
     '23514 ai_attachment_derivatives_provider_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, voice) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 'alloy')$$,
     '23514 ai_attachment_derivatives_voice_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'ocr', '00000000-0000-7000-8000-00000000f102', 'x')$$,
     '23514 ai_attachment_derivatives_kind_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, status) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 'running')$$,
     '23514 ai_attachment_derivatives_lock_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, status) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 'done')$$,
     '23514 ai_attachment_derivatives_result_check'),
    ($$INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model, status) VALUES
       ('00000000-0000-7000-8000-00000000c501', 2, 'speech', '00000000-0000-7000-8000-00000000f102', 'tts-1', 'done')$$,
     '23514 ai_attachment_derivatives_result_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, result_attachment_id) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1',
        '00000000-0000-7000-8000-00000000d004')$$, '23514 ai_attachment_derivatives_result_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, status) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 'failed')$$,
     '23514 ai_attachment_derivatives_error_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, attempts) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 101)$$,
     '23514 ai_attachment_derivatives_attempts_check'),
    ($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, content) VALUES
       ('00000000-0000-7000-8000-00000000d006', 'transcription', '00000000-0000-7000-8000-00000000f102', 'whisper-1',
        repeat('x', 5000001))$$, '23514 ai_attachment_derivatives_content_check'),
    -- Fila: reserva, falha com erro, nova tentativa e conclusão.
    ($$UPDATE ai_attachment_derivatives SET status = 'running', locked_at = now(), attempts = attempts + 1
        WHERE id = '00000000-0000-7000-8000-00000000d103'$$, 'ok'),
    ($$UPDATE ai_attachment_derivatives SET status = 'failed', locked_at = NULL, error = 'HTTP 500'
        WHERE id = '00000000-0000-7000-8000-00000000d103'$$, 'ok'),
    ($$UPDATE ai_attachment_derivatives SET status = 'done', content = 'Pague a conta de luz.'
        WHERE id = '00000000-0000-7000-8000-00000000d103'$$, 'ok'),
    ($$UPDATE ai_attachment_derivatives SET model = 'whisper-1' WHERE id = '00000000-0000-7000-8000-00000000d103'$$,
     '23514 ai_attachment_derivatives_immutable_check'),
    ($$UPDATE ai_attachment_derivatives SET attachment_id = '00000000-0000-7000-8000-00000000d001'
        WHERE id = '00000000-0000-7000-8000-00000000d103'$$, '23514 ai_attachment_derivatives_immutable_check')
  ) x (c, e);
SELECT is((SELECT attempts::int FROM ai_attachment_derivatives WHERE id = '00000000-0000-7000-8000-00000000d103'), 1, 'tentativas contadas');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_attachment_derivatives'), 0, 'derivados fora da auditoria');

-- Áudio gerado em attachment_links; trocado ou com o derivado excluído, sai se ficou sem vínculo
SELECT results_eq($$SELECT target_kind, target_id FROM attachment_links WHERE attachment_id = '00000000-0000-7000-8000-00000000d003'$$,
                  $$VALUES ('ai_message_speech', '00000000-0000-7000-8000-00000000c501'::uuid)$$, 'áudio gerado aparece em attachment_links');
UPDATE ai_attachment_derivatives SET result_attachment_id = '00000000-0000-7000-8000-00000000d004'
 WHERE id = '00000000-0000-7000-8000-00000000d104';
SELECT ok(NOT EXISTS (SELECT 1 FROM attachments WHERE id = '00000000-0000-7000-8000-00000000d003'), 'áudio trocado: o antigo sai');
INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'company', 'Energisa');
INSERT INTO entity_attachments (entity_id, attachment_id) VALUES
  ('00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000d004');
UPDATE ai_attachment_derivatives SET status = 'done', result_attachment_id = '00000000-0000-7000-8000-00000000d005'
 WHERE message_id = '00000000-0000-7000-8000-00000000c501' AND block_index = 1;
DELETE FROM ai_attachment_derivatives WHERE id = '00000000-0000-7000-8000-00000000d104';
SELECT ok(EXISTS (SELECT 1 FROM attachments WHERE id = '00000000-0000-7000-8000-00000000d004'), 'áudio com outro vínculo fica');
-- Excluir a conversa leva as mensagens, os derivados speech e os áudios gerados
DELETE FROM ai_conversations WHERE id = '00000000-0000-7000-8000-00000000c301';
SELECT is((SELECT count(*)::int FROM ai_attachment_derivatives WHERE message_id IS NOT NULL), 0, 'derivados da mensagem saem com ela');
SELECT ok(NOT EXISTS (SELECT 1 FROM attachments WHERE id = '00000000-0000-7000-8000-00000000d005'), 'áudio gerado sai com a conversa');
-- Excluir o anexo leva os derivados dele
DELETE FROM attachments WHERE id = '00000000-0000-7000-8000-00000000d001';
SELECT is((SELECT count(*)::int FROM ai_attachment_derivatives WHERE kind = 'description'), 0, 'derivados saem com o anexo');

-- Índices de embeddings por par ---------------------------------------------------------------------------------
-- Em uso: Assistente (ativo) → f105 com o padrão; Leitor (ativo) → f102 com text-embedding-3-large.
INSERT INTO ai_agents (id, name, provider_id, model, is_active) VALUES
  ('00000000-0000-7000-8000-00000000a204', 'Inativo', '00000000-0000-7000-8000-00000000f102', 'gpt-4.1', false);
INSERT INTO ai_agent_inferences (agent_id, capability, provider_id, model) VALUES
  ('00000000-0000-7000-8000-00000000a204', 'embeddings', '00000000-0000-7000-8000-00000000f102', 'text-embedding-ada-002');
SELECT results_eq($$SELECT provider_id, model, agents FROM ai_embedding_pairs_in_use ORDER BY provider_id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f102'::uuid, 'text-embedding-3-large', 1),
                           ('00000000-0000-7000-8000-00000000f105'::uuid, 'text-embedding-3-small', 1)$$,
                  'pares em uso: agentes ativos, modelo nulo herda o padrão, inativo fica de fora');
SELECT is(pg_temp.err($$INSERT INTO ai_embeddings (object_type, object_id, provider_id, model, source_text) VALUES
                         ('entity', '00000000-0000-7000-8000-00000000e001', '00000000-0000-7000-8000-00000000f102',
                          'text-embedding-3-large', 'Energisa')$$),
          '23503 ai_embeddings_index_fkey', 'vetor só de par registrado');
SELECT results_eq($$SELECT provider_id, model FROM ai_embedding_indexes_touch() ORDER BY provider_id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f102'::uuid, 'text-embedding-3-large'),
                           ('00000000-0000-7000-8000-00000000f105'::uuid, 'text-embedding-3-small')$$, 'touch registra e devolve os pares em uso');
UPDATE ai_embedding_indexes SET last_in_use_at = now() - interval '30 days';
SELECT is((SELECT count(*)::int FROM ai_embedding_indexes_touch()), 2, 'touch de novo');
SELECT is((SELECT count(*)::int FROM ai_embedding_indexes WHERE last_in_use_at = now()), 2, 'touch renova last_in_use_at');
UPDATE ai_providers SET is_active = false WHERE id = '00000000-0000-7000-8000-00000000f105';
SELECT is((SELECT count(*)::int FROM ai_embedding_pairs_in_use), 1, 'provedor inativo sai dos pares em uso');
UPDATE ai_providers SET is_active = true WHERE id = '00000000-0000-7000-8000-00000000f105';

-- Busca: dois pares no mesmo HNSW; o par raro (30 vetores, todos mais longe da consulta que os 300 do outro par)
-- continua achando os seus com o índice forçado. (O HNSW é aproximado: com poucos vetores longe de todos, alguns podem
-- ficar sem ligação no grafo; 30 deixam a busca dos 5 mais próximos estável.)
INSERT INTO ai_embedding_indexes (provider_id, model, last_in_use_at) VALUES
  ('00000000-0000-7000-8000-00000000f102', 'text-embedding-3-small', now() - interval '8 days'),
  ('00000000-0000-7000-8000-00000000f104', 'nomic-embed-text', now() - interval '1 day');
CREATE TEMP TABLE q AS
SELECT (SELECT array_agg(CASE WHEN i = 1 THEN 1 ELSE 0 END ORDER BY i) FROM generate_series(1, 1536) i)::vector(1536) AS e1;
-- 300 vetores do par comum perto da consulta e, para 30 deles, um gêmeo do par raro um pouco mais longe (a 1ª
-- coordenada cai de 1 para 0,8): todos os raros ficam atrás de todos os comuns, mas na mesma vizinhança do grafo.
CREATE TEMP TABLE noise AS
SELECT g, (SELECT array_agg(random() * 0.01 ORDER BY i) FROM generate_series(1, 1535 + 0 * g) i) AS rest
  FROM generate_series(1, 300) g;
INSERT INTO ai_embeddings (object_type, object_id, provider_id, model, source_text, embedding, embedded_hash, embedded_at)
SELECT 'title', gen_random_uuid(), x.provider_id, 'text-embedding-3-small', x.label || n.g,
       (ARRAY[x.first] || n.rest)::vector(1536), ai_text_sha256(x.label || n.g), now()
  FROM noise n
  CROSS JOIN (VALUES ('00000000-0000-7000-8000-00000000f105'::uuid, 'Título ', 1.0::float8, 1),
                     ('00000000-0000-7000-8000-00000000f102'::uuid, 'Outro ', 0.8::float8, 2)) x (provider_id, label, first, k)
 WHERE x.k = 1 OR n.g % 10 = 0
 ORDER BY n.g, x.k;
INSERT INTO ai_embeddings (object_type, object_id, provider_id, model, source_text)
SELECT 'title', gen_random_uuid(), '00000000-0000-7000-8000-00000000f104', 'nomic-embed-text', 'Sem vetor ' || g
  FROM generate_series(1, 3) g;
-- Força o HNSW (sem varredura sequencial, bitmap nem ordenação): é o plano em que o filtro do par vem depois do índice.
SET LOCAL enable_seqscan = off;
SET LOCAL enable_bitmapscan = off;
SET LOCAL enable_sort = off;
SET LOCAL hnsw.iterative_scan = off;
SELECT ok((SELECT count(*) FROM (SELECT 1 FROM ai_embeddings e
                                  WHERE e.provider_id = '00000000-0000-7000-8000-00000000f102' AND e.model = 'text-embedding-3-small'
                                    AND e.embedding IS NOT NULL
                                  ORDER BY e.embedding <=> (SELECT e1 FROM q) LIMIT 5) x) < 5,
          'sem a varredura iterativa, o filtro depois do HNSW perde vetores do par raro');
SELECT is((SELECT count(*)::int FROM ai_embeddings_search((SELECT e1 FROM q), '00000000-0000-7000-8000-00000000f102',
                                                         'text-embedding-3-small', NULL, NULL, 5)), 5,
          'par raro: a varredura iterativa acha 5 vetores dele, mesmo atrás de 300 de outro par');
SELECT ok((SELECT bool_and(source_text LIKE 'Outro %') FROM ai_embeddings_search((SELECT e1 FROM q), '00000000-0000-7000-8000-00000000f102',
                                                                                 'text-embedding-3-small', NULL, NULL, 5)),
          'só vetores do par pedido');
SELECT is((SELECT count(*)::int FROM ai_embeddings_search((SELECT e1 FROM q), '00000000-0000-7000-8000-00000000f105',
                                                         'text-embedding-3-small', NULL, NULL, 200)), 200, 'outro provedor, mesmo modelo: os dele');
SELECT ok((SELECT bool_and(d1 <= d2) FROM (
             SELECT distance AS d1, lead(distance) OVER (ORDER BY ord) AS d2
               FROM ai_embeddings_search((SELECT e1 FROM q), '00000000-0000-7000-8000-00000000f105', 'text-embedding-3-small',
                                         NULL, NULL, 50) WITH ORDINALITY s (object_type, object_id, caixa_id, source_text, distance, ord)) x
             WHERE d2 IS NOT NULL), 'resultado em ordem de distância (relaxed_order reordenado)');
SELECT is(current_setting('hnsw.iterative_scan'), 'off', 'a configuração da sessão volta ao sair da função');
SELECT is(pg_temp.err($$SELECT * FROM ai_embeddings_search((SELECT e1 FROM q), NULL, 'text-embedding-3-small', NULL)$$), '22023 ',
          'provedor obrigatório');
RESET enable_seqscan;
RESET enable_bitmapscan;
RESET enable_sort;
RESET hnsw.iterative_scan;

SELECT results_eq($$SELECT provider_id, model, in_use, vectors, indexed, pending FROM ai_embedding_index_stats ORDER BY provider_id, model$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f102'::uuid, 'text-embedding-3-large', true, 0, 0, 0),
                           ('00000000-0000-7000-8000-00000000f102'::uuid, 'text-embedding-3-small', false, 30, 30, 0),
                           ('00000000-0000-7000-8000-00000000f104'::uuid, 'nomic-embed-text', false, 3, 0, 3),
                           ('00000000-0000-7000-8000-00000000f105'::uuid, 'text-embedding-3-small', true, 300, 300, 0)$$,
                  'progresso por par');

-- Purga: só o par fora de uso parado há mais que o prazo
SELECT is(ai_embedding_indexes_purge(), 30::bigint, 'purga os vetores do par parado há mais de 7 dias');
SELECT results_eq($$SELECT provider_id, model FROM ai_embedding_indexes ORDER BY provider_id, model$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f102'::uuid, 'text-embedding-3-large'),
                           ('00000000-0000-7000-8000-00000000f104'::uuid, 'nomic-embed-text'),
                           ('00000000-0000-7000-8000-00000000f105'::uuid, 'text-embedding-3-small')$$,
                  'pares em uso e o parado há menos tempo ficam');
UPDATE ai_embedding_indexes SET last_in_use_at = now() - interval '60 days';
SELECT is(ai_embedding_indexes_purge(interval '2 hours'), 3::bigint, 'par em uso nunca é purgado, mesmo velho');
SELECT is((SELECT count(*)::int FROM ai_embeddings), 300, 'só os vetores do par em uso sobram');
SELECT is(pg_temp.err($$SELECT ai_embedding_indexes_purge(interval '5 minutes')$$), '22023 ', 'prazo mínimo de 1 hora');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name IN ('ai_embedding_indexes', 'ai_embeddings')), 0, 'fora da auditoria');
-- Excluir o provedor leva os pares e os vetores
DELETE FROM ai_agent_inferences WHERE provider_id = '00000000-0000-7000-8000-00000000f105';
DELETE FROM ai_providers WHERE id = '00000000-0000-7000-8000-00000000f105';
SELECT is((SELECT count(*)::int FROM ai_embeddings), 0, 'provedor excluído leva os vetores do par');

-- Uso e preços ------------------------------------------------------------------------------------------------
INSERT INTO ai_model_prices (provider_id, model, input_price_per_million, output_price_per_million, audio_input_per_minute,
                             speech_per_million_chars, valid_from) VALUES
  ('00000000-0000-7000-8000-00000000f102', 'whisper-1', 0, 0, 0.006, NULL, '2026-01-01'),
  ('00000000-0000-7000-8000-00000000f102', 'tts-1', 0, 0, NULL, 15, '2026-01-01'),
  ('00000000-0000-7000-8000-00000000f102', 'gpt-4o-transcribe', 2.5, 10, NULL, NULL, '2026-01-01');
-- 90 s × US$ 0,006/min = US$ 0,009 = 9000 micros; 12,5 s = 1250; 1000 caracteres × 15/milhão = 15000; tokens: 2500 + 1000.
INSERT INTO ai_usage (id, provider_id, model, purpose, audio_seconds, characters, input_tokens, output_tokens) VALUES
  ('00000000-0000-7000-8000-00000000b001', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 'transcription', 90, 0, 0, 0),
  ('00000000-0000-7000-8000-00000000b002', '00000000-0000-7000-8000-00000000f102', 'whisper-1', 'transcription', 12.5, 0, 0, 0),
  ('00000000-0000-7000-8000-00000000b003', '00000000-0000-7000-8000-00000000f102', 'tts-1', 'speech', 0, 1000, 0, 0),
  ('00000000-0000-7000-8000-00000000b004', '00000000-0000-7000-8000-00000000f102', 'gpt-4o-transcribe', 'transcription', 30, 0, 1000, 100),
  ('00000000-0000-7000-8000-00000000b005', '00000000-0000-7000-8000-00000000f102', 'gpt-4.1', 'vision_describe', 0, 0, 500, 50);
SELECT results_eq($$SELECT purpose, audio_seconds, characters, cost_micros, currency FROM ai_usage
                     WHERE id IN ('00000000-0000-7000-8000-00000000b001', '00000000-0000-7000-8000-00000000b002',
                                  '00000000-0000-7000-8000-00000000b003', '00000000-0000-7000-8000-00000000b004') ORDER BY id$$,
                  $$VALUES ('transcription', 90.000::numeric, 0::bigint, 9000::bigint, 'USD'),
                           ('transcription', 12.500::numeric, 0::bigint, 1250::bigint, 'USD'),
                           ('speech', 0.000::numeric, 1000::bigint, 15000::bigint, 'USD'),
                           ('transcription', 30.000::numeric, 0::bigint, 3500::bigint, 'USD')$$,
                  'custo por minuto de áudio, por caractere de fala e por token');
SELECT is((SELECT purpose FROM ai_usage WHERE id = '00000000-0000-7000-8000-00000000b005'), 'vision_describe', 'finalidade vision_describe');
SELECT is(pg_temp.err(c), e, 'uso/preço: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO ai_usage (provider_id, model, purpose, audio_seconds) VALUES ('00000000-0000-7000-8000-00000000f102', 'x', 'transcription', -1)$$,
     '23514 ai_usage_audio_check'),
    ($$INSERT INTO ai_usage (provider_id, model, purpose, characters) VALUES ('00000000-0000-7000-8000-00000000f102', 'x', 'speech', -1)$$,
     '23514 ai_usage_audio_check'),
    ($$INSERT INTO ai_usage (provider_id, model, purpose) VALUES ('00000000-0000-7000-8000-00000000f102', 'x', 'audio')$$,
     '23514 ai_usage_purpose_check'),
    ($$INSERT INTO ai_model_prices (provider_id, model, input_price_per_million, output_price_per_million, audio_input_per_minute)
       VALUES ('00000000-0000-7000-8000-00000000f102', 'y', 0, 0, -0.01)$$, '23514 ai_model_prices_audio_values_check'),
    ($$INSERT INTO ai_model_prices (provider_id, model, input_price_per_million, output_price_per_million, speech_per_million_chars)
       VALUES ('00000000-0000-7000-8000-00000000f102', 'y', 0, 0, -1)$$, '23514 ai_model_prices_audio_values_check')
  ) x (c, e);
SELECT is(pg_temp.err(format($$INSERT INTO ai_requests (provider_id, operation, purpose, path) VALUES (%L, %L, %L, '/v1/x')$$,
                             '00000000-0000-7000-8000-00000000f102', o, o)), 'ok', 'requisição com a finalidade ' || o)
  FROM unnest(ARRAY['vision_describe', 'transcription', 'speech']) o;

-- O papel da aplicação -----------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$SELECT id, capabilities, default_models, prompt_cache_enabled, thinking_enabled FROM ai_providers$$,
                'app: lê as colunas novas');
SELECT throws_ok($$SELECT * FROM ai_providers$$, '42501', NULL, 'app: SELECT * continua negado');
SELECT lives_ok($$SELECT * FROM ai_embedding_pairs_in_use$$, 'app: lê os pares em uso');
SELECT lives_ok($$SELECT * FROM ai_embedding_index_stats$$, 'app: lê o progresso dos índices');
SELECT is(pg_temp.err($$INSERT INTO ai_providers (id, name, kind, api_key, default_models) VALUES
                         ('00000000-0000-7000-8000-00000000f107', 'Pelo app', 'openai', 'sk-proj-SEGREDO-7777',
                          '{"embeddings": "text-embedding-3-small", "speech_voice": "alloy"}')$$), 'ok', 'app: cria provedor com padrões');
SELECT is(pg_temp.err($$INSERT INTO ai_agent_inferences (agent_id, capability, provider_id) VALUES
                         ('00000000-0000-7000-8000-00000000a202', 'vision', '00000000-0000-7000-8000-00000000f107')$$), 'ok',
          'app: liga uma inferência');
SELECT is(pg_temp.err($$UPDATE ai_agent_inferences SET provider_id = '00000000-0000-7000-8000-00000000f107'
                         WHERE agent_id = '00000000-0000-7000-8000-00000000a202' AND capability = 'embeddings'$$), 'ok',
          'app: troca o provedor da inferência');
SELECT is((SELECT count(*)::int FROM ai_embedding_indexes_touch()), 1, 'app: touch');
SELECT is((SELECT default_model FROM ai_embedding_credentials('00000000-0000-7000-8000-00000000f107')), 'text-embedding-3-small',
          'app: credenciais de embeddings');
SELECT is((SELECT voice FROM ai_capability_credentials('00000000-0000-7000-8000-00000000a202', 'speech',
                                                        '00000000-0000-7000-8000-0000000000a2')), 'onyx', 'app: credenciais da inferência');
SELECT is(pg_temp.err($$INSERT INTO ai_attachment_derivatives (attachment_id, kind, content, status) VALUES
                         ('00000000-0000-7000-8000-00000000d002', 'pdf_text', 'outra', 'done')$$), '23505 ai_attachment_derivatives_key',
          'app: grava derivados (e esbarra no único)');
SELECT is(pg_temp.err($$UPDATE ai_providers SET capabilities = '{text,embeddings}' WHERE id = '00000000-0000-7000-8000-00000000f107'$$),
          '23514 ai_providers_capability_in_use_check', 'app: flag em uso recusada');
SELECT is(ai_embedding_indexes_purge(), 0::bigint, 'app: purga');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
