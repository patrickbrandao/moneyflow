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
     OR m.occurrence IS DISTINCT FROM t.occurrence THEN
    RAISE EXCEPTION 'titles: mirror pair % / % must share origin and recurrence occurrence', t.id, m.id
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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    CONSTRAINT titles_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT titles_counterparty_caixa_check CHECK ((counterparty_caixa_id <> caixa_id)),
    CONSTRAINT titles_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT titles_direction_check CHECK ((direction = ANY (ARRAY['payable'::text, 'receivable'::text]))),
    CONSTRAINT titles_mirror_fields_check CHECK ((((counterparty_caixa_id IS NULL) = (mirror_title_id IS NULL)) AND ((mirror_status IS NULL) OR (mirror_title_id IS NOT NULL)))),
    CONSTRAINT titles_mirror_self_check CHECK ((mirror_title_id <> id)),
    CONSTRAINT titles_mirror_status_check CHECK ((mirror_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'disputed'::text]))),
    CONSTRAINT titles_occurrence_check CHECK ((occurrence >= 1)),
    CONSTRAINT titles_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'recurrence'::text, 'card_invoice'::text]))),
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

COMMENT ON COLUMN public.titles.origin IS 'manual, recurrence (gerado por recurrence_rules) ou card_invoice (fatura de cartão, F2). O espelho herda a origem do original.';


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
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


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
-- Name: financial_accounts financial_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_accounts
    ADD CONSTRAINT financial_accounts_pkey PRIMARY KEY (id);


--
-- Name: movements movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_pkey PRIMARY KEY (id);


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
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);


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
-- Name: categories_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_parent_id_idx ON public.categories USING btree (parent_id);


--
-- Name: categories_sibling_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX categories_sibling_name_key ON public.categories USING btree (kind, parent_id, lower(name)) NULLS NOT DISTINCT;


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
-- Name: financial_accounts_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX financial_accounts_caixa_id_idx ON public.financial_accounts USING btree (caixa_id);


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
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


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
-- Name: titles_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX titles_category_id_idx ON public.titles USING btree (category_id);


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
-- Name: caixa_hidden_categories caixa_hidden_categories_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixa_hidden_categories_set_updated_at BEFORE UPDATE ON public.caixa_hidden_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: caixa_members caixa_members_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixa_members_set_updated_at BEFORE UPDATE ON public.caixa_members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: caixas caixas_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixas_set_updated_at BEFORE UPDATE ON public.caixas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: caixas caixas_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER caixas_validate BEFORE INSERT OR UPDATE ON public.caixas FOR EACH ROW EXECUTE FUNCTION public.caixas_validate();


--
-- Name: categories categories_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categories categories_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_validate BEFORE INSERT OR UPDATE OF kind, parent_id ON public.categories FOR EACH ROW EXECUTE FUNCTION public.categories_validate();


--
-- Name: entities entities_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entities_set_updated_at BEFORE UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_addresses entity_addresses_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_addresses_set_updated_at BEFORE UPDATE ON public.entity_addresses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_bank_accounts entity_bank_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_bank_accounts_set_updated_at BEFORE UPDATE ON public.entity_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_contacts entity_contacts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_contacts_set_updated_at BEFORE UPDATE ON public.entity_contacts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_links entity_links_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_links_set_updated_at BEFORE UPDATE ON public.entity_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entity_pix_keys entity_pix_keys_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_pix_keys_set_updated_at BEFORE UPDATE ON public.entity_pix_keys FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: movements movements_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER movements_integrity_check AFTER INSERT OR DELETE OR UPDATE ON public.movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.movements_integrity_check();


--
-- Name: movements movements_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_set_updated_at BEFORE UPDATE ON public.movements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: movements movements_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_validate BEFORE INSERT OR UPDATE ON public.movements FOR EACH ROW EXECUTE FUNCTION public.movements_validate();


--
-- Name: recurrence_rules recurrence_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurrence_rules_set_updated_at BEFORE UPDATE ON public.recurrence_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: recurrence_rules recurrence_rules_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurrence_rules_validate BEFORE UPDATE OF installments_total ON public.recurrence_rules FOR EACH ROW EXECUTE FUNCTION public.recurrence_rules_validate();


--
-- Name: settlements settlements_mirror_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER settlements_mirror_check AFTER INSERT OR UPDATE OF mirror_settlement_id, reversed_at ON public.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.settlements_mirror_check();


--
-- Name: settlements settlements_movements_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER settlements_movements_check AFTER INSERT OR UPDATE OF financial_account_id, reversed_at ON public.settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.settlements_movements_check();


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
-- Name: titles titles_mirror_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER titles_mirror_check AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin, recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status ON public.titles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.titles_mirror_check();


--
-- Name: titles titles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_set_updated_at BEFORE UPDATE ON public.titles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: titles titles_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate BEFORE INSERT OR UPDATE ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate();


--
-- Name: titles titles_validate_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER titles_validate_status BEFORE INSERT OR UPDATE OF caixa_id, amount_cents, status ON public.titles FOR EACH ROW EXECUTE FUNCTION public.titles_validate_status();


--
-- Name: transfers transfers_integrity_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER transfers_integrity_check AFTER INSERT OR UPDATE ON public.transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.transfers_integrity_check();


--
-- Name: transfers transfers_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transfers_set_updated_at BEFORE UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users users_revoke_sessions_on_deactivate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_revoke_sessions_on_deactivate AFTER UPDATE OF is_active ON public.users FOR EACH ROW WHEN ((old.is_active AND (NOT new.is_active))) EXECUTE FUNCTION public.users_revoke_sessions_on_deactivate();


--
-- Name: users users_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id);


--
-- Name: entity_addresses entity_addresses_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_addresses
    ADD CONSTRAINT entity_addresses_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


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
-- Name: financial_accounts financial_accounts_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_accounts
    ADD CONSTRAINT financial_accounts_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


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
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


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
-- Name: titles titles_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


--
-- Name: titles titles_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.titles
    ADD CONSTRAINT titles_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


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
-- PostgreSQL database dump complete
--


