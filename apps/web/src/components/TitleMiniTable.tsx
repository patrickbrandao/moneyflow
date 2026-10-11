import { formatDate, type TitleRow } from '@moneyflow/shared';
import { Link } from 'react-router-dom';
import { recordDragProps } from '../agents/records';
import { titleLink } from '../lib/links';
import { MirrorBadge, Money, SkelRows, TitleStatusBadge } from './domain';
import { EmptyRow } from './ui';

/** Tabela compacta de títulos (visão geral): cada linha abre o título na caixa. */
export function TitleMiniTable({ rows, empty, showCaixa = true }: { rows: TitleRow[] | undefined; empty: string; showCaixa?: boolean }) {
  const cols = showCaixa ? 5 : 4;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Vencimento</th>
            <th>Título</th>
            {showCaixa && <th>Caixa</th>}
            <th className="num">Em aberto</th>
            <th>Situação</th>
          </tr>
        </thead>
        <tbody>
          {!rows && <SkelRows cols={cols} rows={3} />}
          {rows && rows.length === 0 && <EmptyRow colSpan={cols}>{empty}</EmptyRow>}
          {rows?.map((title) => (
            <tr key={title.id} {...recordDragProps({ kind: 'title', id: title.id, label: title.description })}>
              <td className="mono text-xs">{formatDate(title.dueDate)}</td>
              <td>
                <Link to={titleLink(title)} className="row-title hover:text-[var(--accent-soft)]">
                  {title.description}
                </Link>
                <span className="row-sub">
                  {title.direction === 'payable' ? '↑' : '↓'} {title.entityName}
                </span>
              </td>
              {showCaixa && <td className="text-dim">{title.caixaName}</td>}
              <td className="num">
                <Money cents={title.direction === 'payable' ? -title.openCents : title.openCents} signed />
              </td>
              <td>
                <span className="inline-flex flex-wrap gap-1">
                  <TitleStatusBadge title={title} />
                  <MirrorBadge status={title.mirrorStatus} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
