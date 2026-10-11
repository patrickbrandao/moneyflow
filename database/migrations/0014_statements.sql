-- migrate:up

-- Extratos e conciliação (spec 009): import OFX/CSV de conta corrente/poupança e
-- de fatura de cartão, linhas deduplicadas, casamento com movimentos/títulos/itens
-- de fatura, mapeamentos de CSV salvos e regras de classificação aprendidas.

-- Mapeamentos de CSV -------------------------------------------------------------------------
CREATE TABLE statement_csv_mappings (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  financial_account_id uuid        REFERENCES financial_accounts (id) ON DELETE CASCADE,
  card_caixa_id        uuid        REFERENCES caixas (id) ON DELETE CASCADE,
  name                 text        NOT NULL,
  delimiter            text        NOT NULL DEFAULT ';',
  encoding             text        NOT NULL DEFAULT 'utf-8',
  has_header           boolean     NOT NULL DEFAULT true,
  skip_rows            smallint    NOT NULL DEFAULT 0,
  date_format          text        NOT NULL DEFAULT 'dd/MM/yyyy',
  decimal_separator    text        NOT NULL DEFAULT ',',
  columns              jsonb       NOT NULL,
  is_default           boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_csv_mappings_target_check CHECK (num_nonnulls(financial_account_id, card_caixa_id) = 1),
  CONSTRAINT statement_csv_mappings_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT statement_csv_mappings_delimiter_check CHECK (delimiter IN (',', ';', E'\t', '|')),
  CONSTRAINT statement_csv_mappings_encoding_check CHECK (encoding IN ('utf-8', 'latin1', 'windows-1252')),
  CONSTRAINT statement_csv_mappings_skip_rows_check CHECK (skip_rows BETWEEN 0 AND 100),
  CONSTRAINT statement_csv_mappings_date_format_check CHECK (btrim(date_format) <> ''),
  CONSTRAINT statement_csv_mappings_decimal_separator_check CHECK (decimal_separator IN (',', '.')),
  CONSTRAINT statement_csv_mappings_columns_check CHECK (
    jsonb_typeof(columns) = 'object' AND columns ? 'date' AND columns ? 'description'
    AND (columns ? 'amount' OR (columns ? 'debit' AND columns ? 'credit'))
  )
);

CREATE INDEX statement_csv_mappings_card_caixa_id_idx ON statement_csv_mappings (card_caixa_id);
CREATE UNIQUE INDEX statement_csv_mappings_name_key
  ON statement_csv_mappings (financial_account_id, card_caixa_id, lower(name)) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX statement_csv_mappings_default_key
  ON statement_csv_mappings (financial_account_id, card_caixa_id) NULLS NOT DISTINCT WHERE is_default;

CREATE TRIGGER statement_csv_mappings_set_updated_at BEFORE UPDATE ON statement_csv_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE statement_csv_mappings IS
  'Mapeamento de colunas de CSV salvo por conta (ou por cartão, para fatura). No máximo um padrão por destino.';
COMMENT ON COLUMN statement_csv_mappings.columns IS
  'Objeto JSON: chave = campo (date, description, amount OU debit+credit; opcionais fitid, balance, document), '
  'valor = índice (0-based) ou nome da coluna no cabeçalho. Interpretado pela aplicação.';
COMMENT ON COLUMN statement_csv_mappings.date_format IS 'Formato da data no arquivo (padrão date-fns, ex.: dd/MM/yyyy).';

-- Lotes de importação ---------------------------------------------------------------------------
CREATE TABLE statement_imports (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  financial_account_id uuid        REFERENCES financial_accounts (id),
  card_caixa_id        uuid        REFERENCES caixas (id),
  card_invoice_id      uuid        REFERENCES card_invoices (id),
  format               text        NOT NULL,
  attachment_id        uuid        NOT NULL REFERENCES attachments (id),
  csv_mapping_id       uuid        REFERENCES statement_csv_mappings (id) ON DELETE SET NULL,
  period_start         date        NOT NULL,
  period_end           date        NOT NULL,
  bank_balance_cents   bigint,
  bank_balance_on      date,
  imported_by_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_imports_target_check CHECK (
    num_nonnulls(financial_account_id, card_caixa_id) = 1
    AND (card_invoice_id IS NULL OR card_caixa_id IS NOT NULL)
  ),
  CONSTRAINT statement_imports_format_check CHECK (format IN ('ofx', 'csv')),
  CONSTRAINT statement_imports_csv_mapping_check CHECK (format = 'csv' OR csv_mapping_id IS NULL),
  CONSTRAINT statement_imports_period_check CHECK (period_end >= period_start),
  CONSTRAINT statement_imports_bank_balance_check CHECK ((bank_balance_cents IS NULL) = (bank_balance_on IS NULL))
);

CREATE INDEX statement_imports_financial_account_id_idx ON statement_imports (financial_account_id, period_start);
CREATE INDEX statement_imports_card_caixa_id_idx ON statement_imports (card_caixa_id, period_start);
CREATE INDEX statement_imports_card_invoice_id_idx ON statement_imports (card_invoice_id);
CREATE INDEX statement_imports_attachment_id_idx ON statement_imports (attachment_id);
CREATE INDEX statement_imports_csv_mapping_id_idx ON statement_imports (csv_mapping_id);
CREATE INDEX statement_imports_imported_by_user_id_idx ON statement_imports (imported_by_user_id);

CREATE TRIGGER statement_imports_set_updated_at BEFORE UPDATE ON statement_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE statement_imports IS
  'Lote de importação de extrato (OFX/CSV) de uma conta corrente/poupança, ou de fatura de um cartão. '
  'O arquivo original fica em attachment_id. Excluir o lote apaga as linhas (os movimentos criados a partir delas ficam).';
COMMENT ON COLUMN statement_imports.financial_account_id IS 'Conta (checking ou savings) do extrato. Exclusivo com card_caixa_id.';
COMMENT ON COLUMN statement_imports.card_caixa_id IS 'Cartão (caixa credit_card) cuja fatura foi importada.';
COMMENT ON COLUMN statement_imports.card_invoice_id IS 'Fatura do app a que o arquivo do cartão corresponde (opcional).';
COMMENT ON COLUMN statement_imports.bank_balance_cents IS
  'Saldo informado pelo banco (OFX LEDGERBAL ou digitado) em bank_balance_on; comparado com o do app em statement_import_balances.';

-- Regras de classificação ------------------------------------------------------------------------
CREATE TABLE classification_rules (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  caixa_id             uuid        REFERENCES caixas (id) ON DELETE CASCADE,
  match_kind           text        NOT NULL DEFAULT 'contains',
  pattern              text        NOT NULL,
  direction            text,
  entity_id            uuid        REFERENCES entities (id) ON DELETE CASCADE,
  category_id          uuid        REFERENCES categories (id) ON DELETE CASCADE,
  priority             smallint    NOT NULL DEFAULT 100,
  origin               text        NOT NULL DEFAULT 'manual',
  created_from_line_id uuid,
  created_by_user_id   uuid        REFERENCES users (id) ON DELETE SET NULL,
  usage_count          integer     NOT NULL DEFAULT 0,
  last_used_at         timestamptz,
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classification_rules_match_kind_check CHECK (match_kind IN ('contains', 'starts_with', 'exact', 'regex')),
  CONSTRAINT classification_rules_pattern_check CHECK (btrim(pattern) <> '' AND length(pattern) <= 200),
  CONSTRAINT classification_rules_direction_check CHECK (direction IN ('in', 'out')),
  CONSTRAINT classification_rules_target_check CHECK (
    num_nonnulls(entity_id, category_id) >= 1 AND (category_id IS NULL OR direction IS NOT NULL)
  ),
  CONSTRAINT classification_rules_priority_check CHECK (priority BETWEEN 0 AND 1000),
  CONSTRAINT classification_rules_origin_check CHECK (origin IN ('manual', 'correction', 'agent')),
  CONSTRAINT classification_rules_usage_count_check CHECK (usage_count >= 0)
);

CREATE INDEX classification_rules_caixa_id_idx ON classification_rules (caixa_id);
CREATE INDEX classification_rules_entity_id_idx ON classification_rules (entity_id);
CREATE INDEX classification_rules_category_id_idx ON classification_rules (category_id);
CREATE INDEX classification_rules_created_from_line_id_idx ON classification_rules (created_from_line_id);
CREATE INDEX classification_rules_created_by_user_id_idx ON classification_rules (created_by_user_id);
CREATE UNIQUE INDEX classification_rules_pattern_key
  ON classification_rules (caixa_id, match_kind, lower(pattern), direction) NULLS NOT DISTINCT
  WHERE archived_at IS NULL;

CREATE TRIGGER classification_rules_set_updated_at BEFORE UPDATE ON classification_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION classification_rules_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM categories c
                  WHERE c.id = NEW.category_id
                    AND c.kind <> CASE NEW.direction WHEN 'in' THEN 'income' ELSE 'expense' END) THEN
    RAISE EXCEPTION 'classification_rules: % rule requires % category', NEW.direction,
      CASE NEW.direction WHEN 'in' THEN 'income' ELSE 'expense' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_category_kind_check';
  END IF;

  IF NEW.match_kind = 'regex' THEN
    BEGIN
      PERFORM '' ~ NEW.pattern;
    EXCEPTION WHEN invalid_regular_expression THEN
      RAISE EXCEPTION 'classification_rules: invalid regular expression %', NEW.pattern
        USING ERRCODE = 'check_violation', CONSTRAINT = 'classification_rules_pattern_check';
    END;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER classification_rules_validate
  BEFORE INSERT OR UPDATE OF match_kind, pattern, direction, category_id ON classification_rules
  FOR EACH ROW EXECUTE FUNCTION classification_rules_validate();

COMMENT ON TABLE classification_rules IS
  'Regras descrição → entidade/categoria (spec 009), criadas à mão, por correção do usuário ou sugeridas pelo agente. '
  'A melhor regra para uma linha: classification_rule_for().';
COMMENT ON COLUMN classification_rules.caixa_id IS 'Escopo: só nesta caixa. Nulo = todas as caixas.';
COMMENT ON COLUMN classification_rules.match_kind IS
  'contains, starts_with, exact (sem distinção de maiúsculas, espaços nas pontas ignorados) ou regex (~*, POSIX).';
COMMENT ON COLUMN classification_rules.direction IS 'in (entrada, categoria income), out (saída, expense) ou nulo (qualquer; só sem categoria).';
COMMENT ON COLUMN classification_rules.priority IS 'Menor número vence (0–1000, padrão 100).';
COMMENT ON COLUMN classification_rules.origin IS 'manual, correction (aprendida de uma correção do usuário) ou agent (sugestão aprovada do agente).';
COMMENT ON COLUMN classification_rules.created_from_line_id IS 'Linha de extrato cuja correção originou a regra.';
COMMENT ON COLUMN classification_rules.usage_count IS 'Quantas vezes a regra classificou uma linha (a aplicação incrementa).';

-- Linhas de extrato -------------------------------------------------------------------------------
CREATE TABLE statement_lines (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  statement_import_id    uuid        NOT NULL REFERENCES statement_imports (id) ON DELETE CASCADE,
  financial_account_id   uuid        REFERENCES financial_accounts (id),
  card_caixa_id          uuid        REFERENCES caixas (id),
  line_number            integer     NOT NULL,
  posted_on              date        NOT NULL,
  amount_cents           bigint      NOT NULL,
  description            text        NOT NULL,
  fitid                  text,
  dedup_hash             text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'new',
  movement_id            uuid        REFERENCES movements (id),
  title_id               uuid        REFERENCES titles (id),
  card_invoice_item_id   uuid        REFERENCES card_invoice_items (id),
  entity_id              uuid        REFERENCES entities (id),
  category_id            uuid        REFERENCES categories (id),
  classification_rule_id uuid        REFERENCES classification_rules (id) ON DELETE SET NULL,
  classification_source  text,
  raw                    jsonb,
  matched_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_lines_target_check CHECK (num_nonnulls(financial_account_id, card_caixa_id) = 1),
  CONSTRAINT statement_lines_line_number_key UNIQUE (statement_import_id, line_number),
  CONSTRAINT statement_lines_line_number_check CHECK (line_number >= 1),
  CONSTRAINT statement_lines_amount_cents_check CHECK (amount_cents <> 0),
  CONSTRAINT statement_lines_dedup_hash_check CHECK (btrim(dedup_hash) <> '' AND length(dedup_hash) <= 200),
  CONSTRAINT statement_lines_status_check CHECK (status IN ('matched', 'suggested', 'new', 'ignored')),
  CONSTRAINT statement_lines_links_check CHECK (
    (movement_id IS NULL OR financial_account_id IS NOT NULL)
    AND (title_id IS NULL OR financial_account_id IS NOT NULL)
    AND (card_invoice_item_id IS NULL OR card_caixa_id IS NOT NULL)
    AND CASE status
          WHEN 'matched'   THEN num_nonnulls(movement_id, card_invoice_item_id) = 1 AND title_id IS NULL
          WHEN 'suggested' THEN num_nonnulls(movement_id, title_id, card_invoice_item_id) = 1
          ELSE num_nonnulls(movement_id, title_id, card_invoice_item_id) = 0
        END
    AND (status = 'matched') = (matched_at IS NOT NULL)
  ),
  CONSTRAINT statement_lines_classification_source_check CHECK (
    classification_source IN ('rule', 'agent', 'user')
    AND (classification_rule_id IS NULL OR classification_source IS NOT DISTINCT FROM 'rule')
  ),
  CONSTRAINT statement_lines_raw_check CHECK (jsonb_typeof(raw) = 'object')
);

CREATE UNIQUE INDEX statement_lines_account_dedup_key ON statement_lines (financial_account_id, dedup_hash)
  WHERE financial_account_id IS NOT NULL;
CREATE UNIQUE INDEX statement_lines_card_dedup_key ON statement_lines (card_caixa_id, dedup_hash)
  WHERE card_caixa_id IS NOT NULL;
CREATE UNIQUE INDEX statement_lines_movement_matched_key ON statement_lines (movement_id) WHERE status = 'matched';
CREATE UNIQUE INDEX statement_lines_card_item_matched_key ON statement_lines (card_invoice_item_id) WHERE status = 'matched';
CREATE INDEX statement_lines_financial_account_id_posted_on_idx ON statement_lines (financial_account_id, posted_on);
CREATE INDEX statement_lines_card_caixa_id_posted_on_idx ON statement_lines (card_caixa_id, posted_on);
CREATE INDEX statement_lines_status_idx ON statement_lines (statement_import_id, status);
CREATE INDEX statement_lines_movement_id_idx ON statement_lines (movement_id);
CREATE INDEX statement_lines_title_id_idx ON statement_lines (title_id);
CREATE INDEX statement_lines_card_invoice_item_id_idx ON statement_lines (card_invoice_item_id);
CREATE INDEX statement_lines_entity_id_idx ON statement_lines (entity_id);
CREATE INDEX statement_lines_category_id_idx ON statement_lines (category_id);
CREATE INDEX statement_lines_classification_rule_id_idx ON statement_lines (classification_rule_id);
CREATE INDEX statement_lines_description_trgm_idx ON statement_lines USING gin (description gin_trgm_ops);

CREATE TRIGGER statement_lines_set_updated_at BEFORE UPDATE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE classification_rules
  ADD CONSTRAINT classification_rules_created_from_line_id_fkey
  FOREIGN KEY (created_from_line_id) REFERENCES statement_lines (id) ON DELETE SET NULL;

COMMENT ON TABLE statement_lines IS
  'Linhas de um extrato importado (spec 009), deduplicadas por conta (ou cartão) via dedup_hash. '
  'matched = conciliada (movimento ou item de fatura), suggested = casamento proposto aguardando confirmação, '
  'new = sem par (vira baixa ou movimento avulso), ignored = descartada.';
COMMENT ON COLUMN statement_lines.financial_account_id IS 'Conta do lote (repetida aqui para a deduplicação por conta).';
COMMENT ON COLUMN statement_lines.card_caixa_id IS 'Cartão do lote (import de fatura).';
COMMENT ON COLUMN statement_lines.line_number IS 'Posição da linha no arquivo (1-based).';
COMMENT ON COLUMN statement_lines.amount_cents IS
  'Valor assinado do ponto de vista do titular: + entra, − sai. Na fatura do cartão: compra/encargo −, estorno/crédito +.';
COMMENT ON COLUMN statement_lines.fitid IS 'FITID do OFX, quando houver.';
COMMENT ON COLUMN statement_lines.dedup_hash IS
  'Chave de deduplicação calculada pela aplicação, única por conta/cartão: ''fitid:'' || FITID quando houver; '
  'senão o SHA-256 hex de data|valor|descrição normalizada|ordem entre linhas idênticas do mesmo dia.';
COMMENT ON COLUMN statement_lines.movement_id IS 'matched: movimento conciliado (mesma conta e valor); suggested: movimento proposto.';
COMMENT ON COLUMN statement_lines.title_id IS 'suggested: título em aberto proposto para baixa com esta linha.';
COMMENT ON COLUMN statement_lines.card_invoice_item_id IS 'Fatura de cartão: item (parcela) conciliado/proposto; valor = −amount_cents do item.';
COMMENT ON COLUMN statement_lines.entity_id IS 'Entidade sugerida/escolhida para criar o lançamento de uma linha nova.';
COMMENT ON COLUMN statement_lines.category_id IS 'Categoria sugerida/escolhida (income se entra, expense se sai; no cartão sempre expense).';
COMMENT ON COLUMN statement_lines.classification_source IS 'De onde veio entity/category: rule (classification_rule_id), agent (pendente de aprovação) ou user.';
COMMENT ON COLUMN statement_lines.raw IS 'Campos originais da linha no arquivo (objeto JSON), para auditoria e reprocessamento.';
COMMENT ON COLUMN statement_lines.matched_at IS 'Quando a linha foi conciliada (obrigatório se e somente se matched).';

-- Validação da linha.
CREATE FUNCTION statement_lines_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imp statement_imports;
  ok  boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.statement_import_id <> OLD.statement_import_id OR NEW.posted_on <> OLD.posted_on
          OR NEW.amount_cents <> OLD.amount_cents OR NEW.dedup_hash <> OLD.dedup_hash
          OR NEW.line_number <> OLD.line_number
          OR NEW.financial_account_id IS DISTINCT FROM OLD.financial_account_id
          OR NEW.card_caixa_id IS DISTINCT FROM OLD.card_caixa_id) THEN
    RAISE EXCEPTION 'statement_lines: imported data of line % cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_immutable_check';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO imp FROM statement_imports i WHERE i.id = NEW.statement_import_id;
    IF FOUND AND (NEW.financial_account_id IS DISTINCT FROM imp.financial_account_id
                  OR NEW.card_caixa_id IS DISTINCT FROM imp.card_caixa_id) THEN
      RAISE EXCEPTION 'statement_lines: line must belong to the account/card of import %', imp.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_import_target_check';
    END IF;
  END IF;

  IF NEW.movement_id IS NOT NULL THEN
    SELECT m.financial_account_id = NEW.financial_account_id
           AND (NEW.status <> 'matched' OR m.amount_cents = NEW.amount_cents)
      INTO ok FROM movements m WHERE m.id = NEW.movement_id;
    IF ok IS FALSE THEN
      RAISE EXCEPTION 'statement_lines: movement % must be on the same account (and amount, when matched)', NEW.movement_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_movement_check';
    END IF;
  END IF;

  IF NEW.card_invoice_item_id IS NOT NULL THEN
    SELECT v.card_caixa_id = NEW.card_caixa_id
           AND (NEW.status <> 'matched' OR i.amount_cents = -NEW.amount_cents)
      INTO ok FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
     WHERE i.id = NEW.card_invoice_item_id;
    IF ok IS FALSE THEN
      RAISE EXCEPTION 'statement_lines: invoice item % must be on the same card (and opposite amount, when matched)',
        NEW.card_invoice_item_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_card_item_check';
    END IF;
  END IF;

  IF NEW.category_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM categories c
                  WHERE c.id = NEW.category_id
                    AND c.kind <> CASE WHEN NEW.card_caixa_id IS NOT NULL OR NEW.amount_cents < 0
                                       THEN 'expense' ELSE 'income' END) THEN
    RAISE EXCEPTION 'statement_lines: category % does not match the line direction', NEW.category_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_category_kind_check';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER statement_lines_validate BEFORE INSERT OR UPDATE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION statement_lines_validate();

-- O lote: conta corrente/poupança ou cartão; fatura do mesmo cartão; mapeamento do mesmo destino.
CREATE FUNCTION statement_imports_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.financial_account_id IS DISTINCT FROM OLD.financial_account_id
          OR NEW.card_caixa_id IS DISTINCT FROM OLD.card_caixa_id
          OR NEW.attachment_id <> OLD.attachment_id OR NEW.format <> OLD.format) THEN
    RAISE EXCEPTION 'statement_imports: account/card, file and format of import % cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_immutable_check';
  END IF;

  IF NEW.financial_account_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM financial_accounts a
                  WHERE a.id = NEW.financial_account_id AND a.kind NOT IN ('checking', 'savings')) THEN
    RAISE EXCEPTION 'statement_imports: account % does not import statements (only checking/savings)', NEW.financial_account_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_account_kind_check';
  END IF;

  IF NEW.card_caixa_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.card_caixa_id AND c.kind <> 'credit_card') THEN
    RAISE EXCEPTION 'statement_imports: caixa % is not a credit card', NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_card_kind_check';
  END IF;

  IF NEW.card_invoice_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM card_invoices v WHERE v.id = NEW.card_invoice_id AND v.card_caixa_id <> NEW.card_caixa_id) THEN
    RAISE EXCEPTION 'statement_imports: invoice % is not from card %', NEW.card_invoice_id, NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_card_invoice_check';
  END IF;

  IF NEW.csv_mapping_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM statement_csv_mappings m
                  WHERE m.id = NEW.csv_mapping_id
                    AND (m.financial_account_id IS DISTINCT FROM NEW.financial_account_id
                         OR m.card_caixa_id IS DISTINCT FROM NEW.card_caixa_id)) THEN
    RAISE EXCEPTION 'statement_imports: CSV mapping % belongs to another account/card', NEW.csv_mapping_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_csv_mapping_target_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER statement_imports_validate BEFORE INSERT OR UPDATE ON statement_imports
  FOR EACH ROW EXECUTE FUNCTION statement_imports_validate();

-- O mapeamento é de uma conta corrente/poupança ou de um cartão.
CREATE FUNCTION statement_csv_mappings_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.financial_account_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM financial_accounts a
                  WHERE a.id = NEW.financial_account_id AND a.kind NOT IN ('checking', 'savings')) THEN
    RAISE EXCEPTION 'statement_csv_mappings: account % does not import statements', NEW.financial_account_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_account_kind_check';
  END IF;
  IF NEW.card_caixa_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM caixas c WHERE c.id = NEW.card_caixa_id AND c.kind <> 'credit_card') THEN
    RAISE EXCEPTION 'statement_csv_mappings: caixa % is not a credit card', NEW.card_caixa_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_imports_card_kind_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER statement_csv_mappings_validate
  BEFORE INSERT OR UPDATE OF financial_account_id, card_caixa_id ON statement_csv_mappings
  FOR EACH ROW EXECUTE FUNCTION statement_csv_mappings_validate();

-- Movimento conciliado não muda de conta nem de valor sem desfazer a conciliação.
CREATE FUNCTION movements_validate_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_lines l
              WHERE l.movement_id = OLD.id AND l.status = 'matched'
                AND (l.financial_account_id <> NEW.financial_account_id OR l.amount_cents <> NEW.amount_cents)) THEN
    RAISE EXCEPTION 'movements: movement % is reconciled with a statement line', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_movement_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER movements_validate_statement BEFORE UPDATE OF financial_account_id, amount_cents ON movements
  FOR EACH ROW EXECUTE FUNCTION movements_validate_statement();

-- Melhor regra para uma linha --------------------------------------------------------------------
CREATE FUNCTION classification_rule_for(p_caixa_id uuid, p_description text, p_amount_cents bigint)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT r.id
    FROM classification_rules r
   WHERE r.archived_at IS NULL
     AND (r.caixa_id IS NULL OR r.caixa_id = p_caixa_id)
     AND (r.direction IS NULL OR r.direction = CASE WHEN p_amount_cents > 0 THEN 'in' ELSE 'out' END)
     AND CASE r.match_kind
           WHEN 'exact'       THEN lower(btrim(p_description)) = lower(btrim(r.pattern))
           WHEN 'starts_with' THEN starts_with(lower(btrim(p_description)), lower(btrim(r.pattern)))
           WHEN 'contains'    THEN strpos(lower(p_description), lower(btrim(r.pattern))) > 0
           WHEN 'regex'       THEN p_description ~* r.pattern
         END
   ORDER BY r.priority,
            (r.caixa_id IS NULL),
            array_position(ARRAY['exact', 'starts_with', 'contains', 'regex'], r.match_kind),
            length(r.pattern) DESC,
            r.id
   LIMIT 1
$$;

COMMENT ON FUNCTION classification_rule_for(uuid, text, bigint) IS
  'Regra ativa que classifica a descrição (sinal de p_amount_cents = direção) na caixa: menor prioridade, regra da '
  'caixa antes da global, exact > starts_with > contains > regex, padrão mais longo. NULL se nenhuma casa. '
  'Para cartão, passe a caixa do cartão e o valor da linha (compra −).';

-- Divergência de saldo --------------------------------------------------------------------------------
CREATE VIEW statement_import_balances WITH (security_invoker = true) AS
SELECT i.id AS statement_import_id,
       i.financial_account_id,
       i.card_caixa_id,
       i.period_start,
       i.period_end,
       i.bank_balance_on,
       i.bank_balance_cents,
       CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
            THEN financial_account_balance_at(i.financial_account_id, i.bank_balance_on) END AS app_balance_cents,
       CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
            THEN i.bank_balance_cents - financial_account_balance_at(i.financial_account_id, i.bank_balance_on)
       END AS difference_cents,
       coalesce(c.lines, 0)::int AS lines,
       coalesce(c.matched, 0)::int AS matched_lines,
       coalesce(c.suggested, 0)::int AS suggested_lines,
       coalesce(c.new, 0)::int AS new_lines,
       coalesce(c.ignored, 0)::int AS ignored_lines
  FROM statement_imports i
  LEFT JOIN LATERAL (
    SELECT count(*) AS lines,
           count(*) FILTER (WHERE l.status = 'matched') AS matched,
           count(*) FILTER (WHERE l.status = 'suggested') AS suggested,
           count(*) FILTER (WHERE l.status = 'new') AS new,
           count(*) FILTER (WHERE l.status = 'ignored') AS ignored
      FROM statement_lines l WHERE l.statement_import_id = i.id
  ) c ON true;

COMMENT ON VIEW statement_import_balances IS
  'Por lote: saldo informado pelo banco × saldo do app na mesma data (difference_cents = banco − app; 0 = sem '
  'divergência) e contagem de linhas por status. Saldo só para contas (não para cartão).';

-- Anexos: o arquivo de cada lote.
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
SELECT attachment_id, 'statement_import', id FROM statement_imports;

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
SELECT xml_attachment_id, 'nfe_document', id FROM nfe_documents WHERE xml_attachment_id IS NOT NULL
UNION ALL
SELECT attachment_id, 'card_purchase', card_purchase_id FROM card_purchase_attachments;

DROP VIEW statement_import_balances;
DROP FUNCTION classification_rule_for(uuid, text, bigint);
DROP TRIGGER movements_validate_statement ON movements;
DROP FUNCTION movements_validate_statement();
ALTER TABLE classification_rules DROP CONSTRAINT classification_rules_created_from_line_id_fkey;
DROP TABLE statement_lines;
DROP TABLE classification_rules;
DROP TABLE statement_imports;
DROP TABLE statement_csv_mappings;
DROP FUNCTION statement_csv_mappings_validate();
DROP FUNCTION statement_imports_validate();
DROP FUNCTION statement_lines_validate();
DROP FUNCTION classification_rules_validate();
