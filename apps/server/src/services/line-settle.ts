import { type Executor, movements, type Tx, titles, transfers } from '@moneyflow/db';
import { type ContractTerms, type SettlementSplit, splitSettlement, t } from '@moneyflow/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { settleInTx } from './settlements';

/*
 * A baixa feita a partir de uma linha de extrato (specs 009 e 033): o valor da
 * linha vira a baixa repartida (principal, multa, juros, desconto) quando o
 * título é parcela de contrato; na conta da linha, ou — se o título é de outra
 * caixa e a conta da linha é a conta prevista dele — na conta de passagem do
 * título, com a transferência a partir da conta da linha.
 */

export type LineForSettle = {
  id: string;
  caixaId: string;
  financialAccountId: string | null;
  postedOn: string;
  amountCents: number;
};

type TitleForSplit = {
  id: string;
  contractId: string | null;
  dueDate: string;
  amountCents: number;
};

/** Encargos e janela do contrato da parcela, ou null (título fora de contrato). */
export async function contractTermsOf(db: Executor, contractId: string | null): Promise<ContractTerms | null> {
  if (!contractId) return null;
  const result = await db.execute<{
    late_fee_percent: string | null;
    interest_month_percent: string | null;
    early_discount_percent: string | null;
    tolerance_cents: string | number;
    match_window_days: number;
  }>(sql`
    SELECT late_fee_percent, interest_month_percent, early_discount_percent, tolerance_cents, match_window_days
      FROM contracts WHERE id = ${contractId}`);
  const row = result.rows[0];
  if (!row) return null;
  return termsOfRow(row);
}

export const termsOfRow = (row: {
  late_fee_percent: string | number | null;
  interest_month_percent: string | number | null;
  early_discount_percent: string | number | null;
  tolerance_cents: string | number;
  match_window_days: string | number;
}): ContractTerms => ({
  lateFeePercent: row.late_fee_percent === null ? null : Number(row.late_fee_percent),
  interestMonthPercent: row.interest_month_percent === null ? null : Number(row.interest_month_percent),
  earlyDiscountPercent: row.early_discount_percent === null ? null : Number(row.early_discount_percent),
  toleranceCents: Number(row.tolerance_cents),
  matchWindowDays: Number(row.match_window_days),
});

/**
 * Repartição do valor da linha sobre o título: a do contrato (spec 033) ou,
 * fora de contrato, o valor inteiro como principal. null = o valor passa do
 * saldo além do que os encargos e a tolerância explicam.
 */
export async function lineSplit(
  db: Executor,
  title: TitleForSplit,
  openCents: number,
  line: { postedOn: string; amountCents: number },
): Promise<SettlementSplit | null> {
  const paid = Math.abs(line.amountCents);
  const terms = await contractTermsOf(db, title.contractId);
  if (terms) return splitSettlement(paid, { dueDate: title.dueDate, amountCents: title.amountCents, openCents }, terms, line.postedOn);
  if (paid > openCents) return null;
  return {
    kind: paid === openCents ? 'exact' : 'partial',
    amountCents: paid,
    fineCents: 0,
    interestCents: 0,
    discountCents: 0,
    days: 0,
  };
}

async function openOf(db: Executor, titleId: string): Promise<number> {
  const result = await db.execute<{ open_cents: string | number }>(sql`SELECT open_cents FROM title_balances WHERE title_id = ${titleId}`);
  return Number(result.rows[0]?.open_cents ?? 0);
}

/**
 * Baixa o título com o valor da linha e devolve o movimento que fica
 * conciliado com ela (o da baixa na conta da linha, ou a perna da
 * transferência na conta da linha) e o created_entry correspondente.
 */
export async function settleFromLine(
  ctx: ServiceContext,
  tx: Tx,
  line: LineForSettle,
  titleId: string,
): Promise<{ movementId: string; createdEntry: 'settlement' | 'transfer_settlement'; split: SettlementSplit }> {
  if (!line.financialAccountId) throw unprocessable(t.errors.lineAccountOnly);
  const [title] = await tx.select().from(titles).where(eq(titles.id, titleId));
  if (!title) throw notFound();
  // Título de outra caixa só pela conta prevista dele (a caixa pagadora), com a conta de passagem.
  const viaTransit = title.caixaId !== line.caixaId;
  if (viaTransit && (title.plannedAccountId !== line.financialAccountId || !title.plannedTransitAccountId)) throw notFound();
  if ((title.direction === 'payable') !== line.amountCents < 0) throw unprocessable(t.errors.lineDirectionMismatch);
  const split = await lineSplit(tx, title, await openOf(tx, titleId), line);
  if (!split) throw unprocessable(t.errors.lineAmountMismatch);
  const { settlementId, movementId } = await settleInTx(ctx, tx, titleId, {
    settledOn: line.postedOn,
    amountCents: split.amountCents,
    interestCents: split.interestCents,
    fineCents: split.fineCents,
    discountCents: split.discountCents,
    financialAccountId: viaTransit ? title.plannedTransitAccountId : line.financialAccountId,
    sourceAccountId: viaTransit ? line.financialAccountId : null,
    mirrorAccountId: null,
    notes: null,
  });
  if (!viaTransit) {
    if (!movementId) throw unprocessable(t.errors.lineAmountMismatch);
    return { movementId, createdEntry: 'settlement', split };
  }
  const [leg] = await tx
    .select({ id: movements.id })
    .from(movements)
    .innerJoin(transfers, eq(transfers.id, movements.transferId))
    .where(and(eq(transfers.settlementId, settlementId), eq(movements.financialAccountId, line.financialAccountId)));
  if (!leg) throw unprocessable(t.errors.lineAmountMismatch);
  return { movementId: leg.id, createdEntry: 'transfer_settlement', split };
}
