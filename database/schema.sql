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
-- Name: admin_message_destination_webhook_secret(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_message_destination_webhook_secret(p_destination_id uuid, p_actor_user_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  h text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users a
                  WHERE a.id = p_actor_user_id AND a.role = 'admin' AND a.is_active) THEN
    RAISE EXCEPTION 'admin_message_destination_webhook_secret: actor % is not an active admin', p_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.webhook_secret_hash INTO h FROM public.message_destinations d WHERE d.id = p_destination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_message_destination_webhook_secret: destination % not found', p_destination_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN h;
END
$$;


--
-- Name: FUNCTION admin_message_destination_webhook_secret(p_destination_id uuid, p_actor_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_message_destination_webhook_secret(p_destination_id uuid, p_actor_user_id uuid) IS 'Hash do segredo do webhook (webhook_secret_hash, nulo se nunca ligado) para o export de backup do admin. A importação traz o destino com inbound_enabled = false (o webhook é de outra instância e precisa ser religado, com um segredo novo). Erro 42501 se o ator não é admin ativo e P0002 se o destino não existe.';


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
-- Name: ai_budget_check(uuid, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_budget_check(p_user_id uuid, p_agent_id uuid, p_is_flow boolean) RETURNS TABLE(budget_id uuid, scope text, user_id uuid, agent_id uuid, currency text, monthly_limit_micros bigint, alert_percent integer, month date, spent_micros bigint, unpriced_calls integer, percent numeric, status text)
    LANGUAGE sql STABLE
    AS $$
  SELECT b.id, b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros, b.alert_percent,
         st.month, st.spent_micros, st.unpriced_calls, st.percent, st.status
    FROM ai_budgets b
   CROSS JOIN LATERAL ai_budget_state(b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros,
                                      b.alert_percent, NULL) st
   WHERE b.is_active
     AND (b.scope = 'global'
          OR (b.scope = 'flows' AND coalesce(p_is_flow, false))
          OR (b.scope = 'user' AND b.user_id = p_user_id)
          OR (b.scope = 'agent' AND b.agent_id = p_agent_id))
     AND st.status = 'blocked'
   ORDER BY array_position(ARRAY['global', 'flows', 'agent', 'user'], b.scope), b.currency, b.id
$$;


--
-- Name: FUNCTION ai_budget_check(p_user_id uuid, p_agent_id uuid, p_is_flow boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_budget_check(p_user_id uuid, p_agent_id uuid, p_is_flow boolean) IS 'Orçamentos ativos estourados (gasto >= valor no mês corrente de America/Sao_Paulo) que valem para uma execução: global, o do usuário (p_user_id; o uso dos fluxos dele conta), o do agente (p_agent_id) e, com p_is_flow (conversa com purpose <> chat), o flows. Nenhuma linha = pode seguir. A isenção do admin que aciona é da aplicação.';


--
-- Name: ai_budget_state(text, uuid, uuid, text, bigint, integer, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_budget_state(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text, p_limit_micros bigint, p_alert_percent integer, p_month date) RETURNS TABLE(month date, spent_micros bigint, unpriced_calls integer, percent numeric, status text)
    LANGUAGE sql STABLE
    AS $$
  SELECT m.month, s.spent_micros, s.unpriced_calls,
         round(s.spent_micros::numeric * 100 / p_limit_micros, 2),
         CASE WHEN s.spent_micros >= p_limit_micros THEN 'blocked'
              WHEN s.spent_micros::numeric * 100 >= p_limit_micros::numeric * p_alert_percent THEN 'alert'
              ELSE 'ok'
         END
    FROM (SELECT coalesce(date_trunc('month', p_month::timestamp),
                          date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'))::date
                   AS month) m
   CROSS JOIN LATERAL ai_budget_usage(p_scope, p_user_id, p_agent_id, p_currency,
                                      m.month::timestamp AT TIME ZONE 'America/Sao_Paulo',
                                      (m.month + interval '1 month') AT TIME ZONE 'America/Sao_Paulo') s
$$;


--
-- Name: FUNCTION ai_budget_state(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text, p_limit_micros bigint, p_alert_percent integer, p_month date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_budget_state(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text, p_limit_micros bigint, p_alert_percent integer, p_month date) IS 'Apoio de ai_budget_status/ai_budget_check: mês (1º dia; nulo = o mês corrente em America/Sao_Paulo), gasto, sem preço, percentual (2 casas) e situação: blocked com gasto >= valor, alert com gasto >= valor × aviso ÷ 100, senão ok.';


--
-- Name: ai_budget_status(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_budget_status(p_month date DEFAULT NULL::date) RETURNS TABLE(budget_id uuid, scope text, user_id uuid, agent_id uuid, currency text, monthly_limit_micros bigint, alert_percent integer, month date, spent_micros bigint, unpriced_calls integer, percent numeric, status text)
    LANGUAGE sql STABLE
    AS $$
  SELECT b.id, b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros, b.alert_percent,
         st.month, st.spent_micros, st.unpriced_calls, st.percent, st.status
    FROM ai_budgets b
   CROSS JOIN LATERAL ai_budget_state(b.scope, b.user_id, b.agent_id, b.currency, b.monthly_limit_micros,
                                      b.alert_percent, p_month) st
   WHERE b.is_active
   ORDER BY array_position(ARRAY['global', 'flows', 'agent', 'user'], b.scope), b.currency, b.id
$$;


--
-- Name: FUNCTION ai_budget_status(p_month date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_budget_status(p_month date) IS 'Situação de cada orçamento ativo no mês de p_month (qualquer dia do mês; nulo = o mês corrente em America/Sao_Paulo): gasto em micros na moeda do orçamento (uso sem preço e noutra moeda não contam), chamadas sem preço do escopo (unpriced_calls, para "N chamadas sem preço"), percentual e status ok|alert|blocked. Ordem: global, flows, agent, user.';


--
-- Name: ai_budget_usage(text, uuid, uuid, text, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_budget_usage(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text, p_from timestamp with time zone, p_to timestamp with time zone) RETURNS TABLE(spent_micros bigint, unpriced_calls integer)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  -- Uma consulta por escopo, para cada uma usar o seu índice (created_at; user_id, created_at; agent_id, created_at).
  CASE p_scope
    WHEN 'global' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
       WHERE u.created_at >= p_from AND u.created_at < p_to;
    WHEN 'user' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
       WHERE u.user_id = p_user_id AND u.created_at >= p_from AND u.created_at < p_to;
    WHEN 'agent' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
       WHERE u.agent_id = p_agent_id AND u.created_at >= p_from AND u.created_at < p_to;
    WHEN 'flows' THEN
      RETURN QUERY
      SELECT coalesce(sum(u.cost_micros) FILTER (WHERE u.currency = p_currency), 0)::bigint,
             (count(*) FILTER (WHERE u.cost_micros IS NULL))::integer
        FROM ai_usage u
        LEFT JOIN ai_conversations c ON c.id = u.conversation_id
       WHERE u.created_at >= p_from AND u.created_at < p_to
         AND ai_usage_is_flow(u.purpose, c.purpose);
    ELSE
      RAISE EXCEPTION 'ai_budget_usage: unknown scope %', p_scope USING ERRCODE = 'invalid_parameter_value';
  END CASE;
END
$$;


--
-- Name: FUNCTION ai_budget_usage(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text, p_from timestamp with time zone, p_to timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_budget_usage(p_scope text, p_user_id uuid, p_agent_id uuid, p_currency text, p_from timestamp with time zone, p_to timestamp with time zone) IS 'Apoio de ai_budget_status/ai_budget_check: gasto (soma de cost_micros na moeda informada) e chamadas sem preço (qualquer moeda) do escopo no intervalo [de, até). 22023 com escopo desconhecido.';


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
-- Name: ai_chat_sessions_consolidate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_chat_sessions_consolidate() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  extras uuid[];
BEGIN
  -- Sem escrita concorrente nas conversas enquanto escolhe a ativa de cada par.
  LOCK TABLE ai_conversations IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(array_agg(x.id), '{}') INTO extras
    FROM (SELECT c.id,
                 row_number() OVER (PARTITION BY c.user_id, c.agent_id
                                    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC) AS rn
            FROM ai_conversations c
           WHERE c.purpose = 'chat' AND c.archived_at IS NULL) x
   WHERE x.rn > 1;
  IF cardinality(extras) = 0 THEN
    RETURN 0;
  END IF;

  -- Execuções ativas das que serão arquivadas: na fila ou esperando confirmação, canceladas na hora; rodando, com o
  -- cancelamento pedido (o worker encerra como canceled no próximo heartbeat).
  UPDATE ai_runs r
     SET cancel_requested_at = coalesce(r.cancel_requested_at, now()),
         status = CASE WHEN r.status = 'running' THEN r.status ELSE 'canceled' END
   WHERE r.conversation_id = ANY (extras)
     AND r.status IN ('queued', 'running', 'awaiting_confirmation');

  UPDATE ai_conversations c
     SET archived_at = now(), archived_reason = 'migrated_from_multi'
   WHERE c.id = ANY (extras);
  RETURN cardinality(extras);
END
$$;


--
-- Name: FUNCTION ai_chat_sessions_consolidate(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_chat_sessions_consolidate() IS 'Manutenção da migração 0043 (spec 026), idempotente: para cada (usuário, agente) com mais de uma conversa chat ativa, mantém a de last_message_at mais recente (nulos por último; empate por created_at e id) e arquiva as outras com archived_reason = migrated_from_multi, encerrando as execuções ativas delas (queued e awaiting_confirmation viram canceled; running recebe cancel_requested_at). Nada é apagado. Devolve quantas arquivou. Só o dono do banco.';


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

  -- Finaliza a sessão ativa do mesmo (usuário, agente), que pode ser a própria origem. Com execução ativa sem
  -- cancelamento pedido, ai_conversations_archive_guard recusa (23514).
  UPDATE ai_conversations c
     SET archived_at = now(), archived_reason = 'forked'
   WHERE c.user_id = p_user_id AND c.agent_id = src.agent_id AND c.purpose = 'chat' AND c.archived_at IS NULL;

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

COMMENT ON FUNCTION public.ai_conversation_fork(p_message_id uuid, p_user_id uuid, p_title text) IS 'Bifurca: finaliza a sessão chat ativa de p_user_id com o agente da origem (archived_reason = forked; pode ser a própria origem) e cria a sessão nova, que vira a ativa, copiando as mensagens da origem até p_message_id (inclusive, mesmos seq, sem run_id; anexos religados); devolve o id. Título = p_title ou o da origem. A cópia é sempre purpose chat (sem a chave purpose no screen_context), mesmo vinda de uma conversa de fluxo. Corte a bifurcação numa mensagem que não deixe tool_use sem tool_result (a aplicação escolhe). P0002 se a mensagem não existe; 23514 ai_conversations_archive_active_run_check se a sessão ativa tem execução ativa sem cancelamento pedido; 23505 se outra transação criou a ativa do par ao mesmo tempo.';


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
-- Name: ai_conversations_archive_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_conversations_archive_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'ai_conversations: session % is finished and cannot become active again (fork it instead)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_conversations_unarchive_check';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM ai_runs r
                  WHERE r.conversation_id = NEW.id
                    AND r.status IN ('queued', 'running', 'awaiting_confirmation')
                    AND r.cancel_requested_at IS NULL) THEN
    RAISE EXCEPTION 'ai_conversations: session % has an active run; request its cancellation before finishing', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_conversations_archive_active_run_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: FUNCTION ai_conversations_archive_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_conversations_archive_guard() IS 'Trigger das sessões chat (spec 026): arquivada não volta a ativa (23514 ai_conversations_unarchive_check); arquivar com execução ativa (queued, running, awaiting_confirmation) só com cancel_requested_at já preenchido (23514 ai_conversations_archive_active_run_check). Conversas de fluxo (purpose <> chat) ficam de fora.';


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
-- Name: ai_reconcile_import_busy(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_import_busy(p_import_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (SELECT 1 FROM ai_conversations c
                   JOIN ai_runs r ON r.conversation_id = c.id
                  WHERE c.purpose = 'reconcile_statement' AND c.screen_context ->> 'importId' = p_import_id::text
                    AND r.status IN ('queued', 'running', 'awaiting_confirmation'))
      OR EXISTS (SELECT 1 FROM ai_reconcile_recipe_runs x
                  WHERE x.import_id = p_import_id AND x.status = 'started' AND x.run_id IS NULL
                    AND x.started_at > clock_timestamp() - interval '10 minutes')
$$;


--
-- Name: FUNCTION ai_reconcile_import_busy(p_import_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_import_busy(p_import_id uuid) IS 'true se o lote tem execução ativa: uma conversa reconcile_statement com screen_context.importId = lote e uma ai_runs queued/running/awaiting_confirmation, ou uma execução de receita started há menos de 10 min ainda sem a ai_runs (recém-reservada). O play responde 409 com true.';


--
-- Name: ai_reconcile_import_limit_check(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_import_limit_check(p_recipe_id uuid, p_account_id uuid, p_card_caixa_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Trava por conta/cartão: serializa vínculos e ativações concorrentes do mesmo alvo.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ai_reconcile_recipe_targets:' || coalesce(p_account_id, p_card_caixa_id)::text, 0));
  IF (SELECT count(DISTINCT r.id)
        FROM ai_reconcile_recipe_targets t
        JOIN ai_reconcile_recipes r ON r.id = t.recipe_id
       WHERE r.run_on_import AND r.archived_at IS NULL AND r.id <> p_recipe_id
         AND (t.financial_account_id = p_account_id OR t.card_caixa_id = p_card_caixa_id)) >= 10 THEN
    RAISE EXCEPTION 'ai_reconcile_recipe_targets: account/card % already has 10 recipes run on import',
      coalesce(p_account_id, p_card_caixa_id)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_import_limit_check';
  END IF;
END
$$;


--
-- Name: FUNCTION ai_reconcile_import_limit_check(p_recipe_id uuid, p_account_id uuid, p_card_caixa_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_import_limit_check(p_recipe_id uuid, p_account_id uuid, p_card_caixa_id uuid) IS 'Interna: recusa (23514 ai_reconcile_recipe_targets_import_limit_check) quando a conta ou o cartão já tem 10 outras receitas não arquivadas com run_on_import. Trava o alvo (advisory lock) antes de contar.';


--
-- Name: ai_reconcile_import_lock(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_import_lock(p_import_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ai_reconcile_import:' || p_import_id::text, 0))
$$;


--
-- Name: FUNCTION ai_reconcile_import_lock(p_import_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_import_lock(p_import_id uuid) IS 'Advisory lock (da transação) do lote: o play, a conciliação genérica e ai_reconcile_recipe_claim o tomam antes de conferir ai_reconcile_import_busy e criar a execução, para duas execuções nunca começarem juntas no mesmo lote.';


--
-- Name: ai_reconcile_recipe_claim(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipe_claim(p_import_id uuid) RETURNS TABLE(recipe_run_id uuid, recipe_id uuid, import_id uuid, user_id uuid, agent_id uuid, recipe_name text, instruction text, "position" integer)
    LANGUAGE plpgsql
    AS $$
#variable_conflict use_column
DECLARE
  x ai_reconcile_recipe_runs;
  rc ai_reconcile_recipes;
  reason text;
BEGIN
  PERFORM ai_reconcile_import_lock(p_import_id);
  IF ai_reconcile_import_busy(p_import_id) THEN
    RETURN;
  END IF;

  LOOP
    SELECT q.* INTO x FROM ai_reconcile_recipe_runs q
     WHERE q.import_id = p_import_id AND q.status = 'queued'
     ORDER BY q.position, q.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT r.* INTO rc FROM ai_reconcile_recipes r WHERE r.id = x.recipe_id;
    reason := CASE
                WHEN NOT rc.is_active OR rc.archived_at IS NOT NULL THEN 'recipe_inactive'
                WHEN NOT EXISTS (SELECT 1 FROM ai_agents a
                                  WHERE a.id = rc.agent_id AND a.is_active AND a.archived_at IS NULL) THEN 'agent_inactive'
                WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = x.user_id AND u.is_active) THEN 'user_inactive'
              END;
    IF reason IS NOT NULL THEN
      UPDATE ai_reconcile_recipe_runs q SET status = 'skipped', skip_reason = reason WHERE q.id = x.id;
      CONTINUE;
    END IF;

    UPDATE ai_reconcile_recipe_runs q SET status = 'started' WHERE q.id = x.id;
    RETURN QUERY SELECT x.id, rc.id, x.import_id, x.user_id, rc.agent_id, rc.name, rc.instruction, x.position;
    RETURN;
  END LOOP;
END
$$;


--
-- Name: FUNCTION ai_reconcile_recipe_claim(p_import_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_recipe_claim(p_import_id uuid) IS 'Fila do import (spec 030): toma o lock do lote (ai_reconcile_import_lock) e, se o lote não está ocupado (ai_reconcile_import_busy), reserva a próxima execução queued por position (FOR UPDATE SKIP LOCKED), passa-a a started e a devolve (zero ou uma linha). Antes, pula (skipped) as da vez com recipe_inactive (receita desligada ou arquivada), agent_inactive ou user_inactive. Lote ocupado ou fila vazia: nenhuma linha. A aplicação calcula as linhas pendentes (sem nenhuma, skipped no_lines e chama de novo), cria a sessão e a execução na mesma transação e grava line_ids, conversation_id e run_id; se não puder começar, passa a failed/skipped com o motivo.';


--
-- Name: ai_reconcile_recipe_pending_imports(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipe_pending_imports(p_limit integer DEFAULT 20) RETURNS TABLE(import_id uuid)
    LANGUAGE sql STABLE
    AS $$
  SELECT q.import_id
    FROM ai_reconcile_recipe_runs q
   WHERE q.status = 'queued'
   GROUP BY q.import_id
  HAVING NOT ai_reconcile_import_busy(q.import_id)
   ORDER BY min(q.created_at), q.import_id
   LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
$$;


--
-- Name: FUNCTION ai_reconcile_recipe_pending_imports(p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_recipe_pending_imports(p_limit integer) IS 'Lotes com execução de receita queued e sem execução ativa (ai_reconcile_import_busy), o mais antigo primeiro, até p_limit (1–100, padrão 20): o worker chama ai_reconcile_recipe_claim para cada um.';


--
-- Name: ai_reconcile_recipe_runs_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipe_runs_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.recipe_id <> OLD.recipe_id OR NEW.import_id <> OLD.import_id OR NEW.user_id <> OLD.user_id
       OR NEW.trigger_kind <> OLD.trigger_kind OR NEW.created_at <> OLD.created_at
       OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NOT NULL
           AND NEW.conversation_id <> OLD.conversation_id)
       OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NEW.run_id <> OLD.run_id) THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: recipe, import, user, trigger and links of run % are immutable', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_immutable_check';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'queued' AND NEW.status IN ('started', 'skipped', 'failed'))
         OR (OLD.status = 'started' AND NEW.status IN ('completed', 'skipped', 'failed'))) THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: run % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_status_transition_check';
    END IF;
    IF OLD.status IN ('completed', 'skipped', 'failed') AND NEW.skip_reason IS DISTINCT FROM OLD.skip_reason THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: run % is % (final)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_status_transition_check';
    END IF;
  END IF;

  IF NEW.status IN ('started', 'completed') AND NEW.started_at IS NULL THEN
    NEW.started_at := clock_timestamp();
  END IF;
  IF NEW.status IN ('completed', 'skipped', 'failed') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := clock_timestamp();
  END IF;

  IF NEW.conversation_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.conversation_id IS NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM ai_conversations c
                    WHERE c.id = NEW.conversation_id AND c.user_id = NEW.user_id
                      AND c.purpose = 'reconcile_statement') THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: conversation % is not a reconcile_statement session of user %',
        NEW.conversation_id, NEW.user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_links_check';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.run_id IS NULL) THEN
    IF NEW.conversation_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.conversation_id = NEW.conversation_id) THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_runs: run % does not belong to conversation %', NEW.run_id, NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_runs_links_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_reconcile_recipe_targets_audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipe_targets_audit_row() RETURNS trigger
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

  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed,
                      coalesce(n ->> 'recipe_id', o ->> 'recipe_id')::uuid);
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_reconcile_recipe_targets_audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_recipe_targets_audit_row() IS 'Trigger de auditoria de ai_reconcile_recipe_targets: grava com record_id = recipe_id, para vincular e desvincular contas aparecerem no histórico da receita.';


--
-- Name: ai_reconcile_recipe_targets_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipe_targets_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  r ai_reconcile_recipes;
  owner uuid;
  payer uuid;
  k text;
BEGIN
  SELECT x.* INTO r FROM ai_reconcile_recipes x WHERE x.id = NEW.recipe_id;
  IF NOT FOUND THEN
    RETURN NEW; -- a FK recusa
  END IF;

  IF NEW.financial_account_id IS NOT NULL THEN
    SELECT a.caixa_id, a.kind INTO owner, k FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
    IF FOUND AND k NOT IN ('checking', 'savings') THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: account % does not import statements (only checking/savings)',
        NEW.financial_account_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_kind_check';
    END IF;
    IF FOUND AND r.caixa_id IS NOT NULL AND owner <> r.caixa_id THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: account % is not of caixa %', NEW.financial_account_id, r.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_owner_check';
    END IF;
  ELSIF NEW.card_caixa_id IS NOT NULL THEN
    SELECT c.kind, c.default_payer_caixa_id INTO k, payer FROM caixas c WHERE c.id = NEW.card_caixa_id;
    IF FOUND AND k <> 'credit_card' THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: caixa % is not a credit card', NEW.card_caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_kind_check';
    END IF;
    -- O cartão é uma caixa própria: vale a receita do próprio cartão ou a da pagadora padrão dele.
    IF FOUND AND r.caixa_id IS NOT NULL AND r.caixa_id <> NEW.card_caixa_id AND payer IS DISTINCT FROM r.caixa_id THEN
      RAISE EXCEPTION 'ai_reconcile_recipe_targets: card % is not of caixa %', NEW.card_caixa_id, r.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipe_targets_owner_check';
    END IF;
  END IF;

  IF r.run_on_import AND r.archived_at IS NULL
     AND (TG_OP = 'INSERT' OR (NEW.recipe_id, NEW.financial_account_id, NEW.card_caixa_id)
                              IS DISTINCT FROM (OLD.recipe_id, OLD.financial_account_id, OLD.card_caixa_id)) THEN
    PERFORM ai_reconcile_import_limit_check(NEW.recipe_id, NEW.financial_account_id, NEW.card_caixa_id);
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_reconcile_recipes_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipes_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  t record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.caixa_id IS DISTINCT FROM OLD.caixa_id THEN
    RAISE EXCEPTION 'ai_reconcile_recipes: owner of recipe % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipes_owner_immutable_check';
  END IF;

  -- No máximo 50 não arquivadas por dona (caixa ou global).
  IF NEW.archived_at IS NULL AND (TG_OP = 'INSERT' OR OLD.archived_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'ai_reconcile_recipes:' || coalesce(NEW.caixa_id::text, 'global'), 0));
    IF (SELECT count(*) FROM ai_reconcile_recipes x
         WHERE x.caixa_id IS NOT DISTINCT FROM NEW.caixa_id AND x.archived_at IS NULL AND x.id <> NEW.id) >= 50 THEN
      RAISE EXCEPTION 'ai_reconcile_recipes: owner % already has 50 recipes', coalesce(NEW.caixa_id::text, 'global')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipes_active_limit_check';
    END IF;
  END IF;

  -- Passou a contar no limite de 10 ao importar (ligou run_on_import ou desarquivou): confere cada alvo.
  IF TG_OP = 'UPDATE' AND NEW.run_on_import AND NEW.archived_at IS NULL
     AND NOT (OLD.run_on_import AND OLD.archived_at IS NULL) THEN
    FOR t IN SELECT financial_account_id, card_caixa_id FROM ai_reconcile_recipe_targets WHERE recipe_id = NEW.id LOOP
      PERFORM ai_reconcile_import_limit_check(NEW.id, t.financial_account_id, t.card_caixa_id);
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_reconcile_recipes_run_on_import_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_reconcile_recipes_run_on_import_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  rid uuid;
BEGIN
  -- O registro de cada tabela só tem os campos dela: o id da receita sai por to_jsonb.
  IF TG_TABLE_NAME = 'ai_reconcile_recipes' THEN
    rid := NEW.id;
  ELSE
    -- Alvo removido ou trocado de receita: confere a receita de antes.
    rid := (to_jsonb(OLD) ->> 'recipe_id')::uuid;
  END IF;
  IF EXISTS (SELECT 1 FROM ai_reconcile_recipes r
              WHERE r.id = rid AND r.run_on_import
                AND NOT EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = r.id)) THEN
    RAISE EXCEPTION 'ai_reconcile_recipes: recipe % runs on import but has no account or card', rid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_reconcile_recipes_run_on_import_check';
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_reconcile_recipes_run_on_import_check(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_reconcile_recipes_run_on_import_check() IS 'Constraint trigger deferida: receita com run_on_import precisa de pelo menos um alvo no COMMIT (23514 ai_reconcile_recipes_run_on_import_check). Crie a receita e os alvos na mesma transação.';


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
-- Name: ai_schedule_next_run(jsonb, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_schedule_next_run(p_schedule jsonb, p_after timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
DECLARE
  d0 date;
  d date;
  t timestamptz;
BEGIN
  IF NOT ai_schedule_valid(p_schedule) OR p_after IS NULL THEN
    RETURN NULL;
  END IF;
  d0 := (p_after AT TIME ZONE 'America/Sao_Paulo')::date;
  FOR i IN 0..62 LOOP
    d := d0 + i;
    CONTINUE WHEN NOT ai_schedule_occurs_on(p_schedule, d);
    t := (d + (p_schedule ->> 'time')::time) AT TIME ZONE 'America/Sao_Paulo';
    IF t > p_after THEN
      RETURN t;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_schedule_next_run(p_schedule jsonb, p_after timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_schedule_next_run(p_schedule jsonb, p_after timestamp with time zone) IS 'Próximo disparo da agenda estritamente depois de p_after, no fuso America/Sao_Paulo (dia 31 em mês curto = último dia do mês; "last" = último dia). NULL com agenda inválida.';


--
-- Name: ai_schedule_occurs_on(jsonb, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_schedule_occurs_on(p_schedule jsonb, p_day date) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE p_schedule ->> 'kind'
           WHEN 'daily' THEN true
           WHEN 'weekly' THEN (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow FROM p_day)::int)
           WHEN 'monthly' THEN
             extract(day FROM p_day)::int
               = least(CASE WHEN p_schedule -> 'day' = '"last"'::jsonb THEN 31 ELSE (p_schedule ->> 'day')::int END,
                       extract(day FROM (date_trunc('month', p_day) + interval '1 month - 1 day'))::int)
           ELSE false
         END
$$;


--
-- Name: FUNCTION ai_schedule_occurs_on(p_schedule jsonb, p_day date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_schedule_occurs_on(p_schedule jsonb, p_day date) IS 'Interna: a agenda dispara no dia p_day (diária: todo dia; semanal: dia ISO na lista; mensal: o dia, limitado ao último dia do mês, ou o último dia com "last").';


--
-- Name: ai_schedule_prev_run(jsonb, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_schedule_prev_run(p_schedule jsonb, p_at timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
DECLARE
  d0 date;
  d date;
  t timestamptz;
BEGIN
  IF NOT ai_schedule_valid(p_schedule) OR p_at IS NULL THEN
    RETURN NULL;
  END IF;
  d0 := (p_at AT TIME ZONE 'America/Sao_Paulo')::date;
  FOR i IN 0..62 LOOP
    d := d0 - i;
    CONTINUE WHEN NOT ai_schedule_occurs_on(p_schedule, d);
    t := (d + (p_schedule ->> 'time')::time) AT TIME ZONE 'America/Sao_Paulo';
    IF t <= p_at THEN
      RETURN t;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION ai_schedule_prev_run(p_schedule jsonb, p_at timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_schedule_prev_run(p_schedule jsonb, p_at timestamp with time zone) IS 'Último disparo da agenda em p_at ou antes, no fuso America/Sao_Paulo (o "disparo perdido" mais recente). NULL com agenda inválida.';


--
-- Name: ai_schedule_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_schedule_valid(p_schedule jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
DECLARE
  allowed text[];
BEGIN
  IF p_schedule IS NULL OR jsonb_typeof(p_schedule) <> 'object' OR jsonb_typeof(p_schedule -> 'kind') <> 'string' THEN
    RETURN false;
  END IF;
  CASE p_schedule ->> 'kind'
    WHEN 'daily' THEN allowed := '{kind,time}';
    WHEN 'weekly' THEN allowed := '{kind,time,weekdays}';
    WHEN 'monthly' THEN allowed := '{kind,time,day}';
    ELSE RETURN false;
  END CASE;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_schedule) k WHERE k <> ALL (allowed)) OR NOT (p_schedule ?& allowed) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_schedule -> 'time') <> 'string' OR p_schedule ->> 'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RETURN false;
  END IF;
  IF p_schedule ? 'weekdays' AND (
       jsonb_typeof(p_schedule -> 'weekdays') <> 'array'
       OR jsonb_array_length(p_schedule -> 'weekdays') NOT BETWEEN 1 AND 7
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule -> 'weekdays') e
                   WHERE jsonb_typeof(e) <> 'number' OR e::text !~ '^[1-7]$')
       OR (SELECT count(DISTINCT e::text) FROM jsonb_array_elements(p_schedule -> 'weekdays') e)
          <> jsonb_array_length(p_schedule -> 'weekdays')) THEN
    RETURN false;
  END IF;
  IF p_schedule ? 'day' AND NOT (
       (jsonb_typeof(p_schedule -> 'day') = 'number' AND (p_schedule -> 'day')::text ~ '^[0-9]{1,2}$'
        AND (p_schedule ->> 'day')::int BETWEEN 1 AND 31)
       OR p_schedule -> 'day' = '"last"'::jsonb) THEN
    RETURN false;
  END IF;
  RETURN true;
END
$_$;


--
-- Name: FUNCTION ai_schedule_valid(p_schedule jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_schedule_valid(p_schedule jsonb) IS 'true se a agenda de uma tarefa agendada (spec 029) é válida: {"kind": "daily", "time": "HH:MM"}, {"kind": "weekly", "time", "weekdays": [1–7 distintos, ISO, 1 = segunda]} ou {"kind": "monthly", "time", "day": 1–31 ou "last"}; só essas chaves, todas obrigatórias. Horário em America/Sao_Paulo.';


--
-- Name: ai_scheduled_task_claim(integer, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_scheduled_task_claim(p_limit integer DEFAULT 10, p_max_delay interval DEFAULT '06:00:00'::interval) RETURNS TABLE(task_run_id uuid, task_id uuid, user_id uuid, agent_id uuid, task_name text, instruction text, scheduled_for timestamp with time zone, trigger_kind text, status text, skip_reason text)
    LANGUAGE plpgsql
    AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
  t ai_scheduled_tasks;
  s timestamptz;
  reason text;
  rid uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_max_delay IS NULL OR p_max_delay < interval '1 minute' THEN
    RAISE EXCEPTION 'ai_scheduled_task_claim: limit must be 1..100 and max_delay >= 1 minute'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR t IN SELECT x.* FROM ai_scheduled_tasks x
            WHERE x.is_active AND x.next_run_at <= v_now
            ORDER BY x.next_run_at, x.id
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED LOOP
    -- O disparo perdido mais recente (vários perdidos com o worker parado viram um só).
    s := greatest(t.next_run_at, coalesce(ai_schedule_prev_run(t.schedule, v_now), t.next_run_at));
    reason := CASE WHEN v_now - s > p_max_delay THEN 'missed_window' ELSE ai_scheduled_task_skip_reason(t) END;

    rid := NULL;
    INSERT INTO ai_scheduled_task_runs AS r (task_id, scheduled_for, trigger_kind, status, skip_reason)
    VALUES (t.id, s, 'schedule', CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason)
    ON CONFLICT ON CONSTRAINT ai_scheduled_task_runs_task_scheduled_key DO NOTHING
    RETURNING r.id INTO rid;

    UPDATE ai_scheduled_tasks x
       SET next_run_at = ai_schedule_next_run(x.schedule, greatest(v_now, t.next_run_at)),
           last_run_at = CASE WHEN rid IS NOT NULL AND reason IS NULL THEN v_now ELSE x.last_run_at END
     WHERE x.id = t.id;

    IF rid IS NOT NULL THEN
      RETURN QUERY SELECT rid, t.id, t.user_id, t.agent_id, t.name, t.instruction, s, 'schedule'::text,
                          CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason;
    END IF;
  END LOOP;
END
$$;


--
-- Name: FUNCTION ai_scheduled_task_claim(p_limit integer, p_max_delay interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_scheduled_task_claim(p_limit integer, p_max_delay interval) IS 'Reserva até p_limit tarefas ativas vencidas (next_run_at <= agora) com FOR UPDATE SKIP LOCKED e, para cada uma, grava o disparo do horário previsto mais recente (vários perdidos viram um) e avança next_run_at para depois de agora. O disparo sai skipped com missed_window se o atraso passa de p_max_delay (padrão 6 h), com user_inactive, agent_inactive ou previous_run_active; senão started (last_run_at = agora). Devolve os disparos gravados (started e skipped); um horário já gravado não se repete (único por tarefa e horário). Para cada started, a aplicação cria a sessão (purpose scheduled_task) e a execução, de preferência na mesma transação, e grava conversation_id e run_id; se não puder começar (orçamento, limite, erro), passa o disparo a skipped/failed com o motivo. 22023 com parâmetros inválidos.';


--
-- Name: ai_scheduled_task_run_now(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_scheduled_task_run_now(p_task_id uuid) RETURNS TABLE(task_run_id uuid, task_id uuid, user_id uuid, agent_id uuid, task_name text, instruction text, scheduled_for timestamp with time zone, trigger_kind text, status text, skip_reason text)
    LANGUAGE plpgsql
    AS $$
#variable_conflict use_column
DECLARE
  t ai_scheduled_tasks;
  s timestamptz := clock_timestamp();
  reason text;
  rid uuid;
BEGIN
  SELECT x.* INTO t FROM ai_scheduled_tasks x WHERE x.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_scheduled_task_run_now: task % not found', p_task_id USING ERRCODE = 'no_data_found';
  END IF;
  reason := ai_scheduled_task_skip_reason(t);

  INSERT INTO ai_scheduled_task_runs AS r (task_id, scheduled_for, trigger_kind, status, skip_reason)
  VALUES (t.id, s, 'manual', CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason)
  RETURNING r.id INTO rid;
  IF reason IS NULL THEN
    UPDATE ai_scheduled_tasks x SET last_run_at = s WHERE x.id = t.id;
  END IF;

  RETURN QUERY SELECT rid, t.id, t.user_id, t.agent_id, t.name, t.instruction, s, 'manual'::text,
                      CASE WHEN reason IS NULL THEN 'started' ELSE 'skipped' END, reason;
END
$$;


--
-- Name: FUNCTION ai_scheduled_task_run_now(p_task_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_scheduled_task_run_now(p_task_id uuid) IS '"Rodar agora": grava um disparo manual (scheduled_for = agora), started ou skipped (user_inactive, agent_inactive, previous_run_active), e o devolve; vale também para tarefa desligada e não muda next_run_at. A aplicação segue como no claim. Quem pode (o dono ou o admin) é regra da aplicação. P0002 se a tarefa não existe.';


--
-- Name: ai_scheduled_task_runs_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_scheduled_task_runs_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  owner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.task_id <> OLD.task_id OR NEW.scheduled_for <> OLD.scheduled_for OR NEW.trigger_kind <> OLD.trigger_kind
       OR NEW.created_at <> OLD.created_at
       OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NOT NULL
           AND NEW.conversation_id <> OLD.conversation_id)
       OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NEW.run_id <> OLD.run_id) THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: task, time, trigger and links of run % are immutable', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_immutable_check';
    END IF;
    IF OLD.status <> 'started' AND (NEW.status, NEW.skip_reason) IS DISTINCT FROM (OLD.status, OLD.skip_reason) THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: run % is % (final)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_status_transition_check';
    END IF;
  END IF;

  IF NEW.conversation_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.conversation_id IS NULL) THEN
    SELECT t.user_id INTO owner FROM ai_scheduled_tasks t WHERE t.id = NEW.task_id;
    IF NOT EXISTS (SELECT 1 FROM ai_conversations c
                    WHERE c.id = NEW.conversation_id AND c.user_id = owner AND c.purpose = 'scheduled_task') THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: conversation % is not a scheduled_task session of the task owner',
        NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_links_check';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.run_id IS NULL) THEN
    IF NEW.conversation_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.id = NEW.run_id AND r.conversation_id = NEW.conversation_id) THEN
      RAISE EXCEPTION 'ai_scheduled_task_runs: run % does not belong to conversation %', NEW.run_id, NEW.conversation_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_task_runs_links_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: ai_scheduled_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_scheduled_tasks (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    name text NOT NULL,
    instruction text NOT NULL,
    schedule jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_scheduled_tasks_instruction_check CHECK (((btrim(instruction) <> ''::text) AND (length(instruction) <= 20000))),
    CONSTRAINT ai_scheduled_tasks_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT ai_scheduled_tasks_next_run_check CHECK ((is_active = (next_run_at IS NOT NULL))),
    CONSTRAINT ai_scheduled_tasks_schedule_check CHECK (public.ai_schedule_valid(schedule))
);


--
-- Name: TABLE ai_scheduled_tasks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_scheduled_tasks IS 'Tarefas agendadas dos agentes (spec 029): a cada disparo, a instrução vai como mensagem do usuário numa sessão própria (purpose scheduled_task), rodando como o dono (user_id) com as permissões dele. No máximo 20 ativas por usuário (ai_scheduled_tasks_active_limit_check). Disparos em ai_scheduled_task_runs; reserva por ai_scheduled_task_claim, "Rodar agora" por ai_scheduled_task_run_now. Auditada (menos next_run_at/last_run_at).';


--
-- Name: COLUMN ai_scheduled_tasks.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.user_id IS 'Dono: a tarefa roda como ele. Imutável (ai_scheduled_tasks_user_immutable_check).';


--
-- Name: COLUMN ai_scheduled_tasks.agent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.agent_id IS 'Agente que executa. Excluir o agente com tarefas dá 23503 (arquive). Agente inativo ou arquivado: o disparo é skipped com agent_inactive.';


--
-- Name: COLUMN ai_scheduled_tasks.instruction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.instruction IS 'Texto enviado como mensagem do usuário a cada disparo (até 20 mil).';


--
-- Name: COLUMN ai_scheduled_tasks.schedule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.schedule IS 'Agenda (ai_schedule_valid): {"kind": "daily", "time": "HH:MM"}, {"kind": "weekly", "time", "weekdays": [1–7, ISO]} ou {"kind": "monthly", "time", "day": 1–31 | "last"}. Fuso America/Sao_Paulo; dia que o mês não tem = último dia.';


--
-- Name: COLUMN ai_scheduled_tasks.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.is_active IS 'Desligada não dispara e não conta no limite de 20.';


--
-- Name: COLUMN ai_scheduled_tasks.next_run_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.next_run_at IS 'Próximo disparo, mantido pelo banco (ai_schedule_next_run a partir de agora, ao criar, ativar ou mudar a agenda; avançado pelo claim). Nulo se e somente se desativada.';


--
-- Name: COLUMN ai_scheduled_tasks.last_run_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.last_run_at IS 'Último disparo que começou (started), agendado ou manual.';


--
-- Name: COLUMN ai_scheduled_tasks.created_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_tasks.created_by_user_id IS 'Quem criou (o dono ou o admin).';


--
-- Name: ai_scheduled_task_skip_reason(public.ai_scheduled_tasks); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_scheduled_task_skip_reason(p_task public.ai_scheduled_tasks) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_task.user_id AND u.is_active) THEN 'user_inactive'
           WHEN NOT EXISTS (SELECT 1 FROM ai_agents a
                             WHERE a.id = p_task.agent_id AND a.is_active AND a.archived_at IS NULL) THEN 'agent_inactive'
           WHEN EXISTS (SELECT 1 FROM ai_scheduled_task_runs r
                          LEFT JOIN ai_runs ar ON ar.id = r.run_id
                         WHERE r.task_id = p_task.id AND r.status = 'started'
                           AND (ar.status IN ('queued', 'running', 'awaiting_confirmation')
                                -- Disparo recém-reservado cuja execução a aplicação ainda vai criar.
                                OR (r.run_id IS NULL AND r.conversation_id IS NULL
                                    AND r.created_at > clock_timestamp() - interval '10 minutes'))) THEN
             'previous_run_active'
         END
$$;


--
-- Name: FUNCTION ai_scheduled_task_skip_reason(p_task public.ai_scheduled_tasks); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_scheduled_task_skip_reason(p_task public.ai_scheduled_tasks) IS 'Interna: motivo para pular um disparo agora, ou NULL: user_inactive (dono desativado), agent_inactive (agente inativo ou arquivado), previous_run_active (um disparo anterior com execução queued/running/awaiting_confirmation, ou started há menos de 10 min ainda sem sessão nem execução).';


--
-- Name: ai_scheduled_tasks_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_scheduled_tasks_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'ai_scheduled_tasks: owner of task % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_tasks_user_immutable_check';
  END IF;
  IF NOT ai_schedule_valid(NEW.schedule) THEN
    RAISE EXCEPTION 'ai_scheduled_tasks: invalid schedule %', NEW.schedule
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_tasks_schedule_check';
  END IF;

  -- No máximo 20 ativas por usuário. A trava por usuário serializa ativações concorrentes do mesmo dono.
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ai_scheduled_tasks:' || NEW.user_id::text, 0));
    IF (SELECT count(*) FROM ai_scheduled_tasks x
         WHERE x.user_id = NEW.user_id AND x.is_active AND x.id <> NEW.id) >= 20 THEN
      RAISE EXCEPTION 'ai_scheduled_tasks: user % already has 20 active tasks', NEW.user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_scheduled_tasks_active_limit_check';
    END IF;
  END IF;

  -- Próximo disparo: calculado pelo banco ao criar, ao ativar e ao mudar a agenda; nulo se desativada. O claim o
  -- avança (sem mudar a agenda), e o valor dele fica.
  IF NOT NEW.is_active THEN
    NEW.next_run_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.is_active OR NEW.schedule IS DISTINCT FROM OLD.schedule
        OR NEW.next_run_at IS NULL THEN
    NEW.next_run_at := ai_schedule_next_run(NEW.schedule, now());
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
    lock_token uuid,
    conversation_id uuid,
    CONSTRAINT ai_attachment_derivatives_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT ai_attachment_derivatives_block_index_check CHECK (((block_index >= 0) AND (block_index <= 9999))),
    CONSTRAINT ai_attachment_derivatives_content_check CHECK ((length(content) <= 5000000)),
    CONSTRAINT ai_attachment_derivatives_error_check CHECK (((length(error) <= 4000) AND ((status <> 'failed'::text) OR (error IS NOT NULL)))),
    CONSTRAINT ai_attachment_derivatives_kind_check CHECK ((kind = ANY (ARRAY['description'::text, 'pdf_text'::text, 'transcription'::text, 'speech'::text]))),
    CONSTRAINT ai_attachment_derivatives_lock_check CHECK ((((status = 'running'::text) = (locked_at IS NOT NULL)) AND ((status = 'running'::text) = (lock_token IS NOT NULL)))),
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

COMMENT ON COLUMN public.ai_attachment_derivatives.locked_at IS 'Instante da reserva, só em running (reserva velha = worker caiu; ai_transcription_claim a retoma).';


--
-- Name: COLUMN ai_attachment_derivatives.lock_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.lock_token IS 'Cerca da reserva, só em running (gerada por ai_transcription_claim; exigida por ai_transcription_credentials, _complete e _fail).';


--
-- Name: COLUMN ai_attachment_derivatives.conversation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_attachment_derivatives.conversation_id IS 'Conversa em que o derivado foi pedido (a transcrição no upload): o worker atribui uso e requisição ao dono e ao agente dela. Nula = sem atribuição (ou a conversa foi excluída: SET NULL, o cache do anexo fica).';


--
-- Name: ai_transcription_claim(integer, interval, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_transcription_claim(p_limit integer DEFAULT 1, p_stale_after interval DEFAULT '00:10:00'::interval, p_max_attempts integer DEFAULT 3) RETURNS SETOF public.ai_attachment_derivatives
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_stale_after IS NULL OR p_stale_after < interval '30 seconds'
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'ai_transcription_claim: limit must be 1..100, stale_after >= 30 seconds and max_attempts 1..100'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Sem tentativas restantes: reserva abandonada (worker caiu) ou pendente que já gastou o limite vira failed.
  UPDATE ai_attachment_derivatives d
     SET status = 'failed', locked_at = NULL, lock_token = NULL,
         error = CASE WHEN d.status = 'running' THEN 'stale_lock: worker stopped and the transcription has no attempts left'
                      ELSE 'max_attempts: the transcription has no attempts left' END
   WHERE d.id IN (SELECT x.id FROM ai_attachment_derivatives x
                   WHERE x.kind = 'transcription' AND x.attempts >= p_max_attempts
                     AND (x.status = 'pending'
                          OR (x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after))
                   FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  UPDATE ai_attachment_derivatives d
     SET status = 'running', locked_at = clock_timestamp(), lock_token = gen_random_uuid(),
         attempts = d.attempts + 1, error = NULL
   WHERE d.id IN (SELECT x.id FROM ai_attachment_derivatives x
                   WHERE x.kind = 'transcription' AND x.attempts < p_max_attempts
                     AND (x.status = 'pending'
                          OR (x.status = 'running' AND x.locked_at < clock_timestamp() - p_stale_after))
                   ORDER BY x.created_at, x.id
                   LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING d.*;
END
$$;


--
-- Name: FUNCTION ai_transcription_claim(p_limit integer, p_stale_after interval, p_max_attempts integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_transcription_claim(p_limit integer, p_stale_after interval, p_max_attempts integer) IS 'Reserva até p_limit transcrições (kind transcription: pending, ou running com reserva mais velha que p_stale_after = worker caiu), em ordem de criação, com FOR UPDATE SKIP LOCKED: status = running, locked_at = agora, lock_token novo, attempts + 1. Sem tentativas restantes (attempts >= p_max_attempts), a reserva velha ou a pendente vira failed com error stale_lock / max_attempts. Rode numa transação curta e faça COMMIT antes de chamar o provedor; guarde id e lock_token. Erro 22023: parâmetros inválidos (limite 1–100, reserva >= 30 s, tentativas 1–100).';


--
-- Name: ai_transcription_complete(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_transcription_complete(p_id uuid, p_lock_token uuid, p_content text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_attachment_derivatives d
     SET status = 'done', content = p_content, error = NULL, locked_at = NULL, lock_token = NULL
   WHERE d.id = p_id AND d.kind = 'transcription' AND d.status = 'running' AND d.lock_token = p_lock_token;
  RETURN FOUND;
END
$$;


--
-- Name: FUNCTION ai_transcription_complete(p_id uuid, p_lock_token uuid, p_content text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_transcription_complete(p_id uuid, p_lock_token uuid, p_content text) IS 'running → done com o texto (pode ser vazio; até 5 milhões de caracteres). Devolve false se a reserva se perdeu (a linha saiu com o anexo, outra reserva a retomou ou já terminou): descarte o resultado. Erros: 23514 ai_attachment_derivatives_result_check (texto nulo) ou _content_check (texto longo demais).';


--
-- Name: ai_transcription_credentials(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_transcription_credentials(p_id uuid, p_lock_token uuid) RETURNS TABLE(provider_id uuid, kind text, base_url text, api_key text, model text, attachment_id uuid, conversation_id uuid, user_id uuid, agent_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  d public.ai_attachment_derivatives;
  c public.ai_conversations;
  p public.ai_providers;
BEGIN
  SELECT * INTO d FROM public.ai_attachment_derivatives x WHERE x.id = p_id AND x.kind = 'transcription';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_transcription_credentials: transcription % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status <> 'running' OR d.lock_token IS DISTINCT FROM p_lock_token THEN
    RAISE EXCEPTION 'ai_transcription_credentials: reservation of transcription % was lost', p_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_attachment_derivatives_lock_check';
  END IF;
  IF d.conversation_id IS NOT NULL THEN
    SELECT * INTO c FROM public.ai_conversations x WHERE x.id = d.conversation_id;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = c.user_id AND u.is_active)
       OR NOT EXISTS (SELECT 1 FROM public.ai_agents a WHERE a.id = c.agent_id AND a.is_active AND a.archived_at IS NULL) THEN
      RAISE EXCEPTION 'ai_transcription_credentials: owner or agent of conversation % is not active', c.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT * INTO p FROM public.ai_providers x WHERE x.id = d.provider_id;
  IF NOT p.is_active OR p.archived_at IS NOT NULL OR NOT ('transcription' = ANY (p.capabilities)) THEN
    RAISE EXCEPTION 'ai_transcription_credentials: provider % is not active or lacks the transcription capability', p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY SELECT p.id, p.kind, p.base_url, p.api_key, d.model, d.attachment_id, c.id, c.user_id, c.agent_id;
END
$$;


--
-- Name: FUNCTION ai_transcription_credentials(p_id uuid, p_lock_token uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_transcription_credentials(p_id uuid, p_lock_token uuid) IS 'Provedor, tipo, URL, chave e modelo da transcrição reservada, mais o anexo e a atribuição (conversa, usuário dono e agente dela; nulos sem conversa). Só para quem tem a reserva (lock_token de ai_transcription_claim). Erros: P0002 transcrição inexistente; 23514 ai_attachment_derivatives_lock_check reserva perdida; 42501 provedor inativo, arquivado ou sem a flag transcription, ou dono/agente da conversa inativo (o worker marca failed).';


--
-- Name: ai_transcription_enqueue(uuid, uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_transcription_enqueue(p_attachment_id uuid, p_provider_id uuid, p_model text, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS public.ai_attachment_derivatives
    LANGUAGE plpgsql
    AS $$
DECLARE
  d ai_attachment_derivatives;
BEGIN
  INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, conversation_id)
  VALUES (p_attachment_id, 'transcription', p_provider_id, p_model, p_conversation_id)
  ON CONFLICT ON CONSTRAINT ai_attachment_derivatives_key DO NOTHING
  RETURNING * INTO d;
  IF d.id IS NULL THEN
    SELECT * INTO d FROM ai_attachment_derivatives x
     WHERE x.attachment_id = p_attachment_id AND x.kind = 'transcription'
       AND x.provider_id = p_provider_id AND x.model = p_model;
  END IF;
  RETURN d;
END
$$;


--
-- Name: FUNCTION ai_transcription_enqueue(p_attachment_id uuid, p_provider_id uuid, p_model text, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_transcription_enqueue(p_attachment_id uuid, p_provider_id uuid, p_model text, p_conversation_id uuid) IS 'Enfileira a transcrição do anexo com o provedor e o modelo (status pending) e devolve a linha; se já existe uma para o anexo, provedor e modelo, devolve a existente como está (done = cache; failed = use ai_transcription_retry). p_conversation_id atribui o uso. Erros: 23503 anexo, provedor ou conversa inexistente; 23514 ai_attachment_derivatives_provider_check (provedor ou modelo nulo) ou _model_check (formato do modelo).';


--
-- Name: ai_transcription_fail(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_transcription_fail(p_id uuid, p_lock_token uuid, p_error text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE ai_attachment_derivatives d
     SET status = 'failed', error = left(coalesce(nullif(btrim(p_error), ''), 'transcription failed'), 4000),
         locked_at = NULL, lock_token = NULL
   WHERE d.id = p_id AND d.kind = 'transcription' AND d.status = 'running' AND d.lock_token = p_lock_token;
  RETURN FOUND;
END
$$;


--
-- Name: FUNCTION ai_transcription_fail(p_id uuid, p_lock_token uuid, p_error text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_transcription_fail(p_id uuid, p_lock_token uuid, p_error text) IS 'running → failed com a mensagem (vazia = "transcription failed"; cortada em 4000). Definitiva: as novas tentativas de HTTP ficam no adaptador (spec 023); voltar à fila é ai_transcription_retry. Devolve false se a reserva se perdeu.';


--
-- Name: ai_transcription_retry(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_transcription_retry(p_id uuid) RETURNS public.ai_attachment_derivatives
    LANGUAGE plpgsql
    AS $$
DECLARE
  d ai_attachment_derivatives;
BEGIN
  SELECT * INTO d FROM ai_attachment_derivatives x WHERE x.id = p_id AND x.kind = 'transcription' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_transcription_retry: transcription % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status = 'failed' THEN
    UPDATE ai_attachment_derivatives x SET status = 'pending', error = NULL, attempts = 0
     WHERE x.id = p_id RETURNING * INTO d;
  END IF;
  RETURN d;
END
$$;


--
-- Name: FUNCTION ai_transcription_retry(p_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_transcription_retry(p_id uuid) IS '"Tentar de novo": failed → pending com as tentativas zeradas e sem erro, e devolve a linha. Em pending, running ou done não muda nada e devolve a linha como está (clique repetido não erra). A permissão é da aplicação. Erro P0002: transcrição inexistente (ou id de outro tipo de derivado).';


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
-- Name: ai_usage_is_flow(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_is_flow(p_usage_purpose text, p_conversation_purpose text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT coalesce(p_conversation_purpose <> 'chat',
                  p_usage_purpose <> ALL (ARRAY['chat', 'title', 'embedding', 'vision_describe', 'transcription',
                                                'speech']))
$$;


--
-- Name: FUNCTION ai_usage_is_flow(p_usage_purpose text, p_conversation_purpose text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_usage_is_flow(p_usage_purpose text, p_conversation_purpose text) IS 'true se o uso é de um fluxo automático (spec 028): a conversa dele tem purpose <> chat; sem conversa (nula ou excluída), a finalidade do uso não é um tipo de chamada (chat, title, embedding, vision_describe, transcription, speech), ou seja, é a finalidade de um fluxo. Finalidades de fluxo novas entram sozinhas; um tipo de chamada novo precisa entrar na lista.';


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
-- Name: ai_usage_top_conversations(date, date, integer, uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_top_conversations(p_from date, p_to date, p_limit integer DEFAULT 20, p_provider_id uuid DEFAULT NULL::uuid, p_agent_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid, p_purpose text DEFAULT NULL::text) RETURNS TABLE(rank integer, conversation_id uuid, title text, conversation_purpose text, owner_user_id uuid, conversation_agent_id uuid, archived_at timestamp with time zone, currency text, cost_micros bigint, calls integer, runs integer, input_tokens bigint, output_tokens bigint, cache_write_tokens bigint, cache_read_tokens bigint, audio_seconds numeric, characters bigint, unpriced_calls integer, last_used_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION 'ai_usage_top_conversations: invalid period % .. % (up to 3660 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'ai_usage_top_conversations: limit must be between 1 and 100'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT x.conversation_id, x.currency, x.cost_micros, x.run_id, x.input_tokens, x.output_tokens,
           x.cache_write_tokens, x.cache_read_tokens, x.audio_seconds, x.characters, x.created_at
      FROM ai_usage x
     WHERE x.conversation_id IS NOT NULL
       AND x.created_at >= p_from::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND x.created_at < (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
       AND (p_provider_id IS NULL OR x.provider_id = p_provider_id)
       AND (p_agent_id IS NULL OR x.agent_id = p_agent_id)
       AND (p_user_id IS NULL OR x.user_id = p_user_id)
       AND (p_purpose IS NULL OR x.purpose = p_purpose)
  ), unpriced AS (
    SELECT u.conversation_id, count(*)::integer AS n FROM u WHERE u.cost_micros IS NULL GROUP BY u.conversation_id
  ), agg AS (
    SELECT u.conversation_id, u.currency,
           sum(u.cost_micros)::bigint AS cost_micros,
           count(*)::integer AS calls,
           count(DISTINCT u.run_id)::integer AS runs,
           sum(u.input_tokens)::bigint AS input_tokens,
           sum(u.output_tokens)::bigint AS output_tokens,
           sum(u.cache_write_tokens)::bigint AS cache_write_tokens,
           sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
           sum(u.audio_seconds) AS audio_seconds,
           sum(u.characters)::bigint AS characters,
           max(u.created_at) AS last_used_at
      FROM u
     WHERE u.currency IS NOT NULL
     GROUP BY u.conversation_id, u.currency
  ), ranked AS (
    SELECT agg.*, row_number() OVER (PARTITION BY agg.currency
                                     ORDER BY agg.cost_micros DESC, agg.last_used_at DESC, agg.conversation_id) AS rn
      FROM agg
  )
  SELECT r.rn::integer, r.conversation_id, c.title, c.purpose, c.user_id, c.agent_id, c.archived_at, r.currency,
         r.cost_micros, r.calls, r.runs, r.input_tokens, r.output_tokens, r.cache_write_tokens, r.cache_read_tokens,
         r.audio_seconds, r.characters, coalesce(p.n, 0), r.last_used_at
    FROM ranked r
    JOIN ai_conversations c ON c.id = r.conversation_id
    LEFT JOIN unpriced p ON p.conversation_id = r.conversation_id
   WHERE r.rn <= p_limit
   ORDER BY r.currency, r.rn;
END
$$;


--
-- Name: FUNCTION ai_usage_top_conversations(p_from date, p_to date, p_limit integer, p_provider_id uuid, p_agent_id uuid, p_user_id uuid, p_purpose text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ai_usage_top_conversations(p_from date, p_to date, p_limit integer, p_provider_id uuid, p_agent_id uuid, p_user_id uuid, p_purpose text) IS 'Ranking das conversas (sessões e fluxos) por custo no período [p_from, p_to] (datas em America/Sao_Paulo, até 3660 dias) com os filtros opcionais do painel (provedor, agente, usuário, finalidade do uso): as p_limit (1–100, padrão 20) mais caras de cada moeda, rank 1, 2, 3… por moeda; desempate pelo uso mais recente. Só o uso com preço entra no custo e nos totais da linha; unpriced_calls = chamadas sem preço da conversa no período. Uso sem conversa (embeddings ou conversa excluída) fica de fora. 22023 com período ou limite inválidos. O admin vê todas; a aplicação restringe.';


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
  SELECT CASE
           WHEN p_key = 'ai.request_retention_days' THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,3}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 365
                  ELSE false
             END
           WHEN p_key IN ('ai.runs_per_minute', 'ai.flow_runs_per_minute') THEN
             CASE WHEN jsonb_typeof(p_value) = 'number' AND p_value #>> '{}' ~ '^[0-9]{1,4}$'
                  THEN (p_value #>> '{}')::integer BETWEEN 1 AND 1000
                  ELSE false
             END
           WHEN p_key = 'telegram.public_base_url' THEN
             coalesce(jsonb_typeof(p_value) = 'string'
                      AND length(p_value #>> '{}') <= 500
                      AND p_value #>> '{}'
                          ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&()*+,;=:@-]+)*$',
                      false)
           ELSE false
         END
$_$;


--
-- Name: FUNCTION app_setting_valid(p_key text, p_value jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.app_setting_valid(p_key text, p_value jsonb) IS 'Valida o valor de uma configuração (app_settings_value_check). Chave desconhecida = inválida. Chaves: ai.request_retention_days (número inteiro de 1 a 365); na F14 (spec 028), ai.runs_per_minute e ai.flow_runs_per_minute (número inteiro de 1 a 1000), sempre sem aspas nem casas decimais; na F15 (spec 029), telegram.public_base_url (texto: URL https://host[:porta][/caminho], sem barra no fim, query nem fragmento, até 500; vence PUBLIC_BASE_URL).';


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
                            'duration_ms', OLD.duration_ms, 'page_count', OLD.page_count,
                            'uploaded_by_user_id', OLD.uploaded_by_user_id,
                            'created_at', OLD.created_at, 'updated_at', OLD.updated_at);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    n := jsonb_build_object('id', NEW.id, 'file_name', NEW.file_name, 'mime_type', NEW.mime_type,
                            'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256,
                            'duration_ms', NEW.duration_ms, 'page_count', NEW.page_count,
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


--
-- Name: FUNCTION audit_row(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.audit_row() IS 'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token, api_key, secret_headers, token_hash, webhook_secret_hash, code_hash): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha.';


--
-- Name: audit_row_keyed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_row_keyed() RETURNS trigger
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
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed,
                      coalesce(n ->> TG_ARGV[0], o ->> TG_ARGV[0])::uuid);
  RETURN NULL;
END
$$;


--
-- Name: FUNCTION audit_row_keyed(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.audit_row_keyed() IS 'Trigger de auditoria de tabelas sem id: grava com record_id = a coluna informada em TG_ARGV[0] (card_recurring_charges e card_recurring_charge_amounts: recurrence_rule_id, o histórico da série).';


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
-- Name: card_purchases_validate_occurrence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_purchases_validate_occurrence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  total smallint;
BEGIN
  IF NEW.recurrence_rule_id IS NULL OR NEW.kind <> 'purchase'
     OR (TG_OP = 'UPDATE' AND NEW.recurrence_rule_id IS NOT DISTINCT FROM OLD.recurrence_rule_id
         AND NEW.occurrence IS NOT DISTINCT FROM OLD.occurrence) THEN
    RETURN NEW;
  END IF;
  SELECT r.installments_total INTO total FROM recurrence_rules r WHERE r.id = NEW.recurrence_rule_id FOR NO KEY UPDATE;
  IF NEW.occurrence > total THEN
    RAISE EXCEPTION 'card_purchases: occurrence % exceeds installments total %', NEW.occurrence, total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_occurrence_total_check';
  END IF;
  IF EXISTS (SELECT 1 FROM card_purchases p
              WHERE p.recurrence_rule_id = NEW.recurrence_rule_id AND p.occurrence = NEW.occurrence
                AND p.id <> NEW.id AND p.kind = 'purchase'
                AND p.amount_cents > coalesce((SELECT sum(x.amount_cents) FROM card_purchases x
                                                WHERE x.refunded_purchase_id = p.id), 0)) THEN
    RAISE EXCEPTION 'card_purchases: occurrence % of series % already has a purchase', NEW.occurrence, NEW.recurrence_rule_id
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'card_purchases_occurrence_key';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: card_recurring_charge_amount(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_recurring_charge_amount(p_rule_id uuid, p_occurrence integer) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT coalesce(
    (SELECT a.amount_cents FROM card_recurring_charge_amounts a
      WHERE a.recurrence_rule_id = p_rule_id AND a.from_occurrence <= p_occurrence
      ORDER BY a.from_occurrence DESC LIMIT 1),
    (SELECT g.amount_cents FROM card_recurring_charges g WHERE g.recurrence_rule_id = p_rule_id))
$$;


--
-- Name: FUNCTION card_recurring_charge_amount(p_rule_id uuid, p_occurrence integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.card_recurring_charge_amount(p_rule_id uuid, p_occurrence integer) IS 'Valor esperado da ocorrência n de uma cobrança no cartão: o do último degrau de card_recurring_charge_amounts com from_occurrence <= n, senão card_recurring_charges.amount_cents. Nulo se a série não é de cartão.';


--
-- Name: card_recurring_charges_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_recurring_charges_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ck text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.recurrence_rule_id <> OLD.recurrence_rule_id THEN
    RAISE EXCEPTION 'card_recurring_charges: the series of a card charge cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_immutable_check';
  END IF;
  SELECT c.kind INTO ck FROM recurrence_rules r JOIN caixas c ON c.id = r.caixa_id WHERE r.id = NEW.recurrence_rule_id;
  IF FOUND AND ck <> 'credit_card' THEN
    RAISE EXCEPTION 'card_recurring_charges: series % is not in a credit card caixa', NEW.recurrence_rule_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_card_check';
  END IF;
  IF EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.payer_caixa_id AND c.kind <> 'general') THEN
    RAISE EXCEPTION 'card_recurring_charges: payer % must be a general caixa', NEW.payer_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_payer_kind_check';
  END IF;
  IF EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.kind <> 'expense') THEN
    RAISE EXCEPTION 'card_recurring_charges: category % must be an expense category', NEW.category_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_category_kind_check';
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
-- Name: classification_rule_for(uuid, uuid, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid, p_description text, p_amount_cents bigint) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  rule_id uuid;
BEGIN
  IF num_nonnulls(p_financial_account_id, p_card_caixa_id) <> 1 THEN
    RAISE EXCEPTION 'classification_rule_for: pass exactly one target (account or card)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.id INTO rule_id
    FROM classification_rules r
   WHERE r.archived_at IS NULL
     AND CASE WHEN p_financial_account_id IS NOT NULL
              THEN r.financial_account_id = p_financial_account_id
              ELSE r.caixa_id = p_card_caixa_id AND r.financial_account_id IS NULL END
     AND (r.direction IS NULL OR r.direction = CASE WHEN p_amount_cents > 0 THEN 'in' ELSE 'out' END)
     AND CASE r.match_kind
           WHEN 'exact'       THEN lower(btrim(p_description)) = lower(btrim(r.pattern))
           WHEN 'starts_with' THEN starts_with(lower(btrim(p_description)), lower(btrim(r.pattern)))
           WHEN 'contains'    THEN strpos(lower(p_description), lower(btrim(r.pattern))) > 0
           WHEN 'regex'       THEN p_description ~* r.pattern
         END
   ORDER BY r.priority,
            array_position(ARRAY['exact', 'starts_with', 'contains', 'regex'], r.match_kind),
            length(r.pattern) DESC,
            r.id
   LIMIT 1;
  RETURN rule_id;
END
$$;


--
-- Name: FUNCTION classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid, p_description text, p_amount_cents bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.classification_rule_for(p_financial_account_id uuid, p_card_caixa_id uuid, p_description text, p_amount_cents bigint) IS 'Regra ativa do alvo da linha (a conta, ou o cartão; exatamente um) que classifica a descrição (sinal de p_amount_cents = direção): menor prioridade, exact > starts_with > contains > regex, padrão mais longo. NULL se nenhuma casa. Para o cartão, passe a caixa do cartão e o valor da linha (compra −).';


--
-- Name: classification_rules_split_by_target(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classification_rules_split_by_target() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF to_regclass('pg_temp.crs_rules') IS NOT NULL THEN DROP TABLE pg_temp.crs_rules; END IF;
  IF to_regclass('pg_temp.crs_pairs') IS NOT NULL THEN DROP TABLE pg_temp.crs_pairs; END IF;

  -- Regras a migrar: as globais e as de caixa geral ainda sem conta.
  CREATE TEMP TABLE crs_rules ON COMMIT DROP AS
  SELECT r.id, r.caixa_id, r.match_kind, r.pattern, r.direction, r.priority, r.archived_at, r.created_from_line_id
    FROM classification_rules r
   WHERE r.financial_account_id IS NULL
     AND (r.caixa_id IS NULL OR EXISTS (SELECT 1 FROM caixas c WHERE c.id = r.caixa_id AND c.kind = 'general'));

  CREATE TEMP TABLE crs_pairs (
    rule_id     uuid    NOT NULL,
    caixa_id    uuid    NOT NULL,
    account_id  uuid,
    lines       integer NOT NULL DEFAULT 0,
    archive     boolean NOT NULL DEFAULT false,
    is_original boolean NOT NULL DEFAULT false,
    new_id      uuid
  ) ON COMMIT DROP;

  -- Alvos: contas checking/savings ativas (da caixa, ou de todas na global), cartões ativos
  -- (só a global) e o alvo de cada linha classificada pela regra (mesmo conta arquivada).
  INSERT INTO crs_pairs (rule_id, caixa_id, account_id)
  SELECT r.id, a.caixa_id, a.id
    FROM crs_rules r
    JOIN financial_accounts a ON a.kind IN ('checking', 'savings') AND a.archived_at IS NULL
                             AND (r.caixa_id IS NULL OR a.caixa_id = r.caixa_id)
  UNION
  SELECT r.id, c.id, NULL
    FROM crs_rules r
    JOIN caixas c ON r.caixa_id IS NULL AND c.kind = 'credit_card' AND c.archived_at IS NULL
  UNION
  SELECT l.classification_rule_id, coalesce(a.caixa_id, l.card_caixa_id), l.financial_account_id
    FROM statement_lines l
    JOIN crs_rules r ON r.id = l.classification_rule_id
    LEFT JOIN financial_accounts a ON a.id = l.financial_account_id
   WHERE l.card_caixa_id IS NOT NULL OR a.kind IN ('checking', 'savings');

  -- Linhas de cada alvo classificadas pela regra.
  UPDATE crs_pairs p
     SET lines = x.n
    FROM (SELECT l.classification_rule_id AS rule_id, l.financial_account_id, l.card_caixa_id, count(*)::int AS n
            FROM statement_lines l
            JOIN crs_rules r ON r.id = l.classification_rule_id
           GROUP BY 1, 2, 3) x
   WHERE x.rule_id = p.rule_id
     AND x.financial_account_id IS NOT DISTINCT FROM p.account_id
     AND (p.account_id IS NOT NULL OR x.card_caixa_id = p.caixa_id);

  -- Unicidade das ativas no alvo: a regra que já é do alvo (a do cartão) fica; entre as
  -- migradas, vence a que já vencia (menor prioridade, a da caixa antes da global). A
  -- perdedora vira cópia arquivada se tem linhas no alvo; senão, não vai para ele.
  WITH cand AS (
    SELECT p.rule_id, p.caixa_id, p.account_id, r.match_kind, lower(r.pattern) AS pat, r.direction,
           false AS fixed, r.priority, (r.caixa_id IS NULL) AS is_global
      FROM crs_pairs p JOIN crs_rules r ON r.id = p.rule_id
     WHERE r.archived_at IS NULL
    UNION ALL
    SELECT r.id, r.caixa_id, r.financial_account_id, r.match_kind, lower(r.pattern), r.direction,
           true, r.priority, false
      FROM classification_rules r
     WHERE r.archived_at IS NULL AND r.caixa_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM crs_rules m WHERE m.id = r.id)
  ), ranked AS (
    SELECT c.*, row_number() OVER (PARTITION BY c.caixa_id, c.account_id, c.match_kind, c.pat, c.direction
                                   ORDER BY c.fixed DESC, c.priority, c.is_global, c.rule_id) AS rn
      FROM cand c
  )
  UPDATE crs_pairs p
     SET archive = true
    FROM ranked k
   WHERE NOT k.fixed AND k.rn > 1
     AND k.rule_id = p.rule_id AND k.caixa_id = p.caixa_id AND k.account_id IS NOT DISTINCT FROM p.account_id;

  DELETE FROM crs_pairs WHERE archive AND lines = 0;

  -- A original fica no alvo com mais linhas (ativo antes de arquivado); os demais são cópias.
  UPDATE crs_pairs p
     SET is_original = true
    FROM (SELECT DISTINCT ON (rule_id) rule_id, caixa_id, account_id
            FROM crs_pairs
           ORDER BY rule_id, lines DESC, archive, account_id NULLS LAST, caixa_id) o
   WHERE o.rule_id = p.rule_id AND o.caixa_id = p.caixa_id AND o.account_id IS NOT DISTINCT FROM p.account_id;
  UPDATE crs_pairs SET new_id = uuidv7() WHERE NOT is_original;

  -- Cópias: a mesma regra no alvo, com a origem da original, o uso do alvo e o histórico.
  INSERT INTO classification_rules (id, caixa_id, financial_account_id, match_kind, pattern, direction, entity_id,
                                    category_id, priority, origin, created_from_line_id, created_by_user_id,
                                    usage_count, last_used_at, archived_at, created_at, updated_at)
  SELECT p.new_id, p.caixa_id, p.account_id, r.match_kind, r.pattern, r.direction, r.entity_id,
         r.category_id, r.priority, r.origin,
         (SELECT l.id FROM statement_lines l
           WHERE l.id = r.created_from_line_id
             AND l.financial_account_id IS NOT DISTINCT FROM p.account_id
             AND (p.account_id IS NOT NULL OR l.card_caixa_id = p.caixa_id)),
         r.created_by_user_id, p.lines, CASE WHEN p.lines > 0 THEN r.last_used_at END,
         coalesce(r.archived_at, CASE WHEN p.archive THEN now() END), r.created_at, now()
    FROM crs_pairs p
    JOIN classification_rules r ON r.id = p.rule_id
   WHERE NOT p.is_original;

  UPDATE classification_rules r
     SET caixa_id = p.caixa_id,
         financial_account_id = p.account_id,
         usage_count = p.lines,
         last_used_at = CASE WHEN p.lines > 0 THEN r.last_used_at END,
         archived_at = coalesce(r.archived_at, CASE WHEN p.archive THEN now() END)
    FROM crs_pairs p
   WHERE p.rule_id = r.id AND p.is_original;

  -- As linhas passam para a cópia do alvo delas. Só classification_rule_id muda: a
  -- validação da linha, a imutabilidade do lote substituído (0049), o updated_at e a
  -- auditoria das linhas ficam desligados (a auditoria das regras registra a migração).
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_supersede_validate;
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
  ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;

  UPDATE statement_lines l
     SET classification_rule_id = p.new_id
    FROM crs_pairs p
   WHERE l.classification_rule_id = p.rule_id AND NOT p.is_original
     AND l.financial_account_id IS NOT DISTINCT FROM p.account_id
     AND (p.account_id IS NOT NULL OR l.card_caixa_id = p.caixa_id);

  -- Linha que não tem alvo de regra (conta que deixou de ser checking/savings) solta a regra.
  UPDATE statement_lines l
     SET classification_rule_id = NULL
    FROM classification_rules r
   WHERE l.classification_rule_id = r.id
     AND EXISTS (SELECT 1 FROM crs_rules m WHERE m.id = r.id)
     AND NOT (l.financial_account_id IS NOT DISTINCT FROM r.financial_account_id
              AND (r.financial_account_id IS NOT NULL OR l.card_caixa_id = r.caixa_id));

  -- Sem alvo e sem linha: removida (as globais sempre saem daqui, porque a original ganhou um alvo).
  DELETE FROM classification_rules r
   USING crs_rules m
   WHERE r.id = m.id
     AND NOT EXISTS (SELECT 1 FROM crs_pairs p WHERE p.rule_id = r.id AND p.is_original);

  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_supersede_validate;
  ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;

  DROP TABLE pg_temp.crs_pairs;
  DROP TABLE pg_temp.crs_rules;
END
$$;


--
-- Name: FUNCTION classification_rules_split_by_target(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.classification_rules_split_by_target() IS 'Uso interno (migração 0050, spec 032): leva as regras globais e de caixa geral sem conta para os alvos (conta checking/savings ou cartão), com uma cópia por alvo, as linhas reapontadas e o uso recontado. Não é usado pela aplicação.';


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
-- Name: classification_rules_validate_target(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classification_rules_validate_target() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  caixa_kind text;
  acc        financial_accounts;
BEGIN
  IF NEW.caixa_id IS NULL THEN
    RETURN NEW;  -- o NOT NULL de caixa_id recusa
  END IF;
  SELECT c.kind INTO caixa_kind FROM caixas c WHERE c.id = NEW.caixa_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK recusa
  END IF;

  IF caixa_kind = 'credit_card' THEN
    IF NEW.financial_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'classification_rules: a rule of card % has no account', NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.financial_account_id IS NULL THEN
    RAISE EXCEPTION 'classification_rules: a rule of caixa % needs an account', NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
  END IF;
  SELECT * INTO acc FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK recusa
  END IF;
  IF acc.caixa_id <> NEW.caixa_id THEN
    RAISE EXCEPTION 'classification_rules: account % is not in caixa %', acc.id, NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
  END IF;
  IF acc.kind NOT IN ('checking', 'savings') THEN
    RAISE EXCEPTION 'classification_rules: account % does not import statements (only checking/savings)', acc.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
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
  IF NOT FOUND OR st <> 'draft' THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM titles t WHERE t.contract_id = p_contract_id)
     OR EXISTS (SELECT 1 FROM card_purchases p WHERE p.contract_id = p_contract_id) THEN
    RAISE EXCEPTION 'contracts: draft contract % cannot have titles or card purchases', p_contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_draft_titles_check';
  END IF;
END
$$;


--
-- Name: FUNCTION contract_assert(p_contract_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.contract_assert(p_contract_id uuid) IS 'Interna (constraint triggers no COMMIT): rascunho sem títulos nem compras de cartão ligadas (contracts_draft_titles_check).';


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
    IF r.seq <> prev_seq + 1 OR (prev_seq > 0 AND (prev_end IS NULL OR r.starts_on <> prev_end + 1)) THEN
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
-- Name: contract_cycles_fill(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_cycles_fill() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  x timestamp;
BEGIN
  IF NEW.duration_months IS NOT NULL THEN
    x := NEW.starts_on + make_interval(months => NEW.duration_months);
    NEW.ends_on := CASE WHEN extract(day FROM x) < extract(day FROM NEW.starts_on) THEN x::date ELSE x::date - 1 END;
  END IF;
  NEW.installments_count := (CASE NEW.periodicity
                               WHEN 'monthly' THEN NEW.duration_months
                               WHEN 'quarterly' THEN NEW.duration_months / 3
                               WHEN 'semiannual' THEN NEW.duration_months / 6
                               WHEN 'annual' THEN NEW.duration_months / 12
                               WHEN 'single' THEN 1
                             END)::smallint;
  RETURN NEW;
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
-- Name: contract_payments(uuid, date, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contract_payments(p_contract_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date) RETURNS TABLE(kind text, recurrence_rule_id uuid, occurrence integer, title_id uuid, card_purchase_id uuid, caixa_id uuid, card_invoice_id uuid, description text, competence_date date, due_date date, amount_cents bigint, status text, settled_cents bigint, open_cents bigint, interest_cents bigint, fine_cents bigint, discount_cents bigint, cash_cents bigint, settlement_count integer, last_settled_on date, paid_on date, days integer, overdue boolean, not_charged boolean, account_id uuid, funding_account_id uuid, planned_account_id uuid, planned_account_custom boolean, last_origin text, settlements jsonb)
    LANGUAGE sql STABLE
    AS $$
  WITH obligations AS (
    SELECT t.*
      FROM titles t
     WHERE t.contract_id = p_contract_id
       AND t.mirror_status IS NULL           -- o lado do contrato (o espelho repete as baixas)
       AND t.status <> 'canceled'
       AND (p_from IS NULL OR t.due_date >= p_from)
       AND (p_to IS NULL OR t.due_date <= p_to)
  ), legs AS (
    SELECT s.id, s.title_id, s.settled_on, s.amount_cents, s.interest_cents, s.fine_cents, s.discount_cents,
           s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents AS cash_cents,
           s.financial_account_id,
           tr.id AS transfer_id,
           CASE o.direction WHEN 'payable' THEN tr.from_account_id ELSE tr.to_account_id END AS funding_account_id,
           ln.id AS statement_line_id,
           CASE WHEN ln.auto_settled THEN 'auto'
                WHEN ln.created_entry IN ('title', 'settlement', 'transfer_settlement') THEN 'reconciliation'
                ELSE 'manual' END AS origin,
           ln.id IS NOT NULL AS reconciled,
           (s.settled_on - o.due_date) AS days
      FROM settlements s
      JOIN obligations o ON o.id = s.title_id
      LEFT JOIN transfers tr ON tr.settlement_id = s.id
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry
          FROM statement_lines l
          JOIN movements m ON m.id = l.movement_id
         WHERE l.status = 'matched'
           AND (m.settlement_id IN (s.id, s.mirror_settlement_id)
                OR m.transfer_id IN (SELECT x.id FROM transfers x
                                      WHERE x.settlement_id IN (s.id, s.mirror_settlement_id)))
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE s.reversed_at IS NULL
  ), agg AS (
    SELECT g.title_id,
           sum(g.amount_cents)::bigint   AS settled_cents,
           sum(g.interest_cents)::bigint AS interest_cents,
           sum(g.fine_cents)::bigint     AS fine_cents,
           sum(g.discount_cents)::bigint AS discount_cents,
           sum(g.cash_cents)::bigint     AS cash_cents,
           count(*)::int                 AS settlement_count,
           jsonb_agg(jsonb_build_object(
             'id', g.id, 'settled_on', g.settled_on, 'amount_cents', g.amount_cents,
             'interest_cents', g.interest_cents, 'fine_cents', g.fine_cents, 'discount_cents', g.discount_cents,
             'cash_cents', g.cash_cents, 'financial_account_id', g.financial_account_id,
             'transfer_id', g.transfer_id, 'funding_account_id', g.funding_account_id,
             'statement_line_id', g.statement_line_id, 'reconciled', g.reconciled, 'origin', g.origin,
             'days', g.days) ORDER BY g.settled_on, g.id) AS settlements,
           (array_agg(g.settled_on ORDER BY g.settled_on DESC, g.id DESC))[1]           AS last_settled_on,
           (array_agg(g.financial_account_id ORDER BY g.settled_on DESC, g.id DESC))[1] AS account_id,
           (array_agg(g.funding_account_id ORDER BY g.settled_on DESC, g.id DESC))[1]   AS funding_account_id,
           (array_agg(g.origin ORDER BY g.settled_on DESC, g.id DESC))[1]               AS last_origin
      FROM legs g
     GROUP BY g.title_id
  ), title_rows AS (
    SELECT 'title'::text AS kind, o.recurrence_rule_id, o.occurrence::int AS occurrence, o.id AS title_id,
           NULL::uuid AS card_purchase_id, o.caixa_id, NULL::uuid AS card_invoice_id, o.description,
           o.competence_date, o.due_date, o.amount_cents, o.status,
           coalesce(a.settled_cents, 0) AS settled_cents, o.amount_cents - coalesce(a.settled_cents, 0) AS open_cents,
           coalesce(a.interest_cents, 0) AS interest_cents, coalesce(a.fine_cents, 0) AS fine_cents,
           coalesce(a.discount_cents, 0) AS discount_cents, coalesce(a.cash_cents, 0) AS cash_cents,
           coalesce(a.settlement_count, 0) AS settlement_count,
           a.last_settled_on,
           CASE WHEN o.status = 'paid' THEN a.last_settled_on END AS paid_on,
           CASE WHEN o.status = 'paid' THEN a.last_settled_on - o.due_date
                WHEN o.due_date < p_today THEN p_today - o.due_date END AS days,
           o.status <> 'paid' AND o.due_date < p_today AS overdue,
           false AS not_charged,
           a.account_id, a.funding_account_id, o.planned_account_id, o.planned_account_custom,
           a.last_origin, coalesce(a.settlements, '[]'::jsonb) AS settlements
      FROM obligations o
      LEFT JOIN agg a ON a.title_id = o.id
  ), charges AS (
    SELECT r.id AS rule_id, r.caixa_id AS card_caixa_id, r.frequency, r.interval_count, r.anchor_day, r.starts_on,
           r.installments_total, g.description,
           least(coalesce(r.ends_on, 'infinity'::date), coalesce(p_to, (p_today + interval '12 months')::date)) AS until
      FROM recurrence_rules r
      JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
     WHERE r.contract_id = p_contract_id
  ), expected AS (
    SELECT c.rule_id, n.n
      FROM charges c
     CROSS JOIN LATERAL generate_series(1, greatest(0, least(coalesce(c.installments_total::int, 32767),
       CASE c.frequency
         WHEN 'weekly' THEN (c.until - c.starts_on) / (7 * c.interval_count) + 1
         ELSE ((extract(year FROM c.until)::int * 12 + extract(month FROM c.until)::int)
               - (extract(year FROM c.starts_on)::int * 12 + extract(month FROM c.starts_on)::int))
              / (c.interval_count * CASE c.frequency WHEN 'yearly' THEN 12 ELSE 1 END) + 1
       END))) AS n (n)
     WHERE recurrence_occurrence_due(c.frequency, c.interval_count, c.anchor_day, c.starts_on, n.n) <= c.until
    UNION
    SELECT p.recurrence_rule_id, p.occurrence
      FROM card_purchases p JOIN charges c ON c.rule_id = p.recurrence_rule_id
     WHERE p.kind = 'purchase'
  ), occ AS (
    SELECT e.rule_id, e.n, c.card_caixa_id, c.description,
           recurrence_occurrence_due(c.frequency, c.interval_count, c.anchor_day, c.starts_on, e.n) AS due,
           card_recurring_charge_amount(e.rule_id, e.n) AS expected_cents
      FROM expected e JOIN charges c ON c.rule_id = e.rule_id
  ), card_rows AS (
    SELECT 'card_charge'::text AS kind, o.rule_id AS recurrence_rule_id, o.n AS occurrence, NULL::uuid AS title_id,
           pu.id AS card_purchase_id, o.card_caixa_id AS caixa_id,
           CASE WHEN pu.charged THEN pi.card_invoice_id ELSE inv.id END AS card_invoice_id, o.description,
           date_trunc('month', o.due::timestamp)::date AS competence_date, o.due AS due_date,
           o.expected_cents AS amount_cents,
           CASE WHEN pu.charged THEN 'charged' WHEN inv.closed_at IS NOT NULL THEN 'not_charged' ELSE 'expected' END AS status,
           CASE WHEN pu.charged THEN pu.net_cents ELSE 0 END AS settled_cents,
           CASE WHEN pu.charged THEN 0 ELSE o.expected_cents END AS open_cents,
           0::bigint AS interest_cents, 0::bigint AS fine_cents, 0::bigint AS discount_cents,
           CASE WHEN pu.charged THEN pu.net_cents ELSE 0 END AS cash_cents,
           CASE WHEN pu.charged THEN 1 ELSE 0 END AS settlement_count,
           CASE WHEN pu.charged THEN pu.purchased_on END AS last_settled_on,
           CASE WHEN pu.charged THEN pu.purchased_on END AS paid_on,
           CASE WHEN pu.charged THEN pu.purchased_on - o.due END AS days,
           false AS overdue,
           coalesce(NOT pu.charged, true) AND inv.closed_at IS NOT NULL AS not_charged,
           NULL::uuid AS account_id, NULL::uuid AS funding_account_id, NULL::uuid AS planned_account_id,
           false AS planned_account_custom,
           CASE WHEN pu.charged IS NOT TRUE THEN NULL WHEN ln.auto_settled THEN 'auto'
                WHEN ln.created_entry = 'purchase' THEN 'reconciliation' ELSE 'manual' END AS last_origin,
           CASE WHEN pu.charged THEN jsonb_build_array(jsonb_build_object(
             'card_purchase_id', pu.id, 'purchased_on', pu.purchased_on, 'amount_cents', pu.net_cents,
             'card_invoice_id', pi.card_invoice_id, 'statement_line_id', ln.id, 'reconciled', ln.id IS NOT NULL,
             'origin', CASE WHEN ln.auto_settled THEN 'auto' WHEN ln.created_entry = 'purchase' THEN 'reconciliation'
                            ELSE 'manual' END,
             'days', pu.purchased_on - o.due))
           ELSE '[]'::jsonb END AS settlements
      FROM occ o
      LEFT JOIN LATERAL (
        SELECT q.id, q.purchased_on, q.net_cents, q.net_cents > 0 AS charged
          FROM (SELECT p.id, p.purchased_on,
                       p.amount_cents - coalesce((SELECT sum(x.amount_cents) FROM card_purchases x
                                                   WHERE x.refunded_purchase_id = p.id), 0)::bigint AS net_cents
                  FROM card_purchases p
                 WHERE p.recurrence_rule_id = o.rule_id AND p.occurrence = o.n AND p.kind = 'purchase') q
         ORDER BY q.net_cents > 0 DESC, q.purchased_on DESC, q.id DESC
         LIMIT 1
      ) pu ON true
      LEFT JOIN LATERAL (
        SELECT i.id AS item_id, i.card_invoice_id FROM card_invoice_items i
         WHERE i.card_purchase_id = pu.id AND pu.charged ORDER BY i.installment_number LIMIT 1
      ) pi ON true
      LEFT JOIN LATERAL (
        SELECT v.id, v.closed_at FROM card_invoices v
         WHERE v.card_caixa_id = o.card_caixa_id AND v.closing_date >= o.due
         ORDER BY v.closing_date LIMIT 1
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry FROM statement_lines l
         WHERE l.status = 'matched' AND l.card_invoice_item_id = pi.item_id
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE (p_from IS NULL OR o.due >= p_from) AND (p_to IS NULL OR o.due <= p_to)
  ), loose_rows AS (
    -- Compra ligada só ao contrato (sem ocorrência de série).
    SELECT 'card_charge'::text AS kind, NULL::uuid AS recurrence_rule_id, NULL::int AS occurrence, NULL::uuid AS title_id,
           p.id AS card_purchase_id, p.card_caixa_id AS caixa_id, pi.card_invoice_id, p.description,
           date_trunc('month', p.purchased_on::timestamp)::date AS competence_date, p.purchased_on AS due_date,
           p.amount_cents, 'charged'::text AS status, net.cents AS settled_cents, 0::bigint AS open_cents,
           0::bigint AS interest_cents, 0::bigint AS fine_cents, 0::bigint AS discount_cents, net.cents AS cash_cents,
           1 AS settlement_count, p.purchased_on AS last_settled_on, p.purchased_on AS paid_on, 0 AS days,
           false AS overdue, false AS not_charged,
           NULL::uuid AS account_id, NULL::uuid AS funding_account_id, NULL::uuid AS planned_account_id,
           false AS planned_account_custom,
           CASE WHEN ln.auto_settled THEN 'auto' WHEN ln.created_entry = 'purchase' THEN 'reconciliation'
                ELSE 'manual' END AS last_origin,
           jsonb_build_array(jsonb_build_object(
             'card_purchase_id', p.id, 'purchased_on', p.purchased_on, 'amount_cents', net.cents,
             'card_invoice_id', pi.card_invoice_id, 'statement_line_id', ln.id, 'reconciled', ln.id IS NOT NULL,
             'origin', CASE WHEN ln.auto_settled THEN 'auto' WHEN ln.created_entry = 'purchase' THEN 'reconciliation'
                            ELSE 'manual' END,
             'days', 0)) AS settlements
      FROM card_purchases p
      CROSS JOIN LATERAL (
        SELECT p.amount_cents - coalesce((SELECT sum(x.amount_cents) FROM card_purchases x
                                           WHERE x.refunded_purchase_id = p.id), 0)::bigint AS cents
      ) net
      LEFT JOIN LATERAL (
        SELECT i.id AS item_id, i.card_invoice_id FROM card_invoice_items i
         WHERE i.card_purchase_id = p.id ORDER BY i.installment_number LIMIT 1
      ) pi ON true
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry FROM statement_lines l
         WHERE l.status = 'matched' AND l.card_invoice_item_id = pi.item_id
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE p.contract_id = p_contract_id AND p.recurrence_rule_id IS NULL AND p.kind = 'purchase' AND net.cents > 0
       AND (p_from IS NULL OR p.purchased_on >= p_from) AND (p_to IS NULL OR p.purchased_on <= p_to)
  )
  SELECT * FROM (
    SELECT * FROM title_rows
    UNION ALL
    SELECT * FROM card_rows
    UNION ALL
    SELECT * FROM loose_rows
  ) x
  ORDER BY x.due_date, x.kind DESC, x.occurrence NULLS LAST, x.title_id, x.card_purchase_id
$$;


--
-- Name: FUNCTION contract_payments(p_contract_id uuid, p_from date, p_to date, p_today date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.contract_payments(p_contract_id uuid, p_from date, p_to date, p_today date) IS 'Pagamentos das obrigações de um contrato (spec 034), com vencimento entre p_from e p_to (nulos = sem limite), em ordem de vencimento. kind = title: os títulos não cancelados do lado do contrato (ocorrências das séries dele e avulsos ligados), com as baixas ativas somadas e uma a uma em settlements (como na 033: conta, transferência, funding_account_id, linha, origin manual|reconciliation|auto, days); paid_on = data da última baixa do título pago; days = paid_on − vencimento ou, em aberto vencido, p_today − vencimento (overdue). kind = card_charge: as ocorrências esperadas das cobranças no cartão do contrato (calendário da série até o fim dela e até p_to, ou p_today + 12 meses), mais as que têm compra ligada; amount_cents = valor esperado; status charged (compra ligada não estornada por inteiro: settled/cash = valor líquido da compra, paid_on = data da compra, days = compra − data esperada), not_charged (a fatura que fecha na data esperada ou depois já fechou sem compra; not_charged = true) ou expected; card_invoice_id = a fatura da compra ou a esperada; e as compras ligadas só ao contrato, sem ocorrência (recurrence_rule_id nulo). SECURITY INVOKER; quem lê o contrato é a aplicação, que monta o resumo.';


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
      OR (OLD.status = 'active' AND NEW.status IN ('ended', 'terminated'))
      OR (OLD.status = 'ended' AND NEW.status = 'active')
      -- só a migração 0052 (renewal_pending some): renewal_pending → active
      OR (OLD.status = 'renewal_pending' AND NEW.status = 'active')) THEN
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
-- Name: financial_accounts_validate_payment_refs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.financial_accounts_validate_payment_refs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.caixa_id <> OLD.caixa_id AND EXISTS (SELECT 1 FROM titles t WHERE t.planned_account_id = OLD.id) THEN
    RAISE EXCEPTION 'financial_accounts: account % is the planned account of a title and cannot change caixa', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_planned_account_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: financial_accounts_validate_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.financial_accounts_validate_rules() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.caixa_id <> OLD.caixa_id OR NEW.kind NOT IN ('checking', 'savings'))
     AND EXISTS (SELECT 1 FROM classification_rules r WHERE r.financial_account_id = OLD.id) THEN
    RAISE EXCEPTION 'financial_accounts: account % has classification rules and must stay a checking/savings account of caixa %',
      OLD.id, OLD.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_account_check';
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
    CONSTRAINT message_outbox_event_kind_check CHECK ((event_kind = ANY (ARRAY['due_reminder'::text, 'overdue'::text, 'daily_summary'::text, 'weekly_summary'::text, 'invoice_closed'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'agent_completed'::text, 'agent_message'::text, 'contract_notice_deadline'::text, 'contract_ending'::text, 'contract_renewal_pending'::text, 'contract_readjustment'::text, 'ai_budget_alert'::text, 'ai_awaiting_approval'::text, 'test'::text]))),
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
    WHEN 'invoice_closed', 'agent_completed', 'agent_message', 'ai_budget_alert', 'ai_awaiting_approval' THEN
      allowed := '{}'; required := '{}';
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

COMMENT ON FUNCTION public.message_subscription_params_valid(p_event_kind text, p_params jsonb) IS 'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent 1–200; repeat_every_days 1–30; invoice_closed, agent_completed, agent_message, ai_budget_alert e ai_awaiting_approval sem parâmetros). Usada no CHECK de message_subscriptions.';


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
-- Name: period_closings_provisional_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.period_closings_provisional_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  imports text;
BEGIN
  SELECT string_agg(DISTINCT l.statement_import_id::text, ', ') INTO imports
    FROM statement_lines l
    JOIN financial_accounts a ON a.id = l.financial_account_id
    JOIN statement_imports i ON i.id = l.statement_import_id
   WHERE a.caixa_id = NEW.caixa_id
     AND l.posted_on >= NEW.month AND l.posted_on < (NEW.month + interval '1 month')::date
     AND ((i.provisional AND i.superseded_by_import_id IS NULL) OR l.supersede_outcome = 'pending');
  IF imports IS NOT NULL THEN
    RAISE EXCEPTION 'period_closings: month % of caixa % has lines of an active provisional import or pending lines (imports: %)',
      to_char(NEW.month, 'YYYY-MM'), NEW.caixa_id, imports
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_provisional_check';
  END IF;
  RETURN NEW;
END
$$;


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
-- Name: recurrence_occurrence_due(text, integer, integer, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurrence_occurrence_due(p_frequency text, p_interval_count integer, p_anchor_day integer, p_starts_on date, p_occurrence integer) RETURNS date
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
DECLARE
  m date;
BEGIN
  IF p_occurrence IS NULL OR p_occurrence < 1 OR p_starts_on IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_frequency = 'weekly' THEN
    RETURN p_starts_on + ((p_anchor_day - extract(isodow FROM p_starts_on)::int + 7) % 7)
                       + (p_occurrence - 1) * 7 * p_interval_count;
  END IF;
  m := (date_trunc('month', p_starts_on::timestamp)
        + make_interval(months => (p_occurrence - 1) * p_interval_count
                                  * CASE p_frequency WHEN 'yearly' THEN 12 ELSE 1 END))::date;
  RETURN m + least(p_anchor_day, extract(day FROM ((m + interval '1 month')::date - 1))::int) - 1;
END
$$;


--
-- Name: FUNCTION recurrence_occurrence_due(p_frequency text, p_interval_count integer, p_anchor_day integer, p_starts_on date, p_occurrence integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.recurrence_occurrence_due(p_frequency text, p_interval_count integer, p_anchor_day integer, p_starts_on date, p_occurrence integer) IS 'Data da ocorrência n (1 = primeira) de uma série (spec 005), igual a occurrenceDueDate do shared: weekly = primeira data >= starts_on no dia ISO âncora + (n−1)·7·intervalo dias; monthly/yearly = mês de starts_on + (n−1)·intervalo (·12 no yearly) meses, no dia âncora (meses curtos: o último dia).';


--
-- Name: recurrence_rule_assert(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurrence_rule_assert(p_rule_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  r          recurrence_rules;
  ck         text;
  has_charge boolean;
  dir        text;
  bad        uuid;
BEGIN
  SELECT * INTO r FROM recurrence_rules x WHERE x.id = p_rule_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT c.kind INTO ck FROM caixas c WHERE c.id = r.caixa_id;
  has_charge := EXISTS (SELECT 1 FROM card_recurring_charges g WHERE g.recurrence_rule_id = r.id);
  IF coalesce(ck = 'credit_card', false) <> has_charge THEN
    RAISE EXCEPTION 'recurrence_rules: series % in a % caixa must % a card charge', r.id, ck,
      CASE WHEN has_charge THEN 'not have' ELSE 'have' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recurrence_rules_target_check';
  END IF;

  -- Títulos: o lado original fica na caixa da série; série de cartão não tem títulos.
  SELECT t.id INTO bad FROM titles t
   WHERE t.recurrence_rule_id = r.id AND (has_charge OR (t.mirror_status IS NULL AND t.caixa_id <> r.caixa_id))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'titles: title % of series % must be in the series caixa %', bad, r.id, r.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_recurrence_caixa_check';
  END IF;

  -- Contrato: os títulos e as compras ligadas carregam o contrato da série.
  SELECT t.id INTO bad FROM titles t
   WHERE t.recurrence_rule_id = r.id AND t.contract_id IS DISTINCT FROM r.contract_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'titles: title % of series % must have the series contract %', bad, r.id, r.contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_recurrence_contract_check';
  END IF;
  SELECT p.id INTO bad FROM card_purchases p
   WHERE p.recurrence_rule_id = r.id AND p.contract_id IS DISTINCT FROM r.contract_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'card_purchases: purchase % of series % must have the series contract %', bad, r.id, r.contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_recurrence_contract_check';
  END IF;

  -- Cobrança no cartão só em contrato a pagar.
  IF has_charge AND r.contract_id IS NOT NULL THEN
    SELECT k.direction INTO dir FROM contracts k WHERE k.id = r.contract_id;
    IF dir = 'receivable' THEN
      RAISE EXCEPTION 'card_recurring_charges: card charge % belongs to a receivable contract %', r.id, r.contract_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_contract_check';
    END IF;
  END IF;
END
$$;


--
-- Name: FUNCTION recurrence_rule_assert(p_rule_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.recurrence_rule_assert(p_rule_id uuid) IS 'Interna (constraint triggers no COMMIT): série em caixa de cartão ⇔ tem card_recurring_charges (recurrence_rules_target_check); lado original dos títulos na caixa da série e série de cartão sem títulos (titles_recurrence_caixa_check); títulos e compras ligadas com o contrato da série (titles_recurrence_contract_check, card_purchases_recurrence_contract_check); cobrança no cartão só em contrato a pagar (card_recurring_charges_contract_check).';


--
-- Name: recurrence_rule_integrity_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurrence_rule_integrity_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'recurrence_rules' THEN
    PERFORM recurrence_rule_assert(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM recurrence_rule_assert(OLD.recurrence_rule_id);
  ELSIF NEW.recurrence_rule_id IS NOT NULL THEN
    PERFORM recurrence_rule_assert(NEW.recurrence_rule_id);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: recurrence_rules_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurrence_rules_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.installments_total IS NOT NULL
     AND (EXISTS (SELECT 1 FROM titles t WHERE t.recurrence_rule_id = NEW.id AND t.occurrence > NEW.installments_total)
          OR EXISTS (SELECT 1 FROM card_purchases p
                      WHERE p.recurrence_rule_id = NEW.id AND p.occurrence > NEW.installments_total)) THEN
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
-- Name: statement_imports_supersede_commit_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_imports_supersede_commit_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  imp   statement_imports;
  other uuid;
BEGIN
  SELECT * INTO imp FROM statement_imports i WHERE i.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF imp.provisional AND imp.superseded_by_import_id IS NULL THEN
    -- Serializa os provisórios da conta: quem chega depois relê depois do COMMIT do outro.
    PERFORM pg_advisory_xact_lock(hashtextextended('statement_imports_provisional:' || imp.financial_account_id::text, 0));
    SELECT s.id INTO other
      FROM statement_imports s
     WHERE s.financial_account_id = imp.financial_account_id AND s.id <> imp.id
       AND s.provisional AND s.superseded_by_import_id IS NULL
       AND s.period_start <= imp.period_end AND imp.period_start <= s.period_end
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'statement_imports: provisional import % overlaps active provisional import % of the same account',
        imp.id, other
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_provisional_overlap_check';
    END IF;
  END IF;

  IF imp.superseded_by_import_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM statement_lines l WHERE l.statement_import_id = imp.id AND l.supersede_outcome IS NULL) THEN
    RAISE EXCEPTION 'statement_imports: every line of superseded import % needs a supersede_outcome', imp.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_lines_check';
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: statement_imports_supersede_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_imports_supersede_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target statement_imports;
  caixa  uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.superseded_by_import_id IS NOT NULL THEN
      RAISE EXCEPTION 'statement_imports: import % was superseded and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_immutable_check';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.superseded_by_import_id IS NOT NULL
     AND (NEW.provisional IS DISTINCT FROM OLD.provisional
          OR NEW.superseded_by_import_id IS DISTINCT FROM OLD.superseded_by_import_id
          OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'statement_imports: import % was superseded; provisional and the supersession are final', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_immutable_check';
  END IF;

  -- A troca: o substituto é da mesma conta e, no UPDATE (a troca ao vivo), não está substituído. No INSERT (restauração
  -- de um backup) a cadeia já aconteceu e o substituto pode ter sido substituído depois.
  IF NEW.superseded_by_import_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.superseded_by_import_id IS NULL) THEN
    SELECT * INTO target FROM statement_imports i WHERE i.id = NEW.superseded_by_import_id;
    IF FOUND AND (target.financial_account_id IS DISTINCT FROM NEW.financial_account_id
                  OR (TG_OP = 'UPDATE' AND target.superseded_by_import_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'statement_imports: import % can only be superseded by an import of the same account that is not superseded',
        NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_by_check';
    END IF;
  END IF;

  -- Marcar como provisório.
  IF TG_OP = 'UPDATE' AND NEW.provisional AND NOT OLD.provisional THEN
    IF EXISTS (SELECT 1 FROM statement_imports s WHERE s.superseded_by_import_id = NEW.id) THEN
      RAISE EXCEPTION 'statement_imports: import % already superseded another import and cannot become provisional', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_provisional_supersedes_check';
    END IF;
    SELECT a.caixa_id INTO caixa FROM financial_accounts a WHERE a.id = NEW.financial_account_id;
    IF EXISTS (SELECT 1 FROM statement_lines l
                WHERE l.statement_import_id = NEW.id AND period_is_closed(caixa, l.posted_on)) THEN
      RAISE EXCEPTION 'statement_imports: import % has lines in a closed month of caixa % and cannot become provisional',
        NEW.id, caixa
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_provisional_closed_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: statement_imports_sync_provisional(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_imports_sync_provisional() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE statement_lines SET provisional = NEW.provisional
   WHERE statement_import_id = NEW.id AND provisional IS DISTINCT FROM NEW.provisional;
  RETURN NULL;
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
-- Name: statement_line_inferred_created_entry(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_line_inferred_created_entry(p_line_id uuid) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE
           WHEN l.status <> 'matched' THEN NULL
           WHEN m.kind = 'adjustment' AND m.created_at = l.matched_at THEN 'adjustment'
           WHEN m.kind = 'settlement' AND t.created_at = l.matched_at THEN 'title'
           WHEN m.kind = 'settlement' AND s.created_at = l.matched_at THEN 'settlement'
           WHEN p.created_at = l.matched_at THEN 'purchase'
         END
    FROM statement_lines l
    LEFT JOIN movements m ON m.id = l.movement_id
    LEFT JOIN settlements s ON s.id = m.settlement_id
    LEFT JOIN titles t ON t.id = s.title_id
    LEFT JOIN card_invoice_items i ON i.id = l.card_invoice_item_id
    LEFT JOIN card_purchases p ON p.id = i.card_purchase_id
   WHERE l.id = p_line_id
$$;


--
-- Name: FUNCTION statement_line_inferred_created_entry(p_line_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.statement_line_inferred_created_entry(p_line_id uuid) IS 'Uso interno (backfill da 0048): created_entry inferido para uma linha matched pelo instante de criação do lançamento igual ao matched_at (mesma transação). Nulo se o lançamento é mais antigo que a conciliação. Não é usado pela aplicação, que grava created_entry ao conciliar.';


--
-- Name: statement_lines_supersede_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_lines_supersede_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  imp            statement_imports;
  target         statement_lines;
  caixa          uuid;
  links_changed  boolean;
  class_changed  boolean;
  sugg_changed   boolean;
  line_changed   boolean;
  swap_ok        boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM statement_imports i
                WHERE i.id = OLD.statement_import_id AND i.superseded_by_import_id IS NOT NULL) THEN
      RAISE EXCEPTION 'statement_lines: line % belongs to a superseded import and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO imp FROM statement_imports i WHERE i.id = NEW.statement_import_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK recusa
  END IF;

  -- A marca é a do lote: copiada no INSERT; só muda acompanhando o lote.
  IF TG_OP = 'INSERT' THEN
    NEW.provisional := imp.provisional;
  ELSIF NEW.provisional IS DISTINCT FROM OLD.provisional AND NEW.provisional IS DISTINCT FROM imp.provisional THEN
    RAISE EXCEPTION 'statement_lines: provisional of line % follows its import %', OLD.id, imp.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_provisional_check';
  END IF;

  -- Provisório ativo não entra em mês fechado.
  IF TG_OP = 'INSERT' AND imp.provisional AND imp.superseded_by_import_id IS NULL THEN
    SELECT a.caixa_id INTO caixa FROM financial_accounts a WHERE a.id = imp.financial_account_id;
    IF period_is_closed(caixa, NEW.posted_on) THEN
      RAISE EXCEPTION 'statement_lines: provisional import % cannot have a line in closed month % of caixa %',
        imp.id, to_char(NEW.posted_on, 'YYYY-MM'), caixa
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_provisional_closed_check';
    END IF;
  END IF;

  -- Desfecho só em lote substituído; linha de lote substituído sempre com desfecho.
  IF imp.superseded_by_import_id IS NULL THEN
    IF NEW.supersede_outcome IS NOT NULL THEN
      RAISE EXCEPTION 'statement_lines: supersede_outcome only on lines of a superseded import (line %)', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_import_check';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.supersede_outcome IS NULL THEN
    RAISE EXCEPTION 'statement_lines: a line of superseded import % needs a supersede_outcome', imp.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_superseded_lines_check';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    links_changed := NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id
                     OR NEW.title_id IS DISTINCT FROM OLD.title_id
                     OR NEW.card_invoice_item_id IS DISTINCT FROM OLD.card_invoice_item_id
                     OR NEW.matched_at IS DISTINCT FROM OLD.matched_at
                     OR NEW.created_entry IS DISTINCT FROM OLD.created_entry;
    -- A regra excluída (FK ON DELETE SET NULL) pode soltar classification_rule_id.
    class_changed := NEW.entity_id IS DISTINCT FROM OLD.entity_id
                     OR NEW.category_id IS DISTINCT FROM OLD.category_id
                     OR NEW.classification_source IS DISTINCT FROM OLD.classification_source
                     OR (NEW.classification_rule_id IS DISTINCT FROM OLD.classification_rule_id
                         AND NEW.classification_rule_id IS NOT NULL);
    sugg_changed  := NEW.supersede_suggested_line_id IS DISTINCT FROM OLD.supersede_suggested_line_id
                     OR NEW.supersede_suggestion_reason IS DISTINCT FROM OLD.supersede_suggestion_reason;
    line_changed  := NEW.superseded_by_line_id IS DISTINCT FROM OLD.superseded_by_line_id;

    -- A troca: a conciliada transfere ou fica pendente (como está); as demais casam ou são descartadas.
    swap_ok := CASE NEW.supersede_outcome
                 WHEN 'transferred' THEN OLD.status = 'matched'
                 WHEN 'pending'     THEN OLD.status = 'matched' AND NOT links_changed
                 WHEN 'paired'      THEN OLD.status <> 'matched'
                 WHEN 'dropped'     THEN OLD.status <> 'matched'
                 ELSE false
               END;

    IF class_changed THEN
      RAISE EXCEPTION 'statement_lines: line % of a superseded import cannot change its classification', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
    END IF;

    IF OLD.supersede_outcome IS NULL THEN
      IF NEW.supersede_outcome IS NULL THEN
        IF links_changed OR line_changed OR sugg_changed THEN
          RAISE EXCEPTION 'statement_lines: line % of a superseded import only changes by its supersede outcome', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
        END IF;
      ELSIF NOT swap_ok THEN
        RAISE EXCEPTION 'statement_lines: line % (status %) cannot be superseded as %', OLD.id, OLD.status, NEW.supersede_outcome
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_transition_check';
      END IF;
    ELSIF OLD.supersede_outcome = 'pending' THEN
      IF NEW.supersede_outcome = 'pending' THEN
        IF links_changed OR line_changed THEN
          RAISE EXCEPTION 'statement_lines: pending line % only changes by leaving pending or by its suggestion', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
        END IF;
      ELSIF NOT coalesce(NEW.supersede_outcome IN ('transferred', 'kept')
                         OR (NEW.supersede_outcome = 'entry_deleted' AND OLD.created_entry IS NOT NULL), false) THEN
        RAISE EXCEPTION 'statement_lines: pending line % cannot become %', OLD.id, coalesce(NEW.supersede_outcome, 'NULL')
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_transition_check';
      END IF;
    ELSE
      IF NEW.supersede_outcome IS DISTINCT FROM OLD.supersede_outcome THEN
        RAISE EXCEPTION 'statement_lines: supersede outcome % of line % is final', OLD.supersede_outcome, OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_transition_check';
      END IF;
      IF links_changed OR line_changed OR sugg_changed THEN
        RAISE EXCEPTION 'statement_lines: line % of a superseded import is read-only', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_immutable_check';
      END IF;
    END IF;
  END IF;

  -- A linha que ficou no lugar e a sugestão: do lote substituto (a sugestão com o mesmo valor).
  IF NEW.superseded_by_line_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.superseded_by_line_id IS DISTINCT FROM OLD.superseded_by_line_id) THEN
    SELECT * INTO target FROM statement_lines l WHERE l.id = NEW.superseded_by_line_id;
    IF FOUND AND (target.statement_import_id <> imp.superseded_by_import_id
                  OR target.financial_account_id IS DISTINCT FROM NEW.financial_account_id) THEN
      RAISE EXCEPTION 'statement_lines: line % must be superseded by a line of import %', NEW.id, imp.superseded_by_import_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_superseded_by_line_check';
    END IF;
  END IF;

  IF NEW.supersede_suggested_line_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.supersede_suggested_line_id IS DISTINCT FROM OLD.supersede_suggested_line_id) THEN
    SELECT * INTO target FROM statement_lines l WHERE l.id = NEW.supersede_suggested_line_id;
    IF FOUND AND (target.statement_import_id <> imp.superseded_by_import_id OR target.amount_cents <> NEW.amount_cents) THEN
      RAISE EXCEPTION 'statement_lines: suggestion for line % must be a line of import % with the same amount',
        NEW.id, imp.superseded_by_import_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_supersede_suggestion_target_check';
    END IF;
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
-- Name: statement_lines_validate_created_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.statement_lines_validate_created_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.created_entry = 'transfer_settlement'
     AND NOT EXISTS (SELECT 1 FROM movements m JOIN transfers tr ON tr.id = m.transfer_id
                      WHERE m.id = NEW.movement_id AND tr.settlement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'statement_lines: transfer_settlement needs the movement of a transfer that funds a settlement (line %)',
      NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_created_entry_links_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: telegram_inbound_bot_token(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_inbound_bot_token(p_destination_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  d record;
BEGIN
  SELECT x.channel, x.is_active, x.archived_at, x.webhook_secret_hash IS NOT NULL AS has_secret, x.bot_token
    INTO d
    FROM public.message_destinations x
   WHERE x.id = p_destination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telegram_inbound_bot_token: destination % not found', p_destination_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF d.channel <> 'telegram' OR NOT d.is_active OR d.archived_at IS NOT NULL OR NOT d.has_secret THEN
    RAISE EXCEPTION 'telegram_inbound_bot_token: destination % is inactive, archived or has no inbound webhook',
      p_destination_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN d.bot_token;
END
$$;


--
-- Name: FUNCTION telegram_inbound_bot_token(p_destination_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_inbound_bot_token(p_destination_id uuid) IS 'Leitura do bot token para a ENTRADA do Telegram (spec 029): setWebhook/deleteWebhook, answerCallbackQuery, getFile e download de arquivo, sendChatAction e respostas diretas ao chat privado pareado. Devolve o token só de destino telegram ativo, não arquivado e com webhook_secret_hash (entrada ligada ou já ligada); enxerga o hash gravado na mesma transação. 42501 em qualquer outro caso; P0002 se o destino não existe. O token nunca vai para logs, respostas da API, auditoria, eventos ou tools.';


--
-- Name: telegram_links_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_links_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.destination_id <> OLD.destination_id OR NEW.user_id <> OLD.user_id OR NEW.chat_id <> OLD.chat_id
     OR NEW.telegram_user_id <> OLD.telegram_user_id THEN
    RAISE EXCEPTION 'telegram_links: destination, user and chat of link % are immutable (pair again)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_links_immutable_check';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'telegram_links: link % is revoked', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_links_revoked_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: telegram_pairing_code_create(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_pairing_code_create(p_user_id uuid, p_destination_id uuid, p_code text) RETURNS TABLE(id uuid, expires_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
#variable_conflict use_column
DECLARE
  c text := upper(btrim(p_code));
BEGIN
  IF c IS NULL OR c !~ '^[A-Z0-9]{8}$' THEN
    RAISE EXCEPTION 'telegram_pairing_code_create: the code must have 8 letters or digits'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  INSERT INTO telegram_pairing_codes AS k (user_id, destination_id, code_hash)
  VALUES (p_user_id, p_destination_id, telegram_secret_hash(c))
  RETURNING k.id, k.expires_at;
END
$_$;


--
-- Name: FUNCTION telegram_pairing_code_create(p_user_id uuid, p_destination_id uuid, p_code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_pairing_code_create(p_user_id uuid, p_destination_id uuid, p_code text) IS 'Grava um código de pareamento (só o hash do código em maiúsculas), válido por 10 min, e devolve id e expiração. 22023 se o código não tem 8 letras ou dígitos; 23514 telegram_pairing_codes_destination_check se o destino não está ativo com a entrada ligada; 23505 telegram_pairing_codes_code_hash_key se o código já foi emitido (gere outro). Quem pode usar o destino é regra da aplicação.';


--
-- Name: telegram_pairing_codes_validate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_pairing_codes_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM message_destinations d
                    WHERE d.id = NEW.destination_id AND d.inbound_enabled AND d.is_active) THEN
      RAISE EXCEPTION 'telegram_pairing_codes: destination % does not receive messages', NEW.destination_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_pairing_codes_destination_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.destination_id <> OLD.destination_id OR NEW.code_hash <> OLD.code_hash
     OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.link_id IS NOT NULL AND NEW.link_id IS NOT NULL AND NEW.link_id <> OLD.link_id) THEN
    RAISE EXCEPTION 'telegram_pairing_codes: code % is immutable and single-use', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'telegram_pairing_codes_immutable_check';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: telegram_pairing_consume(uuid, text, bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_pairing_consume(p_destination_id uuid, p_code text, p_chat_id bigint, p_telegram_user_id bigint, p_username text DEFAULT NULL::text) RETURNS TABLE(link_id uuid, user_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  k public.telegram_pairing_codes;
  l public.telegram_links;
  uname text := nullif(ltrim(btrim(p_username), '@'), '');
BEGIN
  IF p_chat_id IS NULL OR p_chat_id <= 0 OR p_telegram_user_id IS NULL OR p_telegram_user_id <= 0 THEN
    RAISE EXCEPTION 'telegram_pairing_consume: only private chats pair (positive chat and user ids)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_code IS NULL THEN
    RETURN;
  END IF;

  SELECT c.* INTO k
    FROM public.telegram_pairing_codes c
    JOIN public.users u ON u.id = c.user_id AND u.is_active
    JOIN public.message_destinations d ON d.id = c.destination_id AND d.inbound_enabled AND d.is_active
   WHERE c.code_hash = public.telegram_secret_hash(upper(btrim(p_code)))
     AND c.destination_id = p_destination_id
     AND c.used_at IS NULL
     AND c.expires_at > clock_timestamp()
     FOR UPDATE OF c;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Quem pareou é o dono do código (o webhook não tem sessão): o ator da auditoria no resto da transação.
  IF nullif(current_setting('app.user_id', true), '') IS NULL THEN
    PERFORM set_config('app.user_id', k.user_id::text, true);
  END IF;

  SELECT x.* INTO l FROM public.telegram_links x
   WHERE x.destination_id = p_destination_id AND x.chat_id = p_chat_id AND x.revoked_at IS NULL
     FOR UPDATE;
  IF FOUND AND l.user_id <> k.user_id THEN
    -- O chat passa para o dono do código: o vínculo anterior é desfeito.
    UPDATE public.telegram_links x SET revoked_at = clock_timestamp() WHERE x.id = l.id;
    l := NULL;
  END IF;

  IF l.id IS NULL THEN
    INSERT INTO public.telegram_links AS x (destination_id, user_id, chat_id, telegram_user_id, username)
    VALUES (p_destination_id, k.user_id, p_chat_id, p_telegram_user_id, uname)
    RETURNING x.* INTO l;
  ELSIF l.username IS DISTINCT FROM uname THEN
    UPDATE public.telegram_links x SET username = uname WHERE x.id = l.id;
  END IF;

  UPDATE public.telegram_pairing_codes c SET used_at = clock_timestamp(), link_id = l.id WHERE c.id = k.id;
  RETURN QUERY SELECT l.id, l.user_id;
END
$$;


--
-- Name: FUNCTION telegram_pairing_consume(p_destination_id uuid, p_code text, p_chat_id bigint, p_telegram_user_id bigint, p_username text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_pairing_consume(p_destination_id uuid, p_code text, p_chat_id bigint, p_telegram_user_id bigint, p_username text) IS '/start <código>: confere o código (maiúsculas, sem espaços nas pontas) contra os não usados e não expirados do destino, de dono ativo e destino ativo com a entrada ligada; marca o código usado e liga o chat ao dono (se o chat já estava ligado a outro usuário no destino, aquele vínculo é desfeito; se ao mesmo, é mantido). Devolve (link_id, user_id), ou nenhuma linha com código errado, expirado, usado ou de outro destino. Sem app.user_id na transação, define-o como o dono do código (ator da auditoria). 22023 se o chat ou o usuário do Telegram não é positivo (só chats privados pareiam).';


--
-- Name: telegram_secret_hash(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_secret_hash(p_value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  SELECT encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
$$;


--
-- Name: FUNCTION telegram_secret_hash(p_value text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_secret_hash(p_value text) IS 'SHA-256 (hex minúsculo) do texto em UTF-8: o formato de message_destinations.webhook_secret_hash e de telegram_pairing_codes.code_hash (igual a createHash(''sha256'').update(valor, ''utf8'').digest(''hex'') no Node).';


--
-- Name: telegram_update_seen(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_update_seen(p_destination_id uuid, p_update_id bigint) RETURNS boolean
    LANGUAGE sql
    AS $$
  WITH ins AS (
    INSERT INTO telegram_updates_seen (destination_id, update_id) VALUES (p_destination_id, p_update_id)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT NOT EXISTS (SELECT 1 FROM ins)
$$;


--
-- Name: FUNCTION telegram_update_seen(p_destination_id uuid, p_update_id bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_update_seen(p_destination_id uuid, p_update_id bigint) IS 'Marca o update_id do destino como recebido. Devolve false na primeira vez (processe) e true se já tinha sido visto (ignore). Chame na mesma transação que processa a atualização, para uma falha não marcar o que não foi feito.';


--
-- Name: telegram_updates_seen_purge(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_updates_seen_purge(p_keep interval DEFAULT '7 days'::interval) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
  n bigint;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '1 hour' THEN
    RAISE EXCEPTION 'telegram_updates_seen_purge: keep must be >= 1 hour' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM telegram_updates_seen s WHERE s.created_at < clock_timestamp() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;


--
-- Name: FUNCTION telegram_updates_seen_purge(p_keep interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_updates_seen_purge(p_keep interval) IS 'Apaga os update_id vistos há mais de p_keep (padrão 7 dias; o Telegram desiste de reentregar bem antes) e devolve quantos. 22023 com prazo nulo ou < 1 hora.';


--
-- Name: telegram_webhook_authenticate(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.telegram_webhook_authenticate(p_destination_id uuid, p_secret text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT coalesce((SELECT d.webhook_secret_hash = public.telegram_secret_hash(p_secret)
                     FROM public.message_destinations d
                    WHERE d.id = p_destination_id AND d.inbound_enabled AND d.is_active AND d.archived_at IS NULL),
                  false)
$$;


--
-- Name: FUNCTION telegram_webhook_authenticate(p_destination_id uuid, p_secret text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.telegram_webhook_authenticate(p_destination_id uuid, p_secret text) IS 'true se p_secret (o cabeçalho X-Telegram-Bot-Api-Secret-Token, como chegou) confere com o segredo do destino e o destino está ativo, não arquivado e com a entrada ligada; false em qualquer outro caso (destino inexistente, entrada desligada, segredo errado ou nulo). A API responde 401 com false.';


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

  IF NEW.mirror_status IS NULL AND (NEW.recurrence_rule_id IS NOT NULL OR NEW.contract_cycle_id IS NOT NULL)
     AND (NEW.direction <> c.direction OR NEW.entity_id <> c.entity_id) THEN
    RAISE EXCEPTION 'titles: contract % obligation must be % with entity %', c.id, c.direction, c.entity_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_match_check';
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
-- Name: titles_validate_planned_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.titles_validate_planned_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  acc_caixa uuid;
BEGIN
  IF NEW.planned_account_id IS NOT NULL THEN
    SELECT a.caixa_id INTO acc_caixa FROM financial_accounts a WHERE a.id = NEW.planned_account_id;
    IF FOUND AND acc_caixa <> NEW.caixa_id THEN
      RAISE EXCEPTION 'titles: planned account % must be an account of caixa %', NEW.planned_account_id, NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_planned_account_check';
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
-- Name: ai_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_budgets (
    id uuid DEFAULT uuidv7() NOT NULL,
    scope text NOT NULL,
    user_id uuid,
    agent_id uuid,
    currency text DEFAULT 'USD'::text NOT NULL,
    monthly_limit_micros bigint NOT NULL,
    alert_percent integer DEFAULT 80 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_budgets_alert_percent_check CHECK (((alert_percent >= 1) AND (alert_percent <= 99))),
    CONSTRAINT ai_budgets_currency_check CHECK ((currency = ANY (ARRAY['USD'::text, 'BRL'::text]))),
    CONSTRAINT ai_budgets_monthly_limit_micros_check CHECK ((monthly_limit_micros > 0)),
    CONSTRAINT ai_budgets_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'agent'::text, 'flows'::text, 'global'::text]))),
    CONSTRAINT ai_budgets_target_check CHECK (
CASE scope
    WHEN 'user'::text THEN ((user_id IS NOT NULL) AND (agent_id IS NULL))
    WHEN 'agent'::text THEN ((agent_id IS NOT NULL) AND (user_id IS NULL))
    ELSE ((user_id IS NULL) AND (agent_id IS NULL))
END)
);


--
-- Name: TABLE ai_budgets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_budgets IS 'Orçamento mensal de IA (spec 028). Gasto = soma de ai_usage.cost_micros no mês de America/Sao_Paulo, na moeda do orçamento (uso sem preço e uso noutra moeda não contam), no escopo: user (o uso do usuário, inclusive o dos fluxos que ele acionou), agent (o uso do agente), flows (o uso de conversas com purpose <> chat, ai_usage_is_flow) ou global (todo o uso). No máximo um ativo por (escopo, alvo, moeda): ai_budgets_active_key, 23505. Situação por ai_budget_status(mês); estourados que valem para uma execução por ai_budget_check(usuário, agente, é_fluxo). Auditada.';


--
-- Name: COLUMN ai_budgets.scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.scope IS 'user (user_id obrigatório), agent (agent_id obrigatório), flows ou global (sem alvo): ai_budgets_target_check.';


--
-- Name: COLUMN ai_budgets.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.user_id IS 'Usuário coberto (só no escopo user). Some com o usuário (CASCADE).';


--
-- Name: COLUMN ai_budgets.agent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.agent_id IS 'Agente coberto (só no escopo agent). Some com o agente (CASCADE).';


--
-- Name: COLUMN ai_budgets.currency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.currency IS 'USD ou BRL, a moeda dos preços (ai_model_prices.currency). Só o uso nessa moeda conta.';


--
-- Name: COLUMN ai_budgets.monthly_limit_micros; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.monthly_limit_micros IS 'Valor do mês em milionésimos da moeda (> 0; ex.: 50000000 = US$ 50). Gasto >= valor = blocked.';


--
-- Name: COLUMN ai_budgets.alert_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.alert_percent IS 'Percentual de aviso, 1 a 99 (padrão 80). Gasto >= valor × percentual ÷ 100 = alert.';


--
-- Name: COLUMN ai_budgets.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_budgets.is_active IS 'Desligado, o orçamento não aparece em ai_budget_status nem bloqueia; sai da unicidade.';


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    title text,
    title_source text DEFAULT 'auto'::text NOT NULL,
    archived_at timestamp with time zone,
    forked_from_conversation_id uuid,
    forked_from_message_id uuid,
    screen_context jsonb,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    purpose text DEFAULT 'chat'::text NOT NULL,
    archived_reason text,
    CONSTRAINT ai_conversations_archived_reason_archived_check CHECK (((archived_reason IS NULL) OR (archived_at IS NOT NULL))),
    CONSTRAINT ai_conversations_archived_reason_check CHECK ((archived_reason = ANY (ARRAY['finished'::text, 'forked'::text, 'migrated_from_multi'::text, 'import_conflict'::text]))),
    CONSTRAINT ai_conversations_fork_check CHECK ((forked_from_conversation_id <> id)),
    CONSTRAINT ai_conversations_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'document_reading'::text, 'classify_lines'::text, 'contract_reading'::text, 'contract_markdown'::text, 'scheduled_task'::text, 'reconcile_statement'::text, 'supersede_pairs'::text]))),
    CONSTRAINT ai_conversations_screen_context_check CHECK ((jsonb_typeof(screen_context) = 'object'::text)),
    CONSTRAINT ai_conversations_title_check CHECK (((btrim(title) <> ''::text) AND (length(title) <= 200))),
    CONSTRAINT ai_conversations_title_source_check CHECK ((title_source = ANY (ARRAY['auto'::text, 'user'::text])))
);


--
-- Name: TABLE ai_conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_conversations IS 'Sessões do usuário com um agente (specs 011 e 026): purpose chat é o fio contínuo de (usuário, agente), com no máximo uma sessão ativa (ai_conversations_active_chat_key); finalizar = arquivar (archived_reason), sem volta; continuar de uma finalizada = bifurcar (ai_conversation_fork). Título automático e editável, excluir (apaga mensagens, execuções e eventos; o uso fica em ai_usage), buscar (ai_conversation_search). Conversas de fluxo (purpose <> chat) ficam fora da regra da sessão ativa. O admin pode ler as de todos (a aplicação aplica). Fora da auditoria.';


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
-- Name: COLUMN ai_conversations.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.archived_at IS 'Arquivada (finalizada) desde; nula = ativa. Sessão chat: no máximo uma ativa por (user_id, agent_id) (ai_conversations_active_chat_key), não volta a ser ativa e só é arquivada sem execução ativa ou com o cancelamento dela já pedido (ai_conversations_archive_guard).';


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

COMMENT ON COLUMN public.ai_conversations.purpose IS 'Finalidade, definida no INSERT e imutável: chat (sessão do usuário, padrão) ou o fluxo automático que a criou (document_reading, classify_lines, contract_reading, contract_markdown, supersede_pairs = pares das sobras do lote provisório substituído, scheduled_task = um disparo de tarefa agendada, reconcile_statement = conciliação completa de um lote de extrato; mesmo vocabulário de ai_usage.purpose). Conversas de fluxo ficam fora da sessão ativa (ai_conversations_active_chat_key), da lista e da busca; scheduled_task e reconcile_statement rodam com as tools do kit do agente, os demais fluxos sem tools. A bifurcação é sempre chat.';


--
-- Name: COLUMN ai_conversations.archived_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_conversations.archived_reason IS 'Por que a sessão foi finalizada (spec 026): finished (o usuário finalizou), forked (ai_conversation_fork abriu uma sessão nova do mesmo par), migrated_from_multi (a migração 0043 deixou uma ativa por usuário e agente) ou import_conflict (a importação do backup trazia uma segunda ativa para o par). Nula = arquivada antes da F12 ou sem motivo. Só com archived_at preenchido.';


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
    CONSTRAINT ai_usage_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'title'::text, 'embedding'::text, 'document_reading'::text, 'classify_lines'::text, 'contract_reading'::text, 'contract_markdown'::text, 'vision_describe'::text, 'transcription'::text, 'speech'::text, 'scheduled_task'::text, 'reconcile_statement'::text, 'supersede_pairs'::text]))),
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

COMMENT ON COLUMN public.ai_usage.purpose IS 'chat (loop do agente), title (título automático), embedding (indexação/busca semântica), vision_describe (descrição de anexo pelo provedor de visão), transcription (áudio→texto), speech (texto→áudio) ou a finalidade de um fluxo automático: document_reading (leitura de documento), classify_lines (sugestões da conciliação), contract_reading (leitura do PDF do contrato), contract_markdown (PDF do contrato → markdown), scheduled_task (tarefa agendada), reconcile_statement (conciliação completa ao importar) e supersede_pairs (pares das sobras do lote provisório substituído). chat numa conversa de fluxo vira a finalidade da conversa.';


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
-- Name: ai_reconcile_recipe_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_reconcile_recipe_runs (
    id uuid DEFAULT uuidv7() NOT NULL,
    recipe_id uuid NOT NULL,
    import_id uuid NOT NULL,
    user_id uuid NOT NULL,
    trigger_kind text NOT NULL,
    "position" integer,
    line_ids uuid[],
    status text NOT NULL,
    skip_reason text,
    conversation_id uuid,
    run_id uuid,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_reconcile_recipe_runs_line_ids_check CHECK ((cardinality(line_ids) >= 1)),
    CONSTRAINT ai_reconcile_recipe_runs_position_check CHECK (((trigger_kind = 'import'::text) = ("position" IS NOT NULL))),
    CONSTRAINT ai_reconcile_recipe_runs_queued_check CHECK (((status <> 'queued'::text) OR (trigger_kind = 'import'::text))),
    CONSTRAINT ai_reconcile_recipe_runs_reason_check CHECK ((((status = ANY (ARRAY['skipped'::text, 'failed'::text])) = (skip_reason IS NOT NULL)) AND ((length(skip_reason) >= 1) AND (length(skip_reason) <= 500)))),
    CONSTRAINT ai_reconcile_recipe_runs_run_check CHECK (((status <> ALL (ARRAY['queued'::text, 'skipped'::text])) OR (run_id IS NULL))),
    CONSTRAINT ai_reconcile_recipe_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'started'::text, 'completed'::text, 'skipped'::text, 'failed'::text]))),
    CONSTRAINT ai_reconcile_recipe_runs_trigger_kind_check CHECK ((trigger_kind = ANY (ARRAY['manual'::text, 'import'::text])))
);


--
-- Name: TABLE ai_reconcile_recipe_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_reconcile_recipe_runs IS 'Execuções das receitas (spec 030): a fila do import (trigger_kind import, criadas queued com position) e o play (manual, criadas started). queued → started|skipped|failed; started → completed|skipped|failed; completed, skipped e failed são finais (ai_reconcile_recipe_runs_status_transition_check). A aplicação liga a sessão e a execução, grava line_ids ao começar e passa a completed/failed quando a execução termina. O resultado está em ai_runs. Fora da auditoria e do backup.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.user_id IS 'Quem disparou (o clique, ou quem importou): roda como ele.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.trigger_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.trigger_kind IS 'manual (play) ou import (fila do import).';


--
-- Name: COLUMN ai_reconcile_recipe_runs."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs."position" IS 'Ordem na fila do import (a position da receita ao enfileirar); obrigatória em import, nula em manual.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.line_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.line_ids IS 'Linhas do extrato no escopo (as selecionadas ou as pendentes ao começar); nulo enquanto queued ou se pulada.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.status IS 'queued, started, completed, skipped ou failed.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.skip_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.skip_reason IS 'Motivo, obrigatório em skipped/failed e nulo nos demais (até 500). Do banco (claim): recipe_inactive, agent_inactive, user_inactive. Da aplicação: no_lines, budget_exceeded, rate_limited ou a mensagem de erro.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.conversation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.conversation_id IS 'Sessão da execução (purpose reconcile_statement, de user_id: ai_reconcile_recipe_runs_links_check). Excluída, o histórico fica.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.run_id IS 'Execução (ai_runs) da sessão acima.';


--
-- Name: COLUMN ai_reconcile_recipe_runs.started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.started_at IS 'Quando passou a started (pelo banco).';


--
-- Name: COLUMN ai_reconcile_recipe_runs.finished_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_runs.finished_at IS 'Quando chegou a completed/skipped/failed (pelo banco).';


--
-- Name: ai_reconcile_recipe_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_reconcile_recipe_targets (
    id uuid DEFAULT uuidv7() NOT NULL,
    recipe_id uuid NOT NULL,
    financial_account_id uuid,
    card_caixa_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_reconcile_recipe_targets_target_check CHECK ((num_nonnulls(financial_account_id, card_caixa_id) = 1))
);


--
-- Name: TABLE ai_reconcile_recipe_targets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_reconcile_recipe_targets IS 'Contas e cartões vinculados a uma receita (spec 030): exatamente um dos dois por linha (ai_reconcile_recipe_targets_target_check), sem repetir na mesma receita (…_account_key, …_card_key). Conta só checking/savings e cartão só credit_card (ai_reconcile_recipe_targets_kind_check). Receita de caixa: a conta da caixa dona, e o cartão que é a caixa dona ou cuja pagadora padrão é a dona; global: qualquer um (ai_reconcile_recipe_targets_owner_check). No máximo 10 receitas não arquivadas com run_on_import por alvo (ai_reconcile_recipe_targets_import_limit_check). Sem vínculo, a receita vale para todos os lotes da dona. Some com a receita, a conta ou o cartão (CASCADE). Trocar vínculos pode apagar (DELETE). Auditada com record_id = recipe_id; no backup (tem id próprio).';


--
-- Name: COLUMN ai_reconcile_recipe_targets.financial_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_targets.financial_account_id IS 'Conta corrente/poupança vinculada (ou nulo).';


--
-- Name: COLUMN ai_reconcile_recipe_targets.card_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipe_targets.card_caixa_id IS 'Cartão (caixa credit_card) vinculado (ou nulo).';


--
-- Name: ai_reconcile_recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_reconcile_recipes (
    id uuid DEFAULT uuidv7() NOT NULL,
    caixa_id uuid,
    agent_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    instruction text NOT NULL,
    run_on_import boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_reconcile_recipes_active_check CHECK ((NOT (is_active AND (archived_at IS NOT NULL)))),
    CONSTRAINT ai_reconcile_recipes_description_check CHECK ((length(description) <= 2000)),
    CONSTRAINT ai_reconcile_recipes_instruction_check CHECK (((btrim(instruction) <> ''::text) AND (length(instruction) <= 20000))),
    CONSTRAINT ai_reconcile_recipes_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT ai_reconcile_recipes_position_check CHECK ((("position" >= 0) AND ("position" <= 100000)))
);


--
-- Name: TABLE ai_reconcile_recipes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_reconcile_recipes IS 'Receitas de conciliação (spec 030): instrução reutilizável (mensagem do usuário) com o agente responsável, executada sobre um lote de extrato numa sessão nova (purpose reconcile_statement, screen_context.recipeId). Dona uma caixa ou global (caixa_id nulo). No máximo 50 não arquivadas por dona (ai_reconcile_recipes_active_limit_check). Excluir = arquivar (sem DELETE para a aplicação). Auditada; no backup.';


--
-- Name: COLUMN ai_reconcile_recipes.caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes.caixa_id IS 'Caixa dona (quem escreve nela edita; quem lê vê) ou nulo = global (só o admin edita; vale para os lotes de qualquer caixa). Imutável (ai_reconcile_recipes_owner_immutable_check).';


--
-- Name: COLUMN ai_reconcile_recipes.agent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes.agent_id IS 'Agente que executa (qualquer agente; o kit dele decide allow/ask). Excluir o agente em uso dá 23503 (arquive).';


--
-- Name: COLUMN ai_reconcile_recipes.instruction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes.instruction IS 'Texto enviado como mensagem do usuário (até 20 mil), com as variáveis da spec 022 e as do lote; a validação das variáveis é da aplicação.';


--
-- Name: COLUMN ai_reconcile_recipes.run_on_import; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes.run_on_import IS '"Rodar ao importar": entra na fila do import das contas/cartões vinculados (quando ai_auto_reconcile do alvo está ligado). Exige pelo menos um alvo, checado no COMMIT (ai_reconcile_recipes_run_on_import_check). No máximo 10 não arquivadas por alvo (ai_reconcile_recipe_targets_import_limit_check).';


--
-- Name: COLUMN ai_reconcile_recipes."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes."position" IS 'Ordem (menor primeiro) na lista e na fila do import (0–100000).';


--
-- Name: COLUMN ai_reconcile_recipes.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes.is_active IS 'Interruptor ativo. Arquivada não pode estar ativa (ai_reconcile_recipes_active_check): ao arquivar, desligue.';


--
-- Name: COLUMN ai_reconcile_recipes.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_reconcile_recipes.archived_at IS 'Arquivada (a exclusão da tela). Não conta nos limites.';


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
    CONSTRAINT ai_requests_purpose_check CHECK ((purpose = ANY (ARRAY['chat'::text, 'title'::text, 'embedding'::text, 'document_reading'::text, 'classify_lines'::text, 'contract_reading'::text, 'contract_markdown'::text, 'vision_describe'::text, 'transcription'::text, 'speech'::text, 'scheduled_task'::text, 'reconcile_statement'::text, 'supersede_pairs'::text]))),
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
-- Name: ai_scheduled_task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_scheduled_task_runs (
    id uuid DEFAULT uuidv7() NOT NULL,
    task_id uuid NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    trigger_kind text DEFAULT 'schedule'::text NOT NULL,
    status text NOT NULL,
    skip_reason text,
    conversation_id uuid,
    run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_scheduled_task_runs_reason_check CHECK ((((status = 'started'::text) = (skip_reason IS NULL)) AND ((length(skip_reason) >= 1) AND (length(skip_reason) <= 500)))),
    CONSTRAINT ai_scheduled_task_runs_run_check CHECK (((status = 'started'::text) OR (run_id IS NULL))),
    CONSTRAINT ai_scheduled_task_runs_status_check CHECK ((status = ANY (ARRAY['started'::text, 'skipped'::text, 'failed'::text]))),
    CONSTRAINT ai_scheduled_task_runs_trigger_kind_check CHECK ((trigger_kind = ANY (ARRAY['schedule'::text, 'manual'::text])))
);


--
-- Name: TABLE ai_scheduled_task_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_scheduled_task_runs IS 'Disparos das tarefas agendadas (spec 029): um por (tarefa, horário previsto) (ai_scheduled_task_runs_task_scheduled_key). Criados por ai_scheduled_task_claim (agendados) e ai_scheduled_task_run_now (manuais) como started ou skipped; a aplicação liga a sessão e a execução que criou, ou passa o started a skipped/failed (com o motivo) se não conseguiu começar. skipped e failed são finais. O resultado da execução está em ai_runs. Fora da auditoria e do backup (histórico operacional, como ai_runs).';


--
-- Name: COLUMN ai_scheduled_task_runs.scheduled_for; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_task_runs.scheduled_for IS 'Horário previsto do disparo (agendado) ou o instante do clique (manual). Imutável.';


--
-- Name: COLUMN ai_scheduled_task_runs.trigger_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_task_runs.trigger_kind IS 'schedule (pelo worker) ou manual ("Rodar agora").';


--
-- Name: COLUMN ai_scheduled_task_runs.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_task_runs.status IS 'started (começou: a aplicação cria a sessão e a execução), skipped (pulado, com o motivo) ou failed (não conseguiu começar, com o erro). started pode virar skipped/failed enquanto não tem execução; skipped e failed são finais.';


--
-- Name: COLUMN ai_scheduled_task_runs.skip_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_task_runs.skip_reason IS 'Motivo, obrigatório em skipped/failed e nulo em started (até 500). Do banco: missed_window (atraso acima do prazo, 6 h), previous_run_active (execução anterior ativa), user_inactive, agent_inactive. Da aplicação: os dela (ex.: budget_exceeded, rate_limited ou a mensagem de erro).';


--
-- Name: COLUMN ai_scheduled_task_runs.conversation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_task_runs.conversation_id IS 'Sessão do disparo (purpose scheduled_task, do dono da tarefa: ai_scheduled_task_runs_links_check). Excluir a sessão anula o vínculo e o histórico fica.';


--
-- Name: COLUMN ai_scheduled_task_runs.run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_scheduled_task_runs.run_id IS 'Execução do disparo (da conversa acima). Excluída a conversa, vira nula e o histórico fica.';


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
-- Name: ai_usage_daily; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_usage_daily WITH (security_invoker='true') AS
 SELECT ((created_at AT TIME ZONE 'America/Sao_Paulo'::text))::date AS day,
    provider_id,
    model,
    agent_id,
    user_id,
    purpose,
    currency,
    (count(*))::integer AS calls,
    (count(DISTINCT run_id))::integer AS runs,
    (count(DISTINCT conversation_id))::integer AS conversations,
    (sum(input_tokens))::bigint AS input_tokens,
    (sum(output_tokens))::bigint AS output_tokens,
    (sum(cache_write_tokens))::bigint AS cache_write_tokens,
    (sum(cache_read_tokens))::bigint AS cache_read_tokens,
    sum(audio_seconds) AS audio_seconds,
    (sum(characters))::bigint AS characters,
    (sum(cost_micros))::bigint AS cost_micros,
    bool_or((cost_micros IS NULL)) AS has_unpriced
   FROM public.ai_usage u
  GROUP BY (((created_at AT TIME ZONE 'America/Sao_Paulo'::text))::date), provider_id, model, agent_id, user_id, purpose, currency;


--
-- Name: VIEW ai_usage_daily; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_daily IS 'Uso por dia (America/Sao_Paulo), provedor, modelo, agente, usuário, finalidade e moeda (spec 028, painel de uso). currency nula = chamadas sem preço (cost_micros nulo). Taxa de acerto do cache = cache_read_tokens ÷ (input_tokens + cache_write_tokens + cache_read_tokens). Filtre por day (índice ai_usage_sp_day_idx).';


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
    bool_or((cost_micros IS NULL)) AS has_unpriced,
    sum(audio_seconds) AS audio_seconds,
    (sum(characters))::bigint AS characters
   FROM public.ai_usage u
  GROUP BY ((date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date), agent_id, provider_id, model, currency;


--
-- Name: VIEW ai_usage_monthly_by_agent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_monthly_by_agent IS 'Uso por mês (America/Sao_Paulo), agente, provedor, modelo e moeda, com segundos de áudio e caracteres de fala. agent_id nulo = embeddings (sem agente).';


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
    bool_or((cost_micros IS NULL)) AS has_unpriced,
    sum(audio_seconds) AS audio_seconds,
    (sum(characters))::bigint AS characters
   FROM public.ai_usage u
  GROUP BY ((date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date), purpose, currency;


--
-- Name: VIEW ai_usage_monthly_by_purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_monthly_by_purpose IS 'Uso por mês (America/Sao_Paulo), finalidade (ai_usage.purpose) e moeda, com segundos de áudio e caracteres de fala; currency nula = chamadas sem preço.';


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
    bool_or((cost_micros IS NULL)) AS has_unpriced,
    sum(audio_seconds) AS audio_seconds,
    (sum(characters))::bigint AS characters
   FROM public.ai_usage u
  GROUP BY ((date_trunc('month'::text, (created_at AT TIME ZONE 'America/Sao_Paulo'::text)))::date), user_id, currency;


--
-- Name: VIEW ai_usage_monthly_by_user; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.ai_usage_monthly_by_user IS 'Uso por mês (America/Sao_Paulo), usuário e moeda, com segundos de áudio e caracteres de fala. user_id nulo = sistema (embeddings) ou usuário excluído.';


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
    provisional boolean DEFAULT false NOT NULL,
    superseded_by_import_id uuid,
    superseded_at timestamp with time zone,
    CONSTRAINT statement_imports_bank_balance_check CHECK (((bank_balance_cents IS NULL) = (bank_balance_on IS NULL))),
    CONSTRAINT statement_imports_csv_mapping_check CHECK (((format = 'csv'::text) OR (csv_mapping_id IS NULL))),
    CONSTRAINT statement_imports_format_check CHECK ((format = ANY (ARRAY['ofx'::text, 'csv'::text]))),
    CONSTRAINT statement_imports_period_check CHECK ((period_end >= period_start)),
    CONSTRAINT statement_imports_provisional_check CHECK (((NOT provisional) OR (financial_account_id IS NOT NULL))),
    CONSTRAINT statement_imports_superseded_check CHECK ((((superseded_by_import_id IS NULL) = (superseded_at IS NULL)) AND ((superseded_by_import_id IS NULL) OR (provisional AND (superseded_by_import_id <> id))))),
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
-- Name: COLUMN statement_imports.provisional; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.provisional IS 'Lote provisório (spec 031): extrato parcial de conta (nunca de cartão) importado antes do consolidado do mês. As linhas dele ficam fora da deduplicação da conta (statement_lines.provisional). Provisórios ativos da mesma conta não se sobrepõem (no COMMIT); não vira provisório com linha em mês fechado nem se já substituiu outro lote.';


--
-- Name: COLUMN statement_imports.superseded_by_import_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.superseded_by_import_id IS 'Lote (da mesma conta, não substituído no momento da troca) que substituiu este provisório; preenchido junto com superseded_at. Final: provisional, superseded_by_import_id e superseded_at não mudam mais, o lote não é excluído e o substituto também não (FK). Toda linha do substituído tem supersede_outcome (no COMMIT).';


--
-- Name: COLUMN statement_imports.superseded_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_imports.superseded_at IS 'Instante da troca pelo consolidado (junto com superseded_by_import_id).';


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
    duration_ms integer,
    page_count integer,
    CONSTRAINT attachments_duration_ms_check CHECK (((duration_ms IS NULL) OR (((duration_ms >= 1) AND (duration_ms <= 86400000)) AND (mime_type ~ '^(audio|video)/'::text)))),
    CONSTRAINT attachments_file_name_check CHECK (((btrim(file_name) <> ''::text) AND (length(file_name) <= 255) AND (file_name !~ '[/\\[:cntrl:]]'::text))),
    CONSTRAINT attachments_mime_type_check CHECK (((mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'::text) AND (length(mime_type) <= 127))),
    CONSTRAINT attachments_page_count_check CHECK (((page_count IS NULL) OR (((page_count >= 1) AND (page_count <= 100000)) AND (mime_type = 'application/pdf'::text)))),
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
-- Name: COLUMN attachments.duration_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.duration_ms IS 'Duração do áudio em milissegundos (1 ms a 24 h; só com mime_type audio/* ou video/*). Opcional, preenchida pela aplicação no upload (spec 025).';


--
-- Name: COLUMN attachments.page_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.attachments.page_count IS 'Número de páginas do PDF (1 a 100 mil; só com mime_type application/pdf). Opcional, preenchido pela aplicação no upload (spec 025).';


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
    ai_auto_reconcile boolean DEFAULT false NOT NULL,
    CONSTRAINT caixas_ai_auto_reconcile_check CHECK (((NOT ai_auto_reconcile) OR (kind = 'credit_card'::text))),
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
-- Name: COLUMN caixas.ai_auto_reconcile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.caixas.ai_auto_reconcile IS '"Conciliar com IA ao importar" do cartão (spec 029): o import de extrato da fatura dispara a conciliação completa pelo agente dos fluxos (purpose reconcile_statement). Só em credit_card (caixas_ai_auto_reconcile_check).';


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
    contract_id uuid,
    recurrence_rule_id uuid,
    occurrence smallint,
    CONSTRAINT card_purchases_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT card_purchases_charge_kind_check CHECK ((charge_kind = ANY (ARRAY['interest'::text, 'iof'::text, 'fine'::text, 'fee'::text, 'other'::text]))),
    CONSTRAINT card_purchases_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT card_purchases_installments_check CHECK ((((installments_total >= 1) AND (installments_total <= 99)) AND ((first_installment >= 1) AND (first_installment <= installments_total)))),
    CONSTRAINT card_purchases_kind_check CHECK ((kind = ANY (ARRAY['purchase'::text, 'refund'::text, 'charge'::text]))),
    CONSTRAINT card_purchases_kind_links_check CHECK ((((kind = 'refund'::text) = (refunded_purchase_id IS NOT NULL)) AND ((kind = 'charge'::text) = (charge_kind IS NOT NULL)))),
    CONSTRAINT card_purchases_recurrence_check CHECK ((((recurrence_rule_id IS NULL) = (occurrence IS NULL)) AND ((occurrence IS NULL) OR (occurrence >= 1)) AND (((recurrence_rule_id IS NULL) AND (contract_id IS NULL)) OR (kind = 'purchase'::text)))),
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
-- Name: COLUMN card_purchases.contract_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.contract_id IS 'Contrato da compra (spec 034): o da série quando ligada a uma ocorrência (checado no COMMIT). Só em purchase.';


--
-- Name: COLUMN card_purchases.recurrence_rule_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.recurrence_rule_id IS 'Série de cobrança no cartão (do mesmo cartão: FK composta com card_caixa_id) cuja ocorrência esta compra atende.';


--
-- Name: COLUMN card_purchases.occurrence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_purchases.occurrence IS 'Ocorrência atendida (n, junto com recurrence_rule_id). No máximo uma compra não estornada por série e ocorrência (card_purchases_occurrence_key, 23505): a estornada por inteiro libera a ocorrência.';


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
    planned_account_id uuid,
    planned_account_custom boolean DEFAULT false NOT NULL,
    CONSTRAINT titles_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT titles_boleto_barcode_check CHECK (public.is_valid_boleto_barcode(boleto_barcode)),
    CONSTRAINT titles_card_invoice_check CHECK ((((origin = 'card_invoice'::text) = (card_invoice_id IS NOT NULL)) AND ((card_invoice_id IS NULL) OR (counterparty_caixa_id IS NOT NULL)))),
    CONSTRAINT titles_contract_check CHECK ((((contract_cycle_id IS NULL) = (contract_installment IS NULL)) AND ((contract_cycle_id IS NULL) OR (contract_id IS NOT NULL)) AND ((contract_id IS NULL) OR (origin = ANY (ARRAY['manual'::text, 'recurrence'::text]))))),
    CONSTRAINT titles_contract_installment_check CHECK ((contract_installment >= 1)),
    CONSTRAINT titles_counterparty_caixa_check CHECK ((counterparty_caixa_id <> caixa_id)),
    CONSTRAINT titles_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT titles_direction_check CHECK ((direction = ANY (ARRAY['payable'::text, 'receivable'::text]))),
    CONSTRAINT titles_mirror_fields_check CHECK ((((counterparty_caixa_id IS NULL) = (mirror_title_id IS NULL)) AND ((mirror_status IS NULL) OR (mirror_title_id IS NOT NULL)))),
    CONSTRAINT titles_mirror_self_check CHECK ((mirror_title_id <> id)),
    CONSTRAINT titles_mirror_status_check CHECK ((mirror_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'disputed'::text]))),
    CONSTRAINT titles_occurrence_check CHECK ((occurrence >= 1)),
    CONSTRAINT titles_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'recurrence'::text, 'card_invoice'::text]))),
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

COMMENT ON COLUMN public.titles.origin IS 'manual, recurrence (ocorrência de recurrence_rules) ou card_invoice (fatura de cartão, F2). O espelho herda a origem do original. Título de contrato (spec 034) é recurrence (obrigação em série) ou manual (avulso: parcela única, multa); a origem contract saiu na 0052.';


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

COMMENT ON COLUMN public.titles.contract_id IS 'Contrato do título (spec 034): a ocorrência de uma série do contrato (= recurrence_rules.contract_id, no COMMIT) ou um avulso ligado a ele. O espelho repete o contrato.';


--
-- Name: COLUMN titles.contract_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.contract_cycle_id IS 'Legado (até a 0051): ciclo da parcela gerada pelo contrato, mantido como histórico nos títulos migrados. Não preencha em títulos novos.';


--
-- Name: COLUMN titles.contract_installment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.contract_installment IS 'Legado (até a 0051): número da parcela n no ciclo (N = contract_cycles.installments_count). Histórico.';


--
-- Name: COLUMN titles.planned_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.planned_account_id IS 'Conta prevista (specs 033 e 034): conta da caixa do título (corrente, poupança ou cofre), onde o pagamento sai ou o recebimento entra. A série copia a da ocorrência modelo; a conciliação procura a ocorrência pela conta.';


--
-- Name: COLUMN titles.planned_account_custom; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.titles.planned_account_custom IS 'A ocorrência escolheu a conta dela (troca avulsa); padrão false. Sem regra no banco: a aplicação decide se a troca da conta da série ("esta e as próximas") a respeita.';


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
-- Name: card_recurring_charge_amounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_recurring_charge_amounts (
    recurrence_rule_id uuid NOT NULL,
    from_occurrence smallint NOT NULL,
    amount_cents bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_recurring_charge_amounts_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT card_recurring_charge_amounts_from_occurrence_check CHECK ((from_occurrence >= 2))
);


--
-- Name: TABLE card_recurring_charge_amounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.card_recurring_charge_amounts IS 'Valor esperado de uma cobrança no cartão a partir da ocorrência from_occurrence (aditivo/reajuste "dali em diante", spec 034); as anteriores ficam com o valor de antes. Valor da ocorrência n: card_recurring_charge_amount(série, n).';


--
-- Name: card_recurring_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_recurring_charges (
    recurrence_rule_id uuid NOT NULL,
    payer_caixa_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    category_id uuid NOT NULL,
    description text NOT NULL,
    amount_cents bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_recurring_charges_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT card_recurring_charges_description_check CHECK (((btrim(description) <> ''::text) AND (length(description) <= 200)))
);


--
-- Name: TABLE card_recurring_charges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.card_recurring_charges IS 'Cobrança recorrente esperada num cartão (spec 034): o alvo de uma série cuja caixa (recurrence_rules.caixa_id) é a do cartão. Não gera título nem compra adiantada; as ocorrências são calculadas pelo calendário da série e a compra que atende uma ocorrência fica ligada a ela (card_purchases.recurrence_rule_id/occurrence). Uma por série.';


--
-- Name: COLUMN card_recurring_charges.payer_caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_recurring_charges.payer_caixa_id IS 'Caixa pagadora da cobrança (general): a da compra criada ao confirmar.';


--
-- Name: COLUMN card_recurring_charges.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_recurring_charges.entity_id IS 'Recebedor final esperado (o lojista da cobrança).';


--
-- Name: COLUMN card_recurring_charges.category_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_recurring_charges.category_id IS 'Categoria de despesa da compra.';


--
-- Name: COLUMN card_recurring_charges.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_recurring_charges.description IS 'Descrição da obrigação (1–200), usada na sugestão da fatura.';


--
-- Name: COLUMN card_recurring_charges.amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.card_recurring_charges.amount_cents IS 'Valor esperado a partir da ocorrência 1; mudanças "dali em diante" ficam em card_recurring_charge_amounts.';


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
    caixa_id uuid NOT NULL,
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
    financial_account_id uuid,
    copied_from_rule_id uuid,
    CONSTRAINT classification_rules_copied_from_check CHECK (((copied_from_rule_id IS NULL) OR ((origin = 'copy'::text) AND (copied_from_rule_id <> id)))),
    CONSTRAINT classification_rules_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT classification_rules_match_kind_check CHECK ((match_kind = ANY (ARRAY['contains'::text, 'starts_with'::text, 'exact'::text, 'regex'::text]))),
    CONSTRAINT classification_rules_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'correction'::text, 'agent'::text, 'copy'::text]))),
    CONSTRAINT classification_rules_pattern_check CHECK (((btrim(pattern) <> ''::text) AND (length(pattern) <= 200))),
    CONSTRAINT classification_rules_priority_check CHECK (((priority >= 0) AND (priority <= 1000))),
    CONSTRAINT classification_rules_target_check CHECK (((num_nonnulls(entity_id, category_id) >= 1) AND ((category_id IS NULL) OR (direction IS NOT NULL)))),
    CONSTRAINT classification_rules_usage_count_check CHECK ((usage_count >= 0))
);


--
-- Name: TABLE classification_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.classification_rules IS 'Regras descrição → entidade/categoria (spec 009/032), de uma conta checking/savings ou de um cartão, criadas à mão, por correção do usuário, sugeridas pelo agente ou copiadas de outra conta. A melhor regra para uma linha: classification_rule_for().';


--
-- Name: COLUMN classification_rules.caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.caixa_id IS 'Caixa do alvo: a caixa da conta (financial_account_id) ou o próprio cartão (caixa credit_card, sem conta).';


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

COMMENT ON COLUMN public.classification_rules.origin IS 'manual, correction (aprendida de uma correção do usuário), agent (sugestão aprovada do agente) ou copy (copiada de outra conta pelo usuário).';


--
-- Name: COLUMN classification_rules.created_from_line_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.created_from_line_id IS 'Linha de extrato cuja correção originou a regra.';


--
-- Name: COLUMN classification_rules.usage_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.usage_count IS 'Quantas vezes a regra classificou uma linha (a aplicação incrementa).';


--
-- Name: COLUMN classification_rules.financial_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.financial_account_id IS 'Conta checking/savings da caixa cujas linhas a regra classifica; obrigatória fora do cartão, nula no cartão.';


--
-- Name: COLUMN classification_rules.copied_from_rule_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.classification_rules.copied_from_rule_id IS 'Regra de origem da cópia (só em origin = copy; informativo, nulo se a origem foi excluída).';


--
-- Name: contract_amendments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_amendments (
    id uuid DEFAULT uuidv7() NOT NULL,
    contract_id uuid NOT NULL,
    contract_cycle_id uuid,
    document_id uuid,
    effective_on date NOT NULL,
    changes jsonb NOT NULL,
    affected_title_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    skipped_title_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recurrence_rule_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    CONSTRAINT contract_amendments_changes_check CHECK (((jsonb_typeof(changes) = 'object'::text) AND COALESCE((jsonb_typeof((changes -> 'before'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof((changes -> 'after'::text)) = 'object'::text), false))),
    CONSTRAINT contract_amendments_rule_ids_check CHECK ((array_position(recurrence_rule_ids, NULL::uuid) IS NULL)),
    CONSTRAINT contract_amendments_title_ids_check CHECK (((array_position(affected_title_ids, NULL::uuid) IS NULL) AND (array_position(skipped_title_ids, NULL::uuid) IS NULL)))
);


--
-- Name: TABLE contract_amendments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_amendments IS 'Histórico de aditivos de um contrato (antes → depois). Imutável, exceto document_id e notes.';


--
-- Name: COLUMN contract_amendments.contract_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.contract_cycle_id IS 'Ciclo aditado (legado; opcional desde a 0052).';


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
-- Name: COLUMN contract_amendments.recurrence_rule_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_amendments.recurrence_rule_ids IS 'Obrigações (séries) atingidas pelo aditivo (spec 034), com "esta e as próximas" a partir da data de efeito.';


--
-- Name: contract_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_cycles (
    id uuid DEFAULT uuidv7() NOT NULL,
    contract_id uuid NOT NULL,
    seq smallint NOT NULL,
    starts_on date NOT NULL,
    duration_months smallint,
    ends_on date,
    periodicity text,
    installments_count smallint,
    total_cents bigint,
    due_day smallint,
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
    CONSTRAINT contract_cycles_ends_on_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT contract_cycles_legacy_check CHECK ((((duration_months IS NULL) = (periodicity IS NULL)) AND ((duration_months IS NULL) = (total_cents IS NULL)) AND ((duration_months IS NULL) = (due_day IS NULL)))),
    CONSTRAINT contract_cycles_periodicity_check CHECK ((periodicity = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text, 'single'::text]))),
    CONSTRAINT contract_cycles_readjustment_percent_check CHECK ((readjustment_percent > ('-100'::integer)::numeric)),
    CONSTRAINT contract_cycles_seq_check CHECK ((seq >= 1)),
    CONSTRAINT contract_cycles_total_cents_check CHECK (((total_cents > 0) AND (total_cents >= installments_count)))
);


--
-- Name: TABLE contract_cycles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_cycles IS 'Histórico das vigências de um contrato (spec 034): seq 1, 2, 3… contíguos (o seguinte começa no dia seguinte ao fim do anterior; o sem fim só no último; no COMMIT). Renovar acrescenta um. Os ciclos de parcelas de antes da 0052 têm os campos do ciclo (duração, periodicidade, total, dia), com ends_on e installments_count calculados; com títulos ligados, início, duração e periodicidade ficam imutáveis.';


--
-- Name: COLUMN contract_cycles.duration_months; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.duration_months IS 'Legado (ciclo de parcelas): duração em meses (1–120), múltipla do período. Nulo nas vigências novas, junto com periodicity, total_cents e due_day (contract_cycles_legacy_check).';


--
-- Name: COLUMN contract_cycles.ends_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.ends_on IS 'Fim da vigência (nulo = indeterminado, só no último ciclo). Num ciclo com duration_months, calculado como antes: x = starts_on + duração meses; x se o dia não existe no mês final, senão x − 1 dia.';


--
-- Name: COLUMN contract_cycles.periodicity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.periodicity IS 'monthly (1 mês), quarterly (3), semiannual (6), annual (12) ou single (parcela única no ciclo).';


--
-- Name: COLUMN contract_cycles.installments_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_cycles.installments_count IS 'Legado: número de parcelas = duração ÷ meses do período (single = 1), calculado; nulo sem os campos do ciclo.';


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
    status text NOT NULL,
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
    ELSE ((decided_at IS NOT NULL) AND (new_cycle_id IS NULL))
END),
    CONSTRAINT contract_renewal_tasks_new_cycle_self_check CHECK ((new_cycle_id <> contract_cycle_id)),
    CONSTRAINT contract_renewal_tasks_status_check CHECK ((status = ANY (ARRAY['approved'::text, 'declined'::text, 'closed'::text])))
);


--
-- Name: TABLE contract_renewal_tasks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_renewal_tasks IS 'Histórico das tarefas de renovação (até a 0052): approved (com o ciclo criado), declined ou closed (aberta fechada pela migração 0052, quando o aviso de fim de vigência assumiu). Nenhuma tarefa nova abre.';


--
-- Name: COLUMN contract_renewal_tasks.contract_cycle_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.contract_cycle_id IS 'Ciclo que termina (a renovar).';


--
-- Name: COLUMN contract_renewal_tasks.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_renewal_tasks.status IS 'approved (decided_at e new_cycle_id) | declined | closed (decided_at). Final.';


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
    starts_on date NOT NULL,
    ends_on date,
    CONSTRAINT contracts_contract_number_check CHECK (((btrim(contract_number) <> ''::text) AND (length(contract_number) <= 60))),
    CONSTRAINT contracts_counterparty_caixa_check CHECK ((counterparty_caixa_id <> caixa_id)),
    CONSTRAINT contracts_direction_check CHECK ((direction = ANY (ARRAY['payable'::text, 'receivable'::text]))),
    CONSTRAINT contracts_ended_term_check CHECK (((status <> ALL (ARRAY['ended'::text, 'terminated'::text])) OR (ends_on IS NOT NULL))),
    CONSTRAINT contracts_ends_on_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT contracts_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 200))),
    CONSTRAINT contracts_notice_days_check CHECK (((notice_days >= 0) AND (notice_days <= 365))),
    CONSTRAINT contracts_readjustment_index_check CHECK ((readjustment_index = ANY (ARRAY['none'::text, 'ipca'::text, 'igpm'::text, 'inpc'::text, 'other'::text]))),
    CONSTRAINT contracts_reminder_every_days_check CHECK (((reminder_every_days >= 1) AND (reminder_every_days <= 30))),
    CONSTRAINT contracts_renewal_lead_days_check CHECK (((renewal_lead_days >= 1) AND (renewal_lead_days <= 365))),
    CONSTRAINT contracts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'ended'::text, 'terminated'::text]))),
    CONSTRAINT contracts_terminated_check CHECK (((status = 'terminated'::text) = (terminated_on IS NOT NULL))),
    CONSTRAINT contracts_terminated_on_check CHECK (((terminated_on IS NULL) OR (terminated_on = ends_on))),
    CONSTRAINT contracts_termination_penalty_cents_check CHECK ((termination_penalty_cents > 0)),
    CONSTRAINT contracts_termination_penalty_text_check CHECK ((length(termination_penalty_text) <= 2000))
);


--
-- Name: TABLE contracts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contracts IS 'Contratos (specs 020 e 034): acordo com uma entidade dentro de uma caixa general, com vigência, documentos, avisos e obrigações (as séries com recurrence_rules.contract_id, em contas ou no cartão, e títulos avulsos ligados). contract_cycles, contract_amendments e contract_renewal_tasks guardam o histórico. Só rascunho é excluído.';


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

COMMENT ON COLUMN public.contracts.status IS 'draft (sem títulos nem compras ligadas) → active; active → ended | terminated; ended → active (renovar); terminated é final; nada volta para draft. renewal_pending saiu na 0052 (renovar é uma ação).';


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

COMMENT ON COLUMN public.contracts.terminated_on IS 'Data de encerramento da rescisão; preenchida se e somente se status = terminated, e igual ao fim da vigência.';


--
-- Name: COLUMN contracts.starts_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.starts_on IS 'Início da vigência (spec 034).';


--
-- Name: COLUMN contracts.ends_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.ends_on IS 'Fim da vigência (nulo = indeterminado; obrigatório em ended e terminated; no rescindido, = terminated_on). Renovar estende a vigência e o fim das séries.';


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
    ai_auto_reconcile boolean DEFAULT false NOT NULL,
    CONSTRAINT financial_accounts_account_number_check CHECK ((account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'::text)),
    CONSTRAINT financial_accounts_ai_auto_reconcile_check CHECK (((NOT ai_auto_reconcile) OR (kind = ANY (ARRAY['checking'::text, 'savings'::text])))),
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
-- Name: COLUMN financial_accounts.ai_auto_reconcile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.financial_accounts.ai_auto_reconcile IS '"Conciliar com IA ao importar" (spec 029): o import de extrato desta conta dispara a conciliação completa pelo agente dos fluxos (purpose reconcile_statement). Só em checking/savings (financial_accounts_ai_auto_reconcile_check).';


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
    inbound_enabled boolean DEFAULT false NOT NULL,
    inbound_agent_id uuid,
    webhook_secret_hash text,
    CONSTRAINT message_destinations_active_check CHECK ((NOT (is_active AND (archived_at IS NOT NULL)))),
    CONSTRAINT message_destinations_bot_token_check CHECK ((bot_token ~ '^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$'::text)),
    CONSTRAINT message_destinations_channel_check CHECK ((channel = 'telegram'::text)),
    CONSTRAINT message_destinations_chat_id_check CHECK (((chat_id ~ '^-?[0-9]{1,20}$'::text) OR (chat_id ~ '^@[A-Za-z][A-Za-z0-9_]{3,31}$'::text))),
    CONSTRAINT message_destinations_inbound_check CHECK (((NOT inbound_enabled) OR (is_active AND (inbound_agent_id IS NOT NULL) AND (webhook_secret_hash IS NOT NULL)))),
    CONSTRAINT message_destinations_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 120))),
    CONSTRAINT message_destinations_owner_check CHECK ((num_nonnulls(owner_user_id, owner_caixa_id) <= 1)),
    CONSTRAINT message_destinations_telegram_check CHECK (((channel <> 'telegram'::text) OR ((bot_token IS NOT NULL) AND (chat_id IS NOT NULL)))),
    CONSTRAINT message_destinations_webhook_secret_hash_check CHECK ((webhook_secret_hash ~ '^[0-9a-f]{64}$'::text))
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
-- Name: COLUMN message_destinations.inbound_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.inbound_enabled IS '"Receber mensagens" (spec 029): o bot entrega as mensagens por webhook em /api/telegram/webhook/:id e o agente inbound_agent_id responde. Exige destino ativo, agente e segredo (message_destinations_inbound_check): desativar ou arquivar o destino desliga a entrada na mesma operação (e a aplicação chama deleteWebhook). Um destino com a entrada ligada por bot (message_destinations_inbound_bot_key, 23505). A importação do backup traz false.';


--
-- Name: COLUMN message_destinations.inbound_agent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.inbound_agent_id IS 'Agente que responde às mensagens recebidas. Excluir o agente em uso dá 23503 (arquive).';


--
-- Name: COLUMN message_destinations.webhook_secret_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_destinations.webhook_secret_hash IS 'SEGREDO: SHA-256 (hex, telegram_secret_hash) do secret_token enviado no setWebhook. moneyflow_app grava mas NÃO lê esta coluna; o webhook confere o cabeçalho X-Telegram-Bot-Api-Secret-Token por telegram_webhook_authenticate. Nunca vai para o audit_log; o backup o lê por admin_message_destination_webhook_secret.';


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
    CONSTRAINT message_subscriptions_event_kind_check CHECK ((event_kind = ANY (ARRAY['due_reminder'::text, 'overdue'::text, 'daily_summary'::text, 'weekly_summary'::text, 'invoice_closed'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'agent_completed'::text, 'agent_message'::text, 'contract_notice_deadline'::text, 'contract_ending'::text, 'contract_renewal_pending'::text, 'contract_readjustment'::text, 'ai_budget_alert'::text, 'ai_awaiting_approval'::text]))),
    CONSTRAINT message_subscriptions_params_check CHECK (public.message_subscription_params_valid(event_kind, params))
);


--
-- Name: TABLE message_subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_subscriptions IS 'Eventos que um destino recebe (spec 013), um por tipo de evento, com parâmetros validados por message_subscription_params_valid. Filtro opcional por caixas em message_subscription_caixas (sem linhas = todas as caixas que o dono do destino vê).';


--
-- Name: COLUMN message_subscriptions.event_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_subscriptions.event_kind IS 'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos (spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base); ai_budget_alert (spec 028: orçamento de IA cruzou o aviso ou chegou a 100%; sem parâmetros); ai_awaiting_approval (spec 029: uma tarefa agendada ou a conciliação com IA espera aprovação; sem parâmetros).';


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
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['agent_completed'::text, 'agent_message'::text, 'mirror_pending'::text, 'mirror_disputed'::text, 'invoice_closed'::text, 'due_reminder'::text, 'overdue'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'message_failed'::text, 'system'::text, 'contract_notice_deadline'::text, 'contract_ending'::text, 'contract_renewal_pending'::text, 'contract_readjustment'::text, 'ai_budget_alert'::text, 'ai_awaiting_approval'::text, 'contract_charge_missing'::text]))),
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

COMMENT ON COLUMN public.notifications.kind IS 'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, contract_renewal_pending (histórico), contract_readjustment, ai_budget_alert (spec 028; dedup por orçamento, mês e limiar), ai_awaiting_approval (spec 029) ou contract_charge_missing (spec 034: ocorrência de cobrança no cartão não cobrada, uma vez por ocorrência).';


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
    caixa_id uuid NOT NULL,
    contract_id uuid,
    match_window_days smallint DEFAULT 15 NOT NULL,
    late_fee_percent numeric(6,4),
    interest_month_percent numeric(6,4),
    early_discount_percent numeric(6,4),
    tolerance_cents bigint DEFAULT 0 NOT NULL,
    auto_settle boolean DEFAULT false NOT NULL,
    CONSTRAINT recurrence_rules_anchor_day_check CHECK (
CASE frequency
    WHEN 'weekly'::text THEN ((anchor_day >= 1) AND (anchor_day <= 7))
    ELSE ((anchor_day >= 1) AND (anchor_day <= 31))
END),
    CONSTRAINT recurrence_rules_early_discount_percent_check CHECK (((early_discount_percent >= (0)::numeric) AND (early_discount_percent <= (50)::numeric))),
    CONSTRAINT recurrence_rules_end_check CHECK (((ends_on IS NULL) OR (installments_total IS NULL))),
    CONSTRAINT recurrence_rules_ends_on_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT recurrence_rules_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT recurrence_rules_installments_total_check CHECK (((installments_total >= 2) AND (installments_total <= 999))),
    CONSTRAINT recurrence_rules_interest_month_percent_check CHECK (((interest_month_percent >= (0)::numeric) AND (interest_month_percent <= (10)::numeric))),
    CONSTRAINT recurrence_rules_interval_count_check CHECK (((interval_count >= 1) AND (interval_count <= 366))),
    CONSTRAINT recurrence_rules_late_fee_percent_check CHECK (((late_fee_percent >= (0)::numeric) AND (late_fee_percent <= (20)::numeric))),
    CONSTRAINT recurrence_rules_match_window_days_check CHECK (((match_window_days >= 0) AND (match_window_days <= 45))),
    CONSTRAINT recurrence_rules_tolerance_cents_check CHECK ((tolerance_cents >= 0))
);


--
-- Name: TABLE recurrence_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recurrence_rules IS 'Série recorrente ou parcelamento (spec 005): o calendário, a caixa (caixa_id) e, opcionalmente, o contrato de que é obrigação (contract_id, spec 034) e os ajustes de reconhecimento do pagamento. Série numa caixa general = títulos materializados pelo worker até 12 meses à frente (titles.recurrence_rule_id/occurrence; modelo = a ocorrência mais recente). Série na caixa de um cartão = cobrança esperada (card_recurring_charges), sem títulos.';


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
-- Name: COLUMN recurrence_rules.caixa_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.caixa_id IS 'Caixa da série: a do lado original dos títulos (a da conta da obrigação) ou, na cobrança esperada, a do cartão (credit_card ⇔ card_recurring_charges, no COMMIT). Mudar exige mover os títulos na mesma transação.';


--
-- Name: COLUMN recurrence_rules.contract_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.contract_id IS 'Contrato de que a série é obrigação (spec 034; ON DELETE SET NULL). Os títulos da série e as compras ligadas carregam o mesmo contract_id (no COMMIT): ligar ou desligar a série muda os dois na mesma transação.';


--
-- Name: COLUMN recurrence_rules.match_window_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.match_window_days IS 'Reconhecimento: janela em dias em torno do vencimento (0–45, padrão 15), além do mês do vencimento.';


--
-- Name: COLUMN recurrence_rules.late_fee_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.late_fee_percent IS 'Reconhecimento: multa por atraso (0–20%) sobre o valor, uma vez. Nula = sem.';


--
-- Name: COLUMN recurrence_rules.interest_month_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.interest_month_percent IS 'Reconhecimento: juros de mora (0–10% ao mês), pró-rata por dia. Nulo = sem.';


--
-- Name: COLUMN recurrence_rules.early_discount_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.early_discount_percent IS 'Reconhecimento: desconto por pontualidade (0–50%) até o vencimento. Nulo = sem.';


--
-- Name: COLUMN recurrence_rules.tolerance_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.tolerance_cents IS 'Reconhecimento: diferença aceita além dos encargos (≥ 0, padrão 0; o teto de 10% do valor é da aplicação).';


--
-- Name: COLUMN recurrence_rules.auto_settle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recurrence_rules.auto_settle IS 'Baixar sem confirmação: a linha do extrato (ou da fatura) com um único candidato desta série vira conciliada direto (statement_lines.auto_settled; no cartão, a compra criada com created_entry purchase).';


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
    created_entry text,
    provisional boolean DEFAULT false NOT NULL,
    superseded_by_line_id uuid,
    supersede_outcome text,
    supersede_suggested_line_id uuid,
    supersede_suggestion_reason text,
    auto_settled boolean DEFAULT false NOT NULL,
    CONSTRAINT statement_lines_amount_cents_check CHECK ((amount_cents <> 0)),
    CONSTRAINT statement_lines_auto_settled_check CHECK (((NOT auto_settled) OR ((status = 'matched'::text) AND COALESCE((created_entry = ANY (ARRAY['settlement'::text, 'transfer_settlement'::text, 'purchase'::text])), false)))),
    CONSTRAINT statement_lines_classification_source_check CHECK (((classification_source = ANY (ARRAY['rule'::text, 'agent'::text, 'user'::text])) AND ((classification_rule_id IS NULL) OR (NOT (classification_source IS DISTINCT FROM 'rule'::text))))),
    CONSTRAINT statement_lines_created_entry_check CHECK (((created_entry IS NULL) OR ((created_entry = ANY (ARRAY['adjustment'::text, 'title'::text, 'settlement'::text, 'transfer_settlement'::text, 'purchase'::text])) AND (status = 'matched'::text)))),
    CONSTRAINT statement_lines_created_entry_links_check CHECK (
CASE created_entry
    WHEN 'adjustment'::text THEN (movement_id IS NOT NULL)
    WHEN 'title'::text THEN (movement_id IS NOT NULL)
    WHEN 'settlement'::text THEN (movement_id IS NOT NULL)
    WHEN 'transfer_settlement'::text THEN (movement_id IS NOT NULL)
    WHEN 'purchase'::text THEN (card_invoice_item_id IS NOT NULL)
    ELSE true
END),
    CONSTRAINT statement_lines_dedup_hash_check CHECK (((btrim(dedup_hash) <> ''::text) AND (length(dedup_hash) <= 200))),
    CONSTRAINT statement_lines_line_number_check CHECK ((line_number >= 1)),
    CONSTRAINT statement_lines_links_check CHECK ((((movement_id IS NULL) OR (financial_account_id IS NOT NULL)) AND ((title_id IS NULL) OR (financial_account_id IS NOT NULL)) AND ((card_invoice_item_id IS NULL) OR (card_caixa_id IS NOT NULL)) AND
CASE status
    WHEN 'matched'::text THEN ((num_nonnulls(movement_id, card_invoice_item_id) = 1) AND (title_id IS NULL))
    WHEN 'suggested'::text THEN (num_nonnulls(movement_id, title_id, card_invoice_item_id) = 1)
    ELSE (num_nonnulls(movement_id, title_id, card_invoice_item_id) = 0)
END AND ((status = 'matched'::text) = (matched_at IS NOT NULL)))),
    CONSTRAINT statement_lines_raw_check CHECK ((jsonb_typeof(raw) = 'object'::text)),
    CONSTRAINT statement_lines_status_check CHECK ((status = ANY (ARRAY['matched'::text, 'suggested'::text, 'new'::text, 'ignored'::text, 'superseded'::text]))),
    CONSTRAINT statement_lines_supersede_outcome_check CHECK ((((supersede_outcome IS NULL) OR (supersede_outcome = ANY (ARRAY['transferred'::text, 'paired'::text, 'dropped'::text, 'pending'::text, 'kept'::text, 'entry_deleted'::text]))) AND ((status = 'superseded'::text) = COALESCE((supersede_outcome <> 'pending'::text), false)) AND ((supersede_outcome IS DISTINCT FROM 'pending'::text) OR (status = 'matched'::text)) AND ((superseded_by_line_id IS NOT NULL) = COALESCE((supersede_outcome = ANY (ARRAY['transferred'::text, 'paired'::text])), false)) AND (superseded_by_line_id IS DISTINCT FROM id))),
    CONSTRAINT statement_lines_supersede_suggestion_check CHECK ((((supersede_suggested_line_id IS NULL) OR (NOT (supersede_outcome IS DISTINCT FROM 'pending'::text))) AND ((supersede_suggestion_reason IS NULL) OR ((supersede_suggested_line_id IS NOT NULL) AND (btrim(supersede_suggestion_reason) <> ''::text) AND (length(supersede_suggestion_reason) <= 500))))),
    CONSTRAINT statement_lines_target_check CHECK ((num_nonnulls(financial_account_id, card_caixa_id) = 1))
);


--
-- Name: TABLE statement_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.statement_lines IS 'Linhas de um extrato importado (spec 009), deduplicadas por conta (só entre lotes não provisórios) ou cartão via dedup_hash. matched = conciliada (movimento ou item de fatura), suggested = casamento proposto aguardando confirmação, new = sem par (vira baixa ou movimento avulso), ignored = descartada, superseded = linha de um lote provisório substituído pelo consolidado (spec 031), sem vínculo, com o desfecho em supersede_outcome.';


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
-- Name: COLUMN statement_lines.created_entry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.created_entry IS 'Só em matched: o lançamento ligado foi criado a partir desta linha. adjustment = o movimento avulso de movement_id; title = o título (o par com o espelho) e a baixa cujo movimento é movement_id; settlement = só a baixa cujo movimento é movement_id, num título que já existia (casar com título em aberto); transfer_settlement = a baixa num título de outra caixa (na conta de passagem) e a transferência que a financia (transfers.settlement_id), sendo movement_id a perna da transferência na conta da linha; purchase = a compra no cartão do card_invoice_item_id. Nulo = a linha foi casada com um lançamento que já existia. A aplicação grava junto com a conciliação e limpa ao desfazer ou ignorar a linha (o "desfazer e excluir o lançamento" apaga o que ela indica; em transfer_settlement, a baixa e a transferência).';


--
-- Name: COLUMN statement_lines.provisional; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.provisional IS 'Cópia de statement_imports.provisional, mantida pelo banco (preenchida no INSERT; acompanha o lote ao marcar ou desmarcar). Linha provisória fica fora de statement_lines_account_dedup_key; desmarcar um lote cujas linhas repetem as de outro lote não provisório dá 23505.';


--
-- Name: COLUMN statement_lines.superseded_by_line_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.superseded_by_line_id IS 'transferred/paired: a linha do lote que substituiu o desta linha (statement_imports.superseded_by_import_id), que ficou no lugar dela.';


--
-- Name: COLUMN statement_lines.supersede_outcome; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.supersede_outcome IS 'Só em linha de lote substituído (spec 031), e toda linha dele tem um: transferred (conciliação passada à linha do consolidado), paired (ignorada/nova com par; a classificação passou), dropped (ignorada/nova sem par), pending (conciliada sem par: continua matched, aguardando o usuário), kept (pendente que soltou o vínculo e manteve o lançamento), entry_deleted (pendente cujo lançamento criado pela linha foi excluído). Na troca, matched vira transferred ou pending e as demais, paired ou dropped; pending só sai para transferred, kept ou entry_deleted (este só com created_entry); os outros são finais.';


--
-- Name: COLUMN statement_lines.supersede_suggested_line_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.supersede_suggested_line_id IS 'Só em pending: par sugerido pela IA (fluxo supersede_pairs), uma linha do lote substituto com o mesmo amount_cents. A aplicação limpa ao aprovar, descartar ou sair de pending.';


--
-- Name: COLUMN statement_lines.supersede_suggestion_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.supersede_suggestion_reason IS 'Motivo curto da sugestão da IA (até 500 caracteres).';


--
-- Name: COLUMN statement_lines.auto_settled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.statement_lines.auto_settled IS 'O lançamento desta linha foi feito sem confirmação (recurrence_rules.auto_settle, specs 033 e 034). Só em matched com created_entry settlement, transfer_settlement ou purchase (a compra da cobrança no cartão); a aplicação limpa junto com created_entry.';


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
    (COALESCE(c.ignored, (0)::bigint))::integer AS ignored_lines,
    i.provisional,
    (i.superseded_by_import_id IS NOT NULL) AS superseded
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

COMMENT ON VIEW public.statement_import_balances IS 'Por lote: saldo informado pelo banco × saldo do app na mesma data (difference_cents = banco − app; 0 = sem divergência) e contagem de linhas por status (lines inclui as superseded). Saldo só para contas (não para cartão). provisional e superseded (spec 031): a aplicação tira os substituídos da divergência e do "lote anterior".';


--
-- Name: telegram_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_links (
    id uuid DEFAULT uuidv7() NOT NULL,
    destination_id uuid NOT NULL,
    user_id uuid NOT NULL,
    chat_id bigint NOT NULL,
    telegram_user_id bigint NOT NULL,
    username text,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_links_chat_id_check CHECK ((chat_id > 0)),
    CONSTRAINT telegram_links_telegram_user_id_check CHECK ((telegram_user_id > 0)),
    CONSTRAINT telegram_links_username_check CHECK ((username ~ '^[A-Za-z0-9_]{1,64}$'::text))
);


--
-- Name: TABLE telegram_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.telegram_links IS 'Pareamento de um chat privado do Telegram com um usuário, por destino com entrada (spec 029). Criado por telegram_pairing_consume (/start <código>). Um ativo por (destino, chat) (telegram_links_active_key); desfazer = revoked_at (irreversível). Auditada e no backup.';


--
-- Name: COLUMN telegram_links.chat_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_links.chat_id IS 'id do chat privado (positivo; grupos e canais não pareiam).';


--
-- Name: COLUMN telegram_links.telegram_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_links.telegram_user_id IS 'id do usuário do Telegram (no chat privado, igual ao chat_id).';


--
-- Name: COLUMN telegram_links.username; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_links.username IS '@username do Telegram, sem a arroba, quando houver (pode ser atualizado).';


--
-- Name: COLUMN telegram_links.revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_links.revoked_at IS 'Desfeito em (irreversível; nulo = ativo).';


--
-- Name: telegram_pairing_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_pairing_codes (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    destination_id uuid NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    used_at timestamp with time zone,
    link_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_pairing_codes_code_hash_check CHECK ((code_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT telegram_pairing_codes_expires_at_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:10:00'::interval)))),
    CONSTRAINT telegram_pairing_codes_link_check CHECK (((link_id IS NULL) OR (used_at IS NOT NULL)))
);


--
-- Name: TABLE telegram_pairing_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.telegram_pairing_codes IS 'Códigos de pareamento do Telegram (spec 029): 8 caracteres, válidos por 10 min, de uso único, para um destino com entrada. Só o hash é guardado. Crie por telegram_pairing_code_create e consuma por telegram_pairing_consume. Auditada (sem o hash); fora do backup.';


--
-- Name: COLUMN telegram_pairing_codes.code_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_pairing_codes.code_hash IS 'SHA-256 (hex, telegram_secret_hash) do código em maiúsculas. moneyflow_app grava mas NÃO lê esta coluna. Nunca vai para o audit_log.';


--
-- Name: COLUMN telegram_pairing_codes.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_pairing_codes.expires_at IS 'Expiração: no máximo 10 min depois da criação (padrão).';


--
-- Name: COLUMN telegram_pairing_codes.used_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_pairing_codes.used_at IS 'Usado em (uma vez só; nulo = ainda não usado).';


--
-- Name: COLUMN telegram_pairing_codes.link_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_pairing_codes.link_id IS 'Vínculo criado (ou mantido) com este código.';


--
-- Name: telegram_updates_seen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_updates_seen (
    destination_id uuid NOT NULL,
    update_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_updates_seen_update_id_check CHECK ((update_id >= 0))
);


--
-- Name: TABLE telegram_updates_seen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.telegram_updates_seen IS 'update_id já recebidos por destino (spec 029), para o webhook ignorar a reentrega do Telegram. Marque por telegram_update_seen; purga por telegram_updates_seen_purge (7 dias). Fora da auditoria e do backup.';


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
-- Name: ai_budgets ai_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budgets
    ADD CONSTRAINT ai_budgets_pkey PRIMARY KEY (id);


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
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_runs
    ADD CONSTRAINT ai_reconcile_recipe_runs_pkey PRIMARY KEY (id);


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_targets
    ADD CONSTRAINT ai_reconcile_recipe_targets_pkey PRIMARY KEY (id);


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipes
    ADD CONSTRAINT ai_reconcile_recipes_pkey PRIMARY KEY (id);


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
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_task_runs
    ADD CONSTRAINT ai_scheduled_task_runs_pkey PRIMARY KEY (id);


--
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_task_scheduled_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_task_runs
    ADD CONSTRAINT ai_scheduled_task_runs_task_scheduled_key UNIQUE (task_id, scheduled_for);


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_tasks
    ADD CONSTRAINT ai_scheduled_tasks_pkey PRIMARY KEY (id);


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
-- Name: card_recurring_charge_amounts card_recurring_charge_amounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charge_amounts
    ADD CONSTRAINT card_recurring_charge_amounts_pkey PRIMARY KEY (recurrence_rule_id, from_occurrence);


--
-- Name: card_recurring_charges card_recurring_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charges
    ADD CONSTRAINT card_recurring_charges_pkey PRIMARY KEY (recurrence_rule_id);


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
-- Name: recurrence_rules recurrence_rules_id_caixa_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurrence_rules
    ADD CONSTRAINT recurrence_rules_id_caixa_key UNIQUE (id, caixa_id);


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
-- Name: telegram_links telegram_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_pkey PRIMARY KEY (id);


--
-- Name: telegram_pairing_codes telegram_pairing_codes_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_pairing_codes
    ADD CONSTRAINT telegram_pairing_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: telegram_pairing_codes telegram_pairing_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_pairing_codes
    ADD CONSTRAINT telegram_pairing_codes_pkey PRIMARY KEY (id);


--
-- Name: telegram_updates_seen telegram_updates_seen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_updates_seen
    ADD CONSTRAINT telegram_updates_seen_pkey PRIMARY KEY (destination_id, update_id);


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
-- Name: ai_attachment_derivatives_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_attachment_derivatives_conversation_id_idx ON public.ai_attachment_derivatives USING btree (conversation_id);


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
-- Name: ai_budgets_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_budgets_active_key ON public.ai_budgets USING btree (scope, user_id, agent_id, currency) NULLS NOT DISTINCT WHERE is_active;


--
-- Name: ai_budgets_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_budgets_agent_id_idx ON public.ai_budgets USING btree (agent_id);


--
-- Name: ai_budgets_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_budgets_user_id_idx ON public.ai_budgets USING btree (user_id);


--
-- Name: ai_conversations_active_chat_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_conversations_active_chat_key ON public.ai_conversations USING btree (user_id, agent_id) WHERE ((purpose = 'chat'::text) AND (archived_at IS NULL));


--
-- Name: INDEX ai_conversations_active_chat_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.ai_conversations_active_chat_key IS 'Sessão ativa única (spec 026): no máximo uma conversa chat não arquivada por (usuário, agente). 23505 ao criar a segunda; finalize (arquive) a ativa antes, ou use ai_conversation_fork, que faz isso.';


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
-- Name: ai_conversations_reconcile_import_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_reconcile_import_idx ON public.ai_conversations USING btree (((screen_context ->> 'importId'::text))) WHERE (purpose = 'reconcile_statement'::text);


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
-- Name: ai_reconcile_recipe_runs_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_runs_conversation_id_idx ON public.ai_reconcile_recipe_runs USING btree (conversation_id);


--
-- Name: ai_reconcile_recipe_runs_import_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_runs_import_id_idx ON public.ai_reconcile_recipe_runs USING btree (import_id, status, "position");


--
-- Name: ai_reconcile_recipe_runs_import_queue_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_reconcile_recipe_runs_import_queue_key ON public.ai_reconcile_recipe_runs USING btree (import_id, recipe_id) WHERE (trigger_kind = 'import'::text);


--
-- Name: ai_reconcile_recipe_runs_queued_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_runs_queued_idx ON public.ai_reconcile_recipe_runs USING btree (created_at) WHERE (status = 'queued'::text);


--
-- Name: ai_reconcile_recipe_runs_recipe_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_runs_recipe_id_idx ON public.ai_reconcile_recipe_runs USING btree (recipe_id, created_at DESC);


--
-- Name: ai_reconcile_recipe_runs_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_runs_run_id_idx ON public.ai_reconcile_recipe_runs USING btree (run_id);


--
-- Name: ai_reconcile_recipe_runs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_runs_user_id_idx ON public.ai_reconcile_recipe_runs USING btree (user_id);


--
-- Name: ai_reconcile_recipe_targets_account_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_reconcile_recipe_targets_account_key ON public.ai_reconcile_recipe_targets USING btree (recipe_id, financial_account_id) WHERE (financial_account_id IS NOT NULL);


--
-- Name: ai_reconcile_recipe_targets_card_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_targets_card_caixa_id_idx ON public.ai_reconcile_recipe_targets USING btree (card_caixa_id);


--
-- Name: ai_reconcile_recipe_targets_card_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_reconcile_recipe_targets_card_key ON public.ai_reconcile_recipe_targets USING btree (recipe_id, card_caixa_id) WHERE (card_caixa_id IS NOT NULL);


--
-- Name: ai_reconcile_recipe_targets_financial_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_targets_financial_account_id_idx ON public.ai_reconcile_recipe_targets USING btree (financial_account_id);


--
-- Name: ai_reconcile_recipe_targets_recipe_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipe_targets_recipe_id_idx ON public.ai_reconcile_recipe_targets USING btree (recipe_id);


--
-- Name: ai_reconcile_recipes_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipes_agent_id_idx ON public.ai_reconcile_recipes USING btree (agent_id);


--
-- Name: ai_reconcile_recipes_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipes_caixa_id_idx ON public.ai_reconcile_recipes USING btree (caixa_id, "position");


--
-- Name: ai_reconcile_recipes_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_reconcile_recipes_created_by_user_id_idx ON public.ai_reconcile_recipes USING btree (created_by_user_id);


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
-- Name: ai_scheduled_task_runs_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_scheduled_task_runs_conversation_id_idx ON public.ai_scheduled_task_runs USING btree (conversation_id);


--
-- Name: ai_scheduled_task_runs_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_scheduled_task_runs_run_id_idx ON public.ai_scheduled_task_runs USING btree (run_id);


--
-- Name: ai_scheduled_tasks_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_scheduled_tasks_agent_id_idx ON public.ai_scheduled_tasks USING btree (agent_id);


--
-- Name: ai_scheduled_tasks_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_scheduled_tasks_created_by_user_id_idx ON public.ai_scheduled_tasks USING btree (created_by_user_id);


--
-- Name: ai_scheduled_tasks_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_scheduled_tasks_due_idx ON public.ai_scheduled_tasks USING btree (next_run_at) WHERE is_active;


--
-- Name: ai_scheduled_tasks_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_scheduled_tasks_user_id_idx ON public.ai_scheduled_tasks USING btree (user_id, created_at);


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
-- Name: ai_usage_sp_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_sp_day_idx ON public.ai_usage USING btree ((((created_at AT TIME ZONE 'America/Sao_Paulo'::text))::date));


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
-- Name: card_purchases_contract_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_contract_id_idx ON public.card_purchases USING btree (contract_id);


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
-- Name: card_purchases_recurrence_rule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_recurrence_rule_id_idx ON public.card_purchases USING btree (recurrence_rule_id, occurrence);


--
-- Name: card_purchases_refunded_purchase_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_purchases_refunded_purchase_id_idx ON public.card_purchases USING btree (refunded_purchase_id);


--
-- Name: card_recurring_charges_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_recurring_charges_category_id_idx ON public.card_recurring_charges USING btree (category_id);


--
-- Name: card_recurring_charges_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_recurring_charges_entity_id_idx ON public.card_recurring_charges USING btree (entity_id);


--
-- Name: card_recurring_charges_payer_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_recurring_charges_payer_caixa_id_idx ON public.card_recurring_charges USING btree (payer_caixa_id);


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
-- Name: classification_rules_copied_from_rule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_copied_from_rule_id_idx ON public.classification_rules USING btree (copied_from_rule_id);


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
-- Name: classification_rules_financial_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classification_rules_financial_account_id_idx ON public.classification_rules USING btree (financial_account_id);


--
-- Name: classification_rules_pattern_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX classification_rules_pattern_key ON public.classification_rules USING btree (caixa_id, financial_account_id, match_kind, lower(pattern), direction) NULLS NOT DISTINCT WHERE (archived_at IS NULL);


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
-- Name: contract_renewal_tasks_new_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contract_renewal_tasks_new_cycle_id_idx ON public.contract_renewal_tasks USING btree (new_cycle_id);


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
-- Name: contracts_ends_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contracts_ends_on_idx ON public.contracts USING btree (ends_on) WHERE (archived_at IS NULL);


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
-- Name: message_destinations_inbound_agent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_destinations_inbound_agent_id_idx ON public.message_destinations USING btree (inbound_agent_id);


--
-- Name: message_destinations_inbound_bot_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_destinations_inbound_bot_key ON public.message_destinations USING btree (bot_id) WHERE inbound_enabled;


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
-- Name: recurrence_rules_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurrence_rules_caixa_id_idx ON public.recurrence_rules USING btree (caixa_id);


--
-- Name: recurrence_rules_contract_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurrence_rules_contract_id_idx ON public.recurrence_rules USING btree (contract_id);


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
-- Name: statement_imports_provisional_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_provisional_active_idx ON public.statement_imports USING btree (financial_account_id, period_start) WHERE (provisional AND (superseded_by_import_id IS NULL));


--
-- Name: statement_imports_superseded_by_import_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_imports_superseded_by_import_id_idx ON public.statement_imports USING btree (superseded_by_import_id);


--
-- Name: statement_lines_account_dedup_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statement_lines_account_dedup_key ON public.statement_lines USING btree (financial_account_id, dedup_hash) WHERE ((financial_account_id IS NOT NULL) AND (NOT provisional));


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
-- Name: statement_lines_supersede_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_supersede_pending_idx ON public.statement_lines USING btree (financial_account_id, posted_on) WHERE (supersede_outcome = 'pending'::text);


--
-- Name: statement_lines_supersede_suggested_line_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_supersede_suggested_line_id_idx ON public.statement_lines USING btree (supersede_suggested_line_id);


--
-- Name: statement_lines_superseded_by_line_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_superseded_by_line_id_idx ON public.statement_lines USING btree (superseded_by_line_id);


--
-- Name: statement_lines_title_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_lines_title_id_idx ON public.statement_lines USING btree (title_id);


--
-- Name: telegram_links_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX telegram_links_active_key ON public.telegram_links USING btree (destination_id, chat_id) WHERE (revoked_at IS NULL);


--
-- Name: telegram_links_destination_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_links_destination_id_idx ON public.telegram_links USING btree (destination_id);


--
-- Name: telegram_links_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_links_user_id_idx ON public.telegram_links USING btree (user_id, created_at);


--
-- Name: telegram_pairing_codes_destination_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_pairing_codes_destination_id_idx ON public.telegram_pairing_codes USING btree (destination_id);


--
-- Name: telegram_pairing_codes_link_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_pairing_codes_link_id_idx ON public.telegram_pairing_codes USING btree (link_id);


--
-- Name: telegram_pairing_codes_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_pairing_codes_user_id_idx ON public.telegram_pairing_codes USING btree (user_id, created_at);


--
-- Name: telegram_updates_seen_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_updates_seen_created_at_idx ON public.telegram_updates_seen USING btree (created_at);


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
-- Name: titles_planned_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_planned_account_id_idx ON public.titles USING btree (planned_account_id) WHERE (planned_account_id IS NOT NULL);


--
-- Name: titles_planned_account_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_planned_account_open_idx ON public.titles USING btree (planned_account_id, due_date) WHERE ((planned_account_id IS NOT NULL) AND (status = ANY (ARRAY['open'::text, 'partial'::text])));


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
-- Name: ai_budgets ai_budgets_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_budgets_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_budgets FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: ai_budgets ai_budgets_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_budgets_set_updated_at BEFORE UPDATE ON public.ai_budgets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_conversations ai_conversations_archive_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_conversations_archive_guard BEFORE UPDATE OF archived_at ON public.ai_conversations FOR EACH ROW WHEN (((old.purpose = 'chat'::text) AND (old.archived_at IS DISTINCT FROM new.archived_at))) EXECUTE FUNCTION public.ai_conversations_archive_guard();


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
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipe_runs_before_write BEFORE INSERT OR UPDATE ON public.ai_reconcile_recipe_runs FOR EACH ROW EXECUTE FUNCTION public.ai_reconcile_recipe_runs_before_write();


--
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipe_runs_set_updated_at BEFORE UPDATE ON public.ai_reconcile_recipe_runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipe_targets_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_reconcile_recipe_targets FOR EACH ROW EXECUTE FUNCTION public.ai_reconcile_recipe_targets_audit_row();


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipe_targets_before_write BEFORE INSERT OR UPDATE ON public.ai_reconcile_recipe_targets FOR EACH ROW EXECUTE FUNCTION public.ai_reconcile_recipe_targets_before_write();


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_run_on_import_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER ai_reconcile_recipe_targets_run_on_import_check AFTER DELETE OR UPDATE OF recipe_id ON public.ai_reconcile_recipe_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ai_reconcile_recipes_run_on_import_check();


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipe_targets_set_updated_at BEFORE UPDATE ON public.ai_reconcile_recipe_targets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipes_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_reconcile_recipes FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipes_before_write BEFORE INSERT OR UPDATE ON public.ai_reconcile_recipes FOR EACH ROW EXECUTE FUNCTION public.ai_reconcile_recipes_before_write();


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_run_on_import_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER ai_reconcile_recipes_run_on_import_check AFTER INSERT OR UPDATE OF run_on_import ON public.ai_reconcile_recipes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ai_reconcile_recipes_run_on_import_check();


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_reconcile_recipes_set_updated_at BEFORE UPDATE ON public.ai_reconcile_recipes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_scheduled_task_runs_before_write BEFORE INSERT OR UPDATE ON public.ai_scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION public.ai_scheduled_task_runs_before_write();


--
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_scheduled_task_runs_set_updated_at BEFORE UPDATE ON public.ai_scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_scheduled_tasks_audit AFTER INSERT OR DELETE OR UPDATE ON public.ai_scheduled_tasks FOR EACH ROW EXECUTE FUNCTION public.audit_row('next_run_at,last_run_at');


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_scheduled_tasks_before_write BEFORE INSERT OR UPDATE ON public.ai_scheduled_tasks FOR EACH ROW EXECUTE FUNCTION public.ai_scheduled_tasks_before_write();


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_scheduled_tasks_set_updated_at BEFORE UPDATE ON public.ai_scheduled_tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: card_purchases card_purchases_contract_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_purchases_contract_integrity_check AFTER INSERT OR UPDATE OF contract_id ON public.card_purchases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contract_refs_integrity_check();


--
-- Name: card_purchases card_purchases_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_purchases_integrity_check AFTER INSERT OR UPDATE ON public.card_purchases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.card_purchases_integrity_check();


--
-- Name: card_purchases card_purchases_period_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_period_lock BEFORE INSERT OR DELETE OR UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.card_purchases_period_lock();


--
-- Name: card_purchases card_purchases_recurrence_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_purchases_recurrence_integrity_check AFTER INSERT OR UPDATE OF recurrence_rule_id, contract_id ON public.card_purchases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.recurrence_rule_integrity_check();


--
-- Name: card_purchases card_purchases_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_set_updated_at BEFORE UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_purchases card_purchases_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_validate BEFORE INSERT OR UPDATE ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.card_purchases_validate();


--
-- Name: card_purchases card_purchases_validate_occurrence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_purchases_validate_occurrence BEFORE INSERT OR UPDATE OF recurrence_rule_id, occurrence ON public.card_purchases FOR EACH ROW EXECUTE FUNCTION public.card_purchases_validate_occurrence();


--
-- Name: card_recurring_charge_amounts card_recurring_charge_amounts_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_recurring_charge_amounts_audit AFTER INSERT OR DELETE OR UPDATE ON public.card_recurring_charge_amounts FOR EACH ROW EXECUTE FUNCTION public.audit_row_keyed('recurrence_rule_id');


--
-- Name: card_recurring_charge_amounts card_recurring_charge_amounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_recurring_charge_amounts_set_updated_at BEFORE UPDATE ON public.card_recurring_charge_amounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_recurring_charges card_recurring_charges_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_recurring_charges_audit AFTER INSERT OR DELETE OR UPDATE ON public.card_recurring_charges FOR EACH ROW EXECUTE FUNCTION public.audit_row_keyed('recurrence_rule_id');


--
-- Name: card_recurring_charges card_recurring_charges_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_recurring_charges_integrity_check AFTER INSERT OR DELETE ON public.card_recurring_charges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.recurrence_rule_integrity_check();


--
-- Name: card_recurring_charges card_recurring_charges_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_recurring_charges_set_updated_at BEFORE UPDATE ON public.card_recurring_charges FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: card_recurring_charges card_recurring_charges_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_recurring_charges_validate BEFORE INSERT OR UPDATE ON public.card_recurring_charges FOR EACH ROW EXECUTE FUNCTION public.card_recurring_charges_validate();


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
-- Name: classification_rules classification_rules_validate_target; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER classification_rules_validate_target BEFORE INSERT OR UPDATE OF caixa_id, financial_account_id ON public.classification_rules FOR EACH ROW EXECUTE FUNCTION public.classification_rules_validate_target();


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

CREATE CONSTRAINT TRIGGER contract_cycles_contiguous_check AFTER INSERT OR DELETE OR UPDATE OF seq, starts_on, ends_on, duration_months ON public.contract_cycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contract_cycles_contiguous_check();


--
-- Name: contract_cycles contract_cycles_fill; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contract_cycles_fill BEFORE INSERT OR UPDATE ON public.contract_cycles FOR EACH ROW EXECUTE FUNCTION public.contract_cycles_fill();


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
-- Name: contracts contracts_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER contracts_integrity_check AFTER INSERT OR UPDATE OF status ON public.contracts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contracts_status_integrity_check();


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
-- Name: financial_accounts financial_accounts_validate_payment_refs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_validate_payment_refs BEFORE UPDATE OF caixa_id ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION public.financial_accounts_validate_payment_refs();


--
-- Name: financial_accounts financial_accounts_validate_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER financial_accounts_validate_rules BEFORE UPDATE OF caixa_id, kind ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION public.financial_accounts_validate_rules();


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
-- Name: period_closings period_closings_provisional_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_closings_provisional_check BEFORE INSERT ON public.period_closings FOR EACH ROW EXECUTE FUNCTION public.period_closings_provisional_check();


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
-- Name: recurrence_rules recurrence_rules_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER recurrence_rules_integrity_check AFTER INSERT OR UPDATE OF caixa_id, contract_id ON public.recurrence_rules DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.recurrence_rule_integrity_check();


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
-- Name: statement_imports statement_imports_supersede_commit_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER statement_imports_supersede_commit_check AFTER INSERT OR UPDATE OF provisional, period_start, period_end, superseded_by_import_id ON public.statement_imports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.statement_imports_supersede_commit_check();


--
-- Name: statement_imports statement_imports_supersede_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_imports_supersede_validate BEFORE INSERT OR DELETE OR UPDATE ON public.statement_imports FOR EACH ROW EXECUTE FUNCTION public.statement_imports_supersede_validate();


--
-- Name: statement_imports statement_imports_sync_provisional; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_imports_sync_provisional AFTER UPDATE OF provisional ON public.statement_imports FOR EACH ROW WHEN ((new.provisional IS DISTINCT FROM old.provisional)) EXECUTE FUNCTION public.statement_imports_sync_provisional();


--
-- Name: statement_imports statement_imports_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_imports_validate BEFORE INSERT OR UPDATE ON public.statement_imports FOR EACH ROW EXECUTE FUNCTION public.statement_imports_validate();


--
-- Name: statement_lines statement_lines_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_audit AFTER INSERT OR DELETE OR UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.audit_row('provisional');


--
-- Name: statement_lines statement_lines_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_set_updated_at BEFORE UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: statement_lines statement_lines_supersede_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_supersede_validate BEFORE INSERT OR DELETE OR UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.statement_lines_supersede_validate();


--
-- Name: statement_lines statement_lines_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_validate BEFORE INSERT OR UPDATE ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.statement_lines_validate();


--
-- Name: statement_lines statement_lines_validate_created_entry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statement_lines_validate_created_entry BEFORE INSERT OR UPDATE OF created_entry, movement_id ON public.statement_lines FOR EACH ROW EXECUTE FUNCTION public.statement_lines_validate_created_entry();


--
-- Name: telegram_links telegram_links_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_links_audit AFTER INSERT OR DELETE OR UPDATE ON public.telegram_links FOR EACH ROW EXECUTE FUNCTION public.audit_row('username');


--
-- Name: telegram_links telegram_links_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_links_set_updated_at BEFORE UPDATE ON public.telegram_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: telegram_links telegram_links_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_links_validate BEFORE UPDATE ON public.telegram_links FOR EACH ROW EXECUTE FUNCTION public.telegram_links_validate();


--
-- Name: telegram_pairing_codes telegram_pairing_codes_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_pairing_codes_audit AFTER INSERT OR DELETE OR UPDATE ON public.telegram_pairing_codes FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: telegram_pairing_codes telegram_pairing_codes_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_pairing_codes_set_updated_at BEFORE UPDATE ON public.telegram_pairing_codes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: telegram_pairing_codes telegram_pairing_codes_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_pairing_codes_validate BEFORE INSERT OR UPDATE ON public.telegram_pairing_codes FOR EACH ROW EXECUTE FUNCTION public.telegram_pairing_codes_validate();


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
-- Name: titles titles_recurrence_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER titles_recurrence_integrity_check AFTER INSERT OR UPDATE OF recurrence_rule_id, caixa_id, contract_id, mirror_status ON public.titles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.recurrence_rule_integrity_check();


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

CREATE TRIGGER titles_validate_contract BEFORE INSERT OR UPDATE OF contract_id, contract_cycle_id, contract_installment, recurrence_rule_id, direction, entity_id, mirror_status ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate_contract();


--
-- Name: titles titles_validate_planned_account; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate_planned_account BEFORE INSERT OR UPDATE OF caixa_id, planned_account_id ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate_planned_account();


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
-- Name: ai_attachment_derivatives ai_attachment_derivatives_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_attachment_derivatives
    ADD CONSTRAINT ai_attachment_derivatives_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE SET NULL;


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
-- Name: ai_budgets ai_budgets_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budgets
    ADD CONSTRAINT ai_budgets_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE CASCADE;


--
-- Name: ai_budgets ai_budgets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budgets
    ADD CONSTRAINT ai_budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


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
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_runs
    ADD CONSTRAINT ai_reconcile_recipe_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE SET NULL;


--
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_runs
    ADD CONSTRAINT ai_reconcile_recipe_runs_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.statement_imports(id) ON DELETE CASCADE;


--
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_runs
    ADD CONSTRAINT ai_reconcile_recipe_runs_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.ai_reconcile_recipes(id) ON DELETE CASCADE;


--
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_runs
    ADD CONSTRAINT ai_reconcile_recipe_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_runs(id) ON DELETE SET NULL;


--
-- Name: ai_reconcile_recipe_runs ai_reconcile_recipe_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_runs
    ADD CONSTRAINT ai_reconcile_recipe_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_card_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_targets
    ADD CONSTRAINT ai_reconcile_recipe_targets_card_caixa_id_fkey FOREIGN KEY (card_caixa_id) REFERENCES public.caixas(id) ON DELETE CASCADE;


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_targets
    ADD CONSTRAINT ai_reconcile_recipe_targets_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id) ON DELETE CASCADE;


--
-- Name: ai_reconcile_recipe_targets ai_reconcile_recipe_targets_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipe_targets
    ADD CONSTRAINT ai_reconcile_recipe_targets_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.ai_reconcile_recipes(id) ON DELETE CASCADE;


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipes
    ADD CONSTRAINT ai_reconcile_recipes_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id);


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipes
    ADD CONSTRAINT ai_reconcile_recipes_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: ai_reconcile_recipes ai_reconcile_recipes_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_reconcile_recipes
    ADD CONSTRAINT ai_reconcile_recipes_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


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
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_task_runs
    ADD CONSTRAINT ai_scheduled_task_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE SET NULL;


--
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_task_runs
    ADD CONSTRAINT ai_scheduled_task_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_runs(id) ON DELETE SET NULL;


--
-- Name: ai_scheduled_task_runs ai_scheduled_task_runs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_task_runs
    ADD CONSTRAINT ai_scheduled_task_runs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.ai_scheduled_tasks(id) ON DELETE CASCADE;


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_tasks
    ADD CONSTRAINT ai_scheduled_tasks_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id);


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_tasks
    ADD CONSTRAINT ai_scheduled_tasks_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_scheduled_tasks ai_scheduled_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_scheduled_tasks
    ADD CONSTRAINT ai_scheduled_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


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
-- Name: card_purchases card_purchases_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id);


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
-- Name: card_purchases card_purchases_recurrence_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_recurrence_rule_id_fkey FOREIGN KEY (recurrence_rule_id, card_caixa_id) REFERENCES public.recurrence_rules(id, caixa_id);


--
-- Name: card_purchases card_purchases_refunded_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_purchases
    ADD CONSTRAINT card_purchases_refunded_purchase_id_fkey FOREIGN KEY (refunded_purchase_id) REFERENCES public.card_purchases(id);


--
-- Name: card_recurring_charge_amounts card_recurring_charge_amounts_recurrence_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charge_amounts
    ADD CONSTRAINT card_recurring_charge_amounts_recurrence_rule_id_fkey FOREIGN KEY (recurrence_rule_id) REFERENCES public.card_recurring_charges(recurrence_rule_id) ON DELETE CASCADE;


--
-- Name: card_recurring_charges card_recurring_charges_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charges
    ADD CONSTRAINT card_recurring_charges_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: card_recurring_charges card_recurring_charges_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charges
    ADD CONSTRAINT card_recurring_charges_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: card_recurring_charges card_recurring_charges_payer_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charges
    ADD CONSTRAINT card_recurring_charges_payer_caixa_id_fkey FOREIGN KEY (payer_caixa_id) REFERENCES public.caixas(id);


--
-- Name: card_recurring_charges card_recurring_charges_recurrence_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_recurring_charges
    ADD CONSTRAINT card_recurring_charges_recurrence_rule_id_fkey FOREIGN KEY (recurrence_rule_id) REFERENCES public.recurrence_rules(id) ON DELETE CASCADE;


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
-- Name: classification_rules classification_rules_copied_from_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_copied_from_rule_id_fkey FOREIGN KEY (copied_from_rule_id) REFERENCES public.classification_rules(id) ON DELETE SET NULL;


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
-- Name: classification_rules classification_rules_financial_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES public.financial_accounts(id) ON DELETE CASCADE;


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
-- Name: message_destinations message_destinations_inbound_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_destinations
    ADD CONSTRAINT message_destinations_inbound_agent_id_fkey FOREIGN KEY (inbound_agent_id) REFERENCES public.ai_agents(id);


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
-- Name: recurrence_rules recurrence_rules_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurrence_rules
    ADD CONSTRAINT recurrence_rules_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: recurrence_rules recurrence_rules_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurrence_rules
    ADD CONSTRAINT recurrence_rules_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;


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
-- Name: statement_imports statement_imports_superseded_by_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_imports
    ADD CONSTRAINT statement_imports_superseded_by_import_id_fkey FOREIGN KEY (superseded_by_import_id) REFERENCES public.statement_imports(id);


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
-- Name: statement_lines statement_lines_supersede_suggested_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_supersede_suggested_line_id_fkey FOREIGN KEY (supersede_suggested_line_id) REFERENCES public.statement_lines(id);


--
-- Name: statement_lines statement_lines_superseded_by_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_superseded_by_line_id_fkey FOREIGN KEY (superseded_by_line_id) REFERENCES public.statement_lines(id);


--
-- Name: statement_lines statement_lines_title_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_lines
    ADD CONSTRAINT statement_lines_title_id_fkey FOREIGN KEY (title_id) REFERENCES public.titles(id);


--
-- Name: telegram_links telegram_links_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.message_destinations(id) ON DELETE CASCADE;


--
-- Name: telegram_links telegram_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telegram_pairing_codes telegram_pairing_codes_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_pairing_codes
    ADD CONSTRAINT telegram_pairing_codes_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.message_destinations(id) ON DELETE CASCADE;


--
-- Name: telegram_pairing_codes telegram_pairing_codes_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_pairing_codes
    ADD CONSTRAINT telegram_pairing_codes_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.telegram_links(id) ON DELETE SET NULL;


--
-- Name: telegram_pairing_codes telegram_pairing_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_pairing_codes
    ADD CONSTRAINT telegram_pairing_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telegram_updates_seen telegram_updates_seen_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_updates_seen
    ADD CONSTRAINT telegram_updates_seen_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.message_destinations(id) ON DELETE CASCADE;


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
-- Name: titles titles_planned_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_planned_account_id_fkey FOREIGN KEY (planned_account_id) REFERENCES public.financial_accounts(id);


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


