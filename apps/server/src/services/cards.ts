import { cardInvoices, cardPurchases, categories, titles } from '@moneyflow/db';
import {
  type CardOverview,
  type CardPurchaseDetail,
  type CardPurchaseRow,
  type cardChargeInput,
  type cardPurchaseInput,
  type cardPurchaseListQuery,
  type cardPurchaseUpdateInput,
  type cardRefundInput,
  type InvoiceDetail,
  type InvoiceLine,
  type InvoicePayerTotal,
  type InvoiceSummary,
  type invoiceAdvanceInput,
  type invoiceCloseInput,
  type invoicePaymentInput,
  type invoiceUpdateInput,
  type TitleRow,
  t,
  todayIso,
} from '@moneyflow/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { cardSettings } from './caixas';
import {
  closeInvoiceTx,
  ensureHorizon,
  ensureInvoices,
  insertInvoiceTitlePair,
  insertPurchase,
  loadCard,
  reopenInvoiceTx,
} from './card-core';
import { settleInTx } from './settlements';
import { listTitles } from './titles';
import { withTx } from './tx';
import { camel, iso } from './util';

/* Cartão de crédito (spec 007): visão do cartão, faturas, compras, fechamento e pagamentos. */

const summarySql = sql`
  s.card_invoice_id AS id, s.card_caixa_id, s.reference_month, s.closing_date, s.due_date, s.closed_at,
  s.total_cents, s.billed_cents, s.settled_cents, s.open_cents, s.carried_out_cents, s.status`;

function toSummary(row: Record<string, unknown>, today = todayIso()): InvoiceSummary {
  const r = camel<InvoiceSummary>(row);
  return { ...r, closedAt: iso(r.closedAt), closeSuggested: !r.closedAt && r.closingDate < today };
}

async function loadInvoice(ctx: ServiceContext, id: string) {
  const [invoice] = await ctx.db.select().from(cardInvoices).where(eq(cardInvoices.id, id));
  if (!invoice) throw notFound();
  return invoice;
}

/* ---------------- leitura ---------------- */

export async function cardOverview(ctx: ServiceContext, cardId: string): Promise<CardOverview> {
  ctx.access.assertRead(cardId);
  const card = await loadCard(ctx.db, cardId);
  const settings = (await cardSettings(ctx.db, cardId))!;
  const [limits, invoices, committed, issuer] = await Promise.all([
    ctx.db.execute<{ used_cents: number; available_cents: number }>(
      sql`SELECT used_cents, available_cents FROM card_limits WHERE card_caixa_id = ${cardId}`,
    ),
    ctx.db.execute(
      sql`SELECT ${summarySql} FROM card_invoice_summaries s WHERE s.card_caixa_id = ${cardId} ORDER BY s.reference_month DESC`,
    ),
    ctx.db.execute<{ reference_month: string; amount_cents: number }>(sql`
      SELECT v.reference_month, sum(i.amount_cents)::bigint AS amount_cents
        FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
       WHERE v.card_caixa_id = ${cardId} AND v.closed_at IS NULL
       GROUP BY v.reference_month ORDER BY v.reference_month`),
    ctx.db.execute<{ name: string }>(sql`SELECT name FROM entities WHERE id = ${card.holderEntityId}`),
  ]);
  const summaries = invoices.rows.map((row) => toSummary(row));
  const open = [...summaries].reverse().find((s) => s.status === 'open') ?? null;
  return {
    caixaId: card.id,
    name: card.name,
    settings,
    issuerEntityId: card.holderEntityId,
    issuerName: issuer.rows[0]?.name ?? '',
    creditLimitCents: settings.creditLimitCents,
    usedCents: Number(limits.rows[0]?.used_cents ?? 0),
    availableCents: Number(limits.rows[0]?.available_cents ?? settings.creditLimitCents),
    canWrite: ctx.access.canWrite(cardId),
    openInvoice: open,
    invoices: summaries,
    committed: committed.rows.map((r) => ({ referenceMonth: r.reference_month, amountCents: Number(r.amount_cents) })),
  };
}

/**
 * Detalhe da fatura. Quem lê o cartão vê tudo; quem só lê uma pagadora (pela
 * fatura-título na caixa dela) vê só as compras dessa pagadora.
 */
export async function getInvoice(ctx: ServiceContext, id: string, payerFilter?: string): Promise<InvoiceDetail> {
  const invoice = await loadInvoice(ctx, id);
  let payerCaixaId: string | null = payerFilter ?? null;
  if (!ctx.access.canRead(invoice.cardCaixaId)) {
    if (!payerCaixaId || !ctx.access.canRead(payerCaixaId)) throw notFound();
  }
  if (payerCaixaId && !ctx.access.canRead(payerCaixaId) && !ctx.access.canRead(invoice.cardCaixaId)) throw notFound();
  if (!payerCaixaId && !ctx.access.canRead(invoice.cardCaixaId)) payerCaixaId = null;

  const [summary, card, payers, lines] = await Promise.all([
    ctx.db.execute(sql`SELECT ${summarySql} FROM card_invoice_summaries s WHERE s.card_invoice_id = ${id}`),
    ctx.db.execute<{ name: string; issuer: string }>(
      sql`SELECT c.name, e.name AS issuer FROM caixas c JOIN entities e ON e.id = c.holder_entity_id WHERE c.id = ${invoice.cardCaixaId}`,
    ),
    ctx.db.execute(sql`
      SELECT x.payer_caixa_id, p.name AS payer_caixa_name, x.items_cents, x.billed_cents, x.settled_cents, x.open_cents,
             x.carried_out_cents,
             (SELECT t.id FROM titles t
               WHERE t.card_invoice_id = x.card_invoice_id AND t.caixa_id = x.payer_caixa_id AND t.status <> 'canceled'
               ORDER BY (t.status = 'paid'), t.created_at DESC LIMIT 1) AS payer_title_id
        FROM card_invoice_payer_totals x JOIN caixas p ON p.id = x.payer_caixa_id
       WHERE x.card_invoice_id = ${id} ${payerCaixaId ? sql`AND x.payer_caixa_id = ${payerCaixaId}` : sql``}
       ORDER BY p.name`),
    ctx.db.execute(sql`
      SELECT l.card_invoice_item_id AS item_id, l.item_kind, l.payer_caixa_id, p.name AS payer_caixa_name, l.amount_cents,
             l.installment_number, l.installments_total, l.card_purchase_id AS purchase_id, l.purchase_kind, l.charge_kind,
             l.refunded_purchase_id, l.entity_id, e.name AS entity_name, l.category_id, cat.name AS category_name,
             coalesce(cat.color_slot, pc.color_slot) AS category_color_slot, l.purchased_on,
             coalesce(l.description, '') AS description, l.carried_from_invoice_id, cv.reference_month AS carried_from_month,
             EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.card_invoice_item_id = l.card_invoice_item_id AND sl.status = 'matched') AS reconciled
        FROM card_invoice_lines l
        JOIN caixas p ON p.id = l.payer_caixa_id
        LEFT JOIN entities e ON e.id = l.entity_id
        LEFT JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN categories pc ON pc.id = cat.parent_id
        LEFT JOIN card_invoices cv ON cv.id = l.carried_from_invoice_id
       WHERE l.card_invoice_id = ${id} ${payerCaixaId ? sql`AND l.payer_caixa_id = ${payerCaixaId}` : sql``}
       ORDER BY l.purchased_on NULLS FIRST, l.card_invoice_item_id`),
  ]);
  const row = summary.rows[0];
  if (!row) throw notFound();

  let invoiceTitles: TitleRow[] = [];
  const titleIds = await ctx.db.select({ id: titles.id, caixaId: titles.caixaId }).from(titles).where(eq(titles.cardInvoiceId, id));
  const readable = titleIds.filter((r) => ctx.access.canRead(r.caixaId) && (!payerCaixaId || r.caixaId === payerCaixaId));
  if (readable.length > 0) {
    const all = await Promise.all(
      [...new Set(readable.map((r) => r.caixaId))].map((caixaId) => listTitles(ctx, { caixaId, archived: false, limit: 1000 })),
    );
    const wanted = new Set(readable.map((r) => r.id));
    invoiceTitles = all.flat().filter((tr) => wanted.has(tr.id));
  }

  return {
    ...toSummary(row),
    cardName: card.rows[0]?.name ?? '',
    issuerName: card.rows[0]?.issuer ?? '',
    canWrite: ctx.access.canWrite(invoice.cardCaixaId),
    payerCaixaId,
    payers: payers.rows.map((p) => {
      const r = camel<InvoicePayerTotal>(p);
      return { ...r, canReadPayer: ctx.access.canRead(r.payerCaixaId), canWritePayer: ctx.access.canWrite(r.payerCaixaId) };
    }),
    lines: lines.rows.map((l) => camel<InvoiceLine>(l)),
    titles: invoiceTitles,
  };
}

const purchaseSql = sql`
  SELECT p.id, p.card_caixa_id, p.kind, p.charge_kind, p.payer_caixa_id, pc.name AS payer_caixa_name, p.entity_id,
         e.name AS entity_name, p.category_id, cat.name AS category_name, coalesce(cat.color_slot, gc.color_slot) AS category_color_slot,
         p.purchased_on, p.description, p.amount_cents, p.installments_total, p.first_installment, p.refunded_purchase_id,
         coalesce((SELECT sum(r.amount_cents) FROM card_purchases r WHERE r.refunded_purchase_id = p.id), 0)::bigint AS refunded_cents,
         p.notes,
         (SELECT count(*)::int FROM card_purchase_attachments a WHERE a.card_purchase_id = p.id) AS attachment_count,
         NOT EXISTS (SELECT 1 FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
                      WHERE i.card_purchase_id = p.id AND v.closed_at IS NOT NULL) AS editable
    FROM card_purchases p
    JOIN caixas pc ON pc.id = p.payer_caixa_id
    JOIN entities e ON e.id = p.entity_id
    JOIN categories cat ON cat.id = p.category_id
    LEFT JOIN categories gc ON gc.id = cat.parent_id`;

export async function listPurchases(
  ctx: ServiceContext,
  cardId: string,
  query: z.output<typeof cardPurchaseListQuery>,
): Promise<CardPurchaseRow[]> {
  ctx.access.assertRead(cardId);
  const where = [sql`p.card_caixa_id = ${cardId}`];
  if (query.from) where.push(sql`p.purchased_on >= ${query.from}::date`);
  if (query.to) where.push(sql`p.purchased_on <= ${query.to}::date`);
  if (query.payerCaixaId) where.push(sql`p.payer_caixa_id = ${query.payerCaixaId}`);
  if (query.kind) where.push(sql`p.kind = ${query.kind}`);
  if (query.q) where.push(sql`(p.description ILIKE ${`%${query.q}%`} OR e.name ILIKE ${`%${query.q}%`})`);
  const result = await ctx.db.execute(
    sql`${purchaseSql} WHERE ${sql.join(where, sql` AND `)} ORDER BY p.purchased_on DESC, p.created_at DESC LIMIT ${query.limit}`,
  );
  return result.rows.map((r) => camel<CardPurchaseRow>(r));
}

export async function getPurchase(ctx: ServiceContext, id: string): Promise<CardPurchaseDetail> {
  const result = await ctx.db.execute(sql`${purchaseSql} WHERE p.id = ${id}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  const row = camel<CardPurchaseRow>(raw);
  // Quem lê a pagadora vê as compras dela (navegação a partir da fatura-título).
  if (!ctx.access.canRead(row.payerCaixaId)) ctx.access.assertRead(row.cardCaixaId);
  const [items, refunds] = await Promise.all([
    ctx.db.execute(sql`
      SELECT i.id, i.card_invoice_id AS invoice_id, v.reference_month, i.installment_number, i.amount_cents,
             (v.closed_at IS NOT NULL) AS invoice_closed
        FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id
       WHERE i.card_purchase_id = ${id} ORDER BY i.installment_number`),
    ctx.db.execute(sql`${purchaseSql} WHERE p.refunded_purchase_id = ${id} ORDER BY p.purchased_on`),
  ]);
  return {
    ...row,
    items: items.rows.map((r) => camel<CardPurchaseDetail['items'][number]>(r)),
    refunds: refunds.rows.map((r) => camel<CardPurchaseRow>(r)),
    canWrite: ctx.access.canWrite(row.cardCaixaId),
  };
}

/* ---------------- compras, estornos e encargos ---------------- */

export async function createPurchase(
  ctx: ServiceContext,
  cardId: string,
  input: z.output<typeof cardPurchaseInput>,
): Promise<CardPurchaseDetail> {
  ctx.access.assertWrite(cardId);
  const id = await withTx(ctx, async (tx) => {
    const card = await loadCard(tx, cardId, true);
    const payerCaixaId = input.payerCaixaId ?? card.defaultPayerCaixaId;
    ctx.access.assertRead(payerCaixaId);
    const created = await insertPurchase(tx, card, {
      kind: 'purchase',
      payerCaixaId,
      entityId: input.entityId,
      categoryId: input.categoryId,
      purchasedOn: input.purchasedOn,
      description: input.description,
      amountCents: input.amountCents,
      installmentsTotal: input.installmentsTotal,
      firstInstallment: input.firstInstallment,
      notes: input.notes,
    });
    return created.id;
  });
  return getPurchase(ctx, id);
}

/** Estorno: crédito ligado à compra (mesmo recebedor, categoria e pagadora), na fatura aberta da data. */
export async function refundPurchase(ctx: ServiceContext, purchaseId: string, input: z.output<typeof cardRefundInput>) {
  const original = await getPurchase(ctx, purchaseId);
  ctx.access.assertWrite(original.cardCaixaId);
  if (original.kind === 'refund') throw unprocessable(t.errors.refundOfRefund);
  if (input.amountCents > original.amountCents - original.refundedCents) throw unprocessable(t.errors.refundTooHigh);
  const id = await withTx(ctx, async (tx) => {
    const card = await loadCard(tx, original.cardCaixaId, true);
    const created = await insertPurchase(tx, card, {
      kind: 'refund',
      payerCaixaId: original.payerCaixaId,
      entityId: original.entityId,
      categoryId: original.categoryId,
      purchasedOn: input.refundedOn,
      description: input.description ?? `Estorno: ${original.description}`,
      amountCents: input.amountCents,
      installmentsTotal: 1,
      firstInstallment: 1,
      refundedPurchaseId: original.id,
    });
    return created.id;
  });
  return getPurchase(ctx, id);
}

/** Encargo do emissor (juros, IOF, multa, tarifa): recebedor = emissor (titular do cartão). */
export async function createCharge(ctx: ServiceContext, cardId: string, input: z.output<typeof cardChargeInput>) {
  ctx.access.assertWrite(cardId);
  const id = await withTx(ctx, async (tx) => {
    const card = await loadCard(tx, cardId, true);
    const created = await insertPurchase(tx, card, {
      kind: 'charge',
      chargeKind: input.chargeKind,
      payerCaixaId: input.payerCaixaId ?? card.defaultPayerCaixaId,
      entityId: card.holderEntityId,
      categoryId: input.categoryId,
      purchasedOn: input.chargedOn,
      description: input.description ?? t.card.chargeKinds[input.chargeKind] ?? input.chargeKind,
      amountCents: input.amountCents,
      installmentsTotal: 1,
      firstInstallment: 1,
    });
    return created.id;
  });
  return getPurchase(ctx, id);
}

export async function updatePurchase(ctx: ServiceContext, id: string, input: z.output<typeof cardPurchaseUpdateInput>) {
  const current = await getPurchase(ctx, id);
  ctx.access.assertWrite(current.cardCaixaId);
  const structural = input.categoryId !== undefined || input.entityId !== undefined || input.payerCaixaId !== undefined;
  if (structural && !current.editable) throw unprocessable(t.errors.purchaseClosedInvoice);
  if (structural && (current.refunds.length > 0 || current.kind === 'refund')) throw unprocessable(t.errors.purchaseHasRefunds);
  if (input.payerCaixaId) ctx.access.assertRead(input.payerCaixaId);
  await withTx(ctx, async (tx) => {
    const patch: Partial<typeof cardPurchases.$inferInsert> = {};
    if (input.description !== undefined) patch.description = input.description;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.entityId !== undefined && current.kind === 'purchase') patch.entityId = input.entityId;
    if (input.payerCaixaId !== undefined) patch.payerCaixaId = input.payerCaixaId;
    if (Object.keys(patch).length > 0) await tx.update(cardPurchases).set(patch).where(eq(cardPurchases.id, id));
    if (input.payerCaixaId !== undefined) {
      await tx.execute(sql`UPDATE card_invoice_items SET payer_caixa_id = ${input.payerCaixaId} WHERE card_purchase_id = ${id}`);
    }
  });
  return getPurchase(ctx, id);
}

/** Exclui o lançamento (as parcelas vão junto) enquanto todas as faturas dele estão abertas. */
export async function deletePurchase(ctx: ServiceContext, id: string) {
  const current = await getPurchase(ctx, id);
  ctx.access.assertWrite(current.cardCaixaId);
  if (!current.editable) throw unprocessable(t.errors.purchaseClosedInvoice);
  if (current.refunds.length > 0) throw unprocessable(t.errors.purchaseHasRefunds);
  await withTx(ctx, async (tx) => {
    await tx.execute(sql`
      UPDATE statement_lines SET status = 'new', card_invoice_item_id = NULL
       WHERE status = 'suggested' AND card_invoice_item_id IN (SELECT id FROM card_invoice_items WHERE card_purchase_id = ${id})`);
    await tx.delete(cardPurchases).where(eq(cardPurchases.id, id));
  });
  return { deleted: true, archived: false };
}

/* ---------------- faturas ---------------- */

export async function updateInvoice(ctx: ServiceContext, id: string, input: z.output<typeof invoiceUpdateInput>) {
  const invoice = await loadInvoice(ctx, id);
  ctx.access.assertWrite(invoice.cardCaixaId);
  await withTx(ctx, async (tx) => {
    const patch: Partial<typeof cardInvoices.$inferInsert> = {};
    if (input.closingDate !== undefined) patch.closingDate = input.closingDate;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (Object.keys(patch).length > 0) await tx.update(cardInvoices).set(patch).where(eq(cardInvoices.id, id));
  });
  return getInvoice(ctx, id);
}

export async function closeInvoice(ctx: ServiceContext, id: string, input: z.output<typeof invoiceCloseInput>) {
  const invoice = await loadInvoice(ctx, id);
  ctx.access.assertWrite(invoice.cardCaixaId);
  await withTx(ctx, (tx) =>
    closeInvoiceTx(tx, id, {
      // Sem permissão na pagadora, o título dela nasce aguardando aceite (spec 006).
      mirrorStatusFor: (payer) => (ctx.access.canWrite(payer) ? 'accepted' : 'pending'),
      payerCategoryIds: input.payerCategoryIds,
      cardCategoryId: input.cardCategoryId,
    }),
  );
  return getInvoice(ctx, id);
}

export async function reopenInvoice(ctx: ServiceContext, id: string) {
  const invoice = await loadInvoice(ctx, id);
  ctx.access.assertWrite(invoice.cardCaixaId);
  await withTx(ctx, (tx) => reopenInvoiceTx(tx, id));
  return getInvoice(ctx, id);
}

/**
 * Pagamento de fatura fechada pela pagadora. Valor = saldo aberto: baixa
 * normal. Menor: baixa o que foi pago, reduz o par de títulos a esse valor
 * (ou cancela, se nada foi pago), rola o restante para a próxima fatura e
 * lança os encargos do emissor (juros, IOF, multa) nela.
 */
export async function payInvoice(ctx: ServiceContext, id: string, input: z.output<typeof invoicePaymentInput>) {
  const invoice = await loadInvoice(ctx, id);
  ctx.access.assertWrite(input.payerCaixaId);
  if (!invoice.closedAt) throw unprocessable(t.errors.invoiceNotClosed, 'invoice_open');
  await withTx(ctx, async (tx) => {
    const [title] = await tx
      .select()
      .from(titles)
      .where(and(eq(titles.cardInvoiceId, id), eq(titles.caixaId, input.payerCaixaId), inArray(titles.status, ['open', 'partial'])))
      .for('update');
    if (!title) throw unprocessable(t.errors.invoiceNoOpenBalance, 'invoice_no_open_balance');
    const balance = await tx.execute<{ settled_cents: number; open_cents: number }>(
      sql`SELECT settled_cents, open_cents FROM title_balances WHERE title_id = ${title.id}`,
    );
    const settled = Number(balance.rows[0]!.settled_cents);
    const open = Number(balance.rows[0]!.open_cents);
    if (input.amountCents > open) throw unprocessable(t.errors.invoicePaymentTooHigh, 'invoice_payment_too_high');
    const card = await loadCard(tx, invoice.cardCaixaId, true);

    if (input.amountCents > 0) {
      await settleInTx(ctx, tx, title.id, {
        settledOn: input.settledOn,
        amountCents: input.amountCents,
        interestCents: 0,
        fineCents: 0,
        discountCents: 0,
        financialAccountId: input.financialAccountId,
        sourceAccountId: input.sourceAccountId,
        mirrorAccountId: null,
        notes: input.notes,
      });
    }

    const rest = open - input.amountCents;
    if (rest > 0) {
      const pair = [title.id, ...(title.mirrorTitleId ? [title.mirrorTitleId] : [])];
      const paid = settled + input.amountCents;
      if (paid > 0) await tx.update(titles).set({ amountCents: paid }).where(inArray(titles.id, pair));
      else await tx.update(titles).set({ status: 'canceled' }).where(inArray(titles.id, pair));
      const next = await nextOpenInvoice(tx, card, invoice.referenceMonth);
      await tx.execute(sql`
        INSERT INTO card_invoice_items (card_invoice_id, kind, carried_from_invoice_id, payer_caixa_id, amount_cents, description)
        VALUES (${next.id}, 'carryover', ${id}, ${input.payerCaixaId}, ${rest}, ${`Saldo da fatura ${invoice.referenceMonth.slice(5, 7)}/${invoice.referenceMonth.slice(0, 4)}`})`);
    }
    for (const charge of input.charges) {
      await insertPurchase(tx, card, {
        kind: 'charge',
        chargeKind: charge.chargeKind,
        payerCaixaId: input.payerCaixaId,
        entityId: card.holderEntityId,
        categoryId: charge.categoryId,
        purchasedOn: input.settledOn,
        description: charge.description ?? t.card.chargeKinds[charge.chargeKind] ?? charge.chargeKind,
        amountCents: charge.amountCents,
        installmentsTotal: 1,
        firstInstallment: 1,
      });
    }
  });
  return getInvoice(ctx, id, ctx.access.canRead(invoice.cardCaixaId) ? undefined : input.payerCaixaId);
}

async function nextOpenInvoice(tx: Parameters<typeof ensureInvoices>[0], card: Parameters<typeof ensureInvoices>[1], month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  await ensureInvoices(tx, card, next, next);
  const [row] = await tx
    .select()
    .from(cardInvoices)
    .where(and(eq(cardInvoices.cardCaixaId, card.id), eq(cardInvoices.referenceMonth, next)));
  if (!row || row.closedAt) throw unprocessable(t.errors.noOpenInvoice, 'no_open_invoice');
  return row;
}

/** Pagamento antecipado (fatura aberta): par de títulos já quitado, com as duas pernas e o movimento. */
export async function advanceInvoice(ctx: ServiceContext, id: string, input: z.output<typeof invoiceAdvanceInput>) {
  const invoice = await loadInvoice(ctx, id);
  ctx.access.assertWrite(input.payerCaixaId);
  if (invoice.closedAt) throw unprocessable(t.errors.invoiceClosed, 'invoice_closed');
  await withTx(ctx, async (tx) => {
    const card = await loadCard(tx, invoice.cardCaixaId, true);
    const pair = await insertInvoiceTitlePair(tx, card, invoice, input.payerCaixaId, input.amountCents, {
      mirrorStatus: 'accepted',
      payerCategoryId: input.categoryId,
    });
    await settleInTx(ctx, tx, pair.mirrorId!, {
      settledOn: input.settledOn,
      amountCents: input.amountCents,
      interestCents: 0,
      fineCents: 0,
      discountCents: 0,
      financialAccountId: input.financialAccountId,
      sourceAccountId: null,
      mirrorAccountId: null,
      notes: input.notes,
    });
  });
  return getInvoice(ctx, id, ctx.access.canRead(invoice.cardCaixaId) ? undefined : input.payerCaixaId);
}

/** Cria as faturas do horizonte de todos os cartões e (opcional) fecha as vencidas. Worker, ator system. */
export async function cardMaintenance(db: ServiceContext['db'], opts: { autoClose: boolean }) {
  const cards = await db.execute<{ id: string }>(sql`SELECT id FROM caixas WHERE kind = 'credit_card' AND archived_at IS NULL`);
  let closed = 0;
  let failed = 0;
  for (const { id } of cards.rows) {
    try {
      await db.transaction(async (tx) => {
        const card = await loadCard(tx, id, true);
        await ensureHorizon(tx, card);
      });
    } catch {
      failed += 1;
    }
  }
  if (opts.autoClose) {
    const due = await db.execute<{ id: string }>(sql`
      SELECT v.id FROM card_invoices v JOIN caixas c ON c.id = v.card_caixa_id
       WHERE v.closed_at IS NULL AND v.closing_date < ${todayIso()}::date AND c.archived_at IS NULL
       ORDER BY v.reference_month`);
    for (const { id } of due.rows) {
      try {
        await db.transaction(async (tx) => {
          await closeInvoiceTx(tx, id, { mirrorStatusFor: () => 'accepted' });
        });
        closed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { cards: cards.rows.length, closed, failed };
}

/** Categorias de despesa para encargos sugeridas pelo nome (juros, IOF, multa). */
export async function suggestedChargeCategory(ctx: ServiceContext) {
  const [row] = await ctx.db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(eq(categories.kind, 'expense'), sql`${categories.archivedAt} IS NULL`, sql`${categories.name} ~* '(juro|encargo|tarifa|iof)'`),
    )
    .limit(1);
  return row?.id ?? null;
}
