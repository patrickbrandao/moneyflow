import { type CalendarItem, type DailyBalance, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { getAccount, readableFilter } from './caixas';
import { camel } from './util';

/*
 * Calendário (spec 012): títulos e faturas por vencimento (calendar_items) e o
 * saldo por dia, realizado e projetado (caixa_daily_balances,
 * account_daily_balances). As funções do banco recebem só caixas legíveis.
 */

export async function calendarItems(ctx: ServiceContext, query: { from: string; to: string; caixaIds: string[] }): Promise<CalendarItem[]> {
  for (const id of query.caixaIds) ctx.access.assertRead(id);
  const ids =
    query.caixaIds.length > 0
      ? query.caixaIds
      : (
          await ctx.db.execute<{ id: string }>(sql`SELECT c.id FROM caixas c WHERE ${readableFilter(ctx.access)} AND c.archived_at IS NULL`)
        ).rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const result = await ctx.db.execute(sql`
    SELECT ci.item_kind, ci.title_id, ci.card_invoice_id, ci.caixa_id, c.name AS caixa_name, ci.counterparty_caixa_id,
           ci.direction, ci.due_date, ci.reference_month, ci.description, ci.entity_id, e.name AS entity_name,
           ci.category_id, cat.name AS category_name, coalesce(cat.color_slot, pc.color_slot) AS category_color_slot,
           ci.amount_cents, ci.open_cents, ci.status, ci.calendar_status, ci.mirror_side, ci.mirror_status,
           (ci.item_kind = 'title' AND ci.mirror_status IS NOT NULL) AS is_mirror_side,
           (ci.item_kind = 'title' AND ci.card_invoice_id IS NOT NULL) AS is_invoice_title
      FROM calendar_items(ARRAY[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[], ${query.from}::date, ${query.to}::date, ${todayIso()}::date) ci
      JOIN caixas c ON c.id = ci.caixa_id
      LEFT JOIN entities e ON e.id = ci.entity_id
      LEFT JOIN categories cat ON cat.id = ci.category_id
      LEFT JOIN categories pc ON pc.id = cat.parent_id`);
  return result.rows.map((row) => {
    const r = camel<Omit<CalendarItem, 'key' | 'canWrite' | 'canReschedule'> & { isMirrorSide: boolean }>(row);
    const canWrite = ctx.access.canWrite(r.caixaId);
    // O vencimento do par muda pelo original: no lado espelho, só com escrita também na outra caixa.
    const canReschedule =
      r.itemKind === 'title' &&
      canWrite &&
      (!r.isMirrorSide || (r.counterpartyCaixaId !== null && ctx.access.canWrite(r.counterpartyCaixaId)));
    return { ...r, key: r.titleId ?? `${r.cardInvoiceId}:${r.caixaId}:${r.direction}`, canWrite, canReschedule };
  });
}

export async function dailyBalances(
  ctx: ServiceContext,
  query: { from: string; to: string; caixaId?: string; accountId?: string },
): Promise<DailyBalance[]> {
  if (query.accountId) {
    await getAccount(ctx, query.accountId);
    const result = await ctx.db.execute<{ day: string; balance_cents: number | null }>(
      sql`SELECT day, balance_cents FROM account_daily_balances(${query.accountId}::uuid, ${query.from}::date, ${query.to}::date)`,
    );
    return result.rows.map((r) => ({
      day: r.day,
      realizedCents: r.balance_cents === null ? null : Number(r.balance_cents),
      scheduledCents: 0,
      projectedCents: r.balance_cents === null ? null : Number(r.balance_cents),
    }));
  }
  ctx.access.assertRead(query.caixaId!);
  const result = await ctx.db.execute<{ day: string; realized_cents: number; scheduled_cents: number; projected_cents: number }>(sql`
    SELECT day, realized_cents, scheduled_cents, projected_cents
      FROM caixa_daily_balances(${query.caixaId}::uuid, ${query.from}::date, ${query.to}::date, ${todayIso()}::date)`);
  return result.rows.map((r) => ({
    day: r.day,
    realizedCents: Number(r.realized_cents),
    scheduledCents: Number(r.scheduled_cents),
    projectedCents: Number(r.projected_cents),
  }));
}
