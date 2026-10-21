-- migrate:up

-- Contratos sobre séries recorrentes (spec 034, F20). O contrato deixa de gerar parcelas próprias: passa a ter
-- vigência e obrigações, que são séries recorrentes comuns (recurrence_rules.contract_id), cada uma na caixa da
-- conta onde o dinheiro se move (títulos com a conta prevista, que aceita cofre) ou no cartão (cobrança esperada,
-- card_recurring_charges, sem títulos: a compra ligada à ocorrência é o fato). Os ajustes de reconhecimento do
-- pagamento (janela, multa, juros, desconto, tolerância, baixar sem confirmação) saem do contrato e vão para a
-- série. A migração converte os contratos existentes sem perder baixa, conciliação, auditoria nem documento.
--
-- Ordem: estrutura nova; dados (com os triggers novos já ativos, para validar o que foi migrado); SET CONSTRAINTS
-- ALL IMMEDIATE (dispara as checagens adiadas e libera as tabelas para ALTER); por fim, o que sai.

-- 1. Calendário de uma série no banco (o mesmo de occurrenceDueDate do shared) --------------------------------------
CREATE FUNCTION recurrence_occurrence_due(p_frequency text, p_interval_count integer, p_anchor_day integer,
                                          p_starts_on date, p_occurrence integer) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  m date;
BEGIN
  IF p_occurrence IS NULL OR p_occurrence < 1 OR p_starts_on IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_frequency = 'weekly' THEN
    RETURN p_starts_on + ((p_anchor_day - extract(isodow FROM p_starts_on)::int + 7) % 7)
                       + (p_occurrence - 1) * 7 * p_interval_count;
  END IF;
  m := (date_trunc('month', p_starts_on::timestamp)
        + make_interval(months => (p_occurrence - 1) * p_interval_count
                                  * CASE p_frequency WHEN 'yearly' THEN 12 ELSE 1 END))::date;
  RETURN m + least(p_anchor_day, extract(day FROM ((m + interval '1 month')::date - 1))::int) - 1;
END
$$;

GRANT EXECUTE ON FUNCTION recurrence_occurrence_due(text, integer, integer, date, integer) TO moneyflow_app;

COMMENT ON FUNCTION recurrence_occurrence_due(text, integer, integer, date, integer) IS
  'Data da ocorrência n (1 = primeira) de uma série (spec 005), igual a occurrenceDueDate do shared: weekly = '
  'primeira data >= starts_on no dia ISO âncora + (n−1)·7·intervalo dias; monthly/yearly = mês de starts_on + '
  '(n−1)·intervalo (·12 no yearly) meses, no dia âncora (meses curtos: o último dia).';

-- 2. Séries: caixa, contrato e ajustes de reconhecimento -------------------------------------------------------------
ALTER TABLE recurrence_rules
  ADD COLUMN caixa_id               uuid REFERENCES caixas (id),
  ADD COLUMN contract_id            uuid REFERENCES contracts (id) ON DELETE SET NULL,
  ADD COLUMN match_window_days      smallint NOT NULL DEFAULT 15,
  ADD COLUMN late_fee_percent       numeric(6,4),
  ADD COLUMN interest_month_percent numeric(6,4),
  ADD COLUMN early_discount_percent numeric(6,4),
  ADD COLUMN tolerance_cents        bigint   NOT NULL DEFAULT 0,
  ADD COLUMN auto_settle            boolean  NOT NULL DEFAULT false,
  ADD CONSTRAINT recurrence_rules_match_window_days_check CHECK (match_window_days BETWEEN 0 AND 45),
  ADD CONSTRAINT recurrence_rules_late_fee_percent_check CHECK (late_fee_percent BETWEEN 0 AND 20),
  ADD CONSTRAINT recurrence_rules_interest_month_percent_check CHECK (interest_month_percent BETWEEN 0 AND 10),
  ADD CONSTRAINT recurrence_rules_early_discount_percent_check CHECK (early_discount_percent BETWEEN 0 AND 50),
  ADD CONSTRAINT recurrence_rules_tolerance_cents_check CHECK (tolerance_cents >= 0),
  ADD CONSTRAINT recurrence_rules_id_caixa_key UNIQUE (id, caixa_id);

CREATE INDEX recurrence_rules_caixa_id_idx ON recurrence_rules (caixa_id);
CREATE INDEX recurrence_rules_contract_id_idx ON recurrence_rules (contract_id);

-- 3. Cobrança esperada no cartão ---------------------------------------------------------------------------------------
-- A série de cartão tem recurrence_rules.caixa_id = a caixa do cartão; esta tabela guarda o resto do alvo. As
-- ocorrências são calculadas pelo calendário (não há títulos); a compra que atende uma ocorrência aponta para ela.
CREATE TABLE card_recurring_charges (
  recurrence_rule_id uuid        PRIMARY KEY REFERENCES recurrence_rules (id) ON DELETE CASCADE,
  payer_caixa_id     uuid        NOT NULL REFERENCES caixas (id),
  entity_id          uuid        NOT NULL REFERENCES entities (id),
  category_id        uuid        NOT NULL REFERENCES categories (id),
  description        text        NOT NULL,
  amount_cents       bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_recurring_charges_description_check CHECK (btrim(description) <> '' AND length(description) <= 200),
  CONSTRAINT card_recurring_charges_amount_cents_check CHECK (amount_cents > 0)
);

CREATE INDEX card_recurring_charges_payer_caixa_id_idx ON card_recurring_charges (payer_caixa_id);
CREATE INDEX card_recurring_charges_entity_id_idx ON card_recurring_charges (entity_id);
CREATE INDEX card_recurring_charges_category_id_idx ON card_recurring_charges (category_id);

CREATE TRIGGER card_recurring_charges_set_updated_at BEFORE UPDATE ON card_recurring_charges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE card_recurring_charges IS
  'Cobrança recorrente esperada num cartão (spec 034): o alvo de uma série cuja caixa (recurrence_rules.caixa_id) é '
  'a do cartão. Não gera título nem compra adiantada; as ocorrências são calculadas pelo calendário da série e a '
  'compra que atende uma ocorrência fica ligada a ela (card_purchases.recurrence_rule_id/occurrence). Uma por série.';
COMMENT ON COLUMN card_recurring_charges.payer_caixa_id IS 'Caixa pagadora da cobrança (general): a da compra criada ao confirmar.';
COMMENT ON COLUMN card_recurring_charges.entity_id IS 'Recebedor final esperado (o lojista da cobrança).';
COMMENT ON COLUMN card_recurring_charges.category_id IS 'Categoria de despesa da compra.';
COMMENT ON COLUMN card_recurring_charges.description IS 'Descrição da obrigação (1–200), usada na sugestão da fatura.';
COMMENT ON COLUMN card_recurring_charges.amount_cents IS
  'Valor esperado a partir da ocorrência 1; mudanças "dali em diante" ficam em card_recurring_charge_amounts.';

CREATE TABLE card_recurring_charge_amounts (
  recurrence_rule_id uuid        NOT NULL REFERENCES card_recurring_charges (recurrence_rule_id) ON DELETE CASCADE,
  from_occurrence    smallint    NOT NULL,
  amount_cents       bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recurrence_rule_id, from_occurrence),
  CONSTRAINT card_recurring_charge_amounts_from_occurrence_check CHECK (from_occurrence >= 2),
  CONSTRAINT card_recurring_charge_amounts_amount_cents_check CHECK (amount_cents > 0)
);

CREATE TRIGGER card_recurring_charge_amounts_set_updated_at BEFORE UPDATE ON card_recurring_charge_amounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE card_recurring_charge_amounts IS
  'Valor esperado de uma cobrança no cartão a partir da ocorrência from_occurrence (aditivo/reajuste "dali em diante", '
  'spec 034); as anteriores ficam com o valor de antes. Valor da ocorrência n: card_recurring_charge_amount(série, n).';

CREATE FUNCTION card_recurring_charge_amount(p_rule_id uuid, p_occurrence integer) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT a.amount_cents FROM card_recurring_charge_amounts a
      WHERE a.recurrence_rule_id = p_rule_id AND a.from_occurrence <= p_occurrence
      ORDER BY a.from_occurrence DESC LIMIT 1),
    (SELECT g.amount_cents FROM card_recurring_charges g WHERE g.recurrence_rule_id = p_rule_id))
$$;

GRANT EXECUTE ON FUNCTION card_recurring_charge_amount(uuid, integer) TO moneyflow_app;

COMMENT ON FUNCTION card_recurring_charge_amount(uuid, integer) IS
  'Valor esperado da ocorrência n de uma cobrança no cartão: o do último degrau de card_recurring_charge_amounts com '
  'from_occurrence <= n, senão card_recurring_charges.amount_cents. Nulo se a série não é de cartão.';

CREATE FUNCTION card_recurring_charges_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ck text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.recurrence_rule_id <> OLD.recurrence_rule_id THEN
    RAISE EXCEPTION 'card_recurring_charges: the series of a card charge cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_immutable_check';
  END IF;
  SELECT c.kind INTO ck FROM recurrence_rules r JOIN caixas c ON c.id = r.caixa_id WHERE r.id = NEW.recurrence_rule_id;
  IF FOUND AND ck <> 'credit_card' THEN
    RAISE EXCEPTION 'card_recurring_charges: series % is not in a credit card caixa', NEW.recurrence_rule_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_card_check';
  END IF;
  IF EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.payer_caixa_id AND c.kind <> 'general') THEN
    RAISE EXCEPTION 'card_recurring_charges: payer % must be a general caixa', NEW.payer_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_payer_kind_check';
  END IF;
  IF EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.kind <> 'expense') THEN
    RAISE EXCEPTION 'card_recurring_charges: category % must be an expense category', NEW.category_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_category_kind_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER card_recurring_charges_validate BEFORE INSERT OR UPDATE ON card_recurring_charges
  FOR EACH ROW EXECUTE FUNCTION card_recurring_charges_validate();

-- Auditoria por chave: as duas tabelas não têm id; a linha entra no histórico da série (record_id = a série).
CREATE FUNCTION audit_row_keyed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
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
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed,
                      coalesce(n ->> TG_ARGV[0], o ->> TG_ARGV[0])::uuid);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION audit_row_keyed() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION audit_row_keyed() IS
  'Trigger de auditoria de tabelas sem id: grava com record_id = a coluna informada em TG_ARGV[0] '
  '(card_recurring_charges e card_recurring_charge_amounts: recurrence_rule_id, o histórico da série).';

CREATE TRIGGER card_recurring_charges_audit AFTER INSERT OR UPDATE OR DELETE ON card_recurring_charges
  FOR EACH ROW EXECUTE FUNCTION audit_row_keyed('recurrence_rule_id');
CREATE TRIGGER card_recurring_charge_amounts_audit AFTER INSERT OR UPDATE OR DELETE ON card_recurring_charge_amounts
  FOR EACH ROW EXECUTE FUNCTION audit_row_keyed('recurrence_rule_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON card_recurring_charges, card_recurring_charge_amounts TO moneyflow_app;

-- 4. Compras do cartão ligadas a uma ocorrência --------------------------------------------------------------------
ALTER TABLE card_purchases
  ADD COLUMN contract_id        uuid REFERENCES contracts (id),
  ADD COLUMN recurrence_rule_id uuid,
  ADD COLUMN occurrence         smallint,
  ADD CONSTRAINT card_purchases_recurrence_rule_id_fkey FOREIGN KEY (recurrence_rule_id, card_caixa_id)
    REFERENCES recurrence_rules (id, caixa_id),
  ADD CONSTRAINT card_purchases_recurrence_check CHECK (
    (recurrence_rule_id IS NULL) = (occurrence IS NULL)
    AND (occurrence IS NULL OR occurrence >= 1)
    AND ((recurrence_rule_id IS NULL AND contract_id IS NULL) OR kind = 'purchase')
  );

CREATE INDEX card_purchases_contract_id_idx ON card_purchases (contract_id);
CREATE INDEX card_purchases_recurrence_rule_id_idx ON card_purchases (recurrence_rule_id, occurrence);

COMMENT ON COLUMN card_purchases.contract_id IS
  'Contrato da compra (spec 034): o da série quando ligada a uma ocorrência (checado no COMMIT). Só em purchase.';
COMMENT ON COLUMN card_purchases.recurrence_rule_id IS
  'Série de cobrança no cartão (do mesmo cartão: FK composta com card_caixa_id) cuja ocorrência esta compra atende.';
COMMENT ON COLUMN card_purchases.occurrence IS
  'Ocorrência atendida (n, junto com recurrence_rule_id). No máximo uma compra não estornada por série e ocorrência '
  '(card_purchases_occurrence_key, 23505): a estornada por inteiro libera a ocorrência.';

-- Uma compra não estornada por ocorrência (trava a série para serializar ligações concorrentes) e n ≤ N.
CREATE FUNCTION card_purchases_validate_occurrence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total smallint;
BEGIN
  IF NEW.recurrence_rule_id IS NULL OR NEW.kind <> 'purchase'
     OR (TG_OP = 'UPDATE' AND NEW.recurrence_rule_id IS NOT DISTINCT FROM OLD.recurrence_rule_id
         AND NEW.occurrence IS NOT DISTINCT FROM OLD.occurrence) THEN
    RETURN NEW;
  END IF;
  SELECT r.installments_total INTO total FROM recurrence_rules r WHERE r.id = NEW.recurrence_rule_id FOR NO KEY UPDATE;
  IF NEW.occurrence > total THEN
    RAISE EXCEPTION 'card_purchases: occurrence % exceeds installments total %', NEW.occurrence, total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_occurrence_total_check';
  END IF;
  IF EXISTS (SELECT 1 FROM card_purchases p
              WHERE p.recurrence_rule_id = NEW.recurrence_rule_id AND p.occurrence = NEW.occurrence
                AND p.id <> NEW.id AND p.kind = 'purchase'
                AND p.amount_cents > coalesce((SELECT sum(x.amount_cents) FROM card_purchases x
                                                WHERE x.refunded_purchase_id = p.id), 0)) THEN
    RAISE EXCEPTION 'card_purchases: occurrence % of series % already has a purchase', NEW.occurrence, NEW.recurrence_rule_id
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'card_purchases_occurrence_key';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER card_purchases_validate_occurrence
  BEFORE INSERT OR UPDATE OF recurrence_rule_id, occurrence ON card_purchases
  FOR EACH ROW EXECUTE FUNCTION card_purchases_validate_occurrence();

-- Reduzir o total de parcelas não deixa ocorrência (título ou compra ligada) acima de N.
CREATE OR REPLACE FUNCTION recurrence_rules_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.installments_total IS NOT NULL
     AND (EXISTS (SELECT 1 FROM titles t WHERE t.recurrence_rule_id = NEW.id AND t.occurrence > NEW.installments_total)
          OR EXISTS (SELECT 1 FROM card_purchases p
                      WHERE p.recurrence_rule_id = NEW.id AND p.occurrence > NEW.installments_total)) THEN
    RAISE EXCEPTION 'recurrence_rules: rule % has occurrences above %', NEW.id, NEW.installments_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_occurrence_total_check';
  END IF;
  RETURN NEW;
END
$$;

-- 5. Integridade da série (no COMMIT) ------------------------------------------------------------------------------
CREATE FUNCTION recurrence_rule_assert(p_rule_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r          recurrence_rules;
  ck         text;
  has_charge boolean;
  dir        text;
  bad        uuid;
BEGIN
  SELECT * INTO r FROM recurrence_rules x WHERE x.id = p_rule_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT c.kind INTO ck FROM caixas c WHERE c.id = r.caixa_id;
  has_charge := EXISTS (SELECT 1 FROM card_recurring_charges g WHERE g.recurrence_rule_id = r.id);
  IF coalesce(ck = 'credit_card', false) <> has_charge THEN
    RAISE EXCEPTION 'recurrence_rules: series % in a % caixa must % a card charge', r.id, ck,
      CASE WHEN has_charge THEN 'not have' ELSE 'have' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recurrence_rules_target_check';
  END IF;

  -- Títulos: o lado original fica na caixa da série; série de cartão não tem títulos.
  SELECT t.id INTO bad FROM titles t
   WHERE t.recurrence_rule_id = r.id AND (has_charge OR (t.mirror_status IS NULL AND t.caixa_id <> r.caixa_id))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'titles: title % of series % must be in the series caixa %', bad, r.id, r.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_recurrence_caixa_check';
  END IF;

  -- Contrato: os títulos e as compras ligadas carregam o contrato da série.
  SELECT t.id INTO bad FROM titles t
   WHERE t.recurrence_rule_id = r.id AND t.contract_id IS DISTINCT FROM r.contract_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'titles: title % of series % must have the series contract %', bad, r.id, r.contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_recurrence_contract_check';
  END IF;
  SELECT p.id INTO bad FROM card_purchases p
   WHERE p.recurrence_rule_id = r.id AND p.contract_id IS DISTINCT FROM r.contract_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'card_purchases: purchase % of series % must have the series contract %', bad, r.id, r.contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'card_purchases_recurrence_contract_check';
  END IF;

  -- Cobrança no cartão só em contrato a pagar.
  IF has_charge AND r.contract_id IS NOT NULL THEN
    SELECT k.direction INTO dir FROM contracts k WHERE k.id = r.contract_id;
    IF dir = 'receivable' THEN
      RAISE EXCEPTION 'card_recurring_charges: card charge % belongs to a receivable contract %', r.id, r.contract_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'card_recurring_charges_contract_check';
    END IF;
  END IF;
END
$$;

COMMENT ON FUNCTION recurrence_rule_assert(uuid) IS
  'Interna (constraint triggers no COMMIT): série em caixa de cartão ⇔ tem card_recurring_charges '
  '(recurrence_rules_target_check); lado original dos títulos na caixa da série e série de cartão sem títulos '
  '(titles_recurrence_caixa_check); títulos e compras ligadas com o contrato da série '
  '(titles_recurrence_contract_check, card_purchases_recurrence_contract_check); cobrança no cartão só em contrato '
  'a pagar (card_recurring_charges_contract_check).';

CREATE FUNCTION recurrence_rule_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'recurrence_rules' THEN
    PERFORM recurrence_rule_assert(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM recurrence_rule_assert(OLD.recurrence_rule_id);
  ELSIF NEW.recurrence_rule_id IS NOT NULL THEN
    PERFORM recurrence_rule_assert(NEW.recurrence_rule_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER recurrence_rules_integrity_check
  AFTER INSERT OR UPDATE OF caixa_id, contract_id ON recurrence_rules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recurrence_rule_integrity_check();
CREATE CONSTRAINT TRIGGER titles_recurrence_integrity_check
  AFTER INSERT OR UPDATE OF recurrence_rule_id, caixa_id, contract_id, mirror_status ON titles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recurrence_rule_integrity_check();
CREATE CONSTRAINT TRIGGER card_recurring_charges_integrity_check
  AFTER INSERT OR DELETE ON card_recurring_charges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recurrence_rule_integrity_check();
CREATE CONSTRAINT TRIGGER card_purchases_recurrence_integrity_check
  AFTER INSERT OR UPDATE OF recurrence_rule_id, contract_id ON card_purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recurrence_rule_integrity_check();

-- 6. Títulos: conta prevista da própria caixa (cofre inclusive) e contrato em série ou avulso -----------------------
ALTER TABLE titles DROP CONSTRAINT titles_contract_check;

DROP TRIGGER titles_validate_planned_account ON titles;
CREATE OR REPLACE FUNCTION titles_validate_planned_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acc_caixa uuid;
BEGIN
  IF NEW.planned_account_id IS NOT NULL THEN
    SELECT a.caixa_id INTO acc_caixa FROM financial_accounts a WHERE a.id = NEW.planned_account_id;
    IF FOUND AND acc_caixa <> NEW.caixa_id THEN
      RAISE EXCEPTION 'titles: planned account % must be an account of caixa %', NEW.planned_account_id, NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_planned_account_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER titles_validate_planned_account
  BEFORE INSERT OR UPDATE OF caixa_id, planned_account_id ON titles
  FOR EACH ROW EXECUTE FUNCTION titles_validate_planned_account();

-- Contrato no título: a ocorrência de série (e a parcela legada) segue direção e contraparte do contrato no lado
-- original; o título avulso (parcela única, multa) vale em qualquer direção. A caixa é livre (a da conta).
CREATE OR REPLACE FUNCTION titles_validate_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c     contracts;
  total smallint;
BEGIN
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM contracts k WHERE k.id = NEW.contract_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;

  IF NEW.mirror_status IS NULL AND (NEW.recurrence_rule_id IS NOT NULL OR NEW.contract_cycle_id IS NOT NULL)
     AND (NEW.direction <> c.direction OR NEW.entity_id <> c.entity_id) THEN
    RAISE EXCEPTION 'titles: contract % obligation must be % with entity %', c.id, c.direction, c.entity_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_match_check';
  END IF;

  IF NEW.contract_cycle_id IS NOT NULL THEN
    SELECT y.installments_count INTO total FROM contract_cycles y WHERE y.id = NEW.contract_cycle_id;
    IF NEW.contract_installment > total THEN
      RAISE EXCEPTION 'titles: installment % exceeds the % installments of cycle %', NEW.contract_installment, total,
        NEW.contract_cycle_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_installment_total_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER titles_validate_contract ON titles;
CREATE TRIGGER titles_validate_contract
  BEFORE INSERT OR UPDATE OF contract_id, contract_cycle_id, contract_installment, recurrence_rule_id, direction,
                             entity_id, mirror_status
  ON titles FOR EACH ROW EXECUTE FUNCTION titles_validate_contract();

-- A conta prevista não muda de caixa (o tipo agora é livre: cofre também é conta prevista).
CREATE OR REPLACE FUNCTION financial_accounts_validate_payment_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.caixa_id <> OLD.caixa_id AND EXISTS (SELECT 1 FROM titles t WHERE t.planned_account_id = OLD.id) THEN
    RAISE EXCEPTION 'financial_accounts: account % is the planned account of a title and cannot change caixa', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_planned_account_check';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER financial_accounts_validate_payment_refs ON financial_accounts;
CREATE TRIGGER financial_accounts_validate_payment_refs BEFORE UPDATE OF caixa_id ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_accounts_validate_payment_refs();

-- 7. Contratos: vigência; ciclos, aditivos e tarefas de renovação como histórico ------------------------------------
DROP TRIGGER contracts_validate_accounts ON contracts;
DROP FUNCTION contracts_validate_accounts();
DROP FUNCTION payment_accounts_assert(uuid, uuid, uuid, text, text, text);

ALTER TABLE contracts
  ADD COLUMN starts_on date,
  ADD COLUMN ends_on   date;

-- Ciclos: ends_on deixa de ser gerada (renovar acrescenta uma vigência com o fim informado, ou sem fim); os campos
-- do ciclo de parcelas ficam como histórico, opcionais. Um ciclo com eles continua com ends_on e installments_count
-- calculados como antes (contract_cycles_fill), o que mantém a importação de backups antigos.
ALTER TABLE contract_cycles
  ALTER COLUMN ends_on DROP EXPRESSION,
  ALTER COLUMN installments_count DROP EXPRESSION,
  ALTER COLUMN ends_on DROP NOT NULL,
  ALTER COLUMN installments_count DROP NOT NULL,
  ALTER COLUMN duration_months DROP NOT NULL,
  ALTER COLUMN periodicity DROP NOT NULL,
  ALTER COLUMN total_cents DROP NOT NULL,
  ALTER COLUMN due_day DROP NOT NULL,
  ADD CONSTRAINT contract_cycles_legacy_check CHECK (
    (duration_months IS NULL) = (periodicity IS NULL)
    AND (duration_months IS NULL) = (total_cents IS NULL)
    AND (duration_months IS NULL) = (due_day IS NULL)
  ),
  ADD CONSTRAINT contract_cycles_ends_on_check CHECK (ends_on >= starts_on);

CREATE FUNCTION contract_cycles_fill() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  x timestamp;
BEGIN
  IF NEW.duration_months IS NOT NULL THEN
    x := NEW.starts_on + make_interval(months => NEW.duration_months);
    NEW.ends_on := CASE WHEN extract(day FROM x) < extract(day FROM NEW.starts_on) THEN x::date ELSE x::date - 1 END;
  END IF;
  NEW.installments_count := (CASE NEW.periodicity
                               WHEN 'monthly' THEN NEW.duration_months
                               WHEN 'quarterly' THEN NEW.duration_months / 3
                               WHEN 'semiannual' THEN NEW.duration_months / 6
                               WHEN 'annual' THEN NEW.duration_months / 12
                               WHEN 'single' THEN 1
                             END)::smallint;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_cycles_fill BEFORE INSERT OR UPDATE ON contract_cycles
  FOR EACH ROW EXECUTE FUNCTION contract_cycles_fill();

-- Contiguidade: o ciclo sem fim (vigência indeterminada) só pode ser o último.
CREATE OR REPLACE FUNCTION contract_cycles_assert(p_contract_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r        record;
  prev_seq int := 0;
  prev_end date;
BEGIN
  FOR r IN SELECT y.seq, y.starts_on, y.ends_on FROM contract_cycles y WHERE y.contract_id = p_contract_id ORDER BY y.seq LOOP
    IF r.seq <> prev_seq + 1 OR (prev_seq > 0 AND (prev_end IS NULL OR r.starts_on <> prev_end + 1)) THEN
      RAISE EXCEPTION 'contract_cycles: cycle % of contract % must start on the day after cycle % ends (%)',
        r.seq, p_contract_id, prev_seq, prev_end
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_contiguous_check';
    END IF;
    prev_seq := r.seq;
    prev_end := r.ends_on;
  END LOOP;
END
$$;

DROP TRIGGER contract_cycles_contiguous_check ON contract_cycles;
CREATE CONSTRAINT TRIGGER contract_cycles_contiguous_check
  AFTER INSERT OR DELETE OR UPDATE OF seq, starts_on, ends_on, duration_months ON contract_cycles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_cycles_contiguous_check();

-- Aditivos: o ciclo fica opcional (o aditivo novo aplica sobre as obrigações) e guarda as séries atingidas.
ALTER TABLE contract_amendments
  ALTER COLUMN contract_cycle_id DROP NOT NULL,
  ADD COLUMN recurrence_rule_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT contract_amendments_rule_ids_check CHECK (array_position(recurrence_rule_ids, NULL) IS NULL);

-- Tarefas de renovação: só histórico. As abertas são fechadas (closed); nenhuma nova abre.
ALTER TABLE contract_renewal_tasks
  DROP CONSTRAINT contract_renewal_tasks_status_check,
  DROP CONSTRAINT contract_renewal_tasks_decision_check,
  ADD CONSTRAINT contract_renewal_tasks_status_check CHECK (status IN ('open', 'approved', 'declined', 'closed')),
  ADD CONSTRAINT contract_renewal_tasks_decision_check CHECK (
    CASE status
      WHEN 'open' THEN decided_at IS NULL AND new_cycle_id IS NULL
      WHEN 'approved' THEN decided_at IS NOT NULL AND new_cycle_id IS NOT NULL
      ELSE decided_at IS NOT NULL AND new_cycle_id IS NULL
    END
  );

DROP TRIGGER contract_renewal_tasks_integrity_check ON contract_renewal_tasks;
DROP TRIGGER contracts_renewal_pending_check ON contracts;

-- Rascunho não tem títulos nem compras de cartão ligadas.
CREATE OR REPLACE FUNCTION contract_assert(p_contract_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT k.status INTO st FROM contracts k WHERE k.id = p_contract_id;
  IF NOT FOUND OR st <> 'draft' THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM titles t WHERE t.contract_id = p_contract_id)
     OR EXISTS (SELECT 1 FROM card_purchases p WHERE p.contract_id = p_contract_id) THEN
    RAISE EXCEPTION 'contracts: draft contract % cannot have titles or card purchases', p_contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_draft_titles_check';
  END IF;
END
$$;

COMMENT ON FUNCTION contract_assert(uuid) IS
  'Interna (constraint triggers no COMMIT): rascunho sem títulos nem compras de cartão ligadas '
  '(contracts_draft_titles_check).';

CREATE CONSTRAINT TRIGGER contracts_integrity_check
  AFTER INSERT OR UPDATE OF status ON contracts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contracts_status_integrity_check();
CREATE CONSTRAINT TRIGGER card_purchases_contract_integrity_check
  AFTER INSERT OR UPDATE OF contract_id ON card_purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_refs_integrity_check();

-- Status sem renewal_pending: draft → active; active → ended | terminated; ended → active (renovar); terminated final.
CREATE OR REPLACE FUNCTION contracts_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cx       caixas;
  cp       caixas;
  cat_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'contracts: only draft contracts can be deleted (contract %, status %)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_delete_check';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'contracts: direction cannot change (contract %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_direction_immutable_check';
    END IF;
    IF OLD.status <> 'draft' AND (NEW.caixa_id <> OLD.caixa_id OR NEW.entity_id <> OLD.entity_id) THEN
      RAISE EXCEPTION 'contracts: caixa and entity only change in draft (contract %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_party_immutable_check';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'active')
      OR (OLD.status = 'active' AND NEW.status IN ('ended', 'terminated'))
      OR (OLD.status = 'ended' AND NEW.status = 'active')
      -- só a migração 0052 (renewal_pending some): renewal_pending → active
      OR (OLD.status = 'renewal_pending' AND NEW.status = 'active')) THEN
      RAISE EXCEPTION 'contracts: status cannot go from % to % (contract %)', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_status_transition_check';
    END IF;
  END IF;

  SELECT * INTO cx FROM caixas c WHERE c.id = NEW.caixa_id;
  IF FOUND THEN
    IF cx.kind <> 'general' THEN
      RAISE EXCEPTION 'contracts: caixa % must be general', NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_caixa_kind_check';
    END IF;
    IF cx.holder_entity_id = NEW.entity_id THEN
      RAISE EXCEPTION 'contracts: counterparty % is the holder of caixa %', NEW.entity_id, NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_entity_check';
    END IF;
  END IF;

  SELECT c.kind INTO cat_kind FROM categories c WHERE c.id = NEW.category_id;
  IF cat_kind IS NOT NULL
     AND cat_kind <> (CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END) THEN
    RAISE EXCEPTION 'contracts: % contract requires % category, got %', NEW.direction,
      CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END, cat_kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_category_kind_check';
  END IF;

  IF NEW.counterparty_caixa_id IS NOT NULL THEN
    SELECT * INTO cp FROM caixas c WHERE c.id = NEW.counterparty_caixa_id;
    IF FOUND AND (cp.kind <> 'general' OR cp.holder_entity_id <> NEW.entity_id) THEN
      RAISE EXCEPTION 'contracts: counterparty caixa % must be general and held by entity %',
        NEW.counterparty_caixa_id, NEW.entity_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_counterparty_caixa_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 8. Notificação "não cobrada" e baixa sem confirmação na fatura --------------------------------------------------
ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval', 'contract_charge_missing'));

ALTER TABLE statement_lines
  DROP CONSTRAINT statement_lines_auto_settled_check,
  ADD CONSTRAINT statement_lines_auto_settled_check CHECK (
    NOT auto_settled
    OR (status = 'matched' AND coalesce(created_entry IN ('settlement', 'transfer_settlement', 'purchase'), false))
  );

-- 9. Dados -------------------------------------------------------------------------------------------------------------
-- 9.1 Séries que já existiam: a caixa é a do lado original da ocorrência mais recente (o modelo do worker). A série
-- com lado original em caixas diferentes (possível se um título mudou de caixa) é dividida: as ocorrências das
-- outras caixas vão para uma regra nova por caixa, com a mesma agenda e terminando no último vencimento delas.
-- Regras sem nenhum título (órfãs: o worker já as ignorava) saem.
DO $$
DECLARE
  g   record;
  nid uuid;
BEGIN
  UPDATE recurrence_rules r SET caixa_id = x.caixa_id
    FROM (SELECT DISTINCT ON (t.recurrence_rule_id) t.recurrence_rule_id, t.caixa_id
            FROM titles t
           WHERE t.recurrence_rule_id IS NOT NULL
           ORDER BY t.recurrence_rule_id, (t.mirror_status IS NULL) DESC, t.occurrence DESC, t.id) x
   WHERE x.recurrence_rule_id = r.id;

  FOR g IN
    SELECT DISTINCT t.recurrence_rule_id AS rule_id, t.caixa_id
      FROM titles t JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
     WHERE t.mirror_status IS NULL AND t.caixa_id <> r.caixa_id
  LOOP
    -- A parte que sai termina no último vencimento dela (o worker segue só a parte com a ocorrência mais recente,
    -- o modelo de antes, sem repetir uma ocorrência na outra caixa).
    INSERT INTO recurrence_rules (frequency, interval_count, anchor_day, starts_on, ends_on, installments_total, caixa_id)
    SELECT r.frequency, r.interval_count, r.anchor_day, r.starts_on,
           greatest(r.starts_on, least(coalesce(r.ends_on, 'infinity'::date),
                                       (SELECT max(o.due_date) FROM titles o
                                         WHERE o.recurrence_rule_id = g.rule_id AND o.mirror_status IS NULL
                                           AND o.caixa_id = g.caixa_id))),
           NULL, g.caixa_id
      FROM recurrence_rules r WHERE r.id = g.rule_id
    RETURNING id INTO nid;
    UPDATE titles t SET recurrence_rule_id = nid
     WHERE t.recurrence_rule_id = g.rule_id
       AND (t.id IN (SELECT o.id FROM titles o
                      WHERE o.recurrence_rule_id = g.rule_id AND o.mirror_status IS NULL AND o.caixa_id = g.caixa_id)
            OR t.mirror_title_id IN (SELECT o.id FROM titles o
                                      WHERE o.recurrence_rule_id = g.rule_id AND o.mirror_status IS NULL
                                        AND o.caixa_id = g.caixa_id));
  END LOOP;

  DELETE FROM recurrence_rules r WHERE r.caixa_id IS NULL;
END
$$;

-- 9.2 Vigência do contrato: do início do primeiro ciclo ao fim do último (rescindido: até a rescisão).
UPDATE contracts k
   SET starts_on = least(c.first_start, coalesce(k.terminated_on, c.first_start)),
       ends_on = CASE WHEN k.status = 'terminated' THEN k.terminated_on ELSE c.last_end END
  FROM (SELECT y.contract_id, min(y.starts_on) AS first_start, (array_agg(y.ends_on ORDER BY y.seq DESC))[1] AS last_end
          FROM contract_cycles y GROUP BY y.contract_id) c
 WHERE c.contract_id = k.id;
UPDATE contracts k
   SET starts_on = coalesce(k.terminated_on, (k.created_at AT TIME ZONE 'America/Sao_Paulo')::date),
       ends_on = CASE WHEN k.status = 'terminated' THEN k.terminated_on
                      WHEN k.status = 'ended' THEN coalesce(k.terminated_on, (k.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
                 END
 WHERE k.starts_on IS NULL;

-- 9.3 Renovação: as tarefas abertas são fechadas e o contrato em renovação pendente volta a vigente (o aviso de fim
-- de vigência assume).
UPDATE contract_renewal_tasks SET status = 'closed', decided_at = now() WHERE status = 'open';
UPDATE contracts SET status = 'active' WHERE status = 'renewal_pending';

-- 9.4 Conta prevista: a de passagem vira a conta (é da caixa do título).
UPDATE titles SET planned_account_id = planned_transit_account_id, planned_transit_account_id = NULL
 WHERE planned_transit_account_id IS NOT NULL;

-- 9.5 Parcelas → séries. Por contrato e caixa do lado original, as parcelas dos ciclos que não são de parcela única
-- viram uma série, com a ocorrência na ordem do vencimento; o espelho repete série e ocorrência. A agenda é a do
-- último ciclo (mensal 1, trimestral 3, semestral 6 meses, anual) ancorada no último vencimento: a ocorrência N
-- calculada é exatamente o último vencimento, então a N + 1 cai depois do fim (ends_on = último vencimento; no
-- rescindido, o último não cancelado) e o worker não cria nada além nem repete um mês. Sem deriva (o caso comum),
-- o início é o primeiro vencimento. Os ajustes de reconhecimento do contrato vão para a série.
DO $$
DECLARE
  g         record;
  last_t    record;
  n_total   int;
  freq      text;
  step      int;
  ivl       int;
  anchor    int;
  base      date;
  start_d   date;
  end_d     date;
  rid       uuid;
BEGIN
  FOR g IN
    SELECT t.contract_id, t.caixa_id, count(*)::int AS n
      FROM titles t JOIN contract_cycles y ON y.id = t.contract_cycle_id
     WHERE t.origin = 'contract' AND t.mirror_status IS NULL AND y.periodicity <> 'single'
     GROUP BY t.contract_id, t.caixa_id
     ORDER BY t.contract_id, t.caixa_id
  LOOP
    n_total := g.n;
    SELECT t.due_date, y.periodicity, y.due_day INTO last_t
      FROM titles t JOIN contract_cycles y ON y.id = t.contract_cycle_id
     WHERE t.origin = 'contract' AND t.mirror_status IS NULL AND y.periodicity <> 'single'
       AND t.contract_id = g.contract_id AND t.caixa_id = g.caixa_id
     ORDER BY t.due_date DESC, t.competence_date DESC, y.seq DESC, t.contract_installment DESC, t.id DESC
     LIMIT 1;

    freq := CASE last_t.periodicity WHEN 'annual' THEN 'yearly' ELSE 'monthly' END;
    ivl := CASE last_t.periodicity WHEN 'quarterly' THEN 3 WHEN 'semiannual' THEN 6 ELSE 1 END;
    step := CASE freq WHEN 'yearly' THEN 12 ELSE ivl END;
    -- Dia âncora: o do último vencimento; se ele é o último dia do mês e o dia do ciclo é maior (31 em fevereiro),
    -- o do ciclo.
    anchor := extract(day FROM last_t.due_date)::int;
    IF last_t.due_date = (date_trunc('month', last_t.due_date::timestamp) + interval '1 month')::date - 1
       AND last_t.due_day > anchor THEN
      anchor := last_t.due_day;
    END IF;
    base := (date_trunc('month', last_t.due_date::timestamp) - make_interval(months => (n_total - 1) * step))::date;
    start_d := recurrence_occurrence_due(freq, ivl, anchor, base, 1);

    SELECT CASE WHEN k.status = 'terminated'
                THEN (SELECT max(t.due_date) FROM titles t JOIN contract_cycles y ON y.id = t.contract_cycle_id
                       WHERE t.origin = 'contract' AND t.mirror_status IS NULL AND y.periodicity <> 'single'
                         AND t.contract_id = g.contract_id AND t.caixa_id = g.caixa_id AND t.status <> 'canceled')
                ELSE last_t.due_date END
      INTO end_d
      FROM contracts k WHERE k.id = g.contract_id;
    end_d := greatest(coalesce(end_d, start_d), start_d);

    IF recurrence_occurrence_due(freq, ivl, anchor, start_d, n_total) <> last_t.due_date
       OR recurrence_occurrence_due(freq, ivl, anchor, start_d, n_total + 1) <= end_d THEN
      RAISE EXCEPTION 'migration 0052: calendar of contract % does not end at its last installment', g.contract_id;
    END IF;

    INSERT INTO recurrence_rules (frequency, interval_count, anchor_day, starts_on, ends_on, caixa_id, contract_id,
                                  match_window_days, late_fee_percent, interest_month_percent, early_discount_percent,
                                  tolerance_cents, auto_settle)
    SELECT freq, ivl, anchor, start_d, end_d, g.caixa_id, k.id,
           k.match_window_days, k.late_fee_percent, k.interest_month_percent, k.early_discount_percent,
           k.tolerance_cents, k.auto_settle
      FROM contracts k WHERE k.id = g.contract_id
    RETURNING id INTO rid;

    WITH ordered AS (
      SELECT t.id, t.mirror_title_id,
             row_number() OVER (ORDER BY t.due_date, t.competence_date, y.seq, t.contract_installment, t.id) AS occ
        FROM titles t JOIN contract_cycles y ON y.id = t.contract_cycle_id
       WHERE t.origin = 'contract' AND t.mirror_status IS NULL AND y.periodicity <> 'single'
         AND t.contract_id = g.contract_id AND t.caixa_id = g.caixa_id
    ), pairs AS (
      SELECT o.id, o.occ FROM ordered o
      UNION ALL
      SELECT o.mirror_title_id, o.occ FROM ordered o WHERE o.mirror_title_id IS NOT NULL
    )
    UPDATE titles t SET origin = 'recurrence', recurrence_rule_id = rid, occurrence = p.occ
      FROM pairs p WHERE p.id = t.id;
  END LOOP;
END
$$;

-- Parcela única e títulos extras (multa, valor rescisório): avulsos ligados ao contrato.
UPDATE titles SET origin = 'manual' WHERE origin = 'contract';

-- 9.6 Conta de cada título do contrato sem conta prevista: a da última baixa ativa do contrato na mesma caixa
-- (conta não arquivada); senão fica sem (a tela avisa "obrigação sem conta").
UPDATE titles t SET planned_account_id = la.account_id
  FROM (SELECT DISTINCT ON (x.contract_id, x.caixa_id) x.contract_id, x.caixa_id, s.financial_account_id AS account_id
          FROM titles x
          JOIN settlements s ON s.title_id = x.id
          JOIN financial_accounts a ON a.id = s.financial_account_id
         WHERE x.contract_id IS NOT NULL AND s.reversed_at IS NULL AND a.archived_at IS NULL
           AND a.caixa_id = x.caixa_id
         ORDER BY x.contract_id, x.caixa_id, s.settled_on DESC, s.created_at DESC, s.id DESC) la
 WHERE t.contract_id = la.contract_id AND t.caixa_id = la.caixa_id AND t.planned_account_id IS NULL;

-- Checagens adiadas agora (valida o que foi migrado e libera as tabelas para o ALTER).
SET CONSTRAINTS ALL IMMEDIATE;

-- 10. O que sai -------------------------------------------------------------------------------------------------------
ALTER TABLE recurrence_rules ALTER COLUMN caixa_id SET NOT NULL;

DROP INDEX titles_planned_transit_account_id_idx;
ALTER TABLE titles
  DROP COLUMN planned_transit_account_id,
  DROP CONSTRAINT titles_origin_check,
  ADD CONSTRAINT titles_origin_check CHECK (origin IN ('manual', 'recurrence', 'card_invoice')),
  ADD CONSTRAINT titles_contract_check CHECK (
    (contract_cycle_id IS NULL) = (contract_installment IS NULL)
    AND (contract_cycle_id IS NULL OR contract_id IS NOT NULL)
    AND (contract_id IS NULL OR origin IN ('manual', 'recurrence'))
  );

DROP INDEX contracts_payment_account_id_idx;
DROP INDEX contracts_transit_account_id_idx;
ALTER TABLE contracts
  DROP COLUMN payment_account_id,
  DROP COLUMN transit_account_id,
  DROP COLUMN late_fee_percent,
  DROP COLUMN interest_month_percent,
  DROP COLUMN early_discount_percent,
  DROP COLUMN tolerance_cents,
  DROP COLUMN match_window_days,
  DROP COLUMN auto_settle,
  ALTER COLUMN starts_on SET NOT NULL,
  DROP CONSTRAINT contracts_status_check,
  ADD CONSTRAINT contracts_status_check CHECK (status IN ('draft', 'active', 'ended', 'terminated')),
  ADD CONSTRAINT contracts_ends_on_check CHECK (ends_on >= starts_on),
  ADD CONSTRAINT contracts_ended_term_check CHECK (status NOT IN ('ended', 'terminated') OR ends_on IS NOT NULL),
  ADD CONSTRAINT contracts_terminated_on_check CHECK (terminated_on IS NULL OR terminated_on = ends_on);

CREATE INDEX contracts_ends_on_idx ON contracts (ends_on) WHERE archived_at IS NULL;

ALTER TABLE contract_renewal_tasks
  ALTER COLUMN status DROP DEFAULT,
  DROP CONSTRAINT contract_renewal_tasks_status_check,
  ADD CONSTRAINT contract_renewal_tasks_status_check CHECK (status IN ('approved', 'declined', 'closed'));
DROP INDEX contract_renewal_tasks_open_key;
DROP INDEX contract_renewal_tasks_due_on_idx;

SET CONSTRAINTS ALL DEFERRED;

-- 11. Leitura: pagamentos das obrigações de um contrato --------------------------------------------------------------
DROP FUNCTION contract_payments(uuid, uuid, date);

CREATE FUNCTION contract_payments(
  p_contract_id uuid,
  p_from        date DEFAULT NULL,
  p_to          date DEFAULT NULL,
  p_today       date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
RETURNS TABLE (
  kind                   text,
  recurrence_rule_id     uuid,
  occurrence             integer,
  title_id               uuid,
  card_purchase_id       uuid,
  caixa_id               uuid,
  card_invoice_id        uuid,
  description            text,
  competence_date        date,
  due_date               date,
  amount_cents           bigint,
  status                 text,
  settled_cents          bigint,
  open_cents             bigint,
  interest_cents         bigint,
  fine_cents             bigint,
  discount_cents         bigint,
  cash_cents             bigint,
  settlement_count       integer,
  last_settled_on        date,
  paid_on                date,
  days                   integer,
  overdue                boolean,
  not_charged            boolean,
  account_id             uuid,
  funding_account_id     uuid,
  planned_account_id     uuid,
  planned_account_custom boolean,
  last_origin            text,
  settlements            jsonb
)
LANGUAGE sql STABLE AS $$
  WITH obligations AS (
    SELECT t.*
      FROM titles t
     WHERE t.contract_id = p_contract_id
       AND t.mirror_status IS NULL           -- o lado do contrato (o espelho repete as baixas)
       AND t.status <> 'canceled'
       AND (p_from IS NULL OR t.due_date >= p_from)
       AND (p_to IS NULL OR t.due_date <= p_to)
  ), legs AS (
    SELECT s.id, s.title_id, s.settled_on, s.amount_cents, s.interest_cents, s.fine_cents, s.discount_cents,
           s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents AS cash_cents,
           s.financial_account_id,
           tr.id AS transfer_id,
           CASE o.direction WHEN 'payable' THEN tr.from_account_id ELSE tr.to_account_id END AS funding_account_id,
           ln.id AS statement_line_id,
           CASE WHEN ln.auto_settled THEN 'auto'
                WHEN ln.created_entry IN ('title', 'settlement', 'transfer_settlement') THEN 'reconciliation'
                ELSE 'manual' END AS origin,
           ln.id IS NOT NULL AS reconciled,
           (s.settled_on - o.due_date) AS days
      FROM settlements s
      JOIN obligations o ON o.id = s.title_id
      LEFT JOIN transfers tr ON tr.settlement_id = s.id
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry
          FROM statement_lines l
          JOIN movements m ON m.id = l.movement_id
         WHERE l.status = 'matched'
           AND (m.settlement_id IN (s.id, s.mirror_settlement_id)
                OR m.transfer_id IN (SELECT x.id FROM transfers x
                                      WHERE x.settlement_id IN (s.id, s.mirror_settlement_id)))
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE s.reversed_at IS NULL
  ), agg AS (
    SELECT g.title_id,
           sum(g.amount_cents)::bigint   AS settled_cents,
           sum(g.interest_cents)::bigint AS interest_cents,
           sum(g.fine_cents)::bigint     AS fine_cents,
           sum(g.discount_cents)::bigint AS discount_cents,
           sum(g.cash_cents)::bigint     AS cash_cents,
           count(*)::int                 AS settlement_count,
           jsonb_agg(jsonb_build_object(
             'id', g.id, 'settled_on', g.settled_on, 'amount_cents', g.amount_cents,
             'interest_cents', g.interest_cents, 'fine_cents', g.fine_cents, 'discount_cents', g.discount_cents,
             'cash_cents', g.cash_cents, 'financial_account_id', g.financial_account_id,
             'transfer_id', g.transfer_id, 'funding_account_id', g.funding_account_id,
             'statement_line_id', g.statement_line_id, 'reconciled', g.reconciled, 'origin', g.origin,
             'days', g.days) ORDER BY g.settled_on, g.id) AS settlements,
           (array_agg(g.settled_on ORDER BY g.settled_on DESC, g.id DESC))[1]           AS last_settled_on,
           (array_agg(g.financial_account_id ORDER BY g.settled_on DESC, g.id DESC))[1] AS account_id,
           (array_agg(g.funding_account_id ORDER BY g.settled_on DESC, g.id DESC))[1]   AS funding_account_id,
           (array_agg(g.origin ORDER BY g.settled_on DESC, g.id DESC))[1]               AS last_origin
      FROM legs g
     GROUP BY g.title_id
  ), title_rows AS (
    SELECT 'title'::text AS kind, o.recurrence_rule_id, o.occurrence::int AS occurrence, o.id AS title_id,
           NULL::uuid AS card_purchase_id, o.caixa_id, NULL::uuid AS card_invoice_id, o.description,
           o.competence_date, o.due_date, o.amount_cents, o.status,
           coalesce(a.settled_cents, 0) AS settled_cents, o.amount_cents - coalesce(a.settled_cents, 0) AS open_cents,
           coalesce(a.interest_cents, 0) AS interest_cents, coalesce(a.fine_cents, 0) AS fine_cents,
           coalesce(a.discount_cents, 0) AS discount_cents, coalesce(a.cash_cents, 0) AS cash_cents,
           coalesce(a.settlement_count, 0) AS settlement_count,
           a.last_settled_on,
           CASE WHEN o.status = 'paid' THEN a.last_settled_on END AS paid_on,
           CASE WHEN o.status = 'paid' THEN a.last_settled_on - o.due_date
                WHEN o.due_date < p_today THEN p_today - o.due_date END AS days,
           o.status <> 'paid' AND o.due_date < p_today AS overdue,
           false AS not_charged,
           a.account_id, a.funding_account_id, o.planned_account_id, o.planned_account_custom,
           a.last_origin, coalesce(a.settlements, '[]'::jsonb) AS settlements
      FROM obligations o
      LEFT JOIN agg a ON a.title_id = o.id
  ), charges AS (
    SELECT r.id AS rule_id, r.caixa_id AS card_caixa_id, r.frequency, r.interval_count, r.anchor_day, r.starts_on,
           r.installments_total, g.description,
           least(coalesce(r.ends_on, 'infinity'::date), coalesce(p_to, (p_today + interval '12 months')::date)) AS until
      FROM recurrence_rules r
      JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
     WHERE r.contract_id = p_contract_id
  ), expected AS (
    SELECT c.rule_id, n.n
      FROM charges c
     CROSS JOIN LATERAL generate_series(1, greatest(0, least(coalesce(c.installments_total::int, 32767),
       CASE c.frequency
         WHEN 'weekly' THEN (c.until - c.starts_on) / (7 * c.interval_count) + 1
         ELSE ((extract(year FROM c.until)::int * 12 + extract(month FROM c.until)::int)
               - (extract(year FROM c.starts_on)::int * 12 + extract(month FROM c.starts_on)::int))
              / (c.interval_count * CASE c.frequency WHEN 'yearly' THEN 12 ELSE 1 END) + 1
       END))) AS n (n)
     WHERE recurrence_occurrence_due(c.frequency, c.interval_count, c.anchor_day, c.starts_on, n.n) <= c.until
    UNION
    SELECT p.recurrence_rule_id, p.occurrence
      FROM card_purchases p JOIN charges c ON c.rule_id = p.recurrence_rule_id
     WHERE p.kind = 'purchase'
  ), occ AS (
    SELECT e.rule_id, e.n, c.card_caixa_id, c.description,
           recurrence_occurrence_due(c.frequency, c.interval_count, c.anchor_day, c.starts_on, e.n) AS due,
           card_recurring_charge_amount(e.rule_id, e.n) AS expected_cents
      FROM expected e JOIN charges c ON c.rule_id = e.rule_id
  ), card_rows AS (
    SELECT 'card_charge'::text AS kind, o.rule_id AS recurrence_rule_id, o.n AS occurrence, NULL::uuid AS title_id,
           pu.id AS card_purchase_id, o.card_caixa_id AS caixa_id,
           CASE WHEN pu.charged THEN pi.card_invoice_id ELSE inv.id END AS card_invoice_id, o.description,
           date_trunc('month', o.due::timestamp)::date AS competence_date, o.due AS due_date,
           o.expected_cents AS amount_cents,
           CASE WHEN pu.charged THEN 'charged' WHEN inv.closed_at IS NOT NULL THEN 'not_charged' ELSE 'expected' END AS status,
           CASE WHEN pu.charged THEN pu.net_cents ELSE 0 END AS settled_cents,
           CASE WHEN pu.charged THEN 0 ELSE o.expected_cents END AS open_cents,
           0::bigint AS interest_cents, 0::bigint AS fine_cents, 0::bigint AS discount_cents,
           CASE WHEN pu.charged THEN pu.net_cents ELSE 0 END AS cash_cents,
           CASE WHEN pu.charged THEN 1 ELSE 0 END AS settlement_count,
           CASE WHEN pu.charged THEN pu.purchased_on END AS last_settled_on,
           CASE WHEN pu.charged THEN pu.purchased_on END AS paid_on,
           CASE WHEN pu.charged THEN pu.purchased_on - o.due END AS days,
           false AS overdue,
           coalesce(NOT pu.charged, true) AND inv.closed_at IS NOT NULL AS not_charged,
           NULL::uuid AS account_id, NULL::uuid AS funding_account_id, NULL::uuid AS planned_account_id,
           false AS planned_account_custom,
           CASE WHEN pu.charged IS NOT TRUE THEN NULL WHEN ln.auto_settled THEN 'auto'
                WHEN ln.created_entry = 'purchase' THEN 'reconciliation' ELSE 'manual' END AS last_origin,
           CASE WHEN pu.charged THEN jsonb_build_array(jsonb_build_object(
             'card_purchase_id', pu.id, 'purchased_on', pu.purchased_on, 'amount_cents', pu.net_cents,
             'card_invoice_id', pi.card_invoice_id, 'statement_line_id', ln.id, 'reconciled', ln.id IS NOT NULL,
             'origin', CASE WHEN ln.auto_settled THEN 'auto' WHEN ln.created_entry = 'purchase' THEN 'reconciliation'
                            ELSE 'manual' END,
             'days', pu.purchased_on - o.due))
           ELSE '[]'::jsonb END AS settlements
      FROM occ o
      LEFT JOIN LATERAL (
        SELECT q.id, q.purchased_on, q.net_cents, q.net_cents > 0 AS charged
          FROM (SELECT p.id, p.purchased_on,
                       p.amount_cents - coalesce((SELECT sum(x.amount_cents) FROM card_purchases x
                                                   WHERE x.refunded_purchase_id = p.id), 0)::bigint AS net_cents
                  FROM card_purchases p
                 WHERE p.recurrence_rule_id = o.rule_id AND p.occurrence = o.n AND p.kind = 'purchase') q
         ORDER BY q.net_cents > 0 DESC, q.purchased_on DESC, q.id DESC
         LIMIT 1
      ) pu ON true
      LEFT JOIN LATERAL (
        SELECT i.id AS item_id, i.card_invoice_id FROM card_invoice_items i
         WHERE i.card_purchase_id = pu.id AND pu.charged ORDER BY i.installment_number LIMIT 1
      ) pi ON true
      LEFT JOIN LATERAL (
        SELECT v.id, v.closed_at FROM card_invoices v
         WHERE v.card_caixa_id = o.card_caixa_id AND v.closing_date >= o.due
         ORDER BY v.closing_date LIMIT 1
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry FROM statement_lines l
         WHERE l.status = 'matched' AND l.card_invoice_item_id = pi.item_id
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE (p_from IS NULL OR o.due >= p_from) AND (p_to IS NULL OR o.due <= p_to)
  ), loose_rows AS (
    -- Compra ligada só ao contrato (sem ocorrência de série).
    SELECT 'card_charge'::text AS kind, NULL::uuid AS recurrence_rule_id, NULL::int AS occurrence, NULL::uuid AS title_id,
           p.id AS card_purchase_id, p.card_caixa_id AS caixa_id, pi.card_invoice_id, p.description,
           date_trunc('month', p.purchased_on::timestamp)::date AS competence_date, p.purchased_on AS due_date,
           p.amount_cents, 'charged'::text AS status, net.cents AS settled_cents, 0::bigint AS open_cents,
           0::bigint AS interest_cents, 0::bigint AS fine_cents, 0::bigint AS discount_cents, net.cents AS cash_cents,
           1 AS settlement_count, p.purchased_on AS last_settled_on, p.purchased_on AS paid_on, 0 AS days,
           false AS overdue, false AS not_charged,
           NULL::uuid AS account_id, NULL::uuid AS funding_account_id, NULL::uuid AS planned_account_id,
           false AS planned_account_custom,
           CASE WHEN ln.auto_settled THEN 'auto' WHEN ln.created_entry = 'purchase' THEN 'reconciliation'
                ELSE 'manual' END AS last_origin,
           jsonb_build_array(jsonb_build_object(
             'card_purchase_id', p.id, 'purchased_on', p.purchased_on, 'amount_cents', net.cents,
             'card_invoice_id', pi.card_invoice_id, 'statement_line_id', ln.id, 'reconciled', ln.id IS NOT NULL,
             'origin', CASE WHEN ln.auto_settled THEN 'auto' WHEN ln.created_entry = 'purchase' THEN 'reconciliation'
                            ELSE 'manual' END,
             'days', 0)) AS settlements
      FROM card_purchases p
      CROSS JOIN LATERAL (
        SELECT p.amount_cents - coalesce((SELECT sum(x.amount_cents) FROM card_purchases x
                                           WHERE x.refunded_purchase_id = p.id), 0)::bigint AS cents
      ) net
      LEFT JOIN LATERAL (
        SELECT i.id AS item_id, i.card_invoice_id FROM card_invoice_items i
         WHERE i.card_purchase_id = p.id ORDER BY i.installment_number LIMIT 1
      ) pi ON true
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry FROM statement_lines l
         WHERE l.status = 'matched' AND l.card_invoice_item_id = pi.item_id
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE p.contract_id = p_contract_id AND p.recurrence_rule_id IS NULL AND p.kind = 'purchase' AND net.cents > 0
       AND (p_from IS NULL OR p.purchased_on >= p_from) AND (p_to IS NULL OR p.purchased_on <= p_to)
  )
  SELECT * FROM (
    SELECT * FROM title_rows
    UNION ALL
    SELECT * FROM card_rows
    UNION ALL
    SELECT * FROM loose_rows
  ) x
  ORDER BY x.due_date, x.kind DESC, x.occurrence NULLS LAST, x.title_id, x.card_purchase_id
$$;

GRANT EXECUTE ON FUNCTION contract_payments(uuid, date, date, date) TO moneyflow_app;

COMMENT ON FUNCTION contract_payments(uuid, date, date, date) IS
  'Pagamentos das obrigações de um contrato (spec 034), com vencimento entre p_from e p_to (nulos = sem limite), em '
  'ordem de vencimento. kind = title: os títulos não cancelados do lado do contrato (ocorrências das séries dele e '
  'avulsos ligados), com as baixas ativas somadas e uma a uma em settlements (como na 033: conta, transferência, '
  'funding_account_id, linha, origin manual|reconciliation|auto, days); paid_on = data da última baixa do título '
  'pago; days = paid_on − vencimento ou, em aberto vencido, p_today − vencimento (overdue). kind = card_charge: as '
  'ocorrências esperadas das cobranças no cartão do contrato (calendário da série até o fim dela e até p_to, ou '
  'p_today + 12 meses), mais as que têm compra ligada; amount_cents = valor esperado; status charged (compra ligada '
  'não estornada por inteiro: settled/cash = valor líquido da compra, paid_on = data da compra, days = compra − '
  'data esperada), not_charged (a fatura que fecha na data esperada ou depois já fechou sem compra; not_charged = '
  'true) ou expected; card_invoice_id = a fatura da compra ou a esperada; e as compras ligadas só ao contrato, sem '
  'ocorrência (recurrence_rule_id nulo). SECURITY INVOKER; quem lê o contrato é a aplicação, que monta o resumo.';

-- 12. Comentários -------------------------------------------------------------------------------------------------------
COMMENT ON TABLE recurrence_rules IS
  'Série recorrente ou parcelamento (spec 005): o calendário, a caixa (caixa_id) e, opcionalmente, o contrato de que '
  'é obrigação (contract_id, spec 034) e os ajustes de reconhecimento do pagamento. Série numa caixa general = '
  'títulos materializados pelo worker até 12 meses à frente (titles.recurrence_rule_id/occurrence; modelo = a '
  'ocorrência mais recente). Série na caixa de um cartão = cobrança esperada (card_recurring_charges), sem títulos.';
COMMENT ON COLUMN recurrence_rules.caixa_id IS
  'Caixa da série: a do lado original dos títulos (a da conta da obrigação) ou, na cobrança esperada, a do cartão '
  '(credit_card ⇔ card_recurring_charges, no COMMIT). Mudar exige mover os títulos na mesma transação.';
COMMENT ON COLUMN recurrence_rules.contract_id IS
  'Contrato de que a série é obrigação (spec 034; ON DELETE SET NULL). Os títulos da série e as compras ligadas '
  'carregam o mesmo contract_id (no COMMIT): ligar ou desligar a série muda os dois na mesma transação.';
COMMENT ON COLUMN recurrence_rules.match_window_days IS
  'Reconhecimento: janela em dias em torno do vencimento (0–45, padrão 15), além do mês do vencimento.';
COMMENT ON COLUMN recurrence_rules.late_fee_percent IS 'Reconhecimento: multa por atraso (0–20%) sobre o valor, uma vez. Nula = sem.';
COMMENT ON COLUMN recurrence_rules.interest_month_percent IS 'Reconhecimento: juros de mora (0–10% ao mês), pró-rata por dia. Nulo = sem.';
COMMENT ON COLUMN recurrence_rules.early_discount_percent IS 'Reconhecimento: desconto por pontualidade (0–50%) até o vencimento. Nulo = sem.';
COMMENT ON COLUMN recurrence_rules.tolerance_cents IS
  'Reconhecimento: diferença aceita além dos encargos (≥ 0, padrão 0; o teto de 10% do valor é da aplicação).';
COMMENT ON COLUMN recurrence_rules.auto_settle IS
  'Baixar sem confirmação: a linha do extrato (ou da fatura) com um único candidato desta série vira conciliada direto '
  '(statement_lines.auto_settled; no cartão, a compra criada com created_entry purchase).';

COMMENT ON COLUMN titles.origin IS
  'manual, recurrence (ocorrência de recurrence_rules) ou card_invoice (fatura de cartão, F2). O espelho herda a '
  'origem do original. Título de contrato (spec 034) é recurrence (obrigação em série) ou manual (avulso: parcela '
  'única, multa); a origem contract saiu na 0052.';
COMMENT ON COLUMN titles.contract_id IS
  'Contrato do título (spec 034): a ocorrência de uma série do contrato (= recurrence_rules.contract_id, no COMMIT) '
  'ou um avulso ligado a ele. O espelho repete o contrato.';
COMMENT ON COLUMN titles.contract_cycle_id IS
  'Legado (até a 0051): ciclo da parcela gerada pelo contrato, mantido como histórico nos títulos migrados. Não '
  'preencha em títulos novos.';
COMMENT ON COLUMN titles.contract_installment IS
  'Legado (até a 0051): número da parcela n no ciclo (N = contract_cycles.installments_count). Histórico.';
COMMENT ON COLUMN titles.planned_account_id IS
  'Conta prevista (specs 033 e 034): conta da caixa do título (corrente, poupança ou cofre), onde o pagamento sai '
  'ou o recebimento entra. A série copia a da ocorrência modelo; a conciliação procura a ocorrência pela conta.';
COMMENT ON COLUMN titles.planned_account_custom IS
  'A ocorrência escolheu a conta dela (troca avulsa); padrão false. Sem regra no banco: a aplicação decide se a troca '
  'da conta da série ("esta e as próximas") a respeita.';

COMMENT ON TABLE contracts IS
  'Contratos (specs 020 e 034): acordo com uma entidade dentro de uma caixa general, com vigência, documentos, avisos '
  'e obrigações (as séries com recurrence_rules.contract_id, em contas ou no cartão, e títulos avulsos ligados). '
  'contract_cycles, contract_amendments e contract_renewal_tasks guardam o histórico. Só rascunho é excluído.';
COMMENT ON COLUMN contracts.status IS
  'draft (sem títulos nem compras ligadas) → active; active → ended | terminated; ended → active (renovar); '
  'terminated é final; nada volta para draft. renewal_pending saiu na 0052 (renovar é uma ação).';
COMMENT ON COLUMN contracts.starts_on IS 'Início da vigência (spec 034).';
COMMENT ON COLUMN contracts.ends_on IS
  'Fim da vigência (nulo = indeterminado; obrigatório em ended e terminated; no rescindido, = terminated_on). Renovar '
  'estende a vigência e o fim das séries.';
COMMENT ON COLUMN contracts.terminated_on IS
  'Data de encerramento da rescisão; preenchida se e somente se status = terminated, e igual ao fim da vigência.';

COMMENT ON TABLE contract_cycles IS
  'Histórico das vigências de um contrato (spec 034): seq 1, 2, 3… contíguos (o seguinte começa no dia seguinte ao '
  'fim do anterior; o sem fim só no último; no COMMIT). Renovar acrescenta um. Os ciclos de parcelas de antes da '
  '0052 têm os campos do ciclo (duração, periodicidade, total, dia), com ends_on e installments_count calculados; '
  'com títulos ligados, início, duração e periodicidade ficam imutáveis.';
COMMENT ON COLUMN contract_cycles.ends_on IS
  'Fim da vigência (nulo = indeterminado, só no último ciclo). Num ciclo com duration_months, calculado como antes: '
  'x = starts_on + duração meses; x se o dia não existe no mês final, senão x − 1 dia.';
COMMENT ON COLUMN contract_cycles.installments_count IS
  'Legado: número de parcelas = duração ÷ meses do período (single = 1), calculado; nulo sem os campos do ciclo.';
COMMENT ON COLUMN contract_cycles.duration_months IS
  'Legado (ciclo de parcelas): duração em meses (1–120), múltipla do período. Nulo nas vigências novas, junto com '
  'periodicity, total_cents e due_day (contract_cycles_legacy_check).';
COMMENT ON COLUMN contract_amendments.contract_cycle_id IS 'Ciclo aditado (legado; opcional desde a 0052).';
COMMENT ON COLUMN contract_amendments.recurrence_rule_ids IS
  'Obrigações (séries) atingidas pelo aditivo (spec 034), com "esta e as próximas" a partir da data de efeito.';
COMMENT ON TABLE contract_renewal_tasks IS
  'Histórico das tarefas de renovação (até a 0052): approved (com o ciclo criado), declined ou closed (aberta '
  'fechada pela migração 0052, quando o aviso de fim de vigência assumiu). Nenhuma tarefa nova abre.';
COMMENT ON COLUMN contract_renewal_tasks.status IS 'approved (decided_at e new_cycle_id) | declined | closed (decided_at). Final.';
COMMENT ON COLUMN card_purchases.kind IS 'purchase, refund (estorno de refunded_purchase_id) ou charge (encargo do emissor). Imutável.';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending (histórico), contract_readjustment, ai_budget_alert (spec 028; dedup por orçamento, mês e '
  'limiar), ai_awaiting_approval (spec 029) ou contract_charge_missing (spec 034: ocorrência de cobrança no cartão '
  'não cobrada, uma vez por ocorrência).';
COMMENT ON COLUMN statement_lines.auto_settled IS
  'O lançamento desta linha foi feito sem confirmação (recurrence_rules.auto_settle, specs 033 e 034). Só em '
  'matched com created_entry settlement, transfer_settlement ou purchase (a compra da cobrança no cartão); a '
  'aplicação limpa junto com created_entry.';

-- migrate:down

-- Melhor esforço: os contratos migrados voltam ao modelo de parcelas (as séries de contrato voltam a origin
-- contract; a conta prevista que era de passagem fica como conta prevista da própria caixa, sem passagem; os
-- ajustes voltam ao contrato a partir da primeira série dele). O que só existe no modelo novo se perde: cobranças
-- esperadas no cartão e as ligações das compras, vigências acrescentadas depois (ciclos sem os campos do ciclo de
-- parcelas), a ligação de séries cuja caixa não é a do contrato e as regras órfãs apagadas na subida.

SET CONSTRAINTS ALL IMMEDIATE;

DROP FUNCTION contract_payments(uuid, date, date, date);

-- Cartão
DROP TRIGGER card_purchases_recurrence_integrity_check ON card_purchases;
DROP TRIGGER card_purchases_contract_integrity_check ON card_purchases;
DROP TRIGGER card_purchases_validate_occurrence ON card_purchases;
DROP FUNCTION card_purchases_validate_occurrence();
DROP TRIGGER card_recurring_charges_integrity_check ON card_recurring_charges;
ALTER TABLE card_purchases
  DROP CONSTRAINT card_purchases_recurrence_check,
  DROP CONSTRAINT card_purchases_recurrence_rule_id_fkey,
  DROP COLUMN occurrence,
  DROP COLUMN recurrence_rule_id,
  DROP COLUMN contract_id;
DROP TRIGGER recurrence_rules_integrity_check ON recurrence_rules;
DROP TRIGGER titles_recurrence_integrity_check ON titles;
DELETE FROM recurrence_rules r USING caixas c WHERE c.id = r.caixa_id AND c.kind = 'credit_card';
DROP TABLE card_recurring_charge_amounts;
DROP TABLE card_recurring_charges;
DROP FUNCTION card_recurring_charge_amount(uuid, integer);
DROP FUNCTION card_recurring_charges_validate();
DROP FUNCTION audit_row_keyed();
DROP FUNCTION recurrence_rule_integrity_check();
DROP FUNCTION recurrence_rule_assert(uuid);

CREATE OR REPLACE FUNCTION recurrence_rules_validate() RETURNS trigger
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

-- Notificações e linhas
DELETE FROM notifications WHERE kind = 'contract_charge_missing';
ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment',
    'ai_budget_alert', 'ai_awaiting_approval'));
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending, contract_readjustment, ai_budget_alert (spec 028; dedup por orçamento, mês e limiar) ou '
  'ai_awaiting_approval (spec 029: tarefa agendada ou conciliação com IA esperando aprovação).';

ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_supersede_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;
UPDATE statement_lines SET auto_settled = false WHERE auto_settled AND created_entry = 'purchase';
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_supersede_validate;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;
ALTER TABLE statement_lines
  DROP CONSTRAINT statement_lines_auto_settled_check,
  ADD CONSTRAINT statement_lines_auto_settled_check CHECK (
    NOT auto_settled OR (status = 'matched' AND coalesce(created_entry IN ('settlement', 'transfer_settlement'), false))
  );
COMMENT ON COLUMN statement_lines.auto_settled IS
  'A baixa desta linha foi feita sem confirmação (contracts.auto_settle, spec 033). Só em matched com created_entry '
  'settlement ou transfer_settlement; a aplicação limpa junto com created_entry.';

-- Contratos: colunas da 033 (ajustes da primeira série do contrato), status e as tarefas fechadas reabertas.
ALTER TABLE contracts
  DROP CONSTRAINT contracts_status_check,
  DROP CONSTRAINT contracts_ends_on_check,
  DROP CONSTRAINT contracts_ended_term_check,
  DROP CONSTRAINT contracts_terminated_on_check,
  ADD CONSTRAINT contracts_status_check CHECK (status IN ('draft', 'active', 'renewal_pending', 'ended', 'terminated')),
  ADD COLUMN payment_account_id     uuid REFERENCES financial_accounts (id),
  ADD COLUMN transit_account_id     uuid REFERENCES financial_accounts (id),
  ADD COLUMN late_fee_percent       numeric(6,4),
  ADD COLUMN interest_month_percent numeric(6,4),
  ADD COLUMN early_discount_percent numeric(6,4),
  ADD COLUMN tolerance_cents        bigint   NOT NULL DEFAULT 0,
  ADD COLUMN match_window_days      smallint NOT NULL DEFAULT 15,
  ADD COLUMN auto_settle            boolean  NOT NULL DEFAULT false,
  ADD CONSTRAINT contracts_late_fee_percent_check CHECK (late_fee_percent BETWEEN 0 AND 20),
  ADD CONSTRAINT contracts_interest_month_percent_check CHECK (interest_month_percent BETWEEN 0 AND 10),
  ADD CONSTRAINT contracts_early_discount_percent_check CHECK (early_discount_percent BETWEEN 0 AND 50),
  ADD CONSTRAINT contracts_tolerance_cents_check CHECK (tolerance_cents >= 0),
  ADD CONSTRAINT contracts_match_window_days_check CHECK (match_window_days BETWEEN 0 AND 45);
DROP INDEX contracts_ends_on_idx;
CREATE INDEX contracts_payment_account_id_idx ON contracts (payment_account_id);
CREATE INDEX contracts_transit_account_id_idx ON contracts (transit_account_id);

UPDATE contracts k
   SET late_fee_percent = r.late_fee_percent, interest_month_percent = r.interest_month_percent,
       early_discount_percent = r.early_discount_percent, tolerance_cents = r.tolerance_cents,
       match_window_days = r.match_window_days, auto_settle = r.auto_settle
  FROM (SELECT DISTINCT ON (x.contract_id) x.* FROM recurrence_rules x WHERE x.contract_id IS NOT NULL
         ORDER BY x.contract_id, x.created_at, x.id) r
 WHERE r.contract_id = k.id;

CREATE OR REPLACE FUNCTION contracts_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cx       caixas;
  cp       caixas;
  cat_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'contracts: only draft contracts can be deleted (contract %, status %)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_delete_check';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'contracts: direction cannot change (contract %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_direction_immutable_check';
    END IF;
    IF OLD.status <> 'draft' AND (NEW.caixa_id <> OLD.caixa_id OR NEW.entity_id <> OLD.entity_id) THEN
      RAISE EXCEPTION 'contracts: caixa and entity only change in draft (contract %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_party_immutable_check';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'active')
      OR (OLD.status = 'active' AND NEW.status IN ('renewal_pending', 'ended', 'terminated'))
      OR (OLD.status = 'renewal_pending' AND NEW.status IN ('active', 'ended', 'terminated'))
      OR (OLD.status = 'ended' AND NEW.status IN ('active', 'renewal_pending'))) THEN
      RAISE EXCEPTION 'contracts: status cannot go from % to % (contract %)', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_status_transition_check';
    END IF;
  END IF;

  SELECT * INTO cx FROM caixas c WHERE c.id = NEW.caixa_id;
  IF FOUND THEN
    IF cx.kind <> 'general' THEN
      RAISE EXCEPTION 'contracts: caixa % must be general', NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_caixa_kind_check';
    END IF;
    IF cx.holder_entity_id = NEW.entity_id THEN
      RAISE EXCEPTION 'contracts: counterparty % is the holder of caixa %', NEW.entity_id, NEW.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_entity_check';
    END IF;
  END IF;

  SELECT c.kind INTO cat_kind FROM categories c WHERE c.id = NEW.category_id;
  IF cat_kind IS NOT NULL
     AND cat_kind <> (CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END) THEN
    RAISE EXCEPTION 'contracts: % contract requires % category, got %', NEW.direction,
      CASE NEW.direction WHEN 'payable' THEN 'expense' ELSE 'income' END, cat_kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_category_kind_check';
  END IF;

  IF NEW.counterparty_caixa_id IS NOT NULL THEN
    SELECT * INTO cp FROM caixas c WHERE c.id = NEW.counterparty_caixa_id;
    IF FOUND AND (cp.kind <> 'general' OR cp.holder_entity_id <> NEW.entity_id) THEN
      RAISE EXCEPTION 'contracts: counterparty caixa % must be general and held by entity %',
        NEW.counterparty_caixa_id, NEW.entity_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_counterparty_caixa_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- Ciclos: as vigências sem os campos do ciclo de parcelas não existiam (e quem aponta para elas sai junto).
DELETE FROM contract_renewal_tasks k USING contract_cycles y
 WHERE y.duration_months IS NULL AND y.id IN (k.contract_cycle_id, k.new_cycle_id);
UPDATE contract_amendments a
   SET contract_cycle_id = (SELECT y.id FROM contract_cycles y
                             WHERE y.contract_id = a.contract_id AND y.duration_months IS NOT NULL
                             ORDER BY (a.effective_on BETWEEN y.starts_on AND y.ends_on) DESC, y.seq DESC LIMIT 1)
 WHERE a.contract_cycle_id IS NULL
    OR a.contract_cycle_id IN (SELECT y.id FROM contract_cycles y WHERE y.duration_months IS NULL);
DELETE FROM contract_amendments WHERE contract_cycle_id IS NULL;
UPDATE titles SET contract_cycle_id = NULL, contract_installment = NULL
 WHERE contract_cycle_id IN (SELECT y.id FROM contract_cycles y WHERE y.duration_months IS NULL);
DELETE FROM contract_cycles WHERE duration_months IS NULL;

ALTER TABLE contract_amendments
  DROP CONSTRAINT contract_amendments_rule_ids_check,
  DROP COLUMN recurrence_rule_ids,
  ALTER COLUMN contract_cycle_id SET NOT NULL;
COMMENT ON COLUMN contract_amendments.contract_cycle_id IS 'Ciclo aditado (do mesmo contrato).';

-- Tarefas: closed volta a open (com o contrato vigente em renovação pendente) ou, com o contrato já encerrado ou
-- rescindido, a declined.
ALTER TABLE contract_renewal_tasks
  DROP CONSTRAINT contract_renewal_tasks_status_check,
  ADD CONSTRAINT contract_renewal_tasks_status_check CHECK (status IN ('open', 'approved', 'declined', 'closed')),
  ALTER COLUMN status SET DEFAULT 'open';
ALTER TABLE contract_renewal_tasks DISABLE TRIGGER contract_renewal_tasks_validate;  -- closed é final no modelo novo
UPDATE contract_renewal_tasks k SET status = CASE WHEN c.status = 'active' THEN 'open' ELSE 'declined' END,
       decided_at = CASE WHEN c.status = 'active' THEN NULL ELSE k.decided_at END
  FROM contracts c WHERE c.id = k.contract_id AND k.status = 'closed';
ALTER TABLE contract_renewal_tasks ENABLE TRIGGER contract_renewal_tasks_validate;
UPDATE contracts c SET status = 'renewal_pending'
 WHERE c.status = 'active' AND EXISTS (SELECT 1 FROM contract_renewal_tasks k WHERE k.contract_id = c.id AND k.status = 'open');
ALTER TABLE contract_renewal_tasks
  DROP CONSTRAINT contract_renewal_tasks_status_check,
  DROP CONSTRAINT contract_renewal_tasks_decision_check,
  ADD CONSTRAINT contract_renewal_tasks_status_check CHECK (status IN ('open', 'approved', 'declined')),
  ADD CONSTRAINT contract_renewal_tasks_decision_check CHECK (
    CASE status
      WHEN 'open' THEN decided_at IS NULL AND new_cycle_id IS NULL
      WHEN 'approved' THEN decided_at IS NOT NULL AND new_cycle_id IS NOT NULL
      WHEN 'declined' THEN decided_at IS NOT NULL AND new_cycle_id IS NULL
    END
  );
CREATE UNIQUE INDEX contract_renewal_tasks_open_key ON contract_renewal_tasks (contract_id) WHERE status = 'open';
CREATE INDEX contract_renewal_tasks_due_on_idx ON contract_renewal_tasks (due_on) WHERE status = 'open';
COMMENT ON TABLE contract_renewal_tasks IS
  'Tarefa de renovação de um ciclo (uma por ciclo; no máximo uma open por contrato). Aprovada pelo usuário (cria o '
  'ciclo seguinte, new_cycle_id) ou recusada; decidida é final. Contrato renewal_pending ⇔ tarefa open (no COMMIT).';
COMMENT ON COLUMN contract_renewal_tasks.status IS 'open → approved (decided_at e new_cycle_id) | declined (decided_at). Decidida é final.';

-- Ciclos: ends_on e installments_count voltam a ser gerados (recriados no fim da tabela).
DROP TRIGGER contract_cycles_contiguous_check ON contract_cycles;
DROP TRIGGER contract_cycles_fill ON contract_cycles;
DROP FUNCTION contract_cycles_fill();
ALTER TABLE contract_cycles
  DROP CONSTRAINT contract_cycles_legacy_check,
  DROP CONSTRAINT contract_cycles_ends_on_check,
  DROP COLUMN ends_on,
  DROP COLUMN installments_count,
  ALTER COLUMN duration_months SET NOT NULL,
  ALTER COLUMN periodicity SET NOT NULL,
  ALTER COLUMN total_cents SET NOT NULL,
  ALTER COLUMN due_day SET NOT NULL;
ALTER TABLE contract_cycles
  ADD COLUMN ends_on date NOT NULL GENERATED ALWAYS AS (
    CASE WHEN extract(day FROM starts_on + make_interval(months => duration_months)) < extract(day FROM starts_on)
         THEN (starts_on + make_interval(months => duration_months))::date
         ELSE (starts_on + make_interval(months => duration_months))::date - 1
    END) STORED,
  ADD COLUMN installments_count smallint NOT NULL GENERATED ALWAYS AS (
    (CASE periodicity
       WHEN 'monthly' THEN duration_months
       WHEN 'quarterly' THEN duration_months / 3
       WHEN 'semiannual' THEN duration_months / 6
       WHEN 'annual' THEN duration_months / 12
       ELSE 1
     END)::smallint) STORED,
  DROP CONSTRAINT IF EXISTS contract_cycles_total_cents_check,
  ADD CONSTRAINT contract_cycles_total_cents_check CHECK (total_cents > 0 AND total_cents >= installments_count);
CREATE OR REPLACE FUNCTION contract_cycles_assert(p_contract_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r        record;
  prev_seq int := 0;
  prev_end date;
BEGIN
  FOR r IN SELECT y.seq, y.starts_on, y.ends_on FROM contract_cycles y WHERE y.contract_id = p_contract_id ORDER BY y.seq LOOP
    IF r.seq <> prev_seq + 1 OR (prev_end IS NOT NULL AND r.starts_on <> prev_end + 1) THEN
      RAISE EXCEPTION 'contract_cycles: cycle % of contract % must start on the day after cycle % ends (%)',
        r.seq, p_contract_id, prev_seq, prev_end
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_contiguous_check';
    END IF;
    prev_seq := r.seq;
    prev_end := r.ends_on;
  END LOOP;
END
$$;
CREATE CONSTRAINT TRIGGER contract_cycles_contiguous_check
  AFTER INSERT OR DELETE OR UPDATE OF seq, starts_on, duration_months ON contract_cycles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_cycles_contiguous_check();
COMMENT ON TABLE contract_cycles IS
  'Ciclos (vigências) de um contrato, seq 1, 2, 3… contíguos (o seguinte começa no dia seguinte ao fim do anterior; '
  'checado no COMMIT). Com títulos ligados, starts_on, duration_months e periodicity ficam imutáveis.';
COMMENT ON COLUMN contract_cycles.duration_months IS 'Duração em meses (1–120), múltipla dos meses do período (single aceita qualquer).';
COMMENT ON COLUMN contract_cycles.ends_on IS
  'Gerada: x = starts_on + duration_months meses; x se o dia não existe no mês final (31/01 + 1 → 28/02, o seguinte '
  'começa em 01/03), senão x − 1 dia (01/03/2025 + 12 → 28/02/2026; 29/01/2024 + 1 → 28/02/2024).';
COMMENT ON COLUMN contract_cycles.installments_count IS 'Gerada: número de parcelas = duração ÷ meses do período (single = 1).';

-- Títulos: as séries de contrato voltam a parcelas (origin contract; as que não são da caixa do contrato perdem o
-- contrato), os avulsos ligados também; a conta prevista volta a ser corrente/poupança da caixa, sem passagem.
UPDATE titles t SET contract_id = NULL
  FROM contracts k
 WHERE k.id = t.contract_id AND t.recurrence_rule_id IS NOT NULL
   AND t.recurrence_rule_id IN (SELECT r.id FROM recurrence_rules r JOIN contracts c ON c.id = r.contract_id
                                 WHERE r.caixa_id <> c.caixa_id);
UPDATE recurrence_rules r SET contract_id = NULL
  FROM contracts c WHERE c.id = r.contract_id AND r.caixa_id <> c.caixa_id;
ALTER TABLE titles
  DROP CONSTRAINT titles_contract_check,
  DROP CONSTRAINT titles_origin_check,
  ADD CONSTRAINT titles_origin_check CHECK (origin IN ('manual', 'recurrence', 'card_invoice', 'contract')),
  ADD COLUMN planned_transit_account_id uuid REFERENCES financial_accounts (id);
UPDATE titles SET origin = 'contract', recurrence_rule_id = NULL, occurrence = NULL
 WHERE contract_id IS NOT NULL AND origin IN ('manual', 'recurrence');
UPDATE titles t SET planned_account_id = NULL
  FROM financial_accounts a WHERE a.id = t.planned_account_id AND a.kind NOT IN ('checking', 'savings');
DELETE FROM recurrence_rules r
 WHERE r.contract_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM titles t WHERE t.recurrence_rule_id = r.id);

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE titles
  ADD CONSTRAINT titles_contract_check CHECK (
    (origin = 'contract') = (contract_id IS NOT NULL)
    AND (contract_cycle_id IS NULL) = (contract_installment IS NULL)
    AND (contract_cycle_id IS NULL OR contract_id IS NOT NULL)
  );
CREATE INDEX titles_planned_transit_account_id_idx ON titles (planned_transit_account_id)
  WHERE planned_transit_account_id IS NOT NULL;

CREATE FUNCTION payment_accounts_assert(p_caixa_id uuid, p_account_id uuid, p_transit_id uuid,
                                        p_what text, p_account_constraint text, p_transit_constraint text)
RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  acc financial_accounts;
  tr  financial_accounts;
BEGIN
  IF p_account_id IS NULL THEN
    IF p_transit_id IS NOT NULL THEN
      RAISE EXCEPTION '%: a transit account needs a payment account', p_what
        USING ERRCODE = 'check_violation', CONSTRAINT = p_transit_constraint;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO acc FROM financial_accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    RETURN;  -- a FK recusa
  END IF;
  IF acc.kind NOT IN ('checking', 'savings') THEN
    RAISE EXCEPTION '%: payment account % must be checking or savings (got %)', p_what, acc.id, acc.kind
      USING ERRCODE = 'check_violation', CONSTRAINT = p_account_constraint;
  END IF;

  IF acc.caixa_id = p_caixa_id THEN
    IF p_transit_id IS NOT NULL THEN
      RAISE EXCEPTION '%: payment account % is in caixa %, so there is no transit account', p_what, acc.id, p_caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = p_transit_constraint;
    END IF;
    RETURN;
  END IF;

  IF p_transit_id IS NULL THEN
    RAISE EXCEPTION '%: payment account % is in another caixa and needs a transit account of caixa %',
      p_what, acc.id, p_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = p_transit_constraint;
  END IF;
  SELECT * INTO tr FROM financial_accounts a WHERE a.id = p_transit_id;
  IF FOUND AND tr.caixa_id <> p_caixa_id THEN
    RAISE EXCEPTION '%: transit account % must be in caixa %', p_what, tr.id, p_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = p_transit_constraint;
  END IF;
END
$$;
COMMENT ON FUNCTION payment_accounts_assert(uuid, uuid, uuid, text, text, text) IS
  'Usada pelos triggers de contracts e titles (spec 033; roda como quem escreve, por isso sem REVOKE):conta de pagamento checking/savings de qualquer caixa; a de passagem obrigatória '
  'quando a conta é de outra caixa, nula senão, sempre da caixa dona. 23514 com o nome de constraint informado.';

CREATE FUNCTION contracts_validate_accounts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM payment_accounts_assert(NEW.caixa_id, NEW.payment_account_id, NEW.transit_account_id, 'contracts',
                                  'contracts_payment_account_check', 'contracts_transit_account_check');
  RETURN NEW;
END
$$;
CREATE TRIGGER contracts_validate_accounts
  BEFORE INSERT OR UPDATE OF caixa_id, payment_account_id, transit_account_id ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_validate_accounts();

DROP TRIGGER titles_validate_planned_account ON titles;
CREATE OR REPLACE FUNCTION titles_validate_planned_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM payment_accounts_assert(NEW.caixa_id, NEW.planned_account_id, NEW.planned_transit_account_id, 'titles',
                                  'titles_planned_account_check', 'titles_planned_transit_account_check');
  RETURN NEW;
END
$$;
CREATE TRIGGER titles_validate_planned_account
  BEFORE INSERT OR UPDATE OF caixa_id, planned_account_id, planned_transit_account_id ON titles
  FOR EACH ROW EXECUTE FUNCTION titles_validate_planned_account();

CREATE OR REPLACE FUNCTION financial_accounts_validate_payment_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.caixa_id <> OLD.caixa_id OR NEW.kind NOT IN ('checking', 'savings') THEN
    IF EXISTS (SELECT 1 FROM contracts c WHERE c.payment_account_id = OLD.id) THEN
      RAISE EXCEPTION 'financial_accounts: account % is the installments account of a contract and must stay a '
                      'checking/savings account of caixa %', OLD.id, OLD.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_payment_account_check';
    END IF;
    IF EXISTS (SELECT 1 FROM titles t WHERE t.planned_account_id = OLD.id) THEN
      RAISE EXCEPTION 'financial_accounts: account % is the planned account of a title and must stay a '
                      'checking/savings account of caixa %', OLD.id, OLD.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_planned_account_check';
    END IF;
  END IF;
  IF NEW.caixa_id <> OLD.caixa_id THEN
    IF EXISTS (SELECT 1 FROM contracts c WHERE c.transit_account_id = OLD.id) THEN
      RAISE EXCEPTION 'financial_accounts: account % is the transit account of a contract and cannot change caixa', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_transit_account_check';
    END IF;
    IF EXISTS (SELECT 1 FROM titles t WHERE t.planned_transit_account_id = OLD.id) THEN
      RAISE EXCEPTION 'financial_accounts: account % is the planned transit account of a title and cannot change caixa', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_planned_transit_account_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER financial_accounts_validate_payment_refs ON financial_accounts;
CREATE TRIGGER financial_accounts_validate_payment_refs BEFORE UPDATE OF caixa_id, kind ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_accounts_validate_payment_refs();

CREATE OR REPLACE FUNCTION titles_validate_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c     contracts;
  total smallint;
BEGIN
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM contracts k WHERE k.id = NEW.contract_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;

  IF NEW.mirror_status IS NULL THEN
    -- Lado original: na caixa do contrato; a parcela segue direção e contraparte do contrato.
    IF NEW.caixa_id <> c.caixa_id THEN
      RAISE EXCEPTION 'titles: contract % title must be in the contract caixa %', c.id, c.caixa_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_caixa_check';
    END IF;
    IF NEW.contract_cycle_id IS NOT NULL AND (NEW.direction <> c.direction OR NEW.entity_id <> c.entity_id) THEN
      RAISE EXCEPTION 'titles: contract % installment must be % with entity %', c.id, c.direction, c.entity_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_match_check';
    END IF;
  ELSIF NEW.counterparty_caixa_id IS DISTINCT FROM c.caixa_id THEN
    -- Lado espelho: o outro lado está na caixa do contrato.
    RAISE EXCEPTION 'titles: mirror of contract % title must point to the contract caixa %', c.id, c.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_caixa_check';
  END IF;

  IF NEW.contract_cycle_id IS NOT NULL THEN
    SELECT y.installments_count INTO total FROM contract_cycles y WHERE y.id = NEW.contract_cycle_id;
    IF NEW.contract_installment > total THEN
      RAISE EXCEPTION 'titles: installment % exceeds the % installments of cycle %', NEW.contract_installment, total,
        NEW.contract_cycle_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'titles_contract_installment_total_check';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
DROP TRIGGER titles_validate_contract ON titles;
CREATE TRIGGER titles_validate_contract
  BEFORE INSERT OR UPDATE OF contract_id, contract_cycle_id, contract_installment, caixa_id, direction, entity_id,
                             counterparty_caixa_id, mirror_status
  ON titles FOR EACH ROW EXECUTE FUNCTION titles_validate_contract();

COMMENT ON COLUMN titles.origin IS
  'manual, recurrence (gerado por recurrence_rules), card_invoice (fatura de cartão, F2) ou contract (parcela ou título '
  'extra de um contrato, F5). O espelho herda a origem do original.';
COMMENT ON COLUMN titles.contract_id IS
  'Contrato (origin = contract). O lado original fica na caixa do contrato; o espelho aponta para ela em counterparty_caixa_id.';
COMMENT ON COLUMN titles.contract_cycle_id IS
  'Ciclo da parcela. Nulo num título de contrato = título extra ligado a ele (multa, valor rescisório; qualquer direção).';
COMMENT ON COLUMN titles.contract_installment IS 'Número da parcela n no ciclo (N = contract_cycles.installments_count).';
COMMENT ON COLUMN titles.planned_account_id IS
  'Conta prevista (spec 033): checking/savings da caixa do título ou de outra caixa. O contrato preenche nas parcelas; '
  'vale em qualquer título. O espelho tem a dele.';
COMMENT ON COLUMN titles.planned_transit_account_id IS
  'Conta de passagem da conta prevista: da caixa do título, obrigatória quando planned_account_id é de outra caixa e nula senão.';
COMMENT ON COLUMN titles.planned_account_custom IS
  'A conta prevista foi escolhida na parcela: trocar a conta do contrato não a muda. Padrão false (segue o contrato).';

-- Checagens do contrato no COMMIT: renewal_pending ⇔ tarefa open; rascunho sem títulos.
DROP TRIGGER contracts_integrity_check ON contracts;
CREATE OR REPLACE FUNCTION contract_assert(p_contract_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT k.status INTO st FROM contracts k WHERE k.id = p_contract_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF (st = 'renewal_pending')
     <> EXISTS (SELECT 1 FROM contract_renewal_tasks r WHERE r.contract_id = p_contract_id AND r.status = 'open') THEN
    RAISE EXCEPTION 'contracts: contract % is % but % an open renewal task', p_contract_id, st,
      CASE WHEN st = 'renewal_pending' THEN 'has no' ELSE 'has' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_renewal_pending_check';
  END IF;
  IF st = 'draft' AND EXISTS (SELECT 1 FROM titles t WHERE t.contract_id = p_contract_id) THEN
    RAISE EXCEPTION 'contracts: draft contract % cannot have titles', p_contract_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contracts_draft_titles_check';
  END IF;
END
$$;
COMMENT ON FUNCTION contract_assert(uuid) IS
  'Interna (constraint triggers no COMMIT): contrato renewal_pending ⇔ tarefa de renovação open '
  '(contracts_renewal_pending_check) e rascunho sem títulos (contracts_draft_titles_check).';
CREATE CONSTRAINT TRIGGER contracts_renewal_pending_check
  AFTER INSERT OR UPDATE OF status ON contracts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contracts_status_integrity_check();
CREATE CONSTRAINT TRIGGER contract_renewal_tasks_integrity_check
  AFTER INSERT OR DELETE OR UPDATE OF status, contract_id ON contract_renewal_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_refs_integrity_check();

-- Leitura da 0051.
CREATE FUNCTION contract_payments(
  p_contract_id uuid,
  p_cycle_id    uuid DEFAULT NULL,
  p_today       date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
RETURNS TABLE (
  title_id                   uuid,
  contract_cycle_id          uuid,
  cycle_seq                  integer,
  installment                integer,
  installments_count         integer,
  competence_date            date,
  due_date                   date,
  amount_cents               bigint,
  status                     text,
  settled_cents              bigint,
  open_cents                 bigint,
  interest_cents             bigint,
  fine_cents                 bigint,
  discount_cents             bigint,
  cash_cents                 bigint,
  settlement_count           integer,
  last_settled_on            date,
  paid_on                    date,
  days                       integer,
  overdue                    boolean,
  account_id                 uuid,
  funding_account_id         uuid,
  planned_account_id         uuid,
  planned_transit_account_id uuid,
  planned_account_custom     boolean,
  last_origin                text,
  settlements                jsonb
)
LANGUAGE sql STABLE AS $$
  WITH parcels AS (
    SELECT t.*, y.seq AS y_seq, y.installments_count AS y_count
      FROM titles t
      JOIN contract_cycles y ON y.id = t.contract_cycle_id
     WHERE t.contract_id = p_contract_id
       AND (p_cycle_id IS NULL OR t.contract_cycle_id = p_cycle_id)
       AND t.mirror_status IS NULL           -- o lado do contrato (o espelho repete as baixas)
       AND t.status <> 'canceled'
  ), legs AS (
    SELECT s.id, s.title_id, s.settled_on, s.amount_cents, s.interest_cents, s.fine_cents, s.discount_cents,
           s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents AS cash_cents,
           s.financial_account_id,
           tr.id AS transfer_id,
           CASE p.direction WHEN 'payable' THEN tr.from_account_id ELSE tr.to_account_id END AS funding_account_id,
           ln.id AS statement_line_id,
           CASE WHEN ln.auto_settled THEN 'auto'
                WHEN ln.created_entry IN ('title', 'settlement', 'transfer_settlement') THEN 'reconciliation'
                ELSE 'manual' END AS origin,
           ln.id IS NOT NULL AS reconciled,
           (s.settled_on - p.due_date) AS days
      FROM settlements s
      JOIN parcels p ON p.id = s.title_id
      LEFT JOIN transfers tr ON tr.settlement_id = s.id
      LEFT JOIN LATERAL (
        SELECT l.id, l.auto_settled, l.created_entry
          FROM statement_lines l
          JOIN movements m ON m.id = l.movement_id
         WHERE l.status = 'matched'
           AND (m.settlement_id IN (s.id, s.mirror_settlement_id)
                OR m.transfer_id IN (SELECT x.id FROM transfers x
                                      WHERE x.settlement_id IN (s.id, s.mirror_settlement_id)))
         ORDER BY l.auto_settled DESC, (l.created_entry IS NOT NULL) DESC, l.matched_at, l.id
         LIMIT 1
      ) ln ON true
     WHERE s.reversed_at IS NULL
  ), agg AS (
    SELECT g.title_id,
           sum(g.amount_cents)::bigint   AS settled_cents,
           sum(g.interest_cents)::bigint AS interest_cents,
           sum(g.fine_cents)::bigint     AS fine_cents,
           sum(g.discount_cents)::bigint AS discount_cents,
           sum(g.cash_cents)::bigint     AS cash_cents,
           count(*)::int                 AS settlement_count,
           jsonb_agg(jsonb_build_object(
             'id', g.id, 'settled_on', g.settled_on, 'amount_cents', g.amount_cents,
             'interest_cents', g.interest_cents, 'fine_cents', g.fine_cents, 'discount_cents', g.discount_cents,
             'cash_cents', g.cash_cents, 'financial_account_id', g.financial_account_id,
             'transfer_id', g.transfer_id, 'funding_account_id', g.funding_account_id,
             'statement_line_id', g.statement_line_id, 'reconciled', g.reconciled, 'origin', g.origin,
             'days', g.days) ORDER BY g.settled_on, g.id) AS settlements,
           (array_agg(g.settled_on ORDER BY g.settled_on DESC, g.id DESC))[1]           AS last_settled_on,
           (array_agg(g.financial_account_id ORDER BY g.settled_on DESC, g.id DESC))[1] AS account_id,
           (array_agg(g.funding_account_id ORDER BY g.settled_on DESC, g.id DESC))[1]   AS funding_account_id,
           (array_agg(g.origin ORDER BY g.settled_on DESC, g.id DESC))[1]               AS last_origin
      FROM legs g
     GROUP BY g.title_id
  )
  SELECT p.id, p.contract_cycle_id, p.y_seq::int, p.contract_installment::int, p.y_count::int,
         p.competence_date, p.due_date, p.amount_cents, p.status,
         coalesce(a.settled_cents, 0), p.amount_cents - coalesce(a.settled_cents, 0),
         coalesce(a.interest_cents, 0), coalesce(a.fine_cents, 0), coalesce(a.discount_cents, 0),
         coalesce(a.cash_cents, 0), coalesce(a.settlement_count, 0),
         a.last_settled_on,
         CASE WHEN p.status = 'paid' THEN a.last_settled_on END,
         CASE WHEN p.status = 'paid' THEN a.last_settled_on - p.due_date
              WHEN p.due_date < p_today THEN p_today - p.due_date END,
         p.status <> 'paid' AND p.due_date < p_today,
         a.account_id, a.funding_account_id,
         p.planned_account_id, p.planned_transit_account_id, p.planned_account_custom,
         a.last_origin,
         coalesce(a.settlements, '[]'::jsonb)
    FROM parcels p
    LEFT JOIN agg a ON a.title_id = p.id
   ORDER BY p.y_seq, p.contract_installment
$$;
GRANT EXECUTE ON FUNCTION contract_payments(uuid, uuid, date) TO moneyflow_app;
COMMENT ON FUNCTION contract_payments(uuid, uuid, date) IS
  'Pagamentos das parcelas de um contrato (spec 033): as parcelas não canceladas do lado do contrato, do ciclo '
  'p_cycle_id (nulo = todos), em ordem de ciclo e parcela, com as baixas ativas somadas (principal, juros, multa, '
  'desconto, dinheiro) e uma a uma em settlements (jsonb: id, settled_on, valores, financial_account_id, transfer_id, '
  'funding_account_id = a conta da outra caixa que pagou pela transferência, statement_line_id, reconciled, origin '
  'manual|reconciliation|auto, days). paid_on = data da última baixa ativa do título pago; days = paid_on − vencimento '
  '(+ atraso, − adiantamento) ou, em aberto/parcial vencido, p_today − vencimento (overdue); nulo no prazo. account_id, '
  'funding_account_id e last_origin são os da última baixa ativa. p_today padrão = hoje em America/Sao_Paulo. '
  'SECURITY INVOKER; quem pode ler o contrato é checado pela aplicação, que monta o resumo.';

COMMENT ON TABLE contracts IS
  'Contratos (spec 020): acordo com uma entidade dentro de uma caixa general. Gera os títulos das parcelas por ciclo '
  '(contract_cycles); documentos, aditivos e tarefas de renovação ficam nas tabelas contract_*. Só rascunho é excluído.';
COMMENT ON COLUMN contracts.status IS
  'draft (sem títulos) → active; active → renewal_pending | ended | terminated; renewal_pending → active | ended | '
  'terminated; ended → active | renewal_pending; terminated é final; nada volta para draft. renewal_pending ⇔ existe '
  'tarefa de renovação open (checado no COMMIT).';
COMMENT ON COLUMN contracts.terminated_on IS 'Data de encerramento da rescisão; preenchida se e somente se status = terminated.';
COMMENT ON COLUMN contracts.payment_account_id IS
  'Conta das parcelas (spec 033): checking/savings onde o pagamento sai ou o recebimento entra, da caixa do contrato ou '
  'de outra caixa (a pagadora; a permissão é da aplicação). Nula = sem conta. Copiada para titles.planned_account_id.';
COMMENT ON COLUMN contracts.transit_account_id IS
  'Conta de passagem (spec 033): da caixa do contrato, obrigatória quando payment_account_id é de outra caixa e nula '
  'senão. A baixa da parcela é nela, com a transferência a partir da conta das parcelas.';
COMMENT ON COLUMN contracts.late_fee_percent IS 'Multa por atraso (0–20%) sobre a parcela, uma vez. Nula = sem. Só para reconhecer o valor pago.';
COMMENT ON COLUMN contracts.interest_month_percent IS 'Juros de mora (0–10% ao mês), pró-rata por dia (mês = 30 dias). Nulo = sem.';
COMMENT ON COLUMN contracts.early_discount_percent IS 'Desconto por pontualidade (0–50%) até o vencimento. Nulo = sem.';
COMMENT ON COLUMN contracts.tolerance_cents IS
  'Diferença aceita além dos encargos (≥ 0, padrão 0). O teto de 10% da parcela é da aplicação (o valor da parcela muda por ciclo e aditivo).';
COMMENT ON COLUMN contracts.match_window_days IS 'Janela da conciliação em dias em torno do vencimento (0–45, padrão 15), além do mês do vencimento.';
COMMENT ON COLUMN contracts.auto_settle IS
  'Baixar sem confirmação: a linha com um único candidato, parcela deste contrato na conta prevista e valor exato ou '
  'dentro dos encargos/desconto vira conciliada direto (statement_lines.auto_settled).';

ALTER TABLE contracts DROP COLUMN starts_on, DROP COLUMN ends_on;

-- Séries: sem caixa, contrato e ajustes.
DROP INDEX recurrence_rules_contract_id_idx;
DROP INDEX recurrence_rules_caixa_id_idx;
ALTER TABLE recurrence_rules
  DROP CONSTRAINT recurrence_rules_id_caixa_key,
  DROP COLUMN auto_settle,
  DROP COLUMN tolerance_cents,
  DROP COLUMN early_discount_percent,
  DROP COLUMN interest_month_percent,
  DROP COLUMN late_fee_percent,
  DROP COLUMN match_window_days,
  DROP COLUMN contract_id,
  DROP COLUMN caixa_id;
COMMENT ON TABLE recurrence_rules IS
  'Calendário de uma série de títulos (recorrência ou parcelamento). Os títulos apontam para a regra '
  'com titles.occurrence; o worker materializa até 12 meses à frente (spec 005).';

DROP FUNCTION recurrence_occurrence_due(text, integer, integer, date, integer);

SET CONSTRAINTS ALL DEFERRED;
