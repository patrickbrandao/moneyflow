import {
  daysInMonth,
  formatDate,
  isoWeekday,
  NOTE_KIND_ORDER,
  type NoteCalendarDay,
  type NoteKind,
  type NoteKindCounts,
  t,
  todayIso,
  toIso,
} from '@moneyflow/shared';
import { ChevronLeft, ChevronRight, CornerLeftUp } from 'lucide-react';
import { useMemo } from 'react';
import { useApi } from '../../lib/hooks';
import { cx } from '../ui';
import { countsText, NoteKindDot } from './kinds';

/*
 * Calendário das anotações (spec 035): a visão anual (12 mini-meses) e a
 * mensal, com uma bolinha por tipo presente no dia (nunca o texto da nota) e
 * as contagens no tooltip. Clicar no dia seleciona; no nome do mês, abre o mês.
 */

export type NoteCalendarView = 'year' | 'month';

const U = t.notes.ui;
const capitalize = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const monthLabel = (month: number) => capitalize(t.calendar.months[month - 1] ?? '');

function DayDots({ counts, size }: { counts: NoteKindCounts | undefined; size?: 'lg' }) {
  if (!counts) return <span className="note-dots" />;
  const kinds = NOTE_KIND_ORDER.filter((kind) => (counts[kind] ?? 0) > 0) as NoteKind[];
  return (
    <span className="note-dots">
      {kinds.map((kind) => (
        <NoteKindDot key={kind} kind={kind} size={size} />
      ))}
    </span>
  );
}

function monthCells(year: number, month: number): (string | null)[] {
  const first = toIso(year, month, 1);
  const lead = isoWeekday(first) - 1;
  const total = daysInMonth(year, month);
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day += 1) cells.push(toIso(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function NoteCalendar({
  view,
  year,
  month,
  selectedDay,
  entityId,
  kinds,
  reloadKey,
  onSelectDay,
  onNavigate,
}: {
  view: NoteCalendarView;
  year: number;
  month: number;
  selectedDay: string | null;
  entityId?: string | null;
  kinds?: NoteKind[];
  reloadKey?: number;
  onSelectDay: (day: string) => void;
  onNavigate: (next: { view: NoteCalendarView; year: number; month: number }) => void;
}) {
  const from = view === 'year' ? toIso(year, 1, 1) : toIso(year, month, 1);
  const to = view === 'year' ? toIso(year, 12, 31) : toIso(year, month, daysInMonth(year, month));
  const qs = new URLSearchParams({ from, to });
  if (entityId) qs.set('entityId', entityId);
  if (kinds && kinds.length > 0) qs.set('kinds', kinds.join(','));
  qs.set('r', String(reloadKey ?? 0));
  const calendar = useApi<NoteCalendarDay[]>(`/api/notes/calendar?${qs}`);
  const byDay = useMemo(() => new Map((calendar.data ?? []).map((d) => [d.day, d.counts])), [calendar.data]);
  const today = todayIso();
  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7));

  const dayButton = (day: string, size?: 'lg') => {
    const counts = byDay.get(day);
    const text = counts ? countsText(counts) : '';
    const label = U.dayCounts(formatDate(day), text);
    return (
      <button
        key={day}
        type="button"
        className={cx('note-day', day === today && 'is-today', day === selectedDay && 'is-selected', counts && 'has-notes')}
        title={label}
        aria-label={label}
        aria-pressed={day === selectedDay}
        data-day={day}
        onClick={() => onSelectDay(day)}
      >
        <span className="num">{Number(day.slice(8, 10))}</span>
        <DayDots counts={counts} size={size} />
      </button>
    );
  };

  const weekdays = (
    <>
      {t.calendar.weekdays.map((w) => (
        <span key={w} className="note-wd" aria-hidden>
          {view === 'year' ? w.charAt(0) : w}
        </span>
      ))}
    </>
  );

  const shift = (step: 1 | -1) => {
    if (view === 'year') onNavigate({ view, year: year + step, month });
    else {
      const index = year * 12 + (month - 1) + step;
      onNavigate({ view, year: Math.floor(index / 12), month: (index % 12) + 1 });
    }
  };

  return (
    <div className="note-cal" data-view={view}>
      <div className="note-cal-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => shift(-1)}
          title={view === 'year' ? U.prevYear : U.prevMonth}
          aria-label={view === 'year' ? U.prevYear : U.prevMonth}
        >
          <ChevronLeft />
        </button>
        <h2 className="note-cal-title">{view === 'year' ? year : `${monthLabel(month)} de ${year}`}</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => shift(1)}
          title={view === 'year' ? U.nextYear : U.nextMonth}
          aria-label={view === 'year' ? U.nextYear : U.nextMonth}
        >
          <ChevronRight />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate({ view, year: todayYear, month: todayMonth })}>
          {U.today}
        </button>
        {view === 'month' && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => onNavigate({ view: 'year', year, month })}>
            <CornerLeftUp /> {U.backToYear}
          </button>
        )}
        <span className="note-legend" aria-hidden>
          {NOTE_KIND_ORDER.map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1">
              <NoteKindDot kind={kind} />
              {t.notes.kinds[kind]}
            </span>
          ))}
        </span>
      </div>
      {view === 'year' ? (
        <div className="note-year">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <section key={m} className="note-mini" aria-label={`${monthLabel(m)} de ${year}`}>
              <button
                type="button"
                className="note-mini-title"
                onClick={() => onNavigate({ view: 'month', year, month: m })}
                aria-label={U.openMonth(`${monthLabel(m)} de ${year}`)}
              >
                {monthLabel(m)}
              </button>
              <div className="note-grid">
                {weekdays}
                {monthCells(year, m).map((day, i) => (day ? dayButton(day) : <span key={`b${i}`} />))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="note-grid note-month">
          {weekdays}
          {monthCells(year, month).map((day, i) => (day ? dayButton(day, 'lg') : <span key={`b${i}`} />))}
        </div>
      )}
    </div>
  );
}
