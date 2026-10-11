import { periodClosings } from '@moneyflow/db';
import {
  type AuditEntry,
  type auditListQuery,
  type ClosingsOverview,
  type PeriodClosingRow,
  type periodClosingInput,
  t,
} from '@moneyflow/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Auditoria e fechamento de mês (spec 008). O log é escrito pelo banco (trigger
 * em toda tabela de negócio, com o ator da transação); a aplicação só lê.
 */

/** Caixa(s) donas de um registro, para decidir quem pode ver o histórico dele. */
const OWNER_SQL: Record<string, (id: string) => ReturnType<typeof sql>> = {
  caixas: (id) => sql`SELECT id AS caixa_id FROM caixas WHERE id = ${id}`,
  caixa_members: (id) => sql`SELECT caixa_id FROM caixa_members WHERE id = ${id}`,
  caixa_hidden_categories: (id) => sql`SELECT caixa_id FROM caixa_hidden_categories WHERE id = ${id}`,
  financial_accounts: (id) => sql`SELECT caixa_id FROM financial_accounts WHERE id = ${id}`,
  titles: (id) => sql`SELECT caixa_id FROM titles WHERE id = ${id}`,
  settlements: (id) => sql`SELECT t.caixa_id FROM settlements s JOIN titles t ON t.id = s.title_id WHERE s.id = ${id}`,
  movements: (id) => sql`SELECT a.caixa_id FROM movements m JOIN financial_accounts a ON a.id = m.financial_account_id WHERE m.id = ${id}`,
  transfers: (id) => sql`
    SELECT a.caixa_id FROM transfers tr JOIN financial_accounts a ON a.id IN (tr.from_account_id, tr.to_account_id) WHERE tr.id = ${id}`,
  card_invoices: (id) => sql`SELECT card_caixa_id AS caixa_id FROM card_invoices WHERE id = ${id}`,
  card_purchases: (id) => sql`SELECT card_caixa_id AS caixa_id FROM card_purchases WHERE id = ${id}`,
  card_invoice_items: (id) =>
    sql`SELECT v.card_caixa_id AS caixa_id FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id WHERE i.id = ${id}`,
  statement_imports: (id) => sql`
    SELECT coalesce(a.caixa_id, i.card_caixa_id) AS caixa_id
      FROM statement_imports i LEFT JOIN financial_accounts a ON a.id = i.financial_account_id WHERE i.id = ${id}`,
  statement_lines: (id) => sql`
    SELECT coalesce(a.caixa_id, l.card_caixa_id) AS caixa_id
      FROM statement_lines l LEFT JOIN financial_accounts a ON a.id = l.financial_account_id WHERE l.id = ${id}`,
  period_closings: (id) => sql`SELECT caixa_id FROM period_closings WHERE id = ${id}`,
};

/** Cadastros globais: o histórico é visível a todos os usuários. */
const GLOBAL_TABLES = new Set([
  'entities',
  'entity_contacts',
  'entity_addresses',
  'entity_bank_accounts',
  'entity_pix_keys',
  'entity_links',
  'categories',
  'nfe_documents',
  'nfe_items',
]);

const entrySql = sql`
  SELECT l.id, l.table_name, l.record_id, l.action, l.old_data, l.new_data, l.changed_columns, l.user_id,
         u.username, l.actor_kind, l.agent_run_id, l.transaction_id, l.created_at
    FROM audit_log l LEFT JOIN users u ON u.id = l.user_id`;

function toEntry(row: Record<string, unknown>): AuditEntry {
  const r = camel<AuditEntry>(row);
  return { ...r, transactionId: Number(r.transactionId), createdAt: iso(r.createdAt)! };
}

async function assertRecordReadable(ctx: ServiceContext, table: string, recordId: string) {
  if (ctx.access.isAdmin || GLOBAL_TABLES.has(table)) return;
  const owner = OWNER_SQL[table];
  if (!owner) throw forbidden();
  let caixaIds = (await ctx.db.execute<{ caixa_id: string }>(owner(recordId))).rows.map((r) => r.caixa_id);
  if (caixaIds.length === 0) {
    // Registro excluído: a caixa vem do último estado guardado no log.
    const last = await ctx.db.execute<{ data: Record<string, string> }>(sql`
      SELECT coalesce(old_data, new_data) AS data FROM audit_log
       WHERE table_name = ${table} AND record_id = ${recordId} ORDER BY id DESC LIMIT 1`);
    const data = last.rows[0]?.data;
    caixaIds = [data?.caixa_id, data?.card_caixa_id].filter((v): v is string => Boolean(v));
  }
  if (!caixaIds.some((id) => ctx.access.canRead(id))) throw notFound();
}

/** Histórico de um registro (antes/depois de cada alteração). */
export async function recordHistory(ctx: ServiceContext, table: string, recordId: string): Promise<AuditEntry[]> {
  await assertRecordReadable(ctx, table, recordId);
  const result = await ctx.db.execute(
    sql`${entrySql} WHERE l.table_name = ${table} AND l.record_id = ${recordId} ORDER BY l.id DESC LIMIT 500`,
  );
  return result.rows.map(toEntry);
}

/** Log geral (admin), do mais recente para o mais antigo; `before` = id do último item da página anterior. */
export async function auditLog(ctx: ServiceContext, query: z.output<typeof auditListQuery>): Promise<AuditEntry[]> {
  ctx.access.assertAdmin();
  const where = [sql`true`];
  if (query.table) where.push(sql`l.table_name = ${query.table}`);
  if (query.userId) where.push(sql`l.user_id = ${query.userId}`);
  if (query.actorKind) where.push(sql`l.actor_kind = ${query.actorKind}`);
  if (query.recordId) where.push(sql`l.record_id = ${query.recordId}`);
  if (query.from) where.push(sql`l.created_at >= ${query.from}::date`);
  if (query.to) where.push(sql`l.created_at < ${query.to}::date + 1`);
  if (query.before && /^[0-9a-f-]{36}$/i.test(query.before)) where.push(sql`l.id < ${query.before}::uuid`);
  const result = await ctx.db.execute(sql`${entrySql} WHERE ${sql.join(where, sql` AND `)} ORDER BY l.id DESC LIMIT ${query.limit}`);
  return result.rows.map(toEntry);
}

/* ---------------- fechamento de mês ---------------- */

export async function closingsOverview(ctx: ServiceContext, caixaId: string): Promise<ClosingsOverview> {
  ctx.access.assertRead(caixaId);
  const [closings, unreconciled] = await Promise.all([
    ctx.db.execute(sql`
      SELECT pc.id, pc.caixa_id, pc.month, pc.closed_by_user_id, u.username AS closed_by, pc.notes, pc.created_at
        FROM period_closings pc LEFT JOIN users u ON u.id = pc.closed_by_user_id
       WHERE pc.caixa_id = ${caixaId} ORDER BY pc.month DESC`),
    unreconciledByMonth(ctx, caixaId),
  ]);
  return {
    closings: closings.rows.map((row) => {
      const r = camel<PeriodClosingRow>(row);
      return { ...r, createdAt: iso(r.createdAt)! };
    }),
    unreconciled,
    canWrite: ctx.access.canWrite(caixaId),
    canReopen: ctx.access.isAdmin,
  };
}

async function unreconciledByMonth(ctx: ServiceContext, caixaId: string, month?: string) {
  const result = await ctx.db.execute<{ month: string; lines: number }>(sql`
    SELECT date_trunc('month', l.posted_on)::date AS month, count(*)::int AS lines
      FROM statement_lines l
      LEFT JOIN financial_accounts a ON a.id = l.financial_account_id
     WHERE coalesce(a.caixa_id, l.card_caixa_id) = ${caixaId} AND l.status IN ('new', 'suggested')
       ${month ? sql`AND date_trunc('month', l.posted_on)::date = ${month}::date` : sql``}
     GROUP BY 1 ORDER BY 1 DESC`);
  return result.rows.map((r) => ({ month: r.month, lines: Number(r.lines) }));
}

/** Fecha o mês na caixa (spec 008: depois da conciliação; `force` fecha com pendências). */
export async function closeMonth(ctx: ServiceContext, caixaId: string, input: z.output<typeof periodClosingInput>) {
  ctx.access.assertWrite(caixaId);
  if (!input.force) {
    const [pending] = await unreconciledByMonth(ctx, caixaId, input.month);
    if (pending && pending.lines > 0) throw new AppError(422, 'closing_unreconciled', t.errors.closingUnreconciled(pending.lines));
  }
  await withTx(ctx, (tx) =>
    tx.insert(periodClosings).values({ caixaId, month: input.month, notes: input.notes, closedByUserId: ctx.access.actor.id }),
  );
  return closingsOverview(ctx, caixaId);
}

/** Reabrir = apagar o fechamento, só admin ativo (o banco confere app.user_id, senão 42501). */
export async function reopenMonth(ctx: ServiceContext, caixaId: string, month: string) {
  ctx.access.assertRead(caixaId);
  if (!ctx.access.isAdmin) throw forbidden(t.errors.reopenAdminOnly);
  const removed = await withTx(ctx, (tx) =>
    tx.delete(periodClosings).where(and(eq(periodClosings.caixaId, caixaId), eq(periodClosings.month, month))),
  );
  if (!removed.rowCount) throw notFound();
  return closingsOverview(ctx, caixaId);
}
