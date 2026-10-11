import { type AiUsageReport, formatMonth, t, type UsageTotals } from '@moneyflow/shared';
import { useState } from 'react';
import { formatCost, formatInt } from '../../agents/format';
import { withQuery } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { EmptyRow, Field } from '../ui';

const s = t.agentsUi.admin.usage;

function monthsAgo(n: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function Cost({ row }: { row: UsageTotals }) {
  return (
    <span>
      {row.costMicros !== null && row.currency ? formatCost(row.costMicros, row.currency) : '—'}
      {row.hasUnpriced && <span className="block text-[11px] text-faint">{t.agentsUi.usage.unpriced}</span>}
    </span>
  );
}

const monthLabel = (month: string) => (/^\d{4}-\d{2}$/.test(month) ? formatMonth(`${month}-01`) : month);

/** Uso de tokens e custo estimado por mês: por usuário e por agente/modelo (só medição, sem teto). */
export function UsageTab() {
  const [from, setFrom] = useState(monthsAgo(2));
  const [to, setTo] = useState(monthsAgo(0));
  const { data, error, reload } = useApi<AiUsageReport>(withQuery('/api/admin/ai/usage', { from, to }));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={s.from}>
          <input className="field" type="month" value={from} onChange={(e) => setFrom(e.target.value)} max={to} />
        </Field>
        <Field label={s.to}>
          <input className="field" type="month" value={to} onChange={(e) => setTo(e.target.value)} min={from} />
        </Field>
      </div>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="grid gap-6">
          <section>
            <h2 className="text-h3 mb-2">{s.byUser}</h2>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{s.month}</th>
                    <th>{s.user}</th>
                    <th className="num">{s.runs}</th>
                    <th className="num">{s.calls}</th>
                    <th className="num">{s.input}</th>
                    <th className="num">{s.output}</th>
                    <th className="num">{s.cache}</th>
                    <th className="num">{s.cost}</th>
                  </tr>
                </thead>
                <tbody>
                  {!data && <SkelRows cols={8} rows={3} />}
                  {data?.byUser.length === 0 && <EmptyRow colSpan={8}>{s.empty}</EmptyRow>}
                  {data?.byUser.map((row, index) => (
                    <tr key={`${row.month}-${row.userId}-${row.currency}-${index}`}>
                      <td className="mono text-xs">{monthLabel(row.month)}</td>
                      <td>{row.username ? `@${row.username}` : s.unknownUser}</td>
                      <td className="num mono text-xs">{formatInt(row.runs)}</td>
                      <td className="num mono text-xs">{formatInt(row.calls)}</td>
                      <td className="num mono text-xs">{formatInt(row.inputTokens)}</td>
                      <td className="num mono text-xs">{formatInt(row.outputTokens)}</td>
                      <td className="num mono text-xs">
                        {formatInt(row.cacheWriteTokens)} / {formatInt(row.cacheReadTokens)}
                      </td>
                      <td className="num mono text-xs">
                        <Cost row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2 className="text-h3 mb-2">{s.byAgent}</h2>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{s.month}</th>
                    <th>{s.agent}</th>
                    <th>{s.model}</th>
                    <th className="num">{s.runs}</th>
                    <th className="num">{s.users}</th>
                    <th className="num">{s.input}</th>
                    <th className="num">{s.output}</th>
                    <th className="num">{s.cache}</th>
                    <th className="num">{s.cost}</th>
                  </tr>
                </thead>
                <tbody>
                  {!data && <SkelRows cols={9} rows={3} />}
                  {data?.byAgent.length === 0 && <EmptyRow colSpan={9}>{s.empty}</EmptyRow>}
                  {data?.byAgent.map((row, index) => (
                    <tr key={`${row.month}-${row.agentId}-${row.model}-${row.currency}-${index}`}>
                      <td className="mono text-xs">{monthLabel(row.month)}</td>
                      <td>{row.agentName ?? s.unknownAgent}</td>
                      <td className="mono text-xs">{row.model}</td>
                      <td className="num mono text-xs">{formatInt(row.runs)}</td>
                      <td className="num mono text-xs">{formatInt(row.users)}</td>
                      <td className="num mono text-xs">{formatInt(row.inputTokens)}</td>
                      <td className="num mono text-xs">{formatInt(row.outputTokens)}</td>
                      <td className="num mono text-xs">
                        {formatInt(row.cacheWriteTokens)} / {formatInt(row.cacheReadTokens)}
                      </td>
                      <td className="num mono text-xs">
                        <Cost row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
