import { type ContractDetail, formatDate, t } from '@moneyflow/shared';
import { FileText } from 'lucide-react';
import type { ReactNode } from 'react';
import { CategoryLabel, Money } from '../domain';
import { Panel } from '../ui';
import { termText } from './ContractsTable';

const C = t.contracts;

/** Números das obrigações: quantas, a próxima ocorrência, em aberto e vencidas. */
export function ContractTotals({ contract }: { contract: ContractDetail }) {
  const open = contract.obligations.reduce((acc, o) => acc + o.openCount, 0);
  const overdue = contract.obligations.reduce((acc, o) => acc + o.overdueCount, 0);
  const next = contract.nextOccurrence;
  const P = C.payments;
  return (
    <div className="stat-tiles" data-testid="contract-totals">
      <div className="stat-tile">
        <div className="v">{contract.obligationCount}</div>
        <div className="k">{C.fields.obligations}</div>
      </div>
      <div className="stat-tile">
        <div className="v">
          {next ? (
            <span className="text-sm">
              <span className="mono">{formatDate(next.dueDate)}</span> · <Money cents={next.amountCents} />
            </span>
          ) : (
            '—'
          )}
        </div>
        <div className="k">{next ? `${C.fields.nextOccurrence} · ${next.description}` : C.fields.nextOccurrence}</div>
      </div>
      <div className="stat-tile">
        <div className="v">{open}</div>
        <div className="k">{P.openCount}</div>
      </div>
      <div className="stat-tile">
        <div className={`v${overdue > 0 ? ' text-danger' : ''}`}>{overdue}</div>
        <div className="k">{P.overdueCount}</div>
      </div>
    </div>
  );
}

export function ContractSummary({ contract }: { contract: ContractDetail }) {
  const F = C.fields;
  const rows: [string, ReactNode][] = [
    [F.category, <CategoryLabel key="c" name={contract.categoryName} slot={contract.categoryColorSlot} />],
    [F.term, termText(contract)],
    [F.autoRenew, contract.autoRenew ? t.common.yes : t.common.no],
    [
      F.noticeDays,
      contract.noticeDeadline ? `${contract.noticeDays} · ${formatDate(contract.noticeDeadline)}` : String(contract.noticeDays),
    ],
    [
      F.readjustmentIndex,
      `${C.indexes[contract.readjustmentIndex]}${contract.nextReadjustment ? ` · ${formatDate(contract.nextReadjustment)}` : ''}`,
    ],
    ...(contract.counterpartyCaixaName ? ([[F.mirrorCaixa, contract.counterpartyCaixaName]] as [string, ReactNode][]) : []),
    ...(contract.terminationPenaltyText || contract.terminationPenaltyCents
      ? ([
          [
            C.termination.penaltyRecorded,
            <span key="p">
              {contract.terminationPenaltyText}
              {contract.terminationPenaltyCents ? (
                <>
                  {' '}
                  <Money cents={contract.terminationPenaltyCents} />
                </>
              ) : null}
            </span>,
          ],
        ] as [string, ReactNode][])
      : []),
    ...(contract.terminatedOn ? ([[C.termination.terminatedOn, formatDate(contract.terminatedOn)]] as [string, ReactNode][]) : []),
  ];
  return (
    <Panel title={C.contract} icon={<FileText />}>
      <dl className="kv" data-testid="contract-summary">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {contract.notes && <p className="hint mt-3 whitespace-pre-wrap">{contract.notes}</p>}
    </Panel>
  );
}
