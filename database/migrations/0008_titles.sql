-- migrate:up

-- Títulos a pagar e a receber (spec 005) com espelhamento entre caixas (spec 006).
CREATE TABLE titles (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  caixa_id              uuid        NOT NULL REFERENCES caixas (id),
  direction             text        NOT NULL,
  entity_id             uuid        NOT NULL REFERENCES entities (id),
  category_id           uuid        NOT NULL REFERENCES categories (id),
  description           text        NOT NULL,
  competence_date       date        NOT NULL,
  due_date              date        NOT NULL,
  amount_cents          bigint      NOT NULL,
  status                text        NOT NULL DEFAULT 'open',
  origin                text        NOT NULL DEFAULT 'manual',
  recurrence_rule_id    uuid        REFERENCES recurrence_rules (id),
  occurrence            smallint,
  counterparty_caixa_id uuid        REFERENCES caixas (id),
  mirror_title_id       uuid        REFERENCES titles (id) DEFERRABLE INITIALLY DEFERRED,
  mirror_status         text,
  notes                 text,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT titles_direction_check CHECK (direction IN ('payable', 'receivable')),
  CONSTRAINT titles_description_check CHECK (btrim(description) <> ''),
  CONSTRAINT titles_amount_cents_check CHECK (amount_cents > 0),
  CONSTRAINT titles_status_check CHECK (status IN ('open', 'partial', 'paid', 'canceled')),
  CONSTRAINT titles_origin_check CHECK (origin IN ('manual', 'recurrence', 'card_invoice')),
  CONSTRAINT titles_occurrence_check CHECK (occurrence >= 1),
  CONSTRAINT titles_recurrence_check CHECK (
    (recurrence_rule_id IS NULL) = (occurrence IS NULL)
    AND (origin = 'recurrence') = (recurrence_rule_id IS NOT NULL)
  ),
  CONSTRAINT titles_mirror_status_check CHECK (mirror_status IN ('pending', 'accepted', 'disputed')),
  CONSTRAINT titles_mirror_fields_check CHECK (
    (counterparty_caixa_id IS NULL) = (mirror_title_id IS NULL)
    AND (mirror_status IS NULL OR mirror_title_id IS NOT NULL)
  ),
  CONSTRAINT titles_mirror_self_check CHECK (mirror_title_id <> id),
  CONSTRAINT titles_counterparty_caixa_check CHECK (counterparty_caixa_id <> caixa_id)
);

-- Calendário e listas por caixa: vencimento, status e competência.
CREATE INDEX titles_caixa_id_due_date_idx ON titles (caixa_id, due_date);
CREATE INDEX titles_caixa_id_status_due_date_idx ON titles (caixa_id, status, due_date);
CREATE INDEX titles_caixa_id_competence_date_idx ON titles (caixa_id, competence_date);
CREATE INDEX titles_due_date_idx ON titles (due_date) WHERE status IN ('open', 'partial');
CREATE INDEX titles_entity_id_idx ON titles (entity_id);
CREATE INDEX titles_category_id_idx ON titles (category_id);
CREATE INDEX titles_counterparty_caixa_id_idx ON titles (counterparty_caixa_id);
CREATE UNIQUE INDEX titles_mirror_title_id_key ON titles (mirror_title_id);
-- Uma ocorrência por série em cada caixa (o espelho de uma ocorrência repete regra e número na outra caixa).
CREATE UNIQUE INDEX titles_recurrence_occurrence_key ON titles (recurrence_rule_id, caixa_id, occurrence);

CREATE TRIGGER titles_set_updated_at BEFORE UPDATE ON titles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Regras imediatas por linha.
CREATE FUNCTION titles_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER titles_validate BEFORE INSERT OR UPDATE ON titles
  FOR EACH ROW EXECUTE FUNCTION titles_validate();

-- Reduzir o total de parcelas não pode deixar ocorrência acima de N.
CREATE FUNCTION recurrence_rules_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER recurrence_rules_validate BEFORE UPDATE OF installments_total ON recurrence_rules
  FOR EACH ROW EXECUTE FUNCTION recurrence_rules_validate();

-- Espelho (checado no COMMIT, para o par poder nascer na mesma transação):
-- ligação recíproca, direção oposta, mesmo valor e vencimento, cada título na
-- caixa cujo titular é a contraparte do outro, exatamente um lado é o espelho
-- (mirror_status preenchido), e mesma origem/série.
CREATE FUNCTION titles_mirror_check() RETURNS trigger
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

COMMENT ON TABLE titles IS
  'Títulos a pagar/receber de uma caixa (spec 005), liquidados por baixas; espelhados na caixa da contraparte (spec 006).';
COMMENT ON COLUMN titles.direction IS 'payable (a pagar, categoria expense) ou receivable (a receber, categoria income). Imutável.';
COMMENT ON COLUMN titles.entity_id IS 'Contraparte: a quem pagamos (payable) ou de quem recebemos (receivable).';
COMMENT ON COLUMN titles.status IS
  'open | partial | paid: derivado da soma das baixas ativas (mantido por trigger); canceled: definido pela aplicação, só sem baixas ativas.';
COMMENT ON COLUMN titles.origin IS
  'manual, recurrence (gerado por recurrence_rules) ou card_invoice (fatura de cartão, F2). O espelho herda a origem do original.';
COMMENT ON COLUMN titles.occurrence IS 'Número da ocorrência/parcela n na série (N = recurrence_rules.installments_total).';
COMMENT ON COLUMN titles.counterparty_caixa_id IS 'Caixa do outro lado do espelho (titular = entity_id). Nulo = sem espelho.';
COMMENT ON COLUMN titles.mirror_title_id IS 'Título espelho (ligação 1:1 recíproca, checada no COMMIT).';
COMMENT ON COLUMN titles.mirror_status IS
  'Só no lado espelho (o criado na caixa da contraparte): pending (aguarda aceite), accepted ou disputed. Nulo no original.';

-- migrate:down

DROP TABLE titles;
DROP FUNCTION titles_mirror_check();
DROP TRIGGER recurrence_rules_validate ON recurrence_rules;
DROP FUNCTION recurrence_rules_validate();
DROP FUNCTION titles_validate();
