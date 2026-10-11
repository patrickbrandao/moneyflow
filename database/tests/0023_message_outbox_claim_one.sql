-- Testes de 0023_message_outbox_claim_one: reserva de uma mensagem só ("enviar teste").
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

SELECT has_function('message_outbox_claim_one', ARRAY['uuid']);
SELECT ok(has_function_privilege('moneyflow_app', 'message_outbox_claim_one(uuid)', 'EXECUTE'), 'app executa');
SELECT ok(NOT has_function_privilege('public', 'message_outbox_claim_one(uuid)', 'EXECUTE'), 'PUBLIC não executa');

INSERT INTO message_destinations (id, name, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000de001', 'Teste', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '1');
INSERT INTO message_outbox (id, destination_id, event_kind, payload, next_attempt_at, max_attempts) VALUES
  ('00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-0000000de001', 'test', '{"text": "a"}', now() + interval '1 hour', 5),
  ('00000000-0000-7000-8000-00000000f002', '00000000-0000-7000-8000-0000000de001', 'test', '{"text": "b"}', now(), 5),
  ('00000000-0000-7000-8000-00000000f003', '00000000-0000-7000-8000-0000000de001', 'test', '{"text": "c"}', now(), 1);

SET LOCAL ROLE moneyflow_app;
SELECT results_eq($$SELECT id, status, attempts, locked_at IS NOT NULL FROM message_outbox_claim_one('00000000-0000-7000-8000-00000000f001')$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f001'::uuid, 'sending', 1::smallint, true)$$,
                  'reserva a mensagem pedida (mesmo agendada para depois)');
SELECT is((SELECT status FROM message_outbox WHERE id = '00000000-0000-7000-8000-00000000f002'), 'pending', 'as outras ficam');
SELECT is_empty($$SELECT * FROM message_outbox_claim_one('00000000-0000-7000-8000-00000000f001')$$, 'já reservada: nada');
SELECT is_empty($$SELECT * FROM message_outbox_claim_one('00000000-0000-7000-8000-0000000fffff')$$, 'inexistente: nada');
SELECT is(message_destination_token('00000000-0000-7000-8000-00000000f001'), '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
          'reservada: o worker lê o token');
SELECT lives_ok($$SELECT message_outbox_mark_sent('00000000-0000-7000-8000-00000000f001', '1')$$, 'e fecha como enviada');
SELECT is_empty($$SELECT * FROM message_outbox_claim_one('00000000-0000-7000-8000-00000000f001')$$, 'enviada: nada');
RESET ROLE;

-- Sem tentativas restantes não é reservada.
SELECT is((SELECT count(*)::int FROM message_outbox_claim_one('00000000-0000-7000-8000-00000000f003')), 1, 'última tentativa');
SELECT is(message_outbox_mark_failed('00000000-0000-7000-8000-00000000f003', 'timeout'), 'failed', 'esgotou');
UPDATE message_outbox SET status = 'pending' WHERE id = '00000000-0000-7000-8000-00000000f003';
SELECT is_empty($$SELECT * FROM message_outbox_claim_one('00000000-0000-7000-8000-00000000f003')$$,
                'pendente sem tentativas restantes: nada');

SELECT * FROM finish();
ROLLBACK;
