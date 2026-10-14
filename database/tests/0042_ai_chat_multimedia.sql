-- Testes de 0042_ai_chat_multimedia: duração e páginas no anexo (validação e auditoria) e a fila da transcrição
-- (enfileirar, reservar com SKIP LOCKED entre duas sessões, retomar reserva velha, limite de tentativas, credenciais
-- pela reserva, concluir, falhar e "tentar de novo") e o papel da aplicação.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS dblink;
SELECT * FROM no_plan();

-- Executa um comando e devolve "SQLSTATE constraint" do erro (ou 'ok').
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

-- Estrutura ----------------------------------------------------------------------------------------------------
SELECT has_column('attachments', c) FROM unnest(ARRAY['duration_ms', 'page_count']) c;
SELECT col_type_is('attachments', c, 'integer') FROM unnest(ARRAY['duration_ms', 'page_count']) c;
SELECT col_is_null('attachments', c) FROM unnest(ARRAY['duration_ms', 'page_count']) c;
SELECT has_column('ai_attachment_derivatives', c) FROM unnest(ARRAY['lock_token', 'conversation_id']) c;
SELECT col_type_is('ai_attachment_derivatives', 'lock_token', 'uuid');
SELECT fk_ok('ai_attachment_derivatives', 'conversation_id', 'ai_conversations', 'id');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conname = 'ai_attachment_derivatives_conversation_id_fkey'), 'n',
          'conversa excluída: SET NULL (o cache do anexo fica)');
SELECT has_index('ai_attachment_derivatives', 'ai_attachment_derivatives_conversation_id_idx');
SELECT has_function('ai_transcription_enqueue', ARRAY['uuid', 'uuid', 'text', 'uuid']);
SELECT has_function('ai_transcription_claim', ARRAY['integer', 'interval', 'integer']);
SELECT has_function('ai_transcription_credentials', ARRAY['uuid', 'uuid']);
SELECT has_function('ai_transcription_complete', ARRAY['uuid', 'uuid', 'text']);
SELECT has_function('ai_transcription_fail', ARRAY['uuid', 'uuid', 'text']);
SELECT has_function('ai_transcription_retry', ARRAY['uuid']);
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'ai_transcription_credentials(uuid, uuid)'::regprocedure),
          'credenciais da transcrição são SECURITY DEFINER');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' roda com o papel de quem chama')
  FROM unnest(ARRAY['ai_transcription_enqueue(uuid, uuid, text, uuid)', 'ai_transcription_claim(integer, interval, integer)',
                    'ai_transcription_complete(uuid, uuid, text)', 'ai_transcription_fail(uuid, uuid, text)',
                    'ai_transcription_retry(uuid)']) f;
SELECT ok(has_function_privilege('moneyflow_app', f, 'EXECUTE'), 'app executa ' || f)
  FROM unnest(ARRAY['ai_transcription_enqueue(uuid, uuid, text, uuid)', 'ai_transcription_claim(integer, interval, integer)',
                    'ai_transcription_credentials(uuid, uuid)', 'ai_transcription_complete(uuid, uuid, text)',
                    'ai_transcription_fail(uuid, uuid, text)', 'ai_transcription_retry(uuid)']) f;
SELECT ok(NOT has_function_privilege('public', 'ai_transcription_credentials(uuid, uuid)', 'EXECUTE'),
          'PUBLIC não executa as credenciais da transcrição');

-- Duas sessões de verdade (dblink): SKIP LOCKED -------------------------------------------------------------------
-- Provedor, anexos e transcrições gravados fora desta transação (sessão c0, autocommit) e excluídos no fim da seção.
SELECT dblink_connect(c, format('dbname=%s user=%s', current_database(), current_user))
  FROM unnest(ARRAY['c0', 'c1', 'c2']) c;
SELECT dblink_exec('c0', $$INSERT INTO ai_providers (id, name, kind, api_key) VALUES
                          ('00000000-0000-7000-8000-0000000f4201', 'Concorrente 0042', 'openai', 'sk-proj-CONCORRENTE')$$);
SELECT dblink_exec('c0', $$INSERT INTO attachments (id, file_name, mime_type, content) VALUES
                          ('00000000-0000-7000-8000-0000000f4301', 'a.ogg', 'audio/ogg', '\x01'),
                          ('00000000-0000-7000-8000-0000000f4302', 'b.ogg', 'audio/ogg', '\x02')$$);
SELECT r.id FROM unnest(ARRAY['00000000-0000-7000-8000-0000000f4301', '00000000-0000-7000-8000-0000000f4302']) a,
       dblink('c0', format($$SELECT (ai_transcription_enqueue(%L, '00000000-0000-7000-8000-0000000f4201', 'whisper-1')).id$$, a))
         AS r (id uuid);
SELECT dblink_exec('c1', 'BEGIN');
CREATE TEMP TABLE w1 AS
SELECT * FROM dblink('c1', 'SELECT attachment_id FROM ai_transcription_claim(1)') AS r (attachment_id uuid);
CREATE TEMP TABLE w2 AS
SELECT * FROM dblink('c2', 'SELECT attachment_id FROM ai_transcription_claim(5)') AS r (attachment_id uuid);
SELECT is((SELECT attachment_id FROM w1), '00000000-0000-7000-8000-0000000f4301'::uuid, 'worker 1 reserva a mais antiga');
SELECT results_eq('SELECT attachment_id FROM w2', $$VALUES ('00000000-0000-7000-8000-0000000f4302'::uuid)$$,
                  'worker 2 pula a travada pelo 1 (SKIP LOCKED) e sem esperar');
SELECT is((SELECT count(*)::int FROM dblink('c2', 'SELECT id FROM ai_transcription_claim(5)') AS r (id uuid)), 0,
          'com o worker 1 ainda na transação, nada mais a reservar');
SELECT dblink_exec('c1', 'COMMIT');
SELECT is((SELECT count(*)::int FROM dblink('c2', 'SELECT id FROM ai_transcription_claim(5)') AS r (id uuid)), 0,
          'depois do COMMIT, a reservada pelo 1 não volta (está running)');
SELECT is((SELECT count(*)::int FROM ai_attachment_derivatives
            WHERE provider_id = '00000000-0000-7000-8000-0000000f4201' AND status = 'running' AND attempts = 1), 2,
          'cada transcrição reservada uma vez só');
SELECT dblink_exec('c0', $$DELETE FROM attachments WHERE id IN ('00000000-0000-7000-8000-0000000f4301',
                                                                  '00000000-0000-7000-8000-0000000f4302')$$);
SELECT dblink_exec('c0', $$DELETE FROM ai_providers WHERE id = '00000000-0000-7000-8000-0000000f4201'$$);
SELECT is_empty($$SELECT 1 FROM ai_attachment_derivatives WHERE provider_id = '00000000-0000-7000-8000-0000000f4201'$$,
                'transcrições saem com o anexo');
SELECT dblink_disconnect(c) FROM unnest(ARRAY['c0', 'c1', 'c2']) c;

-- Dados base -----------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role, is_active) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'ana', 'ana@example.com', 'segredo', 'admin', true),
  ('00000000-0000-7000-8000-0000000000a3', 'caio', 'caio@example.com', 'segredo', 'user', true);
INSERT INTO ai_providers (id, name, kind, api_key) VALUES
  ('00000000-0000-7000-8000-00000000f201', 'OpenAI', 'openai', 'sk-proj-SEGREDO-2222'),
  ('00000000-0000-7000-8000-00000000f202', 'Claude', 'anthropic', 'sk-ant-SEGREDO-1111');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES
  ('00000000-0000-7000-8000-00000000a201', 'Assistente', '00000000-0000-7000-8000-00000000f201', 'gpt-4.1');
INSERT INTO ai_conversations (id, user_id, agent_id) VALUES
  ('00000000-0000-7000-8000-00000000c201', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-00000000a201'),
  ('00000000-0000-7000-8000-00000000c202', '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-00000000a201');

-- Duração e páginas no anexo ---------------------------------------------------------------------------------------
INSERT INTO attachments (id, file_name, mime_type, content, duration_ms) VALUES
  ('00000000-0000-7000-8000-00000000d201', 'recado.webm', 'audio/webm', '\x1a45dfa3', 65000),
  ('00000000-0000-7000-8000-00000000d202', 'conta.mp3', 'audio/mpeg', '\x494433', NULL),
  ('00000000-0000-7000-8000-00000000d203', 'safari.mp4', 'video/mp4', '\x00000018', 1),
  ('00000000-0000-7000-8000-00000000d204', 'longo.ogg', 'audio/ogg', '\x4f676753', 86400000),
  ('00000000-0000-7000-8000-00000000d205', 'outro.ogg', 'audio/ogg', '\x4f676754', NULL);
INSERT INTO attachments (id, file_name, mime_type, content, page_count) VALUES
  ('00000000-0000-7000-8000-00000000d206', 'boleto.pdf', 'application/pdf', '\x25504446', 3);
SELECT results_eq($$SELECT duration_ms, page_count FROM attachments
                     WHERE id IN ('00000000-0000-7000-8000-00000000d201', '00000000-0000-7000-8000-00000000d206') ORDER BY id$$,
                  $$VALUES (65000, NULL::int), (NULL, 3)$$, 'duração do áudio e páginas do PDF gravadas');
SELECT is(pg_temp.err(c), e, 'anexo: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$INSERT INTO attachments (file_name, mime_type, content, duration_ms) VALUES ('a.ogg', 'audio/ogg', '\x01', 0)$$,
     '23514 attachments_duration_ms_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, duration_ms) VALUES ('a.ogg', 'audio/ogg', '\x01', -5)$$,
     '23514 attachments_duration_ms_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, duration_ms) VALUES ('a.ogg', 'audio/ogg', '\x01', 86400001)$$,
     '23514 attachments_duration_ms_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, duration_ms) VALUES ('a.png', 'image/png', '\x01', 1000)$$,
     '23514 attachments_duration_ms_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, duration_ms) VALUES ('a.bin', 'application/octet-stream', '\x01', 1000)$$,
     '23514 attachments_duration_ms_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, page_count) VALUES ('a.pdf', 'application/pdf', '\x01', 0)$$,
     '23514 attachments_page_count_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, page_count) VALUES ('a.pdf', 'application/pdf', '\x01', 100001)$$,
     '23514 attachments_page_count_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, page_count) VALUES ('a.ogg', 'audio/ogg', '\x01', 2)$$,
     '23514 attachments_page_count_check'),
    ($$INSERT INTO attachments (file_name, mime_type, content, page_count) VALUES ('a.pdf', 'application/pdf', '\x01', 100000)$$, 'ok'),
    ($$UPDATE attachments SET mime_type = 'image/png' WHERE id = '00000000-0000-7000-8000-00000000d206'$$,
     '23514 attachments_page_count_check'),
    ($$UPDATE attachments SET mime_type = 'application/pdf' WHERE id = '00000000-0000-7000-8000-00000000d201'$$,
     '23514 attachments_duration_ms_check')
  ) x (c, e);
-- Preencher depois do upload pode; a auditoria registra
UPDATE attachments SET duration_ms = 42000 WHERE id = '00000000-0000-7000-8000-00000000d202';
SELECT results_eq($$SELECT changed_columns, (old_data ->> 'duration_ms') IS NULL, (new_data ->> 'duration_ms')::int, new_data ? 'content'
                      FROM audit_log WHERE table_name = 'attachments' AND action = 'update'
                       AND record_id = '00000000-0000-7000-8000-00000000d202'$$,
                  $$VALUES (ARRAY['duration_ms'], true, 42000, false)$$, 'duração auditada (sem o conteúdo)');
SELECT is((SELECT (new_data ->> 'page_count')::int FROM audit_log WHERE table_name = 'attachments' AND action = 'insert'
            AND record_id = '00000000-0000-7000-8000-00000000d206'), 3, 'páginas no INSERT auditado');

-- Enfileirar --------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE e1 AS SELECT * FROM ai_transcription_enqueue('00000000-0000-7000-8000-00000000d201',
  '00000000-0000-7000-8000-00000000f201', 'whisper-1', '00000000-0000-7000-8000-00000000c201');
SELECT results_eq($$SELECT kind, status, attempts::int, conversation_id, content IS NULL, lock_token IS NULL FROM e1$$,
                  $$VALUES ('transcription', 'pending', 0, '00000000-0000-7000-8000-00000000c201'::uuid, true, true)$$,
                  'enfileira pending, com a conversa');
SELECT is((SELECT id FROM ai_transcription_enqueue('00000000-0000-7000-8000-00000000d201', '00000000-0000-7000-8000-00000000f201',
                                                   'whisper-1')), (SELECT id FROM e1), 'enfileirar de novo devolve a existente');
SELECT is((SELECT count(*)::int FROM ai_attachment_derivatives WHERE attachment_id = '00000000-0000-7000-8000-00000000d201'), 1,
          'sem duplicar');
SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d202', '00000000-0000-7000-8000-00000000f201', 'whisper-1');
SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d203', '00000000-0000-7000-8000-00000000f201', 'whisper-1',
                                '00000000-0000-7000-8000-00000000c201');
-- Outros tipos pendentes não entram na fila da transcrição
INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model) VALUES
  ('00000000-0000-7000-8000-00000000d206', 'description', '00000000-0000-7000-8000-00000000f201', 'gpt-4.1');
SELECT is(pg_temp.err(c), e, 'enfileirar: ' || regexp_replace(c, '\s+', ' ', 'g'))
  FROM (VALUES
    ($$SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d204', '00000000-0000-7000-8000-00000000f201', 'whisper 1')$$,
     '23514 ai_attachment_derivatives_model_check'),
    ($$SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d204', '00000000-0000-7000-8000-00000000f201', NULL)$$,
     '23514 ai_attachment_derivatives_provider_check'),
    ($$SELECT ai_transcription_enqueue('00000000-0000-7000-8000-0000000000ff', '00000000-0000-7000-8000-00000000f201', 'whisper-1')$$,
     '23503 ai_attachment_derivatives_attachment_id_fkey'),
    ($$SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d204', '00000000-0000-7000-8000-00000000f201', 'whisper-1',
                                       '00000000-0000-7000-8000-0000000000ff')$$,
     '23503 ai_attachment_derivatives_conversation_id_fkey')
  ) x (c, e);

-- Reservar --------------------------------------------------------------------------------------------------------
SELECT is(pg_temp.err(c), '22023 ', 'claim: parâmetro inválido ' || c)
  FROM unnest(ARRAY['SELECT ai_transcription_claim(0)', 'SELECT ai_transcription_claim(101)',
                    $$SELECT ai_transcription_claim(1, '29 seconds')$$, $$SELECT ai_transcription_claim(1, NULL)$$,
                    $$SELECT ai_transcription_claim(1, '10 minutes', 0)$$, $$SELECT ai_transcription_claim(1, '10 minutes', 101)$$]) c;
CREATE TEMP TABLE k1 AS SELECT * FROM ai_transcription_claim(2);
SELECT results_eq($$SELECT attachment_id, status, attempts::int, locked_at IS NOT NULL, lock_token IS NOT NULL FROM k1 ORDER BY id$$,
                  $$VALUES ('00000000-0000-7000-8000-00000000d201'::uuid, 'running', 1, true, true),
                           ('00000000-0000-7000-8000-00000000d202'::uuid, 'running', 1, true, true)$$,
                  'reserva as duas mais antigas: running, tentativa 1, com a cerca');
CREATE TEMP TABLE k2 AS SELECT * FROM ai_transcription_claim(5);
SELECT results_eq('SELECT attachment_id FROM k2', $$VALUES ('00000000-0000-7000-8000-00000000d203'::uuid)$$,
                  'depois, só a que sobrou (a descrição pendente fica de fora)');
SELECT is_empty('SELECT * FROM ai_transcription_claim(5)', 'fila vazia: as reservadas não voltam antes de envelhecer');
SELECT is(pg_temp.err($$UPDATE ai_attachment_derivatives SET lock_token = NULL WHERE attachment_id = '00000000-0000-7000-8000-00000000d203'$$),
          '23514 ai_attachment_derivatives_lock_check', 'running exige a cerca');
SELECT is(pg_temp.err($$UPDATE ai_attachment_derivatives SET lock_token = gen_random_uuid() WHERE kind = 'description'$$),
          '23514 ai_attachment_derivatives_lock_check', 'cerca só em running');

-- Credenciais pela reserva ----------------------------------------------------------------------------------------
SELECT results_eq(format($$SELECT provider_id, kind, base_url, api_key, model, attachment_id, conversation_id, user_id, agent_id
                             FROM ai_transcription_credentials(%L, %L)$$,
                         (SELECT id FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201'),
                         (SELECT lock_token FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201')),
                  $$VALUES ('00000000-0000-7000-8000-00000000f201'::uuid, 'openai', NULL::text, 'sk-proj-SEGREDO-2222', 'whisper-1',
                            '00000000-0000-7000-8000-00000000d201'::uuid, '00000000-0000-7000-8000-00000000c201'::uuid,
                            '00000000-0000-7000-8000-0000000000a1'::uuid, '00000000-0000-7000-8000-00000000a201'::uuid)$$,
                  'credenciais: provedor, chave, modelo e a atribuição pela conversa');
SELECT results_eq(format($$SELECT conversation_id, user_id, agent_id FROM ai_transcription_credentials(%L, %L)$$,
                         (SELECT id FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d202'),
                         (SELECT lock_token FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d202')),
                  $$VALUES (NULL::uuid, NULL::uuid, NULL::uuid)$$, 'sem conversa, sem atribuição');
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, gen_random_uuid())$$, (SELECT id FROM k2))),
          '23514 ai_attachment_derivatives_lock_check', 'credenciais: cerca errada');
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, NULL)$$, (SELECT id FROM k2))),
          '23514 ai_attachment_derivatives_lock_check', 'credenciais: sem cerca');
SELECT is(pg_temp.err($$SELECT * FROM ai_transcription_credentials('00000000-0000-7000-8000-0000000000ff', gen_random_uuid())$$),
          'P0002 ', 'credenciais: transcrição inexistente');
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, gen_random_uuid())$$,
                             (SELECT id FROM ai_attachment_derivatives WHERE kind = 'description'))),
          'P0002 ', 'credenciais: outro tipo de derivado');
-- Provedor inativo, sem a flag; dono ou agente da conversa inativo: 42501
UPDATE ai_providers SET is_active = false WHERE id = '00000000-0000-7000-8000-00000000f201';
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, %L)$$, id, lock_token)), '42501 ',
          'credenciais: provedor inativo') FROM k2;
UPDATE ai_providers SET is_active = true WHERE id = '00000000-0000-7000-8000-00000000f201';
UPDATE users SET is_active = false WHERE id = '00000000-0000-7000-8000-0000000000a1';
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, %L)$$, id, lock_token)), '42501 ',
          'credenciais: dono da conversa inativo') FROM k2;
UPDATE users SET is_active = true WHERE id = '00000000-0000-7000-8000-0000000000a1';
UPDATE ai_agents SET is_active = false WHERE id = '00000000-0000-7000-8000-00000000a201';
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, %L)$$, id, lock_token)), '42501 ',
          'credenciais: agente da conversa inativo') FROM k2;
UPDATE ai_agents SET is_active = true WHERE id = '00000000-0000-7000-8000-00000000a201';
SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d205', '00000000-0000-7000-8000-00000000f202', 'claude-x');
CREATE TEMP TABLE k3 AS SELECT * FROM ai_transcription_claim(1);
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, %L)$$, id, lock_token)), '42501 ',
          'credenciais: provedor sem a flag transcription') FROM k3;

-- Concluir e falhar -------------------------------------------------------------------------------------------------
SELECT is(ai_transcription_complete(id, gen_random_uuid(), 'x'), false, 'concluir com a cerca errada não grava')
  FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201';
SELECT is(pg_temp.err(format($$SELECT ai_transcription_complete(%L, %L, NULL)$$, id, lock_token)),
          '23514 ai_attachment_derivatives_result_check', 'concluir sem texto') FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201';
SELECT is(ai_transcription_complete(id, lock_token, 'Pague a luz.'), true, 'concluir')
  FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201';
SELECT results_eq($$SELECT status, content, error, locked_at IS NULL, lock_token IS NULL FROM ai_attachment_derivatives
                     WHERE attachment_id = '00000000-0000-7000-8000-00000000d201'$$,
                  $$VALUES ('done', 'Pague a luz.', NULL::text, true, true)$$, 'done com o texto, sem reserva');
SELECT is(ai_transcription_complete(id, lock_token, 'outra'), false, 'concluir de novo não grava')
  FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201';
SELECT is(ai_transcription_fail(id, lock_token, 'x'), false, 'falhar a concluída não grava')
  FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201';
SELECT is(ai_transcription_complete(id, lock_token, ''), true, 'texto vazio (áudio mudo) vale') FROM k3;
SELECT is(ai_transcription_fail(id, lock_token, repeat('e', 5000)), true, 'falhar')
  FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d202';
SELECT results_eq($$SELECT status, length(error), locked_at IS NULL, lock_token IS NULL FROM ai_attachment_derivatives
                     WHERE attachment_id = '00000000-0000-7000-8000-00000000d202'$$,
                  $$VALUES ('failed', 4000, true, true)$$, 'failed com o erro cortado em 4000');
SELECT is(ai_transcription_fail(id, lock_token, '   '), true, 'falhar sem mensagem') FROM k2;
SELECT is((SELECT error FROM ai_attachment_derivatives WHERE attachment_id = '00000000-0000-7000-8000-00000000d203'),
          'transcription failed', 'mensagem padrão');
SELECT is_empty('SELECT * FROM ai_transcription_claim(5)', 'failed não volta sozinho à fila');

-- Tentar de novo ----------------------------------------------------------------------------------------------------
SELECT results_eq(format($$SELECT status, attempts::int, error FROM ai_transcription_retry(%L)$$, (SELECT id FROM k2)),
                  $$VALUES ('pending', 0, NULL::text)$$, 'tentar de novo: pending, tentativas zeradas, sem erro');
SELECT results_eq(format($$SELECT status, attempts::int FROM ai_transcription_retry(%L)$$, (SELECT id FROM k2)),
                  $$VALUES ('pending', 0)$$, 'clique repetido: devolve como está');
SELECT results_eq(format($$SELECT status, content FROM ai_transcription_retry(%L)$$,
                         (SELECT id FROM k1 WHERE attachment_id = '00000000-0000-7000-8000-00000000d201')),
                  $$VALUES ('done', 'Pague a luz.')$$, 'concluída não muda');
SELECT is(pg_temp.err($$SELECT ai_transcription_retry('00000000-0000-7000-8000-0000000000ff')$$), 'P0002 ',
          'tentar de novo: inexistente');
SELECT is(pg_temp.err(format($$SELECT ai_transcription_retry(%L)$$, (SELECT id FROM ai_attachment_derivatives WHERE kind = 'description'))),
          'P0002 ', 'tentar de novo: outro tipo de derivado');
SELECT results_eq('SELECT attachment_id, attempts::int FROM ai_transcription_claim(5)',
                  $$VALUES ('00000000-0000-7000-8000-00000000d203'::uuid, 1)$$, 'volta à fila e é reservada');

-- Reserva velha (worker caiu) e limite de tentativas ----------------------------------------------------------------
CREATE TEMP TABLE old_token AS
SELECT lock_token FROM ai_attachment_derivatives WHERE attachment_id = '00000000-0000-7000-8000-00000000d203';
UPDATE ai_attachment_derivatives SET locked_at = now() - interval '9 minutes'
 WHERE attachment_id = '00000000-0000-7000-8000-00000000d203';
SELECT is_empty('SELECT * FROM ai_transcription_claim(5)', 'reserva com 9 min ainda vale (padrão 10 min)');
UPDATE ai_attachment_derivatives SET locked_at = now() - interval '11 minutes'
 WHERE attachment_id = '00000000-0000-7000-8000-00000000d203';
CREATE TEMP TABLE k4 AS SELECT * FROM ai_transcription_claim(5);
SELECT results_eq('SELECT attachment_id, attempts::int FROM k4', $$VALUES ('00000000-0000-7000-8000-00000000d203'::uuid, 2)$$,
                  'reserva velha retomada: tentativa 2');
SELECT ok((SELECT lock_token FROM k4) <> (SELECT lock_token FROM old_token), 'com cerca nova');
SELECT is(ai_transcription_complete((SELECT id FROM k4), (SELECT lock_token FROM old_token), 'atrasado'), false,
          'o worker que caiu não grava por cima');
SELECT is(pg_temp.err(format($$SELECT * FROM ai_transcription_credentials(%L, %L)$$, (SELECT id FROM k4), (SELECT lock_token FROM old_token))),
          '23514 ai_attachment_derivatives_lock_check', 'nem lê a chave');
UPDATE ai_attachment_derivatives SET locked_at = now() - interval '3 minutes'
 WHERE attachment_id = '00000000-0000-7000-8000-00000000d203';
SELECT is_empty($$SELECT * FROM ai_transcription_claim(5, '2 minutes', 2)$$, 'sem tentativas restantes: não reserva');
SELECT results_eq($$SELECT status, error, locked_at IS NULL, lock_token IS NULL FROM ai_attachment_derivatives
                     WHERE attachment_id = '00000000-0000-7000-8000-00000000d203'$$,
                  $$VALUES ('failed', 'stale_lock: worker stopped and the transcription has no attempts left', true, true)$$,
                  'reserva velha sem tentativas vira failed');
SELECT ai_transcription_enqueue('00000000-0000-7000-8000-00000000d204', '00000000-0000-7000-8000-00000000f201', 'whisper-1');
UPDATE ai_attachment_derivatives SET attempts = 3 WHERE attachment_id = '00000000-0000-7000-8000-00000000d204';
SELECT is_empty('SELECT * FROM ai_transcription_claim(5)', 'pendente sem tentativas restantes: não reserva');
SELECT results_eq($$SELECT status, error FROM ai_attachment_derivatives WHERE attachment_id = '00000000-0000-7000-8000-00000000d204'$$,
                  $$VALUES ('failed', 'max_attempts: the transcription has no attempts left')$$, 'e vira failed');
SELECT is((SELECT count(*)::int FROM audit_log WHERE table_name = 'ai_attachment_derivatives'), 0, 'fila fora da auditoria');

-- Conversa excluída: o cache do anexo fica, sem a atribuição -----------------------------------------------------------
DELETE FROM ai_conversations WHERE id = '00000000-0000-7000-8000-00000000c201';
SELECT results_eq($$SELECT status, conversation_id FROM ai_attachment_derivatives
                     WHERE attachment_id = '00000000-0000-7000-8000-00000000d201'$$,
                  $$VALUES ('done', NULL::uuid)$$, 'transcrição fica, conversation_id nulo');
DELETE FROM attachments WHERE id = '00000000-0000-7000-8000-00000000d201';
SELECT is_empty($$SELECT 1 FROM ai_attachment_derivatives WHERE attachment_id = '00000000-0000-7000-8000-00000000d201'$$,
                'e sai com o anexo');

-- O papel da aplicação -----------------------------------------------------------------------------------------
SET LOCAL ROLE moneyflow_app;
SELECT lives_ok($$INSERT INTO attachments (id, file_name, mime_type, content, uploaded_by_user_id, duration_ms) VALUES
                    ('00000000-0000-7000-8000-00000000d207', 'gravado.webm', 'audio/webm', '\x1a45dfa4',
                     '00000000-0000-7000-8000-0000000000a3', 600000)$$, 'app: grava a duração no upload');
SELECT lives_ok($$UPDATE attachments SET page_count = 4 WHERE id = '00000000-0000-7000-8000-00000000d206'$$,
                'app: atualiza as páginas');
CREATE TEMP TABLE a1 AS SELECT * FROM ai_transcription_enqueue('00000000-0000-7000-8000-00000000d207',
  '00000000-0000-7000-8000-00000000f201', 'whisper-1', '00000000-0000-7000-8000-00000000c202');
CREATE TEMP TABLE a2 AS SELECT * FROM ai_transcription_claim(5);
SELECT results_eq('SELECT attachment_id FROM a2', $$VALUES ('00000000-0000-7000-8000-00000000d207'::uuid)$$, 'app: reserva');
SELECT is((SELECT api_key FROM ai_transcription_credentials((SELECT id FROM a2), (SELECT lock_token FROM a2))),
          'sk-proj-SEGREDO-2222', 'app: lê a chave pela reserva');
SELECT is((SELECT user_id FROM ai_transcription_credentials((SELECT id FROM a2), (SELECT lock_token FROM a2))),
          '00000000-0000-7000-8000-0000000000a3'::uuid, 'app: atribuição ao dono da conversa');
SELECT is(ai_transcription_fail((SELECT id FROM a2), (SELECT lock_token FROM a2), 'HTTP 500'), true, 'app: falha');
SELECT is((SELECT status FROM ai_transcription_retry((SELECT id FROM a2))), 'pending', 'app: tentar de novo');
SELECT is((SELECT attempts::int FROM ai_transcription_claim(1)), 1, 'app: reserva de novo');
SELECT is(ai_transcription_complete((SELECT id FROM a2),
                                    (SELECT lock_token FROM ai_attachment_derivatives WHERE id = (SELECT id FROM a2)), 'Oi.'),
          true, 'app: conclui');
SELECT throws_ok($$SELECT api_key FROM ai_providers$$, '42501', NULL, 'app: a chave continua fora do SELECT');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
