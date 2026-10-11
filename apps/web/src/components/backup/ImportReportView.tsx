import { type ImportReport, t } from '@moneyflow/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { downloadCsv } from '../../lib/export';
import { Badge, Button, EmptyRow, Panel, Tabs } from '../ui';

const r = t.backup.report;
const tableName = (table: string) => t.audit.tables[table] ?? t.backup.tables[table] ?? table;

/** Resultado de uma importação (ou simulação): totais por recurso e os itens não importados com o motivo. */
export function ImportReportView({ report }: { report: ImportReport }) {
  const failed = report.issues.filter((i) => i.status === 'failed');
  const kept = report.issues.filter((i) => i.status !== 'failed');
  const [view, setView] = useState<'failed' | 'kept'>(failed.length > 0 || kept.length === 0 ? 'failed' : 'kept');
  const list = view === 'failed' ? failed : kept;

  function exportCsv() {
    downloadCsv({
      fileName: `moneyflow-importacao-${report.kind}`,
      title: r.issues,
      columns: [
        { key: 'table', label: r.resource },
        { key: 'label', label: r.item },
        { key: 'id', label: 'ID' },
        { key: 'status', label: t.common.status },
        { key: 'reason', label: r.reason },
      ],
      rows: report.issues.map((issue) => ({ ...issue, table: tableName(issue.table), status: r.statuses[issue.status] ?? issue.status })),
    });
  }

  return (
    <Panel
      title={report.dryRun ? r.simulation : r.title}
      actions={
        report.issues.length > 0 && (
          <Button variant="ghost" size="sm" onClick={exportCsv}>
            <Download /> {r.downloadCsv}
          </Button>
        )
      }
    >
      {report.sourceSchemaVersion && report.schemaVersion && report.sourceSchemaVersion !== report.schemaVersion && (
        <p className="notice warn mb-3">{r.schemaMismatch(report.sourceSchemaVersion, report.schemaVersion)}</p>
      )}
      {report.ignoredTables.length > 0 && <p className="notice info mb-3">{r.ignoredTables(report.ignoredTables.join(', '))}</p>}
      <div className="table-wrap mb-4">
        <table className="data">
          <thead>
            <tr>
              <th>{r.resource}</th>
              <th className="num">{r.total}</th>
              <th className="num">{r.imported}</th>
              <th className="num">{r.existing}</th>
              <th className="num">{r.skipped}</th>
              <th className="num">{r.failed}</th>
            </tr>
          </thead>
          <tbody>
            {report.summary.map((row) => (
              <tr key={row.table}>
                <td>{tableName(row.table)}</td>
                <td className="num">{row.total}</td>
                <td className="num">{row.imported > 0 ? <Badge tone="ok">{row.imported}</Badge> : 0}</td>
                <td className="num">{row.existing}</td>
                <td className="num">{row.skipped}</td>
                <td className="num">{row.failed > 0 ? <Badge tone="danger">{row.failed}</Badge> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.issueCount === 0 ? (
        <p className="notice ok">{r.noIssues}</p>
      ) : (
        <>
          <Tabs
            value={view}
            onChange={(key) => setView(key as 'failed' | 'kept')}
            items={[
              { key: 'failed', label: r.issuesFailed, count: failed.length },
              { key: 'kept', label: r.issuesExisting, count: kept.length },
            ]}
          />
          {report.truncated && <p className="hint mb-2">{r.truncated(report.issues.length, report.issueCount)}</p>}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{r.resource}</th>
                  <th>{r.item}</th>
                  <th>{r.reason}</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && <EmptyRow colSpan={3}>{r.noneInFilter}</EmptyRow>}
                {list.map((issue) => (
                  <tr key={`${issue.table}:${issue.id}`}>
                    <td className="whitespace-nowrap">{tableName(issue.table)}</td>
                    <td>
                      <span className="row-title">{issue.label}</span>
                      <span className="row-sub mono">{issue.id}</span>
                    </td>
                    <td>
                      <Badge tone={issue.status === 'failed' ? 'danger' : 'neutral'} className="mr-2">
                        {r.statuses[issue.status] ?? issue.status}
                      </Badge>
                      {issue.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="hint mt-3">{r.duration((report.durationMs / 1000).toFixed(1))}</p>
    </Panel>
  );
}
