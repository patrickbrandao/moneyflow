import { formatAccounting, formatMonth } from '@moneyflow/shared';
import { useState } from 'react';
import { Legend, niceTicks, TipRow, Tooltip, topRounded, useKeyboardIndex, useWidth } from '../admin-ai/usage-charts';

/*
 * Gráficos da tela da conta (spec 004), no mesmo SVG próprio do painel de uso
 * (classes uc-*): colunas lado a lado por mês, a linha do saldo e a pizza
 * (rosca) por categoria. Cores só por token: entradas --ok, saídas --danger,
 * saldo --accent-soft e a categoria --port-N (sem cor, --chart-other).
 */

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 72 };
const MAX_BAR = 18;
const RADIUS = 3;

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const axisMoney = (cents: number) => compact.format(cents / 100);

export type MonthSeries = { key: string; label: string; color: string; values: number[] };

/** Colunas agrupadas por mês (uma por série, lado a lado), todas positivas. */
export function MonthColumns({
  months,
  series,
  label,
  testId,
}: {
  months: string[];
  series: MonthSeries[];
  label: string;
  testId?: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const onKey = useKeyboardIndex(months.length, setHover);
  const ticks = niceTicks(Math.max(0, ...series.flatMap((s) => s.values)));
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = months.length > 0 ? plotW / months.length : plotW;
  const barW = Math.max(3, Math.min(MAX_BAR, (band * 0.72) / Math.max(1, series.length)));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(plotW / 64))));

  return (
    <figure className="uc-chart" aria-label={label} data-testid={testId}>
      <div ref={ref} className="uc-plot" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: o gráfico recebe foco para as setas mostrarem a dica de cada mês (a mesma do mouse).
          <svg width={width} height={HEIGHT} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="uc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="uc-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {axisMoney(tick)}
                </text>
              </g>
            ))}
            {months.map((month, i) => {
              const cx = PAD.left + band * i + band / 2;
              const left = cx - (barW * series.length) / 2;
              return (
                <g key={month} className={hover === i ? 'uc-col is-hover' : 'uc-col'}>
                  {series.map((s, k) => {
                    const value = Math.max(0, s.values[i] ?? 0);
                    const h = (value / top) * plotH;
                    if (h <= 0) return null;
                    return <path key={s.key} d={topRounded(left + barW * k + 1, y(value), barW - 2, h, RADIUS)} fill={s.color} />;
                  })}
                  {i % every === 0 && (
                    <text className="uc-axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                      {formatMonth(month)}
                    </text>
                  )}
                  <rect
                    className="uc-hit"
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    onPointerEnter={() => setHover(i)}
                    onPointerMove={() => setHover(i)}
                  />
                </g>
              );
            })}
            <line className="uc-baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
          </svg>
        )}
        {hover !== null && months[hover] && (
          <Tooltip x={PAD.left + band * hover + band / 2} width={width}>
            <div className="uc-tip-head">{formatMonth(months[hover]!)}</div>
            {series.map((s) => (
              <TipRow key={s.key} color={s.color} label={s.label} value={formatAccounting(s.values[hover] ?? 0)} />
            ))}
          </Tooltip>
        )}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </figure>
  );
}

/** Linha do saldo ao fim de cada mês; aceita negativo (a escala desce abaixo de zero) e lacunas (antes da abertura). */
export function BalanceLine({
  months,
  values,
  label,
  color,
  testId,
}: {
  months: string[];
  values: (number | null)[];
  label: string;
  color: string;
  testId?: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const onKey = useKeyboardIndex(months.length, setHover);
  const present = values.filter((v): v is number => v !== null);
  const upper = niceTicks(Math.max(0, ...present));
  const lower = niceTicks(Math.max(0, ...present.map((v) => -v)));
  const max = upper[upper.length - 1] || 0;
  const min = -(lower[lower.length - 1] || 0);
  const span = max - min || 1;
  const ticks = [
    ...lower
      .slice(1)
      .map((v) => -v)
      .reverse(),
    ...upper,
  ];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = months.length > 0 ? plotW / months.length : plotW;
  const x = (i: number) => PAD.left + band * i + band / 2;
  const y = (v: number) => PAD.top + plotH - ((v - min) / span) * plotH;
  const every = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(plotW / 64))));

  const runs: { i: number; v: number }[][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1]!.i === i - 1) last.push({ i, v });
    else runs.push([{ i, v }]);
  });

  return (
    <figure className="uc-chart" aria-label={label} data-testid={testId}>
      <div ref={ref} className="uc-plot" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: o gráfico recebe foco para as setas mostrarem a dica de cada mês (a mesma do mouse).
          <svg width={width} height={HEIGHT} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="uc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="uc-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {axisMoney(tick)}
                </text>
              </g>
            ))}
            {months.map((month, i) =>
              i % every === 0 ? (
                <text key={month} className="uc-axis" x={x(i)} y={HEIGHT - 8} textAnchor="middle">
                  {formatMonth(month)}
                </text>
              ) : null,
            )}
            <line className="uc-baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
            {runs.map((run) => (
              <g key={run[0]!.i}>
                <path className="uc-line" d={run.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join('')} stroke={color} />
                {run.map((p) => (
                  <circle key={p.i} className="uc-dot" cx={x(p.i)} cy={y(p.v)} r={hover === p.i ? 5 : 3.5} fill={color} />
                ))}
              </g>
            ))}
            {hover !== null && <line className="uc-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />}
            {months.map((month, i) => (
              <rect
                key={month}
                className="uc-hit"
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH}
                onPointerEnter={() => setHover(i)}
                onPointerMove={() => setHover(i)}
              />
            ))}
          </svg>
        )}
        {hover !== null && months[hover] && (
          <Tooltip x={x(hover)} width={width}>
            <div className="uc-tip-head">{formatMonth(months[hover]!)}</div>
            <TipRow color={color} line label={label} value={values[hover] === null ? '—' : formatAccounting(values[hover]!)} />
          </Tooltip>
        )}
      </div>
    </figure>
  );
}

export type DonutSlice = { key: string; label: string; color: string; value: number };

/** Pizza em rosca com a legenda ao lado (valor e parte do total); fatias ≤ 0 não entram. */
export function Donut({ slices, label, testId }: { slices: DonutSlice[]; label: string; testId?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const visible = slices.filter((s) => s.value > 0);
  const total = visible.reduce((acc, s) => acc + s.value, 0);
  const size = 152;
  const r = 60;
  const stroke = 22;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const share = (value: number) => `${((value / (total || 1)) * 100).toFixed(1).replace('.', ',')}%`;
  const focused = visible.find((s) => s.key === hover);

  return (
    <figure className="acc-donut" aria-label={label} data-testid={testId}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {visible.map((s) => {
            const length = (s.value / total) * circumference;
            // 2 px de fundo entre as fatias (quando há mais de uma).
            const gap = visible.length > 1 ? Math.min(2, length / 2) : 0;
            const dash = `${Math.max(0, length - gap)} ${circumference}`;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={hover === s.key ? stroke + 4 : stroke}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                onPointerEnter={() => setHover(s.key)}
                onPointerLeave={() => setHover(null)}
              >
                <title>{`${s.label}: ${formatAccounting(s.value)} (${share(s.value)})`}</title>
              </circle>
            );
            offset += length;
            return el;
          })}
        </g>
        <text x={size / 2} y={size / 2 - 6} textAnchor="middle" className="acc-donut-k">
          {focused ? share(focused.value) : 'Total'}
        </text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" className="acc-donut-v">
          {compact.format((focused ? focused.value : total) / 100)}
        </text>
      </svg>
      <figcaption className="acc-donut-legend">
        {visible.map((s) => (
          <button
            key={s.key}
            type="button"
            className={hover === s.key ? 'is-hover' : undefined}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(s.key)}
            onBlur={() => setHover(null)}
          >
            <i style={{ background: s.color }} />
            <span className="acc-donut-name" title={s.label}>
              {s.label}
            </span>
            <span className="acc-donut-share">{share(s.value)}</span>
            <span className="acc-donut-value money">{formatAccounting(s.value)}</span>
          </button>
        ))}
      </figcaption>
    </figure>
  );
}
