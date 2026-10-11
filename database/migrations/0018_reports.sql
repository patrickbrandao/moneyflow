-- migrate:up

-- Relatórios (spec 014): despesa/receita por categoria, totais por entidade e fluxo
-- de caixa projetado. Funções SECURITY INVOKER: a aplicação aplica a permissão
-- passando só as caixas que o usuário pode ver (p_caixa_ids).
--
-- Regimes (spec 008, padrão = competência):
--   competence  títulos não cancelados pela competence_date (arquivados contam), EXCETO os
--               títulos card_invoice; as despesas do cartão entram pelas compras
--               (card_purchases) na data da compra, com a categoria e a pagadora de cada
--               uma (estorno subtrai), para não contar a mesma despesa duas vezes (spec 007).
--   cash        movimentos pela data: os de baixa (inclusive o estorno, que subtrai) com a
--               categoria do título e os ajustes com a própria categoria (ou sem categoria).
--               Transferências nunca contam. O pagamento da fatura do cartão conta como o
--               pagamento do título card_invoice da pagadora, com a categoria desse título,
--               marcado source = 'card_invoice_payment' (spec 007: "no regime de caixa vale o
--               pagamento da fatura"); não é rateado pelas compras.
-- is_internal = o título tem espelho numa caixa que também está em p_caixa_ids (o mesmo
-- valor aparece como despesa numa e receita na outra); no consolidado a aplicação pode
-- descartar essas linhas. Pagamento de fatura e compras nunca são internos.

-- Validação comum dos parâmetros de período e regime.
CREATE FUNCTION report_check_period(p_fn text, p_from date, p_to date, p_basis text DEFAULT 'competence')
RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION '%: invalid period % .. % (max 3660 days)', p_fn, p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_basis IS NULL OR p_basis NOT IN ('competence', 'cash') THEN
    RAISE EXCEPTION '%: basis must be competence or cash, got %', p_fn, p_basis
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$$;

COMMENT ON FUNCTION report_check_period(text, date, date, text) IS
  'Interna dos relatórios: erro 22023 se o período é inválido (até 3660 dias) ou o regime não é competence/cash.';

-- Despesa e receita por categoria e mês ---------------------------------------------------------
CREATE FUNCTION report_category_totals(
  p_caixa_ids uuid[],
  p_from      date,
  p_to        date,
  p_basis     text DEFAULT 'competence'
)
RETURNS TABLE (
  month             date,
  caixa_id          uuid,
  card_caixa_id     uuid,
  kind              text,
  group_category_id uuid,
  category_id       uuid,
  source            text,
  is_internal       boolean,
  amount_cents      bigint,
  entries           int
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM report_check_period('report_category_totals', p_from, p_to, p_basis);

  IF p_basis = 'competence' THEN
    RETURN QUERY
    WITH lines AS (
      SELECT date_trunc('month', t.competence_date)::date AS month,
             t.caixa_id,
             NULL::uuid AS card_caixa_id,
             c.kind,
             coalesce(c.parent_id, c.id) AS group_category_id,
             c.id AS category_id,
             'title'::text AS source,
             coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false) AS is_internal,
             t.amount_cents
        FROM titles t
        JOIN categories c ON c.id = t.category_id
       WHERE t.caixa_id = ANY (p_caixa_ids)
         AND t.competence_date BETWEEN p_from AND p_to
         AND t.status <> 'canceled'
         AND t.origin <> 'card_invoice'
      UNION ALL
      SELECT date_trunc('month', p.purchased_on)::date,
             p.payer_caixa_id,
             p.card_caixa_id,
             c.kind,
             coalesce(c.parent_id, c.id),
             c.id,
             'card_purchase'::text,
             false,
             CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END
        FROM card_purchases p
        JOIN categories c ON c.id = p.category_id
       WHERE (p.payer_caixa_id = ANY (p_caixa_ids) OR p.card_caixa_id = ANY (p_caixa_ids))
         AND p.purchased_on BETWEEN p_from AND p_to
    )
    SELECT l.month, l.caixa_id, l.card_caixa_id, l.kind, l.group_category_id, l.category_id, l.source,
           l.is_internal, sum(l.amount_cents)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
     ORDER BY 1, 2, 4, 5, 6, 7, 8, 3;
  ELSE
    RETURN QUERY
    WITH lines AS (
      SELECT date_trunc('month', m.occurred_on)::date AS month,
             a.caixa_id,
             CASE WHEN t.origin = 'card_invoice' THEN t.counterparty_caixa_id END AS card_caixa_id,
             c.kind,
             coalesce(c.parent_id, c.id) AS group_category_id,
             c.id AS category_id,
             CASE WHEN t.origin = 'card_invoice' THEN 'card_invoice_payment' ELSE 'settlement' END AS source,
             (t.origin <> 'card_invoice' AND coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false)) AS is_internal,
             CASE c.kind WHEN 'expense' THEN -m.amount_cents ELSE m.amount_cents END AS amount_cents
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
        JOIN settlements s ON s.id = m.settlement_id
        JOIN titles t ON t.id = s.title_id
        JOIN categories c ON c.id = t.category_id
       WHERE m.kind = 'settlement'
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
      UNION ALL
      SELECT date_trunc('month', m.occurred_on)::date,
             a.caixa_id,
             NULL::uuid,
             x.kind,
             coalesce(c.parent_id, c.id),
             c.id,
             'adjustment'::text,
             false,
             CASE x.kind WHEN 'expense' THEN -m.amount_cents ELSE m.amount_cents END
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
        LEFT JOIN categories c ON c.id = m.category_id
        CROSS JOIN LATERAL (
          SELECT coalesce(c.kind, CASE WHEN m.amount_cents > 0 THEN 'income' ELSE 'expense' END) AS kind
        ) x
       WHERE m.kind = 'adjustment'
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
    )
    SELECT l.month, l.caixa_id, l.card_caixa_id, l.kind, l.group_category_id, l.category_id, l.source,
           l.is_internal, sum(l.amount_cents)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
     ORDER BY 1, 2, 4, 5, 6, 7, 8, 3;
  END IF;
END
$$;

COMMENT ON FUNCTION report_category_totals(uuid[], date, date, text) IS
  'Despesa/receita por mês, caixa e categoria (spec 014). p_basis: competence (padrão) ou cash. Uma linha por '
  '(month, caixa_id, card_caixa_id, kind, group_category_id, category_id, source, is_internal) com amount_cents '
  '(positivo = despesa em expense, receita em income; estornos subtraem) e entries. '
  'competence: source title (títulos não cancelados pela competência, sem os card_invoice) e card_purchase '
  '(compras/encargos/estornos do cartão pela data da compra, caixa_id = pagadora, card_caixa_id = cartão; entram se '
  'a pagadora OU o cartão está em p_caixa_ids). cash: source settlement (movimentos de baixa pela data, categoria do '
  'título), card_invoice_payment (pagamento da fatura pela pagadora, categoria do título da fatura, card_caixa_id = '
  'cartão; não rateado pelas compras) e adjustment (ajustes; sem categoria = category_id nulo, kind pelo sinal). '
  'Transferências nunca contam. is_internal: espelho cuja outra caixa também está na lista. Erro 22023: período '
  'inválido (até 3660 dias) ou regime desconhecido.';

-- Totais por entidade (contraparte) --------------------------------------------------------------
CREATE FUNCTION report_entity_totals(
  p_caixa_ids uuid[],
  p_from      date,
  p_to        date,
  p_basis     text DEFAULT 'competence'
)
RETURNS TABLE (
  entity_id     uuid,
  caixa_id      uuid,
  card_caixa_id uuid,
  source        text,
  is_internal   boolean,
  outflow_cents bigint,
  inflow_cents  bigint,
  entries       int
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM report_check_period('report_entity_totals', p_from, p_to, p_basis);

  IF p_basis = 'competence' THEN
    RETURN QUERY
    WITH lines AS (
      SELECT t.entity_id,
             t.caixa_id,
             NULL::uuid AS card_caixa_id,
             'title'::text AS source,
             coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false) AS is_internal,
             CASE t.direction WHEN 'payable' THEN t.amount_cents ELSE 0 END AS outflow,
             CASE t.direction WHEN 'receivable' THEN t.amount_cents ELSE 0 END AS inflow
        FROM titles t
       WHERE t.caixa_id = ANY (p_caixa_ids)
         AND t.competence_date BETWEEN p_from AND p_to
         AND t.status <> 'canceled'
         AND t.origin <> 'card_invoice'
      UNION ALL
      SELECT p.entity_id,
             p.payer_caixa_id,
             p.card_caixa_id,
             'card_purchase'::text,
             false,
             CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END,
             0
        FROM card_purchases p
       WHERE (p.payer_caixa_id = ANY (p_caixa_ids) OR p.card_caixa_id = ANY (p_caixa_ids))
         AND p.purchased_on BETWEEN p_from AND p_to
    )
    SELECT l.entity_id, l.caixa_id, l.card_caixa_id, l.source, l.is_internal,
           sum(l.outflow)::bigint, sum(l.inflow)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1, 2, 4, 5, 3;
  ELSE
    RETURN QUERY
    WITH lines AS (
      SELECT t.entity_id,
             a.caixa_id,
             CASE WHEN t.origin = 'card_invoice' THEN t.counterparty_caixa_id END AS card_caixa_id,
             CASE WHEN t.origin = 'card_invoice' THEN 'card_invoice_payment' ELSE 'settlement' END AS source,
             (t.origin <> 'card_invoice' AND coalesce(t.counterparty_caixa_id = ANY (p_caixa_ids), false)) AS is_internal,
             CASE t.direction WHEN 'payable' THEN -m.amount_cents ELSE 0 END AS outflow,
             CASE t.direction WHEN 'receivable' THEN m.amount_cents ELSE 0 END AS inflow
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
        JOIN settlements s ON s.id = m.settlement_id
        JOIN titles t ON t.id = s.title_id
       WHERE m.kind = 'settlement'
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
      UNION ALL
      SELECT m.entity_id,
             a.caixa_id,
             NULL::uuid,
             'adjustment'::text,
             false,
             greatest(-m.amount_cents, 0),
             greatest(m.amount_cents, 0)
        FROM movements m
        JOIN financial_accounts a ON a.id = m.financial_account_id
       WHERE m.kind = 'adjustment'
         AND m.entity_id IS NOT NULL
         AND a.caixa_id = ANY (p_caixa_ids)
         AND m.occurred_on BETWEEN p_from AND p_to
    )
    SELECT l.entity_id, l.caixa_id, l.card_caixa_id, l.source, l.is_internal,
           sum(l.outflow)::bigint, sum(l.inflow)::bigint, count(*)::int
      FROM lines l
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1, 2, 4, 5, 3;
  END IF;
END
$$;

COMMENT ON FUNCTION report_entity_totals(uuid[], date, date, text) IS
  'Pago (outflow_cents) e recebido (inflow_cents) por entidade e caixa no período (spec 014). competence (padrão): '
  'títulos não cancelados pela competência, sem os card_invoice (source title), e compras do cartão pela data com o '
  'RECEBEDOR FINAL como entidade (source card_purchase; caixa_id = pagadora, card_caixa_id = cartão: rastreio '
  'pagadora → cartão → lojista; estorno subtrai). cash: movimentos de baixa pela data (source settlement; estorno '
  'subtrai), pagamento de fatura ao emissor (source card_invoice_payment, card_caixa_id = cartão; os lojistas ficam '
  'no regime de competência) e ajustes com entidade (source adjustment, pelo sinal). Transferências nunca contam. '
  'is_internal como em report_category_totals. Erro 22023: período ou regime inválido.';

-- Fluxo de caixa projetado ----------------------------------------------------------------------
CREATE FUNCTION report_cash_projection(
  p_caixa_ids uuid[],
  p_today     date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  p_horizons  int[] DEFAULT '{30,60,90}'
)
RETURNS TABLE (
  caixa_id                 uuid,
  financial_account_id     uuid,
  horizon_days             int,
  until                    date,
  balance_today_cents      bigint,
  scheduled_movements_cents bigint,
  overdue_receivable_cents bigint,
  overdue_payable_cents    bigint,
  receivable_cents         bigint,
  payable_cents            bigint,
  projected_cents          bigint
)
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
           (CASE WHEN accs.opening_date > p_today AND accs.opening_date <= hz.until THEN accs.opening_balance_cents ELSE 0 END
            + coalesce((SELECT sum(m.amount_cents) FROM movements m
                         WHERE m.financial_account_id = accs.id
                           AND m.occurred_on > p_today AND m.occurred_on <= hz.until), 0))::bigint AS future_cents
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
    UNION ALL
    SELECT x.payer_caixa_id, 'payable', x.due_date, (x.items_cents - x.settled_cents)::bigint
      FROM card_invoice_payer_totals x
      JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
     WHERE x.payer_caixa_id = ANY (p_caixa_ids) AND x.items_cents - x.settled_cents > 0
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

COMMENT ON FUNCTION report_cash_projection(uuid[], date, int[]) IS
  'Fluxo de caixa projetado (spec 014) das caixas general pedidas, por horizonte (padrão 30/60/90 dias a partir de '
  'p_today, padrão = hoje em America/Sao_Paulo). Linha da caixa (financial_account_id nulo): balance_today_cents = '
  'saldo das contas no fim de hoje; scheduled_movements_cents = movimentos já lançados com data em (hoje, until] '
  '(e saldo inicial de conta aberta nesse intervalo); receivable_cents/payable_cents = saldo aberto dos títulos não '
  'arquivados com vencimento até until, INCLUSIVE os vencidos (que também saem em overdue_*), e as faturas abertas '
  'em que a caixa é pagadora (itens − antecipações); projected_cents = saldo + lançados + a receber − a pagar. '
  'Linha da conta: só realizado (títulos não têm conta), previstos = 0. Caixas de cartão não entram. '
  'Erro 22023: horizonte fora de 1..1100 ou lista vazia.';

-- migrate:down

DROP FUNCTION report_cash_projection(uuid[], date, int[]);
DROP FUNCTION report_entity_totals(uuid[], date, date, text);
DROP FUNCTION report_category_totals(uuid[], date, date, text);
DROP FUNCTION report_check_period(text, date, date, text);
