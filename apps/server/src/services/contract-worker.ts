import type { Database, Executor } from '@moneyflow/db';
import {
  addDays,
  type ContractMessageInfo,
  contractEndingMessage,
  contractLink,
  contractNoticeMessage,
  contractReadjustmentMessage,
  dedupKeys,
  diffDays,
  formatDate,
  formatMonth,
  type MessagePayload,
  noticeDeadline,
  readjustmentDateIn,
  type SpClock,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { Access } from '../authz/access';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { syncLifecycle } from './contracts';
import { createNotifications, type NewNotification } from './notifications';
import { uuidArray } from './reports';

/*
 * Contratos no worker (specs 020 e 034):
 *  - manutenção: o contrato vigente que passou do fim é renovado pelo mesmo
 *    prazo, com as obrigações estendidas (renovação automática, com aviso no
 *    sino), ou encerrado (as séries já terminam no fim da vigência). Nada é
 *    lançado além das ocorrências das séries;
 *  - eventos de mensagem (aviso prévio, fim, reajuste), com dedup por contrato
 *    e fim da vigência, e as notificações do sino, inclusive a cobrança no
 *    cartão não feita (contract_charge_missing, uma vez por ocorrência).
 * Roda como ator `system` (sem app.user_id), como as séries.
 */

/** Dias antes (sino): aviso prévio e fim da vigência. */
const BELL_NOTICE_DAYS = [15, 7, 1, 0];
const BELL_ENDING_DAYS = [30, 7, 0];
/** Até quantos dias atrás o sino avisa a cobrança no cartão não feita. */
const CHARGE_MISSING_LOOKBACK_DAYS = 120;

/** O contexto do worker: acesso de sistema (as séries de qualquer caixa), sem ator humano na transação. */
function systemContext(db: Database): ServiceContext {
  const access = new Access(
    { id: '00000000-0000-0000-0000-000000000000', username: 'system', email: '', role: 'admin', isActive: true },
    new Map(),
  );
  return { db, access, config: {} as Config };
}

type Recipients = (caixaIds: string[]) => Promise<Map<string, string[]>>;

/** Uma passada: cada contrato numa transação curta própria. */
export async function contractMaintenance(db: Database, today: string, recipients?: Recipients) {
  const candidates = await db.execute<{ id: string; caixa_id: string; name: string }>(sql`
    SELECT c.id, c.caixa_id, c.name FROM contracts c
     WHERE c.status = 'active' AND c.archived_at IS NULL AND c.ends_on IS NOT NULL AND c.ends_on < ${today}::date`);
  const ctx = systemContext(db);
  let renewed = 0;
  let ended = 0;
  let failed = 0;
  const notices: NewNotification[] = [];
  for (const contract of candidates.rows) {
    try {
      const result = await db.transaction((tx) => syncLifecycle(ctx, tx, contract.id, today));
      if (result?.action === 'ended') ended += 1;
      if (result?.action === 'renewed') {
        renewed += 1;
        const N = t.contracts.notifications;
        const users = (await recipients?.([contract.caixa_id]))?.get(contract.caixa_id) ?? [];
        for (const userId of users)
          notices.push({
            userId,
            kind: 'contract_ending',
            title: N.renewed(contract.name).slice(0, 200),
            body: N.renewedBody(formatDate(result.startsOn), formatDate(result.endsOn)),
            link: contractLink(contract.id),
            caixaId: contract.caixa_id,
            data: { contractId: contract.id },
            dedupKey: dedupKeys.contractRenewed(contract.id, result.seq),
          });
      }
    } catch {
      failed += 1;
    }
  }
  if (notices.length > 0) await createNotifications(db, notices);
  return { renewed, ended, failed };
}

type LiveContract = ContractMessageInfo & {
  id: string;
  caixaId: string;
  noticeDays: number;
  readjustmentIndex: string;
  readjustmentBaseDate: string | null;
  startsOn: string;
  endsOn: string | null;
};

/** Contratos vigentes (das caixas pedidas), com a vigência. */
async function liveContracts(db: Executor, caixaIds?: string[]): Promise<LiveContract[]> {
  if (caixaIds && caixaIds.length === 0) return [];
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT c.id, c.caixa_id, k.name AS caixa_name, coalesce(e.trade_name, e.name) AS entity_name, c.name, c.direction,
           c.notice_days, c.readjustment_index, c.readjustment_base_date, c.starts_on, c.ends_on
      FROM contracts c
      JOIN caixas k ON k.id = c.caixa_id
      JOIN entities e ON e.id = c.entity_id
     WHERE c.status = 'active' AND c.archived_at IS NULL
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
    readjustmentIndex: String(r.readjustment_index),
    readjustmentBaseDate: (r.readjustment_base_date as string | null) ?? null,
    startsOn: String(r.starts_on),
    endsOn: (r.ends_on as string | null) ?? null,
  }));
}

type EventKind = 'contract_notice_deadline' | 'contract_ending' | 'contract_readjustment';

type ContractEvent = {
  kind: EventKind;
  contract: LiveContract;
  dedupKey: string;
  /** Dias até o marco (aviso prévio/fim). */
  daysBefore: number;
  date: string;
};

/** Eventos do dia para um conjunto de contratos (mesmas regras para mensagens e sino). */
function eventsOfDay(
  contracts: LiveContract[],
  today: string,
  opts: { noticeDays: number[]; endingDays: number[] },
  kinds: EventKind[],
): ContractEvent[] {
  const out: ContractEvent[] = [];
  for (const c of contracts) {
    const termKey = `${c.id}:${c.endsOn}`;
    if (kinds.includes('contract_notice_deadline') && c.endsOn && c.noticeDays > 0) {
      const deadline = noticeDeadline(c.endsOn, c.noticeDays);
      const days = diffDays(today, deadline);
      if (opts.noticeDays.includes(days))
        out.push({
          kind: 'contract_notice_deadline',
          contract: c,
          dedupKey: dedupKeys.contractNotice(termKey, days),
          daysBefore: days,
          date: deadline,
        });
    }
    if (kinds.includes('contract_ending') && c.endsOn) {
      const days = diffDays(today, c.endsOn);
      if (opts.endingDays.includes(days))
        out.push({
          kind: 'contract_ending',
          contract: c,
          dedupKey: dedupKeys.contractEnding(termKey, days),
          daysBefore: days,
          date: c.endsOn,
        });
    }
    if (kinds.includes('contract_readjustment') && c.readjustmentIndex !== 'none') {
      const date = readjustmentDateIn(Number(today.slice(0, 4)), c.startsOn, c.readjustmentBaseDate);
      if (date === today)
        out.push({ kind: 'contract_readjustment', contract: c, dedupKey: dedupKeys.contractReadjustment(c.id, date), daysBefore: 0, date });
    }
  }
  return out;
}

const indexLabel = (index: string) => t.contracts.indexes[index] ?? index;

function messageOf(event: ContractEvent, url: string | null): MessagePayload {
  const info = { ...event.contract, url };
  switch (event.kind) {
    case 'contract_notice_deadline':
      return contractNoticeMessage(info, event.daysBefore, event.date, event.contract.endsOn ?? event.date);
    case 'contract_ending':
      return contractEndingMessage(info, event.daysBefore, event.date);
    case 'contract_readjustment':
      return contractReadjustmentMessage(info, indexLabel(event.contract.readjustmentIndex), event.date);
  }
}

/**
 * Mensagens de uma assinatura de evento de contrato (o produtor do laço de
 * mensagens chama aqui). A renovação pendente não existe desde a F20: as
 * assinaturas antigas desse evento ficam sem mensagens.
 */
export async function contractMessages(
  db: Database,
  kind: EventKind | 'contract_renewal_pending',
  params: Record<string, unknown>,
  caixaIds: string[],
  clock: SpClock,
  linkTo: (path: string) => string | null,
): Promise<{ dedupKey: string; caixaId: string | null; payload: MessagePayload }[]> {
  if (kind === 'contract_renewal_pending') return [];
  const contracts = await liveContracts(db, caixaIds);
  const days = (params.days_before as number[] | undefined) ?? [];
  const events = eventsOfDay(contracts, clock.date, { noticeDays: days, endingDays: days }, [kind]);
  return events.map((event) => ({
    dedupKey: event.dedupKey,
    caixaId: event.contract.caixaId,
    payload: messageOf(event, linkTo(contractLink(event.contract.id))),
  }));
}

/** Cobranças no cartão não feitas (a fatura esperada fechou sem a compra) dos contratos vigentes ou encerrados. */
async function missingCharges(db: Executor, today: string) {
  const result = await db.execute<{
    contract_id: string;
    contract_name: string;
    caixa_id: string;
    rule_id: string;
    occurrence: number;
    description: string;
    due_date: string;
    reference_month: string | null;
  }>(sql`
    SELECT c.id AS contract_id, c.name AS contract_name, c.caixa_id, p.recurrence_rule_id AS rule_id, p.occurrence, p.description,
           p.due_date, to_char(v.reference_month, 'YYYY-MM-DD') AS reference_month
      FROM contracts c
      CROSS JOIN LATERAL contract_payments(c.id, ${addDays(today, -CHARGE_MISSING_LOOKBACK_DAYS)}::date, ${today}::date, ${today}::date) p
      LEFT JOIN card_invoices v ON v.id = p.card_invoice_id
     WHERE c.archived_at IS NULL AND c.status IN ('active', 'ended', 'terminated') AND p.kind = 'card_charge' AND p.not_charged
       AND p.recurrence_rule_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM recurrence_rules r JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id WHERE r.contract_id = c.id)`);
  return result.rows;
}

/** Notificações do sino dos contratos, para os destinatários de cada caixa. */
export async function contractNotifications(db: Database, clock: SpClock, recipients: Recipients): Promise<NewNotification[]> {
  const contracts = await liveContracts(db);
  const events = eventsOfDay(contracts, clock.date, { noticeDays: BELL_NOTICE_DAYS, endingDays: BELL_ENDING_DAYS }, [
    'contract_notice_deadline',
    'contract_ending',
    'contract_readjustment',
  ]);
  const missing = await missingCharges(db, clock.date);
  if (events.length === 0 && missing.length === 0) return [];
  const byCaixa = await recipients([...new Set([...events.map((e) => e.contract.caixaId), ...missing.map((m) => m.caixa_id)])]);
  const N = t.contracts.notifications;
  const out: NewNotification[] = [];
  for (const event of events) {
    const c = event.contract;
    const base = {
      kind: event.kind,
      link: contractLink(c.id),
      caixaId: c.caixaId,
      dedupKey: event.dedupKey,
      data: { contractId: c.id },
    };
    const text =
      event.kind === 'contract_notice_deadline'
        ? { title: N.noticeDeadline(c.name, event.daysBefore), body: N.noticeDeadlineBody(formatDate(event.date), formatDate(c.endsOn!)) }
        : event.kind === 'contract_ending'
          ? { title: N.ending(c.name, event.daysBefore), body: N.endingBody(formatDate(c.endsOn!), c.entityName) }
          : { title: N.readjustment(c.name), body: N.readjustmentBody(indexLabel(c.readjustmentIndex), formatDate(event.date)) };
    for (const userId of byCaixa.get(c.caixaId) ?? []) out.push({ ...base, ...text, title: text.title.slice(0, 200), userId });
  }
  for (const m of missing) {
    const occurrence = Number(m.occurrence);
    for (const userId of byCaixa.get(m.caixa_id) ?? [])
      out.push({
        userId,
        kind: 'contract_charge_missing',
        title: N.chargeMissing(m.description, formatMonth(m.due_date)).slice(0, 200),
        body: N.chargeMissingBody(m.contract_name, m.reference_month ? formatMonth(m.reference_month) : formatMonth(m.due_date)),
        link: contractLink(m.contract_id, 'payments'),
        caixaId: m.caixa_id,
        data: { contractId: m.contract_id, ruleId: m.rule_id, occurrence },
        dedupKey: dedupKeys.contractChargeMissing(m.rule_id, occurrence),
      });
  }
  return out;
}
