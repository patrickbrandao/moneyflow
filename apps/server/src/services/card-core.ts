import { caixas, cardInvoiceItems, cardInvoices, cardPurchases, type Executor, type Tx, titles } from '@moneyflow/db';
import { addMonths, daysInMonth, formatMonth, type MirrorStatus, t, todayIso, toIso } from '@moneyflow/shared';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { notFound, unprocessable } from '../errors';
import { clearStatementSuggestions } from './reconciliation-guards';
import { insertTitlePair } from './title-pair';
import { defaultMirrorCategory } from './titles';

/*
 * Núcleo do cartão de crédito (spec 007), sem permissão (quem chama confere):
 * datas das faturas, criação das faturas, lançamento das compras em parcelas
 * e o fechamento/reabertura. Tudo roda numa transação aberta; as checagens
 * do banco (parcelas × compra, totais da fatura × títulos) são deferidas para
 * o COMMIT, então o conjunto inteiro é montado aqui antes dele (docs/016).
 */

export type Card = typeof caixas.$inferSelect & { closingDay: number; dueDay: number; defaultPayerCaixaId: string };
export type Invoice = typeof cardInvoices.$inferSelect;

/** Horizonte de faturas futuras que o worker mantém criadas. */
export const INVOICE_HORIZON_MONTHS = 3;

const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;

/**
 * Datas de uma fatura pela competência (1º dia do mês do vencimento): vence
 * no dia `dueDay` do mês; fecha no dia `closingDay` do mesmo mês se ele vem
 * antes do vencimento, senão no mês anterior. Meses curtos usam o último dia.
 */
export function invoiceDates(card: { closingDay: number; dueDay: number }, referenceMonth: string) {
  const [y, m] = referenceMonth.split('-').map(Number) as [number, number];
  const dueDate = toIso(y, m, Math.min(card.dueDay, daysInMonth(y, m)));
  const closingMonth = card.closingDay < card.dueDay ? referenceMonth : addMonths(referenceMonth, -1);
  const [cy, cm] = closingMonth.split('-').map(Number) as [number, number];
  const closingDate = toIso(cy, cm, Math.min(card.closingDay, daysInMonth(cy, cm)));
  return { closingDate, dueDate };
}

/** Competência da primeira fatura que fecha na data ou depois. */
export function invoiceMonthFor(card: { closingDay: number; dueDay: number }, date: string): string {
  let month = addMonths(monthOf(date), -1);
  for (let i = 0; i < 4; i += 1) {
    if (invoiceDates(card, month).closingDate >= date) return month;
    month = addMonths(month, 1);
  }
  return month;
}

export async function loadCard(tx: Executor, cardId: string, lock = false): Promise<Card> {
  const query = tx.select().from(caixas).where(eq(caixas.id, cardId));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound();
  if (row.kind !== 'credit_card') throw unprocessable(t.errors.notCard, 'not_card');
  return row as Card;
}

/** Cria (se faltarem) as faturas de `from` até `to`, inclusive. */
export async function ensureInvoices(tx: Executor, card: Card, from: string, to: string) {
  const values = [];
  for (let month = monthOf(from); month <= to; month = addMonths(month, 1)) {
    values.push({ cardCaixaId: card.id, referenceMonth: month, ...invoiceDates(card, month) });
    if (values.length > 240) break;
  }
  if (values.length > 0) await tx.insert(cardInvoices).values(values).onConflictDoNothing();
}

/** Faturas do horizonte: da que fecha hoje ou depois até INVOICE_HORIZON_MONTHS à frente. */
export async function ensureHorizon(tx: Executor, card: Card, today = todayIso()) {
  const current = invoiceMonthFor(card, today);
  await ensureInvoices(tx, card, current, addMonths(current, INVOICE_HORIZON_MONTHS));
}

async function invoiceByMonth(tx: Executor, cardId: string, month: string) {
  const [row] = await tx
    .select()
    .from(cardInvoices)
    .where(and(eq(cardInvoices.cardCaixaId, cardId), eq(cardInvoices.referenceMonth, month)));
  return row ?? null;
}

/**
 * Primeira fatura ABERTA que fecha na data ou depois (as anteriores podem já
 * estar fechadas: a compra lançada atrasada entra na próxima aberta).
 */
export async function openInvoiceFor(tx: Executor, card: Card, date: string): Promise<Invoice> {
  let month = invoiceMonthFor(card, date);
  for (let i = 0; i < 60; i += 1) {
    await ensureInvoices(tx, card, month, month);
    const invoice = await invoiceByMonth(tx, card.id, month);
    if (invoice && !invoice.closedAt && invoice.closingDate >= date) return invoice;
    month = addMonths(month, 1);
  }
  throw unprocessable(t.errors.noOpenInvoice, 'no_open_invoice');
}

/** Divide o total em `count` parcelas inteiras; o resto (centavos) vai na primeira. */
export function splitInstallments(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const parts = Array.from({ length: count }, () => base);
  parts[0]! += totalCents - base * count;
  return parts;
}

export type PurchaseFields = {
  kind: 'purchase' | 'refund' | 'charge';
  chargeKind?: string | null;
  payerCaixaId: string;
  entityId: string;
  categoryId: string;
  purchasedOn: string;
  description: string;
  amountCents: number;
  installmentsTotal: number;
  firstInstallment: number;
  refundedPurchaseId?: string | null;
  notes?: string | null;
};

/** Insere o lançamento e as parcelas (itens) nas faturas consecutivas a partir da primeira aberta. */
export async function insertPurchase(tx: Tx, card: Card, fields: PurchaseFields): Promise<{ id: string; itemIds: string[] }> {
  const [payer] = await tx.select({ kind: caixas.kind }).from(caixas).where(eq(caixas.id, fields.payerCaixaId));
  if (!payer) throw notFound();
  if (payer.kind !== 'general') throw unprocessable(t.errors.cardPayerNotGeneral, 'payer_not_general');

  const first = await openInvoiceFor(tx, card, fields.purchasedOn);
  const count = fields.installmentsTotal - fields.firstInstallment + 1;
  const lastMonth = addMonths(first.referenceMonth, count - 1);
  await ensureInvoices(tx, card, first.referenceMonth, lastMonth);
  const invoices = await tx
    .select()
    .from(cardInvoices)
    .where(and(eq(cardInvoices.cardCaixaId, card.id), gte(cardInvoices.referenceMonth, first.referenceMonth)))
    .orderBy(asc(cardInvoices.referenceMonth))
    .limit(count);
  if (invoices.some((inv) => inv.closedAt)) throw unprocessable(t.errors.noOpenInvoice, 'no_open_invoice');

  const [row] = await tx
    .insert(cardPurchases)
    .values({
      cardCaixaId: card.id,
      kind: fields.kind,
      chargeKind: fields.chargeKind ?? null,
      payerCaixaId: fields.payerCaixaId,
      entityId: fields.entityId,
      categoryId: fields.categoryId,
      purchasedOn: fields.purchasedOn,
      description: fields.description,
      amountCents: fields.amountCents,
      installmentsTotal: fields.installmentsTotal,
      firstInstallment: fields.firstInstallment,
      refundedPurchaseId: fields.refundedPurchaseId ?? null,
      notes: fields.notes ?? null,
    })
    .returning({ id: cardPurchases.id });
  const sign = fields.kind === 'refund' ? -1 : 1;
  const parts = splitInstallments(fields.amountCents, count);
  const items = await tx
    .insert(cardInvoiceItems)
    .values(
      parts.map((amount, i) => ({
        cardInvoiceId: invoices[i]!.id,
        kind: 'installment',
        cardPurchaseId: row!.id,
        installmentNumber: fields.firstInstallment + i,
        payerCaixaId: fields.payerCaixaId,
        amountCents: sign * amount,
      })),
    )
    .returning({ id: cardInvoiceItems.id });
  return { id: row!.id, itemIds: items.map((i) => i.id) };
}

/** A pagadora e o emissor das faturas (titulares das caixas). */
async function holderOf(tx: Executor, caixaId: string) {
  const [row] = await tx.select({ holder: caixas.holderEntityId, name: caixas.name }).from(caixas).where(eq(caixas.id, caixaId));
  if (!row) throw notFound();
  return row;
}

export const invoiceTitleDescription = (cardName: string, referenceMonth: string) => `Fatura ${cardName} ${formatMonth(referenceMonth)}`;

/** Cria o par de títulos da fatura: "a receber" no cartão e "a pagar" (espelho) na pagadora. */
export async function insertInvoiceTitlePair(
  tx: Tx,
  card: Card,
  invoice: Invoice,
  payerCaixaId: string,
  amountCents: number,
  opts: { mirrorStatus: MirrorStatus; payerCategoryId?: string | null; cardCategoryId?: string | null; dueDate?: string },
) {
  const payer = await holderOf(tx, payerCaixaId);
  const description = invoiceTitleDescription(card.name, invoice.referenceMonth);
  return insertTitlePair(
    tx,
    {
      caixaId: card.id,
      direction: 'receivable',
      entityId: payer.holder,
      categoryId: opts.cardCategoryId ?? (await defaultMirrorCategory(tx, card.id, 'receivable')),
      description,
      competenceDate: invoice.referenceMonth,
      dueDate: opts.dueDate ?? invoice.dueDate,
      amountCents,
      notes: null,
      origin: 'card_invoice',
      recurrenceRuleId: null,
      occurrence: null,
      cardInvoiceId: invoice.id,
    },
    {
      caixaId: payerCaixaId,
      entityId: card.holderEntityId,
      categoryId: opts.payerCategoryId ?? (await defaultMirrorCategory(tx, payerCaixaId, 'payable')),
      description,
      status: opts.mirrorStatus,
    },
  );
}

type PayerTotal = { payer_caixa_id: string; items_cents: number; billed_cents: number };

/**
 * Fecha a fatura: closed_at = now() e, por pagadora, o par de títulos pelo
 * valor dos itens − o já faturado (antecipações). Saldo negativo (crédito)
 * rola como item carryover negativo para a fatura seguinte.
 */
export async function closeInvoiceTx(
  tx: Tx,
  invoiceId: string,
  opts: {
    mirrorStatusFor: (payerCaixaId: string) => MirrorStatus;
    payerCategoryIds?: Record<string, string>;
    cardCategoryId?: string | null;
  },
) {
  const [invoice] = await tx.select().from(cardInvoices).where(eq(cardInvoices.id, invoiceId)).for('update');
  if (!invoice) throw notFound();
  if (invoice.closedAt) throw unprocessable(t.errors.invoiceClosed, 'invoice_closed');
  const card = await loadCard(tx, invoice.cardCaixaId);
  const totals = await tx.execute<PayerTotal>(sql`
    SELECT payer_caixa_id, items_cents, billed_cents FROM card_invoice_payer_totals WHERE card_invoice_id = ${invoiceId}`);

  await tx.update(cardInvoices).set({ closedAt: sql`now()` }).where(eq(cardInvoices.id, invoiceId));
  const nextMonth = addMonths(invoice.referenceMonth, 1);
  let next: Invoice | null = null;

  for (const row of totals.rows) {
    const amount = Number(row.items_cents) - Number(row.billed_cents);
    if (amount > 0) {
      await insertInvoiceTitlePair(tx, card, invoice, row.payer_caixa_id, amount, {
        mirrorStatus: opts.mirrorStatusFor(row.payer_caixa_id),
        payerCategoryId: opts.payerCategoryIds?.[row.payer_caixa_id],
        cardCategoryId: opts.cardCategoryId,
      });
    } else if (amount < 0) {
      // Crédito (estornos/antecipações acima do total): rola para a próxima fatura.
      if (!next) {
        await ensureInvoices(tx, card, nextMonth, nextMonth);
        next = await invoiceByMonth(tx, card.id, nextMonth);
      }
      if (!next || next.closedAt) throw unprocessable(t.errors.noOpenInvoice, 'no_open_invoice');
      await tx.insert(cardInvoiceItems).values({
        cardInvoiceId: next.id,
        kind: 'carryover',
        carriedFromInvoiceId: invoice.id,
        payerCaixaId: row.payer_caixa_id,
        amountCents: amount,
        description: `Crédito da fatura ${formatMonth(invoice.referenceMonth)}`,
      });
    }
  }
  return invoice;
}

/**
 * Reabre a fatura (sem pagamento ativo): apaga o saldo rolado que ela gerou
 * (se a seguinte ainda está aberta) e exclui os títulos não pagos — ou os
 * cancela, se já tiveram baixa estornada.
 */
export async function reopenInvoiceTx(tx: Tx, invoiceId: string) {
  const [invoice] = await tx.select().from(cardInvoices).where(eq(cardInvoices.id, invoiceId)).for('update');
  if (!invoice) throw notFound();
  if (!invoice.closedAt) return invoice;
  const paid = await tx.execute(sql`
    SELECT 1 FROM titles t JOIN settlements s ON s.title_id = t.id
     WHERE t.card_invoice_id = ${invoiceId} AND s.reversed_at IS NULL LIMIT 1`);
  if (paid.rows.length > 0) throw unprocessable(t.errors.invoiceHasPayments, 'invoice_has_payments');

  const carried = await tx.execute<{ id: string; closed: boolean }>(sql`
    SELECT i.id, (v.closed_at IS NOT NULL) AS closed
      FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
     WHERE i.carried_from_invoice_id = ${invoiceId}`);
  if (carried.rows.some((r) => r.closed)) throw unprocessable(t.errors.invoiceCarriedClosed, 'invoice_carried_closed');
  if (carried.rows.length > 0) {
    await tx.delete(cardInvoiceItems).where(
      inArray(
        cardInvoiceItems.id,
        carried.rows.map((r) => r.id),
      ),
    );
  }

  const invoiceTitles = await tx.select({ id: titles.id, status: titles.status }).from(titles).where(eq(titles.cardInvoiceId, invoiceId));
  const ids = invoiceTitles.map((r) => r.id);
  if (ids.length > 0) {
    await clearStatementSuggestions(tx, { titleIds: ids });
    const everSettled = await tx.execute<{ id: string }>(sql`
      SELECT DISTINCT t.id FROM titles t JOIN settlements s ON s.title_id = t.id WHERE t.card_invoice_id = ${invoiceId}`);
    const keep = new Set(everSettled.rows.map((r) => r.id));
    // Um par é cancelado ou excluído junto (as pernas e o espelho andam juntos).
    const cancel = ids.filter((id) => keep.has(id));
    const remove = ids.filter((id) => !keep.has(id));
    if (cancel.length > 0) await tx.update(titles).set({ status: 'canceled' }).where(inArray(titles.id, cancel));
    if (remove.length > 0) await tx.delete(titles).where(inArray(titles.id, remove));
  }
  await tx.update(cardInvoices).set({ closedAt: null }).where(eq(cardInvoices.id, invoiceId));
  return invoice;
}

/** Faturas abertas com a data de fechamento já passada (o worker fecha ou sugere). */
export async function overdueOpenInvoices(tx: Executor, today = todayIso()) {
  return tx
    .select({ id: cardInvoices.id, cardCaixaId: cardInvoices.cardCaixaId, referenceMonth: cardInvoices.referenceMonth })
    .from(cardInvoices)
    .innerJoin(caixas, eq(caixas.id, cardInvoices.cardCaixaId))
    .where(and(isNull(cardInvoices.closedAt), sql`${cardInvoices.closingDate} < ${today}::date`, isNull(caixas.archivedAt)))
    .orderBy(asc(cardInvoices.referenceMonth));
}
