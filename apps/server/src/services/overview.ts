import { addDays, type Overview, type SearchHit, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { listCaixas, readableFilter } from './caixas';
import { listEntities } from './entities';
import { listTitles } from './titles';

/** Visão geral: saldos por caixa, vencidos, a vencer em 30 dias e pendências de espelho/conta. */
export async function overview(ctx: ServiceContext): Promise<Overview> {
  const today = todayIso();
  const [caixas, overdue, upcoming, pendingMirrors, pendingAccounts] = await Promise.all([
    listCaixas(ctx),
    listTitles(ctx, { status: 'overdue', archived: false, limit: 50 }),
    listTitles(ctx, { status: 'unpaid', from: today, to: addDays(today, 30), archived: false, limit: 50 }),
    listTitles(ctx, { status: 'pending_acceptance', archived: false, limit: 50 }, { writableOnly: true }),
    listTitles(ctx, { status: 'pending_account', archived: false, limit: 50 }, { writableOnly: true }),
  ]);
  const sum = (key: 'balanceCents' | 'payableOpenCents' | 'receivableOpenCents' | 'overdueCents') =>
    caixas.reduce((acc, c) => acc + c[key], 0);
  return {
    totals: {
      balanceCents: sum('balanceCents'),
      payableOpenCents: sum('payableOpenCents'),
      receivableOpenCents: sum('receivableOpenCents'),
      overdueCents: sum('overdueCents'),
    },
    caixas,
    overdue,
    upcoming,
    pendingMirrors,
    pendingAccounts,
  };
}

/** Busca da paleta (⌘K): entidades, caixas e títulos visíveis. */
export async function search(ctx: ServiceContext, q: string, limit = 6): Promise<SearchHit[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  const [entities, caixas, titles] = await Promise.all([
    listEntities(ctx, { q: text, archived: false, limit }),
    ctx.db.execute<{ id: string; name: string; holder: string }>(sql`
      SELECT c.id, c.name, e.name AS holder FROM caixas c JOIN entities e ON e.id = c.holder_entity_id
       WHERE ${readableFilter(ctx.access)} AND c.archived_at IS NULL AND (c.name ILIKE ${`%${text}%`} OR e.name ILIKE ${`%${text}%`})
       ORDER BY c.name LIMIT ${limit}`),
    listTitles(ctx, { q: text, archived: false, limit }),
  ]);
  return [
    ...entities.map((e) => ({ kind: 'entity' as const, id: e.id, label: e.name, sub: e.document ?? '', to: `/entities/${e.id}` })),
    ...caixas.rows.map((c) => ({ kind: 'caixa' as const, id: c.id, label: c.name, sub: c.holder, to: `/caixas/${c.id}` })),
    ...titles.map((t) => ({
      kind: 'title' as const,
      id: t.id,
      label: t.description,
      sub: `${t.caixaName} · ${t.dueDate}`,
      to: `/caixas/${t.caixaId}/${t.direction === 'payable' ? 'payables' : 'receivables'}?title=${t.id}`,
    })),
  ];
}
