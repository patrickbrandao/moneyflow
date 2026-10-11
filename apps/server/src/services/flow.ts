import {
  type CanvasPosition,
  type FlowEdgeDto,
  type FlowGraphData,
  type FlowLineDto,
  type FlowNodeDto,
  invoiceLink,
  purchaseLink,
  statementLink,
  titleLink,
  transfersLink,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { scopeCaixas, uuidArray } from './reports';
import { withTx } from './tx';
import { camel } from './util';

/*
 * Canvas de fluxo de dinheiro (spec 014): nós, arestas e linhas da gaveta
 * (flow_graph_*), com as caixas legíveis do usuário, e as posições dos nós
 * salvas por usuário (canvas_node_positions, layout 'default').
 */

const LAYOUT = 'default';

export async function flowGraph(ctx: ServiceContext, q: { from: string; to: string; caixaIds: string[] }): Promise<FlowGraphData> {
  const caixas = await scopeCaixas(ctx, q.caixaIds);
  const caixaIds = caixas.map((c) => c.id);
  const positions = await loadPositions(ctx);
  if (caixaIds.length === 0) return { from: q.from, to: q.to, caixaIds, nodes: [], edges: [], positions };
  const arr = uuidArray(caixaIds);
  const [nodes, edges] = await Promise.all([
    ctx.db.execute(sql`
      SELECT n.node_kind AS kind, n.node_id AS id, n.name, n.caixa_kind, n.entity_kind, n.holder_entity_id, n.balance_cents,
             n.card_used_cents, c.credit_limit_cents AS card_limit_cents, n.main_category_id, n.main_group_category_id,
             g.name AS main_group_name, g.color_slot AS main_group_color_slot,
             n.realized_in_cents, n.realized_out_cents, n.forecast_in_cents, n.forecast_out_cents
        FROM flow_graph_nodes(${arr}, ${q.from}::date, ${q.to}::date) n
        LEFT JOIN caixas c ON n.node_kind = 'caixa' AND c.id = n.node_id
        LEFT JOIN categories g ON g.id = n.main_group_category_id`),
    ctx.db.execute(sql`SELECT * FROM flow_graph_edges(${arr}, ${q.from}::date, ${q.to}::date)`),
  ]);
  return {
    from: q.from,
    to: q.to,
    caixaIds,
    nodes: nodes.rows.map((row) => {
      const n = camel<FlowNodeDto>(row);
      return {
        ...n,
        realizedInCents: Number(n.realizedInCents ?? 0),
        realizedOutCents: Number(n.realizedOutCents ?? 0),
        forecastInCents: Number(n.forecastInCents ?? 0),
        forecastOutCents: Number(n.forecastOutCents ?? 0),
      };
    }),
    edges: edges.rows.map((row) => camel<FlowEdgeDto>(row)),
    positions,
  };
}

type LinesQuery = {
  from: string;
  to: string;
  caixaIds: string[];
  nodeKind?: 'caixa' | 'entity';
  nodeId?: string;
  sourceKind?: 'caixa' | 'entity';
  sourceId?: string;
  targetKind?: 'caixa' | 'entity';
  targetId?: string;
  edgeKind?: string;
  payerCaixaId?: string;
  entityIds: string[];
  limit: number;
};

/** Linhas da gaveta: de uma aresta, de um nó ou de um grupo de entidades, com rótulo e link do registro. */
export async function flowLines(ctx: ServiceContext, q: LinesQuery): Promise<FlowLineDto[]> {
  const caixas = await scopeCaixas(ctx, q.caixaIds);
  if (caixas.length === 0) return [];
  const where: SQL[] = [sql`true`];
  if (q.nodeKind && q.nodeId) {
    where.push(
      sql`((l.source_kind = ${q.nodeKind} AND l.source_id = ${q.nodeId}::uuid) OR (l.target_kind = ${q.nodeKind} AND l.target_id = ${q.nodeId}::uuid))`,
    );
  }
  if (q.entityIds.length > 0) {
    const arr = uuidArray(q.entityIds);
    where.push(
      sql`((l.source_kind = 'entity' AND l.source_id = ANY (${arr})) OR (l.target_kind = 'entity' AND l.target_id = ANY (${arr})))`,
    );
  }
  if (q.sourceKind && q.sourceId) where.push(sql`l.source_kind = ${q.sourceKind} AND l.source_id = ${q.sourceId}::uuid`);
  if (q.targetKind && q.targetId) where.push(sql`l.target_kind = ${q.targetKind} AND l.target_id = ${q.targetId}::uuid`);
  if (q.edgeKind) where.push(sql`l.edge_kind = ${q.edgeKind}`);
  if (q.payerCaixaId) where.push(sql`l.payer_caixa_id = ${q.payerCaixaId}::uuid`);

  const result = await ctx.db.execute(sql`
    SELECT l.source_kind, l.source_id, l.target_kind, l.target_id, l.edge_kind, l.payer_caixa_id, l.category_id,
           cat.name AS category_name, coalesce(cat.color_slot, pc.color_slot) AS color_slot,
           l.ref_kind, l.ref_id, l.occurred_on, l.realized_cents, l.forecast_cents,
           coalesce(sc.name, coalesce(se.trade_name, se.name)) AS source_name,
           coalesce(tc.name, coalesce(te.trade_name, te.name)) AS target_name,
           coalesce(t.description, st.description, cp.description, tr.description, mv.description, inv_card.name) AS description,
           coalesce(t.id, st.id) AS title_id, coalesce(t.caixa_id, st.caixa_id) AS title_caixa_id,
           coalesce(t.direction, st.direction) AS title_direction,
           cp.card_caixa_id AS purchase_card_id, inv.reference_month AS invoice_month,
           fa.caixa_id AS transfer_caixa_id, ma.caixa_id AS movement_caixa_id, mv.financial_account_id AS movement_account_id
      FROM flow_graph_lines(${uuidArray(caixas.map((c) => c.id))}, ${q.from}::date, ${q.to}::date) l
      LEFT JOIN categories cat ON cat.id = l.category_id
      LEFT JOIN categories pc ON pc.id = cat.parent_id
      LEFT JOIN caixas sc ON l.source_kind = 'caixa' AND sc.id = l.source_id
      LEFT JOIN entities se ON l.source_kind = 'entity' AND se.id = l.source_id
      LEFT JOIN caixas tc ON l.target_kind = 'caixa' AND tc.id = l.target_id
      LEFT JOIN entities te ON l.target_kind = 'entity' AND te.id = l.target_id
      LEFT JOIN settlements s ON l.ref_kind = 'settlement' AND s.id = l.ref_id
      LEFT JOIN titles st ON st.id = s.title_id
      LEFT JOIN titles t ON l.ref_kind = 'title' AND t.id = l.ref_id
      LEFT JOIN card_purchases cp ON l.ref_kind = 'card_purchase' AND cp.id = l.ref_id
      LEFT JOIN card_invoices inv ON l.ref_kind = 'card_invoice' AND inv.id = l.ref_id
      LEFT JOIN caixas inv_card ON inv_card.id = inv.card_caixa_id
      LEFT JOIN transfers tr ON l.ref_kind = 'transfer' AND tr.id = l.ref_id
      LEFT JOIN financial_accounts fa ON fa.id = tr.from_account_id
      LEFT JOIN movements mv ON l.ref_kind = 'movement' AND mv.id = l.ref_id
      LEFT JOIN financial_accounts ma ON ma.id = mv.financial_account_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY l.occurred_on DESC, l.ref_id
     LIMIT ${q.limit}`);

  return result.rows.map((row) => {
    const r = camel<
      Omit<FlowLineDto, 'description' | 'link'> & {
        description: string | null;
        titleId: string | null;
        titleCaixaId: string | null;
        titleDirection: 'payable' | 'receivable' | null;
        purchaseCardId: string | null;
        invoiceMonth: string | null;
        transferCaixaId: string | null;
        movementCaixaId: string | null;
        movementAccountId: string | null;
      }
    >(row);
    const link = lineLink(ctx, r);
    const description =
      r.refKind === 'card_invoice' && r.invoiceMonth
        ? `Fatura ${r.description ?? ''} ${r.invoiceMonth.slice(5, 7)}/${r.invoiceMonth.slice(0, 4)}`.replace(/\s+/g, ' ')
        : (r.description ?? '');
    return {
      sourceKind: r.sourceKind,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      targetKind: r.targetKind,
      targetId: r.targetId,
      targetName: r.targetName,
      edgeKind: r.edgeKind,
      payerCaixaId: r.payerCaixaId,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      colorSlot: r.colorSlot,
      refKind: r.refKind,
      refId: r.refId,
      description,
      occurredOn: r.occurredOn,
      realizedCents: Number(r.realizedCents),
      forecastCents: Number(r.forecastCents),
      link,
    };
  });
}

function lineLink(
  ctx: ServiceContext,
  r: {
    refKind: FlowLineDto['refKind'];
    refId: string;
    payerCaixaId: string | null;
    titleId: string | null;
    titleCaixaId: string | null;
    titleDirection: 'payable' | 'receivable' | null;
    purchaseCardId: string | null;
    transferCaixaId: string | null;
    movementCaixaId: string | null;
    movementAccountId: string | null;
  },
): string | null {
  const can = (id: string | null) => id !== null && ctx.access.canRead(id);
  switch (r.refKind) {
    case 'settlement':
    case 'title':
      return r.titleId && r.titleCaixaId && r.titleDirection && can(r.titleCaixaId)
        ? titleLink({ id: r.titleId, caixaId: r.titleCaixaId, direction: r.titleDirection })
        : null;
    case 'card_invoice':
      return invoiceLink(r.refId, r.payerCaixaId);
    case 'card_purchase':
      return can(r.purchaseCardId) ? purchaseLink(r.purchaseCardId!, r.refId) : null;
    case 'transfer':
      return transfersLink(can(r.transferCaixaId) ? r.transferCaixaId! : undefined);
    case 'movement':
      return can(r.movementCaixaId) && r.movementAccountId ? statementLink(r.movementCaixaId!, r.movementAccountId) : null;
    default:
      return null;
  }
}

async function loadPositions(ctx: ServiceContext): Promise<CanvasPosition[]> {
  const result = await ctx.db.execute<{ node_kind: CanvasPosition['nodeKind']; node_id: string; x: number; y: number }>(sql`
    SELECT node_kind, node_id, x, y FROM canvas_node_positions WHERE user_id = ${ctx.access.actor.id} AND layout = ${LAYOUT}`);
  return result.rows.map((r) => ({ nodeKind: r.node_kind, nodeId: r.node_id, x: Number(r.x), y: Number(r.y) }));
}

/** Grava as posições (upsert por nó). Estado de interface do próprio usuário: não exige permissão de caixa. */
export async function savePositions(ctx: ServiceContext, input: { layout: string; positions: CanvasPosition[] }) {
  if (input.positions.length === 0) return { saved: 0 };
  await withTx(ctx, async (tx) => {
    const values = input.positions.map(
      (p) => sql`(${ctx.access.actor.id}::uuid, ${input.layout}, ${p.nodeKind}, ${p.nodeId}::uuid, ${p.x}, ${p.y})`,
    );
    await tx.execute(sql`
      INSERT INTO canvas_node_positions (user_id, layout, node_kind, node_id, x, y)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (user_id, layout, node_kind, node_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y`);
  });
  return { saved: input.positions.length };
}

/** Descarta o arranjo salvo (o canvas volta ao auto-layout). */
export async function resetPositions(ctx: ServiceContext, layout = LAYOUT) {
  await withTx(ctx, (tx) =>
    tx.execute(sql`DELETE FROM canvas_node_positions WHERE user_id = ${ctx.access.actor.id} AND layout = ${layout}`),
  );
  return { ok: true };
}
