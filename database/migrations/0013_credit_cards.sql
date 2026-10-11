-- migrate:up

-- Cartão de crédito (spec 007). A caixa do cartão (kind = credit_card) guarda:
--   card_invoices       faturas por competência (mês de referência), abertas ou fechadas;
--   card_purchases      compras, estornos e encargos do emissor, com recebedor final e pagadora;
--   card_invoice_items  o que entra em cada fatura: parcelas (n de N) das compras e saldo rolado.
-- No fechamento a aplicação gera, por caixa pagadora, um título card_invoice "a receber"
-- na caixa do cartão espelhado como "a pagar" na pagadora (spec 006). Pagamento parcial:
-- o título é reduzido ao valor pago (ou cancelado) e o restante vira item carryover na
-- fatura seguinte. Pagamento antecipado: título card_invoice já pago numa fatura aberta.

-- Faturas --------------------------------------------------------------------------------
CREATE TABLE card_invoices (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  card_caixa_id   uuid        NOT NULL REFERENCES caixas (id),
  reference_month date        NOT NULL,
  closing_date    date        NOT NULL,
  due_date        date        NOT NULL,
  closed_at       timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_invoices_reference_month_check CHECK (reference_month = date_trunc('month', reference_month)::date),
  CONSTRAINT card_invoices_dates_check CHECK (due_date >= closing_date),
  CONSTRAINT card_invoices_card_month_key UNIQUE (card_caixa_id, reference_month)
);

CREATE INDEX card_invoices_due_date_idx ON card_invoices (due_date);

CREATE TRIGGER card_invoices_set_updated_at BEFORE UPDATE ON card_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE card_invoices IS
  'Fatura de um cartão por competência (spec 007). Aberta (closed_at nulo) recebe itens; fechada fica congelada e '
  'tem, por caixa pagadora, títulos card_invoice cuja soma + o saldo rolado = soma dos itens. '
  'Status (open/closed/paid) e totais: view card_invoice_summaries.';
COMMENT ON COLUMN card_invoices.reference_month IS 'Competência da fatura: 1º dia do mês (ex.: 2026-10-01 = fatura 10/2026). Imutável.';
COMMENT ON COLUMN card_invoices.closing_date IS 'Data de fechamento; só muda enquanto a fatura está aberta.';
COMMENT ON COLUMN card_invoices.due_date IS 'Vencimento (>= fechamento); só muda enquanto a fatura está aberta.';
COMMENT ON COLUMN card_invoices.closed_at IS 'Instante do fechamento. Nulo = aberta. Reabrir (voltar a nulo) só sem pagamento nem saldo rolado.';

-- Compras, estornos e encargos ------------------------------------------------------------------
CREATE TABLE card_purchases (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  card_caixa_id        uuid        NOT NULL REFERENCES caixas (id),
  kind                 text        NOT NULL DEFAULT 'purchase',
  charge_kind          text,
  payer_caixa_id       uuid        NOT NULL REFERENCES caixas (id),
  entity_id            uuid        NOT NULL REFERENCES entities (id),
  category_id          uuid        NOT NULL REFERENCES categories (id),
  purchased_on         date        NOT NULL,
  description          text        NOT NULL,
  amount_cents         bigint      NOT NULL,
  installments_total   smallint    NOT NULL DEFAULT 1,
  first_installment    smallint    NOT NULL DEFAULT 1,
  refunded_purchase_id uuid        REFERENCES card_purchases (id),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_purchases_kind_check CHECK (kind IN ('purchase', 'refund', 'charge')),
  CONSTRAINT card_purchases_charge_kind_check CHECK (charge_kind IN ('interest', 'iof', 'fine', 'fee', 'other')),
  CONSTRAINT card_purchases_kind_links_check CHECK (
    (kind = 'refund') = (refunded_purchase_id IS NOT NULL) AND (kind = 'charge') = (charge_kind IS NOT NULL)
  ),
  CONSTRAINT card_purchases_description_check CHECK (btrim(description) <> ''),
  CONSTRAINT card_purchases_amount_cents_check CHECK (amount_cents > 0),
  CONSTRAINT card_purchases_installments_check CHECK (
    installments_total BETWEEN 1 AND 99 AND first_installment BETWEEN 1 AND installments_total
  ),
  CONSTRAINT card_purchases_refund_self_check CHECK (refunded_purchase_id <> id)
);

CREATE INDEX card_purchases_card_caixa_id_purchased_on_idx ON card_purchases (card_caixa_id, purchased_on);
CREATE INDEX card_purchases_payer_caixa_id_idx ON card_purchases (payer_caixa_id);
CREATE INDEX card_purchases_entity_id_idx ON card_purchases (entity_id);
CREATE INDEX card_purchases_category_id_idx ON card_purchases (category_id);
CREATE INDEX card_purchases_refunded_purchase_id_idx ON card_purchases (refunded_purchase_id);
CREATE INDEX card_purchases_description_trgm_idx ON card_purchases USING gin (description gin_trgm_ops);

CREATE TRIGGER card_purchases_set_updated_at BEFORE UPDATE ON card_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE card_purchases IS
  'Lançamentos da caixa do cartão (spec 007): compra (purchase), estorno (refund, crédito ligado à compra original) '
  'e encargo do emissor (charge: juros, IOF, multa, tarifa). Cada um tem recebedor final, categoria de despesa e '
  'caixa pagadora, e se distribui em itens de fatura (card_invoice_items), um por parcela.';
COMMENT ON COLUMN card_purchases.kind IS 'purchase, refund (estorno de refunded_purchase_id) ou charge (encargo do emissor). Imutável.';
COMMENT ON COLUMN card_purchases.charge_kind IS 'Só em charge: interest (juros), iof, fine (multa), fee (tarifa/anuidade) ou other.';
COMMENT ON COLUMN card_purchases.payer_caixa_id IS
  'Caixa pagadora (general). A aplicação preenche com a pagadora padrão do cartão; pode ser trocada por compra.';
COMMENT ON COLUMN card_purchases.entity_id IS
  'Recebedor final (lojista). Encargo: o emissor (titular da caixa do cartão). Estorno: o mesmo da compra original.';
COMMENT ON COLUMN card_purchases.category_id IS 'Categoria de despesa (expense). Estorno: a mesma da compra original.';
COMMENT ON COLUMN card_purchases.amount_cents IS
  'Valor total (> 0, sempre positivo; o sinal do estorno está nos itens). Com first_installment > 1, é o valor das '
  'parcelas first_installment..N registradas no app.';
COMMENT ON COLUMN card_purchases.installments_total IS 'N: total de parcelas (1 = à vista).';
COMMENT ON COLUMN card_purchases.first_installment IS
  'Primeira parcela registrada no app (1 normalmente; > 1 ao começar a usar o app no meio de um parcelamento).';
COMMENT ON COLUMN card_purchases.refunded_purchase_id IS 'Estorno: a compra (ou encargo) original estornada.';

-- Itens da fatura ---------------------------------------------------------------------------------
CREATE TABLE card_invoice_items (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  card_invoice_id         uuid        NOT NULL REFERENCES card_invoices (id),
  kind                    text        NOT NULL DEFAULT 'installment',
  card_purchase_id        uuid        REFERENCES card_purchases (id) ON DELETE CASCADE,
  installment_number      smallint,
  carried_from_invoice_id uuid        REFERENCES card_invoices (id),
  payer_caixa_id          uuid        NOT NULL REFERENCES caixas (id),
  amount_cents            bigint      NOT NULL,
  description             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_invoice_items_kind_check CHECK (kind IN ('installment', 'carryover')),
  CONSTRAINT card_invoice_items_kind_links_check CHECK (
    CASE kind
      WHEN 'installment' THEN card_purchase_id IS NOT NULL AND installment_number IS NOT NULL
                              AND carried_from_invoice_id IS NULL
      WHEN 'carryover'   THEN carried_from_invoice_id IS NOT NULL AND card_purchase_id IS NULL
                              AND installment_number IS NULL
    END
  ),
  CONSTRAINT card_invoice_items_amount_cents_check CHECK (amount_cents <> 0),
  CONSTRAINT card_invoice_items_installment_number_check CHECK (installment_number BETWEEN 1 AND 99),
  CONSTRAINT card_invoice_items_carried_self_check CHECK (carried_from_invoice_id <> card_invoice_id),
  CONSTRAINT card_invoice_items_purchase_installment_key UNIQUE (card_purchase_id, installment_number),
  CONSTRAINT card_invoice_items_carryover_key UNIQUE (carried_from_invoice_id, payer_caixa_id)
);

CREATE INDEX card_invoice_items_card_invoice_id_payer_idx ON card_invoice_items (card_invoice_id, payer_caixa_id);
CREATE INDEX card_invoice_items_payer_caixa_id_idx ON card_invoice_items (payer_caixa_id);

CREATE TRIGGER card_invoice_items_set_updated_at BEFORE UPDATE ON card_invoice_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE card_invoice_items IS
  'Linhas de uma fatura: installment (parcela n de N de um card_purchases) ou carryover (saldo não pago de uma '
  'fatura anterior, rolado para esta). Só mudam enquanto a fatura está aberta.';
COMMENT ON COLUMN card_invoice_items.amount_cents IS
  'Valor assinado: + aumenta a fatura (parcela de compra/encargo, saldo devedor rolado), − reduz (parcela de estorno, '
  'crédito rolado). Parcelas de uma compra somam o amount_cents dela.';
COMMENT ON COLUMN card_invoice_items.installment_number IS
  'n de N. A parcela n fica na fatura n − first_installment meses depois da primeira, cujo fechamento é >= purchased_on.';
COMMENT ON COLUMN card_invoice_items.carried_from_invoice_id IS
  'carryover: fatura (fechada, anterior, do mesmo cartão) cujo saldo desta pagadora foi rolado. Um por fatura e pagadora.';
COMMENT ON COLUMN card_invoice_items.payer_caixa_id IS 'Caixa pagadora (igual à da compra nas parcelas).';

-- Títulos da fatura ---------------------------------------------------------------------------------
ALTER TABLE titles
  ADD COLUMN card_invoice_id uuid REFERENCES card_invoices (id),
  ADD CONSTRAINT titles_card_invoice_check CHECK (
    (origin = 'card_invoice') = (card_invoice_id IS NOT NULL)
    AND (card_invoice_id IS NULL OR counterparty_caixa_id IS NOT NULL)
  );

CREATE INDEX titles_card_invoice_id_idx ON titles (card_invoice_id);

COMMENT ON COLUMN titles.card_invoice_id IS
  'origin = card_invoice: a fatura. O par espelhado é "a receber" na caixa do cartão e "a pagar" na caixa pagadora '
  '(general); os dois lados apontam para a mesma fatura.';

-- Validações imediatas ------------------------------------------------------------------------------
CREATE FUNCTION card_invoices_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER card_invoices_validate BEFORE INSERT OR UPDATE ON card_invoices
  FOR EACH ROW EXECUTE FUNCTION card_invoices_validate();

CREATE FUNCTION card_purchases_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER card_purchases_validate BEFORE INSERT OR UPDATE ON card_purchases
  FOR EACH ROW EXECUTE FUNCTION card_purchases_validate();

-- Itens só mudam em fatura aberta; carryover vem de fatura fechada anterior do mesmo cartão.
CREATE FUNCTION card_invoice_items_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER card_invoice_items_validate BEFORE INSERT OR UPDATE OR DELETE ON card_invoice_items
  FOR EACH ROW EXECUTE FUNCTION card_invoice_items_validate();

-- Título de fatura: o lado do cartão é "a receber" na caixa do cartão; o outro, "a pagar" numa caixa general.
CREATE FUNCTION titles_validate_card_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER titles_validate_card_invoice
  BEFORE INSERT OR UPDATE OF card_invoice_id, caixa_id, direction, counterparty_caixa_id ON titles
  FOR EACH ROW EXECUTE FUNCTION titles_validate_card_invoice();

-- Espelho: o par também compartilha a fatura (substitui a função de 0008).
CREATE OR REPLACE FUNCTION titles_mirror_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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

DROP TRIGGER titles_mirror_check ON titles;
CREATE CONSTRAINT TRIGGER titles_mirror_check
  AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin,
                            recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status,
                            card_invoice_id
  ON titles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION titles_mirror_check();

-- Checagens no COMMIT -------------------------------------------------------------------------------
-- Compra: parcelas first..N, uma por fatura em meses consecutivos do mesmo cartão, a primeira numa
-- fatura que fecha no dia da compra ou depois; somam o valor, com o sinal do tipo; pagadora da compra.
-- Estorno: mesmo recebedor, categoria e pagadora da original; estornos somados <= valor da original.
CREATE FUNCTION card_purchase_assert(p_purchase_id uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
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

COMMENT ON FUNCTION card_purchase_assert(uuid) IS
  'Erro 23514 (card_purchases_installments_check / _refund_check / _refund_amount_check) se a compra não bate com '
  'os itens de fatura ou com a compra original. Usada pelos triggers deferidos.';

-- Fatura: fechada => por pagadora, títulos card_invoice não cancelados (lado do cartão) + saldo rolado
-- para frente = soma dos itens. Aberta => só títulos já pagos (pagamento antecipado).
CREATE FUNCTION card_invoice_assert(p_invoice_id uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
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

COMMENT ON FUNCTION card_invoice_assert(uuid) IS
  'Erro 23514 (card_invoices_total_check / card_invoices_open_titles_check) se a fatura não fecha com os títulos. '
  'Usada pelos triggers deferidos.';

CREATE FUNCTION card_purchases_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM card_purchase_assert(NEW.id);
  IF NEW.refunded_purchase_id IS NOT NULL THEN
    PERFORM card_purchase_assert(NEW.refunded_purchase_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER card_purchases_integrity_check
  AFTER INSERT OR UPDATE ON card_purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION card_purchases_integrity_check();

CREATE FUNCTION card_invoice_items_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER card_invoice_items_integrity_check
  AFTER INSERT OR UPDATE OR DELETE ON card_invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION card_invoice_items_integrity_check();

CREATE FUNCTION card_invoices_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER card_invoices_integrity_check
  AFTER INSERT OR UPDATE ON card_invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION card_invoices_integrity_check();

CREATE FUNCTION titles_card_invoice_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER titles_card_invoice_integrity_check
  AFTER INSERT OR DELETE OR UPDATE OF card_invoice_id, caixa_id, counterparty_caixa_id, amount_cents, status ON titles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION titles_card_invoice_integrity_check();

-- Visões ---------------------------------------------------------------------------------------------
-- Totais da fatura por pagadora.
CREATE VIEW card_invoice_payer_totals WITH (security_invoker = true) AS
SELECT v.id AS card_invoice_id,
       v.card_caixa_id,
       v.reference_month,
       v.due_date,
       p.payer_caixa_id,
       coalesce(it.items_cents, 0)::bigint AS items_cents,
       coalesce(tt.billed_cents, 0)::bigint AS billed_cents,
       coalesce(tt.settled_cents, 0)::bigint AS settled_cents,
       coalesce(tt.open_cents, 0)::bigint AS open_cents,
       coalesce(co.carried_out_cents, 0)::bigint AS carried_out_cents
  FROM card_invoices v
  JOIN LATERAL (
    SELECT i.payer_caixa_id FROM card_invoice_items i WHERE i.card_invoice_id = v.id
    UNION
    SELECT t.counterparty_caixa_id FROM titles t WHERE t.card_invoice_id = v.id AND t.caixa_id = v.card_caixa_id
  ) p ON true
  LEFT JOIN LATERAL (
    SELECT sum(i.amount_cents) AS items_cents FROM card_invoice_items i
     WHERE i.card_invoice_id = v.id AND i.payer_caixa_id = p.payer_caixa_id
  ) it ON true
  LEFT JOIN LATERAL (
    SELECT sum(b.amount_cents) FILTER (WHERE b.status <> 'canceled') AS billed_cents,
           sum(b.settled_cents) AS settled_cents,
           sum(b.open_cents) AS open_cents
      FROM title_balances b JOIN titles t ON t.id = b.title_id
     WHERE t.card_invoice_id = v.id AND t.caixa_id = v.card_caixa_id AND t.counterparty_caixa_id = p.payer_caixa_id
  ) tt ON true
  LEFT JOIN LATERAL (
    SELECT sum(i.amount_cents) AS carried_out_cents FROM card_invoice_items i
     WHERE i.carried_from_invoice_id = v.id AND i.payer_caixa_id = p.payer_caixa_id
  ) co ON true;

COMMENT ON VIEW card_invoice_payer_totals IS
  'Por fatura e caixa pagadora: soma dos itens, valor faturado em títulos (lado do cartão, não cancelados), principal '
  'pago, saldo aberto e saldo rolado para frente. No fechamento: título = items_cents − settled de antecipações.';

CREATE VIEW card_invoice_summaries WITH (security_invoker = true) AS
SELECT v.id AS card_invoice_id,
       v.card_caixa_id,
       v.reference_month,
       v.closing_date,
       v.due_date,
       v.closed_at,
       coalesce(s.items_cents, 0)::bigint AS total_cents,
       coalesce(s.billed_cents, 0)::bigint AS billed_cents,
       coalesce(s.settled_cents, 0)::bigint AS settled_cents,
       coalesce(s.open_cents, 0)::bigint AS open_cents,
       coalesce(s.carried_out_cents, 0)::bigint AS carried_out_cents,
       CASE WHEN v.closed_at IS NULL THEN 'open'
            WHEN coalesce(s.open_cents, 0) = 0 AND coalesce(s.carried_out_cents, 0) <= 0 THEN 'paid'
            ELSE 'closed' END AS status
  FROM card_invoices v
  LEFT JOIN LATERAL (
    SELECT sum(x.items_cents) AS items_cents, sum(x.billed_cents) AS billed_cents,
           sum(x.settled_cents) AS settled_cents, sum(x.open_cents) AS open_cents,
           sum(x.carried_out_cents) AS carried_out_cents
      FROM card_invoice_payer_totals x WHERE x.card_invoice_id = v.id
  ) s ON true;

COMMENT ON VIEW card_invoice_summaries IS
  'Fatura com totais e status: open (aberta), closed (fechada com saldo aberto ou rolado) ou paid (fechada e quitada).';

-- Linhas da fatura com a compra: rastreio até o recebedor final.
CREATE VIEW card_invoice_lines WITH (security_invoker = true) AS
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
       coalesce(p.description, i.description) AS description,
       i.carried_from_invoice_id
  FROM card_invoice_items i
  JOIN card_invoices v ON v.id = i.card_invoice_id
  LEFT JOIN card_purchases p ON p.id = i.card_purchase_id;

COMMENT ON VIEW card_invoice_lines IS
  'Itens de fatura com a compra de origem (recebedor final, categoria, n de N). A pagadora navega da fatura-título '
  '(titles.card_invoice_id) para cá filtrando por payer_caixa_id.';

-- Limite: usado = itens lançados (exceto saldo rolado, que já está nas compras) − principal pago nas faturas.
CREATE VIEW card_limits WITH (security_invoker = true) AS
SELECT c.id AS card_caixa_id,
       c.credit_limit_cents,
       (coalesce(it.items_cents, 0) - coalesce(st.paid_cents, 0))::bigint AS used_cents,
       (c.credit_limit_cents - coalesce(it.items_cents, 0) + coalesce(st.paid_cents, 0))::bigint AS available_cents
  FROM caixas c
  LEFT JOIN LATERAL (
    SELECT sum(i.amount_cents) AS items_cents
      FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
     WHERE v.card_caixa_id = c.id AND i.kind = 'installment'
  ) it ON true
  LEFT JOIN LATERAL (
    SELECT sum(s.amount_cents) AS paid_cents
      FROM settlements s JOIN titles t ON t.id = s.title_id
     WHERE t.caixa_id = c.id AND t.card_invoice_id IS NOT NULL AND s.reversed_at IS NULL
  ) st ON true
 WHERE c.kind = 'credit_card';

COMMENT ON VIEW card_limits IS
  'Limite do cartão: used_cents = parcelas lançadas em todas as faturas (inclusive futuras, encargos e estornos) − '
  'principal pago nos títulos de fatura (lado do cartão); available_cents = limite − usado (pode ficar negativo).';

-- Anexos de compras -------------------------------------------------------------------------------------
CREATE TABLE card_purchase_attachments (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  card_purchase_id uuid        NOT NULL REFERENCES card_purchases (id) ON DELETE CASCADE,
  attachment_id    uuid        NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_purchase_attachments_key UNIQUE (card_purchase_id, attachment_id)
);
CREATE INDEX card_purchase_attachments_attachment_id_idx ON card_purchase_attachments (attachment_id);
CREATE TRIGGER card_purchase_attachments_set_updated_at BEFORE UPDATE ON card_purchase_attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE card_purchase_attachments IS 'Anexos de uma compra no cartão (nota, comprovante).';

CREATE OR REPLACE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments
UNION ALL
SELECT xml_attachment_id, 'nfe_document', id FROM nfe_documents WHERE xml_attachment_id IS NOT NULL
UNION ALL
SELECT attachment_id, 'card_purchase', card_purchase_id FROM card_purchase_attachments;

-- migrate:down

CREATE OR REPLACE VIEW attachment_links WITH (security_invoker = true) AS
SELECT attachment_id, 'title'::text AS target_kind, title_id AS target_id FROM title_attachments
UNION ALL
SELECT attachment_id, 'settlement', settlement_id FROM settlement_attachments
UNION ALL
SELECT attachment_id, 'movement', movement_id FROM movement_attachments
UNION ALL
SELECT attachment_id, 'entity', entity_id FROM entity_attachments
UNION ALL
SELECT xml_attachment_id, 'nfe_document', id FROM nfe_documents WHERE xml_attachment_id IS NOT NULL;

DROP TABLE card_purchase_attachments;
DROP VIEW card_limits;
DROP VIEW card_invoice_lines;
DROP VIEW card_invoice_summaries;
DROP VIEW card_invoice_payer_totals;

DROP TRIGGER titles_card_invoice_integrity_check ON titles;
DROP FUNCTION titles_card_invoice_integrity_check();
DROP TRIGGER titles_validate_card_invoice ON titles;
DROP FUNCTION titles_validate_card_invoice();

-- Espelho: volta a função e o trigger de 0008.
DROP TRIGGER titles_mirror_check ON titles;
CREATE OR REPLACE FUNCTION titles_mirror_check() RETURNS trigger
LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER titles_mirror_check
  AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin,
                            recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status
  ON titles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION titles_mirror_check();

DROP INDEX titles_card_invoice_id_idx;
ALTER TABLE titles
  DROP CONSTRAINT titles_card_invoice_check,
  DROP COLUMN card_invoice_id;

DROP TABLE card_invoice_items;
DROP TABLE card_purchases;
DROP TABLE card_invoices;
DROP FUNCTION card_invoices_integrity_check();
DROP FUNCTION card_invoice_items_integrity_check();
DROP FUNCTION card_purchases_integrity_check();
DROP FUNCTION card_invoice_assert(uuid);
DROP FUNCTION card_purchase_assert(uuid);
DROP FUNCTION card_invoice_items_validate();
DROP FUNCTION card_purchases_validate();
DROP FUNCTION card_invoices_validate();
