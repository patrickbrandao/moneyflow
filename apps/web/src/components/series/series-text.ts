import { formatDate, type SeriesDto, t } from '@moneyflow/shared';

/* Textos e mapeamentos da série recorrente (spec 034), usados no contrato e no título. */

const O = t.contracts.obligation;

/** Tipo da categoria pela direção: eu pago = despesa, eu recebo = receita. */
export const kindOf = (direction: 'receivable' | 'payable') => (direction === 'payable' ? 'expense' : 'income');

/** Calendário legível da série ("Todo mês · dia 10", "A cada 3 mês(es) · dia 5"). */
export function calendarText(series: Pick<SeriesDto, 'frequency' | 'intervalCount' | 'anchorDay' | 'startsOn'>): string {
  const unit = O[series.frequency] as string;
  const every = series.intervalCount === 1 ? O.everyOne[series.frequency]! : O.everyN(series.intervalCount, unit);
  const day = series.frequency === 'weekly' ? O.dayOfWeek(formatDate(series.startsOn)) : O.dayOfMonth(series.anchorDay);
  return O.summary(every, day);
}
