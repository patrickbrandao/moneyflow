-- migrate:up

-- Canvas de fluxo de dinheiro (spec 014): linhas, arestas agregadas e nós para um
-- período e um conjunto de caixas, e as posições dos nós salvas por usuário.
-- Funções SECURITY INVOKER: a aplicação passa só as caixas que o usuário pode ver
-- (inclusive os cartões das pagadoras que ele vê, spec 002).
--
-- Nós: cada caixa de p_caixa_ids ('caixa') e as entidades do outro lado ('entity').
-- Uma caixa fora de p_caixa_ids aparece como o seu titular (nó 'entity').
-- Arestas (edge_kind), sempre no sentido do dinheiro:
--   payment       caixa → contraparte: títulos a pagar (manual/recorrência) e ajustes negativos com entidade;
--   receipt       contraparte → caixa: títulos a receber e ajustes positivos com entidade;
--   card_invoice  pagadora → cartão: títulos card_invoice e a previsão das faturas abertas;
--   card_purchase cartão → recebedor final: compras, encargos e estornos (negativos), pela data da compra;
--   transfer      caixa → caixa: transferências entre contas de caixas diferentes.
-- realized_cents = valor em dinheiro das baixas ativas na data (principal + juros + multa − desconto),
-- transferências e compras no período; forecast_cents = saldo aberto dos títulos (não arquivados) que
-- vencem no período e a previsão das faturas abertas (itens − antecipações) que vencem no período.
-- Um par espelhado com as duas caixas na lista conta uma vez só, pelo lado a pagar.

CREATE FUNCTION flow_graph_lines(p_caixa_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  source_kind    text,
  source_id      uuid,
  target_kind    text,
  target_id      uuid,
  edge_kind      text,
  payer_caixa_id uuid,
  category_id    uuid,
  ref_kind       text,
  ref_id         uuid,
  occurred_on    date,
  realized_cents bigint,
  forecast_cents bigint
)
LANGUAGE plpgsql STABLE AS $$
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

COMMENT ON FUNCTION flow_graph_lines(uuid[], date, date) IS
  'Linhas do canvas de fluxo (spec 014), uma por registro: origem e destino (source_kind/target_kind = caixa | '
  'entity), edge_kind (payment | receipt | transfer | card_invoice | card_purchase), payer_caixa_id (pagadora, só em '
  'card_invoice e card_purchase), categoria, registro de origem (ref_kind = settlement | title | card_invoice | '
  'card_purchase | transfer | movement, ref_id), data e valor realizado ou previsto. É o detalhe da gaveta de uma '
  'aresta. Caixa fora de p_caixa_ids vira o nó do titular. Erro 22023: período inválido (até 3660 dias).';

CREATE FUNCTION flow_graph_edges(p_caixa_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  source_kind    text,
  source_id      uuid,
  target_kind    text,
  target_id      uuid,
  edge_kind      text,
  payer_caixa_id uuid,
  realized_cents bigint,
  forecast_cents bigint,
  lines          int
)
LANGUAGE sql STABLE AS $$
  SELECT l.source_kind, l.source_id, l.target_kind, l.target_id, l.edge_kind, l.payer_caixa_id,
         sum(l.realized_cents)::bigint, sum(l.forecast_cents)::bigint, count(*)::int
    FROM flow_graph_lines(p_caixa_ids, p_from, p_to) l
   GROUP BY 1, 2, 3, 4, 5, 6
   ORDER BY 5, 1, 2, 3, 4, 6
$$;

COMMENT ON FUNCTION flow_graph_edges(uuid[], date, date) IS
  'Arestas agregadas do canvas (spec 014): soma de flow_graph_lines por origem, destino, edge_kind e pagadora '
  '(payer_caixa_id separa as compras de um cartão por pagadora, para o rastreio pagadora → cartão → lojista; nulo '
  'nos outros tipos). realized_cents (traço contínuo) e forecast_cents (tracejado).';

CREATE FUNCTION flow_graph_nodes(p_caixa_ids uuid[], p_from date, p_to date)
RETURNS TABLE (
  node_kind               text,
  node_id                 uuid,
  name                    text,
  caixa_kind              text,
  entity_kind             text,
  holder_entity_id        uuid,
  balance_cents           bigint,
  card_used_cents         bigint,
  main_category_id        uuid,
  main_group_category_id  uuid,
  realized_in_cents       bigint,
  realized_out_cents      bigint,
  forecast_in_cents       bigint,
  forecast_out_cents      bigint
)
LANGUAGE sql STABLE AS $$
  WITH l AS (
    SELECT * FROM flow_graph_lines(p_caixa_ids, p_from, p_to)
  ),
  ends AS (
    SELECT l.target_kind AS k, l.target_id AS id, l.realized_cents AS r_in, 0::bigint AS r_out,
           l.forecast_cents AS f_in, 0::bigint AS f_out, l.category_id
      FROM l
    UNION ALL
    SELECT l.source_kind, l.source_id, 0, l.realized_cents, 0, l.forecast_cents, l.category_id
      FROM l
  ),
  totals AS (
    SELECT e.k, e.id, sum(e.r_in) AS r_in, sum(e.r_out) AS r_out, sum(e.f_in) AS f_in, sum(e.f_out) AS f_out
      FROM ends e GROUP BY 1, 2
  ),
  -- Categoria principal da entidade (para agrupar folhas): a de maior volume nas linhas dela.
  main_cat AS (
    SELECT DISTINCT ON (e.id) e.id, e.category_id
      FROM ends e
     WHERE e.k = 'entity' AND e.category_id IS NOT NULL
     GROUP BY e.id, e.category_id
     ORDER BY e.id, sum(abs(e.r_in) + abs(e.r_out) + abs(e.f_in) + abs(e.f_out)) DESC, e.category_id
  )
  SELECT 'caixa'::text, c.id, c.name, c.kind, NULL::text, c.holder_entity_id,
         CASE WHEN c.kind = 'general' THEN
           coalesce((SELECT sum(financial_account_balance_at(a.id, p_to)) FROM financial_accounts a WHERE a.caixa_id = c.id), 0)
         END::bigint,
         (SELECT cl.used_cents FROM card_limits cl WHERE cl.card_caixa_id = c.id)::bigint,
         NULL::uuid, NULL::uuid,
         coalesce(t.r_in, 0)::bigint, coalesce(t.r_out, 0)::bigint, coalesce(t.f_in, 0)::bigint, coalesce(t.f_out, 0)::bigint
    FROM caixas c
    LEFT JOIN totals t ON t.k = 'caixa' AND t.id = c.id
   WHERE c.id = ANY (p_caixa_ids)
  UNION ALL
  SELECT 'entity'::text, en.id, coalesce(en.trade_name, en.name), NULL::text, en.kind, NULL::uuid,
         NULL::bigint, NULL::bigint, mc.category_id, coalesce(cat.parent_id, cat.id),
         t.r_in::bigint, t.r_out::bigint, t.f_in::bigint, t.f_out::bigint
    FROM totals t
    JOIN entities en ON en.id = t.id
    LEFT JOIN main_cat mc ON mc.id = en.id
    LEFT JOIN categories cat ON cat.id = mc.category_id
   WHERE t.k = 'entity'
   ORDER BY 1, 3, 2
$$;

COMMENT ON FUNCTION flow_graph_nodes(uuid[], date, date) IS
  'Nós do canvas (spec 014): todas as caixas de p_caixa_ids (node_kind caixa: balance_cents = soma dos saldos das '
  'contas no fim de p_to, só em general; card_used_cents = limite usado, só em cartão) e as entidades que aparecem '
  'nas arestas (node_kind entity: nome fantasia ou nome; main_category_id / main_group_category_id = categoria de '
  'maior volume, para agrupar folhas). Totais de entrada e saída, realizados e previstos, no período.';

-- Posições salvas do canvas ------------------------------------------------------------------------
CREATE TABLE canvas_node_positions (
  id         uuid             PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid             NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  layout     text             NOT NULL DEFAULT 'default',
  node_kind  text             NOT NULL,
  node_id    uuid             NOT NULL,
  x          double precision NOT NULL,
  y          double precision NOT NULL,
  created_at timestamptz      NOT NULL DEFAULT now(),
  updated_at timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT canvas_node_positions_layout_check CHECK (btrim(layout) <> '' AND length(layout) <= 60),
  CONSTRAINT canvas_node_positions_node_kind_check CHECK (node_kind IN ('caixa', 'entity', 'category_group')),
  CONSTRAINT canvas_node_positions_xy_check CHECK (
    x BETWEEN -1e7 AND 1e7 AND y BETWEEN -1e7 AND 1e7
  ),
  CONSTRAINT canvas_node_positions_node_key UNIQUE (user_id, layout, node_kind, node_id)
);

CREATE TRIGGER canvas_node_positions_set_updated_at BEFORE UPDATE ON canvas_node_positions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE canvas_node_positions IS
  'Posição de cada nó do canvas de fluxo por usuário e layout nomeado (spec 014). Estado de interface: sem FK para o '
  'nó (caixa, entidade ou grupo de categoria; posições de nós que sumiram são ignoradas) e fora da auditoria. '
  'Gravar com INSERT … ON CONFLICT (user_id, layout, node_kind, node_id) DO UPDATE.';
COMMENT ON COLUMN canvas_node_positions.layout IS 'Nome do layout ("default" = o do canvas; outros = visões salvas).';
COMMENT ON COLUMN canvas_node_positions.node_kind IS 'caixa, entity ou category_group (folhas agrupadas pela categoria; node_id = id do grupo).';

-- migrate:down

DROP TABLE canvas_node_positions;
DROP FUNCTION flow_graph_nodes(uuid[], date, date);
DROP FUNCTION flow_graph_edges(uuid[], date, date);
DROP FUNCTION flow_graph_lines(uuid[], date, date);
