import { formatAccounting, formatMonth } from '@moneyflow/shared';
import type { CSSProperties } from 'react';
import { negClass } from '../domain';
import { cx } from '../ui';

/*
 * Gráficos leves dos relatórios, em HTML/CSS (sem biblioteca): barras
 * empilhadas por mês e barras horizontais de ranking. Cores só por token:
 * a série = a cor da categoria (--port-N); sem cor, o texto apagado. Funcionam
 * nos dois temas porque só usam tokens.
 */

export type Series = { key: string; label: string; colorSlot: number | null; values: number[] };

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
/** Rótulo curto do total da barra: "2,1 mil". */
const short = (cents: number) => compact.format(cents / 100);

const color = (slot: number | null) => (slot ? `var(--port-${slot})` : 'var(--text-faint)');

/** Barras empilhadas por mês (uma série por grupo). Valores negativos (estornos) não empilham. */
export function StackedBars({ months, series, label }: { months: string[]; series: Series[]; label: string }) {
  const totals = months.map((_, i) => series.reduce((acc, s) => acc + Math.max(0, s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  return (
    <figure className="chart" aria-label={label}>
      <div className="chart-bars" style={{ '--n': months.length } as CSSProperties}>
        {months.map((month, i) => (
          <div key={month} className="chart-col" title={`${formatMonth(month)}: ${formatAccounting(totals[i]!)}`}>
            <span className="chart-total money">{totals[i] ? short(totals[i]!) : ''}</span>
            <div className="chart-stack">
              {series.map((s) => {
                const value = Math.max(0, s.values[i] ?? 0);
                if (value === 0) return null;
                return (
                  <i
                    key={s.key}
                    style={{ height: `${(value / max) * 100}%`, background: color(s.colorSlot) }}
                    title={`${s.label} · ${formatMonth(month)}: ${formatAccounting(value)}`}
                  />
                );
              })}
            </div>
            <span className="chart-x">{formatMonth(month)}</span>
          </div>
        ))}
      </div>
      <figcaption className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: color(s.colorSlot) }} /> {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Ranking em barras horizontais (valor e parte do total). */
export function RankBars({
  rows,
}: {
  rows: { key: string; label: string; sub?: string | null; colorSlot: number | null; value: number; share: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="rank">
      {rows.map((row, index) => (
        <li key={row.key}>
          <span className="rank-n mono">{index + 1}</span>
          <span className="rank-body">
            <span className="rank-label">
              <span className="truncate">{row.label}</span>
              {row.sub && <span className="rank-sub truncate">{row.sub}</span>}
            </span>
            <span className="rank-bar">
              <i style={{ width: `${(Math.max(0, row.value) / max) * 100}%`, background: color(row.colorSlot) }} />
            </span>
          </span>
          <span className="rank-v">
            <span className={cx('money', negClass(row.value))}>{formatAccounting(row.value)}</span>
            <span className="rank-share">{(row.share * 100).toFixed(1).replace('.', ',')}%</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
