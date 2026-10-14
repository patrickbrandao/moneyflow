-- Testes de 0043_ai_agent_sessions (spec 026): sessão chat ativa única por (usuário, agente), consolidação da
-- migração, finalizada não volta, arquivar com execução ativa, bifurcação que finaliza a ativa e pinned_at fora.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

-- Estrutura -----------------------------------------------------------------------------------------------------------
SELECT has_column('ai_conversations', 'archived_reason');
SELECT hasnt_column('ai_conversations', 'pinned_at');
SELECT has_index('ai_conversations', 'ai_conversations_active_chat_key');
SELECT ok((SELECT indisunique FROM pg_index WHERE indexrelid = 'ai_conversations_active_chat_key'::regclass),
          'índice da sessão ativa é único');
SELECT is((SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = 'ai_conversations_active_chat_key'::regclass),
          '((purpose = ''chat''::text) AND (archived_at IS NULL))', 'só chat não arquivada');
SELECT has_trigger('ai_conversations', 'ai_conversations_archive_guard');
SELECT has_function('ai_chat_sessions_consolidate');
SELECT ok(NOT has_function_privilege('moneyflow_app', 'ai_chat_sessions_consolidate()', 'EXECUTE'),
          'app não executa a consolidação');
SELECT ok(has_function_privilege('moneyflow_app', 'ai_conversation_fork(uuid, uuid, text)', 'EXECUTE'), 'app bifurca');
SELECT ok(has_column_privilege('moneyflow_app', 'ai_conversations', 'archived_reason', 'SELECT')
          AND has_column_privilege('moneyflow_app', 'ai_conversations', 'archived_reason', 'UPDATE'),
          'app lê e grava archived_reason');

-- Dados base ----------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000000a2', 'bia', 'bia@example.com', 'segredo', 'user', true),
  ('00000000-0000-7000-8000-0000000000a3', 'cid', 'cid@example.com', 'segredo', 'user', true);
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-0000000a1001', 'Claude', 'anthropic', 'sk-ant-api03-SEGREDO1234');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-0000000a3001', 'Assistente', '00000000-0000-7000-8000-0000000a1001', 'claude-sonnet-4-5'),
  ('00000000-0000-7000-8000-0000000a3002', 'Fiscal', '00000000-0000-7000-8000-0000000a1001', 'claude-haiku-4-5');

-- Consolidação da migração ----------------------------------------------------------------------------------------------
-- Reproduz o banco anterior à 0043 (várias ativas por par) sem o índice, consolida e recria o índice.
DROP INDEX ai_conversations_active_chat_key;
INSERT INTO ai_conversations (id, user_id, agent_id, title, screen_context, created_at) VALUES
  -- bia + Assistente: a 02 tem a última mensagem mais recente; a 03 nunca teve mensagem.
  ('00000000-0000-7000-8000-000000430001', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'Velha', '{"route": "/caixas"}', now() - interval '3 days'),
  ('00000000-0000-7000-8000-000000430002', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'Recente', NULL, now() - interval '2 days'),
  ('00000000-0000-7000-8000-000000430003', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'Vazia', NULL, now() - interval '1 day'),
  -- bia + Fiscal: só uma, fica.
  ('00000000-0000-7000-8000-000000430004', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3002',
   'Única', NULL, now()),
  -- cid + Assistente: duas sem mensagem; fica a criada por último.
  ('00000000-0000-7000-8000-000000430005', '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000a3001',
   'Primeira', NULL, now() - interval '2 hours'),
  ('00000000-0000-7000-8000-000000430006', '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000a3001',
   'Segunda', NULL, now() - interval '1 hour');
-- Já arquivada e de fluxo: ficam como estão.
INSERT INTO ai_conversations (id, user_id, agent_id, archived_at) VALUES
  ('00000000-0000-7000-8000-000000430007', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   now() - interval '10 days');
INSERT INTO ai_conversations (id, user_id, agent_id, purpose) VALUES
  ('00000000-0000-7000-8000-000000430008', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'document_reading'),
  ('00000000-0000-7000-8000-000000430009', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001',
   'classify_lines');
INSERT INTO ai_messages (conversation_id, role, content) VALUES
  ('00000000-0000-7000-8000-000000430001', 'user', '[{"type": "text", "text": "um"}]'),
  ('00000000-0000-7000-8000-000000430001', 'assistant', '[{"type": "text", "text": "dois"}]'),
  ('00000000-0000-7000-8000-000000430002', 'user', '[{"type": "text", "text": "três"}]');
UPDATE ai_conversations SET last_message_at = now() - interval '5 days' WHERE id = '00000000-0000-7000-8000-000000430001';
UPDATE ai_conversations SET last_message_at = now() - interval '1 hour' WHERE id = '00000000-0000-7000-8000-000000430002';
-- Execuções ativas nas que serão arquivadas: uma rodando (na 05), uma na fila (na 01).
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000431005', '00000000-0000-7000-8000-000000430005', '00000000-0000-7000-8000-0000000000a3',
   '00000000-0000-7000-8000-0000000a3001');
SELECT is((SELECT id FROM ai_run_claim(1)), '00000000-0000-7000-8000-000000431005'::uuid, 'execução da 05 rodando');
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000431001', '00000000-0000-7000-8000-000000430001', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
CREATE TEMP TABLE msgs_before AS SELECT conversation_id, count(*) AS n FROM ai_messages GROUP BY conversation_id;

SELECT is(ai_chat_sessions_consolidate(), 3, 'arquiva as três extras');
SELECT results_eq(
  $$SELECT id, archived_reason FROM ai_conversations
     WHERE purpose = 'chat' AND archived_at IS NULL ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-000000430002'::uuid, NULL::text),
           ('00000000-0000-7000-8000-000000430004'::uuid, NULL),
           ('00000000-0000-7000-8000-000000430006'::uuid, NULL)$$,
  'uma ativa por par: a de last_message_at mais recente; sem mensagem, a criada por último');
SELECT results_eq(
  $$SELECT id, archived_reason FROM ai_conversations WHERE archived_reason IS NOT NULL ORDER BY id$$,
  $$VALUES ('00000000-0000-7000-8000-000000430001'::uuid, 'migrated_from_multi'),
           ('00000000-0000-7000-8000-000000430003'::uuid, 'migrated_from_multi'),
           ('00000000-0000-7000-8000-000000430005'::uuid, 'migrated_from_multi')$$,
  'extras arquivadas com a marca técnica');
SELECT ok((SELECT bool_and(archived_at IS NOT NULL) FROM ai_conversations
            WHERE id IN ('00000000-0000-7000-8000-000000430001', '00000000-0000-7000-8000-000000430003',
                         '00000000-0000-7000-8000-000000430005')), 'extras com archived_at');
SELECT is((SELECT archived_reason FROM ai_conversations WHERE id = '00000000-0000-7000-8000-000000430007'), NULL,
          'já arquivada não é tocada');
SELECT is((SELECT count(*)::int FROM ai_conversations WHERE purpose <> 'chat' AND archived_at IS NULL), 2,
          'conversas de fluxo ficam ativas');
SELECT is((SELECT screen_context FROM ai_conversations WHERE id = '00000000-0000-7000-8000-000000430001'),
          '{"route": "/caixas"}'::jsonb, 'contexto da tela intacto');
SELECT results_eq($$SELECT conversation_id, count(*) FROM ai_messages GROUP BY conversation_id ORDER BY 1$$,
                  $$SELECT conversation_id, n FROM msgs_before ORDER BY 1$$, 'nenhuma mensagem apagada');
SELECT results_eq($$SELECT id, status, cancel_requested_at IS NOT NULL FROM ai_runs ORDER BY id$$,
                  $$VALUES ('00000000-0000-7000-8000-000000431001'::uuid, 'canceled', true),
                           ('00000000-0000-7000-8000-000000431005'::uuid, 'running', true)$$,
                  'na fila vira canceled; rodando recebe o pedido de cancelamento');
SELECT is(ai_chat_sessions_consolidate(), 0, 'idempotente');
CREATE UNIQUE INDEX ai_conversations_active_chat_key ON ai_conversations (user_id, agent_id)
  WHERE purpose = 'chat' AND archived_at IS NULL;

-- Sessão ativa única ----------------------------------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO ai_conversations (user_id, agent_id) VALUES
                   ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001')$$,
                 '23505', NULL, 'segunda sessão ativa do par é recusada');
SELECT lives_ok($$INSERT INTO ai_conversations (user_id, agent_id, archived_at, archived_reason) VALUES
                  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', now(), 'import_conflict')$$,
                'sessão já finalizada do par entra');
SELECT lives_ok($$INSERT INTO ai_conversations (user_id, agent_id, purpose) VALUES
                  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001', 'document_reading')$$,
                'conversa de fluxo fica fora da regra');
SELECT throws_ok($$UPDATE ai_conversations SET archived_reason = 'finished' WHERE id = '00000000-0000-7000-8000-000000430002'$$,
                 '23514', NULL, 'motivo só com archived_at');
SELECT throws_ok($$UPDATE ai_conversations SET archived_at = now(), archived_reason = 'outro'
                    WHERE id = '00000000-0000-7000-8000-000000430002'$$, '23514', NULL, 'motivo fora do vocabulário');

-- Finalizada não volta ------------------------------------------------------------------------------------------------
SELECT throws_ok($$UPDATE ai_conversations SET archived_at = NULL, archived_reason = NULL
                    WHERE id = '00000000-0000-7000-8000-000000430007'$$, '23514',
                 'ai_conversations: session 00000000-0000-7000-8000-000000430007 is finished and cannot become active again (fork it instead)',
                 'sessão chat finalizada não volta a ativa');
SELECT throws_ok($$UPDATE ai_conversations SET archived_at = NULL WHERE id = '00000000-0000-7000-8000-000000430003'$$,
                 '23514', NULL, 'nem a arquivada pela migração');
SELECT lives_ok($$UPDATE ai_conversations SET archived_at = now() - interval '1 day', title = 'Renomeada'
                   WHERE id = '00000000-0000-7000-8000-000000430007'$$, 'finalizada pode ser renomeada');
UPDATE ai_conversations SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000430008';
SELECT lives_ok($$UPDATE ai_conversations SET archived_at = NULL WHERE id = '00000000-0000-7000-8000-000000430008'$$,
                'conversa de fluxo pode ser desarquivada');

-- Arquivar com execução ativa ---------------------------------------------------------------------------------------
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000431002', '00000000-0000-7000-8000-000000430002', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
SELECT throws_ok($$UPDATE ai_conversations SET archived_at = now(), archived_reason = 'finished'
                    WHERE id = '00000000-0000-7000-8000-000000430002'$$, '23514',
                 'ai_conversations: session 00000000-0000-7000-8000-000000430002 has an active run; request its cancellation before finishing',
                 'execução na fila sem cancelamento pedido impede finalizar');
UPDATE ai_runs SET status = 'running', locked_at = now(), lock_token = gen_random_uuid()
 WHERE id = '00000000-0000-7000-8000-000000431002';
SELECT throws_ok($$UPDATE ai_conversations SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000430002'$$,
                 '23514', NULL, 'execução rodando sem cancelamento pedido impede finalizar');
-- Finalizar = pedir o parar e arquivar na mesma transação.
SELECT lives_ok($$UPDATE ai_runs SET cancel_requested_at = now() WHERE id = '00000000-0000-7000-8000-000000431002';
                  UPDATE ai_conversations SET archived_at = now(), archived_reason = 'finished'
                   WHERE id = '00000000-0000-7000-8000-000000430002'$$,
                'com o cancelamento pedido, finaliza');
SELECT is((SELECT status FROM ai_runs WHERE id = '00000000-0000-7000-8000-000000431002'), 'running',
          'a execução termina sozinha (o worker vê o pedido)');
SELECT lives_ok($$INSERT INTO ai_conversations (id, user_id, agent_id) VALUES
                  ('00000000-0000-7000-8000-00000043000a', '00000000-0000-7000-8000-0000000000a2',
                   '00000000-0000-7000-8000-0000000a3001')$$,
                'a próxima mensagem já abre a sessão nova');
-- Execução encerrada não impede.
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000431004', '00000000-0000-7000-8000-000000430004', '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3002');
UPDATE ai_runs SET status = 'canceled' WHERE id = '00000000-0000-7000-8000-000000431004';
SELECT lives_ok($$UPDATE ai_conversations SET archived_at = now(), archived_reason = 'finished'
                   WHERE id = '00000000-0000-7000-8000-000000430004'$$, 'execução encerrada não impede finalizar');
-- Conversa de fluxo com execução ativa: fora da regra.
INSERT INTO ai_runs (conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000430009', '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000a3001');
SELECT lives_ok($$UPDATE ai_conversations SET archived_at = now() WHERE id = '00000000-0000-7000-8000-000000430009'$$,
                'conversa de fluxo arquiva com execução ativa');

-- Bifurcação ----------------------------------------------------------------------------------------------------------
-- bia + Assistente: ativa = 0a; bifurca da 01 (finalizada) na 2ª mensagem.
SELECT lives_ok($$CREATE TEMP TABLE fork1 AS
                  SELECT ai_conversation_fork((SELECT id FROM ai_messages WHERE conversation_id = '00000000-0000-7000-8000-000000430001'
                                                AND seq = 2), '00000000-0000-7000-8000-0000000000a2') AS id$$,
                'bifurca de uma finalizada');
SELECT results_eq($$SELECT archived_at IS NOT NULL, archived_reason FROM ai_conversations
                     WHERE id = '00000000-0000-7000-8000-00000043000a'$$,
                  $$VALUES (true, 'forked')$$, 'a ativa anterior é finalizada como forked');
SELECT results_eq($$SELECT id FROM ai_conversations
                     WHERE user_id = '00000000-0000-7000-8000-0000000000a2' AND agent_id = '00000000-0000-7000-8000-0000000a3001'
                       AND purpose = 'chat' AND archived_at IS NULL$$,
                  $$SELECT id FROM fork1$$, 'a cópia é a sessão ativa');
SELECT results_eq($$SELECT forked_from_conversation_id, title, archived_reason FROM ai_conversations WHERE id = (SELECT id FROM fork1)$$,
                  $$VALUES ('00000000-0000-7000-8000-000000430001'::uuid, 'Velha', NULL::text)$$, 'ligada à origem, sem motivo');
SELECT is((SELECT count(*)::int FROM ai_messages WHERE conversation_id = (SELECT id FROM fork1)), 2, 'copia até o corte');
SELECT is((SELECT archived_reason FROM ai_conversations WHERE id = '00000000-0000-7000-8000-000000430001'),
          'migrated_from_multi', 'a origem finalizada fica como estava');

-- Bifurcar da própria ativa: a origem é finalizada e a cópia vira a ativa.
INSERT INTO ai_messages (conversation_id, role, content) VALUES
  ((SELECT id FROM fork1), 'user', '[{"type": "text", "text": "continua"}]');
SELECT lives_ok($$CREATE TEMP TABLE fork2 AS
                  SELECT ai_conversation_fork((SELECT id FROM ai_messages WHERE conversation_id = (SELECT id FROM fork1) AND seq = 3),
                                              '00000000-0000-7000-8000-0000000000a2', 'Ramo') AS id$$,
                'bifurca da ativa');
SELECT results_eq($$SELECT archived_reason FROM ai_conversations WHERE id = (SELECT id FROM fork1)$$,
                  $$VALUES ('forked'::text)$$, 'a origem ativa é finalizada');
SELECT results_eq($$SELECT title, title_source, archived_at IS NULL FROM ai_conversations WHERE id = (SELECT id FROM fork2)$$,
                  $$VALUES ('Ramo'::text, 'user'::text, true)$$, 'a cópia é a ativa, com o título pedido');

-- Bifurcar com execução ativa na ativa, sem o parar pedido: recusado, nada muda.
INSERT INTO ai_runs (id, conversation_id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-000000431010', (SELECT id FROM fork2), '00000000-0000-7000-8000-0000000000a2',
   '00000000-0000-7000-8000-0000000a3001');
SELECT throws_ok($$SELECT ai_conversation_fork((SELECT id FROM ai_messages WHERE conversation_id = '00000000-0000-7000-8000-000000430001'
                                                 AND seq = 1), '00000000-0000-7000-8000-0000000000a2')$$,
                 '23514', NULL, 'fork com execução ativa sem cancelamento é recusado');
SELECT results_eq($$SELECT id FROM ai_conversations
                     WHERE user_id = '00000000-0000-7000-8000-0000000000a2' AND agent_id = '00000000-0000-7000-8000-0000000a3001'
                       AND purpose = 'chat' AND archived_at IS NULL$$,
                  $$SELECT id FROM fork2$$, 'a ativa continua a mesma');
UPDATE ai_runs SET status = 'canceled', cancel_requested_at = now() WHERE id = '00000000-0000-7000-8000-000000431010';

-- Bifurcar para outro usuário: finaliza a ativa dele, não a do dono da origem.
SELECT lives_ok($$CREATE TEMP TABLE fork3 AS
                  SELECT ai_conversation_fork((SELECT id FROM ai_messages WHERE conversation_id = '00000000-0000-7000-8000-000000430002'
                                                AND seq = 1), '00000000-0000-7000-8000-0000000000a3') AS id$$,
                'bifurca para outro usuário');
SELECT results_eq($$SELECT archived_reason FROM ai_conversations WHERE id = '00000000-0000-7000-8000-000000430006'$$,
                  $$VALUES ('forked'::text)$$, 'a ativa do outro usuário é finalizada');
SELECT ok((SELECT archived_at IS NULL FROM ai_conversations WHERE id = (SELECT id FROM fork2)), 'a ativa da bia fica');
SELECT results_eq($$SELECT user_id, agent_id, archived_at IS NULL FROM ai_conversations WHERE id = (SELECT id FROM fork3)$$,
                  $$VALUES ('00000000-0000-7000-8000-0000000000a3'::uuid, '00000000-0000-7000-8000-0000000a3001'::uuid, true)$$,
                  'a cópia é a ativa do outro usuário');

-- Bifurcar de uma conversa de fluxo: a cópia é chat e finaliza a ativa do par.
INSERT INTO ai_messages (conversation_id, role, content) VALUES
  ('00000000-0000-7000-8000-000000430008', 'user', '[{"type": "text", "text": "leia o boleto"}]');
SELECT lives_ok($$CREATE TEMP TABLE fork4 AS
                  SELECT ai_conversation_fork((SELECT id FROM ai_messages WHERE conversation_id = '00000000-0000-7000-8000-000000430008'
                                                AND seq = 1), '00000000-0000-7000-8000-0000000000a2') AS id$$,
                'bifurca de uma conversa de fluxo');
SELECT results_eq($$SELECT purpose, archived_at IS NULL FROM ai_conversations WHERE id = (SELECT id FROM fork4)$$,
                  $$VALUES ('chat'::text, true)$$, 'a cópia é a sessão chat ativa');
SELECT results_eq($$SELECT archived_reason FROM ai_conversations WHERE id = (SELECT id FROM fork2)$$,
                  $$VALUES ('forked'::text)$$, 'a ativa anterior é finalizada');
SELECT ok((SELECT archived_at IS NULL FROM ai_conversations WHERE id = '00000000-0000-7000-8000-000000430008'),
          'a conversa de fluxo de origem não muda');

SELECT is((SELECT count(*)::int FROM (SELECT user_id, agent_id FROM ai_conversations
                                       WHERE purpose = 'chat' AND archived_at IS NULL
                                       GROUP BY 1, 2 HAVING count(*) > 1) d), 0, 'no fim, uma ativa por par');

SELECT * FROM finish();
ROLLBACK;
