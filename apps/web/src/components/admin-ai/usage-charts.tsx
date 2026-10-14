import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';

/*
 * Gráficos do painel de uso (spec 028), em SVG próprio (sem biblioteca),
 * seguindo o dataviz: colunas finas (≤ 24 px) com o topo arredondado (4 px) e
 * a base reta, 2 px de fundo entre os segmentos, linha de 2 px com marcador
 * de 8 px e anel da cor do fundo, grade de 1 px recessiva, uma escala só,
 * legenda para 2+ séries e dica (tooltip) no passar do mouse e no teclado
 * (setas). Cores só por token: as séries usam --chart-N (ordem fixa) e
 * "Outros" o neutro --chart-other. Os valores também estão nas tabelas e no CSV.
 */

export type ChartSeries = { key: string; label: string; color: string; values: number[] };

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 64 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** Largura do contêiner (o SVG desenha em pixels reais: texto nítido e colunas de largura fixa). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Marcas "redondas" do eixo: 0, 1, 2, 5 × 10ⁿ. */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** "2026-10-14" → "14/10". */
export const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Retângulo com só os cantos de cima arredondados (a base fica reta na linha zero). */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  // À direita do ponto; perto da borda, vira para a esquerda (não cobre a coluna em destaque).
  const left = x + 12 + 220 <= width ? x + 12 : Math.max(8, x - 12 - 220);
  return (
    <div className="uc-tip" style={{ left }} role="status">
      {children}
    </div>
  );
}

function TipRow({ color, label, value, line }: { color: string; label: string; value: string; line?: boolean }) {
  return (
    <div className="uc-tip-row">
      <i className={line ? 'line' : undefined} style={{ background: color }} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Legend({ series, line }: { series: Pick<ChartSeries, 'key' | 'label' | 'color'>[]; line?: boolean }) {
  return (
    <figcaption className="uc-legend">
      {series.map((s) => (
        <span key={s.key}>
          <i className={line ? 'line' : undefined} style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </figcaption>
  );
}

/** Teclado: setas movem o dia em destaque (a mesma dica do mouse). */
function useKeyboardIndex(count: number, setIndex: (update: (i: number | null) => number | null) => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') setIndex((i) => Math.min(count - 1, (i ?? -1) + 1));
    else if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, (i ?? count) - 1));
    else if (event.key === 'Escape') setIndex(() => null);
    else return;
    event.preventDefault();
  };
}

/** Colunas empilhadas por dia (custo ou tokens). */
export function StackedColumns({
  days,
  series,
  format,
  axisFormat,
  label,
  totalLabel,
  testId,
}: {
  days: string[];
  series: ChartSeries[];
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  label: string;
  totalLabel: string;
  testId?: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const onKey = useKeyboardIndex(days.length, setHover);
  const totals = days.map((_, i) => series.reduce((acc, s) => acc + Math.max(0, s.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = days.length > 0 ? plotW / days.length : plotW;
  const barW = Math.max(2, Math.min(MAX_BAR, band - GAP));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 56))));

  return (
    <figure className="uc-chart" aria-label={label} data-testid={testId}>
      <div ref={ref} className="uc-plot" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: o gráfico recebe foco para as setas mostrarem a dica de cada dia (a mesma do mouse).
          <svg width={width} height={HEIGHT} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="uc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="uc-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {(axisFormat ?? format)(tick)}
                </text>
              </g>
            ))}
            {days.map((day, i) => {
              const cx = PAD.left + band * i + band / 2;
              let base = y(0);
              const visible = series.filter((s) => (s.values[i] ?? 0) > 0);
              return (
                <g key={day} className={hover === i ? 'uc-col is-hover' : 'uc-col'}>
                  {visible.map((s, k) => {
                    const h = ((s.values[i] ?? 0) / top) * plotH;
                    const gap = k > 0 && h > GAP ? GAP : 0;
                    const yTop = base - h;
                    const segment =
                      k === visible.length - 1 ? (
                        <path key={s.key} d={topRounded(cx - barW / 2, yTop, barW, h - gap, RADIUS)} fill={s.color} />
                      ) : (
                        <rect key={s.key} x={cx - barW / 2} y={yTop} width={barW} height={Math.max(0, h - gap)} fill={s.color} />
                      );
                    base = yTop;
                    return segment;
                  })}
                  {i % every === 0 && (
                    <text className="uc-axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                      {dayLabel(day)}
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
        {hover !== null && days[hover] && (
          <Tooltip x={PAD.left + band * hover + band / 2} width={width}>
            <div className="uc-tip-head">{dayLabel(days[hover]!)}</div>
            <TipRow color="transparent" label={totalLabel} value={format(totals[hover]!)} />
            {series
              .filter((s) => (s.values[hover] ?? 0) > 0)
              .map((s) => (
                <TipRow key={s.key} color={s.color} label={s.label} value={format(s.values[hover]!)} />
              ))}
          </Tooltip>
        )}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </figure>
  );
}

/** Uma série por dia em linha (0–100%), com lacunas onde não há valor. */
export function PercentLine({
  days,
  values,
  label,
  color,
  testId,
}: {
  days: string[];
  values: (number | null)[];
  label: string;
  color: string;
  testId?: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const onKey = useKeyboardIndex(days.length, setHover);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = days.length > 1 ? plotW / (days.length - 1) : 0;
  const x = (i: number) => PAD.left + (days.length > 1 ? step * i : plotW / 2);
  const y = (v: number) => PAD.top + plotH - v * plotH;
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 56))));
  const pct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

  // Trechos contínuos (sem os dias sem entrada).
  const runs: { i: number; v: number }[][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1]!.i === i - 1) last.push({ i, v });
    else runs.push([{ i, v }]);
  });

  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    setHover(days.length > 1 ? Math.min(days.length - 1, Math.max(0, Math.round(px / step))) : 0);
  };

  return (
    <figure className="uc-chart" aria-label={label} data-testid={testId}>
      <div ref={ref} className="uc-plot" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: o gráfico recebe foco para as setas mostrarem a dica de cada dia (a mesma do mouse).
          <svg width={width} height={HEIGHT} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
              <g key={tick}>
                <line className="uc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="uc-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {pct(tick)}
                </text>
              </g>
            ))}
            {days.map((day, i) =>
              i % every === 0 ? (
                <text key={day} className="uc-axis" x={x(i)} y={HEIGHT - 8} textAnchor="middle">
                  {dayLabel(day)}
                </text>
              ) : null,
            )}
            {runs.map((run) => (
              <g key={run[0]!.i}>
                {run.length > 1 && (
                  <path
                    className="uc-area"
                    d={`M${x(run[0]!.i)},${y(0)}${run.map((p) => `L${x(p.i)},${y(p.v)}`).join('')}L${x(run[run.length - 1]!.i)},${y(0)}Z`}
                    fill={color}
                  />
                )}
                <path className="uc-line" d={run.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join('')} stroke={color} />
                {run.length === 1 && <circle className="uc-dot" cx={x(run[0]!.i)} cy={y(run[0]!.v)} r={4} fill={color} />}
              </g>
            ))}
            {hover !== null && (
              <>
                <line className="uc-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
                {values[hover] !== null && values[hover] !== undefined && (
                  <circle className="uc-dot" cx={x(hover)} cy={y(values[hover]!)} r={4} fill={color} />
                )}
              </>
            )}
            <line className="uc-baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
            <rect className="uc-hit" x={PAD.left} y={PAD.top} width={plotW} height={plotH} onPointerMove={onMove} onPointerEnter={onMove} />
          </svg>
        )}
        {hover !== null && days[hover] && (
          <Tooltip x={x(hover)} width={width}>
            <div className="uc-tip-head">{dayLabel(days[hover]!)}</div>
            <TipRow color={color} line label={label} value={values[hover] === null ? '—' : pct(values[hover]!)} />
          </Tooltip>
        )}
      </div>
    </figure>
  );
}
