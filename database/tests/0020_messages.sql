-- Testes de 0020_messages: destinos (token blindado), assinaturas, outbox e auditoria sem o token.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['message_destinations', 'message_subscriptions', 'message_subscription_caixas',
                                      'message_outbox']) t;
SELECT has_function('message_destination_token', ARRAY['uuid']);
SELECT has_function('message_outbox_claim', ARRAY['integer', 'interval']);
SELECT has_function('message_outbox_mark_sent', ARRAY['uuid', 'text']);
SELECT has_function('message_outbox_mark_failed', ARRAY['uuid', 'text', 'interval', 'boolean']);
SELECT has_function('message_subscription_params_valid', ARRAY['text', 'jsonb']);
SELECT fk_ok('message_subscriptions', 'destination_id', 'message_destinations', 'id');
SELECT fk_ok('message_outbox', 'destination_id', 'message_destinations', 'id');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'message_destination_token(uuid)'::regprocedure), true,
          'message_destination_token é SECURITY DEFINER');

-- Dados base
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin');
INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001', true);

-- Destinos ----------------------------------------------------------------------------------------------------
INSERT INTO message_destinations (id, name, owner_user_id, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000de001', 'Meu Telegram', '00000000-0000-7000-8000-0000000000a1',
   '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '987654321');
INSERT INTO message_destinations (id, name, owner_caixa_id, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000de002', 'Grupo da casa', '00000000-0000-7000-8000-0000000c0001',
   '555000111:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '-1001234567890');
INSERT INTO message_destinations (id, name, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000de003', 'Canal global', '555000111:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '@moneyflow_alertas');

SELECT is((SELECT bot_id FROM message_destinations WHERE id = '00000000-0000-7000-8000-0000000de001'), '123456789',
          'bot_id é a parte pública do token');
SELECT throws_ok($$INSERT INTO message_destinations (name, bot_token, chat_id) VALUES ('Sem token', NULL, '1')$$,
                 '23514', NULL, 'telegram exige token');
SELECT throws_ok($$INSERT INTO message_destinations (name, bot_token, chat_id) VALUES ('Sem chat', '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', NULL)$$,
                 '23514', NULL, 'telegram exige chat_id');
SELECT throws_ok($$INSERT INTO message_destinations (name, bot_token, chat_id) VALUES ('Token ruim', 'abc', '1')$$,
                 '23514', NULL, 'formato do token');
SELECT throws_ok($$INSERT INTO message_destinations (name, bot_token, chat_id) VALUES ('Chat ruim', '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'abc')$$,
                 '23514', NULL, 'formato do chat_id');
SELECT throws_ok($$INSERT INTO message_destinations (name, channel, bot_token, chat_id) VALUES ('Email', 'email', NULL, NULL)$$,
                 '23514', NULL, 'só o canal telegram por ora');
SELECT throws_ok($$INSERT INTO message_destinations (name, owner_user_id, owner_caixa_id, bot_token, chat_id)
                   VALUES ('Dois donos', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000c0001',
                           '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '1')$$,
                 '23514', NULL, 'no máximo um dono');
SELECT throws_ok($$INSERT INTO message_destinations (name, owner_user_id, bot_token, chat_id)
                   VALUES ('MEU TELEGRAM', '00000000-0000-7000-8000-0000000000a1', '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '1')$$,
                 '23505', NULL, 'nome único por dono');
SELECT lives_ok($$INSERT INTO message_destinations (name, bot_token, chat_id) VALUES ('Meu Telegram', '123:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '1')$$,
                'mesmo nome com outro dono');
SELECT throws_ok($$UPDATE message_destinations SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000de003'$$,
                 '23514', NULL, 'arquivado não fica ativo');

-- Blindagem do token
SELECT ok(NOT has_column_privilege('moneyflow_app', 'message_destinations', 'bot_token', 'SELECT'), 'app não lê bot_token');
SELECT ok(has_column_privilege('moneyflow_app', 'message_destinations', 'bot_token', 'INSERT'), 'app grava bot_token');
SELECT ok(has_column_privilege('moneyflow_app', 'message_destinations', 'bot_token', 'UPDATE'), 'app troca bot_token');
SELECT ok(has_column_privilege('moneyflow_app', 'message_destinations', c, 'SELECT'), 'app lê ' || c)
  FROM unnest(ARRAY['id', 'channel', 'name', 'owner_user_id', 'owner_caixa_id', 'bot_id', 'chat_id', 'is_active',
                    'created_by_user_id', 'notes', 'archived_at', 'created_at', 'updated_at']) c;
SELECT is_empty($$
  SELECT a.attname FROM pg_attribute a
   WHERE a.attrelid = 'message_destinations'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'bot_token'
     AND NOT has_column_privilege('moneyflow_app', 'message_destinations', a.attname, 'SELECT')
$$, 'app lê todas as colunas menos o token');

-- Assinaturas ----------------------------------------------------------------------------------------------------
SELECT ok(message_subscription_params_valid(k, p::jsonb), 'parâmetros válidos: ' || k || ' ' || p)
  FROM (VALUES ('due_reminder', '{"days_before": [3, 1, 0], "send_at": "08:00"}'),
               ('overdue', '{"send_at": "08:00"}'),
               ('overdue', '{"send_at": "23:59", "repeat_every_days": 7}'),
               ('daily_summary', '{"send_at": "07:30"}'),
               ('weekly_summary', '{"send_at": "07:30", "weekday": 1}'),
               ('invoice_closed', '{}'),
               ('card_limit', '{"thresholds_percent": [80, 100]}'),
               ('reconciliation_divergence', '{}'),
               ('reconciliation_divergence', '{"min_difference_cents": 100}'),
               ('agent_completed', '{}'),
               ('agent_message', '{}')) v (k, p);
SELECT ok(NOT message_subscription_params_valid(k, p::jsonb), 'parâmetros inválidos: ' || k || ' ' || p)
  FROM (VALUES ('due_reminder', '{"days_before": [3], "send_at": "8:00"}'),
               ('due_reminder', '{"days_before": [], "send_at": "08:00"}'),
               ('due_reminder', '{"days_before": [61], "send_at": "08:00"}'),
               ('due_reminder', '{"days_before": [1, 1], "send_at": "08:00"}'),
               ('due_reminder', '{"days_before": ["3"], "send_at": "08:00"}'),
               ('due_reminder', '{"days_before": [-1], "send_at": "08:00"}'),
               ('due_reminder', '{"send_at": "08:00"}'),
               ('overdue', '{"send_at": "24:00"}'),
               ('overdue', '{"send_at": "08:00", "repeat_every_days": 0}'),
               ('weekly_summary', '{"send_at": "07:30", "weekday": 8}'),
               ('weekly_summary', '{"send_at": "07:30"}'),
               ('card_limit', '{"thresholds_percent": [0]}'),
               ('card_limit', '{}'),
               ('invoice_closed', '{"extra": 1}'),
               ('reconciliation_divergence', '{"min_difference_cents": -1}'),
               ('unknown_event', '{}'),
               ('daily_summary', '[]')) v (k, p);

INSERT INTO message_subscriptions (id, destination_id, event_kind, params) VALUES
  ('00000000-0000-7000-8000-0000000d5001', '00000000-0000-7000-8000-0000000de001', 'due_reminder',
   '{"days_before": [3, 0], "send_at": "08:00"}'),
  ('00000000-0000-7000-8000-0000000d5002', '00000000-0000-7000-8000-0000000de001', 'agent_completed', '{}');
INSERT INTO message_subscription_caixas (subscription_id, caixa_id) VALUES
  ('00000000-0000-7000-8000-0000000d5001', '00000000-0000-7000-8000-0000000c0001');
SELECT throws_ok($$INSERT INTO message_subscriptions (destination_id, event_kind, params)
                   VALUES ('00000000-0000-7000-8000-0000000de002', 'card_limit', '{"thresholds_percent": 80}')$$,
                 '23514', NULL, 'assinatura com parâmetros inválidos');
SELECT throws_ok($$INSERT INTO message_subscriptions (destination_id, event_kind) VALUES ('00000000-0000-7000-8000-0000000de001', 'agent_completed')$$,
                 '23505', NULL, 'uma assinatura por evento e destino');
SELECT throws_ok($$INSERT INTO message_subscription_caixas (subscription_id, caixa_id)
                   VALUES ('00000000-0000-7000-8000-0000000d5001', '00000000-0000-7000-8000-0000000c0001')$$,
                 '23505', NULL, 'caixa repetida no filtro');

-- Outbox ------------------------------------------------------------------------------------------------------------
INSERT INTO message_outbox (id, destination_id, subscription_id, event_kind, dedup_key, payload) VALUES
  ('00000000-0000-7000-8000-00000000f001', '00000000-0000-7000-8000-0000000de001', '00000000-0000-7000-8000-0000000d5001',
   'due_reminder', 'due_reminder:b001:D-3:2026-10-12', '{"text": "Energia vence em 3 dias"}'),
  ('00000000-0000-7000-8000-00000000f002', '00000000-0000-7000-8000-0000000de001', NULL, 'test', NULL, '{"text": "teste"}');
WITH x AS (
  INSERT INTO message_outbox (destination_id, event_kind, dedup_key, payload)
  VALUES ('00000000-0000-7000-8000-0000000de001', 'due_reminder', 'due_reminder:b001:D-3:2026-10-12', '{"text": "de novo"}')
  ON CONFLICT (destination_id, dedup_key) DO NOTHING RETURNING 1)
SELECT is((SELECT count(*)::int FROM x), 0, 'a mesma chave de evento não é enfileirada duas vezes');
SELECT lives_ok($$INSERT INTO message_outbox (destination_id, event_kind, dedup_key, payload)
                  VALUES ('00000000-0000-7000-8000-0000000de002', 'due_reminder', 'due_reminder:b001:D-3:2026-10-12', '{"text": "x"}')$$,
                'a mesma chave em outro destino');
SELECT throws_ok($$INSERT INTO message_outbox (destination_id, event_kind, payload, status, locked_at)
                   VALUES ('00000000-0000-7000-8000-0000000de001', 'test', '{}', 'sending', now())$$,
                 '23514', NULL, 'mensagem nasce pendente');
SELECT throws_ok($$INSERT INTO message_outbox (destination_id, event_kind, payload) VALUES ('00000000-0000-7000-8000-0000000de001', 'boom', '{}')$$,
                 '23514', NULL, 'evento desconhecido');
SELECT throws_ok($$INSERT INTO message_outbox (destination_id, event_kind, payload) VALUES ('00000000-0000-7000-8000-0000000de001', 'test', '"x"')$$,
                 '23514', NULL, 'payload é objeto');

-- Token só de mensagem reservada
SELECT throws_ok($$SELECT message_destination_token('00000000-0000-7000-8000-00000000f001')$$, '42501', NULL,
                 'token: mensagem pendente não lê');
SELECT throws_ok($$SELECT message_destination_token('00000000-0000-7000-8000-0000000fffff')$$, 'P0002', NULL,
                 'token: mensagem inexistente');

-- Claim
UPDATE message_outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = '00000000-0000-7000-8000-00000000f002';
SELECT results_eq($$SELECT id, status, attempts, locked_at IS NOT NULL FROM message_outbox_claim(10) ORDER BY id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f001'::uuid, 'sending', 1::smallint, true),
                           ((SELECT id FROM message_outbox WHERE destination_id = '00000000-0000-7000-8000-0000000de002'), 'sending', 1::smallint, true)$$,
                  'claim reserva as prontas (não as agendadas para depois)');
SELECT is((SELECT count(*)::int FROM message_outbox_claim(10)), 0, 'reservadas não são reservadas de novo');
SELECT is(message_destination_token('00000000-0000-7000-8000-00000000f001'), '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
          'token: mensagem reservada lê o token do destino');
SELECT throws_ok($$SELECT * FROM message_outbox_claim(0)$$, '22023', NULL, 'claim: limite inválido');

-- Falha com retry e envio
SELECT is(message_outbox_mark_failed('00000000-0000-7000-8000-00000000f001', '429 Too Many Requests', interval '30 seconds'),
          'pending', 'falha temporária volta para pending');
SELECT results_eq($$SELECT status, attempts, locked_at IS NULL, last_error, next_attempt_at > now() FROM message_outbox
                     WHERE id = '00000000-0000-7000-8000-00000000f001'$$,
                  $$VALUES ('pending', 1::smallint, true, '429 Too Many Requests', true)$$, 'retry agendado com o erro');
UPDATE message_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = '00000000-0000-7000-8000-00000000f001';
SELECT is((SELECT attempts FROM message_outbox_claim(1)), 2::smallint, 'nova tentativa soma 1');
SELECT lives_ok($$SELECT message_outbox_mark_sent('00000000-0000-7000-8000-00000000f001', '4242')$$, 'enviada');
SELECT results_eq($$SELECT status, sent_at IS NOT NULL, locked_at IS NULL, provider_message_id FROM message_outbox
                     WHERE id = '00000000-0000-7000-8000-00000000f001'$$,
                  $$VALUES ('sent', true, true, '4242')$$, 'enviada guarda o id do provedor');
SELECT throws_ok($$SELECT message_outbox_mark_sent('00000000-0000-7000-8000-00000000f001')$$, '23514', NULL, 'enviada não fecha de novo');
SELECT throws_ok($$SELECT message_destination_token('00000000-0000-7000-8000-00000000f001')$$, '42501', NULL, 'token: enviada não lê');
SELECT throws_ok($$UPDATE message_outbox SET payload = '{"text": "outro"}' WHERE id = '00000000-0000-7000-8000-00000000f001'$$,
                 '23514', NULL, 'payload imutável');
SELECT throws_ok($$UPDATE message_outbox SET status = 'pending', sent_at = NULL WHERE id = '00000000-0000-7000-8000-00000000f001'$$,
                 '23514', NULL, 'enviada é final');
SELECT throws_ok($$UPDATE message_outbox SET last_error = 'x' WHERE id = '00000000-0000-7000-8000-00000000f001'$$,
                 '23514', NULL, 'enviada não muda');
SELECT throws_ok($$UPDATE message_outbox SET status = 'sent', sent_at = now() WHERE id = '00000000-0000-7000-8000-00000000f002'$$,
                 '23514', NULL, 'pendente não vai direto para enviada');

-- Falha permanente, esgotar tentativas, reserva abandonada e reenvio manual
SELECT is(message_outbox_mark_failed(id, 'chat not found', NULL, true), 'failed', 'falha permanente')
  FROM message_outbox WHERE destination_id = '00000000-0000-7000-8000-0000000de002';
INSERT INTO message_outbox (id, destination_id, event_kind, payload, max_attempts) VALUES
  ('00000000-0000-7000-8000-00000000f003', '00000000-0000-7000-8000-0000000de001', 'test', '{"text": "uma vez"}', 1),
  ('00000000-0000-7000-8000-00000000f004', '00000000-0000-7000-8000-0000000de001', 'test', '{"text": "abandonada"}', 3);
SELECT is((SELECT count(*)::int FROM message_outbox_claim(10)), 2, 'claim das novas');
SELECT is(message_outbox_mark_failed('00000000-0000-7000-8000-00000000f003', 'timeout'), 'failed', 'esgotou as tentativas');
SELECT throws_ok($$SELECT message_outbox_mark_failed('00000000-0000-7000-8000-00000000f003', 'de novo')$$, '23514', NULL,
                 'falha só de mensagem em envio');
UPDATE message_outbox SET locked_at = now() - interval '1 hour' WHERE id = '00000000-0000-7000-8000-00000000f004';
SELECT results_eq($$SELECT id, attempts FROM message_outbox_claim(10, interval '5 minutes')$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f004'::uuid, 2::smallint)$$, 'reserva abandonada é retomada');
UPDATE message_outbox SET locked_at = now() - interval '1 hour', attempts = 3 WHERE id = '00000000-0000-7000-8000-00000000f004';
SELECT is((SELECT count(*)::int FROM message_outbox_claim(10)), 0, 'reserva abandonada sem tentativas não é retomada');
SELECT results_eq($$SELECT status, last_error LIKE '%stale_lock%' FROM message_outbox WHERE id = '00000000-0000-7000-8000-00000000f004'$$,
                  $$VALUES ('failed', true)$$, 'e vira failed');
SELECT lives_ok($$UPDATE message_outbox SET status = 'pending', attempts = 0, next_attempt_at = now()
                   WHERE id = '00000000-0000-7000-8000-00000000f003'$$, 'reenvio manual: failed → pending');

-- Destino desativado cancela as pendentes e não recebe novas
UPDATE message_destinations SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000de001';
SELECT results_eq($$SELECT id, status, last_error FROM message_outbox
                     WHERE destination_id = '00000000-0000-7000-8000-0000000de001' AND status <> 'sent' ORDER BY id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000f002'::uuid, 'canceled', 'destination_inactive'),
                           ('00000000-0000-7000-8000-00000000f003', 'canceled', 'destination_inactive'),
                           ('00000000-0000-7000-8000-00000000f004', 'canceled', 'destination_inactive')$$,
                  'desativar cancela pendentes e falhas');
SELECT throws_ok($$INSERT INTO message_outbox (destination_id, event_kind, payload) VALUES ('00000000-0000-7000-8000-0000000de001', 'test', '{}')$$,
                 '23514', NULL, 'destino inativo não recebe mensagem');
SELECT throws_ok($$DELETE FROM message_destinations WHERE id = '00000000-0000-7000-8000-0000000de001'$$, '23503', NULL,
                 'destino com histórico não é excluído (arquive)');

-- Auditoria sem o token -----------------------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'message_destinations'), 'destinos são auditados');
SELECT is_empty($$SELECT 1 FROM audit_log WHERE table_name = 'message_destinations'
                    AND (old_data ? 'bot_token' OR new_data ? 'bot_token'
                         OR coalesce(old_data::text, '') LIKE '%AAHdqTcv%' OR coalesce(new_data::text, '') LIKE '%AAHdqTcv%')$$,
                'o token nunca vai para o audit_log');
UPDATE message_destinations SET bot_token = '123456789:ZZZdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
 WHERE id = '00000000-0000-7000-8000-0000000de002';
SELECT results_eq($$SELECT changed_columns, old_data ? 'bot_token', new_data ? 'bot_token' FROM audit_log
                     WHERE table_name = 'message_destinations' AND record_id = '00000000-0000-7000-8000-0000000de002'
                       AND action = 'update'$$,
                  $$VALUES (ARRAY['bot_id', 'bot_token'], false, false)$$, 'troca de token registrada sem o valor');
SELECT ok(NOT EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'users' AND (new_data ? 'password' OR old_data ? 'password')),
          'a senha continua fora do log');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'message_outbox'), 0, 'outbox fica fora da auditoria');
SELECT ok(EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'message_subscriptions'), 'assinaturas são auditadas');

-- Privilégios e o papel da aplicação --------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['message_destination_token(uuid)', 'message_outbox_claim(integer, interval)',
                    'message_outbox_mark_sent(uuid, text)', 'message_outbox_mark_failed(uuid, text, interval, boolean)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['message_destination_token(uuid)', 'message_outbox_claim(integer, interval)',
                    'message_outbox_mark_sent(uuid, text)', 'message_outbox_mark_failed(uuid, text, interval, boolean)',
                    'message_subscription_params_valid(text, jsonb)']) f;

INSERT INTO message_outbox (id, destination_id, event_kind, payload) VALUES
  ('00000000-0000-7000-8000-00000000f005', '00000000-0000-7000-8000-0000000de003', 'test', '{"text": "pelo app"}');
SET LOCAL ROLE moneyflow_app;
SELECT throws_ok($$SELECT bot_token FROM message_destinations$$, '42501', NULL, 'app: SELECT do token negado');
SELECT throws_ok($$SELECT * FROM message_destinations$$, '42501', NULL, 'app: SELECT * negado (liste as colunas)');
SELECT lives_ok($$SELECT id, name, bot_id, chat_id FROM message_destinations$$, 'app: colunas públicas');
SELECT lives_ok($$UPDATE message_destinations SET bot_token = '777:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', name = 'Canal'
                   WHERE id = '00000000-0000-7000-8000-0000000de003'$$, 'app: troca o token');
SELECT is((SELECT count(*)::int FROM message_outbox_claim(5)), 1, 'app: claim');
SELECT is(message_destination_token('00000000-0000-7000-8000-00000000f005'), '777:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
          'app: worker lê o token da mensagem reservada');
SELECT lives_ok($$SELECT message_outbox_mark_sent('00000000-0000-7000-8000-00000000f005', '1')$$, 'app: marca enviada');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
