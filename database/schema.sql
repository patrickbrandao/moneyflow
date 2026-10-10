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
    color text,
    icon text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT categories_color_check CHECK ((color = ANY (ARRAY['slate'::text, 'gray'::text, 'zinc'::text, 'stone'::text, 'red'::text, 'orange'::text, 'amber'::text, 'yellow'::text, 'lime'::text, 'green'::text, 'emerald'::text, 'teal'::text, 'cyan'::text, 'sky'::text, 'blue'::text, 'indigo'::text, 'violet'::text, 'purple'::text, 'fuchsia'::text, 'pink'::text, 'rose'::text]))),
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
-- Name: COLUMN categories.color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.color IS 'Nome de cor da paleta do Tailwind (ex.: violet), não hex: o front mapeia para tokens.';


--
-- Name: COLUMN categories.icon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.icon IS 'Nome de ícone lucide em kebab-case (ex.: shopping-cart).';


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
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


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
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


