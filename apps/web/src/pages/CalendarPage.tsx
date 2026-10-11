import {
  type AccountRow,
  type CaixaSummary,
  type CalendarItem,
  type DailyBalance,
  formatDate,
  type TitleDetail,
  t,
  todayIso,
} from '@moneyflow/shared';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  List,
  Wallet,
} from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import '../styles/calendar.css';
import { useSearchParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { AuditHistory } from '../components/audit/AuditHistory';
import { AgendaView } from '../components/calendar/AgendaView';
import { CalendarGrid } from '../components/calendar/CalendarGrid';
import { asDate, asView, type CalendarView, shiftAnchor, VIEWS, viewLabel, viewRange } from '../components/calendar/dates';
import { ItemPopover } from '../components/calendar/ItemPopover';
import { LoadError, Money, PageHead } from '../components/domain';
import { SettlementModal } from '../components/titles/SettlementModal';
import { Button, Menu, Skel, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { useSetParams } from '../lib/params';

const VIEW_ICONS: Record<CalendarView, ReactNode> = {
  month: <CalendarDays />,
  week: <CalendarRange />,
  agenda: <List />,
};

/**
 * Calendário (spec 012): mês, semana e agenda; títulos e previsões de fatura
 * por vencimento, coloridos pela situação; filtro por caixa (na URL); arrastar
 * um título para outro dia reagenda (o espelho acompanha); o painel do item
 * baixa pelo SettlementModal; saldo por dia de uma caixa ou conta.
 */
export function CalendarPage() {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const today = todayIso();
  const view = asView(params.get('view'));
  const anchor = asDate(params.get('date'), today);
  const selected = useMemo(() => (params.get('caixas') ?? '').split(',').filter(Boolean), [params]);
  const balanceParam = params.get('balance'); // 'c:<caixaId>' | 'a:<accountId>'
  const { from, to } = viewRange(view, anchor);

  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  useAgentScreenContext({
    title: t.nav.calendar,
    filters: { view, date: anchor, from, to, caixas: selected.join(',') || null, balance: balanceParam },
  });
  const accounts = useApi<AccountRow[]>('/api/accounts');
  const itemsPath = `/api/calendar?from=${from}&to=${to}${selected.length ? `&caixaIds=${selected.join(',')}` : ''}`;
  const items = useApi<CalendarItem[]>(itemsPath);
  const balancePath = balanceParam
    ? `/api/calendar/balances?from=${from}&to=${to}&${balanceParam.startsWith('a:') ? 'accountId' : 'caixaId'}=${balanceParam.slice(2)}`
    : null;
  const balances = useApi<DailyBalance[]>(balancePath);

  const [popover, setPopover] = useState<{ item: CalendarItem; anchor: HTMLElement } | null>(null);
  const [settling, setSettling] = useState<TitleDetail | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const confirm = useConfirm();
  const { run, busy } = useAction();

  const go = useCallback((patch: Record<string, string | null>) => setParams(patch), [setParams]);
  const move = useCallback((step: 1 | -1) => go({ date: shiftAnchor(view, anchor, step) }), [go, view, anchor]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items.data ?? []) {
      const list = map.get(item.dueDate);
      if (list) list.push(item);
      else map.set(item.dueDate, [item]);
    }
    return map;
  }, [items.data]);
  const balanceByDay = useMemo(() => new Map((balances.data ?? []).map((b) => [b.day, b])), [balances.data]);

  const totals = useMemo(() => {
    const acc = { payable: 0, receivable: 0, overdue: 0, paid: 0 };
    for (const item of items.data ?? []) {
      if (item.calendarStatus === 'paid') acc.paid += item.amountCents;
      else {
        if (item.calendarStatus === 'overdue') acc.overdue += item.openCents;
        acc[item.direction] += item.openCents;
      }
    }
    return acc;
  }, [items.data]);

  const reloadItems = items.reload;
  const reloadBalances = balances.reload;
  const reloadAll = useCallback(() => {
    void reloadItems();
    void reloadBalances();
  }, [reloadItems, reloadBalances]);

  async function reschedule(key: string, day: string) {
    const item = items.data?.find((i) => i.key === key);
    if (!item?.titleId || item.dueDate === day) return;
    if (item.counterpartyCaixaId) {
      const ok = await confirm({
        title: t.calendar.rescheduleTitle(formatDate(day)),
        description: t.calendar.rescheduleMirror,
        confirmLabel: t.calendar.reschedule,
      });
      if (!ok) return;
    }
    const titleId = item.titleId;
    items.setData((current) => (current ?? []).map((i) => (i.key === key ? { ...i, dueDate: day } : i)));
    await run(() => api.patch<TitleDetail>(`/api/titles/${titleId}`, { dueDate: day }), t.calendar.rescheduled(formatDate(day)));
    reloadAll();
  }

  async function openSettle(item: CalendarItem) {
    if (!item.titleId) return;
    const titleId = item.titleId;
    const detail = await run(() => api.get<TitleDetail>(`/api/titles/${titleId}`));
    if (detail) {
      setPopover(null);
      setSettling(detail);
    }
  }

  useRegisterCommands(
    [
      { id: 'cal-prev', label: t.calendar.goPrev, group: 'Ir para', icon: <ChevronLeft />, run: () => move(-1) },
      { id: 'cal-next', label: t.calendar.goNext, group: 'Ir para', icon: <ChevronRight />, run: () => move(1) },
      { id: 'cal-today', label: t.calendar.goToday, group: 'Ir para', icon: <CalendarDays />, run: () => go({ date: null }) },
      ...VIEWS.map((v) => ({
        id: `cal-view-${v}`,
        label: t.calendar.switchView(t.calendar.views[v]!.toLowerCase()),
        group: 'Ir para' as const,
        icon: VIEW_ICONS[v],
        disabled: v === view ? t.calendar.views[v] : (false as const),
        run: () => go({ view: v === 'month' ? null : v }),
      })),
    ],
    [view, anchor],
  );

  const visibleCaixas = (caixas.data ?? []).filter((c) => !c.archivedAt);
  const toggleCaixa = (id: string) => {
    const next = selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id];
    go({ caixas: next.length ? next.join(',') : null });
  };

  return (
    <div className="page wide">
      <PageHead title={t.nav.calendar} sub={t.calendar.sub} />

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="v">{items.data ? <Money cents={totals.payable} /> : '—'}</div>
          <div className="k">
            <ArrowUpRight /> {t.calendar.totals.payable.toLowerCase()}
          </div>
        </div>
        <div className="stat-tile">
          <div className="v">{items.data ? <Money cents={totals.receivable} /> : '—'}</div>
          <div className="k">
            <ArrowDownLeft /> {t.calendar.totals.receivable.toLowerCase()}
          </div>
        </div>
        <div className="stat-tile">
          <div className="v">{items.data ? <Money cents={totals.overdue} className={totals.overdue ? 'out' : ''} /> : '—'}</div>
          <div className="k">
            <AlertTriangle /> {t.calendar.totals.overdue.toLowerCase()}
          </div>
        </div>
        <div className="stat-tile">
          <div className="v">{items.data ? <Money cents={totals.paid} /> : '—'}</div>
          <div className="k">
            <CheckCircle2 /> {t.calendar.totals.paid.toLowerCase()}
          </div>
        </div>
      </div>

      <div className="cal-toolbar">
        <div className="segmented" role="group" aria-label={t.calendar.view}>
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={view === v ? 'active' : ''}
              aria-pressed={view === v}
              onClick={() => go({ view: v === 'month' ? null : v })}
            >
              {VIEW_ICONS[v]} {t.calendar.views[v]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="icon-btn" onClick={() => move(-1)} aria-label={t.calendar.previous} title={t.calendar.previous}>
            <ChevronLeft />
          </button>
          <Button size="sm" variant="ghost" onClick={() => go({ date: null })}>
            {t.calendar.today}
          </Button>
          <button type="button" className="icon-btn" onClick={() => move(1)} aria-label={t.calendar.next} title={t.calendar.next}>
            <ChevronRight />
          </button>
        </div>
        <span className="cal-label" aria-live="polite">
          {viewLabel(view, anchor)}
        </span>
        <span className="flex-1" />

        <Menu
          align="right"
          trigger={(props) => (
            <Button size="sm" variant="ghost" {...props}>
              <Wallet /> {selected.length ? t.calendar.caixasSelected(selected.length) : t.calendar.allCaixas} <ChevronDown />
            </Button>
          )}
        >
          <div className="cal-caixas" role="group" aria-label={t.calendar.caixas}>
            {visibleCaixas.map((c) => (
              <label key={c.id}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggleCaixa(c.id)} />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
            {selected.length > 0 && (
              <>
                <div className="sep" role="separator" />
                <button type="button" className="mi" onClick={() => go({ caixas: null })}>
                  {t.calendar.clearFilter}
                </button>
              </>
            )}
          </div>
        </Menu>

        <select
          className="field field-auto field-sm"
          value={balanceParam ?? ''}
          onChange={(e) => go({ balance: e.target.value || null })}
          aria-label={t.calendar.balance}
          title={t.calendar.balance}
        >
          <option value="">{t.calendar.balanceNone}</option>
          <optgroup label={t.calendar.balanceCaixa}>
            {visibleCaixas.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={t.calendar.balanceAccount}>
            {(accounts.data ?? [])
              .filter((a) => !a.archivedAt)
              .map((a) => (
                <option key={a.id} value={`a:${a.id}`}>
                  {a.caixaName} › {a.name}
                </option>
              ))}
          </optgroup>
        </select>
      </div>

      <div className="cal-legend mb-3">
        {(['payable', 'receivable', 'overdue', 'paid'] as const).map((s) => (
          <span key={s} className={`s-${s}`}>
            <i aria-hidden /> {t.calendar.statuses[s]}
          </span>
        ))}
        {balances.error && <span className="text-danger">{balances.error.message}</span>}
      </div>

      {items.error ? (
        <LoadError error={items.error} onRetry={() => void items.reload()} />
      ) : !items.data && items.loading ? (
        <Skel h={480} />
      ) : view === 'agenda' ? (
        <AgendaView
          from={from}
          to={to}
          today={today}
          itemsByDay={itemsByDay}
          balances={balanceByDay}
          showBalance={Boolean(balancePath)}
          onOpen={(item, el) => setPopover({ item, anchor: el })}
        />
      ) : (
        <CalendarGrid
          from={from}
          to={to}
          month={view === 'month' ? anchor.slice(0, 7) : null}
          today={today}
          week={view === 'week'}
          itemsByDay={itemsByDay}
          balances={balanceByDay}
          onOpen={(item, el) => setPopover({ item, anchor: el })}
          onDrop={(key, day) => void reschedule(key, day)}
        />
      )}

      {popover && (
        <ItemPopover
          key={popover.item.key}
          item={popover.item}
          anchor={popover.anchor}
          busy={busy}
          onClose={() => setPopover(null)}
          onSettle={(item) => void openSettle(item)}
          onHistory={(item) => {
            setPopover(null);
            setHistory(item.titleId);
          }}
        />
      )}
      {settling && (
        <SettlementModal
          title={settling}
          onClose={() => setSettling(null)}
          onSaved={() => {
            setSettling(null);
            reloadAll();
          }}
        />
      )}
      {history && <AuditHistory table="titles" recordId={history} title={t.audit.titleHistory} onClose={() => setHistory(null)} />}
    </div>
  );
}
