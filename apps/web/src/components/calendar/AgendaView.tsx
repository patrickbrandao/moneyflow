import { type CalendarItem, type DailyBalance, formatDate, t } from '@moneyflow/shared';
import { Fragment } from 'react';
import { CategoryLabel, Money } from '../domain';
import { Badge, cx, EmptyRow } from '../ui';
import type { ItemOpen } from './CalendarGrid';
import { daysBetween, weekdayName } from './dates';

const TONE = { payable: 'warn', receivable: 'info', paid: 'ok', overdue: 'danger' } as const;

export function CalendarStatusBadge({ item }: { item: CalendarItem }) {
  return <Badge tone={TONE[item.calendarStatus]}>{t.calendar.statuses[item.calendarStatus]}</Badge>;
}

function BalanceCells({ balance, today }: { balance: DailyBalance | undefined; today: string }) {
  if (!balance) return <td colSpan={3} />;
  const neg = (v: number | null) => v !== null && v < 0;
  return (
    <>
      <td className="num">
        {balance.realizedCents === null || balance.day > today ? (
          '—'
        ) : (
          <Money cents={balance.realizedCents} className={cx(neg(balance.realizedCents) && 'out')} />
        )}
      </td>
      <td className="num">{balance.scheduledCents ? <Money cents={balance.scheduledCents} signed /> : '—'}</td>
      <td className="num">
        {balance.projectedCents === null ? (
          '—'
        ) : (
          <Money cents={balance.projectedCents} className={cx(neg(balance.projectedCents) && 'out')} />
        )}
      </td>
    </>
  );
}

/** Lista por dia (agenda); com saldo escolhido, as colunas realizado/previsto/projetado na linha do dia. */
export function AgendaView({
  from,
  to,
  today,
  itemsByDay,
  balances,
  showBalance,
  onOpen,
}: {
  from: string;
  to: string;
  today: string;
  itemsByDay: Map<string, CalendarItem[]>;
  balances: Map<string, DailyBalance>;
  showBalance: boolean;
  onOpen: ItemOpen;
}) {
  // Sem saldo: só os dias com itens. Com saldo: todos os dias (o saldo muda mesmo sem vencimento).
  const days = daysBetween(from, to).filter((day) => itemsByDay.has(day) || (showBalance && balances.has(day)));
  const cols = showBalance ? 8 : 5;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{t.calendar.entry}</th>
            <th>{t.calendar.caixas}</th>
            <th>{t.title.category}</th>
            <th className="num">{t.title.amount}</th>
            <th>{t.common.status}</th>
            {showBalance && (
              <>
                <th className="num">{t.calendar.realized}</th>
                <th className="num">{t.calendar.scheduled}</th>
                <th className="num">{t.calendar.projected}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {days.length === 0 && <EmptyRow colSpan={cols}>{t.calendar.empty}</EmptyRow>}
          {days.map((day) => {
            const items = itemsByDay.get(day) ?? [];
            return (
              <Fragment key={day}>
                <tr className={cx('cal-dayrow', day === today && 'today')}>
                  <td colSpan={5}>
                    <span className="mono">{formatDate(day)}</span> · {weekdayName(day)}
                    {day === today && (
                      <Badge tone="accent" className="ml-2">
                        {t.calendar.today}
                      </Badge>
                    )}
                  </td>
                  {showBalance && <BalanceCells balance={balances.get(day)} today={today} />}
                </tr>
                {items.map((item) => (
                  <tr key={item.key} className="cursor-pointer" onClick={(event) => onOpen(item, event.currentTarget)}>
                    <td>
                      <span className={cx('row-title inline-flex items-center gap-2', `s-${item.calendarStatus}`)}>
                        <span className="cal-dot" aria-hidden />
                        {item.description}
                      </span>
                      <span className="row-sub">
                        {item.entityName ?? (item.itemKind === 'card_invoice' ? t.calendar.invoiceForecast : '')}
                      </span>
                    </td>
                    <td className="text-[13px] text-dim">{item.caixaName}</td>
                    <td>{item.categoryName ? <CategoryLabel name={item.categoryName} slot={item.categoryColorSlot} /> : '—'}</td>
                    <td className="num">
                      <Money cents={item.amountCents} />
                    </td>
                    <td>
                      <CalendarStatusBadge item={item} />
                    </td>
                    {showBalance && <td colSpan={3} />}
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
