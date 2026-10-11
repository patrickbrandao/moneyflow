-- migrate:up

-- Fechamento de mês por caixa (spec 008). Uma linha = o mês está fechado naquela
-- caixa; reabrir = apagar a linha, só por admin ativo (app.user_id da transação).
-- Mês fechado congela o que os relatórios daquele mês usam:
--   títulos      pela competência (competence_date), na caixa do título;
--   baixas       pela data da baixa (settled_on), na caixa do título;
--   movimentos   pela data (occurred_on), na caixa da conta;
--   compras      pela data da compra (purchased_on), na caixa do cartão E na pagadora;
--   contas       saldo/data de abertura, se houver mês fechado a partir da abertura.
-- O que continua livre: o status derivado das baixas, vencimento, descrição, notas,
-- arquivamento, aceite do espelho e o estorno de uma baixa (o movimento do estorno
-- sai na data do estorno, que precisa estar aberta).

CREATE TABLE period_closings (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  caixa_id          uuid        NOT NULL REFERENCES caixas (id),
  month             date        NOT NULL,
  closed_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_closings_month_check CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT period_closings_caixa_month_key UNIQUE (caixa_id, month)
);

CREATE INDEX period_closings_closed_by_user_id_idx ON period_closings (closed_by_user_id);

CREATE TRIGGER period_closings_set_updated_at BEFORE UPDATE ON period_closings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE period_closings IS
  'Meses fechados por caixa (spec 008). Bloqueia títulos (competência), baixas, movimentos e compras do mês; '
  'reabrir é apagar a linha, só por admin ativo (app.user_id).';
COMMENT ON COLUMN period_closings.month IS '1º dia do mês fechado.';
COMMENT ON COLUMN period_closings.closed_by_user_id IS 'Quem fechou.';

CREATE FUNCTION period_is_closed(p_caixa_id uuid, p_on date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM period_closings pc
                  WHERE pc.caixa_id = p_caixa_id AND pc.month = date_trunc('month', p_on)::date)
$$;

COMMENT ON FUNCTION period_is_closed(uuid, date) IS 'true se o mês da data está fechado na caixa.';

CREATE FUNCTION period_assert_open(p_caixa_id uuid, p_on date, p_what text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_caixa_id IS NOT NULL AND p_on IS NOT NULL AND period_is_closed(p_caixa_id, p_on) THEN
    RAISE EXCEPTION '%: month % is closed in caixa %', p_what, to_char(p_on, 'YYYY-MM'), p_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_closings_locked_check';
  END IF;
END
$$;

COMMENT ON FUNCTION period_assert_open(uuid, date, text) IS
  'Erro 23514 (period_closings_locked_check) se o mês da data está fechado na caixa.';

-- Fechamento: caixa e mês imutáveis; reabrir só admin.
CREATE FUNCTION period_closings_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;

CREATE TRIGGER period_closings_validate BEFORE UPDATE OR DELETE ON period_closings
  FOR EACH ROW EXECUTE FUNCTION period_closings_validate();

-- Títulos ----------------------------------------------------------------------------------------
CREATE FUNCTION titles_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER titles_period_lock BEFORE INSERT OR UPDATE OR DELETE ON titles
  FOR EACH ROW EXECUTE FUNCTION titles_period_lock();

-- Baixas (título, data e valores já são imutáveis; o estorno continua permitido) -----------------
CREATE FUNCTION settlements_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s settlements := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  PERFORM period_assert_open(t.caixa_id, s.settled_on, 'settlements') FROM titles t WHERE t.id = s.title_id;
  RETURN s;
END
$$;

CREATE TRIGGER settlements_period_lock BEFORE INSERT OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlements_period_lock();

-- Movimentos ---------------------------------------------------------------------------------------
CREATE FUNCTION movements_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER movements_period_lock BEFORE INSERT OR UPDATE OR DELETE ON movements
  FOR EACH ROW EXECUTE FUNCTION movements_period_lock();

-- Compras no cartão: mês fechado no cartão ou na pagadora --------------------------------------------
CREATE FUNCTION card_purchases_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER card_purchases_period_lock BEFORE INSERT OR UPDATE OR DELETE ON card_purchases
  FOR EACH ROW EXECUTE FUNCTION card_purchases_period_lock();

-- Abertura da conta: não muda se houver mês fechado na caixa a partir dela ----------------------------
CREATE FUNCTION financial_accounts_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER financial_accounts_period_lock
  BEFORE UPDATE OF opening_balance_cents, opening_date ON financial_accounts
  FOR EACH ROW
  WHEN (NEW.opening_balance_cents IS DISTINCT FROM OLD.opening_balance_cents
        OR NEW.opening_date IS DISTINCT FROM OLD.opening_date)
  EXECUTE FUNCTION financial_accounts_period_lock();

-- Auditoria do próprio fechamento.
CREATE TRIGGER period_closings_audit AFTER INSERT OR UPDATE OR DELETE ON period_closings
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- migrate:down

DROP TRIGGER financial_accounts_period_lock ON financial_accounts;
DROP TRIGGER card_purchases_period_lock ON card_purchases;
DROP TRIGGER movements_period_lock ON movements;
DROP TRIGGER settlements_period_lock ON settlements;
DROP TRIGGER titles_period_lock ON titles;
DROP TABLE period_closings;
DROP FUNCTION financial_accounts_period_lock();
DROP FUNCTION card_purchases_period_lock();
DROP FUNCTION movements_period_lock();
DROP FUNCTION settlements_period_lock();
DROP FUNCTION titles_period_lock();
DROP FUNCTION period_closings_validate();
DROP FUNCTION period_assert_open(uuid, date, text);
DROP FUNCTION period_is_closed(uuid, date);
