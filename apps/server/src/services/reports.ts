import type {
  CategoryReportData,
  CategoryTotalLine,
  EntityFilter,
  EntityReportData,
  EntityTotalLine,
  ProjectionLine,
  ProjectionReportData,
  ReportBasis,
  ReportCaixa,
} from '@moneyflow/shared';
import { monthsBetween, todayIso } from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { readableFilter } from './caixas';
import { resolveEntityFilter } from './entity-tags';
import { camel } from './util';

/*
 * Relatórios (spec 014). As funções do banco são SECURITY INVOKER e recebem a
 * lista de caixas: a permissão é aplicada aqui, passando só caixas legíveis
 * (spec 002), com os cartões cuja pagadora padrão está na seleção.
 */

/** uuid[] para o banco a partir de ids já validados. */
export const uuidArray = (ids: string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * Caixas do escopo: as pedidas (cada uma com leitura, senão 404) ou, sem pedido,
 * todas as legíveis não arquivadas; mais os cartões legíveis cuja pagadora padrão
 * está no escopo.
 */
export async function scopeCaixas(ctx: ServiceContext, requested: string[]): Promise<ReportCaixa[]> {
  for (const id of requested) ctx.access.assertRead(id);
  const wanted =
    requested.length > 0
      ? sql`(c.id = ANY (${uuidArray(requested)}) OR (c.kind = 'credit_card' AND c.archived_at IS NULL AND c.default_payer_caixa_id = ANY (${uuidArray(requested)})))`
      : sql`c.archived_at IS NULL`;
  const result = await ctx.db.execute<{ id: string; name: string; kind: 'general' | 'credit_card' }>(sql`
    SELECT c.id, c.name, c.kind FROM caixas c
     WHERE ${readableFilter(ctx.access)} AND ${wanted}
     ORDER BY c.kind, c.name`);
  return result.rows;
}

const ids = (caixas: ReportCaixa[]) => caixas.map((c) => c.id);

/**
 * Filtro por entidade (spec 014): resolvido numa lista de entidades e passado
 * como p_entity_ids. NULL = sem filtro; lista vazia = nada casa (relatório vazio).
 */
async function entityScope(ctx: ServiceContext, filter: Partial<EntityFilter> | undefined) {
  const entityIds = await resolveEntityFilter(ctx, filter);
  return {
    param: entityIds === null ? sql`NULL::uuid[]` : uuidArray(entityIds),
    info: entityIds === null ? null : { entityCount: entityIds.length },
  };
}

type Filtered = Partial<EntityFilter>;

export async function categoryReport(
  ctx: ServiceContext,
  q: { from: string; to: string; basis: ReportBasis; caixaIds: string[] } & Filtered,
): Promise<CategoryReportData> {
  const caixas = await scopeCaixas(ctx, q.caixaIds);
  const months = monthsBetween(q.from, q.to);
  const scope = await entityScope(ctx, q);
  const empty = { basis: q.basis, from: q.from, to: q.to, months, caixas, lines: [], entityFilter: scope.info };
  if (caixas.length === 0 || scope.info?.entityCount === 0) return empty;
  const result = await ctx.db.execute(sql`
    SELECT r.month, r.caixa_id, r.card_caixa_id, r.kind, r.group_category_id, g.name AS group_name, g.color_slot AS group_color_slot,
           r.category_id, c.name AS category_name, c.color_slot, r.source, r.is_internal, r.amount_cents, r.entries
      FROM report_category_totals(${uuidArray(ids(caixas))}, ${q.from}::date, ${q.to}::date, ${q.basis}, ${scope.param}) r
      LEFT JOIN categories g ON g.id = r.group_category_id
      LEFT JOIN categories c ON c.id = r.category_id`);
  const lines = result.rows.map((row) => {
    const line = camel<CategoryTotalLine>(row);
    return { ...line, amountCents: Number(line.amountCents), entries: Number(line.entries) };
  });
  return { ...empty, lines };
}

export async function entityReport(
  ctx: ServiceContext,
  q: { from: string; to: string; basis: ReportBasis; caixaIds: string[] } & Filtered,
): Promise<EntityReportData> {
  const caixas = await scopeCaixas(ctx, q.caixaIds);
  const scope = await entityScope(ctx, q);
  const empty = { basis: q.basis, from: q.from, to: q.to, caixas, lines: [], entityFilter: scope.info };
  if (caixas.length === 0 || scope.info?.entityCount === 0) return empty;
  const result = await ctx.db.execute(sql`
    SELECT r.entity_id, coalesce(e.trade_name, e.name) AS entity_name, r.caixa_id, c.name AS caixa_name,
           r.card_caixa_id, k.name AS card_name, r.source, r.is_internal, r.outflow_cents, r.inflow_cents, r.entries
      FROM report_entity_totals(${uuidArray(ids(caixas))}, ${q.from}::date, ${q.to}::date, ${q.basis}, ${scope.param}) r
      JOIN entities e ON e.id = r.entity_id
      JOIN caixas c ON c.id = r.caixa_id
      LEFT JOIN caixas k ON k.id = r.card_caixa_id
     ORDER BY entity_name, c.name`);
  return { ...empty, lines: result.rows.map((row) => camel<EntityTotalLine>(row)) };
}

export async function projectionReport(
  ctx: ServiceContext,
  q: { caixaIds: string[]; horizons: number[] } & Filtered,
): Promise<ProjectionReportData> {
  const caixas = (await scopeCaixas(ctx, q.caixaIds)).filter((c) => c.kind === 'general');
  const today = todayIso();
  const horizons = [...new Set(q.horizons)].sort((a, b) => a - b);
  const scope = await entityScope(ctx, q);
  if (caixas.length === 0 || scope.info?.entityCount === 0) return { today, horizons, lines: [], entityFilter: scope.info };
  const result = await ctx.db.execute(sql`
    SELECT p.*, c.name AS caixa_name, a.name AS account_name
      FROM report_cash_projection(${uuidArray(ids(caixas))}, ${today}::date, ${`{${horizons.join(',')}}`}::int[], ${scope.param}) p
      JOIN caixas c ON c.id = p.caixa_id
      LEFT JOIN financial_accounts a ON a.id = p.financial_account_id
     ORDER BY c.name, p.caixa_id, p.financial_account_id NULLS FIRST, a.name, p.horizon_days`);
  return { today, horizons, lines: result.rows.map((row) => camel<ProjectionLine>(row)), entityFilter: scope.info };
}
