-- migrate:up

-- Regras de recorrência e parcelamento (spec 005). A regra guarda só o
-- calendário; os títulos materializados pelo worker apontam para ela com o
-- número da ocorrência (n de N). O modelo de cada novo título é a ocorrência
-- mais recente da série (editar "esta e as próximas" reescreve os futuros).
CREATE TABLE recurrence_rules (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  frequency          text        NOT NULL,
  interval_count     smallint    NOT NULL DEFAULT 1,
  anchor_day         smallint    NOT NULL,
  starts_on          date        NOT NULL,
  ends_on            date,
  installments_total smallint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurrence_rules_frequency_check CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
  CONSTRAINT recurrence_rules_interval_count_check CHECK (interval_count BETWEEN 1 AND 366),
  CONSTRAINT recurrence_rules_anchor_day_check CHECK (
    CASE frequency WHEN 'weekly' THEN anchor_day BETWEEN 1 AND 7 ELSE anchor_day BETWEEN 1 AND 31 END
  ),
  CONSTRAINT recurrence_rules_ends_on_check CHECK (ends_on >= starts_on),
  CONSTRAINT recurrence_rules_installments_total_check CHECK (installments_total BETWEEN 2 AND 999),
  CONSTRAINT recurrence_rules_end_check CHECK (ends_on IS NULL OR installments_total IS NULL)
);

CREATE TRIGGER recurrence_rules_set_updated_at BEFORE UPDATE ON recurrence_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE recurrence_rules IS
  'Calendário de uma série de títulos (recorrência ou parcelamento). Os títulos apontam para a regra '
  'com titles.occurrence; o worker materializa até 12 meses à frente (spec 005).';
COMMENT ON COLUMN recurrence_rules.frequency IS 'weekly, monthly ou yearly.';
COMMENT ON COLUMN recurrence_rules.interval_count IS 'A cada N períodos (1 = todo período; 2 = quinzenal/bimestral…).';
COMMENT ON COLUMN recurrence_rules.anchor_day IS
  'weekly: dia da semana ISO (1 = segunda … 7 = domingo). monthly/yearly: dia do mês (1–31; em meses '
  'curtos a aplicação usa o último dia). yearly usa o mês de starts_on.';
COMMENT ON COLUMN recurrence_rules.starts_on IS 'Data de referência da primeira ocorrência.';
COMMENT ON COLUMN recurrence_rules.ends_on IS 'Recorrência: última data possível (nulo = sem fim). Exclusivo com installments_total.';
COMMENT ON COLUMN recurrence_rules.installments_total IS 'Parcelamento: total de parcelas N (2–999). Exclusivo com ends_on.';

-- migrate:down

DROP TABLE recurrence_rules;
