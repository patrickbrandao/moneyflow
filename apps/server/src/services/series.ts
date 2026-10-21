import type { Executor, Tx } from '@moneyflow/db';
import {
  type AmendmentPreview,
  dayOfMonth,
  type Frequency,
  isoWeekday,
  type ObligationNext,
  occurrenceDueDate,
  occurrenceWithinRule,
  type RecurrenceRule,
  readjustedTotal,
  type SeriesChangeRow,
  type SeriesChangeSkipped,
  type SeriesDto,
  type SeriesEndPreview,
  type SeriesTerms,
  type seriesCreateInput,
  type seriesUpdateInput,
  t,
  todayIso,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { readableFilter } from './caixas';
import { contractOwner } from './contracts';
import { assertPlannedAccount } from './planned-account';
import { MATERIALIZE_LOCK, materializeRule } from './recurrence';
import { uuidArray } from './reports';
import { assertTolerance, TERMS_SQL, termsColumns, termsOf } from './series-core';
import { insertTitlePair, type MirrorPlan, opposite } from './title-pair';
import { applySeriesEnd, defaultMirrorCategory, resolveMirror, seriesEndPlanOf } from './titles';
import { withTx } from './tx';
import { camel } from './util';

/*
 * Séries recorrentes com conta, cartão e ajustes (spec 034). Numa caixa geral
 * a série gera títulos (ocorrências materializadas pelo worker, com a conta
 * prevista); na caixa de um cartão é uma cobrança esperada
 * (card_recurring_charges), sem títulos: a compra ligada à ocorrência é o
 * fato. A série pode ser obrigação de um contrato (contract_id). Os ajustes de
 * reconhecimento valem para toda série. Toda escrita passa por withTx.
 */

const E = t.contracts.errors;
type Direction = 'payable' | 'receivable';

export type RuleRecord = RecurrenceRule & {
  id: string;
  caixaId: string;
  caixaKind: string;
  contractId: string | null;
  frequency: Frequency;
  terms: SeriesTerms;
  card: { payerCaixaId: string; entityId: string; categoryId: string; description: string; amountCents: number } | null;
};

export async function loadRule(db: Executor, id: string, lock = false): Promise<RuleRecord> {
  if (lock) await db.execute(sql`SELECT pg_advisory_xact_lock(${MATERIALIZE_LOCK}, hashtext(${id}))`);
  const result = await db.execute(sql`
    SELECT r.id, r.caixa_id, k.kind AS caixa_kind, r.contract_id, r.frequency, r.interval_count, r.anchor_day, r.starts_on, r.ends_on,
           r.installments_total, ${TERMS_SQL},
           g.payer_caixa_id, g.entity_id AS card_entity_id, g.category_id AS card_category_id, g.description AS card_description,
           g.amount_cents AS card_amount_cents
      FROM recurrence_rules r
      JOIN caixas k ON k.id = r.caixa_id
      LEFT JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
     WHERE r.id = ${id} ${lock ? sql`FOR UPDATE OF r` : sql``}`);
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  if (!raw) throw notFound();
  const r = camel<Record<string, unknown>>(raw);
  return {
    id: String(r.id),
    caixaId: String(r.caixaId),
    caixaKind: String(r.caixaKind),
    contractId: (r.contractId as string | null) ?? null,
    frequency: r.frequency as Frequency,
    intervalCount: Number(r.intervalCount),
    anchorDay: Number(r.anchorDay),
    startsOn: String(r.startsOn),
    endsOn: (r.endsOn as string | null) ?? null,
    installmentsTotal: r.installmentsTotal === null ? null : Number(r.installmentsTotal),
    terms: termsOf(raw as Parameters<typeof termsOf>[0]),
    card: r.payerCaixaId
      ? {
          payerCaixaId: String(r.payerCaixaId),
          entityId: String(r.cardEntityId),
          categoryId: String(r.cardCategoryId),
          description: String(r.cardDescription),
          amountCents: Number(r.cardAmountCents),
        }
      : null,
  };
}

/* ---------------- leitura ---------------- */

const seriesSelect = sql`
  r.id, r.caixa_id, k.name AS caixa_name, k.kind AS caixa_kind, r.contract_id, ct.name AS contract_name, r.frequency, r.interval_count,
  r.anchor_day, r.starts_on, r.ends_on, r.installments_total, ${TERMS_SQL},
  tpl.id AS tpl_id, tpl.occurrence AS tpl_occurrence, tpl.due_date AS tpl_due_date, tpl.is_open AS tpl_open, tpl.direction AS tpl_direction,
  tpl.description AS tpl_description, tpl.entity_id AS tpl_entity_id, te.name AS tpl_entity_name, tpl.category_id AS tpl_category_id,
  tc.name AS tpl_category_name, tpl.amount_cents AS tpl_amount_cents, tpl.planned_account_id, pa.name AS account_name, pa.kind AS account_kind,
  coalesce(cnt.open_count, 0) AS open_count, coalesce(cnt.overdue_count, 0) AS overdue_count, coalesce(cnt.without_account, 0) AS without_account,
  g.payer_caixa_id, pk.name AS payer_caixa_name, g.entity_id AS card_entity_id, ge.name AS card_entity_name, g.category_id AS card_category_id,
  gc.name AS card_category_name, g.description AS card_description`;

const seriesFrom = (today: string) => sql`
  FROM recurrence_rules r
  JOIN caixas k ON k.id = r.caixa_id
  LEFT JOIN contracts ct ON ct.id = r.contract_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.occurrence, x.due_date, x.direction, x.description, x.entity_id, x.category_id, x.amount_cents, x.planned_account_id,
           (x.status IN ('open', 'partial')) AS is_open
      FROM titles x
     WHERE x.recurrence_rule_id = r.id AND x.mirror_status IS NULL AND x.archived_at IS NULL AND x.occurrence IS NOT NULL
     ORDER BY (x.status IN ('open', 'partial')) DESC,
              CASE WHEN x.status IN ('open', 'partial') THEN x.occurrence ELSE -x.occurrence END
     LIMIT 1) tpl ON true
  LEFT JOIN entities te ON te.id = tpl.entity_id
  LEFT JOIN categories tc ON tc.id = tpl.category_id
  LEFT JOIN financial_accounts pa ON pa.id = tpl.planned_account_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS open_count,
           count(*) FILTER (WHERE x.due_date < ${today}::date)::int AS overdue_count,
           count(*) FILTER (WHERE x.planned_account_id IS NULL)::int AS without_account
      FROM titles x
     WHERE x.recurrence_rule_id = r.id AND x.mirror_status IS NULL AND x.archived_at IS NULL AND x.status IN ('open', 'partial')) cnt ON true
  LEFT JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
  LEFT JOIN caixas pk ON pk.id = g.payer_caixa_id
  LEFT JOIN entities ge ON ge.id = g.entity_id
  LEFT JOIN categories gc ON gc.id = g.category_id`;

/** Primeira ocorrência esperada a partir de `from` (cobrança no cartão, calculada pelo calendário), ou null. */
export function nextExpectedOccurrence(rule: RecurrenceRule, from: string): { occurrence: number; dueDate: string } | null {
  for (let n = 1; n <= 5000; n += 1) {
    if (!occurrenceWithinRule(rule, n)) return null;
    const dueDate = occurrenceDueDate(rule, n);
    if (dueDate >= from) return { occurrence: n, dueDate };
  }
  return null;
}

async function cardAmount(db: Executor, ruleId: string, occurrence: number): Promise<number> {
  const result = await db.execute<{ amount: string | number }>(
    sql`SELECT card_recurring_charge_amount(${ruleId}::uuid, ${occurrence}::int) AS amount`,
  );
  return Number(result.rows[0]?.amount ?? 0);
}

async function toSeries(ctx: ServiceContext, db: Executor, raw: Record<string, unknown>, today: string): Promise<SeriesDto> {
  const r = camel<Record<string, unknown>>(raw);
  const rule: RecurrenceRule = {
    frequency: r.frequency as Frequency,
    intervalCount: Number(r.intervalCount),
    anchorDay: Number(r.anchorDay),
    startsOn: String(r.startsOn),
    endsOn: (r.endsOn as string | null) ?? null,
    installmentsTotal: r.installmentsTotal === null ? null : Number(r.installmentsTotal),
  };
  const isCard = r.caixaKind === 'credit_card';
  let next: ObligationNext | null = null;
  let amountCents = Number(r.tplAmountCents ?? 0);
  if (isCard) {
    const expected = nextExpectedOccurrence(rule, today);
    const n = expected?.occurrence ?? 1;
    amountCents = await cardAmount(db, String(r.id), n);
    if (expected)
      next = {
        ruleId: String(r.id),
        occurrence: expected.occurrence,
        dueDate: expected.dueDate,
        amountCents,
        titleId: null,
        description: String(r.cardDescription),
      };
  } else if (r.tplId && r.tplOpen) {
    next = {
      ruleId: String(r.id),
      occurrence: Number(r.tplOccurrence),
      dueDate: String(r.tplDueDate),
      amountCents,
      titleId: String(r.tplId),
      description: String(r.tplDescription),
    };
  }
  return {
    id: String(r.id),
    kind: isCard ? 'card' : 'account',
    caixaId: String(r.caixaId),
    caixaName: String(r.caixaName),
    contractId: (r.contractId as string | null) ?? null,
    contractName: (r.contractName as string | null) ?? null,
    direction: isCard ? 'payable' : ((r.tplDirection as Direction | null) ?? 'payable'),
    description: String((isCard ? r.cardDescription : r.tplDescription) ?? ''),
    entityId: String((isCard ? r.cardEntityId : r.tplEntityId) ?? ''),
    entityName: String((isCard ? r.cardEntityName : r.tplEntityName) ?? ''),
    categoryId: String((isCard ? r.cardCategoryId : r.tplCategoryId) ?? ''),
    categoryName: String((isCard ? r.cardCategoryName : r.tplCategoryName) ?? ''),
    ...rule,
    endsOn: rule.endsOn ?? null,
    installmentsTotal: rule.installmentsTotal ?? null,
    amountCents,
    accountId: isCard ? null : ((r.plannedAccountId as string | null) ?? null),
    accountName: isCard ? null : ((r.accountName as string | null) ?? null),
    accountKind: isCard ? null : ((r.accountKind as SeriesDto['accountKind']) ?? null),
    payerCaixaId: (r.payerCaixaId as string | null) ?? null,
    payerCaixaName: (r.payerCaixaName as string | null) ?? null,
    terms: termsOf(raw as Parameters<typeof termsOf>[0]),
    next,
    openCount: Number(r.openCount),
    overdueCount: Number(r.overdueCount),
    withoutAccount: Number(r.withoutAccount),
    canWrite: ctx.access.canWrite(String(r.caixaId)),
  };
}

/** Séries pelo filtro, só das caixas legíveis (a série é da caixa dela). */
export async function seriesWhere(ctx: ServiceContext, db: Executor, where: SQL): Promise<SeriesDto[]> {
  const today = todayIso();
  const result = await db.execute(sql`
    SELECT ${seriesSelect} ${seriesFrom(today)}
     WHERE ${readableFilter(ctx.access, sql`r.caixa_id`)} AND ${where}
     ORDER BY r.ends_on IS NOT NULL AND r.ends_on < ${today}::date, r.created_at, r.id`);
  const out: SeriesDto[] = [];
  for (const raw of result.rows) out.push(await toSeries(ctx, db, raw as Record<string, unknown>, today));
  return out;
}

export async function getSeries(ctx: ServiceContext, id: string): Promise<SeriesDto> {
  const [row] = await seriesWhere(ctx, ctx.db, sql`r.id = ${id}`);
  if (!row) throw notFound();
  return row;
}

/** Séries de uma caixa (as soltas, para ligar a um contrato, ou as de um contrato). */
export async function listSeries(
  ctx: ServiceContext,
  query: { caixaId?: string; contractId?: string; unlinked?: boolean; entityId?: string },
): Promise<SeriesDto[]> {
  if (query.caixaId) ctx.access.assertRead(query.caixaId);
  const where: SQL[] = [sql`true`];
  if (query.caixaId) where.push(sql`r.caixa_id = ${query.caixaId}`);
  if (query.contractId) where.push(sql`r.contract_id = ${query.contractId}`);
  if (query.unlinked) where.push(sql`r.contract_id IS NULL AND r.installments_total IS NULL`);
  if (query.entityId)
    where.push(sql`coalesce((SELECT x.entity_id FROM titles x WHERE x.recurrence_rule_id = r.id AND x.mirror_status IS NULL
      ORDER BY x.occurrence DESC LIMIT 1), (SELECT g.entity_id FROM card_recurring_charges g WHERE g.recurrence_rule_id = r.id)) = ${query.entityId}`);
  return seriesWhere(ctx, ctx.db, sql.join(where, sql` AND `));
}

/* ---------------- obrigação nova ---------------- */

/** O dono da série: o contrato (direção, contraparte, categoria padrão, espelho, fim) ou a série solta. */
export type SeriesOwner = {
  contractId: string | null;
  direction: Direction;
  entityId: string;
  categoryId: string | null;
  /** Caixa do espelho (do contrato); undefined = a principal da entidade (série solta). */
  mirrorCaixaId: string | null | undefined;
  /** Fim padrão (o da vigência). */
  endsOn: string | null;
};

type ObligationInput = z.output<typeof seriesCreateInput>;

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

async function holderOf(tx: Executor, caixaId: string): Promise<string> {
  const result = await tx.execute<{ holder_entity_id: string }>(sql`SELECT holder_entity_id FROM caixas WHERE id = ${caixaId}`);
  const holder = result.rows[0]?.holder_entity_id;
  if (!holder) throw notFound();
  return holder;
}

/**
 * Cria a série (numa transação aberta): na conta, a regra na caixa da conta e
 * a primeira ocorrência (com a conta prevista e o espelho), materializando até
 * o horizonte; no cartão, a regra no cartão e a cobrança esperada. Devolve o id.
 */
export async function insertObligation(
  ctx: ServiceContext,
  tx: Tx,
  input: Omit<ObligationInput, 'contractId' | 'entityId' | 'direction'>,
  owner: SeriesOwner,
): Promise<string> {
  const categoryId = input.categoryId ?? owner.categoryId;
  if (!categoryId) throw unprocessable(E.seriesCategory);
  const endsOn = input.endsOn === undefined ? owner.endsOn : input.endsOn;
  assertTolerance(input.toleranceCents, input.amountCents);
  const calendar = {
    frequency: input.frequency,
    intervalCount: input.intervalCount,
    anchorDay: input.frequency === 'weekly' ? isoWeekday(input.firstDueDate) : dayOfMonth(input.firstDueDate),
    startsOn: input.firstDueDate,
    endsOn,
  };
  const terms = termsColumns(input);

  if (input.kind === 'card') {
    if (owner.direction !== 'payable') throw unprocessable(E.obligationCardPayable, 'card_recurring_charges_contract_check');
    const card = await tx.execute<{ kind: string; default_payer_caixa_id: string | null }>(
      sql`SELECT kind, default_payer_caixa_id FROM caixas WHERE id = ${input.cardCaixaId}`,
    );
    const row = card.rows[0];
    if (!row) throw notFound();
    if (row.kind !== 'credit_card') throw unprocessable(E.obligationCard, 'recurrence_rules_target_check');
    ctx.access.assertWrite(input.cardCaixaId!);
    const payerCaixaId = input.payerCaixaId ?? row.default_payer_caixa_id;
    if (!payerCaixaId) throw unprocessable(t.errors.validation);
    ctx.access.assertRead(payerCaixaId);
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO recurrence_rules (frequency, interval_count, anchor_day, starts_on, ends_on, caixa_id, contract_id,
                                    match_window_days, late_fee_percent, interest_month_percent, early_discount_percent,
                                    tolerance_cents, auto_settle)
      VALUES (${calendar.frequency}, ${calendar.intervalCount}, ${calendar.anchorDay}, ${calendar.startsOn}::date, ${endsOn}::date,
              ${input.cardCaixaId}, ${owner.contractId}, ${input.matchWindowDays}, ${terms.lateFeePercent ?? null},
              ${terms.interestMonthPercent ?? null}, ${terms.earlyDiscountPercent ?? null}, ${input.toleranceCents}, ${input.autoSettle})
      RETURNING id`);
    const ruleId = inserted.rows[0]!.id;
    await tx.execute(sql`
      INSERT INTO card_recurring_charges (recurrence_rule_id, payer_caixa_id, entity_id, category_id, description, amount_cents)
      VALUES (${ruleId}, ${payerCaixaId}, ${owner.entityId}, ${categoryId}, ${input.description}, ${input.amountCents})`);
    return ruleId;
  }

  const account = await tx.execute<{ caixa_id: string; kind: string; archived_at: string | null }>(
    sql`SELECT caixa_id, kind, archived_at FROM financial_accounts WHERE id = ${input.accountId}`,
  );
  const acc = account.rows[0];
  if (!acc) throw notFound();
  if (!['checking', 'savings', 'cash'].includes(acc.kind)) throw unprocessable(E.obligationAccountKind);
  ctx.access.assertWrite(acc.caixa_id);
  const holder = await holderOf(tx, acc.caixa_id);
  if (holder === owner.entityId) throw unprocessable(E.obligationAccountHolder, 'contracts_entity_check');

  // O espelho do contrato (na caixa da contraparte), ou, na série solta, o de sempre (a principal da entidade).
  let mirror: MirrorPlan | null = null;
  if (owner.mirrorCaixaId === undefined) {
    mirror = await resolveMirror(
      ctx,
      tx,
      { caixaId: acc.caixa_id, direction: owner.direction, entityId: owner.entityId, mirrorCaixaId: undefined, mirrorCategoryId: null },
      holder,
    );
  } else if (owner.mirrorCaixaId && owner.mirrorCaixaId !== acc.caixa_id) {
    const direction = opposite(owner.direction);
    mirror = {
      caixaId: owner.mirrorCaixaId,
      entityId: holder,
      categoryId: await defaultMirrorCategory(tx, owner.mirrorCaixaId, direction),
      status: ctx.access.canWrite(owner.mirrorCaixaId) ? 'accepted' : 'pending',
    };
  }

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO recurrence_rules (frequency, interval_count, anchor_day, starts_on, ends_on, caixa_id, contract_id,
                                  match_window_days, late_fee_percent, interest_month_percent, early_discount_percent,
                                  tolerance_cents, auto_settle)
    VALUES (${calendar.frequency}, ${calendar.intervalCount}, ${calendar.anchorDay}, ${calendar.startsOn}::date, ${endsOn}::date,
            ${acc.caixa_id}, ${owner.contractId}, ${input.matchWindowDays}, ${terms.lateFeePercent ?? null},
            ${terms.interestMonthPercent ?? null}, ${terms.earlyDiscountPercent ?? null}, ${input.toleranceCents}, ${input.autoSettle})
    RETURNING id`);
  const ruleId = inserted.rows[0]!.id;
  await insertTitlePair(
    tx,
    {
      caixaId: acc.caixa_id,
      direction: owner.direction,
      entityId: owner.entityId,
      categoryId,
      description: input.description,
      competenceDate: input.firstCompetenceDate ?? monthStart(input.firstDueDate),
      dueDate: input.firstDueDate,
      amountCents: input.amountCents,
      notes: null,
      origin: 'recurrence',
      recurrenceRuleId: ruleId,
      occurrence: 1,
      contractId: owner.contractId,
      plannedAccountId: input.accountId,
    },
    mirror,
  );
  await materializeRule(tx, ruleId);
  return ruleId;
}

/** Série nova pela API (POST /api/series): ligada a um contrato ou solta. */
export async function createSeries(ctx: ServiceContext, input: z.output<typeof seriesCreateInput>): Promise<SeriesDto> {
  const id = await withTx(ctx, async (tx) => {
    if (input.contractId) {
      return insertObligation(ctx, tx, input, await contractOwner(ctx, tx, input.contractId));
    }
    return insertObligation(ctx, tx, input, {
      contractId: null,
      direction: input.kind === 'card' ? 'payable' : (input.direction ?? 'payable'),
      entityId: input.entityId!,
      categoryId: input.categoryId,
      mirrorCaixaId: undefined,
      endsOn: null,
    });
  });
  return getSeries(ctx, id);
}

/* ---------------- ligar ao contrato ---------------- */

/**
 * Liga (ou, com contrato null, desliga) a série e o que é dela — os títulos
 * (os dois lados) e as compras ligadas — numa transação aberta. O banco confere
 * direção e contraparte (titles_contract_match_check) e o rascunho.
 */
export async function setSeriesContract(
  tx: Tx,
  rule: RuleRecord,
  contract: { id: string; direction: Direction; entityId: string } | null,
): Promise<void> {
  if (contract) {
    if (rule.contractId && rule.contractId !== contract.id) throw unprocessable(E.seriesLinked);
    if (rule.installmentsTotal !== null) throw unprocessable(E.seriesInstallments);
    const tpl = await tx.execute<{ direction: string; entity_id: string }>(sql`
      SELECT direction, entity_id FROM titles WHERE recurrence_rule_id = ${rule.id} AND mirror_status IS NULL
       ORDER BY occurrence DESC LIMIT 1`);
    const side = rule.card ? { direction: 'payable', entity_id: rule.card.entityId } : tpl.rows[0];
    if (side && (side.direction !== contract.direction || side.entity_id !== contract.entityId))
      throw unprocessable(E.seriesLinkMismatch, 'titles_contract_match_check');
  }
  const contractId = contract?.id ?? null;
  await tx.execute(sql`UPDATE recurrence_rules SET contract_id = ${contractId} WHERE id = ${rule.id}`);
  await tx.execute(sql`UPDATE titles SET contract_id = ${contractId} WHERE recurrence_rule_id = ${rule.id}`);
  await tx.execute(sql`UPDATE card_purchases SET contract_id = ${contractId} WHERE recurrence_rule_id = ${rule.id}`);
}

/* ---------------- "esta e as próximas" ---------------- */

export type SeriesChange = {
  description?: string;
  amountCents?: number | null;
  readjustmentPercent?: number | null;
  anchorDay?: number | null;
  categoryId?: string | null;
  accountId?: string | null;
  payerCaixaId?: string | null;
};

type OccurrenceState = {
  id: string;
  occurrence: number;
  mirrorTitleId: string | null;
  mirrorCaixaId: string | null;
  mirrorStatus: string | null;
  competenceDate: string;
  dueDate: string;
  amountCents: number;
  status: string;
  caixaId: string;
};

export type SeriesChangePlan = {
  affected: SeriesChangeRow[];
  skipped: SeriesChangeSkipped[];
  cardFrom: AmendmentPreview['cardFrom'];
  /** Antes → depois das propriedades da série (o modelo atual). */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  apply: (tx: Tx) => Promise<void>;
};

/** Meses (1º dia) fechados nas caixas, entre as competências pedidas. */
export async function closedMonths(db: Executor, caixaIds: (string | null)[], competences: string[]): Promise<Set<string>> {
  const ids = caixaIds.filter((id): id is string => Boolean(id));
  const months = [...new Set(competences.map(monthStart))];
  if (ids.length === 0 || months.length === 0) return new Set();
  const result = await db.execute<{ month: string }>(sql`
    SELECT DISTINCT to_char(month, 'YYYY-MM-DD') AS month FROM period_closings
     WHERE caixa_id = ANY (${uuidArray(ids)}) AND month = ANY (${`{${months.join(',')}}`}::date[])`);
  return new Set(result.rows.map((r) => r.month));
}

async function occurrences(tx: Executor, ruleId: string, lock: boolean): Promise<OccurrenceState[]> {
  const result = await tx.execute(sql`
    SELECT x.id, x.occurrence, x.mirror_title_id, m.caixa_id AS mirror_caixa_id, m.mirror_status, x.competence_date, x.due_date,
           x.amount_cents, x.status, x.caixa_id
      FROM titles x LEFT JOIN titles m ON m.id = x.mirror_title_id
     WHERE x.recurrence_rule_id = ${ruleId} AND x.mirror_status IS NULL AND x.occurrence IS NOT NULL
     ORDER BY x.occurrence
     ${lock ? sql`FOR UPDATE OF x` : sql``}`);
  return result.rows.map((raw) => {
    const r = camel<OccurrenceState>(raw);
    return { ...r, occurrence: Number(r.occurrence), amountCents: Number(r.amountCents) };
  });
}

/** Grava valor/vencimento/categoria/descrição/conta no título e mantém o par (o espelho volta a aguardar aceite sem permissão lá). */
export async function patchOccurrence(
  ctx: ServiceContext,
  tx: Tx,
  row: Pick<OccurrenceState, 'id' | 'mirrorTitleId' | 'mirrorCaixaId' | 'mirrorStatus'>,
  patch: {
    amountCents?: number;
    dueDate?: string;
    categoryId?: string;
    description?: string;
    plannedAccountId?: string;
    status?: 'canceled';
  },
) {
  const sets: SQL[] = [];
  if (patch.amountCents !== undefined) sets.push(sql`amount_cents = ${patch.amountCents}`);
  if (patch.dueDate !== undefined) sets.push(sql`due_date = ${patch.dueDate}::date`);
  if (patch.categoryId !== undefined) sets.push(sql`category_id = ${patch.categoryId}`);
  if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
  if (patch.plannedAccountId !== undefined) sets.push(sql`planned_account_id = ${patch.plannedAccountId}, planned_account_custom = false`);
  if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
  if (sets.length === 0) return;
  await tx.execute(sql`UPDATE titles SET ${sql.join(sets, sql`, `)} WHERE id = ${row.id}`);
  if (!row.mirrorTitleId) return;
  const mirrorSets: SQL[] = [];
  if (patch.amountCents !== undefined) mirrorSets.push(sql`amount_cents = ${patch.amountCents}`);
  if (patch.dueDate !== undefined) mirrorSets.push(sql`due_date = ${patch.dueDate}::date`);
  if (patch.status !== undefined) mirrorSets.push(sql`status = ${patch.status}`);
  const valueChanged = patch.amountCents !== undefined || patch.dueDate !== undefined;
  if (valueChanged && row.mirrorStatus !== null && row.mirrorCaixaId && !ctx.access.canWrite(row.mirrorCaixaId))
    mirrorSets.push(sql`mirror_status = 'pending'`);
  if (mirrorSets.length > 0) await tx.execute(sql`UPDATE titles SET ${sql.join(mirrorSets, sql`, `)} WHERE id = ${row.mirrorTitleId}`);
}

/**
 * Plano de "esta e as próximas" numa série a partir de `effectiveOn`: na
 * conta, as ocorrências em aberto sem baixa com vencimento na data ou depois
 * mudam (as com baixa ou em mês fechado ficam, na lista dos puladas); no
 * cartão, o valor esperado muda a partir da primeira ocorrência na data.
 */
export async function planSeriesChange(
  ctx: ServiceContext,
  tx: Executor,
  rule: RuleRecord,
  change: SeriesChange,
  effectiveOn: string,
  lock: boolean,
): Promise<SeriesChangePlan> {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const newAmount = (current: number) =>
    change.amountCents ? change.amountCents : change.readjustmentPercent ? readjustedTotal(current, change.readjustmentPercent) : current;
  const anchorChanged = change.anchorDay != null && change.anchorDay !== rule.anchorDay;
  const newRule: RecurrenceRule = { ...rule, anchorDay: anchorChanged ? change.anchorDay! : rule.anchorDay };
  if (anchorChanged) {
    before.anchorDay = rule.anchorDay;
    after.anchorDay = change.anchorDay;
  }

  if (rule.card) {
    const card = rule.card;
    const expected = nextExpectedOccurrence(rule, effectiveOn);
    const cardFrom: AmendmentPreview['cardFrom'] = [];
    let amountFrom: { n: number; cents: number } | null = null;
    if (expected && (change.amountCents || change.readjustmentPercent)) {
      const current = await cardAmount(tx, rule.id, expected.occurrence);
      const cents = newAmount(current);
      before.amountCents = current;
      after.amountCents = cents;
      if (cents !== current) {
        amountFrom = { n: expected.occurrence, cents };
        cardFrom.push({ ruleId: rule.id, fromOccurrence: expected.occurrence, beforeCents: current, afterCents: cents });
      }
    }
    if (change.categoryId && change.categoryId !== card.categoryId) {
      before.categoryId = card.categoryId;
      after.categoryId = change.categoryId;
    }
    if (change.payerCaixaId && change.payerCaixaId !== card.payerCaixaId) {
      ctx.access.assertRead(change.payerCaixaId);
      before.payerCaixaId = card.payerCaixaId;
      after.payerCaixaId = change.payerCaixaId;
    }
    if (change.description && change.description !== card.description) {
      before.description = card.description;
      after.description = change.description;
    }
    return {
      affected: [],
      skipped: [],
      cardFrom,
      before,
      after,
      apply: async (w) => {
        if (amountFrom) {
          if (amountFrom.n === 1) {
            await w.execute(
              sql`UPDATE card_recurring_charges SET amount_cents = ${amountFrom.cents} WHERE recurrence_rule_id = ${rule.id}`,
            );
            await w.execute(sql`DELETE FROM card_recurring_charge_amounts WHERE recurrence_rule_id = ${rule.id}`);
          } else {
            await w.execute(sql`DELETE FROM card_recurring_charge_amounts
              WHERE recurrence_rule_id = ${rule.id} AND from_occurrence >= ${amountFrom.n}`);
            await w.execute(sql`INSERT INTO card_recurring_charge_amounts (recurrence_rule_id, from_occurrence, amount_cents)
              VALUES (${rule.id}, ${amountFrom.n}, ${amountFrom.cents})`);
          }
        }
        const sets: SQL[] = [];
        if (after.categoryId) sets.push(sql`category_id = ${after.categoryId as string}`);
        if (after.payerCaixaId) sets.push(sql`payer_caixa_id = ${after.payerCaixaId as string}`);
        if (after.description) sets.push(sql`description = ${after.description as string}`);
        if (sets.length)
          await w.execute(sql`UPDATE card_recurring_charges SET ${sql.join(sets, sql`, `)} WHERE recurrence_rule_id = ${rule.id}`);
        if (anchorChanged) await w.execute(sql`UPDATE recurrence_rules SET anchor_day = ${change.anchorDay!} WHERE id = ${rule.id}`);
      },
    };
  }

  if (change.accountId) await assertPlannedAccount(tx, rule.caixaId, change.accountId);
  const rows = await occurrences(tx, rule.id, lock);
  const candidates = rows.filter((r) => r.dueDate >= effectiveOn && r.status !== 'canceled');
  const closed = await closedMonths(
    tx,
    [rule.caixaId, ...new Set(candidates.map((r) => r.mirrorCaixaId))],
    candidates.map((r) => r.competenceDate),
  );
  const affected: SeriesChangeRow[] = [];
  const skipped: SeriesChangeSkipped[] = [];
  const updates: { row: OccurrenceState; amountCents: number; dueDate: string }[] = [];
  for (const row of candidates) {
    const reason = row.status !== 'open' ? 'settled' : closed.has(monthStart(row.competenceDate)) ? 'closed_month' : null;
    if (reason) {
      skipped.push({ ruleId: rule.id, titleId: row.id, occurrence: row.occurrence, dueDate: row.dueDate, reason });
      continue;
    }
    const amountCents = newAmount(row.amountCents);
    const dueDate = anchorChanged ? occurrenceDueDate(newRule, row.occurrence) : row.dueDate;
    updates.push({ row, amountCents, dueDate });
    affected.push({
      ruleId: rule.id,
      titleId: row.id,
      occurrence: row.occurrence,
      dueDate: row.dueDate,
      before: { amountCents: row.amountCents, dueDate: row.dueDate },
      after: { amountCents, dueDate },
    });
  }
  const model = updates[0]?.row ?? rows.at(-1);
  if (model && (change.amountCents || change.readjustmentPercent)) {
    before.amountCents = model.amountCents;
    after.amountCents = newAmount(model.amountCents);
  }
  if (change.categoryId) after.categoryId = change.categoryId;
  if (change.accountId) after.accountId = change.accountId;
  if (change.description) after.description = change.description;
  return {
    affected,
    skipped,
    cardFrom: [],
    before,
    after,
    apply: async (w) => {
      for (const u of updates) {
        await patchOccurrence(ctx, w, u.row, {
          amountCents: u.amountCents !== u.row.amountCents ? u.amountCents : undefined,
          dueDate: u.dueDate !== u.row.dueDate ? u.dueDate : undefined,
          categoryId: change.categoryId ?? undefined,
          description: change.description ?? undefined,
          plannedAccountId: change.accountId ?? undefined,
        });
      }
      if (anchorChanged) await w.execute(sql`UPDATE recurrence_rules SET anchor_day = ${change.anchorDay!} WHERE id = ${rule.id}`);
    },
  };
}

/* ---------------- edição pela API ---------------- */

const TERM_KEYS = [
  'matchWindowDays',
  'lateFeePercent',
  'interestMonthPercent',
  'earlyDiscountPercent',
  'toleranceCents',
  'autoSettle',
] as const;

const TERM_COLUMN: Record<(typeof TERM_KEYS)[number], string> = {
  matchWindowDays: 'match_window_days',
  lateFeePercent: 'late_fee_percent',
  interestMonthPercent: 'interest_month_percent',
  earlyDiscountPercent: 'early_discount_percent',
  toleranceCents: 'tolerance_cents',
  autoSettle: 'auto_settle',
};

/**
 * Edição da série: os ajustes valem na hora (com o teto da tolerância); o
 * contrato liga ou desliga; o resto é "esta e as próximas" desde
 * `effectiveOn` (padrão hoje).
 */
export async function updateSeries(ctx: ServiceContext, id: string, input: z.output<typeof seriesUpdateInput>): Promise<SeriesDto> {
  const current = await getSeries(ctx, id);
  ctx.access.assertWrite(current.caixaId);
  await withTx(ctx, async (tx) => {
    const rule = await loadRule(tx, id, true);
    const sets: SQL[] = [];
    for (const key of TERM_KEYS) if (input[key] !== undefined) sets.push(sql`${sql.identifier(TERM_COLUMN[key])} = ${input[key]}`);
    if (input.toleranceCents !== undefined) assertTolerance(input.toleranceCents, input.amountCents ?? current.amountCents);
    if (sets.length > 0) await tx.execute(sql`UPDATE recurrence_rules SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);

    if (input.contractId !== undefined && input.contractId !== rule.contractId) {
      if (input.contractId === null) await setSeriesContract(tx, rule, null);
      else {
        const owner = await contractOwner(ctx, tx, input.contractId);
        await setSeriesContract(tx, rule, { id: input.contractId, direction: owner.direction, entityId: owner.entityId });
      }
    }

    const change: SeriesChange = {
      description: input.description,
      amountCents: input.amountCents,
      anchorDay: input.anchorDay,
      categoryId: input.categoryId,
      accountId: input.accountId,
      payerCaixaId: input.payerCaixaId,
    };
    if (Object.values(change).some((v) => v !== undefined)) {
      const plan = await planSeriesChange(ctx, tx, rule, change, input.effectiveOn ?? todayIso(), true);
      await plan.apply(tx);
    }
  });
  return getSeries(ctx, id);
}

/** Encerrar ou estender a série pela regra (a cobrança no cartão inclusive, que não tem títulos). */
export async function previewSeriesEndRule(ctx: ServiceContext, id: string, endsOn: string | null): Promise<SeriesEndPreview> {
  return (await seriesEndPlanOf(ctx, ctx.db, id, endsOn, false)).preview;
}

export async function endSeriesRule(
  ctx: ServiceContext,
  id: string,
  endsOn: string | null,
): Promise<SeriesEndPreview & { created: number; series: SeriesDto }> {
  const { preview, created } = await withTx(ctx, async (tx) => {
    const plan = await seriesEndPlanOf(ctx, tx, id, endsOn, true);
    return { preview: plan.preview, created: await applySeriesEnd(tx, plan) };
  });
  return { ...preview, created, series: await getSeries(ctx, id) };
}
