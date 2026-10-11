-- Testes de 0021_notifications: notificações do sino por usuário.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('notifications');
SELECT columns_are('notifications', ARRAY['id', 'user_id', 'kind', 'title', 'body', 'link', 'caixa_id', 'data', 'dedup_key',
                                          'read_at', 'created_at', 'updated_at']);
SELECT fk_ok('notifications', 'user_id', 'users', 'id');
SELECT fk_ok('notifications', 'caixa_id', 'caixas', 'id');
SELECT has_index('notifications', 'notifications_unread_idx');

INSERT INTO users (id, username, email, password) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'x'),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'x');
INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick');
INSERT INTO caixas (id, name, kind, holder_entity_id) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001');

INSERT INTO notifications (id, user_id, kind, title, body, link, dedup_key) VALUES
  ('00000000-0000-7000-8000-00000000a001', '00000000-0000-7000-8000-0000000000a1', 'agent_completed', 'Agente concluiu',
   'Conciliação de outubro pronta', '/agents/conversations/1', 'agent_run:1');
INSERT INTO notifications (user_id, kind, title, caixa_id, data) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'mirror_pending', 'Título aguardando aceite', '00000000-0000-7000-8000-0000000c0001',
   '{"title_id": "x"}');
SELECT is((SELECT count(*)::int FROM notifications WHERE user_id = '00000000-0000-7000-8000-0000000000a1' AND read_at IS NULL), 2,
          'não lidas');
UPDATE notifications SET read_at = now() WHERE id = '00000000-0000-7000-8000-00000000a001';
SELECT is((SELECT count(*)::int FROM notifications WHERE user_id = '00000000-0000-7000-8000-0000000000a1' AND read_at IS NULL), 1,
          'marcar como lida');

WITH x AS (
  INSERT INTO notifications (user_id, kind, title, dedup_key)
  VALUES ('00000000-0000-7000-8000-0000000000a1', 'agent_completed', 'De novo', 'agent_run:1')
  ON CONFLICT (user_id, dedup_key) DO NOTHING RETURNING 1)
SELECT is((SELECT count(*)::int FROM x), 0, 'dedup por usuário');
SELECT lives_ok($$INSERT INTO notifications (user_id, kind, title, dedup_key)
                  VALUES ('00000000-0000-7000-8000-0000000000a2', 'agent_completed', 'Outro usuário', 'agent_run:1')$$,
                'mesma chave para outro usuário');
SELECT lives_ok($$INSERT INTO notifications (user_id, kind, title, link) VALUES ('00000000-0000-7000-8000-0000000000a2', 'system', 'Raiz', '/')$$,
                'link para a raiz');

SELECT throws_ok($$INSERT INTO notifications (user_id, kind, title) VALUES ('00000000-0000-7000-8000-0000000000a1', 'boom', 'x')$$,
                 '23514', NULL, 'tipo inválido');
SELECT throws_ok($$INSERT INTO notifications (user_id, kind, title) VALUES ('00000000-0000-7000-8000-0000000000a1', 'system', '  ')$$,
                 '23514', NULL, 'título em branco');
SELECT throws_ok($$INSERT INTO notifications (user_id, kind, title, link)
                   VALUES ('00000000-0000-7000-8000-0000000000a1', 'system', 'x', 'https://evil.example.com')$$,
                 '23514', NULL, 'link externo');
SELECT throws_ok($$INSERT INTO notifications (user_id, kind, title, link)
                   VALUES ('00000000-0000-7000-8000-0000000000a1', 'system', 'x', '//evil.example.com')$$,
                 '23514', NULL, 'link relativo ao protocolo');
SELECT throws_ok($$INSERT INTO notifications (user_id, kind, title, data) VALUES ('00000000-0000-7000-8000-0000000000a1', 'system', 'x', '[]')$$,
                 '23514', NULL, 'data é objeto');

DELETE FROM caixas WHERE id = '00000000-0000-7000-8000-0000000c0001';
SELECT is((SELECT count(*)::int FROM notifications WHERE kind = 'mirror_pending' AND caixa_id IS NULL), 1,
          'excluir a caixa mantém a notificação');
DELETE FROM users WHERE id = '00000000-0000-7000-8000-0000000000a2';
SELECT is((SELECT count(*)::int FROM notifications WHERE user_id = '00000000-0000-7000-8000-0000000000a2'), 0,
          'excluir o usuário leva as notificações');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'notifications'), 0, 'fora da auditoria');

SELECT ok(has_table_privilege('moneyflow_app', 'notifications', p), 'app tem ' || p)
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;

SELECT * FROM finish();
ROLLBACK;
