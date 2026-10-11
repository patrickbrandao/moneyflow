-- migrate:up

-- Agentes de IA (spec 011), parte 1: provedores de LLM, preços por modelo e agentes.
--
-- A chave de API do provedor é SEGREDO, blindada como users.password e message_destinations.bot_token:
-- moneyflow_app grava (INSERT/UPDATE) mas não lê ai_providers.api_key. A leitura é só por funções
-- SECURITY DEFINER: ai_run_provider_credentials(run) (worker, execução reservada; migration 0026),
-- ai_embedding_credentials() (worker, indexação) e admin_ai_provider_api_key(provider, ator admin)
-- (testar conexão / listar modelos na tela do admin). A chave nunca vai para o audit_log.

-- Auditoria: novos segredos mascarados ---------------------------------------------------------------------
-- api_key (ai_providers), secret_headers (mcp_servers, 0025) e token_hash (user_api_tokens, 0028): a troca
-- aparece só em changed_columns, sem o valor.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  secrets constant text[] := ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash'];
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
  'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token, api_key, secret_headers, '
  'token_hash): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha.';

-- Lista de nomes de tools (agente e vínculo com servidor MCP) -------------------------------------------------
CREATE FUNCTION ai_tool_list_valid(p_tools text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_tools IS NULL
      OR (cardinality(p_tools) <= 500
          AND array_position(p_tools, NULL) IS NULL
          AND NOT EXISTS (SELECT 1 FROM unnest(p_tools) t WHERE t !~ '^[A-Za-z0-9_./-]{1,128}$')
          AND (SELECT count(DISTINCT t) FROM unnest(p_tools) t) = cardinality(p_tools))
$$;

COMMENT ON FUNCTION ai_tool_list_valid(text[]) IS
  'true se a lista de tools é NULL (= todas) ou tem até 500 nomes distintos, não nulos, no formato de nome de tool '
  'do MCP ([A-Za-z0-9_./-], 1–128). Lista vazia = nenhuma tool.';

-- Provedores ------------------------------------------------------------------------------------------------
CREATE TABLE ai_providers (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  name               text        NOT NULL,
  kind               text        NOT NULL,
  base_url           text,
  api_key            text,
  api_key_hint       text        GENERATED ALWAYS AS (CASE WHEN api_key IS NOT NULL THEN '…' || right(api_key, 4) END) STORED,
  embedding_model    text,
  is_active          boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  notes              text,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_providers_kind_check CHECK (kind IN ('anthropic', 'openai')),
  CONSTRAINT ai_providers_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT ai_providers_base_url_check CHECK (base_url ~ '^https?://[^[:space:]]+$' AND length(base_url) <= 500),
  CONSTRAINT ai_providers_api_key_check CHECK (api_key ~ '^[[:graph:]]+$' AND length(api_key) BETWEEN 8 AND 1000),
  CONSTRAINT ai_providers_credentials_check CHECK (api_key IS NOT NULL OR base_url IS NOT NULL),
  CONSTRAINT ai_providers_embedding_model_check CHECK (
    embedding_model IS NULL OR (embedding_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$' AND kind = 'openai')
  ),
  CONSTRAINT ai_providers_active_check CHECK (NOT (is_active AND archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX ai_providers_name_key ON ai_providers (lower(name));
-- No máximo um provedor de embeddings ativo: a dimensão do vetor é fixa (0029).
CREATE UNIQUE INDEX ai_providers_embedding_key ON ai_providers ((true)) WHERE embedding_model IS NOT NULL AND is_active;
CREATE INDEX ai_providers_created_by_user_id_idx ON ai_providers (created_by_user_id);

CREATE TRIGGER ai_providers_set_updated_at BEFORE UPDATE ON ai_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_providers IS
  'Provedores de LLM cadastrados pelo admin (spec 011). kind anthropic (Claude API, padrão) ou openai (OpenAI API e '
  'APIs compatíveis, com base_url). A chave é segredo: moneyflow_app grava mas não lê api_key.';
COMMENT ON COLUMN ai_providers.kind IS 'anthropic (Messages API) ou openai (Chat Completions/Responses; cobre APIs compatíveis via base_url).';
COMMENT ON COLUMN ai_providers.base_url IS 'URL base da API (nulo = a oficial do kind). Ex.: proxy, Azure, Ollama, OpenRouter.';
COMMENT ON COLUMN ai_providers.api_key IS
  'SEGREDO: chave da API. moneyflow_app grava mas NÃO lê esta coluna; leitura só por ai_run_provider_credentials, '
  'ai_embedding_credentials e admin_ai_provider_api_key. Nula só com base_url (servidor local sem chave). Nunca vai '
  'para o audit_log, respostas da API, logs ou tools de agente. Na edição, campo vazio mantém a atual.';
COMMENT ON COLUMN ai_providers.api_key_hint IS 'Parte pública da chave (…últimos 4 caracteres), gerada pelo banco, para a tela.';
COMMENT ON COLUMN ai_providers.embedding_model IS
  'Modelo de embeddings deste provedor (só kind openai; ex.: text-embedding-3-small, 1536 dimensões). Nulo = o provedor '
  'não gera embeddings. No máximo um provedor ativo com embeddings; sem nenhum, a busca dos agentes cai para trigram.';
COMMENT ON COLUMN ai_providers.is_active IS 'false = agentes deste provedor não iniciam execuções novas.';

-- Blindagem da chave: SELECT por coluna, sem api_key. Coluna nova nesta tabela precisa de GRANT SELECT explícito.
REVOKE SELECT ON ai_providers FROM moneyflow_app;
GRANT SELECT (id, name, kind, base_url, api_key_hint, embedding_model, is_active, created_by_user_id, notes,
              archived_at, created_at, updated_at)
  ON ai_providers TO moneyflow_app;

CREATE FUNCTION admin_ai_provider_api_key(p_provider_id uuid, p_actor_user_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_ai_provider_api_key: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.api_key INTO k FROM public.ai_providers p WHERE p.id = p_provider_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_ai_provider_api_key: provider % not found', p_provider_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN k;
END
$$;

REVOKE EXECUTE ON FUNCTION admin_ai_provider_api_key(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_ai_provider_api_key(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION admin_ai_provider_api_key(uuid, uuid) IS
  'Chave do provedor para uso INTERNO da API em ações do admin (testar conexão, listar modelos); nunca devolva o valor '
  'ao cliente. Erro 42501 se o ator não é admin ativo (ator = sessão autenticada) e P0002 se o provedor não existe.';

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

-- Preços por modelo ------------------------------------------------------------------------------------------
CREATE TABLE ai_model_prices (
  id                           uuid          PRIMARY KEY DEFAULT uuidv7(),
  provider_id                  uuid          NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
  model                        text          NOT NULL,
  currency                     text          NOT NULL DEFAULT 'USD',
  input_price_per_million      numeric(14,6) NOT NULL,
  output_price_per_million     numeric(14,6) NOT NULL,
  cache_write_price_per_million numeric(14,6),
  cache_read_price_per_million numeric(14,6),
  valid_from                   timestamptz   NOT NULL DEFAULT now(),
  created_at                   timestamptz   NOT NULL DEFAULT now(),
  updated_at                   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_prices_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_model_prices_currency_check CHECK (currency IN ('USD', 'BRL')),
  CONSTRAINT ai_model_prices_values_check CHECK (
    input_price_per_million >= 0 AND output_price_per_million >= 0
    AND cache_write_price_per_million >= 0 AND cache_read_price_per_million >= 0
  ),
  CONSTRAINT ai_model_prices_valid_from_key UNIQUE (provider_id, model, valid_from)
);

CREATE TRIGGER ai_model_prices_set_updated_at BEFORE UPDATE ON ai_model_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_model_prices IS
  'Tabela de preços por provedor e modelo, com vigência (valid_from): o preço de um instante é a linha mais recente com '
  'valid_from <= instante (ai_model_price_at). Só para custo ESTIMADO (spec 011: medição, sem teto). Preço novo = linha nova.';
COMMENT ON COLUMN ai_model_prices.model IS 'Nome exato do modelo na API (ex.: claude-sonnet-4-5, gpt-4.1-mini).';
COMMENT ON COLUMN ai_model_prices.currency IS 'Moeda da tabela do provedor: USD (padrão, como as APIs cobram) ou BRL.';
COMMENT ON COLUMN ai_model_prices.input_price_per_million IS 'Preço por 1 milhão de tokens de entrada (sem cache), na moeda da linha.';
COMMENT ON COLUMN ai_model_prices.output_price_per_million IS 'Preço por 1 milhão de tokens de saída.';
COMMENT ON COLUMN ai_model_prices.cache_write_price_per_million IS 'Preço por 1 milhão de tokens gravados no cache de prompt. Nulo = preço de entrada.';
COMMENT ON COLUMN ai_model_prices.cache_read_price_per_million IS 'Preço por 1 milhão de tokens lidos do cache de prompt. Nulo = preço de entrada.';
COMMENT ON COLUMN ai_model_prices.valid_from IS 'Início da vigência deste preço.';

CREATE FUNCTION ai_model_price_at(p_provider_id uuid, p_model text, p_at timestamptz DEFAULT now())
RETURNS ai_model_prices
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM ai_model_prices p
   WHERE p.provider_id = p_provider_id AND p.model = p_model AND p.valid_from <= p_at
   ORDER BY p.valid_from DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION ai_model_price_at(uuid, text, timestamptz) IS
  'Preço vigente do modelo no instante (linha mais recente com valid_from <= p_at); todos os campos nulos se não há preço.';

-- Agentes ----------------------------------------------------------------------------------------------------
-- Parâmetros do modelo (todos opcionais):
--   temperature            número 0–2
--   top_p                  número > 0 e <= 1
--   max_tokens             inteiro 1–1000000 (saída por chamada)
--   max_tool_iterations    inteiro 1–200 (voltas do loop de tools por execução)
--   thinking_budget_tokens inteiro 0–1000000 (raciocínio estendido; 0 = desligado)
--   reasoning_effort       "minimal" | "low" | "medium" | "high" (modelos de raciocínio da OpenAI)
CREATE FUNCTION ai_agent_params_valid(p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_params) LOOP
    CASE k
      WHEN 'temperature' THEN
        IF jsonb_typeof(v) <> 'number' OR v::text::numeric NOT BETWEEN 0 AND 2 THEN RETURN false; END IF;
      WHEN 'top_p' THEN
        IF jsonb_typeof(v) <> 'number' OR v::text::numeric <= 0 OR v::text::numeric > 1 THEN RETURN false; END IF;
      WHEN 'max_tokens', 'max_tool_iterations', 'thinking_budget_tokens' THEN
        IF jsonb_typeof(v) <> 'number' OR v::text !~ '^[0-9]{1,7}$' THEN RETURN false; END IF;
        IF (k = 'max_tokens' AND v::text::int NOT BETWEEN 1 AND 1000000)
           OR (k = 'max_tool_iterations' AND v::text::int NOT BETWEEN 1 AND 200)
           OR (k = 'thinking_budget_tokens' AND v::text::int > 1000000) THEN
          RETURN false;
        END IF;
      WHEN 'reasoning_effort' THEN
        IF jsonb_typeof(v) <> 'string' OR v #>> '{}' NOT IN ('minimal', 'low', 'medium', 'high') THEN RETURN false; END IF;
      ELSE
        RETURN false;
    END CASE;
  END LOOP;
  RETURN true;
END
$$;

COMMENT ON FUNCTION ai_agent_params_valid(jsonb) IS
  'true se params é um objeto só com chaves conhecidas e valores na faixa: temperature 0–2, top_p (0,1], max_tokens '
  '1–1000000, max_tool_iterations 1–200, thinking_budget_tokens 0–1000000, reasoning_effort minimal|low|medium|high.';

CREATE TABLE ai_agents (
  id                         uuid        PRIMARY KEY DEFAULT uuidv7(),
  name                       text        NOT NULL,
  description                text,
  system_prompt              text        NOT NULL DEFAULT '',
  provider_id                uuid        REFERENCES ai_providers (id),
  model                      text,
  params                     jsonb       NOT NULL DEFAULT '{}',
  enabled_tools              text[],
  require_write_confirmation boolean     NOT NULL DEFAULT true,
  color_slot                 smallint    NOT NULL DEFAULT 1,
  icon                       text,
  is_active                  boolean     NOT NULL DEFAULT true,
  created_by_user_id         uuid        REFERENCES users (id) ON DELETE SET NULL,
  archived_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agents_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT ai_agents_description_check CHECK (length(description) <= 2000),
  CONSTRAINT ai_agents_system_prompt_check CHECK (length(system_prompt) <= 200000),
  CONSTRAINT ai_agents_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT ai_agents_params_check CHECK (ai_agent_params_valid(params)),
  CONSTRAINT ai_agents_enabled_tools_check CHECK (ai_tool_list_valid(enabled_tools)),
  CONSTRAINT ai_agents_color_slot_check CHECK (color_slot BETWEEN 1 AND 12),
  CONSTRAINT ai_agents_icon_check CHECK (icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT ai_agents_ready_check CHECK (NOT is_active OR (provider_id IS NOT NULL AND model IS NOT NULL)),
  CONSTRAINT ai_agents_active_check CHECK (NOT (is_active AND archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX ai_agents_name_key ON ai_agents (lower(name));
CREATE INDEX ai_agents_provider_id_idx ON ai_agents (provider_id);
CREATE INDEX ai_agents_created_by_user_id_idx ON ai_agents (created_by_user_id);

CREATE TRIGGER ai_agents_set_updated_at BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_agents IS
  'Agentes de IA, criados só pelo admin (spec 011; a aplicação aplica). Ativo exige provedor e modelo; agente usado é '
  'arquivado, não excluído (as conversas e o uso o referenciam).';
COMMENT ON COLUMN ai_agents.system_prompt IS 'Prompt de sistema (até 200 mil caracteres).';
COMMENT ON COLUMN ai_agents.provider_id IS 'Provedor de LLM. Nulo só em agente inativo (rascunho).';
COMMENT ON COLUMN ai_agents.model IS 'Modelo no provedor (nome exato da API). Nulo só em agente inativo.';
COMMENT ON COLUMN ai_agents.params IS 'Parâmetros do modelo validados por ai_agent_params_valid (temperature, max_tokens…).';
COMMENT ON COLUMN ai_agents.enabled_tools IS
  'Tools internas habilitadas (nomes de packages/shared). NULL = todas; {} = nenhuma. As tools de MCP são escolhidas '
  'por servidor em agent_mcp_servers.';
COMMENT ON COLUMN ai_agents.require_write_confirmation IS
  'true (padrão) = tools de escrita (inclusive "enviar mensagem") pedem confirmação do usuário (ai_tool_confirmations).';
COMMENT ON COLUMN ai_agents.color_slot IS 'Cor do agente: slot 1–12 do design system (token --port-N), como nas categorias.';
COMMENT ON COLUMN ai_agents.icon IS 'Nome de ícone lucide em kebab-case (ex.: bot).';
COMMENT ON COLUMN ai_agents.is_active IS 'false = não aparece para novas conversas nem inicia execuções.';

-- Auditoria (configuração) ----------------------------------------------------------------------------------
CREATE TRIGGER ai_providers_audit AFTER INSERT OR UPDATE OR DELETE ON ai_providers
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER ai_model_prices_audit AFTER INSERT OR UPDATE OR DELETE ON ai_model_prices
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER ai_agents_audit AFTER INSERT OR UPDATE OR DELETE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- migrate:down

DROP TABLE ai_agents;
DROP FUNCTION ai_agent_params_valid(jsonb);
DROP FUNCTION ai_model_price_at(uuid, text, timestamptz);
DROP TABLE ai_model_prices;
DROP FUNCTION ai_embedding_credentials();
DROP FUNCTION admin_ai_provider_api_key(uuid, uuid);
DROP TABLE ai_providers;
DROP FUNCTION ai_tool_list_valid(text[]);

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
