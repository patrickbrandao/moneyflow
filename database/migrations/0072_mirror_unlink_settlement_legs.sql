-- migrate:up

-- Tarefa 148 (complemento): as pernas da baixa de um par espelhado ficam nos dois títulos do par
-- (settlements_mirror_title_check), mas a conferência só rodava quando a baixa mudava. Desligar o par (ou trocar o
-- espelho de um dos lados) com baixas ligadas deixava as pernas apontando uma para a outra fora de um par. Agora
-- titles_mirror_check, que roda no COMMIT quando o espelho de um título muda, confere também as pernas das baixas dele:
-- para desligar o par, solte as pernas na mesma transação.

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

  -- As pernas das baixas acompanham o par (tarefa 148): a perna ligada a uma baixa deste título fica no espelho dele.
  IF EXISTS (SELECT 1 FROM settlements s JOIN settlements o ON o.id = s.mirror_settlement_id
              WHERE s.title_id = t.id AND o.title_id IS DISTINCT FROM t.mirror_title_id) THEN
    RAISE EXCEPTION 'titles: settlement legs of title % are not on a mirrored title pair', t.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlements_mirror_title_check';
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

-- migrate:down

-- A versão da 0060.
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
