import { type ContractRow, type ContractStatus, formatDate, t } from '@moneyflow/shared';
import { useNavigate } from 'react-router-dom';
import { CategoryDot, Money, SkelRows } from '../domain';
import { Badge, EmptyRow, type Tone } from '../ui';

const STATUS_TONE: Record<ContractStatus, Tone> = {
  draft: 'outline',
  active: 'ok',
  renewal_pending: 'warn',
  ended: 'neutral',
  terminated: 'neutral',
};

/** Situação do contrato; renovação pendente vencida em vermelho. */
export function ContractStatusBadge({ row }: { row: Pick<ContractRow, 'status' | 'openTask'> }) {
  if (row.status === 'renewal_pending' && row.openTask?.overdue)
    return <Badge tone="danger">{`${t.contracts.statuses.renewal_pending} · ${t.contracts.panel.overdue}`}</Badge>;
  return <Badge tone={STATUS_TONE[row.status]}>{t.contracts.statuses[row.status]}</Badge>;
}

/** Tabela de contratos (lista, aba da entidade e painel). */
export function ContractsTable({
  rows,
  empty,
  showCaixa = true,
  showEntity = true,
}: {
  rows: ContractRow[] | undefined;
  empty: string;
  showCaixa?: boolean;
  showEntity?: boolean;
}) {
  const navigate = useNavigate();
  const C = t.contracts.columns;
  const cols = 5 + (showCaixa ? 1 : 0) + (showEntity ? 1 : 0);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{C.name}</th>
            {showEntity && <th>{C.entity}</th>}
            {showCaixa && <th>{C.caixa}</th>}
            <th>{C.cycle}</th>
            <th className="num">{C.value}</th>
            <th>{C.next}</th>
            <th>{C.status}</th>
          </tr>
        </thead>
        <tbody>
          {!rows && <SkelRows cols={cols} />}
          {rows && rows.length === 0 && <EmptyRow colSpan={cols}>{empty}</EmptyRow>}
          {rows?.map((row) => (
            <tr
              key={row.id}
              className={`cursor-pointer${row.archivedAt ? ' is-off' : ''}`}
              onClick={() => navigate(`/contracts/${row.id}`)}
            >
              <td>
                <span className="flex items-center gap-2">
                  <CategoryDot slot={row.categoryColorSlot} />
                  <span className="min-w-0">
                    <span className="row-title">{row.name}</span>
                    <span className="row-sub">
                      {t.contracts.directionsShort[row.direction]}
                      {row.contractNumber ? ` · nº ${row.contractNumber}` : ''}
                    </span>
                  </span>
                </span>
              </td>
              {showEntity && <td>{row.entityName}</td>}
              {showCaixa && <td className="text-dim">{row.caixaName}</td>}
              <td className="mono text-xs">
                {row.currentCycle
                  ? t.contracts.cycleRange(formatDate(row.currentCycle.startsOn), formatDate(row.currentCycle.endsOn))
                  : '—'}
              </td>
              <td className="num">{row.currentCycle ? <Money cents={row.currentCycle.totalCents} /> : '—'}</td>
              <td>
                {row.nextInstallment ? (
                  <span className="text-xs">
                    <span className="mono">{formatDate(row.nextInstallment.dueDate)}</span> ·{' '}
                    <Money cents={row.nextInstallment.amountCents} />
                    <span className="text-faint">
                      {' '}
                      ({row.nextInstallment.installment}/{row.nextInstallment.total})
                    </span>
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td>
                <ContractStatusBadge row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
