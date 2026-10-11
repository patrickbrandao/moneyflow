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
  secrets constant text[] := ARRAY['password', 'bot_token'];
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

COMMENT ON FUNCTION public.audit_row() IS 'Trigger AFTER INSERT/UPDATE/DELETE de auditoria. Remove os segredos (password, bot_token): a troca aparece só em changed_columns, sem o valor. TG_ARGV[0] = colunas que sozinhas não geram linha.';


--
-- Name: audit_write(text, text, jsonb, jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: FUNCTION audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.audit_write(p_table text, p_action text, p_old jsonb, p_new jsonb, p_changed text[]) IS 'Interna: grava em audit_log com o ator de app.user_id / app.actor_kind / app.agent_run_id. Erro 23514 (audit_log_actor_check) se app.user_id não é uuid, se actor_kind é inválido ou se human/agent vem sem usuário.';


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
  IF access_key !~ '^[0-9]{44}$' THEN
    RETURN false;
  END IF;
  FOR i IN REVERSE 43..1 LOOP
    s := s + substr(access_key, i, 1)::int * w;
    w := CASE WHEN w = 9 THEN 2 ELSE w + 1 END;
  END LOOP;
  r := s % 11;
  RETURN (CASE WHEN r IN (0, 1) THEN 0 ELSE 11 - r END) = substr(access_key, 44, 1)::int;
END
$_$;


--
-- Name: FUNCTION is_valid_nfe_access_key(access_key text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_valid_nfe_access_key(access_key text) IS 'Valida a chave de acesso de NF-e/NFC-e: 44 dígitos (JÁ NORMALIZADA) e DV módulo 11 (pesos 2..9; resto 0 ou 1 => 0). NULL => NULL.';


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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    CONSTRAINT message_outbox_event_kind_check CHECK ((event_kind = ANY (ARRAY['due_reminder'::text, 'overdue'::text, 'daily_summary'::text, 'weekly_summary'::text, 'invoice_closed'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'agent_completed'::text, 'agent_message'::text, 'test'::text]))),
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
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > 60) THEN
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

COMMENT ON FUNCTION public.message_subscription_params_valid(p_event_kind text, p_params jsonb) IS 'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros distintos: days_before 0–60, thresholds_percent 1–200). Usada no CHECK de message_subscriptions.';


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
-- Name: report_cash_projection(uuid[], date, integer[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_cash_projection(p_caixa_ids uuid[], p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_horizons integer[] DEFAULT '{30,60,90}'::integer[]) RETURNS TABLE(caixa_id uuid, financial_account_id uuid, horizon_days integer, until date, balance_today_cents bigint, scheduled_movements_cents bigint, overdue_receivable_cents bigint, overdue_payable_cents bigint, receivable_cents bigint, payable_cents bigint, projected_cents bigint)
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
           (CASE WHEN accs.opening_date > p_today AND accs.opening_date <= hz.until THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id
                           AND m.occurred_on > p_today AND m.occurred_on <= hz.until), 0))::bigint AS future_cents
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
    UNION ALL
    SELECT x.payer_caixa_id, 'payable', x.due_date, (x.items_cents - x.settled_cents)::bigint
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = ANY (p_caixa_ids) AND x.items_cents - x.settled_cents > 0
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
-- Name: FUNCTION report_cash_projection(p_caixa_ids uuid[], p_today date, p_horizons integer[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_cash_projection(p_caixa_ids uuid[], p_today date, p_horizons integer[]) IS 'Fluxo de caixa projetado (spec 014) das caixas general pedidas, por horizonte (padrão 30/60/90 dias a partir de p_today, padrão = hoje em America/Sao_Paulo). Linha da caixa (financial_account_id nulo): balance_today_cents = saldo das contas no fim de hoje; scheduled_movements_cents = movimentos já lançados com data em (hoje, until] (e saldo inicial de conta aberta nesse intervalo); receivable_cents/payable_cents = saldo aberto dos títulos não arquivados com vencimento até until, INCLUSIVE os vencidos (que também saem em overdue_*), e as faturas abertas em que a caixa é pagadora (itens − antecipações); projected_cents = saldo + lançados + a receber − a pagar. Linha da conta: só realizado (títulos não têm conta), previstos = 0. Caixas de cartão não entram. Erro 22023: horizonte fora de 1..1100 ou lista vazia.';


--
-- Name: report_category_totals(uuid[], date, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_category_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text DEFAULT 'competence'::text) RETURNS TABLE(month date, caixa_id uuid, card_caixa_id uuid, kind text, group_category_id uuid, category_id uuid, source text, is_internal boolean, amount_cents bigint, entries integer)
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
-- Name: FUNCTION report_category_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_category_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text) IS 'Despesa/receita por mês, caixa e categoria (spec 014). p_basis: competence (padrão) ou cash. Uma linha por (month, caixa_id, card_caixa_id, kind, group_category_id, category_id, source, is_internal) com amount_cents (positivo = despesa em expense, receita em income; estornos subtraem) e entries. competence: source title (títulos não cancelados pela competência, sem os card_invoice) e card_purchase (compras/encargos/estornos do cartão pela data da compra, caixa_id = pagadora, card_caixa_id = cartão; entram se a pagadora OU o cartão está em p_caixa_ids). cash: source settlement (movimentos de baixa pela data, categoria do título), card_invoice_payment (pagamento da fatura pela pagadora, categoria do título da fatura, card_caixa_id = cartão; não rateado pelas compras) e adjustment (ajustes; sem categoria = category_id nulo, kind pelo sinal). Transferências nunca contam. is_internal: espelho cuja outra caixa também está na lista. Erro 22023: período inválido (até 3660 dias) ou regime desconhecido.';


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
-- Name: report_entity_totals(uuid[], date, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_entity_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text DEFAULT 'competence'::text) RETURNS TABLE(entity_id uuid, caixa_id uuid, card_caixa_id uuid, source text, is_internal boolean, outflow_cents bigint, inflow_cents bigint, entries integer)
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
-- Name: FUNCTION report_entity_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_entity_totals(p_caixa_ids uuid[], p_from date, p_to date, p_basis text) IS 'Pago (outflow_cents) e recebido (inflow_cents) por entidade e caixa no período (spec 014). competence (padrão): títulos não cancelados pela competência, sem os card_invoice (source title), e compras do cartão pela data com o RECEBEDOR FINAL como entidade (source card_purchase; caixa_id = pagadora, card_caixa_id = cartão: rastreio pagadora → cartão → lojista; estorno subtrai). cash: movimentos de baixa pela data (source settlement; estorno subtrai), pagamento de fatura ao emissor (source card_invoice_payment, card_caixa_id = cartão; os lojistas ficam no regime de competência) e ajustes com entidade (source adjustment, pelo sinal). Transferências nunca contam. is_internal como em report_category_totals. Erro 22023: período ou regime inválido.';


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
     OR m.card_invoice_id IS DISTINCT FROM t.card_invoice_id THEN
    RAISE EXCEPTION 'titles: mirror pair % / % must share origin, recurrence occurrence and card invoice', t.id, m.id
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

COMMENT ON COLUMN public.nfe_documents.access_key IS 'Chave de acesso de 44 dígitos, normalizada, com DV válido. Única.';


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
   FROM public.statement_imports;


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

COMMENT ON COLUMN public.audit_log.agent_run_id IS 'app.agent_run_id: execução do agente que fez a alteração (opcional).';


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
    CONSTRAINT titles_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT titles_boleto_barcode_check CHECK (public.is_valid_boleto_barcode(boleto_barcode)),
    CONSTRAINT titles_card_invoice_check CHECK ((((origin = 'card_invoice'::text) = (card_invoice_id IS NOT NULL)) AND ((card_invoice_id IS NULL) OR (counterparty_caixa_id IS NOT NULL)))),
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
    CONSTRAINT message_subscriptions_event_kind_check CHECK ((event_kind = ANY (ARRAY['due_reminder'::text, 'overdue'::text, 'daily_summary'::text, 'weekly_summary'::text, 'invoice_closed'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'agent_completed'::text, 'agent_message'::text]))),
    CONSTRAINT message_subscriptions_params_check CHECK (public.message_subscription_params_valid(event_kind, params))
);


--
-- Name: TABLE message_subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.message_subscriptions IS 'Eventos que um destino recebe (spec 013), um por tipo de evento, com parâmetros validados por message_subscription_params_valid. Filtro opcional por caixas em message_subscription_caixas (sem linhas = todas as caixas que o dono do destino vê).';


--
-- Name: COLUMN message_subscriptions.event_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.message_subscriptions.event_kind IS 'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message.';


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
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['agent_completed'::text, 'agent_message'::text, 'mirror_pending'::text, 'mirror_disputed'::text, 'invoice_closed'::text, 'due_reminder'::text, 'overdue'::text, 'card_limit'::text, 'reconciliation_divergence'::text, 'message_failed'::text, 'system'::text]))),
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

COMMENT ON COLUMN public.notifications.kind IS 'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, reconciliation_divergence, message_failed ou system.';


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
-- Name: financial_accounts financial_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_accounts
    ADD CONSTRAINT financial_accounts_pkey PRIMARY KEY (id);


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
-- Name: financial_accounts_caixa_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX financial_accounts_caixa_id_idx ON public.financial_accounts USING btree (caixa_id);


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
-- Name: titles titles_mirror_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER titles_mirror_check AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin, recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status, card_invoice_id ON public.titles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.titles_mirror_check();


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
-- Name: financial_accounts financial_accounts_caixa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_accounts
    ADD CONSTRAINT financial_accounts_caixa_id_fkey FOREIGN KEY (caixa_id) REFERENCES public.caixas(id);


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
-- PostgreSQL database dump complete
--


