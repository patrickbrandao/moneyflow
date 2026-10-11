-- migrate:up

-- Agentes de IA (spec 011), parte 4: uso de tokens e custo estimado, por chamada ao modelo, com agregados por
-- mensagem, execução, usuário, agente e mês. Só medição, sem teto. Fora da auditoria (volume).
--
-- Custo em "micros": milionésimos da moeda do preço (ex.: micro-dólares). Como o preço é por milhão de tokens,
-- cost_micros = Σ tokens × preço_por_milhão (arredondado). A moeda vem da tabela de preços (USD padrão; BRL
-- se o admin cadastrar assim); os agregados separam por moeda.

CREATE TABLE ai_usage (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  run_id             uuid        REFERENCES ai_runs (id) ON DELETE SET NULL,
  message_id         uuid        REFERENCES ai_messages (id) ON DELETE SET NULL,
  conversation_id    uuid        REFERENCES ai_conversations (id) ON DELETE SET NULL,
  user_id            uuid        REFERENCES users (id) ON DELETE SET NULL,
  agent_id           uuid        REFERENCES ai_agents (id),
  provider_id        uuid        NOT NULL REFERENCES ai_providers (id),
  model              text        NOT NULL,
  purpose            text        NOT NULL DEFAULT 'chat',
  input_tokens       bigint      NOT NULL DEFAULT 0,
  output_tokens      bigint      NOT NULL DEFAULT 0,
  cache_write_tokens bigint      NOT NULL DEFAULT 0,
  cache_read_tokens  bigint      NOT NULL DEFAULT 0,
  price_id           uuid        REFERENCES ai_model_prices (id),
  cost_micros        bigint,
  currency           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('chat', 'title', 'embedding')),
  CONSTRAINT ai_usage_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_usage_tokens_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cache_write_tokens >= 0 AND cache_read_tokens >= 0
  ),
  CONSTRAINT ai_usage_cost_check CHECK (
    cost_micros >= 0 AND (cost_micros IS NULL) = (currency IS NULL) AND (price_id IS NULL OR cost_micros IS NOT NULL)
  ),
  CONSTRAINT ai_usage_currency_check CHECK (currency IN ('USD', 'BRL'))
);

CREATE INDEX ai_usage_run_id_idx ON ai_usage (run_id);
CREATE INDEX ai_usage_message_id_idx ON ai_usage (message_id);
CREATE INDEX ai_usage_conversation_id_idx ON ai_usage (conversation_id);
CREATE INDEX ai_usage_user_id_idx ON ai_usage (user_id, created_at);
CREATE INDEX ai_usage_agent_id_idx ON ai_usage (agent_id, created_at);
CREATE INDEX ai_usage_provider_id_idx ON ai_usage (provider_id);
CREATE INDEX ai_usage_price_id_idx ON ai_usage (price_id);
CREATE INDEX ai_usage_created_at_idx ON ai_usage (created_at);

CREATE TRIGGER ai_usage_set_updated_at BEFORE UPDATE ON ai_usage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_usage IS
  'Uso de uma chamada ao modelo (spec 011: tokens e custo estimado por mensagem, agente e usuário; só medição). Uma linha '
  'por chamada (ou por mensagem do assistente). Ao inserir, o banco completa conversa/usuário/agente/provedor/modelo da '
  'execução e calcula o custo pelo preço vigente; a execução recebe os totais. Imutável para a aplicação. Sobrevive à '
  'exclusão da conversa (ligações anuladas). Fora da auditoria.';
COMMENT ON COLUMN ai_usage.message_id IS 'Mensagem do assistente que a chamada produziu (opcional).';
COMMENT ON COLUMN ai_usage.purpose IS 'chat (loop do agente), title (título automático) ou embedding (indexação/busca semântica, sem agente).';
COMMENT ON COLUMN ai_usage.input_tokens IS
  'Tokens de entrada SEM cache. Normalize por provedor: Anthropic input_tokens; OpenAI prompt_tokens − cached_tokens.';
COMMENT ON COLUMN ai_usage.cache_write_tokens IS 'Tokens gravados no cache de prompt (Anthropic cache_creation_input_tokens; OpenAI 0).';
COMMENT ON COLUMN ai_usage.cache_read_tokens IS 'Tokens lidos do cache (Anthropic cache_read_input_tokens; OpenAI cached_tokens).';
COMMENT ON COLUMN ai_usage.price_id IS 'Preço usado (vigente no created_at). Nulo = sem preço cadastrado: custo desconhecido (nulo).';
COMMENT ON COLUMN ai_usage.cost_micros IS 'Custo estimado em milionésimos de currency (ex.: 1500000 = US$ 1,50). Nulo sem preço.';

REVOKE UPDATE ON ai_usage FROM moneyflow_app;

CREATE FUNCTION ai_usage_before_insert() RETURNS trigger
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

CREATE TRIGGER ai_usage_before_insert BEFORE INSERT ON ai_usage
  FOR EACH ROW EXECUTE FUNCTION ai_usage_before_insert();

-- Totais da execução (o custo soma só na moeda da execução; a primeira com custo define a moeda).
CREATE FUNCTION ai_usage_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    UPDATE ai_runs r
       SET input_tokens = r.input_tokens + NEW.input_tokens,
           output_tokens = r.output_tokens + NEW.output_tokens,
           cache_write_tokens = r.cache_write_tokens + NEW.cache_write_tokens,
           cache_read_tokens = r.cache_read_tokens + NEW.cache_read_tokens,
           cost_currency = coalesce(r.cost_currency, NEW.currency),
           cost_micros = r.cost_micros + CASE WHEN NEW.currency = coalesce(r.cost_currency, NEW.currency)
                                              THEN NEW.cost_micros ELSE 0 END
     WHERE r.id = NEW.run_id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER ai_usage_after_insert AFTER INSERT ON ai_usage
  FOR EACH ROW EXECUTE FUNCTION ai_usage_after_insert();

-- Agregados ----------------------------------------------------------------------------------------------------
CREATE VIEW ai_message_usage WITH (security_invoker = true) AS
SELECT u.message_id,
       u.currency,
       count(*)::int AS calls,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 WHERE u.message_id IS NOT NULL
 GROUP BY u.message_id, u.currency;

COMMENT ON VIEW ai_message_usage IS
  'Tokens e custo por mensagem do assistente (uma linha por moeda; currency nula = chamadas sem preço cadastrado).';

CREATE VIEW ai_usage_monthly_by_user WITH (security_invoker = true) AS
SELECT date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS month,
       u.user_id,
       u.currency,
       count(*)::int AS calls,
       count(DISTINCT u.run_id)::int AS runs,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cost_micros)::bigint AS cost_micros,
       bool_or(u.cost_micros IS NULL) AS has_unpriced
  FROM ai_usage u
 GROUP BY 1, u.user_id, u.currency;

COMMENT ON VIEW ai_usage_monthly_by_user IS
  'Uso por mês (America/Sao_Paulo), usuário e moeda. user_id nulo = sistema (embeddings) ou usuário excluído.';

CREATE VIEW ai_usage_monthly_by_agent WITH (security_invoker = true) AS
SELECT date_trunc('month', u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS month,
       u.agent_id,
       u.provider_id,
       u.model,
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
 GROUP BY 1, u.agent_id, u.provider_id, u.model, u.currency;

COMMENT ON VIEW ai_usage_monthly_by_agent IS
  'Uso por mês (America/Sao_Paulo), agente, provedor, modelo e moeda. agent_id nulo = embeddings (sem agente).';

-- migrate:down

DROP VIEW ai_usage_monthly_by_agent;
DROP VIEW ai_usage_monthly_by_user;
DROP VIEW ai_message_usage;
DROP TABLE ai_usage;
DROP FUNCTION ai_usage_after_insert();
DROP FUNCTION ai_usage_before_insert();
