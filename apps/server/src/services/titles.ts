import { caixas, categories, type Executor, recurrenceRules, settlements, type Tx, titles } from '@moneyflow/db';
import {
  addDays,
  type DeleteResult,
  dayOfMonth,
  isoWeekday,
  type MirrorStatus,
  type mirrorAcceptInput,
  type mirrorDisputeInput,
  parseBoleto,
  type RecurrenceRuleDto,
  type SettlementRow,
  t as strings,
  type TitleDetail,
  type TitleRow,
  type TitleStatus,
  type titleCreateInput,
  type titleListQuery,
  type titleUpdateInput,
  todayIso,
} from '@moneyflow/shared';
import { and, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { readableFilter } from './caixas';
import { clearStatementSuggestions } from './reconciliation-guards';
import { materializeRule } from './recurrence';
import { insertTitlePair, type MirrorPlan, opposite } from './title-pair';
import { deleteOrArchive, withTx } from './tx';
import { camel } from './util';

/* Títulos a pagar e a receber (spec 005) com espelhamento (spec 006). */

type Direction = 'payable' | 'receivable';
const categoryKindFor = (direction: Direction) => (direction === 'payable' ? 'expense' : 'income');

/* ---------------- leitura ---------------- */

const rowSelect = (today: string) => sql`
  t.id, t.caixa_id, c.name AS caixa_name, t.direction, t.status, t.entity_id, e.name AS entity_name,
  t.category_id, cat.name AS category_name, coalesce(cat.color_slot, pc.color_slot) AS category_color_slot,
  t.description, t.competence_date, t.due_date, t.amount_cents, tb.settled_cents, tb.open_cents,
  t.origin, t.recurrence_rule_id, t.occurrence, r.installments_total,
  t.counterparty_caixa_id, cc.name AS counterparty_caixa_name, t.mirror_title_id, t.mirror_status,
  coalesce(t.mirror_status, m.mirror_status) AS pair_mirror_status,
  t.notes, t.archived_at,
  (tb.open_cents > 0 AND t.due_date < ${today}::date) AS overdue,
  CASE WHEN c.kind = 'credit_card' THEN 0 ELSE
  (SELECT count(*)::int FROM settlements s
    WHERE s.title_id = t.id AND s.reversed_at IS NULL AND s.financial_account_id IS NULL
      AND s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents <> 0) END AS pending_account_count,
  t.card_invoice_id, t.boleto_barcode, t.pix_payload, t.nfe_document_id,
  (SELECT count(*)::int FROM title_attachments ta WHERE ta.title_id = t.id) AS attachment_count`;

const fromSql = sql`
  FROM titles t
  JOIN title_balances tb ON tb.title_id = t.id
  JOIN caixas c ON c.id = t.caixa_id
  JOIN entities e ON e.id = t.entity_id
  JOIN categories cat ON cat.id = t.category_id
  LEFT JOIN categories pc ON pc.id = cat.parent_id
  LEFT JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
  LEFT JOIN caixas cc ON cc.id = t.counterparty_caixa_id
  LEFT JOIN titles m ON m.id = t.mirror_title_id`;

function toRow(row: Record<string, unknown>): TitleRow {
  const r = camel<TitleRow & { archivedAt: Date | null }>(row);
  return { ...r, archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null };
}

export async function listTitles(
  ctx: ServiceContext,
  query: z.output<typeof titleListQuery>,
  opts: { writableOnly?: boolean } = {},
): Promise<TitleRow[]> {
  if (query.caixaId) ctx.access.assertRead(query.caixaId);
  const today = todayIso();
  const where = [readableFilter(ctx.access, sql`t.caixa_id`)];
  if (opts.writableOnly && !ctx.access.isAdmin) {
    const ids = ctx.access.writableCaixaIds() as string[];
    where.push(
      ids.length
        ? sql`t.caixa_id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`,
    );
  }
  if (query.caixaId) where.push(sql`t.caixa_id = ${query.caixaId}`);
  if (query.direction) where.push(sql`t.direction = ${query.direction}`);
  if (query.entityId) where.push(sql`t.entity_id = ${query.entityId}`);
  if (query.from) where.push(sql`t.due_date >= ${query.from}::date`);
  if (query.to) where.push(sql`t.due_date <= ${query.to}::date`);
  if (query.q) where.push(sql`(t.description ILIKE ${`%${query.q}%`} OR e.name ILIKE ${`%${query.q}%`})`);
  where.push(query.archived ? sql`t.archived_at IS NOT NULL` : sql`t.archived_at IS NULL`);
  switch (query.status) {
    case 'open':
    case 'partial':
    case 'paid':
    case 'canceled':
      where.push(sql`t.status = ${query.status}`);
      break;
    case 'unpaid':
      where.push(sql`tb.open_cents > 0`);
      break;
    case 'overdue':
      where.push(sql`tb.open_cents > 0 AND t.due_date < ${today}::date`);
      break;
    case 'pending_acceptance':
      where.push(sql`t.mirror_status = 'pending'`);
      break;
    case 'pending_account':
      // O lado do cartão de uma fatura é baixado sempre sem conta (cartão não tem contas).
      where.push(sql`c.kind <> 'credit_card' AND EXISTS (SELECT 1 FROM settlements s WHERE s.title_id = t.id AND s.reversed_at IS NULL AND s.financial_account_id IS NULL
        AND s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents <> 0)`);
      break;
  }
  const result = await ctx.db.execute(sql`
    SELECT ${rowSelect(today)} ${fromSql}
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY t.due_date, t.created_at
     LIMIT ${query.limit}`);
  return result.rows.map(toRow);
}

async function loadTitle(db: Executor, id: string, lock = false) {
  const query = db.select().from(titles).where(eq(titles.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound();
  return row;
}

export async function listSettlements(db: Executor, titleId: string): Promise<SettlementRow[]> {
  const result = await db.execute(sql`
    SELECT s.id, s.title_id, s.settled_on, s.amount_cents, s.interest_cents, s.fine_cents, s.discount_cents,
           (s.amount_cents + s.interest_cents + s.fine_cents - s.discount_cents)::bigint AS cash_cents,
           s.financial_account_id, a.name AS financial_account_name, s.mirror_settlement_id,
           tr.id AS transfer_id, oa.name AS transfer_other_account_name,
           s.notes, s.reversed_at, s.reversal_reason, s.created_at
      FROM settlements s
      LEFT JOIN financial_accounts a ON a.id = s.financial_account_id
      LEFT JOIN transfers tr ON tr.settlement_id = s.id
      LEFT JOIN financial_accounts oa
        ON oa.id = CASE WHEN tr.from_account_id = s.financial_account_id THEN tr.to_account_id ELSE tr.from_account_id END
     WHERE s.title_id = ${titleId}
     ORDER BY s.settled_on, s.created_at`);
  return result.rows.map((row) => {
    const r = camel<SettlementRow & { reversedAt: Date | null; createdAt: Date }>(row);
    return { ...r, reversedAt: r.reversedAt ? new Date(r.reversedAt).toISOString() : null, createdAt: new Date(r.createdAt).toISOString() };
  });
}

export async function getTitle(ctx: ServiceContext, id: string): Promise<TitleDetail> {
  const result = await ctx.db.execute(sql`SELECT ${rowSelect(todayIso())} ${fromSql} WHERE t.id = ${id}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  const row = toRow(raw);
  ctx.access.assertRead(row.caixaId);
  let rule: RecurrenceRuleDto | null = null;
  if (row.recurrenceRuleId) {
    const [r] = await ctx.db.select().from(recurrenceRules).where(eq(recurrenceRules.id, row.recurrenceRuleId));
    if (r) {
      rule = {
        id: r.id,
        frequency: r.frequency as RecurrenceRuleDto['frequency'],
        intervalCount: r.intervalCount,
        anchorDay: r.anchorDay,
        startsOn: r.startsOn,
        endsOn: r.endsOn,
        installmentsTotal: r.installmentsTotal,
      };
    }
  }
  let mirror: TitleDetail['mirror'] = null;
  if (row.mirrorTitleId) {
    const [m] = await ctx.db
      .select({
        id: titles.id,
        caixaId: titles.caixaId,
        caixaName: caixas.name,
        mirrorStatus: titles.mirrorStatus,
        categoryName: categories.name,
        status: titles.status,
      })
      .from(titles)
      .innerJoin(caixas, eq(caixas.id, titles.caixaId))
      .innerJoin(categories, eq(categories.id, titles.categoryId))
      .where(eq(titles.id, row.mirrorTitleId));
    if (m) {
      mirror = {
        ...m,
        mirrorStatus: m.mirrorStatus as MirrorStatus | null,
        status: m.status as TitleStatus,
        canRead: ctx.access.canRead(m.caixaId),
        canWrite: ctx.access.canWrite(m.caixaId),
      };
    }
  }
  return { ...row, canWrite: ctx.access.canWrite(row.caixaId), settlements: await listSettlements(ctx.db, id), rule, mirror };
}

/* ---------------- espelho ---------------- */

/**
 * Categoria do lado espelho quando o autor não escolhe: a mais usada
 * recentemente nessa caixa com a direção do espelho; senão uma "Outras…" do
 * tipo certo; senão qualquer uma do tipo. (O editor de lá pode trocá-la ao aceitar.)
 */
export async function defaultMirrorCategory(tx: Executor, caixaId: string, direction: Direction): Promise<string> {
  const kind = categoryKindFor(direction);
  const [recent] = await tx
    .select({ id: titles.categoryId })
    .from(titles)
    .innerJoin(categories, eq(categories.id, titles.categoryId))
    .where(and(eq(titles.caixaId, caixaId), eq(titles.direction, direction), isNull(categories.archivedAt)))
    .orderBy(desc(titles.createdAt))
    .limit(1);
  if (recent) return recent.id;
  const result = await tx.execute<{ id: string }>(sql`
    SELECT c.id FROM categories c
     WHERE c.kind = ${kind} AND c.archived_at IS NULL
     ORDER BY (c.name ILIKE 'outr%') DESC, (c.parent_id IS NOT NULL) DESC, c.name
     LIMIT 1`);
  const id = result.rows[0]?.id;
  if (!id) throw unprocessable(strings.errors.noMirrorCategory);
  return id;
}

/** Plano do espelho de um título novo (também usado ao lançar a partir da linha do extrato). */
export async function resolveMirror(
  ctx: ServiceContext,
  tx: Executor,
  input: Pick<z.output<typeof titleCreateInput>, 'caixaId' | 'direction' | 'entityId' | 'mirrorCaixaId' | 'mirrorCategoryId'>,
  originHolderId: string,
): Promise<MirrorPlan | null> {
  if (input.mirrorCaixaId === null) return null;
  let caixaId = input.mirrorCaixaId;
  if (caixaId === undefined) {
    // A caixa principal da entidade vem pré-selecionada (spec 006).
    const [primary] = await tx
      .select({ id: caixas.id })
      .from(caixas)
      .where(
        and(eq(caixas.holderEntityId, input.entityId), eq(caixas.isPrimary, true), eq(caixas.kind, 'general'), isNull(caixas.archivedAt)),
      );
    if (!primary || primary.id === input.caixaId) return null;
    caixaId = primary.id;
  } else {
    const [target] = await tx.select().from(caixas).where(eq(caixas.id, caixaId));
    if (!target || target.holderEntityId !== input.entityId || target.kind !== 'general')
      throw unprocessable(strings.errors.mirrorCaixaNotHeld);
    if (target.id === input.caixaId) throw unprocessable(strings.errors.mirrorSameCaixa);
  }
  const mirrorDirection = opposite(input.direction);
  return {
    caixaId,
    entityId: originHolderId,
    categoryId: input.mirrorCategoryId ?? (await defaultMirrorCategory(tx, caixaId, mirrorDirection)),
    // Com permissão na caixa da contraparte o espelho já nasce aceito; sem ela, pendente de aceite.
    status: ctx.access.canWrite(caixaId) ? 'accepted' : 'pending',
  };
}

/* ---------------- escrita ---------------- */

/** Linha digitável (47/48) ou código de barras (44) → código de barras de 44 dígitos (spec 010). */
export function normalizeBoleto(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parseBoleto(value);
  if (!parsed.ok) throw unprocessable(strings.errors.boletoInvalid, 'boleto_invalid');
  return parsed.barcode;
}

export async function createTitle(ctx: ServiceContext, input: z.output<typeof titleCreateInput>): Promise<TitleDetail> {
  ctx.access.assertWrite(input.caixaId);
  const id = await withTx(ctx, async (tx) => {
    const [caixa] = await tx.select().from(caixas).where(eq(caixas.id, input.caixaId));
    if (!caixa) throw notFound();
    const mirror = await resolveMirror(ctx, tx, input, caixa.holderEntityId);

    let ruleId: string | null = null;
    if (input.series) {
      const series = input.series;
      const [rule] = await tx
        .insert(recurrenceRules)
        .values({
          frequency: series.frequency,
          intervalCount: series.intervalCount,
          anchorDay: series.frequency === 'weekly' ? isoWeekday(input.dueDate) : dayOfMonth(input.dueDate),
          startsOn: input.dueDate,
          endsOn: series.kind === 'recurrence' ? series.endsOn : null,
          installmentsTotal: series.kind === 'installments' ? series.count : null,
        })
        .returning({ id: recurrenceRules.id });
      ruleId = rule!.id;
    }

    const first = await insertTitlePair(
      tx,
      {
        caixaId: input.caixaId,
        direction: input.direction,
        entityId: input.entityId,
        categoryId: input.categoryId,
        description: input.description,
        competenceDate: input.competenceDate,
        dueDate: input.dueDate,
        amountCents: input.amountCents,
        notes: input.notes,
        origin: ruleId ? 'recurrence' : 'manual',
        recurrenceRuleId: ruleId,
        occurrence: ruleId ? 1 : null,
        boletoBarcode: normalizeBoleto(input.boletoBarcode),
        pixPayload: input.pixPayload,
        nfeDocumentId: input.nfeDocumentId,
      },
      mirror,
    );
    if (ruleId) await materializeRule(tx, ruleId);
    return first.id;
  });
  return getTitle(ctx, id);
}

type Patch = Partial<typeof titles.$inferInsert>;

export async function updateTitle(ctx: ServiceContext, id: string, input: z.output<typeof titleUpdateInput>): Promise<TitleDetail> {
  await withTx(ctx, async (tx) => {
    const title = await loadTitle(tx, id, true);
    ctx.access.assertWrite(title.caixaId);
    const mirror = title.mirrorTitleId ? await loadTitle(tx, title.mirrorTitleId, true) : null;
    if (mirror && input.entityId && input.entityId !== title.entityId) throw unprocessable(strings.errors.mirrorEntityLocked);

    const amountChanged = input.amountCents !== undefined && input.amountCents !== title.amountCents;
    const dueChanged = input.dueDate !== undefined && input.dueDate !== title.dueDate;
    if (mirror && (amountChanged || dueChanged)) {
      await syncMirror(ctx, tx, title, mirror, { amountCents: input.amountCents, dueDate: input.dueDate });
    }

    const patch: Patch = {};
    if (input.entityId !== undefined) patch.entityId = input.entityId;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.description !== undefined) patch.description = input.description;
    if (input.competenceDate !== undefined) patch.competenceDate = input.competenceDate;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.amountCents !== undefined) patch.amountCents = input.amountCents;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.boletoBarcode !== undefined) patch.boletoBarcode = normalizeBoleto(input.boletoBarcode);
    if (input.pixPayload !== undefined) patch.pixPayload = input.pixPayload;
    if (Object.keys(patch).length > 0) await tx.update(titles).set(patch).where(eq(titles.id, id));

    // "Esta e as próximas": reescreve as ocorrências futuras ainda em aberto (datas seguem a regra).
    if (input.scope === 'following' && title.recurrenceRuleId && title.occurrence) {
      const following = await tx
        .select()
        .from(titles)
        .where(
          and(
            eq(titles.recurrenceRuleId, title.recurrenceRuleId),
            eq(titles.caixaId, title.caixaId),
            gt(titles.occurrence, title.occurrence),
            eq(titles.status, 'open'),
          ),
        )
        .for('update');
      const futurePatch: Patch = {};
      if (input.categoryId !== undefined) futurePatch.categoryId = input.categoryId;
      if (input.description !== undefined) futurePatch.description = input.description;
      if (input.amountCents !== undefined) futurePatch.amountCents = input.amountCents;
      if (input.notes !== undefined) futurePatch.notes = input.notes;
      if (input.entityId !== undefined && !mirror) futurePatch.entityId = input.entityId;
      for (const next of following) {
        if (Object.keys(futurePatch).length === 0) break;
        if (next.mirrorTitleId && input.amountCents !== undefined && input.amountCents !== next.amountCents) {
          const nextMirror = await loadTitle(tx, next.mirrorTitleId, true);
          await syncMirror(ctx, tx, next, nextMirror, { amountCents: input.amountCents });
        }
        await tx.update(titles).set(futurePatch).where(eq(titles.id, next.id));
      }
    }
  });
  return getTitle(ctx, id);
}

/**
 * Valor e vencimento do par andam juntos. Quem edita o lado espelho sem poder
 * escrever no original não muda valor/vencimento; se o outro lado é o espelho
 * e o autor não tem permissão lá, ele volta a aguardar aceite.
 */
async function syncMirror(
  ctx: ServiceContext,
  tx: Tx,
  title: typeof titles.$inferSelect,
  mirror: typeof titles.$inferSelect,
  change: { amountCents?: number; dueDate?: string },
) {
  const canWriteOther = ctx.access.canWrite(mirror.caixaId);
  if (title.mirrorStatus !== null && !canWriteOther) throw unprocessable(strings.errors.mirrorEditOriginal);
  const patch: Patch = {};
  if (change.amountCents !== undefined) patch.amountCents = change.amountCents;
  if (change.dueDate !== undefined) patch.dueDate = change.dueDate;
  if (mirror.mirrorStatus !== null && !canWriteOther) patch.mirrorStatus = 'pending';
  await tx.update(titles).set(patch).where(eq(titles.id, mirror.id));
}

/** Cancela o título e o espelho (um débito cancelado vale para os dois lados). */
export async function cancelTitle(ctx: ServiceContext, id: string): Promise<TitleDetail> {
  await withTx(ctx, async (tx) => {
    const title = await loadTitle(tx, id, true);
    ctx.access.assertWrite(title.caixaId);
    const ids = [title.id, ...(title.mirrorTitleId ? [title.mirrorTitleId] : [])];
    await tx.update(titles).set({ status: 'canceled' }).where(inArray(titles.id, ids));
  });
  return getTitle(ctx, id);
}

export async function reopenTitle(ctx: ServiceContext, id: string): Promise<TitleDetail> {
  await withTx(ctx, async (tx) => {
    const title = await loadTitle(tx, id, true);
    ctx.access.assertWrite(title.caixaId);
    if (title.status !== 'canceled') return;
    const ids = [title.id, ...(title.mirrorTitleId ? [title.mirrorTitleId] : [])];
    await tx
      .update(titles)
      .set({ status: 'open' })
      .where(and(inArray(titles.id, ids), eq(titles.status, 'canceled')));
  });
  return getTitle(ctx, id);
}

/**
 * Exclusão (spec 008). Título avulso: exclui o par; com baixas (mesmo
 * estornadas), arquiva o par. Ocorrência de série: "só esta" arquiva (a vaga
 * da ocorrência continua ocupada, então o worker não a recria); "esta e as
 * próximas" encerra a série a partir dela.
 */
export async function deleteTitle(ctx: ServiceContext, id: string, scope: 'this' | 'following'): Promise<DeleteResult> {
  const title = await loadTitle(ctx.db, id);
  ctx.access.assertWrite(title.caixaId);
  if (title.cardInvoiceId) throw unprocessable(strings.errors.cardInvoiceTitleLocked);
  const pair = [title.id, ...(title.mirrorTitleId ? [title.mirrorTitleId] : [])];

  if (title.recurrenceRuleId && title.occurrence) {
    if (scope === 'following') {
      await withTx(ctx, (tx) => endSeriesFrom(tx, title.recurrenceRuleId!, title.occurrence!, title.dueDate));
      return { deleted: true, archived: false };
    }
    await withTx(ctx, (tx) => tx.update(titles).set({ archivedAt: sql`now()` }).where(inArray(titles.id, pair)));
    return { deleted: false, archived: true };
  }

  return withTx(ctx, async (tx) => {
    // Sugestão de extrato apontando para o título sai antes (spec 009).
    await clearStatementSuggestions(tx, { titleIds: pair });
    return deleteOrArchive(
      tx,
      async (sp) => (await sp.delete(titles).where(inArray(titles.id, pair))).rowCount ?? 0,
      (t) => t.update(titles).set({ archivedAt: sql`now()` }).where(inArray(titles.id, pair)),
    );
  });
}

export async function restoreTitle(ctx: ServiceContext, id: string): Promise<TitleDetail> {
  const title = await loadTitle(ctx.db, id);
  ctx.access.assertWrite(title.caixaId);
  const pair = [title.id, ...(title.mirrorTitleId ? [title.mirrorTitleId] : [])];
  await withTx(ctx, (tx) => tx.update(titles).set({ archivedAt: null }).where(inArray(titles.id, pair)));
  return getTitle(ctx, id);
}

async function endSeriesFrom(tx: Tx, ruleId: string, occurrence: number, dueDate: string) {
  const [rule] = await tx.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId)).for('update');
  if (!rule) throw notFound();
  const doomed = await tx
    .select({ id: titles.id })
    .from(titles)
    .where(and(eq(titles.recurrenceRuleId, ruleId), gte(titles.occurrence, occurrence)));
  const doomedIds = doomed.map((d) => d.id);
  if (doomedIds.length > 0) {
    const [settled] = await tx.select({ id: settlements.id }).from(settlements).where(inArray(settlements.titleId, doomedIds)).limit(1);
    if (settled) throw unprocessable(strings.errors.seriesHasSettlements);
    await clearStatementSuggestions(tx, { titleIds: doomedIds });
    await tx.delete(titles).where(inArray(titles.id, doomedIds));
  }
  const remaining = occurrence - 1;
  if (remaining === 0) {
    await tx.delete(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
  } else if (rule.installmentsTotal !== null) {
    if (remaining >= 2) {
      await tx.update(recurrenceRules).set({ installmentsTotal: remaining }).where(eq(recurrenceRules.id, ruleId));
    } else {
      // Sobrou uma parcela: deixa de ser série (o total mínimo de um parcelamento é 2).
      await tx
        .update(titles)
        .set({ origin: 'manual', recurrenceRuleId: null, occurrence: null })
        .where(eq(titles.recurrenceRuleId, ruleId));
      await tx.delete(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
    }
  } else {
    await tx
      .update(recurrenceRules)
      .set({ endsOn: addDays(dueDate, -1) })
      .where(eq(recurrenceRules.id, ruleId));
  }
}

/* ---------------- aceite do espelho ---------------- */

export async function acceptMirror(ctx: ServiceContext, id: string, input: z.output<typeof mirrorAcceptInput>): Promise<TitleDetail> {
  const title = await loadTitle(ctx.db, id);
  ctx.access.assertWrite(title.caixaId);
  if (title.mirrorStatus !== 'pending' && title.mirrorStatus !== 'disputed') throw unprocessable(strings.errors.mirrorNotPending);
  await withTx(ctx, (tx) =>
    tx
      .update(titles)
      .set({ mirrorStatus: 'accepted', ...(input.categoryId ? { categoryId: input.categoryId } : {}) })
      .where(eq(titles.id, id)),
  );
  return getTitle(ctx, id);
}

export async function disputeMirror(ctx: ServiceContext, id: string, input: z.output<typeof mirrorDisputeInput>): Promise<TitleDetail> {
  const title = await loadTitle(ctx.db, id);
  ctx.access.assertWrite(title.caixaId);
  if (title.mirrorStatus === null || title.mirrorStatus === 'disputed') throw unprocessable(strings.errors.mirrorNotPending);
  const notes = input.reason
    ? [title.notes, `${strings.title.mirrorStatuses.disputed}: ${input.reason}`].filter(Boolean).join('\n')
    : title.notes;
  await withTx(ctx, (tx) => tx.update(titles).set({ mirrorStatus: 'disputed', notes }).where(eq(titles.id, id)));
  return getTitle(ctx, id);
}

/** Usado pelos testes e pela baixa: títulos do par. */
export async function titlePair(db: Executor, id: string) {
  const title = await loadTitle(db, id);
  const mirror = title.mirrorTitleId ? await loadTitle(db, title.mirrorTitleId) : null;
  return { title, mirror };
}
