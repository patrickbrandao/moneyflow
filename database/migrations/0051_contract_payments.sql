-- migrate:up

-- Pagamentos de contrato no extrato (spec 033, F19): a conta das parcelas no contrato (com a
-- conta de passagem quando é de outra caixa), os encargos usados para reconhecer o valor pago,
-- a janela e o "baixar sem confirmação"; a conta prevista em cada título; a baixa com
-- transferência feita a partir da linha do extrato; e a leitura contract_payments().

-- Contratos ---------------------------------------------------------------------------------------------------------
ALTER TABLE contracts
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

CREATE INDEX contracts_payment_account_id_idx ON contracts (payment_account_id);
CREATE INDEX contracts_transit_account_id_idx ON contracts (transit_account_id);

-- Títulos -----------------------------------------------------------------------------------------------------------
ALTER TABLE titles
  ADD COLUMN planned_account_id         uuid REFERENCES financial_accounts (id),
  ADD COLUMN planned_transit_account_id uuid REFERENCES financial_accounts (id),
  ADD COLUMN planned_account_custom     boolean NOT NULL DEFAULT false;

-- FK (exclusão da conta) e a busca dos candidatos da conciliação (só os em aberto).
CREATE INDEX titles_planned_account_id_idx ON titles (planned_account_id) WHERE planned_account_id IS NOT NULL;
CREATE INDEX titles_planned_account_open_idx ON titles (planned_account_id, due_date)
  WHERE planned_account_id IS NOT NULL AND status IN ('open', 'partial');
CREATE INDEX titles_planned_transit_account_id_idx ON titles (planned_transit_account_id)
  WHERE planned_transit_account_id IS NOT NULL;

-- Regra comum: a conta (do pagamento) é checking/savings de qualquer caixa; a de passagem é
-- obrigatória quando a conta é de outra caixa, nula senão, e sempre da caixa dona.
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

CREATE FUNCTION titles_validate_planned_account() RETURNS trigger
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

-- A conta usada como conta das parcelas, prevista ou de passagem não muda de caixa; a das
-- parcelas e a prevista também não deixam de ser checking/savings.
CREATE FUNCTION financial_accounts_validate_payment_refs() RETURNS trigger
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

CREATE TRIGGER financial_accounts_validate_payment_refs BEFORE UPDATE OF caixa_id, kind ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_accounts_validate_payment_refs();

-- Linhas do extrato -------------------------------------------------------------------------------------------------
-- transfer_settlement: a baixa feita a partir da linha numa parcela de outra caixa (a conta da
-- linha é a conta prevista): a baixa na conta de passagem + a transferência (transfers.settlement_id)
-- entre a conta da linha e a de passagem; movement_id é a perna da transferência na conta da linha.
ALTER TABLE statement_lines DROP CONSTRAINT statement_lines_created_entry_check;
ALTER TABLE statement_lines DROP CONSTRAINT statement_lines_created_entry_links_check;
ALTER TABLE statement_lines
  ADD COLUMN auto_settled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT statement_lines_created_entry_check CHECK (
    created_entry IS NULL
    OR (created_entry IN ('adjustment', 'title', 'settlement', 'transfer_settlement', 'purchase') AND status = 'matched')
  ),
  ADD CONSTRAINT statement_lines_created_entry_links_check CHECK (
    CASE created_entry
      WHEN 'adjustment'          THEN movement_id IS NOT NULL
      WHEN 'title'               THEN movement_id IS NOT NULL
      WHEN 'settlement'          THEN movement_id IS NOT NULL
      WHEN 'transfer_settlement' THEN movement_id IS NOT NULL
      WHEN 'purchase'            THEN card_invoice_item_id IS NOT NULL
      ELSE true
    END
  ),
  ADD CONSTRAINT statement_lines_auto_settled_check CHECK (
    NOT auto_settled OR (status = 'matched' AND coalesce(created_entry IN ('settlement', 'transfer_settlement'), false))
  );

-- transfer_settlement: o movimento é perna de uma transferência que nasceu de uma baixa.
CREATE FUNCTION statement_lines_validate_created_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_entry = 'transfer_settlement'
     AND NOT EXISTS (SELECT 1 FROM movements m JOIN transfers tr ON tr.id = m.transfer_id
                      WHERE m.id = NEW.movement_id AND tr.settlement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'statement_lines: transfer_settlement needs the movement of a transfer that funds a settlement (line %)',
      NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'statement_lines_created_entry_links_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER statement_lines_validate_created_entry
  BEFORE INSERT OR UPDATE OF created_entry, movement_id ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION statement_lines_validate_created_entry();

-- Leitura: pagamentos das parcelas de um contrato ---------------------------------------------------------------
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
      -- A linha conciliada com a baixa: o movimento dela (ou da perna do espelho) ou a perna da
      -- transferência; a que criou a baixa primeiro.
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

-- Comentários ---------------------------------------------------------------------------------------------------------
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
COMMENT ON COLUMN titles.planned_account_id IS
  'Conta prevista (spec 033): checking/savings da caixa do título ou de outra caixa. O contrato preenche nas parcelas; '
  'vale em qualquer título. O espelho tem a dele.';
COMMENT ON COLUMN titles.planned_transit_account_id IS
  'Conta de passagem da conta prevista: da caixa do título, obrigatória quando planned_account_id é de outra caixa e nula senão.';
COMMENT ON COLUMN titles.planned_account_custom IS
  'A conta prevista foi escolhida na parcela: trocar a conta do contrato não a muda. Padrão false (segue o contrato).';
COMMENT ON COLUMN statement_lines.created_entry IS
  'Só em matched: o lançamento ligado foi criado a partir desta linha. adjustment = o movimento avulso de movement_id; '
  'title = o título (o par com o espelho) e a baixa cujo movimento é movement_id; settlement = só a baixa cujo movimento '
  'é movement_id, num título que já existia (casar com título em aberto); transfer_settlement = a baixa num título de '
  'outra caixa (na conta de passagem) e a transferência que a financia (transfers.settlement_id), sendo movement_id a '
  'perna da transferência na conta da linha; purchase = a compra no cartão do card_invoice_item_id. Nulo = a linha foi '
  'casada com um lançamento que já existia. A aplicação grava junto com a conciliação e limpa ao desfazer ou ignorar a '
  'linha (o "desfazer e excluir o lançamento" apaga o que ela indica; em transfer_settlement, a baixa e a transferência).';
COMMENT ON COLUMN statement_lines.auto_settled IS
  'A baixa desta linha foi feita sem confirmação (contracts.auto_settle, spec 033). Só em matched com created_entry '
  'settlement ou transfer_settlement; a aplicação limpa junto com created_entry.';

-- migrate:down

DROP FUNCTION contract_payments(uuid, uuid, date);

DROP TRIGGER statement_lines_validate_created_entry ON statement_lines;
DROP FUNCTION statement_lines_validate_created_entry();

-- transfer_settlement não existia: a linha continua conciliada, sem a marca (o desfazer não
-- apaga mais a baixa e a transferência). Só created_entry muda, como no backfill da 0048.
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_supersede_validate;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines DISABLE TRIGGER statement_lines_audit;
UPDATE statement_lines SET created_entry = NULL, auto_settled = false WHERE created_entry = 'transfer_settlement';
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_audit;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_set_updated_at;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_supersede_validate;
ALTER TABLE statement_lines ENABLE TRIGGER statement_lines_validate;

ALTER TABLE statement_lines DROP CONSTRAINT statement_lines_auto_settled_check;
ALTER TABLE statement_lines DROP CONSTRAINT statement_lines_created_entry_check;
ALTER TABLE statement_lines DROP CONSTRAINT statement_lines_created_entry_links_check;
ALTER TABLE statement_lines DROP COLUMN auto_settled;
ALTER TABLE statement_lines
  ADD CONSTRAINT statement_lines_created_entry_check CHECK (
    created_entry IS NULL
    OR (created_entry IN ('adjustment', 'title', 'settlement', 'purchase') AND status = 'matched')
  ),
  ADD CONSTRAINT statement_lines_created_entry_links_check CHECK (
    CASE created_entry
      WHEN 'adjustment' THEN movement_id IS NOT NULL
      WHEN 'title'      THEN movement_id IS NOT NULL
      WHEN 'settlement' THEN movement_id IS NOT NULL
      WHEN 'purchase'   THEN card_invoice_item_id IS NOT NULL
      ELSE true
    END
  );

COMMENT ON COLUMN statement_lines.created_entry IS
  'Só em matched: o lançamento ligado foi criado a partir desta linha. adjustment = o movimento avulso de movement_id; '
  'title = o título (o par com o espelho) e a baixa cujo movimento é movement_id; settlement = só a baixa cujo movimento '
  'é movement_id, num título que já existia (casar com título em aberto); purchase = a compra no cartão do '
  'card_invoice_item_id. Nulo = a linha foi casada com um lançamento que já existia. A aplicação grava junto com a '
  'conciliação e limpa ao desfazer ou ignorar a linha (o "desfazer e excluir o lançamento" apaga o que ela indica).';

DROP TRIGGER financial_accounts_validate_payment_refs ON financial_accounts;
DROP FUNCTION financial_accounts_validate_payment_refs();
DROP TRIGGER titles_validate_planned_account ON titles;
DROP FUNCTION titles_validate_planned_account();
DROP TRIGGER contracts_validate_accounts ON contracts;
DROP FUNCTION contracts_validate_accounts();
DROP FUNCTION payment_accounts_assert(uuid, uuid, uuid, text, text, text);

ALTER TABLE titles
  DROP COLUMN planned_account_custom,
  DROP COLUMN planned_transit_account_id,
  DROP COLUMN planned_account_id;

ALTER TABLE contracts
  DROP COLUMN auto_settle,
  DROP COLUMN match_window_days,
  DROP COLUMN tolerance_cents,
  DROP COLUMN early_discount_percent,
  DROP COLUMN interest_month_percent,
  DROP COLUMN late_fee_percent,
  DROP COLUMN transit_account_id,
  DROP COLUMN payment_account_id;
