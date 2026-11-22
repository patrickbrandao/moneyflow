-- Testes de 0067_ai_requests_close_stale (tarefa 162): a manutenção fecha como error as requisições running mais velhas
-- que o prazo, em lotes, sem tocar nas recentes nem nas terminadas; a saúde do provedor passa a contá-las.
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
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000067' || p)::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(text) TO moneyflow_app;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('ai_requests_close_stale', ARRAY['interval', 'integer']);
SELECT ok(has_function_privilege('moneyflow_app', 'ai_requests_close_stale(interval, integer)', 'EXECUTE'), 'app executa');
SELECT ok(NOT has_function_privilege('public', 'ai_requests_close_stale(interval, integer)', 'EXECUTE'), 'PUBLIC não executa');
SELECT is((SELECT prosecdef FROM pg_proc WHERE proname = 'ai_requests_close_stale'), false, 'SECURITY INVOKER');
SELECT has_index('ai_requests', 'ai_requests_running_idx', ARRAY['started_at']);
SELECT is((SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = 'ai_requests_running_idx'::regclass),
          '(status = ''running''::text)', 'índice só das em andamento');

SELECT is(pg_temp.err($$SELECT ai_requests_close_stale(interval '5 minutes')$$), '22023', 'prazo abaixo de 10 minutos');
SELECT is(pg_temp.err($$SELECT ai_requests_close_stale(NULL)$$), '22023', 'prazo nulo');
SELECT is(pg_temp.err($$SELECT ai_requests_close_stale(interval '1 hour', 0)$$), '22023', 'limite < 1');
SELECT is(pg_temp.err($$SELECT ai_requests_close_stale(interval '1 hour', 100001)$$), '22023', 'limite acima de 100000');

-- Dados ----------------------------------------------------------------------------------------------------------------------
INSERT INTO ai_providers (id, name, kind, api_key) VALUES (pg_temp.u('f101'), 'Claude67', 'anthropic', 'sk-ant-api03-SEGREDO67');
INSERT INTO ai_requests (id, provider_id, operation, purpose, model, path, streaming, started_at) VALUES
  (pg_temp.u('e001'), pg_temp.u('f101'), 'chat', 'chat', 'claude-sonnet-4-5', '/v1/messages', true, clock_timestamp() - interval '3 hours'),
  (pg_temp.u('e002'), pg_temp.u('f101'), 'chat', 'chat', 'claude-sonnet-4-5', '/v1/messages', true, clock_timestamp() - interval '2 hours'),
  (pg_temp.u('e003'), pg_temp.u('f101'), 'title', 'title', 'claude-haiku-4-5', '/v1/messages', false, clock_timestamp() - interval '90 minutes'),
  (pg_temp.u('e004'), pg_temp.u('f101'), 'chat', 'chat', 'claude-sonnet-4-5', '/v1/messages', true, clock_timestamp() - interval '20 minutes');
INSERT INTO ai_requests (id, provider_id, operation, purpose, model, path, status, started_at, finished_at) VALUES
  (pg_temp.u('e005'), pg_temp.u('f101'), 'chat', 'chat', 'claude-sonnet-4-5', '/v1/messages', 'ok',
   clock_timestamp() - interval '4 hours', clock_timestamp() - interval '4 hours' + interval '3 seconds');
SELECT set_config('test.e005', (SELECT to_jsonb(r)::text FROM ai_requests r WHERE id = pg_temp.u('e005')), true);
SELECT is((SELECT errors FROM ai_provider_health(7, pg_temp.u('f101')) WHERE model = 'claude-sonnet-4-5'), 0,
          'antes: as presas em running não contam na saúde');

-- Fechamento em lotes, como a aplicação -------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT is(ai_requests_close_stale(interval '1 hour', 1), 1, 'em lotes: fecha até o limite, a mais velha primeiro');
SELECT is((SELECT status FROM ai_requests WHERE id = pg_temp.u('e001')), 'error', 'a mais velha saiu primeiro');
SELECT is(ai_requests_close_stale(), 2, 'o resto das que passaram do prazo padrão (1 hora)');
SELECT is(ai_requests_close_stale(), 0, 'nada mais a fechar');
RESET ROLE;

SELECT results_eq($$SELECT id, status, finished_at IS NOT NULL, error_message, duration_ms >= 90 * 60 * 1000
                      FROM ai_requests WHERE id IN (pg_temp.u('e001'), pg_temp.u('e002'), pg_temp.u('e003')) ORDER BY id$$,
                  $$SELECT x, 'error'::text, true, 'interrupted: the process stopped before the request finished'::text, true
                      FROM unnest(ARRAY[pg_temp.u('e001'), pg_temp.u('e002'), pg_temp.u('e003')]) x ORDER BY x$$,
                  'as velhas viram error, com o motivo e finished_at');
SELECT results_eq($$SELECT status, finished_at FROM ai_requests WHERE id = pg_temp.u('e004')$$,
                  $$VALUES ('running'::text, NULL::timestamptz)$$, 'a recente, dentro do prazo, não é tocada');
SELECT is((SELECT to_jsonb(r)::text FROM ai_requests r WHERE id = pg_temp.u('e005')), current_setting('test.e005'),
          'a terminada não muda');
SELECT results_eq($$SELECT model, errors FROM ai_provider_health(7, pg_temp.u('f101')) ORDER BY model$$,
                  $$VALUES ('claude-haiku-4-5'::text, 1), ('claude-sonnet-4-5'::text, 2)$$,
                  'depois: a saúde do provedor conta as interrompidas como erro');

-- Fechada, a requisição continua imutável; o fim tardio da chamada não a reabre.
SELECT is(pg_temp.err($$UPDATE ai_requests SET status = 'ok', error_message = NULL WHERE id = '$$ || pg_temp.u('e001') || $$'$$),
          '23514', 'fechada pela manutenção, não volta');
SELECT is((SELECT count(*)::int FROM ai_requests WHERE id = pg_temp.u('e001') AND status = 'running'), 0,
          'o UPDATE do fim da chamada (WHERE status = running) não acha a linha');

-- Prazo menor (o mínimo é 10 minutos) alcança a de 20 minutos.
SELECT is(ai_requests_close_stale(interval '15 minutes'), 1, 'prazo de 15 minutos fecha a de 20');

SELECT * FROM finish();
ROLLBACK;
