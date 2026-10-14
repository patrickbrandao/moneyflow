-- migrate:up

-- Capacidades dos provedores e provedor por inferência (F10, spec 024; tarefa 022).
--
-- ai_providers:
--   * capabilities: subconjunto de text|vision|embeddings|transcription|speech, em ordem canônica. Omitida no INSERT
--     = padrão do tipo (anthropic = text + vision; openai = todas). anthropic só aceita text e vision;
--   * default_models: um modelo padrão por capacidade ligada, mais speech_voice (voz do TTS). Absorve embedding_model,
--     que sai junto com a regra "no máximo um provedor ativo com embeddings";
--   * prompt_cache_enabled e thinking_enabled: omitidos no INSERT = ligados sem base_url e desligados com ela;
--   * anthropic com base_url (compatível com a Messages API) e a flag text exige default_models.text.
-- ai_agent_inferences: provedor (e modelo/voz, nulos = padrão do provedor) de cada inferência do agente além do texto,
--   que continua em ai_agents.provider_id/model. O provedor precisa ter a flag (inclusive o de texto, com text), e a
--   flag não sai do provedor enquanto um agente (arquivado inclusive) a usa.
-- ai_attachment_derivatives: cache do que se extrai de um anexo (descrição, texto do PDF, transcrição) e do áudio
--   gerado de uma mensagem (speech), com a fila (status, tentativas, reserva). O áudio gerado entra em attachment_links.
-- ai_embedding_indexes + ai_embeddings.provider_id: um índice por par (provedor, modelo) em uso, com a última vez em
--   uso; ai_embeddings_search recebe o provedor e liga hnsw.iterative_scan.
-- Credenciais fora da execução reservada: ai_capability_credentials(agente, capacidade, ator) e
--   ai_embedding_credentials(provedor).
-- Uso e preços: finalidades vision_describe|transcription|speech, audio_seconds/characters e os preços de áudio.
--
-- Migração: cada provedor recebe as flags do tipo; o embedding_model vira default_models.embeddings; o anthropic com
-- base_url ganha o modelo de texto de um agente dele (ou do uso, ou da tabela de preços); cache e raciocínio ficam
-- ligados só sem base_url. Para nada mudar de comportamento, cada agente ganha a inferência de visão no próprio
-- provedor de texto (os anexos continuam indo direto ao modelo) e a de embeddings no provedor de embeddings ativo de
-- hoje, se houver. Os vetores ficam com o provedor cujo embedding_model é o modelo deles (o ativo primeiro); sem
-- provedor, são apagados.

-- Validação -----------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_capability_list_valid(p_capabilities text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_capabilities IS NOT NULL
     AND coalesce(array_ndims(p_capabilities), 1) = 1
     AND array_position(p_capabilities, NULL) IS NULL
     AND p_capabilities <@ ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech']
     AND (SELECT count(DISTINCT c) FROM unnest(p_capabilities) c) = cardinality(p_capabilities)
$$;

COMMENT ON FUNCTION ai_capability_list_valid(text[]) IS
  'true se a lista é um subconjunto, sem nulos nem repetição, de text, vision, embeddings, transcription e speech '
  '(lista vazia vale).';

CREATE FUNCTION ai_provider_default_models_valid(p_capabilities text[], p_models jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF p_models IS NULL OR jsonb_typeof(p_models) <> 'object' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_models) LOOP
    IF jsonb_typeof(v) <> 'string' THEN
      RETURN false;
    END IF;
    IF k = 'speech_voice' THEN
      IF NOT ('speech' = ANY (coalesce(p_capabilities, '{}'))) OR v #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
        RETURN false;
      END IF;
    ELSIF k IN ('text', 'vision', 'embeddings', 'transcription', 'speech') THEN
      IF NOT (k = ANY (coalesce(p_capabilities, '{}'))) OR v #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$' THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

COMMENT ON FUNCTION ai_provider_default_models_valid(text[], jsonb) IS
  'true se default_models é um objeto só com as chaves text, vision, embeddings, transcription, speech (nome de '
  'modelo) e speech_voice (nome de voz, até 64), cada uma só com a capacidade ligada (speech_voice com speech). '
  'Nenhuma chave é obrigatória aqui; o modelo de texto do Anthropic compatível é exigido por ai_providers_validate.';

-- Provedores: colunas novas e migração -------------------------------------------------------------------------
ALTER TABLE ai_providers
  ADD COLUMN capabilities text[],
  ADD COLUMN default_models jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN prompt_cache_enabled boolean,
  ADD COLUMN thinking_enabled boolean;

ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_set_updated_at;
UPDATE ai_providers p
   SET capabilities = CASE WHEN p.kind = 'anthropic' THEN ARRAY['text', 'vision']
                           ELSE ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech'] END,
       default_models = jsonb_strip_nulls(jsonb_build_object(
         'embeddings', p.embedding_model,
         'text', CASE WHEN p.kind = 'anthropic' AND p.base_url IS NOT NULL THEN coalesce(
                   (SELECT a.model FROM ai_agents a
                     WHERE a.provider_id = p.id AND a.model IS NOT NULL
                     ORDER BY (a.is_active AND a.archived_at IS NULL) DESC, a.updated_at DESC, a.id
                     LIMIT 1),
                   (SELECT u.model FROM ai_usage u
                     WHERE u.provider_id = p.id AND u.purpose <> 'embedding'
                     ORDER BY u.created_at DESC, u.id
                     LIMIT 1),
                   (SELECT m.model FROM ai_model_prices m
                     WHERE m.provider_id = p.id
                     ORDER BY m.valid_from DESC, m.id
                     LIMIT 1)) END)),
       prompt_cache_enabled = p.base_url IS NULL,
       thinking_enabled = p.base_url IS NULL;
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_set_updated_at;

ALTER TABLE ai_providers
  ALTER COLUMN capabilities SET NOT NULL,
  ALTER COLUMN prompt_cache_enabled SET NOT NULL,
  ALTER COLUMN thinking_enabled SET NOT NULL,
  ADD CONSTRAINT ai_providers_capabilities_check CHECK (ai_capability_list_valid(capabilities)),
  ADD CONSTRAINT ai_providers_capabilities_kind_check CHECK (kind <> 'anthropic' OR capabilities <@ ARRAY['text', 'vision']),
  ADD CONSTRAINT ai_providers_default_models_check CHECK (ai_provider_default_models_valid(capabilities, default_models));

COMMENT ON COLUMN ai_providers.capabilities IS
  'O que o provedor sabe fazer (spec 024): text (texto→texto), vision (imagens e PDF), embeddings, transcription '
  '(áudio→texto) e speech (texto→áudio), em ordem canônica. Omitida no INSERT = padrão do tipo (anthropic = text + '
  'vision; openai = todas); anthropic só aceita text e vision. Flag em uso por um agente não sai '
  '(ai_providers_capability_in_use_check).';
COMMENT ON COLUMN ai_providers.default_models IS
  'Modelo padrão por capacidade ligada ({"text": …, "vision": …, "embeddings": …, "transcription": …, "speech": …}) e '
  'a voz padrão do TTS (speech_voice). A inferência do agente com modelo nulo herda daqui. Obrigatório só o text do '
  'Anthropic compatível (kind anthropic com base_url): o modelo da chamada mínima do teste e a sugestão no agente.';
COMMENT ON COLUMN ai_providers.prompt_cache_enabled IS
  'Messages API: manda cache_control. Omitido no INSERT = true sem base_url, false com ela. Desligado, o adaptador não '
  'manda cache_control mesmo que o agente peça.';
COMMENT ON COLUMN ai_providers.thinking_enabled IS
  'Messages API: manda thinking (raciocínio). Omitido no INSERT = true sem base_url, false com ela. Desligado, o '
  'adaptador não manda thinking mesmo que o agente peça.';

-- Blindagem da chave: coluna nova precisa de GRANT SELECT explícito.
GRANT SELECT (capabilities, default_models, prompt_cache_enabled, thinking_enabled) ON ai_providers TO moneyflow_app;

-- Agentes: provedor por inferência -----------------------------------------------------------------------------
CREATE TABLE ai_agent_inferences (
  agent_id    uuid        NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  capability  text        NOT NULL,
  provider_id uuid        NOT NULL REFERENCES ai_providers (id),
  model       text,
  voice       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_inferences_pkey PRIMARY KEY (agent_id, capability),
  CONSTRAINT ai_agent_inferences_capability_check CHECK (capability IN ('vision', 'embeddings', 'transcription', 'speech')),
  CONSTRAINT ai_agent_inferences_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_agent_inferences_voice_check CHECK (
    voice IS NULL OR (capability = 'speech' AND voice ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  )
);

CREATE INDEX ai_agent_inferences_provider_id_idx ON ai_agent_inferences (provider_id);

CREATE TRIGGER ai_agent_inferences_set_updated_at BEFORE UPDATE ON ai_agent_inferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_agent_inferences IS
  'Provedor de cada inferência do agente além do texto (spec 024): vision, embeddings, transcription e speech; uma por '
  'agente e capacidade, sem linha = "Nenhum". O texto continua em ai_agents.provider_id/model. O provedor precisa ter a '
  'flag (ai_agent_inferences_provider_capability_check); excluir provedor em uso dá 23503. Some com o agente. Auditada '
  'com record_id = agent_id (histórico do agente).';
COMMENT ON COLUMN ai_agent_inferences.model IS 'Modelo (nulo = o padrão do provedor para a capacidade, default_models).';
COMMENT ON COLUMN ai_agent_inferences.voice IS 'Voz do TTS, só em speech (nula = default_models.speech_voice do provedor).';

CREATE FUNCTION ai_agent_inferences_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  caps text[];
BEGIN
  -- FOR SHARE: espera (e depois relê) uma troca de flags em andamento no provedor.
  SELECT p.capabilities INTO caps FROM ai_providers p WHERE p.id = NEW.provider_id FOR SHARE;
  IF FOUND AND NOT (NEW.capability = ANY (caps)) THEN
    RAISE EXCEPTION 'ai_agent_inferences: provider % does not have the % capability', NEW.provider_id, NEW.capability
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_inferences_provider_capability_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_agent_inferences_validate BEFORE INSERT OR UPDATE ON ai_agent_inferences
  FOR EACH ROW EXECUTE FUNCTION ai_agent_inferences_validate();

CREATE FUNCTION ai_agent_inferences_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o       jsonb;
  n       jsonb;
  changed text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) k
     WHERE n -> k IS DISTINCT FROM o -> k AND k <> 'updated_at';
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, coalesce(n ->> 'agent_id', o ->> 'agent_id')::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_agent_inferences_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION ai_agent_inferences_audit_row() IS
  'Trigger de auditoria de ai_agent_inferences: grava com record_id = agent_id (a linha não tem id), para as '
  'inferências aparecerem no histórico do agente.';

CREATE TRIGGER ai_agent_inferences_audit AFTER INSERT OR UPDATE OR DELETE ON ai_agent_inferences
  FOR EACH ROW EXECUTE FUNCTION ai_agent_inferences_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_inferences TO moneyflow_app;

-- O provedor de texto do agente precisa da flag text.
CREATE FUNCTION ai_agents_provider_capability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  caps text[];
BEGIN
  IF NEW.provider_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.provider_id IS DISTINCT FROM OLD.provider_id) THEN
    SELECT p.capabilities INTO caps FROM ai_providers p WHERE p.id = NEW.provider_id FOR SHARE;
    IF FOUND AND NOT ('text' = ANY (caps)) THEN
      RAISE EXCEPTION 'ai_agents: text provider % does not have the text capability', NEW.provider_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agents_provider_text_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_agents_provider_capability BEFORE INSERT OR UPDATE OF provider_id ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION ai_agents_provider_capability();

-- Provedores: padrões, modelo de texto do compatível e flag em uso ----------------------------------------------
CREATE FUNCTION ai_providers_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  all_caps constant text[] := ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech'];
  removed text[];
  names   text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.capabilities := coalesce(NEW.capabilities,
                                 CASE WHEN NEW.kind = 'anthropic' THEN ARRAY['text', 'vision'] ELSE all_caps END);
    NEW.prompt_cache_enabled := coalesce(NEW.prompt_cache_enabled, NEW.base_url IS NULL);
    NEW.thinking_enabled := coalesce(NEW.thinking_enabled, NEW.base_url IS NULL);
  END IF;

  -- Ordem canônica (a lista inválida fica como veio, para o CHECK recusar).
  IF ai_capability_list_valid(NEW.capabilities) THEN
    NEW.capabilities := ARRAY(SELECT c FROM unnest(all_caps) WITH ORDINALITY x (c, o)
                               WHERE c = ANY (NEW.capabilities) ORDER BY o);
  END IF;

  -- Anthropic compatível: modelo de texto padrão obrigatório. Conferido quando algo que o afeta muda, para um
  -- provedor antigo sem o modelo ainda poder ser ativado, desativado ou arquivado.
  IF NEW.kind = 'anthropic' AND NEW.base_url IS NOT NULL AND 'text' = ANY (NEW.capabilities)
     AND NOT (NEW.default_models ? 'text')
     AND (TG_OP = 'INSERT' OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.base_url IS DISTINCT FROM OLD.base_url
          OR NEW.capabilities IS DISTINCT FROM OLD.capabilities OR NEW.default_models IS DISTINCT FROM OLD.default_models) THEN
    RAISE EXCEPTION 'ai_providers: an Anthropic-compatible provider (base_url) needs a default text model'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_providers_text_model_check';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    removed := ARRAY(SELECT unnest(OLD.capabilities) EXCEPT SELECT unnest(coalesce(NEW.capabilities, '{}')));
    IF cardinality(removed) > 0 THEN
      SELECT string_agg(DISTINCT x.name, ', ' ORDER BY x.name) INTO names
        FROM (SELECT a.name FROM ai_agents a
               WHERE 'text' = ANY (removed) AND a.provider_id = NEW.id
              UNION ALL
              SELECT a.name FROM ai_agent_inferences i JOIN ai_agents a ON a.id = i.agent_id
               WHERE i.provider_id = NEW.id AND i.capability = ANY (removed)) x;
      IF names IS NOT NULL THEN
        RAISE EXCEPTION 'ai_providers: capability removed from provider % is in use by agents: %', NEW.id, names
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_providers_capability_in_use_check', DETAIL = names;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION ai_providers_validate() IS
  'BEFORE INSERT/UPDATE de ai_providers: preenche capabilities, prompt_cache_enabled e thinking_enabled omitidos no '
  'INSERT (pelo tipo e pela base_url), põe as flags em ordem canônica, exige default_models.text no Anthropic '
  'compatível (ai_providers_text_model_check) e recusa tirar uma flag em uso por algum agente, arquivado inclusive '
  '(ai_providers_capability_in_use_check; os nomes dos agentes vão no DETAIL).';

CREATE TRIGGER ai_providers_validate BEFORE INSERT OR UPDATE ON ai_providers
  FOR EACH ROW EXECUTE FUNCTION ai_providers_validate();

-- Agentes existentes: nada muda de comportamento -----------------------------------------------------------------
-- Visão no próprio provedor de texto (o anexo vai direto ao modelo, como antes).
INSERT INTO ai_agent_inferences (agent_id, capability, provider_id)
SELECT a.id, 'vision', a.provider_id
  FROM ai_agents a JOIN ai_providers p ON p.id = a.provider_id
 WHERE 'vision' = ANY (p.capabilities);
-- Embeddings no provedor de embeddings ativo de hoje (era um só, valendo para todos os agentes).
INSERT INTO ai_agent_inferences (agent_id, capability, provider_id)
SELECT a.id, 'embeddings', p.id
  FROM ai_agents a
  CROSS JOIN (SELECT x.id FROM ai_providers x WHERE x.embedding_model IS NOT NULL AND x.is_active
               ORDER BY x.updated_at DESC, x.id LIMIT 1) p;

-- Derivados de anexo e de mensagem ---------------------------------------------------------------------------------
CREATE TABLE ai_attachment_derivatives (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  attachment_id        uuid        REFERENCES attachments (id) ON DELETE CASCADE,
  message_id           uuid        REFERENCES ai_messages (id) ON DELETE CASCADE,
  block_index          integer,
  kind                 text        NOT NULL,
  provider_id          uuid        REFERENCES ai_providers (id) ON DELETE CASCADE,
  model                text,
  voice                text,
  content              text,
  result_attachment_id uuid        REFERENCES attachments (id) ON DELETE CASCADE,
  status               text        NOT NULL DEFAULT 'pending',
  error                text,
  attempts             smallint    NOT NULL DEFAULT 0,
  locked_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_attachment_derivatives_key UNIQUE NULLS NOT DISTINCT
    (attachment_id, message_id, block_index, kind, provider_id, model, voice),
  CONSTRAINT ai_attachment_derivatives_kind_check CHECK (kind IN ('description', 'pdf_text', 'transcription', 'speech')),
  CONSTRAINT ai_attachment_derivatives_origin_check CHECK (
    (attachment_id IS NULL) <> (message_id IS NULL)
    AND (message_id IS NULL) = (block_index IS NULL)
    AND (kind = 'speech') = (message_id IS NOT NULL)
  ),
  CONSTRAINT ai_attachment_derivatives_block_index_check CHECK (block_index BETWEEN 0 AND 9999),
  CONSTRAINT ai_attachment_derivatives_provider_check CHECK (
    (kind = 'pdf_text') = (provider_id IS NULL) AND (kind = 'pdf_text') = (model IS NULL)
  ),
  CONSTRAINT ai_attachment_derivatives_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_attachment_derivatives_voice_check CHECK (
    voice IS NULL OR (kind = 'speech' AND voice ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  ),
  CONSTRAINT ai_attachment_derivatives_content_check CHECK (length(content) <= 5000000),
  CONSTRAINT ai_attachment_derivatives_status_check CHECK (status IN ('pending', 'running', 'done', 'failed')),
  CONSTRAINT ai_attachment_derivatives_result_check CHECK (
    (result_attachment_id IS NULL OR kind = 'speech')
    AND (status <> 'done' OR (CASE WHEN kind = 'speech' THEN result_attachment_id IS NOT NULL ELSE content IS NOT NULL END))
  ),
  CONSTRAINT ai_attachment_derivatives_error_check CHECK (length(error) <= 4000 AND (status <> 'failed' OR error IS NOT NULL)),
  CONSTRAINT ai_attachment_derivatives_attempts_check CHECK (attempts BETWEEN 0 AND 100),
  CONSTRAINT ai_attachment_derivatives_lock_check CHECK ((status = 'running') = (locked_at IS NOT NULL))
);

-- O único começa por attachment_id e cobre a FK dele.
CREATE INDEX ai_attachment_derivatives_message_id_idx ON ai_attachment_derivatives (message_id, block_index);
CREATE INDEX ai_attachment_derivatives_provider_id_idx ON ai_attachment_derivatives (provider_id);
CREATE INDEX ai_attachment_derivatives_result_attachment_id_idx ON ai_attachment_derivatives (result_attachment_id);
CREATE INDEX ai_attachment_derivatives_queue_idx ON ai_attachment_derivatives (kind, created_at)
  WHERE status IN ('pending', 'running');

CREATE TRIGGER ai_attachment_derivatives_set_updated_at BEFORE UPDATE ON ai_attachment_derivatives
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_attachment_derivatives IS
  'Derivados (cache) de anexos e mensagens dos agentes (specs 024 e 025): description (o provedor de visão descreve o '
  'anexo para outro modelo de texto), pdf_text (camada de texto do PDF, extraída no servidor, sem provedor), '
  'transcription (áudio→texto) e speech (áudio gerado de uma mensagem). Um por origem, tipo, provedor, modelo e voz '
  '(ai_attachment_derivatives_key, NULLS NOT DISTINCT). Some com a origem; o áudio gerado aparece em attachment_links '
  'como ai_message_speech e é apagado com o derivado quando não tem outro vínculo. Fora da auditoria e do backup.';
COMMENT ON COLUMN ai_attachment_derivatives.attachment_id IS 'Origem anexo (description, pdf_text, transcription). Exatamente uma origem.';
COMMENT ON COLUMN ai_attachment_derivatives.message_id IS 'Origem mensagem (só speech), com block_index.';
COMMENT ON COLUMN ai_attachment_derivatives.block_index IS
  'Parte da mensagem que virou áudio (0–9999, definida pela aplicação: o bloco de texto ou o trecho dividido no limite '
  'do provedor). Só com message_id.';
COMMENT ON COLUMN ai_attachment_derivatives.provider_id IS 'Provedor que gerou (nulo só em pdf_text). Excluir o provedor leva o cache.';
COMMENT ON COLUMN ai_attachment_derivatives.model IS 'Modelo que gerou (nulo só em pdf_text).';
COMMENT ON COLUMN ai_attachment_derivatives.voice IS 'Voz do TTS (só speech; opcional).';
COMMENT ON COLUMN ai_attachment_derivatives.content IS 'Texto gerado (descrição, texto do PDF, transcrição; até 5 milhões de caracteres). Obrigatório em done, menos no speech.';
COMMENT ON COLUMN ai_attachment_derivatives.result_attachment_id IS
  'Áudio gerado (só speech; obrigatório em done). Entra em attachment_links (ai_message_speech, alvo = a mensagem); '
  'trocado ou com o derivado excluído, o anexo antigo é apagado se ficou sem vínculo.';
COMMENT ON COLUMN ai_attachment_derivatives.status IS 'pending (na fila), running (reservado: locked_at), done ou failed (com error).';
COMMENT ON COLUMN ai_attachment_derivatives.attempts IS 'Tentativas feitas (0–100), para a fila desistir.';
COMMENT ON COLUMN ai_attachment_derivatives.locked_at IS 'Instante da reserva, só em running (reserva velha = worker caiu).';

-- O que identifica o derivado não muda (a fila só mexe em conteúdo, status, erro, tentativas e reserva).
CREATE FUNCTION ai_attachment_derivatives_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.attachment_id, NEW.message_id, NEW.block_index, NEW.kind, NEW.provider_id, NEW.model, NEW.voice)
     IS DISTINCT FROM (OLD.attachment_id, OLD.message_id, OLD.block_index, OLD.kind, OLD.provider_id, OLD.model, OLD.voice) THEN
    RAISE EXCEPTION 'ai_attachment_derivatives: origin, kind, provider, model and voice of derivative % are immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_attachment_derivatives_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_attachment_derivatives_guard BEFORE UPDATE ON ai_attachment_derivatives
  FOR EACH ROW EXECUTE FUNCTION ai_attachment_derivatives_guard();

-- O áudio gerado pertence ao derivado: sai com ele (ou quando é trocado), se não ganhou outro vínculo.
CREATE FUNCTION ai_attachment_derivatives_release_result() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.result_attachment_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR NEW.result_attachment_id IS DISTINCT FROM OLD.result_attachment_id)
     AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = OLD.result_attachment_id) THEN
    DELETE FROM attachments a WHERE a.id = OLD.result_attachment_id;
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION ai_attachment_derivatives_release_result() IS
  'AFTER UPDATE OF result_attachment_id / DELETE: apaga o áudio gerado antigo se ele não aparece mais em '
  'attachment_links (excluir a conversa leva as mensagens, os derivados speech e os áudios gerados).';

CREATE TRIGGER ai_attachment_derivatives_release_result AFTER UPDATE OF result_attachment_id OR DELETE
  ON ai_attachment_derivatives
  FOR EACH ROW EXECUTE FUNCTION ai_attachment_derivatives_release_result();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_attachment_derivatives TO moneyflow_app;

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
  SELECT attachment_id, 'ai_message', message_id FROM ai_message_attachments
  UNION ALL
  SELECT attachment_id, 'contract_document', id FROM contract_documents WHERE attachment_id IS NOT NULL
  UNION ALL
  SELECT result_attachment_id, 'ai_message_speech', message_id FROM ai_attachment_derivatives
   WHERE result_attachment_id IS NOT NULL;

-- Embeddings por par (provedor, modelo) ---------------------------------------------------------------------------
CREATE TABLE ai_embedding_indexes (
  provider_id    uuid        NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
  model          text        NOT NULL,
  last_in_use_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_embedding_indexes_pkey PRIMARY KEY (provider_id, model),
  CONSTRAINT ai_embedding_indexes_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$')
);

CREATE TRIGGER ai_embedding_indexes_set_updated_at BEFORE UPDATE ON ai_embedding_indexes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_embedding_indexes IS
  'Um índice de embeddings por par (provedor, modelo) (spec 024). O worker registra os pares em uso a cada ciclo '
  '(ai_embedding_indexes_touch) e apaga os parados há mais de 7 dias com os vetores (ai_embedding_indexes_purge). '
  'Todo vetor pertence a um par registrado (FK; registre antes de gravar). Estado operacional: fora da auditoria e do '
  'backup.';
COMMENT ON COLUMN ai_embedding_indexes.last_in_use_at IS 'Última vez em que algum agente ativo usava o par.';

ALTER TABLE ai_embeddings ADD COLUMN provider_id uuid;

ALTER TABLE ai_embeddings DISABLE TRIGGER ai_embeddings_set_updated_at;
UPDATE ai_embeddings e
   SET provider_id = (SELECT p.id FROM ai_providers p
                       WHERE p.embedding_model = e.model
                       ORDER BY p.is_active DESC, p.updated_at DESC, p.id
                       LIMIT 1);
ALTER TABLE ai_embeddings ENABLE TRIGGER ai_embeddings_set_updated_at;
DELETE FROM ai_embeddings WHERE provider_id IS NULL;

INSERT INTO ai_embedding_indexes (provider_id, model)
SELECT DISTINCT e.provider_id, e.model FROM ai_embeddings e;

DROP INDEX ai_embeddings_reindex_idx;
ALTER TABLE ai_embeddings
  ALTER COLUMN provider_id SET NOT NULL,
  DROP CONSTRAINT ai_embeddings_object_key,
  ADD CONSTRAINT ai_embeddings_object_key UNIQUE (object_type, object_id, provider_id, model),
  ADD CONSTRAINT ai_embeddings_index_fkey FOREIGN KEY (provider_id, model)
    REFERENCES ai_embedding_indexes (provider_id, model) ON DELETE CASCADE;
CREATE INDEX ai_embeddings_pair_idx ON ai_embeddings (provider_id, model);
CREATE INDEX ai_embeddings_reindex_idx ON ai_embeddings (provider_id, model, updated_at) WHERE needs_reindex;

COMMENT ON TABLE ai_embeddings IS
  'Embeddings dos registros para a busca semântica dos agentes (vector(1536), HNSW por cosseno). Um por objeto e par '
  '(provedor, modelo); todos os pares dividem o mesmo HNSW e a busca filtra pelo par com hnsw.iterative_scan. Sem FK '
  'para o objeto (polimórfico): ai_embeddings_purge_orphans limpa os de objetos excluídos. Derivado: fora da '
  'auditoria. A busca SEMPRE filtra pelas caixas que o usuário lê (caixa_id) e a aplicação revalida o objeto.';
COMMENT ON COLUMN ai_embeddings.provider_id IS
  'Provedor que gera o vetor. O par (provider_id, model) precisa estar em ai_embedding_indexes, e sai com ele.';
COMMENT ON COLUMN ai_embeddings.model IS
  'Modelo de embeddings (ex.: text-embedding-3-small). Busque sempre com o par (provedor, modelo) do vetor de consulta.';

CREATE VIEW ai_embedding_pairs_in_use WITH (security_invoker = true) AS
SELECT i.provider_id,
       coalesce(i.model, p.default_models ->> 'embeddings') AS model,
       count(*)::int AS agents
  FROM ai_agent_inferences i
  JOIN ai_agents a ON a.id = i.agent_id AND a.is_active AND a.archived_at IS NULL
  JOIN ai_providers p ON p.id = i.provider_id AND p.is_active AND p.archived_at IS NULL AND 'embeddings' = ANY (p.capabilities)
 WHERE i.capability = 'embeddings' AND coalesce(i.model, p.default_models ->> 'embeddings') IS NOT NULL
 GROUP BY i.provider_id, coalesce(i.model, p.default_models ->> 'embeddings');

COMMENT ON VIEW ai_embedding_pairs_in_use IS
  'Pares (provedor, modelo) de embeddings usados por algum agente ativo e não arquivado, com provedor ativo e com a '
  'flag; o modelo nulo da inferência herda default_models.embeddings (sem nenhum dos dois, o par não existe).';

CREATE FUNCTION ai_embedding_indexes_touch() RETURNS SETOF ai_embedding_indexes
LANGUAGE sql VOLATILE AS $$
  INSERT INTO ai_embedding_indexes AS x (provider_id, model, last_in_use_at)
  SELECT u.provider_id, u.model, now() FROM ai_embedding_pairs_in_use u
  ON CONFLICT (provider_id, model) DO UPDATE SET last_in_use_at = excluded.last_in_use_at
  RETURNING x.*
$$;

COMMENT ON FUNCTION ai_embedding_indexes_touch() IS
  'Worker, a cada ciclo: registra os pares em uso (ai_embedding_pairs_in_use) com last_in_use_at = agora e os devolve '
  '(o que indexar). Rode antes de gravar vetores de um par novo (a FK de ai_embeddings exige o par).';

CREATE FUNCTION ai_embedding_indexes_purge(p_idle interval DEFAULT interval '7 days') RETURNS bigint
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  n bigint;
BEGIN
  IF p_idle IS NULL OR p_idle < interval '1 hour' THEN
    RAISE EXCEPTION 'ai_embedding_indexes_purge: idle interval must be at least 1 hour'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Os vetores primeiro (para contar), depois os pares (a FK levaria os vetores de qualquer jeito).
  WITH gone AS (
    DELETE FROM ai_embeddings e USING ai_embedding_indexes x
     WHERE e.provider_id = x.provider_id AND e.model = x.model
       AND x.last_in_use_at < now() - p_idle
       AND NOT EXISTS (SELECT 1 FROM ai_embedding_pairs_in_use u WHERE u.provider_id = x.provider_id AND u.model = x.model)
    RETURNING 1
  )
  SELECT count(*) INTO n FROM gone;
  DELETE FROM ai_embedding_indexes x
   WHERE x.last_in_use_at < now() - p_idle
     AND NOT EXISTS (SELECT 1 FROM ai_embedding_pairs_in_use u WHERE u.provider_id = x.provider_id AND u.model = x.model);
  RETURN n;
END
$$;

COMMENT ON FUNCTION ai_embedding_indexes_purge(interval) IS
  'Worker: apaga os pares fora de uso cujo last_in_use_at é mais velho que p_idle (padrão 7 dias), com os vetores, e '
  'devolve quantos vetores saíram. Erro 22023 com p_idle nulo ou menor que 1 hora.';

CREATE VIEW ai_embedding_index_stats WITH (security_invoker = true) AS
SELECT x.provider_id,
       x.model,
       x.last_in_use_at,
       EXISTS (SELECT 1 FROM ai_embedding_pairs_in_use u WHERE u.provider_id = x.provider_id AND u.model = x.model) AS in_use,
       count(e.id)::int AS vectors,
       (count(e.id) FILTER (WHERE NOT e.needs_reindex))::int AS indexed,
       (count(e.id) FILTER (WHERE e.needs_reindex))::int AS pending
  FROM ai_embedding_indexes x
  LEFT JOIN ai_embeddings e ON e.provider_id = x.provider_id AND e.model = x.model
 GROUP BY x.provider_id, x.model, x.last_in_use_at;

COMMENT ON VIEW ai_embedding_index_stats IS
  'Progresso de cada índice (detalhe do provedor): linhas (vectors), já indexadas com o texto atual (indexed) e na '
  'fila (pending), mais se o par está em uso.';

DROP FUNCTION ai_embeddings_search(vector, text, uuid[], text[], int);

CREATE FUNCTION ai_embeddings_search(
  p_query        vector(1536),
  p_provider_id  uuid,
  p_model        text,
  p_caixa_ids    uuid[],
  p_object_types text[] DEFAULT NULL,
  p_limit        int DEFAULT 20
)
RETURNS TABLE (object_type text, object_id uuid, caixa_id uuid, source_text text, distance double precision)
LANGUAGE plpgsql STABLE
SET hnsw.iterative_scan = relaxed_order
AS $$
BEGIN
  IF p_query IS NULL OR p_provider_id IS NULL OR p_model IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'ai_embeddings_search: query vector, provider, model and limit 1..200 are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Vários pares no mesmo HNSW: com o filtro depois do índice, a varredura iterativa continua até achar p_limit
  -- linhas do par; relaxed_order pode devolver fora de ordem, então reordena por fora. O "+ 0" impede o planejador
  -- (PostgreSQL 17+) de reaproveitar a ordem declarada pela CTE e pular a ordenação.
  RETURN QUERY
  WITH nearest AS MATERIALIZED (
    SELECT e.object_type AS o_type, e.object_id AS o_id, e.caixa_id AS c_id, e.source_text AS s_text,
           (e.embedding <=> p_query)::double precision AS dist
      FROM ai_embeddings e
     WHERE e.provider_id = p_provider_id AND e.model = p_model AND e.embedding IS NOT NULL
       AND (e.caixa_id IS NULL OR e.caixa_id = ANY (coalesce(p_caixa_ids, '{}')))
       AND (p_object_types IS NULL OR e.object_type = ANY (p_object_types))
     ORDER BY e.embedding <=> p_query
     LIMIT p_limit
  )
  SELECT n.o_type, n.o_id, n.c_id, n.s_text, n.dist FROM nearest n ORDER BY n.dist + 0, n.o_type, n.o_id;
END
$$;

COMMENT ON FUNCTION ai_embeddings_search(vector, uuid, text, uuid[], text[], int) IS
  'Vizinhos mais próximos (distância de cosseno, menor = mais parecido) do vetor de consulta, no mesmo par (provedor, '
  'modelo), só de objetos globais (caixa_id nulo) ou das caixas listadas (as que o usuário lê), opcionalmente por '
  'tipos. Roda com hnsw.iterative_scan = relaxed_order (o filtro do par não derruba resultados) e reordena. Vetores '
  'velhos (needs_reindex) ainda entram. Erro 22023 sem vetor/provedor/modelo ou com limite fora de 1..200.';

-- Credenciais -----------------------------------------------------------------------------------------------------
DROP FUNCTION ai_embedding_credentials();

CREATE FUNCTION ai_embedding_credentials(p_provider_id uuid)
RETURNS TABLE (provider_id uuid, kind text, base_url text, api_key text, default_model text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.ai_providers;
BEGIN
  SELECT * INTO p FROM public.ai_providers x WHERE x.id = p_provider_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_embedding_credentials: provider % not found', p_provider_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT p.is_active OR p.archived_at IS NOT NULL OR NOT ('embeddings' = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_embedding_credentials: provider % is not active or lacks the embeddings capability', p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, p.default_models ->> 'embeddings';
END
$$;

REVOKE EXECUTE ON FUNCTION ai_embedding_credentials(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_embedding_credentials(uuid) TO moneyflow_app;

COMMENT ON FUNCTION ai_embedding_credentials(uuid) IS
  'Worker (indexação de um par): tipo, URL, chave e modelo padrão de embeddings do provedor. Erro 42501 se o provedor '
  'está inativo, arquivado ou sem a flag embeddings; P0002 se não existe. Use o modelo do par, não o padrão, quando '
  'forem diferentes.';

CREATE FUNCTION ai_capability_credentials(p_agent_id uuid, p_capability text, p_actor_user_id uuid)
RETURNS TABLE (provider_id uuid, kind text, base_url text, api_key text, model text, voice text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ag  public.ai_agents;
  inf public.ai_agent_inferences;
  p   public.ai_providers;
BEGIN
  IF p_capability IS NULL OR p_capability NOT IN ('text', 'vision', 'embeddings', 'transcription', 'speech') THEN
    RAISE EXCEPTION 'ai_capability_credentials: unknown capability %', p_capability USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.is_active) THEN
    RAISE EXCEPTION 'ai_capability_credentials: actor % is not an active user', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO ag FROM public.ai_agents a WHERE a.id = p_agent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_capability_credentials: agent % not found', p_agent_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT ag.is_active OR ag.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'ai_capability_credentials: agent % is not active', p_agent_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_capability = 'text' THEN
    SELECT * INTO p FROM public.ai_providers x WHERE x.id = ag.provider_id;
  ELSE
    SELECT * INTO inf FROM public.ai_agent_inferences i WHERE i.agent_id = ag.id AND i.capability = p_capability;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_capability_credentials: agent % has no provider for %', p_agent_id, p_capability
        USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO p FROM public.ai_providers x WHERE x.id = inf.provider_id;
  END IF;
  IF p.id IS NULL OR NOT p.is_active OR p.archived_at IS NOT NULL OR NOT (p_capability = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_capability_credentials: provider % is not active or lacks the % capability', p.id, p_capability
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT p.id, p.kind, p.base_url, p.api_key,
         CASE WHEN p_capability = 'text' THEN ag.model ELSE coalesce(inf.model, p.default_models ->> p_capability) END,
         CASE WHEN p_capability = 'speech' THEN coalesce(inf.voice, p.default_models ->> 'speech_voice') END;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_capability_credentials(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_capability_credentials(uuid, text, uuid) TO moneyflow_app;

COMMENT ON FUNCTION ai_capability_credentials(uuid, text, uuid) IS
  'Provedor, URL, chave, modelo e voz de uma inferência do agente (text, vision, embeddings, transcription, speech), '
  'fora ou dentro de uma execução (transcrição no upload, TTS, embedding da consulta, visão por descrição no runner). '
  'Modelo nulo da inferência = default_models do provedor (pode voltar nulo: não configurado); text = provedor e '
  'modelo do agente; voz só no speech. Erros: 22023 capacidade desconhecida; 42501 ator não é usuário ativo, agente '
  'inativo/arquivado, provedor inativo/arquivado ou sem a flag; P0002 agente inexistente ou sem provedor para a '
  'capacidade. O ator vem da sessão autenticada (na execução, o usuário dela).';

-- A execução só lê a chave de um provedor de texto (a flag não sai com agente usando, mas a execução guarda o seu).
CREATE OR REPLACE FUNCTION ai_run_provider_credentials(p_run_id uuid)
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
  IF NOT ('text' = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: provider % lacks the text capability', p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, r.model;
END
$$;

COMMENT ON FUNCTION ai_run_provider_credentials(uuid) IS
  'Worker: provedor, URL, chave e modelo de texto de uma execução RESERVADA (status running). Erro 42501 em outro '
  'status ou com o provedor inativo ou sem a flag text; P0002 se a execução não existe. Única forma de ler '
  'ai_providers.api_key durante o loop, além de ai_capability_credentials para as outras inferências.';

-- Sai o embedding_model --------------------------------------------------------------------------------------------
DROP INDEX ai_providers_embedding_key;
ALTER TABLE ai_providers DROP CONSTRAINT ai_providers_embedding_model_check;
ALTER TABLE ai_providers DROP COLUMN embedding_model;

COMMENT ON TABLE ai_providers IS
  'Provedores de LLM cadastrados pelo admin (specs 011 e 024). kind anthropic (Messages API; com base_url, um '
  'compatível) ou openai (Chat Completions, embeddings e áudio; com base_url, um compatível). capabilities diz o que '
  'cada um faz e default_models o modelo padrão de cada capacidade. A chave é segredo: moneyflow_app grava mas não lê '
  'api_key.';
COMMENT ON COLUMN ai_providers.api_key IS
  'SEGREDO: chave da API. moneyflow_app grava mas NÃO lê esta coluna; leitura só por ai_run_provider_credentials, '
  'ai_capability_credentials, ai_embedding_credentials e admin_ai_provider_api_key. Nula só com base_url (servidor '
  'local sem chave). Nunca vai para o audit_log, respostas da API, logs ou tools de agente. Na edição, campo vazio '
  'mantém a atual.';

-- Uso e preços -----------------------------------------------------------------------------------------------------
ALTER TABLE ai_model_prices
  ADD COLUMN audio_input_per_minute numeric(14,6),
  ADD COLUMN speech_per_million_chars numeric(14,6),
  ADD CONSTRAINT ai_model_prices_audio_values_check CHECK (audio_input_per_minute >= 0 AND speech_per_million_chars >= 0);

COMMENT ON COLUMN ai_model_prices.audio_input_per_minute IS
  'Preço por minuto de áudio transcrito, para os modelos cobrados assim (ex.: whisper-1). Nulo = não cobra por minuto.';
COMMENT ON COLUMN ai_model_prices.speech_per_million_chars IS
  'Preço por 1 milhão de caracteres convertidos em fala, para os modelos cobrados assim (ex.: tts-1). Nulo = não cobra '
  'por caractere.';

ALTER TABLE ai_usage
  ADD COLUMN audio_seconds numeric(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN characters bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT ai_usage_audio_check CHECK (audio_seconds >= 0 AND characters >= 0);

ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (
  purpose IN ('chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
              'vision_describe', 'transcription', 'speech')
);

ALTER TABLE ai_requests DROP CONSTRAINT ai_requests_purpose_check;
ALTER TABLE ai_requests ADD CONSTRAINT ai_requests_purpose_check CHECK (
  purpose IN ('chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown',
              'vision_describe', 'transcription', 'speech')
);

COMMENT ON COLUMN ai_usage.purpose IS
  'chat (loop do agente), title (título automático), embedding (indexação/busca semântica), vision_describe (descrição '
  'de anexo pelo provedor de visão), transcription (áudio→texto), speech (texto→áudio) ou a finalidade de um fluxo '
  'automático: document_reading (leitura de documento), classify_lines (sugestões da conciliação), contract_reading '
  '(leitura do PDF do contrato) e contract_markdown (PDF do contrato → markdown). chat numa conversa de fluxo vira a '
  'finalidade da conversa.';
COMMENT ON COLUMN ai_usage.audio_seconds IS 'Segundos de áudio transcritos (transcription), com milésimos. Entra no custo por audio_input_per_minute.';
COMMENT ON COLUMN ai_usage.characters IS 'Caracteres convertidos em fala (speech). Entra no custo por speech_per_million_chars.';
COMMENT ON COLUMN ai_requests.purpose IS
  'Finalidade, com o vocabulário de ai_usage.purpose; nula só (e sempre) em test_connection e list_models. chat numa '
  'conversa de fluxo vira a finalidade dela.';

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
    -- Preços por milhão (tokens, caracteres) dão micros direto; o minuto de áudio vira micros × 1 000 000 / 60.
    NEW.cost_micros := round(NEW.input_tokens * p.input_price_per_million
                             + NEW.output_tokens * p.output_price_per_million
                             + NEW.cache_write_tokens * coalesce(p.cache_write_price_per_million, p.input_price_per_million)
                             + NEW.cache_read_tokens * coalesce(p.cache_read_price_per_million, p.input_price_per_million)
                             + NEW.audio_seconds * coalesce(p.audio_input_per_minute, 0) * 1000000 / 60
                             + NEW.characters * coalesce(p.speech_per_million_chars, 0))::bigint;
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
  'purpose chat pela finalidade da conversa quando ela é de fluxo e calcula o custo pelo preço vigente: tokens, '
  'segundos de áudio (audio_input_per_minute) e caracteres de fala (speech_per_million_chars).';

-- migrate:down

-- Uso e preços
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

-- As finalidades novas voltam a chat (a requisição terminada é imutável: o guard sai durante a troca).
ALTER TABLE ai_requests DISABLE TRIGGER ai_requests_before_write;
ALTER TABLE ai_requests DISABLE TRIGGER ai_requests_set_updated_at;
UPDATE ai_requests SET purpose = 'chat' WHERE purpose IN ('vision_describe', 'transcription', 'speech');
ALTER TABLE ai_requests ENABLE TRIGGER ai_requests_set_updated_at;
ALTER TABLE ai_requests ENABLE TRIGGER ai_requests_before_write;
ALTER TABLE ai_requests DROP CONSTRAINT ai_requests_purpose_check;
ALTER TABLE ai_requests ADD CONSTRAINT ai_requests_purpose_check CHECK (
  purpose IN ('chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown')
);

UPDATE ai_usage SET purpose = 'chat' WHERE purpose IN ('vision_describe', 'transcription', 'speech');
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (
  purpose IN ('chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown')
);
ALTER TABLE ai_usage DROP COLUMN audio_seconds, DROP COLUMN characters;

COMMENT ON COLUMN ai_usage.purpose IS
  'chat (loop do agente), title (título automático), embedding (indexação/busca semântica, sem agente) ou a '
  'finalidade de um fluxo automático: document_reading (leitura de documento), classify_lines (sugestões da '
  'conciliação), contract_reading (leitura do PDF do contrato) e contract_markdown (PDF do contrato → markdown). '
  'Mesmo vocabulário de ai_conversations.purpose; chat numa conversa de fluxo vira a finalidade da conversa.';
COMMENT ON COLUMN ai_requests.purpose IS
  'Finalidade, com o vocabulário de ai_usage.purpose; nula só (e sempre) em test_connection e list_models. chat numa '
  'conversa de fluxo vira a finalidade dela, como em ai_usage.';

ALTER TABLE ai_model_prices DROP COLUMN audio_input_per_minute, DROP COLUMN speech_per_million_chars;

-- Credenciais
DROP FUNCTION ai_capability_credentials(uuid, text, uuid);
DROP FUNCTION ai_embedding_credentials(uuid);

CREATE OR REPLACE FUNCTION ai_run_provider_credentials(p_run_id uuid)
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

COMMENT ON FUNCTION ai_run_provider_credentials(uuid) IS
  'Worker: provedor, URL, chave e modelo de uma execução RESERVADA (status running). Erro 42501 em outro status ou com o '
  'provedor inativo; P0002 se a execução não existe. Única forma de ler ai_providers.api_key durante o loop.';

-- embedding_model volta (um provedor ativo só: o que mais agentes usam para embeddings).
ALTER TABLE ai_providers ADD COLUMN embedding_model text;
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_set_updated_at;
ALTER TABLE ai_providers DISABLE TRIGGER ai_providers_validate;
UPDATE ai_providers p SET embedding_model = p.default_models ->> 'embeddings' WHERE p.kind = 'openai';
UPDATE ai_providers p SET embedding_model = NULL
 WHERE p.is_active AND p.embedding_model IS NOT NULL
   AND p.id <> (SELECT x.id FROM ai_providers x
                 WHERE x.is_active AND x.embedding_model IS NOT NULL
                 ORDER BY (SELECT count(*) FROM ai_agent_inferences i
                            WHERE i.provider_id = x.id AND i.capability = 'embeddings') DESC, x.created_at, x.id
                 LIMIT 1);
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_validate;
ALTER TABLE ai_providers ENABLE TRIGGER ai_providers_set_updated_at;
ALTER TABLE ai_providers ADD CONSTRAINT ai_providers_embedding_model_check CHECK (
  embedding_model IS NULL OR (embedding_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$' AND kind = 'openai')
);
CREATE UNIQUE INDEX ai_providers_embedding_key ON ai_providers ((true)) WHERE embedding_model IS NOT NULL AND is_active;
GRANT SELECT (embedding_model) ON ai_providers TO moneyflow_app;

COMMENT ON COLUMN ai_providers.embedding_model IS
  'Modelo de embeddings deste provedor (só kind openai; ex.: text-embedding-3-small, 1536 dimensões). Nulo = o provedor '
  'não gera embeddings. No máximo um provedor ativo com embeddings; sem nenhum, a busca dos agentes cai para trigram.';

CREATE FUNCTION ai_embedding_credentials()
RETURNS TABLE (provider_id uuid, kind text, base_url text, api_key text, embedding_model text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.id, p.kind, p.base_url, p.api_key, p.embedding_model
    FROM public.ai_providers p
   WHERE p.embedding_model IS NOT NULL AND p.is_active
$$;

REVOKE EXECUTE ON FUNCTION ai_embedding_credentials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_embedding_credentials() TO moneyflow_app;

COMMENT ON FUNCTION ai_embedding_credentials() IS
  'Worker (indexação e busca semântica): credenciais do provedor de embeddings ativo (0 ou 1 linha). Sem linha = sem '
  'embeddings; a busca dos agentes cai para trigram.';

-- Embeddings: um vetor por objeto e modelo de novo (fica o do provedor que manteve o embedding_model).
DROP FUNCTION ai_embeddings_search(vector, uuid, text, uuid[], text[], int);
DROP VIEW ai_embedding_index_stats;
DROP FUNCTION ai_embedding_indexes_purge(interval);
DROP FUNCTION ai_embedding_indexes_touch();
DROP VIEW ai_embedding_pairs_in_use;

DELETE FROM ai_embeddings e
 WHERE EXISTS (SELECT 1 FROM ai_embeddings o
                WHERE o.object_type = e.object_type AND o.object_id = e.object_id AND o.model = e.model AND o.id <> e.id
                  AND (EXISTS (SELECT 1 FROM ai_providers p WHERE p.id = o.provider_id AND p.embedding_model = o.model),
                       o.id)
                      > (EXISTS (SELECT 1 FROM ai_providers p WHERE p.id = e.provider_id AND p.embedding_model = e.model),
                         e.id));

DROP INDEX ai_embeddings_reindex_idx;
DROP INDEX ai_embeddings_pair_idx;
ALTER TABLE ai_embeddings
  DROP CONSTRAINT ai_embeddings_index_fkey,
  DROP CONSTRAINT ai_embeddings_object_key,
  DROP COLUMN provider_id,
  ADD CONSTRAINT ai_embeddings_object_key UNIQUE (object_type, object_id, model);
CREATE INDEX ai_embeddings_reindex_idx ON ai_embeddings (model, updated_at) WHERE needs_reindex;
DROP TABLE ai_embedding_indexes;

COMMENT ON TABLE ai_embeddings IS
  'Embeddings dos registros para a busca semântica dos agentes (vector(1536), HNSW por cosseno). Um por objeto e modelo. '
  'Sem FK para o objeto (polimórfico): ai_embeddings_purge_orphans limpa os de objetos excluídos. Derivado: fora da '
  'auditoria. A busca SEMPRE filtra pelas caixas que o usuário lê (caixa_id) e a aplicação revalida o objeto.';
COMMENT ON COLUMN ai_embeddings.model IS 'Modelo de embeddings (ex.: text-embedding-3-small). Busque sempre com o mesmo modelo do vetor de consulta.';

CREATE FUNCTION ai_embeddings_search(
  p_query        vector(1536),
  p_model        text,
  p_caixa_ids    uuid[],
  p_object_types text[] DEFAULT NULL,
  p_limit        int DEFAULT 20
)
RETURNS TABLE (object_type text, object_id uuid, caixa_id uuid, source_text text, distance double precision)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_query IS NULL OR p_model IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'ai_embeddings_search: query vector, model and limit 1..200 are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT e.object_type, e.object_id, e.caixa_id, e.source_text, (e.embedding <=> p_query)::double precision
    FROM ai_embeddings e
   WHERE e.model = p_model AND e.embedding IS NOT NULL
     AND (e.caixa_id IS NULL OR e.caixa_id = ANY (coalesce(p_caixa_ids, '{}')))
     AND (p_object_types IS NULL OR e.object_type = ANY (p_object_types))
   ORDER BY e.embedding <=> p_query
   LIMIT p_limit;
END
$$;

COMMENT ON FUNCTION ai_embeddings_search(vector, text, uuid[], text[], int) IS
  'Vizinhos mais próximos (distância de cosseno, menor = mais parecido) do vetor de consulta, no mesmo modelo, só de '
  'objetos globais (caixa_id nulo) ou das caixas listadas (as que o usuário lê), opcionalmente por tipos. Vetores velhos '
  '(needs_reindex) ainda entram. Erro 22023 sem vetor/modelo ou com limite fora de 1..200.';

-- Derivados
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
  SELECT attachment_id, 'ai_message', message_id FROM ai_message_attachments
  UNION ALL
  SELECT attachment_id, 'contract_document', id FROM contract_documents WHERE attachment_id IS NOT NULL;

-- Os áudios gerados saem com a tabela (sem vínculo fora dela, viram órfãos).
DELETE FROM attachments a
 WHERE a.id IN (SELECT d.result_attachment_id FROM ai_attachment_derivatives d WHERE d.result_attachment_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id);
DROP TABLE ai_attachment_derivatives;
DROP FUNCTION ai_attachment_derivatives_release_result();
DROP FUNCTION ai_attachment_derivatives_guard();

-- Inferências e flags
DROP TRIGGER ai_providers_validate ON ai_providers;
DROP FUNCTION ai_providers_validate();
DROP TRIGGER ai_agents_provider_capability ON ai_agents;
DROP FUNCTION ai_agents_provider_capability();
DROP TABLE ai_agent_inferences;
DROP FUNCTION ai_agent_inferences_audit_row();
DROP FUNCTION ai_agent_inferences_validate();

ALTER TABLE ai_providers
  DROP COLUMN capabilities,
  DROP COLUMN default_models,
  DROP COLUMN prompt_cache_enabled,
  DROP COLUMN thinking_enabled;
DROP FUNCTION ai_provider_default_models_valid(text[], jsonb);
DROP FUNCTION ai_capability_list_valid(text[]);

COMMENT ON TABLE ai_providers IS
  'Provedores de LLM cadastrados pelo admin (spec 011). kind anthropic (Claude API, padrão) ou openai (OpenAI API e '
  'APIs compatíveis, com base_url). A chave é segredo: moneyflow_app grava mas não lê api_key.';
COMMENT ON COLUMN ai_providers.api_key IS
  'SEGREDO: chave da API. moneyflow_app grava mas NÃO lê esta coluna; leitura só por ai_run_provider_credentials, '
  'ai_embedding_credentials e admin_ai_provider_api_key. Nula só com base_url (servidor local sem chave). Nunca vai '
  'para o audit_log, respostas da API, logs ou tools de agente. Na edição, campo vazio mantém a atual.';
