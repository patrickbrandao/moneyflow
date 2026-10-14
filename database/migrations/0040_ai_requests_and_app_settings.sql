-- migrate:up

-- Requisições ao provedor de IA e configurações do sistema (F9, spec 023).
--
-- app_settings: configurações gravadas pela tela que vencem a variável de ambiente. Chave text (area.nome) como PK,
-- valor jsonb validado por app_setting_valid(key, value) (CHECK; chave desconhecida = inválida; cada fase acrescenta
-- as suas chaves com CREATE OR REPLACE). Começa com ai.request_retention_days (inteiro 1–365). updated_by_user_id vem
-- do app.user_id da transação, quando definido. Auditada com record_id = md5(key)::uuid (a linha não tem id).
--
-- ai_requests: uma linha por chamada ao provedor (chat, título, fluxos, embeddings, descrição, transcrição, TTS, testar
-- conexão, listar modelos). Metadados sempre; corpos e cabeçalhos só com ai_providers.log_bodies (o banco descarta o
-- que chegar com a flag desligada). Nasce running e termina ok|error|canceled; terminada, fica imutável (só as FKs
-- ON DELETE SET NULL e o contador de tentativas mudam). Fora da auditoria (volume), como o resto da IA.
-- ai_request_attempts: as tentativas do próprio MoneyFlow, (request_id, attempt), CASCADE com a requisição; o
-- contador ai_requests.attempts é mantido pelo banco.
-- ai_providers.log_bodies (padrão false, auditada pelo audit_row; GRANT SELECT explícito por causa da api_key).
-- ai_usage.request_id: FK NOT VALID (ON DELETE SET NULL). NOT VALID porque o dump do backup leva só a estrutura de
-- ai_requests (--exclude-table-data): validada, a FK derrubaria o pg_restore do uso que aponta para requisições
-- ausentes. Linhas novas são checadas normalmente; ai_usage_unlink_missing_requests() limpa as órfãs depois de um
-- restore.
-- ai_requests_purge(dias, limite) e ai_provider_health(dias, provedor).

-- Configurações do sistema --------------------------------------------------------------------------------------------
CREATE FUNCTION app_setting_valid(p_key text, p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key
           WHEN 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           ELSE false
         END
$$;

COMMENT ON FUNCTION app_setting_valid(text, jsonb) IS
  'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: '
  'ai.request_retention_days (número inteiro de 1 a 365, sem aspas nem casas decimais). As fases 028 e 029 '
  'acrescentam chaves.';

CREATE TABLE app_settings (
  key                text        PRIMARY KEY,
  value              jsonb       NOT NULL,
  updated_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_check CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(key) <= 100),
  CONSTRAINT app_settings_value_check CHECK (app_setting_valid(key, value))
);

CREATE INDEX app_settings_updated_by_user_id_idx ON app_settings (updated_by_user_id);

CREATE TRIGGER app_settings_set_updated_at BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE app_settings IS
  'Configurações do sistema gravadas pela tela (spec 023), que vencem a variável de ambiente; sem linha = vale a '
  'variável (o DELETE é o "Usar o padrão"). Só o admin grava (regra da aplicação). Auditada com record_id = '
  'md5(key)::uuid.';
COMMENT ON COLUMN app_settings.key IS 'Chave no formato area.nome (minúsculas, até 100), validada com o valor por app_setting_valid.';
COMMENT ON COLUMN app_settings.value IS 'Valor em JSON (ex.: 30 para ai.request_retention_days).';
COMMENT ON COLUMN app_settings.updated_by_user_id IS
  'Quem gravou por último: o app.user_id da transação, quando definido (senão o valor informado). Usuário excluído = nulo.';

CREATE FUNCTION app_settings_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    NEW.updated_by_user_id := uid::uuid;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER app_settings_before_write BEFORE INSERT OR UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION app_settings_before_write();

COMMENT ON FUNCTION app_settings_before_write() IS
  'updated_by_user_id = app.user_id da transação, quando definido (um app.user_id malformado fica para a auditoria recusar).';

CREATE FUNCTION app_settings_audit_row() RETURNS trigger
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
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, md5(coalesce(n ->> 'key', o ->> 'key'))::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION app_settings_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION app_settings_audit_row() IS
  'Trigger de auditoria de app_settings: grava com record_id = md5(key)::uuid (a linha não tem id; o histórico de uma '
  'chave é WHERE table_name = ''app_settings'' AND record_id = md5(chave)::uuid).';

CREATE TRIGGER app_settings_audit AFTER INSERT OR UPDATE OR DELETE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION app_settings_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON app_settings TO moneyflow_app;

-- Registro dos corpos no provedor -------------------------------------------------------------------------------------
ALTER TABLE ai_providers ADD COLUMN log_bodies boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN ai_providers.log_bodies IS
  'Registrar os corpos e cabeçalhos das requisições (spec 023): desligado por padrão; ligado, ai_requests guarda o '
  'corpo enviado completo (inclusive o base64 dos anexos), a resposta e o stream bruto, com o conteúdo das conversas '
  'e dados financeiros. Desligado, o banco descarta corpos e cabeçalhos que chegarem. Auditada.';

-- Blindagem por coluna (api_key): coluna nova precisa de GRANT SELECT explícito.
GRANT SELECT (log_bodies) ON ai_providers TO moneyflow_app;

-- Requisições ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_request_headers_redact(p_headers jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_headers IS NULL OR jsonb_typeof(p_headers) <> 'object' THEN p_headers
           ELSE coalesce((SELECT jsonb_object_agg(h.key,
                                                  CASE WHEN lower(h.key) = ANY (ARRAY['authorization', 'proxy-authorization',
                                                                                      'x-api-key', 'api-key',
                                                                                      'openai-organization', 'openai-project',
                                                                                      'cookie', 'set-cookie'])
                                                       THEN to_jsonb('[omitido]'::text)
                                                       ELSE h.value END)
                            FROM jsonb_each(p_headers) h), '{}'::jsonb)
         END
$$;

COMMENT ON FUNCTION ai_request_headers_redact(jsonb) IS
  'Rede de segurança: troca por "[omitido]" o valor dos cabeçalhos de credencial (authorization, proxy-authorization, '
  'x-api-key, api-key, openai-organization, openai-project, cookie, set-cookie; sem distinção de maiúsculas). A '
  'aplicação omite antes de gravar (inclusive os anthropic-* de credencial); o banco repete nas colunas de cabeçalho.';

CREATE TABLE ai_requests (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  provider_id        uuid        REFERENCES ai_providers (id) ON DELETE SET NULL,
  agent_id           uuid        REFERENCES ai_agents (id) ON DELETE SET NULL,
  user_id            uuid        REFERENCES users (id) ON DELETE SET NULL,
  conversation_id    uuid        REFERENCES ai_conversations (id) ON DELETE SET NULL,
  run_id             uuid        REFERENCES ai_runs (id) ON DELETE SET NULL,
  operation          text        NOT NULL,
  purpose            text,
  model              text,
  method             text        NOT NULL DEFAULT 'POST',
  path               text        NOT NULL,
  streaming          boolean     NOT NULL DEFAULT false,
  status             text        NOT NULL DEFAULT 'running',
  http_status        integer,
  error_message      text,
  started_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at        timestamptz,
  duration_ms        integer     GENERATED ALWAYS AS (floor(extract(epoch FROM finished_at - started_at) * 1000)::integer) STORED,
  first_byte_ms      integer,
  attempts           integer     NOT NULL DEFAULT 0,
  input_tokens       bigint      NOT NULL DEFAULT 0,
  output_tokens      bigint      NOT NULL DEFAULT 0,
  cache_write_tokens bigint      NOT NULL DEFAULT 0,
  cache_read_tokens  bigint      NOT NULL DEFAULT 0,
  request_bytes      bigint,
  response_bytes     bigint,
  request_headers    jsonb,
  request_body       text,
  response_headers   jsonb,
  response_body      text,
  response_stream    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_requests_operation_check CHECK (operation IN ('chat', 'title', 'embedding', 'vision_describe',
                                                              'transcription', 'speech', 'test_connection', 'list_models')),
  CONSTRAINT ai_requests_purpose_check CHECK (
    purpose IN ('chat', 'title', 'embedding', 'document_reading', 'classify_lines', 'contract_reading', 'contract_markdown')
  ),
  CONSTRAINT ai_requests_purpose_null_check CHECK ((purpose IS NULL) = (operation IN ('test_connection', 'list_models'))),
  CONSTRAINT ai_requests_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_requests_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT ai_requests_path_check CHECK (path ~ '^[^[:space:]]+$' AND length(path) <= 2000),
  CONSTRAINT ai_requests_status_check CHECK (status IN ('running', 'ok', 'error', 'canceled')),
  CONSTRAINT ai_requests_finished_check CHECK ((status = 'running') = (finished_at IS NULL) AND finished_at >= started_at),
  CONSTRAINT ai_requests_http_status_check CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT ai_requests_error_message_check CHECK (error_message IS NULL OR (length(error_message) <= 4000 AND status <> 'ok')),
  CONSTRAINT ai_requests_first_byte_check CHECK (first_byte_ms >= 0),
  CONSTRAINT ai_requests_attempts_check CHECK (attempts >= 0),
  CONSTRAINT ai_requests_tokens_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cache_write_tokens >= 0 AND cache_read_tokens >= 0
  ),
  CONSTRAINT ai_requests_bytes_check CHECK (request_bytes >= 0 AND response_bytes >= 0),
  CONSTRAINT ai_requests_headers_check CHECK (
    jsonb_typeof(request_headers) = 'object' AND jsonb_typeof(response_headers) = 'object'
  )
);

CREATE INDEX ai_requests_provider_id_idx ON ai_requests (provider_id, started_at DESC, id DESC);
CREATE INDEX ai_requests_started_at_idx ON ai_requests (started_at, id);
CREATE INDEX ai_requests_run_id_idx ON ai_requests (run_id);
CREATE INDEX ai_requests_agent_id_idx ON ai_requests (agent_id, started_at);
CREATE INDEX ai_requests_user_id_idx ON ai_requests (user_id, started_at);
CREATE INDEX ai_requests_conversation_id_idx ON ai_requests (conversation_id);

CREATE TRIGGER ai_requests_set_updated_at BEFORE UPDATE ON ai_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_requests IS
  'Requisições ao provedor de IA (spec 023): uma por chamada (inclusive testar conexão e listar modelos). Metadados '
  'sempre; cabeçalhos e corpos só com ai_providers.log_bodies. Nasce running (INSERT no início) e termina ok, error ou '
  'canceled (UPDATE no fim, fora da transação do negócio); terminada, é imutável. As FKs são ON DELETE SET NULL: a '
  'requisição sobrevive até a purga (ai_requests_purge). Fora da auditoria e do backup (no dump, só a estrutura).';
COMMENT ON COLUMN ai_requests.provider_id IS 'Provedor chamado. Nulo = testar conexão de um provedor ainda não salvo, ou provedor excluído.';
COMMENT ON COLUMN ai_requests.run_id IS
  'Execução do agente (opcional). Informada, o banco completa conversa, usuário, agente, provedor e modelo nulos a '
  'partir dela, e a conversa tem de ser a da execução (ai_requests_links_check).';
COMMENT ON COLUMN ai_requests.operation IS
  'chat, title, embedding, vision_describe, transcription, speech, test_connection ou list_models.';
COMMENT ON COLUMN ai_requests.purpose IS
  'Finalidade, com o vocabulário de ai_usage.purpose; nula só (e sempre) em test_connection e list_models. chat numa '
  'conversa de fluxo vira a finalidade da conversa, como em ai_usage.';
COMMENT ON COLUMN ai_requests.model IS 'Modelo pedido (nulo quando a chamada não tem modelo, como listar modelos).';
COMMENT ON COLUMN ai_requests.path IS 'Caminho chamado, sem o host quando é o base_url do provedor (senão a URL inteira, sem credenciais).';
COMMENT ON COLUMN ai_requests.streaming IS 'A resposta veio em streaming (SSE).';
COMMENT ON COLUMN ai_requests.status IS
  'running (em andamento) → ok, error ou canceled (finais; a linha fica imutável). Uma running abandonada sai na purga.';
COMMENT ON COLUMN ai_requests.http_status IS 'Status HTTP final (o da última tentativa). Nulo em erro de rede ou timeout.';
COMMENT ON COLUMN ai_requests.error_message IS 'Mensagem de erro segura (até 4000, nunca em ok), sem segredos.';
COMMENT ON COLUMN ai_requests.duration_ms IS 'Duração total em ms (finished_at − started_at), gerada pelo banco.';
COMMENT ON COLUMN ai_requests.first_byte_ms IS 'Tempo até o primeiro byte da resposta, em ms, a partir de started_at.';
COMMENT ON COLUMN ai_requests.attempts IS 'Número de tentativas (linhas em ai_request_attempts), mantido pelo banco; a aplicação não grava.';
COMMENT ON COLUMN ai_requests.input_tokens IS 'Tokens como em ai_usage (entrada sem cache, saída, gravação e leitura de cache).';
COMMENT ON COLUMN ai_requests.request_bytes IS 'Tamanho do corpo enviado, em bytes (gravável também sem log_bodies).';
COMMENT ON COLUMN ai_requests.response_bytes IS 'Tamanho da resposta recebida (o stream bruto, no streaming), em bytes.';
COMMENT ON COLUMN ai_requests.request_headers IS
  'Cabeçalhos enviados (objeto nome → valor), só com log_bodies; credenciais como "[omitido]" (ai_request_headers_redact).';
COMMENT ON COLUMN ai_requests.request_body IS 'Corpo enviado, completo, inclusive o base64 dos anexos. Só com log_bodies.';
COMMENT ON COLUMN ai_requests.response_headers IS 'Cabeçalhos recebidos, só com log_bodies; credenciais omitidas.';
COMMENT ON COLUMN ai_requests.response_body IS 'Resposta montada (JSON final). Só com log_bodies.';
COMMENT ON COLUMN ai_requests.response_stream IS 'Stream bruto recebido (texto SSE), no streaming. Só com log_bodies.';

CREATE FUNCTION ai_requests_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r       ai_runs;
  cp      text;
  logging boolean;
  o       jsonb;
  n       jsonb;
  k       text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.attempts := 0;
    IF NEW.run_id IS NOT NULL THEN
      SELECT * INTO r FROM ai_runs x WHERE x.id = NEW.run_id;
      IF FOUND THEN
        NEW.conversation_id := coalesce(NEW.conversation_id, r.conversation_id);
        NEW.user_id := coalesce(NEW.user_id, r.user_id);
        NEW.agent_id := coalesce(NEW.agent_id, r.agent_id);
        NEW.provider_id := coalesce(NEW.provider_id, r.provider_id);
        NEW.model := coalesce(NEW.model, r.model);
        IF NEW.conversation_id <> r.conversation_id THEN
          RAISE EXCEPTION 'ai_requests: run % belongs to another conversation', NEW.run_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_links_check';
        END IF;
      END IF;
    END IF;
    IF NEW.purpose = 'chat' AND NEW.conversation_id IS NOT NULL THEN
      SELECT c.purpose INTO cp FROM ai_conversations c WHERE c.id = NEW.conversation_id;
      NEW.purpose := coalesce(cp, NEW.purpose);
    END IF;
  END IF;

  -- Cabeçalhos e corpos só com log_bodies (o que chega com a flag desligada é descartado).
  SELECT p.log_bodies INTO logging FROM ai_providers p WHERE p.id = NEW.provider_id;
  IF NOT coalesce(logging, false) THEN
    IF TG_OP = 'INSERT' OR NEW.request_headers IS DISTINCT FROM OLD.request_headers THEN NEW.request_headers := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.request_body IS DISTINCT FROM OLD.request_body THEN NEW.request_body := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.response_headers IS DISTINCT FROM OLD.response_headers THEN NEW.response_headers := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.response_body IS DISTINCT FROM OLD.response_body THEN NEW.response_body := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.response_stream IS DISTINCT FROM OLD.response_stream THEN NEW.response_stream := NULL; END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.request_headers IS DISTINCT FROM OLD.request_headers THEN
    NEW.request_headers := ai_request_headers_redact(NEW.request_headers);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.response_headers IS DISTINCT FROM OLD.response_headers THEN
    NEW.response_headers := ai_request_headers_redact(NEW.response_headers);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD) - 'duration_ms';
    n := to_jsonb(NEW) - 'duration_ms';
    -- As FKs só mudam para nulo (ON DELETE SET NULL).
    FOREACH k IN ARRAY ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id'] LOOP
      IF n -> k IS DISTINCT FROM o -> k AND n ->> k IS NOT NULL THEN
        RAISE EXCEPTION 'ai_requests: % of request % changes only to null', k, OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_immutable_check';
      END IF;
    END LOOP;
    o := o - ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id', 'attempts', 'updated_at'];
    n := n - ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id', 'attempts', 'updated_at'];
    IF OLD.status = 'running' THEN
      -- Em andamento: o que identifica a chamada não muda.
      o := jsonb_build_object('id', o -> 'id', 'operation', o -> 'operation', 'purpose', o -> 'purpose',
                              'model', o -> 'model', 'method', o -> 'method', 'path', o -> 'path',
                              'streaming', o -> 'streaming', 'started_at', o -> 'started_at', 'created_at', o -> 'created_at');
      n := jsonb_build_object('id', n -> 'id', 'operation', n -> 'operation', 'purpose', n -> 'purpose',
                              'model', n -> 'model', 'method', n -> 'method', 'path', n -> 'path',
                              'streaming', n -> 'streaming', 'started_at', n -> 'started_at', 'created_at', n -> 'created_at');
    END IF;
    IF o IS DISTINCT FROM n THEN
      RAISE EXCEPTION 'ai_requests: request % is immutable (%)', OLD.id,
        CASE WHEN OLD.status = 'running' THEN 'identity' ELSE 'finished' END
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_immutable_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_requests_before_write BEFORE INSERT OR UPDATE ON ai_requests
  FOR EACH ROW EXECUTE FUNCTION ai_requests_before_write();

COMMENT ON FUNCTION ai_requests_before_write() IS
  'INSERT: tentativas = 0, completa os vínculos pela execução (ai_requests_links_check) e chat numa conversa de fluxo '
  'vira a finalidade dela. INSERT/UPDATE: descarta cabeçalhos e corpos gravados com log_bodies desligado (ou sem '
  'provedor) e omite as credenciais dos cabeçalhos. UPDATE (23514 ai_requests_immutable_check): FKs só viram nulas; '
  'em running, id, operação, finalidade, modelo, método, caminho, streaming e início não mudam; terminada, nada muda '
  'além das FKs anuladas e do contador de tentativas.';

-- Tentativas -----------------------------------------------------------------------------------------------------------
CREATE TABLE ai_request_attempts (
  request_id         uuid        NOT NULL REFERENCES ai_requests (id) ON DELETE CASCADE,
  attempt            integer     NOT NULL,
  started_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  duration_ms        integer,
  http_status        integer,
  error_type         text,
  error_message      text,
  retry_after_ms     integer,
  rate_limit_headers jsonb,
  response_body      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, attempt),
  CONSTRAINT ai_request_attempts_attempt_check CHECK (attempt BETWEEN 1 AND 100),
  CONSTRAINT ai_request_attempts_duration_check CHECK (duration_ms >= 0),
  CONSTRAINT ai_request_attempts_http_status_check CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT ai_request_attempts_error_type_check CHECK (error_type ~ '^[a-z][a-z0-9_]{0,59}$'),
  CONSTRAINT ai_request_attempts_error_message_check CHECK (length(error_message) <= 4000),
  CONSTRAINT ai_request_attempts_retry_after_check CHECK (retry_after_ms >= 0),
  CONSTRAINT ai_request_attempts_headers_check CHECK (jsonb_typeof(rate_limit_headers) = 'object')
);

CREATE TRIGGER ai_request_attempts_set_updated_at BEFORE UPDATE ON ai_request_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_request_attempts IS
  'Tentativas de uma requisição feitas pelo MoneyFlow (spec 023; o retry dos SDKs fica desligado). Somem com a '
  'requisição (CASCADE). Inserir uma tentativa atualiza ai_requests.attempts.';
COMMENT ON COLUMN ai_request_attempts.attempt IS 'Número da tentativa (1, 2, 3…).';
COMMENT ON COLUMN ai_request_attempts.error_type IS
  'Tipo do erro em snake_case, definido pela aplicação (ex.: http, rate_limit, overloaded, network, timeout, canceled). Nulo = deu certo.';
COMMENT ON COLUMN ai_request_attempts.retry_after_ms IS 'retry-after informado pelo provedor, em ms (nulo se não veio).';
COMMENT ON COLUMN ai_request_attempts.rate_limit_headers IS
  'Cabeçalhos de rate limit da resposta (objeto nome → valor), sempre, com ou sem log_bodies.';
COMMENT ON COLUMN ai_request_attempts.response_body IS 'Corpo da resposta de erro. Só com log_bodies do provedor da requisição.';

CREATE FUNCTION ai_request_attempts_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  logging boolean;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.response_body IS DISTINCT FROM OLD.response_body THEN
    SELECT p.log_bodies INTO logging
      FROM ai_requests r JOIN ai_providers p ON p.id = r.provider_id
     WHERE r.id = NEW.request_id;
    IF NOT coalesce(logging, false) THEN
      NEW.response_body := NULL;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.rate_limit_headers IS DISTINCT FROM OLD.rate_limit_headers THEN
    NEW.rate_limit_headers := ai_request_headers_redact(NEW.rate_limit_headers);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_request_attempts_before_write BEFORE INSERT OR UPDATE ON ai_request_attempts
  FOR EACH ROW EXECUTE FUNCTION ai_request_attempts_before_write();

COMMENT ON FUNCTION ai_request_attempts_before_write() IS
  'Descarta o corpo da resposta de erro sem log_bodies e omite credenciais nos cabeçalhos guardados.';

CREATE FUNCTION ai_request_attempts_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_requests r
     SET attempts = (SELECT count(*) FROM ai_request_attempts a WHERE a.request_id = NEW.request_id)
   WHERE r.id = NEW.request_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER ai_request_attempts_after_insert AFTER INSERT ON ai_request_attempts
  FOR EACH ROW EXECUTE FUNCTION ai_request_attempts_after_insert();

COMMENT ON FUNCTION ai_request_attempts_after_insert() IS 'Mantém ai_requests.attempts = número de tentativas gravadas.';

-- Requisições e tentativas não são apagadas pela aplicação: só a purga (SECURITY DEFINER) e a cascata.
REVOKE DELETE ON ai_requests, ai_request_attempts FROM moneyflow_app;
GRANT SELECT, INSERT, UPDATE ON ai_requests, ai_request_attempts TO moneyflow_app;

-- Uso → requisição ----------------------------------------------------------------------------------------------------
ALTER TABLE ai_usage ADD COLUMN request_id uuid;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES ai_requests (id) ON DELETE SET NULL NOT VALID;
CREATE INDEX ai_usage_request_id_idx ON ai_usage (request_id);

COMMENT ON COLUMN ai_usage.request_id IS
  'Requisição que gerou o uso (spec 023). Purgada a requisição, vira nula; o uso fica. A FK é NOT VALID (as linhas '
  'novas são checadas): o dump do backup leva só a estrutura de ai_requests e, validada, a FK derrubaria o '
  'pg_restore. Depois de um restore, ai_usage_unlink_missing_requests() anula os vínculos órfãos.';

CREATE FUNCTION ai_usage_request_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q ai_requests;
BEGIN
  IF NEW.request_id IS NOT NULL THEN
    SELECT * INTO q FROM ai_requests x WHERE x.id = NEW.request_id;
    IF FOUND AND (q.provider_id <> NEW.provider_id OR q.run_id <> NEW.run_id) THEN
      RAISE EXCEPTION 'ai_usage: request % is for another provider or run', NEW.request_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_links_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Depois de ai_usage_before_insert (ordem alfabética), que completa provedor e execução.
CREATE TRIGGER ai_usage_request_check BEFORE INSERT ON ai_usage
  FOR EACH ROW EXECUTE FUNCTION ai_usage_request_check();

COMMENT ON FUNCTION ai_usage_request_check() IS
  'O uso aponta para uma requisição do mesmo provedor e da mesma execução (quando as duas têm), senão 23514 ai_usage_links_check.';

CREATE FUNCTION ai_usage_unlink_missing_requests() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.ai_usage u SET request_id = NULL
   WHERE u.request_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ai_requests r WHERE r.id = u.request_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_usage_unlink_missing_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_usage_unlink_missing_requests() TO moneyflow_app;

COMMENT ON FUNCTION ai_usage_unlink_missing_requests() IS
  'Depois de restaurar um dump (que traz ai_usage mas não os dados de ai_requests): anula ai_usage.request_id que '
  'aponta para requisição inexistente e devolve quantos. Idempotente.';

-- Purga e saúde -------------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_requests_purge(p_days integer, p_limit integer DEFAULT 1000) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'ai_requests_purge: days must be >= 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'ai_requests_purge: limit must be between 1 and 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH doomed AS (
    SELECT r.id FROM public.ai_requests r
     WHERE r.started_at < clock_timestamp() - make_interval(days => p_days)
     ORDER BY r.started_at, r.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.ai_requests r USING doomed d WHERE r.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_requests_purge(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_requests_purge(integer, integer) TO moneyflow_app;

COMMENT ON FUNCTION ai_requests_purge(integer, integer) IS
  'Retenção (spec 023): apaga até p_limit (padrão 1000, máx. 100000) requisições iniciadas há mais de p_days dias, as '
  'mais velhas primeiro (com as tentativas, em CASCADE; o ai_usage fica com request_id nulo), e devolve quantas. O '
  'worker chama em lotes até devolver menos que o limite; p_days = app_settings ai.request_retention_days ou, sem ele, '
  'AI_REQUEST_RETENTION_DAYS. Erro 22023 com dias < 1 ou limite fora da faixa. Pula linhas travadas.';

CREATE FUNCTION ai_provider_health(p_days integer DEFAULT 7, p_provider_id uuid DEFAULT NULL)
RETURNS TABLE (
  provider_id       uuid,
  model             text,
  requests          integer,
  ok                integer,
  errors            integer,
  canceled          integer,
  error_rate        numeric,
  p50_ms            integer,
  p95_ms            integer,
  p50_first_byte_ms integer,
  p95_first_byte_ms integer,
  avg_attempts      numeric,
  last_error_at     timestamptz
)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'ai_provider_health: days must be between 1 and 365' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT r.provider_id,
         r.model,
         count(*)::integer,
         count(*) FILTER (WHERE r.status = 'ok')::integer,
         count(*) FILTER (WHERE r.status = 'error')::integer,
         count(*) FILTER (WHERE r.status = 'canceled')::integer,
         round(count(*) FILTER (WHERE r.status = 'error')::numeric
               / nullif(count(*) FILTER (WHERE r.status IN ('ok', 'error')), 0), 4),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.first_byte_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.first_byte_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(avg(r.attempts), 2),
         max(r.finished_at) FILTER (WHERE r.status = 'error')
    FROM ai_requests r
   WHERE r.status <> 'running'
     AND r.started_at >= now() - make_interval(days => p_days)
     AND (p_provider_id IS NULL OR r.provider_id = p_provider_id)
   GROUP BY r.provider_id, r.model
   ORDER BY r.provider_id NULLS LAST, r.model NULLS LAST;
END
$$;

COMMENT ON FUNCTION ai_provider_health(integer, uuid) IS
  'Saúde por provedor e modelo nos últimos p_days dias (1–365, padrão 7; senão 22023), só requisições terminadas, de '
  'um provedor (p_provider_id) ou de todos: requests, ok, errors, canceled; error_rate = erros ÷ (ok + erros), sem '
  'as canceladas (nula sem nenhuma); p50/p95 da duração e do primeiro byte das que deram certo (ms); média de '
  'tentativas; último erro. provider_id nulo = provedor não salvo ou excluído; model nulo = sem modelo (listar modelos).';

-- migrate:down

DROP FUNCTION ai_provider_health(integer, uuid);
DROP FUNCTION ai_requests_purge(integer, integer);
DROP FUNCTION ai_usage_unlink_missing_requests();
DROP TRIGGER ai_usage_request_check ON ai_usage;
DROP FUNCTION ai_usage_request_check();
ALTER TABLE ai_usage DROP COLUMN request_id;

DROP TABLE ai_request_attempts;
DROP FUNCTION ai_request_attempts_after_insert();
DROP FUNCTION ai_request_attempts_before_write();
DROP TABLE ai_requests;
DROP FUNCTION ai_requests_before_write();
DROP FUNCTION ai_request_headers_redact(jsonb);

ALTER TABLE ai_providers DROP COLUMN log_bodies;

DROP TABLE app_settings;
DROP FUNCTION app_settings_audit_row();
DROP FUNCTION app_settings_before_write();
DROP FUNCTION app_setting_valid(text, jsonb);
