-- migrate:up

-- Prompts e instruções dos agentes (F8, spec 022).
--
-- user_ai_settings: instruções do usuário para todos os agentes (até 20 mil) e a "Minha caixa principal" (caixa general,
-- ON DELETE SET NULL; a permissão de leitura é da aplicação). Uma linha por usuário (chave = user_id, some com ele).
-- Tabela própria para não mexer em users, que guarda a senha. Auditada com record_id = user_id (a linha não tem id).
--
-- ai_agent_prompt_versions: histórico imutável do prompt de cada agente, como contract_document_versions (0032):
-- version atribuída pelo banco (omitida = a próxima, travando o agente; informada tem de ser a próxima), nota até 500,
-- autor e restored_from_version_id (versão do mesmo agente). Excluídas só com o agente (CASCADE).
--   * A versão manda: AFTER INSERT na versão copia o conteúdo para ai_agents.system_prompt (vale na importação do
--     backup). UPDATE direto que deixe system_prompt diferente da última versão é recusado
--     (ai_agents_system_prompt_version_check); agente ainda sem versão (só no meio da transação que o criou) aceita.
--   * O agente nasce com a versão 1: o constraint trigger ai_agents_prompt_version_init (adiado para o COMMIT) cria a
--     versão 1 com o system_prompt do agente, sem nota e com o autor = created_by_user_id, se até lá ninguém criou uma.
--     A aplicação pode inserir a versão 1 ela mesma na transação (com nota). Na importação do backup, o agente e as
--     versões dele entram na mesma unidade (DEFERRED_CLUSTER) e as versões do arquivo são preservadas; arquivo antigo,
--     sem versões, ganha a versão 1 do system_prompt.
--   * Migração: a versão 1 de cada agente existente recebe o system_prompt atual.
--   * Auditoria sem o content (com content_chars): o ai_agents já audita o system_prompt antes/depois.
--
-- mcp_servers: instructions_mode (ignore|system|user, padrão ignore) e instructions_cache (instructions do initialize,
-- até 50 mil). Atualizar o cache não gera linha de auditoria (como o tools_cache). As duas colunas ganham GRANT SELECT
-- (a tabela guarda secret_headers) e entram na visão effective_agent_mcp_servers.

-- Configurações de IA do usuário --------------------------------------------------------------------------------------
CREATE TABLE user_ai_settings (
  user_id          uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  instructions     text        NOT NULL DEFAULT '',
  primary_caixa_id uuid        REFERENCES caixas (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_ai_settings_instructions_check CHECK (length(instructions) <= 20000)
);

CREATE INDEX user_ai_settings_primary_caixa_id_idx ON user_ai_settings (primary_caixa_id);

CREATE TRIGGER user_ai_settings_set_updated_at BEFORE UPDATE ON user_ai_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE user_ai_settings IS
  'Configurações de IA de cada usuário (spec 022, Minha conta → IA): instruções para todos os agentes e a caixa '
  'principal escolhida. Só o próprio usuário edita; o admin lê (regra da aplicação). Some com o usuário.';
COMMENT ON COLUMN user_ai_settings.instructions IS
  'Instruções do usuário (até 20 mil caracteres; vazio = nenhuma). Entram no prompt das conversas, nunca nas de fluxo.';
COMMENT ON COLUMN user_ai_settings.primary_caixa_id IS
  'Minha caixa principal: uma caixa general (user_ai_settings_primary_caixa_check). Alimenta o contexto automático e '
  'as variáveis {{usuario.caixa_principal}}/{{empresa.titular_principal}}. Que o usuário a lê é checado pela aplicação. '
  'Caixa excluída = nulo.';

CREATE FUNCTION user_ai_settings_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  caixa_kind text;
BEGIN
  IF NEW.primary_caixa_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.primary_caixa_id IS DISTINCT FROM OLD.primary_caixa_id) THEN
    SELECT c.kind INTO caixa_kind FROM caixas c WHERE c.id = NEW.primary_caixa_id;
    IF FOUND AND caixa_kind <> 'general' THEN
      RAISE EXCEPTION 'user_ai_settings: primary caixa % must be general (got %)', NEW.primary_caixa_id, caixa_kind
        USING ERRCODE = 'check_violation', CONSTRAINT = 'user_ai_settings_primary_caixa_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER user_ai_settings_validate BEFORE INSERT OR UPDATE ON user_ai_settings
  FOR EACH ROW EXECUTE FUNCTION user_ai_settings_validate();

COMMENT ON FUNCTION user_ai_settings_validate() IS
  'A caixa principal do usuário é general (o kind da caixa é imutável, então basta checar ao escolher).';

CREATE FUNCTION user_ai_settings_audit_row() RETURNS trigger
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

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, coalesce(n ->> 'user_id', o ->> 'user_id')::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION user_ai_settings_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION user_ai_settings_audit_row() IS
  'Trigger de auditoria de user_ai_settings: grava com record_id = user_id (a linha não tem id).';

CREATE TRIGGER user_ai_settings_audit AFTER INSERT OR UPDATE OR DELETE ON user_ai_settings
  FOR EACH ROW EXECUTE FUNCTION user_ai_settings_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON user_ai_settings TO moneyflow_app;

-- Versões do prompt do agente -----------------------------------------------------------------------------------------
CREATE TABLE ai_agent_prompt_versions (
  id                       uuid        PRIMARY KEY DEFAULT uuidv7(),
  agent_id                 uuid        NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  version                  integer     NOT NULL,
  content                  text        NOT NULL,
  note                     text,
  created_by_user_id       uuid        REFERENCES users (id) ON DELETE SET NULL,
  restored_from_version_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_prompt_versions_version_check CHECK (version >= 1),
  CONSTRAINT ai_agent_prompt_versions_content_check CHECK (length(content) <= 200000),
  CONSTRAINT ai_agent_prompt_versions_note_check CHECK (length(note) <= 500),
  CONSTRAINT ai_agent_prompt_versions_restored_self_check CHECK (restored_from_version_id <> id),
  CONSTRAINT ai_agent_prompt_versions_agent_version_key UNIQUE (agent_id, version),
  CONSTRAINT ai_agent_prompt_versions_id_agent_key UNIQUE (id, agent_id),
  CONSTRAINT ai_agent_prompt_versions_restored_from_version_id_fkey FOREIGN KEY (restored_from_version_id, agent_id)
    REFERENCES ai_agent_prompt_versions (id, agent_id)
);

CREATE INDEX ai_agent_prompt_versions_created_by_user_id_idx ON ai_agent_prompt_versions (created_by_user_id);
CREATE INDEX ai_agent_prompt_versions_restored_from_version_id_idx ON ai_agent_prompt_versions (restored_from_version_id);

CREATE TRIGGER ai_agent_prompt_versions_set_updated_at BEFORE UPDATE ON ai_agent_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_agent_prompt_versions IS
  'Versões do prompt de sistema de um agente (spec 022): toda mudança de prompt é uma versão nova (version 1, 2, 3…; '
  'omita version e o banco atribui a próxima, travando o agente). A versão manda: o INSERT copia o content para '
  'ai_agents.system_prompt. O agente nasce com a versão 1 (ai_agents_prompt_version_init, no COMMIT). Imutáveis; somem '
  'só com o agente. A auditoria grava a linha sem o content (com content_chars).';
COMMENT ON COLUMN ai_agent_prompt_versions.version IS
  'Número da versão no agente, atribuído pelo banco quando omitido; se informado, tem de ser o próximo (max + 1).';
COMMENT ON COLUMN ai_agent_prompt_versions.content IS 'Prompt de sistema desta versão (até 200 mil caracteres; pode ser vazio).';
COMMENT ON COLUMN ai_agent_prompt_versions.note IS 'Nota opcional da gravação (até 500), ex.: "Restaurada da versão N".';
COMMENT ON COLUMN ai_agent_prompt_versions.created_by_user_id IS
  'Autor (usuário excluído = nulo). Na versão 1 criada pelo banco, o created_by_user_id do agente.';
COMMENT ON COLUMN ai_agent_prompt_versions.restored_from_version_id IS
  'Versão (do mesmo agente) cujo conteúdo foi restaurado nesta.';

-- Número atribuído pelo banco (trava o agente: gravações concorrentes saem em sequência).
CREATE FUNCTION ai_agent_prompt_versions_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_version integer;
BEGIN
  PERFORM 1 FROM ai_agents a WHERE a.id = NEW.agent_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    NEW.version := coalesce(NEW.version, 1);
    RETURN NEW;  -- a FK reporta o erro (23503), não o NOT NULL do número.
  END IF;
  SELECT coalesce(max(v.version), 0) + 1 INTO next_version
    FROM ai_agent_prompt_versions v WHERE v.agent_id = NEW.agent_id;
  IF NEW.version IS NULL THEN
    NEW.version := next_version;
  ELSIF NEW.version <> next_version THEN
    RAISE EXCEPTION 'ai_agent_prompt_versions: next version of agent % is %, got %', NEW.agent_id, next_version,
      NEW.version
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_prompt_versions_version_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_agent_prompt_versions_before_insert BEFORE INSERT ON ai_agent_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION ai_agent_prompt_versions_before_insert();

-- A versão manda: a nova (sempre a última) vira o system_prompt do agente.
CREATE FUNCTION ai_agent_prompt_versions_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_agents a SET system_prompt = NEW.content
   WHERE a.id = NEW.agent_id AND a.system_prompt IS DISTINCT FROM NEW.content;
  RETURN NULL;
END
$$;

CREATE TRIGGER ai_agent_prompt_versions_apply AFTER INSERT ON ai_agent_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION ai_agent_prompt_versions_apply();

COMMENT ON FUNCTION ai_agent_prompt_versions_apply() IS
  'A versão manda: copia o content da versão inserida (a última) para ai_agents.system_prompt.';

-- Imutável: só a FK ON DELETE SET NULL do autor muda; DELETE só pela cascata do agente.
CREATE FUNCTION ai_agent_prompt_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM ai_agents a WHERE a.id = OLD.agent_id) THEN
      RAISE EXCEPTION 'ai_agent_prompt_versions: version % is immutable (it goes only with the agent)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_prompt_versions_immutable_check';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.agent_id <> OLD.agent_id OR NEW.version <> OLD.version OR NEW.content <> OLD.content
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.restored_from_version_id IS DISTINCT FROM OLD.restored_from_version_id
     OR NEW.created_at <> OLD.created_at
     OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NEW.created_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ai_agent_prompt_versions: version % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_prompt_versions_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_agent_prompt_versions_guard BEFORE UPDATE OR DELETE ON ai_agent_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION ai_agent_prompt_versions_guard();

-- Auditoria sem o content (o ai_agents já grava o system_prompt antes/depois).
CREATE FUNCTION ai_agent_prompt_versions_audit_row() RETURNS trigger
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
  IF o IS NOT NULL THEN
    o := (o - 'content') || jsonb_build_object('content_chars', length(OLD.content));
  END IF;
  IF n IS NOT NULL THEN
    n := (n - 'content') || jsonb_build_object('content_chars', length(NEW.content));
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_agent_prompt_versions_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION ai_agent_prompt_versions_audit_row() IS
  'Trigger de auditoria de ai_agent_prompt_versions: grava a linha sem content (só content_chars); o texto do prompt '
  'fica na linha de auditoria do ai_agents (system_prompt antes/depois).';

CREATE TRIGGER ai_agent_prompt_versions_audit AFTER INSERT OR UPDATE OR DELETE ON ai_agent_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION ai_agent_prompt_versions_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_prompt_versions TO moneyflow_app;

-- Migração: a versão 1 de cada agente existente é o prompt atual.
INSERT INTO ai_agent_prompt_versions (agent_id, content, created_by_user_id)
SELECT a.id, a.system_prompt, a.created_by_user_id
  FROM ai_agents a
 ORDER BY a.id;

-- system_prompt só muda pela versão.
CREATE FUNCTION ai_agents_system_prompt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest text;
BEGIN
  IF NEW.system_prompt IS DISTINCT FROM OLD.system_prompt THEN
    SELECT v.content INTO latest
      FROM ai_agent_prompt_versions v WHERE v.agent_id = NEW.id ORDER BY v.version DESC LIMIT 1;
    IF FOUND AND latest IS DISTINCT FROM NEW.system_prompt THEN
      RAISE EXCEPTION 'ai_agents: system_prompt of agent % changes only by a new version (ai_agent_prompt_versions)', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agents_system_prompt_version_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_agents_system_prompt_guard BEFORE UPDATE OF system_prompt ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION ai_agents_system_prompt_guard();

COMMENT ON FUNCTION ai_agents_system_prompt_guard() IS
  'Recusa (23514 ai_agents_system_prompt_version_check) UPDATE que deixe system_prompt diferente da última versão. '
  'Agente ainda sem versão (no meio da transação que o criou) aceita.';

-- O agente nasce com a versão 1 (no COMMIT, se ninguém a criou na transação).
CREATE FUNCTION ai_agents_prompt_version_init() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ai_agent_prompt_versions (agent_id, content, created_by_user_id)
  SELECT a.id, a.system_prompt, a.created_by_user_id
    FROM ai_agents a
   WHERE a.id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM ai_agent_prompt_versions v WHERE v.agent_id = a.id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER ai_agents_prompt_version_init
  AFTER INSERT ON ai_agents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ai_agents_prompt_version_init();

COMMENT ON FUNCTION ai_agents_prompt_version_init() IS
  'Constraint trigger adiado (ai_agents_prompt_version_init): no COMMIT (ou em SET CONSTRAINTS … IMMEDIATE), cria a '
  'versão 1 do agente inserido com o system_prompt atual, sem nota e com o autor = created_by_user_id, se ele ainda '
  'não tem versão. Agente excluído na mesma transação: nada.';

COMMENT ON COLUMN ai_agents.system_prompt IS
  'Prompt de sistema (até 200 mil caracteres). Espelho da última versão (ai_agent_prompt_versions): muda só criando '
  'uma versão (UPDATE direto diferente dela dá 23514 ai_agents_system_prompt_version_check).';

-- Instructions dos servidores MCP -------------------------------------------------------------------------------------
ALTER TABLE mcp_servers
  ADD COLUMN instructions_mode text NOT NULL DEFAULT 'ignore',
  ADD COLUMN instructions_cache text,
  ADD CONSTRAINT mcp_servers_instructions_mode_check CHECK (instructions_mode IN ('ignore', 'system', 'user')),
  ADD CONSTRAINT mcp_servers_instructions_cache_check CHECK (length(instructions_cache) <= 50000);

COMMENT ON COLUMN mcp_servers.instructions_mode IS
  'O que fazer com as instructions do servidor (spec 022): ignore (padrão; texto de terceiros), system (no prompt de '
  'sistema, sob "Instruções do servidor MCP <nome>") ou user (bloco do papel user no início do histórico enviado, '
  'nunca gravado em ai_messages).';
COMMENT ON COLUMN mcp_servers.instructions_cache IS
  'Cache das instructions da resposta do initialize (até 50 mil caracteres), atualizado junto com tools_cache pelo '
  '"Atualizar tools". Nulo = o servidor não mandou ou nunca foi listado. Atualizá-lo não gera auditoria.';

-- Blindagem por coluna (secret_headers): coluna nova precisa de GRANT SELECT explícito.
GRANT SELECT (instructions_mode, instructions_cache) ON mcp_servers TO moneyflow_app;

DROP TRIGGER mcp_servers_audit ON mcp_servers;
CREATE TRIGGER mcp_servers_audit AFTER INSERT OR UPDATE OR DELETE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION audit_row('tools_cache,tools_cached_at,tools_error,instructions_cache');

CREATE OR REPLACE VIEW effective_agent_mcp_servers WITH (security_invoker = true) AS
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
       s.tools_cached_at,
       s.instructions_mode,
       s.instructions_cache
  FROM ai_agents a
  JOIN mcp_servers s ON s.is_active AND s.archived_at IS NULL
  LEFT JOIN agent_mcp_servers l ON l.agent_id = a.id AND l.mcp_server_id = s.id
 WHERE s.visibility = 'global' OR l.id IS NOT NULL;

COMMENT ON VIEW effective_agent_mcp_servers IS
  'Servidores MCP efetivos de cada agente: os global ativos (sempre) mais os public/private vinculados e ativos. tools = '
  'tools_cache filtrado por enabled_tools (NULL = todas); instructions_mode e instructions_cache do servidor (a '
  'aplicação usa o cache só fora do modo ignore). Sem os cabeçalhos.';

-- migrate:down

DROP VIEW effective_agent_mcp_servers;
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

GRANT SELECT ON effective_agent_mcp_servers TO moneyflow_app;

DROP TRIGGER mcp_servers_audit ON mcp_servers;
CREATE TRIGGER mcp_servers_audit AFTER INSERT OR UPDATE OR DELETE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION audit_row('tools_cache,tools_cached_at,tools_error');

ALTER TABLE mcp_servers DROP COLUMN instructions_cache, DROP COLUMN instructions_mode;

COMMENT ON COLUMN ai_agents.system_prompt IS 'Prompt de sistema (até 200 mil caracteres).';

DROP TRIGGER ai_agents_prompt_version_init ON ai_agents;
DROP TRIGGER ai_agents_system_prompt_guard ON ai_agents;
DROP FUNCTION ai_agents_prompt_version_init();
DROP FUNCTION ai_agents_system_prompt_guard();

DROP TABLE ai_agent_prompt_versions;
DROP FUNCTION ai_agent_prompt_versions_audit_row();
DROP FUNCTION ai_agent_prompt_versions_guard();
DROP FUNCTION ai_agent_prompt_versions_apply();
DROP FUNCTION ai_agent_prompt_versions_before_insert();

DROP TABLE user_ai_settings;
DROP FUNCTION user_ai_settings_audit_row();
DROP FUNCTION user_ai_settings_validate();
