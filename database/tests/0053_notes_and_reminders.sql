-- Testes de 0053_notes_and_reminders (spec 035, F21): anotações (tipos, escopo, título, corpo, vínculo com a entidade
-- pela FK da coluna gerada, autor imutável, sem DELETE), lembretes (checagens, nota reminder e data = início no COMMIT,
-- next_fire_at mantido pelo banco, arquivar/desarquivar), cálculo do próximo disparo (todo dia, a cada X dias, dia 31
-- em fevereiro, fim da vigência, uma vez) e do último previsto, expansão das ocorrências, disparos (claim com o
-- perdido uma vez só, dedup, autor inativo, adiamento e re-disparo, imutáveis, lido × adiado), preferências do
-- usuário, calendário com a visibilidade, auditoria e a notificação/evento note_reminder.
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
-- Executa e roda as checagens deferidas (como no COMMIT); em erro, desfaz tudo.
CREATE FUNCTION pg_temp.commit_err(cmd text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  cn text;
BEGIN
  EXECUTE cmd;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
  RETURN st || ' ' || coalesce(cn, '');
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO moneyflow_app;

-- Estrutura ----------------------------------------------------------------------------------------------------------
SELECT has_table(t) FROM unnest(ARRAY['notes', 'note_reminders', 'note_reminder_firings', 'user_reminder_settings']) t;
SELECT columns_are('notes', ARRAY['id', 'author_id', 'kind', 'scope', 'title', 'body', 'note_date', 'object_type',
  'object_id', 'entity_id', 'archived_at', 'created_at', 'updated_at']);
SELECT columns_are('note_reminders', ARRAY['note_id', 'time_of_day', 'repeat', 'every_n_days', 'month_day', 'starts_on',
  'ends_on', 'sound', 'ring_seconds', 'send_telegram', 'is_active', 'next_fire_at', 'created_at', 'updated_at']);
SELECT columns_are('note_reminder_firings', ARRAY['id', 'note_id', 'user_id', 'scheduled_for', 'fired_at',
  'last_fired_at', 'read_at', 'snoozed_until', 'snooze_count', 'created_at', 'updated_at']);
SELECT columns_are('user_reminder_settings', ARRAY['user_id', 'sound', 'ring_seconds', 'created_at', 'updated_at']);
SELECT col_default_is('notes', 'scope', 'private');
SELECT col_default_is('note_reminders', 'time_of_day', '09:00:00');
SELECT col_default_is('note_reminders', 'send_telegram', 'false');
SELECT col_default_is('user_reminder_settings', 'ring_seconds', '30');
SELECT is((SELECT attgenerated::text FROM pg_attribute WHERE attrelid = 'notes'::regclass AND attname = 'entity_id'), 's',
          'entity_id é coluna gerada armazenada');
SELECT results_eq($$SELECT conrelid::regclass::text COLLATE "default", conname::text COLLATE "default", confdeltype::text
                      FROM pg_constraint
                     WHERE contype = 'f' AND conrelid IN ('notes'::regclass, 'note_reminders'::regclass,
                           'note_reminder_firings'::regclass, 'user_reminder_settings'::regclass)
                     ORDER BY 1, 2$$,
                  $$VALUES ('note_reminder_firings', 'note_reminder_firings_note_id_fkey', 'c'),
                           ('note_reminder_firings', 'note_reminder_firings_user_id_fkey', 'c'),
                           ('note_reminders', 'note_reminders_note_id_fkey', 'c'),
                           ('notes', 'notes_author_id_fkey', 'a'),
                           ('notes', 'notes_entity_id_fkey', 'a'),
                           ('user_reminder_settings', 'user_reminder_settings_user_id_fkey', 'c')$$,
                  'FKs: entidade e autor com nota não são excluídos; lembrete e disparos somem com a nota');
SELECT has_index(t, i) FROM (VALUES
  ('notes', 'notes_author_id_idx'), ('notes', 'notes_entity_id_idx'), ('notes', 'notes_object_idx'),
  ('notes', 'notes_note_date_idx'), ('notes', 'notes_title_trgm_idx'), ('notes', 'notes_body_trgm_idx'),
  ('note_reminders', 'note_reminders_due_idx'), ('note_reminder_firings', 'note_reminder_firings_user_idx'),
  ('note_reminder_firings', 'note_reminder_firings_unread_idx'),
  ('note_reminder_firings', 'note_reminder_firings_snoozed_idx')) AS v (t, i);
SELECT has_trigger(t, g) FROM (VALUES
  ('notes', 'notes_audit'), ('notes', 'notes_before_write'), ('notes', 'notes_sync_reminder'),
  ('notes', 'notes_reminder_integrity_check'), ('note_reminders', 'note_reminders_audit'),
  ('note_reminders', 'note_reminders_before_write'), ('note_reminders', 'note_reminders_integrity_check'),
  ('note_reminder_firings', 'note_reminder_firings_before_write'),
  ('user_reminder_settings', 'user_reminder_settings_audit')) AS v (t, g);
SELECT hasnt_trigger('note_reminder_firings', 'note_reminder_firings_audit');

-- Privilégios
SELECT ok(has_table_privilege('moneyflow_app', t, p), format('app: %s em %s', p, t))
  FROM (VALUES ('notes', 'SELECT'), ('notes', 'INSERT'), ('notes', 'UPDATE'),
               ('note_reminders', 'SELECT'), ('note_reminders', 'INSERT'), ('note_reminders', 'UPDATE'),
               ('note_reminders', 'DELETE'), ('note_reminder_firings', 'SELECT'), ('note_reminder_firings', 'INSERT'),
               ('note_reminder_firings', 'UPDATE'), ('user_reminder_settings', 'SELECT'),
               ('user_reminder_settings', 'INSERT'), ('user_reminder_settings', 'UPDATE'),
               ('user_reminder_settings', 'DELETE')) AS v (t, p);
SELECT ok(NOT has_table_privilege('moneyflow_app', t, 'DELETE'), 'app não exclui de ' || t)
  FROM unnest(ARRAY['notes', 'note_reminder_firings']) t;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['note_reminder_claim(integer)', 'note_calendar(date, date, uuid, uuid)',
                    'note_occurrences(date, date, uuid, uuid, boolean)',
                    'note_reminder_next_fire(text, time, date, date, integer, integer, timestamptz)',
                    'note_reminder_prev_fire(text, time, date, date, integer, integer, timestamptz)',
                    'note_reminder_occurrences(text, date, date, integer, integer, date, date)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'public não executa ' || f)
  FROM unnest(ARRAY['note_reminder_claim(integer)', 'note_calendar(date, date, uuid, uuid)']) f;
SELECT ok(NOT has_function_privilege('moneyflow_app', 'note_reminders_audit_row()', 'EXECUTE'),
          'app não executa o trigger de auditoria');

-- Cálculo do próximo disparo (puro) -----------------------------------------------------------------------------------
SELECT is(note_reminder_next_fire(r, t::time, s::date, e::date, n, md, a::timestamptz), x::timestamptz, d)
  FROM (VALUES
    ('daily', '09:00', '2026-10-01', NULL, NULL, NULL, '2026-10-21 08:00-03', '2026-10-21 09:00-03', 'todo dia: hoje, antes do horário'),
    ('daily', '09:00', '2026-10-01', NULL, NULL, NULL, '2026-10-21 09:00-03', '2026-10-22 09:00-03', 'todo dia: estritamente depois'),
    ('daily', '09:00', '2026-10-01', NULL, NULL, NULL, '2026-09-01 12:00-03', '2026-10-01 09:00-03', 'todo dia: antes do início'),
    ('daily', '23:30', '2026-10-01', NULL, NULL, NULL, '2026-10-22 01:00+00', '2026-10-21 23:30-03', 'todo dia: dia no fuso de São Paulo'),
    ('daily', '09:00', '2026-10-01', '2026-10-21', NULL, NULL, '2026-10-21 08:00-03', '2026-10-21 09:00-03', 'fim da vigência: o último dia ainda dispara'),
    ('daily', '09:00', '2026-10-01', '2026-10-21', NULL, NULL, '2026-10-21 09:00-03', NULL, 'fim da vigência: depois do último, nada'),
    ('every_n_days', '09:00', '2026-10-01', NULL, 3, NULL, '2026-10-21 10:00-03', '2026-10-22 09:00-03', 'a cada 3 dias a partir do início'),
    ('every_n_days', '09:00', '2026-10-01', NULL, 3, NULL, '2026-10-22 09:00-03', '2026-10-25 09:00-03', 'a cada 3 dias: o seguinte'),
    ('every_n_days', '09:00', '2026-10-01', '2026-10-24', 3, NULL, '2026-10-22 09:00-03', NULL, 'a cada 3 dias: o seguinte passa do fim'),
    ('monthly_day', '09:00', '2026-01-01', NULL, NULL, 31, '2026-02-01 00:00-03', '2026-02-28 09:00-03', 'dia 31 em fevereiro = 28'),
    ('monthly_day', '09:00', '2028-01-01', NULL, NULL, 31, '2028-02-01 00:00-03', '2028-02-29 09:00-03', 'dia 31 em fevereiro bissexto = 29'),
    ('monthly_day', '09:00', '2026-01-01', NULL, NULL, 31, '2026-02-28 09:00-03', '2026-03-31 09:00-03', 'dia 31: depois de fevereiro, 31 de março'),
    ('monthly_day', '09:00', '2026-01-01', NULL, NULL, 31, '2026-04-01 00:00-03', '2026-04-30 09:00-03', 'dia 31 em abril = 30'),
    ('monthly_day', '09:00', '2026-10-20', NULL, NULL, 15, '2026-10-01 00:00-03', '2026-11-15 09:00-03', 'dia 15: o primeiro depois do início'),
    ('monthly_day', '09:00', '2026-10-01', NULL, NULL, 10, '2026-10-10 09:00-03', '2026-11-10 09:00-03', 'dia 10: o mês seguinte'),
    ('once', '09:00', '2026-10-21', NULL, NULL, NULL, '2026-01-01 00:00-03', '2026-10-21 09:00-03', 'uma vez: no início'),
    ('once', '09:00', '2026-10-21', NULL, NULL, NULL, '2026-10-21 08:59-03', '2026-10-21 09:00-03', 'uma vez: antes do horário'),
    ('once', '09:00', '2026-10-21', NULL, NULL, NULL, '2026-10-21 09:00-03', NULL, 'uma vez: depois, nunca mais'),
    ('once', '09:00', '2026-10-21', NULL, NULL, NULL, '2026-12-01 00:00-03', NULL, 'uma vez: passado')
  ) AS v (r, t, s, e, n, md, a, x, d);

SELECT is(note_reminder_prev_fire(r, t::time, s::date, e::date, n, md, a::timestamptz), x::timestamptz, d)
  FROM (VALUES
    ('daily', '09:00', '2026-10-01', NULL, NULL, NULL, '2026-10-21 08:59-03', '2026-10-20 09:00-03', 'último previsto: ontem'),
    ('daily', '09:00', '2026-10-01', NULL, NULL, NULL, '2026-10-21 09:00-03', '2026-10-21 09:00-03', 'último previsto: no horário'),
    ('daily', '09:00', '2026-10-01', NULL, NULL, NULL, '2026-10-01 08:00-03', NULL, 'antes do primeiro: nenhum'),
    ('daily', '09:00', '2026-10-01', '2026-10-10', NULL, NULL, '2026-10-21 12:00-03', '2026-10-10 09:00-03', 'depois do fim: o último dia'),
    ('every_n_days', '09:00', '2026-10-01', NULL, 3, NULL, '2026-10-21 12:00-03', '2026-10-19 09:00-03', 'a cada 3 dias: o último'),
    ('monthly_day', '09:00', '2026-01-01', NULL, NULL, 31, '2026-03-15 12:00-03', '2026-02-28 09:00-03', 'dia 31: fevereiro'),
    ('monthly_day', '09:00', '2026-10-20', NULL, NULL, 15, '2026-11-01 12:00-03', NULL, 'dia 15: o de outubro é antes do início'),
    ('once', '09:00', '2026-10-21', NULL, NULL, NULL, '2026-12-01 00:00-03', '2026-10-21 09:00-03', 'uma vez: o único')
  ) AS v (r, t, s, e, n, md, a, x, d);

SELECT results_eq($$SELECT * FROM note_reminder_occurrences('monthly_day', '2026-01-01', NULL, NULL, 31,
                                                           '2026-01-01', '2026-04-30')$$,
                  $$VALUES ('2026-01-31'::date), ('2026-02-28'), ('2026-03-31'), ('2026-04-30')$$,
                  'ocorrências do dia 31 no último dia dos meses curtos');
SELECT results_eq($$SELECT * FROM note_reminder_occurrences('every_n_days', '2026-10-01', '2026-10-25', 3, NULL,
                                                           '2026-10-20', '2026-10-31')$$,
                  $$VALUES ('2026-10-22'::date), ('2026-10-25')$$, 'a cada 3 dias até o fim');
SELECT is((SELECT count(*)::int FROM note_reminder_occurrences('daily', '2026-01-01', NULL, NULL, NULL,
                                                               '2026-01-01', '2026-12-31')), 365, 'todo dia no ano');
SELECT is((SELECT count(*)::int FROM note_reminder_occurrences('once', '2026-10-21', NULL, NULL, NULL,
                                                               '2026-11-01', '2026-11-30')), 0, 'uma vez fora do período');
SELECT is(pg_temp.err($$SELECT * FROM note_reminder_occurrences('daily', '2026-01-01', NULL, NULL, NULL,
                                                              '2026-01-01', '2029-12-31')$$),
          '22023 ', 'período acima de 1100 dias');

-- Dados base ---------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000053a1', 'admin53', 'admin53@example.com', 'segredo', 'admin', true),
  ('00000000-0000-7000-8000-0000000053a2', 'ana53', 'ana53@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000053a3', 'beto53', 'beto53@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000053a4', 'ina53', 'ina53@example.com', 'segredo', 'user', true);
INSERT INTO entities (id, kind, name) VALUES
  ('00000000-0000-7000-8000-0000000053e1', 'company', 'Fornecedor 53'),
  ('00000000-0000-7000-8000-0000000053e2', 'person', 'Cliente 53'),
  ('00000000-0000-7000-8000-0000000053e3', 'person', 'Sem notas 53');

SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000053a2', true);
SELECT set_config('app.actor_kind', 'human', true);

-- Anotações ----------------------------------------------------------------------------------------------------------
INSERT INTO notes (id, author_id, kind, title, body, note_date, object_type, object_id) VALUES
  ('00000000-0000-7000-8000-000000053101', '00000000-0000-7000-8000-0000000053a2', 'severe', 'Atrasa sempre',
   '**cuidado**', '2026-10-05', 'entity', '00000000-0000-7000-8000-0000000053e1');
INSERT INTO notes (id, author_id, kind, scope, title, body, note_date, object_type, object_id) VALUES
  ('00000000-0000-7000-8000-000000053102', '00000000-0000-7000-8000-0000000053a3', 'good', 'global', 'Bom pagador',
   E'  \n ', '2026-10-05', 'entity', '00000000-0000-7000-8000-0000000053e2'),
  ('00000000-0000-7000-8000-000000053103', '00000000-0000-7000-8000-0000000053a3', 'bad', 'private', 'Privada do Beto',
   NULL, '2026-10-06', 'entity', '00000000-0000-7000-8000-0000000053e1');
SELECT is((SELECT entity_id FROM notes WHERE id = '00000000-0000-7000-8000-000000053101'),
          '00000000-0000-7000-8000-0000000053e1'::uuid, 'entity_id gerada do objeto');
SELECT is((SELECT scope FROM notes WHERE id = '00000000-0000-7000-8000-000000053101'), 'private', 'privada por padrão');
SELECT is((SELECT body FROM notes WHERE id = '00000000-0000-7000-8000-000000053102'), NULL, 'corpo em branco vira nulo');
SELECT is(pg_temp.err($$INSERT INTO notes (author_id, kind, title, object_type, object_id) VALUES
            ('00000000-0000-7000-8000-0000000053a2', 'info', 'Hoje', 'entity', '00000000-0000-7000-8000-0000000053e3')$$),
          'ok', 'nota com a data padrão');
SELECT is((SELECT note_date FROM notes WHERE title = 'Hoje'), (now() AT TIME ZONE 'America/Sao_Paulo')::date,
          'data padrão = hoje em São Paulo');

SELECT is(pg_temp.err(format($$INSERT INTO notes (author_id, kind, scope, title, object_type, object_id)
                                VALUES ('00000000-0000-7000-8000-0000000053a2', %L, %L, %L, %L, %L)$$, k, s, t, ot, oid)),
          e, d)
  FROM (VALUES
    ('urgent', 'private', 'x', 'entity', '00000000-0000-7000-8000-0000000053e1', '23514 notes_kind_check', 'tipo desconhecido'),
    ('info', 'team', 'x', 'entity', '00000000-0000-7000-8000-0000000053e1', '23514 notes_scope_check', 'escopo desconhecido'),
    ('info', 'private', '  ', 'entity', '00000000-0000-7000-8000-0000000053e1', '23514 notes_title_check', 'título em branco'),
    ('info', 'private', repeat('a', 121), 'entity', '00000000-0000-7000-8000-0000000053e1', '23514 notes_title_check', 'título acima de 120'),
    ('info', 'private', repeat('a', 120), 'entity', '00000000-0000-7000-8000-0000000053e1', 'ok', 'título de 120'),
    ('info', 'private', 'x', 'caixa', '00000000-0000-7000-8000-0000000053e1', '23514 notes_object_type_check', 'objeto de tipo desconhecido'),
    ('info', 'private', 'x', 'entity', '00000000-0000-7000-8000-0000000053ff', '23503 notes_entity_id_fkey', 'entidade inexistente')
  ) AS v (k, s, t, ot, oid, e, d);
SELECT is(pg_temp.err($$INSERT INTO notes (author_id, kind, title, object_type, object_id, entity_id) VALUES
            ('00000000-0000-7000-8000-0000000053a2', 'info', 'x', 'entity', '00000000-0000-7000-8000-0000000053e1',
             '00000000-0000-7000-8000-0000000053e1')$$),
          '428C9 ', 'entity_id não se grava');
SELECT is(pg_temp.err($$INSERT INTO notes (author_id, kind, title, body, object_type, object_id) VALUES
            ('00000000-0000-7000-8000-0000000053a2', 'info', 'x', repeat('a', 100001), 'entity',
             '00000000-0000-7000-8000-0000000053e1')$$),
          '23514 notes_body_check', 'corpo acima de 100 mil');
SELECT is(pg_temp.err($$UPDATE notes SET author_id = '00000000-0000-7000-8000-0000000053a3'
                         WHERE id = '00000000-0000-7000-8000-000000053101'$$),
          '23514 notes_author_immutable_check', 'autor imutável');
SELECT is(pg_temp.err($$UPDATE notes SET object_id = '00000000-0000-7000-8000-0000000053e2'
                         WHERE id = '00000000-0000-7000-8000-000000053101'$$),
          'ok', 'trocar a entidade');
SELECT is((SELECT entity_id FROM notes WHERE id = '00000000-0000-7000-8000-000000053101'),
          '00000000-0000-7000-8000-0000000053e2'::uuid, 'entity_id acompanha o objeto');
UPDATE notes SET object_id = '00000000-0000-7000-8000-0000000053e1' WHERE id = '00000000-0000-7000-8000-000000053101';
SELECT is(pg_temp.err($$DELETE FROM entities WHERE id = '00000000-0000-7000-8000-0000000053e1'$$),
          '23503 notes_entity_id_fkey', 'entidade com notas não é excluída');
SELECT is(pg_temp.err($$UPDATE entities SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000053e2'$$),
          'ok', 'entidade arquivada mantém as notas');
SELECT is((SELECT count(*)::int FROM notes WHERE entity_id = '00000000-0000-7000-8000-0000000053e2'), 1,
          'nota da entidade arquivada continua');

SET ROLE moneyflow_app;
SELECT is(pg_temp.err($$DELETE FROM notes WHERE id = '00000000-0000-7000-8000-000000053103'$$), '42501 ',
          'app não exclui nota (arquiva)');
SELECT is(pg_temp.err($$UPDATE notes SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000053103'$$), 'ok',
          'app arquiva nota');
RESET ROLE;
UPDATE notes SET archived_at = NULL WHERE id = '00000000-0000-7000-8000-000000053103';

-- Lembretes: checagens ------------------------------------------------------------------------------------------------
INSERT INTO notes (id, author_id, kind, title, note_date, object_type, object_id) VALUES
  ('00000000-0000-7000-8000-000000053201', '00000000-0000-7000-8000-0000000053a2', 'reminder', 'Cobrar', '2026-10-01',
   'entity', '00000000-0000-7000-8000-0000000053e1');

SELECT is(pg_temp.err(format($$INSERT INTO note_reminders (note_id, time_of_day, repeat, every_n_days, month_day,
                                  starts_on, ends_on, sound, ring_seconds)
                                VALUES ('00000000-0000-7000-8000-000000053201', %L, %L, %s, %s, '2026-10-01', %L, %L, %s)$$,
                               t, r, coalesce(n::text, 'NULL'), coalesce(md::text, 'NULL'), e, so,
                               coalesce(rs::text, 'NULL'))) LIKE x || '%', true, d)
  FROM (VALUES
    ('09:00:30', 'daily', NULL, NULL, NULL, NULL, NULL, '23514 note_reminders_time_of_day_check', 'horário com segundos'),
    ('09:00', 'weekly', NULL, NULL, NULL, NULL, NULL, '23514 note_reminders_repeat_check', 'repetição desconhecida'),
    ('09:00', 'every_n_days', NULL, NULL, NULL, NULL, NULL, '23514 note_reminders_every_n_days_check', 'a cada X sem o X'),
    ('09:00', 'every_n_days', 1, NULL, NULL, NULL, NULL, '23514 note_reminders_every_n_days_check', 'a cada 1 dia'),
    ('09:00', 'every_n_days', 366, NULL, NULL, NULL, NULL, '23514 note_reminders_every_n_days_check', 'a cada 366 dias'),
    ('09:00', 'daily', 3, NULL, NULL, NULL, NULL, '23514 note_reminders_every_n_days_check', 'X fora de every_n_days'),
    ('09:00', 'monthly_day', NULL, NULL, NULL, NULL, NULL, '23514 note_reminders_month_day_check', 'mensal sem o dia'),
    ('09:00', 'monthly_day', NULL, 32, NULL, NULL, NULL, '23514 note_reminders_month_day_check', 'dia 32'),
    ('09:00', 'daily', NULL, 10, NULL, NULL, NULL, '23514 note_reminders_month_day_check', 'dia fora do mensal'),
    ('09:00', 'daily', NULL, NULL, '2026-09-30', NULL, NULL, '23514 note_reminders_ends_on_check', 'fim antes do início'),
    ('09:00', 'once', NULL, NULL, '2026-10-30', NULL, NULL, '23514 note_reminders_ends_on_check', 'fim no uma vez'),
    ('09:00', 'daily', NULL, NULL, NULL, 'Sino!', NULL, '23514 note_reminders_sound_check', 'chave de som inválida'),
    ('09:00', 'daily', NULL, NULL, NULL, NULL, 4, '23514 note_reminders_ring_seconds_check', 'toque de 4 s'),
    ('09:00', 'daily', NULL, NULL, NULL, NULL, 601, '23514 note_reminders_ring_seconds_check', 'toque de 601 s')
  ) AS v (t, r, n, md, e, so, rs, x, d);

-- No COMMIT: a nota é reminder e a data é o início.
SELECT is(pg_temp.commit_err($$INSERT INTO note_reminders (note_id, repeat, starts_on)
                               VALUES ('00000000-0000-7000-8000-000000053101', 'daily', '2026-10-05')$$),
          '23514 note_reminders_note_kind_check', 'lembrete só em nota reminder');
SELECT is(pg_temp.commit_err($$INSERT INTO note_reminders (note_id, repeat, starts_on)
                               VALUES ('00000000-0000-7000-8000-000000053201', 'daily', '2026-10-02')$$),
          '23514 note_reminders_note_date_check', 'início diferente da data da nota');
SELECT is(pg_temp.commit_err($$WITH n AS (
                                 INSERT INTO notes (id, author_id, kind, title, note_date, object_type, object_id)
                                 VALUES ('00000000-0000-7000-8000-000000053202', '00000000-0000-7000-8000-0000000053a2',
                                         'reminder', 'Junto', '2026-10-01', 'entity',
                                         '00000000-0000-7000-8000-0000000053e2') RETURNING id)
                               INSERT INTO note_reminders (note_id, repeat, starts_on, sound, ring_seconds)
                               SELECT id, 'daily', '2026-10-01', 'bell', 45 FROM n$$),
          'ok', 'nota e lembrete na mesma transação');
SELECT is(pg_temp.commit_err($$INSERT INTO note_reminders (note_id, time_of_day, repeat, starts_on)
                               VALUES ('00000000-0000-7000-8000-000000053201', '09:00', 'daily', '2026-10-01')$$),
          'ok', 'lembrete todo dia');
SELECT is(pg_temp.commit_err($$UPDATE notes SET kind = 'info' WHERE id = '00000000-0000-7000-8000-000000053202'$$),
          '23514 note_reminders_note_kind_check', 'nota com lembrete não deixa de ser reminder sozinha');
SELECT is(pg_temp.commit_err($$UPDATE notes SET note_date = '2026-10-03' WHERE id = '00000000-0000-7000-8000-000000053202'$$),
          '23514 note_reminders_note_date_check', 'data da nota acompanha o início');
SELECT is(pg_temp.commit_err($$WITH r AS (UPDATE note_reminders SET starts_on = '2026-10-03'
                                          WHERE note_id = '00000000-0000-7000-8000-000000053202' RETURNING note_id)
                               UPDATE notes SET note_date = '2026-10-03' WHERE id IN (SELECT note_id FROM r)$$),
          'ok', 'data e início mudam juntos');
SELECT is(pg_temp.commit_err($$WITH r AS (DELETE FROM note_reminders
                                          WHERE note_id = '00000000-0000-7000-8000-000000053202' RETURNING note_id)
                               UPDATE notes SET kind = 'info' WHERE id IN (SELECT note_id FROM r)$$),
          'ok', 'virar info excluindo o lembrete');
SELECT is(pg_temp.err($$UPDATE note_reminders SET note_id = '00000000-0000-7000-8000-000000053101'
                         WHERE note_id = '00000000-0000-7000-8000-000000053201'$$),
          '23514 note_reminders_note_immutable_check', 'nota do lembrete imutável');

-- next_fire_at mantido pelo banco
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          note_reminder_next_fire('daily', '09:00', '2026-10-01', NULL, NULL, NULL, now()),
          'próximo disparo calculado ao criar');
SELECT ok((SELECT next_fire_at > now() FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          'próximo disparo no futuro');
UPDATE note_reminders SET time_of_day = '07:15' WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          note_reminder_next_fire('daily', '07:15', '2026-10-01', NULL, NULL, NULL, now()), 'recalculado ao mudar o horário');
UPDATE note_reminders SET is_active = false WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'), NULL,
          'desligado: sem próximo disparo');
SELECT is(pg_temp.err($$UPDATE note_reminders SET next_fire_at = now() WHERE note_id = '00000000-0000-7000-8000-000000053201'$$),
          'ok', 'gravar next_fire_at desligado é ignorado');
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'), NULL,
          'desligado continua sem próximo disparo');
UPDATE note_reminders SET is_active = true WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT ok((SELECT next_fire_at IS NOT NULL FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          'religado: recalculado');
UPDATE notes SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'), NULL,
          'nota arquivada: sem próximo disparo');
UPDATE notes SET archived_at = NULL WHERE id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          note_reminder_next_fire('daily', '07:15', '2026-10-01', NULL, NULL, NULL, now()), 'desarquivada: recalculado');

-- Disparos -----------------------------------------------------------------------------------------------------------
-- Worker parado há 3 dias: o lembrete diário venceu 3 vezes e dispara uma só, no último horário previsto.
UPDATE note_reminders SET next_fire_at = next_fire_at - interval '3 days'
 WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          note_reminder_next_fire('daily', '07:15', '2026-10-01', NULL, NULL, NULL, now()) - interval '3 days',
          'next_fire_at gravado pelo worker fica');
CREATE TEMP TABLE claim1 AS SELECT * FROM note_reminder_claim(100);
SELECT is((SELECT count(*)::int FROM claim1 WHERE note_id = '00000000-0000-7000-8000-000000053201'), 1,
          'três perdidos viram um disparo');
SELECT results_eq($$SELECT user_id, title, kind, object_type, object_id, send_telegram, is_snooze_refire, snooze_count
                      FROM claim1 WHERE note_id = '00000000-0000-7000-8000-000000053201'$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000053a2'::uuid, 'Cobrar'::text, 'reminder'::text,
                            'entity'::text, '00000000-0000-7000-8000-0000000053e1'::uuid, false, false, 0)$$,
                  'o claim devolve o que o worker precisa');
SELECT is((SELECT scheduled_for FROM claim1 WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          note_reminder_prev_fire('daily', '07:15', '2026-10-01', NULL, NULL, NULL, clock_timestamp()),
          'o disparo é o último horário previsto');
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053201'),
          note_reminder_next_fire('daily', '07:15', '2026-10-01', NULL, NULL, NULL, clock_timestamp()),
          'próximo disparo avançado para depois de agora');
SELECT is((SELECT count(*)::int FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053201'), 0,
          'claim de novo: nada vencido');
SELECT is((SELECT count(*)::int FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'), 1,
          'um disparo no log');
SELECT is((SELECT read_at FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'), NULL,
          'disparo não lido');

-- Dedup: o mesmo horário previsto vencido de novo não grava outro disparo.
UPDATE note_reminders SET next_fire_at = (SELECT scheduled_for FROM claim1 WHERE note_id = '00000000-0000-7000-8000-000000053201')
 WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT count(*)::int FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053201'), 0,
          'mesmo horário previsto não repete');
SELECT is((SELECT count(*)::int FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'), 1,
          'dedup por (lembrete, horário previsto)');
SELECT ok((SELECT next_fire_at > clock_timestamp() - interval '1 second' FROM note_reminders
            WHERE note_id = '00000000-0000-7000-8000-000000053201'), 'e o próximo avança mesmo assim');

-- Uma vez: hoje à meia-noite (já passou), dispara uma vez e acaba.
WITH n AS (
  INSERT INTO notes (id, author_id, kind, title, note_date, object_type, object_id)
  VALUES ('00000000-0000-7000-8000-000000053203', '00000000-0000-7000-8000-0000000053a2', 'reminder', 'Uma vez',
          (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'entity', '00000000-0000-7000-8000-0000000053e1')
  RETURNING id, note_date)
INSERT INTO note_reminders (note_id, time_of_day, repeat, starts_on, send_telegram)
SELECT id, '00:00', 'once', note_date, true FROM n;
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053203'), NULL,
          'uma vez no passado: sem próximo disparo');
UPDATE note_reminders SET next_fire_at = ((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + time '00:00')
                                         AT TIME ZONE 'America/Sao_Paulo'
 WHERE note_id = '00000000-0000-7000-8000-000000053203';
CREATE TEMP TABLE claim2 AS SELECT * FROM note_reminder_claim(100);
SELECT is((SELECT count(*)::int FROM claim2 WHERE note_id = '00000000-0000-7000-8000-000000053203'), 1,
          'uma vez: dispara');
SELECT is((SELECT send_telegram FROM claim2 WHERE note_id = '00000000-0000-7000-8000-000000053203'), true,
          'com o Telegram ligado');
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053203'), NULL,
          'uma vez: depois do disparo, nada');

-- Fim da vigência: termina ontem, o último previsto é o de ontem e depois nada.
WITH n AS (
  INSERT INTO notes (id, author_id, kind, title, note_date, object_type, object_id)
  VALUES ('00000000-0000-7000-8000-000000053204', '00000000-0000-7000-8000-0000000053a2', 'reminder', 'Vigência',
          (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date - 10, 'entity', '00000000-0000-7000-8000-0000000053e1')
  RETURNING id, note_date)
INSERT INTO note_reminders (note_id, time_of_day, repeat, starts_on, ends_on)
SELECT id, '10:00', 'daily', note_date, note_date + 9 FROM n;
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053204'), NULL,
          'vigência terminada: sem próximo disparo');
UPDATE note_reminders SET next_fire_at = (starts_on + time '10:00') AT TIME ZONE 'America/Sao_Paulo'
 WHERE note_id = '00000000-0000-7000-8000-000000053204';
SELECT is((SELECT scheduled_for FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053204'),
          (((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date - 1) + time '10:00') AT TIME ZONE 'America/Sao_Paulo',
          'o perdido é o último dia da vigência');
SELECT is((SELECT next_fire_at FROM note_reminders WHERE note_id = '00000000-0000-7000-8000-000000053204'), NULL,
          'e depois do fim, nada');

-- Autor inativo e nota arquivada: avança sem disparar.
WITH n AS (
  INSERT INTO notes (id, author_id, kind, title, note_date, object_type, object_id)
  VALUES ('00000000-0000-7000-8000-000000053205', '00000000-0000-7000-8000-0000000053a4', 'reminder', 'Da Ina',
          '2026-01-01', 'entity', '00000000-0000-7000-8000-0000000053e1')
  RETURNING id, note_date)
INSERT INTO note_reminders (note_id, repeat, starts_on) SELECT id, 'daily', note_date FROM n;
UPDATE users SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000053a4';
UPDATE note_reminders SET next_fire_at = next_fire_at - interval '2 days'
 WHERE note_id = '00000000-0000-7000-8000-000000053205';
SELECT is((SELECT count(*)::int FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053205'), 0,
          'autor inativo: sem disparo');
SELECT ok((SELECT next_fire_at > clock_timestamp() - interval '1 second' FROM note_reminders
            WHERE note_id = '00000000-0000-7000-8000-000000053205'), 'autor inativo: o próximo avança');
SELECT is((SELECT count(*)::int FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053205'), 0,
          'autor inativo: nada no log');

SELECT is(pg_temp.err('SELECT * FROM note_reminder_claim(0)'), '22023 ', 'limite inválido');

-- Disparos: checagens e adiamento --------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO note_reminder_firings (note_id, user_id, scheduled_for)
                         VALUES ('00000000-0000-7000-8000-000000053201', '00000000-0000-7000-8000-0000000053a3', now())$$),
          '23514 note_reminder_firings_user_check', 'disparo só para o autor');
SELECT is(pg_temp.err($$UPDATE note_reminder_firings SET scheduled_for = scheduled_for + interval '1 minute'
                         WHERE note_id = '00000000-0000-7000-8000-000000053201'$$),
          '23514 note_reminder_firings_immutable_check', 'horário previsto imutável');
SELECT is(pg_temp.err($$UPDATE note_reminder_firings SET read_at = now(), snoozed_until = now() + interval '5 minutes'
                         WHERE note_id = '00000000-0000-7000-8000-000000053201'$$),
          '23514 note_reminder_firings_snooze_check', 'lido não fica adiado');

SET ROLE moneyflow_app;
SELECT is(pg_temp.err($$DELETE FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'$$),
          '42501 ', 'app não apaga disparo');
SELECT is(pg_temp.err($$UPDATE note_reminder_firings SET snoozed_until = now() + interval '10 minutes', snooze_count = 50
                         WHERE note_id = '00000000-0000-7000-8000-000000053201'$$),
          'ok', 'app adia');
RESET ROLE;
SELECT is((SELECT snooze_count FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'), 1,
          'contador de adiamentos do banco');
SELECT is((SELECT count(*)::int FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053201'), 0,
          'adiado no futuro não toca');
UPDATE note_reminder_firings SET snoozed_until = clock_timestamp() - interval '1 second'
 WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT snooze_count FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'), 2,
          'novo adiamento soma');
CREATE TEMP TABLE claim3 AS SELECT * FROM note_reminder_claim(100);
SELECT results_eq($$SELECT firing_id, is_snooze_refire, snooze_count, scheduled_for FROM claim3
                     WHERE note_id = '00000000-0000-7000-8000-000000053201'$$,
                  $$SELECT id, true, 2, scheduled_for FROM note_reminder_firings
                     WHERE note_id = '00000000-0000-7000-8000-000000053201'$$,
                  'adiado vencido toca de novo, o mesmo registro');
SELECT results_eq($$SELECT snoozed_until IS NULL, last_fired_at > fired_at, read_at IS NULL, snooze_count
                      FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'$$,
                  $$VALUES (true, true, true, 2)$$, 're-disparo limpa o adiamento e guarda o toque');
SELECT is((SELECT count(*)::int FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053201'), 1,
          'o adiamento não cria disparo novo');
SELECT is((SELECT count(*)::int FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053201'), 0,
          're-disparo uma vez só');
UPDATE note_reminder_firings SET read_at = now(), snoozed_until = NULL
 WHERE user_id = '00000000-0000-7000-8000-0000000053a2' AND read_at IS NULL;
SELECT is((SELECT count(*)::int FROM note_reminder_firings WHERE user_id = '00000000-0000-7000-8000-0000000053a2'
            AND read_at IS NULL), 0, 'marcar todos como lidos');

-- Adiado de lembrete desligado não toca.
UPDATE note_reminder_firings SET read_at = NULL, snoozed_until = clock_timestamp() - interval '1 second'
 WHERE note_id = '00000000-0000-7000-8000-000000053201';
UPDATE note_reminders SET is_active = false WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT count(*)::int FROM note_reminder_claim(100) WHERE note_id = '00000000-0000-7000-8000-000000053201'), 0,
          'adiado de lembrete desligado não toca');
UPDATE note_reminders SET is_active = true WHERE note_id = '00000000-0000-7000-8000-000000053201';

-- Excluir o lembrete leva os disparos.
SELECT is(pg_temp.commit_err($$WITH r AS (DELETE FROM note_reminders
                                          WHERE note_id = '00000000-0000-7000-8000-000000053203' RETURNING note_id)
                               UPDATE notes SET kind = 'info' WHERE id IN (SELECT note_id FROM r)$$),
          'ok', 'lembrete excluído');
SELECT is((SELECT count(*)::int FROM note_reminder_firings WHERE note_id = '00000000-0000-7000-8000-000000053203'), 0,
          'disparos somem com o lembrete');

-- Preferências -------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO user_reminder_settings (user_id, sound) VALUES ('00000000-0000-7000-8000-0000000053a2', 'chime')$$),
          'ok', 'preferências do usuário');
SELECT is((SELECT ring_seconds FROM user_reminder_settings WHERE user_id = '00000000-0000-7000-8000-0000000053a2'),
          30::smallint, '30 s por padrão');
SELECT is(pg_temp.err($$UPDATE user_reminder_settings SET ring_seconds = 601 WHERE user_id = '00000000-0000-7000-8000-0000000053a2'$$),
          '23514 user_reminder_settings_ring_seconds_check', 'segundos até 600');
SELECT is(pg_temp.err($$UPDATE user_reminder_settings SET sound = '../x' WHERE user_id = '00000000-0000-7000-8000-0000000053a2'$$),
          '23514 user_reminder_settings_sound_check', 'chave de som validada');

-- Calendário ---------------------------------------------------------------------------------------------------------
-- 101 severe privada da Ana (05/10, e1), 102 good global do Beto (05/10, e2), 103 bad privada do Beto (06/10, e1),
-- 201 lembrete diário da Ana desde 01/10, 'Hoje' info da Ana, 202 virou info (03/10), 203 virou info (hoje).
SELECT results_eq($$SELECT day, kind, notes FROM note_calendar('2026-10-01', '2026-10-06',
                                                               '00000000-0000-7000-8000-0000000053a2')$$,
                  $$VALUES ('2026-10-01'::date, 'reminder'::text, 1), ('2026-10-02', 'reminder', 1),
                           ('2026-10-03', 'info', 1), ('2026-10-03', 'reminder', 1), ('2026-10-04', 'reminder', 1),
                           ('2026-10-05', 'good', 1), ('2026-10-05', 'reminder', 1), ('2026-10-05', 'severe', 1),
                           ('2026-10-06', 'reminder', 1)$$,
                  'Ana vê as dela e as globais, com o lembrete expandido');
SELECT results_eq($$SELECT day, kind, notes FROM note_calendar('2026-10-05', '2026-10-06',
                                                               '00000000-0000-7000-8000-0000000053a3')$$,
                  $$VALUES ('2026-10-05'::date, 'good'::text, 1), ('2026-10-06', 'bad', 1)$$,
                  'Beto não vê as privadas da Ana');
SELECT results_eq($$SELECT day, kind, notes FROM note_calendar('2026-10-05', '2026-10-06')$$,
                  $$VALUES ('2026-10-05'::date, 'good'::text, 1), ('2026-10-05', 'reminder', 2),
                           ('2026-10-05', 'severe', 1), ('2026-10-06', 'bad', 1), ('2026-10-06', 'reminder', 2)$$,
                  'admin (nulo) vê todas, inclusive o lembrete privado da Ina');
SELECT results_eq($$SELECT day, kind, notes FROM note_calendar('2026-10-05', '2026-10-06', NULL,
                                                               '00000000-0000-7000-8000-0000000053e1')$$,
                  $$VALUES ('2026-10-05'::date, 'reminder'::text, 2), ('2026-10-05', 'severe', 1),
                           ('2026-10-06', 'bad', 1), ('2026-10-06', 'reminder', 2)$$,
                  'filtro pela entidade');
UPDATE notes SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000053101';
SELECT is((SELECT count(*)::int FROM note_calendar('2026-10-05', '2026-10-05') WHERE kind = 'severe'), 0,
          'arquivada sai do calendário');
SELECT is((SELECT count(*)::int FROM note_occurrences('2026-10-05', '2026-10-05', NULL, NULL, true)
            WHERE note_id = '00000000-0000-7000-8000-000000053101'), 1, 'arquivada com o filtro Arquivadas');
SELECT is(pg_temp.err($$SELECT * FROM note_calendar('2026-10-06', '2026-10-05')$$), '22023 ', 'período invertido');

-- Auditoria ----------------------------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'notes'
            AND record_id = '00000000-0000-7000-8000-000000053101' AND action = 'insert'), 1, 'nota auditada');
SELECT is((SELECT user_id FROM audit_log WHERE table_name = 'notes'
            AND record_id = '00000000-0000-7000-8000-000000053101' AND action = 'insert'),
          '00000000-0000-7000-8000-0000000053a2'::uuid, 'com o ator');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'note_reminders'
            AND record_id = '00000000-0000-7000-8000-000000053201' AND action = 'insert'), 1,
          'lembrete auditado no histórico da nota');
CREATE TEMP TABLE audit_before AS
  SELECT count(*) AS n FROM audit_log WHERE table_name = 'note_reminders';
UPDATE note_reminders SET next_fire_at = next_fire_at + interval '1 day'
 WHERE note_id = '00000000-0000-7000-8000-000000053201';
SELECT is((SELECT count(*) FROM audit_log WHERE table_name = 'note_reminders'), (SELECT n FROM audit_before),
          'avanço do próximo disparo não gera auditoria');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'user_reminder_settings'
            AND record_id = '00000000-0000-7000-8000-0000000053a2'), 1, 'preferências auditadas pelo usuário');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'note_reminder_firings'), 0,
          'disparos fora da auditoria');

-- Notificação e evento ------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err($$INSERT INTO notifications (user_id, kind, title, link, dedup_key) VALUES
            ('00000000-0000-7000-8000-0000000053a2', 'note_reminder', 'Cobrar', '/notes', 'note_reminder:x:0')$$),
          'ok', 'notificação note_reminder');
SELECT ok(pg_get_constraintdef(oid) ~ 'note_reminder', conname || ' aceita note_reminder')
  FROM pg_constraint WHERE conname = 'message_outbox_event_kind_check';
SELECT ok(pg_get_constraintdef(oid) !~ 'note_reminder', conname || ' sem note_reminder (sem assinatura)')
  FROM pg_constraint WHERE conname = 'message_subscriptions_event_kind_check';

SELECT * FROM finish();
ROLLBACK;
