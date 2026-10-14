-- Testes de 0026_ai_conversations_and_runs: conversas, mensagens, execuções (claim, heartbeat, credenciais),
-- eventos de streaming, confirmações de escrita, busca e bifurcação.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura
SELECT has_table(t) FROM unnest(ARRAY['ai_conversations', 'ai_messages', 'ai_message_attachments', 'ai_runs',
                                      'ai_run_events', 'ai_tool_confirmations']) t;
SELECT has_function(f) FROM unnest(ARRAY['ai_run_claim', 'ai_run_heartbeat', 'ai_run_provider_credentials',
                                         'ai_run_mcp_headers', 'ai_run_event_append', 'ai_run_events_purge',
                                         'ai_tool_confirmations_decide', 'ai_runs_expire_awaiting',
                                         'ai_conversation_search', 'ai_conversation_fork', 'ai_message_content_valid']) f;
SELECT has_index('ai_conversations', 'ai_conversations_title_trgm_idx');
SELECT has_index('ai_messages', 'ai_messages_search_tsv_idx');
SELECT is((SELECT amname::text FROM pg_class c JOIN pg_am a ON a.oid = c.relam WHERE c.relname = i), 'gin', i || ' é GIN')
  FROM unnest(ARRAY['ai_conversations_title_trgm_idx', 'ai_messages_search_tsv_idx']) i;
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' é SECURITY DEFINER')
  FROM unnest(ARRAY['ai_run_provider_credentials(uuid)', 'ai_run_mcp_headers(uuid, uuid)']) f;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_run_claim(integer, interval)', 'ai_run_heartbeat(uuid, uuid)', 'ai_run_provider_credentials(uuid)',
                    'ai_run_mcp_headers(uuid, uuid)', 'ai_run_event_append(uuid, text, jsonb)', 'ai_run_events_purge(interval)',
                    'ai_tool_confirmations_decide(uuid, uuid, text, uuid[], text)', 'ai_runs_expire_awaiting(interval)',
                    'ai_conversation_search(text, uuid, boolean, integer)', 'ai_conversation_fork(uuid, uuid, text)']) f;
SELECT ok(NOT has_function_privilege('public', f, 'EXECUTE'), 'PUBLIC não executa ' || f)
  FROM unnest(ARRAY['ai_run_provider_credentials(uuid)', 'ai_run_mcp_headers(uuid, uuid)', 'ai_run_claim(integer, interval)']) f;
SELECT ok(NOT has_table_privilege('moneyflow_app', 'ai_run_events', 'UPDATE'), 'eventos: app não altera');

-- Dados base
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin', true),
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000000a3', 'cid', 'cid@example.com', 'segredo', 'user', true);
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000a1001', 'Claude', 'anthropic', 'sk-ant-api03-SEGREDO1234'),
  ('00000000-0000-7000-8000-0000000a1002', 'Reserva', 'anthropic', 'sk-ant-api03-RESERVA999');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000a3001', 'Assistente', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5'),
  ('00000000-0000-7000-8000-0000000a3002', 'Fiscal', '00000000-0000-7000-8000-0000000a1002', 'claude-haiku-4-5');
INSERT INTO mcp_servers (id, name, url, secret_headers, visibility) VALUES
  ('00000000-0000-7000-8000-0000000c1001', 'Docs', 'https://docs.example.com/mcp', '{"Authorization": "Bearer DOCS"}', 'global'),
  ('00000000-0000-7000-8000-0000000c1002', 'Interno', 'https://interno.example.com/mcp', '{"X-Key": "INT"}', 'private');
INSERT INTO attachments (id, file_name, mime_type, content) VALUES
  ('00000000-0000-7000-8000-0000000a7001', 'boleto.pdf', 'application/pdf', '\x25504446');

-- Conversas ---------------------------------------------------------------------------------------------------------
-- b0002 é uma sessão finalizada do mesmo par de b0001 (uma ativa por usuário e agente desde a 0043).
INSERT INTO ai_conversations (id, user_id, agent_id, title, screen_context, archived_at) VALUES
  ('00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'Contas de energia', '{"route": "/caixas/x", "caixa_id": "x"}', NULL),
  ('00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   NULL, NULL, now()),
  ('00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000a3002',
   'Notas fiscais de setembro', NULL, NULL);
SELECT is((SELECT title_source FROM ai_conversations WHERE id = '00000000-0000-7000-8000-0000000b0001'), 'auto', 'título automático por padrão');
SELECT throws_ok($$INSERT INTO ai_conversations (user_id, agent_id, title) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', '   ')$$, '23514', NULL,
                 'título não vazio');
SELECT throws_ok($$INSERT INTO ai_conversations (user_id, agent_id, screen_context) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', '[]')$$, '23514', NULL,
                 'contexto da tela é objeto');
SELECT throws_ok($$UPDATE ai_conversations SET forked_from_conversation_id = '00000000-0000-7000-8000-0000000b0002'
                    WHERE id = '00000000-0000-7000-8000-0000000b0001'$$, '23503', NULL, 'origem e mensagem andam juntas (MATCH FULL)');

-- Mensagens -------------------------------------------------------------------------------------------------------------
SELECT ok(ai_message_content_valid(r, c::jsonb), 'conteúdo válido: ' || r || ' ' || c)
  FROM (VALUES ('user', '[{"type": "text", "text": "oi"}]'),
               ('user', '[{"type": "text", "text": "veja"}, {"type": "attachment", "attachment_id": "00000000-0000-7000-8000-0000000a7001"}]'),
               ('assistant', '[{"type": "thinking", "text": "hmm", "signature": "x"}, {"type": "text", "text": "ok"}, {"type": "tool_use", "id": "tu_1", "name": "list_titles", "input": {}}]'),
               ('tool', '[{"type": "tool_result", "tool_use_id": "tu_1", "content": [{"type": "text", "text": "[]"}], "is_error": false}]')) v (r, c);
SELECT ok(NOT ai_message_content_valid(r, c::jsonb), 'conteúdo inválido: ' || r || ' ' || c)
  FROM (VALUES ('user', '[]'),
               ('user', '{"type": "text", "text": "oi"}'),
               ('user', '[{"type": "text"}]'),
               ('user', '[{"type": "tool_use", "id": "a", "name": "b", "input": {}}]'),
               ('user', '[{"type": "attachment", "attachment_id": "x"}]'),
               ('assistant', '[{"type": "tool_use", "id": "a", "name": "b", "input": []}]'),
               ('assistant', '[{"type": "tool_result", "tool_use_id": "a", "content": "x"}]'),
               ('tool', '[{"type": "tool_result", "tool_use_id": "a"}]'),
               ('tool', '[{"type": "tool_result", "tool_use_id": "a", "content": "x", "is_error": "no"}]'),
               ('tool', '[{"type": "text", "text": "x"}]'),
               ('system', '[{"type": "text", "text": "x"}]'),
               ('user', '["texto solto"]')) v (r, c);

INSERT INTO ai_messages (id, conversation_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000b1001', '00000000-0000-7000-8000-0000000b0001', 'user',
   '[{"type": "text", "text": "Quais pagamentos de energia elétrica vencem este mês?"}, {"type": "attachment", "attachment_id": "00000000-0000-7000-8000-0000000a7001"}]');
INSERT INTO ai_messages (id, conversation_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000b1002', '00000000-0000-7000-8000-0000000b0001', 'assistant',
   '[{"type": "text", "text": "Vou procurar."}, {"type": "tool_use", "id": "tu_1", "name": "list_titles", "input": {"q": "energia"}}]'),
  ('00000000-0000-7000-8000-0000000b1003', '00000000-0000-7000-8000-0000000b0001', 'tool',
   '[{"type": "tool_result", "tool_use_id": "tu_1", "content": "[]"}]');
SELECT results_eq($$SELECT seq FROM ai_messages WHERE conversation_id = '00000000-0000-7000-8000-0000000b0001' ORDER BY seq$$,
                  $$VALUES (1), (2), (3)$$, 'seq atribuído em ordem pelo banco');
SELECT ok((SELECT last_message_at IS NOT NULL FROM ai_conversations WHERE id = '00000000-0000-7000-8000-0000000b0001'),
          'last_message_at atualizado');
SELECT results_eq($$SELECT message_id, attachment_id FROM ai_message_attachments$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b1001'::uuid, '00000000-0000-7000-8000-0000000a7001'::uuid)$$,
                  'bloco attachment liga o anexo');
SELECT results_eq($$SELECT target_kind, target_id FROM attachment_links WHERE attachment_id = '00000000-0000-7000-8000-0000000a7001'$$,
                  $$VALUES ('ai_message', '00000000-0000-7000-8000-0000000b1001'::uuid)$$, 'attachment_links inclui mensagens');
SELECT throws_ok($$INSERT INTO ai_messages (conversation_id, role, content) VALUES ('00000000-0000-7000-8000-0000000b0001', 'user',
                   '[{"type": "attachment", "attachment_id": "00000000-0000-7000-8000-0000000a7fff"}]')$$, '23503', NULL,
                 'anexo inexistente');
SELECT throws_ok($$INSERT INTO ai_messages (conversation_id, seq, role, content) VALUES ('00000000-0000-7000-8000-0000000b0001', 2, 'user',
                   '[{"type": "text", "text": "x"}]')$$, '23505', NULL, 'seq único na conversa');
SELECT throws_ok($$INSERT INTO ai_messages (conversation_id, role, content) VALUES ('00000000-0000-7000-8000-0000000b0001', 'user', '[]')$$,
                 '23514', NULL, 'conteúdo validado');
SELECT throws_ok($$UPDATE ai_messages SET content = '[{"type": "text", "text": "editado"}]' WHERE id = '00000000-0000-7000-8000-0000000b1001'$$,
                 '23514', NULL, 'mensagem imutável');
SELECT ok((SELECT search_tsv @@ websearch_to_tsquery('portuguese', 'pagamento energia') FROM ai_messages
            WHERE id = '00000000-0000-7000-8000-0000000b1001'), 'full-text em português (radicais)');

-- Execuções ----------------------------------------------------------------------------------------------------------------
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id, trigger_message_id) VALUES
  ('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000b0001', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000b1001');
SELECT results_eq($$SELECT status, provider_id, model, attempts, locked_at IS NULL, started_at IS NULL FROM ai_runs
                     WHERE id = '00000000-0000-7000-8000-0000000b2001'$$,
                  $$VALUES ('queued', '00000000-0000-7000-8000-0000000a1001'::uuid, 'claude-sonnet-4-5', 0::smallint, true, true)$$,
                  'nasce queued com provedor e modelo do agente');
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES ('00000000-0000-7000-8000-0000000b0001',
                   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001')$$, '23505', NULL,
                 'uma execução ativa por conversa');
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES ('00000000-0000-7000-8000-0000000b0002',
                   '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000a3001')$$, '23514',
                 'ai_runs: run user must be the owner of conversation 00000000-0000-7000-8000-0000000b0002', 'só o dono da conversa aciona');
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES ('00000000-0000-7000-8000-0000000b0002',
                   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3002')$$, '23514', NULL,
                 'agente da conversa');
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id, status) VALUES ('00000000-0000-7000-8000-0000000b0002',
                   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', 'running')$$, '23514', NULL,
                 'nasce queued');
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id, trigger_message_id) VALUES ('00000000-0000-7000-8000-0000000b0002',
                   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000b1001')$$,
                 '23503', NULL, 'mensagem de gatilho da mesma conversa');
UPDATE ai_providers SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000a1002';
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES ('00000000-0000-7000-8000-0000000b0003',
                   '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000a3002')$$, '23514', NULL,
                 'provedor inativo não inicia');
UPDATE ai_providers SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000a1002';
UPDATE ai_agents SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000a3002';
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES ('00000000-0000-7000-8000-0000000b0003',
                   '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000a3002')$$, '23514', NULL,
                 'agente inativo não inicia');
UPDATE ai_agents SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000a3002';
UPDATE users SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000000a3';
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES ('00000000-0000-7000-8000-0000000b0003',
                   '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000a3002')$$, '23514', NULL,
                 'usuário inativo não aciona');
UPDATE users SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000000a3';
SELECT throws_ok($$UPDATE ai_runs SET status = 'completed' WHERE id = '00000000-0000-7000-8000-0000000b2001'$$, '23514', NULL,
                 'queued não vai direto para completed');
SELECT throws_ok($$SELECT * FROM ai_run_provider_credentials('00000000-0000-7000-8000-0000000b2001')$$, '42501', NULL,
                 'credenciais: execução não reservada');
SELECT throws_ok($$SELECT * FROM ai_run_provider_credentials('00000000-0000-7000-8000-0000000b2fff')$$, 'P0002', NULL,
                 'credenciais: execução inexistente');

-- Claim
SELECT throws_ok($$SELECT * FROM ai_run_claim(0)$$, '22023', NULL, 'claim: limite inválido');
CREATE TEMP TABLE claimed AS SELECT * FROM ai_run_claim(5);
SELECT results_eq($$SELECT id, status, attempts, lock_token IS NOT NULL, started_at IS NOT NULL FROM claimed$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b2001'::uuid, 'running', 1::smallint, true, true)$$,
                  'claim reserva a execução');
SELECT is((SELECT count(*)::int FROM ai_run_claim(5)), 0, 'reservada não é reservada de novo');
SELECT results_eq($$SELECT provider_id, kind, api_key, model FROM ai_run_provider_credentials('00000000-0000-7000-8000-0000000b2001')$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000a1001'::uuid, 'anthropic', 'sk-ant-api03-SEGREDO1234', 'claude-sonnet-4-5')$$,
                  'credenciais da execução reservada');
SELECT is(ai_run_mcp_headers('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000c1001'),
          '{"Authorization": "Bearer DOCS"}'::jsonb, 'cabeçalhos de servidor global');
SELECT throws_ok($$SELECT ai_run_mcp_headers('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000c1002')$$,
                 '42501', NULL, 'servidor private não vinculado: 42501');
INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES
  ('00000000-0000-7000-8000-0000000a3001', '00000000-0000-7000-8000-0000000c1002');
SELECT is(ai_run_mcp_headers('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000c1002'),
          '{"X-Key": "INT"}'::jsonb, 'vinculado: lê');

-- Heartbeat e cancelamento
SELECT is(ai_run_heartbeat('00000000-0000-7000-8000-0000000b2001', (SELECT lock_token FROM claimed)), false, 'heartbeat sem cancelamento');
SELECT throws_ok($$SELECT ai_run_heartbeat('00000000-0000-7000-8000-0000000b2001', gen_random_uuid())$$, '23514', NULL,
                 'heartbeat com outra reserva: 23514');

-- Eventos
SELECT is(ai_run_event_append('00000000-0000-7000-8000-0000000b2001', 'status', '{"status": "running"}'), 1, 'primeiro evento');
SELECT is(ai_run_event_append('00000000-0000-7000-8000-0000000b2001', 'text_delta', '{"text": "Vou"}'), 2, 'segundo evento');
SELECT results_eq($$SELECT seq, event_type FROM ai_run_events WHERE run_id = '00000000-0000-7000-8000-0000000b2001' ORDER BY seq$$,
                  $$VALUES (1, 'status'), (2, 'text_delta')$$, 'eventos em ordem');
SELECT is((SELECT last_event_seq FROM ai_runs WHERE id = '00000000-0000-7000-8000-0000000b2001'), 2, 'contador da execução');
SELECT throws_ok($$SELECT ai_run_event_append('00000000-0000-7000-8000-0000000b2001', 'Bad Type', '{}')$$, '23514', NULL, 'tipo validado');
SELECT throws_ok($$SELECT ai_run_event_append('00000000-0000-7000-8000-0000000b2fff', 'x', '{}')$$, 'P0002', NULL, 'execução inexistente');

-- Confirmações
INSERT INTO ai_tool_confirmations (id, run_id, tool_use_id, tool_name, input, preview) VALUES
  ('00000000-0000-7000-8000-0000000b3001', '00000000-0000-7000-8000-0000000b2001', 'tu_2', 'create_title', '{"amount_cents": 100}', '{"after": {}}'),
  ('00000000-0000-7000-8000-0000000b3002', '00000000-0000-7000-8000-0000000b2001', 'tu_3', 'send_message', '{"text": "oi"}', NULL),
  ('00000000-0000-7000-8000-0000000b3003', '00000000-0000-7000-8000-0000000b2001', 'tu_4', 'update_title', '{"id": "x"}', NULL);
SELECT throws_ok($$INSERT INTO ai_tool_confirmations (run_id, tool_use_id, tool_name, input) VALUES
                   ('00000000-0000-7000-8000-0000000b2001', 'tu_2', 'create_title', '{}')$$, '23505', NULL, 'uma por tool_use');
UPDATE ai_runs SET status = 'awaiting_confirmation' WHERE id = '00000000-0000-7000-8000-0000000b2001';
SELECT results_eq($$SELECT status, locked_at IS NULL, lock_token IS NULL, attempts FROM ai_runs WHERE id = '00000000-0000-7000-8000-0000000b2001'$$,
                  $$VALUES ('awaiting_confirmation', true, true, 0::smallint)$$, 'esperando: sem reserva, tentativas zeradas');
SELECT throws_ok($$INSERT INTO ai_tool_confirmations (run_id, tool_use_id, tool_name, input) VALUES
                   ('00000000-0000-7000-8000-0000000b2001', 'tu_9', 'x', '{}')$$, '23514', NULL, 'só com a execução em running');
SELECT throws_ok($$SELECT ai_run_heartbeat('00000000-0000-7000-8000-0000000b2001', (SELECT lock_token FROM claimed))$$, '23514', NULL,
                 'heartbeat de execução que saiu de running');
SELECT throws_ok($$SELECT * FROM ai_tool_confirmations_decide('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000000a1', 'approved')$$,
                 '42501', NULL, 'só quem acionou decide (nem o admin)');
SELECT throws_ok($$SELECT * FROM ai_tool_confirmations_decide('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000000a2', 'maybe')$$,
                 '22023', NULL, 'decisão approved|rejected');
SELECT throws_ok($$UPDATE ai_tool_confirmations SET status = 'approved', decided_by_user_id = '00000000-0000-7000-8000-0000000000a1'
                    WHERE id = '00000000-0000-7000-8000-0000000b3001'$$, '23514', NULL, 'UPDATE direto também exige o usuário da execução');
SELECT results_eq($$SELECT * FROM ai_tool_confirmations_decide('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000000a2',
                     'approved', ARRAY['00000000-0000-7000-8000-0000000b3001'::uuid, '00000000-0000-7000-8000-0000000b3002'::uuid])$$,
                  $$VALUES (2, 1, 'awaiting_confirmation')$$, 'aprova duas; uma pendente; continua esperando');
SELECT results_eq($$SELECT * FROM ai_tool_confirmations_decide('00000000-0000-7000-8000-0000000b2001', '00000000-0000-7000-8000-0000000000a2',
                     'rejected', NULL, 'não quero')$$,
                  $$VALUES (1, 0, 'queued')$$, 'rejeita o resto; sem pendentes, volta para a fila');
SELECT results_eq($$SELECT status, decided_by_user_id, decided_at IS NOT NULL, reason FROM ai_tool_confirmations ORDER BY id$$,
                  $$VALUES ('approved', '00000000-0000-7000-8000-0000000000a2'::uuid, true, NULL::text),
                           ('approved', '00000000-0000-7000-8000-0000000000a2', true, NULL),
                           ('rejected', '00000000-0000-7000-8000-0000000000a2', true, 'não quero')$$, 'decisões gravadas');
SELECT throws_ok($$UPDATE ai_tool_confirmations SET status = 'rejected' WHERE id = '00000000-0000-7000-8000-0000000b3001'$$,
                 '23514', NULL, 'decisão é final');
SELECT throws_ok($$UPDATE ai_tool_confirmations SET input = '{}' WHERE id = '00000000-0000-7000-8000-0000000b3001'$$,
                 '23514', NULL, 'entrada imutável');

-- Continua e termina
SELECT results_eq($$SELECT id, attempts FROM ai_run_claim(1)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b2001'::uuid, 1::smallint)$$, 'retomada depois da confirmação');
UPDATE ai_runs SET status = 'completed', finished_at = now() - interval '30 days' WHERE id = '00000000-0000-7000-8000-0000000b2001';
SELECT results_eq($$SELECT status, locked_at IS NULL, lock_token IS NULL FROM ai_runs WHERE id = '00000000-0000-7000-8000-0000000b2001'$$,
                  $$VALUES ('completed', true, true)$$, 'completed');
SELECT throws_ok($$UPDATE ai_runs SET status = 'failed', error = 'x' WHERE id = '00000000-0000-7000-8000-0000000b2001'$$, '23514', NULL,
                 'final não muda de status');
SELECT throws_ok($$UPDATE ai_runs SET model = 'outro' WHERE id = '00000000-0000-7000-8000-0000000b2001'$$, '23514', NULL,
                 'modelo imutável');
SELECT is(ai_run_event_append('00000000-0000-7000-8000-0000000b2001', 'done', '{}'), 3, 'evento depois de terminar ainda entra');
SELECT throws_ok($$INSERT INTO ai_runs (conversation_id, user_id, agent_id, status, error) VALUES ('00000000-0000-7000-8000-0000000b0002',
                   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', 'failed', NULL)$$, '23514', NULL,
                 'failed exige erro (e nasce queued)');

-- Mensagem do assistente ligada à execução
INSERT INTO ai_messages (conversation_id, role, content, run_id) VALUES
  ('00000000-0000-7000-8000-0000000b0001', 'assistant', '[{"type": "text", "text": "Nenhum boleto de energia vence este mês."}]',
   '00000000-0000-7000-8000-0000000b2001');
SELECT throws_ok($$INSERT INTO ai_messages (conversation_id, role, content, run_id) VALUES
                   ('00000000-0000-7000-8000-0000000b0002', 'assistant', '[{"type": "text", "text": "x"}]',
                    '00000000-0000-7000-8000-0000000b2001')$$, '23503', NULL, 'execução da mesma conversa');

-- Cancelamento, reserva abandonada e expiração das pendentes
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b2002', '00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
SELECT is((SELECT count(*)::int FROM ai_run_claim(1)), 1, 'reserva a segunda');
INSERT INTO ai_tool_confirmations (id, run_id, tool_use_id, tool_name, input) VALUES
  ('00000000-0000-7000-8000-0000000b3004', '00000000-0000-7000-8000-0000000b2002', 'tu_1', 'create_title', '{}');
UPDATE ai_runs SET cancel_requested_at = now() WHERE id = '00000000-0000-7000-8000-0000000b2002';
SELECT is(ai_run_heartbeat('00000000-0000-7000-8000-0000000b2002', (SELECT lock_token FROM ai_runs WHERE id = '00000000-0000-7000-8000-0000000b2002')),
          true, 'heartbeat avisa o cancelamento pedido');
UPDATE ai_runs SET locked_at = now() - interval '1 hour' WHERE id = '00000000-0000-7000-8000-0000000b2002';
SELECT is((SELECT count(*)::int FROM ai_run_claim(5)), 0, 'abandonada com cancelamento pedido não é retomada');
SELECT results_eq($$SELECT r.status, c.status FROM ai_runs r JOIN ai_tool_confirmations c ON c.run_id = r.id
                     WHERE r.id = '00000000-0000-7000-8000-0000000b2002'$$,
                  $$VALUES ('canceled', 'expired')$$, 'é cancelada e as pendentes expiram');

INSERT INTO ai_runs (id, conversation_id, user_id, agent_id, max_attempts) VALUES
  ('00000000-0000-7000-8000-0000000b2003', '00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001', 2);
SELECT is((SELECT attempts FROM ai_run_claim(1)), 1::smallint, 'primeira reserva');
UPDATE ai_runs SET locked_at = now() - interval '1 hour' WHERE id = '00000000-0000-7000-8000-0000000b2003';
SELECT results_eq($$SELECT id, attempts FROM ai_run_claim(1, interval '5 minutes')$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b2003'::uuid, 2::smallint)$$, 'reserva abandonada é retomada');
UPDATE ai_runs SET locked_at = now() - interval '1 hour' WHERE id = '00000000-0000-7000-8000-0000000b2003';
SELECT is((SELECT count(*)::int FROM ai_run_claim(1)), 0, 'sem tentativas restantes não é retomada');
SELECT results_eq($$SELECT status, error LIKE 'stale_lock%', finished_at IS NOT NULL FROM ai_runs WHERE id = '00000000-0000-7000-8000-0000000b2003'$$,
                  $$VALUES ('failed', true, true)$$, 'e vira failed');

-- Expiração de execuções esperando confirmação
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b2004', '00000000-0000-7000-8000-0000000b0002', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
SELECT is((SELECT count(*)::int FROM ai_run_claim(1)), 1, 'reserva a quarta');
INSERT INTO ai_tool_confirmations (run_id, tool_use_id, tool_name, input) VALUES
  ('00000000-0000-7000-8000-0000000b2004', 'tu_1', 'create_title', '{}');
UPDATE ai_runs SET status = 'awaiting_confirmation' WHERE id = '00000000-0000-7000-8000-0000000b2004';
SELECT is(ai_runs_expire_awaiting(interval '1 day'), 0, 'recente não expira');
ALTER TABLE ai_runs DISABLE TRIGGER ai_runs_set_updated_at;
UPDATE ai_runs SET updated_at = now() - interval '8 days' WHERE id = '00000000-0000-7000-8000-0000000b2004';
ALTER TABLE ai_runs ENABLE TRIGGER ai_runs_set_updated_at;
SELECT is(ai_runs_expire_awaiting(), 1, 'parada há mais de 7 dias expira');
SELECT results_eq($$SELECT r.status, r.error, c.status FROM ai_runs r JOIN ai_tool_confirmations c ON c.run_id = r.id
                     WHERE r.id = '00000000-0000-7000-8000-0000000b2004'$$,
                  $$VALUES ('canceled', 'confirmation_expired', 'expired')$$, 'cancelada com as pendentes expiradas');

-- Retenção de eventos
SELECT throws_ok($$SELECT ai_run_events_purge(interval '1 minute')$$, '22023', NULL, 'retenção mínima de 1 hora');
SELECT is(ai_run_events_purge(), 3::bigint, 'apaga os eventos de execuções terminadas há mais de 7 dias');
SELECT is((SELECT count(*)::int FROM ai_run_events), 0, 'sem eventos velhos');

-- Busca -------------------------------------------------------------------------------------------------------------------
SELECT results_eq($$SELECT conversation_id, message_id FROM ai_conversation_search('pagamento energia', '00000000-0000-7000-8000-0000000000a2')$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b0001'::uuid, '00000000-0000-7000-8000-0000000b1001'::uuid)$$,
                  'full-text nas mensagens do usuário');
SELECT ok((SELECT snippet LIKE '%«%»%' FROM ai_conversation_search('boleto', '00000000-0000-7000-8000-0000000000a2')),
          'trecho destaca o termo');
SELECT results_eq($$SELECT conversation_id, message_id FROM ai_conversation_search('fiscais', NULL)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b0003'::uuid, NULL::uuid)$$, 'título (contém), de todos os usuários');
SELECT results_eq($$SELECT conversation_id FROM ai_conversation_search('Contas de energa', '00000000-0000-7000-8000-0000000000a2')$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000b0001'::uuid)$$, 'título parecido (trigram)');
SELECT is_empty($$SELECT * FROM ai_conversation_search('fiscais', '00000000-0000-7000-8000-0000000000a2')$$, 'filtra pelo dono');
UPDATE ai_conversations SET archived_at = now() WHERE id = '00000000-0000-7000-8000-0000000b0003';
SELECT is_empty($$SELECT * FROM ai_conversation_search('fiscais')$$, 'arquivadas fora por padrão');
SELECT is((SELECT count(*)::int FROM ai_conversation_search('fiscais', NULL, true)), 1, 'arquivadas quando pedido');
SELECT is_empty($$SELECT * FROM ai_conversation_search('100%_x')$$, 'curingas do LIKE são literais');
SELECT throws_ok($$SELECT * FROM ai_conversation_search('  ')$$, '22023', NULL, 'busca vazia');

-- Bifurcação ----------------------------------------------------------------------------------------------------------------
SELECT lives_ok($$CREATE TEMP TABLE fork AS SELECT ai_conversation_fork('00000000-0000-7000-8000-0000000b1002',
                   '00000000-0000-7000-8000-0000000000a2') AS id$$, 'bifurca');
SELECT results_eq($$SELECT c.user_id, c.agent_id, c.title, c.forked_from_conversation_id, c.forked_from_message_id
                      FROM ai_conversations c WHERE c.id = (SELECT id FROM fork)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000000a2'::uuid, '00000000-0000-7000-8000-0000000a3001'::uuid,
                            'Contas de energia', '00000000-0000-7000-8000-0000000b0001'::uuid, '00000000-0000-7000-8000-0000000b1002'::uuid)$$,
                  'nova conversa ligada à origem');
SELECT results_eq($$SELECT seq, role, run_id FROM ai_messages WHERE conversation_id = (SELECT id FROM fork) ORDER BY seq$$,
                  $$VALUES (1, 'user', NULL::uuid), (2, 'assistant', NULL)$$, 'copia até a mensagem escolhida, sem execução');
SELECT is((SELECT count(*)::int FROM ai_message_attachments a JOIN ai_messages m ON m.id = a.message_id
            WHERE m.conversation_id = (SELECT id FROM fork)), 1, 'anexos religados');
SELECT throws_ok($$SELECT ai_conversation_fork('00000000-0000-7000-8000-0000000b1fff', '00000000-0000-7000-8000-0000000000a2')$$,
                 'P0002', NULL, 'mensagem inexistente');

-- Finalidade da conversa (0033) ------------------------------------------------------------------------------------------------
SELECT has_column('ai_conversations', 'purpose');
SELECT col_not_null('ai_conversations', 'purpose');
SELECT has_index('ai_conversations', i) FROM unnest(ARRAY['ai_conversations_chat_user_idx', 'ai_conversations_purpose_idx']) i;
SELECT is((SELECT purpose FROM ai_conversations WHERE id = (SELECT id FROM fork)), 'chat', 'finalidade chat por padrão');
INSERT INTO ai_conversations (id, user_id, agent_id, screen_context, purpose, archived_at) VALUES
  ('00000000-0000-7000-8000-0000000b0009', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   '{"purpose": "document_reading", "route": "/titulos"}', 'document_reading', now());
INSERT INTO ai_messages (id, conversation_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000b1009', '00000000-0000-7000-8000-0000000b0009', 'user', '[{"type": "text", "text": "leia"}]');
-- Com o Fiscal: bia já tem a sessão chat ativa com o Assistente (a bifurcação acima).
SELECT lives_ok(format($$INSERT INTO ai_conversations (user_id, agent_id, purpose) VALUES
                  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3002', %L)$$, p), 'finalidade aceita: ' || p)
  FROM unnest(ARRAY['chat', 'classify_lines', 'contract_reading', 'contract_markdown']) p;
SELECT throws_ok($$INSERT INTO ai_conversations (user_id, agent_id, purpose) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', 'document')$$, '23514',
                 'new row for relation "ai_conversations" violates check constraint "ai_conversations_purpose_check"',
                 'finalidade fora do vocabulário');
SELECT throws_ok($$UPDATE ai_conversations SET purpose = 'chat' WHERE id = '00000000-0000-7000-8000-0000000b0009'$$, '23514',
                 'ai_conversations: purpose of conversation 00000000-0000-7000-8000-0000000b0009 is immutable',
                 'finalidade imutável');
SELECT throws_ok($$UPDATE ai_conversations SET purpose = 'classify_lines' WHERE id = (SELECT id FROM fork)$$, '23514', NULL,
                 'conversa comum não vira fluxo');
UPDATE ai_conversations SET screen_context = '{"route": "/caixas"}', title = 'Leitura'
 WHERE id = '00000000-0000-7000-8000-0000000b0009';
SELECT is((SELECT purpose FROM ai_conversations WHERE id = '00000000-0000-7000-8000-0000000b0009'), 'document_reading',
          'trocar o contexto da tela não apaga a finalidade');
SELECT lives_ok($$UPDATE ai_conversations SET purpose = purpose WHERE id = '00000000-0000-7000-8000-0000000b0009'$$,
                'regravar o mesmo valor passa');
UPDATE ai_conversations SET screen_context = '{"purpose": "document_reading", "route": "/titulos"}'
 WHERE id = '00000000-0000-7000-8000-0000000b0009';
CREATE TEMP TABLE fork_flow AS SELECT ai_conversation_fork('00000000-0000-7000-8000-0000000b1009',
                                                           '00000000-0000-7000-8000-0000000000a2') AS id;
SELECT results_eq($$SELECT purpose, screen_context FROM ai_conversations WHERE id = (SELECT id FROM fork_flow)$$,
                  $$VALUES ('chat', '{"route": "/titulos"}'::jsonb)$$, 'bifurcar conversa de fluxo cria chat, sem purpose no contexto');

-- Excluir a conversa de origem: a bifurcação perde só a referência
DELETE FROM ai_conversations WHERE id = '00000000-0000-7000-8000-0000000b0001';
SELECT results_eq($$SELECT forked_from_conversation_id, forked_from_message_id FROM ai_conversations WHERE id = (SELECT id FROM fork)$$,
                  $$VALUES (NULL::uuid, NULL::uuid)$$, 'bifurcação sobrevive à origem');
SELECT is((SELECT count(*)::int FROM ai_runs WHERE conversation_id = '00000000-0000-7000-8000-0000000b0001'), 0, 'execuções vão junto');
SELECT is((SELECT count(*)::int FROM ai_tool_confirmations WHERE run_id = '00000000-0000-7000-8000-0000000b2001'), 0, 'confirmações vão junto');
SELECT is((SELECT count(*)::int FROM ai_messages WHERE conversation_id = '00000000-0000-7000-8000-0000000b0001'), 0, 'mensagens vão junto');

-- Fora da auditoria --------------------------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = ANY (ARRAY['ai_conversations', 'ai_messages', 'ai_message_attachments',
                                                                              'ai_runs', 'ai_run_events', 'ai_tool_confirmations'])), 0,
          'conversas, mensagens, execuções, eventos e confirmações ficam fora da auditoria');

-- O papel da aplicação ---------------------------------------------------------------------------------------------------
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-0000000b2005', '00000000-0000-7000-8000-0000000b0003', '00000000-0000-7000-8000-0000000000a3',
   '00000000-0000-7000-8000-0000000a3002');
SET LOCAL ROLE moneyflow_app;
SELECT is((SELECT count(*)::int FROM ai_run_claim(5)), 1, 'app: claim');
SELECT is((SELECT api_key FROM ai_run_provider_credentials('00000000-0000-7000-8000-0000000b2005')), 'sk-ant-api03-RESERVA999',
          'app: credenciais da execução reservada');
SELECT is(ai_run_event_append('00000000-0000-7000-8000-0000000b2005', 'status', '{}'), 1, 'app: grava evento');
SELECT throws_ok($$UPDATE ai_run_events SET payload = '{}' WHERE run_id = '00000000-0000-7000-8000-0000000b2005'$$, '42501', NULL,
                 'app: evento não muda');
SELECT lives_ok($$INSERT INTO ai_messages (conversation_id, role, content) VALUES ('00000000-0000-7000-8000-0000000b0003', 'user',
                  '[{"type": "text", "text": "oi"}]')$$, 'app: grava mensagem');
SELECT lives_ok($$UPDATE ai_runs SET status = 'completed' WHERE id = '00000000-0000-7000-8000-0000000b2005'$$, 'app: termina');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
