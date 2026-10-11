-- migrate:up

-- Auditoria do ator agente (specs 008 e 011). Com as execuções existindo (0026), app.agent_run_id deixa de ser
-- um texto livre: quando informado, precisa ser o id (uuid) de uma execução em ai_runs acionada pelo MESMO
-- usuário de app.user_id, e só vale com app.actor_kind = agent. Assim o agente nunca grava "em nome" de outro
-- usuário nem de uma execução inventada. actor_kind = agent SEM agent_run_id continua válido: é o cliente
-- externo do servidor MCP próprio (/mcp, token pessoal), que age pelo dono do token sem execução local.
-- audit_log.agent_run_id continua text (compatível), agora sempre um uuid de ai_runs quando presente.

CREATE OR REPLACE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[])
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

COMMENT ON COLUMN audit_log.agent_run_id IS
  'app.agent_run_id: id (uuid em texto) da execução do agente (ai_runs) que fez a alteração. Nulo para humanos, sistema '
  'e para o agente externo do servidor MCP próprio (/mcp).';

-- migrate:down

CREATE OR REPLACE FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[])
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

COMMENT ON COLUMN audit_log.agent_run_id IS 'app.agent_run_id: execução do agente que fez a alteração (opcional).';
