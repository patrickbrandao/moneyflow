-- migrate:up

-- Desempenho (revisão de 2026-11-21):
--   * Tarefa 144: contract_payments acha a linha conciliada de cada baixa por dois ramos indexáveis (o movimento da
--     baixa ou do espelho; a perna da transferência da baixa), e não por um OR que lia as linhas conciliadas do sistema
--     inteiro a cada baixa. Mesma ordem de desempate e o mesmo resultado.
--   * Tarefa 146: flow_graph_lines com title_ends NOT MATERIALIZED (o período desce até titles em cada ramo) e o
--     previsto filtrando status open/partial (indexável).
--   * Tarefa 147: índices que faltavam: trigram na descrição dos títulos (busca da paleta e dos agentes), compras do
--     cartão por pagadora e data (relatórios por competência; substitui o de só pagadora, que servia à FK) e os
--     espelhos pendentes de aceite por caixa (visão geral).

-- 147 -----------------------------------------------------------------------------------------------------------------------
CREATE INDEX titles_description_trgm_idx ON titles USING gin (description gin_trgm_ops);
CREATE INDEX titles_mirror_pending_idx ON titles (caixa_id) WHERE mirror_status = 'pending';
CREATE INDEX card_purchases_payer_caixa_id_purchased_on_idx ON card_purchases (payer_caixa_id, purchased_on);
DROP INDEX card_purchases_payer_caixa_id_idx;

-- 144 -----------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contract_payments(p_contract_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date) RETURNS TABLE(kind text, recurrence_rule_id uuid, occurrence integer, title_id uuid, card_purchase_id uuid, caixa_id uuid, card_invoice_id uuid, description text, competence_date date, due_date date, amount_cents bigint, status text, settled_cents bigint, open_cents bigint, interest_cents bigint, fine_cents bigint, discount_cents bigint, cash_cents bigint, settlement_count integer, last_settled_on date, paid_on date, days integer, overdue boolean, not_charged boolean, account_id uuid, funding_account_id uuid, planned_account_id uuid, planned_account_custom boolean, last_origin text, settlements jsonb)
    LANGUAGE sql STABLE
    AS $$
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
      -- A linha conciliada com a baixa: pelo movimento da baixa (ou da perna do espelho) ou pela perna da transferência
      -- que a financia. Dois ramos indexáveis (movements.settlement_id e transfers.settlement_id) em vez de um OR
      -- (tarefa 144); uma linha só cai num deles (o movimento é de baixa ou de transferência).
      LEFT JOIN LATERAL (
        SELECT c.id, c.auto_settled, c.created_entry
          FROM (SELECT l.id, l.auto_settled, l.created_entry, l.matched_at
                  FROM movements m
                  JOIN statement_lines l ON l.movement_id = m.id AND l.status = 'matched'
                 WHERE m.settlement_id IN (s.id, s.mirror_settlement_id)
                UNION ALL
                SELECT l.id, l.auto_settled, l.created_entry, l.matched_at
                  FROM movements m
                  JOIN statement_lines l ON l.movement_id = m.id AND l.status = 'matched'
                 WHERE m.transfer_id = ANY (ARRAY(SELECT x.id FROM transfers x
                                                   WHERE x.settlement_id IN (s.id, s.mirror_settlement_id)))) c
         ORDER BY c.auto_settled DESC, (c.created_entry IS NOT NULL) DESC, c.matched_at, c.id
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


-- 146 -----------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_graph_lines(p_caixa_ids uuid[], p_from date, p_to date) RETURNS TABLE(source_kind text, source_id uuid, target_kind text, target_id uuid, edge_kind text, payer_caixa_id uuid, category_id uuid, ref_kind text, ref_id uuid, occurred_on date, realized_cents bigint, forecast_cents bigint)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION 'flow_graph: invalid period % .. % (max 3660 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH
  -- Títulos que representam o fluxo: o lado a receber de um par cuja outra caixa está na lista é pulado.
  tt AS (
    SELECT t.*, cp.holder_entity_id AS cp_holder, (cp.id = ANY (p_caixa_ids)) AS cp_in
      FROM titles t
      LEFT JOIN caixas cp ON cp.id = t.counterparty_caixa_id
     WHERE t.caixa_id = ANY (p_caixa_ids)
       AND NOT (t.direction = 'receivable' AND coalesce(cp.id = ANY (p_caixa_ids), false))
  ),
  -- NOT MATERIALIZED (tarefa 146): cada ramo abaixo inlina os títulos e aplica o próprio período (baixas no período;
  -- em aberto que vencem no período), em vez de separar antes todos os títulos das caixas.
  title_ends AS NOT MATERIALIZED (
    SELECT tt.*,
           CASE WHEN tt.direction = 'payable' THEN 'caixa'
                ELSE 'entity' END AS s_kind,
           CASE WHEN tt.direction = 'payable' THEN tt.caixa_id
                ELSE tt.entity_id END AS s_id,
           CASE WHEN tt.direction = 'receivable' THEN 'caixa'
                WHEN coalesce(tt.cp_in, false) THEN 'caixa'
                ELSE 'entity' END AS t_kind,
           CASE WHEN tt.direction = 'receivable' THEN tt.caixa_id
                WHEN coalesce(tt.cp_in, false) THEN tt.counterparty_caixa_id
                ELSE tt.entity_id END AS t_id,
           CASE WHEN tt.origin = 'card_invoice' THEN 'card_invoice'
                WHEN tt.direction = 'payable' THEN 'payment'
                ELSE 'receipt' END AS e_kind,
           CASE WHEN tt.origin = 'card_invoice'
                THEN CASE tt.direction WHEN 'payable' THEN tt.caixa_id ELSE tt.counterparty_caixa_id END
           END AS payer_id
      FROM tt
  )
  -- Realizado: baixas ativas no período.
  SELECT e.s_kind, e.s_id, e.t_kind, e.t_id, e.e_kind, e.payer_id, e.category_id,
         'settlement'::text, s.id, s.settled_on,
         (s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents)::bigint, 0::bigint
    FROM title_ends e
    JOIN settlements s ON s.title_id = e.id
   WHERE s.reversed_at IS NULL AND s.settled_on BETWEEN p_from AND p_to
  UNION ALL
  -- Previsto: saldo aberto dos títulos que vencem no período (antecipação de fatura aberta está na previsão dela).
  SELECT e.s_kind, e.s_id, e.t_kind, e.t_id, e.e_kind, e.payer_id, e.category_id,
         'title'::text, e.id, e.due_date, 0::bigint, b.open_cents
    FROM title_ends e
    JOIN title_balances b ON b.title_id = e.id
    LEFT JOIN card_invoices v ON v.id = e.card_invoice_id
   WHERE e.status IN ('open', 'partial') AND b.open_cents > 0 AND e.archived_at IS NULL
     AND e.due_date BETWEEN p_from AND p_to
     AND (v.id IS NULL OR v.closed_at IS NOT NULL)
  UNION ALL
  -- Faturas abertas: previsão por pagadora (itens − antecipações).
  SELECT CASE WHEN x.payer_caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN x.payer_caixa_id = ANY (p_caixa_ids) THEN x.payer_caixa_id ELSE payer.holder_entity_id END,
         CASE WHEN x.card_caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN x.card_caixa_id = ANY (p_caixa_ids) THEN x.card_caixa_id ELSE card.holder_entity_id END,
         'card_invoice'::text, x.payer_caixa_id, NULL::uuid,
         'card_invoice'::text, x.card_invoice_id, x.due_date, 0::bigint, (x.items_cents - x.settled_cents)::bigint
    FROM card_invoice_payer_totals x
    JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
    JOIN caixas payer ON payer.id = x.payer_caixa_id
    JOIN caixas card ON card.id = x.card_caixa_id
   WHERE (x.payer_caixa_id = ANY (p_caixa_ids) OR x.card_caixa_id = ANY (p_caixa_ids))
     AND x.due_date BETWEEN p_from AND p_to
     AND x.items_cents - x.settled_cents > 0
  UNION ALL
  -- Compras do cartão: cartão → recebedor final.
  SELECT 'caixa'::text, p.card_caixa_id, 'entity'::text, p.entity_id, 'card_purchase'::text, p.payer_caixa_id,
         p.category_id, 'card_purchase'::text, p.id, p.purchased_on,
         (CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END)::bigint, 0::bigint
    FROM card_purchases p
   WHERE p.card_caixa_id = ANY (p_caixa_ids) AND p.purchased_on BETWEEN p_from AND p_to
  UNION ALL
  -- Transferências entre caixas diferentes.
  SELECT CASE WHEN fa.caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN fa.caixa_id = ANY (p_caixa_ids) THEN fa.caixa_id ELSE fc.holder_entity_id END,
         CASE WHEN ta.caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN ta.caixa_id = ANY (p_caixa_ids) THEN ta.caixa_id ELSE tc.holder_entity_id END,
         'transfer'::text, NULL::uuid, NULL::uuid, 'transfer'::text, tr.id, tr.transferred_on,
         tr.amount_cents, 0::bigint
    FROM transfers tr
    JOIN financial_accounts fa ON fa.id = tr.from_account_id
    JOIN financial_accounts ta ON ta.id = tr.to_account_id
    JOIN caixas fc ON fc.id = fa.caixa_id
    JOIN caixas tc ON tc.id = ta.caixa_id
   WHERE fa.caixa_id <> ta.caixa_id
     AND (fa.caixa_id = ANY (p_caixa_ids) OR ta.caixa_id = ANY (p_caixa_ids))
     AND tr.transferred_on BETWEEN p_from AND p_to
  UNION ALL
  -- Ajustes com entidade.
  SELECT CASE WHEN m.amount_cents < 0 THEN 'caixa' ELSE 'entity' END,
         CASE WHEN m.amount_cents < 0 THEN a.caixa_id ELSE m.entity_id END,
         CASE WHEN m.amount_cents < 0 THEN 'entity' ELSE 'caixa' END,
         CASE WHEN m.amount_cents < 0 THEN m.entity_id ELSE a.caixa_id END,
         CASE WHEN m.amount_cents < 0 THEN 'payment' ELSE 'receipt' END,
         NULL::uuid, m.category_id, 'movement'::text, m.id, m.occurred_on, abs(m.amount_cents)::bigint, 0::bigint
    FROM movements m
    JOIN financial_accounts a ON a.id = m.financial_account_id
   WHERE m.kind = 'adjustment' AND m.entity_id IS NOT NULL
     AND a.caixa_id = ANY (p_caixa_ids) AND m.occurred_on BETWEEN p_from AND p_to;
END
$$;


-- migrate:down

CREATE OR REPLACE FUNCTION public.flow_graph_lines(p_caixa_ids uuid[], p_from date, p_to date) RETURNS TABLE(source_kind text, source_id uuid, target_kind text, target_id uuid, edge_kind text, payer_caixa_id uuid, category_id uuid, ref_kind text, ref_id uuid, occurred_on date, realized_cents bigint, forecast_cents bigint)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION 'flow_graph: invalid period % .. % (max 3660 days)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH
  -- Títulos que representam o fluxo: o lado a receber de um par cuja outra caixa está na lista é pulado.
  tt AS (
    SELECT t.*, cp.holder_entity_id AS cp_holder, (cp.id = ANY (p_caixa_ids)) AS cp_in
      FROM titles t
      LEFT JOIN caixas cp ON cp.id = t.counterparty_caixa_id
     WHERE t.caixa_id = ANY (p_caixa_ids)
       AND NOT (t.direction = 'receivable' AND coalesce(cp.id = ANY (p_caixa_ids), false))
  ),
  title_ends AS (
    SELECT tt.*,
           CASE WHEN tt.direction = 'payable' THEN 'caixa'
                ELSE 'entity' END AS s_kind,
           CASE WHEN tt.direction = 'payable' THEN tt.caixa_id
                ELSE tt.entity_id END AS s_id,
           CASE WHEN tt.direction = 'receivable' THEN 'caixa'
                WHEN coalesce(tt.cp_in, false) THEN 'caixa'
                ELSE 'entity' END AS t_kind,
           CASE WHEN tt.direction = 'receivable' THEN tt.caixa_id
                WHEN coalesce(tt.cp_in, false) THEN tt.counterparty_caixa_id
                ELSE tt.entity_id END AS t_id,
           CASE WHEN tt.origin = 'card_invoice' THEN 'card_invoice'
                WHEN tt.direction = 'payable' THEN 'payment'
                ELSE 'receipt' END AS e_kind,
           CASE WHEN tt.origin = 'card_invoice'
                THEN CASE tt.direction WHEN 'payable' THEN tt.caixa_id ELSE tt.counterparty_caixa_id END
           END AS payer_id
      FROM tt
  )
  -- Realizado: baixas ativas no período.
  SELECT e.s_kind, e.s_id, e.t_kind, e.t_id, e.e_kind, e.payer_id, e.category_id,
         'settlement'::text, s.id, s.settled_on,
         (s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents)::bigint, 0::bigint
    FROM title_ends e
    JOIN settlements s ON s.title_id = e.id
   WHERE s.reversed_at IS NULL AND s.settled_on BETWEEN p_from AND p_to
  UNION ALL
  -- Previsto: saldo aberto dos títulos que vencem no período (antecipação de fatura aberta está na previsão dela).
  SELECT e.s_kind, e.s_id, e.t_kind, e.t_id, e.e_kind, e.payer_id, e.category_id,
         'title'::text, e.id, e.due_date, 0::bigint, b.open_cents
    FROM title_ends e
    JOIN title_balances b ON b.title_id = e.id
    LEFT JOIN card_invoices v ON v.id = e.card_invoice_id
   WHERE b.open_cents > 0 AND e.archived_at IS NULL AND e.due_date BETWEEN p_from AND p_to
     AND (v.id IS NULL OR v.closed_at IS NOT NULL)
  UNION ALL
  -- Faturas abertas: previsão por pagadora (itens − antecipações).
  SELECT CASE WHEN x.payer_caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN x.payer_caixa_id = ANY (p_caixa_ids) THEN x.payer_caixa_id ELSE payer.holder_entity_id END,
         CASE WHEN x.card_caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN x.card_caixa_id = ANY (p_caixa_ids) THEN x.card_caixa_id ELSE card.holder_entity_id END,
         'card_invoice'::text, x.payer_caixa_id, NULL::uuid,
         'card_invoice'::text, x.card_invoice_id, x.due_date, 0::bigint, (x.items_cents - x.settled_cents)::bigint
    FROM card_invoice_payer_totals x
    JOIN card_invoices v ON v.id = x.card_invoice_id AND v.closed_at IS NULL
    JOIN caixas payer ON payer.id = x.payer_caixa_id
    JOIN caixas card ON card.id = x.card_caixa_id
   WHERE (x.payer_caixa_id = ANY (p_caixa_ids) OR x.card_caixa_id = ANY (p_caixa_ids))
     AND x.due_date BETWEEN p_from AND p_to
     AND x.items_cents - x.settled_cents > 0
  UNION ALL
  -- Compras do cartão: cartão → recebedor final.
  SELECT 'caixa'::text, p.card_caixa_id, 'entity'::text, p.entity_id, 'card_purchase'::text, p.payer_caixa_id,
         p.category_id, 'card_purchase'::text, p.id, p.purchased_on,
         (CASE p.kind WHEN 'refund' THEN -p.amount_cents ELSE p.amount_cents END)::bigint, 0::bigint
    FROM card_purchases p
   WHERE p.card_caixa_id = ANY (p_caixa_ids) AND p.purchased_on BETWEEN p_from AND p_to
  UNION ALL
  -- Transferências entre caixas diferentes.
  SELECT CASE WHEN fa.caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN fa.caixa_id = ANY (p_caixa_ids) THEN fa.caixa_id ELSE fc.holder_entity_id END,
         CASE WHEN ta.caixa_id = ANY (p_caixa_ids) THEN 'caixa' ELSE 'entity' END,
         CASE WHEN ta.caixa_id = ANY (p_caixa_ids) THEN ta.caixa_id ELSE tc.holder_entity_id END,
         'transfer'::text, NULL::uuid, NULL::uuid, 'transfer'::text, tr.id, tr.transferred_on,
         tr.amount_cents, 0::bigint
    FROM transfers tr
    JOIN financial_accounts fa ON fa.id = tr.from_account_id
    JOIN financial_accounts ta ON ta.id = tr.to_account_id
    JOIN caixas fc ON fc.id = fa.caixa_id
    JOIN caixas tc ON tc.id = ta.caixa_id
   WHERE fa.caixa_id <> ta.caixa_id
     AND (fa.caixa_id = ANY (p_caixa_ids) OR ta.caixa_id = ANY (p_caixa_ids))
     AND tr.transferred_on BETWEEN p_from AND p_to
  UNION ALL
  -- Ajustes com entidade.
  SELECT CASE WHEN m.amount_cents < 0 THEN 'caixa' ELSE 'entity' END,
         CASE WHEN m.amount_cents < 0 THEN a.caixa_id ELSE m.entity_id END,
         CASE WHEN m.amount_cents < 0 THEN 'entity' ELSE 'caixa' END,
         CASE WHEN m.amount_cents < 0 THEN m.entity_id ELSE a.caixa_id END,
         CASE WHEN m.amount_cents < 0 THEN 'payment' ELSE 'receipt' END,
         NULL::uuid, m.category_id, 'movement'::text, m.id, m.occurred_on, abs(m.amount_cents)::bigint, 0::bigint
    FROM movements m
    JOIN financial_accounts a ON a.id = m.financial_account_id
   WHERE m.kind = 'adjustment' AND m.entity_id IS NOT NULL
     AND a.caixa_id = ANY (p_caixa_ids) AND m.occurred_on BETWEEN p_from AND p_to;
END
$$;


CREATE OR REPLACE FUNCTION public.contract_payments(p_contract_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_today date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date) RETURNS TABLE(kind text, recurrence_rule_id uuid, occurrence integer, title_id uuid, card_purchase_id uuid, caixa_id uuid, card_invoice_id uuid, description text, competence_date date, due_date date, amount_cents bigint, status text, settled_cents bigint, open_cents bigint, interest_cents bigint, fine_cents bigint, discount_cents bigint, cash_cents bigint, settlement_count integer, last_settled_on date, paid_on date, days integer, overdue boolean, not_charged boolean, account_id uuid, funding_account_id uuid, planned_account_id uuid, planned_account_custom boolean, last_origin text, settlements jsonb)
    LANGUAGE sql STABLE
    AS $$
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


CREATE INDEX card_purchases_payer_caixa_id_idx ON card_purchases (payer_caixa_id);
DROP INDEX card_purchases_payer_caixa_id_purchased_on_idx;
DROP INDEX titles_mirror_pending_idx;
DROP INDEX titles_description_trgm_idx;
