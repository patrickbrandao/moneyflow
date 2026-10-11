-- migrate:up

-- Mensagens (spec 013): destinos por canal (Telegram por ora), assinaturas de eventos
-- por destino e a fila de saída (outbox) consumida pelo worker, com retry e histórico.
--
-- O bot token é segredo, blindado como a senha (spec 002 / 016): moneyflow_app pode
-- gravar (INSERT/UPDATE) mas não ler a coluna bot_token; o worker lê o token só de uma
-- mensagem que ele reservou (status sending), pela função SECURITY DEFINER
-- message_destination_token(message_id). O token nunca vai para o audit_log.

-- Destinos ------------------------------------------------------------------------------------------
CREATE TABLE message_destinations (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  channel            text        NOT NULL DEFAULT 'telegram',
  name               text        NOT NULL,
  owner_user_id      uuid        REFERENCES users (id) ON DELETE CASCADE,
  owner_caixa_id     uuid        REFERENCES caixas (id) ON DELETE CASCADE,
  bot_token          text,
  bot_id             text        GENERATED ALWAYS AS (split_part(bot_token, ':', 1)) STORED,
  chat_id            text,
  is_active          boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  notes              text,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_destinations_channel_check CHECK (channel IN ('telegram')),
  CONSTRAINT message_destinations_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT message_destinations_owner_check CHECK (num_nonnulls(owner_user_id, owner_caixa_id) <= 1),
  CONSTRAINT message_destinations_telegram_check CHECK (
    channel <> 'telegram' OR (bot_token IS NOT NULL AND chat_id IS NOT NULL)
  ),
  CONSTRAINT message_destinations_bot_token_check CHECK (bot_token ~ '^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$'),
  CONSTRAINT message_destinations_chat_id_check CHECK (
    chat_id ~ '^-?[0-9]{1,20}$' OR chat_id ~ '^@[A-Za-z][A-Za-z0-9_]{3,31}$'
  ),
  CONSTRAINT message_destinations_active_check CHECK (NOT (is_active AND archived_at IS NOT NULL))
);

CREATE INDEX message_destinations_owner_user_id_idx ON message_destinations (owner_user_id);
CREATE INDEX message_destinations_owner_caixa_id_idx ON message_destinations (owner_caixa_id);
CREATE INDEX message_destinations_created_by_user_id_idx ON message_destinations (created_by_user_id);
CREATE UNIQUE INDEX message_destinations_name_key
  ON message_destinations (owner_user_id, owner_caixa_id, lower(name)) NULLS NOT DISTINCT;

CREATE TRIGGER message_destinations_set_updated_at BEFORE UPDATE ON message_destinations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE message_destinations IS
  'Cadastro central de destinos de mensagens (spec 013). Dono: um usuário (pessoal), uma caixa (ex.: grupo da casa) '
  'ou nenhum (global, gerido pelo admin). O canal é abstrato; por ora só telegram (bot_token + chat_id).';
COMMENT ON COLUMN message_destinations.channel IS 'Canal: telegram (email/whatsapp no futuro, com as próprias colunas).';
COMMENT ON COLUMN message_destinations.owner_user_id IS 'Destino pessoal deste usuário. Nulo junto com owner_caixa_id = global (admin).';
COMMENT ON COLUMN message_destinations.owner_caixa_id IS 'Destino da caixa (ex.: grupo da casa).';
COMMENT ON COLUMN message_destinations.bot_token IS
  'SEGREDO: token do bot do Telegram (<id>:<chave>). moneyflow_app grava mas NÃO lê esta coluna; o worker lê pela '
  'função message_destination_token(message_id). Nunca vai para o audit_log, respostas da API, logs ou tools de agente.';
COMMENT ON COLUMN message_destinations.bot_id IS 'Parte pública do token (id numérico do bot), gerada pelo banco: identifica o bot na tela sem expor o segredo.';
COMMENT ON COLUMN message_destinations.chat_id IS 'chat_id do Telegram (pessoa ou grupo, numérico, grupos negativos) ou @canal.';
COMMENT ON COLUMN message_destinations.is_active IS 'false = não recebe mensagens novas; as pendentes são canceladas na hora.';

-- Blindagem do token: SELECT por coluna, sem bot_token. Coluna nova nesta tabela precisa de GRANT SELECT explícito.
REVOKE SELECT ON message_destinations FROM moneyflow_app;
GRANT SELECT (id, channel, name, owner_user_id, owner_caixa_id, bot_id, chat_id, is_active, created_by_user_id,
              notes, archived_at, created_at, updated_at)
  ON message_destinations TO moneyflow_app;

-- Assinaturas de eventos ---------------------------------------------------------------------------------
-- Parâmetros por evento (horários HH:MM em America/Sao_Paulo):
--   due_reminder               {"days_before": [3, 1, 0], "send_at": "08:00"}  (D-N, 0 = no dia; 1–10 valores de 0 a 60)
--   overdue                    {"send_at": "08:00", "repeat_every_days": 1}     (repeat opcional, 1–30)
--   daily_summary              {"send_at": "07:30"}
--   weekly_summary             {"send_at": "07:30", "weekday": 1}               (ISO: 1 = segunda … 7 = domingo)
--   invoice_closed             {}
--   card_limit                 {"thresholds_percent": [80, 100]}                (1–10 valores de 1 a 200)
--   reconciliation_divergence  {"min_difference_cents": 0}                      (opcional, ≥ 0)
--   agent_completed            {}
--   agent_message              {}
CREATE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN false;
  END IF;

  CASE p_event_kind
    WHEN 'due_reminder' THEN allowed := '{days_before,send_at}'; required := '{days_before,send_at}';
    WHEN 'overdue' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'daily_summary' THEN allowed := '{send_at}'; required := '{send_at}';
    WHEN 'weekly_summary' THEN allowed := '{send_at,weekday}'; required := '{send_at,weekday}';
    WHEN 'card_limit' THEN allowed := '{thresholds_percent}'; required := '{thresholds_percent}';
    WHEN 'reconciliation_divergence' THEN allowed := '{min_difference_cents}'; required := '{}';
    WHEN 'invoice_closed', 'agent_completed', 'agent_message' THEN allowed := '{}'; required := '{}';
    ELSE RETURN false;
  END CASE;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k <> ALL (allowed))
     OR NOT (p_params ?& required) THEN
    RETURN false;
  END IF;

  IF p_params ? 'send_at' AND (jsonb_typeof(p_params -> 'send_at') <> 'string' OR p_params ->> 'send_at' !~ hhmm) THEN
    RETURN false;
  END IF;
  IF p_params ? 'weekday' AND (jsonb_typeof(p_params -> 'weekday') <> 'number'
                               OR (p_params ->> 'weekday') !~ '^[1-7]$') THEN
    RETURN false;
  END IF;
  IF p_params ? 'repeat_every_days' AND (jsonb_typeof(p_params -> 'repeat_every_days') <> 'number'
                                         OR (p_params ->> 'repeat_every_days') !~ '^[0-9]{1,2}$'
                                         OR (p_params ->> 'repeat_every_days')::int NOT BETWEEN 1 AND 30) THEN
    RETURN false;
  END IF;
  IF p_params ? 'min_difference_cents' AND (jsonb_typeof(p_params -> 'min_difference_cents') <> 'number'
                                            OR (p_params ->> 'min_difference_cents') !~ '^[0-9]{1,15}$') THEN
    RETURN false;
  END IF;

  -- Listas de inteiros: 1–10 valores distintos dentro da faixa.
  FOREACH arr IN ARRAY ARRAY[p_params -> 'days_before', p_params -> 'thresholds_percent'] LOOP
    CONTINUE WHEN arr IS NULL;
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(arr) e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[0-9]{1,3}$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(arr) e) <> jsonb_array_length(arr) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_params ? 'days_before'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > 60) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60, thresholds_percent 1–200). Usada no CHECK de message_subscriptions.';

CREATE TABLE message_subscriptions (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  destination_id uuid        NOT NULL REFERENCES message_destinations (id) ON DELETE CASCADE,
  event_kind     text        NOT NULL,
  params         jsonb       NOT NULL DEFAULT '{}',
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message')),
  CONSTRAINT message_subscriptions_params_check CHECK (message_subscription_params_valid(event_kind, params)),
  CONSTRAINT message_subscriptions_destination_event_key UNIQUE (destination_id, event_kind)
);

CREATE INDEX message_subscriptions_event_kind_idx ON message_subscriptions (event_kind) WHERE is_active;

CREATE TRIGGER message_subscriptions_set_updated_at BEFORE UPDATE ON message_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE message_subscriptions IS
  'Eventos que um destino recebe (spec 013), um por tipo de evento, com parâmetros validados por '
  'message_subscription_params_valid. Filtro opcional por caixas em message_subscription_caixas (sem linhas = todas '
  'as caixas que o dono do destino vê).';
COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message.';
COMMENT ON COLUMN message_subscriptions.params IS 'Parâmetros do evento (ver message_subscription_params_valid).';

CREATE TABLE message_subscription_caixas (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  subscription_id uuid        NOT NULL REFERENCES message_subscriptions (id) ON DELETE CASCADE,
  caixa_id        uuid        NOT NULL REFERENCES caixas (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_subscription_caixas_key UNIQUE (subscription_id, caixa_id)
);

CREATE INDEX message_subscription_caixas_caixa_id_idx ON message_subscription_caixas (caixa_id);

CREATE TRIGGER message_subscription_caixas_set_updated_at BEFORE UPDATE ON message_subscription_caixas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE message_subscription_caixas IS 'Filtro opcional de caixas de uma assinatura (nenhuma linha = sem filtro).';

-- Fila de saída (outbox) ------------------------------------------------------------------------------------
CREATE TABLE message_outbox (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  destination_id      uuid        NOT NULL REFERENCES message_destinations (id),
  subscription_id     uuid        REFERENCES message_subscriptions (id) ON DELETE SET NULL,
  event_kind          text        NOT NULL,
  dedup_key           text,
  caixa_id            uuid        REFERENCES caixas (id) ON DELETE SET NULL,
  user_id             uuid        REFERENCES users (id) ON DELETE SET NULL,
  agent_run_id        text,
  payload             jsonb       NOT NULL,
  status              text        NOT NULL DEFAULT 'pending',
  attempts            smallint    NOT NULL DEFAULT 0,
  max_attempts        smallint    NOT NULL DEFAULT 5,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  sent_at             timestamptz,
  last_error          text,
  provider_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message', 'test')),
  CONSTRAINT message_outbox_dedup_key_check CHECK (btrim(dedup_key) <> '' AND length(dedup_key) <= 300),
  CONSTRAINT message_outbox_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT message_outbox_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'canceled')),
  CONSTRAINT message_outbox_attempts_check CHECK (
    max_attempts BETWEEN 1 AND 20 AND attempts BETWEEN 0 AND max_attempts
  ),
  CONSTRAINT message_outbox_status_fields_check CHECK (
    (status = 'sending') = (locked_at IS NOT NULL)
    AND (status = 'sent') = (sent_at IS NOT NULL)
    AND (status NOT IN ('failed', 'canceled') OR last_error IS NOT NULL)
  )
);

CREATE INDEX message_outbox_ready_idx ON message_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX message_outbox_sending_idx ON message_outbox (locked_at) WHERE status = 'sending';
CREATE INDEX message_outbox_destination_id_idx ON message_outbox (destination_id, created_at);
CREATE INDEX message_outbox_subscription_id_idx ON message_outbox (subscription_id);
CREATE INDEX message_outbox_caixa_id_idx ON message_outbox (caixa_id);
CREATE INDEX message_outbox_user_id_idx ON message_outbox (user_id);
CREATE UNIQUE INDEX message_outbox_dedup_key ON message_outbox (destination_id, dedup_key);

CREATE TRIGGER message_outbox_set_updated_at BEFORE UPDATE ON message_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE message_outbox IS
  'Fila de saída e histórico de mensagens (spec 013). O worker reserva com message_outbox_claim (FOR UPDATE SKIP '
  'LOCKED), envia fora da transação e fecha com message_outbox_mark_sent / message_outbox_mark_failed. '
  'Fora da auditoria (é fila operacional; o histórico é a própria tabela).';
COMMENT ON COLUMN message_outbox.event_kind IS 'Evento que gerou a mensagem (os de message_subscriptions, mais test).';
COMMENT ON COLUMN message_outbox.dedup_key IS
  'Chave do evento, única por destino (ex.: due_reminder:<title_id>:D-3:2026-10-12): enfileirar com '
  'ON CONFLICT (destination_id, dedup_key) DO NOTHING para nunca mandar o mesmo lembrete duas vezes. Nulo = sem dedup.';
COMMENT ON COLUMN message_outbox.payload IS
  'Mensagem já montada (ex.: {"text": "...", "parse_mode": "HTML"}). Nunca contém o bot token nem senhas. Imutável.';
COMMENT ON COLUMN message_outbox.status IS
  'pending (aguarda next_attempt_at) → sending (reservada por um worker, locked_at) → sent | pending (retry) | failed '
  '(esgotou ou erro permanente). canceled: destino desativado ou cancelada pela aplicação. failed → pending = reenviar.';
COMMENT ON COLUMN message_outbox.attempts IS 'Tentativas já iniciadas (o claim soma 1).';
COMMENT ON COLUMN message_outbox.locked_at IS 'Quando o worker reservou (só em sending). Reserva velha é retomada pelo claim.';
COMMENT ON COLUMN message_outbox.provider_message_id IS 'Id da mensagem no provedor (Telegram message_id), após o envio.';

-- Regras do ciclo de vida: destino ativo ao enfileirar, conteúdo imutável, transições válidas.
CREATE FUNCTION message_outbox_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'message_outbox: new messages must be pending'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_transition_check';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM message_destinations d
                    WHERE d.id = NEW.destination_id AND d.is_active AND d.archived_at IS NULL) THEN
      RAISE EXCEPTION 'message_outbox: destination % is not active', NEW.destination_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_destination_active_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.destination_id <> OLD.destination_id OR NEW.event_kind <> OLD.event_kind
     OR NEW.dedup_key IS DISTINCT FROM OLD.dedup_key OR NEW.payload <> OLD.payload THEN
    RAISE EXCEPTION 'message_outbox: destination, event, dedup key and payload of message % are immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_immutable_check';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('sending', 'canceled'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'pending', 'failed', 'canceled'))
    OR (OLD.status = 'failed' AND NEW.status IN ('pending', 'canceled'))
  ) THEN
    RAISE EXCEPTION 'message_outbox: invalid transition % -> % (message %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_transition_check';
  END IF;
  IF OLD.status IN ('sent', 'canceled') AND (to_jsonb(NEW) - 'updated_at') <> (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'message_outbox: message % is % and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_transition_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER message_outbox_validate BEFORE INSERT OR UPDATE ON message_outbox
  FOR EACH ROW EXECUTE FUNCTION message_outbox_validate();

-- Destino desativado/arquivado: as mensagens pendentes são canceladas na hora.
CREATE FUNCTION message_destinations_cancel_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE message_outbox o
     SET status = 'canceled', last_error = 'destination_inactive'
   WHERE o.destination_id = NEW.id AND o.status IN ('pending', 'failed');
  RETURN NULL;
END
$$;

CREATE TRIGGER message_destinations_cancel_pending
  AFTER UPDATE OF is_active, archived_at ON message_destinations
  FOR EACH ROW WHEN (NOT NEW.is_active OR NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION message_destinations_cancel_pending();

-- Reserva (claim) com SKIP LOCKED ------------------------------------------------------------------------
CREATE FUNCTION message_outbox_claim(p_limit int DEFAULT 10, p_stale_after interval DEFAULT interval '5 minutes')
RETURNS SETOF message_outbox
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_stale_after IS NULL OR p_stale_after < interval '10 seconds' THEN
    RAISE EXCEPTION 'message_outbox_claim: limit must be 1..1000 and stale_after >= 10 seconds'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Reserva abandonada (worker caiu) que já esgotou as tentativas: falha definitiva.
  UPDATE message_outbox o
     SET status = 'failed', locked_at = NULL,
         last_error = coalesce(o.last_error || ' | ', '') || 'stale_lock: worker did not finish the attempt'
   WHERE o.id IN (SELECT x.id FROM message_outbox x
                   WHERE x.status = 'sending' AND x.locked_at < clock_timestamp() - p_stale_after
                     AND x.attempts >= x.max_attempts
                   FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  UPDATE message_outbox o
     SET status = 'sending', locked_at = clock_timestamp(), attempts = o.attempts + 1
   WHERE o.id IN (SELECT x.id FROM message_outbox x
                   WHERE (x.status = 'pending' AND x.next_attempt_at <= clock_timestamp())
                      OR (x.status = 'sending' AND x.locked_at < clock_timestamp() - p_stale_after
                          AND x.attempts < x.max_attempts)
                   ORDER BY x.next_attempt_at, x.id
                   LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
END
$$;

COMMENT ON FUNCTION message_outbox_claim(int, interval) IS
  'Reserva até p_limit mensagens prontas (pending com next_attempt_at <= agora, ou sending com reserva mais velha que '
  'p_stale_after) com FOR UPDATE SKIP LOCKED: status = sending, locked_at = agora, attempts + 1; devolve as linhas. '
  'Reserva velha sem tentativas restantes vira failed. Rode numa transação curta e faça COMMIT antes de enviar. '
  'Erro 22023: parâmetros inválidos.';

CREATE FUNCTION message_outbox_mark_sent(p_message_id uuid, p_provider_message_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  UPDATE message_outbox o
     SET status = 'sent', sent_at = clock_timestamp(), locked_at = NULL, provider_message_id = p_provider_message_id
   WHERE o.id = p_message_id AND o.status = 'sending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_outbox: message % is not being sent', p_message_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_transition_check';
  END IF;
END
$$;

COMMENT ON FUNCTION message_outbox_mark_sent(uuid, text) IS
  'Fecha uma mensagem reservada como enviada (sent_at, id no provedor). Erro 23514 (message_outbox_transition_check) '
  'se ela não está em sending.';

CREATE FUNCTION message_outbox_mark_failed(
  p_message_id  uuid,
  p_error       text,
  p_retry_after interval DEFAULT NULL,
  p_permanent   boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  m message_outbox;
  new_status text;
BEGIN
  SELECT * INTO m FROM message_outbox WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'sending' THEN
    RAISE EXCEPTION 'message_outbox: message % is not being sent', p_message_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_outbox_transition_check';
  END IF;

  new_status := CASE WHEN p_permanent OR m.attempts >= m.max_attempts THEN 'failed' ELSE 'pending' END;
  UPDATE message_outbox o
     SET status = new_status,
         locked_at = NULL,
         last_error = left(coalesce(nullif(btrim(p_error), ''), 'unknown error'), 2000),
         next_attempt_at = CASE WHEN new_status = 'pending'
                                THEN clock_timestamp() + coalesce(p_retry_after,
                                       least(interval '1 hour', interval '30 seconds' * power(2, m.attempts - 1)))
                                ELSE o.next_attempt_at END
   WHERE o.id = p_message_id;
  RETURN new_status;
END
$$;

COMMENT ON FUNCTION message_outbox_mark_failed(uuid, text, interval, boolean) IS
  'Registra a falha de uma tentativa de uma mensagem em sending. Volta a pending com next_attempt_at = agora + '
  'p_retry_after (ex.: retry_after do Telegram 429) ou backoff 30 s × 2^(tentativa−1), máximo 1 h; vira failed se '
  'p_permanent (ex.: chat não existe, token inválido) ou se esgotou max_attempts. Devolve o novo status. '
  'Erro 23514 (message_outbox_transition_check) se ela não está em sending.';

-- Leitura do token (worker) ---------------------------------------------------------------------------------
CREATE FUNCTION message_destination_token(p_message_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st  text;
  tok text;
BEGIN
  SELECT o.status, d.bot_token INTO st, tok
    FROM public.message_outbox o
    JOIN public.message_destinations d ON d.id = o.destination_id
   WHERE o.id = p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_destination_token: message % not found', p_message_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF st <> 'sending' THEN
    RAISE EXCEPTION 'message_destination_token: message % is not being sent (status %)', p_message_id, st
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN tok;
END
$$;

REVOKE EXECUTE ON FUNCTION message_destination_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_destination_token(uuid) TO moneyflow_app;

COMMENT ON FUNCTION message_destination_token(uuid) IS
  'Devolve o bot token do destino de uma mensagem RESERVADA pelo worker (status sending); erro 42501 em qualquer '
  'outro status e P0002 se a mensagem não existe. Única forma de a aplicação ler message_destinations.bot_token.';

-- Auditoria: destinos e assinaturas são auditados, sem o token -------------------------------------------------
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  secrets constant text[] := ARRAY['password', 'bot_token'];
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
    IF changed IS NULL OR changed <@ quiet THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o - secrets, n - secrets, changed);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION audit_row() IS
  'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token): a troca aparece só em '
  'changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha.';

CREATE TRIGGER message_destinations_audit AFTER INSERT OR UPDATE OR DELETE ON message_destinations
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER message_subscriptions_audit AFTER INSERT OR UPDATE OR DELETE ON message_subscriptions
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER message_subscription_caixas_audit AFTER INSERT OR UPDATE OR DELETE ON message_subscription_caixas
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- migrate:down

DROP TRIGGER message_subscription_caixas_audit ON message_subscription_caixas;
DROP TRIGGER message_subscriptions_audit ON message_subscriptions;
DROP TRIGGER message_destinations_audit ON message_destinations;

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
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
    IF changed IS NULL OR changed <@ quiet THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o - 'password', n - 'password', changed);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION audit_row() IS
  'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove a coluna password; TG_ARGV[0] = colunas que sozinhas não geram linha.';

DROP FUNCTION message_destination_token(uuid);
DROP FUNCTION message_outbox_mark_failed(uuid, text, interval, boolean);
DROP FUNCTION message_outbox_mark_sent(uuid, text);
DROP FUNCTION message_outbox_claim(int, interval);
DROP TRIGGER message_destinations_cancel_pending ON message_destinations;
DROP FUNCTION message_destinations_cancel_pending();
DROP TABLE message_outbox;
DROP FUNCTION message_outbox_validate();
DROP TABLE message_subscription_caixas;
DROP TABLE message_subscriptions;
DROP FUNCTION message_subscription_params_valid(text, jsonb);
DROP TABLE message_destinations;
