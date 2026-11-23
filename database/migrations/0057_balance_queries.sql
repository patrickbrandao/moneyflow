-- migrate:up

-- Saldos (revisão de 2026-11-21):
--   * Tarefa 092: o índice de movements por conta e data cobre o valor (INCLUDE), e as somas de saldo viram varredura
--     só de índice; statement_import_balances calcula o saldo do app uma vez por lote e entrega a divergência do
--     intervalo (interval_difference_cents) sem somar de novo desde a abertura; report_cash_projection soma o saldo de
--     hoje uma vez por conta (e não por horizonte).
--   * Tarefa 093: title_balances só soma as baixas do título parcial (aberto = valor, pago = valor baixado, cancelado
--     = 0, pelas invariantes de titles_validate_status e settlements_refresh_title_status); caixa_daily_balances e
--     report_cash_projection filtram status open/partial (indexável) junto de open_cents > 0.
--   * Tarefa 130: financial_account_balances ganha balance_today_cents (o saldo no fim de hoje em São Paulo, sem os
--     movimentos datados no futuro); balance_cents continua com todos.
--   * Tarefa 131: account_daily_balances ganha p_today e o previsto da conta (scheduled_cents, projected_cents) pelos
--     títulos em aberto com a conta prevista; balance_cents continua o realizado.

-- 092: índice de cobertura ----------------------------------------------------------------------------------------------
DROP INDEX movements_financial_account_id_occurred_on_idx;
CREATE INDEX movements_financial_account_id_occurred_on_idx ON movements (financial_account_id, occurred_on)
  INCLUDE (amount_cents);

-- 130: saldo de hoje ----------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW financial_account_balances WITH (security_invoker = true) AS
SELECT a.id AS financial_account_id,
       a.caixa_id,
       a.opening_date,
       a.opening_balance_cents,
       coalesce(m.movements_cents, 0)::bigint AS movements_cents,
       (a.opening_balance_cents + coalesce(m.movements_cents, 0))::bigint AS balance_cents,
       a.archived_at,
       (CASE WHEN a.opening_date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN a.opening_balance_cents ELSE 0 END
        + coalesce(m.today_cents, 0))::bigint AS balance_today_cents
  FROM financial_accounts a
  LEFT JOIN LATERAL (
    SELECT sum(x.amount_cents) AS movements_cents,
           sum(x.amount_cents) FILTER (WHERE x.occurred_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS today_cents
      FROM movements x WHERE x.financial_account_id = a.id
  ) m ON true;

COMMENT ON VIEW financial_account_balances IS
  'Saldo de cada conta: balance_cents = opening_balance_cents + soma de todos os movimentos (inclusive datados no '
  'futuro); balance_today_cents = o saldo no fim de hoje em America/Sao_Paulo (o saldo inicial só se a conta já abriu, '
  'mais os movimentos até hoje; tarefa 130), o "saldo atual" das telas. balance_cents − balance_today_cents = o que já '
  'está lançado com data futura. Saldo numa data: financial_account_balance_at(conta, data).';

-- 092: saldo do lote uma vez e a divergência do intervalo -----------------------------------------------------------------
-- O OFFSET 0 impede o planejador de copiar a chamada para cada coluna que a usa (app_balance_cents e difference_cents).
CREATE OR REPLACE VIEW statement_import_balances WITH (security_invoker = true) AS
SELECT i.id AS statement_import_id,
       i.financial_account_id,
       i.card_caixa_id,
       i.period_start,
       i.period_end,
       i.bank_balance_on,
       i.bank_balance_cents,
       x.app AS app_balance_cents,
       i.bank_balance_cents - x.app AS difference_cents,
       coalesce(c.lines, 0)::int AS lines,
       coalesce(c.matched, 0)::int AS matched_lines,
       coalesce(c.suggested, 0)::int AS suggested_lines,
       coalesce(c.new, 0)::int AS new_lines,
       coalesce(c.ignored, 0)::int AS ignored_lines,
       i.provisional,
       i.superseded_by_import_id IS NOT NULL AS superseded,
       -- Divergência do intervalo (spec 009): a deste lote menos a do lote anterior com saldo da mesma conta, não
       -- substituído, na ordem (data do saldo, criação). As duas divergências têm o saldo inicial e os movimentos até a
       -- data do anterior em comum, então a diferença é (banco − banco anterior) − movimentos em (anterior, este].
       -- Nula sem saldo, sem lote anterior ou com o anterior antes da abertura da conta (sem saldo do app).
       CASE WHEN x.app IS NOT NULL THEN (
         SELECT CASE WHEN pv.bank_balance_on >= a.opening_date THEN
                  (i.bank_balance_cents - pv.bank_balance_cents)
                  - coalesce((SELECT sum(m.amount_cents) FROM movements m
                               WHERE m.financial_account_id = i.financial_account_id
                                 AND m.occurred_on > pv.bank_balance_on AND m.occurred_on <= i.bank_balance_on), 0)
                END::bigint
           FROM (SELECT p.bank_balance_on, p.bank_balance_cents
                   FROM statement_imports p
                  WHERE p.financial_account_id = i.financial_account_id AND p.bank_balance_on IS NOT NULL
                    AND p.superseded_by_import_id IS NULL
                    AND (p.bank_balance_on, p.created_at) < (i.bank_balance_on, i.created_at)
                  ORDER BY p.bank_balance_on DESC, p.created_at DESC
                  LIMIT 1) pv
           JOIN financial_accounts a ON a.id = i.financial_account_id)
       END AS interval_difference_cents
  FROM statement_imports i
  LEFT JOIN LATERAL (
    SELECT financial_account_balance_at(i.financial_account_id, i.bank_balance_on) AS app
     WHERE i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL
    OFFSET 0
  ) x ON true
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
  'divergência), calculado uma vez por lote, e contagem de linhas por status (lines inclui as superseded). Saldo só '
  'para contas (não para cartão). interval_difference_cents (tarefa 092) = difference_cents menos a do lote anterior '
  'com saldo da mesma conta, não substituído, na ordem (bank_balance_on, created_at); nula sem lote anterior ou com ele '
  'antes da abertura. provisional e superseded (spec 031): a aplicação tira os substituídos da divergência (o "lote '
  'anterior" já os exclui).';

-- 093: title_balances sem somar as baixas de quem não é parcial ---------------------------------------------------------------
-- Pelas invariantes do banco (titles_validate_status e settlements_refresh_title_status, imediatas): open = nenhuma
-- baixa ativa, paid = baixado igual ao valor, canceled = nenhuma baixa ativa. Só o parcial precisa somar.
CREATE OR REPLACE VIEW title_balances WITH (security_invoker = true) AS
SELECT t.id AS title_id,
       t.caixa_id,
       t.direction,
       t.status,
       t.entity_id,
       t.category_id,
       t.description,
       t.competence_date,
       t.due_date,
       t.amount_cents,
       (CASE t.status
          WHEN 'paid' THEN t.amount_cents
          WHEN 'partial' THEN (SELECT coalesce(sum(x.amount_cents), 0) FROM settlements x
                                WHERE x.title_id = t.id AND x.reversed_at IS NULL)
          ELSE 0 END)::bigint AS settled_cents,
       (CASE t.status
          WHEN 'open' THEN t.amount_cents
          WHEN 'partial' THEN t.amount_cents - (SELECT coalesce(sum(x.amount_cents), 0) FROM settlements x
                                                 WHERE x.title_id = t.id AND x.reversed_at IS NULL)
          ELSE 0 END)::bigint AS open_cents,
       t.archived_at
  FROM titles t;

COMMENT ON VIEW title_balances IS
  'Títulos com principal baixado (baixas ativas) e saldo aberto (amount − baixado; 0 se cancelado). Títulos em aberto: '
  'open_cents > 0, o mesmo que status IN (''open'', ''partial''): filtre também pelo status, que é indexável '
  '(titles_caixa_id_status_due_date_idx). Só o parcial soma as baixas; aberto, pago e cancelado saem do status '
  '(invariantes de titles_validate_status e settlements_refresh_title_status; tarefa 093).';

-- 093: calendário da caixa com o filtro indexável ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION caixa_daily_balances(p_caixa_id uuid, p_from date, p_to date,
                                                p_today date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date)
RETURNS TABLE (day date, realized_cents bigint, scheduled_cents bigint, projected_cents bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'caixa_daily_balances: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH accs AS (
    SELECT a.id, a.opening_date, a.opening_balance_cents FROM financial_accounts a WHERE a.caixa_id = p_caixa_id
  ),
  before AS (
    SELECT coalesce(sum(m.amount_cents), 0) AS cents
      FROM movements m JOIN accs ON accs.id = m.financial_account_id
     WHERE m.occurred_on < p_from
  ),
  daily AS (
    SELECT m.occurred_on AS d, sum(m.amount_cents) AS delta
      FROM movements m JOIN accs ON accs.id = m.financial_account_id
     WHERE m.occurred_on BETWEEN p_from AND p_to
     GROUP BY m.occurred_on
  ),
  -- Previsto: saldo aberto dos títulos (vencidos contam a partir de hoje) e faturas abertas da pagadora.
  pending AS (
    SELECT greatest(b.due_date, p_today) AS d,
           sum(CASE b.direction WHEN 'receivable' THEN b.open_cents ELSE -b.open_cents END) AS delta
      FROM title_balances b
      JOIN titles t ON t.id = b.title_id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE b.caixa_id = p_caixa_id AND b.status IN ('open', 'partial') AND b.due_date <= p_to
       AND b.open_cents > 0 AND b.archived_at IS NULL
       AND greatest(b.due_date, p_today) <= p_to
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
     GROUP BY 1
    UNION ALL
    SELECT greatest(x.due_date, p_today), -sum(x.items_cents - x.settled_cents)
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = p_caixa_id AND x.items_cents - x.settled_cents > 0
       AND greatest(x.due_date, p_today) <= p_to
     GROUP BY 1
  ),
  pending_daily AS (
    SELECT p.d, sum(p.delta) AS delta FROM pending p GROUP BY p.d
  ),
  pending_before AS (
    SELECT coalesce(sum(p.delta), 0) AS cents FROM pending_daily p WHERE p.d < p_from
  ),
  series AS (
    SELECT g.d::date AS day,
           (SELECT coalesce(sum(accs.opening_balance_cents), 0) FROM accs WHERE accs.opening_date <= g.d::date)
           + before.cents
           + sum(coalesce(daily.delta, 0)) OVER w AS realized,
           pending_before.cents + sum(coalesce(pd.delta, 0)) OVER w AS scheduled
      FROM generate_series(p_from, p_to, interval '1 day') g (d)
      CROSS JOIN before
      CROSS JOIN pending_before
      LEFT JOIN daily ON daily.d = g.d::date
      LEFT JOIN pending_daily pd ON pd.d = g.d::date
    WINDOW w AS (ORDER BY g.d)
  )
  SELECT s.day,
         s.realized::bigint,
         (CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint,
         (s.realized + CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint
    FROM series s
   ORDER BY s.day;
END
$$;

-- 131: calendário da conta com o previsto pela conta prevista ------------------------------------------------------------
DROP FUNCTION account_daily_balances(uuid, date, date);
CREATE FUNCTION account_daily_balances(p_account_id uuid, p_from date, p_to date,
                                       p_today date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date)
RETURNS TABLE (day date, balance_cents bigint, scheduled_cents bigint, projected_cents bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'account_daily_balances: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_today IS NULL THEN
    RAISE EXCEPTION 'account_daily_balances: today must be set' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH acc AS (
    SELECT a.id, a.opening_date, a.opening_balance_cents,
           coalesce((SELECT sum(m.amount_cents) FROM movements m
                      WHERE m.financial_account_id = a.id AND m.occurred_on < p_from), 0) AS before_cents
      FROM financial_accounts a WHERE a.id = p_account_id
  ),
  daily AS (
    SELECT m.occurred_on AS d, sum(m.amount_cents) AS delta
      FROM movements m
     WHERE m.financial_account_id = p_account_id AND m.occurred_on BETWEEN p_from AND p_to
     GROUP BY m.occurred_on
  ),
  -- Previsto: saldo aberto dos títulos com esta conta prevista (vencidos contam a partir de hoje), como na caixa.
  pending_daily AS (
    SELECT greatest(b.due_date, p_today) AS d,
           sum(CASE b.direction WHEN 'receivable' THEN b.open_cents ELSE -b.open_cents END) AS delta
      FROM titles t
      JOIN title_balances b ON b.title_id = t.id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE t.planned_account_id = p_account_id AND t.status IN ('open', 'partial') AND t.due_date <= p_to
       AND t.archived_at IS NULL AND b.open_cents > 0
       AND greatest(t.due_date, p_today) <= p_to
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
     GROUP BY 1
  ),
  pending_before AS (
    SELECT coalesce(sum(p.delta), 0) AS cents FROM pending_daily p WHERE p.d < p_from
  ),
  series AS (
    SELECT g.d::date AS day,
           CASE WHEN g.d < acc.opening_date THEN NULL
                ELSE acc.opening_balance_cents + acc.before_cents + sum(coalesce(daily.delta, 0)) OVER w END AS realized,
           pending_before.cents + sum(coalesce(pd.delta, 0)) OVER w AS scheduled
      FROM acc
      CROSS JOIN generate_series(p_from, p_to, interval '1 day') g (d)
      CROSS JOIN pending_before
      LEFT JOIN daily ON daily.d = g.d::date
      LEFT JOIN pending_daily pd ON pd.d = g.d::date
    WINDOW w AS (ORDER BY g.d)
  )
  SELECT s.day,
         s.realized::bigint,
         (CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint,
         (s.realized + CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint
    FROM series s
   ORDER BY s.day;
END
$$;

COMMENT ON FUNCTION account_daily_balances(uuid, date, date, date) IS
  'Por dia: balance_cents = saldo realizado da conta no fim do dia (saldo inicial + movimentos até o dia, inclusive os '
  'datados no futuro); scheduled_cents = a partir de p_today (padrão = hoje em America/Sao_Paulo), saldo aberto '
  'acumulado dos títulos não arquivados com esta conta prevista (planned_account_id; + receber, − pagar; vencidos '
  'entram em p_today), 0 antes de p_today; projected_cents = balance + scheduled (tarefa 131). balance e projected '
  'NULL antes da abertura; nenhuma linha se a conta não existe. Títulos sem conta prevista só entram no previsto da '
  'caixa (caixa_daily_balances). Até 1100 dias (erro 22023).';

-- 092 e 093: projeção com o saldo de hoje uma vez por conta e o filtro indexável -------------------------------------------
CREATE OR REPLACE FUNCTION report_cash_projection(p_caixa_ids uuid[],
                                                  p_today date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
                                                  p_horizons integer[] DEFAULT '{30,60,90}'::integer[],
                                                  p_entity_ids uuid[] DEFAULT NULL::uuid[])
RETURNS TABLE (caixa_id uuid, financial_account_id uuid, horizon_days integer, until date, balance_today_cents bigint,
               scheduled_movements_cents bigint, overdue_receivable_cents bigint, overdue_payable_cents bigint,
               receivable_cents bigint, payable_cents bigint, projected_cents bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_last date;
BEGIN
  IF p_today IS NULL OR p_horizons IS NULL OR cardinality(p_horizons) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_horizons) h WHERE h IS NULL OR h < 1 OR h > 1100) THEN
    RAISE EXCEPTION 'report_cash_projection: horizons must be 1..1100 days and today must be set'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_last := p_today + (SELECT max(h) FROM unnest(p_horizons) h);

  RETURN QUERY
  WITH hz AS (
    SELECT DISTINCT h AS days, p_today + h AS until FROM unnest(p_horizons) h
  ),
  -- Por conta, uma vez: saldo no fim de hoje.
  accs AS MATERIALIZED (
    SELECT a.id, a.caixa_id, a.opening_date, a.opening_balance_cents,
           (CASE WHEN a.opening_date <= p_today THEN a.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = a.id AND m.occurred_on <= p_today), 0))::bigint AS today_cents
      FROM financial_accounts a
      JOIN caixas c ON c.id = a.caixa_id AND c.kind = 'general'
     WHERE a.caixa_id = ANY (p_caixa_ids)
  ),
  -- Por conta e horizonte: o que já está lançado com data futura (até o horizonte).
  acc_rows AS (
    SELECT accs.caixa_id, accs.id AS account_id, hz.days, hz.until, accs.today_cents,
           (CASE WHEN p_entity_ids IS NULL AND accs.opening_date > p_today AND accs.opening_date <= hz.until
                 THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id
                           AND m.occurred_on > p_today AND m.occurred_on <= hz.until
                           AND (p_entity_ids IS NULL OR movement_counterparty(m.kind, m.settlement_id, m.entity_id)
                                                         = ANY (p_entity_ids))), 0))::bigint AS future_cents
      FROM accs CROSS JOIN hz
  ),
  -- Previsto da caixa: saldo aberto dos títulos (não arquivados) até o horizonte, vencidos à parte,
  -- e as faturas abertas em que ela é pagadora (itens − antecipações), como no calendário.
  open_items AS (
    SELECT b.caixa_id, b.direction, b.due_date, b.open_cents
      FROM title_balances b
      JOIN titles t ON t.id = b.title_id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE b.caixa_id = ANY (p_caixa_ids) AND b.status IN ('open', 'partial') AND b.due_date <= v_last
       AND b.open_cents > 0 AND b.archived_at IS NULL
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
       AND (p_entity_ids IS NULL OR (t.origin <> 'card_invoice' AND t.entity_id = ANY (p_entity_ids)))
    UNION ALL
    SELECT x.payer_caixa_id, 'payable', x.due_date, (x.items_cents - x.settled_cents)::bigint
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = ANY (p_caixa_ids) AND x.items_cents - x.settled_cents > 0
       AND p_entity_ids IS NULL
  ),
  caixa_rows AS (
    SELECT c.id AS caixa_id, hz.days, hz.until,
           coalesce((SELECT sum(r.today_cents) FROM acc_rows r WHERE r.caixa_id = c.id AND r.days = hz.days), 0)::bigint AS today_cents,
           coalesce((SELECT sum(r.future_cents) FROM acc_rows r WHERE r.caixa_id = c.id AND r.days = hz.days), 0)::bigint AS future_cents,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'receivable' AND o.due_date < p_today), 0)::bigint AS od_rec,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'payable' AND o.due_date < p_today), 0)::bigint AS od_pay,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'receivable' AND o.due_date <= hz.until), 0)::bigint AS rec,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'payable' AND o.due_date <= hz.until), 0)::bigint AS pay
      FROM caixas c
      CROSS JOIN hz
      LEFT JOIN open_items o ON o.caixa_id = c.id
     WHERE c.id = ANY (p_caixa_ids) AND c.kind = 'general'
     GROUP BY c.id, hz.days, hz.until
  )
  SELECT r.caixa_id, NULL::uuid, r.days, r.until, r.today_cents, r.future_cents, r.od_rec, r.od_pay, r.rec, r.pay,
         (r.today_cents + r.future_cents + r.rec - r.pay)::bigint
    FROM caixa_rows r
  UNION ALL
  SELECT r.caixa_id, r.account_id, r.days, r.until, r.today_cents, r.future_cents, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
         (r.today_cents + r.future_cents)::bigint
    FROM acc_rows r
   ORDER BY 1, 2 NULLS FIRST, 3;
END
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION report_cash_projection(p_caixa_ids uuid[],
                                                  p_today date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
                                                  p_horizons integer[] DEFAULT '{30,60,90}'::integer[],
                                                  p_entity_ids uuid[] DEFAULT NULL::uuid[])
RETURNS TABLE (caixa_id uuid, financial_account_id uuid, horizon_days integer, until date, balance_today_cents bigint,
               scheduled_movements_cents bigint, overdue_receivable_cents bigint, overdue_payable_cents bigint,
               receivable_cents bigint, payable_cents bigint, projected_cents bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_today IS NULL OR p_horizons IS NULL OR cardinality(p_horizons) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_horizons) h WHERE h IS NULL OR h < 1 OR h > 1100) THEN
    RAISE EXCEPTION 'report_cash_projection: horizons must be 1..1100 days and today must be set'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH hz AS (
    SELECT DISTINCT h AS days, p_today + h AS until FROM unnest(p_horizons) h
  ),
  accs AS (
    SELECT a.id, a.caixa_id, a.opening_date, a.opening_balance_cents
      FROM financial_accounts a
      JOIN caixas c ON c.id = a.caixa_id AND c.kind = 'general'
     WHERE a.caixa_id = ANY (p_caixa_ids)
  ),
  -- Por conta: saldo no fim de hoje e o que já está lançado com data futura (até o horizonte).
  acc_rows AS (
    SELECT accs.caixa_id, accs.id AS account_id, hz.days, hz.until,
           (CASE WHEN accs.opening_date <= p_today THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id AND m.occurred_on <= p_today), 0))::bigint AS today_cents,
           (CASE WHEN p_entity_ids IS NULL AND accs.opening_date > p_today AND accs.opening_date <= hz.until
                 THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id
                           AND m.occurred_on > p_today AND m.occurred_on <= hz.until
                           AND (p_entity_ids IS NULL OR movement_counterparty(m.kind, m.settlement_id, m.entity_id)
                                                         = ANY (p_entity_ids))), 0))::bigint AS future_cents
      FROM accs CROSS JOIN hz
  ),
  -- Previsto da caixa: saldo aberto dos títulos (não arquivados) até o horizonte, vencidos à parte,
  -- e as faturas abertas em que ela é pagadora (itens − antecipações), como no calendário.
  open_items AS (
    SELECT b.caixa_id, b.direction, b.due_date, b.open_cents
      FROM title_balances b
      JOIN titles t ON t.id = b.title_id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE b.caixa_id = ANY (p_caixa_ids) AND b.open_cents > 0 AND b.archived_at IS NULL
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
       AND (p_entity_ids IS NULL OR (t.origin <> 'card_invoice' AND t.entity_id = ANY (p_entity_ids)))
    UNION ALL
    SELECT x.payer_caixa_id, 'payable', x.due_date, (x.items_cents - x.settled_cents)::bigint
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = ANY (p_caixa_ids) AND x.items_cents - x.settled_cents > 0
       AND p_entity_ids IS NULL
  ),
  caixa_rows AS (
    SELECT c.id AS caixa_id, hz.days, hz.until,
           coalesce((SELECT sum(r.today_cents) FROM acc_rows r WHERE r.caixa_id = c.id AND r.days = hz.days), 0)::bigint AS today_cents,
           coalesce((SELECT sum(r.future_cents) FROM acc_rows r WHERE r.caixa_id = c.id AND r.days = hz.days), 0)::bigint AS future_cents,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'receivable' AND o.due_date < p_today), 0)::bigint AS od_rec,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'payable' AND o.due_date < p_today), 0)::bigint AS od_pay,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'receivable' AND o.due_date <= hz.until), 0)::bigint AS rec,
           coalesce(sum(o.open_cents) FILTER (WHERE o.direction = 'payable' AND o.due_date <= hz.until), 0)::bigint AS pay
      FROM caixas c
      CROSS JOIN hz
      LEFT JOIN open_items o ON o.caixa_id = c.id
     WHERE c.id = ANY (p_caixa_ids) AND c.kind = 'general'
     GROUP BY c.id, hz.days, hz.until
  )
  SELECT r.caixa_id, NULL::uuid, r.days, r.until, r.today_cents, r.future_cents, r.od_rec, r.od_pay, r.rec, r.pay,
         (r.today_cents + r.future_cents + r.rec - r.pay)::bigint
    FROM caixa_rows r
  UNION ALL
  SELECT r.caixa_id, r.account_id, r.days, r.until, r.today_cents, r.future_cents, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
         (r.today_cents + r.future_cents)::bigint
    FROM acc_rows r
   ORDER BY 1, 2 NULLS FIRST, 3;
END
$$;

DROP FUNCTION account_daily_balances(uuid, date, date, date);
CREATE FUNCTION account_daily_balances(p_account_id uuid, p_from date, p_to date)
RETURNS TABLE (day date, balance_cents bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'account_daily_balances: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH acc AS (
    SELECT a.id, a.opening_date, a.opening_balance_cents,
           coalesce((SELECT sum(m.amount_cents) FROM movements m
                      WHERE m.financial_account_id = a.id AND m.occurred_on < p_from), 0) AS before_cents
      FROM financial_accounts a WHERE a.id = p_account_id
  ),
  daily AS (
    SELECT m.occurred_on AS d, sum(m.amount_cents) AS delta
      FROM movements m
     WHERE m.financial_account_id = p_account_id AND m.occurred_on BETWEEN p_from AND p_to
     GROUP BY m.occurred_on
  )
  SELECT g.d::date,
         CASE WHEN g.d < acc.opening_date THEN NULL
              ELSE (acc.opening_balance_cents + acc.before_cents
                    + sum(coalesce(daily.delta, 0)) OVER (ORDER BY g.d))::bigint END
    FROM acc
    CROSS JOIN generate_series(p_from, p_to, interval '1 day') g (d)
    LEFT JOIN daily ON daily.d = g.d::date
   ORDER BY 1;
END
$$;

COMMENT ON FUNCTION account_daily_balances(uuid, date, date) IS
  'Saldo da conta no fim de cada dia do período (saldo inicial + movimentos até o dia, inclusive os datados no '
  'futuro); NULL antes da abertura; nenhuma linha se a conta não existe. Até 1100 dias (erro 22023).';

CREATE OR REPLACE FUNCTION caixa_daily_balances(p_caixa_id uuid, p_from date, p_to date,
                                                p_today date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date)
RETURNS TABLE (day date, realized_cents bigint, scheduled_cents bigint, projected_cents bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'caixa_daily_balances: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH accs AS (
    SELECT a.id, a.opening_date, a.opening_balance_cents FROM financial_accounts a WHERE a.caixa_id = p_caixa_id
  ),
  before AS (
    SELECT coalesce(sum(m.amount_cents), 0) AS cents
      FROM movements m JOIN accs ON accs.id = m.financial_account_id
     WHERE m.occurred_on < p_from
  ),
  daily AS (
    SELECT m.occurred_on AS d, sum(m.amount_cents) AS delta
      FROM movements m JOIN accs ON accs.id = m.financial_account_id
     WHERE m.occurred_on BETWEEN p_from AND p_to
     GROUP BY m.occurred_on
  ),
  -- Previsto: saldo aberto dos títulos (vencidos contam a partir de hoje) e faturas abertas da pagadora.
  pending AS (
    SELECT greatest(b.due_date, p_today) AS d,
           sum(CASE b.direction WHEN 'receivable' THEN b.open_cents ELSE -b.open_cents END) AS delta
      FROM title_balances b
      JOIN titles t ON t.id = b.title_id
      LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
     WHERE b.caixa_id = p_caixa_id AND b.open_cents > 0 AND b.archived_at IS NULL
       AND greatest(b.due_date, p_today) <= p_to
       AND (v.id IS NULL OR v.closed_at IS NOT NULL)
     GROUP BY 1
    UNION ALL
    SELECT greatest(x.due_date, p_today), -sum(x.items_cents - x.settled_cents)
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = p_caixa_id AND x.items_cents - x.settled_cents > 0
       AND greatest(x.due_date, p_today) <= p_to
     GROUP BY 1
  ),
  pending_daily AS (
    SELECT p.d, sum(p.delta) AS delta FROM pending p GROUP BY p.d
  ),
  pending_before AS (
    SELECT coalesce(sum(p.delta), 0) AS cents FROM pending_daily p WHERE p.d < p_from
  ),
  series AS (
    SELECT g.d::date AS day,
           (SELECT coalesce(sum(accs.opening_balance_cents), 0) FROM accs WHERE accs.opening_date <= g.d::date)
           + before.cents
           + sum(coalesce(daily.delta, 0)) OVER w AS realized,
           pending_before.cents + sum(coalesce(pd.delta, 0)) OVER w AS scheduled
      FROM generate_series(p_from, p_to, interval '1 day') g (d)
      CROSS JOIN before
      CROSS JOIN pending_before
      LEFT JOIN daily ON daily.d = g.d::date
      LEFT JOIN pending_daily pd ON pd.d = g.d::date
    WINDOW w AS (ORDER BY g.d)
  )
  SELECT s.day,
         s.realized::bigint,
         (CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint,
         (s.realized + CASE WHEN s.day < p_today THEN 0 ELSE s.scheduled END)::bigint
    FROM series s
   ORDER BY s.day;
END
$$;

CREATE OR REPLACE VIEW title_balances WITH (security_invoker = true) AS
SELECT t.id AS title_id,
       t.caixa_id,
       t.direction,
       t.status,
       t.entity_id,
       t.category_id,
       t.description,
       t.competence_date,
       t.due_date,
       t.amount_cents,
       coalesce(s.settled_cents, 0)::bigint AS settled_cents,
       (CASE WHEN t.status = 'canceled' THEN 0 ELSE t.amount_cents - coalesce(s.settled_cents, 0) END)::bigint AS open_cents,
       t.archived_at
  FROM titles t
  LEFT JOIN LATERAL (
    SELECT sum(x.amount_cents) AS settled_cents FROM settlements x WHERE x.title_id = t.id AND x.reversed_at IS NULL
  ) s ON true;

COMMENT ON VIEW title_balances IS
  'Títulos com principal baixado (baixas ativas) e saldo aberto (amount − baixado; 0 se cancelado). Títulos em aberto: open_cents > 0.';

-- As colunas novas saem: recria as visões com as colunas de antes (CREATE OR REPLACE não remove colunas).
DROP VIEW statement_import_balances;
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
       coalesce(c.ignored, 0)::int AS ignored_lines,
       i.provisional,
       i.superseded_by_import_id IS NOT NULL AS superseded
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
  'divergência) e contagem de linhas por status (lines inclui as superseded). Saldo só para contas (não para cartão). '
  'provisional e superseded (spec 031): a aplicação tira os substituídos da divergência e do "lote anterior".';

DROP VIEW financial_account_balances;
CREATE VIEW financial_account_balances WITH (security_invoker = true) AS
SELECT a.id AS financial_account_id,
       a.caixa_id,
       a.opening_date,
       a.opening_balance_cents,
       coalesce(m.movements_cents, 0)::bigint AS movements_cents,
       (a.opening_balance_cents + coalesce(m.movements_cents, 0))::bigint AS balance_cents,
       a.archived_at
  FROM financial_accounts a
  LEFT JOIN LATERAL (
    SELECT sum(x.amount_cents) AS movements_cents FROM movements x WHERE x.financial_account_id = a.id
  ) m ON true;

COMMENT ON VIEW financial_account_balances IS
  'Saldo de cada conta: opening_balance_cents + soma de todos os movimentos (inclusive datados no futuro). Saldo numa data: financial_account_balance_at(conta, data).';

DROP INDEX movements_financial_account_id_occurred_on_idx;
CREATE INDEX movements_financial_account_id_occurred_on_idx ON movements (financial_account_id, occurred_on);
