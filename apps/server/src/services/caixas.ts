import { caixaHiddenCategories, caixaMembers, caixas, type Executor, entities, financialAccounts, movements, users } from '@moneyflow/db';
import {
  type AccountKind,
  type AccountRow,
  type accountCreateInput,
  type accountUpdateInput,
  type adjustmentInput,
  type CaixaDetail,
  type CaixaRole,
  type CaixaSummary,
  type caixaCreateInput,
  type caixaUpdateInput,
  type DeleteResult,
  type hiddenCategoriesInput,
  type MemberRow,
  type memberInput,
  type memberUpdateInput,
  t,
  todayIso,
} from '@moneyflow/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Access } from '../authz/access';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { camel, deleteOrArchive } from './util';

/* Caixas, membros e contas financeiras (specs 002 e 004). */

/** Filtro SQL das caixas legíveis por quem age. */
export function readableFilter(access: Access, column = sql`c.id`) {
  const ids = access.readableCaixaIds();
  if (ids === 'all') return sql`true`;
  if (ids.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

const summarySql = (today: string) => sql`
  c.id, c.name, c.kind, c.holder_entity_id, e.name AS holder_name, c.is_primary, c.description, c.archived_at,
  coalesce((SELECT sum(b.balance_cents) FROM financial_account_balances b WHERE b.caixa_id = c.id AND b.archived_at IS NULL), 0)::bigint AS balance_cents,
  coalesce((SELECT sum(tb.open_cents) FROM title_balances tb WHERE tb.caixa_id = c.id AND tb.direction = 'payable' AND tb.archived_at IS NULL), 0)::bigint AS payable_open_cents,
  coalesce((SELECT sum(tb.open_cents) FROM title_balances tb WHERE tb.caixa_id = c.id AND tb.direction = 'receivable' AND tb.archived_at IS NULL), 0)::bigint AS receivable_open_cents,
  (SELECT count(*)::int FROM title_balances tb WHERE tb.caixa_id = c.id AND tb.open_cents > 0 AND tb.archived_at IS NULL AND tb.due_date < ${today}::date) AS overdue_count,
  coalesce((SELECT sum(tb.open_cents) FROM title_balances tb WHERE tb.caixa_id = c.id AND tb.open_cents > 0 AND tb.archived_at IS NULL AND tb.due_date < ${today}::date), 0)::bigint AS overdue_cents`;

function toSummary(access: Access, row: Record<string, unknown>): CaixaSummary {
  const r = camel<CaixaSummary & { archivedAt: Date | null }>(row);
  return { ...r, archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null, myRole: access.roleIn(r.id) ?? 'viewer' };
}

export async function listCaixas(ctx: ServiceContext, opts: { archived?: boolean } = {}): Promise<CaixaSummary[]> {
  const result = await ctx.db.execute(sql`
    SELECT ${summarySql(todayIso())}
      FROM caixas c JOIN entities e ON e.id = c.holder_entity_id
     WHERE ${readableFilter(ctx.access)} AND ${opts.archived ? sql`c.archived_at IS NOT NULL` : sql`c.archived_at IS NULL`}
     ORDER BY c.name`);
  return result.rows.map((row) => toSummary(ctx.access, row));
}

export async function getCaixa(ctx: ServiceContext, id: string): Promise<CaixaDetail> {
  ctx.access.assertRead(id);
  const result = await ctx.db.execute(sql`
    SELECT ${summarySql(todayIso())} FROM caixas c JOIN entities e ON e.id = c.holder_entity_id WHERE c.id = ${id}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  return {
    ...toSummary(ctx.access, row),
    accounts: await listAccounts(ctx, { caixaId: id, archived: true }),
    canWrite: ctx.access.canWrite(id),
  };
}

async function assertHolder(db: Executor, entityId: string) {
  const [holder] = await db.select({ archivedAt: entities.archivedAt }).from(entities).where(eq(entities.id, entityId));
  if (!holder) throw notFound();
  if (holder.archivedAt) throw unprocessable(t.errors.holderArchived);
}

export async function createCaixa(ctx: ServiceContext, input: z.output<typeof caixaCreateInput>): Promise<CaixaDetail> {
  ctx.access.assertRegistryWrite();
  const id = await ctx.db.transaction(async (tx) => {
    await assertHolder(tx, input.holderEntityId);
    if (input.isPrimary) {
      await tx.update(caixas).set({ isPrimary: false }).where(eq(caixas.holderEntityId, input.holderEntityId));
    }
    const [row] = await tx
      .insert(caixas)
      .values({
        name: input.name,
        kind: 'general',
        holderEntityId: input.holderEntityId,
        isPrimary: input.isPrimary,
        description: input.description,
      })
      .returning({ id: caixas.id });
    // Quem cria (sem ser admin) vira editor da caixa nova.
    if (!ctx.access.isAdmin) await tx.insert(caixaMembers).values({ userId: ctx.access.actor.id, caixaId: row!.id, role: 'editor' });
    return row!.id;
  });
  if (!ctx.access.isAdmin) ctx.access.grant(id, 'editor');
  return getCaixa(ctx, id);
}

export async function updateCaixa(ctx: ServiceContext, id: string, input: z.output<typeof caixaUpdateInput>): Promise<CaixaDetail> {
  ctx.access.assertWrite(id);
  await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(caixas).where(eq(caixas.id, id)).for('update');
    if (!current) throw notFound();
    const holder = input.holderEntityId ?? current.holderEntityId;
    if (input.holderEntityId && input.holderEntityId !== current.holderEntityId) {
      await assertHolder(tx, input.holderEntityId);
      // O titular define os espelhos: com títulos ligados, não muda.
      const linked = await tx.execute(sql`SELECT 1 FROM titles WHERE caixa_id = ${id} OR counterparty_caixa_id = ${id} LIMIT 1`);
      if (linked.rows.length > 0) throw unprocessable(t.errors.mirrorCaixaNotHeld);
    }
    if (input.isPrimary) {
      await tx
        .update(caixas)
        .set({ isPrimary: false })
        .where(and(eq(caixas.holderEntityId, holder), ne(caixas.id, id)));
    }
    const patch: Partial<typeof caixas.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.holderEntityId !== undefined) patch.holderEntityId = input.holderEntityId;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;
    if (Object.keys(patch).length > 0) await tx.update(caixas).set(patch).where(eq(caixas.id, id));
  });
  return getCaixa(ctx, id);
}

export async function deleteCaixa(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  ctx.access.assertAdmin();
  const [current] = await ctx.db.select({ id: caixas.id }).from(caixas).where(eq(caixas.id, id));
  if (!current) throw notFound();
  return deleteOrArchive(
    async () => (await ctx.db.delete(caixas).where(eq(caixas.id, id))).rowCount ?? 0,
    // A principal não pode ficar arquivada: deixa de ser principal.
    () => ctx.db.update(caixas).set({ archivedAt: sql`now()`, isPrimary: false }).where(eq(caixas.id, id)),
  );
}

export async function restoreCaixa(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await ctx.db.update(caixas).set({ archivedAt: null }).where(eq(caixas.id, id));
  return getCaixa(ctx, id);
}

/* ---- membros ---- */

export async function listMembers(ctx: ServiceContext, caixaId: string): Promise<MemberRow[]> {
  ctx.access.assertRead(caixaId);
  const rows = await ctx.db
    .select({
      id: caixaMembers.id,
      userId: users.id,
      username: users.username,
      email: users.email,
      isActive: users.isActive,
      role: caixaMembers.role,
    })
    .from(caixaMembers)
    .innerJoin(users, eq(users.id, caixaMembers.userId))
    .where(eq(caixaMembers.caixaId, caixaId))
    .orderBy(asc(users.username));
  return rows.map((r) => ({ ...r, role: r.role as CaixaRole }));
}

export async function addMember(ctx: ServiceContext, caixaId: string, input: z.output<typeof memberInput>) {
  ctx.access.assertAdmin();
  await ctx.db.insert(caixaMembers).values({ caixaId, userId: input.userId, role: input.role });
  return listMembers(ctx, caixaId);
}

export async function updateMember(ctx: ServiceContext, caixaId: string, memberId: string, input: z.output<typeof memberUpdateInput>) {
  ctx.access.assertAdmin();
  const result = await ctx.db
    .update(caixaMembers)
    .set({ role: input.role })
    .where(and(eq(caixaMembers.id, memberId), eq(caixaMembers.caixaId, caixaId)));
  if (!result.rowCount) throw notFound();
  return listMembers(ctx, caixaId);
}

export async function removeMember(ctx: ServiceContext, caixaId: string, memberId: string) {
  ctx.access.assertAdmin();
  await ctx.db.delete(caixaMembers).where(and(eq(caixaMembers.id, memberId), eq(caixaMembers.caixaId, caixaId)));
  return listMembers(ctx, caixaId);
}

/* ---- contas financeiras ---- */

export async function listAccounts(
  ctx: ServiceContext,
  opts: { caixaId?: string; archived?: boolean; writable?: boolean } = {},
): Promise<AccountRow[]> {
  if (opts.caixaId) ctx.access.assertRead(opts.caixaId);
  const result = await ctx.db.execute(sql`
    SELECT a.id, a.caixa_id, c.name AS caixa_name, a.kind, a.name, a.bank_code, a.ispb, a.branch, a.account_number,
           a.opening_balance_cents, a.opening_date, a.archived_at, b.balance_cents
      FROM financial_accounts a
      JOIN caixas c ON c.id = a.caixa_id
      JOIN financial_account_balances b ON b.financial_account_id = a.id
     WHERE ${readableFilter(ctx.access, sql`a.caixa_id`)}
       ${opts.caixaId ? sql`AND a.caixa_id = ${opts.caixaId}` : sql``}
       ${opts.archived ? sql`` : sql`AND a.archived_at IS NULL AND c.archived_at IS NULL`}
     ORDER BY c.name, a.archived_at NULLS FIRST, a.name`);
  return result.rows
    .map((row) => {
      const r = camel<AccountRow & { archivedAt: Date | null }>(row);
      return {
        ...r,
        kind: r.kind as AccountKind,
        archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null,
        canWrite: ctx.access.canWrite(r.caixaId),
      };
    })
    .filter((a) => !opts.writable || a.canWrite);
}

export async function getAccount(ctx: ServiceContext, id: string, db: Executor = ctx.db) {
  const [account] = await db.select().from(financialAccounts).where(eq(financialAccounts.id, id));
  if (!account) throw notFound();
  ctx.access.assertRead(account.caixaId);
  return account;
}

export async function createAccount(ctx: ServiceContext, caixaId: string, input: z.output<typeof accountCreateInput>) {
  ctx.access.assertWrite(caixaId);
  const bank = input.kind === 'cash' ? { bankCode: null, ispb: null, branch: null, accountNumber: null } : {};
  const [row] = await ctx.db
    .insert(financialAccounts)
    .values({ caixaId, ...input, ...bank })
    .returning({ id: financialAccounts.id });
  return (await listAccounts(ctx, { caixaId, archived: true })).find((a) => a.id === row!.id)!;
}

export async function updateAccount(ctx: ServiceContext, id: string, input: z.output<typeof accountUpdateInput>) {
  const account = await getAccount(ctx, id);
  ctx.access.assertWrite(account.caixaId);
  const patch: Partial<typeof financialAccounts.$inferInsert> = {};
  for (const key of ['name', 'bankCode', 'ispb', 'branch', 'accountNumber', 'openingBalanceCents', 'openingDate'] as const) {
    if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
  }
  if (Object.keys(patch).length > 0) await ctx.db.update(financialAccounts).set(patch).where(eq(financialAccounts.id, id));
  return (await listAccounts(ctx, { caixaId: account.caixaId, archived: true })).find((a) => a.id === id)!;
}

export async function deleteAccount(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  const account = await getAccount(ctx, id);
  ctx.access.assertWrite(account.caixaId);
  return deleteOrArchive(
    async () => (await ctx.db.delete(financialAccounts).where(eq(financialAccounts.id, id))).rowCount ?? 0,
    () => ctx.db.update(financialAccounts).set({ archivedAt: sql`now()` }).where(eq(financialAccounts.id, id)),
  );
}

export async function restoreAccount(ctx: ServiceContext, id: string) {
  const account = await getAccount(ctx, id);
  ctx.access.assertWrite(account.caixaId);
  await ctx.db.update(financialAccounts).set({ archivedAt: null }).where(eq(financialAccounts.id, id));
}

/** Lançamento avulso (ajuste de contagem, rendimento, tarifa). */
export async function addAdjustment(ctx: ServiceContext, accountId: string, input: z.output<typeof adjustmentInput>) {
  const account = await getAccount(ctx, accountId);
  ctx.access.assertWrite(account.caixaId);
  const [row] = await ctx.db
    .insert(movements)
    .values({
      financialAccountId: accountId,
      occurredOn: input.occurredOn,
      amountCents: input.amountCents,
      kind: 'adjustment',
      description: input.description,
      categoryId: input.categoryId,
      entityId: input.entityId,
      notes: input.notes,
    })
    .returning({ id: movements.id });
  return { id: row!.id };
}

export async function deleteAdjustment(ctx: ServiceContext, movementId: string) {
  const [movement] = await ctx.db.select().from(movements).where(eq(movements.id, movementId));
  if (!movement || movement.kind !== 'adjustment') throw notFound();
  const account = await getAccount(ctx, movement.financialAccountId);
  ctx.access.assertWrite(account.caixaId);
  await ctx.db.delete(movements).where(eq(movements.id, movementId));
}

/* ---- categorias ocultas ---- */

export async function getHiddenCategories(ctx: ServiceContext, caixaId: string): Promise<string[]> {
  ctx.access.assertRead(caixaId);
  const rows = await ctx.db
    .select({ id: caixaHiddenCategories.categoryId })
    .from(caixaHiddenCategories)
    .where(eq(caixaHiddenCategories.caixaId, caixaId));
  return rows.map((r) => r.id);
}

export async function setHiddenCategories(ctx: ServiceContext, caixaId: string, input: z.output<typeof hiddenCategoriesInput>) {
  ctx.access.assertWrite(caixaId);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(caixaHiddenCategories).where(eq(caixaHiddenCategories.caixaId, caixaId));
    const ids = [...new Set(input.categoryIds)];
    if (ids.length > 0) await tx.insert(caixaHiddenCategories).values(ids.map((categoryId) => ({ caixaId, categoryId })));
  });
  return getHiddenCategories(ctx, caixaId);
}
