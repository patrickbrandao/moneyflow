-- migrate:up

-- Baixas (spec 005): liquidam um título, total ou parcialmente. O estorno é uma
-- operação própria (reversed_at); baixa estornada não conta no saldo do título.
-- No espelho (spec 006) a baixa única tem duas pernas ligadas (mirror_settlement_id).
CREATE TABLE settlements (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  title_id             uuid        NOT NULL REFERENCES titles (id),
  settled_on           date        NOT NULL,
  amount_cents         bigint      NOT NULL,
  interest_cents       bigint      NOT NULL DEFAULT 0,
  fine_cents           bigint      NOT NULL DEFAULT 0,
  discount_cents       bigint      NOT NULL DEFAULT 0,
  financial_account_id uuid        REFERENCES financial_accounts (id),
  mirror_settlement_id uuid        REFERENCES settlements (id) DEFERRABLE INITIALLY DEFERRED,
  notes                text,
  reversed_at          timestamptz,
  reversal_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_amount_cents_check CHECK (amount_cents > 0),
  CONSTRAINT settlements_charges_check CHECK (interest_cents >= 0 AND fine_cents >= 0 AND discount_cents >= 0),
  CONSTRAINT settlements_discount_check CHECK (discount_cents <= amount_cents + interest_cents + fine_cents),
  CONSTRAINT settlements_reversal_check CHECK (
    (reversed_at IS NULL) = (reversal_reason IS NULL) AND btrim(reversal_reason) <> ''
  ),
  CONSTRAINT settlements_mirror_self_check CHECK (mirror_settlement_id <> id)
);

CREATE INDEX settlements_title_id_idx ON settlements (title_id);
CREATE INDEX settlements_financial_account_id_idx ON settlements (financial_account_id);
CREATE INDEX settlements_settled_on_idx ON settlements (settled_on);
CREATE UNIQUE INDEX settlements_mirror_settlement_id_key ON settlements (mirror_settlement_id);

CREATE TRIGGER settlements_set_updated_at BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE settlements IS
  'Baixas de títulos (spec 005). Valor em dinheiro = principal + juros + multa − desconto. Estorno por reversed_at.';
COMMENT ON COLUMN settlements.amount_cents IS 'Principal abatido do título (> 0). A soma das baixas ativas nunca passa do valor do título.';
COMMENT ON COLUMN settlements.financial_account_id IS
  'Conta (da caixa do título) onde o dinheiro entrou/saiu. Nulo = "baixado, conta a definir" (lado sem acesso do espelho); '
  'pode ser preenchido depois, uma única vez.';
COMMENT ON COLUMN settlements.mirror_settlement_id IS
  'Outra perna da baixa única de um par espelhado (ligação recíproca, mesmos valores e data; checada no COMMIT).';
COMMENT ON COLUMN settlements.reversed_at IS 'Estorno: a baixa deixa de contar. Irreversível; exige reversal_reason.';

-- Principal das baixas ativas de um título.
CREATE FUNCTION title_settled_cents(p_title_id uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(s.amount_cents), 0)::bigint
    FROM settlements s
   WHERE s.title_id = p_title_id AND s.reversed_at IS NULL
$$;

COMMENT ON FUNCTION title_settled_cents(uuid) IS 'Soma do principal das baixas ativas (não estornadas) do título.';

-- Status do título coerente com as baixas -----------------------------------------------
CREATE FUNCTION titles_validate_status() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER titles_validate_status BEFORE INSERT OR UPDATE OF caixa_id, amount_cents, status ON titles
  FOR EACH ROW EXECUTE FUNCTION titles_validate_status();

-- Validação da baixa ------------------------------------------------------------------------
CREATE FUNCTION settlements_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER settlements_validate BEFORE INSERT OR UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlements_validate();

-- Mantém titles.status após criar, estornar ou excluir uma baixa.
CREATE FUNCTION settlements_refresh_title_status() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER settlements_refresh_title_status
  AFTER INSERT OR DELETE OR UPDATE OF reversed_at ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlements_refresh_title_status();

-- Pernas da baixa do espelho (checado no COMMIT): ligação recíproca, cada perna
-- num título do par, mesmos data e valores, estornadas juntas.
CREATE FUNCTION settlements_mirror_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER settlements_mirror_check
  AFTER INSERT OR UPDATE OF mirror_settlement_id, reversed_at ON settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION settlements_mirror_check();

-- Saldo aberto dos títulos --------------------------------------------------------------------
CREATE VIEW title_balances WITH (security_invoker = true) AS
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
       coalesce(s.settled_cents, 0)::bigint AS settled_cents,
       CASE WHEN t.status = 'canceled' THEN 0
            ELSE t.amount_cents - coalesce(s.settled_cents, 0) END::bigint AS open_cents,
       t.archived_at
  FROM titles t
  LEFT JOIN LATERAL (
    SELECT sum(x.amount_cents) AS settled_cents
      FROM settlements x
     WHERE x.title_id = t.id AND x.reversed_at IS NULL
  ) s ON true;

COMMENT ON VIEW title_balances IS
  'Títulos com principal baixado (baixas ativas) e saldo aberto (amount − baixado; 0 se cancelado). '
  'Títulos em aberto: open_cents > 0.';

-- migrate:down

DROP VIEW title_balances;
DROP TABLE settlements;
DROP FUNCTION settlements_mirror_check();
DROP FUNCTION settlements_refresh_title_status();
DROP FUNCTION settlements_validate();
DROP TRIGGER titles_validate_status ON titles;
DROP FUNCTION titles_validate_status();
DROP FUNCTION title_settled_cents(uuid);
