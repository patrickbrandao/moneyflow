import { addDays, addMonths, formatDate, isIsoDate, isoWeekday, t } from '@moneyflow/shared';

/* Contas de data do calendário (semana começa na segunda, como a ISO). */

export type CalendarView = 'month' | 'week' | 'agenda';
export const VIEWS: CalendarView[] = ['month', 'week', 'agenda'];

export const asView = (value: string | null): CalendarView => (VIEWS.includes(value as CalendarView) ? (value as CalendarView) : 'month');
export const asDate = (value: string | null, fallback: string) => (value && isIsoDate(value) ? value : fallback);

export const startOfWeek = (iso: string) => addDays(iso, -(isoWeekday(iso) - 1));
export const monthStart = (iso: string) => `${iso.slice(0, 8)}01`;
export const monthEnd = (iso: string) => addDays(addMonths(monthStart(iso), 1), -1);

/** Período mostrado por uma visão: mês = semanas inteiras que cobrem o mês. */
export function viewRange(view: CalendarView, anchor: string): { from: string; to: string } {
  if (view === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  if (view === 'agenda') return { from: monthStart(anchor), to: monthEnd(anchor) };
  const from = startOfWeek(monthStart(anchor));
  return { from, to: addDays(startOfWeek(monthEnd(anchor)), 6) };
}

export function shiftAnchor(view: CalendarView, anchor: string, step: 1 | -1): string {
  return view === 'week' ? addDays(anchor, 7 * step) : addMonths(monthStart(anchor), step);
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 1101; day = addDays(day, 1)) out.push(day);
  return out;
}

export const monthName = (iso: string) => t.calendar.months[Number(iso.slice(5, 7)) - 1] ?? '';

export function viewLabel(view: CalendarView, anchor: string): string {
  if (view === 'week') {
    const { from, to } = viewRange('week', anchor);
    return `${formatDate(from)} – ${formatDate(to)}`;
  }
  const name = monthName(anchor);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${anchor.slice(0, 4)}`;
}

export const weekdayName = (iso: string) => t.calendar.weekdaysLong[isoWeekday(iso) - 1] ?? '';
export const dayNumber = (iso: string) => Number(iso.slice(8, 10));
