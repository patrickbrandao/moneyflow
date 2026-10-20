import {
  activePeriodShortcut,
  applyPeriodShortcut,
  type DatePeriod,
  defaultPeriod,
  type PeriodShortcut,
  t,
  todayIso,
} from '@moneyflow/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';
import { storageKey } from '../config/brand';
import { readStored, writeStored } from '../lib/storage';
import { cx } from './ui';

/** Atalhos relativos a hoje: guardados pelo nome e recalculados quando a tela abre noutro dia. */
const RELATIVE: PeriodShortcut[] = ['default', 'thisMonth', 'today'];

interface StoredPeriod extends DatePeriod {
  preset: PeriodShortcut | null;
}

/**
 * Período de data lembrado por visão (`scope`: a conta do extrato, os títulos a pagar de
 * uma caixa…), neste navegador. Começa no padrão (últimos 60 dias e próximos 30); quem
 * volta à tela encontra a última escolha.
 */
export function useStoredPeriod(scope: string): [DatePeriod, (period: DatePeriod) => void] {
  const key = storageKey(`period:${scope}`);
  const initial: StoredPeriod = { preset: 'default', ...defaultPeriod() };
  // a visão pode trocar sem desmontar (o seletor de conta do extrato): relê a chave nova
  const [state, setState] = useState(() => ({ key, value: readStored(key, initial) }));
  const stored = state.key === key ? state.value : readStored(key, initial);
  const today = todayIso();
  const period =
    stored.preset && RELATIVE.includes(stored.preset)
      ? applyPeriodShortcut(stored.preset, stored, today)
      : { from: stored.from ?? '', to: stored.to ?? '' };
  const set = useCallback(
    (next: DatePeriod) => {
      const preset = activePeriodShortcut(next);
      const value: StoredPeriod = { preset: preset && RELATIVE.includes(preset) ? preset : null, from: next.from, to: next.to };
      writeStored(key, value);
      setState({ key, value });
    },
    [key],
  );
  return [period, set];
}

const SHORTCUTS: PeriodShortcut[] = ['prevMonth', 'thisMonth', 'nextMonth', 'today', 'default'];

/** Filtro de data inicial/final com os atalhos de mês anterior, atual, próximo, hoje e o padrão. */
export function DateRangeFilter({
  value,
  onChange,
  fromLabel = t.common.from,
  toLabel = t.common.to,
}: {
  value: DatePeriod;
  onChange: (period: DatePeriod) => void;
  fromLabel?: string;
  toLabel?: string;
}) {
  const active = activePeriodShortcut(value);
  const p = t.period;
  return (
    <div className="date-range">
      <div className="segmented" role="group" aria-label={p.label}>
        {SHORTCUTS.map((key) => (
          <button
            key={key}
            type="button"
            className={cx(active === key && 'active')}
            aria-pressed={active === key}
            title={key === 'default' ? p.defaultHint : undefined}
            onClick={() => onChange(applyPeriodShortcut(key, value))}
          >
            {key === 'prevMonth' && <ChevronLeft aria-hidden />}
            {p.shortcuts[key]}
            {key === 'nextMonth' && <ChevronRight aria-hidden />}
          </button>
        ))}
      </div>
      <input
        type="date"
        className="field field-auto"
        value={value.from}
        max={value.to || undefined}
        onChange={(e) => onChange({ from: e.target.value, to: value.to })}
        aria-label={fromLabel}
        title={fromLabel}
      />
      <input
        type="date"
        className="field field-auto"
        value={value.to}
        min={value.from || undefined}
        onChange={(e) => onChange({ from: value.from, to: e.target.value })}
        aria-label={toLabel}
        title={toLabel}
      />
    </div>
  );
}
