-- Testes de 0068_ai_run_event_notice_type (tarefa 164): o aviso de ai_run_events traz o tipo do evento (e o status nos
-- eventos status e done), montado por ai_run_event_notice, que o ai_run_event_append usa. O pgTAP roda numa transação e
-- não recebe o NOTIFY: confere o JSON montado e o uso dele pela função.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000068' || p)::uuid $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('ai_run_event_notice', ARRAY['uuid', 'integer', 'text', 'jsonb']);
SELECT is((SELECT provolatile::text FROM pg_proc WHERE proname = 'ai_run_event_notice'), 'i', 'IMMUTABLE');
SELECT ok(NOT has_function_privilege('public', 'ai_run_event_notice(uuid, integer, text, jsonb)', 'EXECUTE'), 'PUBLIC não executa');
SELECT ok((SELECT prosrc FROM pg_proc WHERE oid = 'ai_run_event_append(uuid, text, jsonb)'::regprocedure)
            ~ 'pg_notify\(''ai_run_events'', ai_run_event_notice\(p_run_id, s, p_event_type, p_payload\)\)',
          'ai_run_event_append avisa com ai_run_event_notice');

-- O JSON do aviso ---------------------------------------------------------------------------------------------------------
SELECT is(ai_run_event_notice(pg_temp.u('b001'), 7, 'text_delta', '{"text": "Vou ver"}')::jsonb,
          jsonb_build_object('run_id', pg_temp.u('b001'), 'seq', 7, 'type', 'text_delta'),
          'delta: run_id, seq e o tipo, sem o texto');
SELECT is(ai_run_event_notice(pg_temp.u('b001'), 8, 'thinking_delta', '{"text": "hmm", "status": "x"}')::jsonb,
          jsonb_build_object('run_id', pg_temp.u('b001'), 'seq', 8, 'type', 'thinking_delta'),
          'o status só vai nos eventos status e done');
SELECT is(ai_run_event_notice(pg_temp.u('b001'), 9, 'status', '{"status": "awaiting_confirmation"}')::jsonb,
          jsonb_build_object('run_id', pg_temp.u('b001'), 'seq', 9, 'type', 'status', 'status', 'awaiting_confirmation'),
          'status: com o status');
SELECT is(ai_run_event_notice(pg_temp.u('b001'), 10, 'done', '{"status": "failed", "error": "provedor caiu com dados"}')::jsonb,
          jsonb_build_object('run_id', pg_temp.u('b001'), 'seq', 10, 'type', 'done', 'status', 'failed'),
          'done: com o status e sem o erro (ele continua só na tabela)');
SELECT is(ai_run_event_notice(pg_temp.u('b001'), 11, 'done', '{}')::jsonb,
          jsonb_build_object('run_id', pg_temp.u('b001'), 'seq', 11, 'type', 'done'), 'done sem status: sem a chave');
SELECT is(ai_run_event_notice(pg_temp.u('b001'), 12, 'status', NULL)::jsonb,
          jsonb_build_object('run_id', pg_temp.u('b001'), 'seq', 12, 'type', 'status'), 'payload nulo');
SELECT is(length(ai_run_event_notice(pg_temp.u('b001'), 13, 'done', jsonb_build_object('status', repeat('s', 5000)))::jsonb ->> 'status'),
          40, 'o status vai cortado em 40 caracteres');
SELECT ok(length(ai_run_event_notice(pg_temp.u('b001'), 2147483647, repeat('t', 64), jsonb_build_object('status', repeat('s', 5000))))
          < 8000, 'o aviso fica abaixo do limite de 8000 bytes do NOTIFY');

-- O append continua igual -------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES (pg_temp.u('0a01'), 'bia68', 'bia68@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key) VALUES (pg_temp.u('1001'), 'Claude68', 'anthropic', 'sk-ant-api03-SEGREDO68');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES (pg_temp.u('3001'), 'Assistente68', pg_temp.u('1001'), 'claude-sonnet-4-5');
INSERT INTO ai_conversations (id, user_id, agent_id) VALUES (pg_temp.u('c001'), pg_temp.u('0a01'), pg_temp.u('3001'));
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES (pg_temp.u('b001'), pg_temp.u('c001'), pg_temp.u('0a01'), pg_temp.u('3001'));
SELECT is(ai_run_event_append(pg_temp.u('b001'), 'status', '{"status": "running"}'), 1, 'primeiro evento');
SELECT is(ai_run_event_append(pg_temp.u('b001'), 'text_delta', '{"text": "Vou"}'), 2, 'segundo evento');
SELECT is(ai_run_event_append(pg_temp.u('b001'), 'done', NULL), 3, 'payload nulo grava {}');
SELECT results_eq($$SELECT seq, event_type, payload FROM ai_run_events WHERE run_id = pg_temp.u('b001') ORDER BY seq$$,
                  $$VALUES (1, 'status'::text, '{"status": "running"}'::jsonb), (2, 'text_delta', '{"text": "Vou"}'),
                           (3, 'done', '{}')$$, 'os eventos gravados não mudam');
SELECT throws_ok($$SELECT ai_run_event_append(pg_temp.u('b001'), 'Bad Type', '{}')$$, '23514', NULL, 'tipo validado antes do aviso');
SELECT throws_ok($$SELECT ai_run_event_append(pg_temp.u('bfff'), 'status', '{}')$$, 'P0002', NULL, 'execução inexistente');

SELECT * FROM finish();
ROLLBACK;
