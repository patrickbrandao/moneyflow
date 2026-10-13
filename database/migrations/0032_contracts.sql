-- migrate:up

-- Contratos (spec 020, fase F5): acordo com uma entidade dentro de uma caixa `general` (eu recebo ou eu pago),
-- com ciclos de vigência que geram os títulos das parcelas (origin = contract), documentos PDF ou markdown
-- versionado, histórico de aditivos e tarefas de renovação aprovadas pelo usuário. Os fluxos (ativar, aditar,
-- renovar, rescindir) ficam na aplicação, numa transação; aqui ficam as invariantes. Erros de regra saem como
-- 23514 com o nome da regra em CONSTRAINT.

-- Contratos ----------------------------------------------------------------------------------------------------------
CREATE TABLE contracts (
  id                        uuid        PRIMARY KEY DEFAULT uuidv7(),
  caixa_id                  uuid        NOT NULL REFERENCES caixas (id),
  entity_id                 uuid        NOT NULL REFERENCES entities (id),
  direction                 text        NOT NULL,
  name                      text        NOT NULL,
  contract_number           text,
  category_id               uuid        NOT NULL REFERENCES categories (id),
  counterparty_caixa_id     uuid        REFERENCES caixas (id),
  status                    text        NOT NULL DEFAULT 'draft',
  auto_renew                boolean     NOT NULL DEFAULT false,
  notice_days               smallint    NOT NULL DEFAULT 30,
  renewal_lead_days         smallint    NOT NULL DEFAULT 60,
  reminder_every_days       smallint    NOT NULL DEFAULT 7,
  readjustment_index        text        NOT NULL DEFAULT 'none',
  readjustment_base_date    date,
  termination_penalty_text  text,
  termination_penalty_cents bigint,
  terminated_on             date,
  termination_notes         text,
  notes                     text,
  created_by                uuid        REFERENCES users (id) ON DELETE SET NULL,
  archived_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contracts_direction_check CHECK (direction IN ('payable', 'receivable')),
  CONSTRAINT contracts_name_check CHECK (btrim(name) <> '' AND length(name) <= 200),
  CONSTRAINT contracts_contract_number_check CHECK (btrim(contract_number) <> '' AND length(contract_number) <= 60),
  CONSTRAINT contracts_counterparty_caixa_check CHECK (counterparty_caixa_id <> caixa_id),
  CONSTRAINT contracts_status_check CHECK (status IN ('draft', 'active', 'renewal_pending', 'ended', 'terminated')),
  CONSTRAINT contracts_notice_days_check CHECK (notice_days BETWEEN 0 AND 365),
  CONSTRAINT contracts_renewal_lead_days_check CHECK (renewal_lead_days BETWEEN 1 AND 365),
  CONSTRAINT contracts_reminder_every_days_check CHECK (reminder_every_days BETWEEN 1 AND 30),
  CONSTRAINT contracts_readjustment_index_check CHECK (readjustment_index IN ('none', 'ipca', 'igpm', 'inpc', 'other')),
  CONSTRAINT contracts_termination_penalty_text_check CHECK (length(termination_penalty_text) <= 2000),
  CONSTRAINT contracts_termination_penalty_cents_check CHECK (termination_penalty_cents > 0),
  CONSTRAINT contracts_terminated_check CHECK ((status = 'terminated') = (terminated_on IS NOT NULL))
);

CREATE INDEX contracts_caixa_id_idx ON contracts (caixa_id);
CREATE INDEX contracts_entity_id_idx ON contracts (entity_id);
CREATE INDEX contracts_category_id_idx ON contracts (category_id);
CREATE INDEX contracts_counterparty_caixa_id_idx ON contracts (counterparty_caixa_id);
CREATE INDEX contracts_status_idx ON contracts (status);
CREATE INDEX contracts_created_by_idx ON contracts (created_by);
-- Número único por caixa, sem distinção de maiúsculas, entre os contratos não arquivados.
CREATE UNIQUE INDEX contracts_contract_number_key ON contracts (caixa_id, lower(contract_number))
  WHERE archived_at IS NULL AND contract_number IS NOT NULL;

CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE contracts IS
  'Contratos (spec 020): acordo com uma entidade dentro de uma caixa general. Gera os títulos das parcelas por ciclo '
  '(contract_cycles); documentos, aditivos e tarefas de renovação ficam nas tabelas contract_*. Só rascunho é excluído.';
COMMENT ON COLUMN contracts.caixa_id IS 'Caixa dona do contrato (sempre general). Imutável fora do rascunho.';
COMMENT ON COLUMN contracts.entity_id IS 'Contraparte (diferente do titular da caixa). Imutável fora do rascunho.';
COMMENT ON COLUMN contracts.direction IS
  'receivable (eu recebo; categoria income) ou payable (eu pago; categoria expense). Imutável; as parcelas seguem.';
COMMENT ON COLUMN contracts.contract_number IS
  'Número do contrato (opcional, até 60), único por caixa sem distinção de maiúsculas entre os não arquivados.';
COMMENT ON COLUMN contracts.category_id IS 'Categoria aplicada às parcelas, compatível com a direção.';
COMMENT ON COLUMN contracts.counterparty_caixa_id IS
  'Caixa onde as parcelas espelham (general, titular = entity_id). Nulo = sem espelho.';
COMMENT ON COLUMN contracts.status IS
  'draft (sem títulos) → active; active → renewal_pending | ended | terminated; renewal_pending → active | ended | '
  'terminated; ended → active | renewal_pending; terminated é final; nada volta para draft. renewal_pending ⇔ existe '
  'tarefa de renovação open (checado no COMMIT).';
COMMENT ON COLUMN contracts.notice_days IS 'Aviso prévio em dias (0–365): prazo para pedir a não renovação ou a rescisão.';
COMMENT ON COLUMN contracts.renewal_lead_days IS 'Antecedência, em dias antes do fim do ciclo, para abrir a tarefa de renovação (1–365).';
COMMENT ON COLUMN contracts.reminder_every_days IS 'Intervalo do lembrete no sino enquanto a renovação estiver pendente (1–30).';
COMMENT ON COLUMN contracts.readjustment_index IS 'Índice de reajuste informativo: none, ipca, igpm, inpc ou other (o sistema não busca índices).';
COMMENT ON COLUMN contracts.readjustment_base_date IS 'Data-base do reajuste (lembrete). Nula = aniversário do contrato.';
COMMENT ON COLUMN contracts.termination_penalty_text IS 'Multa rescisória descrita (até 2000), para consulta no encerramento.';
COMMENT ON COLUMN contracts.termination_penalty_cents IS 'Multa rescisória em valor (> 0), para consulta no encerramento.';
COMMENT ON COLUMN contracts.terminated_on IS 'Data de encerramento da rescisão; preenchida se e somente se status = terminated.';

-- Regras imediatas por linha.
CREATE FUNCTION contracts_validate() RETURNS trigger
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

CREATE TRIGGER contracts_validate BEFORE INSERT OR UPDATE OR DELETE ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_validate();

-- Ciclos (vigências) -------------------------------------------------------------------------------------------------
-- ends_on: x = starts_on + duration_months meses (o Postgres limita ao último dia do mês: 31/01 + 1 mês = 28/02). Se houve
-- esse limite (dia de x < dia do início), o ciclo vai até x, o último dia do mês, e o seguinte começa no dia 1º; senão,
-- até x − 1 dia (01/03/2025 + 12 → 28/02/2026; 31/01 + 1 → 28/02; 31/03 + 1 → 30/04; 29/01/2024 + 1 → 28/02/2024).
CREATE TABLE contract_cycles (
  id                   uuid         PRIMARY KEY DEFAULT uuidv7(),
  contract_id          uuid         NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  seq                  smallint     NOT NULL,
  starts_on            date         NOT NULL,
  duration_months      smallint     NOT NULL,
  ends_on              date         NOT NULL GENERATED ALWAYS AS (
    CASE WHEN extract(day FROM starts_on + make_interval(months => duration_months)) < extract(day FROM starts_on)
         THEN (starts_on + make_interval(months => duration_months))::date
         ELSE (starts_on + make_interval(months => duration_months))::date - 1
    END) STORED,
  periodicity          text         NOT NULL,
  installments_count   smallint     NOT NULL GENERATED ALWAYS AS (
    (CASE periodicity
       WHEN 'monthly' THEN duration_months
       WHEN 'quarterly' THEN duration_months / 3
       WHEN 'semiannual' THEN duration_months / 6
       WHEN 'annual' THEN duration_months / 12
       ELSE 1
     END)::smallint) STORED,
  total_cents          bigint       NOT NULL,
  due_day              smallint     NOT NULL,
  due_month_offset     smallint     NOT NULL DEFAULT 0,
  readjustment_percent numeric(7,4),
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT contract_cycles_seq_check CHECK (seq >= 1),
  CONSTRAINT contract_cycles_duration_months_check CHECK (duration_months BETWEEN 1 AND 120),
  CONSTRAINT contract_cycles_periodicity_check CHECK (periodicity IN ('monthly', 'quarterly', 'semiannual', 'annual', 'single')),
  CONSTRAINT contract_cycles_duration_periodicity_check CHECK (
    duration_months % (CASE periodicity WHEN 'quarterly' THEN 3 WHEN 'semiannual' THEN 6 WHEN 'annual' THEN 12 ELSE 1 END) = 0
  ),
  CONSTRAINT contract_cycles_total_cents_check CHECK (total_cents > 0 AND total_cents >= installments_count),
  CONSTRAINT contract_cycles_due_day_check CHECK (due_day BETWEEN 1 AND 31),
  CONSTRAINT contract_cycles_due_month_offset_check CHECK (due_month_offset BETWEEN 0 AND 3),
  CONSTRAINT contract_cycles_readjustment_percent_check CHECK (readjustment_percent > -100),
  CONSTRAINT contract_cycles_contract_seq_key UNIQUE (contract_id, seq),
  CONSTRAINT contract_cycles_id_contract_key UNIQUE (id, contract_id)
);

CREATE TRIGGER contract_cycles_set_updated_at BEFORE UPDATE ON contract_cycles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE contract_cycles IS
  'Ciclos (vigências) de um contrato, seq 1, 2, 3… contíguos (o seguinte começa no dia seguinte ao fim do anterior; '
  'checado no COMMIT). Com títulos ligados, starts_on, duration_months e periodicity ficam imutáveis.';
COMMENT ON COLUMN contract_cycles.duration_months IS 'Duração em meses (1–120), múltipla dos meses do período (single aceita qualquer).';
COMMENT ON COLUMN contract_cycles.ends_on IS
  'Gerada: x = starts_on + duration_months meses; x se o dia não existe no mês final (31/01 + 1 → 28/02, o seguinte '
  'começa em 01/03), senão x − 1 dia (01/03/2025 + 12 → 28/02/2026; 29/01/2024 + 1 → 28/02/2024).';
COMMENT ON COLUMN contract_cycles.periodicity IS 'monthly (1 mês), quarterly (3), semiannual (6), annual (12) ou single (parcela única no ciclo).';
COMMENT ON COLUMN contract_cycles.installments_count IS 'Gerada: número de parcelas = duração ÷ meses do período (single = 1).';
COMMENT ON COLUMN contract_cycles.total_cents IS
  'Valor total do ciclo (≥ 1 centavo por parcela). Divisão em parcelas iguais com o resto na primeira (aplicação).';
COMMENT ON COLUMN contract_cycles.due_day IS 'Dia de vencimento (1–31; meses curtos usam o último dia).';
COMMENT ON COLUMN contract_cycles.due_month_offset IS 'Meses entre a competência e o vencimento (0–3; ex.: serviço de março vence em abril = 1).';
COMMENT ON COLUMN contract_cycles.readjustment_percent IS 'Reajuste aplicado na renovação ou no aditivo, em % (informativo).';

-- Contiguidade dos ciclos de um contrato: seq sem buracos, cada um começando no dia seguinte ao fim do anterior.
CREATE FUNCTION contract_cycles_assert(p_contract_id uuid) RETURNS void
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

CREATE FUNCTION contract_cycles_contiguous_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM contract_cycles_assert(CASE TG_OP WHEN 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER contract_cycles_contiguous_check
  AFTER INSERT OR DELETE OR UPDATE OF seq, starts_on, duration_months ON contract_cycles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_cycles_contiguous_check();

CREATE FUNCTION contract_cycles_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contract_id <> OLD.contract_id OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'contract_cycles: contract and seq cannot change (cycle %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_immutable_check';
  END IF;
  IF (NEW.starts_on <> OLD.starts_on OR NEW.duration_months <> OLD.duration_months
      OR NEW.periodicity <> OLD.periodicity)
     AND EXISTS (SELECT 1 FROM titles t WHERE t.contract_cycle_id = OLD.id) THEN
    RAISE EXCEPTION 'contract_cycles: cycle % has titles; start, duration and periodicity cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_cycles_locked_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_cycles_validate BEFORE UPDATE ON contract_cycles
  FOR EACH ROW EXECUTE FUNCTION contract_cycles_validate();

-- Títulos gerados pelo contrato ----------------------------------------------------------------------------------------
ALTER TABLE titles
  ADD COLUMN contract_id uuid,
  ADD COLUMN contract_cycle_id uuid,
  ADD COLUMN contract_installment smallint,
  ADD CONSTRAINT titles_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts (id),
  ADD CONSTRAINT titles_contract_cycle_id_fkey FOREIGN KEY (contract_cycle_id, contract_id)
    REFERENCES contract_cycles (id, contract_id),
  ADD CONSTRAINT titles_contract_installment_check CHECK (contract_installment >= 1),
  ADD CONSTRAINT titles_contract_check CHECK (
    (origin = 'contract') = (contract_id IS NOT NULL)
    AND (contract_cycle_id IS NULL) = (contract_installment IS NULL)
    AND (contract_cycle_id IS NULL OR contract_id IS NOT NULL)
  ),
  DROP CONSTRAINT titles_origin_check,
  ADD CONSTRAINT titles_origin_check CHECK (origin IN ('manual', 'recurrence', 'card_invoice', 'contract'));

CREATE INDEX titles_contract_id_idx ON titles (contract_id);
-- Uma parcela por ciclo em cada caixa (o espelho repete ciclo e número na outra caixa); cobre a FK do ciclo.
CREATE UNIQUE INDEX titles_contract_installment_key ON titles (contract_cycle_id, caixa_id, contract_installment);

COMMENT ON COLUMN titles.origin IS
  'manual, recurrence (gerado por recurrence_rules), card_invoice (fatura de cartão, F2) ou contract (parcela ou título '
  'extra de um contrato, F5). O espelho herda a origem do original.';
COMMENT ON COLUMN titles.contract_id IS
  'Contrato (origin = contract). O lado original fica na caixa do contrato; o espelho aponta para ela em counterparty_caixa_id.';
COMMENT ON COLUMN titles.contract_cycle_id IS
  'Ciclo da parcela. Nulo num título de contrato = título extra ligado a ele (multa, valor rescisório; qualquer direção).';
COMMENT ON COLUMN titles.contract_installment IS 'Número da parcela n no ciclo (N = contract_cycles.installments_count).';

CREATE FUNCTION titles_validate_contract() RETURNS trigger
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

CREATE TRIGGER titles_validate_contract
  BEFORE INSERT OR UPDATE OF contract_id, contract_cycle_id, contract_installment, caixa_id, direction, entity_id,
                             counterparty_caixa_id, mirror_status
  ON titles FOR EACH ROW EXECUTE FUNCTION titles_validate_contract();

-- Espelho: os dois lados também têm o mesmo contrato, ciclo e parcela.
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

DROP TRIGGER titles_mirror_check ON titles;
CREATE CONSTRAINT TRIGGER titles_mirror_check
  AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin,
                            recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status,
                            card_invoice_id, contract_id, contract_cycle_id, contract_installment
  ON titles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION titles_mirror_check();

-- Documentos ---------------------------------------------------------------------------------------------------------
CREATE TABLE contract_documents (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  contract_id        uuid        NOT NULL REFERENCES contracts (id),
  kind               text        NOT NULL,
  format             text        NOT NULL,
  title              text        NOT NULL,
  description        text,
  document_date      date,
  attachment_id      uuid        REFERENCES attachments (id),
  current_version_id uuid,
  source_document_id uuid,
  created_by         uuid        REFERENCES users (id) ON DELETE SET NULL,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_documents_kind_check CHECK (kind IN ('contract', 'amendment', 'renewal', 'termination', 'proposal', 'other')),
  CONSTRAINT contract_documents_format_check CHECK (format IN ('pdf', 'markdown')),
  CONSTRAINT contract_documents_title_check CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT contract_documents_format_fields_check CHECK (
    CASE format
      WHEN 'pdf' THEN attachment_id IS NOT NULL AND current_version_id IS NULL AND source_document_id IS NULL
      WHEN 'markdown' THEN attachment_id IS NULL
    END
  ),
  CONSTRAINT contract_documents_id_contract_key UNIQUE (id, contract_id),
  CONSTRAINT contract_documents_source_document_id_fkey FOREIGN KEY (source_document_id, contract_id)
    REFERENCES contract_documents (id, contract_id)
);

CREATE INDEX contract_documents_contract_id_idx ON contract_documents (contract_id);
CREATE INDEX contract_documents_attachment_id_idx ON contract_documents (attachment_id);
CREATE INDEX contract_documents_current_version_id_idx ON contract_documents (current_version_id);
CREATE INDEX contract_documents_source_document_id_idx ON contract_documents (source_document_id);
CREATE INDEX contract_documents_created_by_idx ON contract_documents (created_by);

CREATE TRIGGER contract_documents_set_updated_at BEFORE UPDATE ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE contract_documents IS
  'Documentos de um contrato: PDF (anexo imutável, somente leitura) ou markdown versionado (contract_document_versions; '
  'current_version_id obrigatório no COMMIT). Excluir = arquivar.';
COMMENT ON COLUMN contract_documents.kind IS 'contract, amendment (aditivo), renewal, termination (distrato), proposal ou other.';
COMMENT ON COLUMN contract_documents.format IS 'pdf (attachment_id) ou markdown (versões). Imutável.';
COMMENT ON COLUMN contract_documents.attachment_id IS 'Arquivo do PDF (só em pdf; imutável). Aparece em attachment_links como contract_document.';
COMMENT ON COLUMN contract_documents.current_version_id IS 'Versão atual do markdown (uma versão deste documento). Nulo em pdf.';
COMMENT ON COLUMN contract_documents.source_document_id IS
  'PDF de origem de um markdown gerado por IA (mesmo contrato, formato pdf).';

-- Versões do markdown (imutáveis) -------------------------------------------------------------------------------------
CREATE TABLE contract_document_versions (
  id                       uuid        PRIMARY KEY DEFAULT uuidv7(),
  document_id              uuid        NOT NULL REFERENCES contract_documents (id) ON DELETE CASCADE,
  version                  integer     NOT NULL,
  content                  text        NOT NULL,
  note                     text,
  author_kind              text        NOT NULL DEFAULT 'human',
  author_user_id           uuid        REFERENCES users (id) ON DELETE SET NULL,
  ai_run_id                uuid        REFERENCES ai_runs (id) ON DELETE SET NULL,
  restored_from_version_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_document_versions_version_check CHECK (version >= 1),
  CONSTRAINT contract_document_versions_content_check CHECK (octet_length(content) <= 1048576),
  CONSTRAINT contract_document_versions_note_check CHECK (length(note) <= 500),
  CONSTRAINT contract_document_versions_author_kind_check CHECK (author_kind IN ('human', 'agent')),
  CONSTRAINT contract_document_versions_author_check CHECK (author_kind = 'agent' OR ai_run_id IS NULL),
  CONSTRAINT contract_document_versions_restored_self_check CHECK (restored_from_version_id <> id),
  CONSTRAINT contract_document_versions_document_version_key UNIQUE (document_id, version),
  CONSTRAINT contract_document_versions_id_document_key UNIQUE (id, document_id),
  CONSTRAINT contract_document_versions_restored_from_version_id_fkey FOREIGN KEY (restored_from_version_id, document_id)
    REFERENCES contract_document_versions (id, document_id)
);

CREATE INDEX contract_document_versions_author_user_id_idx ON contract_document_versions (author_user_id);
CREATE INDEX contract_document_versions_ai_run_id_idx ON contract_document_versions (ai_run_id);
CREATE INDEX contract_document_versions_restored_from_version_id_idx ON contract_document_versions (restored_from_version_id);

CREATE TRIGGER contract_document_versions_set_updated_at BEFORE UPDATE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE contract_documents
  ADD CONSTRAINT contract_documents_current_version_id_fkey FOREIGN KEY (current_version_id, id)
    REFERENCES contract_document_versions (id, document_id) DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE contract_document_versions IS
  'Versões de um documento markdown de contrato: cada salvamento cria uma (version 1, 2, 3…; omita version no INSERT e '
  'o banco atribui a próxima, travando o documento). Imutáveis; somem só com o documento. A auditoria grava a linha sem '
  'o content (com content_bytes).';
COMMENT ON COLUMN contract_document_versions.version IS
  'Número da versão no documento, atribuído pelo banco quando omitido; se informado, tem de ser o próximo (max + 1).';
COMMENT ON COLUMN contract_document_versions.content IS 'Markdown (UTF-8, até 1 MB; pode ser vazio).';
COMMENT ON COLUMN contract_document_versions.note IS 'Nota opcional do salvamento (até 500).';
COMMENT ON COLUMN contract_document_versions.author_kind IS 'human (editor, upload, restauração) ou agent (gerado por IA a partir do PDF).';
COMMENT ON COLUMN contract_document_versions.ai_run_id IS 'Execução do agente que gerou a versão (só author_kind = agent; opcional).';
COMMENT ON COLUMN contract_document_versions.restored_from_version_id IS
  'Versão (do mesmo documento) cujo conteúdo foi restaurado nesta.';

-- Documento: formato e arquivo imutáveis; a origem é um PDF do mesmo contrato.
CREATE FUNCTION contract_documents_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src_format text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.contract_id <> OLD.contract_id OR NEW.format <> OLD.format
                           OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id) THEN
    RAISE EXCEPTION 'contract_documents: contract, format and attachment cannot change (document %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_documents_immutable_check';
  END IF;
  IF NEW.source_document_id IS NOT NULL THEN
    SELECT d.format INTO src_format FROM contract_documents d WHERE d.id = NEW.source_document_id;
    IF FOUND AND src_format <> 'pdf' THEN
      RAISE EXCEPTION 'contract_documents: source document % must be a pdf', NEW.source_document_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_documents_source_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_documents_validate BEFORE INSERT OR UPDATE ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION contract_documents_validate();

-- Markdown sem versão atual só no meio da transação.
CREATE FUNCTION contract_documents_current_version_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contract_documents d
              WHERE d.id = NEW.id AND d.format = 'markdown' AND d.current_version_id IS NULL) THEN
    RAISE EXCEPTION 'contract_documents: markdown document % needs a current version', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_documents_current_version_check';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER contract_documents_current_version_check
  AFTER INSERT OR UPDATE OF current_version_id ON contract_documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_documents_current_version_check();

-- Versão: só em markdown, número atribuído pelo banco (trava o documento).
CREATE FUNCTION contract_document_versions_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc_format text;
  next_version integer;
BEGIN
  SELECT d.format INTO doc_format FROM contract_documents d WHERE d.id = NEW.document_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;
  IF doc_format <> 'markdown' THEN
    RAISE EXCEPTION 'contract_document_versions: document % is not markdown', NEW.document_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_document_check';
  END IF;
  SELECT coalesce(max(v.version), 0) + 1 INTO next_version
    FROM contract_document_versions v WHERE v.document_id = NEW.document_id;
  IF NEW.version IS NULL THEN
    NEW.version := next_version;
  ELSIF NEW.version <> next_version THEN
    RAISE EXCEPTION 'contract_document_versions: next version of document % is %, got %', NEW.document_id,
      next_version, NEW.version
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_version_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_document_versions_before_insert BEFORE INSERT ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION contract_document_versions_before_insert();

-- Imutável: só as FKs ON DELETE SET NULL (autor, execução) mudam; DELETE só pela cascata do documento.
CREATE FUNCTION contract_document_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM contract_documents d WHERE d.id = OLD.document_id) THEN
      RAISE EXCEPTION 'contract_document_versions: version % is immutable (archive the document instead)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_immutable_check';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.document_id <> OLD.document_id OR NEW.version <> OLD.version OR NEW.content <> OLD.content
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.author_kind <> OLD.author_kind
     OR NEW.restored_from_version_id IS DISTINCT FROM OLD.restored_from_version_id
     OR NEW.created_at <> OLD.created_at
     OR (NEW.author_user_id IS DISTINCT FROM OLD.author_user_id AND NEW.author_user_id IS NOT NULL)
     OR (NEW.ai_run_id IS DISTINCT FROM OLD.ai_run_id AND NEW.ai_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract_document_versions: version % is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_document_versions_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_document_versions_guard BEFORE UPDATE OR DELETE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION contract_document_versions_guard();

-- Aditivos -----------------------------------------------------------------------------------------------------------
CREATE TABLE contract_amendments (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  contract_id        uuid        NOT NULL REFERENCES contracts (id),
  contract_cycle_id  uuid        NOT NULL,
  document_id        uuid,
  effective_on       date        NOT NULL,
  changes            jsonb       NOT NULL,
  affected_title_ids uuid[]      NOT NULL DEFAULT '{}',
  skipped_title_ids  uuid[]      NOT NULL DEFAULT '{}',
  notes              text,
  created_by         uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_amendments_changes_check CHECK (
    jsonb_typeof(changes) = 'object'
    AND coalesce(jsonb_typeof(changes -> 'before') = 'object', false)
    AND coalesce(jsonb_typeof(changes -> 'after') = 'object', false)
  ),
  CONSTRAINT contract_amendments_title_ids_check CHECK (
    array_position(affected_title_ids, NULL) IS NULL AND array_position(skipped_title_ids, NULL) IS NULL
  ),
  CONSTRAINT contract_amendments_contract_cycle_id_fkey FOREIGN KEY (contract_cycle_id, contract_id)
    REFERENCES contract_cycles (id, contract_id),
  CONSTRAINT contract_amendments_document_id_fkey FOREIGN KEY (document_id, contract_id)
    REFERENCES contract_documents (id, contract_id)
);

CREATE INDEX contract_amendments_contract_id_idx ON contract_amendments (contract_id, effective_on);
CREATE INDEX contract_amendments_contract_cycle_id_idx ON contract_amendments (contract_cycle_id);
CREATE INDEX contract_amendments_document_id_idx ON contract_amendments (document_id);
CREATE INDEX contract_amendments_created_by_idx ON contract_amendments (created_by);

CREATE TRIGGER contract_amendments_set_updated_at BEFORE UPDATE ON contract_amendments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE contract_amendments IS
  'Histórico de aditivos de um contrato (antes → depois). Imutável, exceto document_id e notes.';
COMMENT ON COLUMN contract_amendments.contract_cycle_id IS 'Ciclo aditado (do mesmo contrato).';
COMMENT ON COLUMN contract_amendments.document_id IS 'Documento do aditivo (do mesmo contrato), opcional.';
COMMENT ON COLUMN contract_amendments.effective_on IS 'Data de efeito: parcelas em aberto e sem baixa com competência nela ou depois são recalculadas.';
COMMENT ON COLUMN contract_amendments.changes IS 'O que mudou: {"before": {...}, "after": {...}} (valor, vencimento, deslocamento, categoria…).';
COMMENT ON COLUMN contract_amendments.affected_title_ids IS 'Títulos recalculados pelo aditivo (os dois lados do espelho).';
COMMENT ON COLUMN contract_amendments.skipped_title_ids IS 'Títulos que ficaram como estavam (com baixa ou em mês fechado), mostrados como aviso.';

CREATE FUNCTION contract_amendments_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - '{document_id,notes,created_by,updated_at}'::text[])
     IS DISTINCT FROM (to_jsonb(OLD) - '{document_id,notes,created_by,updated_at}'::text[])
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'contract_amendments: amendment % is immutable (only document_id and notes change)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_amendments_immutable_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_amendments_validate BEFORE UPDATE ON contract_amendments
  FOR EACH ROW EXECUTE FUNCTION contract_amendments_validate();

-- Tarefas de renovação ------------------------------------------------------------------------------------------------
CREATE TABLE contract_renewal_tasks (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  contract_id       uuid        NOT NULL REFERENCES contracts (id),
  contract_cycle_id uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'open',
  opened_on         date        NOT NULL,
  due_on            date        NOT NULL,
  decided_at        timestamptz,
  decided_by        uuid        REFERENCES users (id) ON DELETE SET NULL,
  decision_notes    text,
  new_cycle_id      uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_renewal_tasks_status_check CHECK (status IN ('open', 'approved', 'declined')),
  CONSTRAINT contract_renewal_tasks_decision_check CHECK (
    CASE status
      WHEN 'open' THEN decided_at IS NULL AND new_cycle_id IS NULL
      WHEN 'approved' THEN decided_at IS NOT NULL AND new_cycle_id IS NOT NULL
      WHEN 'declined' THEN decided_at IS NOT NULL AND new_cycle_id IS NULL
    END
  ),
  CONSTRAINT contract_renewal_tasks_new_cycle_self_check CHECK (new_cycle_id <> contract_cycle_id),
  CONSTRAINT contract_renewal_tasks_contract_cycle_id_key UNIQUE (contract_cycle_id),
  CONSTRAINT contract_renewal_tasks_contract_cycle_id_fkey FOREIGN KEY (contract_cycle_id, contract_id)
    REFERENCES contract_cycles (id, contract_id),
  CONSTRAINT contract_renewal_tasks_new_cycle_id_fkey FOREIGN KEY (new_cycle_id, contract_id)
    REFERENCES contract_cycles (id, contract_id)
);

CREATE INDEX contract_renewal_tasks_contract_id_idx ON contract_renewal_tasks (contract_id);
CREATE UNIQUE INDEX contract_renewal_tasks_open_key ON contract_renewal_tasks (contract_id) WHERE status = 'open';
CREATE INDEX contract_renewal_tasks_due_on_idx ON contract_renewal_tasks (due_on) WHERE status = 'open';
CREATE INDEX contract_renewal_tasks_new_cycle_id_idx ON contract_renewal_tasks (new_cycle_id);
CREATE INDEX contract_renewal_tasks_decided_by_idx ON contract_renewal_tasks (decided_by);

CREATE TRIGGER contract_renewal_tasks_set_updated_at BEFORE UPDATE ON contract_renewal_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE contract_renewal_tasks IS
  'Tarefa de renovação de um ciclo (uma por ciclo; no máximo uma open por contrato). Aprovada pelo usuário (cria o '
  'ciclo seguinte, new_cycle_id) ou recusada; decidida é final. Contrato renewal_pending ⇔ tarefa open (no COMMIT).';
COMMENT ON COLUMN contract_renewal_tasks.contract_cycle_id IS 'Ciclo que termina (a renovar).';
COMMENT ON COLUMN contract_renewal_tasks.status IS 'open → approved (decided_at e new_cycle_id) | declined (decided_at). Decidida é final.';
COMMENT ON COLUMN contract_renewal_tasks.opened_on IS 'Quando a tarefa foi aberta (fim do ciclo − renewal_lead_days, ou à mão).';
COMMENT ON COLUMN contract_renewal_tasks.due_on IS 'Fim do ciclo a renovar (= contract_cycles.ends_on); depois disso a tarefa está vencida.';
COMMENT ON COLUMN contract_renewal_tasks.new_cycle_id IS 'Ciclo criado pela aprovação (o seguinte, seq + 1).';

CREATE FUNCTION contract_renewal_tasks_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cyc contract_cycles;
  new_seq smallint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contract_id <> OLD.contract_id OR NEW.contract_cycle_id <> OLD.contract_cycle_id THEN
      RAISE EXCEPTION 'contract_renewal_tasks: contract and cycle cannot change (task %)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_immutable_check';
    END IF;
    IF OLD.status <> 'open'
       AND (NEW.status <> OLD.status OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
            OR NEW.new_cycle_id IS DISTINCT FROM OLD.new_cycle_id
            OR NEW.opened_on <> OLD.opened_on OR NEW.due_on <> OLD.due_on
            OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL)) THEN
      RAISE EXCEPTION 'contract_renewal_tasks: task % was already decided (%)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_final_check';
    END IF;
  END IF;

  SELECT * INTO cyc FROM contract_cycles y WHERE y.id = NEW.contract_cycle_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- a FK reporta o erro.
  END IF;
  IF NEW.due_on <> cyc.ends_on THEN
    RAISE EXCEPTION 'contract_renewal_tasks: due_on % must be the end of cycle % (%)', NEW.due_on, cyc.id, cyc.ends_on
      USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_due_on_check';
  END IF;
  IF NEW.new_cycle_id IS NOT NULL THEN
    SELECT y.seq INTO new_seq FROM contract_cycles y WHERE y.id = NEW.new_cycle_id;
    IF FOUND AND new_seq <> cyc.seq + 1 THEN
      RAISE EXCEPTION 'contract_renewal_tasks: new cycle % must follow cycle % (seq %)', NEW.new_cycle_id, cyc.id, cyc.seq + 1
        USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_renewal_tasks_new_cycle_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER contract_renewal_tasks_validate BEFORE INSERT OR UPDATE ON contract_renewal_tasks
  FOR EACH ROW EXECUTE FUNCTION contract_renewal_tasks_validate();

-- Checagens do contrato no COMMIT -------------------------------------------------------------------------------------
-- renewal_pending ⇔ tarefa open; rascunho sem títulos.
CREATE FUNCTION contract_assert(p_contract_id uuid) RETURNS void
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

CREATE FUNCTION contract_refs_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.contract_id IS NOT NULL THEN
    PERFORM contract_assert(OLD.contract_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.contract_id IS NOT NULL
     AND NEW.contract_id IS DISTINCT FROM (CASE TG_OP WHEN 'UPDATE' THEN OLD.contract_id END) THEN
    PERFORM contract_assert(NEW.contract_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION contracts_status_integrity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM contract_assert(NEW.id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER contracts_renewal_pending_check
  AFTER INSERT OR UPDATE OF status ON contracts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contracts_status_integrity_check();

CREATE CONSTRAINT TRIGGER contract_renewal_tasks_integrity_check
  AFTER INSERT OR DELETE OR UPDATE OF status, contract_id ON contract_renewal_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_refs_integrity_check();

CREATE CONSTRAINT TRIGGER titles_contract_integrity_check
  AFTER INSERT OR UPDATE OF contract_id ON titles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION contract_refs_integrity_check();

-- Anexos: o PDF do documento é uma ligação ----------------------------------------------------------------------------
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
  SELECT attachment_id, 'card_purchase', card_purchase_id FROM card_purchase_attachments
  UNION ALL
  SELECT attachment_id, 'statement_import', id FROM statement_imports
  UNION ALL
  SELECT attachment_id, 'ai_message', message_id FROM ai_message_attachments
  UNION ALL
  SELECT attachment_id, 'contract_document', id FROM contract_documents WHERE attachment_id IS NOT NULL;

-- Mensagens e notificações: eventos de contrato (spec 013) -----------------------------------------------------------
CREATE OR REPLACE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  allowed text[];
  required text[];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  arr jsonb;
  max_days int := 60;
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
    WHEN 'contract_notice_deadline', 'contract_ending' THEN
      allowed := '{days_before,send_at}'; required := '{days_before,send_at}'; max_days := 180;
    WHEN 'contract_renewal_pending' THEN allowed := '{send_at,repeat_every_days}'; required := '{send_at}';
    WHEN 'contract_readjustment' THEN allowed := '{send_at}'; required := '{send_at}';
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
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'days_before') e WHERE e::int > max_days) THEN
    RETURN false;
  END IF;
  IF p_params ? 'thresholds_percent'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_params -> 'thresholds_percent') e
                  WHERE e::int NOT BETWEEN 1 AND 200) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60 no due_reminder e 0–180 em contract_notice_deadline/contract_ending, thresholds_percent '
  '1–200; repeat_every_days 1–30). Usada no CHECK de message_subscriptions.';

ALTER TABLE message_subscriptions
  DROP CONSTRAINT message_subscriptions_event_kind_check,
  ADD CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment'));

ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment', 'test'));

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system',
    'contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment'));

COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message; contratos '
  '(spec 020): contract_notice_deadline (D-N do fim do aviso prévio), contract_ending (D-N do fim do ciclo), '
  'contract_renewal_pending (ao abrir a tarefa e a cada N dias) e contract_readjustment (na data-base).';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed, system, contract_notice_deadline, contract_ending, '
  'contract_renewal_pending ou contract_readjustment.';

-- Auditoria ----------------------------------------------------------------------------------------------------------
-- Versões do markdown: a linha sem o content (até 1 MB por versão), com o tamanho em content_bytes.
CREATE FUNCTION contract_document_versions_audit_row() RETURNS trigger
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
  IF o IS NOT NULL THEN
    o := (o - 'content') || jsonb_build_object('content_bytes', octet_length(OLD.content));
  END IF;
  IF n IS NOT NULL THEN
    n := (n - 'content') || jsonb_build_object('content_bytes', octet_length(NEW.content));
  END IF;
  PERFORM audit_write(TG_TABLE_NAME, lower(TG_OP), o, n, changed);
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION contract_document_versions_audit_row() FROM PUBLIC, moneyflow_app;

COMMENT ON FUNCTION contract_document_versions_audit_row() IS
  'Trigger de auditoria de contract_document_versions: grava a linha sem content (só content_bytes); uma mudança de '
  'content apareceria só em changed_columns.';

CREATE TRIGGER contracts_audit AFTER INSERT OR UPDATE OR DELETE ON contracts
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER contract_cycles_audit AFTER INSERT OR UPDATE OR DELETE ON contract_cycles
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER contract_documents_audit AFTER INSERT OR UPDATE OR DELETE ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER contract_document_versions_audit AFTER INSERT OR UPDATE OR DELETE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION contract_document_versions_audit_row();
CREATE TRIGGER contract_amendments_audit AFTER INSERT OR UPDATE OR DELETE ON contract_amendments
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER contract_renewal_tasks_audit AFTER INSERT OR UPDATE OR DELETE ON contract_renewal_tasks
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- O papel da aplicação tem DML nas tabelas novas (privilégios padrão da 0001); explícito aqui por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON contracts, contract_cycles, contract_documents, contract_document_versions,
  contract_amendments, contract_renewal_tasks TO moneyflow_app;

-- migrate:down

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'agent_completed', 'agent_message', 'mirror_pending', 'mirror_disputed', 'invoice_closed', 'due_reminder',
    'overdue', 'card_limit', 'reconciliation_divergence', 'message_failed', 'system'));
ALTER TABLE message_outbox
  DROP CONSTRAINT message_outbox_event_kind_check,
  ADD CONSTRAINT message_outbox_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message', 'test'));
ALTER TABLE message_subscriptions
  DROP CONSTRAINT message_subscriptions_event_kind_check,
  ADD CONSTRAINT message_subscriptions_event_kind_check CHECK (event_kind IN (
    'due_reminder', 'overdue', 'daily_summary', 'weekly_summary', 'invoice_closed', 'card_limit',
    'reconciliation_divergence', 'agent_completed', 'agent_message'));

COMMENT ON COLUMN message_subscriptions.event_kind IS
  'due_reminder (D-N), overdue (atrasados), daily_summary, weekly_summary, invoice_closed (fatura fechada, valor por '
  'pagadora), card_limit (limite acima de X%), reconciliation_divergence, agent_completed, agent_message.';
COMMENT ON COLUMN notifications.kind IS
  'agent_completed, agent_message, mirror_pending, mirror_disputed, invoice_closed, due_reminder, overdue, card_limit, '
  'reconciliation_divergence, message_failed ou system.';

CREATE OR REPLACE FUNCTION message_subscription_params_valid(p_event_kind text, p_params jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
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
$$;

COMMENT ON FUNCTION message_subscription_params_valid(text, jsonb) IS
  'true se params é válido para o evento (chaves permitidas e obrigatórias, HH:MM, dia ISO, listas de 1–10 inteiros '
  'distintos: days_before 0–60, thresholds_percent 1–200). Usada no CHECK de message_subscriptions.';

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
  SELECT attachment_id, 'card_purchase', card_purchase_id FROM card_purchase_attachments
  UNION ALL
  SELECT attachment_id, 'statement_import', id FROM statement_imports
  UNION ALL
  SELECT attachment_id, 'ai_message', message_id FROM ai_message_attachments;

DROP TRIGGER titles_contract_integrity_check ON titles;
DROP TRIGGER titles_validate_contract ON titles;

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
CREATE CONSTRAINT TRIGGER titles_mirror_check
  AFTER INSERT OR UPDATE OF caixa_id, direction, entity_id, amount_cents, due_date, origin,
                            recurrence_rule_id, occurrence, counterparty_caixa_id, mirror_title_id, mirror_status,
                            card_invoice_id
  ON titles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION titles_mirror_check();

DROP INDEX titles_contract_installment_key;
DROP INDEX titles_contract_id_idx;
ALTER TABLE titles
  DROP CONSTRAINT titles_origin_check,
  ADD CONSTRAINT titles_origin_check CHECK (origin IN ('manual', 'recurrence', 'card_invoice')),
  DROP COLUMN contract_installment,
  DROP COLUMN contract_cycle_id,
  DROP COLUMN contract_id;

COMMENT ON COLUMN titles.origin IS
  'manual, recurrence (gerado por recurrence_rules) ou card_invoice (fatura de cartão, F2). O espelho herda a origem do original.';

DROP TABLE contract_renewal_tasks;
DROP TABLE contract_amendments;
ALTER TABLE contract_documents DROP CONSTRAINT contract_documents_current_version_id_fkey;
DROP TABLE contract_document_versions;
DROP TABLE contract_documents;
DROP TABLE contract_cycles;
DROP TABLE contracts;

DROP FUNCTION contract_document_versions_audit_row();
DROP FUNCTION contracts_status_integrity_check();
DROP FUNCTION contract_refs_integrity_check();
DROP FUNCTION contract_assert(uuid);
DROP FUNCTION contract_renewal_tasks_validate();
DROP FUNCTION contract_amendments_validate();
DROP FUNCTION contract_document_versions_guard();
DROP FUNCTION contract_document_versions_before_insert();
DROP FUNCTION contract_documents_current_version_check();
DROP FUNCTION contract_documents_validate();
DROP FUNCTION titles_validate_contract();
DROP FUNCTION contract_cycles_validate();
DROP FUNCTION contract_cycles_contiguous_check();
DROP FUNCTION contract_cycles_assert(uuid);
DROP FUNCTION contracts_validate();
