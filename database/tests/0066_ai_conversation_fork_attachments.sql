-- Testes de 0066_ai_conversation_fork_attachments (tarefa 160): a bifurcação copia todos os vínculos de anexo das
-- mensagens copiadas, inclusive o arquivo gerado por uma tool (ligado à mensagem tool sem bloco attachment), e excluir a
-- conversa original não deixa a cópia sem o arquivo.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-7000-8000-00000066' || p)::uuid $$;
CREATE FUNCTION pg_temp.links(p_conversation uuid) RETURNS TABLE (seq int, attachment_id uuid)
LANGUAGE sql AS $$
  SELECT m.seq, ma.attachment_id FROM ai_messages m JOIN ai_message_attachments ma ON ma.message_id = m.id
   WHERE m.conversation_id = p_conversation ORDER BY 1, 2
$$;

-- Dados base --------------------------------------------------------------------------------------------------------------
INSERT INTO users (id, username, email, password, role) VALUES (pg_temp.u('0a01'), 'bia66', 'bia66@example.com', 'segredo', 'user');
INSERT INTO ai_providers (id, name, kind, api_key) VALUES (pg_temp.u('1001'), 'Claude66', 'anthropic', 'sk-ant-api03-SEGREDO66');
INSERT INTO ai_agents (id, name, provider_id, model) VALUES (pg_temp.u('3001'), 'Assistente66', pg_temp.u('1001'), 'claude-sonnet-4-5');
INSERT INTO attachments (id, file_name, mime_type, content, uploaded_by_user_id) VALUES
  (pg_temp.u('a001'), 'extrato.ofx', 'application/x-ofx', '\x01', pg_temp.u('0a01')),
  (pg_temp.u('a002'), 'categorias.csv', 'text/csv', '\x02', NULL),
  (pg_temp.u('a003'), 'depois.csv', 'text/csv', '\x03', NULL);

INSERT INTO ai_conversations (id, user_id, agent_id, title) VALUES (pg_temp.u('c001'), pg_temp.u('0a01'), pg_temp.u('3001'), 'Origem');
INSERT INTO ai_messages (id, conversation_id, seq, role, content) VALUES
  (pg_temp.u('e001'), pg_temp.u('c001'), 1, 'user',
   jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'exporte as categorias'),
                     jsonb_build_object('type', 'attachment', 'attachment_id', pg_temp.u('a001')))),
  (pg_temp.u('e002'), pg_temp.u('c001'), 2, 'assistant',
   '[{"type": "tool_use", "id": "t1", "name": "export_categories", "input": {}}]'),
  (pg_temp.u('e003'), pg_temp.u('c001'), 3, 'tool',
   '[{"type": "tool_result", "tool_use_id": "t1", "content": "arquivo gerado"}]'),
  (pg_temp.u('e004'), pg_temp.u('c001'), 4, 'assistant', '[{"type": "text", "text": "pronto"}]'),
  (pg_temp.u('e005'), pg_temp.u('c001'), 5, 'tool',
   '[{"type": "tool_result", "tool_use_id": "t2", "content": "outro"}]');
-- O arquivo gerado pela tool (spec 027): ligado à mensagem tool por INSERT explícito, sem bloco attachment.
INSERT INTO ai_message_attachments (message_id, attachment_id) VALUES
  (pg_temp.u('e003'), pg_temp.u('a002')),
  (pg_temp.u('e005'), pg_temp.u('a003'));
-- O mesmo anexo do bloco também ligado à mão (não duplica na cópia).
INSERT INTO ai_message_attachments (message_id, attachment_id) VALUES (pg_temp.u('e001'), pg_temp.u('a001'))
  ON CONFLICT DO NOTHING;

SELECT results_eq($$SELECT * FROM pg_temp.links(pg_temp.u('c001'))$$,
                  $$VALUES (1, pg_temp.u('a001')), (3, pg_temp.u('a002')), (5, pg_temp.u('a003'))$$,
                  'origem: o anexo do bloco e os dois arquivos gerados');

-- Bifurca na 4ª mensagem ---------------------------------------------------------------------------------------------------
CREATE TEMP TABLE fork1 AS SELECT ai_conversation_fork(pg_temp.u('e004'), pg_temp.u('0a01')) AS id;
SELECT is((SELECT count(*)::int FROM ai_messages WHERE conversation_id = (SELECT id FROM fork1)), 4, 'copia até o corte');
SELECT results_eq($$SELECT * FROM pg_temp.links((SELECT id FROM fork1))$$,
                  $$VALUES (1, pg_temp.u('a001')), (3, pg_temp.u('a002'))$$,
                  'a cópia tem o anexo do bloco e o arquivo gerado pela tool, sem duplicar e sem o de depois do corte');
SELECT results_eq($$SELECT * FROM pg_temp.links(pg_temp.u('c001'))$$,
                  $$VALUES (1, pg_temp.u('a001')), (3, pg_temp.u('a002')), (5, pg_temp.u('a003'))$$,
                  'a origem continua com os vínculos dela');

-- A tool da sessão nova acha o arquivo: ele está numa mensagem da conversa da cópia (o critério de toolAttachment).
SELECT ok(EXISTS (SELECT 1 FROM ai_message_attachments ma JOIN ai_messages m ON m.id = ma.message_id
                   WHERE m.conversation_id = (SELECT id FROM fork1) AND ma.attachment_id = pg_temp.u('a002')),
          'o arquivo gerado é da sessão bifurcada');

-- Bifurcar a cópia de novo leva os vínculos adiante.
CREATE TEMP TABLE fork2 AS
  SELECT ai_conversation_fork((SELECT id FROM ai_messages WHERE conversation_id = (SELECT id FROM fork1) AND seq = 3),
                              pg_temp.u('0a01'), 'Ramo') AS id;
SELECT results_eq($$SELECT * FROM pg_temp.links((SELECT id FROM fork2))$$,
                  $$VALUES (1, pg_temp.u('a001')), (3, pg_temp.u('a002'))$$, 'a bifurcação da bifurcação também');

-- Excluir a original: o arquivo que a cópia cita continua ligado (deleteConversation só apaga os que ficam órfãos).
DELETE FROM ai_conversations WHERE id = pg_temp.u('c001');
SELECT results_eq($$SELECT l.attachment_id FROM attachment_links l
                     WHERE l.attachment_id IN (pg_temp.u('a001'), pg_temp.u('a002'), pg_temp.u('a003'))
                     GROUP BY 1 ORDER BY 1$$,
                  $$VALUES (pg_temp.u('a001')), (pg_temp.u('a002'))$$,
                  'sem a original, os anexos da cópia continuam em attachment_links; só o de depois do corte fica órfão');

SELECT * FROM finish();
ROLLBACK;
