import { barcodeToDigitableLine } from './boleto';
import { addDays, diffDays, formatDate, isoWeekday, TIME_ZONE } from './dates';
import { messagesStrings } from './i18n/areas/messages';
import { formatBRL } from './money';

/*
 * Mensagens do Telegram (spec 013): montagem do texto em HTML (parse_mode
 * HTML da Bot API), com escape de tudo o que vem do usuário, e o cálculo de
 * agendamento por horário no fuso America/Sao_Paulo. Puro (sem banco): o
 * worker busca os dados e chama estas funções; os testes unitários as cobrem.
 */

const T = messagesStrings.telegram;

/** Limite de texto da Bot API (sendMessage). */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Escape para o parse_mode HTML do Telegram: só &, < e > (e aspas, por segurança em atributos). */
export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Payload gravado na outbox (imutável). */
export type MessagePayload = { text: string; parse_mode: 'HTML' };

const payload = (lines: (string | null | undefined | false)[]): MessagePayload => ({
  text: clampLines(lines.filter((line): line is string => typeof line === 'string')),
  parse_mode: 'HTML',
});

/**
 * Junta as linhas respeitando o limite do Telegram: corta linhas inteiras
 * (nunca no meio de uma tag) e avisa quantas ficaram de fora.
 */
export function clampLines(lines: string[], limit = TELEGRAM_TEXT_LIMIT): string {
  const full = lines.join('\n');
  if (full.length <= limit) return full;
  const kept: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const tail = T.more(lines.length - i);
    if (size + line.length + 1 + tail.length + 1 > limit) {
      kept.push(escapeHtml(tail));
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n');
}

const b = (text: string) => `<b>${escapeHtml(text)}</b>`;
const code = (text: string) => `<code>${escapeHtml(text)}</code>`;
const money = (cents: number) => escapeHtml(formatBRL(cents));
const linkLine = (url: string | null | undefined) => (url ? `<a href="${escapeHtml(url)}">${escapeHtml(T.open_link)}</a>` : null);

/* ---------------- agendamento ---------------- */

/** Relógio de São Paulo: data de negócio, HH:MM e dia ISO da semana (1 = segunda). */
export type SpClock = { date: string; time: string; weekday: number };

export function spClock(now: Date = new Date(), timeZone = TIME_ZONE): SpClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday: isoWeekday(date) };
}

/** O horário de envio (HH:MM, São Paulo) já chegou hoje? Quem perdeu o horário (worker parado) envia ao voltar, no mesmo dia. */
export const isTimeReached = (sendAt: string, clock: SpClock) => clock.time >= sendAt;

/** Datas de vencimento que geram lembrete hoje: hoje + N para cada N de days_before. */
export const reminderDueDates = (today: string, daysBefore: number[]) =>
  daysBefore.map((n) => ({ daysBefore: n, dueDate: addDays(today, n) }));

/**
 * Atrasado: sem repetição, um aviso por título (dedup sem data); com repetição a cada N dias, avisa no
 * primeiro dia de atraso e a cada N dias depois (dedup com a data).
 */
export function overdueSchedule(
  dueDate: string,
  today: string,
  repeatEveryDays?: number | null,
): { send: boolean; dedupKey: string; daysLate: number } | null {
  const daysLate = diffDays(dueDate, today);
  if (daysLate < 1) return null;
  if (!repeatEveryDays) return { send: true, dedupKey: '', daysLate };
  return { send: (daysLate - 1) % repeatEveryDays === 0, dedupKey: today, daysLate };
}

/** Segunda-feira (ISO) da semana de `date`. */
export const weekStart = (date: string) => addDays(date, 1 - isoWeekday(date));

/** Chaves de dedup (únicas por destino em message_outbox; por usuário em notifications). */
export const dedupKeys = {
  dueReminder: (titleId: string, daysBefore: number, dueDate: string) => `due_reminder:${titleId}:D-${daysBefore}:${dueDate}`,
  overdue: (titleId: string, day: string) => (day ? `overdue:${titleId}:${day}` : `overdue:${titleId}`),
  daily: (date: string) => `daily_summary:${date}`,
  weekly: (monday: string) => `weekly_summary:${monday}`,
  invoiceClosed: (invoiceId: string) => `invoice_closed:${invoiceId}`,
  cardLimit: (cardId: string, threshold: number, month: string) => `card_limit:${cardId}:${threshold}:${month}`,
  divergence: (importId: string) => `reconciliation_divergence:${importId}`,
  // Contratos (specs 020 e 034): por contrato e fim da vigência (`<contrato>:<fim>`).
  contractNotice: (termKey: string, daysBefore: number) => `contract_notice_deadline:${termKey}:D-${daysBefore}`,
  contractEnding: (termKey: string, daysBefore: number) => `contract_ending:${termKey}:D-${daysBefore}`,
  contractRenewed: (contractId: string, seq: number) => `contract_renewed:${contractId}:${seq}`,
  contractReadjustment: (contractId: string, date: string) => `contract_readjustment:${contractId}:${date}`,
  /** Cobrança no cartão não feita (spec 034): uma vez por ocorrência. */
  contractChargeMissing: (ruleId: string, occurrence: number) => `contract_charge_missing:${ruleId}:${occurrence}`,
  // Orçamento de IA (spec 028): por orçamento, mês (AAAA-MM) e limiar.
  aiBudgetAlert: (budgetId: string, month: string, threshold: number) => `ai_budget_alert:${budgetId}:${month.slice(0, 7)}:${threshold}`,
};

/* ---------------- montagem das mensagens ---------------- */

export type ReminderTitle = {
  description: string;
  direction: 'payable' | 'receivable';
  dueDate: string;
  openCents: number;
  caixaName: string;
  entityName: string | null;
  boletoBarcode?: string | null;
  pixPayload?: string | null;
  /** Parcela de contrato (spec 020): "Nome (n/N)". */
  contractLabel?: string | null;
};

function titleBlock(title: ReminderTitle): string[] {
  const line = title.boletoBarcode ? (barcodeToDigitableLine(title.boletoBarcode) ?? title.boletoBarcode) : null;
  return [
    `${escapeHtml(title.direction === 'payable' ? T.payable : T.receivable)} · ${escapeHtml(title.caixaName)}`,
    `${b(title.description)}${title.entityName ? ` — ${escapeHtml(title.entityName)}` : ''}`,
    ...(title.contractLabel ? [`${escapeHtml(T.contract)}: ${escapeHtml(title.contractLabel)}`] : []),
    `${money(title.openCents)} ${escapeHtml(T.open)} · ${escapeHtml(T.due)} ${escapeHtml(formatDate(title.dueDate))}`,
    ...(line ? ['', `${escapeHtml(T.boleto)}:`, code(line)] : []),
    ...(title.pixPayload ? ['', `${escapeHtml(T.pix)}:`, code(title.pixPayload)] : []),
  ];
}

export function dueReminderMessage(title: ReminderTitle, daysBefore: number, url?: string | null): MessagePayload {
  return payload([b(T.dueIn(daysBefore)), ...titleBlock(title), linkLine(url) && '', linkLine(url)]);
}

export function overdueMessage(title: ReminderTitle, daysLate: number, url?: string | null): MessagePayload {
  return payload([b(T.overdueFor(daysLate)), ...titleBlock(title), linkLine(url) && '', linkLine(url)]);
}

export type SummaryItem = {
  description: string;
  direction: 'payable' | 'receivable';
  dueDate: string;
  openCents: number;
  caixaName: string;
};
export type SummaryData = {
  /** Título já pronto (dia ou semana). */
  heading: string;
  dueLabel: string;
  due: SummaryItem[];
  overdue: { count: number; cents: number };
  balances: { caixaName: string; cents: number }[];
  flowLabel: string;
  flow: { caixaName: string; inflowCents: number; outflowCents: number }[];
  showDueDate: boolean;
};

/** Até quantos vencimentos o resumo lista (o resto vira "… e mais N"). */
const SUMMARY_MAX_ITEMS = 25;

export function summaryMessage(data: SummaryData): MessagePayload {
  const shown = data.due.slice(0, SUMMARY_MAX_ITEMS);
  const dueLines = shown.map(
    (item) =>
      `• ${data.showDueDate ? `${escapeHtml(formatDate(item.dueDate).slice(0, 5))} ` : ''}${escapeHtml(item.direction === 'payable' ? '−' : '+')}${money(item.openCents)} ${escapeHtml(item.description)} <i>(${escapeHtml(item.caixaName)})</i>`,
  );
  if (data.due.length > shown.length) dueLines.push(escapeHtml(T.more(data.due.length - shown.length)));
  return payload([
    b(data.heading),
    '',
    b(data.dueLabel),
    ...(dueLines.length > 0 ? dueLines : [escapeHtml(T.nothingDue)]),
    data.overdue.count > 0 ? escapeHtml(T.overdueTotal(data.overdue.count, formatBRL(data.overdue.cents))) : null,
    '',
    b(T.balances),
    ...data.balances.map((row) => `• ${escapeHtml(row.caixaName)}: ${money(row.cents)}`),
    '',
    b(data.flowLabel),
    ...data.flow.map(
      (row) =>
        `• ${escapeHtml(row.caixaName)}: ${escapeHtml(T.inflow)} ${money(row.inflowCents)} · ${escapeHtml(T.outflow)} ${money(row.outflowCents)}`,
    ),
  ]);
}

export function invoiceClosedMessage(input: {
  cardName: string;
  referenceMonth: string;
  dueDate: string;
  totalCents: number;
  payers: { caixaName: string; cents: number }[];
  url?: string | null;
}): MessagePayload {
  const month = `${input.referenceMonth.slice(5, 7)}/${input.referenceMonth.slice(0, 4)}`;
  return payload([
    b(T.invoiceClosed(input.cardName, month)),
    `${escapeHtml(T.invoiceTotal)}: ${money(input.totalCents)} · ${escapeHtml(T.due)} ${escapeHtml(formatDate(input.dueDate))}`,
    '',
    b(T.invoiceByPayer),
    ...input.payers.map((p) => `• ${escapeHtml(p.caixaName)}: ${money(p.cents)}`),
    linkLine(input.url) && '',
    linkLine(input.url),
  ]);
}

export function cardLimitMessage(input: { cardName: string; usedCents: number; limitCents: number; url?: string | null }): MessagePayload {
  return payload([
    b(T.cardLimit(input.cardName, limitPercent(input.usedCents, input.limitCents))),
    escapeHtml(T.cardLimitDetail(formatBRL(input.usedCents), formatBRL(input.limitCents), formatBRL(input.limitCents - input.usedCents))),
    linkLine(input.url) && '',
    linkLine(input.url),
  ]);
}

/** Percentual de uso do limite (inteiro, para baixo); limite zero = 0 sem uso, 999 com uso. */
export const limitPercent = (usedCents: number, limitCents: number) =>
  limitCents > 0 ? Math.floor((usedCents * 100) / limitCents) : usedCents > 0 ? 999 : 0;

export function divergenceMessage(input: {
  accountName: string;
  caixaName: string;
  bankBalanceOn: string;
  bankCents: number;
  appCents: number;
  url?: string | null;
}): MessagePayload {
  return payload([
    b(T.divergence(`${input.accountName} (${input.caixaName})`)),
    escapeHtml(
      T.divergenceDetail(
        formatDate(input.bankBalanceOn),
        formatBRL(input.bankCents),
        formatBRL(input.appCents),
        formatBRL(input.bankCents - input.appCents),
      ),
    ),
    linkLine(input.url) && '',
    linkLine(input.url),
  ]);
}

export function testMessage(destinationName: string, at: string): MessagePayload {
  return payload([b(T.test), escapeHtml(T.testDetail(destinationName, at))]);
}

/** Eventos de agente (F4): título e texto livres, sempre escapados. */
export function agentMessage(
  kind: 'agent_completed' | 'agent_message' | 'ai_awaiting_approval',
  title: string | null,
  text: string,
  url?: string | null,
): MessagePayload {
  return payload([
    b(title ?? (kind === 'agent_completed' ? T.agentCompleted : T.agentMessage)),
    escapeHtml(text),
    linkLine(url) && '',
    linkLine(url),
  ]);
}

/** Orçamento de IA (spec 028): aviso no percentual e a 100% (bloqueio). */
export function budgetAlertMessage(input: {
  scope: string;
  threshold: number;
  spent: string;
  limit: string;
  percent: string;
  url?: string | null;
}): MessagePayload {
  return payload([
    b(T.budgetAlert(input.scope, input.threshold)),
    escapeHtml(T.budgetAlertDetail(input.spent, input.limit, input.percent)),
    input.threshold >= 100 && escapeHtml(T.budgetBlocked),
    linkLine(input.url) && '',
    linkLine(input.url),
  ]);
}

/* ---------------- contratos (spec 020) ---------------- */

export type ContractMessageInfo = {
  name: string;
  entityName: string;
  caixaName: string;
  direction: 'payable' | 'receivable';
  url?: string | null;
};

const contractHeader = (c: ContractMessageInfo) => [
  `${escapeHtml(c.direction === 'payable' ? T.payable : T.receivable)} · ${escapeHtml(c.caixaName)}`,
  `${b(c.name)} — ${escapeHtml(c.entityName)}`,
];

export function contractNoticeMessage(c: ContractMessageInfo, daysBefore: number, deadline: string, cycleEnd: string): MessagePayload {
  return payload([
    b(T.contractNotice(daysBefore)),
    ...contractHeader(c),
    escapeHtml(T.contractNoticeDetail(formatDate(deadline), formatDate(cycleEnd))),
    linkLine(c.url) && '',
    linkLine(c.url),
  ]);
}

export function contractEndingMessage(c: ContractMessageInfo, daysBefore: number, cycleEnd: string): MessagePayload {
  return payload([
    b(T.contractEnding(daysBefore)),
    ...contractHeader(c),
    escapeHtml(T.contractEndingDetail(formatDate(cycleEnd))),
    linkLine(c.url) && '',
    linkLine(c.url),
  ]);
}

export function contractReadjustmentMessage(c: ContractMessageInfo, indexLabel: string, date: string): MessagePayload {
  return payload([
    b(T.contractReadjustment),
    ...contractHeader(c),
    escapeHtml(T.contractReadjustmentDetail(indexLabel, formatDate(date))),
    linkLine(c.url) && '',
    linkLine(c.url),
  ]);
}

/** Dia da semana por extenso (1 = segunda). */
export const weekdayName = (weekday: number) => messagesStrings.weekdays[(weekday - 1 + 7) % 7] ?? '';
