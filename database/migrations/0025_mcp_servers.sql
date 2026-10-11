-- migrate:up

-- Agentes de IA (spec 011), parte 2: MCP client. Servidores MCP remotos (só Streamable HTTP) cadastrados
-- pelo admin, com visibilidade global | public | private, e o vínculo agente ↔ servidor.
--
-- Os cabeçalhos HTTP do servidor (ex.: Authorization) são SEGREDO, blindados como ai_providers.api_key:
-- moneyflow_app grava (INSERT/UPDATE, ou mcp_server_merge_headers para trocar só alguns) mas não lê
-- mcp_servers.secret_headers; a tela vê só os nomes (secret_header_names). Leitura por
-- ai_run_mcp_headers(run, servidor) (worker, migration 0026) e admin_mcp_server_headers(servidor, ator admin).

CREATE FUNCTION mcp_headers_valid(p_headers jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_headers IS NOT NULL
     AND jsonb_typeof(p_headers) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_headers)) <= 30
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p_headers) h
        WHERE h.key !~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,100}$'
           OR jsonb_typeof(h.value) <> 'string'
           OR length(h.value #>> '{}') > 8000
           OR (h.value #>> '{}') ~ '[\r\n]'
           OR lower(h.key) IN ('host', 'content-length', 'content-type', 'accept', 'mcp-session-id',
                               'mcp-protocol-version', 'connection', 'transfer-encoding'))
     AND (SELECT count(DISTINCT lower(k)) FROM jsonb_object_keys(p_headers) k)
         = (SELECT count(*) FROM jsonb_object_keys(p_headers))
$$;

COMMENT ON FUNCTION mcp_headers_valid(jsonb) IS
  'true se os cabeçalhos são um objeto nome → valor (string) com até 30 nomes de token HTTP distintos sem distinção de '
  'maiúsculas, valores até 8000 caracteres sem quebra de linha, e sem os cabeçalhos que o transporte controla (Host, '
  'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version…).';

CREATE FUNCTION mcp_header_names(p_headers jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(k ORDER BY lower(k)), '{}') FROM jsonb_object_keys(p_headers) k
$$;

COMMENT ON FUNCTION mcp_header_names(jsonb) IS 'Nomes dos cabeçalhos (sem os valores), em ordem alfabética.';

CREATE TABLE mcp_servers (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  name                text        NOT NULL,
  url                 text        NOT NULL,
  secret_headers      jsonb       NOT NULL DEFAULT '{}',
  secret_header_names text[]      NOT NULL GENERATED ALWAYS AS (mcp_header_names(secret_headers)) STORED,
  visibility          text        NOT NULL DEFAULT 'public',
  is_active           boolean     NOT NULL DEFAULT true,
  tools_cache         jsonb,
  tools_cached_at     timestamptz,
  tools_error         text,
  created_by_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  notes               text,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_servers_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT mcp_servers_url_check CHECK (url ~ '^https?://[^[:space:]]+$' AND length(url) <= 2000),
  CONSTRAINT mcp_servers_secret_headers_check CHECK (mcp_headers_valid(secret_headers)),
  CONSTRAINT mcp_servers_visibility_check CHECK (visibility IN ('global', 'public', 'private')),
  CONSTRAINT mcp_servers_tools_cache_check CHECK (
    tools_cache IS NULL OR (jsonb_typeof(tools_cache) = 'array' AND tools_cached_at IS NOT NULL)
  ),
  CONSTRAINT mcp_servers_tools_error_check CHECK (length(tools_error) <= 2000),
  CONSTRAINT mcp_servers_active_check CHECK (NOT (is_active AND archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX mcp_servers_name_key ON mcp_servers (lower(name));
CREATE INDEX mcp_servers_created_by_user_id_idx ON mcp_servers (created_by_user_id);

CREATE TRIGGER mcp_servers_set_updated_at BEFORE UPDATE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE mcp_servers IS
  'Servidores MCP remotos (Streamable HTTP, sem stdio) cadastrados pelo admin (spec 011). Os cabeçalhos são segredo: '
  'moneyflow_app grava mas não lê secret_headers.';
COMMENT ON COLUMN mcp_servers.url IS 'Endpoint Streamable HTTP do servidor (http ou https).';
COMMENT ON COLUMN mcp_servers.secret_headers IS
  'SEGREDO: cabeçalhos HTTP enviados ao servidor (ex.: {"Authorization": "Bearer …"}). moneyflow_app grava mas NÃO lê; '
  'troca parcial por mcp_server_merge_headers; leitura só por ai_run_mcp_headers e admin_mcp_server_headers. Nunca vai '
  'para o audit_log, respostas da API, logs ou tools de agente.';
COMMENT ON COLUMN mcp_servers.secret_header_names IS 'Nomes dos cabeçalhos configurados (sem valores), gerados pelo banco, para a tela.';
COMMENT ON COLUMN mcp_servers.visibility IS
  'global: entra em todos os agentes sem vínculo; public: escolhível na configuração de qualquer agente; private: só '
  'nos agentes que o admin vincular. public e private só valem com linha em agent_mcp_servers.';
COMMENT ON COLUMN mcp_servers.tools_cache IS
  'Cache do resultado de tools/list (array de objetos {name, description, inputSchema, annotations…}). Nulo = nunca listado.';
COMMENT ON COLUMN mcp_servers.tools_cached_at IS 'Quando tools_cache foi atualizado.';
COMMENT ON COLUMN mcp_servers.tools_error IS 'Erro da última tentativa de listar as tools (nulo = a última deu certo).';

-- Blindagem dos cabeçalhos: SELECT por coluna. Coluna nova nesta tabela precisa de GRANT SELECT explícito.
REVOKE SELECT ON mcp_servers FROM moneyflow_app;
GRANT SELECT (id, name, url, secret_header_names, visibility, is_active, tools_cache, tools_cached_at, tools_error,
              created_by_user_id, notes, archived_at, created_at, updated_at)
  ON mcp_servers TO moneyflow_app;

CREATE FUNCTION mcp_server_merge_headers(p_server_id uuid, p_set jsonb DEFAULT '{}', p_remove text[] DEFAULT '{}')
RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  names text[];
  cur   jsonb;
  k     text;
BEGIN
  IF p_set IS NULL OR jsonb_typeof(p_set) <> 'object' THEN
    RAISE EXCEPTION 'mcp_server_merge_headers: p_set must be a json object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT s.secret_headers INTO cur FROM public.mcp_servers s WHERE s.id = p_server_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mcp_server_merge_headers: server % not found', p_server_id USING ERRCODE = 'no_data_found';
  END IF;
  -- Nomes sem distinção de maiúsculas: remover ou redefinir "authorization" troca "Authorization".
  FOR k IN SELECT jsonb_object_keys(cur) LOOP
    IF lower(k) = ANY (SELECT lower(r) FROM unnest(coalesce(p_remove, '{}')) r)
       OR lower(k) IN (SELECT lower(s) FROM jsonb_object_keys(p_set) s) THEN
      cur := cur - k;
    END IF;
  END LOOP;
  UPDATE public.mcp_servers s SET secret_headers = cur || p_set
   WHERE s.id = p_server_id
  RETURNING s.secret_header_names INTO names;
  RETURN names;
END
$$;

REVOKE EXECUTE ON FUNCTION mcp_server_merge_headers(uuid, jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mcp_server_merge_headers(uuid, jsonb, text[]) TO moneyflow_app;

COMMENT ON FUNCTION mcp_server_merge_headers(uuid, jsonb, text[]) IS
  'Troca só alguns cabeçalhos sem ler os demais: remove os nomes de p_remove e define os de p_set (nomes sem distinção '
  'de maiúsculas). Devolve os nomes resultantes. P0002 se o servidor não existe; 22023 se p_set não é objeto; 23514 '
  '(mcp_servers_secret_headers_check) se o resultado é inválido. Auditado como UPDATE (sem os valores).';

CREATE FUNCTION admin_mcp_server_headers(p_server_id uuid, p_actor_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_mcp_server_headers: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.secret_headers INTO h FROM public.mcp_servers s WHERE s.id = p_server_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_mcp_server_headers: server % not found', p_server_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN h;
END
$$;

REVOKE EXECUTE ON FUNCTION admin_mcp_server_headers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_mcp_server_headers(uuid, uuid) TO moneyflow_app;

COMMENT ON FUNCTION admin_mcp_server_headers(uuid, uuid) IS
  'Cabeçalhos do servidor para uso INTERNO da API em ações do admin (testar, atualizar a lista de tools); nunca '
  'devolva ao cliente. Erro 42501 se o ator não é admin ativo e P0002 se o servidor não existe.';

-- Vínculo agente ↔ servidor ----------------------------------------------------------------------------------
CREATE TABLE agent_mcp_servers (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  agent_id      uuid        NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  mcp_server_id uuid        NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  enabled_tools text[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_mcp_servers_key UNIQUE (agent_id, mcp_server_id),
  CONSTRAINT agent_mcp_servers_enabled_tools_check CHECK (ai_tool_list_valid(enabled_tools))
);

CREATE INDEX agent_mcp_servers_mcp_server_id_idx ON agent_mcp_servers (mcp_server_id);

CREATE TRIGGER agent_mcp_servers_set_updated_at BEFORE UPDATE ON agent_mcp_servers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE agent_mcp_servers IS
  'Servidores MCP de um agente: public escolhido na configuração do agente ou private vinculado pelo admin. Servidor '
  'global entra em todos os agentes sem linha aqui; uma linha para um global só serve para restringir as tools.';
COMMENT ON COLUMN agent_mcp_servers.enabled_tools IS 'Tools habilitadas daquele servidor para o agente. NULL = todas; {} = nenhuma.';

CREATE VIEW effective_agent_mcp_servers WITH (security_invoker = true) AS
SELECT a.id AS agent_id,
       s.id AS mcp_server_id,
       s.name,
       s.url,
       s.visibility,
       l.id IS NOT NULL AS linked,
       l.enabled_tools,
       CASE WHEN s.tools_cache IS NULL OR l.enabled_tools IS NULL THEN s.tools_cache
            ELSE coalesce((SELECT jsonb_agg(t ORDER BY ord) FROM jsonb_array_elements(s.tools_cache) WITH ORDINALITY x (t, ord)
                            WHERE t ->> 'name' = ANY (l.enabled_tools)), '[]')
       END AS tools,
       s.tools_cached_at
  FROM ai_agents a
  JOIN mcp_servers s ON s.is_active AND s.archived_at IS NULL
  LEFT JOIN agent_mcp_servers l ON l.agent_id = a.id AND l.mcp_server_id = s.id
 WHERE s.visibility = 'global' OR l.id IS NOT NULL;

COMMENT ON VIEW effective_agent_mcp_servers IS
  'Servidores MCP efetivos de cada agente: os global ativos (sempre) mais os public/private vinculados e ativos. tools = '
  'tools_cache filtrado por enabled_tools (NULL = todas). Sem os cabeçalhos.';

-- Auditoria (configuração). A atualização do cache de tools sozinha não gera linha.
CREATE TRIGGER mcp_servers_audit AFTER INSERT OR UPDATE OR DELETE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION audit_row('tools_cache,tools_cached_at,tools_error');
CREATE TRIGGER agent_mcp_servers_audit AFTER INSERT OR UPDATE OR DELETE ON agent_mcp_servers
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- migrate:down

DROP VIEW effective_agent_mcp_servers;
DROP TABLE agent_mcp_servers;
DROP FUNCTION admin_mcp_server_headers(uuid, uuid);
DROP FUNCTION mcp_server_merge_headers(uuid, jsonb, text[]);
DROP TABLE mcp_servers;
DROP FUNCTION mcp_header_names(jsonb);
DROP FUNCTION mcp_headers_valid(jsonb);
