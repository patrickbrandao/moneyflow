-- Testes de 0045_ai_autonomous_flows (spec 029, F15): finalidades scheduled_task e reconcile_statement (e o fluxo no
-- orçamento), ai_auto_reconcile em contas e cartões, agenda das tarefas (validação, próximo e último disparo em São
-- Paulo, dia 31 e último dia), tarefas (próximo disparo, limite de 20 ativas, dono imutável, auditoria), disparos
-- (claim sem repetição, atraso acima de 6 h, execução ativa, dono e agente inativos, vínculos, estados finais,
-- "Rodar agora"), Telegram de entrada (segredo write-only, um webhook por bot, autenticação, leitor do backup,
-- auditoria sem o segredo), pareamento (código com hash, expiração, uso único, troca de dono do chat), dedup de
-- update_id, notificação/evento ai_awaiting_approval e a chave telegram.public_base_url.
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
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;

-- Estrutura ----------------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['ai_scheduled_tasks', 'ai_scheduled_task_runs', 'telegram_links',
  'telegram_pairing_codes', 'telegram_updates_seen']) t;
SELECT columns_are('ai_scheduled_tasks', ARRAY['id', 'user_id', 'agent_id', 'name', 'instruction', 'schedule',
  'is_active', 'next_run_at', 'last_run_at', 'created_by_user_id', 'created_at', 'updated_at']);
SELECT columns_are('ai_scheduled_task_runs', ARRAY['id', 'task_id', 'scheduled_for', 'trigger_kind', 'status',
  'skip_reason', 'conversation_id', 'run_id', 'created_at', 'updated_at']);
SELECT columns_are('telegram_links', ARRAY['id', 'destination_id', 'user_id', 'chat_id', 'telegram_user_id',
  'username', 'revoked_at', 'created_at', 'updated_at']);
SELECT columns_are('telegram_pairing_codes', ARRAY['id', 'user_id', 'destination_id', 'code_hash', 'expires_at',
  'used_at', 'link_id', 'created_at', 'updated_at']);
SELECT columns_are('telegram_updates_seen', ARRAY['destination_id', 'update_id', 'created_at']);
SELECT has_column('message_destinations', c) FROM unnest(ARRAY['inbound_enabled', 'inbound_agent_id',
  'webhook_secret_hash']) c;
SELECT has_column(t, 'ai_auto_reconcile') FROM unnest(ARRAY['financial_accounts', 'caixas']) t;
SELECT col_default_is(t, 'ai_auto_reconcile', 'false') FROM unnest(ARRAY['financial_accounts', 'caixas']) t;
SELECT col_default_is('message_destinations', 'inbound_enabled', 'false');
SELECT results_eq($$SELECT conrelid::regclass::text COLLATE "default", conname::text COLLATE "default", confdeltype::text
                      FROM pg_constraint
                     WHERE contype = 'f' AND conrelid IN ('ai_scheduled_tasks'::regclass, 'ai_scheduled_task_runs'::regclass,
                           'telegram_links'::regclass, 'telegram_pairing_codes'::regclass,
                           'telegram_updates_seen'::regclass)
                        OR conname = 'message_destinations_inbound_agent_id_fkey'
                     ORDER BY 1, 2$$,
                  $$VALUES ('ai_scheduled_task_runs', 'ai_scheduled_task_runs_conversation_id_fkey', 'n'),
                           ('ai_scheduled_task_runs', 'ai_scheduled_task_runs_run_id_fkey', 'n'),
                           ('ai_scheduled_task_runs', 'ai_scheduled_task_runs_task_id_fkey', 'c'),
                           ('ai_scheduled_tasks', 'ai_scheduled_tasks_agent_id_fkey', 'a'),
                           ('ai_scheduled_tasks', 'ai_scheduled_tasks_created_by_user_id_fkey', 'n'),
                           ('ai_scheduled_tasks', 'ai_scheduled_tasks_user_id_fkey', 'c'),
                           ('message_destinations', 'message_destinations_inbound_agent_id_fkey', 'a'),
                           ('telegram_links', 'telegram_links_destination_id_fkey', 'c'),
                           ('telegram_links', 'telegram_links_user_id_fkey', 'c'),
                           ('telegram_pairing_codes', 'telegram_pairing_codes_destination_id_fkey', 'c'),
                           ('telegram_pairing_codes', 'telegram_pairing_codes_link_id_fkey', 'n'),
                           ('telegram_pairing_codes', 'telegram_pairing_codes_user_id_fkey', 'c'),
                           ('telegram_updates_seen', 'telegram_updates_seen_destination_id_fkey', 'c')$$,
                  'FKs: histórico do disparo sobrevive à sessão (SET NULL); agente em uso não é excluído');
SELECT has_index(t, i) FROM (VALUES
  ('ai_scheduled_tasks', 'ai_scheduled_tasks_user_id_idx'), ('ai_scheduled_tasks', 'ai_scheduled_tasks_agent_id_idx'),
  ('ai_scheduled_tasks', 'ai_scheduled_tasks_created_by_user_id_idx'), ('ai_scheduled_tasks', 'ai_scheduled_tasks_due_idx'),
  ('ai_scheduled_task_runs', 'ai_scheduled_task_runs_conversation_id_idx'),
  ('ai_scheduled_task_runs', 'ai_scheduled_task_runs_run_id_idx'),
  ('message_destinations', 'message_destinations_inbound_agent_id_idx'),
  ('message_destinations', 'message_destinations_inbound_bot_key'),
  ('telegram_links', 'telegram_links_active_key'), ('telegram_links', 'telegram_links_destination_id_idx'),
  ('telegram_links', 'telegram_links_user_id_idx'), ('telegram_pairing_codes', 'telegram_pairing_codes_user_id_idx'),
  ('telegram_pairing_codes', 'telegram_pairing_codes_destination_id_idx'),
  ('telegram_pairing_codes', 'telegram_pairing_codes_link_id_idx'),
  ('telegram_updates_seen', 'telegram_updates_seen_created_at_idx')) AS v (t, i);
SELECT is((SELECT pg_get_indexdef('message_destinations_inbound_bot_key'::regclass)
                  ~ 'UNIQUE INDEX .*\(bot_id\) WHERE inbound_enabled'), true, 'um webhook por bot');
SELECT is((SELECT pg_get_indexdef('telegram_links_active_key'::regclass)
                  ~ 'UNIQUE INDEX .*\(destination_id, chat_id\) WHERE \(revoked_at IS NULL\)'), true,
          'um vínculo ativo por destino e chat');
SELECT has_trigger(t, g) FROM (VALUES
  ('ai_scheduled_tasks', 'ai_scheduled_tasks_audit'), ('ai_scheduled_tasks', 'ai_scheduled_tasks_before_write'),
  ('ai_scheduled_task_runs', 'ai_scheduled_task_runs_before_write'), ('telegram_links', 'telegram_links_audit'),
  ('telegram_pairing_codes', 'telegram_pairing_codes_audit')) AS v (t, g);
SELECT hasnt_trigger('ai_scheduled_task_runs', 'ai_scheduled_task_runs_audit');
SELECT hasnt_trigger('telegram_updates_seen', 'telegram_updates_seen_audit');

-- Privilégios
SELECT ok(has_table_privilege('moneyflow_app', t, p), format('app: %s em %s', p, t))
  FROM unnest(ARRAY['ai_scheduled_tasks', 'ai_scheduled_task_runs', 'telegram_links']) t,
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
SELECT ok(NOT has_column_privilege('moneyflow_app', t, c, 'SELECT'), format('app não lê %s.%s', t, c))
  FROM (VALUES ('message_destinations', 'webhook_secret_hash'), ('message_destinations', 'bot_token'),
               ('telegram_pairing_codes', 'code_hash')) AS v (t, c);
SELECT ok(has_column_privilege('moneyflow_app', t, c, 'SELECT'), format('app lê %s.%s', t, c))
  FROM (VALUES ('message_destinations', 'inbound_enabled'), ('message_destinations', 'inbound_agent_id'),
               ('telegram_pairing_codes', 'expires_at'), ('telegram_pairing_codes', 'used_at')) AS v (t, c);
SELECT ok(has_column_privilege('moneyflow_app', 'message_destinations', c, p), format('app grava %s (%s)', c, p))
  FROM unnest(ARRAY['inbound_enabled', 'inbound_agent_id', 'webhook_secret_hash']) c, unnest(ARRAY['INSERT', 'UPDATE']) p;
SELECT ok(NOT has_table_privilege('moneyflow_app', 'telegram_updates_seen', 'UPDATE'), 'app não altera update visto');
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_scheduled_task_claim(integer, interval)', 'ai_scheduled_task_run_now(uuid)',
                    'ai_schedule_next_run(jsonb, timestamptz)', 'telegram_webhook_authenticate(uuid, text)',
                    'admin_message_destination_webhook_secret(uuid, uuid)', 'telegram_pairing_code_create(uuid, uuid, text)',
                    'telegram_pairing_consume(uuid, text, bigint, bigint, text)', 'telegram_update_seen(uuid, bigint)',
                    'telegram_updates_seen_purge(interval)', 'telegram_secret_hash(text)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'public não executa ' || f)
  FROM unnest(ARRAY['telegram_webhook_authenticate(uuid, text)', 'admin_message_destination_webhook_secret(uuid, uuid)',
                    'telegram_pairing_consume(uuid, text, bigint, bigint, text)', 'ai_scheduled_task_claim(integer, interval)']) f;

-- Finalidades --------------------------------------------------------------------------------------------------------
SELECT ok(pg_get_constraintdef(oid) ~ 'scheduled_task' AND pg_get_constraintdef(oid) ~ 'reconcile_statement',
          conname || ' aceita as finalidades novas')
  FROM pg_constraint
 WHERE conname IN ('ai_conversations_purpose_check', 'ai_usage_purpose_check', 'ai_requests_purpose_check');
SELECT is(ai_usage_is_flow(u, c), true, format('is_flow(%s, %s)', u, c))
  FROM (VALUES ('scheduled_task', NULL), ('reconcile_statement', NULL), ('chat', 'scheduled_task'),
               ('vision_describe', 'reconcile_statement')) AS v (u, c);

-- Dados base ---------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000045a1', 'admin45', 'admin45@example.com', 'segredo', 'admin', true),
  ('00000000-0000-7000-8000-0000000045a2', 'bia45', 'bia45@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000045a3', 'caio45', 'caio45@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000045a4', 'ina45', 'ina45@example.com', 'segredo', 'user', false);
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000045f1', 'Provedor 45', 'anthropic', 'sk-ant-api03-aaaaaaaa');
INSERT INTO ai_agents (id, name, provider_id, model, is_active) VALUES
  ('00000000-0000-7000-8000-0000000045b1', 'Agente 45', '00000000-0000-7000-8000-0000000045f1', 'claude-sonnet-4-5', true),
  ('00000000-0000-7000-8000-0000000045b2', 'Parado 45', '00000000-0000-7000-8000-0000000045f1', 'claude-sonnet-4-5', false);

-- Conversas e uso com as finalidades novas
INSERT INTO ai_conversations (id, user_id, agent_id, purpose, title) VALUES
  ('00000000-0000-7000-8000-0000000045c1', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'scheduled_task', 'Tarefa da Bia'),
  ('00000000-0000-7000-8000-0000000045c2', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'reconcile_statement', 'Conciliação'),
  ('00000000-0000-7000-8000-0000000045c3', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'chat', 'Sessão'),
  ('00000000-0000-7000-8000-0000000045c4', '00000000-0000-7000-8000-0000000045a3', '00000000-0000-7000-8000-0000000045b1',
   'scheduled_task', 'Tarefa do Caio'),
  ('00000000-0000-7000-8000-0000000045c5', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'scheduled_task', 'Outra tarefa da Bia');
SELECT is((SELECT count(*)::int FROM ai_conversations WHERE id IN ('00000000-0000-7000-8000-0000000045c1',
            '00000000-0000-7000-8000-0000000045c3')), 2,
          'sessão de tarefa convive com a sessão chat ativa do mesmo par (fora do índice da sessão ativa)');
INSERT INTO ai_usage (provider_id, model, conversation_id, user_id, agent_id, purpose, input_tokens) VALUES
  ('00000000-0000-7000-8000-0000000045f1', 'claude-sonnet-4-5', '00000000-0000-7000-8000-0000000045c2',
   '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1', 'chat', 10),
  ('00000000-0000-7000-8000-0000000045f1', 'claude-sonnet-4-5', NULL, '00000000-0000-7000-8000-0000000045a2', NULL,
   'scheduled_task', 5);
SELECT is((SELECT purpose FROM ai_usage WHERE conversation_id = '00000000-0000-7000-8000-0000000045c2'),
          'reconcile_statement', 'chat numa conversa de conciliação vira reconcile_statement');
SELECT is((SELECT count(*)::int FROM ai_usage u LEFT JOIN ai_conversations c ON c.id = u.conversation_id
            WHERE u.user_id = '00000000-0000-7000-8000-0000000045a2' AND ai_usage_is_flow(u.purpose, c.purpose)), 2,
          'os dois usos contam como fluxo');

-- Conciliar com IA ao importar ---------------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000045e1', 'person', 'Bia 45'),
  ('00000000-0000-7000-8000-0000000045e2', 'company', 'Banco 45');
INSERT INTO caixas (id, name, kind, holder_entity_id, is_primary) VALUES
  ('00000000-0000-7000-8000-0000000045d1', 'Casa 45', 'general', '00000000-0000-7000-8000-0000000045e1', true);
INSERT INTO caixas (id, name, kind, holder_entity_id, default_payer_caixa_id, credit_limit_cents, closing_day, due_day,
                    card_last4, ai_auto_reconcile) VALUES
  ('00000000-0000-7000-8000-0000000045d2', 'Cartão 45', 'credit_card', '00000000-0000-7000-8000-0000000045e2',
   '00000000-0000-7000-8000-0000000045d1', 100000, 3, 10, '4545', true);
SELECT is((SELECT ai_auto_reconcile FROM caixas WHERE id = '00000000-0000-7000-8000-0000000045d2'), true,
          'cartão liga a conciliação com IA');
SELECT is(pg_temp.err($$UPDATE caixas SET ai_auto_reconcile = true WHERE id = '00000000-0000-7000-8000-0000000045d1'$$),
          '23514 caixas_ai_auto_reconcile_check', 'caixa general não tem o interruptor');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date, ai_auto_reconcile) VALUES
  ('00000000-0000-7000-8000-0000000045a8', '00000000-0000-7000-8000-0000000045d1', 'checking', 'Corrente 45', '2026-01-01', true),
  ('00000000-0000-7000-8000-0000000045a9', '00000000-0000-7000-8000-0000000045d1', 'cash', 'Cofre 45', '2026-01-01', false);
SELECT is((SELECT ai_auto_reconcile FROM financial_accounts WHERE id = '00000000-0000-7000-8000-0000000045a8'), true,
          'conta corrente liga a conciliação com IA');
SELECT is(pg_temp.err($$UPDATE financial_accounts SET ai_auto_reconcile = true
                         WHERE id = '00000000-0000-7000-8000-0000000045a9'$$),
          '23514 financial_accounts_ai_auto_reconcile_check', 'cofre não tem o interruptor');

-- Agenda: validação ------------------------------------------------------------------------------------------------
SELECT is(ai_schedule_valid(s::jsonb), e, format('agenda %s válida = %s', s, e))
  FROM (VALUES
    ('{"kind": "daily", "time": "08:00"}', true),
    ('{"kind": "daily", "time": "23:59"}', true),
    ('{"kind": "weekly", "time": "08:00", "weekdays": [1, 3, 5]}', true),
    ('{"kind": "weekly", "time": "08:00", "weekdays": [1, 2, 3, 4, 5, 6, 7]}', true),
    ('{"kind": "monthly", "time": "08:00", "day": 1}', true),
    ('{"kind": "monthly", "time": "08:00", "day": 31}', true),
    ('{"kind": "monthly", "time": "08:00", "day": "last"}', true),
    ('{"kind": "daily", "time": "8:00"}', false),
    ('{"kind": "daily", "time": "24:00"}', false),
    ('{"kind": "daily"}', false),
    ('{"kind": "daily", "time": "08:00", "day": 1}', false),
    ('{"kind": "hourly", "time": "08:00"}', false),
    ('{"time": "08:00"}', false),
    ('{"kind": "weekly", "time": "08:00"}', false),
    ('{"kind": "weekly", "time": "08:00", "weekdays": []}', false),
    ('{"kind": "weekly", "time": "08:00", "weekdays": [0]}', false),
    ('{"kind": "weekly", "time": "08:00", "weekdays": [8]}', false),
    ('{"kind": "weekly", "time": "08:00", "weekdays": [1, 1]}', false),
    ('{"kind": "weekly", "time": "08:00", "weekdays": ["1"]}', false),
    ('{"kind": "monthly", "time": "08:00", "day": 0}', false),
    ('{"kind": "monthly", "time": "08:00", "day": 32}', false),
    ('{"kind": "monthly", "time": "08:00", "day": "31"}', false),
    ('{"kind": "monthly", "time": "08:00", "day": 1.5}', false),
    ('{"kind": "monthly", "time": "08:00"}', false),
    ('[]', false),
    ('"daily"', false)) AS v (s, e);

-- Agenda: próximo e último disparo (America/Sao_Paulo = UTC−3) --------------------------------------------------------
SELECT is(ai_schedule_next_run(s::jsonb, a::timestamptz), e::timestamptz, d)
  FROM (VALUES
    ('{"kind": "daily", "time": "08:00"}', '2026-03-10 10:00+00', '2026-03-10 11:00+00', 'diária: hoje, 08:00 de SP'),
    ('{"kind": "daily", "time": "08:00"}', '2026-03-10 11:00+00', '2026-03-11 11:00+00',
     'diária: no horário exato, o seguinte é amanhã'),
    ('{"kind": "daily", "time": "23:30"}', '2026-03-10 12:00+00', '2026-03-11 02:30+00', 'diária: 23:30 de SP é 02:30 UTC'),
    ('{"kind": "daily", "time": "00:15"}', '2026-03-10 02:00+00', '2026-03-10 03:15+00',
     'diária: 23:00 de SP do dia 9 → 00:15 do dia 10'),
    ('{"kind": "weekly", "time": "09:30", "weekdays": [1, 5]}', '2026-03-10 12:00+00', '2026-03-13 12:30+00',
     'semanal: terça → sexta'),
    ('{"kind": "weekly", "time": "09:30", "weekdays": [1, 5]}', '2026-03-13 13:00+00', '2026-03-16 12:30+00',
     'semanal: sexta depois do horário → segunda'),
    ('{"kind": "weekly", "time": "09:30", "weekdays": [7]}', '2026-03-10 12:00+00', '2026-03-15 12:30+00',
     'semanal: domingo = 7'),
    ('{"kind": "monthly", "time": "08:00", "day": 15}', '2026-03-20 12:00+00', '2026-04-15 11:00+00',
     'mensal: dia 15 já passou → mês seguinte'),
    ('{"kind": "monthly", "time": "08:00", "day": 31}', '2026-02-01 12:00+00', '2026-02-28 11:00+00',
     'mensal: dia 31 em fevereiro = dia 28'),
    ('{"kind": "monthly", "time": "08:00", "day": 31}', '2026-02-28 12:00+00', '2026-03-31 11:00+00',
     'mensal: depois de 28/02 → 31/03'),
    ('{"kind": "monthly", "time": "08:00", "day": 31}', '2026-04-01 12:00+00', '2026-04-30 11:00+00',
     'mensal: dia 31 em abril = dia 30'),
    ('{"kind": "monthly", "time": "08:00", "day": 30}', '2026-02-28 12:00+00', '2026-03-30 11:00+00',
     'mensal: dia 30 de fevereiro (28) já passou → 30/03'),
    ('{"kind": "monthly", "time": "08:00", "day": "last"}', '2028-02-01 12:00+00', '2028-02-29 11:00+00',
     'mensal: último dia em ano bissexto'),
    ('{"kind": "monthly", "time": "08:00", "day": "last"}', '2026-12-31 12:00+00', '2027-01-31 11:00+00',
     'mensal: último dia, virada do ano'),
    ('{"kind": "monthly", "time": "08:00", "day": 1}', '2026-12-31 12:00+00', '2027-01-01 11:00+00',
     'mensal: dia 1, virada do ano')) AS v (s, a, e, d);
SELECT is(ai_schedule_next_run('{"kind": "daily"}', now()), NULL, 'agenda inválida: sem próximo disparo');
SELECT is(ai_schedule_prev_run(s::jsonb, a::timestamptz), e::timestamptz, d)
  FROM (VALUES
    ('{"kind": "daily", "time": "08:00"}', '2026-03-10 10:00+00', '2026-03-09 11:00+00', 'último: ontem'),
    ('{"kind": "daily", "time": "08:00"}', '2026-03-10 11:00+00', '2026-03-10 11:00+00', 'último: o próprio instante'),
    ('{"kind": "weekly", "time": "09:30", "weekdays": [1, 5]}', '2026-03-12 12:00+00', '2026-03-09 12:30+00',
     'último semanal: segunda'),
    ('{"kind": "monthly", "time": "08:00", "day": 31}', '2026-03-10 12:00+00', '2026-02-28 11:00+00',
     'último mensal: 31 → 28/02')) AS v (s, a, e, d);

-- Tarefas ----------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE sched AS
SELECT d, jsonb_build_object('kind', 'daily',
                             'time', to_char((now() - d) AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')) AS s
  FROM (VALUES (interval '1 hour'), (interval '8 hours')) AS v (d);

INSERT INTO ai_scheduled_tasks (id, user_id, agent_id, name, instruction, schedule, created_by_user_id) VALUES
  -- vence há 1 h
  ('00000000-0000-7000-8000-000000045101', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'Resumo', 'Faça o resumo do dia', (SELECT s FROM sched WHERE d = interval '1 hour'), '00000000-0000-7000-8000-0000000045a2'),
  -- vence há 8 h (acima do prazo de 6 h)
  ('00000000-0000-7000-8000-000000045102', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'Atrasada', 'x', (SELECT s FROM sched WHERE d = interval '8 hours'), '00000000-0000-7000-8000-0000000045a2'),
  -- execução anterior ainda ativa
  ('00000000-0000-7000-8000-000000045103', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'Ocupada', 'x', (SELECT s FROM sched WHERE d = interval '1 hour'), '00000000-0000-7000-8000-0000000045a2'),
  -- agente inativo
  ('00000000-0000-7000-8000-000000045104', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b2',
   'Agente parado', 'x', (SELECT s FROM sched WHERE d = interval '1 hour'), '00000000-0000-7000-8000-0000000045a2'),
  -- dono inativo
  ('00000000-0000-7000-8000-000000045105', '00000000-0000-7000-8000-0000000045a4', '00000000-0000-7000-8000-0000000045b1',
   'Dono inativo', 'x', (SELECT s FROM sched WHERE d = interval '1 hour'), '00000000-0000-7000-8000-0000000045a1');
INSERT INTO ai_scheduled_tasks (id, user_id, agent_id, name, instruction, schedule, is_active) VALUES
  ('00000000-0000-7000-8000-000000045106', '00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1',
   'Desligada', 'x', '{"kind": "monthly", "time": "08:00", "day": "last"}', false);

SELECT is((SELECT next_run_at FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045101'),
          ai_schedule_next_run((SELECT s FROM sched WHERE d = interval '1 hour'), now()),
          'next_run_at calculado pelo banco ao criar (amanhã, no mesmo horário)');
SELECT ok((SELECT next_run_at > now() FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045101'),
          'próximo disparo no futuro');
SELECT is((SELECT next_run_at FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045106'), NULL,
          'desligada: sem próximo disparo');
UPDATE ai_scheduled_tasks SET is_active = true WHERE id = '00000000-0000-7000-8000-000000045106';
SELECT is((SELECT next_run_at FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045106'),
          ai_schedule_next_run('{"kind": "monthly", "time": "08:00", "day": "last"}', now()), 'ligar calcula o próximo');
UPDATE ai_scheduled_tasks SET schedule = '{"kind": "monthly", "time": "09:00", "day": 1}'
 WHERE id = '00000000-0000-7000-8000-000000045106';
SELECT is((SELECT next_run_at FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045106'),
          ai_schedule_next_run('{"kind": "monthly", "time": "09:00", "day": 1}', now()), 'mudar a agenda recalcula');
UPDATE ai_scheduled_tasks SET is_active = false WHERE id = '00000000-0000-7000-8000-000000045106';
SELECT is((SELECT next_run_at FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045106'), NULL,
          'desligar limpa o próximo');

SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_tasks (user_id, agent_id, name, instruction, schedule) VALUES
  ('00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1', 'x', 'x', '{"kind": "daily"}')$$),
          '23514 ai_scheduled_tasks_schedule_check', 'agenda inválida recusada');
SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_tasks (user_id, agent_id, name, instruction, schedule) VALUES
  ('00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1', ' ', 'x',
   '{"kind": "daily", "time": "08:00"}')$$),
          '23514 ai_scheduled_tasks_name_check', 'nome vazio recusado');
SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_tasks (user_id, agent_id, name, instruction, schedule) VALUES
  ('00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045b1', 'x', repeat('a', 20001),
   '{"kind": "daily", "time": "08:00"}')$$),
          '23514 ai_scheduled_tasks_instruction_check', 'instrução acima de 20 mil recusada');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_tasks SET user_id = '00000000-0000-7000-8000-0000000045a3'
                         WHERE id = '00000000-0000-7000-8000-000000045101'$$),
          '23514 ai_scheduled_tasks_user_immutable_check', 'dono imutável');
SELECT is(pg_temp.err($$DELETE FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000045b2'$$),
          '23503 ai_scheduled_tasks_agent_id_fkey', 'agente com tarefa não é excluído');

-- Limite de 20 ativas por usuário (Caio)
INSERT INTO ai_scheduled_tasks (user_id, agent_id, name, instruction, schedule)
SELECT '00000000-0000-7000-8000-0000000045a3', '00000000-0000-7000-8000-0000000045b1', 'Tarefa ' || g, 'x',
       '{"kind": "daily", "time": "07:00"}'
  FROM generate_series(1, 20) g;
SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_tasks (user_id, agent_id, name, instruction, schedule) VALUES
  ('00000000-0000-7000-8000-0000000045a3', '00000000-0000-7000-8000-0000000045b1', 'Vigésima primeira', 'x',
   '{"kind": "daily", "time": "07:00"}')$$),
          '23514 ai_scheduled_tasks_active_limit_check', 'a 21ª ativa é recusada');
INSERT INTO ai_scheduled_tasks (id, user_id, agent_id, name, instruction, schedule, is_active) VALUES
  ('00000000-0000-7000-8000-000000045121', '00000000-0000-7000-8000-0000000045a3', '00000000-0000-7000-8000-0000000045b1',
   'Desligada do Caio', 'x', '{"kind": "daily", "time": "07:00"}', false);
SELECT pass('desligada não conta no limite');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_tasks SET is_active = true WHERE id = '00000000-0000-7000-8000-000000045121'$$),
          '23514 ai_scheduled_tasks_active_limit_check', 'ligar a 21ª é recusado');
UPDATE ai_scheduled_tasks SET is_active = false
 WHERE id = (SELECT id FROM ai_scheduled_tasks WHERE user_id = '00000000-0000-7000-8000-0000000045a3' AND is_active
              ORDER BY id LIMIT 1);
SELECT is(pg_temp.err($$UPDATE ai_scheduled_tasks SET is_active = true WHERE id = '00000000-0000-7000-8000-000000045121'$$),
          'ok', 'desligando uma, outra pode ser ligada');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_tasks SET name = 'Renomeada' WHERE id = '00000000-0000-7000-8000-000000045121'$$),
          'ok', 'editar uma ativa no limite passa');

-- Auditoria da tarefa
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_scheduled_tasks'
            AND record_id = '00000000-0000-7000-8000-000000045101' AND action = 'insert'), 1, 'criação auditada');

-- Disparos -----------------------------------------------------------------------------------------------------------
-- Põe as cinco primeiras para vencer no último horário previsto (a 102 há 8 h; as demais há 1 h).
UPDATE ai_scheduled_tasks SET next_run_at = ai_schedule_prev_run(schedule, now())
 WHERE id BETWEEN '00000000-0000-7000-8000-000000045101' AND '00000000-0000-7000-8000-000000045105';
-- A 103 tem um disparo anterior com a execução na fila.
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000045901', '00000000-0000-7000-8000-0000000045c5', '00000000-0000-7000-8000-0000000045a2',
   '00000000-0000-7000-8000-0000000045b1');
INSERT INTO ai_scheduled_task_runs (task_id, scheduled_for, status, conversation_id, run_id) VALUES
  ('00000000-0000-7000-8000-000000045103', now() - interval '2 days', 'started', '00000000-0000-7000-8000-0000000045c5',
   '00000000-0000-7000-8000-000000045901');
CREATE TEMP TABLE audit_before AS
SELECT count(*) AS n FROM audit_log WHERE table_name = 'ai_scheduled_tasks';

CREATE TEMP TABLE claimed AS SELECT * FROM ai_scheduled_task_claim();
SELECT results_eq($$SELECT task_id, status, skip_reason, trigger_kind FROM claimed ORDER BY task_id$$,
                  $$VALUES ('00000000-0000-7000-8000-000000045101'::uuid, 'started', NULL::text, 'schedule'),
                           ('00000000-0000-7000-8000-000000045102'::uuid, 'skipped', 'missed_window', 'schedule'),
                           ('00000000-0000-7000-8000-000000045103'::uuid, 'skipped', 'previous_run_active', 'schedule'),
                           ('00000000-0000-7000-8000-000000045104'::uuid, 'skipped', 'agent_inactive', 'schedule'),
                           ('00000000-0000-7000-8000-000000045105'::uuid, 'skipped', 'user_inactive', 'schedule')$$,
                  'claim: started, atraso acima de 6 h, execução ativa, agente e dono inativos');
SELECT results_eq($$SELECT user_id, agent_id, task_name, instruction FROM claimed
                     WHERE task_id = '00000000-0000-7000-8000-000000045101'$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000045a2'::uuid, '00000000-0000-7000-8000-0000000045b1'::uuid,
                            'Resumo', 'Faça o resumo do dia')$$,
                  'o claim devolve dono, agente, nome e instrução');
SELECT is((SELECT scheduled_for FROM claimed WHERE task_id = '00000000-0000-7000-8000-000000045101'),
          ai_schedule_prev_run((SELECT s FROM sched WHERE d = interval '1 hour'), now()),
          'scheduled_for = o horário previsto');
SELECT is((SELECT count(*)::int FROM ai_scheduled_task_runs r JOIN claimed c ON c.task_run_id = r.id), 5,
          'os cinco disparos gravados');
SELECT ok((SELECT bool_and(next_run_at > now()) FROM ai_scheduled_tasks
            WHERE id BETWEEN '00000000-0000-7000-8000-000000045101' AND '00000000-0000-7000-8000-000000045105'),
          'next_run_at avançou para depois de agora');
SELECT ok((SELECT last_run_at IS NOT NULL FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045101'),
          'last_run_at do started');
SELECT is((SELECT count(*)::int FROM ai_scheduled_tasks
            WHERE id BETWEEN '00000000-0000-7000-8000-000000045102' AND '00000000-0000-7000-8000-000000045105'
              AND last_run_at IS NOT NULL), 0, 'pulado não muda last_run_at');
SELECT is((SELECT count(*)::int FROM ai_scheduled_task_claim()), 0, 'segundo claim: nada se repete');
SELECT is((SELECT count(*) FROM audit_log WHERE table_name = 'ai_scheduled_tasks'), (SELECT n FROM audit_before),
          'avançar next_run_at/last_run_at não gera auditoria');

-- O mesmo horário não dispara duas vezes (único por tarefa e horário)
UPDATE ai_scheduled_tasks SET next_run_at = (SELECT scheduled_for FROM claimed
                                               WHERE task_id = '00000000-0000-7000-8000-000000045101')
 WHERE id = '00000000-0000-7000-8000-000000045101';
SELECT is((SELECT count(*)::int FROM ai_scheduled_task_claim()), 0, 'horário já disparado não volta');
SELECT ok((SELECT next_run_at > now() FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045101'),
          'mas o próximo avança');
SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_task_runs (task_id, scheduled_for, status)
                        SELECT task_id, scheduled_for, 'started' FROM claimed
                         WHERE task_id = '00000000-0000-7000-8000-000000045101'$$),
          '23505 ai_scheduled_task_runs_task_scheduled_key', 'único por (tarefa, horário)');
SELECT is(pg_temp.err($$SELECT * FROM ai_scheduled_task_claim(0)$$), '22023 ', 'limite inválido');
SELECT is(pg_temp.err($$SELECT * FROM ai_scheduled_task_claim(10, interval '10 seconds')$$), '22023 ', 'prazo inválido');

-- Vínculos do disparo started (tarefa 101, da Bia)
CREATE TEMP TABLE r101 AS SELECT task_run_id AS id FROM claimed WHERE task_id = '00000000-0000-7000-8000-000000045101';
GRANT SELECT ON r101 TO moneyflow_app;
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET conversation_id = '00000000-0000-7000-8000-0000000045c3'
                         WHERE id = (SELECT id FROM r101)$$),
          '23514 ai_scheduled_task_runs_links_check', 'sessão chat não serve');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET conversation_id = '00000000-0000-7000-8000-0000000045c4'
                         WHERE id = (SELECT id FROM r101)$$),
          '23514 ai_scheduled_task_runs_links_check', 'sessão de outro usuário não serve');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET conversation_id = '00000000-0000-7000-8000-0000000045c1',
                                                         run_id = '00000000-0000-7000-8000-000000045901'
                         WHERE id = (SELECT id FROM r101)$$),
          '23514 ai_scheduled_task_runs_links_check', 'execução de outra conversa não serve');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000045902', '00000000-0000-7000-8000-0000000045c1', '00000000-0000-7000-8000-0000000045a2',
   '00000000-0000-7000-8000-0000000045b1');
SET LOCAL ROLE moneyflow_app;
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET conversation_id = '00000000-0000-7000-8000-0000000045c1',
                                                         run_id = '00000000-0000-7000-8000-000000045902'
                         WHERE id = (SELECT id FROM r101)$$),
          'ok', 'app liga a sessão e a execução do disparo');
RESET ROLE;
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET conversation_id = '00000000-0000-7000-8000-0000000045c5'
                         WHERE id = (SELECT id FROM r101)$$),
          '23514 ai_scheduled_task_runs_immutable_check', 'a sessão ligada não muda');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET status = 'failed', skip_reason = 'erro'
                         WHERE id = (SELECT id FROM r101)$$),
          '23514 ai_scheduled_task_runs_run_check', 'started com execução não vira failed');
SELECT is(pg_temp.err($$UPDATE ai_scheduled_task_runs SET status = 'started', skip_reason = NULL
                         WHERE task_id = '00000000-0000-7000-8000-000000045102'$$),
          '23514 ai_scheduled_task_runs_status_transition_check', 'skipped é final');
SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_task_runs (task_id, scheduled_for, status) VALUES
  ('00000000-0000-7000-8000-000000045106', now() - interval '1 day', 'skipped')$$),
          '23514 ai_scheduled_task_runs_reason_check', 'skipped exige o motivo');
SELECT is(pg_temp.err($$INSERT INTO ai_scheduled_task_runs (task_id, scheduled_for, status, skip_reason) VALUES
  ('00000000-0000-7000-8000-000000045106', now() - interval '1 day', 'started', 'x')$$),
          '23514 ai_scheduled_task_runs_reason_check', 'started não tem motivo');

-- "Rodar agora": a 101 tem execução ativa; a 106 (desligada) dispara.
SELECT results_eq($$SELECT status, skip_reason, trigger_kind FROM ai_scheduled_task_run_now('00000000-0000-7000-8000-000000045101')$$,
                  $$VALUES ('skipped', 'previous_run_active', 'manual')$$, 'rodar agora com execução ativa: pulado');
CREATE TEMP TABLE now106 AS SELECT * FROM ai_scheduled_task_run_now('00000000-0000-7000-8000-000000045106');
SELECT results_eq($$SELECT status, skip_reason, trigger_kind FROM now106$$, $$VALUES ('started', NULL::text, 'manual')$$,
                  'rodar agora numa tarefa desligada');
SELECT is((SELECT next_run_at FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045106'), NULL,
          'rodar agora não liga a tarefa');
SELECT ok((SELECT last_run_at IS NOT NULL FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045106'),
          'rodar agora marca last_run_at');
SELECT results_eq($$SELECT status, skip_reason FROM ai_scheduled_task_run_now('00000000-0000-7000-8000-000000045106')$$,
                  $$VALUES ('skipped', 'previous_run_active')$$,
                  'disparo recém-reservado (sem execução ainda) também conta como em andamento');
UPDATE ai_scheduled_task_runs SET status = 'failed', skip_reason = 'budget_exceeded'
 WHERE id = (SELECT task_run_id FROM now106);
SELECT results_eq($$SELECT status FROM ai_scheduled_task_run_now('00000000-0000-7000-8000-000000045106')$$,
                  $$VALUES ('started')$$, 'o anterior que falhou não segura o próximo');
SELECT is(pg_temp.err($$SELECT * FROM ai_scheduled_task_run_now('00000000-0000-7000-8000-000000045199')$$),
          'P0002 ', 'tarefa inexistente');

-- Excluir a sessão: o histórico do disparo fica, sem vínculos
DELETE FROM ai_conversations WHERE id = '00000000-0000-7000-8000-0000000045c1';
SELECT results_eq($$SELECT status, conversation_id, run_id FROM ai_scheduled_task_runs WHERE id = (SELECT id FROM r101)$$,
                  $$VALUES ('started', NULL::uuid, NULL::uuid)$$, 'excluir a sessão mantém o disparo');
-- Excluir a tarefa leva os disparos
DELETE FROM ai_scheduled_tasks WHERE id = '00000000-0000-7000-8000-000000045105';
SELECT is((SELECT count(*)::int FROM ai_scheduled_task_runs WHERE task_id = '00000000-0000-7000-8000-000000045105'), 0,
          'excluir a tarefa leva os disparos');

-- Telegram de entrada ------------------------------------------------------------------------------------------------
SELECT is(telegram_secret_hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
          'telegram_secret_hash = SHA-256 hex');
INSERT INTO message_destinations (id, name, owner_user_id, bot_token, chat_id) VALUES
  ('00000000-0000-7000-8000-0000000045d5', 'Bot da Bia', '00000000-0000-7000-8000-0000000045a2',
   '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '111'),
  ('00000000-0000-7000-8000-0000000045d6', 'Mesmo bot', '00000000-0000-7000-8000-0000000045a3',
   '123456:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '222'),
  ('00000000-0000-7000-8000-0000000045d7', 'Outro bot', NULL, '654321:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', '333');

SELECT is(pg_temp.err($$UPDATE message_destinations SET inbound_enabled = true,
                                                       webhook_secret_hash = telegram_secret_hash('x')
                         WHERE id = '00000000-0000-7000-8000-0000000045d5'$$),
          '23514 message_destinations_inbound_check', 'entrada sem agente');
SELECT is(pg_temp.err($$UPDATE message_destinations SET inbound_enabled = true,
                                                       inbound_agent_id = '00000000-0000-7000-8000-0000000045b1'
                         WHERE id = '00000000-0000-7000-8000-0000000045d5'$$),
          '23514 message_destinations_inbound_check', 'entrada sem segredo');
SELECT is(pg_temp.err($$UPDATE message_destinations SET webhook_secret_hash = 'segredo-cru'
                         WHERE id = '00000000-0000-7000-8000-0000000045d5'$$),
          '23514 message_destinations_webhook_secret_hash_check', 'só o hash é aceito');

SET LOCAL ROLE moneyflow_app;
SELECT is(pg_temp.err($$UPDATE message_destinations SET inbound_enabled = true,
                                                       inbound_agent_id = '00000000-0000-7000-8000-0000000045b1',
                                                       webhook_secret_hash = telegram_secret_hash('s3cr3t-Token_1')
                         WHERE id = '00000000-0000-7000-8000-0000000045d5'$$),
          'ok', 'app liga a entrada com agente e hash');
SELECT is(pg_temp.err($$SELECT webhook_secret_hash FROM message_destinations$$), '42501 ', 'app não lê o hash do segredo');
SELECT is(pg_temp.err($$SELECT * FROM message_destinations$$), '42501 ', 'app não faz SELECT * no destino');
SELECT results_eq($$SELECT inbound_enabled, inbound_agent_id FROM message_destinations
                     WHERE id = '00000000-0000-7000-8000-0000000045d5'$$,
                  $$VALUES (true, '00000000-0000-7000-8000-0000000045b1'::uuid)$$, 'app lê as colunas da entrada');
SELECT is(telegram_webhook_authenticate('00000000-0000-7000-8000-0000000045d5', 's3cr3t-Token_1'), true, 'segredo certo');
SELECT is(telegram_webhook_authenticate('00000000-0000-7000-8000-0000000045d5', 's3cr3t-token_1'), false, 'segredo errado');
SELECT is(telegram_webhook_authenticate('00000000-0000-7000-8000-0000000045d5', NULL), false, 'sem cabeçalho');
SELECT is(telegram_webhook_authenticate('00000000-0000-7000-8000-0000000045d7', 's3cr3t-Token_1'), false,
          'destino sem entrada');
SELECT is(telegram_webhook_authenticate('00000000-0000-7000-8000-0000000045d9', 's3cr3t-Token_1'), false,
          'destino inexistente');
RESET ROLE;

SELECT is(pg_temp.err($$UPDATE message_destinations SET inbound_enabled = true,
                                                       inbound_agent_id = '00000000-0000-7000-8000-0000000045b1',
                                                       webhook_secret_hash = telegram_secret_hash('outro')
                         WHERE id = '00000000-0000-7000-8000-0000000045d6'$$),
          '23505 message_destinations_inbound_bot_key', 'um webhook por bot');
SELECT is(pg_temp.err($$UPDATE message_destinations SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000045d5'$$),
          '23514 message_destinations_inbound_check', 'desativar exige desligar a entrada junto');
SELECT matches(pg_temp.err($$DELETE FROM ai_agents WHERE id = '00000000-0000-7000-8000-0000000045b1'$$),
               '^23503 ', 'agente em uso não é excluído');

-- Leitor do backup
SELECT is(pg_temp.err($$SELECT admin_message_destination_webhook_secret('00000000-0000-7000-8000-0000000045d5',
                                                                        '00000000-0000-7000-8000-0000000045a2')$$),
          '42501 ', 'leitor do backup: só admin');
SELECT is(pg_temp.err($$SELECT admin_message_destination_webhook_secret('00000000-0000-7000-8000-0000000045d9',
                                                                        '00000000-0000-7000-8000-0000000045a1')$$),
          'P0002 ', 'leitor do backup: destino inexistente');
SELECT is(admin_message_destination_webhook_secret('00000000-0000-7000-8000-0000000045d5',
                                                   '00000000-0000-7000-8000-0000000045a1'),
          telegram_secret_hash('s3cr3t-Token_1'), 'leitor do backup devolve o hash');
SELECT is(admin_message_destination_webhook_secret('00000000-0000-7000-8000-0000000045d7',
                                                   '00000000-0000-7000-8000-0000000045a1'),
          NULL, 'sem segredo: nulo');

-- Auditoria sem o segredo
SELECT ok((SELECT bool_and(NOT (coalesce(old_data, '{}') ? 'webhook_secret_hash')
                           AND NOT (coalesce(new_data, '{}') ? 'webhook_secret_hash'))
             FROM audit_log WHERE table_name = 'message_destinations'),
          'auditoria nunca grava o hash do segredo');
SELECT ok((SELECT 'webhook_secret_hash' = ANY (changed_columns) AND (new_data ->> 'inbound_enabled')::boolean
             FROM audit_log WHERE table_name = 'message_destinations' AND record_id = '00000000-0000-7000-8000-0000000045d5'
              AND action = 'update' ORDER BY created_at DESC, id DESC LIMIT 1),
          'a troca do segredo aparece em changed_columns');

-- Pareamento ---------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$SELECT * FROM telegram_pairing_code_create('00000000-0000-7000-8000-0000000045a2',
                                                                  '00000000-0000-7000-8000-0000000045d7', 'AB12CD34')$$),
          '23514 telegram_pairing_codes_destination_check', 'código só para destino com entrada');
SELECT is(pg_temp.err($$SELECT * FROM telegram_pairing_code_create('00000000-0000-7000-8000-0000000045a2',
                                                                  '00000000-0000-7000-8000-0000000045d5', 'AB12-D34')$$),
          '22023 ', 'código de 8 letras ou dígitos');
SET LOCAL ROLE moneyflow_app;
CREATE TEMP TABLE code1 AS
SELECT * FROM telegram_pairing_code_create('00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045d5',
                                           'ab12cd34');
SELECT is(pg_temp.err($$SELECT code_hash FROM telegram_pairing_codes$$), '42501 ', 'app não lê o hash do código');
SELECT is(pg_temp.err($$SELECT * FROM telegram_pairing_codes$$), '42501 ', 'app não faz SELECT * nos códigos');
SELECT ok((SELECT expires_at = created_at + interval '10 minutes' FROM telegram_pairing_codes
            WHERE id = (SELECT id FROM code1)), 'válido por 10 min');
SELECT is(pg_temp.err($$SELECT * FROM telegram_pairing_code_create('00000000-0000-7000-8000-0000000045a3',
                                                                  '00000000-0000-7000-8000-0000000045d5', 'AB12CD34')$$),
          '23505 telegram_pairing_codes_code_hash_key', 'código repetido: gere outro');
RESET ROLE;
SELECT is((SELECT code_hash FROM telegram_pairing_codes WHERE id = (SELECT id FROM code1)),
          telegram_secret_hash('AB12CD34'), 'guarda o hash do código em maiúsculas');
SELECT is(pg_temp.err($$INSERT INTO telegram_pairing_codes (user_id, destination_id, code_hash, expires_at) VALUES
  ('00000000-0000-7000-8000-0000000045a2', '00000000-0000-7000-8000-0000000045d5', telegram_secret_hash('ZZZZZZZZ'),
   now() + interval '11 minutes')$$),
          '23514 telegram_pairing_codes_expires_at_check', 'no máximo 10 min');
-- Um código já vencido (do Caio)
INSERT INTO telegram_pairing_codes (user_id, destination_id, code_hash, created_at, expires_at) VALUES
  ('00000000-0000-7000-8000-0000000045a3', '00000000-0000-7000-8000-0000000045d5', telegram_secret_hash('VENCIDO1'),
   now() - interval '20 minutes', now() - interval '10 minutes');
SELECT is(pg_temp.err($$SELECT * FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d5', 'AB12CD34', -100, 5)$$),
          '22023 ', 'só chat privado');

SELECT is(nullif(current_setting('app.user_id', true), ''), NULL, 'sem ator antes do pareamento');
SET LOCAL ROLE moneyflow_app;
SELECT is((SELECT count(*)::int FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d5', 'XXXXXXXX',
                                                              5001, 5001)), 0, 'código errado: nada');
SELECT is((SELECT count(*)::int FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d7', 'AB12CD34',
                                                              5001, 5001)), 0, 'código de outro destino: nada');
SELECT is((SELECT count(*)::int FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d5', 'VENCIDO1',
                                                              5001, 5001)), 0, 'código vencido: nada');
CREATE TEMP TABLE link1 AS
SELECT * FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d5', ' ab12cd34 ', 5001, 5001, '@bia_tg');
SELECT is((SELECT user_id FROM link1), '00000000-0000-7000-8000-0000000045a2'::uuid, 'pareado com o dono do código');
SELECT is((SELECT count(*)::int FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d5', 'AB12CD34',
                                                              5002, 5002)), 0, 'uso único');
RESET ROLE;
SELECT results_eq($$SELECT destination_id, user_id, chat_id, telegram_user_id, username, revoked_at FROM telegram_links
                     WHERE id = (SELECT link_id FROM link1)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000045d5'::uuid, '00000000-0000-7000-8000-0000000045a2'::uuid,
                            5001::bigint, 5001::bigint, 'bia_tg', NULL::timestamptz)$$, 'vínculo criado');
SELECT results_eq($$SELECT used_at IS NOT NULL, link_id FROM telegram_pairing_codes WHERE id = (SELECT id FROM code1)$$,
                  $$SELECT true, link_id FROM link1$$, 'código marcado como usado, com o vínculo');
SELECT is(current_setting('app.user_id', true), '00000000-0000-7000-8000-0000000045a2', 'o dono do código vira o ator');
SELECT results_eq($$SELECT user_id, actor_kind FROM audit_log WHERE table_name = 'telegram_links'
                     AND record_id = (SELECT link_id FROM link1) AND action = 'insert'$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000045a2'::uuid, 'human')$$, 'pareamento auditado com o ator');
SELECT ok((SELECT bool_and(NOT (coalesce(old_data, '{}') ? 'code_hash') AND NOT (coalesce(new_data, '{}') ? 'code_hash'))
             FROM audit_log WHERE table_name = 'telegram_pairing_codes'),
          'auditoria nunca grava o hash do código');
SELECT ok((SELECT count(*) > 0 FROM audit_log WHERE table_name = 'telegram_pairing_codes'), 'códigos auditados');

-- O mesmo chat pareado de novo pelo Caio: o vínculo da Bia é desfeito
CREATE TEMP TABLE code2 AS
SELECT * FROM telegram_pairing_code_create('00000000-0000-7000-8000-0000000045a3', '00000000-0000-7000-8000-0000000045d5',
                                           'CAIO2345');
CREATE TEMP TABLE link2 AS
SELECT * FROM telegram_pairing_consume('00000000-0000-7000-8000-0000000045d5', 'CAIO2345', 5001, 5001);
SELECT ok((SELECT revoked_at IS NOT NULL FROM telegram_links WHERE id = (SELECT link_id FROM link1)),
          'vínculo anterior do chat desfeito');
SELECT is((SELECT user_id FROM telegram_links WHERE destination_id = '00000000-0000-7000-8000-0000000045d5'
            AND chat_id = 5001 AND revoked_at IS NULL), '00000000-0000-7000-8000-0000000045a3'::uuid,
          'o chat agora é do Caio');
SELECT is(pg_temp.err($$INSERT INTO telegram_links (destination_id, user_id, chat_id, telegram_user_id) VALUES
  ('00000000-0000-7000-8000-0000000045d5', '00000000-0000-7000-8000-0000000045a2', 5001, 5001)$$),
          '23505 telegram_links_active_key', 'um vínculo ativo por destino e chat');
SELECT is(pg_temp.err($$UPDATE telegram_links SET revoked_at = NULL WHERE id = (SELECT link_id FROM link1)$$),
          '23514 telegram_links_revoked_check', 'desfazer é irreversível');
SELECT is(pg_temp.err($$UPDATE telegram_links SET user_id = '00000000-0000-7000-8000-0000000045a2'
                         WHERE id = (SELECT link_id FROM link2)$$),
          '23514 telegram_links_immutable_check', 'dono do vínculo imutável');
SELECT is(pg_temp.err($$UPDATE telegram_pairing_codes SET used_at = NULL WHERE id = (SELECT id FROM code1)$$),
          '23514 telegram_pairing_codes_immutable_check', 'código usado não volta');
SELECT is(pg_temp.err($$INSERT INTO telegram_links (destination_id, user_id, chat_id, telegram_user_id) VALUES
  ('00000000-0000-7000-8000-0000000045d5', '00000000-0000-7000-8000-0000000045a2', -5, 5)$$),
          '23514 telegram_links_chat_id_check', 'grupo não pareia');

-- Dedup de update_id -------------------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT is(telegram_update_seen('00000000-0000-7000-8000-0000000045d5', 100), false, 'primeira vez: processe');
SELECT is(telegram_update_seen('00000000-0000-7000-8000-0000000045d5', 100), true, 'repetido: ignore');
SELECT is(telegram_update_seen('00000000-0000-7000-8000-0000000045d7', 100), false, 'por destino');
RESET ROLE;
INSERT INTO telegram_updates_seen (destination_id, update_id, created_at) VALUES
  ('00000000-0000-7000-8000-0000000045d5', 1, now() - interval '8 days');
SET LOCAL ROLE moneyflow_app;
SELECT is(telegram_updates_seen_purge(), 1::bigint, 'purga os de mais de 7 dias');
SELECT is(pg_temp.err($$SELECT telegram_updates_seen_purge(interval '10 minutes')$$), '22023 ', 'prazo mínimo de 1 h');
RESET ROLE;

-- Notificação, evento e configuração --------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO notifications (user_id, kind, title) VALUES
  ('00000000-0000-7000-8000-0000000045a2', 'ai_awaiting_approval', 'A tarefa Resumo espera sua aprovação')$$),
          'ok', 'notificação ai_awaiting_approval');
SELECT is(pg_temp.err($$INSERT INTO message_subscriptions (destination_id, event_kind, params) VALUES
  ('00000000-0000-7000-8000-0000000045d5', 'ai_awaiting_approval', '{}')$$), 'ok', 'evento ai_awaiting_approval');
SELECT is(message_subscription_params_valid('ai_awaiting_approval', '{"send_at": "08:00"}'), false,
          'ai_awaiting_approval sem parâmetros');
SELECT ok(pg_get_constraintdef(oid) ~ 'ai_awaiting_approval', conname || ' aceita ai_awaiting_approval')
  FROM pg_constraint WHERE conname = 'message_outbox_event_kind_check';

SELECT is(app_setting_valid('telegram.public_base_url', v::jsonb), e, format('telegram.public_base_url %s = %s', v, e))
  FROM (VALUES ('"https://moneyflow.example.com"', true), ('"https://moneyflow.example.com:8443/base/app"', true),
               ('"https://localhost"', true), ('"http://moneyflow.example.com"', false),
               ('"https://moneyflow.example.com/"', false), ('"https://moneyflow.example.com/?a=1"', false),
               ('"https://moneyflow.example.com#x"', false), ('"https://"', false), ('"https://a b.com"', false),
               ('1', false), ('null', false), ('["https://x.com"]', false)) AS v (v, e);
SELECT is(pg_temp.err($$INSERT INTO app_settings (key, value) VALUES ('telegram.public_base_url', '"https://mf.example.com"')$$),
          'ok', 'grava telegram.public_base_url');
SELECT is(pg_temp.err($$INSERT INTO app_settings (key, value) VALUES ('telegram.webhook_url', '"https://mf.example.com"')$$),
          '23514 app_settings_value_check', 'chave desconhecida continua inválida');

SELECT * FROM finish();
ROLLBACK;
