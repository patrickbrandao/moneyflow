-- migrate:up

-- Kit de ferramentas dos agentes (F7, spec 021).
--
-- ai_tool_kits: perfis de tools internas (nome único sem distinção de maiúsculas, até 120; descrição até 2000).
-- ai_tool_kit_tools: as tools que o kit libera, cada uma em allow (executa direto) ou ask (pede aprovação). Tool fora
-- do kit não existe para o agente. O nome segue o formato de ai_tool_list_valid; a aplicação valida contra o registro.
-- ai_agents.tool_kit_id: no máximo um kit por agente, um kit para vários agentes. Nulo = sem kit = poder completo
-- (todas as tools internas em allow, menos as de segredo). Kit em uso (inclusive por agente arquivado) não é excluído
-- (FK sem ON DELETE, 23503). Não há arquivamento de kit.
--
-- Substitui ai_agents.enabled_tools e ai_agents.require_write_confirmation, que saem. Migração (ninguém ganha nem perde
-- poder, salvo a exceção abaixo), com o retrato fixo das 49 tools da v0.1.7 em ai_legacy_tool_registry():
--   * agente com enabled_tools não nulo, ou com require_write_confirmation = true, ganha o kit "Kit – <nome>" (truncado
--     em 120, com sufixo " (n)" se colidir) com exatamente as tools que tinha (todas, se a lista era nula); nomes fora
--     do retrato são descartados;
--   * no kit, ask vai para a escrita que pedia confirmação (send_telegram_message sempre; as demais escritas, menos
--     notify_user, quando a flag era true) e allow para o resto;
--   * agente com lista nula e flag false fica sem kit. Exceção: nele, send_telegram_message deixa de pedir confirmação.
--
-- Auditoria: ai_tool_kits por audit_row(); ai_tool_kit_tools não tem id (a chave é o par), então grava com
-- record_id = kit_id (as tools aparecem no histórico do kit), como entity_tag_links (0035).

-- Retrato fixo do registro da v0.1.7 -----------------------------------------------------------------------------
CREATE FUNCTION ai_legacy_tool_registry()
RETURNS TABLE (tool_name text, kind text, confirm text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT v.tool_name, v.kind, v.confirm
    FROM (VALUES
      -- leituras (25)
      ('search_records', 'read', 'never'),
      ('semantic_search', 'read', 'never'),
      ('list_caixas', 'read', 'never'),
      ('get_caixa', 'read', 'never'),
      ('list_accounts', 'read', 'never'),
      ('get_account_statement', 'read', 'never'),
      ('list_entities', 'read', 'never'),
      ('list_entity_tags', 'read', 'never'),
      ('get_entity', 'read', 'never'),
      ('list_categories', 'read', 'never'),
      ('list_titles', 'read', 'never'),
      ('get_title', 'read', 'never'),
      ('list_transfers', 'read', 'never'),
      ('get_card', 'read', 'never'),
      ('get_invoice', 'read', 'never'),
      ('list_card_purchases', 'read', 'never'),
      ('calendar', 'read', 'never'),
      ('report_categories', 'read', 'never'),
      ('report_entities', 'read', 'never'),
      ('report_projection', 'read', 'never'),
      ('flow_graph', 'read', 'never'),
      ('list_statement_imports', 'read', 'never'),
      ('get_statement_import', 'read', 'never'),
      ('list_line_candidates', 'read', 'never'),
      ('list_message_destinations', 'read', 'never'),
      -- escritas (24)
      ('create_entity', 'write', 'agent'),
      ('update_entity', 'write', 'agent'),
      ('set_entity_tags', 'write', 'agent'),
      ('set_entity_favorite', 'write', 'agent'),
      ('add_pix_key', 'write', 'agent'),
      ('create_title', 'write', 'agent'),
      ('update_title', 'write', 'agent'),
      ('end_series', 'write', 'agent'),
      ('settle_title', 'write', 'agent'),
      ('reverse_settlement', 'write', 'agent'),
      ('create_transfer', 'write', 'agent'),
      ('create_card_purchase', 'write', 'agent'),
      ('match_statement_line', 'write', 'agent'),
      ('match_statement_lines', 'write', 'agent'),
      ('confirm_statement_lines', 'write', 'agent'),
      ('unmatch_statement_line', 'write', 'agent'),
      ('ignore_statement_lines', 'write', 'agent'),
      ('unignore_statement_lines', 'write', 'agent'),
      ('create_from_statement_line', 'write', 'agent'),
      ('create_from_statement_lines', 'write', 'agent'),
      ('classify_statement_lines', 'write', 'agent'),
      ('apply_classification_suggestions', 'write', 'agent'),
      ('send_telegram_message', 'write', 'always'),
      ('notify_user', 'write', 'never')
    ) AS v (tool_name, kind, confirm)
$$;

COMMENT ON FUNCTION ai_legacy_tool_registry() IS
  'Retrato FIXO do registro de tools da v0.1.7 (packages/shared/src/agents/tools.ts): 49 tools, 25 read e 24 write, '
  'com o confirm de cada uma (never|agent|always). Usado pela migração de enabled_tools/require_write_confirmation '
  'para kits (0038) e para a aplicação conferir o retrato contra AGENT_TOOLS. Não acompanha o registro: tools novas '
  'não entram aqui.';

-- Kits -----------------------------------------------------------------------------------------------------------
CREATE TABLE ai_tool_kits (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  name               text        NOT NULL,
  description        text,
  created_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tool_kits_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT ai_tool_kits_description_check CHECK (length(description) <= 2000)
);

CREATE UNIQUE INDEX ai_tool_kits_name_key ON ai_tool_kits (lower(name));
CREATE INDEX ai_tool_kits_created_by_user_id_idx ON ai_tool_kits (created_by_user_id);

CREATE TRIGGER ai_tool_kits_set_updated_at BEFORE UPDATE ON ai_tool_kits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_tool_kits IS
  'Kits de ferramentas dos agentes (spec 021): quais tools internas um agente pode usar e, para cada uma, allow ou ask. '
  'Um agente tem no máximo um kit (ai_agents.tool_kit_id); um kit serve a vários. Kit em uso não é excluído (23503); '
  'não há arquivamento. Valem só para as tools internas (as de MCP externo seguem agent_mcp_servers).';
COMMENT ON COLUMN ai_tool_kits.name IS 'Nome (até 120), único sem distinção de maiúsculas (ai_tool_kits_name_key). Chave natural no backup.';
COMMENT ON COLUMN ai_tool_kits.description IS 'Descrição opcional (até 2000 caracteres).';
COMMENT ON COLUMN ai_tool_kits.created_by_user_id IS 'Quem criou. Nulo = criado pela migração 0038 ou usuário excluído.';

-- Tools do kit ---------------------------------------------------------------------------------------------------
CREATE TABLE ai_tool_kit_tools (
  kit_id     uuid        NOT NULL REFERENCES ai_tool_kits (id) ON DELETE CASCADE,
  tool_name  text        NOT NULL,
  mode       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tool_kit_tools_pkey PRIMARY KEY (kit_id, tool_name),
  CONSTRAINT ai_tool_kit_tools_tool_name_check CHECK (ai_tool_list_valid(ARRAY[tool_name])),
  CONSTRAINT ai_tool_kit_tools_mode_check CHECK (mode IN ('allow', 'ask'))
);

CREATE TRIGGER ai_tool_kit_tools_set_updated_at BEFORE UPDATE ON ai_tool_kit_tools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ai_tool_kit_tools IS
  'Tools internas liberadas por um kit (lista de permissões: tool fora do kit não é enviada ao modelo; tool nova do '
  'registro não entra sozinha). Some com o kit (CASCADE). Auditada com record_id = kit_id.';
COMMENT ON COLUMN ai_tool_kit_tools.tool_name IS
  'Nome da tool no registro (packages/shared). O banco valida só o formato (o de ai_tool_list_valid); a aplicação '
  'valida contra o registro.';
COMMENT ON COLUMN ai_tool_kit_tools.mode IS
  'allow = executa sem perguntar; ask = mostra o cartão "Aplicar?" com a prévia e espera o usuário. Vale para leituras '
  'e escritas; o modo sugerido (leituras e notify_user allow, demais escritas ask) é da aplicação.';

-- Agente → kit ---------------------------------------------------------------------------------------------------
-- Sem ON DELETE: NO ACTION, o "RESTRICT" do projeto (erro 23503; ON DELETE RESTRICT daria 23001), como entity_tag_links.
ALTER TABLE ai_agents ADD COLUMN tool_kit_id uuid REFERENCES ai_tool_kits (id);
CREATE INDEX ai_agents_tool_kit_id_idx ON ai_agents (tool_kit_id);

COMMENT ON COLUMN ai_agents.tool_kit_id IS
  'Kit de ferramentas (spec 021). Nulo = sem kit = poder completo: todas as tools internas em allow, menos as de '
  'segredo (sempre ask). Excluir o kit em uso (inclusive por agente arquivado) dá 23503 (ai_agents_tool_kit_id_fkey).';

-- Auditoria ------------------------------------------------------------------------------------------------------
CREATE FUNCTION ai_tool_kit_tools_audit_row() RETURNS trigger
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

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, coalesce(n ->> 'kit_id', o ->> 'kit_id')::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_tool_kit_tools_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION ai_tool_kit_tools_audit_row() IS
  'Trigger de auditoria de ai_tool_kit_tools: grava com record_id = kit_id (a linha não tem id), para incluir, '
  'remover e trocar o modo de uma tool aparecerem no histórico do kit.';

CREATE TRIGGER ai_tool_kits_audit AFTER INSERT OR UPDATE OR DELETE ON ai_tool_kits
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER ai_tool_kit_tools_audit AFTER INSERT OR UPDATE OR DELETE ON ai_tool_kit_tools
  FOR EACH ROW EXECUTE FUNCTION ai_tool_kit_tools_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_tool_kits, ai_tool_kit_tools TO moneyflow_app;

-- Migração de enabled_tools / require_write_confirmation ----------------------------------------------------------
CREATE FUNCTION ai_tool_kit_from_legacy(p_agent_name text, p_enabled_tools text[], p_require_write_confirmation boolean)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  confirm_writes constant boolean := coalesce(p_require_write_confirmation, true);
  base     text;
  kit_name text;
  suffix   text;
  n        int := 1;
  kid      uuid;
BEGIN
  IF p_enabled_tools IS NULL AND NOT confirm_writes THEN
    RETURN NULL;  -- lista nula e flag false: sem kit (poder completo)
  END IF;

  base := 'Kit – ' || btrim(p_agent_name);
  kit_name := rtrim(left(base, 120));
  WHILE EXISTS (SELECT 1 FROM ai_tool_kits k WHERE lower(k.name) = lower(kit_name)) LOOP
    n := n + 1;
    suffix := ' (' || n || ')';
    kit_name := rtrim(left(base, 120 - length(suffix))) || suffix;
  END LOOP;

  INSERT INTO ai_tool_kits (name, description)
  VALUES (kit_name, 'Criado na migração para kits (F7) a partir da configuração do agente "' || btrim(p_agent_name) || '".')
  RETURNING id INTO kid;

  INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode)
  SELECT kid, r.tool_name,
         CASE WHEN r.kind = 'write' AND (r.confirm = 'always' OR (r.confirm = 'agent' AND confirm_writes))
              THEN 'ask' ELSE 'allow' END
    FROM ai_legacy_tool_registry() r
   WHERE p_enabled_tools IS NULL OR r.tool_name = ANY (p_enabled_tools);

  RETURN kid;
END
$$;

REVOKE EXECUTE ON FUNCTION ai_tool_kit_from_legacy(text, text[], boolean) FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION ai_tool_kit_from_legacy(text, text[], boolean) IS
  'Interna (migração 0038): cria o kit equivalente à configuração antiga de um agente (enabled_tools, '
  'require_write_confirmation) e devolve o id, ou NULL se a lista era nula e a flag false (sem kit). Kit '
  '"Kit – <nome>" (truncado em 120, sufixo " (n)" se colidir) com as tools da lista que existem no retrato '
  'ai_legacy_tool_registry() (todas, se nula): ask nas escritas que pediam confirmação, allow no resto.';

DO $$
DECLARE
  a   record;
  kid uuid;
BEGIN
  FOR a IN SELECT id, name, enabled_tools, require_write_confirmation FROM ai_agents ORDER BY lower(name), id LOOP
    kid := ai_tool_kit_from_legacy(a.name, a.enabled_tools, a.require_write_confirmation);
    IF kid IS NOT NULL THEN
      UPDATE ai_agents SET tool_kit_id = kid WHERE id = a.id;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE ai_agents DROP COLUMN enabled_tools, DROP COLUMN require_write_confirmation;

-- migrate:down

-- Volta às colunas a partir dos kits: sem kit = lista nula e flag false; com kit = a lista das tools do kit (nula se
-- ele tem todas as do retrato da v0.1.7) e flag true se alguma tool, fora send_telegram_message, está em ask. Um kit
-- com modos mistos não tem equivalente exato; a volta fica do lado de pedir confirmação.
ALTER TABLE ai_agents
  ADD COLUMN enabled_tools text[],
  ADD COLUMN require_write_confirmation boolean NOT NULL DEFAULT true;

UPDATE ai_agents SET require_write_confirmation = false WHERE tool_kit_id IS NULL;

UPDATE ai_agents a
   SET enabled_tools = CASE
         WHEN NOT EXISTS (SELECT 1 FROM ai_legacy_tool_registry() r
                           WHERE NOT EXISTS (SELECT 1 FROM ai_tool_kit_tools t
                                              WHERE t.kit_id = a.tool_kit_id AND t.tool_name = r.tool_name))
           THEN NULL
         ELSE coalesce((SELECT array_agg(t.tool_name ORDER BY t.tool_name) FROM ai_tool_kit_tools t
                         WHERE t.kit_id = a.tool_kit_id), '{}')
       END,
       require_write_confirmation = EXISTS (SELECT 1 FROM ai_tool_kit_tools t
                                             WHERE t.kit_id = a.tool_kit_id AND t.mode = 'ask'
                                               AND t.tool_name <> 'send_telegram_message')
 WHERE a.tool_kit_id IS NOT NULL;

ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_enabled_tools_check CHECK (ai_tool_list_valid(enabled_tools));

COMMENT ON COLUMN ai_agents.enabled_tools IS
  'Tools internas habilitadas (nomes de packages/shared). NULL = todas; {} = nenhuma. As tools de MCP são escolhidas '
  'por servidor em agent_mcp_servers.';
COMMENT ON COLUMN ai_agents.require_write_confirmation IS
  'true (padrão) = tools de escrita (inclusive "enviar mensagem") pedem confirmação do usuário (ai_tool_confirmations).';

DROP INDEX ai_agents_tool_kit_id_idx;
ALTER TABLE ai_agents DROP COLUMN tool_kit_id;

DROP TABLE ai_tool_kit_tools;
DROP TABLE ai_tool_kits;
DROP FUNCTION ai_tool_kit_from_legacy(text, text[], boolean);
DROP FUNCTION ai_tool_kit_tools_audit_row();
DROP FUNCTION ai_legacy_tool_registry();
