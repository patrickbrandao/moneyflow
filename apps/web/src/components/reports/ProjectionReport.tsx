import {
  formatAccounting,
  formatDate,
  PROJECTION_METRICS,
  type ProjectionLine,
  type ProjectionReportData,
  projectionValue,
  t,
} from '@moneyflow/shared';
import { Landmark, Wallet } from 'lucide-react';
import { Fragment } from 'react';
import { cx, EmptyState } from '../ui';

type CaixaBlock = { caixaId: string; caixaName: string; rows: ProjectionLine[]; accounts: Map<string, ProjectionLine[]> };

function blocks(data: ProjectionReportData): CaixaBlock[] {
  const map = new Map<string, CaixaBlock>();
  for (const line of data.lines) {
    let block = map.get(line.caixaId);
    if (!block) {
      block = { caixaId: line.caixaId, caixaName: line.caixaName, rows: [], accounts: new Map() };
      map.set(line.caixaId, block);
    }
    if (line.financialAccountId)
      block.accounts.set(line.financialAccountId, [...(block.accounts.get(line.financialAccountId) ?? []), line]);
    else block.rows.push(line);
  }
  return [...map.values()];
}

/** Fluxo de caixa projetado: por caixa, as colunas são os horizontes (30/60/90 dias). */
export function ProjectionReport({ data }: { data: ProjectionReportData }) {
  const list = blocks(data);
  if (list.length === 0) return <EmptyState icon={<Wallet />} title={t.reports.empty} />;
  const at = (rows: ProjectionLine[], horizon: number) => rows.find((r) => r.horizonDays === horizon);

  return (
    <div className="grid gap-4">
      <p className="panel-hint">{t.reports.projectionSub}</p>
      {list.map((block) => (
        <div key={block.caixaId} className="table-wrap report-table">
          <table className="data">
            <thead>
              <tr>
                <th>
                  <span className="inline-flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-faint" /> {block.caixaName}
                  </span>
                </th>
                {data.horizons.map((h) => (
                  <th key={h} className="num">
                    {t.reports.horizon(h)}
                    <span className="block text-[11px] font-normal text-faint">
                      {t.reports.until} {formatDate(at(block.rows, h)?.until ?? '')}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROJECTION_METRICS.map((m) => (
                <tr key={m.key} className={cx(m.bold && 'report-total')}>
                  <td>{m.label}</td>
                  {data.horizons.map((h) => {
                    // saída (sign −1) vem positiva da API e aparece negativa, entre parênteses
                    const value = projectionValue(at(block.rows, h), m);
                    return (
                      <td key={h} className={cx('num money', value === 0 && !m.bold && 'muted', value < 0 && 'neg')}>
                        {formatAccounting(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {[...block.accounts.entries()].map(([accountId, rows]) => (
                <Fragment key={accountId}>
                  <tr className="report-child">
                    <td>
                      <span className="inline-flex items-center gap-2 pl-4 text-muted" title={t.reports.accountsOnlyRealized}>
                        <Landmark className="h-3.5 w-3.5" /> {rows[0]?.accountName}
                      </span>
                    </td>
                    {data.horizons.map((h) => {
                      const value = Number(at(rows, h)?.projectedCents ?? 0);
                      return (
                        <td key={h} className={cx('num money', value < 0 ? 'neg' : 'muted')}>
                          {formatAccounting(value)}
                        </td>
                      );
                    })}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
