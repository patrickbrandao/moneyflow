import {
  caixas,
  cardInvoiceItems,
  categories,
  classificationRules,
  type Executor,
  movements,
  settlements,
  statementCsvMappings,
  statementLines,
  type Tx,
  titles,
  transfers,
} from '@moneyflow/db';
import {
  type ApplyRulesResult,
  type ClassificationRuleRow,
  type CopyRulesResult,
  type CopyRulesSkipped,
  type CsvMappingRow,
  type classificationRuleInput,
  type classificationRuleUpdateInput,
  type copyRulesInput,
  type csvMappingInput,
  type csvMappingUpdateInput,
  type LineCreatedEntry,
  type lineClassifyInput,
  type lineCreateInput,
  type lineMatchInput,
  type lineUnmatchInput,
  type MatchCandidateRow,
  normalizeDescription,
  type StatementLineRow,
  scoreCandidate,
  t,
} from '@moneyflow/shared';
import { and, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, translateDbError, unprocessable } from '../errors';
import { readableFilter } from './caixas';
import { insertPurchase, loadCard } from './card-core';
import { assertPurchaseDeletable, deletePurchaseTx } from './cards';
import { settleFromLine } from './line-settle';
import { assertNotReconciled, clearStatementSuggestions } from './reconciliation-guards';
import { uuidArray } from './reports';
import { candidatesFor, listLines, type RuleTarget, resolveTarget, ruleFor } from './statements';
import { insertTitlePair } from './title-pair';
import { resolveMirror } from './titles';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Ações sobre as linhas de extrato (spec 009): confirmar sugestões em lote,
 * casar à mão, criar o lançamento de uma linha nova (movimento avulso, título
 * já baixado ou compra no cartão), ignorar, desfazer. Correções do usuário
 * viram regras de classificação (origem correction).
 */

type Line = typeof statementLines.$inferSelect & { caixaId: string };

async function loadLine(ctx: ServiceContext, tx: Tx, id: string): Promise<Line> {
  const result = await tx.execute<{ caixa_id: string; superseded: boolean }>(sql`
    SELECT coalesce(a.caixa_id, l.card_caixa_id) AS caixa_id, i.superseded_by_import_id IS NOT NULL AS superseded
      FROM statement_lines l
      JOIN statement_imports i ON i.id = l.statement_import_id
      LEFT JOIN financial_accounts a ON a.id = l.financial_account_id WHERE l.id = ${id}`);
  const caixaId = result.rows[0]?.caixa_id;
  if (!caixaId) throw notFound();
  ctx.access.assertWrite(caixaId);
  // Linha de lote substituído (spec 031): só as decisões das sobras, pela troca.
  if (result.rows[0]!.superseded) throw unprocessable(t.errors.statementImportSuperseded, 'statement_import_superseded');
  const [line] = await tx.select().from(statementLines).where(eq(statementLines.id, id)).for('update');
  return { ...line!, caixaId };
}

async function lineRow(ctx: ServiceContext, id: string): Promise<StatementLineRow> {
  const [row] = await listLines(ctx.db, sql`l.id = ${id}`);
  if (!row) throw notFound();
  return row;
}

/** Concilia a linha; `createdEntry` = o lançamento ligado nasceu dela (o "desfazer e excluir" o tira junto). */
async function setMatched(
  tx: Tx,
  lineId: string,
  link: { movementId?: string | null; cardInvoiceItemId?: string | null; createdEntry?: LineCreatedEntry | null; autoSettled?: boolean },
) {
  await tx
    .update(statementLines)
    .set({
      status: 'matched',
      matchedAt: sql`now()` as unknown as string,
      movementId: link.movementId ?? null,
      titleId: null,
      cardInvoiceItemId: link.cardInvoiceItemId ?? null,
      createdEntry: link.createdEntry ?? null,
      autoSettled: link.autoSettled ?? false,
    })
    .where(eq(statementLines.id, lineId));
}

/** O vínculo da linha ao voltar a nova/ignorada: a baixa automática sai junto com o created_entry (statement_lines_auto_settled_check). */
const UNLINKED = {
  matchedAt: null,
  movementId: null,
  titleId: null,
  cardInvoiceItemId: null,
  createdEntry: null,
  autoSettled: false,
} as const;

/** Aplica uma sugestão (ou um casamento escolhido) dentro da transação. */
async function applyMatch(ctx: ServiceContext, tx: Tx, line: Line, ref: z.output<typeof lineMatchInput>) {
  if (line.status === 'matched' || line.status === 'ignored') throw unprocessable(t.errors.lineNotPending);
  if ([ref.movementId, ref.titleId, ref.cardInvoiceItemId].filter(Boolean).length !== 1) throw unprocessable(t.errors.lineMatchTarget);
  if (ref.movementId) {
    if (!line.financialAccountId) throw unprocessable(t.errors.lineAccountOnly);
    const [movement] = await tx.select().from(movements).where(eq(movements.id, ref.movementId));
    if (!movement || movement.financialAccountId !== line.financialAccountId) throw notFound();
    if (movement.amountCents !== line.amountCents) throw unprocessable(t.errors.lineAmountMismatch);
    await setMatched(tx, line.id, { movementId: movement.id });
  } else if (ref.titleId) {
    if (!line.financialAccountId) throw unprocessable(t.errors.lineAccountOnly);
    // Spec 033: a baixa repartida (parcela de contrato) e, no título de outra caixa, a transferência.
    const { movementId, createdEntry } = await settleFromLine(ctx, tx, line, ref.titleId);
    await setMatched(tx, line.id, { movementId, createdEntry });
  } else if (ref.cardInvoiceItemId) {
    if (!line.cardCaixaId) throw unprocessable(t.errors.lineCardOnly);
    await setMatched(tx, line.id, { cardInvoiceItemId: ref.cardInvoiceItemId });
  }
}

type LineFailure = { lineId: string; message: string };

/**
 * Lote de ações por linha numa transação só, cada linha num savepoint: uma
 * falha (inclusive das checagens deferidas, forçadas ao fim de cada linha)
 * desfaz só aquela linha e volta com o motivo.
 */
async function eachLine<T extends { lineId: string }>(
  ctx: ServiceContext,
  items: T[],
  apply: (tx: Tx, line: Line, item: T) => Promise<void>,
): Promise<{ done: number; failed: LineFailure[] }> {
  const failed: LineFailure[] = [];
  let done = 0;
  await withTx(ctx, async (tx) => {
    for (const item of items) {
      try {
        await tx.transaction(async (sp) => {
          await apply(sp, await loadLine(ctx, sp, item.lineId), item);
          // As checagens deferidas da baixa rodam no fim da transação; aqui forçamos já, para isolar a falha.
          await sp.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          await sp.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        });
        done += 1;
      } catch (error) {
        const message = translateDbError(error)?.message ?? (error instanceof Error ? error.message : String(error));
        failed.push({ lineId: item.lineId, message });
      }
    }
  });
  return { done, failed };
}

/** Confirma em lote as linhas sugeridas; cada linha num savepoint (uma falha não derruba as outras). */
export async function confirmLines(ctx: ServiceContext, lineIds: string[]) {
  const { done, failed } = await eachLine(
    ctx,
    lineIds.map((lineId) => ({ lineId })),
    async (tx, line) => {
      if (line.status !== 'suggested') throw unprocessable(t.errors.lineNotSuggested);
      await applyMatch(ctx, tx, line, {
        movementId: line.movementId ?? undefined,
        titleId: line.titleId ?? undefined,
        cardInvoiceItemId: line.cardInvoiceItemId ?? undefined,
      });
    },
  );
  return { confirmed: done, failed };
}

/** Casa em lote linhas escolhidas (movimento, título em aberto que vira baixa, ou item de fatura). */
export async function matchLines(ctx: ServiceContext, items: ({ lineId: string } & z.output<typeof lineMatchInput>)[]) {
  const { done, failed } = await eachLine(ctx, items, (tx, line, item) => applyMatch(ctx, tx, line, item));
  return { matched: done, failed };
}

/** Lança em lote linhas novas (movimento avulso, título já baixado ou compra). */
export async function createFromLines(ctx: ServiceContext, items: ({ lineId: string } & z.output<typeof lineCreateInput>)[]) {
  const { done, failed } = await eachLine(ctx, items, (tx, line, item) => createInTx(ctx, tx, line, item));
  return { created: done, failed };
}

export async function matchLine(ctx: ServiceContext, id: string, input: z.output<typeof lineMatchInput>) {
  await withTx(ctx, async (tx) => applyMatch(ctx, tx, await loadLine(ctx, tx, id), input));
  return lineRow(ctx, id);
}

/**
 * Desfaz a conciliação/sugestão. Por padrão o lançamento ligado fica; com
 * `deleteEntry`, o que nasceu da linha (created_entry) sai junto, como se não
 * tivesse sido lançado — relançar a linha depois não duplica o valor.
 */
export async function unmatchLine(ctx: ServiceContext, id: string, input: z.output<typeof lineUnmatchInput> = { deleteEntry: false }) {
  await withTx(ctx, async (tx) => {
    const line = await loadLine(ctx, tx, id);
    if (line.status !== 'matched' && line.status !== 'suggested') throw unprocessable(t.errors.lineNotMatched);
    if (input.deleteEntry && !line.createdEntry) throw unprocessable(t.errors.lineEntryNotCreated, 'line_entry_not_created');
    await tx
      .update(statementLines)
      .set({ status: 'new', ...UNLINKED })
      .where(eq(statementLines.id, id));
    if (input.deleteEntry) await deleteCreatedEntry(ctx, tx, line);
  });
  return lineRow(ctx, id);
}

const uuids = (ids: string[]) =>
  sql.join(
    ids.map((v) => sql`${v}::uuid`),
    sql`, `,
  );

/**
 * Exclui o lançamento que nasceu da linha (a linha já voltou a nova): o
 * movimento avulso; o título criado pela linha com o espelho e a baixa; a
 * baixa feita num título que já existia (ele volta a ter o valor em aberto);
 * a compra no cartão (faturas abertas, sem estorno). Se o lançamento mudou
 * depois (outra baixa, estorno, outra conciliação), nada sai.
 */
export async function deleteCreatedEntry(
  ctx: ServiceContext,
  tx: Tx,
  line: Pick<Line, 'createdEntry' | 'movementId' | 'cardInvoiceItemId'>,
) {
  if (line.createdEntry === 'purchase') {
    const [item] = await tx
      .select({ purchaseId: cardInvoiceItems.cardPurchaseId })
      .from(cardInvoiceItems)
      .where(eq(cardInvoiceItems.id, line.cardInvoiceItemId!));
    if (!item?.purchaseId) throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
    await assertPurchaseDeletable(ctx, item.purchaseId);
    await deletePurchaseTx(tx, item.purchaseId);
    return;
  }
  const [movement] = await tx.select().from(movements).where(eq(movements.id, line.movementId!));
  if (!movement) throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
  if (line.createdEntry === 'transfer_settlement') {
    // Spec 033: a perna da transferência na conta da linha → a transferência → a baixa (e a perna do espelho) na conta de passagem.
    if (!movement.transferId) throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
    const [transfer] = await tx.select().from(transfers).where(eq(transfers.id, movement.transferId));
    if (!transfer?.settlementId) throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
    await deleteSettlementLegs(tx, transfer.settlementId, [transfer.id]);
    return;
  }
  if (line.createdEntry === 'adjustment') {
    if (movement.kind !== 'adjustment') throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
    await assertNotReconciled(tx, [movement.id]);
    await clearStatementSuggestions(tx, { movementIds: [movement.id] });
    await tx.delete(movements).where(eq(movements.id, movement.id));
    return;
  }

  // title / settlement: a baixa (e a perna do espelho) do movimento da linha.
  if (!movement.settlementId) throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
  await deleteSettlementLegs(tx, movement.settlementId, [], line.createdEntry === 'title');
}

/**
 * Exclui a baixa (com a perna do espelho), os movimentos dela e as
 * transferências `transferIds` que a financiavam (com os movimentos); com
 * `withTitle`, o par de títulos criado pela linha. Recusa se a baixa foi
 * estornada ou se o título tem outra baixa (title), ou se algum movimento
 * está conciliado com outra linha.
 */
async function deleteSettlementLegs(tx: Tx, settlementId: string, transferIds: string[], withTitle = false) {
  const [leg] = await tx.select().from(settlements).where(eq(settlements.id, settlementId));
  if (!leg) throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
  const legIds = [leg.id, ...(leg.mirrorSettlementId ? [leg.mirrorSettlementId] : [])];
  const [title] = await tx.select().from(titles).where(eq(titles.id, leg.titleId));
  const pair = [title!.id, ...(title!.mirrorTitleId ? [title!.mirrorTitleId] : [])];
  const legs = await tx.execute<{ id: string; reversed_at: string | null }>(
    withTitle
      ? sql`SELECT id, reversed_at FROM settlements WHERE title_id IN (${uuids(pair)})`
      : sql`SELECT id, reversed_at FROM settlements WHERE id IN (${uuids(legIds)})`,
  );
  if (legs.rows.some((r) => r.reversed_at !== null || !legIds.includes(r.id)))
    throw unprocessable(t.errors.lineEntryChanged, 'line_entry_changed');
  const moved = await tx.execute<{ id: string }>(sql`
    SELECT id FROM movements WHERE settlement_id IN (${uuids(legIds)})
    ${transferIds.length ? sql`OR transfer_id IN (${uuids(transferIds)})` : sql``}`);
  const movementIds = moved.rows.map((r) => r.id);
  await assertNotReconciled(tx, movementIds);
  await clearStatementSuggestions(tx, { movementIds });
  if (movementIds.length > 0) await tx.delete(movements).where(inArray(movements.id, movementIds));
  if (transferIds.length > 0) await tx.delete(transfers).where(inArray(transfers.id, transferIds));
  await tx.delete(settlements).where(inArray(settlements.id, legIds));
  if (withTitle) {
    await clearStatementSuggestions(tx, { titleIds: pair });
    await tx.delete(titles).where(inArray(titles.id, pair));
  }
}

async function applyIgnored(tx: Tx, line: Line, ignored: boolean) {
  if (ignored && line.status === 'matched') throw unprocessable(t.errors.lineNotPending);
  if (!ignored && line.status !== 'ignored') return;
  await tx
    .update(statementLines)
    .set({ status: ignored ? 'ignored' : 'new', ...UNLINKED })
    .where(eq(statementLines.id, line.id));
}

export async function setIgnored(ctx: ServiceContext, id: string, ignored: boolean) {
  await withTx(ctx, async (tx) => applyIgnored(tx, await loadLine(ctx, tx, id), ignored));
  return lineRow(ctx, id);
}

/** Ignora (ou volta) em lote; linhas conciliadas não são ignoradas e voltam em failed. */
export async function setIgnoredLines(ctx: ServiceContext, lineIds: string[], ignored: boolean) {
  const { done, failed } = await eachLine(
    ctx,
    lineIds.map((lineId) => ({ lineId })),
    (tx, line) => applyIgnored(tx, line, ignored),
  );
  return { updated: done, failed };
}

/** Padrão da regra aprendida: a descrição normalizada (sem números longos e datas). */
export function rulePatternOf(description: string): string {
  const normalized = normalizeDescription(description);
  return (normalized || description.trim().toLowerCase()).slice(0, 120);
}

/** Cria (ou atualiza) a regra aprendida da correção do usuário, na conta (ou cartão) da linha (spec 032). */
async function learnRule(ctx: ServiceContext, tx: Tx, line: Line, entityId: string | null, categoryId: string | null) {
  if (!entityId && !categoryId) return;
  const direction = line.cardCaixaId || line.amountCents < 0 ? 'out' : 'in';
  await tx.execute(sql`
    INSERT INTO classification_rules (caixa_id, financial_account_id, match_kind, pattern, direction, entity_id, category_id, origin,
                                      created_from_line_id, created_by_user_id)
    VALUES (${line.caixaId}, ${line.financialAccountId}, 'contains', ${rulePatternOf(line.description)}, ${direction}, ${entityId},
            ${categoryId}, 'correction', ${line.id}, ${ctx.access.actor.id})
    ON CONFLICT (caixa_id, financial_account_id, match_kind, lower(pattern), direction) WHERE archived_at IS NULL
    DO UPDATE SET entity_id = EXCLUDED.entity_id, category_id = EXCLUDED.category_id, origin = 'correction',
                  copied_from_rule_id = NULL`);
}

export async function classifyLine(ctx: ServiceContext, id: string, input: z.output<typeof lineClassifyInput>) {
  await withTx(ctx, async (tx) => {
    const line = await loadLine(ctx, tx, id);
    await tx
      .update(statementLines)
      .set({
        entityId: input.entityId,
        categoryId: input.categoryId,
        classificationSource: input.entityId || input.categoryId ? 'user' : null,
        classificationRuleId: null,
      })
      .where(eq(statementLines.id, id));
    if (input.learnRule) await learnRule(ctx, tx, line, input.entityId, input.categoryId);
  });
  return lineRow(ctx, id);
}

/**
 * Linha nova vira lançamento: movimento avulso (adjustment), título já baixado
 * na conta do extrato, ou compra no cartão (import de fatura). A linha fica
 * conciliada com o que foi criado.
 */
export async function createFromLine(ctx: ServiceContext, id: string, input: z.output<typeof lineCreateInput>) {
  await withTx(ctx, async (tx) => createInTx(ctx, tx, await loadLine(ctx, tx, id), input));
  return lineRow(ctx, id);
}

async function createInTx(ctx: ServiceContext, tx: Tx, line: Line, input: z.output<typeof lineCreateInput>) {
  if (line.status === 'matched' || line.status === 'ignored') throw unprocessable(t.errors.lineNotPending);
  const entityId = input.entityId ?? line.entityId;
  const categoryId = input.categoryId ?? line.categoryId;
  const description = input.description ?? line.description;

  if (input.mode === 'purchase') {
    if (!line.cardCaixaId) throw unprocessable(t.errors.lineCardOnly);
    if (line.amountCents > 0) throw unprocessable(t.errors.lineCreditOnCard);
    if (!entityId || !categoryId) throw unprocessable(t.errors.lineNeedsClassification);
    const card = await loadCard(tx, line.cardCaixaId, true);
    const payerCaixaId = input.payerCaixaId ?? card.defaultPayerCaixaId;
    ctx.access.assertRead(payerCaixaId);
    const created = await insertPurchase(tx, card, {
      kind: 'purchase',
      payerCaixaId,
      entityId,
      categoryId,
      purchasedOn: line.postedOn,
      description,
      amountCents: -line.amountCents,
      installmentsTotal: 1,
      firstInstallment: 1,
    });
    await setMatched(tx, line.id, { cardInvoiceItemId: created.itemIds[0]!, createdEntry: 'purchase' });
  } else {
    if (!line.financialAccountId) throw unprocessable(t.errors.lineAccountOnly);
    if (input.mode === 'adjustment') {
      const [movement] = await tx
        .insert(movements)
        .values({
          financialAccountId: line.financialAccountId,
          occurredOn: line.postedOn,
          amountCents: line.amountCents,
          kind: 'adjustment',
          description,
          entityId,
          categoryId,
        })
        .returning({ id: movements.id });
      await setMatched(tx, line.id, { movementId: movement!.id, createdEntry: 'adjustment' });
    } else {
      if (!entityId || !categoryId) throw unprocessable(t.errors.lineNeedsClassification);
      const direction = line.amountCents < 0 ? 'payable' : 'receivable';
      const [holder] = await tx.select({ id: caixas.holderEntityId }).from(caixas).where(eq(caixas.id, line.caixaId));
      // Espelho como em create_title (spec 006): caixa principal da entidade por padrão; null = sem espelho.
      const mirror = await resolveMirror(
        ctx,
        tx,
        { caixaId: line.caixaId, direction, entityId, mirrorCaixaId: input.mirrorCaixaId, mirrorCategoryId: input.mirrorCategoryId },
        holder!.id,
      );
      const pair = await insertTitlePair(
        tx,
        {
          caixaId: line.caixaId,
          direction,
          entityId,
          categoryId,
          description,
          competenceDate: line.postedOn,
          dueDate: line.postedOn,
          amountCents: Math.abs(line.amountCents),
          notes: null,
          origin: 'manual',
          recurrenceRuleId: null,
          occurrence: null,
        },
        mirror,
      );
      const { movementId } = await settleFromLine(ctx, tx, line, pair.id);
      await setMatched(tx, line.id, { movementId, createdEntry: 'title' });
    }
  }
  const corrected = (entityId ?? null) !== (line.entityId ?? null) || (categoryId ?? null) !== (line.categoryId ?? null);
  await tx
    .update(statementLines)
    .set({
      entityId,
      categoryId: categoryId && (await categoryFits(tx, categoryId, line)) ? categoryId : null,
      classificationSource: corrected ? 'user' : line.classificationSource,
      classificationRuleId: corrected ? null : line.classificationRuleId,
    })
    .where(eq(statementLines.id, line.id));
  if (input.learnRule && (corrected || !line.classificationRuleId)) await learnRule(ctx, tx, line, entityId, categoryId);
}

async function categoryFits(tx: Tx, categoryId: string, line: Line) {
  const [row] = await tx.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId));
  return row?.kind === (line.cardCaixaId || line.amountCents < 0 ? 'expense' : 'income');
}

/** Candidatos para casar à mão (janela maior que a do casamento automático). */
export async function lineCandidates(ctx: ServiceContext, id: string): Promise<MatchCandidateRow[]> {
  const [line] = await ctx.db.select().from(statementLines).where(eq(statementLines.id, id));
  if (!line) throw notFound();
  await resolveTarget(ctx, { accountId: line.financialAccountId, cardCaixaId: line.cardCaixaId }, false);
  const raw = {
    id: line.id,
    posted_on: line.postedOn,
    amount_cents: line.amountCents,
    description: line.description,
    financial_account_id: line.financialAccountId,
    card_caixa_id: line.cardCaixaId,
  };
  const candidates = await candidatesFor(ctx.db, raw, 30, (caixaId) => ctx.access.canRead(caixaId));
  // A parcela achada pela regra do contrato (spec 033) aparece uma vez, com a repartição.
  const contractIds = new Set(candidates.filter((c) => c.contract).map((c) => c.id));
  return candidates
    .filter((c) => c.contract || c.kind !== 'title' || !contractIds.has(c.id))
    .map((c) => ({
      kind: c.kind,
      id: c.id,
      date: c.date,
      amountCents: c.amountCents,
      description: c.description,
      entityName: c.entityName ?? null,
      score: scoreCandidate({ postedOn: line.postedOn, amountCents: line.amountCents, description: line.description }, c),
      contract: c.contract ?? null,
    }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/* ---------------- mapeamentos de CSV ---------------- */

const toMapping = (row: typeof statementCsvMappings.$inferSelect): CsvMappingRow => ({
  id: row.id,
  financialAccountId: row.financialAccountId,
  cardCaixaId: row.cardCaixaId,
  name: row.name,
  delimiter: row.delimiter,
  encoding: row.encoding,
  hasHeader: row.hasHeader,
  skipRows: row.skipRows,
  dateFormat: row.dateFormat,
  decimalSeparator: row.decimalSeparator,
  columns: row.columns as Record<string, string | number>,
  isDefault: row.isDefault,
});

export async function listMappings(ctx: ServiceContext, ref: { accountId?: string; cardCaixaId?: string }) {
  const target = await resolveTarget(ctx, ref, false);
  const rows = await ctx.db
    .select()
    .from(statementCsvMappings)
    .where(
      target.kind === 'account'
        ? eq(statementCsvMappings.financialAccountId, target.accountId)
        : eq(statementCsvMappings.cardCaixaId, target.cardId),
    )
    .orderBy(sql`is_default DESC, name`);
  return rows.map(toMapping);
}

export async function createMapping(ctx: ServiceContext, input: z.output<typeof csvMappingInput>) {
  const target = await resolveTarget(ctx, { accountId: input.financialAccountId, cardCaixaId: input.cardCaixaId }, true);
  const row = await withTx(ctx, async (tx) => {
    const owner =
      target.kind === 'account'
        ? eq(statementCsvMappings.financialAccountId, target.accountId)
        : eq(statementCsvMappings.cardCaixaId, target.cardId);
    if (input.isDefault) await tx.update(statementCsvMappings).set({ isDefault: false }).where(owner);
    const [created] = await tx
      .insert(statementCsvMappings)
      .values({
        financialAccountId: target.kind === 'account' ? target.accountId : null,
        cardCaixaId: target.kind === 'card' ? target.cardId : null,
        name: input.name,
        delimiter: input.delimiter,
        encoding: input.encoding,
        hasHeader: input.hasHeader,
        skipRows: input.skipRows,
        dateFormat: input.dateFormat,
        decimalSeparator: input.decimalSeparator,
        columns: input.columns,
        isDefault: input.isDefault,
      })
      .returning();
    return created!;
  });
  return toMapping(row);
}

async function loadMapping(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db.select().from(statementCsvMappings).where(eq(statementCsvMappings.id, id));
  if (!row) throw notFound();
  await resolveTarget(ctx, { accountId: row.financialAccountId, cardCaixaId: row.cardCaixaId }, true);
  return row;
}

export async function updateMapping(ctx: ServiceContext, id: string, input: z.output<typeof csvMappingUpdateInput>) {
  const current = await loadMapping(ctx, id);
  const row = await withTx(ctx, async (tx) => {
    if (input.isDefault) {
      await tx
        .update(statementCsvMappings)
        .set({ isDefault: false })
        .where(
          and(
            current.financialAccountId
              ? eq(statementCsvMappings.financialAccountId, current.financialAccountId)
              : eq(statementCsvMappings.cardCaixaId, current.cardCaixaId!),
            ne(statementCsvMappings.id, id),
          ),
        );
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const [updated] = await tx.update(statementCsvMappings).set(patch).where(eq(statementCsvMappings.id, id)).returning();
    return updated!;
  });
  return toMapping(row);
}

export async function deleteMapping(ctx: ServiceContext, id: string) {
  await loadMapping(ctx, id);
  await withTx(ctx, (tx) => tx.delete(statementCsvMappings).where(eq(statementCsvMappings.id, id)));
  return { deleted: true, archived: false };
}

/* ---------------- regras de classificação (specs 009/032) ---------------- */

/*
 * Cada regra é de uma conta corrente/poupança ou de um cartão (spec 032): só
 * classifica as linhas dos extratos dele. Ler = ler a caixa da conta; criar,
 * editar, arquivar, aplicar e copiar para a conta = escrever nela. Não existe
 * regra global nem da caixa inteira.
 */

export type ResolvedRuleTarget = RuleTarget & { caixaId: string; name: string };

/** Conta (corrente/poupança) ou cartão das regras, com a permissão conferida. */
export async function resolveRuleTarget(
  ctx: ServiceContext,
  ref: { accountId?: string | null; cardCaixaId?: string | null },
  write: boolean,
  db: Executor = ctx.db,
): Promise<ResolvedRuleTarget> {
  if (Boolean(ref.accountId) === Boolean(ref.cardCaixaId)) throw unprocessable(t.errors.ruleAccount, 'rule_target');
  const assert = (caixaId: string) => (write ? ctx.access.assertWrite(caixaId) : ctx.access.assertRead(caixaId));
  if (ref.accountId) {
    const result = await db.execute<{ caixa_id: string; kind: string; name: string }>(
      sql`SELECT caixa_id, kind, name FROM financial_accounts WHERE id = ${ref.accountId}`,
    );
    const account = result.rows[0];
    if (!account) throw notFound();
    assert(account.caixa_id);
    if (account.kind !== 'checking' && account.kind !== 'savings')
      throw unprocessable(t.errors.ruleAccountKind, 'classification_rules_account_check');
    return { accountId: ref.accountId, cardCaixaId: null, caixaId: account.caixa_id, name: account.name };
  }
  const cardId = ref.cardCaixaId!;
  const result = await db.execute<{ kind: string; name: string }>(sql`SELECT kind, name FROM caixas WHERE id = ${cardId}`);
  const caixa = result.rows[0];
  if (!caixa) throw notFound();
  assert(cardId);
  if (caixa.kind !== 'credit_card') throw unprocessable(t.errors.ruleAccountKind, 'classification_rules_account_check');
  return { accountId: null, cardCaixaId: cardId, caixaId: cardId, name: caixa.name };
}

const ruleSql = sql`
  SELECT r.id, r.caixa_id, c.name AS caixa_name, c.kind AS caixa_kind, r.financial_account_id, a.name AS account_name,
         CASE WHEN r.financial_account_id IS NULL THEN r.caixa_id END AS card_caixa_id, coalesce(a.name, c.name) AS target_name,
         r.copied_from_rule_id, r.match_kind, r.pattern, r.direction, r.entity_id, e.name AS entity_name,
         r.category_id, cat.name AS category_name, coalesce(cat.color_slot, pcat.color_slot) AS category_color_slot, r.priority,
         r.origin, r.usage_count, r.last_used_at, r.archived_at
    FROM classification_rules r
    JOIN caixas c ON c.id = r.caixa_id
    LEFT JOIN financial_accounts a ON a.id = r.financial_account_id
    LEFT JOIN entities e ON e.id = r.entity_id
    LEFT JOIN categories cat ON cat.id = r.category_id
    LEFT JOIN categories pcat ON pcat.id = cat.parent_id`;

function toRule(ctx: ServiceContext, row: Record<string, unknown>): ClassificationRuleRow {
  const r = camel<ClassificationRuleRow>(row);
  return {
    ...r,
    lastUsedAt: iso(r.lastUsedAt),
    archivedAt: iso(r.archivedAt),
    canWrite: ctx.access.canWrite(r.caixaId),
  };
}

/** Regras de todas as contas e cartões legíveis, ou só as da conta, do cartão ou da caixa pedida. */
export async function listRules(
  ctx: ServiceContext,
  query: { accountId?: string; cardCaixaId?: string; caixaId?: string; archived?: boolean },
) {
  const where = [readableFilter(ctx.access, sql`r.caixa_id`)];
  if (query.accountId) {
    await resolveRuleTarget(ctx, { accountId: query.accountId }, false);
    where.push(sql`r.financial_account_id = ${query.accountId}`);
  }
  if (query.cardCaixaId) {
    await resolveRuleTarget(ctx, { cardCaixaId: query.cardCaixaId }, false);
    where.push(sql`r.caixa_id = ${query.cardCaixaId} AND r.financial_account_id IS NULL`);
  }
  if (query.caixaId) {
    ctx.access.assertRead(query.caixaId);
    where.push(sql`r.caixa_id = ${query.caixaId}`);
  }
  where.push(query.archived ? sql`r.archived_at IS NOT NULL` : sql`r.archived_at IS NULL`);
  const result = await ctx.db.execute(
    sql`${ruleSql} WHERE ${sql.join(where, sql` AND `)}
        ORDER BY c.name, coalesce(a.name, c.name), r.financial_account_id, r.priority, r.pattern LIMIT 2000`,
  );
  return result.rows.map((row) => toRule(ctx, row));
}

async function loadRule(ctx: ServiceContext, id: string) {
  const [rule] = await ctx.db.select().from(classificationRules).where(eq(classificationRules.id, id));
  if (!rule) throw notFound();
  ctx.access.assertWrite(rule.caixaId);
  return rule;
}

async function getRules(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return [];
  const result = await ctx.db.execute(sql`${ruleSql} WHERE r.id = ANY(${uuidArray(ids)})`);
  const rows = result.rows.map((row) => toRule(ctx, row));
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}

async function getRule(ctx: ServiceContext, id: string) {
  const [rule] = await getRules(ctx, [id]);
  if (!rule) throw notFound();
  return rule;
}

export async function createRule(ctx: ServiceContext, input: z.output<typeof classificationRuleInput>) {
  const target = await resolveRuleTarget(ctx, input, true);
  const { accountId: _account, cardCaixaId: _card, ...values } = input;
  const [row] = await withTx(ctx, (tx) =>
    tx
      .insert(classificationRules)
      .values({
        ...values,
        caixaId: target.caixaId,
        financialAccountId: target.accountId,
        origin: 'manual',
        createdByUserId: ctx.access.actor.id,
      })
      .returning({ id: classificationRules.id }),
  );
  return getRule(ctx, row!.id);
}

export async function updateRule(ctx: ServiceContext, id: string, input: z.output<typeof classificationRuleUpdateInput>) {
  await loadRule(ctx, id);
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (Object.keys(patch).length > 0)
    await withTx(ctx, (tx) => tx.update(classificationRules).set(patch).where(eq(classificationRules.id, id)));
  return getRule(ctx, id);
}

/** Regras são arquivadas (as linhas classificadas por elas guardam o histórico). */
export async function archiveRule(ctx: ServiceContext, id: string) {
  await loadRule(ctx, id);
  await withTx(ctx, (tx) =>
    tx
      .update(classificationRules)
      .set({ archivedAt: sql`now()` as unknown as string })
      .where(and(eq(classificationRules.id, id), isNull(classificationRules.archivedAt))),
  );
  return { deleted: false, archived: true };
}

/**
 * Reaplica as regras do alvo às linhas novas (spec 009), para regras criadas ou
 * editadas depois do import. Só mexe nas sem classificação ou classificadas
 * por regra: a do usuário e a sugestão do agente pendente ficam. Lotes
 * substituídos (spec 031) são somente leitura e ficam de fora.
 */
async function applyRulesTo(tx: Tx, target: RuleTarget, where: SQL): Promise<number> {
  const lines = await tx.execute<{
    id: string;
    description: string;
    amount_cents: string | number;
    entity_id: string | null;
    category_id: string | null;
    classification_rule_id: string | null;
  }>(sql`
    SELECT l.id, l.description, l.amount_cents, l.entity_id, l.category_id, l.classification_rule_id
      FROM statement_lines l
      JOIN statement_imports i ON i.id = l.statement_import_id
     WHERE ${where} AND i.superseded_by_import_id IS NULL
       AND l.status = 'new' AND (l.classification_source IS NULL OR l.classification_source = 'rule')
     ORDER BY l.posted_on, l.line_number
       FOR UPDATE OF l`);
  const usage = new Map<string, number>();
  let updated = 0;
  for (const line of lines.rows) {
    const rule = await ruleFor(tx, target, line.description, Number(line.amount_cents));
    const next = { entityId: rule?.entityId ?? null, categoryId: rule?.categoryId ?? null, ruleId: rule?.id ?? null };
    if (next.ruleId === line.classification_rule_id && next.entityId === line.entity_id && next.categoryId === line.category_id) continue;
    await tx
      .update(statementLines)
      .set({
        entityId: next.entityId,
        categoryId: next.categoryId,
        classificationRuleId: next.ruleId,
        classificationSource: rule ? 'rule' : null,
      })
      .where(eq(statementLines.id, line.id));
    updated += 1;
    if (rule) usage.set(rule.id, (usage.get(rule.id) ?? 0) + 1);
  }
  for (const [ruleId, count] of usage) {
    await tx.execute(sql`UPDATE classification_rules SET usage_count = usage_count + ${count}, last_used_at = now() WHERE id = ${ruleId}`);
  }
  return updated;
}

/** "Aplicar regras" no detalhe do lote (conta ou fatura do cartão), com as regras da conta dele. */
export async function applyRulesToImport(ctx: ServiceContext, importId: string): Promise<ApplyRulesResult> {
  const result = await ctx.db.execute<{ caixa_id: string; financial_account_id: string | null; card_caixa_id: string | null }>(sql`
    SELECT coalesce(a.caixa_id, i.card_caixa_id) AS caixa_id, i.financial_account_id, i.card_caixa_id
      FROM statement_imports i LEFT JOIN financial_accounts a ON a.id = i.financial_account_id WHERE i.id = ${importId}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  ctx.access.assertWrite(row.caixa_id);
  const target = { accountId: row.financial_account_id, cardCaixaId: row.financial_account_id ? null : row.card_caixa_id };
  const updated = await withTx(ctx, (tx) => applyRulesTo(tx, target, sql`l.statement_import_id = ${importId}`));
  return { updated };
}

/** "Aplicar regras" na guia Regras: as linhas novas de todos os lotes da conta (ou do cartão) escolhida. */
export async function applyRulesToAccount(
  ctx: ServiceContext,
  ref: { accountId?: string | null; cardCaixaId?: string | null },
): Promise<ApplyRulesResult> {
  const target = await resolveRuleTarget(ctx, ref, true);
  const where = target.accountId ? sql`l.financial_account_id = ${target.accountId}` : sql`l.card_caixa_id = ${target.cardCaixaId}`;
  const updated = await withTx(ctx, (tx) => applyRulesTo(tx, target, where));
  return { updated };
}

/* ---------------- copiar regras entre contas (spec 032) ---------------- */

const ruleKey = (r: { matchKind: string; pattern: string; direction: string | null }) =>
  `${r.matchKind}|${r.pattern.toLowerCase()}|${r.direction ?? ''}`;

export type RuleCopyPlan = {
  target: ResolvedRuleTarget;
  /** As regras de origem pedidas, na ordem do pedido. */
  sources: ClassificationRuleRow[];
  toCopy: ClassificationRuleRow[];
  skipped: CopyRulesSkipped[];
};

/**
 * O que a cópia faria: as regras de origem (de contas legíveis), as puladas
 * (arquivadas ou já existentes no destino por tipo + padrão + direção, inclusive
 * repetidas na própria seleção) e as que entram. Usado pela prévia da tool.
 */
export async function planRuleCopy(
  ctx: ServiceContext,
  input: z.output<typeof copyRulesInput>,
  db: Executor = ctx.db,
): Promise<RuleCopyPlan> {
  const target = await resolveRuleTarget(ctx, input, true, db);
  const ids = [...new Set(input.ruleIds.map((id) => id.toLowerCase()))];
  const found = await db.execute(sql`${ruleSql} WHERE r.id = ANY(${uuidArray(ids)})`);
  const sources = found.rows.map((row) => toRule(ctx, row));
  for (const id of ids) {
    const source = sources.find((r) => r.id === id);
    if (!source || !ctx.access.canRead(source.caixaId)) throw notFound();
  }
  const existing = await db.execute<{ id: string; match_kind: string; pattern: string; direction: string | null }>(sql`
    SELECT id, match_kind, pattern, direction FROM classification_rules
     WHERE archived_at IS NULL AND caixa_id = ${target.caixaId}
       AND financial_account_id IS NOT DISTINCT FROM ${target.accountId}::uuid`);
  const taken = new Map<string, string | null>(
    existing.rows.map((r) => [ruleKey({ matchKind: r.match_kind, pattern: r.pattern, direction: r.direction }), r.id]),
  );
  const toCopy: ClassificationRuleRow[] = [];
  const skipped: CopyRulesSkipped[] = [];
  for (const id of ids) {
    const source = sources.find((r) => r.id === id)!;
    const base = { ruleId: source.id, pattern: source.pattern, matchKind: source.matchKind };
    if (source.archivedAt) {
      skipped.push({ ...base, reason: 'archived', existingRuleId: null });
      continue;
    }
    const key = ruleKey(source);
    if (taken.has(key)) {
      skipped.push({ ...base, reason: 'exists', existingRuleId: taken.get(key) ?? null });
      continue;
    }
    taken.set(key, null);
    toCopy.push(source);
  }
  return { target, sources: ids.map((id) => sources.find((r) => r.id === id)!), toCopy, skipped };
}

/** Copia as regras escolhidas para a conta (ou cartão) de destino numa transação só; as puladas voltam com o motivo. */
export async function copyRules(ctx: ServiceContext, input: z.output<typeof copyRulesInput>): Promise<CopyRulesResult> {
  const { ids, skipped } = await withTx(ctx, async (tx) => {
    const plan = await planRuleCopy(ctx, input, tx);
    const created: string[] = [];
    for (const rule of plan.toCopy) {
      const [row] = await tx
        .insert(classificationRules)
        .values({
          caixaId: plan.target.caixaId,
          financialAccountId: plan.target.accountId,
          matchKind: rule.matchKind,
          pattern: rule.pattern,
          direction: rule.direction,
          entityId: rule.entityId,
          categoryId: rule.categoryId,
          priority: rule.priority,
          origin: 'copy',
          copiedFromRuleId: rule.id,
          createdByUserId: ctx.access.actor.id,
        })
        .returning({ id: classificationRules.id });
      created.push(row!.id);
    }
    return { ids: created, skipped: plan.skipped };
  });
  return { copied: await getRules(ctx, ids), skipped, hint: t.statements.copyHint };
}

/* ---------------- sugestões do agente (spec 009/011) ---------------- */

/**
 * Grava a sugestão do agente (entidade/categoria) nas linhas ainda sem
 * classificação (nem regra, nem do usuário): ficam como "sugerido pelo
 * agente" até o usuário aprovar ou descartar em lote. Linhas já classificadas,
 * conciliadas ou ignoradas são puladas.
 */
export async function suggestClassifications(
  ctx: ServiceContext,
  suggestions: { lineId: string; entityId?: string | null; categoryId?: string | null }[],
) {
  let updated = 0;
  const skipped: string[] = [];
  await withTx(ctx, async (tx) => {
    for (const s of suggestions) {
      const line = await loadLine(ctx, tx, s.lineId);
      const free = line.classificationSource === null || line.classificationSource === 'agent';
      if (!free || line.status === 'matched' || line.status === 'ignored' || (!s.entityId && !s.categoryId)) {
        skipped.push(s.lineId);
        continue;
      }
      if (s.entityId) {
        const found = await tx.execute(sql`SELECT 1 FROM entities WHERE id = ${s.entityId}`);
        if (found.rows.length === 0) throw notFound();
      }
      const categoryId = s.categoryId && (await categoryFits(tx, s.categoryId, line)) ? s.categoryId : null;
      await tx
        .update(statementLines)
        .set({ entityId: s.entityId ?? null, categoryId, classificationSource: 'agent', classificationRuleId: null })
        .where(eq(statementLines.id, line.id));
      updated += 1;
    }
  });
  return { updated, skipped };
}

/** Aprova (vira classificação do usuário) ou descarta (limpa) as sugestões do agente. */
export async function decideSuggestions(ctx: ServiceContext, lineIds: string[], decision: 'approve' | 'reject') {
  let updated = 0;
  await withTx(ctx, async (tx) => {
    for (const lineId of lineIds) {
      const line = await loadLine(ctx, tx, lineId);
      if (line.classificationSource !== 'agent') continue;
      await tx
        .update(statementLines)
        .set(
          decision === 'approve'
            ? { classificationSource: 'user' }
            : { classificationSource: null, entityId: null, categoryId: null, classificationRuleId: null },
        )
        .where(eq(statementLines.id, line.id));
      updated += 1;
    }
  });
  return { updated };
}
