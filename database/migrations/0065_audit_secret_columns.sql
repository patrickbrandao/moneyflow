-- migrate:up

-- Tarefa 159: a remoção dos segredos do audit_log vivia só em audit_row(); os onze triggers de auditoria próprios
-- (audit_row_keyed, *_audit_row) chamam audit_write direto e a contornavam. Agora:
--   * audit_secret_columns() (IMMUTABLE) é a lista única dos segredos;
--   * audit_write tira essas colunas de old_data e new_data, para qualquer trigger que grave por ela (a troca de um
--     segredo continua só em changed_columns, sem o valor);
--   * audit_row() aceita um segundo argumento, TG_ARGV[1] = colunas que ficam fora do corpo (antes e depois) e só
--     aparecem em changed_columns. mcp_servers o usa para tools_cache e instructions_cache, os caches grandes que iam
--     inteiros ao log a cada troca de nome, modo, visibilidade ou cabeçalho.

CREATE FUNCTION audit_secret_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash', 'webhook_secret_hash', 'code_hash']
$$;

COMMENT ON FUNCTION audit_secret_columns() IS
  'Colunas de segredo que nunca vão ao audit_log (old_data e new_data), qualquer que seja a tabela: audit_write as tira '
  'de tudo o que grava. Segredo novo (coluna sem SELECT para moneyflow_app) entra aqui; o pgTAP da 0065 confere que '
  'toda coluna auditada sem SELECT para a aplicação está na lista (tarefa 159).';

CREATE OR REPLACE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[],
                                       p_record_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid_text text := nullif(current_setting('app.user_id', true), '');
  kind     text := nullif(current_setting('app.actor_kind', true), '');
  run_text text := nullif(current_setting('app.agent_run_id', true), '');
  secrets  constant text[] := public.audit_secret_columns();
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
  VALUES (p_table, coalesce(p_record_id, (p_new ->> 'id')::uuid, (p_old ->> 'id')::uuid), p_action,
          p_old - secrets, p_new - secrets, p_changed, uid, kind, run_text, pg_current_xact_id()::text::bigint);
END
$$;

COMMENT ON FUNCTION audit_write(text, text, jsonb, jsonb, text[], uuid) IS
  'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. record_id = p_record_id '
  '(tabelas sem coluna id, como entity_tag_links) ou o id da linha. Tira de old_data e new_data as colunas de '
  'audit_secret_columns() (tarefa 159), para todo trigger de auditoria; a troca de um segredo fica só em p_changed. '
  'Erro 23514 (audit_log_actor_check) se app.user_id não é uuid, se actor_kind é inválido, se human/agent vem sem '
  'usuário, ou se app.agent_run_id vem sem actor_kind = agent ou não é uma execução (ai_runs) do mesmo usuário.';

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  bulky   text[] := coalesce(string_to_array(nullif(TG_ARGV[1], ''), ','), '{}');
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

  -- Os segredos saem em audit_write (audit_secret_columns); as colunas volumosas, aqui.
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o - bulky, n - bulky, changed);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION audit_row() IS
  'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Os segredos (audit_secret_columns) saem em audit_write: a troca '
  'aparece só em changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha; TG_ARGV[1] = colunas '
  'volumosas (caches) que ficam fora de old_data e new_data e só aparecem em changed_columns (tarefa 159).';

DROP TRIGGER mcp_servers_audit ON mcp_servers;
CREATE TRIGGER mcp_servers_audit AFTER INSERT OR DELETE OR UPDATE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION audit_row('tools_cache,tools_cached_at,tools_error,instructions_cache',
                                          'tools_cache,instructions_cache');

-- migrate:down

DROP TRIGGER mcp_servers_audit ON mcp_servers;
CREATE TRIGGER mcp_servers_audit AFTER INSERT OR DELETE OR UPDATE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION audit_row('tools_cache,tools_cached_at,tools_error,instructions_cache');

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  quiet   text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  secrets constant text[] := ARRAY['password', 'bot_token', 'api_key', 'secret_headers', 'token_hash',
                                   'webhook_secret_hash', 'code_hash'];
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
  'token_hash, webhook_secret_hash, code_hash): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = '
  'colunas que sozinhas não geram linha.';

CREATE OR REPLACE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[],
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

COMMENT ON FUNCTION audit_write(text, text, jsonb, jsonb, text[], uuid) IS
  'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. record_id = p_record_id '
  '(tabelas sem coluna id, como entity_tag_links) ou o id da linha. Erro 23514 (audit_log_actor_check) se '
  'app.user_id não é uuid, se actor_kind é inválido, se human/agent vem sem usuário, ou se app.agent_run_id vem sem '
  'actor_kind = agent ou não é uma execução (ai_runs) do mesmo usuário.';

DROP FUNCTION audit_secret_columns();
