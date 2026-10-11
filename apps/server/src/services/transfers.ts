import { movements, transfers } from '@moneyflow/db';
import { t as strings, type TransferRow, type transferCreateInput, type transferListQuery } from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { getAccount, readableFilter } from './caixas';
import { assertNotReconciled, clearStatementSuggestions, transferMovementIds } from './reconciliation-guards';
import { withTx } from './tx';
import { camel } from './util';

/* Transferências (spec 005): par de movimentos que soma zero; não é receita nem despesa. */

const selectSql = sql`
  SELECT tr.id, tr.from_account_id, fa.name AS from_account_name, fa.caixa_id AS from_caixa_id, fc.name AS from_caixa_name,
         tr.to_account_id, ta.name AS to_account_name, ta.caixa_id AS to_caixa_id, tc.name AS to_caixa_name,
         tr.amount_cents, tr.transferred_on, tr.description, tr.notes, tr.settlement_id, tr.created_at
    FROM transfers tr
    JOIN financial_accounts fa ON fa.id = tr.from_account_id
    JOIN caixas fc ON fc.id = fa.caixa_id
    JOIN financial_accounts ta ON ta.id = tr.to_account_id
    JOIN caixas tc ON tc.id = ta.caixa_id`;

const toRow = (row: Record<string, unknown>): TransferRow => {
  const r = camel<TransferRow & { createdAt: Date }>(row);
  return { ...r, createdAt: new Date(r.createdAt).toISOString() };
};

export async function listTransfers(ctx: ServiceContext, query: z.output<typeof transferListQuery>): Promise<TransferRow[]> {
  if (query.caixaId) ctx.access.assertRead(query.caixaId);
  const where = [sql`(${readableFilter(ctx.access, sql`fa.caixa_id`)} OR ${readableFilter(ctx.access, sql`ta.caixa_id`)})`];
  if (query.caixaId) where.push(sql`(fa.caixa_id = ${query.caixaId} OR ta.caixa_id = ${query.caixaId})`);
  if (query.from) where.push(sql`tr.transferred_on >= ${query.from}::date`);
  if (query.to) where.push(sql`tr.transferred_on <= ${query.to}::date`);
  const result = await ctx.db.execute(
    sql`${selectSql} WHERE ${sql.join(where, sql` AND `)} ORDER BY tr.transferred_on DESC, tr.created_at DESC LIMIT ${query.limit}`,
  );
  return result.rows.map(toRow);
}

export async function getTransfer(ctx: ServiceContext, id: string): Promise<TransferRow> {
  const result = await ctx.db.execute(sql`${selectSql} WHERE tr.id = ${id}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  const row = toRow(raw);
  if (!ctx.access.canRead(row.fromCaixaId) && !ctx.access.canRead(row.toCaixaId)) throw notFound();
  return row;
}

/** Exige escrita nas duas caixas (o dinheiro sai de uma e entra na outra). */
export async function createTransfer(ctx: ServiceContext, input: z.output<typeof transferCreateInput>): Promise<TransferRow> {
  const id = await withTx(ctx, async (tx) => {
    const from = await getAccount(ctx, input.fromAccountId, tx);
    const to = await getAccount(ctx, input.toAccountId, tx);
    ctx.access.assertWrite(from.caixaId);
    ctx.access.assertWrite(to.caixaId);
    const [row] = await tx
      .insert(transfers)
      .values({
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents: input.amountCents,
        transferredOn: input.transferredOn,
        description: input.description,
        notes: input.notes,
      })
      .returning({ id: transfers.id });
    await tx.insert(movements).values([
      {
        financialAccountId: from.id,
        occurredOn: input.transferredOn,
        amountCents: -input.amountCents,
        kind: 'transfer',
        transferId: row!.id,
        description: input.description,
      },
      {
        financialAccountId: to.id,
        occurredOn: input.transferredOn,
        amountCents: input.amountCents,
        kind: 'transfer',
        transferId: row!.id,
        description: input.description,
      },
    ]);
    return row!.id;
  });
  return getTransfer(ctx, id);
}

/** Exclusão física (os movimentos vão junto). A transferência de uma baixa sai pelo estorno da baixa. */
export async function deleteTransfer(ctx: ServiceContext, id: string) {
  const transfer = await getTransfer(ctx, id);
  ctx.access.assertWrite(transfer.fromCaixaId);
  ctx.access.assertWrite(transfer.toCaixaId);
  if (transfer.settlementId) throw unprocessable(strings.errors.transferFromSettlement);
  await withTx(ctx, async (tx) => {
    const movementIds = await transferMovementIds(tx, [id]);
    await assertNotReconciled(tx, movementIds);
    await clearStatementSuggestions(tx, { movementIds });
    await tx.delete(transfers).where(eq(transfers.id, id));
  });
}
