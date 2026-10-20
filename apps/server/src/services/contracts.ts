import type { Executor, Tx } from '@moneyflow/db';
import {
  type AmendmentPreview,
  addDays,
  addMonths,
  amendInstallments,
  type ContractCycleBrief,
  type ContractCycleDto,
  type ContractDetail,
  type ContractInstallmentDto,
  type ContractPaymentRow,
  type ContractPaymentsDto,
  type ContractPaymentsSummary,
  type ContractPeriodicity,
  type ContractRow,
  type ContractStatus,
  type ContractTotals,
  type contractAmendmentInput,
  type contractCreateInput,
  type contractDeclineInput,
  type contractListQuery,
  type contractRenewalInput,
  type contractTerminationInput,
  type contractUpdateInput,
  cycleEnd,
  cycleSchedule,
  type DeleteResult,
  formatBRL,
  formatMonth,
  installmentDescription,
  installmentsCount,
  noticeDeadline,
  type PaymentOrigin,
  proratedAmount,
  type ReadjustmentIndex,
  type RecurringPanelDto,
  type RenewalPreview,
  readjustmentDateIn,
  renewalOpensOn,
  type TerminationPreview,
  type TitleStatus,
  t,
  todayIso,
  toleranceCap,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { readableFilter } from './caixas';
import { listContractDocuments } from './contract-documents';
import { PLANNED_JOINS, PLANNED_SELECT, plannedOf } from './planned-account';
import { uuidArray } from './reports';
import { insertTitlePair, type MirrorPlan, opposite } from './title-pair';
import { defaultMirrorCategory } from './titles';
import { deleteOrArchive, withTx } from './tx';
import { camel, iso } from './util';

/*
 * Contratos (spec 020). O contrato vive numa caixa (a permissão é a dela) e
 * gera, ao ativar ou renovar, todas as parcelas do ciclo como títulos normais
 * (origin = contract, ciclo e parcela n/N), espelhados como qualquer título.
 * Vigente, valor, vencimento e categoria só mudam por aditivo; prazo e
 * periodicidade, na renovação. Toda escrita passa por withTx (auditoria).
 * Quem lê a caixa da contraparte vê o contrato pela parcela espelhada
 * (somente leitura).
 */

type Direction = 'payable' | 'receivable';
const E = t.contracts.errors;

export type ContractRecord = {
  id: string;
  caixaId: string;
  entityId: string;
  direction: Direction;
  name: string;
  contractNumber: string | null;
  categoryId: string;
  counterpartyCaixaId: string | null;
  status: ContractStatus;
  autoRenew: boolean;
  noticeDays: number;
  renewalLeadDays: number;
  reminderEveryDays: number;
  readjustmentIndex: ReadjustmentIndex;
  readjustmentBaseDate: string | null;
  terminationPenaltyText: string | null;
  terminationPenaltyCents: number | null;
  terminatedOn: string | null;
  terminationNotes: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  /** Spec 033: conta das parcelas, passagem, encargos e conciliação. */
  paymentAccountId: string | null;
  transitAccountId: string | null;
  lateFeePercent: number | null;
  interestMonthPercent: number | null;
  earlyDiscountPercent: number | null;
  toleranceCents: number;
  matchWindowDays: number;
  autoSettle: boolean;
};

export type CycleRecord = ContractCycleBrief & { contractId: string };

const CONTRACT_COLUMNS = sql`c.id, c.caixa_id, c.entity_id, c.direction, c.name, c.contract_number, c.category_id, c.counterparty_caixa_id,
  c.status, c.auto_renew, c.notice_days, c.renewal_lead_days, c.reminder_every_days, c.readjustment_index, c.readjustment_base_date,
  c.termination_penalty_text, c.termination_penalty_cents, c.terminated_on, c.termination_notes, c.notes, c.archived_at, c.created_at,
  c.payment_account_id, c.transit_account_id, c.late_fee_percent, c.interest_month_percent, c.early_discount_percent, c.tolerance_cents,
  c.match_window_days, c.auto_settle`;

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const CYCLE_COLUMNS = sql`y.id, y.contract_id, y.seq, y.starts_on, y.ends_on, y.duration_months, y.periodicity, y.installments_count,
  y.total_cents, y.due_day, y.due_month_offset, y.readjustment_percent`;

function toContract(row: Record<string, unknown>): ContractRecord {
  const r = camel<ContractRecord>(row);
  return {
    ...r,
    archivedAt: iso(r.archivedAt),
    createdAt: iso(r.createdAt)!,
    lateFeePercent: numOrNull(r.lateFeePercent),
    interestMonthPercent: numOrNull(r.interestMonthPercent),
    earlyDiscountPercent: numOrNull(r.earlyDiscountPercent),
    toleranceCents: Number(r.toleranceCents),
    matchWindowDays: Number(r.matchWindowDays),
  };
}

function toCycle(row: Record<string, unknown>): CycleRecord {
  const r = camel<CycleRecord>(row);
  return { ...r, readjustmentPercent: r.readjustmentPercent === null ? null : Number(r.readjustmentPercent) };
}

export async function loadContract(db: Executor, id: string, lock = false): Promise<ContractRecord> {
  const result = await db.execute(sql`SELECT ${CONTRACT_COLUMNS} FROM contracts c WHERE c.id = ${id} ${lock ? sql`FOR UPDATE` : sql``}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  return toContract(row);
}

export async function loadCycles(db: Executor, contractId: string): Promise<CycleRecord[]> {
  const result = await db.execute(sql`SELECT ${CYCLE_COLUMNS} FROM contract_cycles y WHERE y.contract_id = ${contractId} ORDER BY y.seq`);
  return result.rows.map(toCycle);
}

const termsOf = (cycle: Pick<CycleRecord, 'startsOn' | 'durationMonths' | 'periodicity' | 'totalCents' | 'dueDay' | 'dueMonthOffset'>) => ({
  startsOn: cycle.startsOn,
  durationMonths: cycle.durationMonths,
  periodicity: cycle.periodicity,
  totalCents: cycle.totalCents,
  dueDay: cycle.dueDay,
  dueMonthOffset: cycle.dueMonthOffset,
});

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/* ---------------- acesso ---------------- */

/**
 * Leitura: quem lê a caixa do contrato, ou quem lê a caixa da contraparte
 * onde há parcela espelhada (somente leitura).
 */
export async function contractReadMode(ctx: ServiceContext, contract: ContractRecord): Promise<'owner' | 'mirror'> {
  if (ctx.access.canRead(contract.caixaId)) return 'owner';
  if (contract.counterpartyCaixaId && ctx.access.canRead(contract.counterpartyCaixaId)) {
    const mirrored = await ctx.db.execute(
      sql`SELECT 1 FROM titles WHERE contract_id = ${contract.id} AND caixa_id = ${contract.counterpartyCaixaId} LIMIT 1`,
    );
    if (mirrored.rows.length > 0) return 'mirror';
  }
  throw notFound();
}

/* ---------------- leitura ---------------- */

const listSelect = (today: string) => sql`
  c.id, c.caixa_id, k.name AS caixa_name, c.entity_id, e.name AS entity_name, c.direction, c.name, c.contract_number,
  c.category_id, cat.name AS category_name, coalesce(cat.color_slot, pc.color_slot) AS category_color_slot, c.status, c.auto_renew,
  c.terminated_on, c.archived_at,
  cur.id AS cur_id, cur.seq AS cur_seq, cur.starts_on AS cur_starts_on, cur.ends_on AS cur_ends_on, cur.duration_months AS cur_duration_months,
  cur.periodicity AS cur_periodicity, cur.installments_count AS cur_installments_count, cur.total_cents AS cur_total_cents,
  cur.due_day AS cur_due_day, cur.due_month_offset AS cur_due_month_offset, cur.readjustment_percent AS cur_readjustment_percent,
  nx.id AS next_title_id, nx.due_date AS next_due_date, nx.open_cents AS next_open_cents, nx.contract_installment AS next_installment,
  nx.installments_count AS next_total,
  task.id AS task_id, task.due_on AS task_due_on, (task.due_on < ${today}::date) AS task_overdue`;

const listFrom = (today: string) => sql`
  FROM contracts c
  JOIN caixas k ON k.id = c.caixa_id
  JOIN entities e ON e.id = c.entity_id
  JOIN categories cat ON cat.id = c.category_id
  LEFT JOIN categories pc ON pc.id = cat.parent_id
  LEFT JOIN LATERAL (
    SELECT y.* FROM contract_cycles y WHERE y.contract_id = c.id
     ORDER BY CASE WHEN y.starts_on <= ${today}::date THEN y.seq ELSE -y.seq END DESC LIMIT 1) cur ON true
  LEFT JOIN LATERAL (
    SELECT y.ends_on FROM contract_cycles y WHERE y.contract_id = c.id ORDER BY y.seq DESC LIMIT 1) last ON true
  LEFT JOIN LATERAL (
    SELECT x.id, x.due_date, b.open_cents, x.contract_installment, yc.installments_count
      FROM titles x JOIN title_balances b ON b.title_id = x.id JOIN contract_cycles yc ON yc.id = x.contract_cycle_id
     WHERE x.contract_id = c.id AND x.caixa_id = c.caixa_id AND x.archived_at IS NULL AND b.open_cents > 0
     ORDER BY x.due_date, x.contract_installment LIMIT 1) nx ON true
  LEFT JOIN contract_renewal_tasks task ON task.contract_id = c.id AND task.status = 'open'`;

/** Contratos visíveis: da caixa legível, ou com parcela espelhada numa caixa legível. */
function visibleFilter(ctx: ServiceContext): SQL {
  return sql`(${readableFilter(ctx.access, sql`c.caixa_id`)} OR (c.counterparty_caixa_id IS NOT NULL
    AND ${readableFilter(ctx.access, sql`c.counterparty_caixa_id`)}
    AND EXISTS (SELECT 1 FROM titles mt WHERE mt.contract_id = c.id AND mt.caixa_id = c.counterparty_caixa_id)))`;
}

function toRow(ctx: ServiceContext, raw: Record<string, unknown>): ContractRow {
  const r = camel<Record<string, unknown>>(raw);
  const cycle: ContractCycleBrief | null = r.curId
    ? {
        id: String(r.curId),
        seq: Number(r.curSeq),
        startsOn: String(r.curStartsOn),
        endsOn: String(r.curEndsOn),
        durationMonths: Number(r.curDurationMonths),
        periodicity: r.curPeriodicity as ContractPeriodicity,
        installmentsCount: Number(r.curInstallmentsCount),
        totalCents: Number(r.curTotalCents),
        dueDay: Number(r.curDueDay),
        dueMonthOffset: Number(r.curDueMonthOffset),
        readjustmentPercent: r.curReadjustmentPercent === null ? null : Number(r.curReadjustmentPercent),
      }
    : null;
  return {
    id: String(r.id),
    caixaId: String(r.caixaId),
    caixaName: String(r.caixaName),
    entityId: String(r.entityId),
    entityName: String(r.entityName),
    direction: r.direction as Direction,
    name: String(r.name),
    contractNumber: (r.contractNumber as string | null) ?? null,
    categoryId: String(r.categoryId),
    categoryName: String(r.categoryName),
    categoryColorSlot: r.categoryColorSlot === null ? null : Number(r.categoryColorSlot),
    status: r.status as ContractStatus,
    autoRenew: Boolean(r.autoRenew),
    currentCycle: cycle,
    nextInstallment: r.nextTitleId
      ? {
          titleId: String(r.nextTitleId),
          dueDate: String(r.nextDueDate),
          amountCents: Number(r.nextOpenCents),
          installment: Number(r.nextInstallment),
          total: Number(r.nextTotal),
        }
      : null,
    openTask: r.taskId ? { id: String(r.taskId), dueOn: String(r.taskDueOn), overdue: Boolean(r.taskOverdue) } : null,
    terminatedOn: (r.terminatedOn as string | null) ?? null,
    archivedAt: iso(r.archivedAt),
    canWrite: ctx.access.canWrite(String(r.caixaId)),
  };
}

export async function listContracts(ctx: ServiceContext, query: z.output<typeof contractListQuery>): Promise<ContractRow[]> {
  if (query.caixaId) ctx.access.assertRead(query.caixaId);
  const today = todayIso();
  const where: SQL[] = [visibleFilter(ctx)];
  if (query.caixaId) where.push(sql`c.caixa_id = ${query.caixaId}`);
  if (query.entityId) where.push(sql`c.entity_id = ${query.entityId}`);
  if (query.direction) where.push(sql`c.direction = ${query.direction}`);
  if (query.status === 'current') where.push(sql`c.status IN ('active', 'renewal_pending')`);
  else if (query.status) where.push(sql`c.status = ${query.status}`);
  if (query.withinDays !== undefined) {
    const until = addDays(today, query.withinDays);
    where.push(sql`c.status IN ('active', 'renewal_pending') AND (last.ends_on BETWEEN ${today}::date AND ${until}::date
      OR (task.id IS NOT NULL AND task.due_on <= ${until}::date))`);
  }
  if (query.q)
    where.push(sql`(c.name ILIKE ${`%${query.q}%`} OR c.contract_number ILIKE ${`%${query.q}%`} OR e.name ILIKE ${`%${query.q}%`})`);
  where.push(query.archived ? sql`c.archived_at IS NOT NULL` : sql`c.archived_at IS NULL`);
  const result = await ctx.db.execute(sql`
    SELECT ${listSelect(today)} ${listFrom(today)}
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY CASE c.status WHEN 'renewal_pending' THEN 0 WHEN 'active' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, c.name, c.id
     LIMIT ${query.limit}`);
  return result.rows.map((row) => toRow(ctx, row));
}

async function contractRow(ctx: ServiceContext, id: string): Promise<ContractRow> {
  const today = todayIso();
  const result = await ctx.db.execute(sql`SELECT ${listSelect(today)} ${listFrom(today)} WHERE c.id = ${id}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  return toRow(ctx, raw);
}

const INSTALLMENT_SELECT = (today: string) => sql`
  x.id AS title_id, x.caixa_id, x.direction, x.contract_cycle_id, x.contract_installment AS installment, x.description,
  x.competence_date, x.due_date, x.amount_cents, b.settled_cents, b.open_cents, x.status,
  (b.open_cents > 0 AND x.due_date < ${today}::date) AS overdue, (x.archived_at IS NOT NULL) AS archived,
  ${PLANNED_SELECT}`;

function toInstallment(row: Record<string, unknown>): ContractInstallmentDto & { contractCycleId: string | null } {
  const r = camel<Record<string, unknown>>(row);
  return {
    titleId: String(r.titleId),
    caixaId: String(r.caixaId),
    direction: r.direction as Direction,
    contractCycleId: (r.contractCycleId as string | null) ?? null,
    installment: r.installment === null ? null : Number(r.installment),
    description: String(r.description),
    competenceDate: String(r.competenceDate),
    dueDate: String(r.dueDate),
    amountCents: Number(r.amountCents),
    settledCents: Number(r.settledCents),
    openCents: Number(r.openCents),
    status: r.status as TitleStatus,
    overdue: Boolean(r.overdue),
    archived: Boolean(r.archived),
    ...plannedOf(r),
  };
}

function totalsOf(rows: ContractInstallmentDto[]): ContractTotals {
  const totals: ContractTotals = { contractedCents: 0, settledCents: 0, openCents: 0, overdueCents: 0, canceledCents: 0 };
  for (const row of rows) {
    if (row.status === 'canceled') {
      totals.canceledCents += row.amountCents;
      continue;
    }
    totals.contractedCents += row.amountCents;
    totals.settledCents += row.settledCents;
    totals.openCents += row.openCents;
    if (row.overdue) totals.overdueCents += row.openCents;
  }
  return totals;
}

export async function getContract(ctx: ServiceContext, id: string): Promise<ContractDetail> {
  const contract = await loadContract(ctx.db, id);
  const mode = await contractReadMode(ctx, contract);
  const today = todayIso();
  const row = await contractRow(ctx, id);
  const cycles = await loadCycles(ctx.db, id);
  // Lado visto: a caixa do contrato, ou (pelo espelho) a caixa da contraparte.
  const sideCaixaId = mode === 'owner' ? contract.caixaId : contract.counterpartyCaixaId!;
  const installments = (
    await ctx.db.execute(sql`
      SELECT ${INSTALLMENT_SELECT(today)} FROM titles x JOIN title_balances b ON b.title_id = x.id ${PLANNED_JOINS}
       WHERE x.contract_id = ${id} AND x.caixa_id = ${sideCaixaId}
       ORDER BY x.competence_date, x.contract_installment NULLS LAST, x.created_at`)
  ).rows.map(toInstallment);

  const [counterparty, amendments, tasks, documents, accounts] = await Promise.all([
    contract.counterpartyCaixaId
      ? ctx.db.execute<{ name: string }>(sql`SELECT name FROM caixas WHERE id = ${contract.counterpartyCaixaId}`)
      : Promise.resolve(null),
    ctx.db.execute(sql`
      SELECT a.id, y.seq AS cycle_seq, a.effective_on, a.document_id, d.title AS document_title, a.changes,
             coalesce(cardinality(a.affected_title_ids), 0) AS affected_count, coalesce(cardinality(a.skipped_title_ids), 0) AS skipped_count,
             a.notes, a.created_at, u.username AS created_by_name
        FROM contract_amendments a
        JOIN contract_cycles y ON y.id = a.contract_cycle_id
        LEFT JOIN contract_documents d ON d.id = a.document_id
        LEFT JOIN users u ON u.id = a.created_by
       WHERE a.contract_id = ${id}
       ORDER BY a.effective_on DESC, a.created_at DESC`),
    ctx.db.execute(sql`
      SELECT k.id, k.contract_cycle_id AS cycle_id, y.seq AS cycle_seq, k.status, k.opened_on, k.due_on,
             (k.status = 'open' AND k.due_on < ${today}::date) AS overdue, k.decided_at, u.username AS decided_by_name,
             k.decision_notes, k.new_cycle_id
        FROM contract_renewal_tasks k
        JOIN contract_cycles y ON y.id = k.contract_cycle_id
        LEFT JOIN users u ON u.id = k.decided_by
       WHERE k.contract_id = ${id}
       ORDER BY y.seq DESC`),
    listContractDocuments(ctx.db, id),
    ctx.db.execute<{
      payment_name: string | null;
      payment_caixa_id: string | null;
      payment_caixa_name: string | null;
      transit_name: string | null;
      following: number;
    }>(sql`
      SELECT pa.name AS payment_name, pa.caixa_id AS payment_caixa_id, pk.name AS payment_caixa_name, ta.name AS transit_name,
             (SELECT count(*)::int FROM titles x
               WHERE x.contract_id = c.id AND x.caixa_id = c.caixa_id AND x.contract_cycle_id IS NOT NULL
                 AND x.status IN ('open', 'partial') AND NOT x.planned_account_custom) AS following
        FROM contracts c
        LEFT JOIN financial_accounts pa ON pa.id = c.payment_account_id
        LEFT JOIN caixas pk ON pk.id = pa.caixa_id
        LEFT JOIN financial_accounts ta ON ta.id = c.transit_account_id
       WHERE c.id = ${id}`),
  ]);
  const acc = accounts.rows[0];

  // Aditivos que trocaram a categoria: o nome entra junto do id, para a tela.
  const categoryIds = amendments.rows.flatMap((raw) => {
    const changes = raw.changes as { before: Record<string, unknown>; after: Record<string, unknown> };
    return [changes.before.categoryId, changes.after.categoryId].filter((v): v is string => typeof v === 'string');
  });
  const categoryNames = new Map(
    categoryIds.length
      ? (
          await ctx.db.execute<{ id: string; name: string }>(
            sql`SELECT id, name FROM categories WHERE id = ANY (${uuidArray(categoryIds)})`,
          )
        ).rows.map((r) => [r.id, r.name] as const)
      : [],
  );
  const named = (side: Record<string, unknown>) =>
    typeof side.categoryId === 'string' ? { ...side, categoryName: categoryNames.get(side.categoryId) ?? null } : side;

  const latest = cycles.at(-1) ?? null;
  const cycleDtos: ContractCycleDto[] = cycles
    .map((cycle) => {
      const rows = installments.filter((i) => i.contractCycleId === cycle.id);
      const { contractId: _c, ...brief } = cycle;
      return { ...brief, installments: rows.map(({ contractCycleId: _y, ...i }) => i), totals: totalsOf(rows) };
    })
    .reverse();
  const nextReadjustment =
    contract.readjustmentIndex === 'none' || !cycles[0]
      ? null
      : ([Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]
          .map((year) => readjustmentDateIn(year, cycles[0]!.startsOn, contract.readjustmentBaseDate))
          .find((date) => date !== null && date >= today) ?? null);

  return {
    ...row,
    counterpartyCaixaId: contract.counterpartyCaixaId,
    counterpartyCaixaName: counterparty?.rows[0]?.name ?? null,
    notes: contract.notes,
    noticeDays: contract.noticeDays,
    renewalLeadDays: contract.renewalLeadDays,
    reminderEveryDays: contract.reminderEveryDays,
    readjustmentIndex: contract.readjustmentIndex,
    readjustmentBaseDate: contract.readjustmentBaseDate,
    terminationPenaltyText: contract.terminationPenaltyText,
    terminationPenaltyCents: contract.terminationPenaltyCents,
    terminationNotes: contract.terminationNotes,
    paymentAccountId: contract.paymentAccountId,
    paymentAccountName: acc?.payment_name ?? null,
    paymentAccountCaixaId: acc?.payment_caixa_id ?? null,
    paymentAccountCaixaName: acc?.payment_caixa_name ?? null,
    transitAccountId: contract.transitAccountId,
    transitAccountName: acc?.transit_name ?? null,
    lateFeePercent: contract.lateFeePercent,
    interestMonthPercent: contract.interestMonthPercent,
    earlyDiscountPercent: contract.earlyDiscountPercent,
    toleranceCents: contract.toleranceCents,
    matchWindowDays: contract.matchWindowDays,
    autoSettle: contract.autoSettle,
    followingOpenInstallments: Number(acc?.following ?? 0),
    createdAt: contract.createdAt,
    noticeDeadline:
      latest && ['active', 'renewal_pending'].includes(contract.status) ? noticeDeadline(latest.endsOn, contract.noticeDays) : null,
    nextReadjustment,
    viaMirror: mode === 'mirror',
    canWrite: mode === 'owner' && ctx.access.canWrite(contract.caixaId),
    cycles: cycleDtos,
    extraTitles: installments.filter((i) => i.contractCycleId === null).map(({ contractCycleId: _y, ...i }) => i),
    documents,
    amendments: amendments.rows.map((raw) => {
      const r = camel<Record<string, unknown>>(raw);
      return {
        id: String(r.id),
        cycleSeq: Number(r.cycleSeq),
        effectiveOn: String(r.effectiveOn),
        documentId: (r.documentId as string | null) ?? null,
        documentTitle: (r.documentTitle as string | null) ?? null,
        changes: (({ before, after }) => ({ before: named(before), after: named(after) }))(
          r.changes as { before: Record<string, unknown>; after: Record<string, unknown> },
        ),
        affectedCount: Number(r.affectedCount),
        skippedCount: Number(r.skippedCount),
        notes: (r.notes as string | null) ?? null,
        createdAt: iso(r.createdAt)!,
        createdByName: (r.createdByName as string | null) ?? null,
      };
    }),
    renewalTasks: tasks.rows.map((raw) => {
      const r = camel<Record<string, unknown>>(raw);
      return {
        id: String(r.id),
        cycleId: String(r.cycleId),
        cycleSeq: Number(r.cycleSeq),
        status: r.status as 'open' | 'approved' | 'declined',
        openedOn: String(r.openedOn),
        dueOn: String(r.dueOn),
        overdue: Boolean(r.overdue),
        decidedAt: iso(r.decidedAt),
        decidedByName: (r.decidedByName as string | null) ?? null,
        decisionNotes: (r.decisionNotes as string | null) ?? null,
        newCycleId: (r.newCycleId as string | null) ?? null,
      };
    }),
  };
}

/* ---------------- validações e espelho ---------------- */

async function assertCaixaAndEntity(tx: Executor, caixaId: string, entityId: string) {
  const result = await tx.execute<{ kind: string; holder_entity_id: string }>(
    sql`SELECT kind, holder_entity_id FROM caixas WHERE id = ${caixaId}`,
  );
  const caixa = result.rows[0];
  if (!caixa) throw notFound();
  if (caixa.kind !== 'general') throw unprocessable(E.caixaNotGeneral, 'contract_caixa_kind');
  if (caixa.holder_entity_id === entityId) throw unprocessable(E.selfContract, 'contract_self');
}

async function assertCategory(tx: Executor, categoryId: string, direction: Direction) {
  const result = await tx.execute<{ kind: string }>(sql`SELECT kind FROM categories WHERE id = ${categoryId}`);
  const kind = result.rows[0]?.kind;
  if (!kind) throw notFound();
  if (kind !== (direction === 'payable' ? 'expense' : 'income')) throw unprocessable(E.categoryKind, 'contract_category_kind');
}

/**
 * Conta das parcelas e a de passagem (spec 033). A conta pode ser de outra
 * caixa em que o usuário escreve; aí a de passagem (da caixa do contrato) é
 * obrigatória; na mesma caixa, a passagem sai. Tipo e caixa da passagem o
 * banco confere (contracts_payment_account_check/contracts_transit_account_check).
 */
export async function resolvePaymentAccounts(
  ctx: ServiceContext,
  tx: Executor,
  caixaId: string,
  paymentAccountId: string | null,
  transitAccountId: string | null,
): Promise<{ paymentAccountId: string | null; transitAccountId: string | null }> {
  if (!paymentAccountId) return { paymentAccountId: null, transitAccountId: null };
  const found = await tx.execute<{ caixa_id: string }>(sql`SELECT caixa_id FROM financial_accounts WHERE id = ${paymentAccountId}`);
  const account = found.rows[0];
  if (!account) throw notFound();
  if (account.caixa_id === caixaId) return { paymentAccountId, transitAccountId: null };
  ctx.access.assertWrite(account.caixa_id);
  if (!transitAccountId) throw unprocessable(E.transitAccount, 'contracts_transit_account_check');
  return { paymentAccountId, transitAccountId };
}

/** Teto da tolerância (spec 033): 10% da menor parcela do ciclo. */
function assertTolerance(toleranceCents: number | undefined, totalCents: number, count: number | null) {
  if (!toleranceCents || !count) return;
  const cap = toleranceCap(Math.floor(totalCents / count));
  if (toleranceCents > cap) throw unprocessable(E.toleranceCap(formatBRL(cap)), 'contracts_tolerance_cents_check');
}

/** Caixa do espelho: omitida = a principal da entidade (se houver); null = sem espelho. */
async function resolveCounterparty(
  tx: Executor,
  caixaId: string,
  entityId: string,
  requested: string | null | undefined,
): Promise<string | null> {
  if (requested === null) return null;
  if (requested === undefined) {
    const primary = await tx.execute<{ id: string }>(sql`
      SELECT id FROM caixas WHERE holder_entity_id = ${entityId} AND is_primary AND kind = 'general' AND archived_at IS NULL`);
    const id = primary.rows[0]?.id ?? null;
    return id === caixaId ? null : id;
  }
  const target = await tx.execute<{ holder_entity_id: string; kind: string }>(
    sql`SELECT holder_entity_id, kind FROM caixas WHERE id = ${requested}`,
  );
  const row = target.rows[0];
  if (!row || row.holder_entity_id !== entityId || row.kind !== 'general') throw unprocessable(t.errors.mirrorCaixaNotHeld);
  if (requested === caixaId) throw unprocessable(t.errors.mirrorSameCaixa);
  return requested;
}

/** Plano do espelho das parcelas: a categoria do último espelho deste contrato (o editor de lá pode tê-la trocado). */
async function mirrorPlan(ctx: ServiceContext, tx: Executor, contract: ContractRecord): Promise<MirrorPlan | null> {
  if (!contract.counterpartyCaixaId) return null;
  const holder = await tx.execute<{ holder_entity_id: string }>(sql`SELECT holder_entity_id FROM caixas WHERE id = ${contract.caixaId}`);
  const previous = await tx.execute<{ category_id: string }>(sql`
    SELECT category_id FROM titles
     WHERE contract_id = ${contract.id} AND caixa_id = ${contract.counterpartyCaixaId} AND contract_cycle_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`);
  const direction = opposite(contract.direction);
  return {
    caixaId: contract.counterpartyCaixaId,
    entityId: holder.rows[0]!.holder_entity_id,
    categoryId: previous.rows[0]?.category_id ?? (await defaultMirrorCategory(tx, contract.counterpartyCaixaId, direction)),
    status: ctx.access.canWrite(contract.counterpartyCaixaId) ? 'accepted' : 'pending',
  };
}

/** Meses (1º dia) fechados em alguma das caixas, entre as competências pedidas. */
async function closedMonths(db: Executor, caixaIds: (string | null)[], competences: string[]): Promise<Set<string>> {
  const ids = caixaIds.filter((id): id is string => Boolean(id));
  const months = [...new Set(competences.map(monthStart))];
  if (ids.length === 0 || months.length === 0) return new Set();
  const result = await db.execute<{ month: string }>(sql`
    SELECT DISTINCT month FROM period_closings
     WHERE caixa_id = ANY (${uuidArray(ids)}) AND month = ANY (${`{${months.join(',')}}`}::date[])`);
  return new Set(result.rows.map((r) => r.month));
}

/** Gera as parcelas do ciclo (títulos + espelho), numa transação aberta. */
async function generateInstallments(ctx: ServiceContext, tx: Tx, contract: ContractRecord, cycle: CycleRecord): Promise<number> {
  const schedule = cycleSchedule(termsOf(cycle));
  const closed = await closedMonths(
    tx,
    [contract.caixaId, contract.counterpartyCaixaId],
    schedule.map((r) => r.competenceDate),
  );
  if (closed.size > 0) throw unprocessable(E.closedMonth(formatMonth([...closed].sort()[0]!)), 'contract_closed_month');
  const mirror = await mirrorPlan(ctx, tx, contract);
  for (const row of schedule) {
    await insertTitlePair(
      tx,
      {
        caixaId: contract.caixaId,
        direction: contract.direction,
        entityId: contract.entityId,
        categoryId: contract.categoryId,
        description: installmentDescription(contract.name, row.installment, schedule.length),
        competenceDate: row.competenceDate,
        dueDate: row.dueDate,
        amountCents: row.amountCents,
        notes: null,
        origin: 'contract',
        recurrenceRuleId: null,
        occurrence: null,
        contractId: contract.id,
        contractCycleId: cycle.id,
        contractInstallment: row.installment,
        plannedAccountId: contract.paymentAccountId,
        plannedTransitAccountId: contract.transitAccountId,
      },
      mirror,
    );
  }
  return schedule.length;
}

/* ---------------- ciclo de vida (também usado pelo worker) ---------------- */

/**
 * Atualiza o status pelo calendário: abre a tarefa de renovação na
 * antecedência (renovação automática) e encerra o contrato vigente que
 * passou do fim sem tarefa aberta. Nada é lançado aqui.
 */
export async function syncLifecycle(tx: Executor, contractId: string, today = todayIso()): Promise<'opened' | 'ended' | null> {
  const contract = await loadContract(tx, contractId, true);
  if (contract.status !== 'active' || contract.archivedAt) return null;
  const latest = (await loadCycles(tx, contractId)).at(-1);
  if (!latest) return null;
  const task = await tx.execute<{ id: string; status: string }>(
    sql`SELECT id, status FROM contract_renewal_tasks WHERE contract_cycle_id = ${latest.id}`,
  );
  if (contract.autoRenew && task.rows.length === 0 && today >= renewalOpensOn(latest.endsOn, contract.renewalLeadDays)) {
    await tx.execute(sql`
      INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, status, opened_on, due_on)
      VALUES (${contractId}, ${latest.id}, 'open', ${today}::date, ${latest.endsOn}::date)`);
    await tx.execute(sql`UPDATE contracts SET status = 'renewal_pending' WHERE id = ${contractId}`);
    return 'opened';
  }
  if (today > latest.endsOn) {
    await tx.execute(sql`UPDATE contracts SET status = 'ended' WHERE id = ${contractId}`);
    return 'ended';
  }
  return null;
}

/* ---------------- escrita ---------------- */

export async function createContract(ctx: ServiceContext, input: z.output<typeof contractCreateInput>): Promise<ContractDetail> {
  ctx.access.assertWrite(input.caixaId);
  const id = await withTx(ctx, async (tx) => {
    await assertCaixaAndEntity(tx, input.caixaId, input.entityId);
    await assertCategory(tx, input.categoryId, input.direction);
    const counterparty = await resolveCounterparty(tx, input.caixaId, input.entityId, input.mirrorCaixaId);
    const accounts = await resolvePaymentAccounts(ctx, tx, input.caixaId, input.paymentAccountId, input.transitAccountId);
    assertTolerance(input.toleranceCents, input.totalCents, installmentsCount(input.durationMonths, input.periodicity));
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO contracts (caixa_id, entity_id, direction, name, contract_number, category_id, counterparty_caixa_id, auto_renew,
                             notice_days, renewal_lead_days, reminder_every_days, readjustment_index, readjustment_base_date,
                             termination_penalty_text, termination_penalty_cents, notes, created_by,
                             payment_account_id, transit_account_id, late_fee_percent, interest_month_percent, early_discount_percent,
                             tolerance_cents, match_window_days, auto_settle)
      VALUES (${input.caixaId}, ${input.entityId}, ${input.direction}, ${input.name}, ${input.contractNumber}, ${input.categoryId},
              ${counterparty}, ${input.autoRenew}, ${input.noticeDays}, ${input.renewalLeadDays}, ${input.reminderEveryDays},
              ${input.readjustmentIndex}, ${input.readjustmentBaseDate}, ${input.terminationPenaltyText}, ${input.terminationPenaltyCents},
              ${input.notes}, ${ctx.access.actor.id},
              ${accounts.paymentAccountId}, ${accounts.transitAccountId}, ${input.lateFeePercent}, ${input.interestMonthPercent},
              ${input.earlyDiscountPercent}, ${input.toleranceCents}, ${input.matchWindowDays}, ${input.autoSettle})
      RETURNING id`);
    const contractId = inserted.rows[0]!.id;
    await tx.execute(sql`
      INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day, due_month_offset)
      VALUES (${contractId}, 1, ${input.startsOn}::date, ${input.durationMonths}, ${input.periodicity}, ${input.totalCents},
              ${input.dueDay}, ${input.dueMonthOffset})`);
    if (input.activate) await activateInTx(ctx, tx, contractId);
    return contractId;
  });
  return getContract(ctx, id);
}

const FREE_FIELDS = [
  'name',
  'contractNumber',
  'notes',
  'autoRenew',
  'noticeDays',
  'renewalLeadDays',
  'reminderEveryDays',
  'readjustmentIndex',
  'readjustmentBaseDate',
  'terminationPenaltyText',
  'terminationPenaltyCents',
  'lateFeePercent',
  'interestMonthPercent',
  'earlyDiscountPercent',
  'toleranceCents',
  'matchWindowDays',
  'autoSettle',
] as const;

const COLUMN: Record<(typeof FREE_FIELDS)[number] | 'entityId' | 'categoryId', string> = {
  name: 'name',
  contractNumber: 'contract_number',
  notes: 'notes',
  autoRenew: 'auto_renew',
  noticeDays: 'notice_days',
  renewalLeadDays: 'renewal_lead_days',
  reminderEveryDays: 'reminder_every_days',
  readjustmentIndex: 'readjustment_index',
  readjustmentBaseDate: 'readjustment_base_date',
  terminationPenaltyText: 'termination_penalty_text',
  terminationPenaltyCents: 'termination_penalty_cents',
  lateFeePercent: 'late_fee_percent',
  interestMonthPercent: 'interest_month_percent',
  earlyDiscountPercent: 'early_discount_percent',
  toleranceCents: 'tolerance_cents',
  matchWindowDays: 'match_window_days',
  autoSettle: 'auto_settle',
  entityId: 'entity_id',
  categoryId: 'category_id',
};

export async function updateContract(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractUpdateInput>,
): Promise<ContractDetail> {
  await withTx(ctx, async (tx) => {
    const contract = await loadContract(tx, id, true);
    ctx.access.assertWrite(contract.caixaId);
    const draft = contract.status === 'draft';
    const [cycle] = await loadCycles(tx, id);
    const termKeys = ['startsOn', 'durationMonths', 'periodicity', 'totalCents', 'dueDay', 'dueMonthOffset'] as const;
    const changedTerms = termKeys.filter((key) => input[key] !== undefined && input[key] !== cycle?.[key]);
    const lockedChange =
      changedTerms.length > 0 ||
      (input.entityId !== undefined && input.entityId !== contract.entityId) ||
      (input.categoryId !== undefined && input.categoryId !== contract.categoryId) ||
      (input.mirrorCaixaId !== undefined && input.mirrorCaixaId !== contract.counterpartyCaixaId);
    if (lockedChange && !draft) throw unprocessable(t.contracts.lockedActive, 'contract_locked');

    const sets: SQL[] = [];
    for (const key of FREE_FIELDS) {
      if (input[key] !== undefined) sets.push(sql`${sql.identifier(COLUMN[key])} = ${input[key]}`);
    }
    // Conta das parcelas (spec 033): a troca vale para as parcelas em aberto que seguem o contrato, se pedido.
    let accounts: { paymentAccountId: string | null; transitAccountId: string | null } | null = null;
    if (input.paymentAccountId !== undefined || input.transitAccountId !== undefined) {
      accounts = await resolvePaymentAccounts(
        ctx,
        tx,
        contract.caixaId,
        input.paymentAccountId !== undefined ? input.paymentAccountId : contract.paymentAccountId,
        input.transitAccountId !== undefined ? input.transitAccountId : contract.transitAccountId,
      );
      sets.push(sql`payment_account_id = ${accounts.paymentAccountId}, transit_account_id = ${accounts.transitAccountId}`);
    }
    if (input.toleranceCents !== undefined) {
      const latest = (await loadCycles(tx, id)).at(-1);
      if (latest) {
        const total = draft ? (input.totalCents ?? latest.totalCents) : latest.totalCents;
        const count = draft
          ? installmentsCount(input.durationMonths ?? latest.durationMonths, input.periodicity ?? latest.periodicity)
          : latest.installmentsCount;
        assertTolerance(input.toleranceCents, total, count);
      }
    }
    if (draft) {
      const entityId = input.entityId ?? contract.entityId;
      if (input.entityId !== undefined) {
        await assertCaixaAndEntity(tx, contract.caixaId, entityId);
        sets.push(sql`entity_id = ${entityId}`);
      }
      if (input.categoryId !== undefined) {
        await assertCategory(tx, input.categoryId, contract.direction);
        sets.push(sql`category_id = ${input.categoryId}`);
      }
      if (input.mirrorCaixaId !== undefined || input.entityId !== undefined) {
        const requested = input.mirrorCaixaId !== undefined ? input.mirrorCaixaId : undefined;
        sets.push(sql`counterparty_caixa_id = ${await resolveCounterparty(tx, contract.caixaId, entityId, requested)}`);
      }
    }
    if (sets.length > 0) await tx.execute(sql`UPDATE contracts SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    if (accounts && input.applyAccountToInstallments) await applyPlannedAccount(tx, { ...contract, ...accounts });
    if (draft && cycle && changedTerms.length > 0) {
      const next = { ...termsOf(cycle), ...Object.fromEntries(changedTerms.map((key) => [key, input[key]])) };
      await tx.execute(sql`
        UPDATE contract_cycles SET starts_on = ${next.startsOn}::date, duration_months = ${next.durationMonths},
               periodicity = ${next.periodicity}, total_cents = ${next.totalCents}, due_day = ${next.dueDay},
               due_month_offset = ${next.dueMonthOffset}
         WHERE id = ${cycle.id}`);
    }
    if (!draft) await syncLifecycle(tx, id);
  });
  return getContract(ctx, id);
}

/**
 * A conta do contrato nas parcelas que o seguem (spec 033): em aberto ou
 * parciais, do lado do contrato, sem conta própria. `ids` restringe às parcelas
 * recalculadas (aditivo). Devolve quantas mudaram.
 */
async function applyPlannedAccount(
  tx: Executor,
  contract: Pick<ContractRecord, 'id' | 'caixaId' | 'paymentAccountId' | 'transitAccountId'>,
  ids?: string[],
): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const result = await tx.execute(sql`
    UPDATE titles SET planned_account_id = ${contract.paymentAccountId}, planned_transit_account_id = ${contract.transitAccountId}
     WHERE contract_id = ${contract.id} AND caixa_id = ${contract.caixaId} AND contract_cycle_id IS NOT NULL
       AND status IN ('open', 'partial') AND NOT planned_account_custom
       AND (planned_account_id IS DISTINCT FROM ${contract.paymentAccountId}::uuid
            OR planned_transit_account_id IS DISTINCT FROM ${contract.transitAccountId}::uuid)
       ${ids ? sql`AND id = ANY (${uuidArray(ids)})` : sql``}`);
  return result.rowCount ?? 0;
}

async function activateInTx(ctx: ServiceContext, tx: Tx, id: string): Promise<number> {
  const contract = await loadContract(tx, id, true);
  ctx.access.assertWrite(contract.caixaId);
  if (contract.status !== 'draft') throw unprocessable(E.alreadyActive, 'contract_not_draft');
  const [cycle] = await loadCycles(tx, id);
  if (!cycle) throw notFound();
  // O status muda antes das parcelas: o banco não aceita parcela de contrato em rascunho.
  await tx.execute(sql`UPDATE contracts SET status = 'active' WHERE id = ${id}`);
  const count = await generateInstallments(ctx, tx, { ...contract, status: 'active' }, cycle);
  await syncLifecycle(tx, id);
  return count;
}

export async function activateContract(ctx: ServiceContext, id: string): Promise<ContractDetail> {
  await withTx(ctx, (tx) => activateInTx(ctx, tx, id));
  return getContract(ctx, id);
}

/** Rascunho sem vínculos é excluído; o resto é arquivado (as parcelas continuam como títulos). */
export async function deleteContract(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  const contract = await loadContract(ctx.db, id);
  ctx.access.assertWrite(contract.caixaId);
  const archive = (tx: Tx) => tx.execute(sql`UPDATE contracts SET archived_at = now() WHERE id = ${id}`);
  return withTx(ctx, async (tx) => {
    if (contract.status !== 'draft') {
      await archive(tx);
      return { deleted: false, archived: true };
    }
    return deleteOrArchive(tx, async (sp) => (await sp.execute(sql`DELETE FROM contracts WHERE id = ${id}`)).rowCount ?? 0, archive);
  });
}

export async function restoreContract(ctx: ServiceContext, id: string): Promise<ContractDetail> {
  const contract = await loadContract(ctx.db, id);
  ctx.access.assertWrite(contract.caixaId);
  await withTx(ctx, (tx) => tx.execute(sql`UPDATE contracts SET archived_at = NULL WHERE id = ${id}`));
  return getContract(ctx, id);
}

/* ---------------- parcelas do lado original ---------------- */

type InstallmentState = {
  id: string;
  mirrorTitleId: string | null;
  mirrorCaixaId: string | null;
  mirrorStatus: string | null;
  cycleId: string | null;
  installment: number | null;
  competenceDate: string;
  dueDate: string;
  amountCents: number;
  settledCents: number;
  status: TitleStatus;
};

async function originalInstallments(tx: Executor, contract: ContractRecord, lock = false): Promise<InstallmentState[]> {
  const result = await tx.execute(sql`
    SELECT x.id, x.mirror_title_id, m.caixa_id AS mirror_caixa_id, m.mirror_status, x.contract_cycle_id AS cycle_id,
           x.contract_installment AS installment, x.competence_date, x.due_date, x.amount_cents, b.settled_cents, x.status
      FROM titles x
      JOIN title_balances b ON b.title_id = x.id
      LEFT JOIN titles m ON m.id = x.mirror_title_id
     WHERE x.contract_id = ${contract.id} AND x.caixa_id = ${contract.caixaId} AND x.contract_cycle_id IS NOT NULL
     ORDER BY x.competence_date, x.contract_installment
     ${lock ? sql`FOR UPDATE OF x` : sql``}`);
  return result.rows.map((raw) => {
    const r = camel<InstallmentState>(raw);
    return { ...r, amountCents: Number(r.amountCents), settledCents: Number(r.settledCents) };
  });
}

/** Grava valor/vencimento/categoria no título e mantém o par (o espelho volta a aguardar aceite sem permissão lá). */
async function patchInstallment(
  ctx: ServiceContext,
  tx: Tx,
  row: InstallmentState,
  patch: { amountCents?: number; dueDate?: string; categoryId?: string; status?: 'canceled' },
) {
  const sets: SQL[] = [];
  if (patch.amountCents !== undefined) sets.push(sql`amount_cents = ${patch.amountCents}`);
  if (patch.dueDate !== undefined) sets.push(sql`due_date = ${patch.dueDate}::date`);
  if (patch.categoryId !== undefined) sets.push(sql`category_id = ${patch.categoryId}`);
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

function assertLive(contract: ContractRecord) {
  if (contract.status === 'terminated') throw unprocessable(E.terminated, 'contract_terminated');
  if (contract.status !== 'active' && contract.status !== 'renewal_pending') throw unprocessable(E.notActive, 'contract_not_active');
}

/* ---------------- aditivo ---------------- */

type AmendmentPlan = AmendmentPreview & {
  updates: { row: InstallmentState; amountCents: number; dueDate: string }[];
  cycles: CycleRecord[];
};

async function planAmendment(
  tx: Executor,
  contract: ContractRecord,
  input: z.output<typeof contractAmendmentInput>,
  lock: boolean,
): Promise<AmendmentPlan> {
  const cycles = await loadCycles(tx, contract.id);
  const cycle = [...cycles].reverse().find((c) => c.startsOn <= input.effectiveOn && input.effectiveOn <= c.endsOn);
  if (!cycle) throw unprocessable(E.effectiveOutside, 'contract_effective_outside');
  const rows = (await originalInstallments(tx, contract, lock)).filter((r) => r.competenceDate >= input.effectiveOn);
  const closed = await closedMonths(
    tx,
    [contract.caixaId, contract.counterpartyCaixaId],
    rows.map((r) => r.competenceDate),
  );
  const skipped: AmendmentPreview['skipped'] = [];
  const affected: InstallmentState[] = [];
  for (const row of rows) {
    const reason =
      row.status === 'canceled'
        ? 'canceled'
        : row.settledCents > 0
          ? 'settled'
          : closed.has(monthStart(row.competenceDate))
            ? 'closed_month'
            : null;
    if (reason) skipped.push({ titleId: row.id, installment: row.installment!, competenceDate: row.competenceDate, reason });
    else affected.push(row);
  }
  const touched = cycles.filter((c) => c.seq >= cycle.seq);
  const recalculated = amendInstallments(affected, input, { dueDay: cycle.dueDay, dueMonthOffset: cycle.dueMonthOffset });
  const byId = new Map(affected.map((r) => [r.id, r]));
  const updates = recalculated.map((r) => ({ row: byId.get(r.id)!, amountCents: r.amountCents, dueDate: r.dueDate }));

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (input.installmentCents || input.remainingTotalCents) {
    before.totalCents = cycle.totalCents;
    const untouched = rows.filter((r) => r.status !== 'canceled' && !byId.has(r.id) && r.cycleId === cycle.id);
    const earlier = (await originalInstallments(tx, contract)).filter(
      (r) => r.cycleId === cycle.id && r.competenceDate < input.effectiveOn && r.status !== 'canceled',
    );
    after.totalCents =
      [...earlier, ...untouched].reduce((acc, r) => acc + r.amountCents, 0) +
      updates.filter((u) => u.row.cycleId === cycle.id).reduce((acc, u) => acc + u.amountCents, 0);
    if (input.installmentCents) {
      before.installmentCents = affected[0]?.amountCents ?? null;
      after.installmentCents = input.installmentCents;
    } else {
      before.remainingTotalCents = affected.reduce((acc, r) => acc + r.amountCents, 0);
      after.remainingTotalCents = input.remainingTotalCents;
    }
  }
  if (input.dueDay !== null) {
    before.dueDay = cycle.dueDay;
    after.dueDay = input.dueDay;
  }
  if (input.dueMonthOffset !== null) {
    before.dueMonthOffset = cycle.dueMonthOffset;
    after.dueMonthOffset = input.dueMonthOffset;
  }
  if (input.categoryId !== null) {
    before.categoryId = contract.categoryId;
    after.categoryId = input.categoryId;
  }
  return {
    cycleId: cycle.id,
    affected: updates.map((u) => ({
      titleId: u.row.id,
      installment: u.row.installment!,
      competenceDate: u.row.competenceDate,
      before: { amountCents: u.row.amountCents, dueDate: u.row.dueDate },
      after: { amountCents: u.amountCents, dueDate: u.dueDate },
    })),
    skipped,
    changes: { before, after },
    updates,
    cycles: touched,
  };
}

const publicPlan = ({ updates: _u, cycles: _c, ...preview }: AmendmentPlan): AmendmentPreview => preview;

export async function amendContract(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractAmendmentInput>,
  dryRun: boolean,
): Promise<{ preview: AmendmentPreview; contract: ContractDetail | null }> {
  const contract = await loadContract(ctx.db, id);
  ctx.access.assertWrite(contract.caixaId);
  assertLive(contract);
  if (input.categoryId) await assertCategory(ctx.db, input.categoryId, contract.direction);
  if (dryRun) return { preview: publicPlan(await planAmendment(ctx.db, contract, input, false)), contract: null };

  const preview = await withTx(ctx, async (tx) => {
    const locked = await loadContract(tx, id, true);
    assertLive(locked);
    const plan = await planAmendment(tx, locked, input, true);
    for (const update of plan.updates) {
      await patchInstallment(ctx, tx, update.row, {
        amountCents: update.amountCents !== update.row.amountCents ? update.amountCents : undefined,
        dueDate: update.dueDate !== update.row.dueDate ? update.dueDate : undefined,
        categoryId: input.categoryId ?? undefined,
      });
    }
    if (input.categoryId) await tx.execute(sql`UPDATE contracts SET category_id = ${input.categoryId} WHERE id = ${id}`);
    // Spec 033: as parcelas recalculadas levam a conta do contrato (as com conta própria ficam).
    await applyPlannedAccount(
      tx,
      locked,
      plan.updates.map((u) => u.row.id),
    );
    // Ciclos atingidos: dia/deslocamento novos e o total = soma das parcelas não canceladas.
    for (const cycle of plan.cycles) {
      await tx.execute(sql`
        UPDATE contract_cycles y
           SET due_day = ${input.dueDay ?? cycle.dueDay}, due_month_offset = ${input.dueMonthOffset ?? cycle.dueMonthOffset},
               total_cents = coalesce((SELECT sum(x.amount_cents) FROM titles x
                                        WHERE x.contract_cycle_id = y.id AND x.caixa_id = ${locked.caixaId} AND x.status <> 'canceled'),
                                      y.total_cents)
         WHERE y.id = ${cycle.id}`);
    }
    await tx.execute(sql`
      INSERT INTO contract_amendments (contract_id, contract_cycle_id, document_id, effective_on, changes, affected_title_ids,
                                       skipped_title_ids, notes, created_by)
      VALUES (${id}, ${plan.cycleId}, ${input.documentId}, ${input.effectiveOn}::date, ${JSON.stringify(plan.changes)}::jsonb,
              ${uuidArray(plan.affected.map((a) => a.titleId))}, ${uuidArray(plan.skipped.map((s) => s.titleId))},
              ${input.notes}, ${ctx.access.actor.id})`);
    return publicPlan(plan);
  });
  return { preview, contract: await getContract(ctx, id) };
}

/* ---------------- rescisão ---------------- */

async function planTermination(
  tx: Executor,
  contract: ContractRecord,
  terminatedOn: string,
  lock: boolean,
): Promise<TerminationPreview & { rows: Map<string, InstallmentState> }> {
  const cycles = await loadCycles(tx, contract.id);
  const first = cycles[0];
  const last = cycles.at(-1);
  if (!first || !last || terminatedOn < first.startsOn) throw unprocessable(E.terminationBeforeStart, 'contract_termination_date');
  if (terminatedOn > last.endsOn) throw unprocessable(E.terminationAfterEnd, 'contract_termination_date');
  const rows = await originalInstallments(tx, contract, lock);
  const periodEnds = new Map<string, string>();
  for (const cycle of cycles) for (const s of cycleSchedule(termsOf(cycle))) periodEnds.set(`${cycle.id}:${s.installment}`, s.periodEnd);
  const closed = await closedMonths(
    tx,
    [contract.caixaId, contract.counterpartyCaixaId],
    rows.map((r) => r.competenceDate),
  );
  const preview: TerminationPreview = { terminatedOn, canceled: [], current: null, blockedClosed: [], keptSettled: 0 };
  for (const row of rows) {
    if (row.status === 'canceled') continue;
    const periodEnd = periodEnds.get(`${row.cycleId}:${row.installment}`) ?? row.competenceDate;
    if (row.competenceDate > terminatedOn) {
      if (row.settledCents > 0) preview.keptSettled += 1;
      else if (closed.has(monthStart(row.competenceDate)))
        preview.blockedClosed.push({ titleId: row.id, installment: row.installment!, competenceDate: row.competenceDate });
      else
        preview.canceled.push({
          titleId: row.id,
          installment: row.installment!,
          competenceDate: row.competenceDate,
          amountCents: row.amountCents,
        });
    } else if (terminatedOn < periodEnd) {
      preview.current = {
        titleId: row.id,
        installment: row.installment!,
        competenceDate: row.competenceDate,
        periodEnd,
        amountCents: row.amountCents,
        proratedCents: Math.max(1, proratedAmount(row.amountCents, row.competenceDate, periodEnd, terminatedOn)),
        settled: row.settledCents > 0,
      };
    }
  }
  return { ...preview, rows: new Map(rows.map((r) => [r.id, r])) };
}

export async function terminateContract(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractTerminationInput>,
  dryRun: boolean,
): Promise<{ preview: TerminationPreview; contract: ContractDetail | null }> {
  const contract = await loadContract(ctx.db, id);
  ctx.access.assertWrite(contract.caixaId);
  assertLive(contract);
  if (input.penalty) await assertCategory(ctx.db, input.penalty.categoryId, input.penalty.direction);
  if (dryRun) {
    const { rows: _r, ...preview } = await planTermination(ctx.db, contract, input.terminatedOn, false);
    return { preview, contract: null };
  }
  const preview = await withTx(ctx, async (tx) => {
    const locked = await loadContract(tx, id, true);
    assertLive(locked);
    const { rows, ...plan } = await planTermination(tx, locked, input.terminatedOn, true);
    for (const item of plan.canceled) await patchInstallment(ctx, tx, rows.get(item.titleId)!, { status: 'canceled' });
    if (plan.current && input.currentInstallmentCents && input.currentInstallmentCents !== plan.current.amountCents) {
      await patchInstallment(ctx, tx, rows.get(plan.current.titleId)!, { amountCents: input.currentInstallmentCents });
    }
    if (input.penalty) {
      const penalty = input.penalty;
      const mirror = await mirrorPlan(ctx, tx, locked);
      const mirrorForPenalty: MirrorPlan | null =
        mirror && penalty.direction !== locked.direction
          ? {
              ...mirror,
              categoryId: await defaultMirrorCategory(tx, mirror.caixaId, opposite(penalty.direction)),
            }
          : mirror;
      await insertTitlePair(
        tx,
        {
          caixaId: locked.caixaId,
          direction: penalty.direction,
          entityId: locked.entityId,
          categoryId: penalty.categoryId,
          description: penalty.description ?? t.contracts.termination.penaltyDescription(locked.name),
          competenceDate: input.terminatedOn,
          dueDate: penalty.dueDate,
          amountCents: penalty.amountCents,
          notes: null,
          origin: 'contract',
          recurrenceRuleId: null,
          occurrence: null,
          contractId: locked.id,
          contractCycleId: null,
          contractInstallment: null,
        },
        mirrorForPenalty,
      );
    }
    // A tarefa aberta (se houver) fica recusada: o contrato acabou.
    await tx.execute(sql`
      UPDATE contract_renewal_tasks SET status = 'declined', decided_at = now(), decided_by = ${ctx.access.actor.id},
             decision_notes = ${t.contracts.termination.done}
       WHERE contract_id = ${id} AND status = 'open'`);
    await tx.execute(sql`
      UPDATE contracts SET status = 'terminated', terminated_on = ${input.terminatedOn}::date, termination_notes = ${input.notes}
       WHERE id = ${id}`);
    return plan;
  });
  return { preview, contract: await getContract(ctx, id) };
}

/* ---------------- renovação ---------------- */

export async function renewContract(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractRenewalInput>,
  dryRun: boolean,
): Promise<{ preview: RenewalPreview; contract: ContractDetail | null }> {
  const contract = await loadContract(ctx.db, id);
  ctx.access.assertWrite(contract.caixaId);
  if (!['active', 'renewal_pending', 'ended'].includes(contract.status))
    throw unprocessable(contract.status === 'terminated' ? E.terminated : E.notActive, 'contract_not_active');
  if (input.categoryId) await assertCategory(ctx.db, input.categoryId, contract.direction);
  const latest = (await loadCycles(ctx.db, id)).at(-1);
  if (!latest) throw notFound();
  const terms = {
    startsOn: addDays(latest.endsOn, 1),
    durationMonths: input.durationMonths,
    periodicity: input.periodicity,
    totalCents: input.totalCents,
    dueDay: input.dueDay,
    dueMonthOffset: input.dueMonthOffset,
  };
  const schedule = cycleSchedule(terms);
  const closed = await closedMonths(
    ctx.db,
    [contract.caixaId, contract.counterpartyCaixaId],
    schedule.map((s) => s.competenceDate),
  );
  const preview: RenewalPreview = {
    startsOn: terms.startsOn,
    endsOn: cycleEnd(terms.startsOn, terms.durationMonths),
    installments: schedule,
    closedMonths: [...closed].sort(),
  };
  if (dryRun) return { preview, contract: null };

  await withTx(ctx, async (tx) => {
    const locked = await loadContract(tx, id, true);
    if (!['active', 'renewal_pending', 'ended'].includes(locked.status)) throw unprocessable(E.notActive, 'contract_not_active');
    const current = (await loadCycles(tx, id)).at(-1)!;
    if (current.id !== latest.id) throw unprocessable(t.errors.generic);
    const inserted = await tx.execute(sql`
      INSERT INTO contract_cycles (contract_id, seq, starts_on, duration_months, periodicity, total_cents, due_day, due_month_offset,
                                   readjustment_percent)
      VALUES (${id}, ${current.seq + 1}, ${terms.startsOn}::date, ${terms.durationMonths}, ${terms.periodicity}, ${terms.totalCents},
              ${terms.dueDay}, ${terms.dueMonthOffset}, ${input.readjustmentPercent})
      RETURNING id, contract_id, seq, starts_on, ends_on, duration_months, periodicity, installments_count, total_cents, due_day,
                due_month_offset, readjustment_percent`);
    const cycle = toCycle(inserted.rows[0]!);
    await tx.execute(sql`
      UPDATE contract_renewal_tasks SET status = 'approved', decided_at = now(), decided_by = ${ctx.access.actor.id},
             decision_notes = ${input.notes}, new_cycle_id = ${cycle.id}
       WHERE contract_id = ${id} AND status = 'open'`);
    const categoryId = input.categoryId ?? locked.categoryId;
    await tx.execute(sql`UPDATE contracts SET status = 'active', category_id = ${categoryId} WHERE id = ${id}`);
    await generateInstallments(ctx, tx, { ...locked, status: 'active', categoryId }, cycle);
    await syncLifecycle(tx, id);
  });
  return { preview, contract: await getContract(ctx, id) };
}

/** Não renovar: recusa a tarefa (ou registra a recusa antes de ela abrir); o contrato termina no fim do ciclo. */
export async function declineRenewal(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractDeclineInput>,
): Promise<ContractDetail> {
  await withTx(ctx, async (tx) => {
    const contract = await loadContract(tx, id, true);
    ctx.access.assertWrite(contract.caixaId);
    assertLive(contract);
    const latest = (await loadCycles(tx, id)).at(-1)!;
    const updated = await tx.execute(sql`
      UPDATE contract_renewal_tasks SET status = 'declined', decided_at = now(), decided_by = ${ctx.access.actor.id},
             decision_notes = ${input.notes}
       WHERE contract_id = ${id} AND status = 'open' RETURNING id`);
    if (updated.rows.length === 0) {
      const existing = await tx.execute(sql`SELECT 1 FROM contract_renewal_tasks WHERE contract_cycle_id = ${latest.id}`);
      if (existing.rows.length > 0) throw unprocessable(E.noTaskOpen, 'contract_no_task');
      await tx.execute(sql`
        INSERT INTO contract_renewal_tasks (contract_id, contract_cycle_id, status, opened_on, due_on, decided_at, decided_by, decision_notes)
        VALUES (${id}, ${latest.id}, 'declined', ${todayIso()}::date, ${latest.endsOn}::date, now(), ${ctx.access.actor.id}, ${input.notes})`);
    }
    if (contract.status === 'renewal_pending') await tx.execute(sql`UPDATE contracts SET status = 'active' WHERE id = ${id}`);
    await syncLifecycle(tx, id);
  });
  return getContract(ctx, id);
}

/* ---------------- painel de recorrentes ---------------- */

export async function recurringPanel(ctx: ServiceContext, caixaIds: string[]): Promise<RecurringPanelDto> {
  for (const id of caixaIds) ctx.access.assertRead(id);
  const today = todayIso();
  const from = monthStart(today);
  const until = addDays(addMonths(from, 12), -1);
  const readable = ctx.access.readableCaixaIds();
  const scope: string[] | 'all' = caixaIds.length > 0 ? caixaIds : readable;
  if (scope !== 'all' && scope.length === 0) return { months: [], renewSoon: [], pendingRenewals: [] };
  const inScope = (column: SQL) => (scope === 'all' ? sql`true` : sql`${column} = ANY (${uuidArray(scope)})`);
  // Um par espelhado com as duas caixas no escopo conta uma vez, pelo lado original.
  const result = await ctx.db.execute<{ month: string; receivable: number; payable: number }>(sql`
    SELECT to_char(date_trunc('month', x.competence_date), 'YYYY-MM-DD') AS month,
           coalesce(sum(x.amount_cents) FILTER (WHERE x.direction = 'receivable'), 0)::bigint AS receivable,
           coalesce(sum(x.amount_cents) FILTER (WHERE x.direction = 'payable'), 0)::bigint AS payable
      FROM titles x
      JOIN contracts c ON c.id = x.contract_id
     WHERE x.contract_cycle_id IS NOT NULL AND x.status <> 'canceled' AND x.archived_at IS NULL AND c.archived_at IS NULL
       AND x.competence_date BETWEEN ${from}::date AND ${until}::date
       AND ${inScope(sql`x.caixa_id`)}
       AND (x.mirror_status IS NULL OR NOT coalesce(${inScope(sql`x.counterparty_caixa_id`)}, false))
     GROUP BY 1 ORDER BY 1`);
  const byMonth = new Map(result.rows.map((r) => [r.month, r]));
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = addMonths(from, i);
    const row = byMonth.get(month);
    const receivableCents = Number(row?.receivable ?? 0);
    const payableCents = Number(row?.payable ?? 0);
    return { month, receivableCents, payableCents, netCents: receivableCents - payableCents };
  });
  const within = (await listContracts(ctx, { withinDays: 90, status: 'current', archived: false, limit: 500 })).filter(
    (c) => caixaIds.length === 0 || caixaIds.includes(c.caixaId),
  );
  return {
    months,
    renewSoon: within.filter((c) => c.status === 'active'),
    pendingRenewals: (await listContracts(ctx, { status: 'renewal_pending', archived: false, limit: 500 })).filter(
      (c) => caixaIds.length === 0 || caixaIds.includes(c.caixaId),
    ),
  };
}

/* ---------------- pagamentos (spec 033) ---------------- */

/**
 * Pagamentos das parcelas do contrato (contract_payments no banco), de um
 * ciclo ou de todos: as baixas repartidas, a data da que quitou e os dias de
 * atraso ou adiantamento; aqui entram os nomes das contas legíveis, a visão
 * por mês e o resumo.
 */
export async function contractPayments(ctx: ServiceContext, id: string, cycleId?: string): Promise<ContractPaymentsDto> {
  const contract = await loadContract(ctx.db, id);
  await contractReadMode(ctx, contract);
  if (cycleId) {
    const cycle = await ctx.db.execute(sql`SELECT 1 FROM contract_cycles WHERE id = ${cycleId} AND contract_id = ${id}`);
    if (cycle.rows.length === 0) throw notFound();
  }
  const result = await ctx.db.execute(sql`
    SELECT p.*, coalesce(p.funding_account_id, p.account_id) AS shown_account_id,
           a.name AS account_name, a.caixa_id AS account_caixa_id,
           pa.name AS planned_account_name, pa.caixa_id AS planned_account_caixa_id, pt.name AS planned_transit_account_name
      FROM contract_payments(${id}::uuid, ${cycleId ?? null}::uuid, ${todayIso()}::date) p
      LEFT JOIN financial_accounts a ON a.id = coalesce(p.funding_account_id, p.account_id)
      LEFT JOIN financial_accounts pa ON pa.id = p.planned_account_id
      LEFT JOIN financial_accounts pt ON pt.id = p.planned_transit_account_id
     ORDER BY p.cycle_seq, p.installment`);
  const readable = (caixaId: unknown, name: unknown) =>
    typeof caixaId === 'string' && ctx.access.canRead(caixaId) ? ((name as string | null) ?? null) : null;
  const rows: ContractPaymentRow[] = result.rows.map((raw) => {
    const r = camel<Record<string, unknown>>(raw);
    const settlements = (r.settlements as Record<string, unknown>[]).map((s) => {
      const x = camel<Record<string, unknown>>(s);
      return {
        id: String(x.id),
        settledOn: String(x.settledOn),
        amountCents: Number(x.amountCents),
        interestCents: Number(x.interestCents),
        fineCents: Number(x.fineCents),
        discountCents: Number(x.discountCents),
        cashCents: Number(x.cashCents),
        financialAccountId: (x.financialAccountId as string | null) ?? null,
        transferId: (x.transferId as string | null) ?? null,
        fundingAccountId: (x.fundingAccountId as string | null) ?? null,
        statementLineId: (x.statementLineId as string | null) ?? null,
        reconciled: Boolean(x.reconciled),
        origin: x.origin as PaymentOrigin,
        days: Number(x.days),
      };
    });
    return {
      titleId: String(r.titleId),
      cycleId: String(r.contractCycleId),
      cycleSeq: Number(r.cycleSeq),
      installment: Number(r.installment),
      installmentsCount: Number(r.installmentsCount),
      competenceDate: String(r.competenceDate),
      dueDate: String(r.dueDate),
      amountCents: Number(r.amountCents),
      status: r.status as TitleStatus,
      settledCents: Number(r.settledCents),
      openCents: Number(r.openCents),
      interestCents: Number(r.interestCents),
      fineCents: Number(r.fineCents),
      discountCents: Number(r.discountCents),
      cashCents: Number(r.cashCents),
      paidOn: (r.paidOn as string | null) ?? null,
      lastSettledOn: (r.lastSettledOn as string | null) ?? null,
      days: r.days === null ? null : Number(r.days),
      overdue: Boolean(r.overdue),
      accountId: (r.shownAccountId as string | null) ?? null,
      accountName: readable(r.accountCaixaId, r.accountName),
      lastOrigin: (r.lastOrigin as PaymentOrigin | null) ?? null,
      settlements,
      ...plannedOf(r),
      plannedAccountName: readable(r.plannedAccountCaixaId, r.plannedAccountName),
    };
  });
  return { contractId: id, cycleId: cycleId ?? null, months: paymentMonths(rows), rows, summary: paymentSummary(rows) };
}

function paymentMonths(rows: ContractPaymentRow[]): ContractPaymentsDto['months'] {
  const months = new Map<string, ContractPaymentsDto['months'][number]>();
  const at = (date: string) => {
    const month = monthStart(date);
    let entry = months.get(month);
    if (!entry) {
      entry = { month, plannedCents: 0, paidCents: 0, chargesCents: 0, discountCents: 0 };
      months.set(month, entry);
    }
    return entry;
  };
  for (const row of rows) {
    at(row.dueDate).plannedCents += row.amountCents;
    for (const s of row.settlements) {
      const entry = at(s.settledOn);
      entry.paidCents += s.amountCents;
      entry.chargesCents += s.fineCents + s.interestCents;
      entry.discountCents += s.discountCents;
    }
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function paymentSummary(rows: ContractPaymentRow[]): ContractPaymentsSummary {
  const paid = rows.filter((r) => r.status === 'paid');
  const delays = paid.map((r) => Math.max(0, r.days ?? 0));
  const late = rows.filter((r) => (r.days ?? 0) > 0).map((r) => r.days!);
  return {
    installments: rows.length,
    paid: paid.length,
    onTimePercent: paid.length ? Math.round((paid.filter((r) => (r.days ?? 0) <= 0).length / paid.length) * 100) : null,
    avgDelayDays: paid.length ? Math.round((delays.reduce((a, b) => a + b, 0) / paid.length) * 10) / 10 : null,
    maxDelayDays: late.length ? Math.max(...late) : null,
    chargesCents: rows.reduce((acc, r) => acc + r.fineCents + r.interestCents, 0),
    discountCents: rows.reduce((acc, r) => acc + r.discountCents, 0),
    open: rows.filter((r) => r.openCents > 0).length,
    overdue: rows.filter((r) => r.overdue).length,
  };
}
