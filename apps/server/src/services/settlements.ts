import { type Executor, movements, settlements, type Tx, titles, transfers } from '@moneyflow/db';
import {
  diffDays,
  type settlementAccountInput,
  type settlementCreateInput,
  type settlementReverseInput,
  t as strings,
  type TitleDetail,
  todayIso,
} from '@moneyflow/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { forbidden, notFound, unprocessable } from '../errors';
import { getAccount } from './caixas';
import { newIds } from './title-pair';
import { getTitle } from './titles';

/*
 * Baixas (specs 005 e 006). Tudo numa transação, na ordem que as checagens
 * deferidas do banco esperam no COMMIT (docs/016):
 *   1. a baixa (e a perna do espelho, ligadas pelos ids gerados antes);
 *   2. o movimento de cada perna com conta e valor em dinheiro ≠ 0;
 *   3. se pagou com conta de outra caixa: a transferência e os dois movimentos dela.
 */

type Direction = 'payable' | 'receivable';
const sign = (direction: string) => (direction === 'payable' ? -1 : 1);
const cashOf = (s: { amountCents: number; interestCents: number; fineCents: number; discountCents: number }) =>
  s.amountCents + s.interestCents + s.fineCents - s.discountCents;

async function lockTitle(tx: Executor, id: string) {
  const [row] = await tx.select().from(titles).where(eq(titles.id, id)).for('update');
  if (!row) throw notFound();
  return row;
}

async function accountInCaixa(ctx: ServiceContext, tx: Executor, accountId: string, caixaId: string) {
  const account = await getAccount(ctx, accountId, tx);
  if (account.caixaId !== caixaId) throw unprocessable(strings.errors.accountOtherCaixa);
  return account;
}

async function insertSettlementMovement(
  tx: Tx,
  leg: { id: string; financialAccountId: string | null; settledOn: string },
  title: { direction: string; description: string; entityId: string },
  cash: number,
  occurredOn = leg.settledOn,
  reversal = false,
) {
  if (!leg.financialAccountId || cash === 0) return;
  await tx.insert(movements).values({
    financialAccountId: leg.financialAccountId,
    occurredOn,
    amountCents: sign(title.direction) * cash * (reversal ? -1 : 1),
    kind: 'settlement',
    settlementId: leg.id,
    description: title.description,
    entityId: title.entityId,
  });
}

export async function createSettlement(
  ctx: ServiceContext,
  titleId: string,
  input: z.output<typeof settlementCreateInput>,
): Promise<TitleDetail> {
  await ctx.db.transaction(async (tx) => {
    const title = await lockTitle(tx, titleId);
    ctx.access.assertWrite(title.caixaId);
    const cash = cashOf(input);

    const accountId = input.financialAccountId;
    if (accountId) await accountInCaixa(ctx, tx, accountId, title.caixaId);

    // Pagar o título da caixa B com uma conta da caixa A: transferência A → B (ou B → A ao receber).
    let transfer: { from: string; to: string } | null = null;
    if (input.sourceAccountId) {
      const source = await getAccount(ctx, input.sourceAccountId, tx);
      ctx.access.assertWrite(source.caixaId);
      if (source.caixaId === title.caixaId) throw unprocessable(strings.errors.sameCaixaSource);
      if (!accountId) throw unprocessable(strings.errors.accountRequiredForTransfer);
      if (cash <= 0) throw unprocessable(strings.errors.zeroCashTransfer);
      transfer = (title.direction as Direction) === 'payable' ? { from: source.id, to: accountId } : { from: accountId, to: source.id };
    }

    const mirror = title.mirrorTitleId ? await lockTitle(tx, title.mirrorTitleId) : null;
    let mirrorAccountId: string | null = null;
    if (mirror && input.mirrorAccountId) {
      if (!ctx.access.canWrite(mirror.caixaId)) throw forbidden();
      await accountInCaixa(ctx, tx, input.mirrorAccountId, mirror.caixaId);
      mirrorAccountId = input.mirrorAccountId;
    }

    const [ownId, mirrorLegId] = await newIds(tx, mirror ? 2 : 1);
    const amounts = {
      settledOn: input.settledOn,
      amountCents: input.amountCents,
      interestCents: input.interestCents,
      fineCents: input.fineCents,
      discountCents: input.discountCents,
    };
    await tx.insert(settlements).values({
      id: ownId!,
      titleId,
      ...amounts,
      financialAccountId: accountId,
      mirrorSettlementId: mirror ? mirrorLegId! : null,
      notes: input.notes,
    });
    if (mirror) {
      // Baixa única, duas pernas (spec 006): sem acesso ao outro lado, ele fica "baixado, conta a definir".
      await tx.insert(settlements).values({
        id: mirrorLegId!,
        titleId: mirror.id,
        ...amounts,
        financialAccountId: mirrorAccountId,
        mirrorSettlementId: ownId!,
        notes: input.notes,
      });
    }

    await insertSettlementMovement(tx, { id: ownId!, financialAccountId: accountId, settledOn: input.settledOn }, title, cash);
    if (mirror) {
      await insertSettlementMovement(
        tx,
        { id: mirrorLegId!, financialAccountId: mirrorAccountId, settledOn: input.settledOn },
        mirror,
        cash,
      );
    }

    if (transfer) {
      const [row] = await tx
        .insert(transfers)
        .values({
          fromAccountId: transfer.from,
          toAccountId: transfer.to,
          amountCents: cash,
          transferredOn: input.settledOn,
          description: title.description,
          settlementId: ownId!,
        })
        .returning({ id: transfers.id });
      await tx.insert(movements).values([
        {
          financialAccountId: transfer.from,
          occurredOn: input.settledOn,
          amountCents: -cash,
          kind: 'transfer',
          transferId: row!.id,
          description: title.description,
        },
        {
          financialAccountId: transfer.to,
          occurredOn: input.settledOn,
          amountCents: cash,
          kind: 'transfer',
          transferId: row!.id,
          description: title.description,
        },
      ]);
    }
  });
  return getTitle(ctx, titleId);
}

async function loadLeg(tx: Executor, id: string) {
  const [row] = await tx.select().from(settlements).where(eq(settlements.id, id)).for('update');
  if (!row) throw notFound();
  return row;
}

/** Define a conta de uma baixa "conta a definir" (o lado sem acesso no espelho). */
export async function setSettlementAccount(
  ctx: ServiceContext,
  settlementId: string,
  input: z.output<typeof settlementAccountInput>,
): Promise<TitleDetail> {
  const titleId = await ctx.db.transaction(async (tx) => {
    const leg = await loadLeg(tx, settlementId);
    const [title] = await tx.select().from(titles).where(eq(titles.id, leg.titleId));
    if (!title) throw notFound();
    ctx.access.assertWrite(title.caixaId);
    if (leg.reversedAt) throw unprocessable(strings.errors.settlementReversed);
    if (leg.financialAccountId) throw unprocessable(strings.errors.settlementHasAccount);
    await accountInCaixa(ctx, tx, input.financialAccountId, title.caixaId);
    await tx.update(settlements).set({ financialAccountId: input.financialAccountId }).where(eq(settlements.id, leg.id));
    await insertSettlementMovement(tx, { ...leg, financialAccountId: input.financialAccountId }, title, cashOf(leg));
    return title.id;
  });
  return getTitle(ctx, titleId);
}

/**
 * Estorno: marca a baixa (e a perna do espelho) como estornada e lança o
 * movimento oposto em cada perna com conta. A transferência gerada pela baixa
 * é desfeita por padrão (o dinheiro volta para a conta de origem).
 */
export async function reverseSettlement(
  ctx: ServiceContext,
  settlementId: string,
  input: z.output<typeof settlementReverseInput>,
): Promise<TitleDetail> {
  const titleId = await ctx.db.transaction(async (tx) => {
    const leg = await loadLeg(tx, settlementId);
    const [title] = await tx.select().from(titles).where(eq(titles.id, leg.titleId));
    if (!title) throw notFound();
    ctx.access.assertWrite(title.caixaId);
    if (leg.reversedAt) throw unprocessable(strings.errors.settlementReversed);
    const reversedOn = input.reversedOn ?? todayIso();
    if (diffDays(leg.settledOn, reversedOn) < 0) throw unprocessable(strings.errors.reversalBeforeSettlement);

    const legs = [leg];
    if (leg.mirrorSettlementId) legs.push(await loadLeg(tx, leg.mirrorSettlementId));
    for (const current of legs) {
      await tx.update(settlements).set({ reversedAt: sql`now()`, reversalReason: input.reason }).where(eq(settlements.id, current.id));
      const [owner] = await tx.select().from(titles).where(eq(titles.id, current.titleId));
      await insertSettlementMovement(tx, current, owner!, cashOf(current), reversedOn, true);
    }
    if (input.undoTransfer) {
      await tx.delete(transfers).where(
        inArray(
          transfers.settlementId,
          legs.map((l) => l.id),
        ),
      );
    }
    return title.id;
  });
  return getTitle(ctx, titleId);
}
