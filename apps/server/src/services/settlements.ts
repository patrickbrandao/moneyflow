import { type Executor, financialAccounts, movements, settlements, type Tx, titles, transfers } from '@moneyflow/db';
import {
  diffDays,
  type SettlementReversalInfo,
  type settlementAccountInput,
  type settlementCreateInput,
  type settlementReversalDateInput,
  type settlementReverseInput,
  t as strings,
  type TitleDetail,
  todayIso,
} from '@moneyflow/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { forbidden, notFound, unprocessable } from '../errors';
import { assertAccountActive, getAccount } from './caixas';
import { assertNotReconciled, clearStatementSuggestions, transferMovementIds } from './reconciliation-guards';
import { newIds } from './title-pair';
import { getTitle, lockTitlePair } from './titles';
import { withTx } from './tx';

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

async function accountInCaixa(ctx: ServiceContext, tx: Executor, accountId: string, caixaId: string) {
  const account = await getAccount(ctx, accountId, tx);
  if (account.caixaId !== caixaId) throw unprocessable(strings.errors.accountOtherCaixa);
  assertAccountActive(account);
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
  await withTx(ctx, (tx) => settleInTx(ctx, tx, titleId, input));
  return getTitle(ctx, titleId);
}

/**
 * A baixa dentro de uma transação já aberta (usada também pelo pagamento de
 * fatura e pela conciliação). Devolve o id da baixa e o do movimento gerado na
 * conta da baixa (se houver).
 */
export async function settleInTx(
  ctx: ServiceContext,
  tx: Tx,
  titleId: string,
  input: z.output<typeof settlementCreateInput>,
): Promise<{ settlementId: string; movementId: string | null }> {
  // O par numa ordem fixa: baixas simultâneas nos dois lados não se travam (tarefa 188).
  const { title, mirror } = await lockTitlePair(tx, titleId);
  ctx.access.assertWrite(title.caixaId);
  const cash = cashOf(input);

  const accountId = input.financialAccountId;
  if (accountId) await accountInCaixa(ctx, tx, accountId, title.caixaId);

  // Pagar o título da caixa B com uma conta da caixa A: transferência A → B (ou B → A ao receber).
  let transfer: { from: string; to: string } | null = null;
  if (input.sourceAccountId) {
    const source = await getAccount(ctx, input.sourceAccountId, tx);
    ctx.access.assertWrite(source.caixaId);
    assertAccountActive(source);
    if (source.caixaId === title.caixaId) throw unprocessable(strings.errors.sameCaixaSource);
    if (!accountId) throw unprocessable(strings.errors.accountRequiredForTransfer);
    if (cash <= 0) throw unprocessable(strings.errors.zeroCashTransfer);
    transfer = (title.direction as Direction) === 'payable' ? { from: source.id, to: accountId } : { from: accountId, to: source.id };
  }

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
    await insertSettlementMovement(tx, { id: mirrorLegId!, financialAccountId: mirrorAccountId, settledOn: input.settledOn }, mirror, cash);
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
  const [movement] = await tx
    .select({ id: movements.id })
    .from(movements)
    .where(and(eq(movements.settlementId, ownId!), eq(movements.kind, 'settlement')));
  return { settlementId: ownId!, movementId: movement?.id ?? null };
}

async function loadLeg(tx: Executor, id: string) {
  const [row] = await tx.select().from(settlements).where(eq(settlements.id, id)).for('update');
  if (!row) throw notFound();
  return row;
}

/** A perna pedida e a do espelho, travadas numa ordem fixa (pelo id), como os títulos do par (tarefa 188). */
async function loadLegPair(tx: Executor, id: string) {
  const [peek] = await tx.select({ mirrorId: settlements.mirrorSettlementId }).from(settlements).where(eq(settlements.id, id));
  if (!peek) throw notFound();
  const ids = [id, ...(peek.mirrorId ? [peek.mirrorId] : [])];
  const rows = await tx.select().from(settlements).where(inArray(settlements.id, ids)).orderBy(settlements.id).for('update');
  const leg = rows.find((r) => r.id === id);
  if (!leg) throw notFound();
  const other = leg.mirrorSettlementId
    ? (rows.find((r) => r.id === leg.mirrorSettlementId) ?? (await loadLeg(tx, leg.mirrorSettlementId)))
    : null;
  return [leg, ...(other ? [other] : [])];
}

/** Define a conta de uma baixa "conta a definir" (o lado sem acesso no espelho). */
export async function setSettlementAccount(
  ctx: ServiceContext,
  settlementId: string,
  input: z.output<typeof settlementAccountInput>,
): Promise<TitleDetail> {
  const titleId = await withTx(ctx, async (tx) => {
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
  const titleId = await withTx(ctx, async (tx) => {
    const legs = await loadLegPair(tx, settlementId);
    const leg = legs[0]!;
    const [title] = await tx.select().from(titles).where(eq(titles.id, leg.titleId));
    if (!title) throw notFound();
    ctx.access.assertWrite(title.caixaId);
    if (leg.reversedAt) throw unprocessable(strings.errors.settlementReversed);
    const reversedOn = input.reversedOn ?? todayIso();
    if (diffDays(leg.settledOn, reversedOn) < 0) throw unprocessable(strings.errors.reversalBeforeSettlement);

    for (const current of legs) {
      await tx.update(settlements).set({ reversedAt: sql`now()`, reversalReason: input.reason }).where(eq(settlements.id, current.id));
      const [owner] = await tx.select().from(titles).where(eq(titles.id, current.titleId));
      await insertSettlementMovement(tx, current, owner!, cashOf(current), reversedOn, true);
    }
    if (input.undoTransfer) {
      const doomed = await tx
        .select({ id: transfers.id, from: transfers.fromAccountId, to: transfers.toAccountId })
        .from(transfers)
        .where(
          inArray(
            transfers.settlementId,
            legs.map((l) => l.id),
          ),
        );
      // Como em deleteTransfer: apagar a transferência mexe nas duas contas, então pede escrita nas duas caixas (tarefa 081).
      const accountIds = [...new Set(doomed.flatMap((d) => [d.from, d.to]))];
      if (accountIds.length > 0) {
        const owners = await tx
          .select({ caixaId: financialAccounts.caixaId })
          .from(financialAccounts)
          .where(inArray(financialAccounts.id, accountIds));
        if (owners.some((o) => !ctx.access.canWrite(o.caixaId))) throw forbidden(strings.errors.undoTransferOtherCaixa);
      }
      const movementIds = await transferMovementIds(
        tx,
        doomed.map((d) => d.id),
      );
      // Movimento da transferência conciliado com o extrato não some; sugestões saem antes.
      await assertNotReconciled(tx, movementIds);
      await clearStatementSuggestions(tx, { movementIds });
      if (doomed.length > 0)
        await tx.delete(transfers).where(
          inArray(
            transfers.id,
            doomed.map((d) => d.id),
          ),
        );
    }
    return title.id;
  });
  return getTitle(ctx, titleId);
}

/* ---- data do estorno (tarefa 045) ---- */

type ReversalRow = {
  settlement_id: string;
  title_id: string;
  caixa_id: string;
  caixa_name: string;
  settled_on: string;
  reversed_at: Date | string | null;
  movement_id: string | null;
  financial_account_id: string | null;
  account_name: string | null;
  occurred_on: string | null;
  amount_cents: number | string | null;
  statement_line_id: string | null;
};

/** As pernas da baixa (a pedida primeiro) e o movimento de estorno de cada uma, por settlement_reversal_movements. */
async function reversalRows(db: Executor, settlementId: string) {
  const result = await db.execute<ReversalRow>(sql`
    SELECT x.settlement_id, x.title_id, x.caixa_id, c.name AS caixa_name, x.settled_on, x.reversed_at, x.movement_id,
           x.financial_account_id, a.name AS account_name, x.occurred_on, x.amount_cents, x.statement_line_id
      FROM settlement_reversal_movements(${settlementId}::uuid) x
      JOIN caixas c ON c.id = x.caixa_id
      LEFT JOIN financial_accounts a ON a.id = x.financial_account_id
     ORDER BY x.settlement_id = ${settlementId}::uuid DESC, x.settlement_id`);
  return result.rows;
}

function toReversalInfo(ctx: ServiceContext, rows: ReversalRow[]): SettlementReversalInfo {
  const first = rows[0]!;
  const legs = rows.map((r) => ({
    settlementId: r.settlement_id,
    titleId: r.title_id,
    caixaId: r.caixa_id,
    caixaName: r.caixa_name,
    financialAccountId: ctx.access.canRead(r.caixa_id) ? r.financial_account_id : null,
    accountName: ctx.access.canRead(r.caixa_id) ? r.account_name : null,
    movementId: r.movement_id,
    occurredOn: r.occurred_on,
    amountCents: r.amount_cents === null ? null : Number(r.amount_cents),
    reconciled: r.statement_line_id !== null,
    canWrite: ctx.access.canWrite(r.caixa_id),
  }));
  const moving = legs.filter((l) => l.movementId);
  return {
    settlementId: first.settlement_id,
    titleId: first.title_id,
    settledOn: first.settled_on,
    reversedAt: first.reversed_at ? new Date(first.reversed_at).toISOString() : null,
    legs,
    canChange:
      first.reversed_at !== null &&
      ctx.access.canWrite(first.caixa_id) &&
      moving.length > 0 &&
      moving.every((l) => l.canWrite && !l.reconciled),
  };
}

/** A baixa estornada com as pernas e os movimentos de estorno: a prévia da correção da data (tela e tool). */
export async function reversalInfo(ctx: ServiceContext, settlementId: string): Promise<SettlementReversalInfo> {
  const rows = await reversalRows(ctx.db, settlementId);
  if (rows.length === 0) throw notFound();
  ctx.access.assertRead(rows[0]!.caixa_id);
  return toReversalInfo(ctx, rows);
}

/**
 * Corrige a data do estorno (tarefa 045): o movimento de estorno de cada perna com conta, a do espelho inclusive,
 * passa para `reversedOn`, numa transação só (settlement_reversal_set_date, com a auditoria do ator). Escrita na
 * caixa da baixa pedida e nas caixas das pernas que mudam; o banco recusa a data antes da baixa, o mês fechado (na
 * data antiga ou na nova, em qualquer perna) e o estorno conciliado com uma linha do extrato.
 */
export async function setReversalDate(
  ctx: ServiceContext,
  settlementId: string,
  input: z.output<typeof settlementReversalDateInput>,
): Promise<TitleDetail> {
  const titleId = await withTx(ctx, async (tx) => {
    const rows = await reversalRows(tx, settlementId);
    const first = rows[0];
    if (!first) throw notFound();
    ctx.access.assertWrite(first.caixa_id);
    if (!first.reversed_at) throw unprocessable(strings.errors.settlementNotReversed, 'settlement_not_reversed');
    if (diffDays(first.settled_on, input.reversedOn) < 0) throw unprocessable(strings.errors.reversalBeforeSettlement);
    if (rows.some((r) => r.movement_id && !ctx.access.canWrite(r.caixa_id))) throw forbidden(strings.errors.reversalDateOtherCaixa);
    await tx.execute(sql`SELECT movement_id FROM settlement_reversal_set_date(${settlementId}::uuid, ${input.reversedOn}::date)`);
    return first.title_id;
  });
  return getTitle(ctx, titleId);
}
