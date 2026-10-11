-- migrate:up

-- Auditoria (spec 008): toda alteração em tabela de negócio vira uma linha em
-- audit_log (quem, quando, antes/depois, humano ou agente), escrita por trigger.
-- Quem age vem da configuração da transação, definida pela aplicação:
--   SELECT set_config('app.user_id', '<uuid>', true),
--          set_config('app.actor_kind', 'human' | 'agent', true),
--          set_config('app.agent_run_id', '<id da execução do agente>', true);  -- opcional
-- A aplicação só lê o log: não insere, não altera, não apaga.

CREATE TABLE audit_log (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  table_name      text        NOT NULL,
  record_id       uuid        NOT NULL,
  action          text        NOT NULL,
  old_data        jsonb,
  new_data        jsonb,
  changed_columns text[],
  user_id         uuid,
  actor_kind      text        NOT NULL,
  agent_run_id    text,
  transaction_id  bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_action_check CHECK (action IN ('insert', 'update', 'delete')),
  CONSTRAINT audit_log_data_check CHECK (
    CASE action
      WHEN 'insert' THEN old_data IS NULL AND new_data IS NOT NULL
      WHEN 'update' THEN old_data IS NOT NULL AND new_data IS NOT NULL
      WHEN 'delete' THEN old_data IS NOT NULL AND new_data IS NULL
    END
  ),
  CONSTRAINT audit_log_actor_kind_check CHECK (actor_kind IN ('human', 'agent', 'system'))
);

CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id, created_at);
CREATE INDEX audit_log_user_id_idx ON audit_log (user_id, created_at);
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at);
CREATE INDEX audit_log_transaction_id_idx ON audit_log (transaction_id);

COMMENT ON TABLE audit_log IS
  'Log de auditoria (spec 008), só leitura para a aplicação. Uma linha por INSERT/UPDATE/DELETE de tabela de negócio '
  '(UPDATE que só toca updated_at ou colunas "ruidosas" não gera linha). Sem updated_at: é append-only.';
COMMENT ON COLUMN audit_log.record_id IS 'id do registro alterado.';
COMMENT ON COLUMN audit_log.old_data IS 'Registro antes (update/delete), em JSON. Nunca contém users.password nem attachments.content.';
COMMENT ON COLUMN audit_log.new_data IS 'Registro depois (insert/update), em JSON. Nunca contém users.password nem attachments.content.';
COMMENT ON COLUMN audit_log.changed_columns IS
  'update: colunas que mudaram, exceto updated_at (inclui "password" quando a senha muda, sem o valor).';
COMMENT ON COLUMN audit_log.user_id IS
  'Usuário da configuração app.user_id da transação (sem FK: o log sobrevive ao usuário). Nulo = sistema.';
COMMENT ON COLUMN audit_log.actor_kind IS
  'app.actor_kind: human (padrão com app.user_id) ou agent (agente de IA agindo pelo usuário); system sem app.user_id (worker, migrations).';
COMMENT ON COLUMN audit_log.agent_run_id IS 'app.agent_run_id: execução do agente que fez a alteração (opcional).';
COMMENT ON COLUMN audit_log.transaction_id IS 'Transação do PostgreSQL (pg_current_xact_id): agrupa as linhas de uma mesma operação.';
COMMENT ON COLUMN audit_log.created_at IS 'Quando (início da transação).';

-- Grava uma linha (uso interno dos triggers de auditoria; a aplicação não executa).
CREATE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid_text text := nullif(current_setting('app.user_id', true), '');
  kind     text := nullif(current_setting('app.actor_kind', true), '');
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

  INSERT INTO public.audit_log (table_name, record_id, action, old_data, new_data, changed_columns,
                                user_id, actor_kind, agent_run_id, transaction_id)
  VALUES (p_table, coalesce(p_new ->> 'id', p_old ->> 'id')::uuid, p_action, p_old, p_new, p_changed,
          uid, kind, nullif(current_setting('app.agent_run_id', true), ''),
          pg_current_xact_id()::text::bigint);
END
$$;

REVOKE EXECUTE ON FUNCTION audit_write(text, text, jsonb, jsonb, text[]) FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION audit_write(text, text, jsonb, jsonb, text[]) IS
  'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. '
  'Erro 23514 (audit_log_actor_check) se app.user_id não é uuid, se actor_kind é inválido ou se human/agent vem sem usuário.';

-- Trigger genérico. TG_ARGV[0] (opcional): colunas, separadas por vírgula, que sozinhas não geram
-- linha (ex.: last_login_at). updated_at nunca gera; password nunca é gravada.
CREATE FUNCTION audit_row() RETURNS trigger
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

-- Anexos: só metadados (o conteúdo de até 20 MB nunca vai para o log).
CREATE FUNCTION attachments_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  changed text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    o := jsonb_build_object('id', OLD.id, 'file_name', OLD.file_name, 'mime_type', OLD.mime_type,
                            'size_bytes', OLD.size_bytes, 'sha256', OLD.sha256,
                            'uploaded_by_user_id', OLD.uploaded_by_user_id,
                            'created_at', OLD.created_at, 'updated_at', OLD.updated_at);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := jsonb_build_object('id', NEW.id, 'file_name', NEW.file_name, 'mime_type', NEW.mime_type,
                            'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256,
                            'uploaded_by_user_id', NEW.uploaded_by_user_id,
                            'created_at', NEW.created_at, 'updated_at', NEW.updated_at);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) k
     WHERE n -> k IS DISTINCT FROM o -> k AND k <> 'updated_at';
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed);
  RETURN NULL;
END
$$;

-- Tabelas auditadas (sessions fica de fora: é estado de login, não dado de negócio).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities', 'entity_contacts', 'entity_addresses', 'entity_bank_accounts', 'entity_pix_keys', 'entity_links',
    'caixas', 'caixa_members', 'financial_accounts', 'categories', 'caixa_hidden_categories', 'recurrence_rules',
    'titles', 'settlements', 'transfers', 'movements',
    'title_attachments', 'settlement_attachments', 'movement_attachments', 'entity_attachments',
    'nfe_documents', 'nfe_items',
    'card_invoices', 'card_purchases', 'card_invoice_items', 'card_purchase_attachments',
    'statement_csv_mappings', 'statement_imports', 'statement_lines']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
                   'FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
  END LOOP;
END
$$;

CREATE TRIGGER users_audit AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_row('last_login_at');
CREATE TRIGGER classification_rules_audit AFTER INSERT OR UPDATE OR DELETE ON classification_rules
  FOR EACH ROW EXECUTE FUNCTION audit_row('usage_count,last_used_at');
CREATE TRIGGER attachments_audit AFTER INSERT OR UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_audit_row();

-- A aplicação só lê o log.
REVOKE INSERT, UPDATE, DELETE ON audit_log FROM moneyflow_app;

-- migrate:down

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities', 'entity_contacts', 'entity_addresses', 'entity_bank_accounts', 'entity_pix_keys', 'entity_links',
    'caixas', 'caixa_members', 'financial_accounts', 'categories', 'caixa_hidden_categories', 'recurrence_rules',
    'titles', 'settlements', 'transfers', 'movements',
    'title_attachments', 'settlement_attachments', 'movement_attachments', 'entity_attachments',
    'nfe_documents', 'nfe_items',
    'card_invoices', 'card_purchases', 'card_invoice_items', 'card_purchase_attachments',
    'statement_csv_mappings', 'statement_imports', 'statement_lines',
    'users', 'classification_rules', 'attachments']
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', t || '_audit', t);
  END LOOP;
END
$$;

DROP FUNCTION attachments_audit_row();
DROP FUNCTION audit_row();
DROP FUNCTION audit_write(text, text, jsonb, jsonb, text[]);
DROP TABLE audit_log;
