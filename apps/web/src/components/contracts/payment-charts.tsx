import { t } from '@moneyflow/shared';
import { useState } from 'react';
import { Legend, niceTicks, TipRow, Tooltip, topRounded, useKeyboardIndex, useWidth } from '../admin-ai/usage-charts';

/*
 * Atraso ou adiantamento por parcela (spec 033), no mesmo SVG próprio do
 * painel de uso (classes uc-*): uma barra por parcela a partir da linha zero,
 * para cima o atraso e para baixo o adiantamento. Cores só por token: paga
 * com atraso --chart-2, no prazo ou adiantada --chart-3, em aberto e vencida
 * (o atraso até hoje) --danger, o tom de alerta.
 */

const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };
const MAX_BAR = 18;
const RADIUS = 3;

/** Retângulo para baixo da linha zero com só os cantos de baixo arredondados. */
function bottomRounded(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y}V${y + h - radius}Q${x},${y + h} ${x + radius},${y + h}H${x + w - radius}Q${x + w},${y + h} ${x + w},${y + h - radius}V${y}Z`;
}

export type DelayBar = { key: string; label: string; days: number; overdue: boolean; tip: string };

const P = t.contracts.payments;
const COLORS = { late: 'var(--chart-2)', onTime: 'var(--chart-3)', overdue: 'var(--danger)' };

export function DelayBars({ bars, label, testId }: { bars: DelayBar[]; label: string; testId?: string }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const onKey = useKeyboardIndex(bars.length, setHover);
  const up = niceTicks(Math.max(0, ...bars.map((b) => b.days)), 3);
  const down = niceTicks(Math.max(0, ...bars.map((b) => -b.days)), 3);
  const top = up[up.length - 1] || 0;
  const bottom = down[down.length - 1] || 0;
  const span = top + bottom || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = bars.length > 0 ? plotW / bars.length : plotW;
  const barW = Math.max(3, Math.min(MAX_BAR, band * 0.7));
  const y = (v: number) => PAD.top + ((top - v) / span) * plotH;
  const ticks = [...down.slice(1).map((v) => -v), ...up].sort((a, b) => a - b);
  const every = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plotW / 40))));
  const colorOf = (b: DelayBar) => (b.overdue ? COLORS.overdue : b.days > 0 ? COLORS.late : COLORS.onTime);

  return (
    <figure className="uc-chart" aria-label={label} data-testid={testId}>
      <div ref={ref} className="uc-plot" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: o gráfico recebe foco para as setas mostrarem a dica de cada parcela (a mesma do mouse).
          <svg width={width} height={HEIGHT} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="uc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="uc-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {tick}
                </text>
              </g>
            ))}
            {bars.map((bar, i) => {
              const cx = PAD.left + band * i + band / 2;
              const h = Math.abs(y(bar.days) - y(0));
              const x = cx - barW / 2;
              return (
                <g key={bar.key} className={hover === i ? 'uc-col is-hover' : 'uc-col'} data-days={bar.days} data-overdue={bar.overdue}>
                  {h > 0 &&
                    (bar.days > 0 ? (
                      <path d={topRounded(x, y(bar.days), barW, h, RADIUS)} fill={colorOf(bar)} />
                    ) : (
                      <path d={bottomRounded(x, y(0), barW, h, RADIUS)} fill={colorOf(bar)} />
                    ))}
                  {i % every === 0 && (
                    <text className="uc-axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                      {bar.label}
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
        {hover !== null && bars[hover] && (
          <Tooltip x={PAD.left + band * hover + band / 2} width={width}>
            <div className="uc-tip-head">{bars[hover]!.tip}</div>
            <TipRow color={colorOf(bars[hover]!)} label={P.delay} value={P.days(bars[hover]!.days)} />
          </Tooltip>
        )}
      </div>
      <Legend
        series={[
          { key: 'late', label: P.paidLate, color: COLORS.late },
          { key: 'onTime', label: P.paidOnTime, color: COLORS.onTime },
          { key: 'overdue', label: P.openOverdue, color: COLORS.overdue },
        ]}
      />
    </figure>
  );
}
