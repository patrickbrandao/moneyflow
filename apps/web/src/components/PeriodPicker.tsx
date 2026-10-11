import { addDays, addMonths, t, todayIso } from '@moneyflow/shared';

/** Atalhos de período (o mês corrente, o anterior, os últimos 3 meses, o ano). */
export function periodPreset(preset: 'month' | 'prevMonth' | 'quarter' | 'year', today = todayIso()): { from: string; to: string } {
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  switch (preset) {
    case 'prevMonth': {
      const start = addMonths(monthStart, -1);
      return { from: start, to: addDays(monthStart, -1) };
    }
    case 'quarter':
      return { from: addMonths(monthStart, -2), to: monthEnd };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    default:
      return { from: monthStart, to: monthEnd };
  }
}

const PRESETS = ['month', 'prevMonth', 'quarter', 'year'] as const;

/** Período: atalhos + datas de/até. */
export function PeriodPicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (period: { from: string; to: string }) => void;
}) {
  const active = PRESETS.find((p) => {
    const range = periodPreset(p);
    return range.from === from && range.to === to;
  });
  return (
    <div className="period-picker">
      <select
        className="field field-auto field-sm"
        value={active ?? ''}
        onChange={(e) => e.target.value && onChange(periodPreset(e.target.value as (typeof PRESETS)[number]))}
        aria-label={t.flow.period}
      >
        {!active && <option value="">{t.flow.period}</option>}
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {t.flow.presets[p]}
          </option>
        ))}
      </select>
      <input
        type="date"
        className="field field-auto field-sm"
        value={from}
        max={to}
        onChange={(e) => e.target.value && onChange({ from: e.target.value, to })}
        aria-label={t.reports.from}
        title={t.reports.from}
      />
      <input
        type="date"
        className="field field-auto field-sm"
        value={to}
        min={from}
        onChange={(e) => e.target.value && onChange({ from, to: e.target.value })}
        aria-label={t.reports.to}
        title={t.reports.to}
      />
    </div>
  );
}
