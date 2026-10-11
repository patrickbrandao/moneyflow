-- migrate:up

-- Agentes de IA (spec 011), parte 3: conversas, mensagens, execuções (o loop roda no worker), eventos de
-- streaming (SSE) e confirmações de tools de escrita.
--
-- Estado operacional e conteúdo privado do usuário, em volume: nada aqui é auditado (o que o agente
-- ALTERA nas tabelas de negócio é auditado lá, com actor_kind = agent e agent_run_id = ai_runs.id).
-- O admin pode ler as conversas de todos (spec 011): o banco não restringe a leitura; a aplicação aplica.

-- Conversas ---------------------------------------------------------------------------------------------------
CREATE TABLE ai_conversations (
  id                          uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id                     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id                    uuid        NOT NULL REFERENCES ai_agents (id),
  title                       text,
  title_source                text        NOT NULL DEFAULT 'auto',
  pinned_at                   timestamptz,
  archived_at                 timestamptz,
  forked_from_conversation_id uuid,
  forked_from_message_id      uuid,
  screen_context              jsonb,
  last_message_at             timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_conversations_title_check CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT ai_conversations_title_source_check CHECK (title_source IN ('auto', 'user')),
  CONSTRAINT ai_conversations_fork_check CHECK (forked_from_conversation_id <> id),
  CONSTRAINT ai_conversations_screen_context_check CHECK (jsonb_typeof(screen_context) = 'object')
);

CREATE INDEX ai_conversations_user_id_idx ON ai_conversations (user_id, last_message_at DESC NULLS LAST);
CREATE INDEX ai_conversations_agent_id_idx ON ai_conversations (agent_id);
CREATE INDEX ai_conversations_forked_from_idx ON ai_conversations (forked_from_conversation_id, forked_from_message_id);
CREATE INDEX ai_conversations_title_trgm_idx ON ai_conversations USING gin (title gin_trgm_ops);

CREATE TRIGGER ai_conversations_set_updated_at BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_conversations IS
  'Conversas do usuário com um agente (spec 011): título automático e editável, fixar, arquivar, excluir (apaga '
  'mensagens, execuções e eventos; o uso fica em ai_usage), buscar (ai_conversation_search) e bifurcar '
  '(ai_conversation_fork). O admin pode ler as de todos (a aplicação aplica). Fora da auditoria.';
COMMENT ON COLUMN ai_conversations.user_id IS 'Dono da conversa (quem conversa; as execuções rodam com as permissões dele).';
COMMENT ON COLUMN ai_conversations.title IS 'Título (nulo até o título automático ser gerado).';
COMMENT ON COLUMN ai_conversations.title_source IS 'auto (gerado pelo agente; pode ser regerado) ou user (renomeado: não sobrescrever).';
COMMENT ON COLUMN ai_conversations.pinned_at IS 'Fixada desde (nulo = não fixada). Fixadas primeiro, mais recente primeiro.';
COMMENT ON COLUMN ai_conversations.forked_from_conversation_id IS
  'Conversa de origem da bifurcação (nula se não é bifurcação ou se a origem foi excluída). Anda junto com '
  'forked_from_message_id (FK composta MATCH FULL para a mensagem).';
COMMENT ON COLUMN ai_conversations.forked_from_message_id IS 'Última mensagem copiada da origem (a bifurcação continua a partir dela).';
COMMENT ON COLUMN ai_conversations.screen_context IS
  'Contexto da tela mais recente enviado pelo console (caixa aberta, registro selecionado, filtros), objeto JSON.';
COMMENT ON COLUMN ai_conversations.last_message_at IS 'Instante da última mensagem (mantido por trigger de ai_messages).';

-- Execuções -------------------------------------------------------------------------------------------------
CREATE TABLE ai_runs (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  conversation_id     uuid        NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id            uuid        NOT NULL REFERENCES ai_agents (id),
  provider_id         uuid        NOT NULL REFERENCES ai_providers (id),
  model               text        NOT NULL,
  trigger_message_id  uuid,
  status              text        NOT NULL DEFAULT 'queued',
  error               text,
  cancel_requested_at timestamptz,
  locked_at           timestamptz,
  lock_token          uuid,
  attempts            smallint    NOT NULL DEFAULT 0,
  max_attempts        smallint    NOT NULL DEFAULT 3,
  started_at          timestamptz,
  finished_at         timestamptz,
  last_event_seq      integer     NOT NULL DEFAULT 0,
  input_tokens        bigint      NOT NULL DEFAULT 0,
  output_tokens       bigint      NOT NULL DEFAULT 0,
  cache_write_tokens  bigint      NOT NULL DEFAULT 0,
  cache_read_tokens   bigint      NOT NULL DEFAULT 0,
  cost_micros         bigint      NOT NULL DEFAULT 0,
  cost_currency       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_runs_conversation_id_key UNIQUE (conversation_id, id),
  CONSTRAINT ai_runs_status_check CHECK (status IN ('queued', 'running', 'awaiting_confirmation', 'completed', 'failed', 'canceled')),
  CONSTRAINT ai_runs_attempts_check CHECK (max_attempts BETWEEN 1 AND 20 AND attempts BETWEEN 0 AND max_attempts),
  CONSTRAINT ai_runs_status_fields_check CHECK (
    (status = 'running') = (locked_at IS NOT NULL)
    AND (status = 'running') = (lock_token IS NOT NULL)
    AND (status IN ('completed', 'failed', 'canceled')) = (finished_at IS NOT NULL)
    AND (status <> 'failed' OR error IS NOT NULL)
    AND (status NOT IN ('running', 'awaiting_confirmation', 'completed') OR started_at IS NOT NULL)
  ),
  CONSTRAINT ai_runs_error_check CHECK (length(error) <= 4000),
  CONSTRAINT ai_runs_usage_check CHECK (
    last_event_seq >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND cache_write_tokens >= 0
    AND cache_read_tokens >= 0 AND cost_micros >= 0
  ),
  CONSTRAINT ai_runs_cost_currency_check CHECK (cost_currency IN ('USD', 'BRL'))
);

-- Uma execução ativa por conversa: nunca dois loops na mesma conversa.
CREATE UNIQUE INDEX ai_runs_conversation_active_key ON ai_runs (conversation_id)
  WHERE status IN ('queued', 'running', 'awaiting_confirmation');
CREATE INDEX ai_runs_queued_idx ON ai_runs (created_at) WHERE status = 'queued';
CREATE INDEX ai_runs_running_idx ON ai_runs (locked_at) WHERE status = 'running';
CREATE INDEX ai_runs_finished_at_idx ON ai_runs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX ai_runs_user_id_idx ON ai_runs (user_id, created_at);
CREATE INDEX ai_runs_agent_id_idx ON ai_runs (agent_id);
CREATE INDEX ai_runs_provider_id_idx ON ai_runs (provider_id);
CREATE INDEX ai_runs_trigger_message_idx ON ai_runs (conversation_id, trigger_message_id);

CREATE TRIGGER ai_runs_set_updated_at BEFORE UPDATE ON ai_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_runs IS
  'Execuções do loop do agente, consumidas pelo worker (spec 011): queued → running (ai_run_claim, SKIP LOCKED) → '
  'awaiting_confirmation (espera ai_tool_confirmations) → queued … → completed | failed | canceled. Uma ativa por conversa. '
  'O id é o app.agent_run_id da auditoria. Tokens e custo agregados de ai_usage (por trigger). Fora da auditoria.';
COMMENT ON COLUMN ai_runs.user_id IS 'Quem acionou (= dono da conversa). As tools rodam com as permissões dele.';
COMMENT ON COLUMN ai_runs.provider_id IS 'Provedor usado (cópia do agente ao enfileirar, se não informado).';
COMMENT ON COLUMN ai_runs.model IS 'Modelo usado (cópia do agente ao enfileirar, se não informado).';
COMMENT ON COLUMN ai_runs.trigger_message_id IS 'Mensagem do usuário que acionou a execução (da mesma conversa).';
COMMENT ON COLUMN ai_runs.status IS
  'queued (na fila), running (reservada por um worker: locked_at), awaiting_confirmation (parada esperando o usuário '
  'decidir tools de escrita), completed, failed (error), canceled. Os três últimos são finais.';
COMMENT ON COLUMN ai_runs.error IS 'Mensagem de erro (obrigatória em failed; opcional em canceled). Nunca contém chaves.';
COMMENT ON COLUMN ai_runs.cancel_requested_at IS
  'O usuário pediu para parar uma execução em running: o worker vê em ai_run_heartbeat e encerra como canceled.';
COMMENT ON COLUMN ai_runs.locked_at IS 'Reserva/heartbeat do worker (só em running). Mais velha que o limite = worker caiu; ai_run_claim retoma.';
COMMENT ON COLUMN ai_runs.lock_token IS
  'Cerca (fencing) da reserva atual, nova a cada claim (só em running): ai_run_heartbeat exige o token, então um worker '
  'cuja reserva foi retomada por outro descobre e para.';
COMMENT ON COLUMN ai_runs.attempts IS
  'Reservas da vez atual (o claim soma 1; volta a 0 quando a execução sai de running para queued ou '
  'awaiting_confirmation). Limita as retomadas depois de queda do worker (max_attempts).';
COMMENT ON COLUMN ai_runs.last_event_seq IS 'Último seq de ai_run_events desta execução (contador do ai_run_event_append).';
COMMENT ON COLUMN ai_runs.cost_micros IS 'Custo estimado agregado em milionésimos de cost_currency (ex.: micro-dólares). Medição, sem teto.';
COMMENT ON COLUMN ai_runs.cost_currency IS 'Moeda do custo agregado (a do preço do modelo); nula até haver custo.';

-- Mensagens ---------------------------------------------------------------------------------------------------
-- Formato neutro entre provedores: content é um array de blocos.
--   {"type": "text", "text": "..."}                                      user, assistant
--   {"type": "attachment", "attachment_id": "<uuid>"}                     user (imagem, PDF…; ligado em ai_message_attachments)
--   {"type": "thinking", ...} / {"type": "redacted_thinking", ...}        assistant (raciocínio, com assinatura do provedor)
--   {"type": "tool_use", "id": "...", "name": "...", "input": {...}}     assistant
--   {"type": "tool_result", "tool_use_id": "...", "content": ..., "is_error": bool}   tool
-- Outras chaves nos blocos são permitidas (ex.: dados próprios do provedor).
CREATE FUNCTION ai_message_content_valid(p_role text, p_content jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  b jsonb;
  t text;
BEGIN
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'array' OR jsonb_array_length(p_content) NOT BETWEEN 1 AND 1000 THEN
    RETURN false;
  END IF;
  FOR b IN SELECT * FROM jsonb_array_elements(p_content) LOOP
    IF jsonb_typeof(b) <> 'object' OR jsonb_typeof(b -> 'type') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    t := b ->> 'type';
    IF NOT (CASE p_role
              WHEN 'user' THEN t IN ('text', 'attachment')
              WHEN 'assistant' THEN t IN ('text', 'thinking', 'redacted_thinking', 'tool_use')
              WHEN 'tool' THEN t = 'tool_result'
              ELSE false
            END) THEN
      RETURN false;
    END IF;
    IF (t = 'text' AND jsonb_typeof(b -> 'text') IS DISTINCT FROM 'string')
       OR (t = 'attachment' AND ((b ->> 'attachment_id') IS NULL OR (b ->> 'attachment_id') !~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
       OR (t = 'tool_use' AND (jsonb_typeof(b -> 'id') IS DISTINCT FROM 'string'
                               OR jsonb_typeof(b -> 'name') IS DISTINCT FROM 'string'
                               OR jsonb_typeof(b -> 'input') IS DISTINCT FROM 'object'))
       OR (t = 'tool_result' AND (jsonb_typeof(b -> 'tool_use_id') IS DISTINCT FROM 'string'
                                  OR NOT b ? 'content'
                                  OR (b ? 'is_error' AND jsonb_typeof(b -> 'is_error') <> 'boolean'))) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

COMMENT ON FUNCTION ai_message_content_valid(text, jsonb) IS
  'true se content é um array de 1–1000 blocos válidos para o papel: user = text|attachment; assistant = '
  'text|thinking|redacted_thinking|tool_use; tool = tool_result. Campos obrigatórios por tipo (ver a migration 0026).';

CREATE FUNCTION ai_message_text(p_content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_content) = 'array' THEN
           (SELECT coalesce(string_agg(b ->> 'text', E'\n' ORDER BY ord), '')
              FROM jsonb_array_elements(p_content) WITH ORDINALITY x (b, ord)
             WHERE jsonb_typeof(b) = 'object' AND b ->> 'type' = 'text')
         ELSE '' END
$$;

COMMENT ON FUNCTION ai_message_text(jsonb) IS 'Texto dos blocos text de uma mensagem, unidos por quebra de linha (base da busca full-text).';

CREATE TABLE ai_messages (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  conversation_id uuid        NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  seq             integer     NOT NULL,
  role            text        NOT NULL,
  content         jsonb       NOT NULL,
  run_id          uuid,
  search_tsv      tsvector    NOT NULL GENERATED ALWAYS AS (to_tsvector('portuguese'::regconfig, ai_message_text(content))) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_messages_conversation_id_key UNIQUE (conversation_id, id),
  CONSTRAINT ai_messages_seq_key UNIQUE (conversation_id, seq),
  CONSTRAINT ai_messages_seq_check CHECK (seq >= 1),
  CONSTRAINT ai_messages_role_check CHECK (role IN ('user', 'assistant', 'tool')),
  CONSTRAINT ai_messages_content_check CHECK (ai_message_content_valid(role, content)),
  CONSTRAINT ai_messages_run_fkey FOREIGN KEY (conversation_id, run_id)
    REFERENCES ai_runs (conversation_id, id) ON DELETE SET NULL (run_id)
);

CREATE INDEX ai_messages_run_idx ON ai_messages (conversation_id, run_id);
CREATE INDEX ai_messages_run_id_idx ON ai_messages (run_id);
CREATE INDEX ai_messages_search_tsv_idx ON ai_messages USING gin (search_tsv);

CREATE TRIGGER ai_messages_set_updated_at BEFORE UPDATE ON ai_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_messages IS
  'Mensagens de uma conversa, em ordem (seq 1, 2, 3… por conversa; omita seq no INSERT e o banco atribui o próximo). '
  'Conteúdo em blocos neutros entre provedores (ai_message_content_valid) e imutável. Tokens e custo por mensagem: '
  'ai_usage / ai_message_usage. Fora da auditoria.';
COMMENT ON COLUMN ai_messages.seq IS 'Ordem na conversa (1, 2, 3…), atribuída pelo banco quando omitida (trava a conversa).';
COMMENT ON COLUMN ai_messages.role IS 'user (pessoa), assistant (modelo: texto, raciocínio, pedidos de tool) ou tool (resultados das tools).';
COMMENT ON COLUMN ai_messages.content IS 'Array de blocos: text, attachment, thinking, redacted_thinking, tool_use, tool_result. Imutável.';
COMMENT ON COLUMN ai_messages.run_id IS 'Execução que produziu a mensagem (da mesma conversa); nula na mensagem do usuário e nas cópias de bifurcação.';
COMMENT ON COLUMN ai_messages.search_tsv IS 'Full-text (português) dos blocos text, gerado pelo banco.';

ALTER TABLE ai_conversations
  ADD CONSTRAINT ai_conversations_forked_from_message_fkey FOREIGN KEY (forked_from_conversation_id, forked_from_message_id)
    REFERENCES ai_messages (conversation_id, id) MATCH FULL ON DELETE SET NULL;
ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_trigger_message_fkey FOREIGN KEY (conversation_id, trigger_message_id)
    REFERENCES ai_messages (conversation_id, id) ON DELETE SET NULL (trigger_message_id);

-- seq automático (trava a conversa: inserções concorrentes na mesma conversa se enfileiram).
CREATE FUNCTION ai_messages_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM ai_conversations c WHERE c.id = NEW.conversation_id FOR NO KEY UPDATE;
  IF NEW.seq IS NULL THEN
    SELECT coalesce(max(m.seq), 0) + 1 INTO NEW.seq FROM ai_messages m WHERE m.conversation_id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_messages_before_insert BEFORE INSERT ON ai_messages
  FOR EACH ROW EXECUTE FUNCTION ai_messages_before_insert();

-- last_message_at da conversa e ligação dos anexos citados nos blocos attachment.
CREATE FUNCTION ai_messages_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_conversations c
     SET last_message_at = greatest(coalesce(c.last_message_at, NEW.created_at), NEW.created_at)
   WHERE c.id = NEW.conversation_id;
  INSERT INTO ai_message_attachments (message_id, attachment_id)
  SELECT DISTINCT NEW.id, (b ->> 'attachment_id')::uuid
    FROM jsonb_array_elements(NEW.content) b
   WHERE b ->> 'type' = 'attachment'
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;

-- Conteúdo imutável (run_id pode ser anulado pela FK quando a execução é excluída).
CREATE FUNCTION ai_messages_validate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id <> OLD.conversation_id OR NEW.seq <> OLD.seq OR NEW.role <> OLD.role
     OR NEW.content <> OLD.content OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ai_messages: message % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_messages_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_messages_validate_update BEFORE UPDATE ON ai_messages
  FOR EACH ROW EXECUTE FUNCTION ai_messages_validate_update();

-- Anexos das mensagens --------------------------------------------------------------------------------------
CREATE TABLE ai_message_attachments (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  message_id    uuid        NOT NULL REFERENCES ai_messages (id) ON DELETE CASCADE,
  attachment_id uuid        NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_message_attachments_key UNIQUE (message_id, attachment_id)
);
CREATE INDEX ai_message_attachments_attachment_id_idx ON ai_message_attachments (attachment_id);
CREATE TRIGGER ai_message_attachments_set_updated_at BEFORE UPDATE ON ai_message_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE ai_message_attachments IS
  'Anexos (imagem, PDF…) de mensagens do agente. Criada automaticamente a partir dos blocos attachment de '
  'ai_messages (anexo inexistente = 23503). Fora da auditoria.';

CREATE TRIGGER ai_messages_after_insert AFTER INSERT ON ai_messages
  FOR EACH ROW EXECUTE FUNCTION ai_messages_after_insert();

CREATE OR REPLACE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments
UNION ALL
SELECT xml_attachment_id, 'nfe_document', id FROM nfe_documents WHERE xml_attachment_id IS NOT NULL
UNION ALL
SELECT attachment_id, 'card_purchase', card_purchase_id FROM card_purchase_attachments
UNION ALL
SELECT attachment_id, 'statement_import', id FROM statement_imports
UNION ALL
SELECT attachment_id, 'ai_message', message_id FROM ai_message_attachments;

-- Regras das execuções ---------------------------------------------------------------------------------------
CREATE FUNCTION ai_runs_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conv ai_conversations;
  ag   ai_agents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' THEN
      RAISE EXCEPTION 'ai_runs: new runs must be queued'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_transition_check';
    END IF;
    SELECT * INTO conv FROM ai_conversations c WHERE c.id = NEW.conversation_id;
    IF FOUND AND conv.user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'ai_runs: run user must be the owner of conversation %', NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_owner_check';
    END IF;
    IF FOUND AND conv.agent_id <> NEW.agent_id THEN
      RAISE EXCEPTION 'ai_runs: run agent must be the agent of conversation %', NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_agent_check';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.is_active) THEN
      RAISE EXCEPTION 'ai_runs: user % is not active', NEW.user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_user_active_check';
    END IF;
    SELECT * INTO ag FROM ai_agents a WHERE a.id = NEW.agent_id;
    IF NOT FOUND OR NOT ag.is_active OR ag.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'ai_runs: agent % is not active', NEW.agent_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_agent_active_check';
    END IF;
    NEW.provider_id := coalesce(NEW.provider_id, ag.provider_id);
    NEW.model := coalesce(NEW.model, ag.model);
    IF NOT EXISTS (SELECT 1 FROM ai_providers p WHERE p.id = NEW.provider_id AND p.is_active AND p.archived_at IS NULL) THEN
      RAISE EXCEPTION 'ai_runs: provider % is not active', NEW.provider_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_provider_active_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.conversation_id <> OLD.conversation_id OR NEW.user_id <> OLD.user_id OR NEW.agent_id <> OLD.agent_id
     OR NEW.provider_id <> OLD.provider_id OR NEW.model <> OLD.model OR NEW.max_attempts <> OLD.max_attempts
     OR (NEW.trigger_message_id IS DISTINCT FROM OLD.trigger_message_id AND OLD.trigger_message_id IS NOT NULL
         AND NEW.trigger_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ai_runs: conversation, user, agent, provider, model and trigger message of run % are immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_immutable_check';
  END IF;

  IF OLD.status IN ('completed', 'failed', 'canceled') THEN
    -- Final: só os contadores (eventos e uso que chegam depois) ainda mudam.
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'last_event_seq', 'input_tokens', 'output_tokens', 'cache_write_tokens',
                              'cache_read_tokens', 'cost_micros', 'cost_currency', 'trigger_message_id'])
       <> (to_jsonb(OLD) - ARRAY['updated_at', 'last_event_seq', 'input_tokens', 'output_tokens', 'cache_write_tokens',
                                 'cache_read_tokens', 'cost_micros', 'cost_currency', 'trigger_message_id']) THEN
      RAISE EXCEPTION 'ai_runs: run % is % and cannot change', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_transition_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running', 'canceled'))
    OR (OLD.status = 'running' AND NEW.status IN ('queued', 'awaiting_confirmation', 'completed', 'failed', 'canceled'))
    OR (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('queued', 'failed', 'canceled'))
  ) THEN
    RAISE EXCEPTION 'ai_runs: invalid transition % -> % (run %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_transition_check';
  END IF;

  -- Campos derivados do status.
  IF NEW.status <> 'running' THEN
    NEW.locked_at := NULL;
    NEW.lock_token := NULL;
  END IF;
  IF OLD.status = 'running' AND NEW.status IN ('queued', 'awaiting_confirmation') THEN
    NEW.attempts := 0;
  END IF;
  IF NEW.status = 'running' AND NEW.started_at IS NULL THEN
    NEW.started_at := clock_timestamp();
  END IF;
  IF NEW.status IN ('completed', 'failed', 'canceled') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_runs_validate BEFORE INSERT OR UPDATE ON ai_runs
  FOR EACH ROW EXECUTE FUNCTION ai_runs_validate();

-- Reserva (claim) com SKIP LOCKED --------------------------------------------------------------------------
CREATE FUNCTION ai_run_claim(p_limit int DEFAULT 1, p_stale_after interval DEFAULT interval '2 minutes')
RETURNS SETOF ai_runs
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_stale_after IS NULL OR p_stale_after < interval '10 seconds' THEN
    RAISE EXCEPTION 'ai_run_claim: limit must be 1..100 and stale_after >= 10 seconds'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Reserva abandonada (worker caiu): com cancelamento pedido, cancela; sem tentativas restantes, falha.
  UPDATE ai_runs r
     SET status = CASE WHEN r.cancel_requested_at IS NOT NULL THEN 'canceled' ELSE 'failed' END,
         error = CASE WHEN r.cancel_requested_at IS NOT NULL THEN r.error
                      ELSE 'stale_lock: worker stopped and the run has no attempts left' END
   WHERE r.id IN (SELECT x.id FROM ai_runs x
                   WHERE x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after
                     AND (x.attempts >= x.max_attempts OR x.cancel_requested_at IS NOT NULL)
                   FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  UPDATE ai_runs r
     SET status = 'running', locked_at = clock_timestamp(), lock_token = gen_random_uuid(), attempts = r.attempts + 1
   WHERE r.id IN (SELECT x.id FROM ai_runs x
                   WHERE x.status = 'queued'
                      OR (x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after
                          AND x.attempts < x.max_attempts AND x.cancel_requested_at IS NULL)
                   ORDER BY x.created_at, x.id
                   LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING r.*;
END
$$;

COMMENT ON FUNCTION ai_run_claim(int, interval) IS
  'Reserva até p_limit execuções (queued, ou running com reserva mais velha que p_stale_after = worker caiu) com FOR '
  'UPDATE SKIP LOCKED: status = running, locked_at = agora, lock_token novo, attempts + 1 (started_at na primeira). '
  'Reserva velha sem tentativas vira failed; com cancelamento pedido, canceled. Rode numa transação curta e faça COMMIT '
  'antes de chamar o modelo. Guarde lock_token: é a cerca de ai_run_heartbeat. Erro 22023: parâmetros inválidos.';

CREATE FUNCTION ai_run_heartbeat(p_run_id uuid, p_lock_token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  cancel boolean;
BEGIN
  UPDATE ai_runs r SET locked_at = clock_timestamp()
   WHERE r.id = p_run_id AND r.status = 'running' AND r.lock_token = p_lock_token
  RETURNING r.cancel_requested_at IS NOT NULL INTO cancel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_heartbeat: run % is not running under this lock', p_run_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_lock_check';
  END IF;
  RETURN cancel;
END
$$;

COMMENT ON FUNCTION ai_run_heartbeat(uuid, uuid) IS
  'O worker renova a reserva (locked_at) de tempos em tempos (bem menos que o stale_after do claim). Devolve true se o '
  'usuário pediu cancelamento. Erro 23514 (ai_runs_lock_check) se a execução não está mais running com este lock_token '
  '(foi retomada por outro worker, cancelada ou terminou): pare o loop sem gravar mais nada.';

-- Credenciais da execução (worker) --------------------------------------------------------------------------
CREATE FUNCTION ai_run_provider_credentials(p_run_id uuid)
RETURNS TABLE (provider_id uuid, kind text, base_url text, api_key text, model text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.ai_runs;
  p public.ai_providers;
BEGIN
  SELECT * INTO r FROM public.ai_runs x WHERE x.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: run % is not running (status %)', p_run_id, r.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM public.ai_providers x WHERE x.id = r.provider_id;
  IF NOT p.is_active OR p.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: provider % is not active', p.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, r.model;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_run_provider_credentials(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_run_provider_credentials(uuid) TO moneyflow_app;

COMMENT ON FUNCTION ai_run_provider_credentials(uuid) IS
  'Worker: provedor, URL, chave e modelo de uma execução RESERVADA (status running). Erro 42501 em outro status ou com o '
  'provedor inativo; P0002 se a execução não existe. Única forma de ler ai_providers.api_key durante o loop.';

CREATE FUNCTION ai_run_mcp_headers(p_run_id uuid, p_mcp_server_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.ai_runs;
  h jsonb;
BEGIN
  SELECT * INTO r FROM public.ai_runs x WHERE x.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_mcp_headers: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'ai_run_mcp_headers: run % is not running (status %)', p_run_id, r.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.secret_headers INTO h
    FROM public.mcp_servers s
    LEFT JOIN public.agent_mcp_servers l ON l.mcp_server_id = s.id AND l.agent_id = r.agent_id
   WHERE s.id = p_mcp_server_id AND s.is_active AND s.archived_at IS NULL
     AND (s.visibility = 'global' OR l.id IS NOT NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_mcp_headers: server % is not enabled for the agent of run %', p_mcp_server_id, p_run_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN h;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_run_mcp_headers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_run_mcp_headers(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION ai_run_mcp_headers(uuid, uuid) IS
  'Worker: cabeçalhos secretos de um servidor MCP efetivo para o agente de uma execução RESERVADA (running). Erro 42501 '
  'se a execução não está running ou o servidor não está ativo/habilitado para o agente; P0002 se a execução não existe.';

-- Eventos de streaming (SSE) ----------------------------------------------------------------------------------
CREATE TABLE ai_run_events (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  run_id     uuid        NOT NULL REFERENCES ai_runs (id) ON DELETE CASCADE,
  seq        integer     NOT NULL,
  event_type text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_run_events_seq_key UNIQUE (run_id, seq),
  CONSTRAINT ai_run_events_seq_check CHECK (seq >= 1),
  CONSTRAINT ai_run_events_event_type_check CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  CONSTRAINT ai_run_events_payload_check CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE ai_run_events IS
  'Eventos de uma execução para o streaming via SSE (deltas de texto, tool chamada, confirmação pedida, status…), em '
  'ordem por seq. Grave com ai_run_event_append (seq + NOTIFY ai_run_events). Append-only (sem UPDATE para a '
  'aplicação, sem updated_at); limpeza por ai_run_events_purge. Fora da auditoria.';
COMMENT ON COLUMN ai_run_events.seq IS 'Ordem na execução (1, 2, 3…, sem buracos); serve de Last-Event-ID no SSE.';
COMMENT ON COLUMN ai_run_events.event_type IS 'Tipo do evento, definido pela aplicação (ex.: status, text_delta, tool_use, tool_result, confirmation, error, done).';
COMMENT ON COLUMN ai_run_events.payload IS 'Dados do evento (objeto JSON). Nunca chaves, tokens ou senhas.';

REVOKE UPDATE ON ai_run_events FROM moneyflow_app;

CREATE FUNCTION ai_run_event_append(p_run_id uuid, p_event_type text, p_payload jsonb DEFAULT '{}')
RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  s integer;
BEGIN
  UPDATE ai_runs r SET last_event_seq = r.last_event_seq + 1 WHERE r.id = p_run_id RETURNING r.last_event_seq INTO s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_event_append: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO ai_run_events (run_id, seq, event_type, payload) VALUES (p_run_id, s, p_event_type, coalesce(p_payload, '{}'));
  PERFORM pg_notify('ai_run_events', json_build_object('run_id', p_run_id, 'seq', s)::text);
  RETURN s;
END
$$;

COMMENT ON FUNCTION ai_run_event_append(uuid, text, jsonb) IS
  'Grava o próximo evento da execução (seq = last_event_seq + 1, trava a linha da execução) e avisa por NOTIFY no canal '
  'ai_run_events com {"run_id", "seq"} (entregue no COMMIT). A API escuta (LISTEN) e lê WHERE run_id = … AND seq > '
  'último enviado. Devolve o seq. P0002 se a execução não existe.';

CREATE FUNCTION ai_run_events_purge(p_keep interval DEFAULT interval '7 days') RETURNS bigint
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  n bigint;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '1 hour' THEN
    RAISE EXCEPTION 'ai_run_events_purge: keep must be >= 1 hour' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM ai_run_events e
   USING ai_runs r
   WHERE r.id = e.run_id AND r.finished_at < clock_timestamp() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION ai_run_events_purge(interval) IS
  'Retenção: apaga os eventos de execuções terminadas há mais de p_keep (padrão 7 dias; mínimo 1 hora) e devolve '
  'quantos. As mensagens e o uso ficam. O worker chama periodicamente. Erro 22023 se p_keep < 1 hora.';

-- Confirmações de tools de escrita ---------------------------------------------------------------------------
CREATE TABLE ai_tool_confirmations (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  run_id             uuid        NOT NULL REFERENCES ai_runs (id) ON DELETE CASCADE,
  tool_use_id        text        NOT NULL,
  tool_name          text        NOT NULL,
  input              jsonb       NOT NULL,
  preview            jsonb,
  status             text        NOT NULL DEFAULT 'pending',
  decided_by_user_id uuid        REFERENCES users (id) ON DELETE CASCADE,
  decided_at         timestamptz,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tool_confirmations_tool_use_key UNIQUE (run_id, tool_use_id),
  CONSTRAINT ai_tool_confirmations_tool_use_id_check CHECK (btrim(tool_use_id) <> '' AND length(tool_use_id) <= 200),
  CONSTRAINT ai_tool_confirmations_tool_name_check CHECK (tool_name ~ '^[A-Za-z0-9_./-]{1,128}$'),
  CONSTRAINT ai_tool_confirmations_input_check CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT ai_tool_confirmations_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT ai_tool_confirmations_decision_check CHECK (
    (status = 'pending') = (decided_at IS NULL)
    AND (status IN ('approved', 'rejected')) = (decided_by_user_id IS NOT NULL)
  ),
  CONSTRAINT ai_tool_confirmations_reason_check CHECK (length(reason) <= 2000)
);

CREATE INDEX ai_tool_confirmations_pending_idx ON ai_tool_confirmations (run_id) WHERE status = 'pending';
CREATE INDEX ai_tool_confirmations_decided_by_user_id_idx ON ai_tool_confirmations (decided_by_user_id);

CREATE TRIGGER ai_tool_confirmations_set_updated_at BEFORE UPDATE ON ai_tool_confirmations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_tool_confirmations IS
  'Cartão "Aplicar?" (spec 011): uma linha por chamada de tool de escrita que precisa de confirmação, com o diff/prévia. '
  'Criada pelo worker com a execução em running (antes de passá-la a awaiting_confirmation). Decidida só pelo usuário '
  'da execução, uma a uma ou em lote (ai_tool_confirmations_decide). Execução que termina expira as pendentes. '
  'Fora da auditoria (o que a tool aplica é auditado como agente).';
COMMENT ON COLUMN ai_tool_confirmations.tool_use_id IS 'id do bloco tool_use da mensagem do assistente (único na execução).';
COMMENT ON COLUMN ai_tool_confirmations.input IS 'Entrada da tool (imutável): é exatamente o que será aplicado se aprovado.';
COMMENT ON COLUMN ai_tool_confirmations.preview IS 'Diff/prévia para o cartão (antes/depois, registros afetados). Nunca senhas nem tokens.';
COMMENT ON COLUMN ai_tool_confirmations.status IS 'pending → approved | rejected (pelo usuário da execução) | expired (execução terminou ou expirou).';
COMMENT ON COLUMN ai_tool_confirmations.reason IS 'Motivo opcional da rejeição (vai para o modelo no tool_result).';

CREATE FUNCTION ai_tool_confirmations_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'ai_tool_confirmations: new confirmations must be pending'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_transition_check';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.status = 'running') THEN
      RAISE EXCEPTION 'ai_tool_confirmations: run % is not running', NEW.run_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_run_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.run_id <> OLD.run_id OR NEW.tool_use_id <> OLD.tool_use_id OR NEW.tool_name <> OLD.tool_name
     OR NEW.input <> OLD.input OR NEW.preview IS DISTINCT FROM OLD.preview THEN
    RAISE EXCEPTION 'ai_tool_confirmations: confirmation % is immutable (only the decision changes)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_immutable_check';
  END IF;
  IF OLD.status <> 'pending' THEN
    IF (to_jsonb(NEW) - 'updated_at') <> (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'ai_tool_confirmations: confirmation % is already %', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_transition_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('approved', 'rejected') THEN
    IF NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.user_id = NEW.decided_by_user_id) THEN
      RAISE EXCEPTION 'ai_tool_confirmations: only the user who started run % can decide', NEW.run_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_decider_check';
    END IF;
  END IF;
  IF NEW.status <> 'pending' AND NEW.decided_at IS NULL THEN
    NEW.decided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_tool_confirmations_validate BEFORE INSERT OR UPDATE ON ai_tool_confirmations
  FOR EACH ROW EXECUTE FUNCTION ai_tool_confirmations_validate();

-- Execução terminada: confirmações pendentes expiram.
CREATE FUNCTION ai_runs_expire_confirmations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_tool_confirmations c SET status = 'expired'
   WHERE c.run_id = NEW.id AND c.status = 'pending';
  RETURN NULL;
END
$$;

CREATE TRIGGER ai_runs_expire_confirmations AFTER UPDATE OF status ON ai_runs
  FOR EACH ROW WHEN (NEW.status IN ('completed', 'failed', 'canceled') AND OLD.status <> NEW.status)
  EXECUTE FUNCTION ai_runs_expire_confirmations();

CREATE FUNCTION ai_tool_confirmations_decide(
  p_run_id           uuid,
  p_actor_user_id    uuid,
  p_decision         text,
  p_confirmation_ids uuid[] DEFAULT NULL,
  p_reason           text DEFAULT NULL
)
RETURNS TABLE (decided integer, pending integer, run_status text)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  r ai_runs;
  n integer;
  left_pending integer;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'ai_tool_confirmations_decide: decision must be approved or rejected'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM ai_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_tool_confirmations_decide: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  IF r.user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'ai_tool_confirmations_decide: only the user who started run % can decide', p_run_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE ai_tool_confirmations c
     SET status = p_decision, decided_by_user_id = p_actor_user_id, decided_at = clock_timestamp(),
         reason = CASE WHEN p_decision = 'rejected' THEN p_reason END
   WHERE c.run_id = p_run_id AND c.status = 'pending'
     AND (p_confirmation_ids IS NULL OR c.id = ANY (p_confirmation_ids));
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT count(*) INTO left_pending FROM ai_tool_confirmations c WHERE c.run_id = p_run_id AND c.status = 'pending';
  IF left_pending = 0 AND r.status = 'awaiting_confirmation' THEN
    UPDATE ai_runs x SET status = 'queued' WHERE x.id = p_run_id;
    r.status := 'queued';
  END IF;
  RETURN QUERY SELECT n, left_pending, r.status;
END
$$;

COMMENT ON FUNCTION ai_tool_confirmations_decide(uuid, uuid, text, uuid[], text) IS
  'Decide confirmações pendentes de uma execução: todas (p_confirmation_ids nulo = "aprovar tudo") ou as listadas. Só o '
  'usuário da execução (42501 se outro; P0002 se a execução não existe; 22023 se a decisão é inválida). Sem pendentes e '
  'com a execução em awaiting_confirmation, devolve-a à fila (queued) para o worker continuar. Devolve quantas decidiu, '
  'quantas ainda pendem e o status da execução.';

CREATE FUNCTION ai_runs_expire_awaiting(p_after interval DEFAULT interval '7 days') RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  n integer;
BEGIN
  IF p_after IS NULL OR p_after < interval '1 minute' THEN
    RAISE EXCEPTION 'ai_runs_expire_awaiting: after must be >= 1 minute' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE ai_runs r SET status = 'canceled', error = 'confirmation_expired'
   WHERE r.status = 'awaiting_confirmation' AND r.updated_at < clock_timestamp() - p_after;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION ai_runs_expire_awaiting(interval) IS
  'Cancela (error = confirmation_expired) execuções paradas em awaiting_confirmation há mais de p_after (padrão 7 dias); '
  'as confirmações pendentes expiram junto. Devolve quantas. O worker chama periodicamente.';

-- Busca e bifurcação --------------------------------------------------------------------------------------------
CREATE FUNCTION ai_conversation_search(
  p_query            text,
  p_user_id          uuid DEFAULT NULL,
  p_include_archived boolean DEFAULT false,
  p_limit            int DEFAULT 50
)
RETURNS TABLE (conversation_id uuid, user_id uuid, title text, last_message_at timestamptz, score real,
               message_id uuid, snippet text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q   text := btrim(coalesce(p_query, ''));
  tsq tsquery;
BEGIN
  IF q = '' OR length(q) > 500 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ai_conversation_search: query must have 1..500 characters and limit 1..500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  tsq := websearch_to_tsquery('portuguese', q);

  RETURN QUERY
  WITH hits AS (
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.id AS message_id, m.content,
           ts_rank(m.search_tsv, tsq) AS rank
      FROM ai_messages m
      JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE numnode(tsq) > 0 AND m.search_tsv @@ tsq
       AND (p_user_id IS NULL OR c.user_id = p_user_id)
       AND (p_include_archived OR c.archived_at IS NULL)
     ORDER BY m.conversation_id, ts_rank(m.search_tsv, tsq) DESC, m.seq DESC
  )
  SELECT c.id, c.user_id, c.title, c.last_message_at,
         greatest(coalesce(similarity(c.title, q), 0), coalesce(h.rank, 0))::real AS score,
         h.message_id,
         CASE WHEN h.message_id IS NOT NULL
              THEN ts_headline('portuguese', ai_message_text(h.content), tsq,
                               'MaxFragments=1, MaxWords=24, MinWords=8, StartSel=«, StopSel=»') END
    FROM ai_conversations c
    LEFT JOIN hits h ON h.conversation_id = c.id
   WHERE (p_user_id IS NULL OR c.user_id = p_user_id)
     AND (p_include_archived OR c.archived_at IS NULL)
     AND (h.conversation_id IS NOT NULL
          OR c.title ILIKE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
          OR c.title % q)
   ORDER BY 5 DESC, c.last_message_at DESC NULLS LAST, c.id
   LIMIT p_limit;
END
$$;

COMMENT ON FUNCTION ai_conversation_search(text, uuid, boolean, int) IS
  'Busca conversas pelo título (trigram: contém ou parecido) e pelo texto das mensagens (full-text em português, sintaxe '
  'de websearch: "frase", -excluir, OR). p_user_id nulo = de todos (só para admin; a aplicação aplica). Devolve a '
  'melhor mensagem e um trecho com o termo entre « ». Erro 22023 se a busca é vazia/longa ou o limite inválido.';

CREATE FUNCTION ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text DEFAULT NULL)
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

-- migrate:down

DROP FUNCTION ai_conversation_fork(uuid, uuid, text);
DROP FUNCTION ai_conversation_search(text, uuid, boolean, int);
DROP FUNCTION ai_runs_expire_awaiting(interval);
DROP FUNCTION ai_tool_confirmations_decide(uuid, uuid, text, uuid[], text);
DROP TRIGGER ai_runs_expire_confirmations ON ai_runs;
DROP FUNCTION ai_runs_expire_confirmations();
DROP TABLE ai_tool_confirmations;
DROP FUNCTION ai_tool_confirmations_validate();
DROP FUNCTION ai_run_events_purge(interval);
DROP FUNCTION ai_run_event_append(uuid, text, jsonb);
DROP TABLE ai_run_events;
DROP FUNCTION ai_run_mcp_headers(uuid, uuid);
DROP FUNCTION ai_run_provider_credentials(uuid);
DROP FUNCTION ai_run_heartbeat(uuid, uuid);
DROP FUNCTION ai_run_claim(int, interval);

CREATE OR REPLACE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments
UNION ALL
SELECT xml_attachment_id, 'nfe_document', id FROM nfe_documents WHERE xml_attachment_id IS NOT NULL
UNION ALL
SELECT attachment_id, 'card_purchase', card_purchase_id FROM card_purchase_attachments
UNION ALL
SELECT attachment_id, 'statement_import', id FROM statement_imports;

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_trigger_message_fkey;
ALTER TABLE ai_conversations DROP CONSTRAINT ai_conversations_forked_from_message_fkey;
DROP TABLE ai_message_attachments;
DROP TABLE ai_messages;
DROP FUNCTION ai_messages_validate_update();
DROP FUNCTION ai_messages_after_insert();
DROP FUNCTION ai_messages_before_insert();
DROP FUNCTION ai_message_text(jsonb);
DROP FUNCTION ai_message_content_valid(text, jsonb);
DROP TABLE ai_runs;
DROP FUNCTION ai_runs_validate();
DROP TABLE ai_conversations;
