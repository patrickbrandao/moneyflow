-- migrate:up

-- Calendário (spec 012): itens por vencimento (títulos e faturas abertas de cartão)
-- e saldo diário realizado/projetado por caixa ou conta. "Hoje" é a data em
-- America/Sao_Paulo (spec 001), a menos que a aplicação passe p_today.
-- As funções são SECURITY INVOKER: a aplicação passa só caixas/contas que o usuário pode ver.

CREATE FUNCTION calendar_items(
  p_caixa_ids uuid[],
  p_from      date,
  p_to        date,
  p_today     date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
RETURNS TABLE (
  item_kind             text,
  title_id              uuid,
  card_invoice_id       uuid,
  caixa_id              uuid,
  counterparty_caixa_id uuid,
  direction             text,
  due_date              date,
  reference_month       date,
  description           text,
  entity_id             uuid,
  category_id           uuid,
  amount_cents          bigint,
  open_cents            bigint,
  status                text,
  calendar_status       text
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN
    RAISE EXCEPTION 'calendar_items: invalid period % .. % (max 1100 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  -- Títulos (inclusive as faturas fechadas, que são títulos card_invoice).
  SELECT 'title'::text,
         t.id,
         t.card_invoice_id,
         t.caixa_id,
         t.counterparty_caixa_id,
         t.direction,
         t.due_date,
         v.reference_month,
         t.description,
         t.entity_id,
         t.category_id,
         t.amount_cents,
         b.open_cents,
         t.status,
         CASE WHEN t.status = 'paid' THEN 'paid'
              WHEN t.due_date < p_today THEN 'overdue'
              ELSE t.direction END
    FROM titles t
    JOIN title_balances b ON b.title_id = t.id
    LEFT JOIN card_invoices v ON v.id = t.card_invoice_id
   WHERE t.caixa_id = ANY (p_caixa_ids)
     AND t.due_date BETWEEN p_from AND p_to
     AND t.status <> 'canceled'
     AND t.archived_at IS NULL
     -- Antecipação de fatura ainda aberta: aparece somada na projeção da fatura abaixo.
     AND (v.id IS NULL OR v.closed_at IS NOT NULL)
  UNION ALL
  -- Faturas ainda abertas: previsão por pagadora (itens − antecipações pagas), nos dois lados.
  SELECT 'card_invoice'::text,
         NULL::uuid,
         x.card_invoice_id,
         side.caixa_id,
         side.counterparty_caixa_id,
         side.direction,
         x.due_date,
         x.reference_month,
         card.name,
         side.entity_id,
         NULL::uuid,
         (x.items_cents - x.settled_cents)::bigint,
         (x.items_cents - x.settled_cents)::bigint,
         'open'::text,
         CASE WHEN x.due_date < p_today THEN 'overdue' ELSE side.direction END
    FROM card_invoice_payer_totals x
    JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
    JOIN caixas card ON card.id = x.card_caixa_id
    JOIN caixas payer ON payer.id = x.payer_caixa_id
    CROSS JOIN LATERAL (
      VALUES (x.payer_caixa_id, x.card_caixa_id, 'payable'::text, card.holder_entity_id),
             (x.card_caixa_id, x.payer_caixa_id, 'receivable'::text, payer.holder_entity_id)
    ) side (caixa_id, counterparty_caixa_id, direction, entity_id)
   WHERE side.caixa_id = ANY (p_caixa_ids)
     AND x.due_date BETWEEN p_from AND p_to
     AND x.items_cents - x.settled_cents > 0
   ORDER BY 7, 4, 1, 2, 3;
END
$$;

COMMENT ON FUNCTION calendar_items(uuid[], date, date, date) IS
  'Itens do calendário por vencimento nas caixas pedidas: títulos não cancelados nem arquivados (item_kind = title; '
  'faturas fechadas aparecem como seus títulos card_invoice) e faturas abertas (item_kind = card_invoice: previsão '
  '= itens − antecipações pagas, como a pagar na pagadora e a receber no cartão). calendar_status: paid, overdue '
  '(vencido em aberto), payable ou receivable. Período de até 1100 dias (erro 22023).';

-- Saldo por dia de uma conta (fim do dia; NULL antes da abertura).
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
  'Saldo da conta no fim de cada dia do período (saldo inicial + movimentos até o dia, inclusive os datados no futuro); '
  'NULL antes da abertura; nenhuma linha se a conta não existe. Até 1100 dias (erro 22023).';

-- Saldo realizado e projetado por dia de uma caixa.
CREATE FUNCTION caixa_daily_balances(
  p_caixa_id uuid,
  p_from     date,
  p_to       date,
  p_today    date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
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

COMMENT ON FUNCTION caixa_daily_balances(uuid, date, date, date) IS
  'Por dia: realized_cents = soma dos saldos das contas da caixa no fim do dia (movimentos até o dia); '
  'scheduled_cents = a partir de p_today, saldo aberto acumulado dos títulos da caixa até o dia (+ receber, − pagar; '
  'vencidos entram em p_today) e das faturas abertas em que ela é pagadora; projected_cents = realized + scheduled. '
  'Antes de p_today, scheduled = 0. Até 1100 dias (erro 22023).';

-- migrate:down

DROP FUNCTION caixa_daily_balances(uuid, date, date, date);
DROP FUNCTION account_daily_balances(uuid, date, date);
DROP FUNCTION calendar_items(uuid[], date, date, date);
