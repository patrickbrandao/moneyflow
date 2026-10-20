import { type CalendarItem, type DailyBalance, formatAccounting, formatDate, t } from '@moneyflow/shared';
import { type DragEvent, type MouseEvent, useState } from 'react';
import { negClass } from '../domain';
import { cx } from '../ui';
import { dayNumber, daysBetween } from './dates';

/** Um título só é arrastável se for título (não previsão de fatura), com escrita e ainda não pago. */
export const isMovable = (item: CalendarItem) => item.canReschedule && item.calendarStatus !== 'paid';

export type ItemOpen = (item: CalendarItem, anchor: HTMLElement) => void;
export type ItemDrop = (key: string, day: string) => void;

const DRAG_TYPE = 'application/x-moneyflow-calendar';

export function CalendarChip({
  item,
  full,
  onOpen,
  dragging,
  onDragState,
}: {
  item: CalendarItem;
  full?: boolean;
  onOpen: ItemOpen;
  dragging?: boolean;
  onDragState?: (key: string | null) => void;
}) {
  const movable = isMovable(item);
  const status = t.calendar.statuses[item.calendarStatus];
  const label = `${item.description} · ${formatAccounting(item.amountCents)} · ${status}`;
  return (
    <button
      type="button"
      className={cx(
        'cal-item',
        `s-${item.calendarStatus}`,
        item.itemKind === 'card_invoice' && 'forecast',
        full && 'full',
        dragging && 'dragging',
      )}
      title={movable ? `${label}\n${t.calendar.dragHint}` : label}
      aria-label={label}
      draggable={movable}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, item.key);
        event.dataTransfer.setData('text/plain', item.description);
        event.dataTransfer.effectAllowed = 'move';
        onDragState?.(item.key);
      }}
      onDragEnd={() => onDragState?.(null)}
      onClick={(event: MouseEvent<HTMLButtonElement>) => onOpen(item, event.currentTarget)}
    >
      <span className="d">{item.description}</span>
      <span className={cx('v', negClass(item.amountCents))}>{formatAccounting(item.amountCents)}</span>
      {full && <span className="sub">{[item.entityName, item.caixaName].filter(Boolean).join(' · ')}</span>}
    </button>
  );
}

/** Saldo do dia, discreto: realizado no passado/hoje, projetado no futuro. */
export function DayBalance({ balance, today }: { balance: DailyBalance | undefined; today: string }) {
  if (!balance) return null;
  const future = balance.day > today;
  const value = future ? balance.projectedCents : (balance.realizedCents ?? balance.projectedCents);
  if (value === null) return null;
  const tip = t.calendar.balanceTip(
    balance.realizedCents === null ? '—' : formatAccounting(balance.realizedCents),
    formatAccounting(balance.scheduledCents),
    balance.projectedCents === null ? '—' : formatAccounting(balance.projectedCents),
  );
  return (
    <div className={cx('cal-bal', value < 0 && 'neg', future && 'future')} title={tip}>
      <span className="sr-only">{future ? t.calendar.projected : t.calendar.realized}: </span>
      {formatAccounting(value)}
    </div>
  );
}

const MONTH_LIMIT = 3;

/** Grade de mês (semanas inteiras) ou de semana, com soltar para reagendar. */
export function CalendarGrid({
  from,
  to,
  month,
  today,
  week,
  itemsByDay,
  balances,
  onOpen,
  onDrop,
}: {
  from: string;
  to: string;
  /** 'YYYY-MM' do mês em foco (dias fora dele ficam esmaecidos). */
  month: string | null;
  today: string;
  week?: boolean;
  itemsByDay: Map<string, CalendarItem[]>;
  balances: Map<string, DailyBalance>;
  onOpen: ItemOpen;
  onDrop: ItemDrop;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const days = daysBetween(from, to);

  const dropHandlers = (day: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (over !== day) setOver(day);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === day ? null : current));
    },
    onDrop: (event: DragEvent) => {
      const key = event.dataTransfer.getData(DRAG_TYPE);
      setOver(null);
      setDragging(null);
      if (!key) return;
      event.preventDefault();
      onDrop(key, day);
    },
  });

  return (
    <div className={cx('cal-grid', week && 'week')}>
      {t.calendar.weekdays.map((name) => (
        <div key={name} className="cal-wd">
          {name}
        </div>
      ))}
      {days.map((day) => {
        const items = itemsByDay.get(day) ?? [];
        const open = week || expanded.has(day);
        const shown = open ? items : items.slice(0, MONTH_LIMIT);
        const hidden = items.length - shown.length;
        return (
          <div
            key={day}
            className={cx('cal-day', month && !day.startsWith(month) && 'out', day === today && 'today', over === day && 'over')}
            {...dropHandlers(day)}
          >
            <div className="cal-head">
              <span className="cal-num">
                {dayNumber(day)}
                <span className="sr-only"> · {formatDate(day)}</span>
              </span>
            </div>
            <div className="cal-items">
              {shown.map((item) => (
                <CalendarChip
                  key={item.key}
                  item={item}
                  full={week}
                  onOpen={onOpen}
                  dragging={dragging === item.key}
                  onDragState={setDragging}
                />
              ))}
            </div>
            {!week && (hidden > 0 || (open && items.length > MONTH_LIMIT)) && (
              <button
                type="button"
                className="cal-more"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(day)) next.delete(day);
                    else next.add(day);
                    return next;
                  })
                }
              >
                {hidden > 0 ? t.calendar.more(hidden) : t.calendar.less}
              </button>
            )}
            <DayBalance balance={balances.get(day)} today={today} />
          </div>
        );
      })}
    </div>
  );
}
