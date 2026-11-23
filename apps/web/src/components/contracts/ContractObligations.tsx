import {
  type ContractDetail,
  formatAccounting,
  formatDate,
  formatMonth,
  type SeriesDto,
  seriesTermsSummary,
  t,
  titleLink,
} from '@moneyflow/shared';
import { CalendarX, ExternalLink, Link2, Pencil, Plus, Unlink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { RowLink } from '../a11y';
import { Money, TitleStatusBadge } from '../domain';
import { calendarText } from '../series/series-text';
import { Badge, Button } from '../ui';

const C = t.contracts;
const O = C.obligation;

/** Onde a obrigação vive: a conta (e a caixa dela) ou o cartão com a pagadora. */
function placeOf(series: SeriesDto): string {
  if (series.kind === 'card') return `${series.caixaName}${series.payerCaixaName ? ` · ${O.payerOf(series.payerCaixaName)}` : ''}`;
  return series.accountName ? `${series.accountName} (${series.caixaName})` : series.caixaName;
}

export function ContractObligations({
  contract,
  canWrite,
  onAdd,
  onLink,
  onEdit,
  onEnd,
  onUnlink,
}: {
  contract: ContractDetail;
  canWrite: boolean;
  onAdd: () => void;
  onLink: () => void;
  onEdit: (series: SeriesDto) => void;
  onEnd: (series: SeriesDto) => void;
  onUnlink: (series: SeriesDto) => void;
}) {
  const navigate = useNavigate();
  const live = contract.status === 'active';
  return (
    <div className="grid gap-4" data-testid="contract-obligations">
      {canWrite && live && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onAdd} data-testid="contract-add-obligation">
            <Plus /> {C.actions.addObligation}
          </Button>
          <Button size="sm" variant="ghost" onClick={onLink} data-testid="contract-link-series">
            <Link2 /> {C.actions.linkSeries}
          </Button>
        </div>
      )}
      {contract.withoutAccount > 0 && (
        <p className="notice warn" data-testid="contract-without-account">
          {O.noAccount} ({O.withoutAccount(contract.withoutAccount)})
        </p>
      )}
      {contract.status === 'draft' && <p className="hint">{C.draftNoObligations}</p>}
      {contract.status !== 'draft' && contract.obligations.length === 0 && <p className="hint">{C.noObligations}</p>}
      {contract.obligations.length > 0 && (
        <ul className="item-list">
          {contract.obligations.map((s) => {
            const ended = Boolean(s.endsOn && !s.next && s.openCount === 0);
            return (
              <li key={s.id} className={`item${ended ? ' is-off' : ''}`} data-testid="obligation-row" data-kind={s.kind}>
                <span className="grow min-w-0">
                  <span className="row-title flex flex-wrap items-center gap-2">
                    {s.description}
                    <Badge tone="outline">{O.kinds[s.kind]}</Badge>
                    {ended && <Badge>{O.ended}</Badge>}
                    {s.withoutAccount > 0 && (
                      <Badge tone="warn" title={O.noAccount}>
                        {O.withoutAccount(s.withoutAccount)}
                      </Badge>
                    )}
                  </span>
                  <span className="row-sub">
                    {placeOf(s)} · {s.categoryName}
                  </span>
                  <span className="row-sub">
                    {calendarText(s)} · {O.period(formatDate(s.startsOn), s.endsOn ? formatDate(s.endsOn) : null)}
                  </span>
                  <span className="row-sub" data-testid="obligation-terms-summary">
                    {seriesTermsSummary(s.terms)}
                  </span>
                  {s.next && (
                    <span className="row-sub" data-testid="obligation-next">
                      {O.next(formatDate(s.next.dueDate), formatAccounting(s.next.amountCents))}
                      {(s.openCount > 0 || s.overdueCount > 0) && ` · ${O.counts(s.openCount, s.overdueCount)}`}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Money cents={s.amountCents} />
                  {s.next?.titleId && (
                    <button
                      type="button"
                      className="row-action"
                      title={O.openNext}
                      aria-label={`${O.openNext}: ${s.description}`}
                      onClick={() => navigate(titleLink({ id: s.next!.titleId!, caixaId: s.caixaId, direction: s.direction }))}
                    >
                      <ExternalLink />
                    </button>
                  )}
                  {canWrite && s.canWrite && (
                    <>
                      <button
                        type="button"
                        className="row-action"
                        title={O.edit}
                        aria-label={`${O.edit}: ${s.description}`}
                        onClick={() => onEdit(s)}
                        data-testid="obligation-edit"
                      >
                        <Pencil />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title={O.endAction}
                        aria-label={`${O.endAction}: ${s.description}`}
                        onClick={() => onEnd(s)}
                        data-testid="obligation-end"
                      >
                        <CalendarX />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title={O.unlink}
                        aria-label={`${O.unlink}: ${s.description}`}
                        onClick={() => onUnlink(s)}
                        data-testid="obligation-unlink"
                      >
                        <Unlink />
                      </button>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {contract.extraTitles.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{C.extraTitles}</h3>
          <div className="table-wrap">
            <table className="data" data-testid="contract-extra-titles">
              <thead>
                <tr>
                  <th>{O.description}</th>
                  <th>{C.columns.competence}</th>
                  <th>{C.columns.due}</th>
                  <th className="num">{C.columns.amount}</th>
                  <th className="num">{C.columns.settled}</th>
                  <th className="num">{C.columns.open}</th>
                  <th>{C.columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {contract.extraTitles.map((row) => {
                  const to = titleLink({ id: row.titleId, caixaId: row.caixaId, direction: row.direction });
                  return (
                    // A linha abre pelo clique; pelo teclado, o nome é o link (tarefa 114).
                    <tr
                      key={row.titleId}
                      className={`cursor-pointer${row.archived || row.status === 'canceled' ? ' is-off' : ''}`}
                      onClick={() => navigate(to)}
                    >
                      <td>
                        <RowLink to={to}>{row.description}</RowLink>
                      </td>
                      <td className="mono">{formatMonth(row.competenceDate)}</td>
                      <td className="mono">{formatDate(row.dueDate)}</td>
                      <td className="num">
                        <Money cents={row.amountCents} />
                      </td>
                      <td className="num">
                        <Money cents={row.settledCents} muted={row.settledCents === 0} />
                      </td>
                      <td className="num">
                        <Money cents={row.openCents} muted={row.openCents === 0} />
                      </td>
                      <td>
                        <TitleStatusBadge title={row} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
