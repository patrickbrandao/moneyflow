-- migrate:up

-- Tags e favoritas de entidade (F6, specs 003 e 016).
--
-- entity_tags: catálogo GLOBAL de tags (nome único sem distinção de maiúsculas, arquivadas inclusive; cor obrigatória
-- color_slot 1–12, pintada com var(--port-N) como as categorias). Tag em uso não é apagada (FK RESTRICT): é arquivada.
-- entity_tag_links: as tags de cada entidade (par único). Ligar uma tag arquivada é recusado por trigger
-- (entity_tag_links_tag_active_check); a ligação que já existia sobrevive ao arquivamento.
-- entities.is_favorite: marca global de favorita.
-- Quem cria tags (admin) e quem as atribui (quem edita o cadastro) é regra da aplicação (Access).
--
-- Auditoria: entity_tag_links não tem id (a chave é o par), então o audit_log grava a ligação com
-- record_id = entity_id: atribuir e remover tags aparece no histórico da entidade (table_name = 'entity_tag_links').
-- Para isso audit_write ganha o parâmetro opcional p_record_id.
--
-- Busca por prefixo do documento (spec 003, "Busca"): índice text_pattern_ops em entities.document, porque o
-- índice único (collation en_US) não atende LIKE 'prefixo%'.

-- audit_write com record_id explícito ----------------------------------------------------------------------------
DROP FUNCTION audit_write(text, text, jsonb, jsonb, text[]);

CREATE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[],
                            p_record_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid_text text := nullif(current_setting('app.user_id', true), '');
  kind     text := nullif(current_setting('app.actor_kind', true), '');
  run_text text := nullif(current_setting('app.agent_run_id', true), '');
  uid      uuid;
BEGIN
  IF uid_text IS NOT NULL THEN
    IF uid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'audit: app.user_id % is not a uuid', uid_text
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
    END IF;
    uid := uid_text::uuid;
  END IF;
  kind := coalesce(kind, CASE WHEN uid IS NULL THEN 'system' ELSE 'human' END);
  IF kind NOT IN ('human', 'agent', 'system') OR (kind <> 'system' AND uid IS NULL) THEN
    RAISE EXCEPTION 'audit: app.actor_kind % requires app.user_id and must be human, agent or system', kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
  END IF;
  IF run_text IS NOT NULL THEN
    IF kind <> 'agent' THEN
      RAISE EXCEPTION 'audit: app.agent_run_id is only allowed with app.actor_kind = agent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
    END IF;
    IF run_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (SELECT 1 FROM public.ai_runs r WHERE r.id = run_text::uuid AND r.user_id = uid) THEN
      RAISE EXCEPTION 'audit: app.agent_run_id % is not a run started by user %', run_text, uid
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
    END IF;
    run_text := lower(run_text);
  END IF;

  INSERT INTO public.audit_log (table_name, record_id, action, old_data, new_data, changed_columns,
                                user_id, actor_kind, agent_run_id, transaction_id)
  VALUES (p_table, coalesce(p_record_id, (p_new ->> 'id')::uuid, (p_old ->> 'id')::uuid), p_action, p_old, p_new,
          p_changed, uid, kind, run_text, pg_current_xact_id()::text::bigint);
END
$$;

REVOKE EXECUTE ON FUNCTION audit_write(text, text, jsonb, jsonb, text[], uuid) FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION audit_write(text, text, jsonb, jsonb, text[], uuid) IS
  'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. record_id = p_record_id '
  '(tabelas sem coluna id, como entity_tag_links) ou o id da linha. Erro 23514 (audit_log_actor_check) se '
  'app.user_id não é uuid, se actor_kind é inválido, se human/agent vem sem usuário, ou se app.agent_run_id vem sem '
  'actor_kind = agent ou não é uma execução (ai_runs) do mesmo usuário.';

-- Favoritas ------------------------------------------------------------------------------------------------------
ALTER TABLE entities ADD COLUMN is_favorite boolean NOT NULL DEFAULT false;

CREATE INDEX entities_is_favorite_idx ON entities (name) WHERE is_favorite AND archived_at IS NULL;
CREATE INDEX entities_document_prefix_idx ON entities (document text_pattern_ops);

COMMENT ON COLUMN entities.is_favorite IS
  'Favorita (marca GLOBAL, igual para todos os usuários; spec 003). Entidade arquivada mantém a marca, mas a aba '
  'Favoritas lista só as ativas (índice parcial entities_is_favorite_idx).';
COMMENT ON INDEX entities_document_prefix_idx IS
  'Busca pelo prefixo do documento normalizado (document LIKE ''12ABC%''), CPF ou CNPJ numérico/alfanumérico.';

-- Catálogo de tags -----------------------------------------------------------------------------------------------
CREATE TABLE entity_tags (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  name        citext      NOT NULL,
  color_slot  smallint    NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_tags_name_key UNIQUE (name),
  CONSTRAINT entity_tags_name_check CHECK (
    char_length(name::text) BETWEEN 1 AND 40 AND name::text !~ '^[[:space:]]' AND name::text !~ '[[:space:]]$'
  ),
  CONSTRAINT entity_tags_color_slot_check CHECK (color_slot BETWEEN 1 AND 12)
);

CREATE TRIGGER entity_tags_set_updated_at BEFORE UPDATE ON entity_tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_tags IS
  'Catálogo global de tags de entidade (spec 003). Tag em uso não é apagada (entity_tag_links RESTRICT): é arquivada; '
  'arquivada não pode ser ligada de novo (entity_tag_links_tag_active_check), mas as ligações existentes ficam.';
COMMENT ON COLUMN entity_tags.name IS
  'Nome: 1 a 40 caracteres, sem espaço nas pontas; único sem distinção de maiúsculas, arquivadas inclusive '
  '(entity_tags_name_key).';
COMMENT ON COLUMN entity_tags.color_slot IS 'Cor obrigatória: slot 1–12 do design system (token --port-N).';
COMMENT ON COLUMN entity_tags.archived_at IS 'Arquivada (nulo = ativa): sai do seletor e do filtro.';

-- Ligações entidade–tag ------------------------------------------------------------------------------------------
CREATE TABLE entity_tag_links (
  entity_id  uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  -- Sem ON DELETE: NO ACTION, o "RESTRICT" do projeto (erro 23503, que o deleteOrArchive da aplicação trata).
  tag_id     uuid        NOT NULL REFERENCES entity_tags (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_tag_links_pkey PRIMARY KEY (entity_id, tag_id)
);

CREATE INDEX entity_tag_links_tag_id_idx ON entity_tag_links (tag_id);

CREATE TRIGGER entity_tag_links_set_updated_at BEFORE UPDATE ON entity_tag_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_tag_links IS
  'Tags de cada entidade (sem limite, sem repetição: chave primária no par). Some com a entidade (CASCADE); a tag '
  'em uso não é apagada (RESTRICT). Auditada com record_id = entity_id.';

-- Ligar só tag ativa.
CREATE FUNCTION entity_tag_links_tag_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  archived timestamptz;
BEGIN
  -- FOR SHARE: um arquivamento concorrente espera esta transação (e vice-versa).
  SELECT t.archived_at INTO archived FROM entity_tags t WHERE t.id = NEW.tag_id FOR SHARE;
  IF FOUND AND archived IS NOT NULL THEN
    RAISE EXCEPTION 'entity_tag_links: tag % is archived and cannot be assigned', NEW.tag_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entity_tag_links_tag_active_check';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION entity_tag_links_tag_active() IS
  'Trigger de entity_tag_links: recusa ligar uma tag arquivada (23514 entity_tag_links_tag_active_check).';

CREATE TRIGGER entity_tag_links_tag_active_check BEFORE INSERT OR UPDATE OF tag_id ON entity_tag_links
  FOR EACH ROW EXECUTE FUNCTION entity_tag_links_tag_active();

-- Auditoria ------------------------------------------------------------------------------------------------------
CREATE FUNCTION entity_tag_links_audit_row() RETURNS trigger
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

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, coalesce(n ->> 'entity_id', o ->> 'entity_id')::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION entity_tag_links_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION entity_tag_links_audit_row() IS
  'Trigger de auditoria de entity_tag_links: grava com record_id = entity_id (a ligação não tem id), para atribuir e '
  'remover tags aparecerem no histórico da entidade.';

CREATE TRIGGER entity_tags_audit AFTER INSERT OR UPDATE OR DELETE ON entity_tags
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER entity_tag_links_audit AFTER INSERT OR UPDATE OR DELETE ON entity_tag_links
  FOR EACH ROW EXECUTE FUNCTION entity_tag_links_audit_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_tags, entity_tag_links TO moneyflow_app;

-- migrate:down

DROP TABLE entity_tag_links;
DROP TABLE entity_tags;
DROP FUNCTION entity_tag_links_audit_row();
DROP FUNCTION entity_tag_links_tag_active();
DROP INDEX entities_document_prefix_idx;
DROP INDEX entities_is_favorite_idx;
ALTER TABLE entities DROP COLUMN is_favorite;

DROP FUNCTION audit_write(text, text, jsonb, jsonb, text[], uuid);

CREATE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid_text text := nullif(current_setting('app.user_id', true), '');
  kind     text := nullif(current_setting('app.actor_kind', true), '');
  run_text text := nullif(current_setting('app.agent_run_id', true), '');
  uid      uuid;
BEGIN
  IF uid_text IS NOT NULL THEN
    IF uid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'audit: app.user_id % is not a uuid', uid_text
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
    END IF;
    uid := uid_text::uuid;
  END IF;
  kind := coalesce(kind, CASE WHEN uid IS NULL THEN 'system' ELSE 'human' END);
  IF kind NOT IN ('human', 'agent', 'system') OR (kind <> 'system' AND uid IS NULL) THEN
    RAISE EXCEPTION 'audit: app.actor_kind % requires app.user_id and must be human, agent or system', kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
  END IF;
  IF run_text IS NOT NULL THEN
    IF kind <> 'agent' THEN
      RAISE EXCEPTION 'audit: app.agent_run_id is only allowed with app.actor_kind = agent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
    END IF;
    IF run_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (SELECT 1 FROM public.ai_runs r WHERE r.id = run_text::uuid AND r.user_id = uid) THEN
      RAISE EXCEPTION 'audit: app.agent_run_id % is not a run started by user %', run_text, uid
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_check';
    END IF;
    run_text := lower(run_text);
  END IF;

  INSERT INTO public.audit_log (table_name, record_id, action, old_data, new_data, changed_columns,
                                user_id, actor_kind, agent_run_id, transaction_id)
  VALUES (p_table, coalesce(p_new ->> 'id', p_old ->> 'id')::uuid, p_action, p_old, p_new, p_changed,
          uid, kind, run_text, pg_current_xact_id()::text::bigint);
END
$$;

REVOKE EXECUTE ON FUNCTION audit_write(text, text, jsonb, jsonb, text[]) FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION audit_write(text, text, jsonb, jsonb, text[]) IS
  'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. Erro 23514 '
  '(audit_log_actor_check) se app.user_id não é uuid, se actor_kind é inválido, se human/agent vem sem usuário, ou se '
  'app.agent_run_id vem sem actor_kind = agent ou não é uma execução (ai_runs) do mesmo usuário.';
