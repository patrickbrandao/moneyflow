import { addDays, addMonths, dayOfMonth, daysInMonth, diffDays, toIso } from './dates';

/*
 * Contratos (spec 020): o calendário de um ciclo e as contas das parcelas,
 * puros (sem banco). A API gera os títulos com estas funções, o front mostra a
 * prévia com as mesmas, e os testes unitários as cobrem.
 */

export const CONTRACT_DIRECTIONS = ['receivable', 'payable'] as const;
export const CONTRACT_STATUSES = ['draft', 'active', 'renewal_pending', 'ended', 'terminated'] as const;
export const CONTRACT_PERIODICITIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'single'] as const;
export const READJUSTMENT_INDEXES = ['none', 'ipca', 'igpm', 'inpc', 'other'] as const;
export const CONTRACT_DOCUMENT_KINDS = ['contract', 'amendment', 'renewal', 'termination', 'proposal', 'other'] as const;
export const CONTRACT_DOCUMENT_FORMATS = ['pdf', 'markdown'] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type ContractPeriodicity = (typeof CONTRACT_PERIODICITIES)[number];
export type ReadjustmentIndex = (typeof READJUSTMENT_INDEXES)[number];
export type ContractDocumentKind = (typeof CONTRACT_DOCUMENT_KINDS)[number];
export type ContractDocumentFormat = (typeof CONTRACT_DOCUMENT_FORMATS)[number];

/** Limites do cadastro (os mesmos do banco). */
export const CONTRACT_MAX_MONTHS = 120;
export const CONTRACT_MAX_DUE_OFFSET = 3;
/** Markdown enviado ou salvo: até 1 MB em UTF-8. */
export const CONTRACT_MARKDOWN_MAX_BYTES = 1024 * 1024;

/** Meses de cada período; `single` cobre o ciclo inteiro. */
export const PERIOD_MONTHS: Record<Exclude<ContractPeriodicity, 'single'>, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export const periodMonths = (periodicity: ContractPeriodicity, durationMonths: number) =>
  periodicity === 'single' ? durationMonths : PERIOD_MONTHS[periodicity];

/**
 * Fim do ciclo: dia anterior ao mesmo dia do mês, `duração` meses depois
 * (01/03/2025 + 12 → 28/02/2026). Se esse dia não existe no mês final, o
 * ciclo vai até o último dia dele (31/01 + 1 → 28/02; o seguinte começa em 01/03).
 */
export function cycleEnd(startsOn: string, durationMonths: number): string {
  const same = addMonths(startsOn, durationMonths);
  return dayOfMonth(same) < dayOfMonth(startsOn) ? same : addDays(same, -1);
}

/** Número de parcelas do ciclo, ou null se a duração não é múltipla do período. */
export function installmentsCount(durationMonths: number, periodicity: ContractPeriodicity): number | null {
  if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > CONTRACT_MAX_MONTHS) return null;
  if (periodicity === 'single') return 1;
  const months = PERIOD_MONTHS[periodicity];
  return durationMonths % months === 0 ? durationMonths / months : null;
}

/** Parcelas iguais; o resto em centavos fica na primeira (como nas compras parceladas do cartão). */
export function splitTotal(totalCents: number, count: number): number[] {
  if (count < 1) return [];
  const base = Math.floor(totalCents / count);
  const rest = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (i === 0 ? base + rest : base));
}

/** Vencimento: dia fixo no mês da competência + deslocamento (meses curtos usam o último dia). */
export function dueDateFor(competenceDate: string, dueDay: number, offsetMonths: number): string {
  const first = addMonths(`${competenceDate.slice(0, 7)}-01`, offsetMonths);
  const year = Number(first.slice(0, 4));
  const month = Number(first.slice(5, 7));
  return toIso(year, month, Math.min(dueDay, daysInMonth(year, month)));
}

export type CycleTerms = {
  startsOn: string;
  durationMonths: number;
  periodicity: ContractPeriodicity;
  totalCents: number;
  dueDay: number;
  dueMonthOffset: number;
};

export type ScheduledInstallment = {
  /** n de N. */
  installment: number;
  /** Primeiro dia do período coberto (a competência). */
  competenceDate: string;
  /** Último dia do período coberto. */
  periodEnd: string;
  dueDate: string;
  amountCents: number;
};

/** Início do período n (1 = primeiro) do ciclo. */
export const periodStart = (terms: Pick<CycleTerms, 'startsOn' | 'periodicity' | 'durationMonths'>, n: number) =>
  addMonths(terms.startsOn, (n - 1) * periodMonths(terms.periodicity, terms.durationMonths), dayOfMonth(terms.startsOn));

/** As parcelas do ciclo inteiro. Lança se a duração não for múltipla do período. */
export function cycleSchedule(terms: CycleTerms): ScheduledInstallment[] {
  const count = installmentsCount(terms.durationMonths, terms.periodicity);
  if (count === null) throw new Error('duração não é múltipla do período');
  const amounts = splitTotal(terms.totalCents, count);
  const end = cycleEnd(terms.startsOn, terms.durationMonths);
  return amounts.map((amountCents, i) => {
    const competenceDate = periodStart(terms, i + 1);
    const periodEnd = i + 1 === count ? end : addDays(periodStart(terms, i + 2), -1);
    return {
      installment: i + 1,
      competenceDate,
      periodEnd,
      dueDate: dueDateFor(competenceDate, terms.dueDay, terms.dueMonthOffset),
      amountCents,
    };
  });
}

/** Valor proporcional da parcela até a data de encerramento (inclusive), arredondado ao centavo. */
export function proratedAmount(amountCents: number, competenceDate: string, periodEnd: string, endOn: string): number {
  if (endOn < competenceDate) return 0;
  if (endOn >= periodEnd) return amountCents;
  const total = diffDays(competenceDate, periodEnd) + 1;
  const covered = diffDays(competenceDate, endOn) + 1;
  return Math.round((amountCents * covered) / total);
}

/** Reajuste em % sobre o total (62.700,01 = 60.000,01 × 1,045). */
export const readjustedTotal = (totalCents: number, percent: number) => Math.round(totalCents * (1 + percent / 100));

/** Último dia para pedir a não renovação ou a rescisão: fim − aviso prévio. */
export const noticeDeadline = (cycleEndsOn: string, noticeDays: number) => addDays(cycleEndsOn, -noticeDays);

/** Dia em que a tarefa de renovação abre: fim − antecedência. */
export const renewalOpensOn = (cycleEndsOn: string, leadDays: number) => addDays(cycleEndsOn, -leadDays);

/**
 * Data-base do reajuste no ano de `today` (a informada, ou o aniversário do
 * contrato): devolve a data se ela cai depois do início do contrato.
 */
export function readjustmentDateIn(year: number, contractStart: string, baseDate: string | null): string | null {
  const base = baseDate ?? contractStart;
  const month = Number(base.slice(5, 7));
  const day = Math.min(dayOfMonth(base), daysInMonth(year, month));
  const date = toIso(year, month, day);
  return date > contractStart ? date : null;
}

/**
 * Recalcula as parcelas afetadas por um aditivo: valor novo por parcela
 * (`installmentCents`) ou o total restante dividido entre elas, com o resto
 * na primeira (`remainingTotalCents`); o vencimento segue o dia/deslocamento
 * novos. Devolve só o que muda.
 */
export function amendInstallments(
  affected: { id: string; competenceDate: string; amountCents: number; dueDate: string }[],
  change: { installmentCents?: number | null; remainingTotalCents?: number | null; dueDay?: number | null; dueMonthOffset?: number | null },
  current: { dueDay: number; dueMonthOffset: number },
): { id: string; amountCents: number; dueDate: string }[] {
  const ordered = [...affected].sort((a, b) => a.competenceDate.localeCompare(b.competenceDate));
  const amounts = change.remainingTotalCents
    ? splitTotal(change.remainingTotalCents, ordered.length)
    : ordered.map((row) => change.installmentCents ?? row.amountCents);
  const dueDay = change.dueDay ?? current.dueDay;
  const offset = change.dueMonthOffset ?? current.dueMonthOffset;
  const dueChanged = change.dueDay != null || change.dueMonthOffset != null;
  return ordered.map((row, i) => ({
    id: row.id,
    amountCents: amounts[i]!,
    dueDate: dueChanged ? dueDateFor(row.competenceDate, dueDay, offset) : row.dueDate,
  }));
}

/** "Suporte mensal ACME · 3/12". */
export const installmentDescription = (contractName: string, n: number, total: number) => `${contractName} · ${n}/${total}`;

/** Rótulo do contrato numa parcela (avisos e listas). */
export const contractInstallmentLabel = (name: string, n: number | null, total: number | null) =>
  n && total ? `${name} (${n}/${total})` : name;

/** Contrato termina dentro de `days` dias a partir de hoje (inclusive)? */
export const endsWithin = (endsOn: string, today: string, days: number) => endsOn >= today && diffDays(today, endsOn) <= days;
