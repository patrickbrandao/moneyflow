-- migrate:up

-- Entidades (spec 003): pessoas e empresas, cadastro global. ------------------
CREATE TABLE entities (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind        text        NOT NULL,
  name        text        NOT NULL,
  trade_name  text,
  document    text,
  birth_date  date,
  notes       text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entities_kind_check CHECK (kind IN ('person', 'company')),
  CONSTRAINT entities_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT entities_document_key UNIQUE (document),
  CONSTRAINT entities_document_check CHECK (
    document IS NULL
    OR (kind = 'person'  AND is_valid_cpf(document))
    OR (kind = 'company' AND is_valid_cnpj(document))
  ),
  CONSTRAINT entities_trade_name_check CHECK (trade_name IS NULL OR (kind = 'company' AND btrim(trade_name) <> '')),
  CONSTRAINT entities_birth_date_check CHECK (birth_date IS NULL OR kind = 'person')
);

CREATE INDEX entities_name_trgm_idx ON entities USING gin (name gin_trgm_ops);
CREATE INDEX entities_trade_name_trgm_idx ON entities USING gin (trade_name gin_trgm_ops);

CREATE TRIGGER entities_set_updated_at BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entities IS 'Pessoas (CPF) e empresas (CNPJ), globais a todas as caixas.';
COMMENT ON COLUMN entities.name IS 'Nome da pessoa ou razão social da empresa.';
COMMENT ON COLUMN entities.trade_name IS 'Nome fantasia (só empresa).';
COMMENT ON COLUMN entities.document IS
  'CPF (person) ou CNPJ (company) NORMALIZADO: só dígitos/letras maiúsculas, sem pontuação. '
  'Opcional; único quando presente.';
COMMENT ON COLUMN entities.birth_date IS 'Data de nascimento (só pessoa).';

-- Contatos ------------------------------------------------------------------------
CREATE TABLE entity_contacts (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  entity_id  uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  value      text        NOT NULL,
  label      text,
  is_primary boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_contacts_kind_check CHECK (kind IN ('phone', 'email', 'other')),
  CONSTRAINT entity_contacts_value_check CHECK (
    btrim(value) <> ''
    AND (kind <> 'email' OR value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  CONSTRAINT entity_contacts_value_key UNIQUE (entity_id, kind, value)
);

-- No máximo um contato principal por tipo (um telefone, um email…) em cada entidade.
CREATE UNIQUE INDEX entity_contacts_primary_key ON entity_contacts (entity_id, kind) WHERE is_primary;

CREATE TRIGGER entity_contacts_set_updated_at BEFORE UPDATE ON entity_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_contacts IS 'Telefones, emails e outros contatos de uma entidade.';

-- Endereços -----------------------------------------------------------------------
CREATE TABLE entity_addresses (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  entity_id    uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  label        text,
  postal_code  text,
  street       text,
  number       text,
  complement   text,
  district     text,
  city         text        NOT NULL,
  state        text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_addresses_postal_code_check CHECK (postal_code ~ '^[0-9]{8}$'),
  CONSTRAINT entity_addresses_city_check CHECK (btrim(city) <> ''),
  CONSTRAINT entity_addresses_state_check CHECK (state IN (
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA',
    'PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'))
);

CREATE INDEX entity_addresses_entity_id_idx ON entity_addresses (entity_id);

CREATE TRIGGER entity_addresses_set_updated_at BEFORE UPDATE ON entity_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_addresses IS 'Endereços de uma entidade (autopreenchimento por CEP via ViaCEP na aplicação).';
COMMENT ON COLUMN entity_addresses.postal_code IS 'CEP normalizado: 8 dígitos, sem traço.';
COMMENT ON COLUMN entity_addresses.street IS 'Logradouro.';
COMMENT ON COLUMN entity_addresses.district IS 'Bairro.';
COMMENT ON COLUMN entity_addresses.state IS 'UF (sigla maiúscula).';

-- Dados bancários --------------------------------------------------------------------
CREATE TABLE entity_bank_accounts (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  entity_id      uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  bank_code      text,
  ispb           text,
  branch         text,
  account_number text        NOT NULL,
  account_type   text        NOT NULL,
  holder_name    text,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_bank_accounts_bank_check CHECK (bank_code IS NOT NULL OR ispb IS NOT NULL),
  CONSTRAINT entity_bank_accounts_bank_code_check CHECK (bank_code ~ '^[0-9]{3}$'),
  CONSTRAINT entity_bank_accounts_ispb_check CHECK (ispb ~ '^[0-9]{8}$'),
  CONSTRAINT entity_bank_accounts_branch_check CHECK (branch ~ '^[0-9]{1,6}(-[0-9A-Z])?$'),
  CONSTRAINT entity_bank_accounts_account_number_check CHECK (account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'),
  CONSTRAINT entity_bank_accounts_account_type_check CHECK (account_type IN ('checking', 'savings', 'payment', 'salary'))
);

CREATE INDEX entity_bank_accounts_entity_id_idx ON entity_bank_accounts (entity_id);

CREATE TRIGGER entity_bank_accounts_set_updated_at BEFORE UPDATE ON entity_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_bank_accounts IS 'Contas bancárias de uma entidade (para pagar ou receber).';
COMMENT ON COLUMN entity_bank_accounts.bank_code IS 'Código COMPE (3 dígitos). Exige bank_code ou ispb.';
COMMENT ON COLUMN entity_bank_accounts.ispb IS 'ISPB (8 dígitos).';
COMMENT ON COLUMN entity_bank_accounts.branch IS 'Agência: dígitos e, opcionalmente, "-DV".';
COMMENT ON COLUMN entity_bank_accounts.account_number IS 'Conta: dígitos e, opcionalmente, "-DV" (X maiúsculo).';

-- Chaves PIX ------------------------------------------------------------------------------
CREATE TABLE entity_pix_keys (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  entity_id  uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  key_type   text        NOT NULL,
  key_value  text        NOT NULL,
  bank_code  text,
  ispb       text,
  label      text,
  is_primary boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_pix_keys_key_type_check CHECK (key_type IN ('cpf', 'cnpj', 'email', 'phone', 'evp')),
  CONSTRAINT entity_pix_keys_key_value_check CHECK (
    CASE key_type
      WHEN 'cpf'   THEN is_valid_cpf(key_value)
      WHEN 'cnpj'  THEN is_valid_cnpj(key_value)
      WHEN 'email' THEN key_value = lower(key_value)
                        AND length(key_value) <= 77
                        AND key_value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      WHEN 'phone' THEN key_value ~ '^\+55[1-9]{2}[0-9]{8,9}$'
      WHEN 'evp'   THEN key_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    END
  ),
  CONSTRAINT entity_pix_keys_bank_code_check CHECK (bank_code ~ '^[0-9]{3}$'),
  CONSTRAINT entity_pix_keys_ispb_check CHECK (ispb ~ '^[0-9]{8}$'),
  -- Uma chave PIX aponta para uma única conta no DICT: não pode estar em duas entidades.
  CONSTRAINT entity_pix_keys_key_value_key UNIQUE (key_type, key_value)
);

CREATE INDEX entity_pix_keys_entity_id_idx ON entity_pix_keys (entity_id);
CREATE UNIQUE INDEX entity_pix_keys_primary_key ON entity_pix_keys (entity_id) WHERE is_primary;

CREATE TRIGGER entity_pix_keys_set_updated_at BEFORE UPDATE ON entity_pix_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_pix_keys IS 'Chaves PIX de uma entidade; no máximo uma principal (mostrada no título a pagar).';
COMMENT ON COLUMN entity_pix_keys.key_value IS
  'Valor NORMALIZADO por tipo: cpf 11 dígitos; cnpj 14 caracteres [0-9A-Z]; email minúsculo (≤ 77); '
  'phone E.164 brasileiro (+55 DDD número, 8 ou 9 dígitos); evp UUID minúsculo com hífens.';
COMMENT ON COLUMN entity_pix_keys.bank_code IS 'Banco (COMPE) onde a chave está registrada, opcional.';
COMMENT ON COLUMN entity_pix_keys.label IS 'Apelido opcional.';

-- Vínculos entre entidades ---------------------------------------------------------------
CREATE TABLE entity_links (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  entity_id         uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  related_entity_id uuid        NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  kind              text        NOT NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_links_kind_check CHECK (kind IN ('partner_of', 'responsible_for', 'spouse_of', 'other')),
  CONSTRAINT entity_links_self_check CHECK (entity_id <> related_entity_id),
  CONSTRAINT entity_links_key UNIQUE (entity_id, related_entity_id, kind)
);

CREATE INDEX entity_links_related_entity_id_idx ON entity_links (related_entity_id);
-- spouse_of é simétrico: A↔B e B↔A são o mesmo vínculo.
CREATE UNIQUE INDEX entity_links_spouse_key ON entity_links
  (LEAST(entity_id, related_entity_id), GREATEST(entity_id, related_entity_id))
  WHERE kind = 'spouse_of';

CREATE TRIGGER entity_links_set_updated_at BEFORE UPDATE ON entity_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entity_links IS
  'Vínculo direcionado: entity_id <kind> related_entity_id (ex.: A partner_of B = A é sócio de B). '
  'spouse_of é simétrico e só pode existir em um sentido.';

-- migrate:down

DROP TABLE entity_links;
DROP TABLE entity_pix_keys;
DROP TABLE entity_bank_accounts;
DROP TABLE entity_addresses;
DROP TABLE entity_contacts;
DROP TABLE entities;
