import { type Database, type Executor, userColumns, users } from '@moneyflow/db';
import {
  addDays,
  agentMessage,
  cardLimitMessage,
  contractInstallmentLabel,
  dedupKeys,
  divergenceMessage,
  dueReminderMessage,
  formatBRL,
  formatDate,
  invoiceClosedMessage,
  invoiceLink,
  limitPercent,
  type MessagePayload,
  messageParamsSchemas,
  overdueMessage,
  overdueSchedule,
  type ReminderTitle,
  reconciliationLink,
  reminderDueDates,
  type SpClock,
  type SummaryData,
  spClock,
  summaryMessage,
  t,
  titleLink,
  weekStart,
} from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import { type Actor, loadAccess } from '../authz/access';
import type { Config } from '../config';
import { contractMessages, contractNotifications } from './contract-worker';
import { type ClaimedMessage, deliver } from './messages';
import { createNotifications, type NewNotification } from './notifications';
import { uuidArray } from './reports';

/*
 * Laço de mensagens do worker (spec 013):
 *  1. produtor: para cada assinatura ativa de destino ativo, gera os eventos
 *     do momento (vencimentos D-N e atrasados no horário, resumos, fatura
 *     fechada, limite do cartão, divergência de conciliação) e enfileira em
 *     message_outbox com dedup_key (ON CONFLICT DO NOTHING): rodar de novo
 *     nunca duplica;
 *  2. notificações do sino nos mesmos eventos (por caixa, para os membros e
 *     os admins), também com dedup;
 *  3. consumidor: reserva com message_outbox_claim (SKIP LOCKED), envia pela
 *     Bot API fora de transação e fecha com mark_sent/mark_failed.
 * Horários em America/Sao_Paulo. Vários workers podem rodar juntos.
 */

/** Teto de mensagens por título que uma assinatura enfileira por passada (o resto vai na seguinte). */
const MAX_TITLE_MESSAGES = 30;
/** Janela dos eventos pontuais (fatura fechada, divergência): não reenvia o passado distante ao assinar. */
const EVENT_WINDOW_DAYS = 3;
/** Divergência só conta depois de 1 dia do import (tempo de conciliar) e até 8 dias. */
const DIVERGENCE_GRACE = '1 day';
const DIVERGENCE_WINDOW = '8 days';
/** Percentuais fixos do aviso de limite no sino. */
const NOTIFY_LIMIT_THRESHOLDS = [80, 100];

type Outgoing = { dedupKey: string; caixaId: string | null; payload: MessagePayload };

type SubscriptionRow = {
  id: string;
  destination_id: string;
  event_kind: string;
  params: Record<string, unknown>;
  created_at: Date | string;
  owner_user_id: string | null;
  owner_caixa_id: string | null;
  caixa_filter: string[] | null;
};

const linkTo = (config: Config, path: string | null) => (config.publicUrl && path ? `${config.publicUrl}${path}` : null);

/* ---------------- escopo de caixas ---------------- */

/** Caixas que o dono do destino vê (pessoal: as do usuário; de caixa: ela e os cartões dela; global: todas). */
async function destinationScope(db: Database, row: Pick<SubscriptionRow, 'owner_user_id' | 'owner_caixa_id'>): Promise<string[]> {
  if (row.owner_caixa_id) {
    const result = await db.execute<{ id: string }>(sql`
      SELECT id FROM caixas WHERE archived_at IS NULL
         AND (id = ${row.owner_caixa_id} OR (kind = 'credit_card' AND default_payer_caixa_id = ${row.owner_caixa_id}))`);
    return result.rows.map((r) => r.id);
  }
  if (row.owner_user_id) {
    const [user] = await db.select(userColumns).from(users).where(eq(users.id, row.owner_user_id));
    if (!user?.isActive) return [];
    const access = await loadAccess(db, user as Actor);
    const readable = access.readableCaixaIds();
    if (readable !== 'all') {
      if (readable.length === 0) return [];
      const result = await db.execute<{ id: string }>(
        sql`SELECT id FROM caixas WHERE archived_at IS NULL AND id = ANY (${uuidArray(readable)})`,
      );
      return result.rows.map((r) => r.id);
    }
  }
  const result = await db.execute<{ id: string }>(sql`SELECT id FROM caixas WHERE archived_at IS NULL`);
  return result.rows.map((r) => r.id);
}

/** Aplica o filtro de caixas da assinatura (sem filtro = tudo do escopo; cartões das pagadoras filtradas entram). */
async function applyFilter(db: Database, scope: string[], filter: string[] | null): Promise<string[]> {
  if (!filter || filter.length === 0 || scope.length === 0) return scope;
  const result = await db.execute<{ id: string }>(sql`
    SELECT id FROM caixas
     WHERE id = ANY (${uuidArray(scope)})
       AND (id = ANY (${uuidArray(filter)}) OR (kind = 'credit_card' AND default_payer_caixa_id = ANY (${uuidArray(filter)})))`);
  return result.rows.map((r) => r.id);
}

/* ---------------- consultas comuns ---------------- */

type TitleRow = ReminderTitle & { id: string; caixa_id: string };

/** Títulos em aberto das caixas (sem o lado a receber de um par cujas duas caixas estão no escopo). */
async function openTitles(db: Executor, caixaIds: string[], where: ReturnType<typeof sql>, limit = 500): Promise<TitleRow[]> {
  if (caixaIds.length === 0) return [];
  const arr = uuidArray(caixaIds);
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT t.id, t.caixa_id, t.description, t.direction, t.due_date, b.open_cents, c.name AS caixa_name,
           coalesce(e.trade_name, e.name) AS entity_name, t.boleto_barcode, t.pix_payload,
           ct.name AS contract_name, t.contract_installment, cy.installments_count AS contract_installments_count
      FROM titles t
      JOIN title_balances b ON b.title_id = t.id
      JOIN caixas c ON c.id = t.caixa_id
      JOIN entities e ON e.id = t.entity_id
      LEFT JOIN contracts ct ON ct.id = t.contract_id
      LEFT JOIN contract_cycles cy ON cy.id = t.contract_cycle_id
     WHERE t.caixa_id = ANY (${arr}) AND t.archived_at IS NULL AND t.status IN ('open', 'partial') AND b.open_cents > 0
       AND NOT (t.direction = 'receivable' AND coalesce(t.counterparty_caixa_id = ANY (${arr}), false))
       AND ${where}
     ORDER BY t.due_date, c.name, t.description, t.id
     LIMIT ${limit}`);
  return result.rows.map((r) => ({
    id: String(r.id),
    caixa_id: String(r.caixa_id),
    description: String(r.description),
    direction: r.direction as 'payable' | 'receivable',
    dueDate: String(r.due_date),
    openCents: Number(r.open_cents),
    caixaName: String(r.caixa_name),
    entityName: (r.entity_name as string | null) ?? null,
    boletoBarcode: (r.boleto_barcode as string | null) ?? null,
    pixPayload: (r.pix_payload as string | null) ?? null,
    contractLabel: r.contract_name
      ? contractInstallmentLabel(
          String(r.contract_name),
          r.contract_installment === null ? null : Number(r.contract_installment),
          r.contract_installments_count === null ? null : Number(r.contract_installments_count),
        )
      : null,
  }));
}

async function balancesByCaixa(db: Executor, caixaIds: string[]) {
  const result = await db.execute<{ caixa_name: string; cents: number }>(sql`
    SELECT c.name AS caixa_name, coalesce(sum(b.balance_cents), 0)::bigint AS cents
      FROM caixas c LEFT JOIN financial_account_balances b ON b.caixa_id = c.id AND b.archived_at IS NULL
     WHERE c.id = ANY (${uuidArray(caixaIds)}) AND c.kind = 'general'
     GROUP BY c.id, c.name ORDER BY c.name`);
  return result.rows.map((r) => ({ caixaName: r.caixa_name, cents: Number(r.cents) }));
}

/** Entradas e saídas por caixa no período (transferências dentro da mesma caixa não contam). */
async function flowByCaixa(db: Executor, caixaIds: string[], from: string, to: string) {
  const result = await db.execute<{ caixa_name: string; inflow: number; outflow: number }>(sql`
    SELECT c.name AS caixa_name,
           coalesce(sum(m.amount_cents) FILTER (WHERE m.amount_cents > 0), 0)::bigint AS inflow,
           coalesce(-sum(m.amount_cents) FILTER (WHERE m.amount_cents < 0), 0)::bigint AS outflow
      FROM caixas c
      JOIN financial_accounts a ON a.caixa_id = c.id
      JOIN movements m ON m.financial_account_id = a.id
     WHERE c.id = ANY (${uuidArray(caixaIds)}) AND m.occurred_on BETWEEN ${from}::date AND ${to}::date
       AND NOT (m.kind = 'transfer' AND EXISTS (
             SELECT 1 FROM transfers tr
               JOIN financial_accounts fa ON fa.id = tr.from_account_id
               JOIN financial_accounts ta ON ta.id = tr.to_account_id
              WHERE tr.id = m.transfer_id AND fa.caixa_id = ta.caixa_id))
     GROUP BY c.id, c.name ORDER BY c.name`);
  return result.rows.map((r) => ({ caixaName: r.caixa_name, inflowCents: Number(r.inflow), outflowCents: Number(r.outflow) }));
}

async function overdueTotals(db: Executor, caixaIds: string[], today: string) {
  const rows = await openTitles(db, caixaIds, sql`t.due_date < ${today}::date AND t.direction = 'payable'`, 5000);
  return { count: rows.length, cents: rows.reduce((acc, r) => acc + r.openCents, 0) };
}

async function closedInvoices(db: Executor, since: Date | string) {
  const result = await db.execute<{
    id: string;
    card_caixa_id: string;
    card_name: string;
    reference_month: string;
    due_date: string;
    payer_caixa_id: string;
    payer_name: string;
    billed_cents: number;
  }>(sql`
    SELECT v.id, v.card_caixa_id, k.name AS card_name, v.reference_month, v.due_date,
           x.payer_caixa_id, p.name AS payer_name, x.billed_cents
      FROM card_invoices v
      JOIN caixas k ON k.id = v.card_caixa_id
      JOIN card_invoice_payer_totals x ON x.card_invoice_id = v.id
      JOIN caixas p ON p.id = x.payer_caixa_id
     WHERE v.closed_at IS NOT NULL AND v.closed_at >= greatest(${since}::timestamptz, now() - make_interval(days => ${EVENT_WINDOW_DAYS}))
       AND x.billed_cents > 0
     ORDER BY v.closed_at, p.name`);
  const byInvoice = new Map<
    string,
    {
      id: string;
      cardCaixaId: string;
      cardName: string;
      referenceMonth: string;
      dueDate: string;
      payers: { caixaId: string; caixaName: string; cents: number }[];
    }
  >();
  for (const r of result.rows) {
    let inv = byInvoice.get(r.id);
    if (!inv) {
      inv = {
        id: r.id,
        cardCaixaId: r.card_caixa_id,
        cardName: r.card_name,
        referenceMonth: r.reference_month,
        dueDate: r.due_date,
        payers: [],
      };
      byInvoice.set(r.id, inv);
    }
    inv.payers.push({ caixaId: r.payer_caixa_id, caixaName: r.payer_name, cents: Number(r.billed_cents) });
  }
  return [...byInvoice.values()];
}

async function cardUsage(db: Executor, caixaIds?: string[]) {
  const result = await db.execute<{
    id: string;
    name: string;
    default_payer_caixa_id: string;
    used_cents: number;
    credit_limit_cents: number;
  }>(sql`
    SELECT c.id, c.name, c.default_payer_caixa_id, l.used_cents, c.credit_limit_cents
      FROM caixas c JOIN card_limits l ON l.card_caixa_id = c.id
     WHERE c.kind = 'credit_card' AND c.archived_at IS NULL ${caixaIds ? sql`AND c.id = ANY (${uuidArray(caixaIds)})` : sql``}`);
  return result.rows.map((r) => ({ ...r, used_cents: Number(r.used_cents), credit_limit_cents: Number(r.credit_limit_cents) }));
}

async function divergences(db: Executor, minDifference: number, since: Date | string, caixaIds?: string[]) {
  const result = await db.execute<{
    id: string;
    caixa_id: string;
    caixa_name: string;
    account_id: string;
    account_name: string;
    bank_balance_on: string;
    bank_balance_cents: number;
    app_balance_cents: number;
  }>(sql`
    SELECT i.id, a.caixa_id, c.name AS caixa_name, a.id AS account_id, a.name AS account_name, b.bank_balance_on,
           b.bank_balance_cents, b.app_balance_cents
      FROM statement_import_balances b
      JOIN statement_imports i ON i.id = b.statement_import_id
      JOIN financial_accounts a ON a.id = b.financial_account_id
      JOIN caixas c ON c.id = a.caixa_id
     WHERE b.difference_cents IS NOT NULL AND abs(b.difference_cents) > ${minDifference}
       AND i.created_at <= now() - ${DIVERGENCE_GRACE}::interval
       AND i.created_at >= greatest(${since}::timestamptz - ${DIVERGENCE_GRACE}::interval, now() - ${DIVERGENCE_WINDOW}::interval)
       ${caixaIds ? sql`AND a.caixa_id = ANY (${uuidArray(caixaIds)})` : sql``}`);
  return result.rows.map((r) => ({
    ...r,
    bank_balance_cents: Number(r.bank_balance_cents),
    app_balance_cents: Number(r.app_balance_cents),
  }));
}

const monthOf = (date: string) => date.slice(0, 7);
const invoiceMonthLabel = (referenceMonth: string) => `${referenceMonth.slice(5, 7)}/${referenceMonth.slice(0, 4)}`;

/* ---------------- produtor de mensagens ---------------- */

async function eventsFor(db: Database, config: Config, sub: SubscriptionRow, caixaIds: string[], clock: SpClock): Promise<Outgoing[]> {
  const kind = sub.event_kind as keyof typeof messageParamsSchemas;
  const parsed = messageParamsSchemas[kind]?.safeParse(sub.params);
  if (!parsed?.success || caixaIds.length === 0) return [];
  const params = parsed.data as Record<string, unknown>;
  const today = clock.date;
  const sendAt = params.send_at as string | undefined;
  if (sendAt && clock.time < sendAt) return [];

  switch (kind) {
    case 'due_reminder': {
      const targets = reminderDueDates(today, params.days_before as number[]);
      const out: Outgoing[] = [];
      for (const target of targets) {
        const titles = await openTitles(db, caixaIds, sql`t.due_date = ${target.dueDate}::date`, MAX_TITLE_MESSAGES);
        for (const title of titles) {
          out.push({
            dedupKey: dedupKeys.dueReminder(title.id, target.daysBefore, title.dueDate),
            caixaId: title.caixa_id,
            payload: dueReminderMessage(
              title,
              target.daysBefore,
              linkTo(config, titleLink({ id: title.id, caixaId: title.caixa_id, direction: title.direction })),
            ),
          });
        }
      }
      return out;
    }
    case 'overdue': {
      const repeat = (params.repeat_every_days as number | undefined) ?? null;
      const titles = await openTitles(db, caixaIds, sql`t.due_date < ${today}::date`, 1000);
      const out: Outgoing[] = [];
      for (const title of titles) {
        const schedule = overdueSchedule(title.dueDate, today, repeat);
        if (!schedule?.send) continue;
        out.push({
          dedupKey: dedupKeys.overdue(title.id, schedule.dedupKey),
          caixaId: title.caixa_id,
          payload: overdueMessage(
            title,
            schedule.daysLate,
            linkTo(config, titleLink({ id: title.id, caixaId: title.caixa_id, direction: title.direction })),
          ),
        });
      }
      return out;
    }
    case 'daily_summary':
    case 'weekly_summary': {
      const weekly = kind === 'weekly_summary';
      if (weekly && clock.weekday !== params.weekday) return [];
      const until = weekly ? addDays(today, 6) : today;
      const flowFrom = weekly ? addDays(today, -7) : addDays(today, -1);
      const [due, overdue, balances, flow] = await Promise.all([
        openTitles(db, caixaIds, sql`t.due_date BETWEEN ${today}::date AND ${until}::date`, 200),
        overdueTotals(db, caixaIds, today),
        balancesByCaixa(db, caixaIds),
        flowByCaixa(db, caixaIds, flowFrom, addDays(today, -1)),
      ]);
      const T = t.messages.telegram;
      const data: SummaryData = {
        heading: weekly ? T.weeklyTitle(formatDate(today), formatDate(until)) : T.dailyTitle(formatDate(today)),
        dueLabel: weekly ? T.dueWeek : T.dueToday,
        due,
        overdue,
        balances,
        flowLabel: weekly ? T.flowWeek : T.flowYesterday,
        flow,
        showDueDate: weekly,
      };
      return [
        { dedupKey: weekly ? dedupKeys.weekly(weekStart(today)) : dedupKeys.daily(today), caixaId: null, payload: summaryMessage(data) },
      ];
    }
    case 'invoice_closed': {
      const scope = new Set(caixaIds);
      const invoices = (await closedInvoices(db, sub.created_at)).filter(
        (inv) => scope.has(inv.cardCaixaId) || inv.payers.some((p) => scope.has(p.caixaId)),
      );
      return invoices.map((inv) => ({
        dedupKey: dedupKeys.invoiceClosed(inv.id),
        caixaId: inv.cardCaixaId,
        payload: invoiceClosedMessage({
          cardName: inv.cardName,
          referenceMonth: inv.referenceMonth,
          dueDate: inv.dueDate,
          totalCents: inv.payers.reduce((acc, p) => acc + p.cents, 0),
          payers: inv.payers,
          url: linkTo(config, invoiceLink(inv.id)),
        }),
      }));
    }
    case 'card_limit': {
      const cards = await cardUsage(db, caixaIds);
      const out: Outgoing[] = [];
      for (const card of cards) {
        const percent = limitPercent(card.used_cents, card.credit_limit_cents);
        const reached = (params.thresholds_percent as number[]).filter((thr) => percent >= thr);
        if (reached.length === 0) continue;
        const top = Math.max(...reached);
        out.push({
          dedupKey: dedupKeys.cardLimit(card.id, top, monthOf(today)),
          caixaId: card.id,
          payload: cardLimitMessage({
            cardName: card.name,
            usedCents: card.used_cents,
            limitCents: card.credit_limit_cents,
            url: linkTo(config, `/caixas/${card.id}/limit`),
          }),
        });
      }
      return out;
    }
    case 'reconciliation_divergence': {
      const rows = await divergences(db, (params.min_difference_cents as number | undefined) ?? 0, sub.created_at, caixaIds);
      return rows.map((r) => ({
        dedupKey: dedupKeys.divergence(r.id),
        caixaId: r.caixa_id,
        payload: divergenceMessage({
          accountName: r.account_name,
          caixaName: r.caixa_name,
          bankBalanceOn: r.bank_balance_on,
          bankCents: r.bank_balance_cents,
          appCents: r.app_balance_cents,
          url: linkTo(config, reconciliationLink(r.caixa_id, r.account_id, r.id)),
        }),
      }));
    }
    case 'contract_notice_deadline':
    case 'contract_ending':
    case 'contract_renewal_pending':
    case 'contract_readjustment':
      // Contratos (spec 020): aviso prévio, fim, renovação pendente e reajuste, com dedup por contrato e ciclo.
      return contractMessages(db, kind, params, caixaIds, clock, (path) => linkTo(config, path));
    default:
      // agent_completed / agent_message: disparados pelo agente (F4), ver emitAgentEvent.
      return [];
  }
}

async function enqueue(
  db: Executor,
  destinationId: string,
  subscriptionId: string | null,
  eventKind: string,
  items: Outgoing[],
  extra?: { userId?: string | null; agentRunId?: string | null },
) {
  if (items.length === 0) return 0;
  const values = items.map(
    (item) =>
      sql`(${destinationId}::uuid, ${subscriptionId}::uuid, ${eventKind}, ${item.dedupKey}, ${item.caixaId}::uuid, ${extra?.userId ?? null}::uuid, ${extra?.agentRunId ?? null}, ${JSON.stringify(item.payload)}::jsonb)`,
  );
  const result = await db.execute(sql`
    INSERT INTO message_outbox (destination_id, subscription_id, event_kind, dedup_key, caixa_id, user_id, agent_run_id, payload)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (destination_id, dedup_key) DO NOTHING RETURNING id`);
  return result.rows.length;
}

async function activeSubscriptions(db: Database, kinds?: string[]) {
  const result = await db.execute<SubscriptionRow>(sql`
    SELECT s.id, s.destination_id, s.event_kind, s.params, s.created_at, d.owner_user_id, d.owner_caixa_id,
           (SELECT array_agg(x.caixa_id::text) FROM message_subscription_caixas x WHERE x.subscription_id = s.id) AS caixa_filter
      FROM message_subscriptions s
      JOIN message_destinations d ON d.id = s.destination_id
     WHERE s.is_active AND d.is_active AND d.archived_at IS NULL
       ${kinds ? sql`AND s.event_kind = ANY (${`{${kinds.join(',')}}`}::text[])` : sql`AND s.event_kind NOT IN ('agent_completed', 'agent_message')`}
     ORDER BY s.destination_id, s.event_kind`);
  return result.rows;
}

/** Gera e enfileira as mensagens do momento para todas as assinaturas. */
export async function produceMessages(db: Database, config: Config, clock: SpClock = spClock()) {
  const scopes = new Map<string, Promise<string[]>>();
  let queued = 0;
  let failed = 0;
  for (const sub of await activeSubscriptions(db)) {
    try {
      if (!scopes.has(sub.destination_id)) scopes.set(sub.destination_id, destinationScope(db, sub));
      const caixaIds = await applyFilter(db, await scopes.get(sub.destination_id)!, sub.caixa_filter);
      const items = await eventsFor(db, config, sub, caixaIds, clock);
      queued += await enqueue(db, sub.destination_id, sub.id, sub.event_kind, items);
    } catch {
      failed += 1;
    }
  }
  return { queued, failed };
}

/* ---------------- notificações do sino ---------------- */

/** Destinatários por caixa: membros (só editores, se pedido) e os admins ativos. */
async function recipientsByCaixa(db: Executor, caixaIds: string[], editorsOnly = false): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (caixaIds.length === 0) return map;
  const [members, admins] = await Promise.all([
    db.execute<{ caixa_id: string; user_id: string }>(sql`
      SELECT m.caixa_id, m.user_id FROM caixa_members m JOIN users u ON u.id = m.user_id AND u.is_active
       WHERE m.caixa_id = ANY (${uuidArray(caixaIds)}) ${editorsOnly ? sql`AND m.role = 'editor'` : sql``}`),
    db.execute<{ id: string }>(sql`SELECT id FROM users WHERE role = 'admin' AND is_active`),
  ]);
  for (const id of caixaIds)
    map.set(
      id,
      admins.rows.map((a) => a.id),
    );
  for (const m of members.rows) {
    const list = map.get(m.caixa_id)!;
    if (!list.includes(m.user_id)) list.push(m.user_id);
  }
  return map;
}

/** Notificações in-app dos eventos do momento (dedup por usuário). */
export async function produceNotifications(db: Database, config: Config, clock: SpClock = spClock()) {
  const items: NewNotification[] = [];
  const N = t.notifications;
  const add = (userIds: string[] | undefined, base: Omit<NewNotification, 'userId'>) => {
    for (const userId of userIds ?? []) items.push({ ...base, userId });
  };

  // Espelhos aguardando aceite: para quem escreve na caixa do espelho.
  const pending = await db.execute<{
    id: string;
    caixa_id: string;
    direction: 'payable' | 'receivable';
    description: string;
    amount_cents: number;
    caixa_name: string;
    from_name: string;
  }>(sql`
    SELECT t.id, t.caixa_id, t.direction, t.description, t.amount_cents, c.name AS caixa_name, o.name AS from_name
      FROM titles t JOIN caixas c ON c.id = t.caixa_id JOIN caixas o ON o.id = t.counterparty_caixa_id
     WHERE t.mirror_status = 'pending' AND t.archived_at IS NULL AND t.status <> 'canceled'
       AND t.created_at >= now() - interval '60 days'`);
  const pendingRecipients = await recipientsByCaixa(db, [...new Set(pending.rows.map((r) => r.caixa_id))], true);
  for (const r of pending.rows) {
    add(pendingRecipients.get(r.caixa_id), {
      kind: 'mirror_pending',
      title: N.mirrorPending(r.description),
      body: N.mirrorPendingBody(r.caixa_name, formatBRL(Number(r.amount_cents)), r.from_name),
      link: titleLink({ id: r.id, caixaId: r.caixa_id, direction: r.direction }),
      caixaId: r.caixa_id,
      dedupKey: `mirror_pending:${r.id}`,
    });
  }

  // Espelhos contestados: para quem escreve na caixa do original.
  const disputed = await db.execute<{
    original_id: string;
    original_caixa_id: string;
    direction: 'payable' | 'receivable';
    description: string;
    amount_cents: number;
    caixa_name: string;
    updated_at: string;
  }>(sql`
    SELECT o.id AS original_id, o.caixa_id AS original_caixa_id, o.direction, o.description, o.amount_cents, c.name AS caixa_name,
           to_char(t.updated_at, 'YYYYMMDDHH24MISS') AS updated_at
      FROM titles t JOIN titles o ON o.id = t.mirror_title_id JOIN caixas c ON c.id = t.caixa_id
     WHERE t.mirror_status = 'disputed' AND t.archived_at IS NULL AND t.updated_at >= now() - interval '60 days'`);
  const disputedRecipients = await recipientsByCaixa(db, [...new Set(disputed.rows.map((r) => r.original_caixa_id))], true);
  for (const r of disputed.rows) {
    add(disputedRecipients.get(r.original_caixa_id), {
      kind: 'mirror_disputed',
      title: N.mirrorDisputed(r.description),
      body: N.mirrorDisputedBody(r.caixa_name, formatBRL(Number(r.amount_cents))),
      link: titleLink({ id: r.original_id, caixaId: r.original_caixa_id, direction: r.direction }),
      caixaId: r.original_caixa_id,
      dedupKey: `mirror_disputed:${r.original_id}:${r.updated_at}`,
    });
  }

  // Faturas fechadas: cartão e pagadoras.
  const invoices = await closedInvoices(db, new Date(0));
  const invoiceRecipients = await recipientsByCaixa(db, [
    ...new Set(invoices.flatMap((i) => [i.cardCaixaId, ...i.payers.map((p) => p.caixaId)])),
  ]);
  for (const inv of invoices) {
    const total = inv.payers.reduce((acc, p) => acc + p.cents, 0);
    const users = new Set([inv.cardCaixaId, ...inv.payers.map((p) => p.caixaId)].flatMap((id) => invoiceRecipients.get(id) ?? []));
    add([...users], {
      kind: 'invoice_closed',
      title: N.invoiceClosed(inv.cardName, invoiceMonthLabel(inv.referenceMonth)),
      body: N.invoiceClosedBody(formatBRL(total), formatDate(inv.dueDate)),
      link: invoiceLink(inv.id),
      caixaId: inv.cardCaixaId,
      dedupKey: dedupKeys.invoiceClosed(inv.id),
    });
  }

  // Limite do cartão (80% e 100%), uma vez por mês por patamar.
  const cards = await cardUsage(db);
  const cardRecipients = await recipientsByCaixa(db, [...new Set(cards.flatMap((c) => [c.id, c.default_payer_caixa_id]))]);
  for (const card of cards) {
    const percent = limitPercent(card.used_cents, card.credit_limit_cents);
    const reached = NOTIFY_LIMIT_THRESHOLDS.filter((thr) => percent >= thr);
    if (reached.length === 0) continue;
    const top = Math.max(...reached);
    const users = new Set([...(cardRecipients.get(card.id) ?? []), ...(cardRecipients.get(card.default_payer_caixa_id) ?? [])]);
    add([...users], {
      kind: 'card_limit',
      title: N.cardLimit(card.name, top),
      body: N.cardLimitBody(formatBRL(card.used_cents), formatBRL(card.credit_limit_cents)),
      link: `/caixas/${card.id}/limit`,
      caixaId: card.id,
      dedupKey: dedupKeys.cardLimit(card.id, top, monthOf(clock.date)),
    });
  }

  // Divergência de conciliação: para quem escreve na caixa da conta.
  const divs = await divergences(db, 0, new Date(0));
  const divRecipients = await recipientsByCaixa(db, [...new Set(divs.map((d) => d.caixa_id))], true);
  for (const d of divs) {
    add(divRecipients.get(d.caixa_id), {
      kind: 'reconciliation_divergence',
      title: N.divergence(`${d.account_name} (${d.caixa_name})`),
      body: N.divergenceBody(formatBRL(d.bank_balance_cents - d.app_balance_cents), formatDate(d.bank_balance_on)),
      link: reconciliationLink(d.caixa_id, d.account_id, d.id),
      caixaId: d.caixa_id,
      dedupKey: dedupKeys.divergence(d.id),
    });
  }

  // Avisos diários por caixa (no horário NOTIFY_AT): vence hoje e atrasados; e os dos contratos (spec 020).
  if (clock.time >= config.notifyAt) {
    items.push(...(await contractNotifications(db, clock, (ids) => recipientsByCaixa(db, ids))));
    const caixas = await db.execute<{ id: string }>(sql`SELECT id FROM caixas WHERE archived_at IS NULL AND kind = 'general'`);
    const ids = caixas.rows.map((c) => c.id);
    const recipients = await recipientsByCaixa(db, ids);
    const rows = await db.execute<{
      caixa_id: string;
      caixa_name: string;
      due_today: number;
      payable: number;
      receivable: number;
      overdue: number;
      overdue_cents: number;
    }>(sql`
      SELECT c.id AS caixa_id, c.name AS caixa_name,
             count(*) FILTER (WHERE b.due_date = ${clock.date}::date)::int AS due_today,
             coalesce(sum(b.open_cents) FILTER (WHERE b.due_date = ${clock.date}::date AND b.direction = 'payable'), 0)::bigint AS payable,
             coalesce(sum(b.open_cents) FILTER (WHERE b.due_date = ${clock.date}::date AND b.direction = 'receivable'), 0)::bigint AS receivable,
             count(*) FILTER (WHERE b.due_date < ${clock.date}::date)::int AS overdue,
             coalesce(sum(b.open_cents) FILTER (WHERE b.due_date < ${clock.date}::date), 0)::bigint AS overdue_cents
        FROM caixas c JOIN title_balances b ON b.caixa_id = c.id
       WHERE c.archived_at IS NULL AND c.kind = 'general' AND b.archived_at IS NULL AND b.open_cents > 0 AND b.due_date <= ${clock.date}::date
       GROUP BY c.id, c.name`);
    for (const r of rows.rows) {
      if (r.due_today > 0) {
        add(recipients.get(r.caixa_id), {
          kind: 'due_reminder',
          title: N.dueToday(r.due_today, r.caixa_name),
          body: N.dueTodayBody(formatBRL(Number(r.payable)), formatBRL(Number(r.receivable))),
          link: `/calendar?view=agenda&caixas=${r.caixa_id}`,
          caixaId: r.caixa_id,
          dedupKey: `due_reminder:${r.caixa_id}:${clock.date}`,
        });
      }
      if (r.overdue > 0) {
        add(recipients.get(r.caixa_id), {
          kind: 'overdue',
          title: N.overdue(r.overdue, r.caixa_name),
          body: N.overdueBody(formatBRL(Number(r.overdue_cents))),
          link: `/caixas/${r.caixa_id}/payables?status=overdue`,
          caixaId: r.caixa_id,
          dedupKey: `overdue:${r.caixa_id}:${clock.date}`,
        });
      }
    }
  }

  let created = 0;
  for (let i = 0; i < items.length; i += 200) created += await createNotifications(db, items.slice(i, i + 200));
  return { created };
}

/* ---------------- consumidor ---------------- */

/** Reserva e envia lotes da outbox até esvaziar o que está pronto (no máximo `rounds` lotes por passada). */
export async function consumeOutbox(db: Database, config: Config, opts: { batch?: number; rounds?: number } = {}) {
  let sent = 0;
  let failed = 0;
  let retried = 0;
  for (let round = 0; round < (opts.rounds ?? 5); round += 1) {
    // Transação curta (autocommit): a reserva fica gravada antes de qualquer envio.
    const claimed = await db.execute<{ id: string; chat_id: string; name: string; payload: MessagePayload }>(sql`
      SELECT c.id, d.chat_id, d.name, c.payload
        FROM message_outbox_claim(${opts.batch ?? 10}, interval '5 minutes') c
        JOIN message_destinations d ON d.id = c.destination_id`);
    if (claimed.rows.length === 0) break;
    for (const row of claimed.rows) {
      const message: ClaimedMessage = { id: row.id, chatId: row.chat_id, destinationName: row.name, payload: row.payload };
      const outcome = await deliver(db, config, message);
      if (outcome.status === 'sent') sent += 1;
      else if (outcome.status === 'failed') failed += 1;
      else retried += 1;
    }
  }
  return { sent, failed, retried };
}

/* ---------------- ponto de extensão da F4 (agentes) ---------------- */

/**
 * Evento de agente (spec 011/013): notifica o usuário no sino e enfileira a
 * mensagem para os destinos que assinam o evento e que esse usuário vê
 * (pessoais dele e das caixas que ele lê). Chamado pelas execuções de agente
 * na F4; o worker consome a fila como qualquer outra mensagem.
 *
 * `eventKey` identifica o evento de forma determinística (`run:<runId>:seq:<seq>`
 * no aviso de conclusão, `run:<runId>:tool:<toolUseId>` na tool notify_user):
 * o mesmo evento emitido de novo (outra réplica, retomada) não duplica o sino
 * nem a fila.
 */
export async function emitAgentEvent(
  db: Database,
  event: {
    kind: 'agent_completed' | 'agent_message';
    userId: string;
    agentRunId: string;
    eventKey: string;
    title?: string | null;
    text: string;
    link?: string | null;
    caixaId?: string | null;
    config: Config;
  },
) {
  await createNotifications(db, [
    {
      userId: event.userId,
      kind: event.kind,
      title: (
        event.title ?? (event.kind === 'agent_completed' ? t.messages.telegram.agentCompleted : t.messages.telegram.agentMessage)
      ).slice(0, 200),
      body: event.text.slice(0, 2000),
      link: event.link ?? null,
      caixaId: event.caixaId ?? null,
      data: { agentRunId: event.agentRunId },
      dedupKey: `${event.kind}:${event.eventKey}`,
    },
  ]);
  const subs = await activeSubscriptions(db, [event.kind]);
  let queued = 0;
  for (const sub of subs) {
    const scope = await destinationScope(db, sub);
    const personal = sub.owner_user_id === event.userId;
    const sharedCaixa = sub.owner_caixa_id !== null && (event.caixaId ? scope.includes(event.caixaId) : scope.length > 0);
    if (!personal && !sharedCaixa) continue;
    queued += await enqueue(
      db,
      sub.destination_id,
      sub.id,
      event.kind,
      [
        {
          dedupKey: `${event.kind}:${event.eventKey}:${sub.id}`,
          caixaId: event.caixaId ?? null,
          payload: agentMessage(event.kind, event.title ?? null, event.text, linkTo(event.config, event.link ?? null)),
        },
      ],
      { userId: event.userId, agentRunId: event.agentRunId },
    );
  }
  return { queued };
}

/** Uma passada completa do laço de mensagens. */
export async function messageTick(db: Database, config: Config, clock: SpClock = spClock()) {
  const produced = await produceMessages(db, config, clock);
  const notifications = await produceNotifications(db, config, clock);
  const consumed = await consumeOutbox(db, config);
  return { ...produced, ...notifications, ...consumed };
}
