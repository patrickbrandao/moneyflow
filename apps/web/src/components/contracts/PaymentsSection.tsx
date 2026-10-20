import {
  type ContractDetail,
  type ContractPaymentRow,
  type ContractPaymentsDto,
  type ExportTable,
  exportFileName,
  formatDate,
  formatMonth,
  t,
  titleLink,
  todayIso,
} from '@moneyflow/shared';
import { BarChart3, Timer } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { MonthColumns } from '../caixa/account-charts';
import { LoadError, Money } from '../domain';
import { ExportMenu } from '../ExportMenu';
import { EmptyRow, Panel, Skel } from '../ui';
import { PlannedAccountButton, PlannedAccountLabel } from './PlannedAccount';
import { DelayBars } from './payment-charts';

const C = t.contracts;
const P = C.payments;

/**
 * Pagamentos do contrato (spec 033): valores por mês (previsto × pago, com
 * encargos e desconto), o atraso ou adiantamento de cada parcela, o resumo e a
 * tabela com a conta prevista (trocável) e a origem da baixa. Filtro do ciclo:
 * o atual, um anterior ou todos.
 */
export function PaymentsSection({ contract, onChanged }: { contract: ContractDetail; onChanged: () => void }) {
  const navigate = useNavigate();
  const [cycleId, setCycleId] = useState<string>(contract.cycles[0]?.id ?? '');
  const payments = useApi<ContractPaymentsDto>(`/api/contracts/${contract.id}/payments${cycleId ? `?cycleId=${cycleId}` : ''}`);
  const data = payments.data;
  const paidLabel = contract.direction === 'receivable' ? P.paidReceivable : P.paidPayable;

  const reload = () => {
    void payments.reload();
    onChanged();
  };

  return (
    <div className="grid gap-4" data-testid="contract-payments">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select className="field field-auto" value={cycleId} onChange={(e) => setCycleId(e.target.value)} aria-label={P.cycle}>
          {contract.cycles.map((cycle, i) => (
            <option key={cycle.id} value={cycle.id}>
              {i === 0 ? `${P.currentCycle} · ` : ''}
              {C.cycleLabel(cycle.seq)} · {C.cycleRange(formatDate(cycle.startsOn), formatDate(cycle.endsOn))}
            </option>
          ))}
          <option value="">{P.allCycles}</option>
        </select>
        <ExportMenu disabled={!data} build={() => paymentsTable(contract, data!, paidLabel)} />
      </div>
      {payments.error && <LoadError error={payments.error} onRetry={() => void payments.reload()} />}
      {!data && !payments.error && <Skel className="h-40" />}
      {data && (
        <>
          <Summary data={data} />
          <Panel title={P.byMonth} icon={<BarChart3 />}>
            <p className="hint mb-2">{P.byMonthHint}</p>
            <MonthColumns
              months={data.months.map((m) => m.month)}
              series={[
                { key: 'planned', label: P.planned, color: 'var(--chart-1)', values: data.months.map((m) => m.plannedCents) },
                { key: 'paid', label: paidLabel, color: 'var(--chart-2)', values: data.months.map((m) => m.paidCents) },
                { key: 'charges', label: P.charges, color: 'var(--chart-3)', values: data.months.map((m) => m.chargesCents) },
                { key: 'discount', label: P.discount, color: 'var(--chart-4)', values: data.months.map((m) => m.discountCents) },
              ]}
              label={P.byMonth}
              testId="contract-payments-months"
            />
          </Panel>
          <Panel title={P.delay} icon={<Timer />}>
            <p className="hint mb-2">{P.delayHint}</p>
            <DelayBars
              label={P.delay}
              testId="contract-payments-delay"
              bars={data.rows
                .filter((r) => r.days !== null)
                .map((r) => ({
                  key: r.titleId,
                  label: `${r.installment}`,
                  days: r.days!,
                  overdue: r.overdue,
                  tip: `${r.installment}/${r.installmentsCount} · ${formatMonth(r.competenceDate)} · ${formatDate(r.dueDate)}`,
                }))}
            />
          </Panel>
          <div className="table-wrap">
            <table className="data" aria-label={P.tab}>
              <thead>
                <tr>
                  <th>{P.columns.installment}</th>
                  <th>{P.columns.month}</th>
                  <th>{P.columns.due}</th>
                  <th className="num">{P.columns.amount}</th>
                  <th className="num">{P.columns.paid}</th>
                  <th>{P.columns.paidOn}</th>
                  <th className="num">{P.columns.days}</th>
                  <th>{P.columns.account}</th>
                  <th>{P.columns.planned}</th>
                  <th>{P.columns.origin}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <EmptyRow colSpan={10}>{P.empty}</EmptyRow>}
                {data.rows.map((row) => (
                  <tr
                    key={row.titleId}
                    className="cursor-pointer"
                    data-testid="payment-row"
                    onClick={() => navigate(titleLink({ id: row.titleId, caixaId: contract.caixaId, direction: contract.direction }))}
                  >
                    <td className="mono">
                      {row.installment}/{row.installmentsCount}
                    </td>
                    <td className="mono">{formatMonth(row.competenceDate)}</td>
                    <td className="mono">{formatDate(row.dueDate)}</td>
                    <td className="num">
                      <Money cents={row.amountCents} />
                    </td>
                    <td className="num">
                      <Money cents={row.cashCents} muted={row.cashCents === 0} />
                    </td>
                    <td className="mono">{row.lastSettledOn ? formatDate(row.lastSettledOn) : '—'}</td>
                    <td className={`num mono whitespace-nowrap${row.overdue ? ' text-danger' : ''}`} data-testid="payment-days">
                      {P.days(row.days)}
                    </td>
                    <td>{row.accountName ?? '—'}</td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <PlannedAccountLabel planned={row} />
                        {contract.canWrite && (row.status === 'open' || row.status === 'partial') && (
                          <PlannedAccountButton title={{ ...row, caixaId: contract.caixaId }} onSaved={reload} />
                        )}
                      </span>
                    </td>
                    <td>{row.lastOrigin ? P.origins[row.lastOrigin] : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Summary({ data }: { data: ContractPaymentsDto }) {
  const s = data.summary;
  const tiles: { label: string; value: React.ReactNode }[] = [
    { label: P.onTime, value: s.onTimePercent === null ? '—' : `${s.onTimePercent}%` },
    { label: P.avgDelay, value: s.avgDelayDays === null ? '—' : P.daysUnit(s.avgDelayDays) },
    { label: P.maxDelay, value: s.maxDelayDays === null ? '—' : P.daysUnit(s.maxDelayDays) },
    { label: P.totalCharges, value: <Money cents={s.chargesCents} muted={s.chargesCents === 0} /> },
    { label: P.totalDiscount, value: <Money cents={s.discountCents} muted={s.discountCents === 0} /> },
    { label: P.openCount, value: String(s.open) },
    { label: P.overdueCount, value: String(s.overdue) },
  ];
  return (
    <div className="stat-tiles" aria-label={P.tab} data-testid="contract-payments-summary">
      {tiles.map((tile) => (
        <div key={tile.label} className="stat-tile">
          <div className="v">{tile.value}</div>
          <div className="k">{tile.label}</div>
        </div>
      ))}
    </div>
  );
}

function paymentsTable(contract: ContractDetail, data: ContractPaymentsDto, paidLabel: string): ExportTable {
  const H = P.columns;
  return {
    fileName: exportFileName(`${P.exportName}-${contract.name}`, todayIso()),
    title: `${contract.name} · ${P.tab}`,
    subtitle: [contract.entityName],
    columns: [
      { key: 'installment', label: H.installment },
      { key: 'month', label: H.month },
      { key: 'due', label: H.due, type: 'date' },
      { key: 'amount', label: H.amount, type: 'money' },
      { key: 'paid', label: paidLabel, type: 'money' },
      { key: 'charges', label: P.charges, type: 'money' },
      { key: 'discount', label: P.discount, type: 'money' },
      { key: 'paidOn', label: H.paidOn, type: 'date' },
      { key: 'days', label: H.days },
      { key: 'account', label: H.account },
      { key: 'planned', label: H.planned },
      { key: 'origin', label: H.origin },
    ],
    rows: data.rows.map((r: ContractPaymentRow) => ({
      installment: `${r.installment}/${r.installmentsCount}`,
      month: formatMonth(r.competenceDate),
      due: r.dueDate,
      amount: r.amountCents,
      paid: r.cashCents,
      charges: r.fineCents + r.interestCents,
      discount: r.discountCents,
      paidOn: r.lastSettledOn,
      days: r.days,
      account: r.accountName,
      planned: r.plannedAccountName,
      origin: r.lastOrigin ? P.origins[r.lastOrigin] : null,
    })),
  };
}
