-- migrate:up

-- Finalidade das chamadas e das conversas de IA (tarefas 001 e 003; spec 011).
--
-- Os fluxos automáticos (leitura de documento, sugestões da conciliação, leitura do PDF do contrato e PDF →
-- markdown) rodam como execuções de agente. Até aqui o uso deles saía como 'chat' em ai_usage e a conversa só
-- se distinguia por screen_context->>'purpose' (jsonb que a mensagem seguinte podia sobrescrever). Agora:
--   * ai_usage.purpose aceita as quatro finalidades dos fluxos, com o mesmo vocabulário de ai_conversations.purpose;
--   * ai_conversations.purpose é coluna própria, preenchida no INSERT e imutável depois;
--   * o uso 'chat' de uma conversa de fluxo assume a finalidade da conversa (fica certo mesmo se a aplicação esquecer);
--   * ai_usage_monthly_by_purpose agrega o uso por mês e finalidade;
--   * ai_conversation_fork cria a cópia sempre como 'chat'.

-- Uso por finalidade ------------------------------------------------------------------------------------------
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (
  purpose IN ('chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown')
);

COMMENT ON COLUMN ai_usage.purpose IS
  'chat (loop do agente), title (título automático), embedding (indexação/busca semântica, sem agente) ou a '
  'finalidade de um fluxo automático: document_reading (leitura de documento), classify_lines (sugestões da '
  'conciliação), contract_reading (leitura do PDF do contrato) e contract_markdown (PDF do contrato → markdown). '
  'Mesmo vocabulário de ai_conversations.purpose; chat numa conversa de fluxo vira a finalidade da conversa.';

-- Finalidade da conversa --------------------------------------------------------------------------------------
ALTER TABLE ai_conversations ADD COLUMN purpose text NOT NULL DEFAULT 'chat';
ALTER TABLE ai_conversations ADD CONSTRAINT ai_conversations_purpose_check CHECK (
  purpose IN ('chat', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown')
);

-- Backfill (sem disparar set_updated_at: a coluna é nova, o registro não mudou).
ALTER TABLE ai_conversations DISABLE TRIGGER ai_conversations_set_updated_at;
UPDATE ai_conversations
   SET purpose = screen_context ->> 'purpose'
 WHERE screen_context ->> 'purpose' IN ('document_reading', 'classify_lines', 'contract_reading', 'contract_markdown');
ALTER TABLE ai_conversations ENABLE TRIGGER ai_conversations_set_updated_at;

-- Lista do usuário (só chat) e manutenção das conversas dos fluxos.
CREATE INDEX ai_conversations_chat_user_idx ON ai_conversations (user_id, last_message_at DESC NULLS LAST)
  WHERE purpose = 'chat';
CREATE INDEX ai_conversations_purpose_idx ON ai_conversations (purpose, created_at) WHERE purpose <> 'chat';

COMMENT ON COLUMN ai_conversations.purpose IS
  'Finalidade, definida no INSERT e imutável: chat (conversa do usuário, padrão) ou o fluxo automático que a criou '
  '(document_reading, classify_lines, contract_reading, contract_markdown; mesmo vocabulário de ai_usage.purpose). '
  'Conversas de fluxo não entram na lista nem na busca e rodam sem tools. A bifurcação é sempre chat.';

CREATE FUNCTION ai_conversations_purpose_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_conversations: purpose of conversation % is immutable', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_conversations_purpose_immutable_check';
END
$$;

CREATE TRIGGER ai_conversations_purpose_immutable BEFORE UPDATE OF purpose ON ai_conversations
  FOR EACH ROW WHEN (NEW.purpose IS DISTINCT FROM OLD.purpose)
  EXECUTE FUNCTION ai_conversations_purpose_immutable();

-- Bifurcação: a cópia é sempre uma conversa comum (sem a finalidade do fluxo, nem no contexto da tela).
CREATE OR REPLACE FUNCTION ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
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
  'Bifurca: cria uma conversa de p_user_id com o mesmo agente, copia as mensagens da origem até p_message_id (inclusive, '
  'mesmos seq, sem run_id; anexos religados) e devolve o id. Título = p_title ou o da origem. A cópia é sempre purpose '
  'chat (sem a chave purpose no screen_context), mesmo vinda de uma conversa de fluxo. Corte a bifurcação numa '
  'mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não existe.';

-- O uso 'chat' de uma conversa de fluxo assume a finalidade da conversa -----------------------------------------
CREATE OR REPLACE FUNCTION ai_usage_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r  ai_runs;
  mc uuid;
  cp text;
  p  ai_model_prices;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT * INTO r FROM ai_runs x WHERE x.id = NEW.run_id;
    IF FOUND THEN
      NEW.conversation_id := coalesce(NEW.conversation_id, r.conversation_id);
      NEW.user_id := coalesce(NEW.user_id, r.user_id);
      NEW.agent_id := coalesce(NEW.agent_id, r.agent_id);
      NEW.provider_id := coalesce(NEW.provider_id, r.provider_id);
      NEW.model := coalesce(NEW.model, r.model);
      IF NEW.conversation_id <> r.conversation_id THEN
        RAISE EXCEPTION 'ai_usage: run % belongs to another conversation', NEW.run_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_links_check';
      END IF;
    END IF;
  END IF;
  IF NEW.message_id IS NOT NULL THEN
    SELECT m.conversation_id INTO mc FROM ai_messages m WHERE m.id = NEW.message_id;
    IF FOUND THEN
      NEW.conversation_id := coalesce(NEW.conversation_id, mc);
      IF NEW.conversation_id <> mc THEN
        RAISE EXCEPTION 'ai_usage: message % belongs to another conversation', NEW.message_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_links_check';
      END IF;
    END IF;
  END IF;

  IF NEW.purpose = 'chat' AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.purpose INTO cp FROM ai_conversations c WHERE c.id = NEW.conversation_id;
    NEW.purpose := coalesce(cp, NEW.purpose);
  END IF;

  IF NEW.price_id IS NULL AND NEW.provider_id IS NOT NULL AND NEW.model IS NOT NULL THEN
    p := ai_model_price_at(NEW.provider_id, NEW.model, NEW.created_at);
    NEW.price_id := p.id;
  ELSIF NEW.price_id IS NOT NULL THEN
    SELECT * INTO p FROM ai_model_prices x WHERE x.id = NEW.price_id;
    IF FOUND AND (p.provider_id <> NEW.provider_id OR p.model <> NEW.model) THEN
      RAISE EXCEPTION 'ai_usage: price % is not for this provider and model', NEW.price_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_price_check';
    END IF;
  END IF;
  IF p.id IS NOT NULL THEN
    NEW.cost_micros := round(NEW.input_tokens * p.input_price_per_million
                             + NEW.output_tokens * p.output_price_per_million
                             + NEW.cache_write_tokens * coalesce(p.cache_write_price_per_million, p.input_price_per_million)
                             + NEW.cache_read_tokens * coalesce(p.cache_read_price_per_million, p.input_price_per_million))::bigint;
    NEW.currency := p.currency;
  ELSE
    NEW.cost_micros := NULL;
    NEW.currency := NULL;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION ai_usage_before_insert() IS
  'Completa conversa/usuário/agente/provedor/modelo da execução, confere as ligações (ai_usage_links_check), troca '
  'purpose chat pela finalidade da conversa quando ela é de fluxo e calcula o custo pelo preço vigente.';

-- Agregado por finalidade -------------------------------------------------------------------------------------
CREATE VIEW ai_usage_monthly_by_purpose WITH (security_invoker = true) AS
SELECT date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS month,
       u.purpose,
       u.currency,
       count(*)::int AS calls,
       count(DISTINCT u.run_id)::int AS runs,
       count(DISTINCT u.user_id)::int AS users,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 GROUP BY 1, u.purpose, u.currency;

COMMENT ON VIEW ai_usage_monthly_by_purpose IS
  'Uso por mês (America/Sao_Paulo), finalidade (ai_usage.purpose) e moeda; currency nula = chamadas sem preço.';

GRANT SELECT ON ai_usage_monthly_by_purpose TO moneyflow_app;

-- migrate:down

DROP VIEW ai_usage_monthly_by_purpose;

CREATE OR REPLACE FUNCTION ai_usage_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r  ai_runs;
  mc uuid;
  p  ai_model_prices;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT * INTO r FROM ai_runs x WHERE x.id = NEW.run_id;
    IF FOUND THEN
      NEW.conversation_id := coalesce(NEW.conversation_id, r.conversation_id);
      NEW.user_id := coalesce(NEW.user_id, r.user_id);
      NEW.agent_id := coalesce(NEW.agent_id, r.agent_id);
      NEW.provider_id := coalesce(NEW.provider_id, r.provider_id);
      NEW.model := coalesce(NEW.model, r.model);
      IF NEW.conversation_id <> r.conversation_id THEN
        RAISE EXCEPTION 'ai_usage: run % belongs to another conversation', NEW.run_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_links_check';
      END IF;
    END IF;
  END IF;
  IF NEW.message_id IS NOT NULL THEN
    SELECT m.conversation_id INTO mc FROM ai_messages m WHERE m.id = NEW.message_id;
    IF FOUND THEN
      NEW.conversation_id := coalesce(NEW.conversation_id, mc);
      IF NEW.conversation_id <> mc THEN
        RAISE EXCEPTION 'ai_usage: message % belongs to another conversation', NEW.message_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_links_check';
      END IF;
    END IF;
  END IF;

  IF NEW.price_id IS NULL AND NEW.provider_id IS NOT NULL AND NEW.model IS NOT NULL THEN
    p := ai_model_price_at(NEW.provider_id, NEW.model, NEW.created_at);
    NEW.price_id := p.id;
  ELSIF NEW.price_id IS NOT NULL THEN
    SELECT * INTO p FROM ai_model_prices x WHERE x.id = NEW.price_id;
    IF FOUND AND (p.provider_id <> NEW.provider_id OR p.model <> NEW.model) THEN
      RAISE EXCEPTION 'ai_usage: price % is not for this provider and model', NEW.price_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_price_check';
    END IF;
  END IF;
  IF p.id IS NOT NULL THEN
    NEW.cost_micros := round(NEW.input_tokens * p.input_price_per_million
                             + NEW.output_tokens * p.output_price_per_million
                             + NEW.cache_write_tokens * coalesce(p.cache_write_price_per_million, p.input_price_per_million)
                             + NEW.cache_read_tokens * coalesce(p.cache_read_price_per_million, p.input_price_per_million))::bigint;
    NEW.currency := p.currency;
  ELSE
    NEW.cost_micros := NULL;
    NEW.currency := NULL;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION ai_usage_before_insert() IS NULL;

CREATE OR REPLACE FUNCTION ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
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
                                forked_from_message_id, screen_context)
  VALUES (p_user_id, src.agent_id, coalesce(nullif(btrim(p_title), ''), src.title),
          CASE WHEN nullif(btrim(p_title), '') IS NOT NULL THEN 'user' ELSE src.title_source END,
          src.id, p_message_id, src.screen_context)
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
  'Bifurca: cria uma conversa de p_user_id com o mesmo agente, copia as mensagens da origem até p_message_id (inclusive, '
  'mesmos seq, sem run_id; anexos religados) e devolve o id. Título = p_title ou o da origem. Corte a bifurcação numa '
  'mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não existe.';

DROP TRIGGER ai_conversations_purpose_immutable ON ai_conversations;
DROP FUNCTION ai_conversations_purpose_immutable();
DROP INDEX ai_conversations_purpose_idx;
DROP INDEX ai_conversations_chat_user_idx;
ALTER TABLE ai_conversations DROP COLUMN purpose;

-- Uso das finalidades novas volta a ser 'chat' (como era gravado antes desta migration).
UPDATE ai_usage SET purpose = 'chat'
 WHERE purpose IN ('document_reading', 'classify_lines', 'contract_reading', 'contract_markdown');
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('chat', 'title', 'embedding'));

COMMENT ON COLUMN ai_usage.purpose IS 'chat (loop do agente), title (título automático) ou embedding (indexação/busca semântica, sem agente).';
