import { type ContractRow, type ContractStatus, formatDate, t } from '@moneyflow/shared';
import { useNavigate } from 'react-router-dom';
import { CategoryDot, Money, SkelRows } from '../domain';
import { Badge, EmptyRow, type Tone } from '../ui';

const STATUS_TONE: Record<ContractStatus, Tone> = {
  draft: 'outline',
  active: 'ok',
  ended: 'neutral',
  terminated: 'neutral',
};

/** Situação do contrato (rascunho, vigente, encerrado, rescindido). */
export function ContractStatusBadge({ row }: { row: Pick<ContractRow, 'status'> }) {
  return <Badge tone={STATUS_TONE[row.status]}>{t.contracts.statuses[row.status]}</Badge>;
}

/** Vigência legível ("01/03/2026 – 28/02/2027" ou "… – indeterminado"). */
export const termText = (row: Pick<ContractRow, 'startsOn' | 'endsOn'>) =>
  t.contracts.termRange(formatDate(row.startsOn), row.endsOn ? formatDate(row.endsOn) : null);

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
      <table className="data" data-testid="contracts-table">
        <thead>
          <tr>
            <th>{C.name}</th>
            {showEntity && <th>{C.entity}</th>}
            {showCaixa && <th>{C.caixa}</th>}
            <th>{C.term}</th>
            <th className="num">{C.obligations}</th>
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
              data-testid="contract-row"
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
              <td className="mono text-xs">{termText(row)}</td>
              <td className="num">
                <span className="inline-flex items-center gap-1">
                  {row.withoutAccount > 0 && (
                    <Badge tone="warn" title={t.contracts.obligation.noAccount}>
                      {t.contracts.obligation.withoutAccount(row.withoutAccount)}
                    </Badge>
                  )}
                  <span className="mono">{row.obligationCount}</span>
                </span>
              </td>
              <td>
                {row.nextOccurrence ? (
                  <span className="text-xs">
                    <span className="mono">{formatDate(row.nextOccurrence.dueDate)}</span> ·{' '}
                    <Money cents={row.nextOccurrence.amountCents} />
                    <span className="row-sub">{row.nextOccurrence.description}</span>
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
