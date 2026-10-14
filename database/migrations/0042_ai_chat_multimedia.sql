-- migrate:up
-- F11, chat multimídia (spec 025; tarefa 024). A tabela de derivados veio inteira na 0041; aqui entram:
-- attachments.duration_ms / page_count: duração do áudio e páginas do PDF, conhecidas no upload (antes de a mensagem
--   existir; por isso no anexo e não em ai_message_attachments). Opcionais, preenchidos pela aplicação.
-- Fila da transcrição sobre ai_attachment_derivatives (kind = 'transcription'):
--   lock_token (cerca da reserva, como ai_runs) e conversation_id (onde foi pedida: o worker atribui uso e requisição
--   ao usuário e ao agente da conversa);
--   ai_transcription_enqueue (enfileira ou devolve o existente), ai_transcription_claim (SKIP LOCKED, retoma reserva
--   velha, desiste no limite de tentativas), ai_transcription_credentials (chave do provedor só para quem tem a
--   reserva), ai_transcription_complete / ai_transcription_fail (cercadas pelo lock_token) e ai_transcription_retry
--   ("Tentar de novo": failed → pending).

-- Metadados do anexo ------------------------------------------------------------------------------------------------
ALTER TABLE attachments
  ADD COLUMN duration_ms integer,
  ADD COLUMN page_count integer,
  ADD CONSTRAINT attachments_duration_ms_check
    CHECK (duration_ms IS NULL OR (duration_ms BETWEEN 1 AND 86400000 AND mime_type ~ '^(audio|video)/')),
  ADD CONSTRAINT attachments_page_count_check
    CHECK (page_count IS NULL OR (page_count BETWEEN 1 AND 100000 AND mime_type = 'application/pdf'));

COMMENT ON COLUMN attachments.duration_ms IS
  'Duração do áudio em milissegundos (1 ms a 24 h; só com mime_type audio/* ou video/*). Opcional, preenchida pela '
  'aplicação no upload (spec 025).';
COMMENT ON COLUMN attachments.page_count IS
  'Número de páginas do PDF (1 a 100 mil; só com mime_type application/pdf). Opcional, preenchido pela aplicação no '
  'upload (spec 025).';

-- A auditoria do anexo passa a registrar os dois metadados (o conteúdo continua fora).
CREATE OR REPLACE FUNCTION attachments_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  changed text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    o := jsonb_build_object('id', OLD.id, 'file_name', OLD.file_name, 'mime_type', OLD.mime_type,
                            'size_bytes', OLD.size_bytes, 'sha256', OLD.sha256,
                            'duration_ms', OLD.duration_ms, 'page_count', OLD.page_count,
                            'uploaded_by_user_id', OLD.uploaded_by_user_id,
                            'created_at', OLD.created_at, 'updated_at', OLD.updated_at);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := jsonb_build_object('id', NEW.id, 'file_name', NEW.file_name, 'mime_type', NEW.mime_type,
                            'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256,
                            'duration_ms', NEW.duration_ms, 'page_count', NEW.page_count,
                            'uploaded_by_user_id', NEW.uploaded_by_user_id,
                            'created_at', NEW.created_at, 'updated_at', NEW.updated_at);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) k
     WHERE n -> k IS DISTINCT FROM o -> k AND k <> 'updated_at';
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed);
  RETURN NULL;
END
$$;

-- Fila da transcrição -----------------------------------------------------------------------------------------------
ALTER TABLE ai_attachment_derivatives
  ADD COLUMN lock_token uuid,
  ADD COLUMN conversation_id uuid REFERENCES ai_conversations (id) ON DELETE SET NULL;

-- Nenhuma linha em running sem a cerca (a 0041 não tinha a coluna).
UPDATE ai_attachment_derivatives SET lock_token = gen_random_uuid() WHERE status = 'running';

ALTER TABLE ai_attachment_derivatives
  DROP CONSTRAINT ai_attachment_derivatives_lock_check,
  ADD CONSTRAINT ai_attachment_derivatives_lock_check
    CHECK ((status = 'running') = (locked_at IS NOT NULL) AND (status = 'running') = (lock_token IS NOT NULL));

CREATE INDEX ai_attachment_derivatives_conversation_id_idx ON ai_attachment_derivatives (conversation_id);

COMMENT ON COLUMN ai_attachment_derivatives.locked_at IS
  'Instante da reserva, só em running (reserva velha = worker caiu; ai_transcription_claim a retoma).';
COMMENT ON COLUMN ai_attachment_derivatives.lock_token IS
  'Cerca da reserva, só em running (gerada por ai_transcription_claim; exigida por ai_transcription_credentials, '
  '_complete e _fail).';
COMMENT ON COLUMN ai_attachment_derivatives.conversation_id IS
  'Conversa em que o derivado foi pedido (a transcrição no upload): o worker atribui uso e requisição ao dono e ao '
  'agente dela. Nula = sem atribuição (ou a conversa foi excluída: SET NULL, o cache do anexo fica).';

-- Enfileira a transcrição do anexo (ou devolve a que já existe para o provedor e o modelo).
CREATE FUNCTION ai_transcription_enqueue(p_attachment_id uuid, p_provider_id uuid, p_model text,
                                         p_conversation_id uuid DEFAULT NULL)
RETURNS ai_attachment_derivatives
LANGUAGE plpgsql AS $$
DECLARE
  d ai_attachment_derivatives;
BEGIN
  INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, conversation_id)
  VALUES (p_attachment_id, 'transcription', p_provider_id, p_model, p_conversation_id)
  ON CONFLICT ON CONSTRAINT ai_attachment_derivatives_key DO NOTHING
  RETURNING * INTO d;
  IF d.id IS NULL THEN
    SELECT * INTO d FROM ai_attachment_derivatives x
     WHERE x.attachment_id = p_attachment_id AND x.kind = 'transcription'
       AND x.provider_id = p_provider_id AND x.model = p_model;
  END IF;
  RETURN d;
END
$$;

COMMENT ON FUNCTION ai_transcription_enqueue(uuid, uuid, text, uuid) IS
  'Enfileira a transcrição do anexo com o provedor e o modelo (status pending) e devolve a linha; se já existe uma para '
  'o anexo, provedor e modelo, devolve a existente como está (done = cache; failed = use ai_transcription_retry). '
  'p_conversation_id atribui o uso. Erros: 23503 anexo, provedor ou conversa inexistente; 23514 '
  'ai_attachment_derivatives_provider_check (provedor ou modelo nulo) ou _model_check (formato do modelo).';

-- Reserva transcrições pendentes para o worker.
CREATE FUNCTION ai_transcription_claim(p_limit integer DEFAULT 1, p_stale_after interval DEFAULT '10 minutes',
                                       p_max_attempts integer DEFAULT 3)
RETURNS SETOF ai_attachment_derivatives
LANGUAGE plpgsql AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_stale_after IS NULL OR p_stale_after < interval '30 seconds'
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'ai_transcription_claim: limit must be 1..100, stale_after >= 30 seconds and max_attempts 1..100'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Sem tentativas restantes: reserva abandonada (worker caiu) ou pendente que já gastou o limite vira failed.
  UPDATE ai_attachment_derivatives d
     SET status = 'failed', locked_at = NULL, lock_token = NULL,
         error = CASE WHEN d.status = 'running' THEN 'stale_lock: worker stopped and the transcription has no attempts left'
                      ELSE 'max_attempts: the transcription has no attempts left' END
   WHERE d.id IN (SELECT x.id FROM ai_attachment_derivatives x
                   WHERE x.kind = 'transcription' AND x.attempts >= p_max_attempts
                     AND (x.status = 'pending'
                          OR (x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after))
                   FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  UPDATE ai_attachment_derivatives d
     SET status = 'running', locked_at = clock_timestamp(), lock_token = gen_random_uuid(),
         attempts = d.attempts + 1, error = NULL
   WHERE d.id IN (SELECT x.id FROM ai_attachment_derivatives x
                   WHERE x.kind = 'transcription' AND x.attempts < p_max_attempts
                     AND (x.status = 'pending'
                          OR (x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after))
                   ORDER BY x.created_at, x.id
                   LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING d.*;
END
$$;

COMMENT ON FUNCTION ai_transcription_claim(integer, interval, integer) IS
  'Reserva até p_limit transcrições (kind transcription: pending, ou running com reserva mais velha que p_stale_after '
  '= worker caiu), em ordem de criação, com FOR UPDATE SKIP LOCKED: status = running, locked_at = agora, lock_token '
  'novo, attempts + 1. Sem tentativas restantes (attempts >= p_max_attempts), a reserva velha ou a pendente vira '
  'failed com error stale_lock / max_attempts. Rode numa transação curta e faça COMMIT antes de chamar o provedor; '
  'guarde id e lock_token. Erro 22023: parâmetros inválidos (limite 1–100, reserva >= 30 s, tentativas 1–100).';

-- Credenciais do provedor da transcrição reservada (o worker não tem agente nem ator: vale a reserva).
CREATE FUNCTION ai_transcription_credentials(p_id uuid, p_lock_token uuid)
RETURNS TABLE (provider_id uuid, kind text, base_url text, api_key text, model text, attachment_id uuid,
               conversation_id uuid, user_id uuid, agent_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.ai_attachment_derivatives;
  c public.ai_conversations;
  p public.ai_providers;
BEGIN
  SELECT * INTO d FROM public.ai_attachment_derivatives x WHERE x.id = p_id AND x.kind = 'transcription';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_transcription_credentials: transcription % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status <> 'running' OR d.lock_token IS DISTINCT FROM p_lock_token THEN
    RAISE EXCEPTION 'ai_transcription_credentials: reservation of transcription % was lost', p_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_attachment_derivatives_lock_check';
  END IF;
  IF d.conversation_id IS NOT NULL THEN
    SELECT * INTO c FROM public.ai_conversations x WHERE x.id = d.conversation_id;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = c.user_id AND u.is_active)
       OR NOT EXISTS (SELECT 1 FROM public.ai_agents a WHERE a.id = c.agent_id AND a.is_active AND a.archived_at IS NULL) THEN
      RAISE EXCEPTION 'ai_transcription_credentials: owner or agent of conversation % is not active', c.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT * INTO p FROM public.ai_providers x WHERE x.id = d.provider_id;
  IF NOT p.is_active OR p.archived_at IS NOT NULL OR NOT ('transcription' = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_transcription_credentials: provider % is not active or lacks the transcription capability', p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, d.model, d.attachment_id, c.id, c.user_id, c.agent_id;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_transcription_credentials(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_transcription_credentials(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION ai_transcription_credentials(uuid, uuid) IS
  'Provedor, tipo, URL, chave e modelo da transcrição reservada, mais o anexo e a atribuição (conversa, usuário dono e '
  'agente dela; nulos sem conversa). Só para quem tem a reserva (lock_token de ai_transcription_claim). Erros: P0002 '
  'transcrição inexistente; 23514 ai_attachment_derivatives_lock_check reserva perdida; 42501 provedor inativo, '
  'arquivado ou sem a flag transcription, ou dono/agente da conversa inativo (o worker marca failed).';

-- Conclui a transcrição reservada.
CREATE FUNCTION ai_transcription_complete(p_id uuid, p_lock_token uuid, p_content text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_attachment_derivatives d
     SET status = 'done', content = p_content, error = NULL, locked_at = NULL, lock_token = NULL
   WHERE d.id = p_id AND d.kind = 'transcription' AND d.status = 'running' AND d.lock_token = p_lock_token;
  RETURN FOUND;
END
$$;

COMMENT ON FUNCTION ai_transcription_complete(uuid, uuid, text) IS
  'running → done com o texto (pode ser vazio; até 5 milhões de caracteres). Devolve false se a reserva se perdeu (a '
  'linha saiu com o anexo, outra reserva a retomou ou já terminou): descarte o resultado. Erros: 23514 '
  'ai_attachment_derivatives_result_check (texto nulo) ou _content_check (texto longo demais).';

-- Marca a falha da transcrição reservada.
CREATE FUNCTION ai_transcription_fail(p_id uuid, p_lock_token uuid, p_error text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_attachment_derivatives d
     SET status = 'failed', error = left(coalesce(nullif(btrim(p_error), ''), 'transcription failed'), 4000),
         locked_at = NULL, lock_token = NULL
   WHERE d.id = p_id AND d.kind = 'transcription' AND d.status = 'running' AND d.lock_token = p_lock_token;
  RETURN FOUND;
END
$$;

COMMENT ON FUNCTION ai_transcription_fail(uuid, uuid, text) IS
  'running → failed com a mensagem (vazia = "transcription failed"; cortada em 4000). Definitiva: as novas tentativas '
  'de HTTP ficam no adaptador (spec 023); voltar à fila é ai_transcription_retry. Devolve false se a reserva se perdeu.';

-- "Tentar de novo".
CREATE FUNCTION ai_transcription_retry(p_id uuid) RETURNS ai_attachment_derivatives
LANGUAGE plpgsql AS $$
DECLARE
  d ai_attachment_derivatives;
BEGIN
  SELECT * INTO d FROM ai_attachment_derivatives x WHERE x.id = p_id AND x.kind = 'transcription' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_transcription_retry: transcription % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status = 'failed' THEN
    UPDATE ai_attachment_derivatives x SET status = 'pending', error = NULL, attempts = 0
     WHERE x.id = p_id RETURNING * INTO d;
  END IF;
  RETURN d;
END
$$;

COMMENT ON FUNCTION ai_transcription_retry(uuid) IS
  '"Tentar de novo": failed → pending com as tentativas zeradas e sem erro, e devolve a linha. Em pending, running ou '
  'done não muda nada e devolve a linha como está (clique repetido não erra). A permissão é da aplicação. Erro P0002: '
  'transcrição inexistente (ou id de outro tipo de derivado).';

-- migrate:down
DROP FUNCTION ai_transcription_retry(uuid);
DROP FUNCTION ai_transcription_fail(uuid, uuid, text);
DROP FUNCTION ai_transcription_complete(uuid, uuid, text);
DROP FUNCTION ai_transcription_credentials(uuid, uuid);
DROP FUNCTION ai_transcription_claim(integer, interval, integer);
DROP FUNCTION ai_transcription_enqueue(uuid, uuid, text, uuid);

ALTER TABLE ai_attachment_derivatives
  DROP CONSTRAINT ai_attachment_derivatives_lock_check,
  ADD CONSTRAINT ai_attachment_derivatives_lock_check CHECK ((status = 'running') = (locked_at IS NOT NULL));
DROP INDEX ai_attachment_derivatives_conversation_id_idx;
ALTER TABLE ai_attachment_derivatives
  DROP COLUMN conversation_id,
  DROP COLUMN lock_token;
COMMENT ON COLUMN ai_attachment_derivatives.locked_at IS 'Instante da reserva, só em running (reserva velha = worker caiu).';

CREATE OR REPLACE FUNCTION attachments_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  changed text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    o := jsonb_build_object('id', OLD.id, 'file_name', OLD.file_name, 'mime_type', OLD.mime_type,
                            'size_bytes', OLD.size_bytes, 'sha256', OLD.sha256,
                            'uploaded_by_user_id', OLD.uploaded_by_user_id,
                            'created_at', OLD.created_at, 'updated_at', OLD.updated_at);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := jsonb_build_object('id', NEW.id, 'file_name', NEW.file_name, 'mime_type', NEW.mime_type,
                            'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256,
                            'uploaded_by_user_id', NEW.uploaded_by_user_id,
                            'created_at', NEW.created_at, 'updated_at', NEW.updated_at);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) k
     WHERE n -> k IS DISTINCT FROM o -> k AND k <> 'updated_at';
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed);
  RETURN NULL;
END
$$;

ALTER TABLE attachments
  DROP CONSTRAINT attachments_page_count_check,
  DROP CONSTRAINT attachments_duration_ms_check,
  DROP COLUMN page_count,
  DROP COLUMN duration_ms;
