-- Testes de 0071_message_outbox_release (tarefa 109): o 429 devolve a mensagem reservada à fila sem gastar tentativa,
-- com o retry_after; uma rajada para o mesmo chat termina enviada sem nenhuma failed; no teto de adiamentos a liberação
-- volta a contar a tentativa; e as falhas comuns continuam com as 5 tentativas e o backoff.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

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
  RETURN st || ' ' || coalesce(nullif(cn, ''), '-');
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000071' || p)::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(text) TO moneyflow_app;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_column('message_outbox', 'deferrals');
SELECT col_not_null('message_outbox', 'deferrals');
SELECT col_default_is('message_outbox', 'deferrals', '0');
SELECT has_function('message_outbox_release', ARRAY['uuid', 'interval', 'text']);
SELECT ok(has_function_privilege('moneyflow_app', 'message_outbox_release(uuid, interval, text)', 'EXECUTE'), 'app executa');
SELECT ok(NOT has_function_privilege('public', 'message_outbox_release(uuid, interval, text)', 'EXECUTE'), 'PUBLIC não executa');
SELECT ok(has_column_privilege('moneyflow_app', 'message_outbox', 'deferrals', 'SELECT'), 'app lê deferrals');

INSERT INTO message_destinations (id, name, bot_token, chat_id) VALUES
  (pg_temp.u('de01'), 'Grupo da casa', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '-1001');
INSERT INTO message_outbox (id, destination_id, event_kind, dedup_key, payload, next_attempt_at) VALUES
  (pg_temp.u('f001'), pg_temp.u('de01'), 'overdue', 'u1', '{"text": "a"}', now() - interval '1 minute');

SELECT is(pg_temp.err($$SELECT message_outbox_release(pg_temp.u('f001'), interval '5 seconds')$$),
          '23514 message_outbox_transition_check', 'só libera mensagem em sending');

-- O 429 não gasta tentativa ------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT is((SELECT attempts FROM message_outbox_claim(10)), 1::smallint, 'a reserva conta a tentativa');
SELECT is(message_outbox_release(pg_temp.u('f001'), interval '7 seconds', '429 Too Many Requests: retry after 7'), 'pending',
          '429: volta a pending');
SELECT results_eq($$SELECT status, attempts, deferrals, locked_at IS NULL, last_error,
                           next_attempt_at BETWEEN clock_timestamp() + interval '6 seconds' AND clock_timestamp() + interval '8 seconds'
                      FROM message_outbox WHERE id = pg_temp.u('f001')$$,
                  $$VALUES ('pending'::text, 0::smallint, 1::smallint, true, '429 Too Many Requests: retry after 7'::text, true)$$,
                  'a tentativa da reserva é desfeita, o adiamento contado e o próximo envio no retry_after');
SELECT is_empty($$SELECT * FROM message_outbox_claim(10)$$, 'antes do retry_after não é reservada de novo');
RESET ROLE;
SELECT is(pg_temp.err($$SELECT message_outbox_release(pg_temp.u('f001'), interval '-1 second')$$), '22023 -',
          'retry_after negativo');

-- Rajada para o mesmo chat: 120 mensagens, 20 aceitas por "minuto", o resto 429 ------------------------------------------------
INSERT INTO message_outbox (destination_id, event_kind, dedup_key, payload, next_attempt_at)
SELECT pg_temp.u('de01'), 'overdue', 'r' || g, jsonb_build_object('text', 'título ' || g), now() - interval '1 hour'
  FROM generate_series(1, 120) g;
DO $do$
DECLARE
  minute int := 0;
  sent   int;
  m      message_outbox;
BEGIN
  WHILE EXISTS (SELECT 1 FROM message_outbox WHERE dedup_key LIKE 'r%' AND status = 'pending') AND minute < 200 LOOP
    minute := minute + 1;
    sent := 0;
    -- O worker reserva 50 por passada; o chat aceita 20 por minuto. Cada passada é um "minuto".
    UPDATE message_outbox SET next_attempt_at = now() - interval '1 second'
     WHERE dedup_key LIKE 'r%' AND status = 'pending';
    FOR m IN SELECT * FROM message_outbox_claim(50) LOOP
      IF sent < 20 THEN
        PERFORM message_outbox_mark_sent(m.id, 'tg-' || m.id);
        sent := sent + 1;
      ELSE
        PERFORM message_outbox_release(m.id, interval '30 seconds', '429 Too Many Requests');
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('test.minutes', minute::text, true);
END
$do$;
SELECT results_eq($$SELECT status, count(*)::int FROM message_outbox WHERE dedup_key LIKE 'r%' GROUP BY 1$$,
                  $$VALUES ('sent'::text, 120)$$, '120 mensagens para um chat limitado a 20 por minuto: todas enviadas, nenhuma failed');
SELECT is(current_setting('test.minutes')::int, 6, 'em 6 passadas');
SELECT is((SELECT max(attempts) FROM message_outbox WHERE dedup_key LIKE 'r%'), 1::smallint,
          'cada uma gastou só a tentativa do envio que deu certo');

-- O teto de adiamentos --------------------------------------------------------------------------------------------------------
INSERT INTO message_outbox (id, destination_id, event_kind, dedup_key, payload, max_attempts) VALUES
  (pg_temp.u('f002'), pg_temp.u('de01'), 'overdue', 'teto', '{"text": "t"}', 2);
UPDATE message_outbox SET deferrals = 100 WHERE id = pg_temp.u('f002');
SELECT is((SELECT count(*)::int FROM message_outbox_claim_one(pg_temp.u('f002'))), 1, 'reserva (tentativa 1)');
SELECT is(message_outbox_release(pg_temp.u('f002'), interval '1 second'), 'pending', 'no teto, a liberação conta a tentativa');
SELECT results_eq($$SELECT attempts, deferrals, last_error FROM message_outbox WHERE id = pg_temp.u('f002')$$,
                  $$VALUES (1::smallint, 100::smallint, 'rate limited: deferred 100 times'::text)$$,
                  'a tentativa fica contada e o adiamento não passa do teto');
UPDATE message_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = pg_temp.u('f002');
SELECT is((SELECT count(*)::int FROM message_outbox_claim_one(pg_temp.u('f002'))), 1, 'reserva (tentativa 2, a última)');
SELECT is(message_outbox_release(pg_temp.u('f002'), interval '1 second', '429'), 'failed',
          'no teto e sem tentativas: failed');
SELECT is(pg_temp.err($$UPDATE message_outbox SET deferrals = 101 WHERE id = '00000000-0000-7000-8000-00000071f002'$$),
          '23514 message_outbox_deferrals_check', 'deferrals vai de 0 a 100');

-- Falha comum continua contando a tentativa, com o backoff ------------------------------------------------------------------
INSERT INTO message_outbox (id, destination_id, event_kind, dedup_key, payload) VALUES
  (pg_temp.u('f003'), pg_temp.u('de01'), 'overdue', 'comum', '{"text": "c"}');
SELECT is((SELECT count(*)::int FROM message_outbox_claim_one(pg_temp.u('f003'))), 1, 'reserva');
SELECT is(message_outbox_mark_failed(pg_temp.u('f003'), 'timeout'), 'pending', 'falha comum volta a pending');
SELECT results_eq($$SELECT attempts, deferrals,
                           next_attempt_at BETWEEN clock_timestamp() + interval '25 seconds' AND clock_timestamp() + interval '31 seconds'
                      FROM message_outbox WHERE id = pg_temp.u('f003')$$,
                  $$VALUES (1::smallint, 0::smallint, true)$$, 'a tentativa fica contada, com o backoff de 30 s');

SELECT * FROM finish();
ROLLBACK;
