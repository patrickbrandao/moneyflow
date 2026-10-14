--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-1.pgdg12+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: account_daily_balances(uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_daily_balances(p_account_id uuid, p_from date, p_to date) RETURNS TABLE(day date, balance_cents bigint)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'account_daily_balances: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH acc AS (
    SELECT a.id, a.opening_date, a.opening_balance_cents,
           coalesce((SELECT sum(m.amount_cents) FROM movements m
                      WHERE m.financial_account_id = a.id AND m.occurred_on < p_from), 0) AS before_cents
      FROM financial_accounts a WHERE a.id = p_account_id
  ),
  daily AS (
    SELECT m.occurred_on AS d, sum(m.amount_cents) AS delta
      FROM movements m
     WHERE m.financial_account_id = p_account_id AND m.occurred_on BETWEEN p_from AND p_to
     GROUP BY m.occurred_on
  )
  SELECT g.d::date,
         CASE WHEN g.d < acc.opening_date THEN NULL
              ELSE (acc.opening_balance_cents + acc.before_cents
                    + sum(coalesce(daily.delta, 0)) OVER (ORDER BY g.d))::bigint END
    FROM acc
    CROSS JOIN generate_series(p_from, p_to, interval '1 day') g (d)
    LEFT JOIN daily ON daily.d = g.d::date
   ORDER BY 1;
END
$$;


--
-- Name: FUNCTION account_daily_balances(p_account_id uuid, p_from date, p_to date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.account_daily_balances(p_account_id uuid, p_from date, p_to date) IS 'Saldo da conta no fim de cada dia do período (saldo inicial + movimentos até o dia, inclusive os datados no futuro); NULL antes da abertura; nenhuma linha se a conta não existe. Até 1100 dias (erro 22023).';


--
-- Name: admin_ai_provider_api_key(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_ai_provider_api_key(p_provider_id uuid, p_actor_user_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION admin_ai_provider_api_key(p_provider_id uuid, p_actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_ai_provider_api_key(p_provider_id uuid, p_actor_user_id uuid) IS 'Chave do provedor para uso INTERNO da API em ações do admin (testar conexão, listar modelos); nunca devolva o valor ao cliente. Erro 42501 se o ator não é admin ativo (ator = sessão autenticada) e P0002 se o provedor não existe.';


--
-- Name: admin_api_token_hash(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_api_token_hash(p_token_id uuid, p_actor_user_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  h text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_api_token_hash: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.token_hash INTO h FROM public.user_api_tokens t WHERE t.id = p_token_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_api_token_hash: token % not found', p_token_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN h;
END
$$;


--
-- Name: FUNCTION admin_api_token_hash(p_token_id uuid, p_actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_api_token_hash(p_token_id uuid, p_actor_user_id uuid) IS 'SHA-256 (hex) do token pessoal para o export de backup do admin (restaurado, o token continua válido). Erro 42501 se o ator não é admin ativo (ator = sessão autenticada) e P0002 se o token não existe.';


--
-- Name: admin_mcp_server_headers(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_mcp_server_headers(p_server_id uuid, p_actor_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION admin_mcp_server_headers(p_server_id uuid, p_actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_mcp_server_headers(p_server_id uuid, p_actor_user_id uuid) IS 'Cabeçalhos do servidor para uso INTERNO da API em ações do admin (testar, atualizar a lista de tools); nunca devolva ao cliente. Erro 42501 se o ator não é admin ativo e P0002 se o servidor não existe.';


--
-- Name: admin_message_destination_token(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_message_destination_token(p_destination_id uuid, p_actor_user_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_message_destination_token: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.bot_token INTO k FROM public.message_destinations d WHERE d.id = p_destination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_message_destination_token: destination % not found', p_destination_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN k;
END
$$;


--
-- Name: FUNCTION admin_message_destination_token(p_destination_id uuid, p_actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_message_destination_token(p_destination_id uuid, p_actor_user_id uuid) IS 'Bot token do destino para o export de backup do admin (única saída do token para fora do banco além do worker). Erro 42501 se o ator não é admin ativo (ator = sessão autenticada) e P0002 se o destino não existe.';


--
-- Name: admin_reveal_password(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reveal_password(target_user_id uuid, actor_user_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  pw text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users a
     WHERE a.id = actor_user_id AND a.role = 'admin' AND a.is_active
  ) THEN
    RAISE EXCEPTION 'admin_reveal_password: actor % is not an active admin', actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT u.password INTO pw FROM public.users u WHERE u.id = target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_reveal_password: user % not found', target_user_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN pw;
END
$$;


--
-- Name: FUNCTION admin_reveal_password(target_user_id uuid, actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_reveal_password(target_user_id uuid, actor_user_id uuid) IS 'Revela a senha de target_user_id se actor_user_id for admin ativo; senão erro 42501. actor_user_id vem da sessão autenticada na aplicação (o banco confia nele).';


--
-- Name: ai_agent_inferences_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_inferences_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, coalesce(n ->> 'agent_id', o ->> 'agent_id')::uuid);
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_agent_inferences_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_agent_inferences_audit_row() IS 'Trigger de auditoria de ai_agent_inferences: grava com record_id = agent_id (a linha não tem id), para as inferências aparecerem no histórico do agente.';


--
-- Name: ai_agent_inferences_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_inferences_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  caps text[];
BEGIN
  -- FOR SHARE: espera (e depois relê) uma troca de flags em andamento no provedor.
  SELECT p.capabilities INTO caps FROM ai_providers p WHERE p.id = NEW.provider_id FOR SHARE;
  IF FOUND AND NOT (NEW.capability = ANY (caps)) THEN
    RAISE EXCEPTION 'ai_agent_inferences: provider % does not have the % capability', NEW.provider_id, NEW.capability
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agent_inferences_provider_capability_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_agent_params_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_params_valid(p_params jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
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
$_$;


--
-- Name: FUNCTION ai_agent_params_valid(p_params jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_agent_params_valid(p_params jsonb) IS 'true se params é um objeto só com chaves conhecidas e valores na faixa: temperature 0–2, top_p (0,1], max_tokens 1–1000000, max_tool_iterations 1–200, thinking_budget_tokens 0–1000000, reasoning_effort minimal|low|medium|high.';


--
-- Name: ai_agent_prompt_versions_apply(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_prompt_versions_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_agents a SET system_prompt = NEW.content
   WHERE a.id = NEW.agent_id AND a.system_prompt IS DISTINCT FROM NEW.content;
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_agent_prompt_versions_apply(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_agent_prompt_versions_apply() IS 'A versão manda: copia o content da versão inserida (a última) para ai_agents.system_prompt.';


--
-- Name: ai_agent_prompt_versions_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_prompt_versions_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION ai_agent_prompt_versions_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_agent_prompt_versions_audit_row() IS 'Trigger de auditoria de ai_agent_prompt_versions: grava a linha sem content (só content_chars); o texto do prompt fica na linha de auditoria do ai_agents (system_prompt antes/depois).';


--
-- Name: ai_agent_prompt_versions_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_prompt_versions_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: ai_agent_prompt_versions_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agent_prompt_versions_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: ai_agents_prompt_version_init(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agents_prompt_version_init() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO ai_agent_prompt_versions (agent_id, content, created_by_user_id)
  SELECT a.id, a.system_prompt, a.created_by_user_id
    FROM ai_agents a
   WHERE a.id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM ai_agent_prompt_versions v WHERE v.agent_id = a.id);
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_agents_prompt_version_init(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_agents_prompt_version_init() IS 'Constraint trigger adiado (ai_agents_prompt_version_init): no COMMIT (ou em SET CONSTRAINTS … IMMEDIATE), cria a versão 1 do agente inserido com o system_prompt atual, sem nota e com o autor = created_by_user_id, se ele ainda não tem versão. Agente excluído na mesma transação: nada.';


--
-- Name: ai_agents_provider_capability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agents_provider_capability() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  caps text[];
BEGIN
  IF NEW.provider_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.provider_id IS DISTINCT FROM OLD.provider_id) THEN
    SELECT p.capabilities INTO caps FROM ai_providers p WHERE p.id = NEW.provider_id FOR SHARE;
    IF FOUND AND NOT ('text' = ANY (caps)) THEN
      RAISE EXCEPTION 'ai_agents: text provider % does not have the text capability', NEW.provider_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_agents_provider_text_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_agents_system_prompt_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_agents_system_prompt_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION ai_agents_system_prompt_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_agents_system_prompt_guard() IS 'Recusa (23514 ai_agents_system_prompt_version_check) UPDATE que deixe system_prompt diferente da última versão. Agente ainda sem versão (no meio da transação que o criou) aceita.';


--
-- Name: ai_attachment_derivatives_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_attachment_derivatives_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.attachment_id, NEW.message_id, NEW.block_index, NEW.kind, NEW.provider_id, NEW.model, NEW.voice)
     IS DISTINCT FROM (OLD.attachment_id, OLD.message_id, OLD.block_index, OLD.kind, OLD.provider_id, OLD.model, OLD.voice) THEN
    RAISE EXCEPTION 'ai_attachment_derivatives: origin, kind, provider, model and voice of derivative % are immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_attachment_derivatives_immutable_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_attachment_derivatives_release_result(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_attachment_derivatives_release_result() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.result_attachment_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR NEW.result_attachment_id IS DISTINCT FROM OLD.result_attachment_id)
     AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = OLD.result_attachment_id) THEN
    DELETE FROM attachments a WHERE a.id = OLD.result_attachment_id;
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_attachment_derivatives_release_result(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_attachment_derivatives_release_result() IS 'AFTER UPDATE OF result_attachment_id / DELETE: apaga o áudio gerado antigo se ele não aparece mais em attachment_links (excluir a conversa leva as mensagens, os derivados speech e os áudios gerados).';


--
-- Name: ai_capability_credentials(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_capability_credentials(p_agent_id uuid, p_capability text, p_actor_user_id uuid) RETURNS TABLE(provider_id uuid, kind text, base_url text, api_key text, model text, voice text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  ag  public.ai_agents;
  inf public.ai_agent_inferences;
  p   public.ai_providers;
BEGIN
  IF p_capability IS NULL OR p_capability NOT IN ('text', 'vision', 'embeddings', 'transcription', 'speech') THEN
    RAISE EXCEPTION 'ai_capability_credentials: unknown capability %', p_capability USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.is_active) THEN
    RAISE EXCEPTION 'ai_capability_credentials: actor % is not an active user', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO ag FROM public.ai_agents a WHERE a.id = p_agent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_capability_credentials: agent % not found', p_agent_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT ag.is_active OR ag.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'ai_capability_credentials: agent % is not active', p_agent_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_capability = 'text' THEN
    SELECT * INTO p FROM public.ai_providers x WHERE x.id = ag.provider_id;
  ELSE
    SELECT * INTO inf FROM public.ai_agent_inferences i WHERE i.agent_id = ag.id AND i.capability = p_capability;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ai_capability_credentials: agent % has no provider for %', p_agent_id, p_capability
        USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO p FROM public.ai_providers x WHERE x.id = inf.provider_id;
  END IF;
  IF p.id IS NULL OR NOT p.is_active OR p.archived_at IS NOT NULL OR NOT (p_capability = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_capability_credentials: provider % is not active or lacks the % capability', p.id, p_capability
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT p.id, p.kind, p.base_url, p.api_key,
         CASE WHEN p_capability = 'text' THEN ag.model ELSE coalesce(inf.model, p.default_models ->> p_capability) END,
         CASE WHEN p_capability = 'speech' THEN coalesce(inf.voice, p.default_models ->> 'speech_voice') END;
END
$$;


--
-- Name: FUNCTION ai_capability_credentials(p_agent_id uuid, p_capability text, p_actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_capability_credentials(p_agent_id uuid, p_capability text, p_actor_user_id uuid) IS 'Provedor, URL, chave, modelo e voz de uma inferência do agente (text, vision, embeddings, transcription, speech), fora ou dentro de uma execução (transcrição no upload, TTS, embedding da consulta, visão por descrição no runner). Modelo nulo da inferência = default_models do provedor (pode voltar nulo: não configurado); text = provedor e modelo do agente; voz só no speech. Erros: 22023 capacidade desconhecida; 42501 ator não é usuário ativo, agente inativo/arquivado, provedor inativo/arquivado ou sem a flag; P0002 agente inexistente ou sem provedor para a capacidade. O ator vem da sessão autenticada (na execução, o usuário dela).';


--
-- Name: ai_capability_list_valid(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_capability_list_valid(p_capabilities text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT p_capabilities IS NOT NULL
     AND coalesce(array_ndims(p_capabilities), 1) = 1
     AND array_position(p_capabilities, NULL) IS NULL
     AND p_capabilities <@ ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech']
     AND (SELECT count(DISTINCT c) FROM unnest(p_capabilities) c) = cardinality(p_capabilities)
$$;


--
-- Name: FUNCTION ai_capability_list_valid(p_capabilities text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_capability_list_valid(p_capabilities text[]) IS 'true se a lista é um subconjunto, sem nulos nem repetição, de text, vision, embeddings, transcription e speech (lista vazia vale).';


--
-- Name: ai_conversation_fork(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  src ai_conversations;
  upto integer;
  new_id uuid;
BEGIN
  SELECT c.* INTO src
    FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
   WHERE m.id = p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_conversation_fork: message % not found', p_message_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT m.seq INTO upto FROM ai_messages m WHERE m.id = p_message_id;

  INSERT INTO ai_conversations (user_id, agent_id, title, title_source, forked_from_conversation_id,
                                forked_from_message_id, screen_context, purpose)
  VALUES (p_user_id, src.agent_id, coalesce(nullif(btrim(p_title), ''), src.title),
          CASE WHEN nullif(btrim(p_title), '') IS NOT NULL THEN 'user' ELSE src.title_source END,
          src.id, p_message_id, src.screen_context - 'purpose', 'chat')
  RETURNING id INTO new_id;

  INSERT INTO ai_messages (conversation_id, seq, role, content)
  SELECT new_id, m.seq, m.role, m.content
    FROM ai_messages m
   WHERE m.conversation_id = src.id AND m.seq <= upto
   ORDER BY m.seq;
  RETURN new_id;
END
$$;


--
-- Name: FUNCTION ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text) IS 'Bifurca: cria uma conversa de p_user_id com o mesmo agente, copia as mensagens da origem até p_message_id (inclusive, mesmos seq, sem run_id; anexos religados) e devolve o id. Título = p_title ou o da origem. A cópia é sempre purpose chat (sem a chave purpose no screen_context), mesmo vinda de uma conversa de fluxo. Corte a bifurcação numa mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não existe.';


--
-- Name: ai_conversation_search(text, uuid, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_conversation_search(p_query text, p_user_id uuid DEFAULT NULL::uuid, p_include_archived boolean DEFAULT false, p_limit integer DEFAULT 50) RETURNS TABLE(conversation_id uuid, user_id uuid, title text, last_message_at timestamp with time zone, score real, message_id uuid, snippet text)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  q   text := btrim(coalesce(p_query, ''));
  tsq tsquery;
BEGIN
  IF q = '' OR length(q) > 500 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ai_conversation_search: query must have 1..500 characters and limit 1..500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  tsq := websearch_to_tsquery('portuguese', q);

  RETURN QUERY
  WITH hits AS (
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.id AS message_id, m.content,
           ts_rank(m.search_tsv, tsq) AS rank
      FROM ai_messages m
      JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE numnode(tsq) > 0 AND m.search_tsv @@ tsq
       AND (p_user_id IS NULL OR c.user_id = p_user_id)
       AND (p_include_archived OR c.archived_at IS NULL)
     ORDER BY m.conversation_id, ts_rank(m.search_tsv, tsq) DESC, m.seq DESC
  )
  SELECT c.id, c.user_id, c.title, c.last_message_at,
         greatest(coalesce(similarity(c.title, q), 0), coalesce(h.rank, 0))::real AS score,
         h.message_id,
         CASE WHEN h.message_id IS NOT NULL
              THEN ts_headline('portuguese', ai_message_text(h.content), tsq,
                               'MaxFragments=1, MaxWords=24, MinWords=8, StartSel=«, StopSel=»') END
    FROM ai_conversations c
    LEFT JOIN hits h ON h.conversation_id = c.id
   WHERE (p_user_id IS NULL OR c.user_id = p_user_id)
     AND (p_include_archived OR c.archived_at IS NULL)
     AND (h.conversation_id IS NOT NULL
          OR c.title ILIKE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
          OR c.title % q)
   ORDER BY 5 DESC, c.last_message_at DESC NULLS LAST, c.id
   LIMIT p_limit;
END
$$;


--
-- Name: FUNCTION ai_conversation_search(p_query text, p_user_id uuid, p_include_archived boolean, p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_conversation_search(p_query text, p_user_id uuid, p_include_archived boolean, p_limit integer) IS 'Busca conversas pelo título (trigram: contém ou parecido) e pelo texto das mensagens (full-text em português, sintaxe de websearch: "frase", -excluir, OR). p_user_id nulo = de todos (só para admin; a aplicação aplica). Devolve a melhor mensagem e um trecho com o termo entre « ». Erro 22023 se a busca é vazia/longa ou o limite inválido.';


--
-- Name: ai_conversations_purpose_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_conversations_purpose_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'ai_conversations: purpose of conversation % is immutable', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_conversations_purpose_immutable_check';
END
$$;


--
-- Name: ai_embedding_credentials(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_embedding_credentials(p_provider_id uuid) RETURNS TABLE(provider_id uuid, kind text, base_url text, api_key text, default_model text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  p public.ai_providers;
BEGIN
  SELECT * INTO p FROM public.ai_providers x WHERE x.id = p_provider_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_embedding_credentials: provider % not found', p_provider_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT p.is_active OR p.archived_at IS NOT NULL OR NOT ('embeddings' = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_embedding_credentials: provider % is not active or lacks the embeddings capability', p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, p.default_models ->> 'embeddings';
END
$$;


--
-- Name: FUNCTION ai_embedding_credentials(p_provider_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_embedding_credentials(p_provider_id uuid) IS 'Worker (indexação de um par): tipo, URL, chave e modelo padrão de embeddings do provedor. Erro 42501 se o provedor está inativo, arquivado ou sem a flag embeddings; P0002 se não existe. Use o modelo do par, não o padrão, quando forem diferentes.';


--
-- Name: ai_embedding_indexes_purge(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_embedding_indexes_purge(p_idle interval DEFAULT '7 days'::interval) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
  n bigint;
BEGIN
  IF p_idle IS NULL OR p_idle < interval '1 hour' THEN
    RAISE EXCEPTION 'ai_embedding_indexes_purge: idle interval must be at least 1 hour'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Os vetores primeiro (para contar), depois os pares (a FK levaria os vetores de qualquer jeito).
  WITH gone AS (
    DELETE FROM ai_embeddings e USING ai_embedding_indexes x
     WHERE e.provider_id = x.provider_id AND e.model = x.model
       AND x.last_in_use_at < now() - p_idle
       AND NOT EXISTS (SELECT 1 FROM ai_embedding_pairs_in_use u WHERE u.provider_id = x.provider_id AND u.model = x.model)
    RETURNING 1
  )
  SELECT count(*) INTO n FROM gone;
  DELETE FROM ai_embedding_indexes x
   WHERE x.last_in_use_at < now() - p_idle
     AND NOT EXISTS (SELECT 1 FROM ai_embedding_pairs_in_use u WHERE u.provider_id = x.provider_id AND u.model = x.model);
  RETURN n;
END
$$;


--
-- Name: FUNCTION ai_embedding_indexes_purge(p_idle interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_embedding_indexes_purge(p_idle interval) IS 'Worker: apaga os pares fora de uso cujo last_in_use_at é mais velho que p_idle (padrão 7 dias), com os vetores, e devolve quantos vetores saíram. Erro 22023 com p_idle nulo ou menor que 1 hora.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_embedding_indexes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_embedding_indexes (
    provider_id uuid NOT NULL,
    model text NOT NULL,
    last_in_use_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_embedding_indexes_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text))
);


--
-- Name: TABLE ai_embedding_indexes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_embedding_indexes IS 'Um índice de embeddings por par (provedor, modelo) (spec 024). O worker registra os pares em uso a cada ciclo (ai_embedding_indexes_touch) e apaga os parados há mais de 7 dias com os vetores (ai_embedding_indexes_purge). Todo vetor pertence a um par registrado (FK; registre antes de gravar). Estado operacional: fora da auditoria e do backup.';


--
-- Name: COLUMN ai_embedding_indexes.last_in_use_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embedding_indexes.last_in_use_at IS 'Última vez em que algum agente ativo usava o par.';


--
-- Name: ai_embedding_indexes_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_embedding_indexes_touch() RETURNS SETOF public.ai_embedding_indexes
    LANGUAGE sql
    AS $$
  INSERT INTO ai_embedding_indexes AS x (provider_id, model, last_in_use_at)
  SELECT u.provider_id, u.model, now() FROM ai_embedding_pairs_in_use u
  ON CONFLICT (provider_id, model) DO UPDATE SET last_in_use_at = excluded.last_in_use_at
  RETURNING x.*
$$;


--
-- Name: FUNCTION ai_embedding_indexes_touch(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_embedding_indexes_touch() IS 'Worker, a cada ciclo: registra os pares em uso (ai_embedding_pairs_in_use) com last_in_use_at = agora e os devolve (o que indexar). Rode antes de gravar vetores de um par novo (a FK de ai_embeddings exige o par).';


--
-- Name: ai_embedding_store(uuid, text, public.vector); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_embedding_store(p_embedding_id uuid, p_source_hash text, p_embedding public.vector) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_embeddings e
     SET embedding = p_embedding, embedded_hash = p_source_hash, embedded_at = clock_timestamp()
   WHERE e.id = p_embedding_id AND e.source_hash = p_source_hash;
  RETURN FOUND;
END
$$;


--
-- Name: FUNCTION ai_embedding_store(p_embedding_id uuid, p_source_hash text, p_embedding public.vector); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_embedding_store(p_embedding_id uuid, p_source_hash text, p_embedding public.vector) IS 'Worker: grava o vetor calculado para o texto de hash p_source_hash (lido junto com source_text). Se o texto mudou nesse meio-tempo, não grava e devolve false (a linha continua em needs_reindex).';


--
-- Name: ai_embeddings_purge_orphans(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_embeddings_purge_orphans() RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM ai_embeddings e
   WHERE NOT CASE e.object_type
     WHEN 'entity' THEN EXISTS (SELECT 1 FROM entities x WHERE x.id = e.object_id)
     WHEN 'caixa' THEN EXISTS (SELECT 1 FROM caixas x WHERE x.id = e.object_id)
     WHEN 'financial_account' THEN EXISTS (SELECT 1 FROM financial_accounts x WHERE x.id = e.object_id)
     WHEN 'category' THEN EXISTS (SELECT 1 FROM categories x WHERE x.id = e.object_id)
     WHEN 'title' THEN EXISTS (SELECT 1 FROM titles x WHERE x.id = e.object_id)
     WHEN 'card_purchase' THEN EXISTS (SELECT 1 FROM card_purchases x WHERE x.id = e.object_id)
     WHEN 'statement_line' THEN EXISTS (SELECT 1 FROM statement_lines x WHERE x.id = e.object_id)
     WHEN 'nfe_document' THEN EXISTS (SELECT 1 FROM nfe_documents x WHERE x.id = e.object_id)
     WHEN 'attachment' THEN EXISTS (SELECT 1 FROM attachments x WHERE x.id = e.object_id)
     WHEN 'classification_rule' THEN EXISTS (SELECT 1 FROM classification_rules x WHERE x.id = e.object_id)
     ELSE false
   END;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;


--
-- Name: FUNCTION ai_embeddings_purge_orphans(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_embeddings_purge_orphans() IS 'Apaga os embeddings cujo objeto não existe mais e devolve quantos. O worker chama periodicamente (ou a aplicação apaga o embedding na mesma transação em que exclui o objeto).';


--
-- Name: ai_embeddings_search(public.vector, uuid, text, uuid[], text[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_embeddings_search(p_query public.vector, p_provider_id uuid, p_model text, p_caixa_ids uuid[], p_object_types text[] DEFAULT NULL::text[], p_limit integer DEFAULT 20) RETURNS TABLE(object_type text, object_id uuid, caixa_id uuid, source_text text, distance double precision)
    LANGUAGE plpgsql STABLE
    SET "hnsw.iterative_scan" TO 'relaxed_order'
    AS $$
BEGIN
  IF p_query IS NULL OR p_provider_id IS NULL OR p_model IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'ai_embeddings_search: query vector, provider, model and limit 1..200 are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Vários pares no mesmo HNSW: com o filtro depois do índice, a varredura iterativa continua até achar p_limit
  -- linhas do par; relaxed_order pode devolver fora de ordem, então reordena por fora. O "+ 0" impede o planejador
  -- (PostgreSQL 17+) de reaproveitar a ordem declarada pela CTE e pular a ordenação.
  RETURN QUERY
  WITH nearest AS MATERIALIZED (
    SELECT e.object_type AS o_type, e.object_id AS o_id, e.caixa_id AS c_id, e.source_text AS s_text,
           (e.embedding <=> p_query)::double precision AS dist
      FROM ai_embeddings e
     WHERE e.provider_id = p_provider_id AND e.model = p_model AND e.embedding IS NOT NULL
       AND (e.caixa_id IS NULL OR e.caixa_id = ANY (coalesce(p_caixa_ids, '{}')))
       AND (p_object_types IS NULL OR e.object_type = ANY (p_object_types))
     ORDER BY e.embedding <=> p_query
     LIMIT p_limit
  )
  SELECT n.o_type, n.o_id, n.c_id, n.s_text, n.dist FROM nearest n ORDER BY n.dist + 0, n.o_type, n.o_id;
END
$$;


--
-- Name: FUNCTION ai_embeddings_search(p_query public.vector, p_provider_id uuid, p_model text, p_caixa_ids uuid[], p_object_types text[], p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_embeddings_search(p_query public.vector, p_provider_id uuid, p_model text, p_caixa_ids uuid[], p_object_types text[], p_limit integer) IS 'Vizinhos mais próximos (distância de cosseno, menor = mais parecido) do vetor de consulta, no mesmo par (provedor, modelo), só de objetos globais (caixa_id nulo) ou das caixas listadas (as que o usuário lê), opcionalmente por tipos. Roda com hnsw.iterative_scan = relaxed_order (o filtro do par não derruba resultados) e reordena. Vetores velhos (needs_reindex) ainda entram. Erro 22023 sem vetor/provedor/modelo ou com limite fora de 1..200.';


--
-- Name: ai_legacy_tool_registry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_legacy_tool_registry() RETURNS TABLE(tool_name text, kind text, confirm text)
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
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


--
-- Name: FUNCTION ai_legacy_tool_registry(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_legacy_tool_registry() IS 'Retrato FIXO do registro de tools da v0.1.7 (packages/shared/src/agents/tools.ts): 49 tools, 25 read e 24 write, com o confirm de cada uma (never|agent|always). Usado pela migração de enabled_tools/require_write_confirmation para kits (0038) e para a aplicação conferir o retrato contra AGENT_TOOLS. Não acompanha o registro: tools novas não entram aqui.';


--
-- Name: ai_message_content_valid(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_message_content_valid(p_role text, p_content jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
DECLARE
  b jsonb;
  t text;
BEGIN
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'array' OR jsonb_array_length(p_content) NOT BETWEEN 1 AND 1000 THEN
    RETURN false;
  END IF;
  FOR b IN SELECT * FROM jsonb_array_elements(p_content) LOOP
    IF jsonb_typeof(b) <> 'object' OR jsonb_typeof(b -> 'type') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    t := b ->> 'type';
    IF NOT (CASE p_role
              WHEN 'user' THEN t IN ('text', 'attachment')
              WHEN 'assistant' THEN t IN ('text', 'thinking', 'redacted_thinking', 'tool_use')
              WHEN 'tool' THEN t = 'tool_result'
              ELSE false
            END) THEN
      RETURN false;
    END IF;
    IF (t = 'text' AND jsonb_typeof(b -> 'text') IS DISTINCT FROM 'string')
       OR (t = 'attachment' AND ((b ->> 'attachment_id') IS NULL OR (b ->> 'attachment_id') !~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
       OR (t = 'tool_use' AND (jsonb_typeof(b -> 'id') IS DISTINCT FROM 'string'
                               OR jsonb_typeof(b -> 'name') IS DISTINCT FROM 'string'
                               OR jsonb_typeof(b -> 'input') IS DISTINCT FROM 'object'))
       OR (t = 'tool_result' AND (jsonb_typeof(b -> 'tool_use_id') IS DISTINCT FROM 'string'
                                  OR NOT b ? 'content'
                                  OR (b ? 'is_error' AND jsonb_typeof(b -> 'is_error') <> 'boolean'))) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$_$;


--
-- Name: FUNCTION ai_message_content_valid(p_role text, p_content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_message_content_valid(p_role text, p_content jsonb) IS 'true se content é um array de 1–1000 blocos válidos para o papel: user = text|attachment; assistant = text|thinking|redacted_thinking|tool_use; tool = tool_result. Campos obrigatórios por tipo (ver a migration 0026).';


--
-- Name: ai_message_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_message_text(p_content jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN jsonb_typeof(p_content) = 'array' THEN
           (SELECT coalesce(string_agg(b ->> 'text', E'\n' ORDER BY ord), '')
              FROM jsonb_array_elements(p_content) WITH ORDINALITY x (b, ord)
             WHERE jsonb_typeof(b) = 'object' AND b ->> 'type' = 'text')
         ELSE '' END
$$;


--
-- Name: FUNCTION ai_message_text(p_content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_message_text(p_content jsonb) IS 'Texto dos blocos text de uma mensagem, unidos por quebra de linha (base da busca full-text).';


--
-- Name: ai_messages_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_messages_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_conversations c
     SET last_message_at = greatest(coalesce(c.last_message_at, NEW.created_at), NEW.created_at)
   WHERE c.id = NEW.conversation_id;
  INSERT INTO ai_message_attachments (message_id, attachment_id)
  SELECT DISTINCT NEW.id, (b ->> 'attachment_id')::uuid
    FROM jsonb_array_elements(NEW.content) b
   WHERE b ->> 'type' = 'attachment'
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;


--
-- Name: ai_messages_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_messages_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM 1 FROM ai_conversations c WHERE c.id = NEW.conversation_id FOR NO KEY UPDATE;
  IF NEW.seq IS NULL THEN
    SELECT coalesce(max(m.seq), 0) + 1 INTO NEW.seq FROM ai_messages m WHERE m.conversation_id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_messages_validate_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_messages_validate_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.conversation_id <> OLD.conversation_id OR NEW.seq <> OLD.seq OR NEW.role <> OLD.role
     OR NEW.content <> OLD.content OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ai_messages: message % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_messages_immutable_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_model_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_model_prices (
    id uuid DEFAULT uuidv7() NOT NULL,
    provider_id uuid NOT NULL,
    model text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    input_price_per_million numeric(14,6) NOT NULL,
    output_price_per_million numeric(14,6) NOT NULL,
    cache_write_price_per_million numeric(14,6),
    cache_read_price_per_million numeric(14,6),
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    audio_input_per_minute numeric(14,6),
    speech_per_million_chars numeric(14,6),
    CONSTRAINT ai_model_prices_audio_values_check CHECK (((audio_input_per_minute >= (0)::numeric) AND (speech_per_million_chars >= (0)::numeric))),
    CONSTRAINT ai_model_prices_currency_check CHECK ((currency = ANY (ARRAY['USD'::text, 'BRL'::text]))),
    CONSTRAINT ai_model_prices_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_model_prices_values_check CHECK (((input_price_per_million >= (0)::numeric) AND (output_price_per_million >= (0)::numeric) AND (cache_write_price_per_million >= (0)::numeric) AND (cache_read_price_per_million >= (0)::numeric)))
);


--
-- Name: TABLE ai_model_prices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_model_prices IS 'Tabela de preços por provedor e modelo, com vigência (valid_from): o preço de um instante é a linha mais recente com valid_from <= instante (ai_model_price_at). Só para custo ESTIMADO (spec 011: medição, sem teto). Preço novo = linha nova.';


--
-- Name: COLUMN ai_model_prices.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.model IS 'Nome exato do modelo na API (ex.: claude-sonnet-4-5, gpt-4.1-mini).';


--
-- Name: COLUMN ai_model_prices.currency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.currency IS 'Moeda da tabela do provedor: USD (padrão, como as APIs cobram) ou BRL.';


--
-- Name: COLUMN ai_model_prices.input_price_per_million; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.input_price_per_million IS 'Preço por 1 milhão de tokens de entrada (sem cache), na moeda da linha.';


--
-- Name: COLUMN ai_model_prices.output_price_per_million; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.output_price_per_million IS 'Preço por 1 milhão de tokens de saída.';


--
-- Name: COLUMN ai_model_prices.cache_write_price_per_million; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.cache_write_price_per_million IS 'Preço por 1 milhão de tokens gravados no cache de prompt. Nulo = preço de entrada.';


--
-- Name: COLUMN ai_model_prices.cache_read_price_per_million; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.cache_read_price_per_million IS 'Preço por 1 milhão de tokens lidos do cache de prompt. Nulo = preço de entrada.';


--
-- Name: COLUMN ai_model_prices.valid_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.valid_from IS 'Início da vigência deste preço.';


--
-- Name: COLUMN ai_model_prices.audio_input_per_minute; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.audio_input_per_minute IS 'Preço por minuto de áudio transcrito, para os modelos cobrados assim (ex.: whisper-1). Nulo = não cobra por minuto.';


--
-- Name: COLUMN ai_model_prices.speech_per_million_chars; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_model_prices.speech_per_million_chars IS 'Preço por 1 milhão de caracteres convertidos em fala, para os modelos cobrados assim (ex.: tts-1). Nulo = não cobra por caractere.';


--
-- Name: ai_model_price_at(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_model_price_at(p_provider_id uuid, p_model text, p_at timestamp with time zone DEFAULT now()) RETURNS public.ai_model_prices
    LANGUAGE sql STABLE
    AS $$
  SELECT p.* FROM ai_model_prices p
   WHERE p.provider_id = p_provider_id AND p.model = p_model AND p.valid_from <= p_at
   ORDER BY p.valid_from DESC
   LIMIT 1
$$;


--
-- Name: FUNCTION ai_model_price_at(p_provider_id uuid, p_model text, p_at timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_model_price_at(p_provider_id uuid, p_model text, p_at timestamp with time zone) IS 'Preço vigente do modelo no instante (linha mais recente com valid_from <= p_at); todos os campos nulos se não há preço.';


--
-- Name: ai_provider_default_models_valid(text[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_provider_default_models_valid(p_capabilities text[], p_models jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF p_models IS NULL OR jsonb_typeof(p_models) <> 'object' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_models) LOOP
    IF jsonb_typeof(v) <> 'string' THEN
      RETURN false;
    END IF;
    IF k = 'speech_voice' THEN
      IF NOT ('speech' = ANY (coalesce(p_capabilities, '{}'))) OR v #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
        RETURN false;
      END IF;
    ELSIF k IN ('text', 'vision', 'embeddings', 'transcription', 'speech') THEN
      IF NOT (k = ANY (coalesce(p_capabilities, '{}'))) OR v #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$' THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$_$;


--
-- Name: FUNCTION ai_provider_default_models_valid(p_capabilities text[], p_models jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_provider_default_models_valid(p_capabilities text[], p_models jsonb) IS 'true se default_models é um objeto só com as chaves text, vision, embeddings, transcription, speech (nome de modelo) e speech_voice (nome de voz, até 64), cada uma só com a capacidade ligada (speech_voice com speech). Nenhuma chave é obrigatória aqui; o modelo de texto do Anthropic compatível é exigido por ai_providers_validate.';


--
-- Name: ai_provider_health(integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_provider_health(p_days integer DEFAULT 7, p_provider_id uuid DEFAULT NULL::uuid) RETURNS TABLE(provider_id uuid, model text, requests integer, ok integer, errors integer, canceled integer, error_rate numeric, p50_ms integer, p95_ms integer, p50_first_byte_ms integer, p95_first_byte_ms integer, avg_attempts numeric, last_error_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'ai_provider_health: days must be between 1 and 365' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT r.provider_id,
         r.model,
         count(*)::integer,
         count(*) FILTER (WHERE r.status = 'ok')::integer,
         count(*) FILTER (WHERE r.status = 'error')::integer,
         count(*) FILTER (WHERE r.status = 'canceled')::integer,
         round(count(*) FILTER (WHERE r.status = 'error')::numeric
               / nullif(count(*) FILTER (WHERE r.status IN ('ok', 'error')), 0), 4),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.first_byte_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.first_byte_ms) FILTER (WHERE r.status = 'ok'))::integer,
         round(avg(r.attempts), 2),
         max(r.finished_at) FILTER (WHERE r.status = 'error')
    FROM ai_requests r
   WHERE r.status <> 'running'
     AND r.started_at >= now() - make_interval(days => p_days)
     AND (p_provider_id IS NULL OR r.provider_id = p_provider_id)
   GROUP BY r.provider_id, r.model
   ORDER BY r.provider_id NULLS LAST, r.model NULLS LAST;
END
$$;


--
-- Name: FUNCTION ai_provider_health(p_days integer, p_provider_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_provider_health(p_days integer, p_provider_id uuid) IS 'Saúde por provedor e modelo nos últimos p_days dias (1–365, padrão 7; senão 22023), só requisições terminadas, de um provedor (p_provider_id) ou de todos: requests, ok, errors, canceled; error_rate = erros ÷ (ok + erros), sem as canceladas (nula sem nenhuma); p50/p95 da duração e do primeiro byte das que deram certo (ms); média de tentativas; último erro. provider_id nulo = provedor não salvo ou excluído; model nulo = sem modelo (listar modelos).';


--
-- Name: ai_providers_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_providers_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  all_caps constant text[] := ARRAY['text', 'vision', 'embeddings', 'transcription', 'speech'];
  removed text[];
  names   text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.capabilities := coalesce(NEW.capabilities,
                                 CASE WHEN NEW.kind = 'anthropic' THEN ARRAY['text', 'vision'] ELSE all_caps END);
    NEW.prompt_cache_enabled := coalesce(NEW.prompt_cache_enabled, NEW.base_url IS NULL);
    NEW.thinking_enabled := coalesce(NEW.thinking_enabled, NEW.base_url IS NULL);
  END IF;

  -- Ordem canônica (a lista inválida fica como veio, para o CHECK recusar).
  IF ai_capability_list_valid(NEW.capabilities) THEN
    NEW.capabilities := ARRAY(SELECT c FROM unnest(all_caps) WITH ORDINALITY x (c, o)
                               WHERE c = ANY (NEW.capabilities) ORDER BY o);
  END IF;

  -- Anthropic compatível: modelo de texto padrão obrigatório. Conferido quando algo que o afeta muda, para um
  -- provedor antigo sem o modelo ainda poder ser ativado, desativado ou arquivado.
  IF NEW.kind = 'anthropic' AND NEW.base_url IS NOT NULL AND 'text' = ANY (NEW.capabilities)
     AND NOT (NEW.default_models ? 'text')
     AND (TG_OP = 'INSERT' OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.base_url IS DISTINCT FROM OLD.base_url
          OR NEW.capabilities IS DISTINCT FROM OLD.capabilities OR NEW.default_models IS DISTINCT FROM OLD.default_models) THEN
    RAISE EXCEPTION 'ai_providers: an Anthropic-compatible provider (base_url) needs a default text model'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_providers_text_model_check';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    removed := ARRAY(SELECT unnest(OLD.capabilities) EXCEPT SELECT unnest(coalesce(NEW.capabilities, '{}')));
    IF cardinality(removed) > 0 THEN
      SELECT string_agg(DISTINCT x.name, ', ' ORDER BY x.name) INTO names
        FROM (SELECT a.name FROM ai_agents a
               WHERE 'text' = ANY (removed) AND a.provider_id = NEW.id
              UNION ALL
              SELECT a.name FROM ai_agent_inferences i JOIN ai_agents a ON a.id = i.agent_id
               WHERE i.provider_id = NEW.id AND i.capability = ANY (removed)) x;
      IF names IS NOT NULL THEN
        RAISE EXCEPTION 'ai_providers: capability removed from provider % is in use by agents: %', NEW.id, names
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_providers_capability_in_use_check', DETAIL = names;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION ai_providers_validate(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_providers_validate() IS 'BEFORE INSERT/UPDATE de ai_providers: preenche capabilities, prompt_cache_enabled e thinking_enabled omitidos no INSERT (pelo tipo e pela base_url), põe as flags em ordem canônica, exige default_models.text no Anthropic compatível (ai_providers_text_model_check) e recusa tirar uma flag em uso por algum agente, arquivado inclusive (ai_providers_capability_in_use_check; os nomes dos agentes vão no DETAIL).';


--
-- Name: ai_request_attempts_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_request_attempts_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_requests r
     SET attempts = (SELECT count(*) FROM ai_request_attempts a WHERE a.request_id = NEW.request_id)
   WHERE r.id = NEW.request_id;
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_request_attempts_after_insert(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_request_attempts_after_insert() IS 'Mantém ai_requests.attempts = número de tentativas gravadas.';


--
-- Name: ai_request_attempts_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_request_attempts_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  logging boolean;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.response_body IS DISTINCT FROM OLD.response_body THEN
    SELECT p.log_bodies INTO logging
      FROM ai_requests r JOIN ai_providers p ON p.id = r.provider_id
     WHERE r.id = NEW.request_id;
    IF NOT coalesce(logging, false) THEN
      NEW.response_body := NULL;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.rate_limit_headers IS DISTINCT FROM OLD.rate_limit_headers THEN
    NEW.rate_limit_headers := ai_request_headers_redact(NEW.rate_limit_headers);
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION ai_request_attempts_before_write(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_request_attempts_before_write() IS 'Descarta o corpo da resposta de erro sem log_bodies e omite credenciais nos cabeçalhos guardados.';


--
-- Name: ai_request_headers_redact(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_request_headers_redact(p_headers jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
           WHEN p_headers IS NULL OR jsonb_typeof(p_headers) <> 'object' THEN p_headers
           ELSE coalesce((SELECT jsonb_object_agg(h.key,
                                                  CASE WHEN lower(h.key) = ANY (ARRAY['authorization', 'proxy-authorization',
                                                                                      'x-api-key', 'api-key',
                                                                                      'openai-organization', 'openai-project',
                                                                                      'cookie', 'set-cookie'])
                                                       THEN to_jsonb('[omitido]'::text)
                                                       ELSE h.value END)
                            FROM jsonb_each(p_headers) h), '{}'::jsonb)
         END
$$;


--
-- Name: FUNCTION ai_request_headers_redact(p_headers jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_request_headers_redact(p_headers jsonb) IS 'Rede de segurança: troca por "[omitido]" o valor dos cabeçalhos de credencial (authorization, proxy-authorization, x-api-key, api-key, openai-organization, openai-project, cookie, set-cookie; sem distinção de maiúsculas). A aplicação omite antes de gravar (inclusive os anthropic-* de credencial); o banco repete nas colunas de cabeçalho.';


--
-- Name: ai_requests_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_requests_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  r       ai_runs;
  cp      text;
  logging boolean;
  o       jsonb;
  n       jsonb;
  k       text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.attempts := 0;
    IF NEW.run_id IS NOT NULL THEN
      SELECT * INTO r FROM ai_runs x WHERE x.id = NEW.run_id;
      IF FOUND THEN
        NEW.conversation_id := coalesce(NEW.conversation_id, r.conversation_id);
        NEW.user_id := coalesce(NEW.user_id, r.user_id);
        NEW.agent_id := coalesce(NEW.agent_id, r.agent_id);
        NEW.provider_id := coalesce(NEW.provider_id, r.provider_id);
        NEW.model := coalesce(NEW.model, r.model);
        IF NEW.conversation_id <> r.conversation_id THEN
          RAISE EXCEPTION 'ai_requests: run % belongs to another conversation', NEW.run_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_links_check';
        END IF;
      END IF;
    END IF;
    IF NEW.purpose = 'chat' AND NEW.conversation_id IS NOT NULL THEN
      SELECT c.purpose INTO cp FROM ai_conversations c WHERE c.id = NEW.conversation_id;
      NEW.purpose := coalesce(cp, NEW.purpose);
    END IF;
  END IF;

  -- Cabeçalhos e corpos só com log_bodies (o que chega com a flag desligada é descartado).
  SELECT p.log_bodies INTO logging FROM ai_providers p WHERE p.id = NEW.provider_id;
  IF NOT coalesce(logging, false) THEN
    IF TG_OP = 'INSERT' OR NEW.request_headers IS DISTINCT FROM OLD.request_headers THEN NEW.request_headers := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.request_body IS DISTINCT FROM OLD.request_body THEN NEW.request_body := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.response_headers IS DISTINCT FROM OLD.response_headers THEN NEW.response_headers := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.response_body IS DISTINCT FROM OLD.response_body THEN NEW.response_body := NULL; END IF;
    IF TG_OP = 'INSERT' OR NEW.response_stream IS DISTINCT FROM OLD.response_stream THEN NEW.response_stream := NULL; END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.request_headers IS DISTINCT FROM OLD.request_headers THEN
    NEW.request_headers := ai_request_headers_redact(NEW.request_headers);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.response_headers IS DISTINCT FROM OLD.response_headers THEN
    NEW.response_headers := ai_request_headers_redact(NEW.response_headers);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD) - 'duration_ms';
    n := to_jsonb(NEW) - 'duration_ms';
    -- As FKs só mudam para nulo (ON DELETE SET NULL).
    FOREACH k IN ARRAY ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id'] LOOP
      IF n -> k IS DISTINCT FROM o -> k AND n ->> k IS NOT NULL THEN
        RAISE EXCEPTION 'ai_requests: % of request % changes only to null', k, OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_immutable_check';
      END IF;
    END LOOP;
    o := o - ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id', 'attempts', 'updated_at'];
    n := n - ARRAY['provider_id', 'agent_id', 'user_id', 'conversation_id', 'run_id', 'attempts', 'updated_at'];
    IF OLD.status = 'running' THEN
      -- Em andamento: o que identifica a chamada não muda.
      o := jsonb_build_object('id', o -> 'id', 'operation', o -> 'operation', 'purpose', o -> 'purpose',
                              'model', o -> 'model', 'method', o -> 'method', 'path', o -> 'path',
                              'streaming', o -> 'streaming', 'started_at', o -> 'started_at', 'created_at', o -> 'created_at');
      n := jsonb_build_object('id', n -> 'id', 'operation', n -> 'operation', 'purpose', n -> 'purpose',
                              'model', n -> 'model', 'method', n -> 'method', 'path', n -> 'path',
                              'streaming', n -> 'streaming', 'started_at', n -> 'started_at', 'created_at', n -> 'created_at');
    END IF;
    IF o IS DISTINCT FROM n THEN
      RAISE EXCEPTION 'ai_requests: request % is immutable (%)', OLD.id,
        CASE WHEN OLD.status = 'running' THEN 'identity' ELSE 'finished' END
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_immutable_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION ai_requests_before_write(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_requests_before_write() IS 'INSERT: tentativas = 0, completa os vínculos pela execução (ai_requests_links_check) e chat numa conversa de fluxo vira a finalidade dela. INSERT/UPDATE: descarta cabeçalhos e corpos gravados com log_bodies desligado (ou sem provedor) e omite as credenciais dos cabeçalhos. UPDATE (23514 ai_requests_immutable_check): FKs só viram nulas; em running, id, operação, finalidade, modelo, método, caminho, streaming e início não mudam; terminada, nada muda além das FKs anuladas e do contador de tentativas.';


--
-- Name: ai_requests_purge(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_requests_purge(p_days integer, p_limit integer DEFAULT 1000) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  n integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'ai_requests_purge: days must be >= 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'ai_requests_purge: limit must be between 1 and 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH doomed AS (
    SELECT r.id FROM public.ai_requests r
     WHERE r.started_at < clock_timestamp() - make_interval(days => p_days)
     ORDER BY r.started_at, r.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.ai_requests r USING doomed d WHERE r.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;


--
-- Name: FUNCTION ai_requests_purge(p_days integer, p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_requests_purge(p_days integer, p_limit integer) IS 'Retenção (spec 023): apaga até p_limit (padrão 1000, máx. 100000) requisições iniciadas há mais de p_days dias, as mais velhas primeiro (com as tentativas, em CASCADE; o ai_usage fica com request_id nulo), e devolve quantas. O worker chama em lotes até devolver menos que o limite; p_days = app_settings ai.request_retention_days ou, sem ele, AI_REQUEST_RETENTION_DAYS. Erro 22023 com dias < 1 ou limite fora da faixa. Pula linhas travadas.';


--
-- Name: ai_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_runs (
    id uuid DEFAULT uuidv7() NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    model text NOT NULL,
    trigger_message_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    cancel_requested_at timestamp with time zone,
    locked_at timestamp with time zone,
    lock_token uuid,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 3 NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_event_seq integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cost_micros bigint DEFAULT 0 NOT NULL,
    cost_currency text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_runs_attempts_check CHECK ((((max_attempts >= 1) AND (max_attempts <= 20)) AND ((attempts >= 0) AND (attempts <= max_attempts)))),
    CONSTRAINT ai_runs_cost_currency_check CHECK ((cost_currency = ANY (ARRAY['USD'::text, 'BRL'::text]))),
    CONSTRAINT ai_runs_error_check CHECK ((length(error) <= 4000)),
    CONSTRAINT ai_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_confirmation'::text, 'completed'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT ai_runs_status_fields_check CHECK ((((status = 'running'::text) = (locked_at IS NOT NULL)) AND ((status = 'running'::text) = (lock_token IS NOT NULL)) AND ((status = ANY (ARRAY['completed'::text, 'failed'::text, 'canceled'::text])) = (finished_at IS NOT NULL)) AND ((status <> 'failed'::text) OR (error IS NOT NULL)) AND ((status <> ALL (ARRAY['running'::text, 'awaiting_confirmation'::text, 'completed'::text])) OR (started_at IS NOT NULL)))),
    CONSTRAINT ai_runs_usage_check CHECK (((last_event_seq >= 0) AND (input_tokens >= 0) AND (output_tokens >= 0) AND (cache_write_tokens >= 0) AND (cache_read_tokens >= 0) AND (cost_micros >= 0)))
);


--
-- Name: TABLE ai_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_runs IS 'Execuções do loop do agente, consumidas pelo worker (spec 011): queued → running (ai_run_claim, SKIP LOCKED) → awaiting_confirmation (espera ai_tool_confirmations) → queued … → completed | failed | canceled. Uma ativa por conversa. O id é o app.agent_run_id da auditoria. Tokens e custo agregados de ai_usage (por trigger). Fora da auditoria.';


--
-- Name: COLUMN ai_runs.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.user_id IS 'Quem acionou (= dono da conversa). As tools rodam com as permissões dele.';


--
-- Name: COLUMN ai_runs.provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.provider_id IS 'Provedor usado (cópia do agente ao enfileirar, se não informado).';


--
-- Name: COLUMN ai_runs.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.model IS 'Modelo usado (cópia do agente ao enfileirar, se não informado).';


--
-- Name: COLUMN ai_runs.trigger_message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.trigger_message_id IS 'Mensagem do usuário que acionou a execução (da mesma conversa).';


--
-- Name: COLUMN ai_runs.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.status IS 'queued (na fila), running (reservada por um worker: locked_at), awaiting_confirmation (parada esperando o usuário decidir tools de escrita), completed, failed (error), canceled. Os três últimos são finais.';


--
-- Name: COLUMN ai_runs.error; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.error IS 'Mensagem de erro (obrigatória em failed; opcional em canceled). Nunca contém chaves.';


--
-- Name: COLUMN ai_runs.cancel_requested_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.cancel_requested_at IS 'O usuário pediu para parar uma execução em running: o worker vê em ai_run_heartbeat e encerra como canceled.';


--
-- Name: COLUMN ai_runs.locked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.locked_at IS 'Reserva/heartbeat do worker (só em running). Mais velha que o limite = worker caiu; ai_run_claim retoma.';


--
-- Name: COLUMN ai_runs.lock_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.lock_token IS 'Cerca (fencing) da reserva atual, nova a cada claim (só em running): ai_run_heartbeat exige o token, então um worker cuja reserva foi retomada por outro descobre e para.';


--
-- Name: COLUMN ai_runs.attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.attempts IS 'Reservas da vez atual (o claim soma 1; volta a 0 quando a execução sai de running para queued ou awaiting_confirmation). Limita as retomadas depois de queda do worker (max_attempts).';


--
-- Name: COLUMN ai_runs.last_event_seq; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.last_event_seq IS 'Último seq de ai_run_events desta execução (contador do ai_run_event_append).';


--
-- Name: COLUMN ai_runs.cost_micros; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.cost_micros IS 'Custo estimado agregado em milionésimos de cost_currency (ex.: micro-dólares). Medição, sem teto.';


--
-- Name: COLUMN ai_runs.cost_currency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_runs.cost_currency IS 'Moeda do custo agregado (a do preço do modelo); nula até haver custo.';


--
-- Name: ai_run_claim(integer, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_run_claim(p_limit integer DEFAULT 1, p_stale_after interval DEFAULT '00:02:00'::interval) RETURNS SETOF public.ai_runs
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_stale_after IS NULL OR p_stale_after < interval '10 seconds' THEN
    RAISE EXCEPTION 'ai_run_claim: limit must be 1..100 and stale_after >= 10 seconds'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Reserva abandonada (worker caiu): com cancelamento pedido, cancela; sem tentativas restantes, falha.
  UPDATE ai_runs r
     SET status = CASE WHEN r.cancel_requested_at IS NOT NULL THEN 'canceled' ELSE 'failed' END,
         error = CASE WHEN r.cancel_requested_at IS NOT NULL THEN r.error
                      ELSE 'stale_lock: worker stopped and the run has no attempts left' END
   WHERE r.id IN (SELECT x.id FROM ai_runs x
                   WHERE x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after
                     AND (x.attempts >= x.max_attempts OR x.cancel_requested_at IS NOT NULL)
                   FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  UPDATE ai_runs r
     SET status = 'running', locked_at = clock_timestamp(), lock_token = gen_random_uuid(), attempts = r.attempts + 1
   WHERE r.id IN (SELECT x.id FROM ai_runs x
                   WHERE x.status = 'queued'
                      OR (x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after
                          AND x.attempts < x.max_attempts AND x.cancel_requested_at IS NULL)
                   ORDER BY x.created_at, x.id
                   LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING r.*;
END
$$;


--
-- Name: FUNCTION ai_run_claim(p_limit integer, p_stale_after interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_run_claim(p_limit integer, p_stale_after interval) IS 'Reserva até p_limit execuções (queued, ou running com reserva mais velha que p_stale_after = worker caiu) com FOR UPDATE SKIP LOCKED: status = running, locked_at = agora, lock_token novo, attempts + 1 (started_at na primeira). Reserva velha sem tentativas vira failed; com cancelamento pedido, canceled. Rode numa transação curta e faça COMMIT antes de chamar o modelo. Guarde lock_token: é a cerca de ai_run_heartbeat. Erro 22023: parâmetros inválidos.';


--
-- Name: ai_run_event_append(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_run_event_append(p_run_id uuid, p_event_type text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  s integer;
BEGIN
  UPDATE ai_runs r SET last_event_seq = r.last_event_seq + 1 WHERE r.id = p_run_id RETURNING r.last_event_seq INTO s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_event_append: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO ai_run_events (run_id, seq, event_type, payload) VALUES (p_run_id, s, p_event_type, coalesce(p_payload, '{}'));
  PERFORM pg_notify('ai_run_events', json_build_object('run_id', p_run_id, 'seq', s)::text);
  RETURN s;
END
$$;


--
-- Name: FUNCTION ai_run_event_append(p_run_id uuid, p_event_type text, p_payload jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_run_event_append(p_run_id uuid, p_event_type text, p_payload jsonb) IS 'Grava o próximo evento da execução (seq = last_event_seq + 1, trava a linha da execução) e avisa por NOTIFY no canal ai_run_events com {"run_id", "seq"} (entregue no COMMIT). A API escuta (LISTEN) e lê WHERE run_id = … AND seq > último enviado. Devolve o seq. P0002 se a execução não existe.';


--
-- Name: ai_run_events_purge(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_run_events_purge(p_keep interval DEFAULT '7 days'::interval) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
  n bigint;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '1 hour' THEN
    RAISE EXCEPTION 'ai_run_events_purge: keep must be >= 1 hour' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM ai_run_events e
   USING ai_runs r
   WHERE r.id = e.run_id AND r.finished_at < clock_timestamp() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;


--
-- Name: FUNCTION ai_run_events_purge(p_keep interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_run_events_purge(p_keep interval) IS 'Retenção: apaga os eventos de execuções terminadas há mais de p_keep (padrão 7 dias; mínimo 1 hora) e devolve quantos. As mensagens e o uso ficam. O worker chama periodicamente. Erro 22023 se p_keep < 1 hora.';


--
-- Name: ai_run_heartbeat(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_run_heartbeat(p_run_id uuid, p_lock_token uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
  cancel boolean;
BEGIN
  UPDATE ai_runs r SET locked_at = clock_timestamp()
   WHERE r.id = p_run_id AND r.status = 'running' AND r.lock_token = p_lock_token
  RETURNING r.cancel_requested_at IS NOT NULL INTO cancel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_heartbeat: run % is not running under this lock', p_run_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_lock_check';
  END IF;
  RETURN cancel;
END
$$;


--
-- Name: FUNCTION ai_run_heartbeat(p_run_id uuid, p_lock_token uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_run_heartbeat(p_run_id uuid, p_lock_token uuid) IS 'O worker renova a reserva (locked_at) de tempos em tempos (bem menos que o stale_after do claim). Devolve true se o usuário pediu cancelamento. Erro 23514 (ai_runs_lock_check) se a execução não está mais running com este lock_token (foi retomada por outro worker, cancelada ou terminou): pare o loop sem gravar mais nada.';


--
-- Name: ai_run_mcp_headers(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_run_mcp_headers(p_run_id uuid, p_mcp_server_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  r public.ai_runs;
  h jsonb;
BEGIN
  SELECT * INTO r FROM public.ai_runs x WHERE x.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_mcp_headers: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'ai_run_mcp_headers: run % is not running (status %)', p_run_id, r.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.secret_headers INTO h
    FROM public.mcp_servers s
    LEFT JOIN public.agent_mcp_servers l ON l.mcp_server_id = s.id AND l.agent_id = r.agent_id
   WHERE s.id = p_mcp_server_id AND s.is_active AND s.archived_at IS NULL
     AND (s.visibility = 'global' OR l.id IS NOT NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_mcp_headers: server % is not enabled for the agent of run %', p_mcp_server_id, p_run_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN h;
END
$$;


--
-- Name: FUNCTION ai_run_mcp_headers(p_run_id uuid, p_mcp_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_run_mcp_headers(p_run_id uuid, p_mcp_server_id uuid) IS 'Worker: cabeçalhos secretos de um servidor MCP efetivo para o agente de uma execução RESERVADA (running). Erro 42501 se a execução não está running ou o servidor não está ativo/habilitado para o agente; P0002 se a execução não existe.';


--
-- Name: ai_run_provider_credentials(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_run_provider_credentials(p_run_id uuid) RETURNS TABLE(provider_id uuid, kind text, base_url text, api_key text, model text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  r public.ai_runs;
  p public.ai_providers;
BEGIN
  SELECT * INTO r FROM public.ai_runs x WHERE x.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: run % is not running (status %)', p_run_id, r.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM public.ai_providers x WHERE x.id = r.provider_id;
  IF NOT p.is_active OR p.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: provider % is not active', p.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ('text' = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_run_provider_credentials: provider % lacks the text capability', p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, r.model;
END
$$;


--
-- Name: FUNCTION ai_run_provider_credentials(p_run_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_run_provider_credentials(p_run_id uuid) IS 'Worker: provedor, URL, chave e modelo de texto de uma execução RESERVADA (status running). Erro 42501 em outro status ou com o provedor inativo ou sem a flag text; P0002 se a execução não existe. Única forma de ler ai_providers.api_key durante o loop, além de ai_capability_credentials para as outras inferências.';


--
-- Name: ai_runs_expire_awaiting(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_runs_expire_awaiting(p_after interval DEFAULT '7 days'::interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  n integer;
BEGIN
  IF p_after IS NULL OR p_after < interval '1 minute' THEN
    RAISE EXCEPTION 'ai_runs_expire_awaiting: after must be >= 1 minute' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE ai_runs r SET status = 'canceled', error = 'confirmation_expired'
   WHERE r.status = 'awaiting_confirmation' AND r.updated_at < clock_timestamp() - p_after;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;


--
-- Name: FUNCTION ai_runs_expire_awaiting(p_after interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_runs_expire_awaiting(p_after interval) IS 'Cancela (error = confirmation_expired) execuções paradas em awaiting_confirmation há mais de p_after (padrão 7 dias); as confirmações pendentes expiram junto. Devolve quantas. O worker chama periodicamente.';


--
-- Name: ai_runs_expire_confirmations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_runs_expire_confirmations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_tool_confirmations c SET status = 'expired'
   WHERE c.run_id = NEW.id AND c.status = 'pending';
  RETURN NULL;
END
$$;


--
-- Name: ai_runs_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_runs_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  conv ai_conversations;
  ag   ai_agents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' THEN
      RAISE EXCEPTION 'ai_runs: new runs must be queued'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_transition_check';
    END IF;
    SELECT * INTO conv FROM ai_conversations c WHERE c.id = NEW.conversation_id;
    IF FOUND AND conv.user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'ai_runs: run user must be the owner of conversation %', NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_owner_check';
    END IF;
    IF FOUND AND conv.agent_id <> NEW.agent_id THEN
      RAISE EXCEPTION 'ai_runs: run agent must be the agent of conversation %', NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_agent_check';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.is_active) THEN
      RAISE EXCEPTION 'ai_runs: user % is not active', NEW.user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_user_active_check';
    END IF;
    SELECT * INTO ag FROM ai_agents a WHERE a.id = NEW.agent_id;
    IF NOT FOUND OR NOT ag.is_active OR ag.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'ai_runs: agent % is not active', NEW.agent_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_agent_active_check';
    END IF;
    NEW.provider_id := coalesce(NEW.provider_id, ag.provider_id);
    NEW.model := coalesce(NEW.model, ag.model);
    IF NOT EXISTS (SELECT 1 FROM ai_providers p WHERE p.id = NEW.provider_id AND p.is_active AND p.archived_at IS NULL) THEN
      RAISE EXCEPTION 'ai_runs: provider % is not active', NEW.provider_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_provider_active_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.conversation_id <> OLD.conversation_id OR NEW.user_id <> OLD.user_id OR NEW.agent_id <> OLD.agent_id
     OR NEW.provider_id <> OLD.provider_id OR NEW.model <> OLD.model OR NEW.max_attempts <> OLD.max_attempts
     OR (NEW.trigger_message_id IS DISTINCT FROM OLD.trigger_message_id AND OLD.trigger_message_id IS NOT NULL
         AND NEW.trigger_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ai_runs: conversation, user, agent, provider, model and trigger message of run % are immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_immutable_check';
  END IF;

  IF OLD.status IN ('completed', 'failed', 'canceled') THEN
    -- Final: só os contadores (eventos e uso que chegam depois) ainda mudam.
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'last_event_seq', 'input_tokens', 'output_tokens', 'cache_write_tokens',
                              'cache_read_tokens', 'cost_micros', 'cost_currency', 'trigger_message_id'])
       <> (to_jsonb(OLD) - ARRAY['updated_at', 'last_event_seq', 'input_tokens', 'output_tokens', 'cache_write_tokens',
                                 'cache_read_tokens', 'cost_micros', 'cost_currency', 'trigger_message_id']) THEN
      RAISE EXCEPTION 'ai_runs: run % is % and cannot change', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_transition_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running', 'canceled'))
    OR (OLD.status = 'running' AND NEW.status IN ('queued', 'awaiting_confirmation', 'completed', 'failed', 'canceled'))
    OR (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('queued', 'failed', 'canceled'))
  ) THEN
    RAISE EXCEPTION 'ai_runs: invalid transition % -> % (run %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_runs_transition_check';
  END IF;

  -- Campos derivados do status.
  IF NEW.status <> 'running' THEN
    NEW.locked_at := NULL;
    NEW.lock_token := NULL;
  END IF;
  IF OLD.status = 'running' AND NEW.status IN ('queued', 'awaiting_confirmation') THEN
    NEW.attempts := 0;
  END IF;
  IF NEW.status = 'running' AND NEW.started_at IS NULL THEN
    NEW.started_at := clock_timestamp();
  END IF;
  IF NEW.status IN ('completed', 'failed', 'canceled') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_text_sha256(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_text_sha256(p_text text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$;


--
-- Name: FUNCTION ai_text_sha256(p_text text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_text_sha256(p_text text) IS 'SHA-256 (hex minúsculo) do texto em UTF-8. Igual ao sha256 de Node sobre a string.';


--
-- Name: ai_tool_confirmations_decide(uuid, uuid, text, uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_tool_confirmations_decide(p_run_id uuid, p_actor_user_id uuid, p_decision text, p_confirmation_ids uuid[] DEFAULT NULL::uuid[], p_reason text DEFAULT NULL::text) RETURNS TABLE(decided integer, pending integer, run_status text)
    LANGUAGE plpgsql
    AS $$
DECLARE
  r ai_runs;
  n integer;
  left_pending integer;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'ai_tool_confirmations_decide: decision must be approved or rejected'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM ai_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_tool_confirmations_decide: run % not found', p_run_id USING ERRCODE = 'no_data_found';
  END IF;
  IF r.user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'ai_tool_confirmations_decide: only the user who started run % can decide', p_run_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE ai_tool_confirmations c
     SET status = p_decision, decided_by_user_id = p_actor_user_id, decided_at = clock_timestamp(),
         reason = CASE WHEN p_decision = 'rejected' THEN p_reason END
   WHERE c.run_id = p_run_id AND c.status = 'pending'
     AND (p_confirmation_ids IS NULL OR c.id = ANY (p_confirmation_ids));
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT count(*) INTO left_pending FROM ai_tool_confirmations c WHERE c.run_id = p_run_id AND c.status = 'pending';
  IF left_pending = 0 AND r.status = 'awaiting_confirmation' THEN
    UPDATE ai_runs x SET status = 'queued' WHERE x.id = p_run_id;
    r.status := 'queued';
  END IF;
  RETURN QUERY SELECT n, left_pending, r.status;
END
$$;


--
-- Name: FUNCTION ai_tool_confirmations_decide(p_run_id uuid, p_actor_user_id uuid, p_decision text, p_confirmation_ids uuid[], p_reason text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_tool_confirmations_decide(p_run_id uuid, p_actor_user_id uuid, p_decision text, p_confirmation_ids uuid[], p_reason text) IS 'Decide confirmações pendentes de uma execução: todas (p_confirmation_ids nulo = "aprovar tudo") ou as listadas. Só o usuário da execução (42501 se outro; P0002 se a execução não existe; 22023 se a decisão é inválida). Sem pendentes e com a execução em awaiting_confirmation, devolve-a à fila (queued) para o worker continuar. Devolve quantas decidiu, quantas ainda pendem e o status da execução.';


--
-- Name: ai_tool_confirmations_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_tool_confirmations_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'ai_tool_confirmations: new confirmations must be pending'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_transition_check';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.status = 'running') THEN
      RAISE EXCEPTION 'ai_tool_confirmations: run % is not running', NEW.run_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_run_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.run_id <> OLD.run_id OR NEW.tool_use_id <> OLD.tool_use_id OR NEW.tool_name <> OLD.tool_name
     OR NEW.input <> OLD.input OR NEW.preview IS DISTINCT FROM OLD.preview THEN
    RAISE EXCEPTION 'ai_tool_confirmations: confirmation % is immutable (only the decision changes)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_immutable_check';
  END IF;
  IF OLD.status <> 'pending' THEN
    IF (to_jsonb(NEW) - 'updated_at') <> (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'ai_tool_confirmations: confirmation % is already %', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_transition_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('approved', 'rejected') THEN
    IF NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.user_id = NEW.decided_by_user_id) THEN
      RAISE EXCEPTION 'ai_tool_confirmations: only the user who started run % can decide', NEW.run_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_tool_confirmations_decider_check';
    END IF;
  END IF;
  IF NEW.status <> 'pending' AND NEW.decided_at IS NULL THEN
    NEW.decided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_tool_kit_from_legacy(text, text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_tool_kit_from_legacy(p_agent_name text, p_enabled_tools text[], p_require_write_confirmation boolean) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION ai_tool_kit_from_legacy(p_agent_name text, p_enabled_tools text[], p_require_write_confirmation boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_tool_kit_from_legacy(p_agent_name text, p_enabled_tools text[], p_require_write_confirmation boolean) IS 'Interna (migração 0038): cria o kit equivalente à configuração antiga de um agente (enabled_tools, require_write_confirmation) e devolve o id, ou NULL se a lista era nula e a flag false (sem kit). Kit "Kit – <nome>" (truncado em 120, sufixo " (n)" se colidir) com as tools da lista que existem no retrato ai_legacy_tool_registry() (todas, se nula): ask nas escritas que pediam confirmação, allow no resto.';


--
-- Name: ai_tool_kit_tools_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_tool_kit_tools_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION ai_tool_kit_tools_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_tool_kit_tools_audit_row() IS 'Trigger de auditoria de ai_tool_kit_tools: grava com record_id = kit_id (a linha não tem id), para incluir, remover e trocar o modo de uma tool aparecerem no histórico do kit.';


--
-- Name: ai_tool_list_valid(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_tool_list_valid(p_tools text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT p_tools IS NULL
      OR (cardinality(p_tools) <= 500
          AND array_position(p_tools, NULL) IS NULL
          AND NOT EXISTS (SELECT 1 FROM unnest(p_tools) t WHERE t !~ '^[A-Za-z0-9_./-]{1,128}$')
          AND (SELECT count(DISTINCT t) FROM unnest(p_tools) t) = cardinality(p_tools))
$_$;


--
-- Name: FUNCTION ai_tool_list_valid(p_tools text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_tool_list_valid(p_tools text[]) IS 'true se a lista de tools é NULL (= todas) ou tem até 500 nomes distintos, não nulos, no formato de nome de tool do MCP ([A-Za-z0-9_./-], 1–128). Lista vazia = nenhuma tool.';


--
-- Name: ai_usage_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: ai_usage_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  r  ai_runs;
  mc uuid;
  cp text;
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

  IF NEW.purpose = 'chat' AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.purpose INTO cp FROM ai_conversations c WHERE c.id = NEW.conversation_id;
    NEW.purpose := coalesce(cp, NEW.purpose);
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
    -- Preços por milhão (tokens, caracteres) dão micros direto; o minuto de áudio vira micros × 1 000 000 / 60.
    NEW.cost_micros := round(NEW.input_tokens * p.input_price_per_million
                             + NEW.output_tokens * p.output_price_per_million
                             + NEW.cache_write_tokens * coalesce(p.cache_write_price_per_million, p.input_price_per_million)
                             + NEW.cache_read_tokens * coalesce(p.cache_read_price_per_million, p.input_price_per_million)
                             + NEW.audio_seconds * coalesce(p.audio_input_per_minute, 0) * 1000000 / 60
                             + NEW.characters * coalesce(p.speech_per_million_chars, 0))::bigint;
    NEW.currency := p.currency;
  ELSE
    NEW.cost_micros := NULL;
    NEW.currency := NULL;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION ai_usage_before_insert(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_usage_before_insert() IS 'Completa conversa/usuário/agente/provedor/modelo da execução, confere as ligações (ai_usage_links_check), troca purpose chat pela finalidade da conversa quando ela é de fluxo e calcula o custo pelo preço vigente: tokens, segundos de áudio (audio_input_per_minute) e caracteres de fala (speech_per_million_chars).';


--
-- Name: ai_usage_request_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_request_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  q ai_requests;
BEGIN
  IF NEW.request_id IS NOT NULL THEN
    SELECT * INTO q FROM ai_requests x WHERE x.id = NEW.request_id;
    IF FOUND AND (q.provider_id <> NEW.provider_id OR q.run_id <> NEW.run_id) THEN
      RAISE EXCEPTION 'ai_usage: request % is for another provider or run', NEW.request_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_usage_links_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION ai_usage_request_check(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_usage_request_check() IS 'O uso aponta para uma requisição do mesmo provedor e da mesma execução (quando as duas têm), senão 23514 ai_usage_links_check.';


--
-- Name: ai_usage_unlink_missing_requests(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_unlink_missing_requests() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.ai_usage u SET request_id = NULL
   WHERE u.request_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ai_requests r WHERE r.id = u.request_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;


--
-- Name: FUNCTION ai_usage_unlink_missing_requests(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_usage_unlink_missing_requests() IS 'Depois de restaurar um dump (que traz ai_usage mas não os dados de ai_requests): anula ai_usage.request_id que aponta para requisição inexistente e devolve quantos. Idempotente.';


--
-- Name: api_token_authenticate(text, inet); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.api_token_authenticate(p_token_hash text, p_ip inet DEFAULT NULL::inet) RETURNS TABLE(user_id uuid, token_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  t public.user_api_tokens;
BEGIN
  SELECT k.* INTO t
    FROM public.user_api_tokens k
    JOIN public.users u ON u.id = k.user_id AND u.is_active
   WHERE k.token_hash = lower(p_token_hash)
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > clock_timestamp());
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF t.last_used_at IS NULL OR t.last_used_at < clock_timestamp() - interval '1 minute'
     OR t.last_used_ip IS DISTINCT FROM coalesce(p_ip, t.last_used_ip) THEN
    UPDATE public.user_api_tokens k
       SET last_used_at = clock_timestamp(), last_used_ip = coalesce(p_ip, k.last_used_ip)
     WHERE k.id = t.id;
  END IF;
  RETURN QUERY SELECT t.user_id, t.id;
END
$$;


--
-- Name: FUNCTION api_token_authenticate(p_token_hash text, p_ip inet); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.api_token_authenticate(p_token_hash text, p_ip inet) IS 'Autentica um token pessoal pelo SHA-256 (hex) do token apresentado: devolve (user_id, token_id) se o token existe, não está revogado nem expirado e o dono está ativo; senão nenhuma linha. Atualiza last_used_at/ip (no máximo uma vez por minuto, ou quando o IP muda).';


--
-- Name: app_schema_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_schema_version() RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  v text;
BEGIN
  -- Bancos migrados sem dbmate (testes de integração da API) não têm a tabela: devolve NULL.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT max(version)::text FROM public.schema_migrations' INTO v;
  RETURN v;
END
$$;


--
-- Name: FUNCTION app_schema_version(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.app_schema_version() IS 'Versão do schema = última migration aplicada pelo dbmate (max(version) de public.schema_migrations, ex.: 0031); NULL se a tabela não existe (banco migrado sem dbmate) ou está vazia. Registrada no arquivo de backup.';


--
-- Name: app_setting_valid(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_setting_valid(p_key text, p_value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT CASE p_key
           WHEN 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           ELSE false
         END
$_$;


--
-- Name: FUNCTION app_setting_valid(p_key text, p_value jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.app_setting_valid(p_key text, p_value jsonb) IS 'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: ai.request_retention_days (número inteiro de 1 a 365, sem aspas nem casas decimais). As fases 028 e 029 acrescentam chaves.';


--
-- Name: app_settings_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_settings_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed, md5(coalesce(n ->> 'key', o ->> 'key'))::uuid);
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION app_settings_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.app_settings_audit_row() IS 'Trigger de auditoria de app_settings: grava com record_id = md5(key)::uuid (a linha não tem id; o histórico de uma chave é WHERE table_name = ''app_settings'' AND record_id = md5(chave)::uuid).';


--
-- Name: app_settings_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_settings_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  uid text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    NEW.updated_by_user_id := uid::uuid;
  END IF;
  RETURN NEW;
END
$_$;


--
-- Name: FUNCTION app_settings_before_write(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.app_settings_before_write() IS 'updated_by_user_id = app.user_id da transação, quando definido (um app.user_id malformado fica para a auditoria recusar).';


--
-- Name: attachments_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attachments_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: attachments_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attachments_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'attachments: content of attachment % cannot change (upload a new file)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attachments_content_immutable_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.audit_row() IS 'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token, api_key, secret_headers, token_hash): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha.';


--
-- Name: audit_write(text, text, jsonb, jsonb, text[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[], p_record_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[], p_record_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[], p_record_id uuid) IS 'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. record_id = p_record_id (tabelas sem coluna id, como entity_tag_links) ou o id da linha. Erro 23514 (audit_log_actor_check) se app.user_id não é uuid, se actor_kind é inválido, se human/agent vem sem usuário, ou se app.agent_run_id vem sem actor_kind = agent ou não é uma execução (ai_runs) do mesmo usuário.';


--
-- Name: auth_login(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_login(login text, password text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  uid uuid;
BEGIN
  UPDATE public.users u
     SET last_login_at = now()
   WHERE (u.username = auth_login.login::citext OR u.email = auth_login.login::citext)
     AND u.is_active
     AND u.password = auth_login.password
  RETURNING u.id INTO uid;
  RETURN uid;
END
$$;


--
-- Name: FUNCTION auth_login(login text, password text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.auth_login(login text, password text) IS 'Autentica por username OU email (sem distinção de maiúsculas) e senha (exata). Retorna o id do usuário ativo e atualiza last_login_at, ou NULL se não conferir.';


--
-- Name: caixa_daily_balances(uuid, date, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caixa_daily_balances(p_caixa_id uuid, p_from date, p_to date, p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date) RETURNS TABLE(day date, realized_cents bigint, scheduled_cents bigint, projected_cents bigint)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'caixa_daily_balances: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH accs AS (
    SELECT a.id, a.opening_date, a.opening_balance_cents FROM financial_accounts a WHERE a.caixa_id = p_caixa_id
  ),
  before AS (
    SELECT coalesce(sum(m.amount_cents), 0) AS cents
      FROM movements m JOIN accs ON accs.id = m.financial_account_id
     WHERE m.occurred_on < p_from
  ),
  daily AS (
    SELECT m.occurred_on AS d, sum(m.amount_cents) AS delta
      FROM movements m JOIN accs ON accs.id = m.financial_account_id
     WHERE m.occurred_on BETWEEN p_from AND p_to
     GROUP BY m.occurred_on
  ),
  -- Previsto: saldo aberto dos títulos (vencidos contam a partir de hoje) e faturas abertas da pagadora.
  pending AS (
    SELECT greatest(b.due_date, p_today) AS d,
           sum(CASE b.direction WHEN 'receivable' THEN b.open_cents ELSE -b.open_cents END) AS delta
      FROM title_balances b
      JOIN titles t ON t.id = b.title_id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE b.caixa_id = p_caixa_id AND b.open_cents > 0 AND b.archived_at IS NULL
       AND greatest(b.due_date, p_today) <= p_to
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
     GROUP BY 1
    UNION ALL
    SELECT greatest(x.due_date, p_today), -sum(x.items_cents - x.settled_cents)
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = p_caixa_id AND x.items_cents - x.settled_cents > 0
       AND greatest(x.due_date, p_today) <= p_to
     GROUP BY 1
  ),
  pending_daily AS (
    SELECT p.d, sum(p.delta) AS delta FROM pending p GROUP BY p.d
  ),
  pending_before AS (
    SELECT coalesce(sum(p.delta), 0) AS cents FROM pending_daily p WHERE p.d < p_from
  ),
  series AS (
    SELECT g.d::date AS day,
           (SELECT coalesce(sum(accs.opening_balance_cents), 0) FROM accs WHERE accs.opening_date <= g.d::date)
           + before.cents
           + sum(coalesce(daily.delta, 0)) OVER w AS realized,
           pending_before.cents + sum(coalesce(pd.delta, 0)) OVER w AS scheduled
      FROM generate_series(p_from, p_to, interval '1 day') g (d)
      CROSS JOIN before
      CROSS JOIN pending_before
      LEFT JOIN daily ON daily.d = g.d::date
      LEFT JOIN pending_daily pd ON pd.d = g.d::date
    WINDOW w AS (ORDER BY g.d)
  )
  SELECT s.day,
         s.realized::bigint,
         (CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint,
         (s.realized + CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint
    FROM series s
   ORDER BY s.day;
END
$$;


--
-- Name: FUNCTION caixa_daily_balances(p_caixa_id uuid, p_from date, p_to date, p_today date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.caixa_daily_balances(p_caixa_id uuid, p_from date, p_to date, p_today date) IS 'Por dia: realized_cents = soma dos saldos das contas da caixa no fim do dia (movimentos até o dia); scheduled_cents = a partir de p_today, saldo aberto acumulado dos títulos da caixa até o dia (+ receber, − pagar; vencidos entram em p_today) e das faturas abertas em que ela é pagadora; projected_cents = realized + scheduled. Antes de p_today, scheduled = 0. Até 1100 dias (erro 22023).';


--
-- Name: caixas_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caixas_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'caixas: kind cannot change (caixa %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'caixas_kind_immutable_check';
  END IF;

  IF NEW.default_payer_caixa_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM caixas c
                      WHERE c.id = NEW.default_payer_caixa_id AND c.kind = 'general') THEN
    RAISE EXCEPTION 'caixas: default payer % must be a general caixa', NEW.default_payer_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'caixas_default_payer_kind_check';
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: calendar_items(uuid[], date, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calendar_items(p_caixa_ids uuid[], p_from date, p_to date, p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date) RETURNS TABLE(item_kind text, title_id uuid, card_invoice_id uuid, caixa_id uuid, counterparty_caixa_id uuid, direction text, due_date date, reference_month date, description text, entity_id uuid, category_id uuid, amount_cents bigint, open_cents bigint, status text, calendar_status text, mirror_side text, mirror_status text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'calendar_items: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  -- Títulos (inclusive as faturas fechadas, que são títulos card_invoice).
  SELECT 'title'::text,
         t.id,
         t.card_invoice_id,
         t.caixa_id,
         t.counterparty_caixa_id,
         t.direction,
         t.due_date,
         v.reference_month,
         t.description,
         t.entity_id,
         t.category_id,
         t.amount_cents,
         b.open_cents,
         t.status,
         CASE WHEN t.status = 'paid' THEN 'paid'
              WHEN t.due_date < p_today THEN 'overdue'
              ELSE t.direction END,
         CASE WHEN t.mirror_title_id IS NULL THEN NULL
              WHEN t.mirror_status IS NOT NULL THEN 'mirror'
              ELSE 'original' END,
         t.mirror_status
    FROM titles t
    JOIN title_balances b ON b.title_id = t.id
    LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
   WHERE t.caixa_id = ANY (p_caixa_ids)
     AND t.due_date BETWEEN p_from AND p_to
     AND t.status <> 'canceled'
     AND t.archived_at IS NULL
     -- Antecipação de fatura ainda aberta: aparece somada na projeção da fatura abaixo.
     AND (v.id IS NULL OR v.closed_at IS NOT NULL)
  UNION ALL
  -- Faturas ainda abertas: previsão por pagadora (itens − antecipações pagas), nos dois lados.
  SELECT 'card_invoice'::text,
         NULL::uuid,
         x.card_invoice_id,
         side.caixa_id,
         side.counterparty_caixa_id,
         side.direction,
         x.due_date,
         x.reference_month,
         card.name,
         side.entity_id,
         NULL::uuid,
         (x.items_cents - x.settled_cents)::bigint,
         (x.items_cents - x.settled_cents)::bigint,
         'open'::text,
         CASE WHEN x.due_date < p_today THEN 'overdue' ELSE side.direction END,
         -- O título da fatura terá o lado "a receber" no cartão (original) e o "a pagar" na pagadora (espelho).
         CASE side.direction WHEN 'payable' THEN 'mirror' ELSE 'original' END,
         NULL::text
    FROM card_invoice_payer_totals x
    JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
    JOIN caixas card ON card.id = x.card_caixa_id
    JOIN caixas payer ON payer.id = x.payer_caixa_id
    CROSS JOIN LATERAL (
      VALUES (x.payer_caixa_id, x.card_caixa_id, 'payable'::text, card.holder_entity_id),
             (x.card_caixa_id, x.payer_caixa_id, 'receivable'::text, payer.holder_entity_id)
    ) side (caixa_id, counterparty_caixa_id, direction, entity_id)
   WHERE side.caixa_id = ANY (p_caixa_ids)
     AND x.due_date BETWEEN p_from AND p_to
     AND x.items_cents - x.settled_cents > 0
   ORDER BY 7, 4, 1, 2, 3;
END
$$;


--
-- Name: FUNCTION calendar_items(p_caixa_ids uuid[], p_from date, p_to date, p_today date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.calendar_items(p_caixa_ids uuid[], p_from date, p_to date, p_today date) IS 'Itens do calendário por vencimento nas caixas pedidas: títulos não cancelados nem arquivados (item_kind = title; faturas fechadas aparecem como seus títulos card_invoice) e faturas abertas (item_kind = card_invoice: previsão = itens − antecipações pagas, como a pagar na pagadora e a receber no cartão). calendar_status: paid, overdue (vencido em aberto), payable ou receivable. mirror_side: original | mirror (lado criado na caixa da contraparte, o que tem mirror_status) | nulo sem espelho; na previsão da fatura aberta, mirror na pagadora e original no cartão. mirror_status: pending | accepted | disputed no lado espelho (nulo nos demais e na previsão). Período de até 1100 dias (erro 22023).';


--
-- Name: card_invoice_assert(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_invoice_assert(p_invoice_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  inv card_invoices;
  bad record;
BEGIN
  SELECT * INTO inv FROM card_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF inv.closed_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM titles t
                WHERE t.card_invoice_id = inv.id AND t.status NOT IN ('paid', 'canceled')) THEN
      RAISE EXCEPTION 'card_invoices: open invoice % can only have fully paid titles (advance payments)', inv.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_open_titles_check';
    END IF;
    RETURN;
  END IF;

  SELECT x.payer, x.items, x.billed, x.carried INTO bad
    FROM (
      SELECT p.payer,
             (SELECT coalesce(sum(i.amount_cents), 0) FROM card_invoice_items i
               WHERE i.card_invoice_id = inv.id AND i.payer_caixa_id = p.payer) AS items,
             (SELECT coalesce(sum(t.amount_cents), 0) FROM titles t
               WHERE t.card_invoice_id = inv.id AND t.caixa_id = inv.card_caixa_id
                 AND t.counterparty_caixa_id = p.payer AND t.status <> 'canceled') AS billed,
             (SELECT coalesce(sum(i.amount_cents), 0) FROM card_invoice_items i
               WHERE i.carried_from_invoice_id = inv.id AND i.payer_caixa_id = p.payer) AS carried
        FROM (SELECT i.payer_caixa_id AS payer FROM card_invoice_items i WHERE i.card_invoice_id = inv.id
              UNION
              SELECT t.counterparty_caixa_id FROM titles t
               WHERE t.card_invoice_id = inv.id AND t.caixa_id = inv.card_caixa_id
              UNION
              SELECT i.payer_caixa_id FROM card_invoice_items i WHERE i.carried_from_invoice_id = inv.id) p
    ) x
   WHERE x.items <> x.billed + x.carried
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'card_invoices: closed invoice % for payer % totals % but titles sum % and carried over %',
      inv.id, bad.payer, bad.items, bad.billed, bad.carried
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_total_check';
  END IF;
END
$$;


--
-- Name: FUNCTION card_invoice_assert(p_invoice_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.card_invoice_assert(p_invoice_id uuid) IS 'Erro 23514 (card_invoices_total_check / card_invoices_open_titles_check) se a fatura não fecha com os títulos. Usada pelos triggers deferidos.';


--
-- Name: card_invoice_items_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_invoice_items_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM card_purchase_assert(OLD.card_purchase_id) WHERE OLD.card_purchase_id IS NOT NULL;
    PERFORM card_invoice_assert(OLD.card_invoice_id);
    PERFORM card_invoice_assert(OLD.carried_from_invoice_id) WHERE OLD.carried_from_invoice_id IS NOT NULL;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM card_purchase_assert(NEW.card_purchase_id) WHERE NEW.card_purchase_id IS NOT NULL;
    PERFORM card_invoice_assert(NEW.card_invoice_id);
    PERFORM card_invoice_assert(NEW.carried_from_invoice_id) WHERE NEW.carried_from_invoice_id IS NOT NULL;
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: card_invoice_items_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_invoice_items_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  inv card_invoices;
  src card_invoices;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND EXISTS (SELECT 1 FROM card_invoices i WHERE i.id = OLD.card_invoice_id AND i.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'card_invoice_items: invoice % is closed', OLD.card_invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoice_items_invoice_closed_check';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT * INTO inv FROM card_invoices i WHERE i.id = NEW.card_invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;
  IF inv.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'card_invoice_items: invoice % is closed', NEW.card_invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoice_items_invoice_closed_check';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.payer_caixa_id AND c.kind = 'general')
     AND EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.payer_caixa_id) THEN
    RAISE EXCEPTION 'card_invoice_items: payer % must be a general caixa', NEW.payer_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoice_items_payer_kind_check';
  END IF;

  IF NEW.kind = 'carryover' THEN
    SELECT * INTO src FROM card_invoices i WHERE i.id = NEW.carried_from_invoice_id;
    IF FOUND AND (src.card_caixa_id <> inv.card_caixa_id OR src.reference_month >= inv.reference_month
                  OR src.closed_at IS NULL) THEN
      RAISE EXCEPTION 'card_invoice_items: carryover must come from an earlier closed invoice of the same card'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoice_items_carryover_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: card_invoices_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_invoices_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM card_invoice_assert(NEW.id);
  IF TG_OP = 'UPDATE' AND NEW.closing_date <> OLD.closing_date THEN
    PERFORM card_purchase_assert(p.id)
       FROM (SELECT DISTINCT i.card_purchase_id AS id FROM card_invoice_items i
              WHERE i.card_invoice_id = NEW.id AND i.card_purchase_id IS NOT NULL) p;
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: card_invoices_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_invoices_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.card_caixa_id <> OLD.card_caixa_id OR NEW.reference_month <> OLD.reference_month THEN
      RAISE EXCEPTION 'card_invoices: card and reference month of invoice % cannot change', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_immutable_check';
    END IF;
    IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT NULL
       AND (NEW.closing_date <> OLD.closing_date OR NEW.due_date <> OLD.due_date) THEN
      RAISE EXCEPTION 'card_invoices: dates of closed invoice % cannot change (reopen it first)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_immutable_check';
    END IF;
    IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL THEN
      IF EXISTS (SELECT 1 FROM titles t JOIN settlements s ON s.title_id = t.id
                  WHERE t.card_invoice_id = OLD.id AND s.reversed_at IS NULL) THEN
        RAISE EXCEPTION 'card_invoices: invoice % has payments and cannot be reopened', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_reopen_check';
      END IF;
      IF EXISTS (SELECT 1 FROM card_invoice_items i WHERE i.carried_from_invoice_id = OLD.id) THEN
        RAISE EXCEPTION 'card_invoices: invoice % has a balance carried over and cannot be reopened', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_reopen_check';
      END IF;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.card_caixa_id AND c.kind = 'credit_card') THEN
    RAISE EXCEPTION 'card_invoices: caixa % is not a credit card', NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_invoices_card_kind_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: card_purchase_assert(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_purchase_assert(p_purchase_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  p      card_purchases;
  o      card_purchases;
  sgn    int;
  bad    boolean;
  total  bigint;
BEGIN
  SELECT * INTO p FROM card_purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  sgn := CASE p.kind WHEN 'refund' THEN -1 ELSE 1 END;

  SELECT coalesce(sum(i.amount_cents), 0) * sgn,
         count(*) <> p.installments_total - p.first_installment + 1
         OR coalesce(bool_or(i.installment_number NOT BETWEEN p.first_installment AND p.installments_total
                             OR sign(i.amount_cents) <> sgn
                             OR i.payer_caixa_id <> p.payer_caixa_id
                             OR v.card_caixa_id <> p.card_caixa_id
                             OR v.reference_month <> f.reference_month
                                + make_interval(months => i.installment_number - p.first_installment)), false)
         OR coalesce(bool_or(i.installment_number = p.first_installment AND v.closing_date < p.purchased_on), false)
    INTO total, bad
    FROM card_invoice_items i
    JOIN card_invoices v ON v.id = i.card_invoice_id
    LEFT JOIN LATERAL (
      SELECT v1.reference_month FROM card_invoice_items i1 JOIN card_invoices v1 ON v1.id = i1.card_invoice_id
       WHERE i1.card_purchase_id = p.id AND i1.installment_number = p.first_installment
    ) f ON true
   WHERE i.card_purchase_id = p.id;

  IF bad OR total <> p.amount_cents THEN
    RAISE EXCEPTION 'card_purchases: purchase % requires installments %..% in consecutive invoices of its card '
                    '(first closing on or after %), signed by kind, for payer %, summing % (found %)',
      p.id, p.first_installment, p.installments_total, p.purchased_on, p.payer_caixa_id, p.amount_cents, total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_installments_check';
  END IF;

  IF p.kind = 'refund' THEN
    SELECT * INTO o FROM card_purchases WHERE id = p.refunded_purchase_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  ELSE
    o := p;
  END IF;

  IF EXISTS (SELECT 1 FROM card_purchases r
              WHERE r.refunded_purchase_id = o.id
                AND (r.entity_id <> o.entity_id OR r.category_id <> o.category_id OR r.payer_caixa_id <> o.payer_caixa_id)) THEN
    RAISE EXCEPTION 'card_purchases: refunds of % must keep its entity, category and payer', o.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_refund_check';
  END IF;
  IF (SELECT coalesce(sum(r.amount_cents), 0) FROM card_purchases r WHERE r.refunded_purchase_id = o.id) > o.amount_cents THEN
    RAISE EXCEPTION 'card_purchases: refunds of % exceed its amount %', o.id, o.amount_cents
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_refund_amount_check';
  END IF;
END
$$;


--
-- Name: FUNCTION card_purchase_assert(p_purchase_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.card_purchase_assert(p_purchase_id uuid) IS 'Erro 23514 (card_purchases_installments_check / _refund_check / _refund_amount_check) se a compra não bate com os itens de fatura ou com a compra original. Usada pelos triggers deferidos.';


--
-- Name: card_purchases_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_purchases_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM card_purchase_assert(NEW.id);
  IF NEW.refunded_purchase_id IS NOT NULL THEN
    PERFORM card_purchase_assert(NEW.refunded_purchase_id);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: card_purchases_period_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_purchases_period_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.purchased_on = OLD.purchased_on AND NEW.amount_cents = OLD.amount_cents
     AND NEW.payer_caixa_id = OLD.payer_caixa_id AND NEW.entity_id = OLD.entity_id
     AND NEW.category_id = OLD.category_id AND NEW.installments_total = OLD.installments_total
     AND NEW.first_installment = OLD.first_installment THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM period_assert_open(OLD.card_caixa_id, OLD.purchased_on, 'card_purchases');
    PERFORM period_assert_open(OLD.payer_caixa_id, OLD.purchased_on, 'card_purchases');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM period_assert_open(NEW.card_caixa_id, NEW.purchased_on, 'card_purchases');
    PERFORM period_assert_open(NEW.payer_caixa_id, NEW.purchased_on, 'card_purchases');
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;


--
-- Name: card_purchases_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_purchases_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  card caixas;
  orig card_purchases;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.card_caixa_id <> OLD.card_caixa_id OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'card_purchases: card and kind of purchase % cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_immutable_check';
  END IF;

  SELECT * INTO card FROM caixas c WHERE c.id = NEW.card_caixa_id;
  IF card.kind <> 'credit_card' THEN
    RAISE EXCEPTION 'card_purchases: caixa % is not a credit card', NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_card_kind_check';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.payer_caixa_id AND c.kind = 'general')
     AND EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.payer_caixa_id) THEN
    RAISE EXCEPTION 'card_purchases: payer % must be a general caixa', NEW.payer_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_payer_kind_check';
  END IF;

  IF EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.kind <> 'expense') THEN
    RAISE EXCEPTION 'card_purchases: category % must be an expense category', NEW.category_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_category_kind_check';
  END IF;

  IF NEW.kind = 'charge' AND NEW.entity_id <> card.holder_entity_id THEN
    RAISE EXCEPTION 'card_purchases: issuer charge must be paid to the card issuer %', card.holder_entity_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_charge_entity_check';
  END IF;

  IF NEW.kind = 'refund' THEN
    SELECT * INTO orig FROM card_purchases p WHERE p.id = NEW.refunded_purchase_id;
    IF FOUND AND (orig.card_caixa_id <> NEW.card_caixa_id OR orig.kind = 'refund') THEN
      RAISE EXCEPTION 'card_purchases: refund must point to a purchase or charge of the same card'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_refund_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: categories_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.categories_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'categories: kind cannot change (category %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_kind_immutable_check';
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    -- FOR SHARE bloqueia o pai contra uma mudança concorrente de parent_id.
    SELECT c.kind, c.parent_id INTO parent
      FROM categories c WHERE c.id = NEW.parent_id FOR SHARE;

    IF FOUND THEN
      IF parent.parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'categories: parent % is already a subcategory (max two levels)', NEW.parent_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth_check';
      END IF;
      IF parent.kind <> NEW.kind THEN
        RAISE EXCEPTION 'categories: kind % differs from parent kind %', NEW.kind, parent.kind
          USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_parent_kind_check';
      END IF;
    END IF;  -- pai inexistente: a FK reporta o erro.

    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'categories: % has subcategories and cannot become a subcategory', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: classification_rule_for(uuid, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classification_rule_for(p_caixa_id uuid, p_description text, p_amount_cents bigint) RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT r.id
    FROM classification_rules r
   WHERE r.archived_at IS NULL
     AND (r.caixa_id IS NULL OR r.caixa_id = p_caixa_id)
     AND (r.direction IS NULL OR r.direction = CASE WHEN p_amount_cents > 0 THEN 'in' ELSE 'out' END)
     AND CASE r.match_kind
           WHEN 'exact'       THEN lower(btrim(p_description)) = lower(btrim(r.pattern))
           WHEN 'starts_with' THEN starts_with(lower(btrim(p_description)), lower(btrim(r.pattern)))
           WHEN 'contains'    THEN strpos(lower(p_description), lower(btrim(r.pattern))) > 0
           WHEN 'regex'       THEN p_description ~* r.pattern
         END
   ORDER BY r.priority,
            (r.caixa_id IS NULL),
            array_position(ARRAY['exact', 'starts_with', 'contains', 'regex'], r.match_kind),
            length(r.pattern) DESC,
            r.id
   LIMIT 1
$$;


--
-- Name: FUNCTION classification_rule_for(p_caixa_id uuid, p_description text, p_amount_cents bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.classification_rule_for(p_caixa_id uuid, p_description text, p_amount_cents bigint) IS 'Regra ativa que classifica a descrição (sinal de p_amount_cents = direção) na caixa: menor prioridade, regra da caixa antes da global, exact > starts_with > contains > regex, padrão mais longo. NULL se nenhuma casa. Para cartão, passe a caixa do cartão e o valor da linha (compra −).';


--
-- Name: classification_rules_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classification_rules_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.category_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM categories c
                  WHERE c.id = NEW.category_id
                    AND c.kind <> CASE NEW.direction WHEN 'in' THEN 'income' ELSE 'expense' END) THEN
    RAISE EXCEPTION 'classification_rules: % rule requires % category', NEW.direction,
      CASE NEW.direction WHEN 'in' THEN 'income' ELSE 'expense' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_category_kind_check';
  END IF;

  IF NEW.match_kind = 'regex' THEN
    BEGIN
      PERFORM '' ~ NEW.pattern;
    EXCEPTION WHEN invalid_regular_expression THEN
      RAISE EXCEPTION 'classification_rules: invalid regular expression %', NEW.pattern
        USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_pattern_check';
    END;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contract_amendments_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_amendments_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - '{document_id,notes,created_by,updated_at}'::text[])
     IS DISTINCT FROM (to_jsonb(OLD) - '{document_id,notes,created_by,updated_at}'::text[])
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'contract_amendments: amendment % is immutable (only document_id and notes change)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_amendments_immutable_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contract_assert(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_assert(p_contract_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  st text;
BEGIN
  SELECT k.status INTO st FROM contracts k WHERE k.id = p_contract_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF (st = 'renewal_pending')
     <> EXISTS (SELECT 1 FROM contract_renewal_tasks r WHERE r.contract_id = p_contract_id AND r.status = 'open') THEN
    RAISE EXCEPTION 'contracts: contract % is % but % an open renewal task', p_contract_id, st,
      CASE WHEN st = 'renewal_pending' THEN 'has no' ELSE 'has' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_renewal_pending_check';
  END IF;
  IF st = 'draft' AND EXISTS (SELECT 1 FROM titles t WHERE t.contract_id = p_contract_id) THEN
    RAISE EXCEPTION 'contracts: draft contract % cannot have titles', p_contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_draft_titles_check';
  END IF;
END
$$;


--
-- Name: FUNCTION contract_assert(p_contract_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.contract_assert(p_contract_id uuid) IS 'Interna (constraint triggers no COMMIT): contrato renewal_pending ⇔ tarefa de renovação open (contracts_renewal_pending_check) e rascunho sem títulos (contracts_draft_titles_check).';


--
-- Name: contract_cycles_assert(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_cycles_assert(p_contract_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  r        record;
  prev_seq int := 0;
  prev_end date;
BEGIN
  FOR r IN SELECT y.seq, y.starts_on, y.ends_on FROM contract_cycles y WHERE y.contract_id = p_contract_id ORDER BY y.seq LOOP
    IF r.seq <> prev_seq + 1 OR (prev_end IS NOT NULL AND r.starts_on <> prev_end + 1) THEN
      RAISE EXCEPTION 'contract_cycles: cycle % of contract % must start on the day after cycle % ends (%)',
        r.seq, p_contract_id, prev_seq, prev_end
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_contiguous_check';
    END IF;
    prev_seq := r.seq;
    prev_end := r.ends_on;
  END LOOP;
END
$$;


--
-- Name: contract_cycles_contiguous_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_cycles_contiguous_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM contract_cycles_assert(CASE TG_OP WHEN 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END);
  RETURN NULL;
END
$$;


--
-- Name: contract_cycles_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_cycles_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.contract_id <> OLD.contract_id OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'contract_cycles: contract and seq cannot change (cycle %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_immutable_check';
  END IF;
  IF (NEW.starts_on <> OLD.starts_on OR NEW.duration_months <> OLD.duration_months
      OR NEW.periodicity <> OLD.periodicity)
     AND EXISTS (SELECT 1 FROM titles t WHERE t.contract_cycle_id = OLD.id) THEN
    RAISE EXCEPTION 'contract_cycles: cycle % has titles; start, duration and periodicity cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_locked_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contract_document_versions_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_document_versions_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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
    o := (o - 'content') || jsonb_build_object('content_bytes', octet_length(OLD.content));
  END IF;
  IF n IS NOT NULL THEN
    n := (n - 'content') || jsonb_build_object('content_bytes', octet_length(NEW.content));
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed);
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION contract_document_versions_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.contract_document_versions_audit_row() IS 'Trigger de auditoria de contract_document_versions: grava a linha sem content (só content_bytes); uma mudança de content apareceria só em changed_columns.';


--
-- Name: contract_document_versions_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_document_versions_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  doc_format text;
  next_version integer;
BEGIN
  SELECT d.format INTO doc_format FROM contract_documents d WHERE d.id = NEW.document_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;
  IF doc_format <> 'markdown' THEN
    RAISE EXCEPTION 'contract_document_versions: document % is not markdown', NEW.document_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_document_check';
  END IF;
  SELECT coalesce(max(v.version), 0) + 1 INTO next_version
    FROM contract_document_versions v WHERE v.document_id = NEW.document_id;
  IF NEW.version IS NULL THEN
    NEW.version := next_version;
  ELSIF NEW.version <> next_version THEN
    RAISE EXCEPTION 'contract_document_versions: next version of document % is %, got %', NEW.document_id,
      next_version, NEW.version
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_version_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contract_document_versions_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_document_versions_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM contract_documents d WHERE d.id = OLD.document_id) THEN
      RAISE EXCEPTION 'contract_document_versions: version % is immutable (archive the document instead)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_immutable_check';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.document_id <> OLD.document_id OR NEW.version <> OLD.version OR NEW.content <> OLD.content
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.author_kind <> OLD.author_kind
     OR NEW.restored_from_version_id IS DISTINCT FROM OLD.restored_from_version_id
     OR NEW.created_at <> OLD.created_at
     OR (NEW.author_user_id IS DISTINCT FROM OLD.author_user_id AND NEW.author_user_id IS NOT NULL)
     OR (NEW.ai_run_id IS DISTINCT FROM OLD.ai_run_id AND NEW.ai_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract_document_versions: version % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_immutable_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contract_documents_current_version_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_documents_current_version_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contract_documents d
              WHERE d.id = NEW.id AND d.format = 'markdown' AND d.current_version_id IS NULL) THEN
    RAISE EXCEPTION 'contract_documents: markdown document % needs a current version', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_documents_current_version_check';
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: contract_documents_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_documents_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  src_format text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.contract_id <> OLD.contract_id OR NEW.format <> OLD.format
                           OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id) THEN
    RAISE EXCEPTION 'contract_documents: contract, format and attachment cannot change (document %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_documents_immutable_check';
  END IF;
  IF NEW.source_document_id IS NOT NULL THEN
    SELECT d.format INTO src_format FROM contract_documents d WHERE d.id = NEW.source_document_id;
    IF FOUND AND src_format <> 'pdf' THEN
      RAISE EXCEPTION 'contract_documents: source document % must be a pdf', NEW.source_document_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_documents_source_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contract_refs_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_refs_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.contract_id IS NOT NULL THEN
    PERFORM contract_assert(OLD.contract_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.contract_id IS NOT NULL
     AND NEW.contract_id IS DISTINCT FROM (CASE TG_OP WHEN 'UPDATE' THEN OLD.contract_id END) THEN
    PERFORM contract_assert(NEW.contract_id);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: contract_renewal_tasks_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_renewal_tasks_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cyc contract_cycles;
  new_seq smallint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contract_id <> OLD.contract_id OR NEW.contract_cycle_id <> OLD.contract_cycle_id THEN
      RAISE EXCEPTION 'contract_renewal_tasks: contract and cycle cannot change (task %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_immutable_check';
    END IF;
    IF OLD.status <> 'open'
       AND (NEW.status <> OLD.status OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
            OR NEW.new_cycle_id IS DISTINCT FROM OLD.new_cycle_id
            OR NEW.opened_on <> OLD.opened_on OR NEW.due_on <> OLD.due_on
            OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL)) THEN
      RAISE EXCEPTION 'contract_renewal_tasks: task % was already decided (%)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_final_check';
    END IF;
  END IF;

  SELECT * INTO cyc FROM contract_cycles y WHERE y.id = NEW.contract_cycle_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;
  IF NEW.due_on <> cyc.ends_on THEN
    RAISE EXCEPTION 'contract_renewal_tasks: due_on % must be the end of cycle % (%)', NEW.due_on, cyc.id, cyc.ends_on
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_due_on_check';
  END IF;
  IF NEW.new_cycle_id IS NOT NULL THEN
    SELECT y.seq INTO new_seq FROM contract_cycles y WHERE y.id = NEW.new_cycle_id;
    IF FOUND AND new_seq <> cyc.seq + 1 THEN
      RAISE EXCEPTION 'contract_renewal_tasks: new cycle % must follow cycle % (seq %)', NEW.new_cycle_id, cyc.id, cyc.seq + 1
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_new_cycle_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: contracts_status_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contracts_status_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM contract_assert(NEW.id);
  RETURN NULL;
END
$$;


--
-- Name: contracts_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contracts_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cx       caixas;
  cp       caixas;
  cat_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'contracts: only draft contracts can be deleted (contract %, status %)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_delete_check';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'contracts: direction cannot change (contract %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_direction_immutable_check';
    END IF;
    IF OLD.status <> 'draft' AND (NEW.caixa_id <> OLD.caixa_id OR NEW.entity_id <> OLD.entity_id) THEN
      RAISE EXCEPTION 'contracts: caixa and entity only change in draft (contract %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_party_immutable_check';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'active')
      OR (OLD.status = 'active' AND NEW.status IN ('renewal_pending', 'ended', 'terminated'))
      OR (OLD.status = 'renewal_pending' AND NEW.status IN ('active', 'ended', 'terminated'))
      OR (OLD.status = 'ended' AND NEW.status IN ('active', 'renewal_pending'))) THEN
      RAISE EXCEPTION 'contracts: status cannot go from % to % (contract %)', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_status_transition_check';
    END IF;
  END IF;

  SELECT * INTO cx FROM caixas c WHERE c.id = NEW.caixa_id;
  IF FOUND THEN
    IF cx.kind <> 'general' THEN
      RAISE EXCEPTION 'contracts: caixa % must be general', NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_caixa_kind_check';
    END IF;
    IF cx.holder_entity_id = NEW.entity_id THEN
      RAISE EXCEPTION 'contracts: counterparty % is the holder of caixa %', NEW.entity_id, NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_entity_check';
    END IF;
  END IF;

  SELECT c.kind INTO cat_kind FROM categories c WHERE c.id = NEW.category_id;
  IF cat_kind IS NOT NULL
     AND cat_kind <> (CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END) THEN
    RAISE EXCEPTION 'contracts: % contract requires % category, got %', NEW.direction,
      CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END, cat_kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_category_kind_check';
  END IF;

  IF NEW.counterparty_caixa_id IS NOT NULL THEN
    SELECT * INTO cp FROM caixas c WHERE c.id = NEW.counterparty_caixa_id;
    IF FOUND AND (cp.kind <> 'general' OR cp.holder_entity_id <> NEW.entity_id) THEN
      RAISE EXCEPTION 'contracts: counterparty caixa % must be general and held by entity %',
        NEW.counterparty_caixa_id, NEW.entity_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_counterparty_caixa_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: entity_tag_links_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.entity_tag_links_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION entity_tag_links_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.entity_tag_links_audit_row() IS 'Trigger de auditoria de entity_tag_links: grava com record_id = entity_id (a ligação não tem id), para atribuir e remover tags aparecerem no histórico da entidade.';


--
-- Name: entity_tag_links_tag_active(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.entity_tag_links_tag_active() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION entity_tag_links_tag_active(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.entity_tag_links_tag_active() IS 'Trigger de entity_tag_links: recusa ligar uma tag arquivada (23514 entity_tag_links_tag_active_check).';


--
-- Name: financial_account_balance_at(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.financial_account_balance_at(p_account_id uuid, p_on date) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN p_on < a.opening_date THEN NULL
              ELSE a.opening_balance_cents
                   + coalesce((SELECT sum(m.amount_cents)
                                 FROM movements m
                                WHERE m.financial_account_id = a.id AND m.occurred_on <= p_on), 0)
         END::bigint
    FROM financial_accounts a
   WHERE a.id = p_account_id
$$;


--
-- Name: FUNCTION financial_account_balance_at(p_account_id uuid, p_on date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.financial_account_balance_at(p_account_id uuid, p_on date) IS 'Saldo da conta ao fim do dia p_on (saldo inicial + movimentos até a data). NULL antes da abertura ou se a conta não existe.';


--
-- Name: financial_accounts_period_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.financial_accounts_period_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM period_closings pc
              WHERE pc.caixa_id = OLD.caixa_id
                AND pc.month >= date_trunc('month', least(OLD.opening_date, NEW.opening_date))::date) THEN
    RAISE EXCEPTION 'financial_accounts: opening of account % falls in or before a closed month of caixa %',
      OLD.id, OLD.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: financial_accounts_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.financial_accounts_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.caixa_id AND c.kind = 'general') THEN
    RAISE EXCEPTION 'financial_accounts: caixa % must be a general caixa', NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'financial_accounts_caixa_kind_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: financial_accounts_validate_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.financial_accounts_validate_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.caixa_id <> OLD.caixa_id
     AND (EXISTS (SELECT 1 FROM movements m WHERE m.financial_account_id = OLD.id)
          OR EXISTS (SELECT 1 FROM settlements s WHERE s.financial_account_id = OLD.id)) THEN
    RAISE EXCEPTION 'financial_accounts: account % has history and cannot change caixa', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'financial_accounts_caixa_history_check';
  END IF;
  IF NEW.opening_date > OLD.opening_date
     AND EXISTS (SELECT 1 FROM movements m
                  WHERE m.financial_account_id = OLD.id AND m.occurred_on < NEW.opening_date) THEN
    RAISE EXCEPTION 'financial_accounts: account % has movements before %', OLD.id, NEW.opening_date
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_opening_date_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: flow_graph_edges(uuid[], date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.flow_graph_edges(p_caixa_ids uuid[], p_from date, p_to date) RETURNS TABLE(source_kind text, source_id uuid, target_kind text, target_id uuid, edge_kind text, payer_caixa_id uuid, realized_cents bigint, forecast_cents bigint, lines integer)
    LANGUAGE sql STABLE
    AS $$
  SELECT l.source_kind, l.source_id, l.target_kind, l.target_id, l.edge_kind, l.payer_caixa_id,
         sum(l.realized_cents)::bigint, sum(l.forecast_cents)::bigint, count(*)::int
    FROM flow_graph_lines(p_caixa_ids, p_from, p_to) l
   GROUP BY 1, 2, 3, 4, 5, 6
   ORDER BY 5, 1, 2, 3, 4, 6
$$;


--
-- Name: FUNCTION flow_graph_edges(p_caixa_ids uuid[], p_from date, p_to date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.flow_graph_edges(p_caixa_ids uuid[], p_from date, p_to date) IS 'Arestas agregadas do canvas (spec 014): soma de flow_graph_lines por origem, destino, edge_kind e pagadora (payer_caixa_id separa as compras de um cartão por pagadora, para o rastreio pagadora → cartão → lojista; nulo nos outros tipos). realized_cents (traço contínuo) e forecast_cents (tracejado).';


--
-- Name: flow_graph_lines(uuid[], date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.flow_graph_lines(p_caixa_ids uuid[], p_from date, p_to date) RETURNS TABLE(source_kind text, source_id uuid, target_kind text, target_id uuid, edge_kind text, payer_caixa_id uuid, category_id uuid, ref_kind text, ref_id uuid, occurred_on date, realized_cents bigint, forecast_cents bigint)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION 'flow_graph: invalid period % .. % (max 3660 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH
  -- Títulos que representam o fluxo: o lado a receber de um par cuja outra caixa está na lista é pulado.
  tt AS (
    SELECT t.*, cp.holder_entity_id AS cp_holder, (cp.id = ANY (p_caixa_ids)) AS cp_in
      FROM titles t
      LEFT JOIN caixas cp ON cp.id = t.counterparty_caixa_id
     WHERE t.caixa_id = ANY (p_caixa_ids)
       AND NOT (t.direction = 'receivable' AND coalesce(cp.id = ANY (p_caixa_ids), false))
  ),
  title_ends AS (
    SELECT tt.*,
           CASE WHEN tt.direction = 'payable' THEN 'caixa'
                ELSE 'entity' END AS s_kind,
           CASE WHEN tt.direction = 'payable' THEN tt.caixa_id
                ELSE tt.entity_id END AS s_id,
           CASE WHEN tt.direction = 'receivable' THEN 'caixa'
                WHEN coalesce(tt.cp_in, false) THEN 'caixa'
                ELSE 'entity' END AS t_kind,
           CASE WHEN tt.direction = 'receivable' THEN tt.caixa_id
                WHEN coalesce(tt.cp_in, false) THEN tt.counterparty_caixa_id
                ELSE tt.entity_id END AS t_id,
           CASE WHEN tt.origin = 'card_invoice' THEN 'card_invoice'
                WHEN tt.direction = 'payable' THEN 'payment'
                ELSE 'receipt' END AS e_kind,
           CASE WHEN tt.origin = 'card_invoice'
                THEN CASE tt.direction WHEN 'payable' THEN tt.caixa_id ELSE tt.counterparty_caixa_id END
           END AS payer_id
      FROM tt
  )
  -- Realizado: baixas ativas no período.
  SELECT e.s_kind, e.s_id, e.t_kind, e.t_id, e.e_kind, e.payer_id, e.category_id,
         'settlement'::text, s.id, s.settled_on,
         (s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents)::bigint, 0::bigint
    FROM title_ends e
    JOIN settlements s ON s.title_id = e.id
   WHERE s.reversed_at IS NULL AND s.settled_on BETWEEN p_from AND p_to
  UNION ALL
  -- Previsto: saldo aberto dos títulos que vencem no período (antecipação de fatura aberta está na previsão dela).
  SELECT e.s_kind, e.s_id, e.t_kind, e.t_id, e.e_kind, e.payer_id, e.category_id,
         'title'::text, e.id, e.due_date, 0::bigint, b.open_cents
    FROM title_ends e
    JOIN title_balances b ON b.title_id = e.id
    LEFT JOIN card_invoices v ON v.id = e.card_invoice_id
   WHERE b.open_cents > 0 AND e.archived_at IS NULL AND e.due_date BETWEEN p_from AND p_to
     AND (v.id IS NULL OR v.closed_at IS NOT NULL)
  UNION ALL
  -- Faturas abertas: previsão por pagadora (itens − antecipações).
  SELECT CASE WHEN x.payer_caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN x.payer_caixa_id = ANY (p_caixa_ids) THEN x.payer_caixa_id ELSE payer.holder_entity_id END,
         CASE WHEN x.card_caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN x.card_caixa_id = ANY (p_caixa_ids) THEN x.card_caixa_id ELSE card.holder_entity_id END,
         'card_invoice'::text, x.payer_caixa_id, NULL::uuid,
         'card_invoice'::text, x.card_invoice_id, x.due_date, 0::bigint, (x.items_cents - x.settled_cents)::bigint
    FROM card_invoice_payer_totals x
    JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
    JOIN caixas payer ON payer.id = x.payer_caixa_id
    JOIN caixas card ON card.id = x.card_caixa_id
   WHERE (x.payer_caixa_id = ANY (p_caixa_ids) OR x.card_caixa_id = ANY (p_caixa_ids))
     AND x.due_date BETWEEN p_from AND p_to
     AND x.items_cents - x.settled_cents > 0
  UNION ALL
  -- Compras do cartão: cartão → recebedor final.
  SELECT 'caixa'::text, p.card_caixa_id, 'entity'::text, p.entity_id, 'card_purchase'::text, p.payer_caixa_id,
         p.category_id, 'card_purchase'::text, p.id, p.purchased_on,
         (CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END)::bigint, 0::bigint
    FROM card_purchases p
   WHERE p.card_caixa_id = ANY (p_caixa_ids) AND p.purchased_on BETWEEN p_from AND p_to
  UNION ALL
  -- Transferências entre caixas diferentes.
  SELECT CASE WHEN fa.caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN fa.caixa_id = ANY (p_caixa_ids) THEN fa.caixa_id ELSE fc.holder_entity_id END,
         CASE WHEN ta.caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN ta.caixa_id = ANY (p_caixa_ids) THEN ta.caixa_id ELSE tc.holder_entity_id END,
         'transfer'::text, NULL::uuid, NULL::uuid, 'transfer'::text, tr.id, tr.transferred_on,
         tr.amount_cents, 0::bigint
    FROM transfers tr
    JOIN financial_accounts fa ON fa.id = tr.from_account_id
    JOIN financial_accounts ta ON ta.id = tr.to_account_id
    JOIN caixas fc ON fc.id = fa.caixa_id
    JOIN caixas tc ON tc.id = ta.caixa_id
   WHERE fa.caixa_id <> ta.caixa_id
     AND (fa.caixa_id = ANY (p_caixa_ids) OR ta.caixa_id = ANY (p_caixa_ids))
     AND tr.transferred_on BETWEEN p_from AND p_to
  UNION ALL
  -- Ajustes com entidade.
  SELECT CASE WHEN m.amount_cents < 0 THEN 'caixa' ELSE 'entity' END,
         CASE WHEN m.amount_cents < 0 THEN a.caixa_id ELSE m.entity_id END,
         CASE WHEN m.amount_cents < 0 THEN 'entity' ELSE 'caixa' END,
         CASE WHEN m.amount_cents < 0 THEN m.entity_id ELSE a.caixa_id END,
         CASE WHEN m.amount_cents < 0 THEN 'payment' ELSE 'receipt' END,
         NULL::uuid, m.category_id, 'movement'::text, m.id, m.occurred_on, abs(m.amount_cents)::bigint, 0::bigint
    FROM movements m
    JOIN financial_accounts a ON a.id = m.financial_account_id
   WHERE m.kind = 'adjustment' AND m.entity_id IS NOT NULL
     AND a.caixa_id = ANY (p_caixa_ids) AND m.occurred_on BETWEEN p_from AND p_to;
END
$$;


--
-- Name: FUNCTION flow_graph_lines(p_caixa_ids uuid[], p_from date, p_to date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.flow_graph_lines(p_caixa_ids uuid[], p_from date, p_to date) IS 'Linhas do canvas de fluxo (spec 014), uma por registro: origem e destino (source_kind/target_kind = caixa | entity), edge_kind (payment | receipt | transfer | card_invoice | card_purchase), payer_caixa_id (pagadora, só em card_invoice e card_purchase), categoria, registro de origem (ref_kind = settlement | title | card_invoice | card_purchase | transfer | movement, ref_id), data e valor realizado ou previsto. É o detalhe da gaveta de uma aresta. Caixa fora de p_caixa_ids vira o nó do titular. Erro 22023: período inválido (até 3660 dias).';


--
-- Name: flow_graph_nodes(uuid[], date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.flow_graph_nodes(p_caixa_ids uuid[], p_from date, p_to date) RETURNS TABLE(node_kind text, node_id uuid, name text, caixa_kind text, entity_kind text, holder_entity_id uuid, balance_cents bigint, card_used_cents bigint, main_category_id uuid, main_group_category_id uuid, realized_in_cents bigint, realized_out_cents bigint, forecast_in_cents bigint, forecast_out_cents bigint)
    LANGUAGE sql STABLE
    AS $$
  WITH l AS (
    SELECT * FROM flow_graph_lines(p_caixa_ids, p_from, p_to)
  ),
  ends AS (
    SELECT l.target_kind AS k, l.target_id AS id, l.realized_cents AS r_in, 0::bigint AS r_out,
           l.forecast_cents AS f_in, 0::bigint AS f_out, l.category_id
      FROM l
    UNION ALL
    SELECT l.source_kind, l.source_id, 0, l.realized_cents, 0, l.forecast_cents, l.category_id
      FROM l
  ),
  totals AS (
    SELECT e.k, e.id, sum(e.r_in) AS r_in, sum(e.r_out) AS r_out, sum(e.f_in) AS f_in, sum(e.f_out) AS f_out
      FROM ends e GROUP BY 1, 2
  ),
  -- Categoria principal da entidade (para agrupar folhas): a de maior volume nas linhas dela.
  main_cat AS (
    SELECT DISTINCT ON (e.id) e.id, e.category_id
      FROM ends e
     WHERE e.k = 'entity' AND e.category_id IS NOT NULL
     GROUP BY e.id, e.category_id
     ORDER BY e.id, sum(abs(e.r_in) + abs(e.r_out) + abs(e.f_in) + abs(e.f_out)) DESC, e.category_id
  )
  SELECT 'caixa'::text, c.id, c.name, c.kind, NULL::text, c.holder_entity_id,
         CASE WHEN c.kind = 'general' THEN
           coalesce((SELECT sum(financial_account_balance_at(a.id, p_to)) FROM financial_accounts a WHERE a.caixa_id = c.id), 0)
         END::bigint,
         (SELECT cl.used_cents FROM card_limits cl WHERE cl.card_caixa_id = c.id)::bigint,
         NULL::uuid, NULL::uuid,
         coalesce(t.r_in, 0)::bigint, coalesce(t.r_out, 0)::bigint, coalesce(t.f_in, 0)::bigint, coalesce(t.f_out, 0)::bigint
    FROM caixas c
    LEFT JOIN totals t ON t.k = 'caixa' AND t.id = c.id
   WHERE c.id = ANY (p_caixa_ids)
  UNION ALL
  SELECT 'entity'::text, en.id, coalesce(en.trade_name, en.name), NULL::text, en.kind, NULL::uuid,
         NULL::bigint, NULL::bigint, mc.category_id, coalesce(cat.parent_id, cat.id),
         t.r_in::bigint, t.r_out::bigint, t.f_in::bigint, t.f_out::bigint
    FROM totals t
    JOIN entities en ON en.id = t.id
    LEFT JOIN main_cat mc ON mc.id = en.id
    LEFT JOIN categories cat ON cat.id = mc.category_id
   WHERE t.k = 'entity'
   ORDER BY 1, 3, 2
$$;


--
-- Name: FUNCTION flow_graph_nodes(p_caixa_ids uuid[], p_from date, p_to date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.flow_graph_nodes(p_caixa_ids uuid[], p_from date, p_to date) IS 'Nós do canvas (spec 014): todas as caixas de p_caixa_ids (node_kind caixa: balance_cents = soma dos saldos das contas no fim de p_to, só em general; card_used_cents = limite usado, só em cartão) e as entidades que aparecem nas arestas (node_kind entity: nome fantasia ou nome; main_category_id / main_group_category_id = categoria de maior volume, para agrupar folhas). Totais de entrada e saída, realizados e previstos, no período.';


--
-- Name: is_valid_boleto_barcode(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_valid_boleto_barcode(code text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
DECLARE
  body text;
  s    int := 0;
  w    int := 2;
  p    int;
  r    int;
  dv   int;
BEGIN
  IF code !~ '^[0-9]{44}$' THEN
    RETURN false;
  END IF;

  IF left(code, 1) <> '8' THEN
    -- Bancário: DV geral na posição 5, módulo 11 (pesos 2..9 da direita); 0, 10 e 11 viram 1.
    body := left(code, 4) || substr(code, 6);
    FOR i IN REVERSE 43..1 LOOP
      s := s + substr(body, i, 1)::int * w;
      w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
    END LOOP;
    dv := 11 - s % 11;
    IF dv IN (0, 10, 11) THEN
      dv := 1;
    END IF;
    RETURN dv = substr(code, 5, 1)::int;
  END IF;

  -- Convênio (arrecadação, começa com 8): DV na posição 4; o 3º dígito diz o módulo.
  body := left(code, 3) || substr(code, 5);
  IF substr(code, 3, 1) IN ('6', '7') THEN
    FOR i IN REVERSE 43..1 LOOP
      p := substr(body, i, 1)::int * w;
      s := s + p / 10 + p % 10;
      w := 3 - w;
    END LOOP;
    dv := (10 - s % 10) % 10;
  ELSIF substr(code, 3, 1) IN ('8', '9') THEN
    FOR i IN REVERSE 43..1 LOOP
      s := s + substr(body, i, 1)::int * w;
      w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
    END LOOP;
    r := s % 11;
    dv := CASE WHEN r IN (0, 1) THEN 0 ELSE 11 - r END;
  ELSE
    RETURN false;
  END IF;
  RETURN dv = substr(code, 4, 1)::int;
END
$_$;


--
-- Name: FUNCTION is_valid_boleto_barcode(code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_valid_boleto_barcode(code text) IS 'Valida o código de barras de boleto (44 dígitos, JÁ NORMALIZADO, sem espaços/pontos). Bancário: DV na posição 5, módulo 11. Convênio (começa com 8): DV na posição 4, módulo 10 (3º dígito 6/7) ou 11 (8/9). A linha digitável (47/48 dígitos) é convertida para o código de barras pela aplicação. NULL => NULL.';


--
-- Name: is_valid_brcode(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_valid_brcode(payload text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
DECLARE
  bytes bytea;
  crc   int := 65535;  -- CRC-16/CCITT-FALSE: polinômio 0x1021, inicial 0xFFFF.
BEGIN
  IF length(payload) NOT BETWEEN 30 AND 512
     OR payload !~ '^000201'
     OR payload !~ '6304[0-9A-Fa-f]{4}$'
     OR position('br.gov.bcb.pix' IN lower(payload)) = 0 THEN
    RETURN false;
  END IF;

  bytes := convert_to(left(payload, length(payload) - 4), 'UTF8');
  FOR i IN 0..length(bytes) - 1 LOOP
    crc := crc # (get_byte(bytes, i) << 8);
    FOR b IN 1..8 LOOP
      IF crc & 32768 <> 0 THEN
        crc := ((crc << 1) # 4129) & 65535;
      ELSE
        crc := (crc << 1) & 65535;
      END IF;
    END LOOP;
  END LOOP;

  RETURN upper(right(payload, 4)) = lpad(upper(to_hex(crc)), 4, '0');
END
$_$;


--
-- Name: FUNCTION is_valid_brcode(payload text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_valid_brcode(payload text) IS 'Valida um PIX copia-e-cola (BR Code): começa com 000201, tem o GUI br.gov.bcb.pix, 30 a 512 caracteres e termina no campo 63 (CRC) com o CRC-16/CCITT-FALSE correto do payload. Não interpreta os demais campos. NULL => NULL.';


--
-- Name: is_valid_cnpj(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_valid_cnpj(cnpj text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
DECLARE
  w1 constant int[] := '{5,4,3,2,9,8,7,6,5,4,3,2}';
  w2 constant int[] := '{6,5,4,3,2,9,8,7,6,5,4,3,2}';
  s  int;
  dv int;
BEGIN
  IF cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' OR cnpj = repeat(left(cnpj, 1), 14) THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..12 LOOP
    s := s + (ascii(substr(cnpj, i, 1)) - 48) * w1[i];
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  IF dv <> substr(cnpj, 13, 1)::int THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..13 LOOP
    s := s + (ascii(substr(cnpj, i, 1)) - 48) * w2[i];
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  RETURN dv = substr(cnpj, 14, 1)::int;
END
$_$;


--
-- Name: FUNCTION is_valid_cnpj(cnpj text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_valid_cnpj(cnpj text) IS 'Valida um CNPJ numérico ou alfanumérico (IN RFB, vigente desde jul/2026). Recebe o valor JÁ NORMALIZADO: 14 caracteres, os 12 primeiros [0-9A-Z] (letras MAIÚSCULAS) e os 2 últimos dígitos verificadores numéricos, sem pontos/barra/traço. Valor de cada caractere = ASCII - 48; pesos e módulo 11 do algoritmo clássico. Rejeita sequências repetidas. NULL => NULL.';


--
-- Name: is_valid_cpf(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_valid_cpf(cpf text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
DECLARE
  s  int;
  dv int;
BEGIN
  IF cpf !~ '^[0-9]{11}$' OR cpf = repeat(left(cpf, 1), 11) THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..9 LOOP
    s := s + substr(cpf, i, 1)::int * (11 - i);
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  IF dv <> substr(cpf, 10, 1)::int THEN
    RETURN false;
  END IF;

  s := 0;
  FOR i IN 1..10 LOOP
    s := s + substr(cpf, i, 1)::int * (12 - i);
  END LOOP;
  dv := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  RETURN dv = substr(cpf, 11, 1)::int;
END
$_$;


--
-- Name: FUNCTION is_valid_cpf(cpf text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_valid_cpf(cpf text) IS 'Valida os dígitos verificadores de um CPF. Recebe o valor JÁ NORMALIZADO: exatamente 11 dígitos, sem pontos/traço. Formatado ou com espaços => false. Rejeita sequências repetidas (000…0 a 999…9). NULL => NULL.';


--
-- Name: is_valid_nfe_access_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_valid_nfe_access_key(access_key text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
DECLARE
  s  int := 0;
  w  int := 2;
  r  int;
BEGIN
  IF access_key !~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$' THEN
    RETURN false;
  END IF;
  FOR i IN REVERSE 43..1 LOOP
    s := s + (ascii(substr(access_key, i, 1)) - 48) * w;
    w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
  END LOOP;
  r := s % 11;
  RETURN (CASE WHEN r IN (0, 1) THEN 0 ELSE 11 - r END) = ascii(substr(access_key, 44, 1)) - 48;
END
$_$;


--
-- Name: FUNCTION is_valid_nfe_access_key(access_key text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_valid_nfe_access_key(access_key text) IS 'Valida a chave de acesso de NF-e/NFC-e (NT 2025.001), JÁ NORMALIZADA: 44 caracteres ^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$ (o CNPJ do emitente, posições 7–20, pode ser alfanumérico; só maiúsculas) e DV módulo 11 sobre os 43 primeiros, cada caractere = ASCII − 48, pesos 2..9 da direita, resto 0 ou 1 => 0. NULL => NULL.';


--
-- Name: mcp_header_names(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_header_names(p_headers jsonb) RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT coalesce(array_agg(k ORDER BY lower(k)), '{}') FROM jsonb_object_keys(p_headers) k
$$;


--
-- Name: FUNCTION mcp_header_names(p_headers jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mcp_header_names(p_headers jsonb) IS 'Nomes dos cabeçalhos (sem os valores), em ordem alfabética.';


--
-- Name: mcp_headers_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_headers_valid(p_headers jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
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
$_$;


--
-- Name: FUNCTION mcp_headers_valid(p_headers jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mcp_headers_valid(p_headers jsonb) IS 'true se os cabeçalhos são um objeto nome → valor (string) com até 30 nomes de token HTTP distintos sem distinção de maiúsculas, valores até 8000 caracteres sem quebra de linha, e sem os cabeçalhos que o transporte controla (Host, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version…).';


--
-- Name: mcp_server_merge_headers(uuid, jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_server_merge_headers(p_server_id uuid, p_set jsonb DEFAULT '{}'::jsonb, p_remove text[] DEFAULT '{}'::text[]) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION mcp_server_merge_headers(p_server_id uuid, p_set jsonb, p_remove text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mcp_server_merge_headers(p_server_id uuid, p_set jsonb, p_remove text[]) IS 'Troca só alguns cabeçalhos sem ler os demais: remove os nomes de p_remove e define os de p_set (nomes sem distinção de maiúsculas). Devolve os nomes resultantes. P0002 se o servidor não existe; 22023 se p_set não é objeto; 23514 (mcp_servers_secret_headers_check) se o resultado é inválido. Auditado como UPDATE (sem os valores).';


--
-- Name: message_destination_token(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_destination_token(p_message_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION message_destination_token(p_message_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.message_destination_token(p_message_id uuid) IS 'Devolve o bot token do destino de uma mensagem RESERVADA pelo worker (status sending); erro 42501 em qualquer outro status e P0002 se a mensagem não existe. Única forma de a aplicação ler message_destinations.bot_token.';


--
-- Name: message_destinations_cancel_pending(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_destinations_cancel_pending() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE message_outbox o
     SET status = 'canceled', last_error = 'destination_inactive'
   WHERE o.destination_id = NEW.id AND o.status IN ('pending', 'failed');
  RETURN NULL;
END
$$;


--
-- Name: message_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_outbox (
    id uuid DEFAULT uuidv7() NOT NULL,
    destination_id uuid NOT NULL,
    subscription_id uuid,
    event_kind text NOT NULL,
    dedup_key text,
    caixa_id uuid,
    user_id uuid,
    agent_run_id text,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    sent_at timestamp with time zone,
    last_error text,
    provider_message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_outbox_attempts_check CHECK ((((max_attempts >= 1) AND (max_attempts <= 20)) AND ((attempts >= 0) AND (attempts <= max_attempts)))),
    CONSTRAINT message_outbox_dedup_key_check CHECK (((btrim(dedup_key) <> ''::text) AND (length(dedup_key) <= 300))),
    CONSTRAINT message_outbox_event_kind_check CHECK ((event_kind = ANY (ARRAY['due_reminder'::text, 'overdue'::text, 'daily_summary'::text, 'weekly_summary'::text, 'invoice_closed'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'agent_completed'::text, 'agent_message'::text, 'contract_notice_deadline'::text, 'contract_ending'::text, 'contract_renewal_pending'::text, 'contract_readjustment'::text, 'test'::text]))),
    CONSTRAINT message_outbox_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT message_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT message_outbox_status_fields_check CHECK ((((status = 'sending'::text) = (locked_at IS NOT NULL)) AND ((status = 'sent'::text) = (sent_at IS NOT NULL)) AND ((status <> ALL (ARRAY['failed'::text, 'canceled'::text])) OR (last_error IS NOT NULL))))
);


--
-- Name: TABLE message_outbox; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_outbox IS 'Fila de saída e histórico de mensagens (spec 013). O worker reserva com message_outbox_claim (FOR UPDATE SKIP LOCKED), envia fora da transação e fecha com message_outbox_mark_sent / message_outbox_mark_failed. Fora da auditoria (é fila operacional; o histórico é a própria tabela).';


--
-- Name: COLUMN message_outbox.event_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.event_kind IS 'Evento que gerou a mensagem (os de message_subscriptions, mais test).';


--
-- Name: COLUMN message_outbox.dedup_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.dedup_key IS 'Chave do evento, única por destino (ex.: due_reminder:<title_id>:D-3:2026-10-12): enfileirar com ON CONFLICT (destination_id, dedup_key) DO NOTHING para nunca mandar o mesmo lembrete duas vezes. Nulo = sem dedup.';


--
-- Name: COLUMN message_outbox.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.payload IS 'Mensagem já montada (ex.: {"text": "...", "parse_mode": "HTML"}). Nunca contém o bot token nem senhas. Imutável.';


--
-- Name: COLUMN message_outbox.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.status IS 'pending (aguarda next_attempt_at) → sending (reservada por um worker, locked_at) → sent | pending (retry) | failed (esgotou ou erro permanente). canceled: destino desativado ou cancelada pela aplicação. failed → pending = reenviar.';


--
-- Name: COLUMN message_outbox.attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.attempts IS 'Tentativas já iniciadas (o claim soma 1).';


--
-- Name: COLUMN message_outbox.locked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.locked_at IS 'Quando o worker reservou (só em sending). Reserva velha é retomada pelo claim.';


--
-- Name: COLUMN message_outbox.provider_message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_outbox.provider_message_id IS 'Id da mensagem no provedor (Telegram message_id), após o envio.';


--
-- Name: message_outbox_claim(integer, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_outbox_claim(p_limit integer DEFAULT 10, p_stale_after interval DEFAULT '00:05:00'::interval) RETURNS SETOF public.message_outbox
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION message_outbox_claim(p_limit integer, p_stale_after interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.message_outbox_claim(p_limit integer, p_stale_after interval) IS 'Reserva até p_limit mensagens prontas (pending com next_attempt_at <= agora, ou sending com reserva mais velha que p_stale_after) com FOR UPDATE SKIP LOCKED: status = sending, locked_at = agora, attempts + 1; devolve as linhas. Reserva velha sem tentativas restantes vira failed. Rode numa transação curta e faça COMMIT antes de enviar. Erro 22023: parâmetros inválidos.';


--
-- Name: message_outbox_claim_one(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_outbox_claim_one(p_message_id uuid) RETURNS SETOF public.message_outbox
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  UPDATE message_outbox o
     SET status = 'sending', locked_at = clock_timestamp(), attempts = o.attempts + 1
   WHERE o.id IN (SELECT x.id FROM message_outbox x
                   WHERE x.id = p_message_id AND x.status = 'pending' AND x.attempts < x.max_attempts
                   FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
END
$$;


--
-- Name: FUNCTION message_outbox_claim_one(p_message_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.message_outbox_claim_one(p_message_id uuid) IS 'Reserva UMA mensagem pendente (ex.: o "enviar teste" logo após enfileirar), com a mesma transição do message_outbox_claim: status = sending, locked_at = agora, attempts + 1. Ignora next_attempt_at. Devolve a linha, ou nada se ela não existe, não está pending, esgotou as tentativas ou está travada por outro worker (SKIP LOCKED).';


--
-- Name: message_outbox_mark_failed(uuid, text, interval, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_outbox_mark_failed(p_message_id uuid, p_error text, p_retry_after interval DEFAULT NULL::interval, p_permanent boolean DEFAULT false) RETURNS text
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION message_outbox_mark_failed(p_message_id uuid, p_error text, p_retry_after interval, p_permanent boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.message_outbox_mark_failed(p_message_id uuid, p_error text, p_retry_after interval, p_permanent boolean) IS 'Registra a falha de uma tentativa de uma mensagem em sending. Volta a pending com next_attempt_at = agora + p_retry_after (ex.: retry_after do Telegram 429) ou backoff 30 s × 2^(tentativa−1), máximo 1 h; vira failed se p_permanent (ex.: chat não existe, token inválido) ou se esgotou max_attempts. Devolve o novo status. Erro 23514 (message_outbox_transition_check) se ela não está em sending.';


--
-- Name: message_outbox_mark_sent(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_outbox_mark_sent(p_message_id uuid, p_provider_message_id text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION message_outbox_mark_sent(p_message_id uuid, p_provider_message_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.message_outbox_mark_sent(p_message_id uuid, p_provider_message_id text) IS 'Fecha uma mensagem reservada como enviada (sent_at, id no provedor). Erro 23514 (message_outbox_transition_check) se ela não está em sending.';


--
-- Name: message_outbox_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_outbox_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: message_subscription_params_valid(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
  max_days int := 60;
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
    WHEN 'contract_notice_deadline', 'contract_ending' THEN
      allowed := '{days_before,send_at}'; required := '{days_before,send_at}'; max_days := 180;
    WHEN 'contract_renewal_pending' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'contract_readjustment' THEN allowed := '{send_at}'; required := '{send_at}';
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
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > max_days) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$_$;


--
-- Name: FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.message_subscription_params_valid(p_event_kind text, p_params jsonb) IS 'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent 1–200; repeat_every_days 1–30). Usada no CHECK de message_subscriptions.';


--
-- Name: movement_counterparty(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.movement_counterparty(p_kind text, p_settlement_id uuid, p_entity_id uuid) RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT CASE p_kind
           WHEN 'adjustment' THEN p_entity_id
           WHEN 'settlement' THEN (SELECT t.entity_id FROM settlements s JOIN titles t ON t.id = s.title_id
                                    WHERE s.id = p_settlement_id AND t.origin <> 'card_invoice')
         END
$$;


--
-- Name: FUNCTION movement_counterparty(p_kind text, p_settlement_id uuid, p_entity_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.movement_counterparty(p_kind text, p_settlement_id uuid, p_entity_id uuid) IS 'Interna dos relatórios (filtro por entidade): contraparte de um movimento = entidade do título da baixa (nula se card_invoice) ou do ajuste; transferência = nula.';


--
-- Name: movements_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.movements_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.settlement_id IS NOT NULL THEN PERFORM settlement_assert_movements(OLD.settlement_id); END IF;
    IF OLD.transfer_id IS NOT NULL THEN PERFORM transfer_assert_movements(OLD.transfer_id); END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.settlement_id IS NOT NULL THEN PERFORM settlement_assert_movements(NEW.settlement_id); END IF;
    IF NEW.transfer_id IS NOT NULL THEN PERFORM transfer_assert_movements(NEW.transfer_id); END IF;
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: movements_period_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.movements_period_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.financial_account_id = OLD.financial_account_id AND NEW.occurred_on = OLD.occurred_on
     AND NEW.amount_cents = OLD.amount_cents AND NEW.kind = OLD.kind
     AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
     AND NEW.transfer_id IS NOT DISTINCT FROM OLD.transfer_id
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM period_assert_open(a.caixa_id, OLD.occurred_on, 'movements')
       FROM financial_accounts a WHERE a.id = OLD.financial_account_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM period_assert_open(a.caixa_id, NEW.occurred_on, 'movements')
       FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;


--
-- Name: movements_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.movements_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  opening  date;
  cat_kind text;
BEGIN
  SELECT a.opening_date INTO opening FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
  IF NEW.occurred_on < opening THEN
    RAISE EXCEPTION 'movements: date % is before the opening date % of account %',
      NEW.occurred_on, opening, NEW.financial_account_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_opening_date_check';
  END IF;

  IF NEW.category_id IS NOT NULL THEN
    SELECT c.kind INTO cat_kind FROM categories c WHERE c.id = NEW.category_id;
    IF cat_kind <> (CASE WHEN NEW.amount_cents > 0 THEN 'income' ELSE 'expense' END) THEN
      RAISE EXCEPTION 'movements: % movement requires % category, got %',
        CASE WHEN NEW.amount_cents > 0 THEN 'incoming' ELSE 'outgoing' END,
        CASE WHEN NEW.amount_cents > 0 THEN 'income' ELSE 'expense' END, cat_kind
        USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_category_kind_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: movements_validate_statement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.movements_validate_statement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_lines l
              WHERE l.movement_id = OLD.id AND l.status = 'matched'
                AND (l.financial_account_id <> NEW.financial_account_id OR l.amount_cents <> NEW.amount_cents)) THEN
    RAISE EXCEPTION 'movements: movement % is reconciled with a statement line', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_movement_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: period_assert_open(uuid, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.period_assert_open(p_caixa_id uuid, p_on date, p_what text) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_caixa_id IS NOT NULL AND p_on IS NOT NULL AND period_is_closed(p_caixa_id, p_on) THEN
    RAISE EXCEPTION '%: month % is closed in caixa %', p_what, to_char(p_on, 'YYYY-MM'), p_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
END
$$;


--
-- Name: FUNCTION period_assert_open(p_caixa_id uuid, p_on date, p_what text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.period_assert_open(p_caixa_id uuid, p_on date, p_what text) IS 'Erro 23514 (period_closings_locked_check) se o mês da data está fechado na caixa.';


--
-- Name: period_closings_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.period_closings_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  uid_text text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.caixa_id <> OLD.caixa_id OR NEW.month <> OLD.month THEN
      RAISE EXCEPTION 'period_closings: caixa and month of closing % cannot change', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_immutable_check';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE = reabrir.
  IF uid_text IS NULL
     OR uid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uid_text::uuid AND u.role = 'admin' AND u.is_active) THEN
    RAISE EXCEPTION 'period_closings: only an active admin (app.user_id) can reopen a closed month'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END
$_$;


--
-- Name: period_is_closed(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.period_is_closed(p_caixa_id uuid, p_on date) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (SELECT 1 FROM period_closings pc
                  WHERE pc.caixa_id = p_caixa_id AND pc.month = date_trunc('month', p_on)::date)
$$;


--
-- Name: FUNCTION period_is_closed(p_caixa_id uuid, p_on date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.period_is_closed(p_caixa_id uuid, p_on date) IS 'true se o mês da data está fechado na caixa.';


--
-- Name: recurrence_rules_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurrence_rules_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.installments_total IS NOT NULL
     AND EXISTS (SELECT 1 FROM titles t
                  WHERE t.recurrence_rule_id = NEW.id AND t.occurrence > NEW.installments_total) THEN
    RAISE EXCEPTION 'recurrence_rules: rule % has occurrences above %', NEW.id, NEW.installments_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_occurrence_total_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: report_cash_projection(uuid[], date, integer[], uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_cash_projection(p_caixa_ids uuid[], p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_horizons integer[] DEFAULT '{30,60,90}'::integer[], p_entity_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(caixa_id uuid, financial_account_id uuid, horizon_days integer, until date, balance_today_cents bigint, scheduled_movements_cents bigint, overdue_receivable_cents bigint, overdue_payable_cents bigint, receivable_cents bigint, payable_cents bigint, projected_cents bigint)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_today IS NULL OR p_horizons IS NULL OR cardinality(p_horizons) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_horizons) h WHERE h IS NULL OR h < 1 OR h > 1100) THEN
    RAISE EXCEPTION 'report_cash_projection: horizons must be 1..1100 days and today must be set'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH hz AS (
    SELECT DISTINCT h AS days, p_today + h AS until FROM unnest(p_horizons) h
  ),
  accs AS (
    SELECT a.id, a.caixa_id, a.opening_date, a.opening_balance_cents
      FROM financial_accounts a
      JOIN caixas c ON c.id = a.caixa_id AND c.kind = 'general'
     WHERE a.caixa_id = ANY (p_caixa_ids)
  ),
  -- Por conta: saldo no fim de hoje e o que já está lançado com data futura (até o horizonte).
  acc_rows AS (
    SELECT accs.caixa_id, accs.id AS account_id, hz.days, hz.until,
           (CASE WHEN accs.opening_date <= p_today THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id AND m.occurred_on <= p_today), 0))::bigint AS today_cents,
           (CASE WHEN p_entity_ids IS NULL AND accs.opening_date > p_today AND accs.opening_date <= hz.until
                 THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id
                           AND m.occurred_on > p_today AND m.occurred_on <= hz.until
                           AND (p_entity_ids IS NULL OR movement_counterparty(m.kind, m.settlement_id, m.entity_id)
                                                         = ANY (p_entity_ids))), 0))::bigint AS future_cents
      FROM accs CROSS JOIN hz
  ),
  -- Previsto da caixa: saldo aberto dos títulos (não arquivados) até o horizonte, vencidos à parte,
  -- e as faturas abertas em que ela é pagadora (itens − antecipações), como no calendário.
  open_items AS (
    SELECT b.caixa_id, b.direction, b.due_date, b.open_cents
      FROM title_balances b
      JOIN titles t ON t.id = b.title_id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE b.caixa_id = ANY (p_caixa_ids) AND b.open_cents > 0 AND b.archived_at IS NULL
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
       AND (p_entity_ids IS NULL OR (t.origin <> 'card_invoice' AND t.entity_id = ANY (p_entity_ids)))
    UNION ALL
    SELECT x.payer_caixa_id, 'payable', x.due_date, (x.items_cents - x.settled_cents)::bigint
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = ANY (p_caixa_ids) AND x.items_cents - x.settled_cents > 0
       AND p_entity_ids IS NULL
  ),
  caixa_rows AS (
    SELECT c.id AS caixa_id, hz.days, hz.until,
           coalesce((SELECT sum(r.today_cents) FROM acc_rows r WHERE r.caixa_id = c.id AND r.days = hz.days), 0)::bigint AS today_cents,
           coalesce((SELECT sum(r.future_cents) FROM acc_rows r WHERE r.caixa_id = c.id AND r.days = hz.days), 0)::bigint AS future_cents,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'receivable' AND o.due_date < p_today), 0)::bigint AS od_rec,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'payable' AND o.due_date < p_today), 0)::bigint AS od_pay,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'receivable' AND o.due_date <= hz.until), 0)::bigint AS rec,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'payable' AND o.due_date <= hz.until), 0)::bigint AS pay
      FROM caixas c
      CROSS JOIN hz
      LEFT JOIN open_items o ON o.caixa_id = c.id
     WHERE c.id = ANY (p_caixa_ids) AND c.kind = 'general'
     GROUP BY c.id, hz.days, hz.until
  )
  SELECT r.caixa_id, NULL::uuid, r.days, r.until, r.today_cents, r.future_cents, r.od_rec, r.od_pay, r.rec, r.pay,
         (r.today_cents + r.future_cents + r.rec - r.pay)::bigint
    FROM caixa_rows r
  UNION ALL
  SELECT r.caixa_id, r.account_id, r.days, r.until, r.today_cents, r.future_cents, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
         (r.today_cents + r.future_cents)::bigint
    FROM acc_rows r
   ORDER BY 1, 2 NULLS FIRST, 3;
END
$$;


--
-- Name: FUNCTION report_cash_projection(p_caixa_ids uuid[], p_today date, p_horizons integer[], p_entity_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_cash_projection(p_caixa_ids uuid[], p_today date, p_horizons integer[], p_entity_ids uuid[]) IS 'Fluxo de caixa projetado (spec 014) das caixas general pedidas, por horizonte (padrão 30/60/90 dias a partir de p_today, padrão = hoje em America/Sao_Paulo). Linha da caixa (financial_account_id nulo): balance_today_cents = saldo das contas no fim de hoje; scheduled_movements_cents = movimentos já lançados com data em (hoje, until] (e saldo inicial de conta aberta nesse intervalo); receivable_cents/payable_cents = saldo aberto dos títulos não arquivados com vencimento até until, INCLUSIVE os vencidos (que também saem em overdue_*), e as faturas abertas em que a caixa é pagadora (itens − antecipações); projected_cents = saldo + lançados + a receber − a pagar. Linha da conta: só realizado (títulos não têm conta), previstos = 0. Caixas de cartão não entram. Erro 22023: horizonte fora de 1..1100 ou lista vazia. p_entity_ids (padrão NULL = sem filtro): com lista (vazia inclusive), o saldo de hoje não muda; lançados futuros e títulos contam só os da lista (contraparte de movement_counterparty / entidade do título; sem saldo inicial futuro, transferências, títulos e pagamentos de fatura) e as faturas abertas saem.';


--
-- Name: report_category_totals(uuid[], date, date, text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_category_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text DEFAULT 'competence'::text, p_entity_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(month date, caixa_id uuid, card_caixa_id uuid, kind text, group_category_id uuid, category_id uuid, source text, is_internal boolean, amount_cents bigint, entries integer)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  PERFORM report_check_period('report_category_totals', p_from, p_to, p_basis);

  IF p_basis = 'competence' THEN
    RETURN QUERY
    WITH lines AS (
      SELECT date_trunc('month', t.competence_date)::date AS month,
             t.caixa_id,
             NULL::uuid AS card_caixa_id,
             c.kind,
             coalesce(c.parent_id, c.id) AS group_category_id,
             c.id AS category_id,
             'title'::text AS source,
             coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false) AS is_internal,
             t.amount_cents
        FROM titles t
        JOIN categories c ON c.id = t.category_id
       WHERE t.caixa_id = ANY (p_caixa_ids)
         AND t.competence_date BETWEEN p_from AND p_to
         AND t.status <> 'canceled'
         AND t.origin <> 'card_invoice'
         AND (p_entity_ids IS NULL OR t.entity_id = ANY (p_entity_ids))
      UNION ALL
      SELECT date_trunc('month', p.purchased_on)::date,
             p.payer_caixa_id,
             p.card_caixa_id,
             c.kind,
             coalesce(c.parent_id, c.id),
             c.id,
             'card_purchase'::text,
             false,
             CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END
        FROM card_purchases p
        JOIN categories c ON c.id = p.category_id
       WHERE (p.payer_caixa_id = ANY (p_caixa_ids) OR p.card_caixa_id = ANY (p_caixa_ids))
         AND p.purchased_on BETWEEN p_from AND p_to
         AND (p_entity_ids IS NULL OR p.entity_id = ANY (p_entity_ids))
    )
    SELECT l.month, l.caixa_id, l.card_caixa_id, l.kind, l.group_category_id, l.category_id, l.source,
           l.is_internal, sum(l.amount_cents)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
     ORDER BY 1, 2, 4, 5, 6, 7, 8, 3;
  ELSE
    RETURN QUERY
    WITH lines AS (
      SELECT date_trunc('month', m.occurred_on)::date AS month,
             a.caixa_id,
             CASE WHEN t.origin = 'card_invoice' THEN t.counterparty_caixa_id END AS card_caixa_id,
             c.kind,
             coalesce(c.parent_id, c.id) AS group_category_id,
             c.id AS category_id,
             CASE WHEN t.origin = 'card_invoice' THEN 'card_invoice_payment' ELSE 'settlement' END AS source,
             (t.origin <> 'card_invoice' AND coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false)) AS is_internal,
             CASE c.kind WHEN 'expense' THEN -m.amount_cents ELSE m.amount_cents END AS amount_cents
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
        JOIN settlements s ON s.id = m.settlement_id
        JOIN titles t ON t.id = s.title_id
        JOIN categories c ON c.id = t.category_id
       WHERE m.kind = 'settlement'
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
         AND (p_entity_ids IS NULL OR (t.origin <> 'card_invoice' AND t.entity_id = ANY (p_entity_ids)))
      UNION ALL
      SELECT date_trunc('month', m.occurred_on)::date,
             a.caixa_id,
             NULL::uuid,
             x.kind,
             coalesce(c.parent_id, c.id),
             c.id,
             'adjustment'::text,
             false,
             CASE x.kind WHEN 'expense' THEN -m.amount_cents ELSE m.amount_cents END
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
        LEFT JOIN categories c ON c.id = m.category_id
        CROSS JOIN LATERAL (
          SELECT coalesce(c.kind, CASE WHEN m.amount_cents > 0 THEN 'income' ELSE 'expense' END) AS kind
        ) x
       WHERE m.kind = 'adjustment'
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
         AND (p_entity_ids IS NULL OR m.entity_id = ANY (p_entity_ids))
    )
    SELECT l.month, l.caixa_id, l.card_caixa_id, l.kind, l.group_category_id, l.category_id, l.source,
           l.is_internal, sum(l.amount_cents)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
     ORDER BY 1, 2, 4, 5, 6, 7, 8, 3;
  END IF;
END
$$;


--
-- Name: FUNCTION report_category_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text, p_entity_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_category_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text, p_entity_ids uuid[]) IS 'Despesa/receita por mês, caixa e categoria (spec 014). p_basis: competence (padrão) ou cash. Uma linha por (month, caixa_id, card_caixa_id, kind, group_category_id, category_id, source, is_internal) com amount_cents (positivo = despesa em expense, receita em income; estornos subtraem) e entries. competence: source title (títulos não cancelados pela competência, sem os card_invoice) e card_purchase (compras/encargos/estornos do cartão pela data da compra, caixa_id = pagadora, card_caixa_id = cartão; entram se a pagadora OU o cartão está em p_caixa_ids). cash: source settlement (movimentos de baixa pela data, categoria do título), card_invoice_payment (pagamento da fatura pela pagadora, categoria do título da fatura, card_caixa_id = cartão; não rateado pelas compras) e adjustment (ajustes; sem categoria = category_id nulo, kind pelo sinal). Transferências nunca contam. is_internal: espelho cuja outra caixa também está na lista. Erro 22023: período inválido (até 3660 dias) ou regime desconhecido. p_entity_ids (padrão NULL = sem filtro): com lista (vazia inclusive), só as linhas cuja contraparte está nela (entidade do título, recebedor final da compra, entidade do ajuste); saem as linhas sem entidade e o card_invoice_payment.';


--
-- Name: report_check_period(text, date, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_check_period(p_fn text, p_from date, p_to date, p_basis text DEFAULT 'competence'::text) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION '%: invalid period % .. % (max 3660 days)', p_fn, p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_basis IS NULL OR p_basis NOT IN ('competence', 'cash') THEN
    RAISE EXCEPTION '%: basis must be competence or cash, got %', p_fn, p_basis
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$$;


--
-- Name: FUNCTION report_check_period(p_fn text, p_from date, p_to date, p_basis text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_check_period(p_fn text, p_from date, p_to date, p_basis text) IS 'Interna dos relatórios: erro 22023 se o período é inválido (até 3660 dias) ou o regime não é competence/cash.';


--
-- Name: report_entity_totals(uuid[], date, date, text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_entity_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text DEFAULT 'competence'::text, p_entity_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(entity_id uuid, caixa_id uuid, card_caixa_id uuid, source text, is_internal boolean, outflow_cents bigint, inflow_cents bigint, entries integer)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  PERFORM report_check_period('report_entity_totals', p_from, p_to, p_basis);

  IF p_basis = 'competence' THEN
    RETURN QUERY
    WITH lines AS (
      SELECT t.entity_id,
             t.caixa_id,
             NULL::uuid AS card_caixa_id,
             'title'::text AS source,
             coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false) AS is_internal,
             CASE t.direction WHEN 'payable' THEN t.amount_cents ELSE 0 END AS outflow,
             CASE t.direction WHEN 'receivable' THEN t.amount_cents ELSE 0 END AS inflow
        FROM titles t
       WHERE t.caixa_id = ANY (p_caixa_ids)
         AND t.competence_date BETWEEN p_from AND p_to
         AND t.status <> 'canceled'
         AND t.origin <> 'card_invoice'
         AND (p_entity_ids IS NULL OR t.entity_id = ANY (p_entity_ids))
      UNION ALL
      SELECT p.entity_id,
             p.payer_caixa_id,
             p.card_caixa_id,
             'card_purchase'::text,
             false,
             CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END,
             0
        FROM card_purchases p
       WHERE (p.payer_caixa_id = ANY (p_caixa_ids) OR p.card_caixa_id = ANY (p_caixa_ids))
         AND p.purchased_on BETWEEN p_from AND p_to
         AND (p_entity_ids IS NULL OR p.entity_id = ANY (p_entity_ids))
    )
    SELECT l.entity_id, l.caixa_id, l.card_caixa_id, l.source, l.is_internal,
           sum(l.outflow)::bigint, sum(l.inflow)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1, 2, 4, 5, 3;
  ELSE
    RETURN QUERY
    WITH lines AS (
      SELECT t.entity_id,
             a.caixa_id,
             CASE WHEN t.origin = 'card_invoice' THEN t.counterparty_caixa_id END AS card_caixa_id,
             CASE WHEN t.origin = 'card_invoice' THEN 'card_invoice_payment' ELSE 'settlement' END AS source,
             (t.origin <> 'card_invoice' AND coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false)) AS is_internal,
             CASE t.direction WHEN 'payable' THEN -m.amount_cents ELSE 0 END AS outflow,
             CASE t.direction WHEN 'receivable' THEN m.amount_cents ELSE 0 END AS inflow
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
        JOIN settlements s ON s.id = m.settlement_id
        JOIN titles t ON t.id = s.title_id
       WHERE m.kind = 'settlement'
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
         AND (p_entity_ids IS NULL OR (t.origin <> 'card_invoice' AND t.entity_id = ANY (p_entity_ids)))
      UNION ALL
      SELECT m.entity_id,
             a.caixa_id,
             NULL::uuid,
             'adjustment'::text,
             false,
             greatest(-m.amount_cents, 0),
             greatest(m.amount_cents, 0)
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
       WHERE m.kind = 'adjustment'
         AND m.entity_id IS NOT NULL
         AND (p_entity_ids IS NULL OR m.entity_id = ANY (p_entity_ids))
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
    )
    SELECT l.entity_id, l.caixa_id, l.card_caixa_id, l.source, l.is_internal,
           sum(l.outflow)::bigint, sum(l.inflow)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1, 2, 4, 5, 3;
  END IF;
END
$$;


--
-- Name: FUNCTION report_entity_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text, p_entity_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_entity_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text, p_entity_ids uuid[]) IS 'Pago (outflow_cents) e recebido (inflow_cents) por entidade e caixa no período (spec 014). competence (padrão): títulos não cancelados pela competência, sem os card_invoice (source title), e compras do cartão pela data com o RECEBEDOR FINAL como entidade (source card_purchase; caixa_id = pagadora, card_caixa_id = cartão: rastreio pagadora → cartão → lojista; estorno subtrai). cash: movimentos de baixa pela data (source settlement; estorno subtrai), pagamento de fatura ao emissor (source card_invoice_payment, card_caixa_id = cartão; os lojistas ficam no regime de competência) e ajustes com entidade (source adjustment, pelo sinal). Transferências nunca contam. is_internal como em report_category_totals. Erro 22023: período ou regime inválido. p_entity_ids (padrão NULL = sem filtro): com lista (vazia inclusive), só as entidades da lista (compra do cartão pelo recebedor final); o card_invoice_payment sai.';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION set_updated_at(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_updated_at() IS 'Trigger BEFORE UPDATE: mantém updated_at = now() (início da transação).';


--
-- Name: settlement_assert_movements(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settlement_assert_movements(p_settlement_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  s      settlements;
  dir    text;
  signed bigint;
  n      int;
  n_orig int;
  n_rev  int;
  same   boolean;
  want   int;
BEGIN
  SELECT * INTO s FROM settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT t.direction INTO dir FROM titles t WHERE t.id = s.title_id;
  signed := (s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents)
            * CASE dir WHEN 'payable' THEN -1 ELSE 1 END;

  SELECT count(*),
         count(*) FILTER (WHERE m.amount_cents = signed AND m.occurred_on = s.settled_on),
         count(*) FILTER (WHERE m.amount_cents = -signed AND m.occurred_on >= s.settled_on),
         coalesce(bool_and(m.financial_account_id = s.financial_account_id), true)
    INTO n, n_orig, n_rev, same
    FROM movements m WHERE m.settlement_id = s.id;

  IF s.financial_account_id IS NULL OR signed = 0 THEN
    want := 0;
  ELSIF s.reversed_at IS NULL THEN
    want := 1;
  ELSE
    want := 2;
  END IF;

  IF n <> want OR NOT same
     OR (want >= 1 AND n_orig < 1)
     OR (want = 2 AND (n_rev < 1 OR n_orig + n_rev < 2)) THEN
    RAISE EXCEPTION 'movements: settlement % requires % movement(s) of % cents on its account (found %)',
      s.id, want, signed, n
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_settlement_check';
  END IF;
END
$$;


--
-- Name: FUNCTION settlement_assert_movements(p_settlement_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.settlement_assert_movements(p_settlement_id uuid) IS 'Erro 23514 (movements_settlement_check) se os movimentos da baixa não batem com ela. Usada pelos triggers deferidos.';


--
-- Name: settlements_mirror_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settlements_mirror_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  s settlements;
  o settlements;
BEGIN
  SELECT * INTO s FROM settlements WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF s.mirror_settlement_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM settlements x WHERE x.mirror_settlement_id = s.id) THEN
      RAISE EXCEPTION 'settlements: mirror link to % is not reciprocal', s.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_reciprocal_check';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO o FROM settlements WHERE id = s.mirror_settlement_id;
  IF NOT FOUND THEN
    RETURN NULL;  -- a FK (também deferida) reporta o erro.
  END IF;

  IF o.mirror_settlement_id IS DISTINCT FROM s.id THEN
    RAISE EXCEPTION 'settlements: mirror link % -> % is not reciprocal', s.id, o.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_reciprocal_check';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM titles t WHERE t.id = s.title_id AND t.mirror_title_id = o.title_id) THEN
    RAISE EXCEPTION 'settlements: legs % / % are not on a mirrored title pair', s.id, o.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_title_check';
  END IF;

  IF s.settled_on <> o.settled_on OR s.amount_cents <> o.amount_cents
     OR s.interest_cents <> o.interest_cents OR s.fine_cents <> o.fine_cents
     OR s.discount_cents <> o.discount_cents
     OR (s.reversed_at IS NULL) <> (o.reversed_at IS NULL) THEN
    RAISE EXCEPTION 'settlements: legs % / % must have the same date, amounts and reversal state', s.id, o.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_match_check';
  END IF;

  RETURN NULL;
END
$$;


--
-- Name: settlements_movements_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settlements_movements_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM settlement_assert_movements(NEW.id);
  PERFORM transfer_assert_movements(tr.id) FROM transfers tr WHERE tr.settlement_id = NEW.id;
  RETURN NULL;
END
$$;


--
-- Name: settlements_period_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settlements_period_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  s settlements := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  PERFORM period_assert_open(t.caixa_id, s.settled_on, 'settlements') FROM titles t WHERE t.id = s.title_id;
  RETURN s;
END
$$;


--
-- Name: settlements_refresh_title_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settlements_refresh_title_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  tid uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.title_id ELSE NEW.title_id END;
BEGIN
  UPDATE titles t
     SET status = CASE WHEN x.settled = 0 THEN 'open'
                       WHEN x.settled < t.amount_cents THEN 'partial'
                       ELSE 'paid' END
    FROM (SELECT title_settled_cents(tid) AS settled) x
   WHERE t.id = tid
     AND t.status <> 'canceled'
     AND t.status <> CASE WHEN x.settled = 0 THEN 'open'
                          WHEN x.settled < t.amount_cents THEN 'partial'
                          ELSE 'paid' END;
  RETURN NULL;
END
$$;


--
-- Name: settlements_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settlements_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  t       titles;
  acc_ok  boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Bloqueia o título: baixas concorrentes do mesmo título ficam em série.
    SELECT * INTO t FROM titles WHERE id = NEW.title_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN NEW;  -- a FK reporta o erro.
    END IF;
    IF NEW.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'settlements: a settlement cannot be created already reversed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_reversal_check';
    END IF;
    IF t.status = 'canceled' THEN
      RAISE EXCEPTION 'settlements: title % is canceled', t.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_title_canceled_check';
    END IF;
    IF title_settled_cents(t.id) + NEW.amount_cents > t.amount_cents THEN
      RAISE EXCEPTION 'settlements: amount % exceeds open balance % of title %',
        NEW.amount_cents, t.amount_cents - title_settled_cents(t.id), t.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_overpayment_check';
    END IF;
  ELSE
    IF NEW.title_id <> OLD.title_id OR NEW.settled_on <> OLD.settled_on
       OR NEW.amount_cents <> OLD.amount_cents OR NEW.interest_cents <> OLD.interest_cents
       OR NEW.fine_cents <> OLD.fine_cents OR NEW.discount_cents <> OLD.discount_cents THEN
      RAISE EXCEPTION 'settlements: title, date and amounts of settlement % cannot change (reverse it instead)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_immutable_check';
    END IF;
    IF OLD.reversed_at IS NOT NULL
       AND (NEW.reversed_at IS DISTINCT FROM OLD.reversed_at OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason) THEN
      RAISE EXCEPTION 'settlements: reversal of settlement % cannot be undone or changed', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_immutable_check';
    END IF;
    IF NEW.financial_account_id IS DISTINCT FROM OLD.financial_account_id
       AND (OLD.financial_account_id IS NOT NULL OR NEW.reversed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'settlements: account of settlement % can only be set once, while active', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_account_immutable_check';
    END IF;
    SELECT * INTO t FROM titles WHERE id = NEW.title_id;
  END IF;

  IF NEW.financial_account_id IS NOT NULL THEN
    SELECT a.caixa_id = t.caixa_id INTO acc_ok FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
    IF acc_ok IS NOT TRUE AND acc_ok IS NOT NULL THEN
      RAISE EXCEPTION 'settlements: account % does not belong to caixa % of the title', NEW.financial_account_id, t.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_account_caixa_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: statement_csv_mappings_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_csv_mappings_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.financial_account_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM financial_accounts a
                  WHERE a.id = NEW.financial_account_id AND a.kind NOT IN ('checking', 'savings')) THEN
    RAISE EXCEPTION 'statement_csv_mappings: account % does not import statements', NEW.financial_account_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_account_kind_check';
  END IF;
  IF NEW.card_caixa_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.card_caixa_id AND c.kind <> 'credit_card') THEN
    RAISE EXCEPTION 'statement_csv_mappings: caixa % is not a credit card', NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_card_kind_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: statement_imports_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_imports_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.financial_account_id IS DISTINCT FROM OLD.financial_account_id
          OR NEW.card_caixa_id IS DISTINCT FROM OLD.card_caixa_id
          OR NEW.attachment_id <> OLD.attachment_id OR NEW.format <> OLD.format) THEN
    RAISE EXCEPTION 'statement_imports: account/card, file and format of import % cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_immutable_check';
  END IF;

  IF NEW.financial_account_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM financial_accounts a
                  WHERE a.id = NEW.financial_account_id AND a.kind NOT IN ('checking', 'savings')) THEN
    RAISE EXCEPTION 'statement_imports: account % does not import statements (only checking/savings)', NEW.financial_account_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_account_kind_check';
  END IF;

  IF NEW.card_caixa_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.card_caixa_id AND c.kind <> 'credit_card') THEN
    RAISE EXCEPTION 'statement_imports: caixa % is not a credit card', NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_card_kind_check';
  END IF;

  IF NEW.card_invoice_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM card_invoices v WHERE v.id = NEW.card_invoice_id AND v.card_caixa_id <> NEW.card_caixa_id) THEN
    RAISE EXCEPTION 'statement_imports: invoice % is not from card %', NEW.card_invoice_id, NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_card_invoice_check';
  END IF;

  IF NEW.csv_mapping_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM statement_csv_mappings m
                  WHERE m.id = NEW.csv_mapping_id
                    AND (m.financial_account_id IS DISTINCT FROM NEW.financial_account_id
                         OR m.card_caixa_id IS DISTINCT FROM NEW.card_caixa_id)) THEN
    RAISE EXCEPTION 'statement_imports: CSV mapping % belongs to another account/card', NEW.csv_mapping_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_csv_mapping_target_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: statement_lines_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_lines_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  imp statement_imports;
  ok  boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.statement_import_id <> OLD.statement_import_id OR NEW.posted_on <> OLD.posted_on
          OR NEW.amount_cents <> OLD.amount_cents OR NEW.dedup_hash <> OLD.dedup_hash
          OR NEW.line_number <> OLD.line_number
          OR NEW.financial_account_id IS DISTINCT FROM OLD.financial_account_id
          OR NEW.card_caixa_id IS DISTINCT FROM OLD.card_caixa_id) THEN
    RAISE EXCEPTION 'statement_lines: imported data of line % cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_immutable_check';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO imp FROM statement_imports i WHERE i.id = NEW.statement_import_id;
    IF FOUND AND (NEW.financial_account_id IS DISTINCT FROM imp.financial_account_id
                  OR NEW.card_caixa_id IS DISTINCT FROM imp.card_caixa_id) THEN
      RAISE EXCEPTION 'statement_lines: line must belong to the account/card of import %', imp.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_import_target_check';
    END IF;
  END IF;

  IF NEW.movement_id IS NOT NULL THEN
    SELECT m.financial_account_id = NEW.financial_account_id
           AND (NEW.status <> 'matched' OR m.amount_cents = NEW.amount_cents)
      INTO ok FROM movements m WHERE m.id = NEW.movement_id;
    IF ok IS FALSE THEN
      RAISE EXCEPTION 'statement_lines: movement % must be on the same account (and amount, when matched)', NEW.movement_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_movement_check';
    END IF;
  END IF;

  IF NEW.card_invoice_item_id IS NOT NULL THEN
    SELECT v.card_caixa_id = NEW.card_caixa_id
           AND (NEW.status <> 'matched' OR i.amount_cents = -NEW.amount_cents)
      INTO ok FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
     WHERE i.id = NEW.card_invoice_item_id;
    IF ok IS FALSE THEN
      RAISE EXCEPTION 'statement_lines: invoice item % must be on the same card (and opposite amount, when matched)',
        NEW.card_invoice_item_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_card_item_check';
    END IF;
  END IF;

  IF NEW.category_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM categories c
                  WHERE c.id = NEW.category_id
                    AND c.kind <> CASE WHEN NEW.card_caixa_id IS NOT NULL OR NEW.amount_cents < 0
                                       THEN 'expense' ELSE 'income' END) THEN
    RAISE EXCEPTION 'statement_lines: category % does not match the line direction', NEW.category_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_category_kind_check';
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: title_settled_cents(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.title_settled_cents(p_title_id uuid) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT coalesce(sum(s.amount_cents), 0)::bigint
    FROM settlements s
   WHERE s.title_id = p_title_id AND s.reversed_at IS NULL
$$;


--
-- Name: FUNCTION title_settled_cents(p_title_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.title_settled_cents(p_title_id uuid) IS 'Soma do principal das baixas ativas (não estornadas) do título.';


--
-- Name: titles_card_invoice_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_card_invoice_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.card_invoice_id IS NOT NULL THEN
    PERFORM card_invoice_assert(OLD.card_invoice_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.card_invoice_id IS NOT NULL
     AND NEW.card_invoice_id IS DISTINCT FROM (CASE TG_OP WHEN 'UPDATE' THEN OLD.card_invoice_id END) THEN
    PERFORM card_invoice_assert(NEW.card_invoice_id);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: titles_mirror_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_mirror_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  t titles;
  m titles;
  holder uuid;
BEGIN
  SELECT * INTO t FROM titles WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF t.mirror_title_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM titles x WHERE x.mirror_title_id = t.id) THEN
      RAISE EXCEPTION 'titles: mirror link to % is not reciprocal', t.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_reciprocal_check';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO m FROM titles WHERE id = t.mirror_title_id;
  IF NOT FOUND THEN
    RETURN NULL;  -- a FK (também deferida) reporta o erro.
  END IF;

  IF m.mirror_title_id IS DISTINCT FROM t.id THEN
    RAISE EXCEPTION 'titles: mirror link % -> % is not reciprocal', t.id, m.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_reciprocal_check';
  END IF;

  IF m.caixa_id IS DISTINCT FROM t.counterparty_caixa_id THEN
    RAISE EXCEPTION 'titles: mirror % is not in counterparty caixa %', m.id, t.counterparty_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_caixa_check';
  END IF;

  SELECT c.holder_entity_id INTO holder FROM caixas c WHERE c.id = m.caixa_id;
  IF holder IS DISTINCT FROM t.entity_id THEN
    RAISE EXCEPTION 'titles: counterparty caixa % is not held by entity %', m.caixa_id, t.entity_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_caixa_check';
  END IF;

  IF m.direction = t.direction OR m.amount_cents <> t.amount_cents OR m.due_date <> t.due_date THEN
    RAISE EXCEPTION 'titles: mirror pair % / % must have opposite direction, same amount and due date', t.id, m.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_match_check';
  END IF;

  IF m.origin <> t.origin
     OR m.recurrence_rule_id IS DISTINCT FROM t.recurrence_rule_id
     OR m.occurrence IS DISTINCT FROM t.occurrence
     OR m.card_invoice_id IS DISTINCT FROM t.card_invoice_id
     OR m.contract_id IS DISTINCT FROM t.contract_id
     OR m.contract_cycle_id IS DISTINCT FROM t.contract_cycle_id
     OR m.contract_installment IS DISTINCT FROM t.contract_installment THEN
    RAISE EXCEPTION 'titles: mirror pair % / % must share origin, recurrence occurrence, card invoice and contract installment',
      t.id, m.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_match_check';
  END IF;

  IF (t.mirror_status IS NULL) = (m.mirror_status IS NULL) THEN
    RAISE EXCEPTION 'titles: exactly one title of pair % / % must carry mirror_status', t.id, m.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_side_check';
  END IF;

  RETURN NULL;
END
$$;


--
-- Name: titles_period_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_period_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.caixa_id = OLD.caixa_id AND NEW.direction = OLD.direction AND NEW.entity_id = OLD.entity_id
     AND NEW.category_id = OLD.category_id AND NEW.competence_date = OLD.competence_date
     AND NEW.amount_cents = OLD.amount_cents
     AND (NEW.status = 'canceled') = (OLD.status = 'canceled') THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM period_assert_open(OLD.caixa_id, OLD.competence_date, 'titles');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM period_assert_open(NEW.caixa_id, NEW.competence_date, 'titles');
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;


--
-- Name: titles_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  caixa_kind text;
  cat_kind   text;
  total      smallint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.direction IS DISTINCT FROM OLD.direction THEN
    RAISE EXCEPTION 'titles: direction cannot change (title %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_direction_immutable_check';
  END IF;

  -- Caixa de cartão só recebe a fatura-título (F2), nunca título manual ou recorrente.
  SELECT c.kind INTO caixa_kind FROM caixas c WHERE c.id = NEW.caixa_id;
  IF caixa_kind = 'credit_card' AND NEW.origin <> 'card_invoice' THEN
    RAISE EXCEPTION 'titles: credit card caixa % only accepts card_invoice titles', NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_card_caixa_origin_check';
  END IF;

  SELECT c.kind INTO cat_kind FROM categories c WHERE c.id = NEW.category_id;
  IF cat_kind IS NOT NULL
     AND cat_kind <> (CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END) THEN
    RAISE EXCEPTION 'titles: % title requires % category, got %', NEW.direction,
      CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END, cat_kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_category_kind_check';
  END IF;

  IF NEW.recurrence_rule_id IS NOT NULL THEN
    SELECT r.installments_total INTO total FROM recurrence_rules r WHERE r.id = NEW.recurrence_rule_id;
    IF NEW.occurrence > total THEN
      RAISE EXCEPTION 'titles: occurrence % exceeds installments total %', NEW.occurrence, total
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_occurrence_total_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: titles_validate_card_invoice(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_validate_card_invoice() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  card uuid;
  other_kind text;
BEGIN
  IF NEW.card_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT i.card_caixa_id INTO card FROM card_invoices i WHERE i.id = NEW.card_invoice_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;

  IF NEW.caixa_id = card AND NEW.direction = 'receivable' THEN
    SELECT c.kind INTO other_kind FROM caixas c WHERE c.id = NEW.counterparty_caixa_id;
  ELSIF NEW.counterparty_caixa_id = card AND NEW.direction = 'payable' THEN
    SELECT c.kind INTO other_kind FROM caixas c WHERE c.id = NEW.caixa_id;
  ELSE
    other_kind := 'mismatch';
  END IF;

  IF other_kind IS DISTINCT FROM 'general' THEN
    RAISE EXCEPTION 'titles: invoice title must be receivable in the card caixa % and payable in a general payer caixa', card
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_card_invoice_caixa_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: titles_validate_contract(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_validate_contract() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  c     contracts;
  total smallint;
BEGIN
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM contracts k WHERE k.id = NEW.contract_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;

  IF NEW.mirror_status IS NULL THEN
    -- Lado original: na caixa do contrato; a parcela segue direção e contraparte do contrato.
    IF NEW.caixa_id <> c.caixa_id THEN
      RAISE EXCEPTION 'titles: contract % title must be in the contract caixa %', c.id, c.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_caixa_check';
    END IF;
    IF NEW.contract_cycle_id IS NOT NULL AND (NEW.direction <> c.direction OR NEW.entity_id <> c.entity_id) THEN
      RAISE EXCEPTION 'titles: contract % installment must be % with entity %', c.id, c.direction, c.entity_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_match_check';
    END IF;
  ELSIF NEW.counterparty_caixa_id IS DISTINCT FROM c.caixa_id THEN
    -- Lado espelho: o outro lado está na caixa do contrato.
    RAISE EXCEPTION 'titles: mirror of contract % title must point to the contract caixa %', c.id, c.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_caixa_check';
  END IF;

  IF NEW.contract_cycle_id IS NOT NULL THEN
    SELECT y.installments_count INTO total FROM contract_cycles y WHERE y.id = NEW.contract_cycle_id;
    IF NEW.contract_installment > total THEN
      RAISE EXCEPTION 'titles: installment % exceeds the % installments of cycle %', NEW.contract_installment, total,
        NEW.contract_cycle_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_installment_total_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: titles_validate_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_validate_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  settled  bigint := 0;
  expected text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    settled := title_settled_cents(NEW.id);
    IF NEW.caixa_id <> OLD.caixa_id AND EXISTS (SELECT 1 FROM settlements s WHERE s.title_id = OLD.id) THEN
      RAISE EXCEPTION 'titles: title % has settlements and cannot change caixa', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_caixa_settled_check';
    END IF;
  END IF;

  IF NEW.amount_cents < settled THEN
    RAISE EXCEPTION 'titles: amount % is below settled %', NEW.amount_cents, settled
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_amount_settled_check';
  END IF;

  expected := CASE WHEN settled = 0 THEN 'open'
                   WHEN settled < NEW.amount_cents THEN 'partial'
                   ELSE 'paid' END;

  IF NEW.status = 'canceled' THEN
    IF settled > 0 THEN
      RAISE EXCEPTION 'titles: title % has active settlements and cannot be canceled', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_cancel_settled_check';
    END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    -- Mudança explícita de status precisa bater com as baixas.
    IF NEW.status <> expected THEN
      RAISE EXCEPTION 'titles: status % does not match settlements (expected %)', NEW.status, expected
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_status_settlements_check';
    END IF;
  ELSE
    -- Status não tocado: acompanha a mudança de valor.
    NEW.status := expected;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: transfer_assert_movements(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_assert_movements(p_transfer_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  tr     transfers;
  n      int;
  n_from int;
  n_to   int;
  s      settlements;
  dir    text;
  cash   bigint;
BEGIN
  SELECT * INTO tr FROM transfers WHERE id = p_transfer_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE m.financial_account_id = tr.from_account_id AND m.amount_cents = -tr.amount_cents),
         count(*) FILTER (WHERE m.financial_account_id = tr.to_account_id AND m.amount_cents = tr.amount_cents)
    INTO n, n_from, n_to
    FROM movements m
   WHERE m.transfer_id = tr.id AND m.occurred_on = tr.transferred_on;

  IF n <> 2 OR n_from <> 1 OR n_to <> 1
     OR (SELECT count(*) FROM movements m WHERE m.transfer_id = tr.id) <> 2 THEN
    RAISE EXCEPTION 'movements: transfer % requires exactly two movements (-% on %, +% on %) on %',
      tr.id, tr.amount_cents, tr.from_account_id, tr.amount_cents, tr.to_account_id, tr.transferred_on
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_transfer_check';
  END IF;

  IF tr.settlement_id IS NOT NULL THEN
    SELECT * INTO s FROM settlements WHERE id = tr.settlement_id;
    SELECT t.direction INTO dir FROM titles t WHERE t.id = s.title_id;
    cash := s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents;
    IF tr.amount_cents <> cash
       OR s.financial_account_id IS DISTINCT FROM
          (CASE dir WHEN 'payable' THEN tr.to_account_id ELSE tr.from_account_id END) THEN
      RAISE EXCEPTION 'transfers: transfer % does not fund settlement % (amount % / account %)',
        tr.id, s.id, cash, s.financial_account_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'transfers_settlement_check';
    END IF;
  END IF;
END
$$;


--
-- Name: FUNCTION transfer_assert_movements(p_transfer_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.transfer_assert_movements(p_transfer_id uuid) IS 'Erro 23514 (movements_transfer_check / transfers_settlement_check) se a transferência não tem exatamente os dois movimentos que somam zero ou não bate com a baixa que a originou. Usada pelos triggers deferidos.';


--
-- Name: transfers_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfers_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM transfer_assert_movements(NEW.id);
  RETURN NULL;
END
$$;


--
-- Name: user_ai_settings_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_ai_settings_audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION user_ai_settings_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_ai_settings_audit_row() IS 'Trigger de auditoria de user_ai_settings: grava com record_id = user_id (a linha não tem id).';


--
-- Name: user_ai_settings_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_ai_settings_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION user_ai_settings_validate(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_ai_settings_validate() IS 'A caixa principal do usuário é general (o kind da caixa é imutável, então basta checar ao escolher).';


--
-- Name: user_api_tokens_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_api_tokens_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.token_hash <> OLD.token_hash OR NEW.token_prefix <> OLD.token_prefix OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'user_api_tokens: token, prefix and owner of token % are immutable (create a new token)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_api_tokens_immutable_check';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'user_api_tokens: token % is revoked', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_api_tokens_revoked_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: users_revoke_sessions_on_deactivate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.users_revoke_sessions_on_deactivate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
  RETURN NULL;
END
$$;


--
-- Name: agent_mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_mcp_servers (
    id uuid DEFAULT uuidv7() NOT NULL,
    agent_id uuid NOT NULL,
    mcp_server_id uuid NOT NULL,
    enabled_tools text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_mcp_servers_enabled_tools_check CHECK (public.ai_tool_list_valid(enabled_tools))
);


--
-- Name: TABLE agent_mcp_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_mcp_servers IS 'Servidores MCP de um agente: public escolhido na configuração do agente ou private vinculado pelo admin. Servidor global entra em todos os agentes sem linha aqui; uma linha para um global só serve para restringir as tools.';


--
-- Name: COLUMN agent_mcp_servers.enabled_tools; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_mcp_servers.enabled_tools IS 'Tools habilitadas daquele servidor para o agente. NULL = todas; {} = nenhuma.';


--
-- Name: ai_agent_inferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_inferences (
    agent_id uuid NOT NULL,
    capability text NOT NULL,
    provider_id uuid NOT NULL,
    model text,
    voice text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_inferences_capability_check CHECK ((capability = ANY (ARRAY['vision'::text, 'embeddings'::text, 'transcription'::text, 'speech'::text]))),
    CONSTRAINT ai_agent_inferences_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_agent_inferences_voice_check CHECK (((voice IS NULL) OR ((capability = 'speech'::text) AND (voice ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'::text))))
);


--
-- Name: TABLE ai_agent_inferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_agent_inferences IS 'Provedor de cada inferência do agente além do texto (spec 024): vision, embeddings, transcription e speech; uma por agente e capacidade, sem linha = "Nenhum". O texto continua em ai_agents.provider_id/model. O provedor precisa ter a flag (ai_agent_inferences_provider_capability_check); excluir provedor em uso dá 23503. Some com o agente. Auditada com record_id = agent_id (histórico do agente).';


--
-- Name: COLUMN ai_agent_inferences.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_inferences.model IS 'Modelo (nulo = o padrão do provedor para a capacidade, default_models).';


--
-- Name: COLUMN ai_agent_inferences.voice; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_inferences.voice IS 'Voz do TTS, só em speech (nula = default_models.speech_voice do provedor).';


--
-- Name: ai_agent_prompt_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_prompt_versions (
    id uuid DEFAULT uuidv7() NOT NULL,
    agent_id uuid NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    note text,
    created_by_user_id uuid,
    restored_from_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_prompt_versions_content_check CHECK ((length(content) <= 200000)),
    CONSTRAINT ai_agent_prompt_versions_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT ai_agent_prompt_versions_restored_self_check CHECK ((restored_from_version_id <> id)),
    CONSTRAINT ai_agent_prompt_versions_version_check CHECK ((version >= 1))
);


--
-- Name: TABLE ai_agent_prompt_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_agent_prompt_versions IS 'Versões do prompt de sistema de um agente (spec 022): toda mudança de prompt é uma versão nova (version 1, 2, 3…; omita version e o banco atribui a próxima, travando o agente). A versão manda: o INSERT copia o content para ai_agents.system_prompt. O agente nasce com a versão 1 (ai_agents_prompt_version_init, no COMMIT). Imutáveis; somem só com o agente. A auditoria grava a linha sem o content (com content_chars).';


--
-- Name: COLUMN ai_agent_prompt_versions.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_prompt_versions.version IS 'Número da versão no agente, atribuído pelo banco quando omitido; se informado, tem de ser o próximo (max + 1).';


--
-- Name: COLUMN ai_agent_prompt_versions.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_prompt_versions.content IS 'Prompt de sistema desta versão (até 200 mil caracteres; pode ser vazio).';


--
-- Name: COLUMN ai_agent_prompt_versions.note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_prompt_versions.note IS 'Nota opcional da gravação (até 500), ex.: "Restaurada da versão N".';


--
-- Name: COLUMN ai_agent_prompt_versions.created_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_prompt_versions.created_by_user_id IS 'Autor (usuário excluído = nulo). Na versão 1 criada pelo banco, o created_by_user_id do agente.';


--
-- Name: COLUMN ai_agent_prompt_versions.restored_from_version_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agent_prompt_versions.restored_from_version_id IS 'Versão (do mesmo agente) cujo conteúdo foi restaurado nesta.';


--
-- Name: ai_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agents (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    description text,
    system_prompt text DEFAULT ''::text NOT NULL,
    provider_id uuid,
    model text,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    color_slot smallint DEFAULT 1 NOT NULL,
    icon text,
    is_active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    use_for_flows boolean DEFAULT false NOT NULL,
    tool_kit_id uuid,
    CONSTRAINT ai_agents_active_check CHECK ((NOT (is_active AND (archived_at IS NOT NULL)))),
    CONSTRAINT ai_agents_color_slot_check CHECK (((color_slot >= 1) AND (color_slot <= 12))),
    CONSTRAINT ai_agents_description_check CHECK ((length(description) <= 2000)),
    CONSTRAINT ai_agents_icon_check CHECK ((icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT ai_agents_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_agents_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT ai_agents_params_check CHECK (public.ai_agent_params_valid(params)),
    CONSTRAINT ai_agents_ready_check CHECK (((NOT is_active) OR ((provider_id IS NOT NULL) AND (model IS NOT NULL)))),
    CONSTRAINT ai_agents_system_prompt_check CHECK ((length(system_prompt) <= 200000)),
    CONSTRAINT ai_agents_use_for_flows_check CHECK (((NOT use_for_flows) OR (is_active AND (archived_at IS NULL))))
);


--
-- Name: TABLE ai_agents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_agents IS 'Agentes de IA, criados só pelo admin (spec 011; a aplicação aplica). Ativo exige provedor e modelo; agente usado é arquivado, não excluído (as conversas e o uso o referenciam).';


--
-- Name: COLUMN ai_agents.system_prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.system_prompt IS 'Prompt de sistema (até 200 mil caracteres). Espelho da última versão (ai_agent_prompt_versions): muda só criando uma versão (UPDATE direto diferente dela dá 23514 ai_agents_system_prompt_version_check).';


--
-- Name: COLUMN ai_agents.provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.provider_id IS 'Provedor de LLM. Nulo só em agente inativo (rascunho).';


--
-- Name: COLUMN ai_agents.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.model IS 'Modelo no provedor (nome exato da API). Nulo só em agente inativo.';


--
-- Name: COLUMN ai_agents.params; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.params IS 'Parâmetros do modelo validados por ai_agent_params_valid (temperature, max_tokens…).';


--
-- Name: COLUMN ai_agents.color_slot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.color_slot IS 'Cor do agente: slot 1–12 do design system (token --port-N), como nas categorias.';


--
-- Name: COLUMN ai_agents.icon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.icon IS 'Nome de ícone lucide em kebab-case (ex.: bot).';


--
-- Name: COLUMN ai_agents.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.is_active IS 'false = não aparece para novas conversas nem inicia execuções.';


--
-- Name: COLUMN ai_agents.use_for_flows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.use_for_flows IS 'true = agente que atende os fluxos automáticos (leitura de documento, sugestões da conciliação, leitura do PDF do contrato e PDF → markdown). No máximo um (ai_agents_use_for_flows_key, 23505) e só ativo e não arquivado (ai_agents_use_for_flows_check, 23514: desmarque antes de desativar ou arquivar). Nenhum marcado = a aplicação escolhe (primeiro agente ativo).';


--
-- Name: COLUMN ai_agents.tool_kit_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_agents.tool_kit_id IS 'Kit de ferramentas (spec 021). Nulo = sem kit = poder completo: todas as tools internas em allow, menos as de segredo (sempre ask). Excluir o kit em uso (inclusive por agente arquivado) dá 23503 (ai_agents_tool_kit_id_fkey).';


--
-- Name: ai_attachment_derivatives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_attachment_derivatives (
    id uuid DEFAULT uuidv7() NOT NULL,
    attachment_id uuid,
    message_id uuid,
    block_index integer,
    kind text NOT NULL,
    provider_id uuid,
    model text,
    voice text,
    content text,
    result_attachment_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    attempts smallint DEFAULT 0 NOT NULL,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_attachment_derivatives_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT ai_attachment_derivatives_block_index_check CHECK (((block_index >= 0) AND (block_index <= 9999))),
    CONSTRAINT ai_attachment_derivatives_content_check CHECK ((length(content) <= 5000000)),
    CONSTRAINT ai_attachment_derivatives_error_check CHECK (((length(error) <= 4000) AND ((status <> 'failed'::text) OR (error IS NOT NULL)))),
    CONSTRAINT ai_attachment_derivatives_kind_check CHECK ((kind = ANY (ARRAY['description'::text, 'pdf_text'::text, 'transcription'::text, 'speech'::text]))),
    CONSTRAINT ai_attachment_derivatives_lock_check CHECK (((status = 'running'::text) = (locked_at IS NOT NULL))),
    CONSTRAINT ai_attachment_derivatives_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_attachment_derivatives_origin_check CHECK ((((attachment_id IS NULL) <> (message_id IS NULL)) AND ((message_id IS NULL) = (block_index IS NULL)) AND ((kind = 'speech'::text) = (message_id IS NOT NULL)))),
    CONSTRAINT ai_attachment_derivatives_provider_check CHECK ((((kind = 'pdf_text'::text) = (provider_id IS NULL)) AND ((kind = 'pdf_text'::text) = (model IS NULL)))),
    CONSTRAINT ai_attachment_derivatives_result_check CHECK ((((result_attachment_id IS NULL) OR (kind = 'speech'::text)) AND ((status <> 'done'::text) OR
CASE
    WHEN (kind = 'speech'::text) THEN (result_attachment_id IS NOT NULL)
    ELSE (content IS NOT NULL)
END))),
    CONSTRAINT ai_attachment_derivatives_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT ai_attachment_derivatives_voice_check CHECK (((voice IS NULL) OR ((kind = 'speech'::text) AND (voice ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'::text))))
);


--
-- Name: TABLE ai_attachment_derivatives; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_attachment_derivatives IS 'Derivados (cache) de anexos e mensagens dos agentes (specs 024 e 025): description (o provedor de visão descreve o anexo para outro modelo de texto), pdf_text (camada de texto do PDF, extraída no servidor, sem provedor), transcription (áudio→texto) e speech (áudio gerado de uma mensagem). Um por origem, tipo, provedor, modelo e voz (ai_attachment_derivatives_key, NULLS NOT DISTINCT). Some com a origem; o áudio gerado aparece em attachment_links como ai_message_speech e é apagado com o derivado quando não tem outro vínculo. Fora da auditoria e do backup.';


--
-- Name: COLUMN ai_attachment_derivatives.attachment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.attachment_id IS 'Origem anexo (description, pdf_text, transcription). Exatamente uma origem.';


--
-- Name: COLUMN ai_attachment_derivatives.message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.message_id IS 'Origem mensagem (só speech), com block_index.';


--
-- Name: COLUMN ai_attachment_derivatives.block_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.block_index IS 'Parte da mensagem que virou áudio (0–9999, definida pela aplicação: o bloco de texto ou o trecho dividido no limite do provedor). Só com message_id.';


--
-- Name: COLUMN ai_attachment_derivatives.provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.provider_id IS 'Provedor que gerou (nulo só em pdf_text). Excluir o provedor leva o cache.';


--
-- Name: COLUMN ai_attachment_derivatives.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.model IS 'Modelo que gerou (nulo só em pdf_text).';


--
-- Name: COLUMN ai_attachment_derivatives.voice; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.voice IS 'Voz do TTS (só speech; opcional).';


--
-- Name: COLUMN ai_attachment_derivatives.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.content IS 'Texto gerado (descrição, texto do PDF, transcrição; até 5 milhões de caracteres). Obrigatório em done, menos no speech.';


--
-- Name: COLUMN ai_attachment_derivatives.result_attachment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.result_attachment_id IS 'Áudio gerado (só speech; obrigatório em done). Entra em attachment_links (ai_message_speech, alvo = a mensagem); trocado ou com o derivado excluído, o anexo antigo é apagado se ficou sem vínculo.';


--
-- Name: COLUMN ai_attachment_derivatives.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.status IS 'pending (na fila), running (reservado: locked_at), done ou failed (com error).';


--
-- Name: COLUMN ai_attachment_derivatives.attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.attempts IS 'Tentativas feitas (0–100), para a fila desistir.';


--
-- Name: COLUMN ai_attachment_derivatives.locked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.locked_at IS 'Instante da reserva, só em running (reserva velha = worker caiu).';


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    title text,
    title_source text DEFAULT 'auto'::text NOT NULL,
    pinned_at timestamp with time zone,
    archived_at timestamp with time zone,
    forked_from_conversation_id uuid,
    forked_from_message_id uuid,
    screen_context jsonb,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    purpose text DEFAULT 'chat'::text NOT NULL,
    CONSTRAINT ai_conversations_fork_check CHECK ((forked_from_conversation_id <> id)),
    CONSTRAINT ai_conversations_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'document_reading'::text, 'classify_lines'::text, 'contract_reading'::text, 'contract_markdown'::text]))),
    CONSTRAINT ai_conversations_screen_context_check CHECK ((jsonb_typeof(screen_context) = 'object'::text)),
    CONSTRAINT ai_conversations_title_check CHECK (((btrim(title) <> ''::text) AND (length(title) <= 200))),
    CONSTRAINT ai_conversations_title_source_check CHECK ((title_source = ANY (ARRAY['auto'::text, 'user'::text])))
);


--
-- Name: TABLE ai_conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_conversations IS 'Conversas do usuário com um agente (spec 011): título automático e editável, fixar, arquivar, excluir (apaga mensagens, execuções e eventos; o uso fica em ai_usage), buscar (ai_conversation_search) e bifurcar (ai_conversation_fork). O admin pode ler as de todos (a aplicação aplica). Fora da auditoria.';


--
-- Name: COLUMN ai_conversations.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.user_id IS 'Dono da conversa (quem conversa; as execuções rodam com as permissões dele).';


--
-- Name: COLUMN ai_conversations.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.title IS 'Título (nulo até o título automático ser gerado).';


--
-- Name: COLUMN ai_conversations.title_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.title_source IS 'auto (gerado pelo agente; pode ser regerado) ou user (renomeado: não sobrescrever).';


--
-- Name: COLUMN ai_conversations.pinned_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.pinned_at IS 'Fixada desde (nulo = não fixada). Fixadas primeiro, mais recente primeiro.';


--
-- Name: COLUMN ai_conversations.forked_from_conversation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.forked_from_conversation_id IS 'Conversa de origem da bifurcação (nula se não é bifurcação ou se a origem foi excluída). Anda junto com forked_from_message_id (FK composta MATCH FULL para a mensagem).';


--
-- Name: COLUMN ai_conversations.forked_from_message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.forked_from_message_id IS 'Última mensagem copiada da origem (a bifurcação continua a partir dela).';


--
-- Name: COLUMN ai_conversations.screen_context; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.screen_context IS 'Contexto da tela mais recente enviado pelo console (caixa aberta, registro selecionado, filtros), objeto JSON.';


--
-- Name: COLUMN ai_conversations.last_message_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.last_message_at IS 'Instante da última mensagem (mantido por trigger de ai_messages).';


--
-- Name: COLUMN ai_conversations.purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.purpose IS 'Finalidade, definida no INSERT e imutável: chat (conversa do usuário, padrão) ou o fluxo automático que a criou (document_reading, classify_lines, contract_reading, contract_markdown; mesmo vocabulário de ai_usage.purpose). Conversas de fluxo não entram na lista nem na busca e rodam sem tools. A bifurcação é sempre chat.';


--
-- Name: ai_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_providers (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    base_url text,
    api_key text,
    api_key_hint text GENERATED ALWAYS AS (
CASE
    WHEN (api_key IS NOT NULL) THEN ('…'::text || "right"(api_key, 4))
    ELSE NULL::text
END) STORED,
    is_active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    notes text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    log_bodies boolean DEFAULT false NOT NULL,
    capabilities text[] NOT NULL,
    default_models jsonb DEFAULT '{}'::jsonb NOT NULL,
    prompt_cache_enabled boolean NOT NULL,
    thinking_enabled boolean NOT NULL,
    CONSTRAINT ai_providers_active_check CHECK ((NOT (is_active AND (archived_at IS NOT NULL)))),
    CONSTRAINT ai_providers_api_key_check CHECK (((api_key ~ '^[[:graph:]]+$'::text) AND ((length(api_key) >= 8) AND (length(api_key) <= 1000)))),
    CONSTRAINT ai_providers_base_url_check CHECK (((base_url ~ '^https?://[^[:space:]]+$'::text) AND (length(base_url) <= 500))),
    CONSTRAINT ai_providers_capabilities_check CHECK (public.ai_capability_list_valid(capabilities)),
    CONSTRAINT ai_providers_capabilities_kind_check CHECK (((kind <> 'anthropic'::text) OR (capabilities <@ ARRAY['text'::text, 'vision'::text]))),
    CONSTRAINT ai_providers_credentials_check CHECK (((api_key IS NOT NULL) OR (base_url IS NOT NULL))),
    CONSTRAINT ai_providers_default_models_check CHECK (public.ai_provider_default_models_valid(capabilities, default_models)),
    CONSTRAINT ai_providers_kind_check CHECK ((kind = ANY (ARRAY['anthropic'::text, 'openai'::text]))),
    CONSTRAINT ai_providers_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120)))
);


--
-- Name: TABLE ai_providers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_providers IS 'Provedores de LLM cadastrados pelo admin (specs 011 e 024). kind anthropic (Messages API; com base_url, um compatível) ou openai (Chat Completions, embeddings e áudio; com base_url, um compatível). capabilities diz o que cada um faz e default_models o modelo padrão de cada capacidade. A chave é segredo: moneyflow_app grava mas não lê api_key.';


--
-- Name: COLUMN ai_providers.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.kind IS 'anthropic (Messages API) ou openai (Chat Completions/Responses; cobre APIs compatíveis via base_url).';


--
-- Name: COLUMN ai_providers.base_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.base_url IS 'URL base da API (nulo = a oficial do kind). Ex.: proxy, Azure, Ollama, OpenRouter.';


--
-- Name: COLUMN ai_providers.api_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.api_key IS 'SEGREDO: chave da API. moneyflow_app grava mas NÃO lê esta coluna; leitura só por ai_run_provider_credentials, ai_capability_credentials, ai_embedding_credentials e admin_ai_provider_api_key. Nula só com base_url (servidor local sem chave). Nunca vai para o audit_log, respostas da API, logs ou tools de agente. Na edição, campo vazio mantém a atual.';


--
-- Name: COLUMN ai_providers.api_key_hint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.api_key_hint IS 'Parte pública da chave (…últimos 4 caracteres), gerada pelo banco, para a tela.';


--
-- Name: COLUMN ai_providers.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.is_active IS 'false = agentes deste provedor não iniciam execuções novas.';


--
-- Name: COLUMN ai_providers.log_bodies; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.log_bodies IS 'Registrar os corpos e cabeçalhos das requisições (spec 023): desligado por padrão; ligado, ai_requests guarda o corpo enviado completo (inclusive o base64 dos anexos), a resposta e o stream bruto, com o conteúdo das conversas e dados financeiros. Desligado, o banco descarta corpos e cabeçalhos que chegarem. Auditada.';


--
-- Name: COLUMN ai_providers.capabilities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.capabilities IS 'O que o provedor sabe fazer (spec 024): text (texto→texto), vision (imagens e PDF), embeddings, transcription (áudio→texto) e speech (texto→áudio), em ordem canônica. Omitida no INSERT = padrão do tipo (anthropic = text + vision; openai = todas); anthropic só aceita text e vision. Flag em uso por um agente não sai (ai_providers_capability_in_use_check).';


--
-- Name: COLUMN ai_providers.default_models; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.default_models IS 'Modelo padrão por capacidade ligada ({"text": …, "vision": …, "embeddings": …, "transcription": …, "speech": …}) e a voz padrão do TTS (speech_voice). A inferência do agente com modelo nulo herda daqui. Obrigatório só o text do Anthropic compatível (kind anthropic com base_url): o modelo da chamada mínima do teste e a sugestão no agente.';


--
-- Name: COLUMN ai_providers.prompt_cache_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.prompt_cache_enabled IS 'Messages API: manda cache_control. Omitido no INSERT = true sem base_url, false com ela. Desligado, o adaptador não manda cache_control mesmo que o agente peça.';


--
-- Name: COLUMN ai_providers.thinking_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_providers.thinking_enabled IS 'Messages API: manda thinking (raciocínio). Omitido no INSERT = true sem base_url, false com ela. Desligado, o adaptador não manda thinking mesmo que o agente peça.';


--
-- Name: ai_embedding_pairs_in_use; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_embedding_pairs_in_use WITH (security_invoker='true') AS
 SELECT i.provider_id,
    COALESCE(i.model, (p.default_models ->> 'embeddings'::text)) AS model,
    (count(*))::integer AS agents
   FROM ((public.ai_agent_inferences i
     JOIN public.ai_agents a ON (((a.id = i.agent_id) AND a.is_active AND (a.archived_at IS NULL))))
     JOIN public.ai_providers p ON (((p.id = i.provider_id) AND p.is_active AND (p.archived_at IS NULL) AND ('embeddings'::text = ANY (p.capabilities)))))
  WHERE ((i.capability = 'embeddings'::text) AND (COALESCE(i.model, (p.default_models ->> 'embeddings'::text)) IS NOT NULL))
  GROUP BY i.provider_id, COALESCE(i.model, (p.default_models ->> 'embeddings'::text));


--
-- Name: VIEW ai_embedding_pairs_in_use; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_embedding_pairs_in_use IS 'Pares (provedor, modelo) de embeddings usados por algum agente ativo e não arquivado, com provedor ativo e com a flag; o modelo nulo da inferência herda default_models.embeddings (sem nenhum dos dois, o par não existe).';


--
-- Name: ai_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_embeddings (
    id uuid DEFAULT uuidv7() NOT NULL,
    object_type text NOT NULL,
    object_id uuid NOT NULL,
    caixa_id uuid,
    model text NOT NULL,
    source_text text NOT NULL,
    source_hash text GENERATED ALWAYS AS (public.ai_text_sha256(source_text)) STORED NOT NULL,
    embedding public.vector(1536),
    embedded_hash text,
    embedded_at timestamp with time zone,
    needs_reindex boolean GENERATED ALWAYS AS (((embedding IS NULL) OR (embedded_hash IS DISTINCT FROM public.ai_text_sha256(source_text)))) STORED NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_id uuid NOT NULL,
    CONSTRAINT ai_embeddings_embedded_check CHECK ((((embedding IS NULL) = (embedded_hash IS NULL)) AND ((embedding IS NULL) = (embedded_at IS NULL)))),
    CONSTRAINT ai_embeddings_embedded_hash_check CHECK ((embedded_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ai_embeddings_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_embeddings_object_type_check CHECK ((object_type = ANY (ARRAY['entity'::text, 'caixa'::text, 'financial_account'::text, 'category'::text, 'title'::text, 'card_purchase'::text, 'statement_line'::text, 'nfe_document'::text, 'attachment'::text, 'classification_rule'::text]))),
    CONSTRAINT ai_embeddings_source_text_check CHECK (((btrim(source_text) <> ''::text) AND (length(source_text) <= 32000)))
);


--
-- Name: TABLE ai_embeddings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_embeddings IS 'Embeddings dos registros para a busca semântica dos agentes (vector(1536), HNSW por cosseno). Um por objeto e par (provedor, modelo); todos os pares dividem o mesmo HNSW e a busca filtra pelo par com hnsw.iterative_scan. Sem FK para o objeto (polimórfico): ai_embeddings_purge_orphans limpa os de objetos excluídos. Derivado: fora da auditoria. A busca SEMPRE filtra pelas caixas que o usuário lê (caixa_id) e a aplicação revalida o objeto.';


--
-- Name: COLUMN ai_embeddings.object_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.object_type IS 'Tipo do objeto: entity, caixa, financial_account, category, title, card_purchase, statement_line, nfe_document, attachment, classification_rule.';


--
-- Name: COLUMN ai_embeddings.caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.caixa_id IS 'Caixa do objeto, para filtrar por permissão (nulo = cadastro global: entidades, categorias, regras globais).';


--
-- Name: COLUMN ai_embeddings.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.model IS 'Modelo de embeddings (ex.: text-embedding-3-small). Busque sempre com o par (provedor, modelo) do vetor de consulta.';


--
-- Name: COLUMN ai_embeddings.source_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.source_text IS 'Texto que gerou (ou vai gerar) o vetor, montado pela aplicação (até 32 mil caracteres).';


--
-- Name: COLUMN ai_embeddings.source_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.source_hash IS 'SHA-256 (hex) de source_text, gerado pelo banco.';


--
-- Name: COLUMN ai_embeddings.embedding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.embedding IS 'Vetor de 1536 dimensões (nulo = ainda não calculado).';


--
-- Name: COLUMN ai_embeddings.embedded_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.embedded_hash IS 'source_hash do texto usado para calcular o vetor atual. Diferente de source_hash = vetor velho.';


--
-- Name: COLUMN ai_embeddings.needs_reindex; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.needs_reindex IS 'true = falta o vetor ou o texto mudou depois dele (gerado). Fila do worker (índice parcial).';


--
-- Name: COLUMN ai_embeddings.provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_embeddings.provider_id IS 'Provedor que gera o vetor. O par (provider_id, model) precisa estar em ai_embedding_indexes, e sai com ele.';


--
-- Name: ai_embedding_index_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_embedding_index_stats WITH (security_invoker='true') AS
 SELECT x.provider_id,
    x.model,
    x.last_in_use_at,
    (EXISTS ( SELECT 1
           FROM public.ai_embedding_pairs_in_use u
          WHERE ((u.provider_id = x.provider_id) AND (u.model = x.model)))) AS in_use,
    (count(e.id))::integer AS vectors,
    (count(e.id) FILTER (WHERE (NOT e.needs_reindex)))::integer AS indexed,
    (count(e.id) FILTER (WHERE e.needs_reindex))::integer AS pending
   FROM (public.ai_embedding_indexes x
     LEFT JOIN public.ai_embeddings e ON (((e.provider_id = x.provider_id) AND (e.model = x.model))))
  GROUP BY x.provider_id, x.model, x.last_in_use_at;


--
-- Name: VIEW ai_embedding_index_stats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_embedding_index_stats IS 'Progresso de cada índice (detalhe do provedor): linhas (vectors), já indexadas com o texto atual (indexed) e na fila (pending), mais se o par está em uso.';


--
-- Name: ai_message_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_message_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    message_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE ai_message_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_message_attachments IS 'Anexos (imagem, PDF…) de mensagens do agente. Criada automaticamente a partir dos blocos attachment de ai_messages (anexo inexistente = 23503). Fora da auditoria.';


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id uuid DEFAULT uuidv7() NOT NULL,
    run_id uuid,
    message_id uuid,
    conversation_id uuid,
    user_id uuid,
    agent_id uuid,
    provider_id uuid NOT NULL,
    model text NOT NULL,
    purpose text DEFAULT 'chat'::text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    price_id uuid,
    cost_micros bigint,
    currency text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id uuid,
    audio_seconds numeric(12,3) DEFAULT 0 NOT NULL,
    characters bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ai_usage_audio_check CHECK (((audio_seconds >= (0)::numeric) AND (characters >= 0))),
    CONSTRAINT ai_usage_cost_check CHECK (((cost_micros >= 0) AND ((cost_micros IS NULL) = (currency IS NULL)) AND ((price_id IS NULL) OR (cost_micros IS NOT NULL)))),
    CONSTRAINT ai_usage_currency_check CHECK ((currency = ANY (ARRAY['USD'::text, 'BRL'::text]))),
    CONSTRAINT ai_usage_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_usage_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'title'::text, 'embedding'::text, 'document_reading'::text, 'classify_lines'::text, 'contract_reading'::text, 'contract_markdown'::text, 'vision_describe'::text, 'transcription'::text, 'speech'::text]))),
    CONSTRAINT ai_usage_tokens_check CHECK (((input_tokens >= 0) AND (output_tokens >= 0) AND (cache_write_tokens >= 0) AND (cache_read_tokens >= 0)))
);


--
-- Name: TABLE ai_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_usage IS 'Uso de uma chamada ao modelo (spec 011: tokens e custo estimado por mensagem, agente e usuário; só medição). Uma linha por chamada (ou por mensagem do assistente). Ao inserir, o banco completa conversa/usuário/agente/provedor/modelo da execução e calcula o custo pelo preço vigente; a execução recebe os totais. Imutável para a aplicação. Sobrevive à exclusão da conversa (ligações anuladas). Fora da auditoria.';


--
-- Name: COLUMN ai_usage.message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.message_id IS 'Mensagem do assistente que a chamada produziu (opcional).';


--
-- Name: COLUMN ai_usage.purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.purpose IS 'chat (loop do agente), title (título automático), embedding (indexação/busca semântica), vision_describe (descrição de anexo pelo provedor de visão), transcription (áudio→texto), speech (texto→áudio) ou a finalidade de um fluxo automático: document_reading (leitura de documento), classify_lines (sugestões da conciliação), contract_reading (leitura do PDF do contrato) e contract_markdown (PDF do contrato → markdown). chat numa conversa de fluxo vira a finalidade da conversa.';


--
-- Name: COLUMN ai_usage.input_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.input_tokens IS 'Tokens de entrada SEM cache. Normalize por provedor: Anthropic input_tokens; OpenAI prompt_tokens − cached_tokens.';


--
-- Name: COLUMN ai_usage.cache_write_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.cache_write_tokens IS 'Tokens gravados no cache de prompt (Anthropic cache_creation_input_tokens; OpenAI 0).';


--
-- Name: COLUMN ai_usage.cache_read_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.cache_read_tokens IS 'Tokens lidos do cache (Anthropic cache_read_input_tokens; OpenAI cached_tokens).';


--
-- Name: COLUMN ai_usage.price_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.price_id IS 'Preço usado (vigente no created_at). Nulo = sem preço cadastrado: custo desconhecido (nulo).';


--
-- Name: COLUMN ai_usage.cost_micros; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.cost_micros IS 'Custo estimado em milionésimos de currency (ex.: 1500000 = US$ 1,50). Nulo sem preço.';


--
-- Name: COLUMN ai_usage.request_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.request_id IS 'Requisição que gerou o uso (spec 023). Purgada a requisição, vira nula; o uso fica. A FK é NOT VALID (as linhas novas são checadas): o dump do backup leva só a estrutura de ai_requests e, validada, a FK derrubaria o pg_restore. Depois de um restore, ai_usage_unlink_missing_requests() anula os vínculos órfãos.';


--
-- Name: COLUMN ai_usage.audio_seconds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.audio_seconds IS 'Segundos de áudio transcritos (transcription), com milésimos. Entra no custo por audio_input_per_minute.';


--
-- Name: COLUMN ai_usage.characters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_usage.characters IS 'Caracteres convertidos em fala (speech). Entra no custo por speech_per_million_chars.';


--
-- Name: ai_message_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_message_usage WITH (security_invoker='true') AS
 SELECT message_id,
    currency,
    (count(*))::integer AS calls,
    (sum(input_tokens))::bigint AS input_tokens,
    (sum(output_tokens))::bigint AS output_tokens,
    (sum(cache_write_tokens))::bigint AS cache_write_tokens,
    (sum(cache_read_tokens))::bigint AS cache_read_tokens,
    (sum(cost_micros))::bigint AS cost_micros,
    bool_or((cost_micros IS NULL)) AS has_unpriced
   FROM public.ai_usage u
  WHERE (message_id IS NOT NULL)
  GROUP BY message_id, currency;


--
-- Name: VIEW ai_message_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_message_usage IS 'Tokens e custo por mensagem do assistente (uma linha por moeda; currency nula = chamadas sem preço cadastrado).';


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    conversation_id uuid NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    run_id uuid,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('portuguese'::regconfig, public.ai_message_text(content))) STORED NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_messages_content_check CHECK (public.ai_message_content_valid(role, content)),
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'tool'::text]))),
    CONSTRAINT ai_messages_seq_check CHECK ((seq >= 1))
);


--
-- Name: TABLE ai_messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_messages IS 'Mensagens de uma conversa, em ordem (seq 1, 2, 3… por conversa; omita seq no INSERT e o banco atribui o próximo). Conteúdo em blocos neutros entre provedores (ai_message_content_valid) e imutável. Tokens e custo por mensagem: ai_usage / ai_message_usage. Fora da auditoria.';


--
-- Name: COLUMN ai_messages.seq; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_messages.seq IS 'Ordem na conversa (1, 2, 3…), atribuída pelo banco quando omitida (trava a conversa).';


--
-- Name: COLUMN ai_messages.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_messages.role IS 'user (pessoa), assistant (modelo: texto, raciocínio, pedidos de tool) ou tool (resultados das tools).';


--
-- Name: COLUMN ai_messages.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_messages.content IS 'Array de blocos: text, attachment, thinking, redacted_thinking, tool_use, tool_result. Imutável.';


--
-- Name: COLUMN ai_messages.run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_messages.run_id IS 'Execução que produziu a mensagem (da mesma conversa); nula na mensagem do usuário e nas cópias de bifurcação.';


--
-- Name: COLUMN ai_messages.search_tsv; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_messages.search_tsv IS 'Full-text (português) dos blocos text, gerado pelo banco.';


--
-- Name: ai_request_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_request_attempts (
    request_id uuid NOT NULL,
    attempt integer NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    duration_ms integer,
    http_status integer,
    error_type text,
    error_message text,
    retry_after_ms integer,
    rate_limit_headers jsonb,
    response_body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_request_attempts_attempt_check CHECK (((attempt >= 1) AND (attempt <= 100))),
    CONSTRAINT ai_request_attempts_duration_check CHECK ((duration_ms >= 0)),
    CONSTRAINT ai_request_attempts_error_message_check CHECK ((length(error_message) <= 4000)),
    CONSTRAINT ai_request_attempts_error_type_check CHECK ((error_type ~ '^[a-z][a-z0-9_]{0,59}$'::text)),
    CONSTRAINT ai_request_attempts_headers_check CHECK ((jsonb_typeof(rate_limit_headers) = 'object'::text)),
    CONSTRAINT ai_request_attempts_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT ai_request_attempts_retry_after_check CHECK ((retry_after_ms >= 0))
);


--
-- Name: TABLE ai_request_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_request_attempts IS 'Tentativas de uma requisição feitas pelo MoneyFlow (spec 023; o retry dos SDKs fica desligado). Somem com a requisição (CASCADE). Inserir uma tentativa atualiza ai_requests.attempts.';


--
-- Name: COLUMN ai_request_attempts.attempt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_request_attempts.attempt IS 'Número da tentativa (1, 2, 3…).';


--
-- Name: COLUMN ai_request_attempts.error_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_request_attempts.error_type IS 'Tipo do erro em snake_case, definido pela aplicação (ex.: http, rate_limit, overloaded, network, timeout, canceled). Nulo = deu certo.';


--
-- Name: COLUMN ai_request_attempts.retry_after_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_request_attempts.retry_after_ms IS 'retry-after informado pelo provedor, em ms (nulo se não veio).';


--
-- Name: COLUMN ai_request_attempts.rate_limit_headers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_request_attempts.rate_limit_headers IS 'Cabeçalhos de rate limit da resposta (objeto nome → valor), sempre, com ou sem log_bodies.';


--
-- Name: COLUMN ai_request_attempts.response_body; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_request_attempts.response_body IS 'Corpo da resposta de erro. Só com log_bodies do provedor da requisição.';


--
-- Name: ai_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_requests (
    id uuid DEFAULT uuidv7() NOT NULL,
    provider_id uuid,
    agent_id uuid,
    user_id uuid,
    conversation_id uuid,
    run_id uuid,
    operation text NOT NULL,
    purpose text,
    model text,
    method text DEFAULT 'POST'::text NOT NULL,
    path text NOT NULL,
    streaming boolean DEFAULT false NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    http_status integer,
    error_message text,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finished_at timestamp with time zone,
    duration_ms integer GENERATED ALWAYS AS ((floor((EXTRACT(epoch FROM (finished_at - started_at)) * (1000)::numeric)))::integer) STORED,
    first_byte_ms integer,
    attempts integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    request_bytes bigint,
    response_bytes bigint,
    request_headers jsonb,
    request_body text,
    response_headers jsonb,
    response_body text,
    response_stream text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_requests_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT ai_requests_bytes_check CHECK (((request_bytes >= 0) AND (response_bytes >= 0))),
    CONSTRAINT ai_requests_error_message_check CHECK (((error_message IS NULL) OR ((length(error_message) <= 4000) AND (status <> 'ok'::text)))),
    CONSTRAINT ai_requests_finished_check CHECK ((((status = 'running'::text) = (finished_at IS NULL)) AND (finished_at >= started_at))),
    CONSTRAINT ai_requests_first_byte_check CHECK ((first_byte_ms >= 0)),
    CONSTRAINT ai_requests_headers_check CHECK (((jsonb_typeof(request_headers) = 'object'::text) AND (jsonb_typeof(response_headers) = 'object'::text))),
    CONSTRAINT ai_requests_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT ai_requests_method_check CHECK ((method = ANY (ARRAY['GET'::text, 'POST'::text, 'PUT'::text, 'PATCH'::text, 'DELETE'::text]))),
    CONSTRAINT ai_requests_model_check CHECK ((model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'::text)),
    CONSTRAINT ai_requests_operation_check CHECK ((operation = ANY (ARRAY['chat'::text, 'title'::text, 'embedding'::text, 'vision_describe'::text, 'transcription'::text, 'speech'::text, 'test_connection'::text, 'list_models'::text]))),
    CONSTRAINT ai_requests_path_check CHECK (((path ~ '^[^[:space:]]+$'::text) AND (length(path) <= 2000))),
    CONSTRAINT ai_requests_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'title'::text, 'embedding'::text, 'document_reading'::text, 'classify_lines'::text, 'contract_reading'::text, 'contract_markdown'::text, 'vision_describe'::text, 'transcription'::text, 'speech'::text]))),
    CONSTRAINT ai_requests_purpose_null_check CHECK (((purpose IS NULL) = (operation = ANY (ARRAY['test_connection'::text, 'list_models'::text])))),
    CONSTRAINT ai_requests_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'canceled'::text]))),
    CONSTRAINT ai_requests_tokens_check CHECK (((input_tokens >= 0) AND (output_tokens >= 0) AND (cache_write_tokens >= 0) AND (cache_read_tokens >= 0)))
);


--
-- Name: TABLE ai_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_requests IS 'Requisições ao provedor de IA (spec 023): uma por chamada (inclusive testar conexão e listar modelos). Metadados sempre; cabeçalhos e corpos só com ai_providers.log_bodies. Nasce running (INSERT no início) e termina ok, error ou canceled (UPDATE no fim, fora da transação do negócio); terminada, é imutável. As FKs são ON DELETE SET NULL: a requisição sobrevive até a purga (ai_requests_purge). Fora da auditoria e do backup (no dump, só a estrutura).';


--
-- Name: COLUMN ai_requests.provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.provider_id IS 'Provedor chamado. Nulo = testar conexão de um provedor ainda não salvo, ou provedor excluído.';


--
-- Name: COLUMN ai_requests.run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.run_id IS 'Execução do agente (opcional). Informada, o banco completa conversa, usuário, agente, provedor e modelo nulos a partir dela, e a conversa tem de ser a da execução (ai_requests_links_check).';


--
-- Name: COLUMN ai_requests.operation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.operation IS 'chat, title, embedding, vision_describe, transcription, speech, test_connection ou list_models.';


--
-- Name: COLUMN ai_requests.purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.purpose IS 'Finalidade, com o vocabulário de ai_usage.purpose; nula só (e sempre) em test_connection e list_models. chat numa conversa de fluxo vira a finalidade dela.';


--
-- Name: COLUMN ai_requests.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.model IS 'Modelo pedido (nulo quando a chamada não tem modelo, como listar modelos).';


--
-- Name: COLUMN ai_requests.path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.path IS 'Caminho chamado, sem o host quando é o base_url do provedor (senão a URL inteira, sem credenciais).';


--
-- Name: COLUMN ai_requests.streaming; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.streaming IS 'A resposta veio em streaming (SSE).';


--
-- Name: COLUMN ai_requests.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.status IS 'running (em andamento) → ok, error ou canceled (finais; a linha fica imutável). Uma running abandonada sai na purga.';


--
-- Name: COLUMN ai_requests.http_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.http_status IS 'Status HTTP final (o da última tentativa). Nulo em erro de rede ou timeout.';


--
-- Name: COLUMN ai_requests.error_message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.error_message IS 'Mensagem de erro segura (até 4000, nunca em ok), sem segredos.';


--
-- Name: COLUMN ai_requests.duration_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.duration_ms IS 'Duração total em ms (finished_at − started_at), gerada pelo banco.';


--
-- Name: COLUMN ai_requests.first_byte_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.first_byte_ms IS 'Tempo até o primeiro byte da resposta, em ms, a partir de started_at.';


--
-- Name: COLUMN ai_requests.attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.attempts IS 'Número de tentativas (linhas em ai_request_attempts), mantido pelo banco; a aplicação não grava.';


--
-- Name: COLUMN ai_requests.input_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.input_tokens IS 'Tokens como em ai_usage (entrada sem cache, saída, gravação e leitura de cache).';


--
-- Name: COLUMN ai_requests.request_bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.request_bytes IS 'Tamanho do corpo enviado, em bytes (gravável também sem log_bodies).';


--
-- Name: COLUMN ai_requests.response_bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.response_bytes IS 'Tamanho da resposta recebida (o stream bruto, no streaming), em bytes.';


--
-- Name: COLUMN ai_requests.request_headers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.request_headers IS 'Cabeçalhos enviados (objeto nome → valor), só com log_bodies; credenciais como "[omitido]" (ai_request_headers_redact).';


--
-- Name: COLUMN ai_requests.request_body; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.request_body IS 'Corpo enviado, completo, inclusive o base64 dos anexos. Só com log_bodies.';


--
-- Name: COLUMN ai_requests.response_headers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.response_headers IS 'Cabeçalhos recebidos, só com log_bodies; credenciais omitidas.';


--
-- Name: COLUMN ai_requests.response_body; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.response_body IS 'Resposta montada (JSON final). Só com log_bodies.';


--
-- Name: COLUMN ai_requests.response_stream; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_requests.response_stream IS 'Stream bruto recebido (texto SSE), no streaming. Só com log_bodies.';


--
-- Name: ai_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_run_events (
    id uuid DEFAULT uuidv7() NOT NULL,
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_run_events_event_type_check CHECK ((event_type ~ '^[a-z][a-z0-9_.]{0,63}$'::text)),
    CONSTRAINT ai_run_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT ai_run_events_seq_check CHECK ((seq >= 1))
);


--
-- Name: TABLE ai_run_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_run_events IS 'Eventos de uma execução para o streaming via SSE (deltas de texto, tool chamada, confirmação pedida, status…), em ordem por seq. Grave com ai_run_event_append (seq + NOTIFY ai_run_events). Append-only (sem UPDATE para a aplicação, sem updated_at); limpeza por ai_run_events_purge. Fora da auditoria.';


--
-- Name: COLUMN ai_run_events.seq; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_run_events.seq IS 'Ordem na execução (1, 2, 3…, sem buracos); serve de Last-Event-ID no SSE.';


--
-- Name: COLUMN ai_run_events.event_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_run_events.event_type IS 'Tipo do evento, definido pela aplicação (ex.: status, text_delta, tool_use, tool_result, confirmation, error, done).';


--
-- Name: COLUMN ai_run_events.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_run_events.payload IS 'Dados do evento (objeto JSON). Nunca chaves, tokens ou senhas.';


--
-- Name: ai_tool_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_tool_confirmations (
    id uuid DEFAULT uuidv7() NOT NULL,
    run_id uuid NOT NULL,
    tool_use_id text NOT NULL,
    tool_name text NOT NULL,
    input jsonb NOT NULL,
    preview jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by_user_id uuid,
    decided_at timestamp with time zone,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_tool_confirmations_decision_check CHECK ((((status = 'pending'::text) = (decided_at IS NULL)) AND ((status = ANY (ARRAY['approved'::text, 'rejected'::text])) = (decided_by_user_id IS NOT NULL)))),
    CONSTRAINT ai_tool_confirmations_input_check CHECK ((jsonb_typeof(input) = 'object'::text)),
    CONSTRAINT ai_tool_confirmations_reason_check CHECK ((length(reason) <= 2000)),
    CONSTRAINT ai_tool_confirmations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text]))),
    CONSTRAINT ai_tool_confirmations_tool_name_check CHECK ((tool_name ~ '^[A-Za-z0-9_./-]{1,128}$'::text)),
    CONSTRAINT ai_tool_confirmations_tool_use_id_check CHECK (((btrim(tool_use_id) <> ''::text) AND (length(tool_use_id) <= 200)))
);


--
-- Name: TABLE ai_tool_confirmations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_tool_confirmations IS 'Cartão "Aplicar?" (spec 011): uma linha por chamada de tool de escrita que precisa de confirmação, com o diff/prévia. Criada pelo worker com a execução em running (antes de passá-la a awaiting_confirmation). Decidida só pelo usuário da execução, uma a uma ou em lote (ai_tool_confirmations_decide). Execução que termina expira as pendentes. Fora da auditoria (o que a tool aplica é auditado como agente).';


--
-- Name: COLUMN ai_tool_confirmations.tool_use_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_confirmations.tool_use_id IS 'id do bloco tool_use da mensagem do assistente (único na execução).';


--
-- Name: COLUMN ai_tool_confirmations.input; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_confirmations.input IS 'Entrada da tool (imutável): é exatamente o que será aplicado se aprovado.';


--
-- Name: COLUMN ai_tool_confirmations.preview; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_confirmations.preview IS 'Diff/prévia para o cartão (antes/depois, registros afetados). Nunca senhas nem tokens.';


--
-- Name: COLUMN ai_tool_confirmations.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_confirmations.status IS 'pending → approved | rejected (pelo usuário da execução) | expired (execução terminou ou expirou).';


--
-- Name: COLUMN ai_tool_confirmations.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_confirmations.reason IS 'Motivo opcional da rejeição (vai para o modelo no tool_result).';


--
-- Name: ai_tool_kit_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_tool_kit_tools (
    kit_id uuid NOT NULL,
    tool_name text NOT NULL,
    mode text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_tool_kit_tools_mode_check CHECK ((mode = ANY (ARRAY['allow'::text, 'ask'::text]))),
    CONSTRAINT ai_tool_kit_tools_tool_name_check CHECK (public.ai_tool_list_valid(ARRAY[tool_name]))
);


--
-- Name: TABLE ai_tool_kit_tools; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_tool_kit_tools IS 'Tools internas liberadas por um kit (lista de permissões: tool fora do kit não é enviada ao modelo; tool nova do registro não entra sozinha). Some com o kit (CASCADE). Auditada com record_id = kit_id.';


--
-- Name: COLUMN ai_tool_kit_tools.tool_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_kit_tools.tool_name IS 'Nome da tool no registro (packages/shared). O banco valida só o formato (o de ai_tool_list_valid); a aplicação valida contra o registro.';


--
-- Name: COLUMN ai_tool_kit_tools.mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_kit_tools.mode IS 'allow = executa sem perguntar; ask = mostra o cartão "Aplicar?" com a prévia e espera o usuário. Vale para leituras e escritas; o modo sugerido (leituras e notify_user allow, demais escritas ask) é da aplicação.';


--
-- Name: ai_tool_kits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_tool_kits (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    description text,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_tool_kits_description_check CHECK ((length(description) <= 2000)),
    CONSTRAINT ai_tool_kits_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120)))
);


--
-- Name: TABLE ai_tool_kits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_tool_kits IS 'Kits de ferramentas dos agentes (spec 021): quais tools internas um agente pode usar e, para cada uma, allow ou ask. Um agente tem no máximo um kit (ai_agents.tool_kit_id); um kit serve a vários. Kit em uso não é excluído (23503); não há arquivamento. Valem só para as tools internas (as de MCP externo seguem agent_mcp_servers).';


--
-- Name: COLUMN ai_tool_kits.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_kits.name IS 'Nome (até 120), único sem distinção de maiúsculas (ai_tool_kits_name_key). Chave natural no backup.';


--
-- Name: COLUMN ai_tool_kits.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_kits.description IS 'Descrição opcional (até 2000 caracteres).';


--
-- Name: COLUMN ai_tool_kits.created_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_tool_kits.created_by_user_id IS 'Quem criou. Nulo = criado pela migração 0038 ou usuário excluído.';


--
-- Name: ai_usage_monthly_by_agent; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_usage_monthly_by_agent WITH (security_invoker='true') AS
 SELECT (date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date AS month,
    agent_id,
    provider_id,
    model,
    currency,
    (count(*))::integer AS calls,
    (count(DISTINCT run_id))::integer AS runs,
    (count(DISTINCT user_id))::integer AS users,
    (sum(input_tokens))::bigint AS input_tokens,
    (sum(output_tokens))::bigint AS output_tokens,
    (sum(cache_write_tokens))::bigint AS cache_write_tokens,
    (sum(cache_read_tokens))::bigint AS cache_read_tokens,
    (sum(cost_micros))::bigint AS cost_micros,
    bool_or((cost_micros IS NULL)) AS has_unpriced
   FROM public.ai_usage u
  GROUP BY ((date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date), agent_id, provider_id, model, currency;


--
-- Name: VIEW ai_usage_monthly_by_agent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_monthly_by_agent IS 'Uso por mês (America/Sao_Paulo), agente, provedor, modelo e moeda. agent_id nulo = embeddings (sem agente).';


--
-- Name: ai_usage_monthly_by_purpose; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_usage_monthly_by_purpose WITH (security_invoker='true') AS
 SELECT (date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date AS month,
    purpose,
    currency,
    (count(*))::integer AS calls,
    (count(DISTINCT run_id))::integer AS runs,
    (count(DISTINCT user_id))::integer AS users,
    (sum(input_tokens))::bigint AS input_tokens,
    (sum(output_tokens))::bigint AS output_tokens,
    (sum(cache_write_tokens))::bigint AS cache_write_tokens,
    (sum(cache_read_tokens))::bigint AS cache_read_tokens,
    (sum(cost_micros))::bigint AS cost_micros,
    bool_or((cost_micros IS NULL)) AS has_unpriced
   FROM public.ai_usage u
  GROUP BY ((date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date), purpose, currency;


--
-- Name: VIEW ai_usage_monthly_by_purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_monthly_by_purpose IS 'Uso por mês (America/Sao_Paulo), finalidade (ai_usage.purpose) e moeda; currency nula = chamadas sem preço.';


--
-- Name: ai_usage_monthly_by_user; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_usage_monthly_by_user WITH (security_invoker='true') AS
 SELECT (date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date AS month,
    user_id,
    currency,
    (count(*))::integer AS calls,
    (count(DISTINCT run_id))::integer AS runs,
    (sum(input_tokens))::bigint AS input_tokens,
    (sum(output_tokens))::bigint AS output_tokens,
    (sum(cache_write_tokens))::bigint AS cache_write_tokens,
    (sum(cache_read_tokens))::bigint AS cache_read_tokens,
    (sum(cost_micros))::bigint AS cost_micros,
    bool_or((cost_micros IS NULL)) AS has_unpriced
   FROM public.ai_usage u
  GROUP BY ((date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date), user_id, currency;


--
-- Name: VIEW ai_usage_monthly_by_user; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_monthly_by_user IS 'Uso por mês (America/Sao_Paulo), usuário e moeda. user_id nulo = sistema (embeddings) ou usuário excluído.';


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_settings_key_check CHECK (((key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text) AND (length(key) <= 100))),
    CONSTRAINT app_settings_value_check CHECK (public.app_setting_valid(key, value))
);


--
-- Name: TABLE app_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_settings IS 'Configurações do sistema gravadas pela tela (spec 023), que vencem a variável de ambiente; sem linha = vale a variável (o DELETE é o "Usar o padrão"). Só o admin grava (regra da aplicação). Auditada com record_id = md5(key)::uuid.';


--
-- Name: COLUMN app_settings.key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_settings.key IS 'Chave no formato area.nome (minúsculas, até 100), validada com o valor por app_setting_valid.';


--
-- Name: COLUMN app_settings.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_settings.value IS 'Valor em JSON (ex.: 30 para ai.request_retention_days).';


--
-- Name: COLUMN app_settings.updated_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_settings.updated_by_user_id IS 'Quem gravou por último: o app.user_id da transação, quando definido (senão o valor informado). Usuário excluído = nulo.';


--
-- Name: card_purchase_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_purchase_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    card_purchase_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE card_purchase_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.card_purchase_attachments IS 'Anexos de uma compra no cartão (nota, comprovante).';


--
-- Name: contract_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_documents (
    id uuid DEFAULT uuidv7() NOT NULL,
    contract_id uuid NOT NULL,
    kind text NOT NULL,
    format text NOT NULL,
    title text NOT NULL,
    description text,
    document_date date,
    attachment_id uuid,
    current_version_id uuid,
    source_document_id uuid,
    created_by uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_documents_format_check CHECK ((format = ANY (ARRAY['pdf'::text, 'markdown'::text]))),
    CONSTRAINT contract_documents_format_fields_check CHECK (
CASE format
    WHEN 'pdf'::text THEN ((attachment_id IS NOT NULL) AND (current_version_id IS NULL) AND (source_document_id IS NULL))
    WHEN 'markdown'::text THEN (attachment_id IS NULL)
    ELSE NULL::boolean
END),
    CONSTRAINT contract_documents_kind_check CHECK ((kind = ANY (ARRAY['contract'::text, 'amendment'::text, 'renewal'::text, 'termination'::text, 'proposal'::text, 'other'::text]))),
    CONSTRAINT contract_documents_title_check CHECK (((btrim(title) <> ''::text) AND (length(title) <= 200)))
);


--
-- Name: TABLE contract_documents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_documents IS 'Documentos de um contrato: PDF (anexo imutável, somente leitura) ou markdown versionado (contract_document_versions; current_version_id obrigatório no COMMIT). Excluir = arquivar.';


--
-- Name: COLUMN contract_documents.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_documents.kind IS 'contract, amendment (aditivo), renewal, termination (distrato), proposal ou other.';


--
-- Name: COLUMN contract_documents.format; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_documents.format IS 'pdf (attachment_id) ou markdown (versões). Imutável.';


--
-- Name: COLUMN contract_documents.attachment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_documents.attachment_id IS 'Arquivo do PDF (só em pdf; imutável). Aparece em attachment_links como contract_document.';


--
-- Name: COLUMN contract_documents.current_version_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_documents.current_version_id IS 'Versão atual do markdown (uma versão deste documento). Nulo em pdf.';


--
-- Name: COLUMN contract_documents.source_document_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_documents.source_document_id IS 'PDF de origem de um markdown gerado por IA (mesmo contrato, formato pdf).';


--
-- Name: entity_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    entity_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE entity_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_attachments IS 'Anexos de uma entidade (contrato, cartão CNPJ, documentos).';


--
-- Name: movement_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movement_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    movement_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE movement_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.movement_attachments IS 'Anexos de um movimento (recibo de um ajuste, comprovante de transferência).';


--
-- Name: nfe_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nfe_documents (
    id uuid DEFAULT uuidv7() NOT NULL,
    access_key text NOT NULL,
    issuer_entity_id uuid NOT NULL,
    recipient_entity_id uuid,
    number integer NOT NULL,
    series smallint NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    total_cents bigint NOT NULL,
    xml_attachment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT nfe_documents_access_key_check CHECK (public.is_valid_nfe_access_key(access_key)),
    CONSTRAINT nfe_documents_number_check CHECK (((number >= 1) AND (number <= 999999999))),
    CONSTRAINT nfe_documents_parties_check CHECK ((recipient_entity_id <> issuer_entity_id)),
    CONSTRAINT nfe_documents_series_check CHECK (((series >= 0) AND (series <= 999))),
    CONSTRAINT nfe_documents_total_cents_check CHECK ((total_cents >= 0))
);


--
-- Name: TABLE nfe_documents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.nfe_documents IS 'NF-e importada (XML, spec 010). Uma por chave de acesso no sistema inteiro; vários títulos podem apontar para ela (duplicatas/parcelas, e os dois lados de um espelho).';


--
-- Name: COLUMN nfe_documents.access_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_documents.access_key IS 'Chave de acesso de 44 caracteres (NT 2025.001: CNPJ do emitente alfanumérico nas posições 7–20), normalizada (maiúsculas, sem espaços), com DV válido. Única.';


--
-- Name: COLUMN nfe_documents.issuer_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_documents.issuer_entity_id IS 'Emitente (vira entidade no import).';


--
-- Name: COLUMN nfe_documents.recipient_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_documents.recipient_entity_id IS 'Destinatário, quando identificado.';


--
-- Name: COLUMN nfe_documents.total_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_documents.total_cents IS 'Valor total da nota (vNF), em centavos.';


--
-- Name: COLUMN nfe_documents.xml_attachment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_documents.xml_attachment_id IS 'Anexo com o XML original.';


--
-- Name: settlement_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    settlement_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE settlement_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.settlement_attachments IS 'Anexos de uma baixa (comprovante de pagamento).';


--
-- Name: statement_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_imports (
    id uuid DEFAULT uuidv7() NOT NULL,
    financial_account_id uuid,
    card_caixa_id uuid,
    card_invoice_id uuid,
    format text NOT NULL,
    attachment_id uuid NOT NULL,
    csv_mapping_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    bank_balance_cents bigint,
    bank_balance_on date,
    imported_by_user_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT statement_imports_bank_balance_check CHECK (((bank_balance_cents IS NULL) = (bank_balance_on IS NULL))),
    CONSTRAINT statement_imports_csv_mapping_check CHECK (((format = 'csv'::text) OR (csv_mapping_id IS NULL))),
    CONSTRAINT statement_imports_format_check CHECK ((format = ANY (ARRAY['ofx'::text, 'csv'::text]))),
    CONSTRAINT statement_imports_period_check CHECK ((period_end >= period_start)),
    CONSTRAINT statement_imports_target_check CHECK (((num_nonnulls(financial_account_id, card_caixa_id) = 1) AND ((card_invoice_id IS NULL) OR (card_caixa_id IS NOT NULL))))
);


--
-- Name: TABLE statement_imports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.statement_imports IS 'Lote de importação de extrato (OFX/CSV) de uma conta corrente/poupança, ou de fatura de um cartão. O arquivo original fica em attachment_id. Excluir o lote apaga as linhas (os movimentos criados a partir delas ficam).';


--
-- Name: COLUMN statement_imports.financial_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.financial_account_id IS 'Conta (checking ou savings) do extrato. Exclusivo com card_caixa_id.';


--
-- Name: COLUMN statement_imports.card_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.card_caixa_id IS 'Cartão (caixa credit_card) cuja fatura foi importada.';


--
-- Name: COLUMN statement_imports.card_invoice_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.card_invoice_id IS 'Fatura do app a que o arquivo do cartão corresponde (opcional).';


--
-- Name: COLUMN statement_imports.bank_balance_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.bank_balance_cents IS 'Saldo informado pelo banco (OFX LEDGERBAL ou digitado) em bank_balance_on; comparado com o do app em statement_import_balances.';


--
-- Name: title_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.title_attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    title_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE title_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.title_attachments IS 'Anexos de um título (boleto, nota, comprovante).';


--
-- Name: attachment_links; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.attachment_links WITH (security_invoker='true') AS
 SELECT title_attachments.attachment_id,
    'title'::text AS target_kind,
    title_attachments.title_id AS target_id
   FROM public.title_attachments
UNION ALL
 SELECT settlement_attachments.attachment_id,
    'settlement'::text AS target_kind,
    settlement_attachments.settlement_id AS target_id
   FROM public.settlement_attachments
UNION ALL
 SELECT movement_attachments.attachment_id,
    'movement'::text AS target_kind,
    movement_attachments.movement_id AS target_id
   FROM public.movement_attachments
UNION ALL
 SELECT entity_attachments.attachment_id,
    'entity'::text AS target_kind,
    entity_attachments.entity_id AS target_id
   FROM public.entity_attachments
UNION ALL
 SELECT nfe_documents.xml_attachment_id AS attachment_id,
    'nfe_document'::text AS target_kind,
    nfe_documents.id AS target_id
   FROM public.nfe_documents
  WHERE (nfe_documents.xml_attachment_id IS NOT NULL)
UNION ALL
 SELECT card_purchase_attachments.attachment_id,
    'card_purchase'::text AS target_kind,
    card_purchase_attachments.card_purchase_id AS target_id
   FROM public.card_purchase_attachments
UNION ALL
 SELECT statement_imports.attachment_id,
    'statement_import'::text AS target_kind,
    statement_imports.id AS target_id
   FROM public.statement_imports
UNION ALL
 SELECT ai_message_attachments.attachment_id,
    'ai_message'::text AS target_kind,
    ai_message_attachments.message_id AS target_id
   FROM public.ai_message_attachments
UNION ALL
 SELECT contract_documents.attachment_id,
    'contract_document'::text AS target_kind,
    contract_documents.id AS target_id
   FROM public.contract_documents
  WHERE (contract_documents.attachment_id IS NOT NULL)
UNION ALL
 SELECT ai_attachment_derivatives.result_attachment_id AS attachment_id,
    'ai_message_speech'::text AS target_kind,
    ai_attachment_derivatives.message_id AS target_id
   FROM public.ai_attachment_derivatives
  WHERE (ai_attachment_derivatives.result_attachment_id IS NOT NULL);


--
-- Name: VIEW attachment_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.attachment_links IS 'Todas as ligações de anexos (target_kind + target_id). Anexo sem linha aqui e sem referência direta (import de extrato, NF-e) é órfão e pode ser apagado pela aplicação.';


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    content bytea NOT NULL,
    size_bytes integer GENERATED ALWAYS AS (octet_length(content)) STORED NOT NULL,
    sha256 text GENERATED ALWAYS AS (encode(sha256(content), 'hex'::text)) STORED NOT NULL,
    uploaded_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachments_file_name_check CHECK (((btrim(file_name) <> ''::text) AND (length(file_name) <= 255) AND (file_name !~ '[/\\[:cntrl:]]'::text))),
    CONSTRAINT attachments_mime_type_check CHECK (((mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'::text) AND (length(mime_type) <= 127))),
    CONSTRAINT attachments_size_check CHECK (((octet_length(content) >= 1) AND (octet_length(content) <= 20971520)))
);


--
-- Name: TABLE attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.attachments IS 'Arquivos anexados (PDF, imagem, XML, OFX/CSV…), guardados em bytea, até 20 MB (spec 001). Ligados aos registros por tabelas *_attachments; o arquivo de um import de extrato e o XML da NF-e são referenciados direto.';


--
-- Name: COLUMN attachments.file_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.file_name IS 'Nome original do arquivo (sem caminho), até 255 caracteres.';


--
-- Name: COLUMN attachments.mime_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.mime_type IS 'Tipo MIME em minúsculas, sem parâmetros (ex.: application/pdf).';


--
-- Name: COLUMN attachments.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.content IS 'Bytes do arquivo (1 byte a 20 MB). Imutável. Nunca selecione em listas: use as outras colunas.';


--
-- Name: COLUMN attachments.size_bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.size_bytes IS 'Tamanho em bytes, calculado pelo banco (coluna gerada).';


--
-- Name: COLUMN attachments.sha256; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.sha256 IS 'SHA-256 do conteúdo em hex minúsculo, calculado pelo banco; serve para achar o mesmo arquivo já enviado.';


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT uuidv7() NOT NULL,
    table_name text NOT NULL,
    record_id uuid NOT NULL,
    action text NOT NULL,
    old_data jsonb,
    new_data jsonb,
    changed_columns text[],
    user_id uuid,
    actor_kind text NOT NULL,
    agent_run_id text,
    transaction_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text]))),
    CONSTRAINT audit_log_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['human'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT audit_log_data_check CHECK (
CASE action
    WHEN 'insert'::text THEN ((old_data IS NULL) AND (new_data IS NOT NULL))
    WHEN 'update'::text THEN ((old_data IS NOT NULL) AND (new_data IS NOT NULL))
    WHEN 'delete'::text THEN ((old_data IS NOT NULL) AND (new_data IS NULL))
    ELSE NULL::boolean
END)
);


--
-- Name: TABLE audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_log IS 'Log de auditoria (spec 008), só leitura para a aplicação. Uma linha por INSERT/UPDATE/DELETE de tabela de negócio (UPDATE que só toca updated_at ou colunas "ruidosas" não gera linha). Sem updated_at: é append-only.';


--
-- Name: COLUMN audit_log.record_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.record_id IS 'id do registro alterado.';


--
-- Name: COLUMN audit_log.old_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.old_data IS 'Registro antes (update/delete), em JSON. Nunca contém users.password nem attachments.content.';


--
-- Name: COLUMN audit_log.new_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.new_data IS 'Registro depois (insert/update), em JSON. Nunca contém users.password nem attachments.content.';


--
-- Name: COLUMN audit_log.changed_columns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.changed_columns IS 'update: colunas que mudaram, exceto updated_at (inclui "password" quando a senha muda, sem o valor).';


--
-- Name: COLUMN audit_log.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.user_id IS 'Usuário da configuração app.user_id da transação (sem FK: o log sobrevive ao usuário). Nulo = sistema.';


--
-- Name: COLUMN audit_log.actor_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.actor_kind IS 'app.actor_kind: human (padrão com app.user_id) ou agent (agente de IA agindo pelo usuário); system sem app.user_id (worker, migrations).';


--
-- Name: COLUMN audit_log.agent_run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.agent_run_id IS 'app.agent_run_id: id (uuid em texto) da execução do agente (ai_runs) que fez a alteração. Nulo para humanos, sistema e para o agente externo do servidor MCP próprio (/mcp).';


--
-- Name: COLUMN audit_log.transaction_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.transaction_id IS 'Transação do PostgreSQL (pg_current_xact_id): agrupa as linhas de uma mesma operação.';


--
-- Name: COLUMN audit_log.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.created_at IS 'Quando (início da transação).';


--
-- Name: caixa_hidden_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caixa_hidden_categories (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid NOT NULL,
    category_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE caixa_hidden_categories; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.caixa_hidden_categories IS 'Categorias que uma caixa oculta das suas listas. Ocultar um grupo não cria linhas para os filhos (a aplicação herda).';


--
-- Name: caixa_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caixa_members (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    caixa_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT caixa_members_role_check CHECK ((role = ANY (ARRAY['editor'::text, 'viewer'::text])))
);


--
-- Name: TABLE caixa_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.caixa_members IS 'Papel do usuário na caixa: editor (CRUD) ou viewer (leitura). Admins globais não precisam de linha aqui.';


--
-- Name: caixas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caixas (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    holder_entity_id uuid NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    description text,
    default_payer_caixa_id uuid,
    credit_limit_cents bigint,
    closing_day smallint,
    due_day smallint,
    card_last4 text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT caixas_card_fields_check CHECK (
CASE kind
    WHEN 'general'::text THEN ((default_payer_caixa_id IS NULL) AND (credit_limit_cents IS NULL) AND (closing_day IS NULL) AND (due_day IS NULL) AND (card_last4 IS NULL))
    WHEN 'credit_card'::text THEN ((default_payer_caixa_id IS NOT NULL) AND (credit_limit_cents IS NOT NULL) AND (closing_day IS NOT NULL) AND (due_day IS NOT NULL) AND (card_last4 IS NOT NULL))
    ELSE NULL::boolean
END),
    CONSTRAINT caixas_card_last4_check CHECK ((card_last4 ~ '^[0-9]{4}$'::text)),
    CONSTRAINT caixas_closing_day_check CHECK (((closing_day >= 1) AND (closing_day <= 31))),
    CONSTRAINT caixas_credit_limit_cents_check CHECK ((credit_limit_cents >= 0)),
    CONSTRAINT caixas_default_payer_self_check CHECK ((default_payer_caixa_id <> id)),
    CONSTRAINT caixas_due_day_check CHECK (((due_day >= 1) AND (due_day <= 31))),
    CONSTRAINT caixas_kind_check CHECK ((kind = ANY (ARRAY['general'::text, 'credit_card'::text]))),
    CONSTRAINT caixas_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT caixas_primary_active_check CHECK ((NOT (is_primary AND (archived_at IS NOT NULL))))
);


--
-- Name: TABLE caixas; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.caixas IS 'Livro financeiro de um titular (entidade); unidade de permissão (specs 002, 004, 007).';


--
-- Name: COLUMN caixas.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.kind IS 'general (empresa, pessoa, casa) ou credit_card. Imutável após a criação.';


--
-- Name: COLUMN caixas.holder_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.holder_entity_id IS 'Titular. No cartão, o emissor (ex.: Nu Pagamentos).';


--
-- Name: COLUMN caixas.is_primary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.is_primary IS 'Caixa principal do titular: no máximo uma por titular, e nunca arquivada.';


--
-- Name: COLUMN caixas.default_payer_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.default_payer_caixa_id IS 'Cartão: caixa pagadora padrão (sempre uma caixa general).';


--
-- Name: COLUMN caixas.credit_limit_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.credit_limit_cents IS 'Cartão: limite, em centavos.';


--
-- Name: COLUMN caixas.closing_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.closing_day IS 'Cartão: dia de fechamento (1–31; meses curtos: a aplicação usa o último dia).';


--
-- Name: COLUMN caixas.due_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.due_day IS 'Cartão: dia de vencimento (1–31).';


--
-- Name: COLUMN caixas.card_last4; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.card_last4 IS 'Cartão: 4 últimos dígitos.';


--
-- Name: canvas_node_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_node_positions (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    layout text DEFAULT 'default'::text NOT NULL,
    node_kind text NOT NULL,
    node_id uuid NOT NULL,
    x double precision NOT NULL,
    y double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canvas_node_positions_layout_check CHECK (((btrim(layout) <> ''::text) AND (length(layout) <= 60))),
    CONSTRAINT canvas_node_positions_node_kind_check CHECK ((node_kind = ANY (ARRAY['caixa'::text, 'entity'::text, 'category_group'::text]))),
    CONSTRAINT canvas_node_positions_xy_check CHECK ((((x >= ('-10000000'::numeric)::double precision) AND (x <= ('10000000'::numeric)::double precision)) AND ((y >= ('-10000000'::numeric)::double precision) AND (y <= ('10000000'::numeric)::double precision))))
);


--
-- Name: TABLE canvas_node_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.canvas_node_positions IS 'Posição de cada nó do canvas de fluxo por usuário e layout nomeado (spec 014). Estado de interface: sem FK para o nó (caixa, entidade ou grupo de categoria; posições de nós que sumiram são ignoradas) e fora da auditoria. Gravar com INSERT … ON CONFLICT (user_id, layout, node_kind, node_id) DO UPDATE.';


--
-- Name: COLUMN canvas_node_positions.layout; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.canvas_node_positions.layout IS 'Nome do layout ("default" = o do canvas; outros = visões salvas).';


--
-- Name: COLUMN canvas_node_positions.node_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.canvas_node_positions.node_kind IS 'caixa, entity ou category_group (folhas agrupadas pela categoria; node_id = id do grupo).';


--
-- Name: card_invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_invoice_items (
    id uuid DEFAULT uuidv7() NOT NULL,
    card_invoice_id uuid NOT NULL,
    kind text DEFAULT 'installment'::text NOT NULL,
    card_purchase_id uuid,
    installment_number smallint,
    carried_from_invoice_id uuid,
    payer_caixa_id uuid NOT NULL,
    amount_cents bigint NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_invoice_items_amount_cents_check CHECK ((amount_cents <> 0)),
    CONSTRAINT card_invoice_items_carried_self_check CHECK ((carried_from_invoice_id <> card_invoice_id)),
    CONSTRAINT card_invoice_items_installment_number_check CHECK (((installment_number >= 1) AND (installment_number <= 99))),
    CONSTRAINT card_invoice_items_kind_check CHECK ((kind = ANY (ARRAY['installment'::text, 'carryover'::text]))),
    CONSTRAINT card_invoice_items_kind_links_check CHECK (
CASE kind
    WHEN 'installment'::text THEN ((card_purchase_id IS NOT NULL) AND (installment_number IS NOT NULL) AND (carried_from_invoice_id IS NULL))
    WHEN 'carryover'::text THEN ((carried_from_invoice_id IS NOT NULL) AND (card_purchase_id IS NULL) AND (installment_number IS NULL))
    ELSE NULL::boolean
END)
);


--
-- Name: TABLE card_invoice_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.card_invoice_items IS 'Linhas de uma fatura: installment (parcela n de N de um card_purchases) ou carryover (saldo não pago de uma fatura anterior, rolado para esta). Só mudam enquanto a fatura está aberta.';


--
-- Name: COLUMN card_invoice_items.installment_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoice_items.installment_number IS 'n de N. A parcela n fica na fatura n − first_installment meses depois da primeira, cujo fechamento é >= purchased_on.';


--
-- Name: COLUMN card_invoice_items.carried_from_invoice_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoice_items.carried_from_invoice_id IS 'carryover: fatura (fechada, anterior, do mesmo cartão) cujo saldo desta pagadora foi rolado. Um por fatura e pagadora.';


--
-- Name: COLUMN card_invoice_items.payer_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoice_items.payer_caixa_id IS 'Caixa pagadora (igual à da compra nas parcelas).';


--
-- Name: COLUMN card_invoice_items.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoice_items.amount_cents IS 'Valor assinado: + aumenta a fatura (parcela de compra/encargo, saldo devedor rolado), − reduz (parcela de estorno, crédito rolado). Parcelas de uma compra somam o amount_cents dela.';


--
-- Name: card_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_invoices (
    id uuid DEFAULT uuidv7() NOT NULL,
    card_caixa_id uuid NOT NULL,
    reference_month date NOT NULL,
    closing_date date NOT NULL,
    due_date date NOT NULL,
    closed_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_invoices_dates_check CHECK ((due_date >= closing_date)),
    CONSTRAINT card_invoices_reference_month_check CHECK ((reference_month = (date_trunc('month'::text, (reference_month)::timestamp with time zone))::date))
);


--
-- Name: TABLE card_invoices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.card_invoices IS 'Fatura de um cartão por competência (spec 007). Aberta (closed_at nulo) recebe itens; fechada fica congelada e tem, por caixa pagadora, títulos card_invoice cuja soma + o saldo rolado = soma dos itens. Status (open/closed/paid) e totais: view card_invoice_summaries.';


--
-- Name: COLUMN card_invoices.reference_month; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoices.reference_month IS 'Competência da fatura: 1º dia do mês (ex.: 2026-10-01 = fatura 10/2026). Imutável.';


--
-- Name: COLUMN card_invoices.closing_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoices.closing_date IS 'Data de fechamento; só muda enquanto a fatura está aberta.';


--
-- Name: COLUMN card_invoices.due_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoices.due_date IS 'Vencimento (>= fechamento); só muda enquanto a fatura está aberta.';


--
-- Name: COLUMN card_invoices.closed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_invoices.closed_at IS 'Instante do fechamento. Nulo = aberta. Reabrir (voltar a nulo) só sem pagamento nem saldo rolado.';


--
-- Name: card_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_purchases (
    id uuid DEFAULT uuidv7() NOT NULL,
    card_caixa_id uuid NOT NULL,
    kind text DEFAULT 'purchase'::text NOT NULL,
    charge_kind text,
    payer_caixa_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    category_id uuid NOT NULL,
    purchased_on date NOT NULL,
    description text NOT NULL,
    amount_cents bigint NOT NULL,
    installments_total smallint DEFAULT 1 NOT NULL,
    first_installment smallint DEFAULT 1 NOT NULL,
    refunded_purchase_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_purchases_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT card_purchases_charge_kind_check CHECK ((charge_kind = ANY (ARRAY['interest'::text, 'iof'::text, 'fine'::text, 'fee'::text, 'other'::text]))),
    CONSTRAINT card_purchases_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT card_purchases_installments_check CHECK ((((installments_total >= 1) AND (installments_total <= 99)) AND ((first_installment >= 1) AND (first_installment <= installments_total)))),
    CONSTRAINT card_purchases_kind_check CHECK ((kind = ANY (ARRAY['purchase'::text, 'refund'::text, 'charge'::text]))),
    CONSTRAINT card_purchases_kind_links_check CHECK ((((kind = 'refund'::text) = (refunded_purchase_id IS NOT NULL)) AND ((kind = 'charge'::text) = (charge_kind IS NOT NULL)))),
    CONSTRAINT card_purchases_refund_self_check CHECK ((refunded_purchase_id <> id))
);


--
-- Name: TABLE card_purchases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.card_purchases IS 'Lançamentos da caixa do cartão (spec 007): compra (purchase), estorno (refund, crédito ligado à compra original) e encargo do emissor (charge: juros, IOF, multa, tarifa). Cada um tem recebedor final, categoria de despesa e caixa pagadora, e se distribui em itens de fatura (card_invoice_items), um por parcela.';


--
-- Name: COLUMN card_purchases.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.kind IS 'purchase, refund (estorno de refunded_purchase_id) ou charge (encargo do emissor). Imutável.';


--
-- Name: COLUMN card_purchases.charge_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.charge_kind IS 'Só em charge: interest (juros), iof, fine (multa), fee (tarifa/anuidade) ou other.';


--
-- Name: COLUMN card_purchases.payer_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.payer_caixa_id IS 'Caixa pagadora (general). A aplicação preenche com a pagadora padrão do cartão; pode ser trocada por compra.';


--
-- Name: COLUMN card_purchases.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.entity_id IS 'Recebedor final (lojista). Encargo: o emissor (titular da caixa do cartão). Estorno: o mesmo da compra original.';


--
-- Name: COLUMN card_purchases.category_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.category_id IS 'Categoria de despesa (expense). Estorno: a mesma da compra original.';


--
-- Name: COLUMN card_purchases.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.amount_cents IS 'Valor total (> 0, sempre positivo; o sinal do estorno está nos itens). Com first_installment > 1, é o valor das parcelas first_installment..N registradas no app.';


--
-- Name: COLUMN card_purchases.installments_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.installments_total IS 'N: total de parcelas (1 = à vista).';


--
-- Name: COLUMN card_purchases.first_installment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.first_installment IS 'Primeira parcela registrada no app (1 normalmente; > 1 ao começar a usar o app no meio de um parcelamento).';


--
-- Name: COLUMN card_purchases.refunded_purchase_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.refunded_purchase_id IS 'Estorno: a compra (ou encargo) original estornada.';


--
-- Name: card_invoice_lines; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.card_invoice_lines WITH (security_invoker='true') AS
 SELECT i.id AS card_invoice_item_id,
    i.card_invoice_id,
    v.card_caixa_id,
    v.reference_month,
    i.payer_caixa_id,
    i.kind AS item_kind,
    i.amount_cents,
    i.installment_number,
    p.installments_total,
    i.card_purchase_id,
    p.kind AS purchase_kind,
    p.charge_kind,
    p.refunded_purchase_id,
    p.entity_id,
    p.category_id,
    p.purchased_on,
    COALESCE(p.description, i.description) AS description,
    i.carried_from_invoice_id
   FROM ((public.card_invoice_items i
     JOIN public.card_invoices v ON ((v.id = i.card_invoice_id)))
     LEFT JOIN public.card_purchases p ON ((p.id = i.card_purchase_id)));


--
-- Name: VIEW card_invoice_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.card_invoice_lines IS 'Itens de fatura com a compra de origem (recebedor final, categoria, n de N). A pagadora navega da fatura-título (titles.card_invoice_id) para cá filtrando por payer_caixa_id.';


--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id uuid DEFAULT uuidv7() NOT NULL,
    title_id uuid NOT NULL,
    settled_on date NOT NULL,
    amount_cents bigint NOT NULL,
    interest_cents bigint DEFAULT 0 NOT NULL,
    fine_cents bigint DEFAULT 0 NOT NULL,
    discount_cents bigint DEFAULT 0 NOT NULL,
    financial_account_id uuid,
    mirror_settlement_id uuid,
    notes text,
    reversed_at timestamp with time zone,
    reversal_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlements_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT settlements_charges_check CHECK (((interest_cents >= 0) AND (fine_cents >= 0) AND (discount_cents >= 0))),
    CONSTRAINT settlements_discount_check CHECK ((discount_cents <= ((amount_cents + interest_cents) + fine_cents))),
    CONSTRAINT settlements_mirror_self_check CHECK ((mirror_settlement_id <> id)),
    CONSTRAINT settlements_reversal_check CHECK ((((reversed_at IS NULL) = (reversal_reason IS NULL)) AND (btrim(reversal_reason) <> ''::text)))
);


--
-- Name: TABLE settlements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.settlements IS 'Baixas de títulos (spec 005). Valor em dinheiro = principal + juros + multa − desconto. Estorno por reversed_at.';


--
-- Name: COLUMN settlements.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.settlements.amount_cents IS 'Principal abatido do título (> 0). A soma das baixas ativas nunca passa do valor do título.';


--
-- Name: COLUMN settlements.financial_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.settlements.financial_account_id IS 'Conta (da caixa do título) onde o dinheiro entrou/saiu. Nulo = "baixado, conta a definir" (lado sem acesso do espelho); pode ser preenchido depois, uma única vez.';


--
-- Name: COLUMN settlements.mirror_settlement_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.settlements.mirror_settlement_id IS 'Outra perna da baixa única de um par espelhado (ligação recíproca, mesmos valores e data; checada no COMMIT).';


--
-- Name: COLUMN settlements.reversed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.settlements.reversed_at IS 'Estorno: a baixa deixa de contar. Irreversível; exige reversal_reason.';


--
-- Name: titles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.titles (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid NOT NULL,
    direction text NOT NULL,
    entity_id uuid NOT NULL,
    category_id uuid NOT NULL,
    description text NOT NULL,
    competence_date date NOT NULL,
    due_date date NOT NULL,
    amount_cents bigint NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    recurrence_rule_id uuid,
    occurrence smallint,
    counterparty_caixa_id uuid,
    mirror_title_id uuid,
    mirror_status text,
    notes text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    boleto_barcode text,
    pix_payload text,
    nfe_document_id uuid,
    card_invoice_id uuid,
    contract_id uuid,
    contract_cycle_id uuid,
    contract_installment smallint,
    CONSTRAINT titles_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT titles_boleto_barcode_check CHECK (public.is_valid_boleto_barcode(boleto_barcode)),
    CONSTRAINT titles_card_invoice_check CHECK ((((origin = 'card_invoice'::text) = (card_invoice_id IS NOT NULL)) AND ((card_invoice_id IS NULL) OR (counterparty_caixa_id IS NOT NULL)))),
    CONSTRAINT titles_contract_check CHECK ((((origin = 'contract'::text) = (contract_id IS NOT NULL)) AND ((contract_cycle_id IS NULL) = (contract_installment IS NULL)) AND ((contract_cycle_id IS NULL) OR (contract_id IS NOT NULL)))),
    CONSTRAINT titles_contract_installment_check CHECK ((contract_installment >= 1)),
    CONSTRAINT titles_counterparty_caixa_check CHECK ((counterparty_caixa_id <> caixa_id)),
    CONSTRAINT titles_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT titles_direction_check CHECK ((direction = ANY (ARRAY['payable'::text, 'receivable'::text]))),
    CONSTRAINT titles_mirror_fields_check CHECK ((((counterparty_caixa_id IS NULL) = (mirror_title_id IS NULL)) AND ((mirror_status IS NULL) OR (mirror_title_id IS NOT NULL)))),
    CONSTRAINT titles_mirror_self_check CHECK ((mirror_title_id <> id)),
    CONSTRAINT titles_mirror_status_check CHECK ((mirror_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'disputed'::text]))),
    CONSTRAINT titles_occurrence_check CHECK ((occurrence >= 1)),
    CONSTRAINT titles_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'recurrence'::text, 'card_invoice'::text, 'contract'::text]))),
    CONSTRAINT titles_pix_payload_check CHECK (public.is_valid_brcode(pix_payload)),
    CONSTRAINT titles_recurrence_check CHECK ((((recurrence_rule_id IS NULL) = (occurrence IS NULL)) AND ((origin = 'recurrence'::text) = (recurrence_rule_id IS NOT NULL)))),
    CONSTRAINT titles_status_check CHECK ((status = ANY (ARRAY['open'::text, 'partial'::text, 'paid'::text, 'canceled'::text])))
);


--
-- Name: TABLE titles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.titles IS 'Títulos a pagar/receber de uma caixa (spec 005), liquidados por baixas; espelhados na caixa da contraparte (spec 006).';


--
-- Name: COLUMN titles.direction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.direction IS 'payable (a pagar, categoria expense) ou receivable (a receber, categoria income). Imutável.';


--
-- Name: COLUMN titles.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.entity_id IS 'Contraparte: a quem pagamos (payable) ou de quem recebemos (receivable).';


--
-- Name: COLUMN titles.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.status IS 'open | partial | paid: derivado da soma das baixas ativas (mantido por trigger); canceled: definido pela aplicação, só sem baixas ativas.';


--
-- Name: COLUMN titles.origin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.origin IS 'manual, recurrence (gerado por recurrence_rules), card_invoice (fatura de cartão, F2) ou contract (parcela ou título extra de um contrato, F5). O espelho herda a origem do original.';


--
-- Name: COLUMN titles.occurrence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.occurrence IS 'Número da ocorrência/parcela n na série (N = recurrence_rules.installments_total).';


--
-- Name: COLUMN titles.counterparty_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.counterparty_caixa_id IS 'Caixa do outro lado do espelho (titular = entity_id). Nulo = sem espelho.';


--
-- Name: COLUMN titles.mirror_title_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.mirror_title_id IS 'Título espelho (ligação 1:1 recíproca, checada no COMMIT).';


--
-- Name: COLUMN titles.mirror_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.mirror_status IS 'Só no lado espelho (o criado na caixa da contraparte): pending (aguarda aceite), accepted ou disputed. Nulo no original.';


--
-- Name: COLUMN titles.boleto_barcode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.boleto_barcode IS 'Código de barras do boleto (44 dígitos, com DV válido). A linha digitável é derivada dele. Único por caixa entre os títulos não cancelados.';


--
-- Name: COLUMN titles.pix_payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.pix_payload IS 'PIX copia-e-cola (BR Code) completo, com CRC válido. Pode repetir (QR estático).';


--
-- Name: COLUMN titles.nfe_document_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.nfe_document_id IS 'NF-e de origem (import de XML). Vários títulos podem apontar para a mesma nota.';


--
-- Name: COLUMN titles.card_invoice_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.card_invoice_id IS 'origin = card_invoice: a fatura. O par espelhado é "a receber" na caixa do cartão e "a pagar" na caixa pagadora (general); os dois lados apontam para a mesma fatura.';


--
-- Name: COLUMN titles.contract_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.contract_id IS 'Contrato (origin = contract). O lado original fica na caixa do contrato; o espelho aponta para ela em counterparty_caixa_id.';


--
-- Name: COLUMN titles.contract_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.contract_cycle_id IS 'Ciclo da parcela. Nulo num título de contrato = título extra ligado a ele (multa, valor rescisório; qualquer direção).';


--
-- Name: COLUMN titles.contract_installment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.contract_installment IS 'Número da parcela n no ciclo (N = contract_cycles.installments_count).';


--
-- Name: title_balances; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.title_balances WITH (security_invoker='true') AS
 SELECT t.id AS title_id,
    t.caixa_id,
    t.direction,
    t.status,
    t.entity_id,
    t.category_id,
    t.description,
    t.competence_date,
    t.due_date,
    t.amount_cents,
    (COALESCE(s.settled_cents, (0)::numeric))::bigint AS settled_cents,
    (
        CASE
            WHEN (t.status = 'canceled'::text) THEN (0)::numeric
            ELSE ((t.amount_cents)::numeric - COALESCE(s.settled_cents, (0)::numeric))
        END)::bigint AS open_cents,
    t.archived_at
   FROM (public.titles t
     LEFT JOIN LATERAL ( SELECT sum(x.amount_cents) AS settled_cents
           FROM public.settlements x
          WHERE ((x.title_id = t.id) AND (x.reversed_at IS NULL))) s ON (true));


--
-- Name: VIEW title_balances; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.title_balances IS 'Títulos com principal baixado (baixas ativas) e saldo aberto (amount − baixado; 0 se cancelado). Títulos em aberto: open_cents > 0.';


--
-- Name: card_invoice_payer_totals; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.card_invoice_payer_totals WITH (security_invoker='true') AS
 SELECT v.id AS card_invoice_id,
    v.card_caixa_id,
    v.reference_month,
    v.due_date,
    p.payer_caixa_id,
    (COALESCE(it.items_cents, (0)::numeric))::bigint AS items_cents,
    (COALESCE(tt.billed_cents, (0)::numeric))::bigint AS billed_cents,
    (COALESCE(tt.settled_cents, (0)::numeric))::bigint AS settled_cents,
    (COALESCE(tt.open_cents, (0)::numeric))::bigint AS open_cents,
    (COALESCE(co.carried_out_cents, (0)::numeric))::bigint AS carried_out_cents
   FROM ((((public.card_invoices v
     JOIN LATERAL ( SELECT i.payer_caixa_id
           FROM public.card_invoice_items i
          WHERE (i.card_invoice_id = v.id)
        UNION
         SELECT t.counterparty_caixa_id
           FROM public.titles t
          WHERE ((t.card_invoice_id = v.id) AND (t.caixa_id = v.card_caixa_id))) p ON (true))
     LEFT JOIN LATERAL ( SELECT sum(i.amount_cents) AS items_cents
           FROM public.card_invoice_items i
          WHERE ((i.card_invoice_id = v.id) AND (i.payer_caixa_id = p.payer_caixa_id))) it ON (true))
     LEFT JOIN LATERAL ( SELECT sum(b.amount_cents) FILTER (WHERE (b.status <> 'canceled'::text)) AS billed_cents,
            sum(b.settled_cents) AS settled_cents,
            sum(b.open_cents) AS open_cents
           FROM (public.title_balances b
             JOIN public.titles t ON ((t.id = b.title_id)))
          WHERE ((t.card_invoice_id = v.id) AND (t.caixa_id = v.card_caixa_id) AND (t.counterparty_caixa_id = p.payer_caixa_id))) tt ON (true))
     LEFT JOIN LATERAL ( SELECT sum(i.amount_cents) AS carried_out_cents
           FROM public.card_invoice_items i
          WHERE ((i.carried_from_invoice_id = v.id) AND (i.payer_caixa_id = p.payer_caixa_id))) co ON (true));


--
-- Name: VIEW card_invoice_payer_totals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.card_invoice_payer_totals IS 'Por fatura e caixa pagadora: soma dos itens, valor faturado em títulos (lado do cartão, não cancelados), principal pago, saldo aberto e saldo rolado para frente. No fechamento: título = items_cents − settled de antecipações.';


--
-- Name: card_invoice_summaries; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.card_invoice_summaries WITH (security_invoker='true') AS
 SELECT v.id AS card_invoice_id,
    v.card_caixa_id,
    v.reference_month,
    v.closing_date,
    v.due_date,
    v.closed_at,
    (COALESCE(s.items_cents, (0)::numeric))::bigint AS total_cents,
    (COALESCE(s.billed_cents, (0)::numeric))::bigint AS billed_cents,
    (COALESCE(s.settled_cents, (0)::numeric))::bigint AS settled_cents,
    (COALESCE(s.open_cents, (0)::numeric))::bigint AS open_cents,
    (COALESCE(s.carried_out_cents, (0)::numeric))::bigint AS carried_out_cents,
        CASE
            WHEN (v.closed_at IS NULL) THEN 'open'::text
            WHEN (COALESCE(s.open_cents, (0)::numeric) > (0)::numeric) THEN 'closed'::text
            WHEN COALESCE(s.carried_debt, false) THEN 'carried_over'::text
            ELSE 'paid'::text
        END AS status
   FROM (public.card_invoices v
     LEFT JOIN LATERAL ( SELECT sum(x.items_cents) AS items_cents,
            sum(x.billed_cents) AS billed_cents,
            sum(x.settled_cents) AS settled_cents,
            sum(x.open_cents) AS open_cents,
            sum(x.carried_out_cents) AS carried_out_cents,
            bool_or((x.carried_out_cents > 0)) AS carried_debt
           FROM public.card_invoice_payer_totals x
          WHERE (x.card_invoice_id = v.id)) s ON (true));


--
-- Name: VIEW card_invoice_summaries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.card_invoice_summaries IS 'Fatura com totais e status: open (aberta), closed (fechada com saldo aberto a pagar), carried_over (fechada, nada mais a pagar nela, mas com saldo devedor rolado para a fatura seguinte) ou paid (fechada e quitada, sem saldo devedor rolado de nenhuma pagadora; crédito rolado conta como quitada).';


--
-- Name: card_limits; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.card_limits WITH (security_invoker='true') AS
 SELECT c.id AS card_caixa_id,
    c.credit_limit_cents,
    ((COALESCE(it.items_cents, (0)::numeric) - COALESCE(st.paid_cents, (0)::numeric)))::bigint AS used_cents,
    ((((c.credit_limit_cents)::numeric - COALESCE(it.items_cents, (0)::numeric)) + COALESCE(st.paid_cents, (0)::numeric)))::bigint AS available_cents
   FROM ((public.caixas c
     LEFT JOIN LATERAL ( SELECT sum(i.amount_cents) AS items_cents
           FROM (public.card_invoice_items i
             JOIN public.card_invoices v ON ((v.id = i.card_invoice_id)))
          WHERE ((v.card_caixa_id = c.id) AND (i.kind = 'installment'::text))) it ON (true))
     LEFT JOIN LATERAL ( SELECT sum(s.amount_cents) AS paid_cents
           FROM (public.settlements s
             JOIN public.titles t ON ((t.id = s.title_id)))
          WHERE ((t.caixa_id = c.id) AND (t.card_invoice_id IS NOT NULL) AND (s.reversed_at IS NULL))) st ON (true))
  WHERE (c.kind = 'credit_card'::text);


--
-- Name: VIEW card_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.card_limits IS 'Limite do cartão: used_cents = parcelas lançadas em todas as faturas (inclusive futuras, encargos e estornos) − principal pago nos títulos de fatura (lado do cartão); available_cents = limite − usado (pode ficar negativo).';


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    icon text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    color_slot smallint,
    CONSTRAINT categories_color_slot_check CHECK (((color_slot >= 1) AND (color_slot <= 12))),
    CONSTRAINT categories_icon_check CHECK ((icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT categories_kind_check CHECK ((kind = ANY (ARRAY['income'::text, 'expense'::text]))),
    CONSTRAINT categories_name_check CHECK (((btrim(name) <> ''::text) AND (name = btrim(name)))),
    CONSTRAINT categories_parent_self_check CHECK ((parent_id <> id))
);


--
-- Name: TABLE categories; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.categories IS 'Plano global de categorias: grupo (parent_id nulo) → subcategoria. Dois níveis, filho com o kind do pai.';


--
-- Name: COLUMN categories.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.kind IS 'income (receita) ou expense (despesa). Imutável após a criação.';


--
-- Name: COLUMN categories.icon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.icon IS 'Nome de ícone lucide em kebab-case (ex.: shopping-cart).';


--
-- Name: COLUMN categories.color_slot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.color_slot IS 'Slot de cor do design system (1–12); o front mapeia para o token CSS --port-N. Nulo = cor neutra.';


--
-- Name: classification_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classification_rules (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid,
    match_kind text DEFAULT 'contains'::text NOT NULL,
    pattern text NOT NULL,
    direction text,
    entity_id uuid,
    category_id uuid,
    priority smallint DEFAULT 100 NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    created_from_line_id uuid,
    created_by_user_id uuid,
    usage_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT classification_rules_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT classification_rules_match_kind_check CHECK ((match_kind = ANY (ARRAY['contains'::text, 'starts_with'::text, 'exact'::text, 'regex'::text]))),
    CONSTRAINT classification_rules_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'correction'::text, 'agent'::text]))),
    CONSTRAINT classification_rules_pattern_check CHECK (((btrim(pattern) <> ''::text) AND (length(pattern) <= 200))),
    CONSTRAINT classification_rules_priority_check CHECK (((priority >= 0) AND (priority <= 1000))),
    CONSTRAINT classification_rules_target_check CHECK (((num_nonnulls(entity_id, category_id) >= 1) AND ((category_id IS NULL) OR (direction IS NOT NULL)))),
    CONSTRAINT classification_rules_usage_count_check CHECK ((usage_count >= 0))
);


--
-- Name: TABLE classification_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.classification_rules IS 'Regras descrição → entidade/categoria (spec 009), criadas à mão, por correção do usuário ou sugeridas pelo agente. A melhor regra para uma linha: classification_rule_for().';


--
-- Name: COLUMN classification_rules.caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.caixa_id IS 'Escopo: só nesta caixa. Nulo = todas as caixas.';


--
-- Name: COLUMN classification_rules.match_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.match_kind IS 'contains, starts_with, exact (sem distinção de maiúsculas, espaços nas pontas ignorados) ou regex (~*, POSIX).';


--
-- Name: COLUMN classification_rules.direction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.direction IS 'in (entrada, categoria income), out (saída, expense) ou nulo (qualquer; só sem categoria).';


--
-- Name: COLUMN classification_rules.priority; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.priority IS 'Menor número vence (0–1000, padrão 100).';


--
-- Name: COLUMN classification_rules.origin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.origin IS 'manual, correction (aprendida de uma correção do usuário) ou agent (sugestão aprovada do agente).';


--
-- Name: COLUMN classification_rules.created_from_line_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.created_from_line_id IS 'Linha de extrato cuja correção originou a regra.';


--
-- Name: COLUMN classification_rules.usage_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.usage_count IS 'Quantas vezes a regra classificou uma linha (a aplicação incrementa).';


--
-- Name: contract_amendments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_amendments (
    id uuid DEFAULT uuidv7() NOT NULL,
    contract_id uuid NOT NULL,
    contract_cycle_id uuid NOT NULL,
    document_id uuid,
    effective_on date NOT NULL,
    changes jsonb NOT NULL,
    affected_title_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    skipped_title_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_amendments_changes_check CHECK (((jsonb_typeof(changes) = 'object'::text) AND COALESCE((jsonb_typeof((changes -> 'before'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof((changes -> 'after'::text)) = 'object'::text), false))),
    CONSTRAINT contract_amendments_title_ids_check CHECK (((array_position(affected_title_ids, NULL::uuid) IS NULL) AND (array_position(skipped_title_ids, NULL::uuid) IS NULL)))
);


--
-- Name: TABLE contract_amendments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_amendments IS 'Histórico de aditivos de um contrato (antes → depois). Imutável, exceto document_id e notes.';


--
-- Name: COLUMN contract_amendments.contract_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.contract_cycle_id IS 'Ciclo aditado (do mesmo contrato).';


--
-- Name: COLUMN contract_amendments.document_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.document_id IS 'Documento do aditivo (do mesmo contrato), opcional.';


--
-- Name: COLUMN contract_amendments.effective_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.effective_on IS 'Data de efeito: parcelas em aberto e sem baixa com competência nela ou depois são recalculadas.';


--
-- Name: COLUMN contract_amendments.changes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.changes IS 'O que mudou: {"before": {...}, "after": {...}} (valor, vencimento, deslocamento, categoria…).';


--
-- Name: COLUMN contract_amendments.affected_title_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.affected_title_ids IS 'Títulos recalculados pelo aditivo (os dois lados do espelho).';


--
-- Name: COLUMN contract_amendments.skipped_title_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.skipped_title_ids IS 'Títulos que ficaram como estavam (com baixa ou em mês fechado), mostrados como aviso.';


--
-- Name: contract_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_cycles (
    id uuid DEFAULT uuidv7() NOT NULL,
    contract_id uuid NOT NULL,
    seq smallint NOT NULL,
    starts_on date NOT NULL,
    duration_months smallint NOT NULL,
    ends_on date GENERATED ALWAYS AS (
CASE
    WHEN (EXTRACT(day FROM (starts_on + make_interval(months => (duration_months)::integer))) < EXTRACT(day FROM starts_on)) THEN ((starts_on + make_interval(months => (duration_months)::integer)))::date
    ELSE (((starts_on + make_interval(months => (duration_months)::integer)))::date - 1)
END) STORED NOT NULL,
    periodicity text NOT NULL,
    installments_count smallint GENERATED ALWAYS AS ((
CASE periodicity
    WHEN 'monthly'::text THEN (duration_months)::integer
    WHEN 'quarterly'::text THEN (duration_months / 3)
    WHEN 'semiannual'::text THEN (duration_months / 6)
    WHEN 'annual'::text THEN (duration_months / 12)
    ELSE 1
END)::smallint) STORED NOT NULL,
    total_cents bigint NOT NULL,
    due_day smallint NOT NULL,
    due_month_offset smallint DEFAULT 0 NOT NULL,
    readjustment_percent numeric(7,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_cycles_due_day_check CHECK (((due_day >= 1) AND (due_day <= 31))),
    CONSTRAINT contract_cycles_due_month_offset_check CHECK (((due_month_offset >= 0) AND (due_month_offset <= 3))),
    CONSTRAINT contract_cycles_duration_months_check CHECK (((duration_months >= 1) AND (duration_months <= 120))),
    CONSTRAINT contract_cycles_duration_periodicity_check CHECK ((((duration_months)::integer %
CASE periodicity
    WHEN 'quarterly'::text THEN 3
    WHEN 'semiannual'::text THEN 6
    WHEN 'annual'::text THEN 12
    ELSE 1
END) = 0)),
    CONSTRAINT contract_cycles_periodicity_check CHECK ((periodicity = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text, 'single'::text]))),
    CONSTRAINT contract_cycles_readjustment_percent_check CHECK ((readjustment_percent > ('-100'::integer)::numeric)),
    CONSTRAINT contract_cycles_seq_check CHECK ((seq >= 1)),
    CONSTRAINT contract_cycles_total_cents_check CHECK (((total_cents > 0) AND (total_cents >= installments_count)))
);


--
-- Name: TABLE contract_cycles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_cycles IS 'Ciclos (vigências) de um contrato, seq 1, 2, 3… contíguos (o seguinte começa no dia seguinte ao fim do anterior; checado no COMMIT). Com títulos ligados, starts_on, duration_months e periodicity ficam imutáveis.';


--
-- Name: COLUMN contract_cycles.duration_months; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.duration_months IS 'Duração em meses (1–120), múltipla dos meses do período (single aceita qualquer).';


--
-- Name: COLUMN contract_cycles.ends_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.ends_on IS 'Gerada: x = starts_on + duration_months meses; x se o dia não existe no mês final (31/01 + 1 → 28/02, o seguinte começa em 01/03), senão x − 1 dia (01/03/2025 + 12 → 28/02/2026; 29/01/2024 + 1 → 28/02/2024).';


--
-- Name: COLUMN contract_cycles.periodicity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.periodicity IS 'monthly (1 mês), quarterly (3), semiannual (6), annual (12) ou single (parcela única no ciclo).';


--
-- Name: COLUMN contract_cycles.installments_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.installments_count IS 'Gerada: número de parcelas = duração ÷ meses do período (single = 1).';


--
-- Name: COLUMN contract_cycles.total_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.total_cents IS 'Valor total do ciclo (≥ 1 centavo por parcela). Divisão em parcelas iguais com o resto na primeira (aplicação).';


--
-- Name: COLUMN contract_cycles.due_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.due_day IS 'Dia de vencimento (1–31; meses curtos usam o último dia).';


--
-- Name: COLUMN contract_cycles.due_month_offset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.due_month_offset IS 'Meses entre a competência e o vencimento (0–3; ex.: serviço de março vence em abril = 1).';


--
-- Name: COLUMN contract_cycles.readjustment_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.readjustment_percent IS 'Reajuste aplicado na renovação ou no aditivo, em % (informativo).';


--
-- Name: contract_document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_document_versions (
    id uuid DEFAULT uuidv7() NOT NULL,
    document_id uuid NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    note text,
    author_kind text DEFAULT 'human'::text NOT NULL,
    author_user_id uuid,
    ai_run_id uuid,
    restored_from_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_document_versions_author_check CHECK (((author_kind = 'agent'::text) OR (ai_run_id IS NULL))),
    CONSTRAINT contract_document_versions_author_kind_check CHECK ((author_kind = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT contract_document_versions_content_check CHECK ((octet_length(content) <= 1048576)),
    CONSTRAINT contract_document_versions_note_check CHECK ((length(note) <= 500)),
    CONSTRAINT contract_document_versions_restored_self_check CHECK ((restored_from_version_id <> id)),
    CONSTRAINT contract_document_versions_version_check CHECK ((version >= 1))
);


--
-- Name: TABLE contract_document_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_document_versions IS 'Versões de um documento markdown de contrato: cada salvamento cria uma (version 1, 2, 3…; omita version no INSERT e o banco atribui a próxima, travando o documento). Imutáveis; somem só com o documento. A auditoria grava a linha sem o content (com content_bytes).';


--
-- Name: COLUMN contract_document_versions.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.version IS 'Número da versão no documento, atribuído pelo banco quando omitido; se informado, tem de ser o próximo (max + 1).';


--
-- Name: COLUMN contract_document_versions.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.content IS 'Markdown (UTF-8, até 1 MB; pode ser vazio).';


--
-- Name: COLUMN contract_document_versions.note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.note IS 'Nota opcional do salvamento (até 500).';


--
-- Name: COLUMN contract_document_versions.author_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.author_kind IS 'human (editor, upload, restauração) ou agent (gerado por IA a partir do PDF).';


--
-- Name: COLUMN contract_document_versions.ai_run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.ai_run_id IS 'Execução do agente que gerou a versão (só author_kind = agent; opcional).';


--
-- Name: COLUMN contract_document_versions.restored_from_version_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.restored_from_version_id IS 'Versão (do mesmo documento) cujo conteúdo foi restaurado nesta.';


--
-- Name: contract_renewal_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_renewal_tasks (
    id uuid DEFAULT uuidv7() NOT NULL,
    contract_id uuid NOT NULL,
    contract_cycle_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    opened_on date NOT NULL,
    due_on date NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    decision_notes text,
    new_cycle_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_renewal_tasks_decision_check CHECK (
CASE status
    WHEN 'open'::text THEN ((decided_at IS NULL) AND (new_cycle_id IS NULL))
    WHEN 'approved'::text THEN ((decided_at IS NOT NULL) AND (new_cycle_id IS NOT NULL))
    WHEN 'declined'::text THEN ((decided_at IS NOT NULL) AND (new_cycle_id IS NULL))
    ELSE NULL::boolean
END),
    CONSTRAINT contract_renewal_tasks_new_cycle_self_check CHECK ((new_cycle_id <> contract_cycle_id)),
    CONSTRAINT contract_renewal_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'approved'::text, 'declined'::text])))
);


--
-- Name: TABLE contract_renewal_tasks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_renewal_tasks IS 'Tarefa de renovação de um ciclo (uma por ciclo; no máximo uma open por contrato). Aprovada pelo usuário (cria o ciclo seguinte, new_cycle_id) ou recusada; decidida é final. Contrato renewal_pending ⇔ tarefa open (no COMMIT).';


--
-- Name: COLUMN contract_renewal_tasks.contract_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.contract_cycle_id IS 'Ciclo que termina (a renovar).';


--
-- Name: COLUMN contract_renewal_tasks.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.status IS 'open → approved (decided_at e new_cycle_id) | declined (decided_at). Decidida é final.';


--
-- Name: COLUMN contract_renewal_tasks.opened_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.opened_on IS 'Quando a tarefa foi aberta (fim do ciclo − renewal_lead_days, ou à mão).';


--
-- Name: COLUMN contract_renewal_tasks.due_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.due_on IS 'Fim do ciclo a renovar (= contract_cycles.ends_on); depois disso a tarefa está vencida.';


--
-- Name: COLUMN contract_renewal_tasks.new_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.new_cycle_id IS 'Ciclo criado pela aprovação (o seguinte, seq + 1).';


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contracts (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    direction text NOT NULL,
    name text NOT NULL,
    contract_number text,
    category_id uuid NOT NULL,
    counterparty_caixa_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    auto_renew boolean DEFAULT false NOT NULL,
    notice_days smallint DEFAULT 30 NOT NULL,
    renewal_lead_days smallint DEFAULT 60 NOT NULL,
    reminder_every_days smallint DEFAULT 7 NOT NULL,
    readjustment_index text DEFAULT 'none'::text NOT NULL,
    readjustment_base_date date,
    termination_penalty_text text,
    termination_penalty_cents bigint,
    terminated_on date,
    termination_notes text,
    notes text,
    created_by uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contracts_contract_number_check CHECK (((btrim(contract_number) <> ''::text) AND (length(contract_number) <= 60))),
    CONSTRAINT contracts_counterparty_caixa_check CHECK ((counterparty_caixa_id <> caixa_id)),
    CONSTRAINT contracts_direction_check CHECK ((direction = ANY (ARRAY['payable'::text, 'receivable'::text]))),
    CONSTRAINT contracts_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 200))),
    CONSTRAINT contracts_notice_days_check CHECK (((notice_days >= 0) AND (notice_days <= 365))),
    CONSTRAINT contracts_readjustment_index_check CHECK ((readjustment_index = ANY (ARRAY['none'::text, 'ipca'::text, 'igpm'::text, 'inpc'::text, 'other'::text]))),
    CONSTRAINT contracts_reminder_every_days_check CHECK (((reminder_every_days >= 1) AND (reminder_every_days <= 30))),
    CONSTRAINT contracts_renewal_lead_days_check CHECK (((renewal_lead_days >= 1) AND (renewal_lead_days <= 365))),
    CONSTRAINT contracts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'renewal_pending'::text, 'ended'::text, 'terminated'::text]))),
    CONSTRAINT contracts_terminated_check CHECK (((status = 'terminated'::text) = (terminated_on IS NOT NULL))),
    CONSTRAINT contracts_termination_penalty_cents_check CHECK ((termination_penalty_cents > 0)),
    CONSTRAINT contracts_termination_penalty_text_check CHECK ((length(termination_penalty_text) <= 2000))
);


--
-- Name: TABLE contracts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contracts IS 'Contratos (spec 020): acordo com uma entidade dentro de uma caixa general. Gera os títulos das parcelas por ciclo (contract_cycles); documentos, aditivos e tarefas de renovação ficam nas tabelas contract_*. Só rascunho é excluído.';


--
-- Name: COLUMN contracts.caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.caixa_id IS 'Caixa dona do contrato (sempre general). Imutável fora do rascunho.';


--
-- Name: COLUMN contracts.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.entity_id IS 'Contraparte (diferente do titular da caixa). Imutável fora do rascunho.';


--
-- Name: COLUMN contracts.direction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.direction IS 'receivable (eu recebo; categoria income) ou payable (eu pago; categoria expense). Imutável; as parcelas seguem.';


--
-- Name: COLUMN contracts.contract_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.contract_number IS 'Número do contrato (opcional, até 60), único por caixa sem distinção de maiúsculas entre os não arquivados.';


--
-- Name: COLUMN contracts.category_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.category_id IS 'Categoria aplicada às parcelas, compatível com a direção.';


--
-- Name: COLUMN contracts.counterparty_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.counterparty_caixa_id IS 'Caixa onde as parcelas espelham (general, titular = entity_id). Nulo = sem espelho.';


--
-- Name: COLUMN contracts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.status IS 'draft (sem títulos) → active; active → renewal_pending | ended | terminated; renewal_pending → active | ended | terminated; ended → active | renewal_pending; terminated é final; nada volta para draft. renewal_pending ⇔ existe tarefa de renovação open (checado no COMMIT).';


--
-- Name: COLUMN contracts.notice_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.notice_days IS 'Aviso prévio em dias (0–365): prazo para pedir a não renovação ou a rescisão.';


--
-- Name: COLUMN contracts.renewal_lead_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.renewal_lead_days IS 'Antecedência, em dias antes do fim do ciclo, para abrir a tarefa de renovação (1–365).';


--
-- Name: COLUMN contracts.reminder_every_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.reminder_every_days IS 'Intervalo do lembrete no sino enquanto a renovação estiver pendente (1–30).';


--
-- Name: COLUMN contracts.readjustment_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.readjustment_index IS 'Índice de reajuste informativo: none, ipca, igpm, inpc ou other (o sistema não busca índices).';


--
-- Name: COLUMN contracts.readjustment_base_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.readjustment_base_date IS 'Data-base do reajuste (lembrete). Nula = aniversário do contrato.';


--
-- Name: COLUMN contracts.termination_penalty_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.termination_penalty_text IS 'Multa rescisória descrita (até 2000), para consulta no encerramento.';


--
-- Name: COLUMN contracts.termination_penalty_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.termination_penalty_cents IS 'Multa rescisória em valor (> 0), para consulta no encerramento.';


--
-- Name: COLUMN contracts.terminated_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.terminated_on IS 'Data de encerramento da rescisão; preenchida se e somente se status = terminated.';


--
-- Name: mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_servers (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    secret_headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret_header_names text[] GENERATED ALWAYS AS (public.mcp_header_names(secret_headers)) STORED NOT NULL,
    visibility text DEFAULT 'public'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    tools_cache jsonb,
    tools_cached_at timestamp with time zone,
    tools_error text,
    created_by_user_id uuid,
    notes text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    instructions_mode text DEFAULT 'ignore'::text NOT NULL,
    instructions_cache text,
    CONSTRAINT mcp_servers_active_check CHECK ((NOT (is_active AND (archived_at IS NOT NULL)))),
    CONSTRAINT mcp_servers_instructions_cache_check CHECK ((length(instructions_cache) <= 50000)),
    CONSTRAINT mcp_servers_instructions_mode_check CHECK ((instructions_mode = ANY (ARRAY['ignore'::text, 'system'::text, 'user'::text]))),
    CONSTRAINT mcp_servers_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT mcp_servers_secret_headers_check CHECK (public.mcp_headers_valid(secret_headers)),
    CONSTRAINT mcp_servers_tools_cache_check CHECK (((tools_cache IS NULL) OR ((jsonb_typeof(tools_cache) = 'array'::text) AND (tools_cached_at IS NOT NULL)))),
    CONSTRAINT mcp_servers_tools_error_check CHECK ((length(tools_error) <= 2000)),
    CONSTRAINT mcp_servers_url_check CHECK (((url ~ '^https?://[^[:space:]]+$'::text) AND (length(url) <= 2000))),
    CONSTRAINT mcp_servers_visibility_check CHECK ((visibility = ANY (ARRAY['global'::text, 'public'::text, 'private'::text])))
);


--
-- Name: TABLE mcp_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mcp_servers IS 'Servidores MCP remotos (Streamable HTTP, sem stdio) cadastrados pelo admin (spec 011). Os cabeçalhos são segredo: moneyflow_app grava mas não lê secret_headers.';


--
-- Name: COLUMN mcp_servers.url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.url IS 'Endpoint Streamable HTTP do servidor (http ou https).';


--
-- Name: COLUMN mcp_servers.secret_headers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.secret_headers IS 'SEGREDO: cabeçalhos HTTP enviados ao servidor (ex.: {"Authorization": "Bearer …"}). moneyflow_app grava mas NÃO lê; troca parcial por mcp_server_merge_headers; leitura só por ai_run_mcp_headers e admin_mcp_server_headers. Nunca vai para o audit_log, respostas da API, logs ou tools de agente.';


--
-- Name: COLUMN mcp_servers.secret_header_names; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.secret_header_names IS 'Nomes dos cabeçalhos configurados (sem valores), gerados pelo banco, para a tela.';


--
-- Name: COLUMN mcp_servers.visibility; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.visibility IS 'global: entra em todos os agentes sem vínculo; public: escolhível na configuração de qualquer agente; private: só nos agentes que o admin vincular. public e private só valem com linha em agent_mcp_servers.';


--
-- Name: COLUMN mcp_servers.tools_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.tools_cache IS 'Cache do resultado de tools/list (array de objetos {name, description, inputSchema, annotations…}). Nulo = nunca listado.';


--
-- Name: COLUMN mcp_servers.tools_cached_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.tools_cached_at IS 'Quando tools_cache foi atualizado.';


--
-- Name: COLUMN mcp_servers.tools_error; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.tools_error IS 'Erro da última tentativa de listar as tools (nulo = a última deu certo).';


--
-- Name: COLUMN mcp_servers.instructions_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.instructions_mode IS 'O que fazer com as instructions do servidor (spec 022): ignore (padrão; texto de terceiros), system (no prompt de sistema, sob "Instruções do servidor MCP <nome>") ou user (bloco do papel user no início do histórico enviado, nunca gravado em ai_messages).';


--
-- Name: COLUMN mcp_servers.instructions_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_servers.instructions_cache IS 'Cache das instructions da resposta do initialize (até 50 mil caracteres), atualizado junto com tools_cache pelo "Atualizar tools". Nulo = o servidor não mandou ou nunca foi listado. Atualizá-lo não gera auditoria.';


--
-- Name: effective_agent_mcp_servers; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.effective_agent_mcp_servers WITH (security_invoker='true') AS
 SELECT a.id AS agent_id,
    s.id AS mcp_server_id,
    s.name,
    s.url,
    s.visibility,
    (l.id IS NOT NULL) AS linked,
    l.enabled_tools,
        CASE
            WHEN ((s.tools_cache IS NULL) OR (l.enabled_tools IS NULL)) THEN s.tools_cache
            ELSE COALESCE(( SELECT jsonb_agg(x.t ORDER BY x.ord) AS jsonb_agg
               FROM jsonb_array_elements(s.tools_cache) WITH ORDINALITY x(t, ord)
              WHERE ((x.t ->> 'name'::text) = ANY (l.enabled_tools))), '[]'::jsonb)
        END AS tools,
    s.tools_cached_at,
    s.instructions_mode,
    s.instructions_cache
   FROM ((public.ai_agents a
     JOIN public.mcp_servers s ON ((s.is_active AND (s.archived_at IS NULL))))
     LEFT JOIN public.agent_mcp_servers l ON (((l.agent_id = a.id) AND (l.mcp_server_id = s.id))))
  WHERE ((s.visibility = 'global'::text) OR (l.id IS NOT NULL));


--
-- Name: VIEW effective_agent_mcp_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.effective_agent_mcp_servers IS 'Servidores MCP efetivos de cada agente: os global ativos (sempre) mais os public/private vinculados e ativos. tools = tools_cache filtrado por enabled_tools (NULL = todas); instructions_mode e instructions_cache do servidor (a aplicação usa o cache só fora do modo ignore). Sem os cabeçalhos.';


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    trade_name text,
    document text,
    birth_date date,
    notes text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_favorite boolean DEFAULT false NOT NULL,
    CONSTRAINT entities_birth_date_check CHECK (((birth_date IS NULL) OR (kind = 'person'::text))),
    CONSTRAINT entities_document_check CHECK (((document IS NULL) OR ((kind = 'person'::text) AND public.is_valid_cpf(document)) OR ((kind = 'company'::text) AND public.is_valid_cnpj(document)))),
    CONSTRAINT entities_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'company'::text]))),
    CONSTRAINT entities_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT entities_trade_name_check CHECK (((trade_name IS NULL) OR ((kind = 'company'::text) AND (btrim(trade_name) <> ''::text))))
);


--
-- Name: TABLE entities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entities IS 'Pessoas (CPF) e empresas (CNPJ), globais a todas as caixas.';


--
-- Name: COLUMN entities.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.name IS 'Nome da pessoa ou razão social da empresa.';


--
-- Name: COLUMN entities.trade_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.trade_name IS 'Nome fantasia (só empresa).';


--
-- Name: COLUMN entities.document; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.document IS 'CPF (person) ou CNPJ (company) NORMALIZADO: só dígitos/letras maiúsculas, sem pontuação. Opcional; único quando presente.';


--
-- Name: COLUMN entities.birth_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.birth_date IS 'Data de nascimento (só pessoa).';


--
-- Name: COLUMN entities.is_favorite; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.is_favorite IS 'Favorita (marca GLOBAL, igual para todos os usuários; spec 003). Entidade arquivada mantém a marca, mas a aba Favoritas lista só as ativas (índice parcial entities_is_favorite_idx).';


--
-- Name: entity_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_addresses (
    id uuid DEFAULT uuidv7() NOT NULL,
    entity_id uuid NOT NULL,
    label text,
    postal_code text,
    street text,
    number text,
    complement text,
    district text,
    city text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_addresses_city_check CHECK ((btrim(city) <> ''::text)),
    CONSTRAINT entity_addresses_postal_code_check CHECK ((postal_code ~ '^[0-9]{8}$'::text)),
    CONSTRAINT entity_addresses_state_check CHECK ((state = ANY (ARRAY['AC'::text, 'AL'::text, 'AP'::text, 'AM'::text, 'BA'::text, 'CE'::text, 'DF'::text, 'ES'::text, 'GO'::text, 'MA'::text, 'MT'::text, 'MS'::text, 'MG'::text, 'PA'::text, 'PB'::text, 'PR'::text, 'PE'::text, 'PI'::text, 'RJ'::text, 'RN'::text, 'RS'::text, 'RO'::text, 'RR'::text, 'SC'::text, 'SP'::text, 'SE'::text, 'TO'::text])))
);


--
-- Name: TABLE entity_addresses; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_addresses IS 'Endereços de uma entidade (autopreenchimento por CEP via ViaCEP na aplicação).';


--
-- Name: COLUMN entity_addresses.postal_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_addresses.postal_code IS 'CEP normalizado: 8 dígitos, sem traço.';


--
-- Name: COLUMN entity_addresses.street; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_addresses.street IS 'Logradouro.';


--
-- Name: COLUMN entity_addresses.district; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_addresses.district IS 'Bairro.';


--
-- Name: COLUMN entity_addresses.state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_addresses.state IS 'UF (sigla maiúscula).';


--
-- Name: entity_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_bank_accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    entity_id uuid NOT NULL,
    bank_code text,
    ispb text,
    branch text,
    account_number text NOT NULL,
    account_type text NOT NULL,
    holder_name text,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_bank_accounts_account_number_check CHECK ((account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'::text)),
    CONSTRAINT entity_bank_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['checking'::text, 'savings'::text, 'payment'::text, 'salary'::text]))),
    CONSTRAINT entity_bank_accounts_bank_check CHECK (((bank_code IS NOT NULL) OR (ispb IS NOT NULL))),
    CONSTRAINT entity_bank_accounts_bank_code_check CHECK ((bank_code ~ '^[0-9]{3}$'::text)),
    CONSTRAINT entity_bank_accounts_branch_check CHECK ((branch ~ '^[0-9]{1,6}(-[0-9A-Z])?$'::text)),
    CONSTRAINT entity_bank_accounts_ispb_check CHECK ((ispb ~ '^[0-9]{8}$'::text))
);


--
-- Name: TABLE entity_bank_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_bank_accounts IS 'Contas bancárias de uma entidade (para pagar ou receber).';


--
-- Name: COLUMN entity_bank_accounts.bank_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_bank_accounts.bank_code IS 'Código COMPE (3 dígitos). Exige bank_code ou ispb.';


--
-- Name: COLUMN entity_bank_accounts.ispb; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_bank_accounts.ispb IS 'ISPB (8 dígitos).';


--
-- Name: COLUMN entity_bank_accounts.branch; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_bank_accounts.branch IS 'Agência: dígitos e, opcionalmente, "-DV".';


--
-- Name: COLUMN entity_bank_accounts.account_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_bank_accounts.account_number IS 'Conta: dígitos e, opcionalmente, "-DV" (X maiúsculo).';


--
-- Name: entity_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_contacts (
    id uuid DEFAULT uuidv7() NOT NULL,
    entity_id uuid NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    label text,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_contacts_kind_check CHECK ((kind = ANY (ARRAY['phone'::text, 'email'::text, 'other'::text]))),
    CONSTRAINT entity_contacts_value_check CHECK (((btrim(value) <> ''::text) AND ((kind <> 'email'::text) OR (value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text))))
);


--
-- Name: TABLE entity_contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_contacts IS 'Telefones, emails e outros contatos de uma entidade.';


--
-- Name: entity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_links (
    id uuid DEFAULT uuidv7() NOT NULL,
    entity_id uuid NOT NULL,
    related_entity_id uuid NOT NULL,
    kind text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_links_kind_check CHECK ((kind = ANY (ARRAY['partner_of'::text, 'responsible_for'::text, 'spouse_of'::text, 'other'::text]))),
    CONSTRAINT entity_links_self_check CHECK ((entity_id <> related_entity_id))
);


--
-- Name: TABLE entity_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_links IS 'Vínculo direcionado: entity_id <kind> related_entity_id (ex.: A partner_of B = A é sócio de B). spouse_of é simétrico e só pode existir em um sentido.';


--
-- Name: entity_pix_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_pix_keys (
    id uuid DEFAULT uuidv7() NOT NULL,
    entity_id uuid NOT NULL,
    key_type text NOT NULL,
    key_value text NOT NULL,
    bank_code text,
    ispb text,
    label text,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_pix_keys_bank_code_check CHECK ((bank_code ~ '^[0-9]{3}$'::text)),
    CONSTRAINT entity_pix_keys_ispb_check CHECK ((ispb ~ '^[0-9]{8}$'::text)),
    CONSTRAINT entity_pix_keys_key_type_check CHECK ((key_type = ANY (ARRAY['cpf'::text, 'cnpj'::text, 'email'::text, 'phone'::text, 'evp'::text]))),
    CONSTRAINT entity_pix_keys_key_value_check CHECK (
CASE key_type
    WHEN 'cpf'::text THEN public.is_valid_cpf(key_value)
    WHEN 'cnpj'::text THEN public.is_valid_cnpj(key_value)
    WHEN 'email'::text THEN ((key_value = lower(key_value)) AND (length(key_value) <= 77) AND (key_value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text))
    WHEN 'phone'::text THEN (key_value ~ '^\+55[1-9]{2}[0-9]{8,9}$'::text)
    WHEN 'evp'::text THEN (key_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)
    ELSE NULL::boolean
END)
);


--
-- Name: TABLE entity_pix_keys; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_pix_keys IS 'Chaves PIX de uma entidade; no máximo uma principal (mostrada no título a pagar).';


--
-- Name: COLUMN entity_pix_keys.key_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_pix_keys.key_value IS 'Valor NORMALIZADO por tipo: cpf 11 dígitos; cnpj 14 caracteres [0-9A-Z]; email minúsculo (≤ 77); phone E.164 brasileiro (+55 DDD número, 8 ou 9 dígitos); evp UUID minúsculo com hífens.';


--
-- Name: COLUMN entity_pix_keys.bank_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_pix_keys.bank_code IS 'Banco (COMPE) onde a chave está registrada, opcional.';


--
-- Name: COLUMN entity_pix_keys.label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_pix_keys.label IS 'Apelido opcional.';


--
-- Name: entity_tag_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_tag_links (
    entity_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE entity_tag_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_tag_links IS 'Tags de cada entidade (sem limite, sem repetição: chave primária no par). Some com a entidade (CASCADE); a tag em uso não é apagada (RESTRICT). Auditada com record_id = entity_id.';


--
-- Name: entity_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_tags (
    id uuid DEFAULT uuidv7() NOT NULL,
    name public.citext NOT NULL,
    color_slot smallint NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_tags_color_slot_check CHECK (((color_slot >= 1) AND (color_slot <= 12))),
    CONSTRAINT entity_tags_name_check CHECK ((((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 40)) AND ((name)::text !~ '^[[:space:]]'::text) AND ((name)::text !~ '[[:space:]]$'::text)))
);


--
-- Name: TABLE entity_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_tags IS 'Catálogo global de tags de entidade (spec 003). Tag em uso não é apagada (entity_tag_links RESTRICT): é arquivada; arquivada não pode ser ligada de novo (entity_tag_links_tag_active_check), mas as ligações existentes ficam.';


--
-- Name: COLUMN entity_tags.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_tags.name IS 'Nome: 1 a 40 caracteres, sem espaço nas pontas; único sem distinção de maiúsculas, arquivadas inclusive (entity_tags_name_key).';


--
-- Name: COLUMN entity_tags.color_slot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_tags.color_slot IS 'Cor obrigatória: slot 1–12 do design system (token --port-N).';


--
-- Name: COLUMN entity_tags.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_tags.archived_at IS 'Arquivada (nulo = ativa): sai do seletor e do filtro.';


--
-- Name: financial_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    bank_code text,
    ispb text,
    branch text,
    account_number text,
    opening_balance_cents bigint DEFAULT 0 NOT NULL,
    opening_date date NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT financial_accounts_account_number_check CHECK ((account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'::text)),
    CONSTRAINT financial_accounts_bank_code_check CHECK ((bank_code ~ '^[0-9]{3}$'::text)),
    CONSTRAINT financial_accounts_bank_fields_check CHECK (((kind = ANY (ARRAY['checking'::text, 'savings'::text])) OR ((bank_code IS NULL) AND (ispb IS NULL) AND (branch IS NULL) AND (account_number IS NULL)))),
    CONSTRAINT financial_accounts_branch_check CHECK ((branch ~ '^[0-9]{1,6}(-[0-9A-Z])?$'::text)),
    CONSTRAINT financial_accounts_cash_balance_check CHECK (((kind <> 'cash'::text) OR (opening_balance_cents >= 0))),
    CONSTRAINT financial_accounts_ispb_check CHECK ((ispb ~ '^[0-9]{8}$'::text)),
    CONSTRAINT financial_accounts_kind_check CHECK ((kind = ANY (ARRAY['checking'::text, 'cash'::text, 'savings'::text]))),
    CONSTRAINT financial_accounts_name_check CHECK ((btrim(name) <> ''::text))
);


--
-- Name: TABLE financial_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.financial_accounts IS 'Contas de uma caixa general: corrente/pagamento, cofre (dinheiro) ou poupança/investimento.';


--
-- Name: COLUMN financial_accounts.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.financial_accounts.kind IS 'checking (corrente/pagamento), cash (cofre/espécie) ou savings (poupança/investimento).';


--
-- Name: COLUMN financial_accounts.bank_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.financial_accounts.bank_code IS 'COMPE (3 dígitos); dados bancários só em checking/savings.';


--
-- Name: COLUMN financial_accounts.opening_balance_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.financial_accounts.opening_balance_cents IS 'Saldo inicial em centavos na opening_date (cash não pode ser negativo).';


--
-- Name: movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movements (
    id uuid DEFAULT uuidv7() NOT NULL,
    financial_account_id uuid NOT NULL,
    occurred_on date NOT NULL,
    amount_cents bigint NOT NULL,
    kind text NOT NULL,
    settlement_id uuid,
    transfer_id uuid,
    description text,
    entity_id uuid,
    category_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT movements_amount_cents_check CHECK ((amount_cents <> 0)),
    CONSTRAINT movements_kind_check CHECK ((kind = ANY (ARRAY['settlement'::text, 'transfer'::text, 'adjustment'::text]))),
    CONSTRAINT movements_kind_links_check CHECK (
CASE kind
    WHEN 'settlement'::text THEN ((settlement_id IS NOT NULL) AND (transfer_id IS NULL) AND (category_id IS NULL))
    WHEN 'transfer'::text THEN ((transfer_id IS NOT NULL) AND (settlement_id IS NULL) AND (category_id IS NULL))
    WHEN 'adjustment'::text THEN ((settlement_id IS NULL) AND (transfer_id IS NULL))
    ELSE NULL::boolean
END)
);


--
-- Name: TABLE movements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.movements IS 'Entradas (+) e saídas (−) numa conta financeira: de baixa, de transferência ou ajuste/avulso. Saldo da conta = opening_balance_cents + soma dos movimentos.';


--
-- Name: COLUMN movements.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movements.amount_cents IS 'Valor assinado em centavos: positivo entra, negativo sai (≠ 0).';


--
-- Name: COLUMN movements.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movements.kind IS 'settlement (ligado a settlement_id), transfer (ligado a transfer_id) ou adjustment (ajuste de contagem, rendimento, tarifa avulsa…).';


--
-- Name: COLUMN movements.category_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.movements.category_id IS 'Só em adjustment (opcional): categoria income se entra, expense se sai. Baixas usam a categoria do título.';


--
-- Name: financial_account_balances; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.financial_account_balances WITH (security_invoker='true') AS
 SELECT a.id AS financial_account_id,
    a.caixa_id,
    a.opening_date,
    a.opening_balance_cents,
    (COALESCE(m.movements_cents, (0)::numeric))::bigint AS movements_cents,
    (((a.opening_balance_cents)::numeric + COALESCE(m.movements_cents, (0)::numeric)))::bigint AS balance_cents,
    a.archived_at
   FROM (public.financial_accounts a
     LEFT JOIN LATERAL ( SELECT sum(x.amount_cents) AS movements_cents
           FROM public.movements x
          WHERE (x.financial_account_id = a.id)) m ON (true));


--
-- Name: VIEW financial_account_balances; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.financial_account_balances IS 'Saldo de cada conta: opening_balance_cents + soma de todos os movimentos (inclusive datados no futuro). Saldo numa data: financial_account_balance_at(conta, data).';


--
-- Name: message_destinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_destinations (
    id uuid DEFAULT uuidv7() NOT NULL,
    channel text DEFAULT 'telegram'::text NOT NULL,
    name text NOT NULL,
    owner_user_id uuid,
    owner_caixa_id uuid,
    bot_token text,
    bot_id text GENERATED ALWAYS AS (split_part(bot_token, ':'::text, 1)) STORED,
    chat_id text,
    is_active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    notes text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_destinations_active_check CHECK ((NOT (is_active AND (archived_at IS NOT NULL)))),
    CONSTRAINT message_destinations_bot_token_check CHECK ((bot_token ~ '^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$'::text)),
    CONSTRAINT message_destinations_channel_check CHECK ((channel = 'telegram'::text)),
    CONSTRAINT message_destinations_chat_id_check CHECK (((chat_id ~ '^-?[0-9]{1,20}$'::text) OR (chat_id ~ '^@[A-Za-z][A-Za-z0-9_]{3,31}$'::text))),
    CONSTRAINT message_destinations_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT message_destinations_owner_check CHECK ((num_nonnulls(owner_user_id, owner_caixa_id) <= 1)),
    CONSTRAINT message_destinations_telegram_check CHECK (((channel <> 'telegram'::text) OR ((bot_token IS NOT NULL) AND (chat_id IS NOT NULL))))
);


--
-- Name: TABLE message_destinations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_destinations IS 'Cadastro central de destinos de mensagens (spec 013). Dono: um usuário (pessoal), uma caixa (ex.: grupo da casa) ou nenhum (global, gerido pelo admin). O canal é abstrato; por ora só telegram (bot_token + chat_id).';


--
-- Name: COLUMN message_destinations.channel; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.channel IS 'Canal: telegram (email/whatsapp no futuro, com as próprias colunas).';


--
-- Name: COLUMN message_destinations.owner_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.owner_user_id IS 'Destino pessoal deste usuário. Nulo junto com owner_caixa_id = global (admin).';


--
-- Name: COLUMN message_destinations.owner_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.owner_caixa_id IS 'Destino da caixa (ex.: grupo da casa).';


--
-- Name: COLUMN message_destinations.bot_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.bot_token IS 'SEGREDO: token do bot do Telegram (<id>:<chave>). moneyflow_app grava mas NÃO lê esta coluna; o worker lê pela função message_destination_token(message_id). Nunca vai para o audit_log, respostas da API, logs ou tools de agente.';


--
-- Name: COLUMN message_destinations.bot_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.bot_id IS 'Parte pública do token (id numérico do bot), gerada pelo banco: identifica o bot na tela sem expor o segredo.';


--
-- Name: COLUMN message_destinations.chat_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.chat_id IS 'chat_id do Telegram (pessoa ou grupo, numérico, grupos negativos) ou @canal.';


--
-- Name: COLUMN message_destinations.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.is_active IS 'false = não recebe mensagens novas; as pendentes são canceladas na hora.';


--
-- Name: message_subscription_caixas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_subscription_caixas (
    id uuid DEFAULT uuidv7() NOT NULL,
    subscription_id uuid NOT NULL,
    caixa_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE message_subscription_caixas; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_subscription_caixas IS 'Filtro opcional de caixas de uma assinatura (nenhuma linha = sem filtro).';


--
-- Name: message_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_subscriptions (
    id uuid DEFAULT uuidv7() NOT NULL,
    destination_id uuid NOT NULL,
    event_kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_subscriptions_event_kind_check CHECK ((event_kind = ANY (ARRAY['due_reminder'::text, 'overdue'::text, 'daily_summary'::text, 'weekly_summary'::text, 'invoice_closed'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'agent_completed'::text, 'agent_message'::text, 'contract_notice_deadline'::text, 'contract_ending'::text, 'contract_renewal_pending'::text, 'contract_readjustment'::text]))),
    CONSTRAINT message_subscriptions_params_check CHECK (public.message_subscription_params_valid(event_kind, params))
);


--
-- Name: TABLE message_subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_subscriptions IS 'Eventos que um destino recebe (spec 013), um por tipo de evento, com parâmetros validados por message_subscription_params_valid. Filtro opcional por caixas em message_subscription_caixas (sem linhas = todas as caixas que o dono do destino vê).';


--
-- Name: COLUMN message_subscriptions.event_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_subscriptions.event_kind IS 'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos (spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base).';


--
-- Name: COLUMN message_subscriptions.params; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_subscriptions.params IS 'Parâmetros do evento (ver message_subscription_params_valid).';


--
-- Name: nfe_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nfe_items (
    id uuid DEFAULT uuidv7() NOT NULL,
    nfe_document_id uuid NOT NULL,
    item_number smallint NOT NULL,
    product_code text,
    description text NOT NULL,
    ncm text,
    cfop text,
    unit text,
    quantity numeric(15,4) NOT NULL,
    unit_price_cents numeric(23,8) NOT NULL,
    total_cents bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT nfe_items_amounts_check CHECK (((unit_price_cents >= (0)::numeric) AND (total_cents >= 0))),
    CONSTRAINT nfe_items_cfop_check CHECK ((cfop ~ '^[1-7][0-9]{3}$'::text)),
    CONSTRAINT nfe_items_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT nfe_items_item_number_check CHECK (((item_number >= 1) AND (item_number <= 990))),
    CONSTRAINT nfe_items_ncm_check CHECK ((ncm ~ '^[0-9]{2}([0-9]{6})?$'::text)),
    CONSTRAINT nfe_items_quantity_check CHECK ((quantity > (0)::numeric))
);


--
-- Name: TABLE nfe_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.nfe_items IS 'Itens (det/prod) de uma NF-e importada. Opcionais: a nota pode ser guardada sem itens.';


--
-- Name: COLUMN nfe_items.unit_price_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_items.unit_price_cents IS 'Valor unitário (vUnCom) em centavos, com casas decimais (a NF-e admite até 10).';


--
-- Name: COLUMN nfe_items.total_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nfe_items.total_cents IS 'Valor do item (vProd), em centavos.';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    link text,
    caixa_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedup_key text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_data_check CHECK ((jsonb_typeof(data) = 'object'::text)),
    CONSTRAINT notifications_dedup_key_check CHECK (((btrim(dedup_key) <> ''::text) AND (length(dedup_key) <= 300))),
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['agent_completed'::text, 'agent_message'::text, 'mirror_pending'::text, 'mirror_disputed'::text, 'invoice_closed'::text, 'due_reminder'::text, 'overdue'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'message_failed'::text, 'system'::text, 'contract_notice_deadline'::text, 'contract_ending'::text, 'contract_renewal_pending'::text, 'contract_readjustment'::text]))),
    CONSTRAINT notifications_link_check CHECK (((link ~ '^/[^/]'::text) OR (link = '/'::text))),
    CONSTRAINT notifications_title_check CHECK (((btrim(title) <> ''::text) AND (length(title) <= 200)))
);


--
-- Name: TABLE notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notifications IS 'Notificações do sino, por usuário. Estado de interface: fora da auditoria. Contador de não lidas: count(*) WHERE read_at IS NULL (índice parcial). Criar com ON CONFLICT (user_id, dedup_key) DO NOTHING quando o evento puder repetir.';


--
-- Name: COLUMN notifications.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.kind IS 'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, contract_renewal_pending ou contract_readjustment.';


--
-- Name: COLUMN notifications.link; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.link IS 'Caminho relativo do console (começa com "/"), ex.: /titles/<id>. Nunca URL externa.';


--
-- Name: COLUMN notifications.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.data IS 'Dados extras para a tela (ids, valores). Nunca senha nem token.';


--
-- Name: COLUMN notifications.dedup_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.dedup_key IS 'Chave do evento, única por usuário (nulo = sem dedup).';


--
-- Name: COLUMN notifications.read_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.read_at IS 'Quando foi lida (nulo = não lida).';


--
-- Name: period_closings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.period_closings (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid NOT NULL,
    month date NOT NULL,
    closed_by_user_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT period_closings_month_check CHECK ((month = (date_trunc('month'::text, (month)::timestamp with time zone))::date))
);


--
-- Name: TABLE period_closings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.period_closings IS 'Meses fechados por caixa (spec 008). Bloqueia títulos (competência), baixas, movimentos e compras do mês; reabrir é apagar a linha, só por admin ativo (app.user_id).';


--
-- Name: COLUMN period_closings.month; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.period_closings.month IS '1º dia do mês fechado.';


--
-- Name: COLUMN period_closings.closed_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.period_closings.closed_by_user_id IS 'Quem fechou.';


--
-- Name: recurrence_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurrence_rules (
    id uuid DEFAULT uuidv7() NOT NULL,
    frequency text NOT NULL,
    interval_count smallint DEFAULT 1 NOT NULL,
    anchor_day smallint NOT NULL,
    starts_on date NOT NULL,
    ends_on date,
    installments_total smallint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recurrence_rules_anchor_day_check CHECK (
CASE frequency
    WHEN 'weekly'::text THEN ((anchor_day >= 1) AND (anchor_day <= 7))
    ELSE ((anchor_day >= 1) AND (anchor_day <= 31))
END),
    CONSTRAINT recurrence_rules_end_check CHECK (((ends_on IS NULL) OR (installments_total IS NULL))),
    CONSTRAINT recurrence_rules_ends_on_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT recurrence_rules_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT recurrence_rules_installments_total_check CHECK (((installments_total >= 2) AND (installments_total <= 999))),
    CONSTRAINT recurrence_rules_interval_count_check CHECK (((interval_count >= 1) AND (interval_count <= 366)))
);


--
-- Name: TABLE recurrence_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recurrence_rules IS 'Calendário de uma série de títulos (recorrência ou parcelamento). Os títulos apontam para a regra com titles.occurrence; o worker materializa até 12 meses à frente (spec 005).';


--
-- Name: COLUMN recurrence_rules.frequency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.frequency IS 'weekly, monthly ou yearly.';


--
-- Name: COLUMN recurrence_rules.interval_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.interval_count IS 'A cada N períodos (1 = todo período; 2 = quinzenal/bimestral…).';


--
-- Name: COLUMN recurrence_rules.anchor_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.anchor_day IS 'weekly: dia da semana ISO (1 = segunda … 7 = domingo). monthly/yearly: dia do mês (1–31; em meses curtos a aplicação usa o último dia). yearly usa o mês de starts_on.';


--
-- Name: COLUMN recurrence_rules.starts_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.starts_on IS 'Data de referência da primeira ocorrência.';


--
-- Name: COLUMN recurrence_rules.ends_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.ends_on IS 'Recorrência: última data possível (nulo = sem fim). Exclusivo com installments_total.';


--
-- Name: COLUMN recurrence_rules.installments_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.installments_total IS 'Parcelamento: total de parcelas N (2–999). Exclusivo com ends_on.';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    ip inet,
    user_agent text,
    CONSTRAINT sessions_expires_at_check CHECK ((expires_at > created_at)),
    CONSTRAINT sessions_id_check CHECK (((length(id) >= 32) AND (length(id) <= 128)))
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sessions IS 'Sessões de login (cookie httpOnly). Não tem updated_at: a única mutação é last_seen_at.';


--
-- Name: COLUMN sessions.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.id IS 'Identificador opaco gerado pela aplicação (32 a 128 caracteres; ex.: hash SHA-256 em hex do token do cookie).';


--
-- Name: statement_csv_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_csv_mappings (
    id uuid DEFAULT uuidv7() NOT NULL,
    financial_account_id uuid,
    card_caixa_id uuid,
    name text NOT NULL,
    delimiter text DEFAULT ';'::text NOT NULL,
    encoding text DEFAULT 'utf-8'::text NOT NULL,
    has_header boolean DEFAULT true NOT NULL,
    skip_rows smallint DEFAULT 0 NOT NULL,
    date_format text DEFAULT 'dd/MM/yyyy'::text NOT NULL,
    decimal_separator text DEFAULT ','::text NOT NULL,
    columns jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT statement_csv_mappings_columns_check CHECK (((jsonb_typeof(columns) = 'object'::text) AND (columns ? 'date'::text) AND (columns ? 'description'::text) AND ((columns ? 'amount'::text) OR ((columns ? 'debit'::text) AND (columns ? 'credit'::text))))),
    CONSTRAINT statement_csv_mappings_date_format_check CHECK ((btrim(date_format) <> ''::text)),
    CONSTRAINT statement_csv_mappings_decimal_separator_check CHECK ((decimal_separator = ANY (ARRAY[','::text, '.'::text]))),
    CONSTRAINT statement_csv_mappings_delimiter_check CHECK ((delimiter = ANY (ARRAY[','::text, ';'::text, '	'::text, '|'::text]))),
    CONSTRAINT statement_csv_mappings_encoding_check CHECK ((encoding = ANY (ARRAY['utf-8'::text, 'latin1'::text, 'windows-1252'::text]))),
    CONSTRAINT statement_csv_mappings_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT statement_csv_mappings_skip_rows_check CHECK (((skip_rows >= 0) AND (skip_rows <= 100))),
    CONSTRAINT statement_csv_mappings_target_check CHECK ((num_nonnulls(financial_account_id, card_caixa_id) = 1))
);


--
-- Name: TABLE statement_csv_mappings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.statement_csv_mappings IS 'Mapeamento de colunas de CSV salvo por conta (ou por cartão, para fatura). No máximo um padrão por destino.';


--
-- Name: COLUMN statement_csv_mappings.date_format; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_csv_mappings.date_format IS 'Formato da data no arquivo (padrão date-fns, ex.: dd/MM/yyyy).';


--
-- Name: COLUMN statement_csv_mappings.columns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_csv_mappings.columns IS 'Objeto JSON: chave = campo (date, description, amount OU debit+credit; opcionais fitid, balance, document), valor = índice (0-based) ou nome da coluna no cabeçalho. Interpretado pela aplicação.';


--
-- Name: statement_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_lines (
    id uuid DEFAULT uuidv7() NOT NULL,
    statement_import_id uuid NOT NULL,
    financial_account_id uuid,
    card_caixa_id uuid,
    line_number integer NOT NULL,
    posted_on date NOT NULL,
    amount_cents bigint NOT NULL,
    description text NOT NULL,
    fitid text,
    dedup_hash text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    movement_id uuid,
    title_id uuid,
    card_invoice_item_id uuid,
    entity_id uuid,
    category_id uuid,
    classification_rule_id uuid,
    classification_source text,
    raw jsonb,
    matched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT statement_lines_amount_cents_check CHECK ((amount_cents <> 0)),
    CONSTRAINT statement_lines_classification_source_check CHECK (((classification_source = ANY (ARRAY['rule'::text, 'agent'::text, 'user'::text])) AND ((classification_rule_id IS NULL) OR (NOT (classification_source IS DISTINCT FROM 'rule'::text))))),
    CONSTRAINT statement_lines_dedup_hash_check CHECK (((btrim(dedup_hash) <> ''::text) AND (length(dedup_hash) <= 200))),
    CONSTRAINT statement_lines_line_number_check CHECK ((line_number >= 1)),
    CONSTRAINT statement_lines_links_check CHECK ((((movement_id IS NULL) OR (financial_account_id IS NOT NULL)) AND ((title_id IS NULL) OR (financial_account_id IS NOT NULL)) AND ((card_invoice_item_id IS NULL) OR (card_caixa_id IS NOT NULL)) AND
CASE status
    WHEN 'matched'::text THEN ((num_nonnulls(movement_id, card_invoice_item_id) = 1) AND (title_id IS NULL))
    WHEN 'suggested'::text THEN (num_nonnulls(movement_id, title_id, card_invoice_item_id) = 1)
    ELSE (num_nonnulls(movement_id, title_id, card_invoice_item_id) = 0)
END AND ((status = 'matched'::text) = (matched_at IS NOT NULL)))),
    CONSTRAINT statement_lines_raw_check CHECK ((jsonb_typeof(raw) = 'object'::text)),
    CONSTRAINT statement_lines_status_check CHECK ((status = ANY (ARRAY['matched'::text, 'suggested'::text, 'new'::text, 'ignored'::text]))),
    CONSTRAINT statement_lines_target_check CHECK ((num_nonnulls(financial_account_id, card_caixa_id) = 1))
);


--
-- Name: TABLE statement_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.statement_lines IS 'Linhas de um extrato importado (spec 009), deduplicadas por conta (ou cartão) via dedup_hash. matched = conciliada (movimento ou item de fatura), suggested = casamento proposto aguardando confirmação, new = sem par (vira baixa ou movimento avulso), ignored = descartada.';


--
-- Name: COLUMN statement_lines.financial_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.financial_account_id IS 'Conta do lote (repetida aqui para a deduplicação por conta).';


--
-- Name: COLUMN statement_lines.card_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.card_caixa_id IS 'Cartão do lote (import de fatura).';


--
-- Name: COLUMN statement_lines.line_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.line_number IS 'Posição da linha no arquivo (1-based).';


--
-- Name: COLUMN statement_lines.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.amount_cents IS 'Valor assinado do ponto de vista do titular: + entra, − sai. Na fatura do cartão: compra/encargo −, estorno/crédito +.';


--
-- Name: COLUMN statement_lines.fitid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.fitid IS 'FITID do OFX, quando houver.';


--
-- Name: COLUMN statement_lines.dedup_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.dedup_hash IS 'Chave de deduplicação calculada pela aplicação, única por conta/cartão: ''fitid:'' || FITID quando houver; senão o SHA-256 hex de data|valor|descrição normalizada|ordem entre linhas idênticas do mesmo dia.';


--
-- Name: COLUMN statement_lines.movement_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.movement_id IS 'matched: movimento conciliado (mesma conta e valor); suggested: movimento proposto.';


--
-- Name: COLUMN statement_lines.title_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.title_id IS 'suggested: título em aberto proposto para baixa com esta linha.';


--
-- Name: COLUMN statement_lines.card_invoice_item_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.card_invoice_item_id IS 'Fatura de cartão: item (parcela) conciliado/proposto; valor = −amount_cents do item.';


--
-- Name: COLUMN statement_lines.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.entity_id IS 'Entidade sugerida/escolhida para criar o lançamento de uma linha nova.';


--
-- Name: COLUMN statement_lines.category_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.category_id IS 'Categoria sugerida/escolhida (income se entra, expense se sai; no cartão sempre expense).';


--
-- Name: COLUMN statement_lines.classification_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.classification_source IS 'De onde veio entity/category: rule (classification_rule_id), agent (pendente de aprovação) ou user.';


--
-- Name: COLUMN statement_lines.raw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.raw IS 'Campos originais da linha no arquivo (objeto JSON), para auditoria e reprocessamento.';


--
-- Name: COLUMN statement_lines.matched_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.matched_at IS 'Quando a linha foi conciliada (obrigatório se e somente se matched).';


--
-- Name: statement_import_balances; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.statement_import_balances WITH (security_invoker='true') AS
 SELECT i.id AS statement_import_id,
    i.financial_account_id,
    i.card_caixa_id,
    i.period_start,
    i.period_end,
    i.bank_balance_on,
    i.bank_balance_cents,
        CASE
            WHEN ((i.financial_account_id IS NOT NULL) AND (i.bank_balance_on IS NOT NULL)) THEN public.financial_account_balance_at(i.financial_account_id, i.bank_balance_on)
            ELSE NULL::bigint
        END AS app_balance_cents,
        CASE
            WHEN ((i.financial_account_id IS NOT NULL) AND (i.bank_balance_on IS NOT NULL)) THEN (i.bank_balance_cents - public.financial_account_balance_at(i.financial_account_id, i.bank_balance_on))
            ELSE NULL::bigint
        END AS difference_cents,
    (COALESCE(c.lines, (0)::bigint))::integer AS lines,
    (COALESCE(c.matched, (0)::bigint))::integer AS matched_lines,
    (COALESCE(c.suggested, (0)::bigint))::integer AS suggested_lines,
    (COALESCE(c.new, (0)::bigint))::integer AS new_lines,
    (COALESCE(c.ignored, (0)::bigint))::integer AS ignored_lines
   FROM (public.statement_imports i
     LEFT JOIN LATERAL ( SELECT count(*) AS lines,
            count(*) FILTER (WHERE (l.status = 'matched'::text)) AS matched,
            count(*) FILTER (WHERE (l.status = 'suggested'::text)) AS suggested,
            count(*) FILTER (WHERE (l.status = 'new'::text)) AS new,
            count(*) FILTER (WHERE (l.status = 'ignored'::text)) AS ignored
           FROM public.statement_lines l
          WHERE (l.statement_import_id = i.id)) c ON (true));


--
-- Name: VIEW statement_import_balances; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.statement_import_balances IS 'Por lote: saldo informado pelo banco × saldo do app na mesma data (difference_cents = banco − app; 0 = sem divergência) e contagem de linhas por status. Saldo só para contas (não para cartão).';


--
-- Name: transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfers (
    id uuid DEFAULT uuidv7() NOT NULL,
    from_account_id uuid NOT NULL,
    to_account_id uuid NOT NULL,
    amount_cents bigint NOT NULL,
    transferred_on date NOT NULL,
    description text,
    settlement_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transfers_accounts_check CHECK ((from_account_id <> to_account_id)),
    CONSTRAINT transfers_amount_cents_check CHECK ((amount_cents > 0))
);


--
-- Name: TABLE transfers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transfers IS 'Transferência entre contas (inclusive de caixas diferentes): exatamente dois movimentos ligados que somam zero. Não conta como receita nem despesa.';


--
-- Name: COLUMN transfers.settlement_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transfers.settlement_id IS 'Baixa que originou a transferência ("pagar título da caixa B com conta da caixa A"): a perna na conta da baixa (destino se o título é payable, origem se receivable) e o valor = valor em dinheiro da baixa.';


--
-- Name: user_ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_ai_settings (
    user_id uuid NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    primary_caixa_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_ai_settings_instructions_check CHECK ((length(instructions) <= 20000))
);


--
-- Name: TABLE user_ai_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_ai_settings IS 'Configurações de IA de cada usuário (spec 022, Minha conta → IA): instruções para todos os agentes e a caixa principal escolhida. Só o próprio usuário edita; o admin lê (regra da aplicação). Some com o usuário.';


--
-- Name: COLUMN user_ai_settings.instructions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_ai_settings.instructions IS 'Instruções do usuário (até 20 mil caracteres; vazio = nenhuma). Entram no prompt das conversas, nunca nas de fluxo.';


--
-- Name: COLUMN user_ai_settings.primary_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_ai_settings.primary_caixa_id IS 'Minha caixa principal: uma caixa general (user_ai_settings_primary_caixa_check). Alimenta o contexto automático e as variáveis {{usuario.caixa_principal}}/{{empresa.titular_principal}}. Que o usuário a lê é checado pela aplicação. Caixa excluída = nulo.';


--
-- Name: user_api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_api_tokens (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    last_used_ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_api_tokens_expires_at_check CHECK ((expires_at > created_at)),
    CONSTRAINT user_api_tokens_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT user_api_tokens_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT user_api_tokens_token_prefix_check CHECK ((token_prefix ~ '^[A-Za-z0-9_-]{4,16}$'::text))
);


--
-- Name: TABLE user_api_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_api_tokens IS 'Tokens pessoais de API (spec 011: autenticação do servidor MCP próprio /mcp, com as permissões do dono). Só o hash é guardado. Revogar = revoked_at (irreversível); usuário desativado não autentica.';


--
-- Name: COLUMN user_api_tokens.token_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_api_tokens.token_hash IS 'SHA-256 (hex minúsculo) do token inteiro. moneyflow_app grava mas NÃO lê esta coluna: autentique com api_token_authenticate(hash). Nunca vai para o audit_log.';


--
-- Name: COLUMN user_api_tokens.token_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_api_tokens.token_prefix IS 'Começo do token (4–16 caracteres, ex.: mf_3k9X), para o usuário reconhecer qual é.';


--
-- Name: COLUMN user_api_tokens.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_api_tokens.expires_at IS 'Expiração (nula = não expira).';


--
-- Name: COLUMN user_api_tokens.revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_api_tokens.revoked_at IS 'Revogado em (irreversível; nulo = válido).';


--
-- Name: COLUMN user_api_tokens.last_used_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_api_tokens.last_used_at IS 'Último uso (atualizado pela autenticação no máximo uma vez por minuto).';


--
-- Name: COLUMN user_api_tokens.last_used_ip; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_api_tokens.last_used_ip IS 'IP do último uso.';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT uuidv7() NOT NULL,
    username public.citext NOT NULL,
    email public.citext NOT NULL,
    password text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_email_format_check CHECK (((email OPERATOR(public.~) '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::public.citext) AND (length((email)::text) <= 254))),
    CONSTRAINT users_password_check CHECK ((password <> ''::text)),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT users_username_format_check CHECK ((username OPERATOR(public.~) '^[^@[:space:]]{3,64}$'::public.citext))
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS 'Usuários do sistema (spec 002).';


--
-- Name: COLUMN users.username; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.username IS 'Login; sem distinção de maiúsculas; não pode conter @ nem espaços.';


--
-- Name: COLUMN users.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.email IS 'Login alternativo; sem distinção de maiúsculas.';


--
-- Name: COLUMN users.password; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.password IS 'Senha em TEXTO PURO por decisão do produto (spec 002). moneyflow_app não tem SELECT nesta coluna: use auth_login() para autenticar e admin_reveal_password() para revelar.';


--
-- Name: COLUMN users.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.role IS 'Papel global: admin (todos os poderes) ou user.';


--
-- Name: COLUMN users.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.is_active IS 'false = desativado: não autentica e as sessões são apagadas na hora.';


--
-- Name: agent_mcp_servers agent_mcp_servers_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_key UNIQUE (agent_id, mcp_server_id);


--
-- Name: agent_mcp_servers agent_mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_inferences ai_agent_inferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_inferences
    ADD CONSTRAINT ai_agent_inferences_pkey PRIMARY KEY (agent_id, capability);


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_agent_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_prompt_versions
    ADD CONSTRAINT ai_agent_prompt_versions_agent_version_key UNIQUE (agent_id, version);


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_id_agent_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_prompt_versions
    ADD CONSTRAINT ai_agent_prompt_versions_id_agent_key UNIQUE (id, agent_id);


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_prompt_versions
    ADD CONSTRAINT ai_agent_prompt_versions_pkey PRIMARY KEY (id);


--
-- Name: ai_agents ai_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agents
    ADD CONSTRAINT ai_agents_pkey PRIMARY KEY (id);


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_key UNIQUE NULLS NOT DISTINCT (attachment_id, message_id, block_index, kind, provider_id, model, voice);


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_embedding_indexes ai_embedding_indexes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embedding_indexes
    ADD CONSTRAINT ai_embedding_indexes_pkey PRIMARY KEY (provider_id, model);


--
-- Name: ai_embeddings ai_embeddings_object_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embeddings
    ADD CONSTRAINT ai_embeddings_object_key UNIQUE (object_type, object_id, provider_id, model);


--
-- Name: ai_embeddings ai_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embeddings
    ADD CONSTRAINT ai_embeddings_pkey PRIMARY KEY (id);


--
-- Name: ai_message_attachments ai_message_attachments_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_message_attachments
    ADD CONSTRAINT ai_message_attachments_key UNIQUE (message_id, attachment_id);


--
-- Name: ai_message_attachments ai_message_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_message_attachments
    ADD CONSTRAINT ai_message_attachments_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_conversation_id_key UNIQUE (conversation_id, id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_seq_key UNIQUE (conversation_id, seq);


--
-- Name: ai_model_prices ai_model_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_prices
    ADD CONSTRAINT ai_model_prices_pkey PRIMARY KEY (id);


--
-- Name: ai_model_prices ai_model_prices_valid_from_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_prices
    ADD CONSTRAINT ai_model_prices_valid_from_key UNIQUE (provider_id, model, valid_from);


--
-- Name: ai_providers ai_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_providers
    ADD CONSTRAINT ai_providers_pkey PRIMARY KEY (id);


--
-- Name: ai_request_attempts ai_request_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_request_attempts
    ADD CONSTRAINT ai_request_attempts_pkey PRIMARY KEY (request_id, attempt);


--
-- Name: ai_requests ai_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_pkey PRIMARY KEY (id);


--
-- Name: ai_run_events ai_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_run_events
    ADD CONSTRAINT ai_run_events_pkey PRIMARY KEY (id);


--
-- Name: ai_run_events ai_run_events_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_run_events
    ADD CONSTRAINT ai_run_events_seq_key UNIQUE (run_id, seq);


--
-- Name: ai_runs ai_runs_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_conversation_id_key UNIQUE (conversation_id, id);


--
-- Name: ai_runs ai_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_pkey PRIMARY KEY (id);


--
-- Name: ai_tool_confirmations ai_tool_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_confirmations
    ADD CONSTRAINT ai_tool_confirmations_pkey PRIMARY KEY (id);


--
-- Name: ai_tool_confirmations ai_tool_confirmations_tool_use_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_confirmations
    ADD CONSTRAINT ai_tool_confirmations_tool_use_key UNIQUE (run_id, tool_use_id);


--
-- Name: ai_tool_kit_tools ai_tool_kit_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_kit_tools
    ADD CONSTRAINT ai_tool_kit_tools_pkey PRIMARY KEY (kit_id, tool_name);


--
-- Name: ai_tool_kits ai_tool_kits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_kits
    ADD CONSTRAINT ai_tool_kits_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: caixa_hidden_categories caixa_hidden_categories_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_hidden_categories
    ADD CONSTRAINT caixa_hidden_categories_key UNIQUE (caixa_id, category_id);


--
-- Name: caixa_hidden_categories caixa_hidden_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_hidden_categories
    ADD CONSTRAINT caixa_hidden_categories_pkey PRIMARY KEY (id);


--
-- Name: caixa_members caixa_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_members
    ADD CONSTRAINT caixa_members_pkey PRIMARY KEY (id);


--
-- Name: caixa_members caixa_members_user_caixa_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_members
    ADD CONSTRAINT caixa_members_user_caixa_key UNIQUE (user_id, caixa_id);


--
-- Name: caixas caixas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixas
    ADD CONSTRAINT caixas_pkey PRIMARY KEY (id);


--
-- Name: canvas_node_positions canvas_node_positions_node_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_node_positions
    ADD CONSTRAINT canvas_node_positions_node_key UNIQUE (user_id, layout, node_kind, node_id);


--
-- Name: canvas_node_positions canvas_node_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_node_positions
    ADD CONSTRAINT canvas_node_positions_pkey PRIMARY KEY (id);


--
-- Name: card_invoice_items card_invoice_items_carryover_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_carryover_key UNIQUE (carried_from_invoice_id, payer_caixa_id);


--
-- Name: card_invoice_items card_invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_pkey PRIMARY KEY (id);


--
-- Name: card_invoice_items card_invoice_items_purchase_installment_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_purchase_installment_key UNIQUE (card_purchase_id, installment_number);


--
-- Name: card_invoices card_invoices_card_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoices
    ADD CONSTRAINT card_invoices_card_month_key UNIQUE (card_caixa_id, reference_month);


--
-- Name: card_invoices card_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoices
    ADD CONSTRAINT card_invoices_pkey PRIMARY KEY (id);


--
-- Name: card_purchase_attachments card_purchase_attachments_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchase_attachments
    ADD CONSTRAINT card_purchase_attachments_key UNIQUE (card_purchase_id, attachment_id);


--
-- Name: card_purchase_attachments card_purchase_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchase_attachments
    ADD CONSTRAINT card_purchase_attachments_pkey PRIMARY KEY (id);


--
-- Name: card_purchases card_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: classification_rules classification_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_pkey PRIMARY KEY (id);


--
-- Name: contract_amendments contract_amendments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_amendments
    ADD CONSTRAINT contract_amendments_pkey PRIMARY KEY (id);


--
-- Name: contract_cycles contract_cycles_contract_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_cycles
    ADD CONSTRAINT contract_cycles_contract_seq_key UNIQUE (contract_id, seq);


--
-- Name: contract_cycles contract_cycles_id_contract_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_cycles
    ADD CONSTRAINT contract_cycles_id_contract_key UNIQUE (id, contract_id);


--
-- Name: contract_cycles contract_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_cycles
    ADD CONSTRAINT contract_cycles_pkey PRIMARY KEY (id);


--
-- Name: contract_document_versions contract_document_versions_document_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_document_version_key UNIQUE (document_id, version);


--
-- Name: contract_document_versions contract_document_versions_id_document_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_id_document_key UNIQUE (id, document_id);


--
-- Name: contract_document_versions contract_document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_pkey PRIMARY KEY (id);


--
-- Name: contract_documents contract_documents_id_contract_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_id_contract_key UNIQUE (id, contract_id);


--
-- Name: contract_documents contract_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_pkey PRIMARY KEY (id);


--
-- Name: contract_renewal_tasks contract_renewal_tasks_contract_cycle_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_renewal_tasks
    ADD CONSTRAINT contract_renewal_tasks_contract_cycle_id_key UNIQUE (contract_cycle_id);


--
-- Name: contract_renewal_tasks contract_renewal_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_renewal_tasks
    ADD CONSTRAINT contract_renewal_tasks_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: entities entities_document_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_document_key UNIQUE (document);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_addresses entity_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_addresses
    ADD CONSTRAINT entity_addresses_pkey PRIMARY KEY (id);


--
-- Name: entity_attachments entity_attachments_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_attachments
    ADD CONSTRAINT entity_attachments_key UNIQUE (entity_id, attachment_id);


--
-- Name: entity_attachments entity_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_attachments
    ADD CONSTRAINT entity_attachments_pkey PRIMARY KEY (id);


--
-- Name: entity_bank_accounts entity_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_bank_accounts
    ADD CONSTRAINT entity_bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: entity_contacts entity_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_contacts
    ADD CONSTRAINT entity_contacts_pkey PRIMARY KEY (id);


--
-- Name: entity_contacts entity_contacts_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_contacts
    ADD CONSTRAINT entity_contacts_value_key UNIQUE (entity_id, kind, value);


--
-- Name: entity_links entity_links_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_key UNIQUE (entity_id, related_entity_id, kind);


--
-- Name: entity_links entity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_pkey PRIMARY KEY (id);


--
-- Name: entity_pix_keys entity_pix_keys_key_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_pix_keys
    ADD CONSTRAINT entity_pix_keys_key_value_key UNIQUE (key_type, key_value);


--
-- Name: entity_pix_keys entity_pix_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_pix_keys
    ADD CONSTRAINT entity_pix_keys_pkey PRIMARY KEY (id);


--
-- Name: entity_tag_links entity_tag_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tag_links
    ADD CONSTRAINT entity_tag_links_pkey PRIMARY KEY (entity_id, tag_id);


--
-- Name: entity_tags entity_tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tags
    ADD CONSTRAINT entity_tags_name_key UNIQUE (name);


--
-- Name: entity_tags entity_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tags
    ADD CONSTRAINT entity_tags_pkey PRIMARY KEY (id);


--
-- Name: financial_accounts financial_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_accounts
    ADD CONSTRAINT financial_accounts_pkey PRIMARY KEY (id);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: message_destinations message_destinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_destinations
    ADD CONSTRAINT message_destinations_pkey PRIMARY KEY (id);


--
-- Name: message_outbox message_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_outbox
    ADD CONSTRAINT message_outbox_pkey PRIMARY KEY (id);


--
-- Name: message_subscription_caixas message_subscription_caixas_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscription_caixas
    ADD CONSTRAINT message_subscription_caixas_key UNIQUE (subscription_id, caixa_id);


--
-- Name: message_subscription_caixas message_subscription_caixas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscription_caixas
    ADD CONSTRAINT message_subscription_caixas_pkey PRIMARY KEY (id);


--
-- Name: message_subscriptions message_subscriptions_destination_event_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscriptions
    ADD CONSTRAINT message_subscriptions_destination_event_key UNIQUE (destination_id, event_kind);


--
-- Name: message_subscriptions message_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscriptions
    ADD CONSTRAINT message_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: movement_attachments movement_attachments_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movement_attachments
    ADD CONSTRAINT movement_attachments_key UNIQUE (movement_id, attachment_id);


--
-- Name: movement_attachments movement_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movement_attachments
    ADD CONSTRAINT movement_attachments_pkey PRIMARY KEY (id);


--
-- Name: movements movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_pkey PRIMARY KEY (id);


--
-- Name: nfe_documents nfe_documents_access_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_documents
    ADD CONSTRAINT nfe_documents_access_key_key UNIQUE (access_key);


--
-- Name: nfe_documents nfe_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_documents
    ADD CONSTRAINT nfe_documents_pkey PRIMARY KEY (id);


--
-- Name: nfe_items nfe_items_item_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_items
    ADD CONSTRAINT nfe_items_item_number_key UNIQUE (nfe_document_id, item_number);


--
-- Name: nfe_items nfe_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_items
    ADD CONSTRAINT nfe_items_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: period_closings period_closings_caixa_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_closings
    ADD CONSTRAINT period_closings_caixa_month_key UNIQUE (caixa_id, month);


--
-- Name: period_closings period_closings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_closings
    ADD CONSTRAINT period_closings_pkey PRIMARY KEY (id);


--
-- Name: recurrence_rules recurrence_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurrence_rules
    ADD CONSTRAINT recurrence_rules_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: settlement_attachments settlement_attachments_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_attachments
    ADD CONSTRAINT settlement_attachments_key UNIQUE (settlement_id, attachment_id);


--
-- Name: settlement_attachments settlement_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_attachments
    ADD CONSTRAINT settlement_attachments_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);


--
-- Name: statement_csv_mappings statement_csv_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_csv_mappings
    ADD CONSTRAINT statement_csv_mappings_pkey PRIMARY KEY (id);


--
-- Name: statement_imports statement_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_pkey PRIMARY KEY (id);


--
-- Name: statement_lines statement_lines_line_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_line_number_key UNIQUE (statement_import_id, line_number);


--
-- Name: statement_lines statement_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_pkey PRIMARY KEY (id);


--
-- Name: title_attachments title_attachments_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.title_attachments
    ADD CONSTRAINT title_attachments_key UNIQUE (title_id, attachment_id);


--
-- Name: title_attachments title_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.title_attachments
    ADD CONSTRAINT title_attachments_pkey PRIMARY KEY (id);


--
-- Name: titles titles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_pkey PRIMARY KEY (id);


--
-- Name: transfers transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);


--
-- Name: transfers transfers_settlement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_settlement_id_key UNIQUE (settlement_id);


--
-- Name: user_ai_settings user_ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_settings
    ADD CONSTRAINT user_ai_settings_pkey PRIMARY KEY (user_id);


--
-- Name: user_api_tokens user_api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_api_tokens
    ADD CONSTRAINT user_api_tokens_pkey PRIMARY KEY (id);


--
-- Name: user_api_tokens user_api_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_api_tokens
    ADD CONSTRAINT user_api_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: agent_mcp_servers_mcp_server_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_mcp_servers_mcp_server_id_idx ON public.agent_mcp_servers USING btree (mcp_server_id);


--
-- Name: ai_agent_inferences_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agent_inferences_provider_id_idx ON public.ai_agent_inferences USING btree (provider_id);


--
-- Name: ai_agent_prompt_versions_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agent_prompt_versions_created_by_user_id_idx ON public.ai_agent_prompt_versions USING btree (created_by_user_id);


--
-- Name: ai_agent_prompt_versions_restored_from_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agent_prompt_versions_restored_from_version_id_idx ON public.ai_agent_prompt_versions USING btree (restored_from_version_id);


--
-- Name: ai_agents_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agents_created_by_user_id_idx ON public.ai_agents USING btree (created_by_user_id);


--
-- Name: ai_agents_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_agents_name_key ON public.ai_agents USING btree (lower(name));


--
-- Name: ai_agents_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agents_provider_id_idx ON public.ai_agents USING btree (provider_id);


--
-- Name: ai_agents_tool_kit_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agents_tool_kit_id_idx ON public.ai_agents USING btree (tool_kit_id);


--
-- Name: ai_agents_use_for_flows_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_agents_use_for_flows_key ON public.ai_agents USING btree ((true)) WHERE use_for_flows;


--
-- Name: ai_attachment_derivatives_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_attachment_derivatives_message_id_idx ON public.ai_attachment_derivatives USING btree (message_id, block_index);


--
-- Name: ai_attachment_derivatives_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_attachment_derivatives_provider_id_idx ON public.ai_attachment_derivatives USING btree (provider_id);


--
-- Name: ai_attachment_derivatives_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_attachment_derivatives_queue_idx ON public.ai_attachment_derivatives USING btree (kind, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: ai_attachment_derivatives_result_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_attachment_derivatives_result_attachment_id_idx ON public.ai_attachment_derivatives USING btree (result_attachment_id);


--
-- Name: ai_conversations_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_agent_id_idx ON public.ai_conversations USING btree (agent_id);


--
-- Name: ai_conversations_chat_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_chat_user_idx ON public.ai_conversations USING btree (user_id, last_message_at DESC NULLS LAST) WHERE (purpose = 'chat'::text);


--
-- Name: ai_conversations_forked_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_forked_from_idx ON public.ai_conversations USING btree (forked_from_conversation_id, forked_from_message_id);


--
-- Name: ai_conversations_purpose_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_purpose_idx ON public.ai_conversations USING btree (purpose, created_at) WHERE (purpose <> 'chat'::text);


--
-- Name: ai_conversations_title_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_title_trgm_idx ON public.ai_conversations USING gin (title public.gin_trgm_ops);


--
-- Name: ai_conversations_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_user_id_idx ON public.ai_conversations USING btree (user_id, last_message_at DESC NULLS LAST);


--
-- Name: ai_embeddings_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_embeddings_caixa_id_idx ON public.ai_embeddings USING btree (caixa_id);


--
-- Name: ai_embeddings_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_embeddings_embedding_idx ON public.ai_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: ai_embeddings_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_embeddings_object_idx ON public.ai_embeddings USING btree (object_type, object_id);


--
-- Name: ai_embeddings_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_embeddings_pair_idx ON public.ai_embeddings USING btree (provider_id, model);


--
-- Name: ai_embeddings_reindex_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_embeddings_reindex_idx ON public.ai_embeddings USING btree (provider_id, model, updated_at) WHERE needs_reindex;


--
-- Name: ai_message_attachments_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_message_attachments_attachment_id_idx ON public.ai_message_attachments USING btree (attachment_id);


--
-- Name: ai_messages_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_run_id_idx ON public.ai_messages USING btree (run_id);


--
-- Name: ai_messages_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_run_idx ON public.ai_messages USING btree (conversation_id, run_id);


--
-- Name: ai_messages_search_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_search_tsv_idx ON public.ai_messages USING gin (search_tsv);


--
-- Name: ai_providers_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_providers_created_by_user_id_idx ON public.ai_providers USING btree (created_by_user_id);


--
-- Name: ai_providers_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_providers_name_key ON public.ai_providers USING btree (lower(name));


--
-- Name: ai_requests_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_agent_id_idx ON public.ai_requests USING btree (agent_id, started_at);


--
-- Name: ai_requests_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_conversation_id_idx ON public.ai_requests USING btree (conversation_id);


--
-- Name: ai_requests_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_provider_id_idx ON public.ai_requests USING btree (provider_id, started_at DESC, id DESC);


--
-- Name: ai_requests_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_run_id_idx ON public.ai_requests USING btree (run_id);


--
-- Name: ai_requests_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_started_at_idx ON public.ai_requests USING btree (started_at, id);


--
-- Name: ai_requests_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_user_id_idx ON public.ai_requests USING btree (user_id, started_at);


--
-- Name: ai_runs_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_agent_id_idx ON public.ai_runs USING btree (agent_id);


--
-- Name: ai_runs_conversation_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_runs_conversation_active_key ON public.ai_runs USING btree (conversation_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_confirmation'::text]));


--
-- Name: ai_runs_finished_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_finished_at_idx ON public.ai_runs USING btree (finished_at) WHERE (finished_at IS NOT NULL);


--
-- Name: ai_runs_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_provider_id_idx ON public.ai_runs USING btree (provider_id);


--
-- Name: ai_runs_queued_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_queued_idx ON public.ai_runs USING btree (created_at) WHERE (status = 'queued'::text);


--
-- Name: ai_runs_running_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_running_idx ON public.ai_runs USING btree (locked_at) WHERE (status = 'running'::text);


--
-- Name: ai_runs_trigger_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_trigger_message_idx ON public.ai_runs USING btree (conversation_id, trigger_message_id);


--
-- Name: ai_runs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_runs_user_id_idx ON public.ai_runs USING btree (user_id, created_at);


--
-- Name: ai_tool_confirmations_decided_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_tool_confirmations_decided_by_user_id_idx ON public.ai_tool_confirmations USING btree (decided_by_user_id);


--
-- Name: ai_tool_confirmations_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_tool_confirmations_pending_idx ON public.ai_tool_confirmations USING btree (run_id) WHERE (status = 'pending'::text);


--
-- Name: ai_tool_kits_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_tool_kits_created_by_user_id_idx ON public.ai_tool_kits USING btree (created_by_user_id);


--
-- Name: ai_tool_kits_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_tool_kits_name_key ON public.ai_tool_kits USING btree (lower(name));


--
-- Name: ai_usage_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_agent_id_idx ON public.ai_usage USING btree (agent_id, created_at);


--
-- Name: ai_usage_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_conversation_id_idx ON public.ai_usage USING btree (conversation_id);


--
-- Name: ai_usage_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_created_at_idx ON public.ai_usage USING btree (created_at);


--
-- Name: ai_usage_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_message_id_idx ON public.ai_usage USING btree (message_id);


--
-- Name: ai_usage_price_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_price_id_idx ON public.ai_usage USING btree (price_id);


--
-- Name: ai_usage_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_provider_id_idx ON public.ai_usage USING btree (provider_id);


--
-- Name: ai_usage_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_request_id_idx ON public.ai_usage USING btree (request_id);


--
-- Name: ai_usage_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_run_id_idx ON public.ai_usage USING btree (run_id);


--
-- Name: ai_usage_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_user_id_idx ON public.ai_usage USING btree (user_id, created_at);


--
-- Name: app_settings_updated_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_settings_updated_by_user_id_idx ON public.app_settings USING btree (updated_by_user_id);


--
-- Name: attachments_sha256_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_sha256_idx ON public.attachments USING btree (sha256);


--
-- Name: attachments_uploaded_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_uploaded_by_user_id_idx ON public.attachments USING btree (uploaded_by_user_id);


--
-- Name: audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_at_idx ON public.audit_log USING btree (created_at);


--
-- Name: audit_log_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_record_idx ON public.audit_log USING btree (table_name, record_id, created_at);


--
-- Name: audit_log_transaction_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_transaction_id_idx ON public.audit_log USING btree (transaction_id);


--
-- Name: audit_log_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_user_id_idx ON public.audit_log USING btree (user_id, created_at);


--
-- Name: caixa_hidden_categories_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caixa_hidden_categories_category_id_idx ON public.caixa_hidden_categories USING btree (category_id);


--
-- Name: caixa_members_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caixa_members_caixa_id_idx ON public.caixa_members USING btree (caixa_id);


--
-- Name: caixas_default_payer_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caixas_default_payer_caixa_id_idx ON public.caixas USING btree (default_payer_caixa_id);


--
-- Name: caixas_holder_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caixas_holder_entity_id_idx ON public.caixas USING btree (holder_entity_id);


--
-- Name: caixas_holder_primary_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX caixas_holder_primary_key ON public.caixas USING btree (holder_entity_id) WHERE is_primary;


--
-- Name: card_invoice_items_card_invoice_id_payer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_invoice_items_card_invoice_id_payer_idx ON public.card_invoice_items USING btree (card_invoice_id, payer_caixa_id);


--
-- Name: card_invoice_items_payer_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_invoice_items_payer_caixa_id_idx ON public.card_invoice_items USING btree (payer_caixa_id);


--
-- Name: card_invoices_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_invoices_due_date_idx ON public.card_invoices USING btree (due_date);


--
-- Name: card_purchase_attachments_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchase_attachments_attachment_id_idx ON public.card_purchase_attachments USING btree (attachment_id);


--
-- Name: card_purchases_card_caixa_id_purchased_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_card_caixa_id_purchased_on_idx ON public.card_purchases USING btree (card_caixa_id, purchased_on);


--
-- Name: card_purchases_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_category_id_idx ON public.card_purchases USING btree (category_id);


--
-- Name: card_purchases_description_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_description_trgm_idx ON public.card_purchases USING gin (description public.gin_trgm_ops);


--
-- Name: card_purchases_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_entity_id_idx ON public.card_purchases USING btree (entity_id);


--
-- Name: card_purchases_payer_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_payer_caixa_id_idx ON public.card_purchases USING btree (payer_caixa_id);


--
-- Name: card_purchases_refunded_purchase_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_refunded_purchase_id_idx ON public.card_purchases USING btree (refunded_purchase_id);


--
-- Name: categories_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_parent_id_idx ON public.categories USING btree (parent_id);


--
-- Name: categories_sibling_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX categories_sibling_name_key ON public.categories USING btree (kind, parent_id, lower(name)) NULLS NOT DISTINCT;


--
-- Name: classification_rules_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_caixa_id_idx ON public.classification_rules USING btree (caixa_id);


--
-- Name: classification_rules_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_category_id_idx ON public.classification_rules USING btree (category_id);


--
-- Name: classification_rules_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_created_by_user_id_idx ON public.classification_rules USING btree (created_by_user_id);


--
-- Name: classification_rules_created_from_line_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_created_from_line_id_idx ON public.classification_rules USING btree (created_from_line_id);


--
-- Name: classification_rules_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_entity_id_idx ON public.classification_rules USING btree (entity_id);


--
-- Name: classification_rules_pattern_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX classification_rules_pattern_key ON public.classification_rules USING btree (caixa_id, match_kind, lower(pattern), direction) NULLS NOT DISTINCT WHERE (archived_at IS NULL);


--
-- Name: contract_amendments_contract_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_amendments_contract_cycle_id_idx ON public.contract_amendments USING btree (contract_cycle_id);


--
-- Name: contract_amendments_contract_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_amendments_contract_id_idx ON public.contract_amendments USING btree (contract_id, effective_on);


--
-- Name: contract_amendments_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_amendments_created_by_idx ON public.contract_amendments USING btree (created_by);


--
-- Name: contract_amendments_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_amendments_document_id_idx ON public.contract_amendments USING btree (document_id);


--
-- Name: contract_document_versions_ai_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_document_versions_ai_run_id_idx ON public.contract_document_versions USING btree (ai_run_id);


--
-- Name: contract_document_versions_author_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_document_versions_author_user_id_idx ON public.contract_document_versions USING btree (author_user_id);


--
-- Name: contract_document_versions_restored_from_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_document_versions_restored_from_version_id_idx ON public.contract_document_versions USING btree (restored_from_version_id);


--
-- Name: contract_documents_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_documents_attachment_id_idx ON public.contract_documents USING btree (attachment_id);


--
-- Name: contract_documents_contract_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_documents_contract_id_idx ON public.contract_documents USING btree (contract_id);


--
-- Name: contract_documents_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_documents_created_by_idx ON public.contract_documents USING btree (created_by);


--
-- Name: contract_documents_current_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_documents_current_version_id_idx ON public.contract_documents USING btree (current_version_id);


--
-- Name: contract_documents_source_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_documents_source_document_id_idx ON public.contract_documents USING btree (source_document_id);


--
-- Name: contract_renewal_tasks_contract_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_renewal_tasks_contract_id_idx ON public.contract_renewal_tasks USING btree (contract_id);


--
-- Name: contract_renewal_tasks_decided_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_renewal_tasks_decided_by_idx ON public.contract_renewal_tasks USING btree (decided_by);


--
-- Name: contract_renewal_tasks_due_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_renewal_tasks_due_on_idx ON public.contract_renewal_tasks USING btree (due_on) WHERE (status = 'open'::text);


--
-- Name: contract_renewal_tasks_new_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_renewal_tasks_new_cycle_id_idx ON public.contract_renewal_tasks USING btree (new_cycle_id);


--
-- Name: contract_renewal_tasks_open_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contract_renewal_tasks_open_key ON public.contract_renewal_tasks USING btree (contract_id) WHERE (status = 'open'::text);


--
-- Name: contracts_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_caixa_id_idx ON public.contracts USING btree (caixa_id);


--
-- Name: contracts_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_category_id_idx ON public.contracts USING btree (category_id);


--
-- Name: contracts_contract_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contracts_contract_number_key ON public.contracts USING btree (caixa_id, lower(contract_number)) WHERE ((archived_at IS NULL) AND (contract_number IS NOT NULL));


--
-- Name: contracts_counterparty_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_counterparty_caixa_id_idx ON public.contracts USING btree (counterparty_caixa_id);


--
-- Name: contracts_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_created_by_idx ON public.contracts USING btree (created_by);


--
-- Name: contracts_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_entity_id_idx ON public.contracts USING btree (entity_id);


--
-- Name: contracts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_status_idx ON public.contracts USING btree (status);


--
-- Name: entities_document_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_document_prefix_idx ON public.entities USING btree (document text_pattern_ops);


--
-- Name: INDEX entities_document_prefix_idx; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.entities_document_prefix_idx IS 'Busca pelo prefixo do documento normalizado (document LIKE ''12ABC%''), CPF ou CNPJ numérico/alfanumérico.';


--
-- Name: entities_is_favorite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_is_favorite_idx ON public.entities USING btree (name) WHERE (is_favorite AND (archived_at IS NULL));


--
-- Name: entities_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_name_trgm_idx ON public.entities USING gin (name public.gin_trgm_ops);


--
-- Name: entities_trade_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_trade_name_trgm_idx ON public.entities USING gin (trade_name public.gin_trgm_ops);


--
-- Name: entity_addresses_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_addresses_entity_id_idx ON public.entity_addresses USING btree (entity_id);


--
-- Name: entity_attachments_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_attachments_attachment_id_idx ON public.entity_attachments USING btree (attachment_id);


--
-- Name: entity_bank_accounts_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_bank_accounts_entity_id_idx ON public.entity_bank_accounts USING btree (entity_id);


--
-- Name: entity_contacts_primary_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_contacts_primary_key ON public.entity_contacts USING btree (entity_id, kind) WHERE is_primary;


--
-- Name: entity_links_related_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_links_related_entity_id_idx ON public.entity_links USING btree (related_entity_id);


--
-- Name: entity_links_spouse_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_links_spouse_key ON public.entity_links USING btree (LEAST(entity_id, related_entity_id), GREATEST(entity_id, related_entity_id)) WHERE (kind = 'spouse_of'::text);


--
-- Name: entity_pix_keys_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_pix_keys_entity_id_idx ON public.entity_pix_keys USING btree (entity_id);


--
-- Name: entity_pix_keys_primary_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_pix_keys_primary_key ON public.entity_pix_keys USING btree (entity_id) WHERE is_primary;


--
-- Name: entity_tag_links_tag_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_tag_links_tag_id_idx ON public.entity_tag_links USING btree (tag_id);


--
-- Name: financial_accounts_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX financial_accounts_caixa_id_idx ON public.financial_accounts USING btree (caixa_id);


--
-- Name: mcp_servers_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_servers_created_by_user_id_idx ON public.mcp_servers USING btree (created_by_user_id);


--
-- Name: mcp_servers_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_servers_name_key ON public.mcp_servers USING btree (lower(name));


--
-- Name: message_destinations_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_destinations_created_by_user_id_idx ON public.message_destinations USING btree (created_by_user_id);


--
-- Name: message_destinations_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_destinations_name_key ON public.message_destinations USING btree (owner_user_id, owner_caixa_id, lower(name)) NULLS NOT DISTINCT;


--
-- Name: message_destinations_owner_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_destinations_owner_caixa_id_idx ON public.message_destinations USING btree (owner_caixa_id);


--
-- Name: message_destinations_owner_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_destinations_owner_user_id_idx ON public.message_destinations USING btree (owner_user_id);


--
-- Name: message_outbox_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_caixa_id_idx ON public.message_outbox USING btree (caixa_id);


--
-- Name: message_outbox_dedup_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_outbox_dedup_key ON public.message_outbox USING btree (destination_id, dedup_key);


--
-- Name: message_outbox_destination_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_destination_id_idx ON public.message_outbox USING btree (destination_id, created_at);


--
-- Name: message_outbox_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_ready_idx ON public.message_outbox USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: message_outbox_sending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_sending_idx ON public.message_outbox USING btree (locked_at) WHERE (status = 'sending'::text);


--
-- Name: message_outbox_subscription_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_subscription_id_idx ON public.message_outbox USING btree (subscription_id);


--
-- Name: message_outbox_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_user_id_idx ON public.message_outbox USING btree (user_id);


--
-- Name: message_subscription_caixas_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_subscription_caixas_caixa_id_idx ON public.message_subscription_caixas USING btree (caixa_id);


--
-- Name: message_subscriptions_event_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_subscriptions_event_kind_idx ON public.message_subscriptions USING btree (event_kind) WHERE is_active;


--
-- Name: movement_attachments_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX movement_attachments_attachment_id_idx ON public.movement_attachments USING btree (attachment_id);


--
-- Name: movements_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX movements_category_id_idx ON public.movements USING btree (category_id);


--
-- Name: movements_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX movements_entity_id_idx ON public.movements USING btree (entity_id);


--
-- Name: movements_financial_account_id_occurred_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX movements_financial_account_id_occurred_on_idx ON public.movements USING btree (financial_account_id, occurred_on);


--
-- Name: movements_settlement_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX movements_settlement_id_idx ON public.movements USING btree (settlement_id);


--
-- Name: movements_transfer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX movements_transfer_id_idx ON public.movements USING btree (transfer_id);


--
-- Name: nfe_documents_issuer_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nfe_documents_issuer_entity_id_idx ON public.nfe_documents USING btree (issuer_entity_id);


--
-- Name: nfe_documents_recipient_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nfe_documents_recipient_entity_id_idx ON public.nfe_documents USING btree (recipient_entity_id);


--
-- Name: nfe_documents_xml_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nfe_documents_xml_attachment_id_idx ON public.nfe_documents USING btree (xml_attachment_id);


--
-- Name: notifications_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_caixa_id_idx ON public.notifications USING btree (caixa_id);


--
-- Name: notifications_dedup_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notifications_dedup_key ON public.notifications USING btree (user_id, dedup_key);


--
-- Name: notifications_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_unread_idx ON public.notifications USING btree (user_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: notifications_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_id_created_at_idx ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: period_closings_closed_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX period_closings_closed_by_user_id_idx ON public.period_closings USING btree (closed_by_user_id);


--
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: settlement_attachments_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlement_attachments_attachment_id_idx ON public.settlement_attachments USING btree (attachment_id);


--
-- Name: settlements_financial_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlements_financial_account_id_idx ON public.settlements USING btree (financial_account_id);


--
-- Name: settlements_mirror_settlement_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX settlements_mirror_settlement_id_key ON public.settlements USING btree (mirror_settlement_id);


--
-- Name: settlements_settled_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlements_settled_on_idx ON public.settlements USING btree (settled_on);


--
-- Name: settlements_title_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlements_title_id_idx ON public.settlements USING btree (title_id);


--
-- Name: statement_csv_mappings_card_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_csv_mappings_card_caixa_id_idx ON public.statement_csv_mappings USING btree (card_caixa_id);


--
-- Name: statement_csv_mappings_default_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_csv_mappings_default_key ON public.statement_csv_mappings USING btree (financial_account_id, card_caixa_id) NULLS NOT DISTINCT WHERE is_default;


--
-- Name: statement_csv_mappings_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_csv_mappings_name_key ON public.statement_csv_mappings USING btree (financial_account_id, card_caixa_id, lower(name)) NULLS NOT DISTINCT;


--
-- Name: statement_imports_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_attachment_id_idx ON public.statement_imports USING btree (attachment_id);


--
-- Name: statement_imports_card_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_card_caixa_id_idx ON public.statement_imports USING btree (card_caixa_id, period_start);


--
-- Name: statement_imports_card_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_card_invoice_id_idx ON public.statement_imports USING btree (card_invoice_id);


--
-- Name: statement_imports_csv_mapping_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_csv_mapping_id_idx ON public.statement_imports USING btree (csv_mapping_id);


--
-- Name: statement_imports_financial_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_financial_account_id_idx ON public.statement_imports USING btree (financial_account_id, period_start);


--
-- Name: statement_imports_imported_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_imported_by_user_id_idx ON public.statement_imports USING btree (imported_by_user_id);


--
-- Name: statement_lines_account_dedup_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_lines_account_dedup_key ON public.statement_lines USING btree (financial_account_id, dedup_hash) WHERE (financial_account_id IS NOT NULL);


--
-- Name: statement_lines_card_caixa_id_posted_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_card_caixa_id_posted_on_idx ON public.statement_lines USING btree (card_caixa_id, posted_on);


--
-- Name: statement_lines_card_dedup_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_lines_card_dedup_key ON public.statement_lines USING btree (card_caixa_id, dedup_hash) WHERE (card_caixa_id IS NOT NULL);


--
-- Name: statement_lines_card_invoice_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_card_invoice_item_id_idx ON public.statement_lines USING btree (card_invoice_item_id);


--
-- Name: statement_lines_card_item_matched_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_lines_card_item_matched_key ON public.statement_lines USING btree (card_invoice_item_id) WHERE (status = 'matched'::text);


--
-- Name: statement_lines_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_category_id_idx ON public.statement_lines USING btree (category_id);


--
-- Name: statement_lines_classification_rule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_classification_rule_id_idx ON public.statement_lines USING btree (classification_rule_id);


--
-- Name: statement_lines_description_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_description_trgm_idx ON public.statement_lines USING gin (description public.gin_trgm_ops);


--
-- Name: statement_lines_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_entity_id_idx ON public.statement_lines USING btree (entity_id);


--
-- Name: statement_lines_financial_account_id_posted_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_financial_account_id_posted_on_idx ON public.statement_lines USING btree (financial_account_id, posted_on);


--
-- Name: statement_lines_movement_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_movement_id_idx ON public.statement_lines USING btree (movement_id);


--
-- Name: statement_lines_movement_matched_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_lines_movement_matched_key ON public.statement_lines USING btree (movement_id) WHERE (status = 'matched'::text);


--
-- Name: statement_lines_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_status_idx ON public.statement_lines USING btree (statement_import_id, status);


--
-- Name: statement_lines_title_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_title_id_idx ON public.statement_lines USING btree (title_id);


--
-- Name: title_attachments_attachment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX title_attachments_attachment_id_idx ON public.title_attachments USING btree (attachment_id);


--
-- Name: titles_caixa_boleto_barcode_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX titles_caixa_boleto_barcode_key ON public.titles USING btree (caixa_id, boleto_barcode) WHERE ((boleto_barcode IS NOT NULL) AND (status <> 'canceled'::text));


--
-- Name: titles_caixa_id_competence_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_caixa_id_competence_date_idx ON public.titles USING btree (caixa_id, competence_date);


--
-- Name: titles_caixa_id_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_caixa_id_due_date_idx ON public.titles USING btree (caixa_id, due_date);


--
-- Name: titles_caixa_id_status_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_caixa_id_status_due_date_idx ON public.titles USING btree (caixa_id, status, due_date);


--
-- Name: titles_card_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_card_invoice_id_idx ON public.titles USING btree (card_invoice_id);


--
-- Name: titles_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_category_id_idx ON public.titles USING btree (category_id);


--
-- Name: titles_contract_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_contract_id_idx ON public.titles USING btree (contract_id);


--
-- Name: titles_contract_installment_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX titles_contract_installment_key ON public.titles USING btree (contract_cycle_id, caixa_id, contract_installment);


--
-- Name: titles_counterparty_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_counterparty_caixa_id_idx ON public.titles USING btree (counterparty_caixa_id);


--
-- Name: titles_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_due_date_idx ON public.titles USING btree (due_date) WHERE (status = ANY (ARRAY['open'::text, 'partial'::text]));


--
-- Name: titles_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_entity_id_idx ON public.titles USING btree (entity_id);


--
-- Name: titles_mirror_title_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX titles_mirror_title_id_key ON public.titles USING btree (mirror_title_id);


--
-- Name: titles_nfe_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_nfe_document_id_idx ON public.titles USING btree (nfe_document_id);


--
-- Name: titles_recurrence_occurrence_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX titles_recurrence_occurrence_key ON public.titles USING btree (recurrence_rule_id, caixa_id, occurrence);


--
-- Name: transfers_from_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transfers_from_account_id_idx ON public.transfers USING btree (from_account_id);


--
-- Name: transfers_to_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transfers_to_account_id_idx ON public.transfers USING btree (to_account_id);


--
-- Name: user_ai_settings_primary_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_ai_settings_primary_caixa_id_idx ON public.user_ai_settings USING btree (primary_caixa_id);


--
-- Name: user_api_tokens_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_api_tokens_name_key ON public.user_api_tokens USING btree (user_id, lower(name)) WHERE (revoked_at IS NULL);


--
-- Name: user_api_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_api_tokens_user_id_idx ON public.user_api_tokens USING btree (user_id, created_at);


--
-- Name: agent_mcp_servers agent_mcp_servers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_mcp_servers_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_mcp_servers FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: agent_mcp_servers agent_mcp_servers_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_mcp_servers_set_updated_at BEFORE UPDATE ON public.agent_mcp_servers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_agent_inferences ai_agent_inferences_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_inferences_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_agent_inferences FOR EACH ROW EXECUTE FUNCTION public.ai_agent_inferences_audit_row();


--
-- Name: ai_agent_inferences ai_agent_inferences_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_inferences_set_updated_at BEFORE UPDATE ON public.ai_agent_inferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_agent_inferences ai_agent_inferences_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_inferences_validate BEFORE INSERT OR UPDATE ON public.ai_agent_inferences FOR EACH ROW EXECUTE FUNCTION public.ai_agent_inferences_validate();


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_apply; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_prompt_versions_apply AFTER INSERT ON public.ai_agent_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.ai_agent_prompt_versions_apply();


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_prompt_versions_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_agent_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.ai_agent_prompt_versions_audit_row();


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_prompt_versions_before_insert BEFORE INSERT ON public.ai_agent_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.ai_agent_prompt_versions_before_insert();


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_prompt_versions_guard BEFORE DELETE OR UPDATE ON public.ai_agent_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.ai_agent_prompt_versions_guard();


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agent_prompt_versions_set_updated_at BEFORE UPDATE ON public.ai_agent_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_agents ai_agents_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agents_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: ai_agents ai_agents_prompt_version_init; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER ai_agents_prompt_version_init AFTER INSERT ON public.ai_agents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ai_agents_prompt_version_init();


--
-- Name: ai_agents ai_agents_provider_capability; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agents_provider_capability BEFORE INSERT OR UPDATE OF provider_id ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION public.ai_agents_provider_capability();


--
-- Name: ai_agents ai_agents_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agents_set_updated_at BEFORE UPDATE ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_agents ai_agents_system_prompt_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agents_system_prompt_guard BEFORE UPDATE OF system_prompt ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION public.ai_agents_system_prompt_guard();


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_attachment_derivatives_guard BEFORE UPDATE ON public.ai_attachment_derivatives FOR EACH ROW EXECUTE FUNCTION public.ai_attachment_derivatives_guard();


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_release_result; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_attachment_derivatives_release_result AFTER DELETE OR UPDATE OF result_attachment_id ON public.ai_attachment_derivatives FOR EACH ROW EXECUTE FUNCTION public.ai_attachment_derivatives_release_result();


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_attachment_derivatives_set_updated_at BEFORE UPDATE ON public.ai_attachment_derivatives FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_conversations ai_conversations_purpose_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_conversations_purpose_immutable BEFORE UPDATE OF purpose ON public.ai_conversations FOR EACH ROW WHEN ((new.purpose IS DISTINCT FROM old.purpose)) EXECUTE FUNCTION public.ai_conversations_purpose_immutable();


--
-- Name: ai_conversations ai_conversations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_conversations_set_updated_at BEFORE UPDATE ON public.ai_conversations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_embedding_indexes ai_embedding_indexes_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_embedding_indexes_set_updated_at BEFORE UPDATE ON public.ai_embedding_indexes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_embeddings ai_embeddings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_embeddings_set_updated_at BEFORE UPDATE ON public.ai_embeddings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_message_attachments ai_message_attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_message_attachments_set_updated_at BEFORE UPDATE ON public.ai_message_attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_messages ai_messages_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_messages_after_insert AFTER INSERT ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.ai_messages_after_insert();


--
-- Name: ai_messages ai_messages_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_messages_before_insert BEFORE INSERT ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.ai_messages_before_insert();


--
-- Name: ai_messages ai_messages_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_messages_set_updated_at BEFORE UPDATE ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_messages ai_messages_validate_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_messages_validate_update BEFORE UPDATE ON public.ai_messages FOR EACH ROW EXECUTE FUNCTION public.ai_messages_validate_update();


--
-- Name: ai_model_prices ai_model_prices_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_model_prices_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_model_prices FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: ai_model_prices ai_model_prices_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_model_prices_set_updated_at BEFORE UPDATE ON public.ai_model_prices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_providers ai_providers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_providers_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_providers FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: ai_providers ai_providers_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_providers_set_updated_at BEFORE UPDATE ON public.ai_providers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_providers ai_providers_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_providers_validate BEFORE INSERT OR UPDATE ON public.ai_providers FOR EACH ROW EXECUTE FUNCTION public.ai_providers_validate();


--
-- Name: ai_request_attempts ai_request_attempts_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_request_attempts_after_insert AFTER INSERT ON public.ai_request_attempts FOR EACH ROW EXECUTE FUNCTION public.ai_request_attempts_after_insert();


--
-- Name: ai_request_attempts ai_request_attempts_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_request_attempts_before_write BEFORE INSERT OR UPDATE ON public.ai_request_attempts FOR EACH ROW EXECUTE FUNCTION public.ai_request_attempts_before_write();


--
-- Name: ai_request_attempts ai_request_attempts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_request_attempts_set_updated_at BEFORE UPDATE ON public.ai_request_attempts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_requests ai_requests_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_requests_before_write BEFORE INSERT OR UPDATE ON public.ai_requests FOR EACH ROW EXECUTE FUNCTION public.ai_requests_before_write();


--
-- Name: ai_requests ai_requests_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_requests_set_updated_at BEFORE UPDATE ON public.ai_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_runs ai_runs_expire_confirmations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_runs_expire_confirmations AFTER UPDATE OF status ON public.ai_runs FOR EACH ROW WHEN (((new.status = ANY (ARRAY['completed'::text, 'failed'::text, 'canceled'::text])) AND (old.status <> new.status))) EXECUTE FUNCTION public.ai_runs_expire_confirmations();


--
-- Name: ai_runs ai_runs_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_runs_set_updated_at BEFORE UPDATE ON public.ai_runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_runs ai_runs_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_runs_validate BEFORE INSERT OR UPDATE ON public.ai_runs FOR EACH ROW EXECUTE FUNCTION public.ai_runs_validate();


--
-- Name: ai_tool_confirmations ai_tool_confirmations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_tool_confirmations_set_updated_at BEFORE UPDATE ON public.ai_tool_confirmations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_tool_confirmations ai_tool_confirmations_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_tool_confirmations_validate BEFORE INSERT OR UPDATE ON public.ai_tool_confirmations FOR EACH ROW EXECUTE FUNCTION public.ai_tool_confirmations_validate();


--
-- Name: ai_tool_kit_tools ai_tool_kit_tools_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_tool_kit_tools_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_tool_kit_tools FOR EACH ROW EXECUTE FUNCTION public.ai_tool_kit_tools_audit_row();


--
-- Name: ai_tool_kit_tools ai_tool_kit_tools_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_tool_kit_tools_set_updated_at BEFORE UPDATE ON public.ai_tool_kit_tools FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_tool_kits ai_tool_kits_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_tool_kits_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_tool_kits FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: ai_tool_kits ai_tool_kits_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_tool_kits_set_updated_at BEFORE UPDATE ON public.ai_tool_kits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_usage ai_usage_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_usage_after_insert AFTER INSERT ON public.ai_usage FOR EACH ROW EXECUTE FUNCTION public.ai_usage_after_insert();


--
-- Name: ai_usage ai_usage_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_usage_before_insert BEFORE INSERT ON public.ai_usage FOR EACH ROW EXECUTE FUNCTION public.ai_usage_before_insert();


--
-- Name: ai_usage ai_usage_request_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_usage_request_check BEFORE INSERT ON public.ai_usage FOR EACH ROW EXECUTE FUNCTION public.ai_usage_request_check();


--
-- Name: ai_usage ai_usage_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_usage_set_updated_at BEFORE UPDATE ON public.ai_usage FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: app_settings app_settings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_settings_audit AFTER INSERT OR DELETE OR UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.app_settings_audit_row();


--
-- Name: app_settings app_settings_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_settings_before_write BEFORE INSERT OR UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.app_settings_before_write();


--
-- Name: app_settings app_settings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_settings_set_updated_at BEFORE UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: attachments attachments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.attachments FOR EACH ROW EXECUTE FUNCTION public.attachments_audit_row();


--
-- Name: attachments attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attachments_set_updated_at BEFORE UPDATE ON public.attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: attachments attachments_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attachments_validate BEFORE UPDATE OF content ON public.attachments FOR EACH ROW EXECUTE FUNCTION public.attachments_validate();


--
-- Name: caixa_hidden_categories caixa_hidden_categories_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixa_hidden_categories_audit AFTER INSERT OR DELETE OR UPDATE ON public.caixa_hidden_categories FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: caixa_hidden_categories caixa_hidden_categories_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixa_hidden_categories_set_updated_at BEFORE UPDATE ON public.caixa_hidden_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: caixa_members caixa_members_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixa_members_audit AFTER INSERT OR DELETE OR UPDATE ON public.caixa_members FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: caixa_members caixa_members_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixa_members_set_updated_at BEFORE UPDATE ON public.caixa_members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: caixas caixas_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixas_audit AFTER INSERT OR DELETE OR UPDATE ON public.caixas FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: caixas caixas_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixas_set_updated_at BEFORE UPDATE ON public.caixas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: caixas caixas_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixas_validate BEFORE INSERT OR UPDATE ON public.caixas FOR EACH ROW EXECUTE FUNCTION public.caixas_validate();


--
-- Name: canvas_node_positions canvas_node_positions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER canvas_node_positions_set_updated_at BEFORE UPDATE ON public.canvas_node_positions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_invoice_items card_invoice_items_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_invoice_items_audit AFTER INSERT OR DELETE OR UPDATE ON public.card_invoice_items FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: card_invoice_items card_invoice_items_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_invoice_items_integrity_check AFTER INSERT OR DELETE OR UPDATE ON public.card_invoice_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.card_invoice_items_integrity_check();


--
-- Name: card_invoice_items card_invoice_items_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_invoice_items_set_updated_at BEFORE UPDATE ON public.card_invoice_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_invoice_items card_invoice_items_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_invoice_items_validate BEFORE INSERT OR DELETE OR UPDATE ON public.card_invoice_items FOR EACH ROW EXECUTE FUNCTION public.card_invoice_items_validate();


--
-- Name: card_invoices card_invoices_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_invoices_audit AFTER INSERT OR DELETE OR UPDATE ON public.card_invoices FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: card_invoices card_invoices_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_invoices_integrity_check AFTER INSERT OR UPDATE ON public.card_invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.card_invoices_integrity_check();


--
-- Name: card_invoices card_invoices_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_invoices_set_updated_at BEFORE UPDATE ON public.card_invoices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_invoices card_invoices_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_invoices_validate BEFORE INSERT OR UPDATE ON public.card_invoices FOR EACH ROW EXECUTE FUNCTION public.card_invoices_validate();


--
-- Name: card_purchase_attachments card_purchase_attachments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchase_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.card_purchase_attachments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: card_purchase_attachments card_purchase_attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchase_attachments_set_updated_at BEFORE UPDATE ON public.card_purchase_attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_purchases card_purchases_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_audit AFTER INSERT OR DELETE OR UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: card_purchases card_purchases_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_purchases_integrity_check AFTER INSERT OR UPDATE ON public.card_purchases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.card_purchases_integrity_check();


--
-- Name: card_purchases card_purchases_period_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_period_lock BEFORE INSERT OR DELETE OR UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.card_purchases_period_lock();


--
-- Name: card_purchases card_purchases_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_set_updated_at BEFORE UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_purchases card_purchases_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_validate BEFORE INSERT OR UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.card_purchases_validate();


--
-- Name: categories categories_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_audit AFTER INSERT OR DELETE OR UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: categories categories_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categories categories_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_validate BEFORE INSERT OR UPDATE OF kind, parent_id ON public.categories FOR EACH ROW EXECUTE FUNCTION public.categories_validate();


--
-- Name: classification_rules classification_rules_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER classification_rules_audit AFTER INSERT OR DELETE OR UPDATE ON public.classification_rules FOR EACH ROW EXECUTE FUNCTION public.audit_row('usage_count,last_used_at');


--
-- Name: classification_rules classification_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER classification_rules_set_updated_at BEFORE UPDATE ON public.classification_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: classification_rules classification_rules_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER classification_rules_validate BEFORE INSERT OR UPDATE OF match_kind, pattern, direction, category_id ON public.classification_rules FOR EACH ROW EXECUTE FUNCTION public.classification_rules_validate();


--
-- Name: contract_amendments contract_amendments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_amendments_audit AFTER INSERT OR DELETE OR UPDATE ON public.contract_amendments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: contract_amendments contract_amendments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_amendments_set_updated_at BEFORE UPDATE ON public.contract_amendments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contract_amendments contract_amendments_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_amendments_validate BEFORE UPDATE ON public.contract_amendments FOR EACH ROW EXECUTE FUNCTION public.contract_amendments_validate();


--
-- Name: contract_cycles contract_cycles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_cycles_audit AFTER INSERT OR DELETE OR UPDATE ON public.contract_cycles FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: contract_cycles contract_cycles_contiguous_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER contract_cycles_contiguous_check AFTER INSERT OR DELETE OR UPDATE OF seq, starts_on, duration_months ON public.contract_cycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contract_cycles_contiguous_check();


--
-- Name: contract_cycles contract_cycles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_cycles_set_updated_at BEFORE UPDATE ON public.contract_cycles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contract_cycles contract_cycles_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_cycles_validate BEFORE UPDATE ON public.contract_cycles FOR EACH ROW EXECUTE FUNCTION public.contract_cycles_validate();


--
-- Name: contract_document_versions contract_document_versions_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_document_versions_audit AFTER INSERT OR DELETE OR UPDATE ON public.contract_document_versions FOR EACH ROW EXECUTE FUNCTION public.contract_document_versions_audit_row();


--
-- Name: contract_document_versions contract_document_versions_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_document_versions_before_insert BEFORE INSERT ON public.contract_document_versions FOR EACH ROW EXECUTE FUNCTION public.contract_document_versions_before_insert();


--
-- Name: contract_document_versions contract_document_versions_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_document_versions_guard BEFORE DELETE OR UPDATE ON public.contract_document_versions FOR EACH ROW EXECUTE FUNCTION public.contract_document_versions_guard();


--
-- Name: contract_document_versions contract_document_versions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_document_versions_set_updated_at BEFORE UPDATE ON public.contract_document_versions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contract_documents contract_documents_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_documents_audit AFTER INSERT OR DELETE OR UPDATE ON public.contract_documents FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: contract_documents contract_documents_current_version_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER contract_documents_current_version_check AFTER INSERT OR UPDATE OF current_version_id ON public.contract_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contract_documents_current_version_check();


--
-- Name: contract_documents contract_documents_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_documents_set_updated_at BEFORE UPDATE ON public.contract_documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contract_documents contract_documents_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_documents_validate BEFORE INSERT OR UPDATE ON public.contract_documents FOR EACH ROW EXECUTE FUNCTION public.contract_documents_validate();


--
-- Name: contract_renewal_tasks contract_renewal_tasks_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_renewal_tasks_audit AFTER INSERT OR DELETE OR UPDATE ON public.contract_renewal_tasks FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: contract_renewal_tasks contract_renewal_tasks_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER contract_renewal_tasks_integrity_check AFTER INSERT OR DELETE OR UPDATE OF status, contract_id ON public.contract_renewal_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contract_refs_integrity_check();


--
-- Name: contract_renewal_tasks contract_renewal_tasks_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_renewal_tasks_set_updated_at BEFORE UPDATE ON public.contract_renewal_tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contract_renewal_tasks contract_renewal_tasks_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_renewal_tasks_validate BEFORE INSERT OR UPDATE ON public.contract_renewal_tasks FOR EACH ROW EXECUTE FUNCTION public.contract_renewal_tasks_validate();


--
-- Name: contracts contracts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contracts_audit AFTER INSERT OR DELETE OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: contracts contracts_renewal_pending_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER contracts_renewal_pending_check AFTER INSERT OR UPDATE OF status ON public.contracts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contracts_status_integrity_check();


--
-- Name: contracts contracts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contracts contracts_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contracts_validate BEFORE INSERT OR DELETE OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.contracts_validate();


--
-- Name: entities entities_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entities_audit AFTER INSERT OR DELETE OR UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entities entities_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entities_set_updated_at BEFORE UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_addresses entity_addresses_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_addresses_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_addresses FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_addresses entity_addresses_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_addresses_set_updated_at BEFORE UPDATE ON public.entity_addresses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_attachments entity_attachments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_attachments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_attachments entity_attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_attachments_set_updated_at BEFORE UPDATE ON public.entity_attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_bank_accounts entity_bank_accounts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_bank_accounts_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_bank_accounts entity_bank_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_bank_accounts_set_updated_at BEFORE UPDATE ON public.entity_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_contacts entity_contacts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_contacts_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_contacts FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_contacts entity_contacts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_contacts_set_updated_at BEFORE UPDATE ON public.entity_contacts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_links entity_links_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_links_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_links FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_links entity_links_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_links_set_updated_at BEFORE UPDATE ON public.entity_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_pix_keys entity_pix_keys_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_pix_keys_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_pix_keys FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_pix_keys entity_pix_keys_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_pix_keys_set_updated_at BEFORE UPDATE ON public.entity_pix_keys FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_tag_links entity_tag_links_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_tag_links_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_tag_links FOR EACH ROW EXECUTE FUNCTION public.entity_tag_links_audit_row();


--
-- Name: entity_tag_links entity_tag_links_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_tag_links_set_updated_at BEFORE UPDATE ON public.entity_tag_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_tag_links entity_tag_links_tag_active_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_tag_links_tag_active_check BEFORE INSERT OR UPDATE OF tag_id ON public.entity_tag_links FOR EACH ROW EXECUTE FUNCTION public.entity_tag_links_tag_active();


--
-- Name: entity_tags entity_tags_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_tags_audit AFTER INSERT OR DELETE OR UPDATE ON public.entity_tags FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: entity_tags entity_tags_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_tags_set_updated_at BEFORE UPDATE ON public.entity_tags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: financial_accounts financial_accounts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_audit AFTER INSERT OR DELETE OR UPDATE ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: financial_accounts financial_accounts_period_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_period_lock BEFORE UPDATE OF opening_balance_cents, opening_date ON public.financial_accounts FOR EACH ROW WHEN (((new.opening_balance_cents IS DISTINCT FROM old.opening_balance_cents) OR (new.opening_date IS DISTINCT FROM old.opening_date))) EXECUTE FUNCTION public.financial_accounts_period_lock();


--
-- Name: financial_accounts financial_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_set_updated_at BEFORE UPDATE ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: financial_accounts financial_accounts_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_validate BEFORE INSERT OR UPDATE OF caixa_id ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION public.financial_accounts_validate();


--
-- Name: financial_accounts financial_accounts_validate_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_validate_history BEFORE UPDATE OF caixa_id, opening_date ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION public.financial_accounts_validate_history();


--
-- Name: mcp_servers mcp_servers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mcp_servers_audit AFTER INSERT OR DELETE OR UPDATE ON public.mcp_servers FOR EACH ROW EXECUTE FUNCTION public.audit_row('tools_cache,tools_cached_at,tools_error,instructions_cache');


--
-- Name: mcp_servers mcp_servers_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mcp_servers_set_updated_at BEFORE UPDATE ON public.mcp_servers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: message_destinations message_destinations_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_destinations_audit AFTER INSERT OR DELETE OR UPDATE ON public.message_destinations FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: message_destinations message_destinations_cancel_pending; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_destinations_cancel_pending AFTER UPDATE OF is_active, archived_at ON public.message_destinations FOR EACH ROW WHEN (((NOT new.is_active) OR (new.archived_at IS NOT NULL))) EXECUTE FUNCTION public.message_destinations_cancel_pending();


--
-- Name: message_destinations message_destinations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_destinations_set_updated_at BEFORE UPDATE ON public.message_destinations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: message_outbox message_outbox_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_outbox_set_updated_at BEFORE UPDATE ON public.message_outbox FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: message_outbox message_outbox_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_outbox_validate BEFORE INSERT OR UPDATE ON public.message_outbox FOR EACH ROW EXECUTE FUNCTION public.message_outbox_validate();


--
-- Name: message_subscription_caixas message_subscription_caixas_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_subscription_caixas_audit AFTER INSERT OR DELETE OR UPDATE ON public.message_subscription_caixas FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: message_subscription_caixas message_subscription_caixas_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_subscription_caixas_set_updated_at BEFORE UPDATE ON public.message_subscription_caixas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: message_subscriptions message_subscriptions_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_subscriptions_audit AFTER INSERT OR DELETE OR UPDATE ON public.message_subscriptions FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: message_subscriptions message_subscriptions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_subscriptions_set_updated_at BEFORE UPDATE ON public.message_subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: movement_attachments movement_attachments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movement_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.movement_attachments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: movement_attachments movement_attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movement_attachments_set_updated_at BEFORE UPDATE ON public.movement_attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: movements movements_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_audit AFTER INSERT OR DELETE OR UPDATE ON public.movements FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: movements movements_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER movements_integrity_check AFTER INSERT OR DELETE OR UPDATE ON public.movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.movements_integrity_check();


--
-- Name: movements movements_period_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_period_lock BEFORE INSERT OR DELETE OR UPDATE ON public.movements FOR EACH ROW EXECUTE FUNCTION public.movements_period_lock();


--
-- Name: movements movements_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_set_updated_at BEFORE UPDATE ON public.movements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: movements movements_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_validate BEFORE INSERT OR UPDATE ON public.movements FOR EACH ROW EXECUTE FUNCTION public.movements_validate();


--
-- Name: movements movements_validate_statement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_validate_statement BEFORE UPDATE OF financial_account_id, amount_cents ON public.movements FOR EACH ROW EXECUTE FUNCTION public.movements_validate_statement();


--
-- Name: nfe_documents nfe_documents_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER nfe_documents_audit AFTER INSERT OR DELETE OR UPDATE ON public.nfe_documents FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: nfe_documents nfe_documents_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER nfe_documents_set_updated_at BEFORE UPDATE ON public.nfe_documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: nfe_items nfe_items_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER nfe_items_audit AFTER INSERT OR DELETE OR UPDATE ON public.nfe_items FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: nfe_items nfe_items_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER nfe_items_set_updated_at BEFORE UPDATE ON public.nfe_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: notifications notifications_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: period_closings period_closings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_closings_audit AFTER INSERT OR DELETE OR UPDATE ON public.period_closings FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: period_closings period_closings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_closings_set_updated_at BEFORE UPDATE ON public.period_closings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: period_closings period_closings_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_closings_validate BEFORE DELETE OR UPDATE ON public.period_closings FOR EACH ROW EXECUTE FUNCTION public.period_closings_validate();


--
-- Name: recurrence_rules recurrence_rules_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurrence_rules_audit AFTER INSERT OR DELETE OR UPDATE ON public.recurrence_rules FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: recurrence_rules recurrence_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurrence_rules_set_updated_at BEFORE UPDATE ON public.recurrence_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: recurrence_rules recurrence_rules_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurrence_rules_validate BEFORE UPDATE OF installments_total ON public.recurrence_rules FOR EACH ROW EXECUTE FUNCTION public.recurrence_rules_validate();


--
-- Name: settlement_attachments settlement_attachments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlement_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.settlement_attachments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: settlement_attachments settlement_attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlement_attachments_set_updated_at BEFORE UPDATE ON public.settlement_attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: settlements settlements_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_audit AFTER INSERT OR DELETE OR UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: settlements settlements_mirror_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER settlements_mirror_check AFTER INSERT OR UPDATE OF mirror_settlement_id, reversed_at ON public.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.settlements_mirror_check();


--
-- Name: settlements settlements_movements_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER settlements_movements_check AFTER INSERT OR UPDATE OF financial_account_id, reversed_at ON public.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.settlements_movements_check();


--
-- Name: settlements settlements_period_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_period_lock BEFORE INSERT OR DELETE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.settlements_period_lock();


--
-- Name: settlements settlements_refresh_title_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_refresh_title_status AFTER INSERT OR DELETE OR UPDATE OF reversed_at ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.settlements_refresh_title_status();


--
-- Name: settlements settlements_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_set_updated_at BEFORE UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: settlements settlements_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlements_validate BEFORE INSERT OR UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION public.settlements_validate();


--
-- Name: statement_csv_mappings statement_csv_mappings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_csv_mappings_audit AFTER INSERT OR DELETE OR UPDATE ON public.statement_csv_mappings FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: statement_csv_mappings statement_csv_mappings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_csv_mappings_set_updated_at BEFORE UPDATE ON public.statement_csv_mappings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: statement_csv_mappings statement_csv_mappings_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_csv_mappings_validate BEFORE INSERT OR UPDATE OF financial_account_id, card_caixa_id ON public.statement_csv_mappings FOR EACH ROW EXECUTE FUNCTION public.statement_csv_mappings_validate();


--
-- Name: statement_imports statement_imports_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_imports_audit AFTER INSERT OR DELETE OR UPDATE ON public.statement_imports FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: statement_imports statement_imports_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_imports_set_updated_at BEFORE UPDATE ON public.statement_imports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: statement_imports statement_imports_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_imports_validate BEFORE INSERT OR UPDATE ON public.statement_imports FOR EACH ROW EXECUTE FUNCTION public.statement_imports_validate();


--
-- Name: statement_lines statement_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: statement_lines statement_lines_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_set_updated_at BEFORE UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: statement_lines statement_lines_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_validate BEFORE INSERT OR UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.statement_lines_validate();


--
-- Name: title_attachments title_attachments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER title_attachments_audit AFTER INSERT OR DELETE OR UPDATE ON public.title_attachments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: title_attachments title_attachments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER title_attachments_set_updated_at BEFORE UPDATE ON public.title_attachments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: titles titles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_audit AFTER INSERT OR DELETE OR UPDATE ON public.titles FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: titles titles_card_invoice_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER titles_card_invoice_integrity_check AFTER INSERT OR DELETE OR UPDATE OF card_invoice_id, caixa_id, counterparty_caixa_id, amount_cents, status ON public.titles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.titles_card_invoice_integrity_check();


--
-- Name: titles titles_contract_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER titles_contract_integrity_check AFTER INSERT OR UPDATE OF contract_id ON public.titles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contract_refs_integrity_check();


--
-- Name: titles titles_mirror_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER titles_mirror_check AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin, recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status, card_invoice_id, contract_id, contract_cycle_id, contract_installment ON public.titles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.titles_mirror_check();


--
-- Name: titles titles_period_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_period_lock BEFORE INSERT OR DELETE OR UPDATE ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_period_lock();


--
-- Name: titles titles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_set_updated_at BEFORE UPDATE ON public.titles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: titles titles_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate BEFORE INSERT OR UPDATE ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate();


--
-- Name: titles titles_validate_card_invoice; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate_card_invoice BEFORE INSERT OR UPDATE OF card_invoice_id, caixa_id, direction, counterparty_caixa_id ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate_card_invoice();


--
-- Name: titles titles_validate_contract; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate_contract BEFORE INSERT OR UPDATE OF contract_id, contract_cycle_id, contract_installment, caixa_id, direction, entity_id, counterparty_caixa_id, mirror_status ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate_contract();


--
-- Name: titles titles_validate_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate_status BEFORE INSERT OR UPDATE OF caixa_id, amount_cents, status ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate_status();


--
-- Name: transfers transfers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transfers_audit AFTER INSERT OR DELETE OR UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: transfers transfers_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER transfers_integrity_check AFTER INSERT OR UPDATE ON public.transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.transfers_integrity_check();


--
-- Name: transfers transfers_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transfers_set_updated_at BEFORE UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_ai_settings user_ai_settings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_ai_settings_audit AFTER INSERT OR DELETE OR UPDATE ON public.user_ai_settings FOR EACH ROW EXECUTE FUNCTION public.user_ai_settings_audit_row();


--
-- Name: user_ai_settings user_ai_settings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_ai_settings_set_updated_at BEFORE UPDATE ON public.user_ai_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_ai_settings user_ai_settings_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_ai_settings_validate BEFORE INSERT OR UPDATE ON public.user_ai_settings FOR EACH ROW EXECUTE FUNCTION public.user_ai_settings_validate();


--
-- Name: user_api_tokens user_api_tokens_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_api_tokens_audit AFTER INSERT OR DELETE OR UPDATE ON public.user_api_tokens FOR EACH ROW EXECUTE FUNCTION public.audit_row('last_used_at,last_used_ip');


--
-- Name: user_api_tokens user_api_tokens_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_api_tokens_set_updated_at BEFORE UPDATE ON public.user_api_tokens FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_api_tokens user_api_tokens_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_api_tokens_validate BEFORE UPDATE ON public.user_api_tokens FOR EACH ROW EXECUTE FUNCTION public.user_api_tokens_validate();


--
-- Name: users users_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_audit AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.audit_row('last_login_at');


--
-- Name: users users_revoke_sessions_on_deactivate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_revoke_sessions_on_deactivate AFTER UPDATE OF is_active ON public.users FOR EACH ROW WHEN ((old.is_active AND (NOT new.is_active))) EXECUTE FUNCTION public.users_revoke_sessions_on_deactivate();


--
-- Name: users users_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: agent_mcp_servers agent_mcp_servers_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE CASCADE;


--
-- Name: agent_mcp_servers agent_mcp_servers_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_mcp_servers
    ADD CONSTRAINT agent_mcp_servers_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: ai_agent_inferences ai_agent_inferences_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_inferences
    ADD CONSTRAINT ai_agent_inferences_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE CASCADE;


--
-- Name: ai_agent_inferences ai_agent_inferences_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_inferences
    ADD CONSTRAINT ai_agent_inferences_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id);


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_prompt_versions
    ADD CONSTRAINT ai_agent_prompt_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE CASCADE;


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_prompt_versions
    ADD CONSTRAINT ai_agent_prompt_versions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_agent_prompt_versions ai_agent_prompt_versions_restored_from_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_prompt_versions
    ADD CONSTRAINT ai_agent_prompt_versions_restored_from_version_id_fkey FOREIGN KEY (restored_from_version_id, agent_id) REFERENCES public.ai_agent_prompt_versions(id, agent_id);


--
-- Name: ai_agents ai_agents_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agents
    ADD CONSTRAINT ai_agents_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_agents ai_agents_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agents
    ADD CONSTRAINT ai_agents_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id);


--
-- Name: ai_agents ai_agents_tool_kit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agents
    ADD CONSTRAINT ai_agents_tool_kit_id_fkey FOREIGN KEY (tool_kit_id) REFERENCES public.ai_tool_kits(id);


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.ai_messages(id) ON DELETE CASCADE;


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id) ON DELETE CASCADE;


--
-- Name: ai_attachment_derivatives ai_attachment_derivatives_result_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_result_attachment_id_fkey FOREIGN KEY (result_attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: ai_conversations ai_conversations_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id);


--
-- Name: ai_conversations ai_conversations_forked_from_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_forked_from_message_fkey FOREIGN KEY (forked_from_conversation_id, forked_from_message_id) REFERENCES public.ai_messages(conversation_id, id) MATCH FULL ON DELETE SET NULL;


--
-- Name: ai_conversations ai_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_embedding_indexes ai_embedding_indexes_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embedding_indexes
    ADD CONSTRAINT ai_embedding_indexes_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id) ON DELETE CASCADE;


--
-- Name: ai_embeddings ai_embeddings_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embeddings
    ADD CONSTRAINT ai_embeddings_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: ai_embeddings ai_embeddings_index_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embeddings
    ADD CONSTRAINT ai_embeddings_index_fkey FOREIGN KEY (provider_id, model) REFERENCES public.ai_embedding_indexes(provider_id, model) ON DELETE CASCADE;


--
-- Name: ai_message_attachments ai_message_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_message_attachments
    ADD CONSTRAINT ai_message_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: ai_message_attachments ai_message_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_message_attachments
    ADD CONSTRAINT ai_message_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.ai_messages(id) ON DELETE CASCADE;


--
-- Name: ai_messages ai_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;


--
-- Name: ai_messages ai_messages_run_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_run_fkey FOREIGN KEY (conversation_id, run_id) REFERENCES public.ai_runs(conversation_id, id) ON DELETE SET NULL (run_id);


--
-- Name: ai_model_prices ai_model_prices_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_prices
    ADD CONSTRAINT ai_model_prices_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id) ON DELETE CASCADE;


--
-- Name: ai_providers ai_providers_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_providers
    ADD CONSTRAINT ai_providers_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_request_attempts ai_request_attempts_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_request_attempts
    ADD CONSTRAINT ai_request_attempts_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.ai_requests(id) ON DELETE CASCADE;


--
-- Name: ai_requests ai_requests_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE SET NULL;


--
-- Name: ai_requests ai_requests_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE SET NULL;


--
-- Name: ai_requests ai_requests_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id) ON DELETE SET NULL;


--
-- Name: ai_requests ai_requests_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_runs(id) ON DELETE SET NULL;


--
-- Name: ai_requests ai_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_run_events ai_run_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_run_events
    ADD CONSTRAINT ai_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_runs(id) ON DELETE CASCADE;


--
-- Name: ai_runs ai_runs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id);


--
-- Name: ai_runs ai_runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;


--
-- Name: ai_runs ai_runs_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id);


--
-- Name: ai_runs ai_runs_trigger_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_trigger_message_fkey FOREIGN KEY (conversation_id, trigger_message_id) REFERENCES public.ai_messages(conversation_id, id) ON DELETE SET NULL (trigger_message_id);


--
-- Name: ai_runs ai_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_runs
    ADD CONSTRAINT ai_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_tool_confirmations ai_tool_confirmations_decided_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_confirmations
    ADD CONSTRAINT ai_tool_confirmations_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_tool_confirmations ai_tool_confirmations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_confirmations
    ADD CONSTRAINT ai_tool_confirmations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_runs(id) ON DELETE CASCADE;


--
-- Name: ai_tool_kit_tools ai_tool_kit_tools_kit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_kit_tools
    ADD CONSTRAINT ai_tool_kit_tools_kit_id_fkey FOREIGN KEY (kit_id) REFERENCES public.ai_tool_kits(id) ON DELETE CASCADE;


--
-- Name: ai_tool_kits ai_tool_kits_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_kits
    ADD CONSTRAINT ai_tool_kits_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_usage ai_usage_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id);


--
-- Name: ai_usage ai_usage_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE SET NULL;


--
-- Name: ai_usage ai_usage_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.ai_messages(id) ON DELETE SET NULL;


--
-- Name: ai_usage ai_usage_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_price_id_fkey FOREIGN KEY (price_id) REFERENCES public.ai_model_prices(id);


--
-- Name: ai_usage ai_usage_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id);


--
-- Name: ai_usage ai_usage_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.ai_requests(id) ON DELETE SET NULL NOT VALID;


--
-- Name: ai_usage ai_usage_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_runs(id) ON DELETE SET NULL;


--
-- Name: ai_usage ai_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: app_settings app_settings_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: attachments attachments_uploaded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: caixa_hidden_categories caixa_hidden_categories_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_hidden_categories
    ADD CONSTRAINT caixa_hidden_categories_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: caixa_hidden_categories caixa_hidden_categories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_hidden_categories
    ADD CONSTRAINT caixa_hidden_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: caixa_members caixa_members_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_members
    ADD CONSTRAINT caixa_members_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: caixa_members caixa_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixa_members
    ADD CONSTRAINT caixa_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: caixas caixas_default_payer_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixas
    ADD CONSTRAINT caixas_default_payer_caixa_id_fkey FOREIGN KEY (default_payer_caixa_id) REFERENCES public.caixas(id);


--
-- Name: caixas caixas_holder_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caixas
    ADD CONSTRAINT caixas_holder_entity_id_fkey FOREIGN KEY (holder_entity_id) REFERENCES public.entities(id);


--
-- Name: canvas_node_positions canvas_node_positions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_node_positions
    ADD CONSTRAINT canvas_node_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: card_invoice_items card_invoice_items_card_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_card_invoice_id_fkey FOREIGN KEY (card_invoice_id) REFERENCES public.card_invoices(id);


--
-- Name: card_invoice_items card_invoice_items_card_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_card_purchase_id_fkey FOREIGN KEY (card_purchase_id) REFERENCES public.card_purchases(id) ON DELETE CASCADE;


--
-- Name: card_invoice_items card_invoice_items_carried_from_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_carried_from_invoice_id_fkey FOREIGN KEY (carried_from_invoice_id) REFERENCES public.card_invoices(id);


--
-- Name: card_invoice_items card_invoice_items_payer_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoice_items
    ADD CONSTRAINT card_invoice_items_payer_caixa_id_fkey FOREIGN KEY (payer_caixa_id) REFERENCES public.caixas(id);


--
-- Name: card_invoices card_invoices_card_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_invoices
    ADD CONSTRAINT card_invoices_card_caixa_id_fkey FOREIGN KEY (card_caixa_id) REFERENCES public.caixas(id);


--
-- Name: card_purchase_attachments card_purchase_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchase_attachments
    ADD CONSTRAINT card_purchase_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: card_purchase_attachments card_purchase_attachments_card_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchase_attachments
    ADD CONSTRAINT card_purchase_attachments_card_purchase_id_fkey FOREIGN KEY (card_purchase_id) REFERENCES public.card_purchases(id) ON DELETE CASCADE;


--
-- Name: card_purchases card_purchases_card_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_card_caixa_id_fkey FOREIGN KEY (card_caixa_id) REFERENCES public.caixas(id);


--
-- Name: card_purchases card_purchases_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: card_purchases card_purchases_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: card_purchases card_purchases_payer_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_payer_caixa_id_fkey FOREIGN KEY (payer_caixa_id) REFERENCES public.caixas(id);


--
-- Name: card_purchases card_purchases_refunded_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_refunded_purchase_id_fkey FOREIGN KEY (refunded_purchase_id) REFERENCES public.card_purchases(id);


--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id);


--
-- Name: classification_rules classification_rules_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: classification_rules classification_rules_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: classification_rules classification_rules_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: classification_rules classification_rules_created_from_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_created_from_line_id_fkey FOREIGN KEY (created_from_line_id) REFERENCES public.statement_lines(id) ON DELETE SET NULL;


--
-- Name: classification_rules classification_rules_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: contract_amendments contract_amendments_contract_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_amendments
    ADD CONSTRAINT contract_amendments_contract_cycle_id_fkey FOREIGN KEY (contract_cycle_id, contract_id) REFERENCES public.contract_cycles(id, contract_id);


--
-- Name: contract_amendments contract_amendments_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_amendments
    ADD CONSTRAINT contract_amendments_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id);


--
-- Name: contract_amendments contract_amendments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_amendments
    ADD CONSTRAINT contract_amendments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_amendments contract_amendments_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_amendments
    ADD CONSTRAINT contract_amendments_document_id_fkey FOREIGN KEY (document_id, contract_id) REFERENCES public.contract_documents(id, contract_id);


--
-- Name: contract_cycles contract_cycles_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_cycles
    ADD CONSTRAINT contract_cycles_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_document_versions contract_document_versions_ai_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_ai_run_id_fkey FOREIGN KEY (ai_run_id) REFERENCES public.ai_runs(id) ON DELETE SET NULL;


--
-- Name: contract_document_versions contract_document_versions_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_document_versions contract_document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.contract_documents(id) ON DELETE CASCADE;


--
-- Name: contract_document_versions contract_document_versions_restored_from_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_restored_from_version_id_fkey FOREIGN KEY (restored_from_version_id, document_id) REFERENCES public.contract_document_versions(id, document_id);


--
-- Name: contract_documents contract_documents_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id);


--
-- Name: contract_documents contract_documents_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id);


--
-- Name: contract_documents contract_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_documents contract_documents_current_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_current_version_id_fkey FOREIGN KEY (current_version_id, id) REFERENCES public.contract_document_versions(id, document_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: contract_documents contract_documents_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_documents
    ADD CONSTRAINT contract_documents_source_document_id_fkey FOREIGN KEY (source_document_id, contract_id) REFERENCES public.contract_documents(id, contract_id);


--
-- Name: contract_renewal_tasks contract_renewal_tasks_contract_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_renewal_tasks
    ADD CONSTRAINT contract_renewal_tasks_contract_cycle_id_fkey FOREIGN KEY (contract_cycle_id, contract_id) REFERENCES public.contract_cycles(id, contract_id);


--
-- Name: contract_renewal_tasks contract_renewal_tasks_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_renewal_tasks
    ADD CONSTRAINT contract_renewal_tasks_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id);


--
-- Name: contract_renewal_tasks contract_renewal_tasks_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_renewal_tasks
    ADD CONSTRAINT contract_renewal_tasks_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_renewal_tasks contract_renewal_tasks_new_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_renewal_tasks
    ADD CONSTRAINT contract_renewal_tasks_new_cycle_id_fkey FOREIGN KEY (new_cycle_id, contract_id) REFERENCES public.contract_cycles(id, contract_id);


--
-- Name: contracts contracts_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: contracts contracts_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: contracts contracts_counterparty_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_counterparty_caixa_id_fkey FOREIGN KEY (counterparty_caixa_id) REFERENCES public.caixas(id);


--
-- Name: contracts contracts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: entity_addresses entity_addresses_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_addresses
    ADD CONSTRAINT entity_addresses_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_attachments entity_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_attachments
    ADD CONSTRAINT entity_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: entity_attachments entity_attachments_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_attachments
    ADD CONSTRAINT entity_attachments_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_bank_accounts entity_bank_accounts_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_bank_accounts
    ADD CONSTRAINT entity_bank_accounts_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_contacts entity_contacts_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_contacts
    ADD CONSTRAINT entity_contacts_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_links entity_links_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_links entity_links_related_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_related_entity_id_fkey FOREIGN KEY (related_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_pix_keys entity_pix_keys_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_pix_keys
    ADD CONSTRAINT entity_pix_keys_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_tag_links entity_tag_links_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tag_links
    ADD CONSTRAINT entity_tag_links_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_tag_links entity_tag_links_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_tag_links
    ADD CONSTRAINT entity_tag_links_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.entity_tags(id);


--
-- Name: financial_accounts financial_accounts_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_accounts
    ADD CONSTRAINT financial_accounts_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: mcp_servers mcp_servers_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: message_destinations message_destinations_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_destinations
    ADD CONSTRAINT message_destinations_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: message_destinations message_destinations_owner_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_destinations
    ADD CONSTRAINT message_destinations_owner_caixa_id_fkey FOREIGN KEY (owner_caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: message_destinations message_destinations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_destinations
    ADD CONSTRAINT message_destinations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: message_outbox message_outbox_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_outbox
    ADD CONSTRAINT message_outbox_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE SET NULL;


--
-- Name: message_outbox message_outbox_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_outbox
    ADD CONSTRAINT message_outbox_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.message_destinations(id);


--
-- Name: message_outbox message_outbox_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_outbox
    ADD CONSTRAINT message_outbox_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.message_subscriptions(id) ON DELETE SET NULL;


--
-- Name: message_outbox message_outbox_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_outbox
    ADD CONSTRAINT message_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: message_subscription_caixas message_subscription_caixas_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscription_caixas
    ADD CONSTRAINT message_subscription_caixas_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: message_subscription_caixas message_subscription_caixas_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscription_caixas
    ADD CONSTRAINT message_subscription_caixas_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.message_subscriptions(id) ON DELETE CASCADE;


--
-- Name: message_subscriptions message_subscriptions_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_subscriptions
    ADD CONSTRAINT message_subscriptions_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.message_destinations(id) ON DELETE CASCADE;


--
-- Name: movement_attachments movement_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movement_attachments
    ADD CONSTRAINT movement_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: movement_attachments movement_attachments_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movement_attachments
    ADD CONSTRAINT movement_attachments_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.movements(id) ON DELETE CASCADE;


--
-- Name: movements movements_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: movements movements_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: movements movements_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id);


--
-- Name: movements movements_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id);


--
-- Name: movements movements_transfer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES public.transfers(id) ON DELETE CASCADE;


--
-- Name: nfe_documents nfe_documents_issuer_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_documents
    ADD CONSTRAINT nfe_documents_issuer_entity_id_fkey FOREIGN KEY (issuer_entity_id) REFERENCES public.entities(id);


--
-- Name: nfe_documents nfe_documents_recipient_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_documents
    ADD CONSTRAINT nfe_documents_recipient_entity_id_fkey FOREIGN KEY (recipient_entity_id) REFERENCES public.entities(id);


--
-- Name: nfe_documents nfe_documents_xml_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_documents
    ADD CONSTRAINT nfe_documents_xml_attachment_id_fkey FOREIGN KEY (xml_attachment_id) REFERENCES public.attachments(id);


--
-- Name: nfe_items nfe_items_nfe_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfe_items
    ADD CONSTRAINT nfe_items_nfe_document_id_fkey FOREIGN KEY (nfe_document_id) REFERENCES public.nfe_documents(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: period_closings period_closings_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_closings
    ADD CONSTRAINT period_closings_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: period_closings period_closings_closed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_closings
    ADD CONSTRAINT period_closings_closed_by_user_id_fkey FOREIGN KEY (closed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: settlement_attachments settlement_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_attachments
    ADD CONSTRAINT settlement_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: settlement_attachments settlement_attachments_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_attachments
    ADD CONSTRAINT settlement_attachments_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id) ON DELETE CASCADE;


--
-- Name: settlements settlements_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id);


--
-- Name: settlements settlements_mirror_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_mirror_settlement_id_fkey FOREIGN KEY (mirror_settlement_id) REFERENCES public.settlements(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: settlements settlements_title_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_title_id_fkey FOREIGN KEY (title_id) REFERENCES public.titles(id);


--
-- Name: statement_csv_mappings statement_csv_mappings_card_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_csv_mappings
    ADD CONSTRAINT statement_csv_mappings_card_caixa_id_fkey FOREIGN KEY (card_caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: statement_csv_mappings statement_csv_mappings_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_csv_mappings
    ADD CONSTRAINT statement_csv_mappings_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id) ON DELETE CASCADE;


--
-- Name: statement_imports statement_imports_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id);


--
-- Name: statement_imports statement_imports_card_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_card_caixa_id_fkey FOREIGN KEY (card_caixa_id) REFERENCES public.caixas(id);


--
-- Name: statement_imports statement_imports_card_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_card_invoice_id_fkey FOREIGN KEY (card_invoice_id) REFERENCES public.card_invoices(id);


--
-- Name: statement_imports statement_imports_csv_mapping_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_csv_mapping_id_fkey FOREIGN KEY (csv_mapping_id) REFERENCES public.statement_csv_mappings(id) ON DELETE SET NULL;


--
-- Name: statement_imports statement_imports_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id);


--
-- Name: statement_imports statement_imports_imported_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_imported_by_user_id_fkey FOREIGN KEY (imported_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: statement_lines statement_lines_card_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_card_caixa_id_fkey FOREIGN KEY (card_caixa_id) REFERENCES public.caixas(id);


--
-- Name: statement_lines statement_lines_card_invoice_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_card_invoice_item_id_fkey FOREIGN KEY (card_invoice_item_id) REFERENCES public.card_invoice_items(id);


--
-- Name: statement_lines statement_lines_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: statement_lines statement_lines_classification_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_classification_rule_id_fkey FOREIGN KEY (classification_rule_id) REFERENCES public.classification_rules(id) ON DELETE SET NULL;


--
-- Name: statement_lines statement_lines_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: statement_lines statement_lines_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id);


--
-- Name: statement_lines statement_lines_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.movements(id);


--
-- Name: statement_lines statement_lines_statement_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_statement_import_id_fkey FOREIGN KEY (statement_import_id) REFERENCES public.statement_imports(id) ON DELETE CASCADE;


--
-- Name: statement_lines statement_lines_title_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_title_id_fkey FOREIGN KEY (title_id) REFERENCES public.titles(id);


--
-- Name: title_attachments title_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.title_attachments
    ADD CONSTRAINT title_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE;


--
-- Name: title_attachments title_attachments_title_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.title_attachments
    ADD CONSTRAINT title_attachments_title_id_fkey FOREIGN KEY (title_id) REFERENCES public.titles(id) ON DELETE CASCADE;


--
-- Name: titles titles_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: titles titles_card_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_card_invoice_id_fkey FOREIGN KEY (card_invoice_id) REFERENCES public.card_invoices(id);


--
-- Name: titles titles_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: titles titles_contract_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_contract_cycle_id_fkey FOREIGN KEY (contract_cycle_id, contract_id) REFERENCES public.contract_cycles(id, contract_id);


--
-- Name: titles titles_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id);


--
-- Name: titles titles_counterparty_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_counterparty_caixa_id_fkey FOREIGN KEY (counterparty_caixa_id) REFERENCES public.caixas(id);


--
-- Name: titles titles_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: titles titles_mirror_title_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_mirror_title_id_fkey FOREIGN KEY (mirror_title_id) REFERENCES public.titles(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: titles titles_nfe_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_nfe_document_id_fkey FOREIGN KEY (nfe_document_id) REFERENCES public.nfe_documents(id);


--
-- Name: titles titles_recurrence_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_recurrence_rule_id_fkey FOREIGN KEY (recurrence_rule_id) REFERENCES public.recurrence_rules(id);


--
-- Name: transfers transfers_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_from_account_id_fkey FOREIGN KEY (from_account_id) REFERENCES public.financial_accounts(id);


--
-- Name: transfers transfers_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_settlement_id_fkey FOREIGN KEY (settlement_id) REFERENCES public.settlements(id);


--
-- Name: transfers transfers_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_to_account_id_fkey FOREIGN KEY (to_account_id) REFERENCES public.financial_accounts(id);


--
-- Name: user_ai_settings user_ai_settings_primary_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_settings
    ADD CONSTRAINT user_ai_settings_primary_caixa_id_fkey FOREIGN KEY (primary_caixa_id) REFERENCES public.caixas(id) ON DELETE SET NULL;


--
-- Name: user_ai_settings user_ai_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_settings
    ADD CONSTRAINT user_ai_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_api_tokens user_api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_api_tokens
    ADD CONSTRAINT user_api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


