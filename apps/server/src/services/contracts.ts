import type { Executor, Tx } from '@moneyflow/db';
import {
  type AmendmentPreview,
  addDays,
  addMonths,
  type CardChargeStatus,
  type ContractCycleDto,
  type ContractDetail,
  type ContractPaymentRow,
  type ContractPaymentsDto,
  type ContractPaymentsSummary,
  type ContractPeriodicity,
  type ContractRow,
  type ContractStatus,
  type ContractTitleDto,
  type contractAmendmentInput,
  type contractCreateInput,
  type contractListQuery,
  type contractRenewalInput,
  type contractTerminationInput,
  type contractUpdateInput,
  cycleEnd,
  type DeleteResult,
  diffDays,
  noticeDeadline,
  type ObligationNext,
  type obligationInput,
  occurrencePeriodEnd,
  type PaymentOrigin,
  proratedAmount,
  type ReadjustmentIndex,
  type RecurringPanelDto,
  type RenewalPreview,
  readjustmentDateIn,
  type SeriesChangeRow,
  type SeriesChangeSkipped,
  type TerminationPreview,
  type TitleStatus,
  t,
  termMonths,
  todayIso,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { readableFilter } from './caixas';
import { listContractDocuments } from './contract-documents';
import { assertPlannedAccount } from './planned-account';
import { MATERIALIZE_LOCK } from './recurrence';
import { uuidArray } from './reports';
import {
  closedMonths,
  insertObligation,
  loadRule,
  patchOccurrence,
  planSeriesChange,
  type SeriesOwner,
  seriesWhere,
  setSeriesContract,
} from './series';
import { insertTitlePair, type MirrorPlan, opposite } from './title-pair';
import { applySeriesEnd, defaultMirrorCategory, seriesEndPlanOf } from './titles';
import { deleteOrArchive, withTx } from './tx';
import { camel, iso } from './util';

/*
 * Contratos (specs 020 e 034). O contrato é o documento e o vínculo: caixa,
 * contraparte, direção, vigência, documentos, avisos e as obrigações — séries
 * recorrentes comuns (recurrence_rules.contract_id), cada uma na conta (ou no
 * cartão) onde o dinheiro de fato se move. O pagamento é sempre um fato: a
 * movimentação na conta ou a compra na fatura. Aditivo, renovação e rescisão
 * são operações das séries. Toda escrita passa por withTx (auditoria). Quem lê
 * a caixa da contraparte vê o contrato pelo título espelhado (somente leitura).
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
  startsOn: string;
  endsOn: string | null;
  autoRenew: boolean;
  noticeDays: number;
  readjustmentIndex: ReadjustmentIndex;
  readjustmentBaseDate: string | null;
  terminationPenaltyText: string | null;
  terminationPenaltyCents: number | null;
  terminatedOn: string | null;
  terminationNotes: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
};

const CONTRACT_COLUMNS = sql`c.id, c.caixa_id, c.entity_id, c.direction, c.name, c.contract_number, c.category_id, c.counterparty_caixa_id,
  c.status, c.starts_on, c.ends_on, c.auto_renew, c.notice_days, c.readjustment_index, c.readjustment_base_date,
  c.termination_penalty_text, c.termination_penalty_cents, c.terminated_on, c.termination_notes, c.notes, c.archived_at, c.created_at`;

function toContract(row: Record<string, unknown>): ContractRecord {
  const r = camel<ContractRecord>(row);
  return {
    ...r,
    terminationPenaltyCents: r.terminationPenaltyCents === null ? null : Number(r.terminationPenaltyCents),
    archivedAt: iso(r.archivedAt),
    createdAt: iso(r.createdAt)!,
  };
}

export async function loadContract(db: Executor, id: string, lock = false): Promise<ContractRecord> {
  const result = await db.execute(sql`SELECT ${CONTRACT_COLUMNS} FROM contracts c WHERE c.id = ${id} ${lock ? sql`FOR UPDATE` : sql``}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  return toContract(row);
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/* ---------------- acesso ---------------- */

/**
 * Leitura: quem lê a caixa do contrato, ou quem lê a caixa da contraparte
 * onde há título espelhado (somente leitura).
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

/** O contrato como dono de uma obrigação nova ou ligada: vigente (ou encerrado), com escrita na caixa dele. */
export async function contractOwner(ctx: ServiceContext, tx: Executor, contractId: string): Promise<SeriesOwner> {
  const contract = await loadContract(tx, contractId, true);
  ctx.access.assertWrite(contract.caixaId);
  if (contract.status === 'draft') throw unprocessable(E.obligationDraft, 'contracts_draft_titles_check');
  if (contract.status === 'terminated') throw unprocessable(E.obligationEnded, 'contract_terminated');
  return {
    contractId: contract.id,
    direction: contract.direction,
    entityId: contract.entityId,
    categoryId: contract.categoryId,
    mirrorCaixaId: contract.counterpartyCaixaId,
    endsOn: contract.endsOn,
  };
}

/* ---------------- leitura ---------------- */

const listSelect = sql`
  c.id, c.caixa_id, k.name AS caixa_name, c.entity_id, e.name AS entity_name, c.direction, c.name, c.contract_number,
  c.category_id, cat.name AS category_name, coalesce(cat.color_slot, pc.color_slot) AS category_color_slot, c.status, c.auto_renew,
  c.starts_on, c.ends_on, c.terminated_on, c.archived_at,
  (SELECT count(*)::int FROM recurrence_rules r WHERE r.contract_id = c.id) AS obligation_count,
  nx.id AS next_title_id, nx.due_date AS next_due_date, nx.open_cents AS next_open_cents, nx.recurrence_rule_id AS next_rule_id,
  nx.occurrence AS next_occurrence, nx.description AS next_description,
  (SELECT count(*)::int FROM titles w
    WHERE w.contract_id = c.id AND w.recurrence_rule_id IS NOT NULL AND w.mirror_status IS NULL AND w.archived_at IS NULL
      AND w.status IN ('open', 'partial') AND w.planned_account_id IS NULL) AS without_account`;

const listFrom = sql`
  FROM contracts c
  JOIN caixas k ON k.id = c.caixa_id
  JOIN entities e ON e.id = c.entity_id
  JOIN categories cat ON cat.id = c.category_id
  LEFT JOIN categories pc ON pc.id = cat.parent_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.due_date, b.open_cents, x.recurrence_rule_id, x.occurrence, x.description
      FROM titles x JOIN title_balances b ON b.title_id = x.id
     WHERE x.contract_id = c.id AND x.mirror_status IS NULL AND x.archived_at IS NULL AND b.open_cents > 0 AND x.status <> 'canceled'
     ORDER BY x.due_date, x.occurrence LIMIT 1) nx ON true`;

/** Contratos visíveis: da caixa legível, ou com título espelhado numa caixa legível. */
function visibleFilter(ctx: ServiceContext): SQL {
  return sql`(${readableFilter(ctx.access, sql`c.caixa_id`)} OR (c.counterparty_caixa_id IS NOT NULL
    AND ${readableFilter(ctx.access, sql`c.counterparty_caixa_id`)}
    AND EXISTS (SELECT 1 FROM titles mt WHERE mt.contract_id = c.id AND mt.caixa_id = c.counterparty_caixa_id)))`;
}

function toRow(ctx: ServiceContext, raw: Record<string, unknown>): ContractRow {
  const r = camel<Record<string, unknown>>(raw);
  const next: ObligationNext | null = r.nextTitleId
    ? {
        ruleId: String(r.nextRuleId ?? ''),
        occurrence: Number(r.nextOccurrence ?? 0),
        dueDate: String(r.nextDueDate),
        amountCents: Number(r.nextOpenCents),
        titleId: String(r.nextTitleId),
        description: String(r.nextDescription),
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
    startsOn: String(r.startsOn),
    endsOn: (r.endsOn as string | null) ?? null,
    obligationCount: Number(r.obligationCount),
    nextOccurrence: next,
    withoutAccount: Number(r.withoutAccount),
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
  if (query.status === 'current') where.push(sql`c.status = 'active'`);
  else if (query.status) where.push(sql`c.status = ${query.status}`);
  if (query.withinDays !== undefined) {
    const until = addDays(today, query.withinDays);
    where.push(sql`c.status = 'active' AND c.ends_on BETWEEN ${today}::date AND ${until}::date`);
  }
  if (query.q)
    where.push(sql`(c.name ILIKE ${`%${query.q}%`} OR c.contract_number ILIKE ${`%${query.q}%`} OR e.name ILIKE ${`%${query.q}%`})`);
  where.push(query.archived ? sql`c.archived_at IS NOT NULL` : sql`c.archived_at IS NULL`);
  const result = await ctx.db.execute(sql`
    SELECT ${listSelect} ${listFrom}
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, c.name, c.id
     LIMIT ${query.limit}`);
  return result.rows.map((row) => toRow(ctx, row));
}

async function contractRow(ctx: ServiceContext, id: string): Promise<ContractRow> {
  const result = await ctx.db.execute(sql`SELECT ${listSelect} ${listFrom} WHERE c.id = ${id}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  return toRow(ctx, raw);
}

function toCycle(raw: Record<string, unknown>): ContractCycleDto {
  const r = camel<Record<string, unknown>>(raw);
  return {
    id: String(r.id),
    seq: Number(r.seq),
    startsOn: String(r.startsOn),
    endsOn: (r.endsOn as string | null) ?? null,
    legacy:
      r.durationMonths === null
        ? null
        : {
            periodicity: r.periodicity as ContractPeriodicity,
            durationMonths: Number(r.durationMonths),
            installmentsCount: Number(r.installmentsCount),
            totalCents: Number(r.totalCents),
            dueDay: Number(r.dueDay),
          },
  };
}

async function loadCycles(db: Executor, contractId: string): Promise<ContractCycleDto[]> {
  const result = await db.execute(sql`
    SELECT y.id, y.seq, y.starts_on, y.ends_on, y.duration_months, y.periodicity, y.installments_count, y.total_cents, y.due_day
      FROM contract_cycles y WHERE y.contract_id = ${contractId} ORDER BY y.seq`);
  return result.rows.map(toCycle);
}

export async function getContract(ctx: ServiceContext, id: string): Promise<ContractDetail> {
  const contract = await loadContract(ctx.db, id);
  const mode = await contractReadMode(ctx, contract);
  const today = todayIso();
  const row = await contractRow(ctx, id);
  // Lado visto: a caixa do contrato, ou (pelo espelho) a caixa da contraparte.
  const extraSide = mode === 'owner' ? sql`x.mirror_status IS NULL` : sql`x.caixa_id = ${contract.counterpartyCaixaId}`;
  const [counterparty, amendments, tasks, documents, extras, cycles, obligations] = await Promise.all([
    contract.counterpartyCaixaId
      ? ctx.db.execute<{ name: string }>(sql`SELECT name FROM caixas WHERE id = ${contract.counterpartyCaixaId}`)
      : Promise.resolve(null),
    ctx.db.execute(sql`
      SELECT a.id, y.seq AS cycle_seq, a.effective_on, a.document_id, d.title AS document_title, a.changes, a.recurrence_rule_ids,
             coalesce(cardinality(a.affected_title_ids), 0) AS affected_count, coalesce(cardinality(a.skipped_title_ids), 0) AS skipped_count,
             a.notes, a.created_at, u.username AS created_by_name
        FROM contract_amendments a
        LEFT JOIN contract_cycles y ON y.id = a.contract_cycle_id
        LEFT JOIN contract_documents d ON d.id = a.document_id
        LEFT JOIN users u ON u.id = a.created_by
       WHERE a.contract_id = ${id}
       ORDER BY a.effective_on DESC, a.created_at DESC`),
    ctx.db.execute(sql`
      SELECT k.id, y.seq AS cycle_seq, k.status, k.opened_on, k.due_on, k.decided_at, u.username AS decided_by_name, k.decision_notes
        FROM contract_renewal_tasks k
        JOIN contract_cycles y ON y.id = k.contract_cycle_id
        LEFT JOIN users u ON u.id = k.decided_by
       WHERE k.contract_id = ${id}
       ORDER BY y.seq DESC`),
    listContractDocuments(ctx.db, id),
    ctx.db.execute(sql`
      SELECT x.id AS title_id, x.caixa_id, x.direction, x.description, x.competence_date, x.due_date, x.amount_cents, b.settled_cents,
             b.open_cents, x.status, (b.open_cents > 0 AND x.due_date < ${today}::date AND x.status <> 'canceled') AS overdue,
             (x.archived_at IS NOT NULL) AS archived
        FROM titles x JOIN title_balances b ON b.title_id = x.id
       WHERE x.contract_id = ${id} AND x.recurrence_rule_id IS NULL AND ${extraSide}
       ORDER BY x.due_date, x.created_at`),
    loadCycles(ctx.db, id),
    mode === 'owner' ? seriesWhere(ctx, ctx.db, sql`r.contract_id = ${id}`) : Promise.resolve([]),
  ]);

  // Aditivos que trocaram a categoria ou a conta: o nome entra junto do id, para a tela.
  const refIds = amendments.rows.flatMap((raw) => {
    const changes = raw.changes as { before: Record<string, unknown>; after: Record<string, unknown> };
    return [changes.before, changes.after].flatMap((side) =>
      [side.categoryId, side.accountId].filter((v): v is string => typeof v === 'string'),
    );
  });
  const names = new Map(
    refIds.length
      ? (
          await ctx.db.execute<{ id: string; name: string }>(sql`
            SELECT id, name FROM categories WHERE id = ANY (${uuidArray(refIds)})
            UNION ALL SELECT id, name FROM financial_accounts WHERE id = ANY (${uuidArray(refIds)})`)
        ).rows.map((r) => [r.id, r.name] as const)
      : [],
  );
  const named = (side: Record<string, unknown>) => ({
    ...side,
    ...(typeof side.categoryId === 'string' ? { categoryName: names.get(side.categoryId) ?? null } : {}),
    ...(typeof side.accountId === 'string' ? { accountName: names.get(side.accountId) ?? null } : {}),
  });

  const nextReadjustment =
    contract.readjustmentIndex === 'none'
      ? null
      : ([Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]
          .map((year) => readjustmentDateIn(year, contract.startsOn, contract.readjustmentBaseDate))
          .find((date) => date !== null && date >= today) ?? null);

  return {
    ...row,
    counterpartyCaixaId: contract.counterpartyCaixaId,
    counterpartyCaixaName: counterparty?.rows[0]?.name ?? null,
    notes: contract.notes,
    noticeDays: contract.noticeDays,
    readjustmentIndex: contract.readjustmentIndex,
    readjustmentBaseDate: contract.readjustmentBaseDate,
    terminationPenaltyText: contract.terminationPenaltyText,
    terminationPenaltyCents: contract.terminationPenaltyCents,
    terminationNotes: contract.terminationNotes,
    createdAt: contract.createdAt,
    noticeDeadline: contract.endsOn && contract.status === 'active' ? noticeDeadline(contract.endsOn, contract.noticeDays) : null,
    nextReadjustment,
    viaMirror: mode === 'mirror',
    canWrite: mode === 'owner' && ctx.access.canWrite(contract.caixaId),
    obligations,
    extraTitles: extras.rows.map((raw) => {
      const r = camel<Record<string, unknown>>(raw);
      return {
        titleId: String(r.titleId),
        caixaId: String(r.caixaId),
        direction: r.direction as Direction,
        description: String(r.description),
        competenceDate: String(r.competenceDate),
        dueDate: String(r.dueDate),
        amountCents: Number(r.amountCents),
        settledCents: Number(r.settledCents),
        openCents: Number(r.openCents),
        status: r.status as TitleStatus,
        overdue: Boolean(r.overdue),
        archived: Boolean(r.archived),
      } satisfies ContractTitleDto;
    }),
    cycles: [...cycles].reverse(),
    documents,
    amendments: amendments.rows.map((raw) => {
      const r = camel<Record<string, unknown>>(raw);
      return {
        id: String(r.id),
        cycleSeq: r.cycleSeq === null ? null : Number(r.cycleSeq),
        effectiveOn: String(r.effectiveOn),
        documentId: (r.documentId as string | null) ?? null,
        documentTitle: (r.documentTitle as string | null) ?? null,
        ruleIds: (r.recurrenceRuleIds as string[] | null) ?? [],
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
        cycleSeq: Number(r.cycleSeq),
        status: r.status as 'approved' | 'declined' | 'closed',
        openedOn: String(r.openedOn),
        dueOn: String(r.dueOn),
        decidedAt: iso(r.decidedAt),
        decidedByName: (r.decidedByName as string | null) ?? null,
        decisionNotes: (r.decisionNotes as string | null) ?? null,
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

const ownerOf = (contract: ContractRecord): SeriesOwner => ({
  contractId: contract.id,
  direction: contract.direction,
  entityId: contract.entityId,
  categoryId: contract.categoryId,
  mirrorCaixaId: contract.counterpartyCaixaId,
  endsOn: contract.endsOn,
});

/* ---------------- ciclo de vida (também usado pelo worker) ---------------- */

/**
 * Pelo calendário (worker, como ator `system`): o contrato vigente que passou
 * do fim é renovado pelo mesmo prazo, com as obrigações estendidas (renovação
 * automática), ou encerrado. Devolve o que aconteceu.
 */
export async function syncLifecycle(
  ctx: ServiceContext,
  tx: Tx,
  contractId: string,
  today = todayIso(),
): Promise<{ action: 'renewed'; startsOn: string; endsOn: string; seq: number } | { action: 'ended' } | null> {
  const contract = await loadContract(tx, contractId, true);
  if (contract.status !== 'active' || contract.archivedAt || !contract.endsOn || today <= contract.endsOn) return null;
  if (!contract.autoRenew) {
    await tx.execute(sql`UPDATE contracts SET status = 'ended' WHERE id = ${contractId}`);
    return { action: 'ended' };
  }
  // Renova quantas vezes for preciso para cobrir hoje (o worker pode ter ficado parado).
  const cycles = await loadCycles(tx, contractId);
  const last = cycles.at(-1);
  const months = termMonths(last?.startsOn ?? contract.startsOn, contract.endsOn);
  let endsOn = contract.endsOn;
  while (endsOn < today) endsOn = cycleEnd(addDays(endsOn, 1), months);
  const renewed = await renewInTx(ctx, tx, contract, endsOn);
  return { action: 'renewed', startsOn: addDays(contract.endsOn, 1), endsOn, seq: renewed.seq };
}

/* ---------------- escrita ---------------- */

export async function createContract(ctx: ServiceContext, input: z.output<typeof contractCreateInput>): Promise<ContractDetail> {
  ctx.access.assertWrite(input.caixaId);
  const activate = input.activate ?? input.obligations.length > 0;
  const id = await withTx(ctx, async (tx) => {
    await assertCaixaAndEntity(tx, input.caixaId, input.entityId);
    await assertCategory(tx, input.categoryId, input.direction);
    const counterparty = await resolveCounterparty(tx, input.caixaId, input.entityId, input.mirrorCaixaId);
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO contracts (caixa_id, entity_id, direction, name, contract_number, category_id, counterparty_caixa_id, auto_renew,
                             notice_days, readjustment_index, readjustment_base_date, termination_penalty_text,
                             termination_penalty_cents, notes, created_by, starts_on, ends_on, status)
      VALUES (${input.caixaId}, ${input.entityId}, ${input.direction}, ${input.name}, ${input.contractNumber}, ${input.categoryId},
              ${counterparty}, ${input.autoRenew}, ${input.noticeDays}, ${input.readjustmentIndex}, ${input.readjustmentBaseDate},
              ${input.terminationPenaltyText}, ${input.terminationPenaltyCents}, ${input.notes}, ${ctx.access.actor.id},
              ${input.startsOn}::date, ${input.endsOn}::date, ${activate ? 'active' : 'draft'})
      RETURNING id`);
    const contractId = inserted.rows[0]!.id;
    await tx.execute(sql`
      INSERT INTO contract_cycles (contract_id, seq, starts_on, ends_on)
      VALUES (${contractId}, 1, ${input.startsOn}::date, ${input.endsOn}::date)`);
    const contract = await loadContract(tx, contractId);
    for (const obligation of input.obligations) await insertObligation(ctx, tx, obligation, ownerOf(contract));
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
  'readjustmentIndex',
  'readjustmentBaseDate',
  'terminationPenaltyText',
  'terminationPenaltyCents',
] as const;

const COLUMN: Record<(typeof FREE_FIELDS)[number], string> = {
  name: 'name',
  contractNumber: 'contract_number',
  notes: 'notes',
  autoRenew: 'auto_renew',
  noticeDays: 'notice_days',
  readjustmentIndex: 'readjustment_index',
  readjustmentBaseDate: 'readjustment_base_date',
  terminationPenaltyText: 'termination_penalty_text',
  terminationPenaltyCents: 'termination_penalty_cents',
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
    const lockedChange =
      (input.startsOn !== undefined && input.startsOn !== contract.startsOn) ||
      (input.endsOn !== undefined && input.endsOn !== contract.endsOn) ||
      (input.entityId !== undefined && input.entityId !== contract.entityId) ||
      (input.categoryId !== undefined && input.categoryId !== contract.categoryId) ||
      (input.mirrorCaixaId !== undefined && input.mirrorCaixaId !== contract.counterpartyCaixaId);
    if (lockedChange && !draft) throw unprocessable(t.contracts.lockedActive, 'contract_locked');

    const sets: SQL[] = [];
    for (const key of FREE_FIELDS) {
      if (input[key] !== undefined) sets.push(sql`${sql.identifier(COLUMN[key])} = ${input[key]}`);
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
      const startsOn = input.startsOn ?? contract.startsOn;
      const endsOn = input.endsOn !== undefined ? input.endsOn : contract.endsOn;
      if (endsOn && endsOn < startsOn) throw unprocessable(E.endsBeforeStart, 'contracts_ends_on_check');
      if (input.startsOn !== undefined || input.endsOn !== undefined) {
        sets.push(sql`starts_on = ${startsOn}::date, ends_on = ${endsOn}::date`);
        await tx.execute(sql`UPDATE contract_cycles SET starts_on = ${startsOn}::date, ends_on = ${endsOn}::date
          WHERE contract_id = ${id} AND seq = 1 AND duration_months IS NULL`);
      }
    }
    if (sets.length > 0) await tx.execute(sql`UPDATE contracts SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
  });
  return getContract(ctx, id);
}

export async function activateContract(ctx: ServiceContext, id: string): Promise<ContractDetail> {
  await withTx(ctx, async (tx) => {
    const contract = await loadContract(tx, id, true);
    ctx.access.assertWrite(contract.caixaId);
    if (contract.status !== 'draft') throw unprocessable(E.alreadyActive, 'contract_not_draft');
    await tx.execute(sql`UPDATE contracts SET status = 'active' WHERE id = ${id}`);
  });
  return getContract(ctx, id);
}

/** Rascunho sem vínculos é excluído; o resto é arquivado (as ocorrências continuam como títulos). */
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

/* ---------------- obrigações ---------------- */

export async function addObligation(ctx: ServiceContext, id: string, input: z.output<typeof obligationInput>): Promise<ContractDetail> {
  await withTx(ctx, async (tx) => insertObligation(ctx, tx, input, await contractOwner(ctx, tx, id)));
  return getContract(ctx, id);
}

/** Liga uma série existente ao contrato: ela e as ocorrências (e compras ligadas) passam a ser obrigação dele. */
export async function linkObligation(ctx: ServiceContext, id: string, ruleId: string): Promise<ContractDetail> {
  await withTx(ctx, async (tx) => {
    const owner = await contractOwner(ctx, tx, id);
    const rule = await loadRule(tx, ruleId, true);
    ctx.access.assertWrite(rule.caixaId);
    await setSeriesContract(tx, rule, { id, direction: owner.direction, entityId: owner.entityId });
  });
  return getContract(ctx, id);
}

function assertLive(contract: ContractRecord) {
  if (contract.status === 'terminated') throw unprocessable(E.terminated, 'contract_terminated');
  if (contract.status !== 'active') throw unprocessable(E.notActive, 'contract_not_active');
}

async function contractRuleIds(tx: Executor, contractId: string): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(
    sql`SELECT id FROM recurrence_rules WHERE contract_id = ${contractId} ORDER BY created_at, id`,
  );
  return result.rows.map((r) => r.id);
}

/* ---------------- aditivo ---------------- */

type AmendmentPlan = AmendmentPreview & { applies: ((tx: Tx) => Promise<void>)[] };

async function planAmendment(
  ctx: ServiceContext,
  tx: Executor,
  contract: ContractRecord,
  input: z.output<typeof contractAmendmentInput>,
  lock: boolean,
): Promise<AmendmentPlan> {
  const own = new Set(await contractRuleIds(tx, contract.id));
  const affected: SeriesChangeRow[] = [];
  const skipped: SeriesChangeSkipped[] = [];
  const cardFrom: AmendmentPreview['cardFrom'] = [];
  const applies: ((tx: Tx) => Promise<void>)[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const ruleId of input.ruleIds) {
    if (!own.has(ruleId)) throw notFound();
    const rule = await loadRule(tx, ruleId, lock);
    ctx.access.assertWrite(rule.caixaId);
    const plan = await planSeriesChange(
      ctx,
      tx,
      rule,
      {
        amountCents: input.amountCents,
        readjustmentPercent: input.readjustmentPercent,
        anchorDay: input.anchorDay,
        categoryId: input.categoryId,
        accountId: rule.card ? null : input.accountId,
      },
      input.effectiveOn,
      lock,
    );
    affected.push(...plan.affected);
    skipped.push(...plan.skipped);
    cardFrom.push(...plan.cardFrom);
    applies.push(plan.apply);
    for (const [k, v] of Object.entries(plan.before)) if (before[k] === undefined) before[k] = v;
    for (const [k, v] of Object.entries(plan.after)) if (after[k] === undefined) after[k] = v;
  }
  if (input.readjustmentPercent) after.readjustmentPercent = input.readjustmentPercent;
  return { effectiveOn: input.effectiveOn, ruleIds: input.ruleIds, affected, skipped, cardFrom, changes: { before, after }, applies };
}

const publicPlan = ({ applies: _a, ...preview }: AmendmentPlan): AmendmentPreview => preview;

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
  if (dryRun) return { preview: publicPlan(await planAmendment(ctx, ctx.db, contract, input, false)), contract: null };

  const preview = await withTx(ctx, async (tx) => {
    const locked = await loadContract(tx, id, true);
    assertLive(locked);
    const plan = await planAmendment(ctx, tx, locked, input, true);
    for (const apply of plan.applies) await apply(tx);
    const cycle = await tx.execute<{ id: string }>(sql`
      SELECT id FROM contract_cycles WHERE contract_id = ${id} AND starts_on <= ${input.effectiveOn}::date
       ORDER BY seq DESC LIMIT 1`);
    await tx.execute(sql`
      INSERT INTO contract_amendments (contract_id, contract_cycle_id, document_id, effective_on, changes, affected_title_ids,
                                       skipped_title_ids, recurrence_rule_ids, notes, created_by)
      VALUES (${id}, ${cycle.rows[0]?.id ?? null}, ${input.documentId}, ${input.effectiveOn}::date, ${JSON.stringify(plan.changes)}::jsonb,
              ${uuidArray(plan.affected.map((a) => a.titleId).filter((v): v is string => !!v))},
              ${uuidArray(plan.skipped.map((s) => s.titleId))}, ${uuidArray(input.ruleIds)}, ${input.notes}, ${ctx.access.actor.id})`);
    return publicPlan(plan);
  });
  return { preview, contract: await getContract(ctx, id) };
}

/* ---------------- rescisão ---------------- */

type TerminationRow = {
  id: string;
  ruleId: string;
  occurrence: number | null;
  mirrorTitleId: string | null;
  mirrorCaixaId: string | null;
  mirrorStatus: string | null;
  competenceDate: string;
  dueDate: string;
  amountCents: number;
  settledCents: number;
  status: TitleStatus;
};

type TerminationPlan = TerminationPreview & {
  rows: Map<string, TerminationRow>;
  /** Novo fim de cada série. */
  ruleEnds: { ruleId: string; endsOn: string }[];
};

/** A rescisão nunca estende a série: uma obrigação que já acabava antes fica com o fim dela. */
const notLater = (rule: { endsOn?: string | null }, endsOn: string) => (rule.endsOn && rule.endsOn < endsOn ? rule.endsOn : endsOn);

async function planTermination(
  ctx: ServiceContext,
  tx: Executor,
  contract: ContractRecord,
  terminatedOn: string,
  lock: boolean,
): Promise<TerminationPlan> {
  if (terminatedOn < contract.startsOn) throw unprocessable(E.terminationBeforeStart, 'contract_termination_date');
  if (contract.endsOn && terminatedOn > contract.endsOn) throw unprocessable(E.terminationAfterEnd, 'contract_termination_date');
  const preview: TerminationPlan = {
    terminatedOn,
    canceled: [],
    last: [],
    blockedClosed: [],
    keptSettled: 0,
    cardRules: 0,
    rows: new Map(),
    ruleEnds: [],
  };
  for (const ruleId of await contractRuleIds(tx, contract.id)) {
    const rule = await loadRule(tx, ruleId, lock);
    ctx.access.assertWrite(rule.caixaId);
    if (rule.card) {
      preview.cardRules += 1;
      preview.ruleEnds.push({ ruleId, endsOn: notLater(rule, terminatedOn > rule.startsOn ? terminatedOn : rule.startsOn) });
      continue;
    }
    const result = await tx.execute(sql`
      SELECT x.id, x.recurrence_rule_id AS rule_id, x.occurrence, x.mirror_title_id, m.caixa_id AS mirror_caixa_id, m.mirror_status,
             x.competence_date, x.due_date, x.amount_cents, b.settled_cents, x.status
        FROM titles x JOIN title_balances b ON b.title_id = x.id LEFT JOIN titles m ON m.id = x.mirror_title_id
       WHERE x.recurrence_rule_id = ${ruleId} AND x.mirror_status IS NULL
       ORDER BY x.occurrence ${lock ? sql`FOR UPDATE OF x` : sql``}`);
    const rows = result.rows.map((raw) => {
      const r = camel<TerminationRow>(raw);
      return { ...r, amountCents: Number(r.amountCents), settledCents: Number(r.settledCents) };
    });
    const closed = await closedMonths(
      tx,
      [rule.caixaId, ...new Set(rows.map((r) => r.mirrorCaixaId))],
      rows.map((r) => r.competenceDate),
    );
    let lastDue = terminatedOn;
    for (const row of rows) {
      preview.rows.set(row.id, row);
      if (row.status === 'canceled') continue;
      const item = {
        ruleId,
        titleId: row.id,
        occurrence: row.occurrence,
        competenceDate: row.competenceDate,
        dueDate: row.dueDate,
        amountCents: row.amountCents,
      };
      if (row.competenceDate > terminatedOn) {
        if (row.settledCents > 0) preview.keptSettled += 1;
        else if (closed.has(monthStart(row.competenceDate))) preview.blockedClosed.push(item);
        else preview.canceled.push(item);
        if (row.settledCents > 0 || closed.has(monthStart(row.competenceDate))) lastDue = row.dueDate > lastDue ? row.dueDate : lastDue;
        continue;
      }
      if (row.dueDate > lastDue) lastDue = row.dueDate;
      const periodEnd = occurrencePeriodEnd(row.competenceDate, rule);
      if (terminatedOn < periodEnd)
        preview.last.push({
          ...item,
          periodEnd,
          proratedCents: Math.max(1, proratedAmount(row.amountCents, row.competenceDate, periodEnd, terminatedOn)),
          settled: row.settledCents > 0,
        });
    }
    preview.ruleEnds.push({ ruleId, endsOn: notLater(rule, lastDue > rule.startsOn ? lastDue : rule.startsOn) });
  }
  return preview;
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
  const strip = ({ rows: _r, ruleEnds: _e, ...preview }: TerminationPlan): TerminationPreview => preview;
  if (dryRun) return { preview: strip(await planTermination(ctx, ctx.db, contract, input.terminatedOn, false)), contract: null };
  const preview = await withTx(ctx, async (tx) => {
    const locked = await loadContract(tx, id, true);
    assertLive(locked);
    for (const ruleId of await contractRuleIds(tx, id))
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${MATERIALIZE_LOCK}, hashtext(${ruleId}))`);
    const plan = await planTermination(ctx, tx, locked, input.terminatedOn, true);
    for (const item of plan.canceled) await patchOccurrence(ctx, tx, plan.rows.get(item.titleId)!, { status: 'canceled' });
    for (const change of input.lastAmounts) {
      const last = plan.last.find((l) => l.titleId === change.titleId);
      if (!last || last.settled || change.amountCents === last.amountCents) continue;
      await patchOccurrence(ctx, tx, plan.rows.get(change.titleId)!, { amountCents: change.amountCents });
    }
    for (const end of plan.ruleEnds)
      await tx.execute(sql`UPDATE recurrence_rules SET ends_on = ${end.endsOn}::date WHERE id = ${end.ruleId}`);
    if (input.penalty) {
      const penalty = input.penalty;
      const accountId = await assertPlannedAccount(tx, locked.caixaId, penalty.accountId);
      let mirror: MirrorPlan | null = null;
      if (locked.counterpartyCaixaId) {
        const holder = await tx.execute<{ holder_entity_id: string }>(
          sql`SELECT holder_entity_id FROM caixas WHERE id = ${locked.caixaId}`,
        );
        mirror = {
          caixaId: locked.counterpartyCaixaId,
          entityId: holder.rows[0]!.holder_entity_id,
          categoryId: await defaultMirrorCategory(tx, locked.counterpartyCaixaId, opposite(penalty.direction)),
          status: ctx.access.canWrite(locked.counterpartyCaixaId) ? 'accepted' : 'pending',
        };
      }
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
          origin: 'manual',
          recurrenceRuleId: null,
          occurrence: null,
          contractId: locked.id,
          plannedAccountId: accountId,
        },
        mirror,
      );
    }
    // Encerrar e rescindir no mesmo UPDATE: terminated_on = ends_on (contracts_terminated_on_check).
    await tx.execute(sql`
      UPDATE contracts SET status = 'terminated', terminated_on = ${input.terminatedOn}::date, ends_on = ${input.terminatedOn}::date,
             termination_notes = ${input.notes}
       WHERE id = ${id}`);
    return strip(plan);
  });
  return { preview, contract: await getContract(ctx, id) };
}

/* ---------------- renovação ---------------- */

/**
 * As obrigações que acompanham a vigência: as séries com fim (por data) que
 * iam até o fim do contrato (o fim da série a menos de um período do fim da
 * vigência). Uma obrigação que já tinha acabado antes não volta.
 */
async function renewableRules(tx: Executor, contract: ContractRecord) {
  if (!contract.endsOn) return [];
  const result = await tx.execute<{
    id: string;
    ends_on: string;
    frequency: string;
    interval_count: number;
    description: string | null;
    card: boolean;
  }>(sql`
    SELECT r.id, r.ends_on, r.frequency, r.interval_count, r.ends_on,
           coalesce(g.description, (SELECT x.description FROM titles x WHERE x.recurrence_rule_id = r.id AND x.mirror_status IS NULL
                                     ORDER BY x.occurrence DESC LIMIT 1)) AS description,
           g.recurrence_rule_id IS NOT NULL AS card
      FROM recurrence_rules r LEFT JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
     WHERE r.contract_id = ${contract.id} AND r.ends_on IS NOT NULL AND r.installments_total IS NULL
     ORDER BY r.created_at, r.id`);
  return result.rows.filter((r) => {
    const back =
      r.frequency === 'weekly'
        ? addDays(contract.endsOn!, -7 * Number(r.interval_count))
        : addMonths(contract.endsOn!, -(r.frequency === 'yearly' ? 12 : 1) * Number(r.interval_count));
    return r.ends_on > back;
  });
}

/** Novo fim da série: o antigo deslocado pelo mesmo tanto que a vigência (ou sem fim). */
function shiftedEnd(rule: { ends_on: string; frequency: string }, oldEnd: string, newEnd: string | null): string | null {
  if (newEnd === null) return null;
  if (rule.frequency === 'weekly') return addDays(rule.ends_on, diffDays(oldEnd, newEnd));
  return addMonths(rule.ends_on, termMonths(addDays(oldEnd, 1), newEnd));
}

async function planRenewal(tx: Executor, contract: ContractRecord, endsOn: string | null): Promise<RenewalPreview> {
  if (!contract.endsOn) throw unprocessable(t.contracts.renewal.indeterminateBlocked, 'contract_indeterminate');
  if (endsOn !== null && endsOn <= contract.endsOn) throw unprocessable(E.renewBeforeEnd, 'contract_renew_date');
  const rules = await renewableRules(tx, contract);
  return {
    startsOn: addDays(contract.endsOn, 1),
    endsOn,
    rules: rules.map((r) => ({
      ruleId: r.id,
      description: r.description ?? '',
      kind: r.card ? 'card' : 'account',
      endsOn: shiftedEnd(r, contract.endsOn!, endsOn),
    })),
  };
}

/** Renovar numa transação aberta: a nova vigência, o fim do contrato e o das obrigações (o "estender série"). */
async function renewInTx(
  ctx: ServiceContext,
  tx: Tx,
  contract: ContractRecord,
  endsOn: string | null,
): Promise<RenewalPreview & { seq: number }> {
  const preview = await planRenewal(tx, contract, endsOn);
  const last = await tx.execute<{ seq: number }>(sql`SELECT max(seq)::int AS seq FROM contract_cycles WHERE contract_id = ${contract.id}`);
  const seq = Number(last.rows[0]?.seq ?? 0) + 1;
  await tx.execute(sql`
    INSERT INTO contract_cycles (contract_id, seq, starts_on, ends_on)
    VALUES (${contract.id}, ${seq}, ${preview.startsOn}::date, ${endsOn}::date)`);
  await tx.execute(sql`UPDATE contracts SET status = 'active', ends_on = ${endsOn}::date WHERE id = ${contract.id}`);
  for (const rule of preview.rules) {
    const plan = await seriesEndPlanOf(ctx, tx, rule.ruleId, rule.endsOn, true);
    await applySeriesEnd(tx, plan);
  }
  return { ...preview, seq };
}

export async function renewContract(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractRenewalInput>,
  dryRun: boolean,
): Promise<{ preview: RenewalPreview; contract: ContractDetail | null }> {
  const contract = await loadContract(ctx.db, id);
  ctx.access.assertWrite(contract.caixaId);
  if (contract.status === 'terminated') throw unprocessable(E.terminated, 'contract_terminated');
  if (contract.status === 'draft') throw unprocessable(E.notActive, 'contract_not_active');
  if (dryRun) return { preview: await planRenewal(ctx.db, contract, input.endsOn), contract: null };
  const preview = await withTx(ctx, async (tx) => {
    const locked = await loadContract(tx, id, true);
    if (locked.status === 'terminated' || locked.status === 'draft') throw unprocessable(E.notActive, 'contract_not_active');
    const { seq: _s, ...done } = await renewInTx(ctx, tx, locked, input.endsOn);
    return done;
  });
  return { preview, contract: await getContract(ctx, id) };
}

/* ---------------- painel de recorrentes ---------------- */

export async function recurringPanel(ctx: ServiceContext, caixaIds: string[]): Promise<RecurringPanelDto> {
  for (const id of caixaIds) ctx.access.assertRead(id);
  const today = todayIso();
  const from = monthStart(today);
  const until = addDays(addMonths(from, 12), -1);
  const readable = ctx.access.readableCaixaIds();
  const scope: string[] | 'all' = caixaIds.length > 0 ? caixaIds : readable;
  if (scope !== 'all' && scope.length === 0) return { months: [], renewSoon: [], recentlyEnded: [] };
  const inScope = (column: SQL) => (scope === 'all' ? sql`true` : sql`${column} = ANY (${uuidArray(scope)})`);
  // Ocorrências (títulos) das obrigações: um par espelhado com as duas caixas no escopo conta uma vez, pelo lado original.
  const titles = await ctx.db.execute<{ month: string; receivable: number; payable: number }>(sql`
    SELECT to_char(date_trunc('month', x.competence_date), 'YYYY-MM-DD') AS month,
           coalesce(sum(x.amount_cents) FILTER (WHERE x.direction = 'receivable'), 0)::bigint AS receivable,
           coalesce(sum(x.amount_cents) FILTER (WHERE x.direction = 'payable'), 0)::bigint AS payable
      FROM titles x
      JOIN contracts c ON c.id = x.contract_id
     WHERE x.status <> 'canceled' AND x.archived_at IS NULL AND c.archived_at IS NULL
       AND x.competence_date BETWEEN ${from}::date AND ${until}::date
       AND ${inScope(sql`x.caixa_id`)}
       AND (x.mirror_status IS NULL OR NOT coalesce(${inScope(sql`x.counterparty_caixa_id`)}, false))
     GROUP BY 1`);
  // Cobranças esperadas no cartão (pela pagadora): o valor esperado de cada ocorrência no mês.
  const cards = await ctx.db.execute<{ month: string; payable: number }>(sql`
    SELECT to_char(p.competence_date, 'YYYY-MM-DD') AS month, sum(p.amount_cents)::bigint AS payable
      FROM contracts c
      CROSS JOIN LATERAL contract_payments(c.id, ${from}::date, ${until}::date, ${today}::date) p
      JOIN card_recurring_charges g ON g.recurrence_rule_id = p.recurrence_rule_id
     WHERE c.archived_at IS NULL AND p.kind = 'card_charge' AND ${inScope(sql`g.payer_caixa_id`)}
       AND EXISTS (SELECT 1 FROM recurrence_rules r JOIN card_recurring_charges h ON h.recurrence_rule_id = r.id WHERE r.contract_id = c.id)
     GROUP BY 1`);
  const byMonth = new Map<string, { receivable: number; payable: number }>();
  for (const r of titles.rows) byMonth.set(r.month, { receivable: Number(r.receivable), payable: Number(r.payable) });
  for (const r of cards.rows) {
    const entry = byMonth.get(r.month) ?? { receivable: 0, payable: 0 };
    entry.payable += Number(r.payable);
    byMonth.set(r.month, entry);
  }
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = addMonths(from, i);
    const row = byMonth.get(month);
    const receivableCents = row?.receivable ?? 0;
    const payableCents = row?.payable ?? 0;
    return { month, receivableCents, payableCents, netCents: receivableCents - payableCents };
  });
  const inCaixas = (c: ContractRow) => caixaIds.length === 0 || caixaIds.includes(c.caixaId);
  const ended = await listContracts(ctx, { status: 'ended', archived: false, limit: 500 });
  return {
    months,
    renewSoon: (await listContracts(ctx, { withinDays: 90, status: 'current', archived: false, limit: 500 })).filter(inCaixas),
    recentlyEnded: ended.filter((c) => inCaixas(c) && c.endsOn !== null && c.endsOn >= addDays(today, -90)),
  };
}

/* ---------------- pagamentos (specs 033 e 034) ---------------- */

/**
 * Pagamentos das obrigações (contract_payments no banco), de uma vigência ou
 * de todas: as ocorrências das séries com as baixas repartidas, as cobranças
 * no cartão com a compra ligada (ou "não cobrada") e os títulos avulsos, com
 * os dias de atraso ou adiantamento; aqui entram os nomes das contas legíveis,
 * a visão por mês e o resumo.
 */
export async function contractPayments(ctx: ServiceContext, id: string, cycleId?: string): Promise<ContractPaymentsDto> {
  const contract = await loadContract(ctx.db, id);
  await contractReadMode(ctx, contract);
  let range: { from: string | null; to: string | null } = { from: null, to: null };
  if (cycleId) {
    const cycle = await ctx.db.execute<{ starts_on: string; ends_on: string | null }>(
      sql`SELECT starts_on, ends_on FROM contract_cycles WHERE id = ${cycleId} AND contract_id = ${id}`,
    );
    const row = cycle.rows[0];
    if (!row) throw notFound();
    range = { from: row.starts_on, to: row.ends_on };
  }
  const result = await ctx.db.execute(sql`
    SELECT p.*, a.name AS account_name, a.caixa_id AS account_caixa_id, pa.name AS planned_account_name, pa.caixa_id AS planned_caixa_id
      FROM contract_payments(${id}::uuid, ${range.from}::date, ${range.to}::date, ${todayIso()}::date) p
      LEFT JOIN financial_accounts a ON a.id = coalesce(p.funding_account_id, p.account_id)
      LEFT JOIN financial_accounts pa ON pa.id = p.planned_account_id
     WHERE ${readableFilter(ctx.access, sql`p.caixa_id`)} OR p.kind = 'card_charge'
     ORDER BY p.due_date, p.kind DESC, p.occurrence NULLS LAST, p.title_id, p.card_purchase_id`);
  const readable = (caixaId: unknown, name: unknown) =>
    typeof caixaId === 'string' && ctx.access.canRead(caixaId) ? ((name as string | null) ?? null) : null;
  const rows: ContractPaymentRow[] = result.rows.map((raw) => {
    const r = camel<Record<string, unknown>>(raw);
    const settlements = (r.settlements as Record<string, unknown>[]).map((s) => {
      const x = camel<Record<string, unknown>>(s);
      return {
        id: String(x.id ?? x.cardPurchaseId),
        settledOn: String(x.settledOn ?? x.purchasedOn),
        amountCents: Number(x.amountCents),
        interestCents: Number(x.interestCents ?? 0),
        fineCents: Number(x.fineCents ?? 0),
        discountCents: Number(x.discountCents ?? 0),
        cashCents: Number(x.cashCents ?? x.amountCents),
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
      kind: r.kind as 'title' | 'card_charge',
      ruleId: (r.recurrenceRuleId as string | null) ?? null,
      occurrence: r.occurrence === null ? null : Number(r.occurrence),
      titleId: (r.titleId as string | null) ?? null,
      cardPurchaseId: (r.cardPurchaseId as string | null) ?? null,
      cardInvoiceId: (r.cardInvoiceId as string | null) ?? null,
      caixaId: String(r.caixaId),
      description: String(r.description),
      competenceDate: String(r.competenceDate),
      dueDate: String(r.dueDate),
      amountCents: Number(r.amountCents),
      status: r.status as TitleStatus | CardChargeStatus,
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
      notCharged: Boolean(r.notCharged),
      accountId: (r.fundingAccountId as string | null) ?? (r.accountId as string | null) ?? null,
      accountName: readable(r.accountCaixaId, r.accountName),
      plannedAccountId: (r.plannedAccountId as string | null) ?? null,
      plannedAccountName: readable(r.plannedCaixaId, r.plannedAccountName),
      lastOrigin: (r.lastOrigin as PaymentOrigin | null) ?? null,
      settlements,
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

const isPaid = (r: ContractPaymentRow) => r.status === 'paid' || r.status === 'charged';

function paymentSummary(rows: ContractPaymentRow[]): ContractPaymentsSummary {
  const paid = rows.filter(isPaid);
  const delays = paid.map((r) => Math.max(0, r.days ?? 0));
  const late = rows.filter((r) => (r.days ?? 0) > 0).map((r) => r.days!);
  return {
    occurrences: rows.length,
    paid: paid.length,
    onTimePercent: paid.length ? Math.round((paid.filter((r) => (r.days ?? 0) <= 0).length / paid.length) * 100) : null,
    avgDelayDays: paid.length ? Math.round((delays.reduce((a, b) => a + b, 0) / paid.length) * 10) / 10 : null,
    maxDelayDays: late.length ? Math.max(...late) : null,
    chargesCents: rows.reduce((acc, r) => acc + r.fineCents + r.interestCents, 0),
    discountCents: rows.reduce((acc, r) => acc + r.discountCents, 0),
    open: rows.filter((r) => r.kind === 'title' && r.openCents > 0).length,
    overdue: rows.filter((r) => r.overdue).length,
    notCharged: rows.filter((r) => r.notCharged).length,
  };
}
