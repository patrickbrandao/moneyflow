-- migrate:up

-- Tarefa 160: a bifurcação copiava só seq, role e content das mensagens. Os vínculos da cópia nasciam do trigger
-- ai_messages_after_insert, que lê só os blocos attachment; o arquivo gerado por uma tool (spec 027) fica ligado à
-- mensagem tool por um INSERT explícito em ai_message_attachments e não era copiado. Na sessão nova o agente não o
-- achava ("o anexo não é desta sessão"), e excluir a conversa original apagava o arquivo que a cópia ainda citava.
-- Agora ai_conversation_fork copia todos os vínculos das mensagens copiadas, casando por seq.

CREATE OR REPLACE FUNCTION ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  src ai_conversations;
  upto integer;
  new_id uuid;
BEGIN
  SELECT c.* INTO src
    FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
   WHERE m.id = p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_conversation_fork: message % not found', p_message_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT m.seq INTO upto FROM ai_messages m WHERE m.id = p_message_id;

  -- Finaliza a sessão ativa do mesmo (usuário, agente), que pode ser a própria origem. Com execução ativa sem
  -- cancelamento pedido, ai_conversations_archive_guard recusa (23514).
  UPDATE ai_conversations c
     SET archived_at = now(), archived_reason = 'forked'
   WHERE c.user_id = p_user_id AND c.agent_id = src.agent_id AND c.purpose = 'chat' AND c.archived_at IS NULL;

  INSERT INTO ai_conversations (user_id, agent_id, title, title_source, forked_from_conversation_id,
                                forked_from_message_id, screen_context, purpose)
  VALUES (p_user_id, src.agent_id, coalesce(nullif(btrim(p_title), ''), src.title),
          CASE WHEN nullif(btrim(p_title), '') IS NOT NULL THEN 'user' ELSE src.title_source END,
          src.id, p_message_id, src.screen_context - 'purpose', 'chat')
  RETURNING id INTO new_id;

  INSERT INTO ai_messages (conversation_id, seq, role, content)
  SELECT new_id, m.seq, m.role, m.content
    FROM ai_messages m
   WHERE m.conversation_id = src.id AND m.seq <= upto
   ORDER BY m.seq;

  -- Os vínculos que não vêm de blocos attachment (os arquivos gerados pelas tools, spec 027); os dos blocos o trigger
  -- já criou.
  INSERT INTO ai_message_attachments (message_id, attachment_id)
  SELECT n.id, ma.attachment_id
    FROM ai_messages o
    JOIN ai_message_attachments ma ON ma.message_id = o.id
    JOIN ai_messages n ON n.conversation_id = new_id AND n.seq = o.seq
   WHERE o.conversation_id = src.id AND o.seq <= upto
  ON CONFLICT (message_id, attachment_id) DO NOTHING;
  RETURN new_id;
END
$$;

COMMENT ON FUNCTION ai_conversation_fork(uuid, uuid, text) IS
  'Bifurca: finaliza a sessão chat ativa de p_user_id com o agente da origem (archived_reason = forked; pode ser a '
  'própria origem) e cria a sessão nova, que vira a ativa, copiando as mensagens da origem até p_message_id (inclusive, '
  'mesmos seq, sem run_id) com todos os anexos delas em ai_message_attachments (os dos blocos attachment e os arquivos '
  'gerados pelas tools, tarefa 160; o áudio gerado por mensagem não é copiado, é refeito sob demanda); devolve o id. '
  'Título = p_title ou o da origem. A cópia é sempre purpose chat (sem a chave purpose no screen_context), mesmo vinda '
  'de uma conversa de fluxo. Corte a bifurcação numa mensagem que não deixe tool_use sem tool_result (a aplicação '
  'escolhe). P0002 se a mensagem não existe; 23514 ai_conversations_archive_active_run_check se a sessão ativa tem '
  'execução ativa sem cancelamento pedido; 23505 se outra transação criou a ativa do par ao mesmo tempo.';

-- migrate:down

CREATE OR REPLACE FUNCTION ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  src ai_conversations;
  upto integer;
  new_id uuid;
BEGIN
  SELECT c.* INTO src
    FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
   WHERE m.id = p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_conversation_fork: message % not found', p_message_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT m.seq INTO upto FROM ai_messages m WHERE m.id = p_message_id;

  -- Finaliza a sessão ativa do mesmo (usuário, agente), que pode ser a própria origem. Com execução ativa sem
  -- cancelamento pedido, ai_conversations_archive_guard recusa (23514).
  UPDATE ai_conversations c
     SET archived_at = now(), archived_reason = 'forked'
   WHERE c.user_id = p_user_id AND c.agent_id = src.agent_id AND c.purpose = 'chat' AND c.archived_at IS NULL;

  INSERT INTO ai_conversations (user_id, agent_id, title, title_source, forked_from_conversation_id,
                                forked_from_message_id, screen_context, purpose)
  VALUES (p_user_id, src.agent_id, coalesce(nullif(btrim(p_title), ''), src.title),
          CASE WHEN nullif(btrim(p_title), '') IS NOT NULL THEN 'user' ELSE src.title_source END,
          src.id, p_message_id, src.screen_context - 'purpose', 'chat')
  RETURNING id INTO new_id;

  INSERT INTO ai_messages (conversation_id, seq, role, content)
  SELECT new_id, m.seq, m.role, m.content
    FROM ai_messages m
   WHERE m.conversation_id = src.id AND m.seq <= upto
   ORDER BY m.seq;
  RETURN new_id;
END
$$;

COMMENT ON FUNCTION ai_conversation_fork(uuid, uuid, text) IS
  'Bifurca: finaliza a sessão chat ativa de p_user_id com o agente da origem (archived_reason = forked; pode ser a '
  'própria origem) e cria a sessão nova, que vira a ativa, copiando as mensagens da origem até p_message_id (inclusive, '
  'mesmos seq, sem run_id; anexos religados); devolve o id. Título = p_title ou o da origem. A cópia é sempre purpose '
  'chat (sem a chave purpose no screen_context), mesmo vinda de uma conversa de fluxo. Corte a bifurcação numa '
  'mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não existe; 23514 '
  'ai_conversations_archive_active_run_check se a sessão ativa tem execução ativa sem cancelamento pedido; 23505 se '
  'outra transação criou a ativa do par ao mesmo tempo.';
