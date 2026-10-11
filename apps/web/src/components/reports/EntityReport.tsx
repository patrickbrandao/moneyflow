import {
  buildEntityRows,
  type EntityReportData,
  type EntityRow,
  type ExportTable,
  entityLink,
  exportFileName,
  formatBRL,
  t,
} from '@moneyflow/shared';
import { ArrowRight, Building2, ChevronDown, ChevronRight, CreditCard } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, cx, EmptyState } from '../ui';

/** Totais por entidade, com o rastreio caixa pagadora → cartão → recebedor final. */
export function EntityReport({ data, scope }: { data: EntityReportData; scope: string | null }) {
  const rows = useMemo(() => buildEntityRows(data.lines, { caixaId: scope }), [data, scope]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (rows.length === 0) return <EmptyState icon={<Building2 />} title={t.reports.empty} />;
  const totals = rows.reduce((acc, r) => ({ out: acc.out + r.outflowCents, in: acc.in + r.inflowCents }), { out: 0, in: 0 });

  return (
    <div className="grid gap-3">
      <p className="panel-hint">{t.reports.entitiesSub}</p>
      <div className="table-wrap report-table">
        <table className="data">
          <thead>
            <tr>
              <th>{t.reports.entity}</th>
              <th className="num">{t.reports.outflow}</th>
              <th className="num">{t.reports.inflow}</th>
              <th className="num">{t.reports.net}</th>
              <th className="num">{t.reports.entries}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.entityId}>
                <tr className="report-group cursor-pointer" onClick={() => toggle(row.entityId)}>
                  <td>
                    <span className="inline-flex items-center gap-1">
                      <span className="report-caret">{open.has(row.entityId) ? <ChevronDown /> : <ChevronRight />}</span>
                      <Link to={entityLink(row.entityId)} onClick={(e) => e.stopPropagation()} className="hover:underline">
                        {row.entityName}
                      </Link>
                      {row.trail.some((x) => x.cardCaixaId) && (
                        <Badge tone="outline">
                          <CreditCard className="h-3 w-3" />
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className={cx('num money', row.outflowCents === 0 && 'muted')}>{formatBRL(row.outflowCents)}</td>
                  <td className={cx('num money', row.inflowCents === 0 && 'muted')}>{formatBRL(row.inflowCents)}</td>
                  <td className={cx('num money', row.netCents > 0 ? 'in' : row.netCents < 0 ? 'out' : '')}>{formatBRL(row.netCents)}</td>
                  <td className="num">{row.entries}</td>
                </tr>
                {open.has(row.entityId) &&
                  row.trail.map((x) => (
                    <tr key={`${x.caixaId}:${x.cardCaixaId}:${x.source}`} className="report-child">
                      <td>
                        <span className="report-trail" title={t.reports.trail}>
                          <span>{x.caixaName}</span>
                          {x.cardName && (
                            <>
                              <ArrowRight />
                              <span>
                                <CreditCard /> {x.cardName}
                              </span>
                            </>
                          )}
                          <ArrowRight />
                          <span>{row.entityName}</span>
                          <Badge tone="neutral">{t.reports.sources[x.source]}</Badge>
                        </span>
                      </td>
                      <td className={cx('num money', x.outflowCents === 0 && 'muted')}>{formatBRL(x.outflowCents)}</td>
                      <td className={cx('num money', x.inflowCents === 0 && 'muted')}>{formatBRL(x.inflowCents)}</td>
                      <td className="num money muted">{formatBRL(x.inflowCents - x.outflowCents)}</td>
                      <td className="num">{x.entries}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
            <tr className="report-total">
              <td>{t.reports.totalLine}</td>
              <td className="num money">{formatBRL(totals.out)}</td>
              <td className="num money">{formatBRL(totals.in)}</td>
              <td className="num money">{formatBRL(totals.in - totals.out)}</td>
              <td className="num">{rows.reduce((acc, r) => acc + r.entries, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function entityExport(data: EntityReportData, scope: string | null, subtitle: string[]): ExportTable {
  const rows: EntityRow[] = buildEntityRows(data.lines, { caixaId: scope });
  const out: ExportTable['rows'] = [];
  const bold: number[] = [];
  for (const row of rows) {
    bold.push(out.length);
    out.push({ entity: row.entityName, outflow: row.outflowCents, inflow: row.inflowCents, net: row.netCents, entries: row.entries });
    for (const x of row.trail) {
      out.push({
        entity: `   ${row.entityName}`,
        caixa: x.caixaName,
        card: x.cardName ?? '',
        source: t.reports.sources[x.source],
        outflow: x.outflowCents,
        inflow: x.inflowCents,
        net: x.inflowCents - x.outflowCents,
        entries: x.entries,
      });
    }
  }
  return {
    fileName: exportFileName('relatorio-por-entidade', data.from, data.to),
    title: t.reports.tabs.entities!,
    subtitle,
    columns: [
      { key: 'entity', label: t.reports.entity },
      { key: 'caixa', label: t.reports.caixas },
      { key: 'card', label: t.flow.cardNode },
      { key: 'source', label: t.reports.trail },
      { key: 'outflow', label: t.reports.outflow, type: 'money' },
      { key: 'inflow', label: t.reports.inflow, type: 'money' },
      { key: 'net', label: t.reports.net, type: 'money' },
      { key: 'entries', label: t.reports.entries, type: 'int' },
    ],
    rows: out,
    boldRows: bold,
  };
}
