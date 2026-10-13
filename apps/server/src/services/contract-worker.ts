import type { Database, Executor } from '@moneyflow/db';
import {
  type ContractMessageInfo,
  contractEndingMessage,
  contractLink,
  contractNoticeMessage,
  contractReadjustmentMessage,
  contractRenewalMessage,
  dedupKeys,
  diffDays,
  formatDate,
  type MessagePayload,
  noticeDeadline,
  readjustmentDateIn,
  renewalReminderDue,
  type SpClock,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { syncLifecycle } from './contracts';
import type { NewNotification } from './notifications';
import { uuidArray } from './reports';

/*
 * Contratos no worker (spec 020):
 *  - manutenção: abre a tarefa de renovação na antecedência (renovação
 *    automática) e encerra quem passou do fim sem renovação. Nada é lançado:
 *    sem aprovação, nenhuma parcela nova existe;
 *  - eventos de mensagem (aviso prévio, fim, renovação pendente, reajuste),
 *    com dedup por contrato e ciclo, e as notificações do sino.
 * Roda como ator `system` (sem app.user_id), como as séries.
 */

/** Dias antes (sino): aviso prévio e fim da vigência. */
const BELL_NOTICE_DAYS = [15, 7, 1, 0];
const BELL_ENDING_DAYS = [30, 7, 0];

/** Uma passada: cada contrato numa transação curta própria. */
export async function contractMaintenance(db: Database, today: string) {
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM contracts c
      JOIN LATERAL (SELECT y.id, y.ends_on FROM contract_cycles y WHERE y.contract_id = c.id ORDER BY y.seq DESC LIMIT 1) y ON true
     WHERE c.status = 'active' AND c.archived_at IS NULL
       AND (y.ends_on < ${today}::date
            OR (c.auto_renew AND y.ends_on - c.renewal_lead_days <= ${today}::date
                AND NOT EXISTS (SELECT 1 FROM contract_renewal_tasks k WHERE k.contract_cycle_id = y.id)))`);
  let opened = 0;
  let ended = 0;
  let failed = 0;
  for (const { id } of candidates.rows) {
    try {
      const result = await db.transaction((tx) => syncLifecycle(tx, id, today));
      if (result === 'opened') opened += 1;
      if (result === 'ended') ended += 1;
    } catch {
      failed += 1;
    }
  }
  return { opened, ended, failed };
}

type LiveContract = ContractMessageInfo & {
  id: string;
  caixaId: string;
  noticeDays: number;
  reminderEveryDays: number;
  readjustmentIndex: string;
  readjustmentBaseDate: string | null;
  cycleId: string;
  endsOn: string;
  firstStart: string;
  decided: boolean;
  taskId: string | null;
  taskOpenedOn: string | null;
  taskDueOn: string | null;
};

/** Contratos vigentes ou com renovação pendente (das caixas pedidas), com o último ciclo e a tarefa aberta. */
async function liveContracts(db: Executor, caixaIds?: string[]): Promise<LiveContract[]> {
  if (caixaIds && caixaIds.length === 0) return [];
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT c.id, c.caixa_id, k.name AS caixa_name, coalesce(e.trade_name, e.name) AS entity_name, c.name, c.direction,
           c.notice_days, c.reminder_every_days, c.readjustment_index, c.readjustment_base_date,
           y.id AS cycle_id, y.ends_on, f.starts_on AS first_start,
           EXISTS (SELECT 1 FROM contract_renewal_tasks d WHERE d.contract_cycle_id = y.id AND d.status <> 'open') AS decided,
           task.id AS task_id, task.opened_on AS task_opened_on, task.due_on AS task_due_on
      FROM contracts c
      JOIN caixas k ON k.id = c.caixa_id
      JOIN entities e ON e.id = c.entity_id
      JOIN LATERAL (SELECT y.id, y.ends_on FROM contract_cycles y WHERE y.contract_id = c.id ORDER BY y.seq DESC LIMIT 1) y ON true
      JOIN LATERAL (SELECT y.starts_on FROM contract_cycles y WHERE y.contract_id = c.id ORDER BY y.seq LIMIT 1) f ON true
      LEFT JOIN contract_renewal_tasks task ON task.contract_id = c.id AND task.status = 'open'
     WHERE c.status IN ('active', 'renewal_pending') AND c.archived_at IS NULL
       ${caixaIds ? sql`AND c.caixa_id = ANY (${uuidArray(caixaIds)})` : sql``}
     ORDER BY c.name, c.id`);
  return result.rows.map((r) => ({
    id: String(r.id),
    caixaId: String(r.caixa_id),
    caixaName: String(r.caixa_name),
    entityName: String(r.entity_name),
    name: String(r.name),
    direction: r.direction as 'payable' | 'receivable',
    noticeDays: Number(r.notice_days),
    reminderEveryDays: Number(r.reminder_every_days),
    readjustmentIndex: String(r.readjustment_index),
    readjustmentBaseDate: (r.readjustment_base_date as string | null) ?? null,
    cycleId: String(r.cycle_id),
    endsOn: String(r.ends_on),
    firstStart: String(r.first_start),
    decided: Boolean(r.decided),
    taskId: (r.task_id as string | null) ?? null,
    taskOpenedOn: (r.task_opened_on as string | null) ?? null,
    taskDueOn: (r.task_due_on as string | null) ?? null,
  }));
}

type ContractEvent = {
  kind: 'contract_notice_deadline' | 'contract_ending' | 'contract_renewal_pending' | 'contract_readjustment';
  contract: LiveContract;
  dedupKey: string;
  /** Dias até o marco (aviso prévio/fim) ou se a renovação está vencida. */
  daysBefore: number;
  date: string;
  overdue: boolean;
};

/** Eventos do dia para um conjunto de contratos (mesmas regras para mensagens e sino). */
function eventsOfDay(
  contracts: LiveContract[],
  today: string,
  opts: { noticeDays: number[]; endingDays: number[]; repeatEvery: (c: LiveContract) => number | null },
  kinds: ContractEvent['kind'][],
): ContractEvent[] {
  const out: ContractEvent[] = [];
  for (const c of contracts) {
    if (kinds.includes('contract_notice_deadline') && !c.decided && c.noticeDays > 0) {
      const deadline = noticeDeadline(c.endsOn, c.noticeDays);
      const days = diffDays(today, deadline);
      if (opts.noticeDays.includes(days))
        out.push({
          kind: 'contract_notice_deadline',
          contract: c,
          dedupKey: dedupKeys.contractNotice(c.cycleId, days),
          daysBefore: days,
          date: deadline,
          overdue: false,
        });
    }
    if (kinds.includes('contract_ending')) {
      const days = diffDays(today, c.endsOn);
      if (opts.endingDays.includes(days))
        out.push({
          kind: 'contract_ending',
          contract: c,
          dedupKey: dedupKeys.contractEnding(c.cycleId, days),
          daysBefore: days,
          date: c.endsOn,
          overdue: false,
        });
    }
    if (kinds.includes('contract_renewal_pending') && c.taskId && c.taskOpenedOn && c.taskDueOn) {
      if (renewalReminderDue(c.taskOpenedOn, today, opts.repeatEvery(c)))
        out.push({
          kind: 'contract_renewal_pending',
          contract: c,
          dedupKey: dedupKeys.contractRenewal(c.taskId, today),
          daysBefore: 0,
          date: c.taskDueOn,
          overdue: c.taskDueOn < today,
        });
    }
    if (kinds.includes('contract_readjustment') && c.readjustmentIndex !== 'none') {
      const date = readjustmentDateIn(Number(today.slice(0, 4)), c.firstStart, c.readjustmentBaseDate);
      if (date === today)
        out.push({
          kind: 'contract_readjustment',
          contract: c,
          dedupKey: dedupKeys.contractReadjustment(c.id, date),
          daysBefore: 0,
          date,
          overdue: false,
        });
    }
  }
  return out;
}

const indexLabel = (index: string) => t.contracts.indexes[index] ?? index;

function messageOf(event: ContractEvent, url: string | null): MessagePayload {
  const info = { ...event.contract, url };
  switch (event.kind) {
    case 'contract_notice_deadline':
      return contractNoticeMessage(info, event.daysBefore, event.date, event.contract.endsOn);
    case 'contract_ending':
      return contractEndingMessage(info, event.daysBefore, event.date);
    case 'contract_renewal_pending':
      return contractRenewalMessage(info, event.date, event.overdue);
    case 'contract_readjustment':
      return contractReadjustmentMessage(info, indexLabel(event.contract.readjustmentIndex), event.date);
  }
}

/** Mensagens de uma assinatura de evento de contrato (o produtor do laço de mensagens chama aqui). */
export async function contractMessages(
  db: Database,
  kind: ContractEvent['kind'],
  params: Record<string, unknown>,
  caixaIds: string[],
  clock: SpClock,
  linkTo: (path: string) => string | null,
): Promise<{ dedupKey: string; caixaId: string | null; payload: MessagePayload }[]> {
  const contracts = await liveContracts(db, caixaIds);
  const days = (params.days_before as number[] | undefined) ?? [];
  const events = eventsOfDay(
    contracts,
    clock.date,
    { noticeDays: days, endingDays: days, repeatEvery: () => (params.repeat_every_days as number | undefined) ?? null },
    [kind],
  );
  return events.map((event) => ({
    dedupKey: event.dedupKey,
    caixaId: event.contract.caixaId,
    payload: messageOf(event, linkTo(contractLink(event.contract.id, event.kind === 'contract_renewal_pending' ? 'renewal' : undefined))),
  }));
}

/** Notificações do sino dos contratos, para os destinatários de cada caixa. */
export async function contractNotifications(
  db: Database,
  clock: SpClock,
  recipients: (caixaIds: string[]) => Promise<Map<string, string[]>>,
): Promise<NewNotification[]> {
  const contracts = await liveContracts(db);
  const events = eventsOfDay(
    contracts,
    clock.date,
    { noticeDays: BELL_NOTICE_DAYS, endingDays: BELL_ENDING_DAYS, repeatEvery: (c) => c.reminderEveryDays },
    ['contract_notice_deadline', 'contract_ending', 'contract_renewal_pending', 'contract_readjustment'],
  );
  if (events.length === 0) return [];
  const byCaixa = await recipients([...new Set(events.map((e) => e.contract.caixaId))]);
  const N = t.contracts.notifications;
  const out: NewNotification[] = [];
  for (const event of events) {
    const c = event.contract;
    const base = {
      kind: event.kind,
      link: contractLink(c.id, event.kind === 'contract_renewal_pending' ? 'renewal' : undefined),
      caixaId: c.caixaId,
      dedupKey: event.dedupKey,
      data: { contractId: c.id },
    };
    const text =
      event.kind === 'contract_notice_deadline'
        ? { title: N.noticeDeadline(c.name, event.daysBefore), body: N.noticeDeadlineBody(formatDate(event.date), formatDate(c.endsOn)) }
        : event.kind === 'contract_ending'
          ? { title: N.ending(c.name, event.daysBefore), body: N.endingBody(formatDate(c.endsOn), c.entityName) }
          : event.kind === 'contract_renewal_pending'
            ? { title: N.renewalPending(c.name), body: N.renewalPendingBody(formatDate(event.date), event.overdue) }
            : { title: N.readjustment(c.name), body: N.readjustmentBody(indexLabel(c.readjustmentIndex), formatDate(event.date)) };
    for (const userId of byCaixa.get(c.caixaId) ?? []) out.push({ ...base, ...text, title: text.title.slice(0, 200), userId });
  }
  return out;
}
