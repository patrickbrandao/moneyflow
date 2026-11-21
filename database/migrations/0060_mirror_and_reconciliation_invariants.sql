-- migrate:up

-- Tarefa 148: regras do espelho e da conciliação que a docs/016 atribui ao banco e que só a aplicação garantia.
--   1. titles_mirror_check confere também o sentido inverso (o título está na caixa da contraparte do espelho, e o
--      titular dela é a entidade do espelho): trocar a caixa de um lado só passava.
--   2. caixas_validate recusa trocar o titular da caixa com títulos (dela ou que a têm como contraparte), contratos
--      (dela ou que a têm como caixa da contraparte) ou encargos do emissor no cartão (caixas_holder_locked_check).
--   3. Baixa ativa num título espelhado exige a perna do espelho (settlements_mirror_required_check, no COMMIT), na baixa
--      e ao ligar o par.
--   4. Item de fatura conciliado com uma linha não muda de valor nem de fatura (statement_lines_card_item_check), como o
--      movimento conciliado.

-- 1 e 3 (ao ligar o par) ------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.titles_mirror_check() RETURNS trigger
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

  -- O sentido inverso (tarefa 148): trocar a caixa de um lado só dispara o trigger deste lado.
  IF t.caixa_id IS DISTINCT FROM m.counterparty_caixa_id THEN
    RAISE EXCEPTION 'titles: title % is not in counterparty caixa % of its mirror %', t.id, m.counterparty_caixa_id, m.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_mirror_caixa_check';
  END IF;

  SELECT c.holder_entity_id INTO holder FROM caixas c WHERE c.id = t.caixa_id;
  IF holder IS DISTINCT FROM m.entity_id THEN
    RAISE EXCEPTION 'titles: caixa % is not held by entity % of mirror %', t.caixa_id, m.entity_id, m.id
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

  -- Baixa ativa num par espelhado tem a perna do espelho (tarefa 148): ligar depois dois títulos com baixas soltas não
  -- passa. As pernas ligadas já têm a mesma data e os mesmos valores (settlements_mirror_check).
  IF EXISTS (SELECT 1 FROM settlements x
              WHERE x.title_id IN (t.id, m.id) AND x.reversed_at IS NULL AND x.mirror_settlement_id IS NULL) THEN
    RAISE EXCEPTION 'titles: mirrored pair % / % has an active settlement without the mirror leg', t.id, m.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_required_check';
  END IF;

  RETURN NULL;
END
$$;


-- 2 -----------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caixas_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'caixas: kind cannot change (caixa %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'caixas_kind_immutable_check';
  END IF;

  -- O titular define os espelhos, os contratos e o recebedor dos encargos do cartão (tarefa 148): com algum deles
  -- ligado à caixa, não muda.
  IF TG_OP = 'UPDATE' AND NEW.holder_entity_id IS DISTINCT FROM OLD.holder_entity_id
     AND (EXISTS (SELECT 1 FROM titles t WHERE t.caixa_id = OLD.id)
          OR EXISTS (SELECT 1 FROM titles t WHERE t.counterparty_caixa_id = OLD.id)
          OR EXISTS (SELECT 1 FROM contracts k WHERE k.caixa_id = OLD.id)
          OR EXISTS (SELECT 1 FROM contracts k WHERE k.counterparty_caixa_id = OLD.id)
          OR EXISTS (SELECT 1 FROM card_purchases p WHERE p.card_caixa_id = OLD.id AND p.kind = 'charge')) THEN
    RAISE EXCEPTION 'caixas: holder of caixa % cannot change while titles, contracts or issuer charges depend on it', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'caixas_holder_locked_check';
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


-- 3 (na baixa) ------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION settlements_mirror_required_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s settlements;
BEGIN
  SELECT * INTO s FROM settlements WHERE id = NEW.id;
  IF FOUND AND s.reversed_at IS NULL AND s.mirror_settlement_id IS NULL
     AND EXISTS (SELECT 1 FROM titles t WHERE t.id = s.title_id AND t.mirror_title_id IS NOT NULL) THEN
    RAISE EXCEPTION 'settlements: settlement % of a mirrored title needs the mirror leg', s.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_required_check';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION settlements_mirror_required_check() IS
  'Constraint trigger de settlements (no COMMIT): baixa ativa em título espelhado tem mirror_settlement_id, a perna no '
  'outro lado do par (spec 006; tarefa 148). O lado do título (ligar o par depois) é conferido em titles_mirror_check.';

CREATE CONSTRAINT TRIGGER settlements_mirror_required_check AFTER INSERT OR UPDATE OF mirror_settlement_id ON settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION settlements_mirror_required_check();

-- 4 -----------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION card_invoice_items_validate_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_lines l
              WHERE l.card_invoice_item_id = OLD.id AND l.status = 'matched'
                AND (l.amount_cents <> -NEW.amount_cents OR NEW.card_invoice_id <> OLD.card_invoice_id)) THEN
    RAISE EXCEPTION 'card_invoice_items: item % is reconciled with a statement line', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_card_item_check';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION card_invoice_items_validate_statement() IS
  'Trigger de card_invoice_items: o item conciliado com uma linha de extrato (matched) não muda de valor nem de fatura '
  '(23514 statement_lines_card_item_check), como movements_validate_statement (tarefa 148).';

CREATE TRIGGER card_invoice_items_validate_statement BEFORE UPDATE OF amount_cents, card_invoice_id ON card_invoice_items
  FOR EACH ROW EXECUTE FUNCTION card_invoice_items_validate_statement();

-- Dados que já existiam: as regras valem daqui em diante; o que já as viola aparece aqui (e falha quando a linha mudar).
DO $do$
DECLARE
  n_pairs int;
  n_legs  int;
  n_items int;
BEGIN
  SELECT count(*) INTO n_pairs FROM titles t JOIN titles m ON m.id = t.mirror_title_id
    LEFT JOIN caixas c ON c.id = t.caixa_id
   WHERE m.counterparty_caixa_id IS DISTINCT FROM t.caixa_id OR c.holder_entity_id IS DISTINCT FROM m.entity_id;
  SELECT count(*) INTO n_legs FROM settlements s JOIN titles t ON t.id = s.title_id
   WHERE t.mirror_title_id IS NOT NULL AND s.reversed_at IS NULL AND s.mirror_settlement_id IS NULL;
  SELECT count(*) INTO n_items FROM statement_lines l JOIN card_invoice_items i ON i.id = l.card_invoice_item_id
   WHERE l.status = 'matched' AND l.amount_cents <> -i.amount_cents;
  IF n_pairs + n_legs + n_items > 0 THEN
    RAISE WARNING 'tarefa 148: dados que já violam as regras novas: % lado(s) de espelho, % baixa(s) sem perna, % item(ns) conciliado(s) com valor diferente',
      n_pairs, n_legs, n_items;
  END IF;
END
$do$;

-- migrate:down

DROP TRIGGER card_invoice_items_validate_statement ON card_invoice_items;
DROP FUNCTION card_invoice_items_validate_statement();
DROP TRIGGER settlements_mirror_required_check ON settlements;
DROP FUNCTION settlements_mirror_required_check();

CREATE OR REPLACE FUNCTION public.caixas_validate() RETURNS trigger
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


CREATE OR REPLACE FUNCTION public.titles_mirror_check() RETURNS trigger
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

