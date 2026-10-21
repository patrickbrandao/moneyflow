import { type Executor, type Tx, titles } from '@moneyflow/db';
import { type RecognitionTerms, type SettlementSplit, splitSettlement, t } from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { TERMS_SQL, termsOf } from './series-core';
import { settleInTx } from './settlements';

/*
 * A baixa feita a partir de uma linha de extrato (specs 009, 033 e 034): o
 * valor da linha vira a baixa repartida (principal, multa, juros, desconto)
 * pelos ajustes da série quando o título é ocorrência de série recorrente; na
 * conta da linha, sempre num título da caixa dela (sem transferência: a
 * obrigação mora onde o dinheiro se move).
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
  recurrenceRuleId: string | null;
  dueDate: string;
  amountCents: number;
};

/** Ajustes de reconhecimento da série do título, ou null (título avulso). */
export async function seriesTermsOf(db: Executor, ruleId: string | null): Promise<RecognitionTerms | null> {
  if (!ruleId) return null;
  const result = await db.execute(sql`SELECT ${TERMS_SQL} FROM recurrence_rules r WHERE r.id = ${ruleId}`);
  const row = result.rows[0];
  return row ? termsOf(row as Parameters<typeof termsOf>[0]) : null;
}

/**
 * Repartição do valor da linha sobre o título: a da série (specs 033 e 034)
 * ou, no avulso, o valor inteiro como principal. null = o valor passa do
 * saldo além do que os encargos e a tolerância explicam.
 */
export async function lineSplit(
  db: Executor,
  title: TitleForSplit,
  openCents: number,
  line: { postedOn: string; amountCents: number },
): Promise<SettlementSplit | null> {
  const paid = Math.abs(line.amountCents);
  const terms = await seriesTermsOf(db, title.recurrenceRuleId);
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

/** Baixa o título com o valor da linha (na conta dela) e devolve o movimento que fica conciliado com a linha. */
export async function settleFromLine(
  ctx: ServiceContext,
  tx: Tx,
  line: LineForSettle,
  titleId: string,
): Promise<{ movementId: string; createdEntry: 'settlement'; split: SettlementSplit }> {
  if (!line.financialAccountId) throw unprocessable(t.errors.lineAccountOnly);
  const [title] = await tx.select().from(titles).where(eq(titles.id, titleId));
  if (!title || title.caixaId !== line.caixaId) throw notFound();
  if ((title.direction === 'payable') !== line.amountCents < 0) throw unprocessable(t.errors.lineDirectionMismatch);
  const split = await lineSplit(tx, title, await openOf(tx, titleId), line);
  if (!split) throw unprocessable(t.errors.lineAmountMismatch);
  const { movementId } = await settleInTx(ctx, tx, titleId, {
    settledOn: line.postedOn,
    amountCents: split.amountCents,
    interestCents: split.interestCents,
    fineCents: split.fineCents,
    discountCents: split.discountCents,
    financialAccountId: line.financialAccountId,
    sourceAccountId: null,
    mirrorAccountId: null,
    notes: null,
  });
  if (!movementId) throw unprocessable(t.errors.lineAmountMismatch);
  return { movementId, createdEntry: 'settlement', split };
}
