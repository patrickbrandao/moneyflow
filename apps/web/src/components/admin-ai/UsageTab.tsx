import {
  AI_USAGE_PURPOSES,
  type AiAgentDto,
  type AiBudgetCurrency,
  type AiProviderDto,
  type AiUsagePanel,
  addDays,
  cacheHitRate,
  type ExportTable,
  formatDateTime,
  formatMicros,
  t,
  todayIso,
  type UserRow,
} from '@moneyflow/shared';
import { MessageSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAgents } from '../../agents/AgentsProvider';
import { formatInt } from '../../agents/format';
import { withQuery } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { ExportMenu } from '../ExportMenu';
import { EmptyRow, Field, Panel } from '../ui';
import { BudgetsSection, RateLimitsPanel } from './UsageBudgets';
import { type ChartSeries, PercentLine, StackedColumns } from './usage-charts';

const s = t.agentsUi.admin.usage;

/** Cores das séries em ordem fixa (dataviz); a 6ª posição em diante vira "Outros". */
const SERIES_COLORS = [1, 2, 3, 4, 5].map((n) => `var(--chart-${n})`);
const OTHER_COLOR = 'var(--chart-other)';

type Period = 'month' | 'last30' | 'range';
type Filters = { period: Period; from: string; to: string; providerId: string; agentId: string; userId: string; purpose: string };

function periodRange(f: Filters): { from: string; to: string } {
  const today = todayIso();
  if (f.period === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (f.period === 'last30') return { from: addDays(today, -29), to: today };
  return { from: f.from || today, to: f.to || today };
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 400; day = addDays(day, 1)) out.push(day);
  return out;
}

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const percent = (v: number | null) => (v === null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const costText = (micros: number | null, currency: AiBudgetCurrency | null) =>
  micros === null || currency === null ? t.agentsUi.usage.unpriced : formatMicros(micros, currency);
const decimal = (micros: number | null) => (micros === null ? null : (micros / 1_000_000).toFixed(6));

/** Guia Uso de /admin/ai (spec 028): filtros, totais, gráficos por dia, tabelas com CSV, orçamentos e o limite por minuto. */
export function UsageTab() {
  const [filters, setFilters] = useState<Filters>({
    period: 'month',
    from: '',
    to: '',
    providerId: '',
    agentId: '',
    userId: '',
    purpose: '',
  });
  const range = periodRange(filters);
  const query = { ...range, providerId: filters.providerId, agentId: filters.agentId, userId: filters.userId, purpose: filters.purpose };
  const panel = useApi<AiUsagePanel>(
    withQuery('/api/admin/ai/usage/panel', Object.fromEntries(Object.entries(query).filter(([, v]) => v))),
  );
  const providers = useApi<AiProviderDto[]>('/api/admin/ai/providers');
  const agents = useApi<AiAgentDto[]>('/api/admin/ai/agents');
  const users = useApi<UserRow[]>('/api/users');
  const set = (key: keyof Filters) => (event: { target: { value: string } }) => setFilters((f) => ({ ...f, [key]: event.target.value }));

  return (
    <div className="usage-stack" data-testid="usage-tab">
      <div className="usage-filters" data-testid="usage-filters">
        <Field label={s.period}>
          <select className="field" value={filters.period} onChange={set('period')} data-testid="usage-period">
            {(['month', 'last30', 'range'] as const).map((p) => (
              <option key={p} value={p}>
                {s.periods[p]}
              </option>
            ))}
          </select>
        </Field>
        {filters.period === 'range' && (
          <>
            <Field label={s.start}>
              <input className="field" type="date" value={range.from} onChange={set('from')} max={range.to} />
            </Field>
            <Field label={s.end}>
              <input className="field" type="date" value={range.to} onChange={set('to')} min={range.from} />
            </Field>
          </>
        )}
        <Field label={s.provider}>
          <select className="field" value={filters.providerId} onChange={set('providerId')}>
            <option value="">{s.all}</option>
            {providers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.agent}>
          <select className="field" value={filters.agentId} onChange={set('agentId')}>
            <option value="">{s.all}</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.user}>
          <select className="field" value={filters.userId} onChange={set('userId')}>
            <option value="">{s.all}</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.purpose}>
          <select className="field" value={filters.purpose} onChange={set('purpose')}>
            <option value="">{s.all}</option>
            {AI_USAGE_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {s.purposes[p] ?? p}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {panel.error ? (
        <LoadError error={panel.error} onRetry={() => void panel.reload()} />
      ) : (
        <div className="usage-stack" style={{ opacity: panel.loading && panel.data ? 0.6 : 1 }}>
          <PanelBody data={panel.data} range={range} providers={providers.data ?? []} agents={agents.data ?? []} />
        </div>
      )}

      <BudgetsSection />
      <RateLimitsPanel />
    </div>
  );
}

function PanelBody({
  data,
  range,
  providers,
  agents,
}: {
  data: AiUsagePanel | undefined;
  range: { from: string; to: string };
  providers: AiProviderDto[];
  agents: AiAgentDto[];
}) {
  const [stackBy, setStackBy] = useState<'provider' | 'agent'>('provider');
  const days = useMemo(() => daysBetween(range.from, range.to), [range.from, range.to]);
  const currencies = useMemo(() => {
    const totals = new Map<AiBudgetCurrency, number>();
    for (const row of data?.daily ?? [])
      if (row.currency) totals.set(row.currency, (totals.get(row.currency) ?? 0) + (row.costMicros ?? 0));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);
  const [pickedCurrency, setCurrency] = useState<AiBudgetCurrency | ''>('');
  const currency: AiBudgetCurrency = (pickedCurrency || currencies[0]?.[0]) ?? 'USD';

  const totals = useMemo(() => {
    const out = { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, unpriced: 0 };
    for (const row of data?.daily ?? []) {
      out.calls += row.calls;
      out.input += row.inputTokens;
      out.output += row.outputTokens;
      out.cacheWrite += row.cacheWriteTokens;
      out.cacheRead += row.cacheReadTokens;
      if (row.currency === null) out.unpriced += row.calls;
    }
    return out;
  }, [data]);

  const costSeries = useMemo((): ChartSeries[] => {
    const index = new Map(days.map((d, i) => [d, i]));
    const byKey = new Map<string, { label: string; values: number[]; total: number }>();
    for (const row of data?.daily ?? []) {
      if (row.currency !== currency || row.costMicros === null) continue;
      const key = (stackBy === 'provider' ? row.providerId : row.agentId) ?? '';
      const label = (stackBy === 'provider' ? row.providerName : row.agentName) ?? (stackBy === 'provider' ? s.noProvider : s.noAgent);
      const entry = byKey.get(key) ?? { label, values: days.map(() => 0), total: 0 };
      const i = index.get(row.day);
      if (i !== undefined) entry.values[i]! += row.costMicros;
      entry.total += row.costMicros;
      byKey.set(key, entry);
    }
    // Os 5 de maior custo viram séries; a cor segue a ordem estável do cadastro (não o ranking), o resto vai para "Outros".
    const stable = (stackBy === 'provider' ? providers : agents).map((x) => x.id);
    const order = (key: string) => {
      const i = stable.indexOf(key);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ranked = [...byKey.entries()].sort((a, b) => b[1].total - a[1].total);
    const shown = ranked.slice(0, SERIES_COLORS.length).sort((a, b) => order(a[0]) - order(b[0]) || a[1].label.localeCompare(b[1].label));
    const rest = ranked.slice(SERIES_COLORS.length);
    const series: ChartSeries[] = shown.map(([key, v], i) => ({
      key: key || 'none',
      label: v.label,
      color: SERIES_COLORS[i]!,
      values: v.values,
    }));
    if (rest.length > 0) {
      series.push({
        key: 'others',
        label: s.others,
        color: OTHER_COLOR,
        values: days.map((_, i) => rest.reduce((acc, [, v]) => acc + v.values[i]!, 0)),
      });
    }
    return series;
  }, [data, days, currency, stackBy, providers, agents]);

  const tokenSeries = useMemo((): ChartSeries[] => {
    const index = new Map(days.map((d, i) => [d, i]));
    const keys = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;
    const values = Object.fromEntries(keys.map((k) => [k, days.map(() => 0)])) as Record<(typeof keys)[number], number[]>;
    for (const row of data?.daily ?? []) {
      const i = index.get(row.day);
      if (i === undefined) continue;
      values.input[i]! += row.inputTokens;
      values.output[i]! += row.outputTokens;
      values.cacheWrite[i]! += row.cacheWriteTokens;
      values.cacheRead[i]! += row.cacheReadTokens;
    }
    return keys.map((k, i) => ({ key: k, label: s.series[k]!, color: SERIES_COLORS[i]!, values: values[k] }));
  }, [data, days]);

  const cacheValues = useMemo(
    () =>
      days.map((_, i) =>
        cacheHitRate({
          inputTokens: tokenSeries[0]!.values[i]!,
          cacheWriteTokens: tokenSeries[2]!.values[i]!,
          cacheReadTokens: tokenSeries[3]!.values[i]!,
        }),
      ),
    [days, tokenSeries],
  );

  const costTotals = currencies.map(([c, v]) => formatMicros(v, c)).join(' · ') || '—';
  const period = `${range.from} – ${range.to}`;

  return (
    <>
      <div className="usage-tiles" data-testid="usage-tiles">
        <div className="usage-tile">
          <div className="label">{s.totalCost}</div>
          <div className="value" data-testid="usage-total-cost">
            {data ? costTotals : '…'}
          </div>
          {totals.unpriced > 0 && <div className="sub">{s.unpricedCalls(totals.unpriced)}</div>}
        </div>
        <div className="usage-tile">
          <div className="label">{s.totalCalls}</div>
          <div className="value">{data ? formatInt(totals.calls) : '…'}</div>
        </div>
        <div className="usage-tile">
          <div className="label">{s.totalTokens}</div>
          <div className="value">{data ? compact.format(totals.input + totals.output + totals.cacheWrite + totals.cacheRead) : '…'}</div>
          <div className="sub">
            {t.agentsUi.usage.tokens(compact.format(totals.input + totals.cacheWrite + totals.cacheRead), compact.format(totals.output))}
          </div>
        </div>
        <div className="usage-tile" title={s.cacheRateHint}>
          <div className="label">{s.cacheRate}</div>
          <div className="value">
            {data
              ? percent(cacheHitRate({ inputTokens: totals.input, cacheWriteTokens: totals.cacheWrite, cacheReadTokens: totals.cacheRead }))
              : '…'}
          </div>
          <div className="sub">{s.cacheRateHint}</div>
        </div>
      </div>

      <div className="usage-charts">
        <Panel>
          <div className="usage-chart-head">
            <h3>{s.costByDay}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="field"
                aria-label={s.stackBy}
                value={stackBy}
                onChange={(e) => setStackBy(e.target.value as 'provider' | 'agent')}
                data-testid="usage-stack-by"
              >
                <option value="provider">
                  {s.stackBy}: {s.stackProvider}
                </option>
                <option value="agent">
                  {s.stackBy}: {s.stackAgent}
                </option>
              </select>
              {currencies.length > 1 && (
                <select
                  className="field"
                  aria-label={s.currency}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as AiBudgetCurrency)}
                >
                  {currencies.map(([c]) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          {costSeries.length === 0 ? (
            <p className="panel-hint">{s.chartEmpty}</p>
          ) : (
            <StackedColumns
              days={days}
              series={costSeries}
              format={(v) => formatMicros(v, currency)}
              axisFormat={(v) => formatMicros(v, currency).replace(/,00$/, '')}
              label={`${s.costByDay} (${currency})`}
              totalLabel={s.chartTotal}
              testId="usage-cost-chart"
            />
          )}
        </Panel>
        <Panel>
          <div className="usage-chart-head">
            <h3>{s.tokensByDay}</h3>
          </div>
          <StackedColumns
            days={days}
            series={tokenSeries}
            format={(v) => formatInt(v)}
            axisFormat={(v) => compact.format(v)}
            label={s.tokensByDay}
            totalLabel={s.chartTotal}
            testId="usage-tokens-chart"
          />
        </Panel>
        <Panel>
          <div className="usage-chart-head">
            <h3>{s.cacheByDay}</h3>
          </div>
          <PercentLine days={days} values={cacheValues} label={s.cacheRate} color="var(--chart-1)" testId="usage-cache-chart" />
          <p className="hint">{s.cacheRateHint}</p>
        </Panel>
      </div>

      <TopSessions data={data} period={period} />
      <ByModel data={data} period={period} />
      <ByPurpose data={data} period={period} />
    </>
  );
}

function SectionHead({ title, hint, build }: { title: string; hint?: string; build: (() => ExportTable) | null }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-h3">{title}</h2>
        {hint && <p className="panel-hint">{hint}</p>}
      </div>
      <ExportMenu build={build ?? (() => Promise.reject(new Error(t.errors.generic)))} disabled={!build} />
    </div>
  );
}

function TopSessions({ data, period }: { data: AiUsagePanel | undefined; period: string }) {
  const agents = useAgents();
  const rows = data?.topConversations ?? [];
  const build = (): ExportTable => ({
    fileName: s.csvFile('sessoes'),
    title: s.topSessions,
    subtitle: [period],
    columns: [
      { key: 'rank', label: s.rank, type: 'int' },
      { key: 'title', label: s.session },
      { key: 'user', label: s.user },
      { key: 'agent', label: s.agent },
      { key: 'purpose', label: s.purpose },
      { key: 'currency', label: s.currency },
      { key: 'cost', label: s.cost },
      { key: 'calls', label: s.calls, type: 'int' },
      { key: 'input', label: s.input, type: 'int' },
      { key: 'output', label: s.output, type: 'int' },
      { key: 'lastUsed', label: s.lastUsed },
    ],
    rows: rows.map((r) => ({
      rank: r.rank,
      title: r.title ?? s.untitled,
      user: r.username ? `@${r.username}` : '',
      agent: r.agentName ?? '',
      purpose: s.purposes[r.purpose] ?? r.purpose,
      currency: r.currency,
      cost: decimal(r.costMicros),
      calls: r.calls,
      input: r.inputTokens + r.cacheWriteTokens + r.cacheReadTokens,
      output: r.outputTokens,
      lastUsed: r.lastUsedAt ? formatDateTime(r.lastUsedAt) : '',
    })),
  });
  return (
    <section data-testid="usage-top-sessions">
      <SectionHead title={s.topSessions} hint={s.topHint} build={data ? build : null} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="num">{s.rank}</th>
              <th>{s.session}</th>
              <th>{s.user}</th>
              <th>{s.agent}</th>
              <th>{s.purpose}</th>
              <th className="num">{s.calls}</th>
              <th className="num">{s.tokensCol}</th>
              <th className="num">{s.cost}</th>
              <th>{s.lastUsed}</th>
            </tr>
          </thead>
          <tbody>
            {!data && <SkelRows cols={9} rows={3} />}
            {data && rows.length === 0 && <EmptyRow colSpan={9}>{s.empty}</EmptyRow>}
            {rows.map((r) => (
              <tr key={`${r.currency}-${r.conversationId}`}>
                <td className="num mono text-xs">{r.rank}</td>
                <td>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void agents.openById(r.conversationId).catch(() => undefined)}
                    data-testid="usage-open-session"
                  >
                    <MessageSquare size={12} /> {r.title ?? s.untitled}
                  </button>
                </td>
                <td>{r.username ? `@${r.username}` : s.unknownUser}</td>
                <td>{r.agentName ?? s.unknownAgent}</td>
                <td>{s.purposes[r.purpose] ?? r.purpose}</td>
                <td className="num mono text-xs">{formatInt(r.calls)}</td>
                <td className="num mono text-xs">
                  {compact.format(r.inputTokens + r.cacheWriteTokens + r.cacheReadTokens)} / {compact.format(r.outputTokens)}
                </td>
                <td className="num mono text-xs">
                  {formatMicros(r.costMicros, r.currency)}
                  {r.unpricedCalls > 0 && <span className="block text-[11px] text-faint">{s.unpricedCalls(r.unpricedCalls)}</span>}
                </td>
                <td className="mono text-xs">{r.lastUsedAt ? formatDateTime(r.lastUsedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ByModel({ data, period }: { data: AiUsagePanel | undefined; period: string }) {
  const rows = data?.byModel ?? [];
  const build = (): ExportTable => ({
    fileName: s.csvFile('modelos'),
    title: s.byModel,
    subtitle: [period],
    columns: [
      { key: 'provider', label: s.provider },
      { key: 'model', label: s.model },
      { key: 'calls', label: s.calls, type: 'int' },
      { key: 'input', label: s.input, type: 'int' },
      { key: 'output', label: s.output, type: 'int' },
      { key: 'cacheWrite', label: s.series.cacheWrite!, type: 'int' },
      { key: 'cacheRead', label: s.series.cacheRead!, type: 'int' },
      { key: 'currency', label: s.currency },
      { key: 'cost', label: s.cost },
      { key: 'requests', label: s.requests, type: 'int' },
      { key: 'p50', label: `${s.p50} (ms)`, type: 'int' },
      { key: 'p95', label: `${s.p95} (ms)`, type: 'int' },
      { key: 'errorRate', label: s.errorRate, type: 'percent' },
    ],
    rows: rows.map((r) => ({
      provider: r.providerName ?? '',
      model: r.model,
      calls: r.calls,
      input: r.inputTokens,
      output: r.outputTokens,
      cacheWrite: r.cacheWriteTokens,
      cacheRead: r.cacheReadTokens,
      currency: r.currency ?? '',
      cost: decimal(r.costMicros),
      requests: r.health?.requests ?? null,
      p50: r.health?.p50Ms ?? null,
      p95: r.health?.p95Ms ?? null,
      errorRate: r.health?.errorRate === null || r.health?.errorRate === undefined ? null : r.health.errorRate * 100,
    })),
  });
  return (
    <section data-testid="usage-by-model">
      <SectionHead title={s.byModel} hint={data ? s.healthHint(data.healthDays) : undefined} build={data ? build : null} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{s.provider}</th>
              <th>{s.model}</th>
              <th className="num">{s.calls}</th>
              <th className="num">{s.tokensCol}</th>
              <th className="num">{s.cache}</th>
              <th className="num">{s.cost}</th>
              <th className="num">{s.requests}</th>
              <th className="num">{s.p50}</th>
              <th className="num">{s.p95}</th>
              <th className="num">{s.errorRate}</th>
            </tr>
          </thead>
          <tbody>
            {!data && <SkelRows cols={10} rows={3} />}
            {data && rows.length === 0 && <EmptyRow colSpan={10}>{s.empty}</EmptyRow>}
            {rows.map((r) => (
              <tr key={`${r.providerId}-${r.model}-${r.currency}`}>
                <td>{r.providerName ?? s.noProvider}</td>
                <td className="mono text-xs">{r.model}</td>
                <td className="num mono text-xs">{formatInt(r.calls)}</td>
                <td className="num mono text-xs">
                  {compact.format(r.inputTokens)} / {compact.format(r.outputTokens)}
                </td>
                <td className="num mono text-xs">
                  {compact.format(r.cacheWriteTokens)} / {compact.format(r.cacheReadTokens)}
                </td>
                <td className="num mono text-xs">{costText(r.costMicros, r.currency)}</td>
                <td className="num mono text-xs">{r.health ? formatInt(r.health.requests) : '—'}</td>
                <td className="num mono text-xs">{r.health?.p50Ms != null ? `${formatInt(r.health.p50Ms)} ms` : '—'}</td>
                <td className="num mono text-xs">{r.health?.p95Ms != null ? `${formatInt(r.health.p95Ms)} ms` : '—'}</td>
                <td className="num mono text-xs">{percent(r.health?.errorRate ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ByPurpose({ data, period }: { data: AiUsagePanel | undefined; period: string }) {
  const rows = data?.byPurpose ?? [];
  const build = (): ExportTable => ({
    fileName: s.csvFile('finalidades'),
    title: s.byPurpose,
    subtitle: [period],
    columns: [
      { key: 'purpose', label: s.purpose },
      { key: 'runs', label: s.runs, type: 'int' },
      { key: 'users', label: s.users, type: 'int' },
      { key: 'calls', label: s.calls, type: 'int' },
      { key: 'input', label: s.input, type: 'int' },
      { key: 'output', label: s.output, type: 'int' },
      { key: 'currency', label: s.currency },
      { key: 'cost', label: s.cost },
    ],
    rows: rows.map((r) => ({
      purpose: s.purposes[r.purpose] ?? r.purpose,
      runs: r.runs,
      users: r.users,
      calls: r.calls,
      input: r.inputTokens + r.cacheWriteTokens + r.cacheReadTokens,
      output: r.outputTokens,
      currency: r.currency ?? '',
      cost: decimal(r.costMicros),
    })),
  });
  return (
    <section data-testid="usage-by-purpose">
      <SectionHead title={s.byPurpose} build={data ? build : null} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{s.purpose}</th>
              <th className="num">{s.runs}</th>
              <th className="num">{s.users}</th>
              <th className="num">{s.calls}</th>
              <th className="num">{s.tokensCol}</th>
              <th className="num">{s.cost}</th>
            </tr>
          </thead>
          <tbody>
            {!data && <SkelRows cols={6} rows={3} />}
            {data && rows.length === 0 && <EmptyRow colSpan={6}>{s.empty}</EmptyRow>}
            {rows.map((r) => (
              <tr key={`${r.purpose}-${r.currency}`}>
                <td>{s.purposes[r.purpose] ?? r.purpose}</td>
                <td className="num mono text-xs">{formatInt(r.runs)}</td>
                <td className="num mono text-xs">{formatInt(r.users)}</td>
                <td className="num mono text-xs">{formatInt(r.calls)}</td>
                <td className="num mono text-xs">
                  {compact.format(r.inputTokens + r.cacheWriteTokens + r.cacheReadTokens)} / {compact.format(r.outputTokens)}
                </td>
                <td className="num mono text-xs">{costText(r.costMicros, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
