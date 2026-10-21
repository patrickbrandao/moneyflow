import {
  type AccountCategoryEntry,
  type AccountRow,
  type AccountSummary,
  type AccountSummaryCategory,
  addDays,
  addMonths,
  type ExportTable,
  exportFileName,
  formatDate,
  formatMonth,
  t,
  titleLink,
  todayIso,
} from '@moneyflow/shared';
import { BarChart3, PieChart, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { useParamState } from '../../lib/params';
import { useStored } from '../../lib/storage';
import { LoadError, Money, SkelRows } from '../domain';
import { ExportMenu } from '../ExportMenu';
import { ModalActions } from '../forms';
import { Button, EmptyRow, Modal, Panel, Skel } from '../ui';
import { BalanceLine, Donut, type DonutSlice, MonthColumns } from './account-charts';

const a = t.caixa.account;

/** Quantos grupos a pizza mostra em separado (o resto vira "Outras"). */
const DONUT_GROUPS = 7;

const PERIODS = ['m6', 'm12', 'year', 'lastYear'] as const;
type Period = (typeof PERIODS)[number];

export const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
export const monthEnd = (iso: string) => addDays(addMonths(monthStart(iso), 1), -1);

function periodRange(period: Period, today = todayIso()) {
  const year = Number(today.slice(0, 4));
  if (period === 'year') return { from: `${year}-01-01`, to: `${year}-12-31` };
  if (period === 'lastYear') return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  const back = period === 'm6' ? 5 : 11;
  return { from: addMonths(monthStart(today), -back), to: monthEnd(today) };
}

/** Fatia da pizza com os grupos que ela soma (id do grupo ou `none`; vários em "Outras"). */
type CategorySlice = DonutSlice & { groups: string[] };
type SliceSelection = CategorySlice & { kind: 'income' | 'expense' };

/** Grupos de categoria de um tipo, do maior para o menor, com "Outras" no fim. */
function donutSlices(lines: AccountSummaryCategory[], kind: 'income' | 'expense'): CategorySlice[] {
  const groups = new Map<string, CategorySlice>();
  for (const line of lines) {
    if (line.kind !== kind) continue;
    const key = line.groupCategoryId ?? 'none';
    const current = groups.get(key);
    if (current) current.value += line.amountCents;
    else
      groups.set(key, {
        key,
        label: line.groupName ?? t.reports.noCategory,
        color: line.groupColorSlot ? `var(--port-${line.groupColorSlot})` : 'var(--chart-other)',
        value: line.amountCents,
        groups: [key],
      });
  }
  const sorted = [...groups.values()].filter((g) => g.value > 0).sort((x, y) => y.value - x.value);
  if (sorted.length <= DONUT_GROUPS + 1) return sorted;
  const tail = sorted.slice(DONUT_GROUPS);
  const rest = tail.reduce((acc, g) => acc + g.value, 0);
  return [
    ...sorted.slice(0, DONUT_GROUPS),
    { key: 'rest', label: t.flow.otherGroup, color: 'var(--chart-other)', value: rest, groups: tail.flatMap((g) => g.groups) },
  ];
}

/** Lançamentos que somam uma fatia da pizza, do mais recente ao mais antigo, com o total no rodapé. */
function CategoryEntriesModal({
  account,
  from,
  to,
  slice,
  onClose,
}: {
  account: AccountRow;
  from: string;
  to: string;
  slice: SliceSelection;
  onClose: () => void;
}) {
  const query = new URLSearchParams({ from, to, kind: slice.kind, groups: slice.groups.join(',') });
  const { data, error, reload } = useApi<AccountCategoryEntry[]>(`/api/accounts/${account.id}/category-entries?${query}`);
  const kindLabel = t.category.kinds[slice.kind] ?? slice.kind;
  const total = data?.reduce((acc, e) => acc + e.amountCents, 0) ?? 0;

  return (
    <Modal open title={a.categoryEntries(kindLabel, slice.label)} onClose={onClose} wide>
      <p className="hint mb-2">
        {formatDate(from)} a {formatDate(to)}
        {data && ` · ${a.categoryEntriesCount(data.length)}`}
      </p>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap acc-entries">
          <table className="data" data-testid="account-category-entries">
            <thead>
              <tr>
                <th>{t.common.date}</th>
                <th>{a.entry}</th>
                <th className="num">{t.common.amount}</th>
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={3} />}
              {data && data.length === 0 && <EmptyRow colSpan={3}>{a.noEntries}</EmptyRow>}
              {data?.map((entry) => (
                <tr key={entry.movementId}>
                  <td className="mono text-xs">{formatDate(entry.occurredOn)}</td>
                  <td>
                    {entry.titleId && entry.titleDirection ? (
                      <Link
                        to={titleLink({ id: entry.titleId, caixaId: account.caixaId, direction: entry.titleDirection })}
                        className="row-title hover:text-[var(--accent-soft)]"
                      >
                        {entry.titleDescription ?? entry.description}
                      </Link>
                    ) : (
                      <span className="row-title">{entry.description ?? '—'}</span>
                    )}
                    <span className="row-sub">
                      {[entry.entityName, entry.categoryName ?? t.reports.noCategory, t.statement.movementKinds[entry.movementKind]]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </td>
                  <td className="num">
                    <Money cents={entry.amountCents} />
                  </td>
                </tr>
              ))}
              {data && data.length > 0 && (
                <tr className="font-semibold">
                  <td colSpan={2}>{a.total}</td>
                  <td className="num">
                    <Money cents={total} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.close}
        </Button>
      </ModalActions>
    </Modal>
  );
}

function monthsTable(summary: AccountSummary, caixaName: string): ExportTable {
  return {
    fileName: exportFileName('Conta', caixaName, summary.account.name, summary.from, summary.to),
    title: `${a.monthByMonth} · ${summary.account.name} (${caixaName})`,
    subtitle: [`${formatMonth(summary.from)} a ${formatMonth(summary.to)}`],
    columns: [
      { key: 'month', label: 'Mês' },
      { key: 'inflow', label: a.inflow, type: 'money' },
      { key: 'outflow', label: a.outflow, type: 'money' },
      { key: 'net', label: a.net, type: 'money' },
      { key: 'transferIn', label: a.transferIn, type: 'money' },
      { key: 'transferOut', label: a.transferOut, type: 'money' },
      { key: 'closing', label: a.closingBalance, type: 'money' },
    ],
    rows: summary.months.map((m) => ({
      month: formatMonth(m.month),
      inflow: m.inflowCents,
      outflow: m.outflowCents,
      net: m.inflowCents - m.outflowCents,
      transferIn: m.transferInCents,
      transferOut: m.transferOutCents,
      closing: m.closingCents,
    })),
  };
}

/** Resumo da conta (spec 004): entradas e saídas por mês, saldo, pizza de despesas e receitas e a tabela mês a mês. */
export function AccountOverview({ account, caixaName }: { account: AccountRow; caixaName: string }) {
  const [periodParam, setPeriod] = useParamState('period');
  const period: Period = PERIODS.includes(periodParam as Period) ? (periodParam as Period) : 'm12';
  const range = periodRange(period);
  const { data, error, reload } = useApi<AccountSummary>(`/api/accounts/${account.id}/summary?from=${range.from}&to=${range.to}`);
  const [withTransfers, setWithTransfers] = useStored<boolean>('account-flows-transfers', false);
  const [selected, setSelected] = useState<SliceSelection | null>(null);

  const view = useMemo(() => {
    if (!data) return null;
    const months = data.months.map((m) => m.month);
    const inflow = data.months.map((m) => m.inflowCents + (withTransfers ? m.transferInCents : 0));
    const outflow = data.months.map((m) => m.outflowCents + (withTransfers ? m.transferOutCents : 0));
    return {
      months,
      series: [
        { key: 'in', label: a.inflow, color: 'var(--ok)', values: inflow },
        { key: 'out', label: a.outflow, color: 'var(--danger)', values: outflow },
      ],
      balance: data.months.map((m) => m.closingCents),
      expense: donutSlices(data.categories, 'expense'),
      income: donutSlices(data.categories, 'income'),
      totals: {
        inflow: inflow.reduce((x, y) => x + y, 0),
        outflow: outflow.reduce((x, y) => x + y, 0),
        transferIn: data.months.reduce((x, m) => x + m.transferInCents, 0),
        transferOut: data.months.reduce((x, m) => x + m.transferOutCents, 0),
      },
    };
  }, [data, withTransfers]);

  return (
    <div className="acc-overview">
      <div className="acc-toolbar">
        <div className="segmented" role="group" aria-label="Período">
          {PERIODS.map((p) => (
            <button key={p} type="button" className={p === period ? 'active' : ''} onClick={() => setPeriod(p === 'm12' ? null : p)}>
              {a.periods[p]}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <ExportMenu disabled={!data} build={() => monthsTable(data!, caixaName)} />
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !view || !data ? (
        <>
          <Skel h={260} />
          <Skel h={260} className="mt-4" />
        </>
      ) : (
        <>
          <Panel
            title={a.flows}
            icon={<BarChart3 />}
            actions={
              <label className="check text-[13px]">
                <input type="checkbox" checked={withTransfers} onChange={(e) => setWithTransfers(e.target.checked)} /> {a.withTransfers}
              </label>
            }
          >
            <p className="hint mb-2">{a.flowsHint}</p>
            <MonthColumns months={view.months} series={view.series} label={a.flows} testId="account-flows" />
          </Panel>

          <Panel title={a.balanceTrend} icon={<TrendingUp />} className="mt-4">
            <BalanceLine
              months={view.months}
              values={view.balance}
              label={a.closingBalance}
              color="var(--accent-soft)"
              testId="account-balance"
            />
          </Panel>

          <div className="acc-donuts mt-4">
            <Panel title={a.expenseByCategory} icon={<PieChart />}>
              {view.expense.length > 0 ? (
                <Donut
                  slices={view.expense}
                  label={a.expenseByCategory}
                  testId="account-expense-donut"
                  onSelect={(slice) => setSelected({ ...slice, kind: 'expense' })}
                />
              ) : (
                <p className="hint">{a.noCategoryData}</p>
              )}
            </Panel>
            <Panel title={a.incomeByCategory} icon={<PieChart />}>
              {view.income.length > 0 ? (
                <Donut
                  slices={view.income}
                  label={a.incomeByCategory}
                  testId="account-income-donut"
                  onSelect={(slice) => setSelected({ ...slice, kind: 'income' })}
                />
              ) : (
                <p className="hint">{a.noCategoryData}</p>
              )}
            </Panel>
          </div>
          <p className="hint mt-2">{a.categoriesHint}</p>
          {selected && (
            <CategoryEntriesModal account={account} from={data.from} to={data.to} slice={selected} onClose={() => setSelected(null)} />
          )}

          <Panel title={a.monthByMonth} className="mt-4">
            <div className="table-wrap">
              <table className="data" data-testid="account-months">
                <thead>
                  <tr>
                    <th>Mês</th>
                    <th className="num">{a.inflow}</th>
                    <th className="num">{a.outflow}</th>
                    <th className="num">{a.net}</th>
                    <th className="num" title={a.transferIn}>
                      {a.transferInShort}
                    </th>
                    <th className="num" title={a.transferOut}>
                      {a.transferOutShort}
                    </th>
                    <th className="num" title={a.closingBalance}>
                      {a.closingShort}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((m) => (
                    <tr key={m.month}>
                      <td>{formatMonth(m.month)}</td>
                      <td className="num">
                        <Money cents={m.inflowCents} muted={m.inflowCents === 0} />
                      </td>
                      <td className="num">
                        <Money cents={m.outflowCents} muted={m.outflowCents === 0} />
                      </td>
                      <td className="num">
                        <Money cents={m.inflowCents - m.outflowCents} signed />
                      </td>
                      <td className="num">
                        <Money cents={m.transferInCents} muted={m.transferInCents === 0} />
                      </td>
                      <td className="num">
                        <Money cents={m.transferOutCents} muted={m.transferOutCents === 0} />
                      </td>
                      <td className="num">{m.closingCents === null ? '—' : <Money cents={m.closingCents} />}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td>{a.total}</td>
                    <td className="num">
                      <Money cents={data.months.reduce((x, m) => x + m.inflowCents, 0)} />
                    </td>
                    <td className="num">
                      <Money cents={data.months.reduce((x, m) => x + m.outflowCents, 0)} />
                    </td>
                    <td className="num">
                      <Money cents={data.months.reduce((x, m) => x + m.inflowCents - m.outflowCents, 0)} signed />
                    </td>
                    <td className="num">
                      <Money cents={view.totals.transferIn} />
                    </td>
                    <td className="num">
                      <Money cents={view.totals.transferOut} />
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
