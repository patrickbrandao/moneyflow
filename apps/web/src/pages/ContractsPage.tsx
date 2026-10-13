import {
  type CaixaSummary,
  CONTRACT_LIST_STATUSES,
  type ContractRow,
  formatDate,
  formatMonth,
  type RecurringPanelDto,
  t,
} from '@moneyflow/shared';
import { CalendarClock, Handshake, Plus, Repeat, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaixaFilter } from '../components/CaixaFilter';
import { ContractFormModal } from '../components/contracts/ContractFormModal';
import { ContractStatusBadge, ContractsTable } from '../components/contracts/ContractsTable';
import { LoadError, Money, PageHead } from '../components/domain';
import { ExportMenu } from '../components/ExportMenu';
import { Button, EmptyRow, Panel, Tabs, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { contractsTable } from '../lib/export-tables';
import { useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

const WITHIN = [30, 60, 90, 180];

/** Contratos (spec 020): lista com filtros e exportação, e o painel de recorrentes. */
export function ContractsPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [view, setView] = useParamState('view');
  const [isNew, setNew] = useParamState('new');
  const [caixaId, setCaixaId] = useParamState('caixa');
  const [entityId] = useParamState('entity');
  const [direction, setDirection] = useParamState('direction');
  const [status, setStatus] = useParamState('status');
  const [within, setWithin] = useParamState('within');
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const general = (caixas.data ?? []).filter((c) => c.kind === 'general' && !c.archivedAt);
  const canCreate = user.role === 'admin' || user.memberships.some((m) => m.role === 'editor');

  const qs = new URLSearchParams({ limit: '300' });
  if (caixaId) qs.set('caixaId', caixaId);
  if (entityId) qs.set('entityId', entityId);
  if (direction) qs.set('direction', direction);
  if (status) qs.set('status', status);
  if (within) qs.set('withinDays', within);
  if (query.trim()) qs.set('q', query.trim());
  if (archived) qs.set('archived', '1');
  const list = useApi<ContractRow[]>(view === 'panel' ? null : `/api/contracts?${qs}`);

  useRegisterCommands(
    canCreate ? [{ id: 'contract-new', label: t.palette.newContract, group: 'Criar', icon: <Plus />, run: () => setNew('1') }] : [],
    [canCreate],
  );

  const filterLabel = [
    caixaId && general.find((c) => c.id === caixaId)?.name,
    direction && t.contracts.directions[direction],
    status && t.contracts.statuses[status],
    within && `${t.contracts.filters.within} ${t.contracts.filters.withinDays(Number(within))}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="page wide">
      <PageHead
        title={t.contracts.title}
        sub={t.contracts.pageSub}
        actions={
          <>
            {view !== 'panel' && (
              <ExportMenu
                size="md"
                build={async () => {
                  const all = new URLSearchParams(qs);
                  all.set('limit', '500');
                  return contractsTable(await api.get<ContractRow[]>(`/api/contracts?${all}`), filterLabel);
                }}
              />
            )}
            {canCreate && (
              <Button onClick={() => setNew('1')}>
                <Plus /> {t.contracts.newContract}
              </Button>
            )}
          </>
        }
      />
      <Tabs
        value={view === 'panel' ? 'panel' : 'list'}
        onChange={(key) => setView(key === 'panel' ? 'panel' : null)}
        items={[
          { key: 'list', label: t.contracts.title, icon: <Handshake /> },
          { key: 'panel', label: t.contracts.panel.title, icon: <Repeat /> },
        ]}
      />
      {view === 'panel' ? (
        <RecurringPanel />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="search-bar">
              <Search />
              <input
                className="field"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t.contracts.filters.search}
                aria-label={t.contracts.filters.search}
              />
            </label>
            <select
              className="field field-auto"
              value={caixaId ?? ''}
              onChange={(e) => setCaixaId(e.target.value || null)}
              aria-label={t.contracts.fields.caixa}
            >
              <option value="">{t.contracts.filters.allCaixas}</option>
              {general.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="field field-auto"
              value={direction ?? ''}
              onChange={(e) => setDirection(e.target.value || null)}
              aria-label={t.contracts.fields.direction}
            >
              <option value="">{t.contracts.filters.allDirections}</option>
              <option value="receivable">{t.contracts.directions.receivable}</option>
              <option value="payable">{t.contracts.directions.payable}</option>
            </select>
            <select
              className="field field-auto"
              value={status ?? ''}
              onChange={(e) => setStatus(e.target.value || null)}
              aria-label={t.contracts.columns.status}
            >
              <option value="">{t.contracts.filters.allStatuses}</option>
              {CONTRACT_LIST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.contracts.statuses[s]}
                </option>
              ))}
            </select>
            <select
              className="field field-auto"
              value={within ?? ''}
              onChange={(e) => setWithin(e.target.value || null)}
              aria-label={t.contracts.filters.within}
            >
              <option value="">
                {t.contracts.filters.within}: {t.contracts.filters.withinAny.toLowerCase()}
              </option>
              {WITHIN.map((d) => (
                <option key={d} value={d}>
                  {t.contracts.filters.within} {t.contracts.filters.withinDays(d)}
                </option>
              ))}
            </select>
            <label className="check ml-auto">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t.common.showArchived}
            </label>
          </div>
          {list.error ? (
            <LoadError error={list.error} onRetry={() => void list.reload()} />
          ) : (
            <ContractsTable rows={list.data} empty={query || filterLabel ? t.common.noResults : t.contracts.noContractsHint} />
          )}
        </>
      )}
      {isNew && (
        <ContractFormModal
          defaultCaixaId={caixaId}
          onClose={() => setNew(null)}
          onSaved={(contract) => {
            setNew(null);
            navigate(`/contracts/${contract.id}`);
          }}
        />
      )}
    </div>
  );
}

/** Receita e despesa contratadas nos próximos 12 meses, a renovar em 90 dias e renovações pendentes. */
function RecurringPanel() {
  const [selected, setSelected] = useState<string[]>([]);
  const panel = useApi<RecurringPanelDto>(`/api/contracts/panel${selected.length ? `?caixas=${selected.join(',')}` : ''}`);
  const P = t.contracts.panel;
  const data = panel.data;
  const totals = (data?.months ?? []).reduce(
    (acc, m) => ({ receivable: acc.receivable + m.receivableCents, payable: acc.payable + m.payableCents }),
    { receivable: 0, payable: 0 },
  );
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="hint">{P.sub}</p>
        <CaixaFilter selected={selected} onChange={setSelected} includeCards={false} />
      </div>
      {panel.error && <LoadError error={panel.error} onRetry={() => void panel.reload()} />}
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="v">
            <Money cents={totals.receivable} />
          </div>
          <div className="k">
            <TrendingUp /> {P.receivable}
          </div>
        </div>
        <div className="stat-tile">
          <div className="v">
            <Money cents={totals.payable} />
          </div>
          <div className="k">
            <TrendingDown /> {P.payable}
          </div>
        </div>
        <div className="stat-tile">
          <div className="v">
            <Money cents={totals.receivable - totals.payable} signed />
          </div>
          <div className="k">{P.net}</div>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={P.title} icon={<Repeat />} className="lg:col-span-2">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{P.month}</th>
                  <th className="num">{P.receivable}</th>
                  <th className="num">{P.payable}</th>
                  <th className="num">{P.net}</th>
                </tr>
              </thead>
              <tbody>
                {data?.months.length === 0 && <EmptyRow colSpan={4}>{P.none}</EmptyRow>}
                {data?.months.map((m) => (
                  <tr key={m.month}>
                    <td className="mono">{formatMonth(m.month)}</td>
                    <td className="num">
                      <Money cents={m.receivableCents} muted={m.receivableCents === 0} />
                    </td>
                    <td className="num">
                      <Money cents={m.payableCents} muted={m.payableCents === 0} />
                    </td>
                    <td className="num">
                      <Money cents={m.netCents} signed />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title={P.renewSoon} icon={<CalendarClock />}>
          <MiniList rows={data?.renewSoon} />
        </Panel>
        <Panel title={P.pending} icon={<Repeat />}>
          <MiniList rows={data?.pendingRenewals} pending />
        </Panel>
      </div>
    </>
  );
}

function MiniList({ rows, pending }: { rows: ContractRow[] | undefined; pending?: boolean }) {
  const navigate = useNavigate();
  if (!rows) return <p className="hint">{t.common.loading}</p>;
  if (rows.length === 0) return <p className="hint">{t.contracts.panel.none}</p>;
  return (
    <ul className="item-list">
      {rows.map((row) => (
        <li key={row.id} className="item cursor-pointer" onClick={() => navigate(`/contracts/${row.id}${pending ? '?tab=renewal' : ''}`)}>
          <span className="grow min-w-0">
            <span className="row-title">{row.name}</span>
            <span className="row-sub">
              {row.entityName} ·{' '}
              {pending && row.openTask
                ? t.contracts.renewal.taskDue(formatDate(row.openTask.dueOn))
                : row.currentCycle
                  ? `${t.contracts.fields.endsOn} ${formatDate(row.currentCycle.endsOn)}`
                  : ''}
            </span>
          </span>
          <ContractStatusBadge row={row} />
        </li>
      ))}
    </ul>
  );
}
