-- Testes de 0015_audit_log: trigger genérico, ator da sessão, senha e conteúdo fora do log, só leitura.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table('audit_log');
SELECT columns_are('audit_log', ARRAY['id', 'table_name', 'record_id', 'action', 'old_data', 'new_data', 'changed_columns',
                                      'user_id', 'actor_kind', 'agent_run_id', 'transaction_id', 'created_at']);
SELECT has_index('audit_log', i) FROM unnest(ARRAY['audit_log_record_idx', 'audit_log_user_id_idx', 'audit_log_created_at_idx',
                                                   'audit_log_transaction_id_idx']) i;
SELECT has_function('audit_row');
SELECT has_function('audit_write', ARRAY['text', 'text', 'jsonb', 'jsonb', 'text[]', 'uuid']);

-- Toda tabela de negócio é auditada (exceto sessions e o próprio log).
SELECT is_empty($$
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     -- Estado de login, de interface e fila operacional ficam fora (0019–0021), assim como o volume dos
     -- agentes de IA: conversas, mensagens, execuções, eventos, confirmações, uso e embeddings (0026–0029),
     -- as requisições ao provedor com as tentativas (0040) e os caches da 0041 (derivados de anexo e índices de
     -- embeddings por par), além dos disparos das tarefas agendadas e da dedup do webhook do Telegram (0045) e das
     -- execuções das receitas de conciliação (0047) e dos disparos dos lembretes (0053).
     AND c.relname NOT IN ('sessions', 'audit_log', 'schema_migrations', 'canvas_node_positions', 'notifications',
                           'message_outbox', 'ai_conversations', 'ai_messages', 'ai_message_attachments', 'ai_runs',
                           'ai_run_events', 'ai_tool_confirmations', 'ai_usage', 'ai_embeddings', 'ai_requests',
                           'ai_request_attempts', 'ai_attachment_derivatives', 'ai_embedding_indexes',
                           'ai_scheduled_task_runs', 'telegram_updates_seen',
                           'ai_reconcile_recipe_runs', 'note_reminder_firings')
     AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = c.relname || '_audit')
$$, 'todas as tabelas de negócio têm trigger <tabela>_audit');

-- Sem ator: sistema ---------------------------------------------------------------------------------
INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e001', 'person', 'Patrick');
SELECT results_eq($$SELECT action, user_id, actor_kind, old_data IS NULL, new_data ->> 'name' FROM audit_log
                     WHERE table_name = 'entities' AND record_id = '00000000-0000-7000-8000-00000000e001'$$,
                  $$VALUES ('insert', NULL::uuid, 'system', true, 'Patrick')$$, 'insert sem app.user_id = system');
SELECT is((SELECT transaction_id FROM audit_log WHERE record_id = '00000000-0000-7000-8000-00000000e001'),
          pg_current_xact_id()::text::bigint, 'transaction_id da transação atual');

-- Ator humano e agente --------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo-123', 'admin');
SELECT ok(NOT EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'users' AND (new_data ? 'password' OR old_data ? 'password')),
          'insert de usuário sem a senha no log');
SELECT ok(NOT EXISTS (SELECT 1 FROM audit_log WHERE (new_data::text || coalesce(old_data::text, '')) LIKE '%segredo-123%'),
          'o valor da senha não aparece em lugar nenhum');

SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
UPDATE entities SET name = 'Patrick Brandão' WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT results_eq($$SELECT user_id, actor_kind, changed_columns, old_data ->> 'name', new_data ->> 'name' FROM audit_log
                     WHERE table_name = 'entities' AND action = 'update'$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000000a1'::uuid, 'human', ARRAY['name'],
                            'Patrick', 'Patrick Brandão')$$, 'update com app.user_id = humano, antes e depois');

-- (A execução do agente em app.agent_run_id é validada contra ai_runs: ver tests/0030_audit_agent_run.sql.)
SELECT set_config('app.actor_kind', 'agent', true);
UPDATE entities SET notes = 'via agente' WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT results_eq($$SELECT actor_kind, agent_run_id, user_id FROM audit_log
                     WHERE table_name = 'entities' AND changed_columns @> ARRAY['notes']$$,
                  $$VALUES ('agent', NULL::text, '00000000-0000-7000-8000-0000000000a1'::uuid)$$, 'agente agindo pelo usuário');
SELECT set_config('app.actor_kind', '', true);
SELECT set_config('app.agent_run_id', '', true);

-- Update sem mudança real não gera linha
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'entities'), 3, 'três linhas até aqui');
UPDATE entities SET name = name WHERE id = '00000000-0000-7000-8000-00000000e001';
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'entities'), 3, 'update que só toca updated_at não gera linha');

-- Senha: registra que mudou, sem o valor
UPDATE users SET password = 'nova-senha-456' WHERE id = '00000000-0000-7000-8000-0000000000a1';
SELECT results_eq($$SELECT changed_columns, old_data ? 'password', new_data ? 'password' FROM audit_log
                     WHERE table_name = 'users' AND action = 'update'$$,
                  $$VALUES (ARRAY['password'], false, false)$$, 'troca de senha registrada sem o valor');
SELECT is(auth_login('ana', 'nova-senha-456'), '00000000-0000-7000-8000-0000000000a1'::uuid, 'login funciona');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'users' AND action = 'update'), 1,
          'last_login_at sozinho não gera linha');

-- Anexo: só metadados
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'a.pdf', 'application/pdf', '\x25504446');
SELECT results_eq($$SELECT new_data ? 'content', new_data ->> 'sha256', (new_data ->> 'size_bytes')::int FROM audit_log
                     WHERE table_name = 'attachments'$$,
                  $$VALUES (false, encode(sha256('\x25504446'::bytea), 'hex'), 4)$$, 'anexo auditado sem o conteúdo');
UPDATE attachments SET file_name = 'b.pdf' WHERE id = '00000000-0000-7000-8000-0000000a7001';
SELECT results_eq($$SELECT changed_columns FROM audit_log WHERE table_name = 'attachments' AND action = 'update'$$,
                  $$VALUES (ARRAY['file_name'])$$, 'renomear anexo');

-- Delete
DELETE FROM attachments WHERE id = '00000000-0000-7000-8000-0000000a7001';
SELECT results_eq($$SELECT old_data ->> 'file_name', new_data IS NULL FROM audit_log WHERE table_name = 'attachments' AND action = 'delete'$$,
                  $$VALUES ('b.pdf', true)$$, 'delete guarda o antes');

-- Regras: contador de uso não gera linha
INSERT INTO caixas (id, name, kind, holder_entity_id) VALUES
  ('00000000-0000-7000-8000-0000000c0001', 'Casa', 'general', '00000000-0000-7000-8000-00000000e001');
INSERT INTO financial_accounts (id, caixa_id, kind, name, opening_date) VALUES
  ('00000000-0000-7000-8000-0000000a0001', '00000000-0000-7000-8000-0000000c0001', 'checking', 'Itaú', '2026-01-01');
INSERT INTO classification_rules (id, caixa_id, financial_account_id, pattern, entity_id) VALUES
  ('00000000-0000-7000-8000-0000000ae001', '00000000-0000-7000-8000-0000000c0001', '00000000-0000-7000-8000-0000000a0001',
   'patrick', '00000000-0000-7000-8000-00000000e001');
UPDATE classification_rules SET usage_count = usage_count + 1, last_used_at = now()
 WHERE id = '00000000-0000-7000-8000-0000000ae001';
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'classification_rules'), 1, 'uso da regra não é auditado');

-- Ator inválido -------------------------------------------------------------------------------------------
SELECT set_config('app.user_id', 'abc', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$,
                 '23514', 'audit: app.user_id abc is not a uuid', 'app.user_id precisa ser uuid');
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.actor_kind', 'agent', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$,
                 '23514', NULL, 'agente exige app.user_id');
SELECT set_config('app.actor_kind', 'robot', true);
SELECT set_config('app.user_id', '00000000-0000-7000-8000-0000000000a1', true);
SELECT throws_ok($$UPDATE entities SET notes = 'x' WHERE id = '00000000-0000-7000-8000-00000000e001'$$,
                 '23514', NULL, 'actor_kind human|agent|system');
SELECT set_config('app.actor_kind', '', true);

-- Privilégios: a aplicação só lê ---------------------------------------------------------------------------
SELECT table_privs_are('audit_log', 'moneyflow_app', ARRAY['SELECT']);
SELECT ok(NOT has_function_privilege('moneyflow_app', 'audit_write(text, text, jsonb, jsonb, text[], uuid)', 'EXECUTE'),
          'app não chama audit_write');
SELECT ok(NOT has_function_privilege('public', 'audit_write(text, text, jsonb, jsonb, text[], uuid)', 'EXECUTE'),
          'PUBLIC não chama audit_write');
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO entities (id, kind, name) VALUES ('00000000-0000-7000-8000-00000000e002', 'company', 'Via app')$$,
                'app escreve e o trigger audita');
SELECT is((SELECT user_id FROM audit_log WHERE record_id = '00000000-0000-7000-8000-00000000e002'),
          '00000000-0000-7000-8000-0000000000a1'::uuid, 'app lê o log com o ator');
SELECT throws_ok($$INSERT INTO audit_log (table_name, record_id, action, new_data, actor_kind, transaction_id)
                   VALUES ('x', uuidv7(), 'insert', '{}', 'system', 1)$$, '42501', NULL, 'app não insere no log');
SELECT throws_ok($$UPDATE audit_log SET actor_kind = 'system'$$, '42501', NULL, 'app não altera o log');
SELECT throws_ok($$DELETE FROM audit_log$$, '42501', NULL, 'app não apaga o log');
SELECT throws_ok($$SELECT audit_write('x', 'insert', NULL, '{}'::jsonb, NULL)$$, '42501', NULL, 'app não forja linha');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
