import { addDays, addMonths, diffDays, isoWeekday } from './dates';

/*
 * Calendário de uma série (recurrence_rules, spec 005). A regra guarda só o
 * calendário; o título n da série vence em occurrenceDueDate(regra, n).
 */

export const FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type RecurrenceRule = {
  frequency: Frequency;
  intervalCount: number;
  /** weekly: dia da semana ISO (1–7); monthly/yearly: dia do mês (1–31). */
  anchorDay: number;
  startsOn: string;
  endsOn?: string | null;
  installmentsTotal?: number | null;
};

/** Primeira data >= startsOn que cai no dia da semana âncora. */
function firstWeekly(rule: RecurrenceRule): string {
  const delta = (rule.anchorDay - isoWeekday(rule.startsOn) + 7) % 7;
  return addDays(rule.startsOn, delta);
}

/** Meses entre ocorrências (monthly/yearly). */
export function monthsStep(rule: Pick<RecurrenceRule, 'frequency' | 'intervalCount'>): number {
  return rule.frequency === 'yearly' ? 12 * rule.intervalCount : rule.intervalCount;
}

/** Vencimento da ocorrência n (1 = primeira). */
export function occurrenceDueDate(rule: RecurrenceRule, n: number): string {
  if (n < 1) throw new Error('ocorrência começa em 1');
  if (rule.frequency === 'weekly') return addDays(firstWeekly(rule), (n - 1) * 7 * rule.intervalCount);
  return addMonths(rule.startsOn, (n - 1) * monthsStep(rule), rule.anchorDay);
}

/**
 * Competência da ocorrência n, a partir da competência de uma ocorrência
 * conhecida (o "modelo" da série): mesmo deslocamento do calendário.
 */
export function occurrenceCompetenceDate(
  rule: RecurrenceRule,
  template: { occurrence: number; competenceDate: string },
  n: number,
): string {
  if (rule.frequency === 'weekly') {
    return addDays(template.competenceDate, (n - template.occurrence) * 7 * rule.intervalCount);
  }
  return addMonths(template.competenceDate, (n - template.occurrence) * monthsStep(rule));
}

/** A ocorrência n existe na regra (respeita fim por data ou por total de parcelas)? */
export function occurrenceWithinRule(rule: RecurrenceRule, n: number): boolean {
  if (rule.installmentsTotal != null && n > rule.installmentsTotal) return false;
  if (rule.endsOn && diffDays(occurrenceDueDate(rule, n), rule.endsOn) < 0) return false;
  return true;
}

/**
 * Números das ocorrências que devem existir depois de `lastOccurrence`, até o
 * horizonte (inclusive). Limite de segurança para regras patológicas.
 */
export function pendingOccurrences(rule: RecurrenceRule, lastOccurrence: number, horizon: string, max = 1000): number[] {
  const out: number[] = [];
  for (let n = lastOccurrence + 1; out.length < max; n += 1) {
    if (!occurrenceWithinRule(rule, n)) break;
    if (diffDays(occurrenceDueDate(rule, n), horizon) < 0) break;
    out.push(n);
  }
  return out;
}

/** Horizonte de materialização: 12 meses à frente de hoje. */
export const MATERIALIZE_MONTHS = 12;
