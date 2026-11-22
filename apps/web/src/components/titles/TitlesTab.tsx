import { type CaixaDetail, formatDate, type TitleRow, type TitleTotals, t } from '@moneyflow/shared';
import { CircleDollarSign, Paperclip, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import '../../styles/attachments.css';
import { recordDragProps } from '../../agents/records';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { titlesTable } from '../../lib/export-tables';
import { useApi, useListLimit } from '../../lib/hooks';
import { useParamState, useSetParams } from '../../lib/params';
import { DateRangeFilter, useStoredPeriod } from '../DateRangeFilter';
import { CategoryLabel, ListCutNotice, LoadError, MirrorBadge, Money, SkelRows, TitleStatusBadge } from '../domain';
import { ExportMenu } from '../ExportMenu';
import { Badge, Button, cx, EmptyRow, Skel, Tabs, useDebounced } from '../ui';
import { TitleDrawer } from './TitleDrawer';
import { TitleFormModal } from './TitleFormModal';

const FILTERS = [
  { key: 'unpaid', label: t.title.filters.unpaid! },
  { key: 'overdue', label: t.title.statuses.overdue! },
  { key: 'paid', label: t.title.filters.paid! },
  { key: 'pending_acceptance', label: t.title.mirrorStatuses.pending! },
  { key: 'pending_account', label: t.title.pendingAccount },
  { key: 'canceled', label: t.title.filters.canceled! },
  { key: 'all', label: t.common.all },
] as const;

/** Títulos a pagar ou a receber de uma caixa: filtros, busca, totais e a gaveta do título. */
export function TitlesTab({
  caixa,
  direction,
  onChanged,
}: {
  caixa: CaixaDetail;
  direction: 'payable' | 'receivable';
  onChanged: () => void;
}) {
  const [status, setStatus] = useParamState('status');
  const [titleId, setTitleId] = useParamState('title');
  const [isNew, setNew] = useParamState('new');
  const setParams = useSetParams();
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  // vencimento: lembrado por caixa e direção
  const [period, setPeriod] = useStoredPeriod(`titles:${caixa.id}:${direction}`);
  const { from, to } = period;
  const query = useDebounced(q, 250);
  const filter = status ?? 'unpaid';
  const params = new URLSearchParams({ caixaId: caixa.id, direction });
  if (filter !== 'all') params.set('status', filter);
  if (query.trim()) params.set('q', query.trim());
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (archived) params.set('archived', '1');
  // A lista corta no servidor (tarefa 116): o rodapé vem dos totais do filtro inteiro, e
  // "Mostrando N de M" com "Carregar mais" avisa quando há mais títulos do que os mostrados.
  const list = useListLimit(params.toString());
  const listParams = new URLSearchParams(params);
  listParams.set('limit', String(list.limit));
  const { data, error, reload, loading } = useApi<TitleRow[]>(`/api/titles?${listParams}`, { keepPrevious: list.growing });
  const totals = useApi<TitleTotals>(`/api/titles/totals?${params}`);

  const changed = () => {
    void reload();
    void totals.reload();
    onChanged();
  };

  const label = direction === 'payable' ? t.title.newPayable : t.title.newReceivable;
  useRegisterCommands(
    caixa.canWrite
      ? [{ id: `new-${direction}`, label: `${label} em ${caixa.name}`, group: 'Criar', icon: <Plus />, run: () => setNew('1') }]
      : [],
    [caixa.canWrite, caixa.id, direction],
  );

  const count = totals.data?.count ?? null;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="search-bar">
          <Search />
          <input
            className="field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.title.searchPlaceholder}
            aria-label={t.title.searchAria}
          />
        </label>
        <DateRangeFilter value={period} onChange={setPeriod} fromLabel={t.title.dueFrom} toLabel={t.title.dueTo} />
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t.common.showArchived}
        </label>
        <span className="flex-1" />
        <ExportMenu
          build={async () => {
            const all = new URLSearchParams(params);
            all.set('limit', '500');
            const rows = await api.get<TitleRow[]>(`/api/titles?${all}`);
            return titlesTable(rows, {
              caixaName: caixa.name,
              direction,
              filter: FILTERS.find((f) => f.key === filter)?.label ?? '',
              from,
              to,
            });
          }}
        />
        {caixa.canWrite && (
          <Button onClick={() => setNew('1')}>
            <Plus /> {label}
          </Button>
        )}
      </div>
      <Tabs
        value={filter}
        onChange={(key) => setStatus(key === 'unpaid' ? null : key)}
        items={FILTERS.map((f) => ({ key: f.key, label: f.label }))}
      />

      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.title.due}</th>
                <th>{t.title.titleLabel}</th>
                <th>{t.title.category}</th>
                <th className="num">{t.title.amount}</th>
                <th className="num">{t.title.open}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={7} />}
              {data && data.length === 0 && <EmptyRow colSpan={7}>{t.title.emptyFiltered}</EmptyRow>}
              {data?.map((row) => (
                <tr
                  key={row.id}
                  className={cx(
                    'cursor-pointer',
                    row.id === titleId && 'is-selected',
                    (row.status === 'canceled' || row.archivedAt) && 'is-off',
                  )}
                  onClick={() => setTitleId(row.id)}
                  {...recordDragProps({ kind: 'title', id: row.id, label: row.description })}
                >
                  <td className={cx('mono text-xs', row.overdue && 'text-danger')}>{formatDate(row.dueDate)}</td>
                  <td>
                    <span className="row-title">
                      {row.description}
                      {row.occurrence && (
                        <Badge mono className="ml-2">
                          {t.title.occurrenceOf(row.occurrence, row.installmentsTotal)}
                        </Badge>
                      )}
                      {row.attachmentCount > 0 && (
                        <span className="clip-count" title={t.attachments.count(row.attachmentCount)}>
                          <Paperclip aria-hidden />
                          {row.attachmentCount}
                        </span>
                      )}
                    </span>
                    <span className="row-sub">
                      {row.entityName}
                      {row.counterpartyCaixaName ? ` · ⇄ ${row.counterpartyCaixaName}` : ''}
                    </span>
                  </td>
                  <td>
                    <CategoryLabel name={row.categoryName} slot={row.categoryColorSlot} />
                  </td>
                  <td className="num">
                    <Money cents={row.amountCents} />
                  </td>
                  <td className="num">
                    <Money cents={row.openCents} muted={row.openCents === 0} />
                  </td>
                  <td>
                    <span className="inline-flex flex-wrap gap-1">
                      <TitleStatusBadge title={row} />
                      <MirrorBadge status={row.mirrorStatus} />
                      {row.pendingAccountCount > 0 && <Badge tone="warn">{t.title.pendingAccount}</Badge>}
                    </span>
                  </td>
                  <td className="text-right">
                    {caixa.canWrite && row.openCents > 0 && row.status !== 'canceled' && (
                      <button
                        type="button"
                        className="row-action"
                        title={direction === 'payable' ? t.title.pay : t.title.receive}
                        onClick={(event) => {
                          event.stopPropagation();
                          setTitleId(row.id);
                        }}
                      >
                        <CircleDollarSign />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {data && data.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={3}>{count === null ? <Skel h={14} w={80} /> : t.title.countLabel(count)}</td>
                  <td className="num">{totals.data ? <Money cents={totals.data.amountCents} /> : <Skel h={14} w={80} />}</td>
                  <td className="num">{totals.data ? <Money cents={totals.data.openCents} /> : <Skel h={14} w={80} />}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {data && count !== null && data.length < count && (
        <ListCutNotice shown={data.length} total={count} canMore={list.canMore} loading={loading} onMore={list.more} />
      )}

      {titleId && <TitleDrawer key={titleId} titleId={titleId} onClose={() => setTitleId(null)} onChanged={changed} />}
      {isNew && (
        <TitleFormModal
          caixaId={caixa.id}
          direction={direction}
          onClose={() => setNew(null)}
          onSaved={(title) => {
            changed();
            setParams({ new: null, title: title.id });
          }}
        />
      )}
    </>
  );
}
