-- Testes de 0070_operational_purge (tarefa 103): cada purga apaga só o que passou do prazo e do estado certo, respeita
-- o limite e devolve a contagem; anexo ligado (por qualquer vínculo de attachment_links) nunca sai; e os índices da
-- lista de destinos.
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
CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000070' || p)::uuid $$;
GRANT EXECUTE ON FUNCTION pg_temp.u(text) TO moneyflow_app;
CREATE FUNCTION pg_temp.ago(p interval) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT now() - p $$;

-- Estrutura ---------------------------------------------------------------------------------------------------------------
SELECT has_function('operational_purge', ARRAY['integer']);
SELECT ok(has_function_privilege('moneyflow_app', 'operational_purge(integer)', 'EXECUTE'), 'app executa');
SELECT ok(NOT has_function_privilege('public', 'operational_purge(integer)', 'EXECUTE'), 'PUBLIC não executa');
SELECT is((SELECT prosecdef FROM pg_proc WHERE proname = 'operational_purge'), true, 'SECURITY DEFINER');
SELECT has_index('message_outbox', 'message_outbox_destination_sent_idx', ARRAY['destination_id', 'sent_at']);
SELECT has_index('message_outbox', 'message_outbox_destination_failed_idx', ARRAY['destination_id']);
SELECT is(pg_temp.err('SELECT * FROM operational_purge(0)'), '22023', 'limite < 1');
SELECT is(pg_temp.err('SELECT * FROM operational_purge(100001)'), '22023', 'limite acima de 100000');
SELECT is(pg_temp.err('SELECT * FROM operational_purge(NULL)'), '22023', 'limite nulo');

-- Toda FK para attachments é um vínculo de attachment_links, fora a origem de um derivado (cache do anexo, que sai com ele).
SELECT is((SELECT array_agg(c.conrelid::regclass::text || '.' || a.attname ORDER BY 1)
             FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND c.confrelid = 'attachments'::regclass
              AND pg_get_viewdef('attachment_links'::regclass) NOT LIKE
                  '%' || c.conrelid::regclass::text || '.' || a.attname || ' AS attachment_id%'
              AND pg_get_viewdef('attachment_links'::regclass) NOT LIKE
                  '%SELECT ' || c.conrelid::regclass::text || '.' || a.attname || ',%'),
          ARRAY['ai_attachment_derivatives.attachment_id'],
          'attachment_links cobre todas as FKs para attachments (menos a origem dos derivados)');

-- Dados (com os triggers desligados: datas no passado e vínculos sem montar o objeto inteiro) ---------------------------------
INSERT INTO users (id, username, email, password, role) VALUES (pg_temp.u('0a01'), 'ana70', 'ana70@example.com', 'segredo', 'user');
INSERT INTO message_destinations (id, name, bot_token, chat_id) VALUES
  (pg_temp.u('de01'), 'Grupo70', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '-100');
SET LOCAL session_replication_role = replica;

INSERT INTO attachments (id, file_name, mime_type, content, created_at) VALUES
  (pg_temp.u('a001'), 'orfao-velho.pdf', 'application/pdf', '\x01', pg_temp.ago('8 days')),
  (pg_temp.u('a002'), 'orfao-velho-2.pdf', 'application/pdf', '\x02', pg_temp.ago('9 days')),
  (pg_temp.u('a003'), 'orfao-novo.pdf', 'application/pdf', '\x03', pg_temp.ago('6 days')),
  (pg_temp.u('a004'), 'audio-com-transcricao.webm', 'audio/webm', '\x04', pg_temp.ago('30 days')),
  (pg_temp.u('a011'), 'titulo.pdf', 'application/pdf', '\x11', pg_temp.ago('400 days')),
  (pg_temp.u('a012'), 'baixa.pdf', 'application/pdf', '\x12', pg_temp.ago('400 days')),
  (pg_temp.u('a013'), 'movimento.pdf', 'application/pdf', '\x13', pg_temp.ago('400 days')),
  (pg_temp.u('a014'), 'entidade.pdf', 'application/pdf', '\x14', pg_temp.ago('400 days')),
  (pg_temp.u('a015'), 'compra.pdf', 'application/pdf', '\x15', pg_temp.ago('400 days')),
  (pg_temp.u('a016'), 'mensagem.pdf', 'application/pdf', '\x16', pg_temp.ago('400 days'));
INSERT INTO title_attachments (title_id, attachment_id) VALUES (pg_temp.u('f011'), pg_temp.u('a011'));
INSERT INTO settlement_attachments (settlement_id, attachment_id) VALUES (pg_temp.u('f012'), pg_temp.u('a012'));
INSERT INTO movement_attachments (movement_id, attachment_id) VALUES (pg_temp.u('f013'), pg_temp.u('a013'));
INSERT INTO entity_attachments (entity_id, attachment_id) VALUES (pg_temp.u('f014'), pg_temp.u('a014'));
INSERT INTO card_purchase_attachments (card_purchase_id, attachment_id) VALUES (pg_temp.u('f015'), pg_temp.u('a015'));
INSERT INTO ai_message_attachments (message_id, attachment_id) VALUES (pg_temp.u('f016'), pg_temp.u('a016'));
-- O áudio enviado ao chat e não mandado: só a transcrição (derivado) aponta para ele; ele é órfão.
INSERT INTO ai_attachment_derivatives (id, attachment_id, kind, status, provider_id, model)
VALUES (pg_temp.u('ad01'), pg_temp.u('a004'), 'transcription', 'pending', pg_temp.u('ffff'), 'whisper-1');

INSERT INTO message_outbox (id, destination_id, event_kind, dedup_key, payload, status, sent_at, last_error, created_at) VALUES
  (pg_temp.u('b001'), pg_temp.u('de01'), 'overdue', 'k1', '{}', 'sent', pg_temp.ago('200 days'), NULL, pg_temp.ago('200 days')),
  (pg_temp.u('b002'), pg_temp.u('de01'), 'overdue', 'k2', '{}', 'failed', NULL, 'erro', pg_temp.ago('190 days')),
  (pg_temp.u('b003'), pg_temp.u('de01'), 'overdue', 'k3', '{}', 'canceled', NULL, 'cancelada', pg_temp.ago('181 days')),
  (pg_temp.u('b004'), pg_temp.u('de01'), 'overdue', 'k4', '{}', 'pending', NULL, NULL, pg_temp.ago('300 days')),
  (pg_temp.u('b005'), pg_temp.u('de01'), 'overdue', 'k5', '{}', 'sent', pg_temp.ago('170 days'), NULL, pg_temp.ago('170 days'));

INSERT INTO notifications (id, user_id, kind, title, dedup_key, read_at, created_at) VALUES
  (pg_temp.u('c001'), pg_temp.u('0a01'), 'system', 'Lida velha', 'n1', pg_temp.ago('190 days'), pg_temp.ago('200 days')),
  (pg_temp.u('c002'), pg_temp.u('0a01'), 'system', 'Não lida velha', 'n2', NULL, pg_temp.ago('400 days')),
  (pg_temp.u('c003'), pg_temp.u('0a01'), 'system', 'Lida recente', 'n3', pg_temp.ago('1 day'), pg_temp.ago('100 days'));

INSERT INTO note_reminder_firings (id, note_id, user_id, scheduled_for, fired_at, last_fired_at, read_at, created_at) VALUES
  (pg_temp.u('e001'), pg_temp.u('fe01'), pg_temp.u('0a01'), pg_temp.ago('200 days'), pg_temp.ago('200 days'),
   pg_temp.ago('200 days'), pg_temp.ago('199 days'), pg_temp.ago('200 days')),
  (pg_temp.u('e002'), pg_temp.u('fe01'), pg_temp.u('0a01'), pg_temp.ago('300 days'), pg_temp.ago('300 days'),
   pg_temp.ago('300 days'), NULL, pg_temp.ago('300 days')),
  (pg_temp.u('e003'), pg_temp.u('fe01'), pg_temp.u('0a01'), pg_temp.ago('100 days'), pg_temp.ago('100 days'),
   pg_temp.ago('100 days'), pg_temp.ago('99 days'), pg_temp.ago('100 days'));

INSERT INTO telegram_pairing_codes (id, user_id, destination_id, code_hash, created_at, expires_at, used_at) VALUES
  (pg_temp.u('d001'), pg_temp.u('0a01'), pg_temp.u('de01'), repeat('1', 64), pg_temp.ago('3 days'),
   pg_temp.ago('3 days') + interval '10 minutes', pg_temp.ago('3 days') + interval '1 minute'),
  (pg_temp.u('d002'), pg_temp.u('0a01'), pg_temp.u('de01'), repeat('2', 64), pg_temp.ago('2 days'),
   pg_temp.ago('2 days') + interval '10 minutes', NULL),
  (pg_temp.u('d003'), pg_temp.u('0a01'), pg_temp.u('de01'), repeat('3', 64), pg_temp.ago('2 hours'),
   pg_temp.ago('2 hours') + interval '10 minutes', NULL),
  (pg_temp.u('d004'), pg_temp.u('0a01'), pg_temp.u('de01'), repeat('4', 64), pg_temp.ago('1 minute'),
   pg_temp.ago('1 minute') + interval '10 minutes', NULL);

INSERT INTO ai_scheduled_task_runs (id, task_id, scheduled_for, trigger_kind, status, skip_reason, created_at) VALUES
  (pg_temp.u('9001'), pg_temp.u('fa01'), pg_temp.ago('400 days'), 'schedule', 'skipped', 'orçamento', pg_temp.ago('400 days')),
  (pg_temp.u('9002'), pg_temp.u('fa01'), pg_temp.ago('100 days'), 'schedule', 'skipped', 'orçamento', pg_temp.ago('100 days'));

INSERT INTO ai_reconcile_recipe_runs (id, recipe_id, import_id, user_id, trigger_kind, line_ids, status, skip_reason,
                                      started_at, finished_at, created_at) VALUES
  (pg_temp.u('8001'), pg_temp.u('fb01'), pg_temp.u('fc01'), pg_temp.u('0a01'), 'manual', ARRAY[pg_temp.u('fd01')], 'completed',
   NULL, pg_temp.ago('400 days'), pg_temp.ago('399 days'), pg_temp.ago('400 days')),
  (pg_temp.u('8002'), pg_temp.u('fb01'), pg_temp.u('fc01'), pg_temp.u('0a01'), 'manual', ARRAY[pg_temp.u('fd01')], 'started',
   NULL, pg_temp.ago('400 days'), NULL, pg_temp.ago('400 days')),
  (pg_temp.u('8003'), pg_temp.u('fb01'), pg_temp.u('fc01'), pg_temp.u('0a01'), 'manual', ARRAY[pg_temp.u('fd01')], 'failed',
   'erro', pg_temp.ago('100 days'), pg_temp.ago('100 days'), pg_temp.ago('100 days'));
SET LOCAL session_replication_role = origin;

-- A aplicação não apaga os disparos direto; a purga, sim ----------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT is(pg_temp.err($$DELETE FROM note_reminder_firings WHERE id = pg_temp.u('e001')$$), '42501', 'app sem DELETE nos disparos');
SELECT results_eq($$SELECT target, deleted FROM operational_purge(1)$$,
                  $$VALUES ('attachments'::text, 1), ('message_outbox', 1), ('notifications', 1), ('note_reminder_firings', 1),
                           ('telegram_pairing_codes', 1), ('ai_scheduled_task_runs', 1), ('ai_reconcile_recipe_runs', 1)$$,
                  'em lotes: até o limite em cada tabela');
SELECT results_eq($$SELECT target, deleted FROM operational_purge()$$,
                  $$VALUES ('attachments'::text, 2), ('message_outbox', 2), ('notifications', 0), ('note_reminder_firings', 0),
                           ('telegram_pairing_codes', 1), ('ai_scheduled_task_runs', 0), ('ai_reconcile_recipe_runs', 0)$$,
                  'o resto do que passou do prazo');
SELECT results_eq($$SELECT target, deleted FROM operational_purge()$$,
                  $$VALUES ('attachments'::text, 0), ('message_outbox', 0), ('notifications', 0), ('note_reminder_firings', 0),
                           ('telegram_pairing_codes', 0), ('ai_scheduled_task_runs', 0), ('ai_reconcile_recipe_runs', 0)$$,
                  'nada mais a apagar');
RESET ROLE;

-- O que ficou ------------------------------------------------------------------------------------------------------------------
SELECT results_eq($$SELECT id FROM attachments WHERE id::text LIKE '00000000-0000-7000-8000-00000070%' ORDER BY id$$,
                  $$SELECT pg_temp.u(x) FROM unnest(ARRAY['a003', 'a011', 'a012', 'a013', 'a014', 'a015', 'a016']) x ORDER BY 1$$,
                  'anexos: saem os órfãos com mais de 7 dias; ficam o recente e os ligados por qualquer vínculo');
SELECT is((SELECT count(*)::int FROM ai_attachment_derivatives WHERE id = pg_temp.u('ad01')), 0,
          'a transcrição do áudio órfão sai junto');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'attachments' AND action = 'delete' AND actor_kind = 'system'
             AND record_id IN (pg_temp.u('a001'), pg_temp.u('a002'), pg_temp.u('a004'))), 3, 'a exclusão dos anexos é auditada como system');
SELECT results_eq($$SELECT id FROM message_outbox WHERE destination_id = pg_temp.u('de01') ORDER BY id$$,
                  $$VALUES (pg_temp.u('b004')), (pg_temp.u('b005'))$$,
                  'outbox: saem as finais com mais de 180 dias; ficam a pendente e a enviada recente');
SELECT results_eq($$SELECT id FROM notifications WHERE user_id = pg_temp.u('0a01') ORDER BY id$$,
                  $$VALUES (pg_temp.u('c002')), (pg_temp.u('c003'))$$, 'sino: sai a lida velha; ficam a não lida e a recente');
SELECT results_eq($$SELECT id FROM note_reminder_firings WHERE user_id = pg_temp.u('0a01') ORDER BY id$$,
                  $$VALUES (pg_temp.u('e002')), (pg_temp.u('e003'))$$, 'disparos: sai o lido velho');
SELECT results_eq($$SELECT id FROM telegram_pairing_codes WHERE user_id = pg_temp.u('0a01') ORDER BY id$$,
                  $$VALUES (pg_temp.u('d003')), (pg_temp.u('d004'))$$,
                  'pareamento: saem o usado e o vencido há mais de 1 dia; ficam o vencido recente e o válido');
SELECT results_eq($$SELECT id FROM ai_scheduled_task_runs WHERE task_id = pg_temp.u('fa01')$$,
                  $$VALUES (pg_temp.u('9002'))$$, 'tarefas: sai o disparo com mais de 1 ano');
SELECT results_eq($$SELECT id FROM ai_reconcile_recipe_runs WHERE recipe_id = pg_temp.u('fb01') ORDER BY id$$,
                  $$VALUES (pg_temp.u('8002')), (pg_temp.u('8003'))$$,
                  'receitas: sai a terminada há mais de 1 ano; ficam a em andamento e a recente');

-- Os índices da lista de destinos ------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.plan(q text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r   text;
  acc text := '';
BEGIN
  FOR r IN EXECUTE 'EXPLAIN ' || q LOOP
    acc := acc || r || E'\n';
  END LOOP;
  RETURN acc;
END
$$;
ANALYZE message_outbox;
SET LOCAL enable_seqscan = off;
SELECT matches(pg_temp.plan($$SELECT (SELECT max(o.sent_at) FROM message_outbox o WHERE o.destination_id = d.id) FROM message_destinations d$$),
               'message_outbox_destination_sent_idx', 'o último envio por destino usa o índice parcial de sent_at');
SELECT matches(pg_temp.plan($$SELECT (SELECT count(*) FROM message_outbox o WHERE o.destination_id = d.id AND o.status = 'failed')
                                FROM message_destinations d$$),
               'message_outbox_destination_failed_idx', 'as falhas por destino usam o índice parcial');
RESET enable_seqscan;

SELECT * FROM finish();
ROLLBACK;
