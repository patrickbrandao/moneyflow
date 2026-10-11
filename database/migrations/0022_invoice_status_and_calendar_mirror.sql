-- migrate:up

-- Ajustes pedidos pela aplicação na F2b:
-- (a) card_invoice_summaries.status ganha 'carried_over': fatura fechada sem saldo aberto
--     cujo restante devedor rolou para a fatura seguinte (antes aparecia como 'closed',
--     o que sugeria um pagamento pendente que não existe mais nesta fatura).
-- (b) calendar_items devolve o lado do espelho (mirror_side) e o mirror_status.
--     Colunas novas no fim: quem seleciona colunas pelo nome não muda.

CREATE OR REPLACE VIEW card_invoice_summaries WITH (security_invoker = true) AS
SELECT v.id AS card_invoice_id,
       v.card_caixa_id,
       v.reference_month,
       v.closing_date,
       v.due_date,
       v.closed_at,
       coalesce(s.items_cents, 0)::bigint AS total_cents,
       coalesce(s.billed_cents, 0)::bigint AS billed_cents,
       coalesce(s.settled_cents, 0)::bigint AS settled_cents,
       coalesce(s.open_cents, 0)::bigint AS open_cents,
       coalesce(s.carried_out_cents, 0)::bigint AS carried_out_cents,
       CASE WHEN v.closed_at IS NULL THEN 'open'
            WHEN coalesce(s.open_cents, 0) > 0 THEN 'closed'
            WHEN coalesce(s.carried_debt, false) THEN 'carried_over'
            ELSE 'paid' END AS status
  FROM card_invoices v
  LEFT JOIN LATERAL (
    SELECT sum(x.items_cents) AS items_cents, sum(x.billed_cents) AS billed_cents,
           sum(x.settled_cents) AS settled_cents, sum(x.open_cents) AS open_cents,
           sum(x.carried_out_cents) AS carried_out_cents,
           bool_or(x.carried_out_cents > 0) AS carried_debt
      FROM card_invoice_payer_totals x WHERE x.card_invoice_id = v.id
  ) s ON true;

COMMENT ON VIEW card_invoice_summaries IS
  'Fatura com totais e status: open (aberta), closed (fechada com saldo aberto a pagar), carried_over (fechada, nada '
  'mais a pagar nela, mas com saldo devedor rolado para a fatura seguinte) ou paid (fechada e quitada, sem saldo '
  'devedor rolado de nenhuma pagadora; crédito rolado conta como quitada).';

DROP FUNCTION calendar_items(uuid[], date, date, date);

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
  calendar_status       text,
  mirror_side           text,
  mirror_status         text
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
              ELSE t.direction END,
         CASE WHEN t.mirror_title_id IS NULL THEN NULL
              WHEN t.mirror_status IS NOT NULL THEN 'mirror'
              ELSE 'original' END,
         t.mirror_status
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
         CASE WHEN x.due_date < p_today THEN 'overdue' ELSE side.direction END,
         -- O título da fatura terá o lado "a receber" no cartão (original) e o "a pagar" na pagadora (espelho).
         CASE side.direction WHEN 'payable' THEN 'mirror' ELSE 'original' END,
         NULL::text
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
  '(vencido em aberto), payable ou receivable. mirror_side: original | mirror (lado criado na caixa da contraparte, '
  'o que tem mirror_status) | nulo sem espelho; na previsão da fatura aberta, mirror na pagadora e original no cartão. '
  'mirror_status: pending | accepted | disputed no lado espelho (nulo nos demais e na previsão). Período de até '
  '1100 dias (erro 22023).';

-- migrate:down

DROP FUNCTION calendar_items(uuid[], date, date, date);

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

CREATE OR REPLACE VIEW card_invoice_summaries WITH (security_invoker = true) AS
SELECT v.id AS card_invoice_id,
       v.card_caixa_id,
       v.reference_month,
       v.closing_date,
       v.due_date,
       v.closed_at,
       coalesce(s.items_cents, 0)::bigint AS total_cents,
       coalesce(s.billed_cents, 0)::bigint AS billed_cents,
       coalesce(s.settled_cents, 0)::bigint AS settled_cents,
       coalesce(s.open_cents, 0)::bigint AS open_cents,
       coalesce(s.carried_out_cents, 0)::bigint AS carried_out_cents,
       CASE WHEN v.closed_at IS NULL THEN 'open'
            WHEN coalesce(s.open_cents, 0) = 0 AND coalesce(s.carried_out_cents, 0) <= 0 THEN 'paid'
            ELSE 'closed' END AS status
  FROM card_invoices v
  LEFT JOIN LATERAL (
    SELECT sum(x.items_cents) AS items_cents, sum(x.billed_cents) AS billed_cents,
           sum(x.settled_cents) AS settled_cents, sum(x.open_cents) AS open_cents,
           sum(x.carried_out_cents) AS carried_out_cents
      FROM card_invoice_payer_totals x WHERE x.card_invoice_id = v.id
  ) s ON true;

COMMENT ON VIEW card_invoice_summaries IS
  'Fatura com totais e status: open (aberta), closed (fechada com saldo aberto ou rolado) ou paid (fechada e quitada).';
