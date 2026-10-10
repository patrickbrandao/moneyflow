-- migrate:up

-- Caixas (spec 004 e 007) ---------------------------------------------------------
CREATE TABLE caixas (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  name                   text        NOT NULL,
  kind                   text        NOT NULL,
  holder_entity_id       uuid        NOT NULL REFERENCES entities (id),
  is_primary             boolean     NOT NULL DEFAULT false,
  description            text,
  default_payer_caixa_id uuid        REFERENCES caixas (id),
  credit_limit_cents     bigint,
  closing_day            smallint,
  due_day                smallint,
  card_last4             text,
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT caixas_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT caixas_kind_check CHECK (kind IN ('general', 'credit_card')),
  CONSTRAINT caixas_credit_limit_cents_check CHECK (credit_limit_cents >= 0),
  CONSTRAINT caixas_closing_day_check CHECK (closing_day BETWEEN 1 AND 31),
  CONSTRAINT caixas_due_day_check CHECK (due_day BETWEEN 1 AND 31),
  CONSTRAINT caixas_card_last4_check CHECK (card_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT caixas_default_payer_self_check CHECK (default_payer_caixa_id <> id),
  CONSTRAINT caixas_card_fields_check CHECK (
    CASE kind
      WHEN 'general' THEN default_payer_caixa_id IS NULL AND credit_limit_cents IS NULL
                          AND closing_day IS NULL AND due_day IS NULL AND card_last4 IS NULL
      WHEN 'credit_card' THEN default_payer_caixa_id IS NOT NULL AND credit_limit_cents IS NOT NULL
                          AND closing_day IS NOT NULL AND due_day IS NOT NULL AND card_last4 IS NOT NULL
    END
  ),
  CONSTRAINT caixas_primary_active_check CHECK (NOT (is_primary AND archived_at IS NOT NULL))
);

CREATE INDEX caixas_holder_entity_id_idx ON caixas (holder_entity_id);
CREATE INDEX caixas_default_payer_caixa_id_idx ON caixas (default_payer_caixa_id);
CREATE UNIQUE INDEX caixas_holder_primary_key ON caixas (holder_entity_id) WHERE is_primary;

CREATE TRIGGER caixas_set_updated_at BEFORE UPDATE ON caixas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- kind é imutável (evita que uma caixa geral com contas ou cartões dependentes
-- vire cartão) e a pagadora padrão precisa ser uma caixa geral.
CREATE FUNCTION caixas_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER caixas_validate BEFORE INSERT OR UPDATE ON caixas
  FOR EACH ROW EXECUTE FUNCTION caixas_validate();

COMMENT ON TABLE caixas IS 'Livro financeiro de um titular (entidade); unidade de permissão (specs 002, 004, 007).';
COMMENT ON COLUMN caixas.kind IS 'general (empresa, pessoa, casa) ou credit_card. Imutável após a criação.';
COMMENT ON COLUMN caixas.holder_entity_id IS 'Titular. No cartão, o emissor (ex.: Nu Pagamentos).';
COMMENT ON COLUMN caixas.is_primary IS 'Caixa principal do titular: no máximo uma por titular, e nunca arquivada.';
COMMENT ON COLUMN caixas.default_payer_caixa_id IS 'Cartão: caixa pagadora padrão (sempre uma caixa general).';
COMMENT ON COLUMN caixas.credit_limit_cents IS 'Cartão: limite, em centavos.';
COMMENT ON COLUMN caixas.closing_day IS 'Cartão: dia de fechamento (1–31; meses curtos: a aplicação usa o último dia).';
COMMENT ON COLUMN caixas.due_day IS 'Cartão: dia de vencimento (1–31).';
COMMENT ON COLUMN caixas.card_last4 IS 'Cartão: 4 últimos dígitos.';

-- Membros ------------------------------------------------------------------------------
CREATE TABLE caixa_members (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  caixa_id   uuid        NOT NULL REFERENCES caixas (id) ON DELETE CASCADE,
  role       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT caixa_members_role_check CHECK (role IN ('editor', 'viewer')),
  CONSTRAINT caixa_members_user_caixa_key UNIQUE (user_id, caixa_id)
);

CREATE INDEX caixa_members_caixa_id_idx ON caixa_members (caixa_id);

CREATE TRIGGER caixa_members_set_updated_at BEFORE UPDATE ON caixa_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE caixa_members IS
  'Papel do usuário na caixa: editor (CRUD) ou viewer (leitura). Admins globais não precisam de linha aqui.';

-- Contas financeiras -------------------------------------------------------------------
CREATE TABLE financial_accounts (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  caixa_id              uuid        NOT NULL REFERENCES caixas (id),
  kind                  text        NOT NULL,
  name                  text        NOT NULL,
  bank_code             text,
  ispb                  text,
  branch                text,
  account_number        text,
  opening_balance_cents bigint      NOT NULL DEFAULT 0,
  opening_date          date        NOT NULL,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_accounts_kind_check CHECK (kind IN ('checking', 'cash', 'savings')),
  CONSTRAINT financial_accounts_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT financial_accounts_bank_code_check CHECK (bank_code ~ '^[0-9]{3}$'),
  CONSTRAINT financial_accounts_ispb_check CHECK (ispb ~ '^[0-9]{8}$'),
  CONSTRAINT financial_accounts_branch_check CHECK (branch ~ '^[0-9]{1,6}(-[0-9A-Z])?$'),
  CONSTRAINT financial_accounts_account_number_check CHECK (account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'),
  CONSTRAINT financial_accounts_bank_fields_check CHECK (
    kind IN ('checking', 'savings')
    OR (bank_code IS NULL AND ispb IS NULL AND branch IS NULL AND account_number IS NULL)
  ),
  CONSTRAINT financial_accounts_cash_balance_check CHECK (kind <> 'cash' OR opening_balance_cents >= 0)
);

CREATE INDEX financial_accounts_caixa_id_idx ON financial_accounts (caixa_id);

CREATE TRIGGER financial_accounts_set_updated_at BEFORE UPDATE ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION financial_accounts_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.caixa_id AND c.kind = 'general') THEN
    RAISE EXCEPTION 'financial_accounts: caixa % must be a general caixa', NEW.caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'financial_accounts_caixa_kind_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER financial_accounts_validate BEFORE INSERT OR UPDATE OF caixa_id ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_accounts_validate();

COMMENT ON TABLE financial_accounts IS 'Contas de uma caixa general: corrente/pagamento, cofre (dinheiro) ou poupança/investimento.';
COMMENT ON COLUMN financial_accounts.kind IS 'checking (corrente/pagamento), cash (cofre/espécie) ou savings (poupança/investimento).';
COMMENT ON COLUMN financial_accounts.bank_code IS 'COMPE (3 dígitos); dados bancários só em checking/savings.';
COMMENT ON COLUMN financial_accounts.opening_balance_cents IS 'Saldo inicial em centavos na opening_date (cash não pode ser negativo).';

-- migrate:down

DROP TABLE financial_accounts;
DROP FUNCTION financial_accounts_validate();
DROP TABLE caixa_members;
DROP TABLE caixas;
DROP FUNCTION caixas_validate();
