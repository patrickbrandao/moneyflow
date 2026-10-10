-- migrate:up

-- Transferências e movimentos (spec 005) e saldos das contas financeiras.

-- Transferências ------------------------------------------------------------------------------
CREATE TABLE transfers (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  from_account_id uuid        NOT NULL REFERENCES financial_accounts (id),
  to_account_id   uuid        NOT NULL REFERENCES financial_accounts (id),
  amount_cents    bigint      NOT NULL,
  transferred_on  date        NOT NULL,
  description     text,
  settlement_id   uuid        REFERENCES settlements (id),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_accounts_check CHECK (from_account_id <> to_account_id),
  CONSTRAINT transfers_amount_cents_check CHECK (amount_cents > 0),
  CONSTRAINT transfers_settlement_id_key UNIQUE (settlement_id)
);

CREATE INDEX transfers_from_account_id_idx ON transfers (from_account_id);
CREATE INDEX transfers_to_account_id_idx ON transfers (to_account_id);

CREATE TRIGGER transfers_set_updated_at BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE transfers IS
  'Transferência entre contas (inclusive de caixas diferentes): exatamente dois movimentos ligados que somam zero. '
  'Não conta como receita nem despesa.';
COMMENT ON COLUMN transfers.settlement_id IS
  'Baixa que originou a transferência ("pagar título da caixa B com conta da caixa A"): a perna na conta da baixa '
  '(destino se o título é payable, origem se receivable) e o valor = valor em dinheiro da baixa.';

-- Movimentos ------------------------------------------------------------------------------------
CREATE TABLE movements (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  financial_account_id uuid        NOT NULL REFERENCES financial_accounts (id),
  occurred_on          date        NOT NULL,
  amount_cents         bigint      NOT NULL,
  kind                 text        NOT NULL,
  settlement_id        uuid        REFERENCES settlements (id),
  transfer_id          uuid        REFERENCES transfers (id) ON DELETE CASCADE,
  description          text,
  entity_id            uuid        REFERENCES entities (id),
  category_id          uuid        REFERENCES categories (id),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movements_amount_cents_check CHECK (amount_cents <> 0),
  CONSTRAINT movements_kind_check CHECK (kind IN ('settlement', 'transfer', 'adjustment')),
  CONSTRAINT movements_kind_links_check CHECK (
    CASE kind
      WHEN 'settlement' THEN settlement_id IS NOT NULL AND transfer_id IS NULL AND category_id IS NULL
      WHEN 'transfer'   THEN transfer_id IS NOT NULL AND settlement_id IS NULL AND category_id IS NULL
      WHEN 'adjustment' THEN settlement_id IS NULL AND transfer_id IS NULL
    END
  )
);

CREATE INDEX movements_financial_account_id_occurred_on_idx ON movements (financial_account_id, occurred_on);
CREATE INDEX movements_settlement_id_idx ON movements (settlement_id);
CREATE INDEX movements_transfer_id_idx ON movements (transfer_id);
CREATE INDEX movements_entity_id_idx ON movements (entity_id);
CREATE INDEX movements_category_id_idx ON movements (category_id);

CREATE TRIGGER movements_set_updated_at BEFORE UPDATE ON movements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE movements IS
  'Entradas (+) e saídas (−) numa conta financeira: de baixa, de transferência ou ajuste/avulso. '
  'Saldo da conta = opening_balance_cents + soma dos movimentos.';
COMMENT ON COLUMN movements.amount_cents IS 'Valor assinado em centavos: positivo entra, negativo sai (≠ 0).';
COMMENT ON COLUMN movements.kind IS
  'settlement (ligado a settlement_id), transfer (ligado a transfer_id) ou adjustment (ajuste de contagem, rendimento, tarifa avulsa…).';
COMMENT ON COLUMN movements.category_id IS
  'Só em adjustment (opcional): categoria income se entra, expense se sai. Baixas usam a categoria do título.';

-- Regras imediatas do movimento.
CREATE FUNCTION movements_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER movements_validate BEFORE INSERT OR UPDATE ON movements
  FOR EACH ROW EXECUTE FUNCTION movements_validate();

-- A conta não pode mudar de caixa com histórico, nem a abertura passar de um movimento.
CREATE FUNCTION financial_accounts_validate_history() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER financial_accounts_validate_history BEFORE UPDATE OF caixa_id, opening_date ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_accounts_validate_history();

-- Movimentos de uma baixa ----------------------------------------------------------------------
-- Baixa com conta e valor em dinheiro ≠ 0: um movimento na conta da baixa, na data
-- da baixa, com valor = ±(principal + juros + multa − desconto) (payable sai,
-- receivable entra). Baixa estornada: mais um movimento de mesmo valor e sinal
-- oposto (data >= da baixa). Sem conta ou valor em dinheiro 0: nenhum movimento.
CREATE FUNCTION settlement_assert_movements(p_settlement_id uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
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

COMMENT ON FUNCTION settlement_assert_movements(uuid) IS
  'Erro 23514 (movements_settlement_check) se os movimentos da baixa não batem com ela. Usada pelos triggers deferidos.';

-- Movimentos de uma transferência ----------------------------------------------------------------
CREATE FUNCTION transfer_assert_movements(p_transfer_id uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
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

COMMENT ON FUNCTION transfer_assert_movements(uuid) IS
  'Erro 23514 (movements_transfer_check / transfers_settlement_check) se a transferência não tem exatamente '
  'os dois movimentos que somam zero ou não bate com a baixa que a originou. Usada pelos triggers deferidos.';

-- Triggers deferidos (checados no COMMIT) -----------------------------------------------------
CREATE FUNCTION movements_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER movements_integrity_check
  AFTER INSERT OR UPDATE OR DELETE ON movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION movements_integrity_check();

CREATE FUNCTION settlements_movements_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM settlement_assert_movements(NEW.id);
  PERFORM transfer_assert_movements(tr.id) FROM transfers tr WHERE tr.settlement_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER settlements_movements_check
  AFTER INSERT OR UPDATE OF financial_account_id, reversed_at ON settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION settlements_movements_check();

CREATE FUNCTION transfers_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM transfer_assert_movements(NEW.id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER transfers_integrity_check
  AFTER INSERT OR UPDATE ON transfers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transfers_integrity_check();

-- Saldos ---------------------------------------------------------------------------------------
CREATE VIEW financial_account_balances WITH (security_invoker = true) AS
SELECT a.id AS financial_account_id,
       a.caixa_id,
       a.opening_date,
       a.opening_balance_cents,
       coalesce(m.movements_cents, 0)::bigint AS movements_cents,
       (a.opening_balance_cents + coalesce(m.movements_cents, 0))::bigint AS balance_cents,
       a.archived_at
  FROM financial_accounts a
  LEFT JOIN LATERAL (
    SELECT sum(x.amount_cents) AS movements_cents
      FROM movements x
     WHERE x.financial_account_id = a.id
  ) m ON true;

COMMENT ON VIEW financial_account_balances IS
  'Saldo de cada conta: opening_balance_cents + soma de todos os movimentos (inclusive datados no futuro). '
  'Saldo numa data: financial_account_balance_at(conta, data).';

CREATE FUNCTION financial_account_balance_at(p_account_id uuid, p_on date) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_on < a.opening_date THEN NULL
              ELSE a.opening_balance_cents
                   + coalesce((SELECT sum(m.amount_cents)
                                 FROM movements m
                                WHERE m.financial_account_id = a.id AND m.occurred_on <= p_on), 0)
         END::bigint
    FROM financial_accounts a
   WHERE a.id = p_account_id
$$;

COMMENT ON FUNCTION financial_account_balance_at(uuid, date) IS
  'Saldo da conta ao fim do dia p_on (saldo inicial + movimentos até a data). NULL antes da abertura ou se a conta não existe.';

-- migrate:down

DROP FUNCTION financial_account_balance_at(uuid, date);
DROP VIEW financial_account_balances;
DROP TABLE movements;
DROP TABLE transfers;
DROP TRIGGER settlements_movements_check ON settlements;
DROP FUNCTION settlements_movements_check();
DROP FUNCTION transfers_integrity_check();
DROP FUNCTION movements_integrity_check();
DROP FUNCTION transfer_assert_movements(uuid);
DROP FUNCTION settlement_assert_movements(uuid);
DROP TRIGGER financial_accounts_validate_history ON financial_accounts;
DROP FUNCTION financial_accounts_validate_history();
DROP FUNCTION movements_validate();
