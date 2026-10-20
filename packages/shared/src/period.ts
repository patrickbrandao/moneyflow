import { addDays, addMonths, todayIso } from './dates';

/*
 * Período dos filtros de data das listagens de extrato e de títulos (spec 004/005):
 * o padrão são os últimos 60 dias e os próximos 30; os atalhos levam ao mês atual,
 * ao anterior, ao próximo e a hoje. Datas `YYYY-MM-DD` no fuso de São Paulo.
 */

export interface DatePeriod {
  /** '' = sem limite. */
  from: string;
  to: string;
}

export const DEFAULT_PERIOD_PAST_DAYS = 60;
export const DEFAULT_PERIOD_FUTURE_DAYS = 30;

export type PeriodShortcut = 'default' | 'prevMonth' | 'thisMonth' | 'nextMonth' | 'today';

/** Últimos 60 dias e próximos 30. */
export function defaultPeriod(today = todayIso()): DatePeriod {
  return { from: addDays(today, -DEFAULT_PERIOD_PAST_DAYS), to: addDays(today, DEFAULT_PERIOD_FUTURE_DAYS) };
}

/** O mês inteiro que contém `iso`. */
export function monthPeriod(iso: string): DatePeriod {
  const from = `${iso.slice(0, 7)}-01`;
  return { from, to: addDays(addMonths(from, 1), -1) };
}

/** Se o período é exatamente um mês inteiro, o primeiro dia dele; senão null. */
export function periodMonth(period: DatePeriod): string | null {
  if (!period.from || !period.to) return null;
  const month = monthPeriod(period.from);
  return month.from === period.from && month.to === period.to ? month.from : null;
}

/**
 * Aplica um atalho. Mês anterior/próximo andam a partir do mês mostrado quando o filtro
 * já é um mês inteiro (clicar de novo continua andando); senão, a partir do mês atual.
 */
export function applyPeriodShortcut(shortcut: PeriodShortcut, current: DatePeriod, today = todayIso()): DatePeriod {
  switch (shortcut) {
    case 'today':
      return { from: today, to: today };
    case 'thisMonth':
      return monthPeriod(today);
    case 'prevMonth':
    case 'nextMonth': {
      const base = periodMonth(current) ?? monthPeriod(today).from;
      return monthPeriod(addMonths(base, shortcut === 'prevMonth' ? -1 : 1));
    }
    default:
      return defaultPeriod(today);
  }
}

/** Qual atalho o período corresponde (para destacar o botão), ou null. */
export function activePeriodShortcut(period: DatePeriod, today = todayIso()): PeriodShortcut | null {
  const same = (other: DatePeriod) => other.from === period.from && other.to === period.to;
  if (same(defaultPeriod(today))) return 'default';
  if (same({ from: today, to: today })) return 'today';
  const month = periodMonth(period);
  if (!month) return null;
  const current = monthPeriod(today).from;
  if (month === current) return 'thisMonth';
  if (month === addMonths(current, -1)) return 'prevMonth';
  if (month === addMonths(current, 1)) return 'nextMonth';
  return null;
}
