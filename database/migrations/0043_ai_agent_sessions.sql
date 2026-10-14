-- migrate:up
-- F12, sessões dos agentes (spec 026; tarefa 026). Cada conversa purpose = 'chat' é uma sessão do fio contínuo de
-- (usuário, agente); no máximo uma ativa (archived_at nulo) por par.
--   * archived_reason: por que a sessão foi finalizada (finished, forked, migrated_from_multi, import_conflict); nula
--     = arquivada antes da F12 ou sem motivo informado. É a marca técnica da migração, numa coluna própria e não no
--     screen_context, que vai ao prompt do modelo e é copiado pela bifurcação.
--   * ai_chat_sessions_consolidate(): deixa uma ativa por par (a de last_message_at mais recente; empate ou nulos por
--     created_at e id), arquiva as outras com archived_reason = 'migrated_from_multi' e encerra as execuções ativas
--     delas (queued/awaiting_confirmation viram canceled; running recebe cancel_requested_at). Não apaga nada.
--   * ai_conversations_active_chat_key: índice único parcial (user_id, agent_id) das sessões chat ativas (23505).
--   * ai_conversations_archive_guard: sessão chat arquivada não volta (23514 ai_conversations_unarchive_check);
--     arquivar uma sessão chat com execução ativa só se o cancelamento dela já foi pedido (23514
--     ai_conversations_archive_active_run_check).
--   * ai_conversation_fork arquiva a sessão ativa do mesmo (usuário, agente) antes de criar a cópia (forked).
--   * pinned_at sai: o "fixar" deixou de existir (a lista agora é por agente).

-- Motivo do arquivamento ----------------------------------------------------------------------------------------------
ALTER TABLE ai_conversations
  ADD COLUMN archived_reason text,
  ADD CONSTRAINT ai_conversations_archived_reason_check
    CHECK (archived_reason IN ('finished', 'forked', 'migrated_from_multi', 'import_conflict')),
  ADD CONSTRAINT ai_conversations_archived_reason_archived_check
    CHECK (archived_reason IS NULL OR archived_at IS NOT NULL);

COMMENT ON COLUMN ai_conversations.archived_reason IS
  'Por que a sessão foi finalizada (spec 026): finished (o usuário finalizou), forked (ai_conversation_fork abriu uma '
  'sessão nova do mesmo par), migrated_from_multi (a migração 0043 deixou uma ativa por usuário e agente) ou '
  'import_conflict (a importação do backup trazia uma segunda ativa para o par). Nula = arquivada antes da F12 ou '
  'sem motivo. Só com archived_at preenchido.';
COMMENT ON COLUMN ai_conversations.archived_at IS
  'Arquivada (finalizada) desde; nula = ativa. Sessão chat: no máximo uma ativa por (user_id, agent_id) '
  '(ai_conversations_active_chat_key), não volta a ser ativa e só é arquivada sem execução ativa ou com o '
  'cancelamento dela já pedido (ai_conversations_archive_guard).';

-- Guarda do arquivamento ----------------------------------------------------------------------------------------------
CREATE FUNCTION ai_conversations_archive_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'ai_conversations: session % is finished and cannot become active again (fork it instead)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_conversations_unarchive_check';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM ai_runs r
                  WHERE r.conversation_id = NEW.id
                    AND r.status IN ('queued', 'running', 'awaiting_confirmation')
                    AND r.cancel_requested_at IS NULL) THEN
    RAISE EXCEPTION 'ai_conversations: session % has an active run; request its cancellation before finishing', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_conversations_archive_active_run_check';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION ai_conversations_archive_guard() IS
  'Trigger das sessões chat (spec 026): arquivada não volta a ativa (23514 ai_conversations_unarchive_check); '
  'arquivar com execução ativa (queued, running, awaiting_confirmation) só com cancel_requested_at já preenchido '
  '(23514 ai_conversations_archive_active_run_check). Conversas de fluxo (purpose <> chat) ficam de fora.';

-- O UPDATE do arquivamento trava a linha da conversa (FOR NO KEY UPDATE), a mesma trava do INSERT em ai_messages:
-- a checagem de execução ativa roda depois de uma mensagem concorrente terminar.
CREATE TRIGGER ai_conversations_archive_guard BEFORE UPDATE OF archived_at ON ai_conversations
  FOR EACH ROW WHEN (OLD.purpose = 'chat' AND OLD.archived_at IS DISTINCT FROM NEW.archived_at)
  EXECUTE FUNCTION ai_conversations_archive_guard();

-- Uma ativa por par ---------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_chat_sessions_consolidate() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  extras uuid[];
BEGIN
  -- Sem escrita concorrente nas conversas enquanto escolhe a ativa de cada par.
  LOCK TABLE ai_conversations IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(array_agg(x.id), '{}') INTO extras
    FROM (SELECT c.id,
                 row_number() OVER (PARTITION BY c.user_id, c.agent_id
                                    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC) AS rn
            FROM ai_conversations c
           WHERE c.purpose = 'chat' AND c.archived_at IS NULL) x
   WHERE x.rn > 1;
  IF cardinality(extras) = 0 THEN
    RETURN 0;
  END IF;

  -- Execuções ativas das que serão arquivadas: na fila ou esperando confirmação, canceladas na hora; rodando, com o
  -- cancelamento pedido (o worker encerra como canceled no próximo heartbeat).
  UPDATE ai_runs r
     SET cancel_requested_at = coalesce(r.cancel_requested_at, now()),
         status = CASE WHEN r.status = 'running' THEN r.status ELSE 'canceled' END
   WHERE r.conversation_id = ANY (extras)
     AND r.status IN ('queued', 'running', 'awaiting_confirmation');

  UPDATE ai_conversations c
     SET archived_at = now(), archived_reason = 'migrated_from_multi'
   WHERE c.id = ANY (extras);
  RETURN cardinality(extras);
END
$$;

COMMENT ON FUNCTION ai_chat_sessions_consolidate() IS
  'Manutenção da migração 0043 (spec 026), idempotente: para cada (usuário, agente) com mais de uma conversa chat '
  'ativa, mantém a de last_message_at mais recente (nulos por último; empate por created_at e id) e arquiva as outras '
  'com archived_reason = migrated_from_multi, encerrando as execuções ativas delas (queued e awaiting_confirmation '
  'viram canceled; running recebe cancel_requested_at). Nada é apagado. Devolve quantas arquivou. Só o dono do banco.';

REVOKE EXECUTE ON FUNCTION ai_chat_sessions_consolidate() FROM moneyflow_app;

SELECT ai_chat_sessions_consolidate();

CREATE UNIQUE INDEX ai_conversations_active_chat_key ON ai_conversations (user_id, agent_id)
  WHERE purpose = 'chat' AND archived_at IS NULL;

COMMENT ON INDEX ai_conversations_active_chat_key IS
  'Sessão ativa única (spec 026): no máximo uma conversa chat não arquivada por (usuário, agente). 23505 ao criar a '
  'segunda; finalize (arquive) a ativa antes, ou use ai_conversation_fork, que faz isso.';

-- Bifurcação: a cópia vira a sessão ativa -----------------------------------------------------------------------------
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
  'própria origem) e cria a sessão nova, que vira a ativa, copiando as mensagens da origem até p_message_id '
  '(inclusive, mesmos seq, sem run_id; anexos religados); devolve o id. Título = p_title ou o da origem. A cópia é '
  'sempre purpose chat (sem a chave purpose no screen_context), mesmo vinda de uma conversa de fluxo. Corte a '
  'bifurcação numa mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não '
  'existe; 23514 ai_conversations_archive_active_run_check se a sessão ativa tem execução ativa sem cancelamento '
  'pedido; 23505 se outra transação criou a ativa do par ao mesmo tempo.';

-- Fixar sai -----------------------------------------------------------------------------------------------------------
ALTER TABLE ai_conversations DROP COLUMN pinned_at;

COMMENT ON TABLE ai_conversations IS
  'Sessões do usuário com um agente (specs 011 e 026): purpose chat é o fio contínuo de (usuário, agente), com no '
  'máximo uma sessão ativa (ai_conversations_active_chat_key); finalizar = arquivar (archived_reason), sem volta; '
  'continuar de uma finalizada = bifurcar (ai_conversation_fork). Título automático e editável, excluir (apaga '
  'mensagens, execuções e eventos; o uso fica em ai_usage), buscar (ai_conversation_search). Conversas de fluxo '
  '(purpose <> chat) ficam fora da regra da sessão ativa. O admin pode ler as de todos (a aplicação aplica). Fora da '
  'auditoria.';

-- migrate:down
-- Desfaz a estrutura. As sessões arquivadas pela consolidação, pelo fork ou pelo usuário continuam arquivadas, as
-- execuções canceladas continuam canceladas, e pinned_at volta vazio.
ALTER TABLE ai_conversations ADD COLUMN pinned_at timestamptz;
COMMENT ON COLUMN ai_conversations.pinned_at IS 'Fixada desde (nulo = não fixada). Fixadas primeiro, mais recente primeiro.';

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
  'Bifurca: cria uma conversa de p_user_id com o mesmo agente, copia as mensagens da origem até p_message_id '
  '(inclusive, mesmos seq, sem run_id; anexos religados) e devolve o id. Título = p_title ou o da origem. A cópia é '
  'sempre purpose chat (sem a chave purpose no screen_context), mesmo vinda de uma conversa de fluxo. Corte a '
  'bifurcação numa mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não '
  'existe.';

DROP INDEX ai_conversations_active_chat_key;
DROP FUNCTION ai_chat_sessions_consolidate();
DROP TRIGGER ai_conversations_archive_guard ON ai_conversations;
DROP FUNCTION ai_conversations_archive_guard();
ALTER TABLE ai_conversations DROP COLUMN archived_reason;
COMMENT ON COLUMN ai_conversations.archived_at IS NULL;

COMMENT ON TABLE ai_conversations IS
  'Conversas do usuário com um agente (spec 011): título automático e editável, fixar, arquivar, excluir (apaga '
  'mensagens, execuções e eventos; o uso fica em ai_usage), buscar (ai_conversation_search) e bifurcar '
  '(ai_conversation_fork). O admin pode ler as de todos (a aplicação aplica). Fora da auditoria.';
