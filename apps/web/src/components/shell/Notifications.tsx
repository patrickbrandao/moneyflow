import { formatDateTime, type NotificationDto, type NotificationKind, type NotificationList, t } from '@moneyflow/shared';
import {
  AlertTriangle,
  Bell,
  Bot,
  BotMessageSquare,
  CalendarClock,
  CheckCheck,
  CreditCard,
  FileClock,
  Gauge,
  GitCompareArrows,
  Info,
  Repeat2,
  SendHorizontal,
} from 'lucide-react';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { cx, EmptyState, useClickOutside, usePolling } from '../ui';

const ICONS: Record<NotificationKind, ReactNode> = {
  agent_completed: <Bot className="ic info" />,
  agent_message: <Bot className="ic info" />,
  mirror_pending: <Repeat2 className="ic" />,
  mirror_disputed: <AlertTriangle className="ic" />,
  invoice_closed: <CreditCard className="ic info" />,
  due_reminder: <CalendarClock className="ic info" />,
  overdue: <AlertTriangle className="ic" />,
  card_limit: <CreditCard className="ic" />,
  reconciliation_divergence: <GitCompareArrows className="ic" />,
  message_failed: <SendHorizontal className="ic" />,
  system: <Info className="ic info" />,
  contract_notice_deadline: <FileClock className="ic" />,
  contract_ending: <FileClock className="ic info" />,
  // Só para o histórico: a renovação virou ação do contrato (spec 034).
  contract_renewal_pending: <Repeat2 className="ic" />,
  contract_charge_missing: <CreditCard className="ic" />,
  contract_readjustment: <CalendarClock className="ic info" />,
  ai_budget_alert: <Gauge className="ic" />,
  ai_awaiting_approval: <BotMessageSquare className="ic" />,
};

/**
 * O sino: as notificações do usuário (tabela notifications), criadas pelo
 * worker nos eventos (espelho aguardando aceite ou contestado, fatura
 * fechada, vencimentos, atrasados, limite do cartão, divergência de
 * conciliação, mensagem não enviada e, na F4, os agentes). Clicar marca como
 * lida e leva à tela; "marcar todas" zera o contador. Atualiza a cada minuto.
 */
export function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NotificationList | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const load = useCallback(async () => {
    const list = await api.get<NotificationList>('/api/notifications', { limit: 30 }).catch(() => null);
    if (list) setData(list);
  }, []);
  usePolling(load, 60_000);

  function toggle() {
    setOpen((o) => {
      if (!o) void load();
      return !o;
    });
  }

  async function openItem(item: NotificationDto) {
    close();
    if (!item.readAt) {
      setData((current) =>
        current
          ? {
              unread: Math.max(0, current.unread - 1),
              items: current.items.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)),
            }
          : current,
      );
      await api.post(`/api/notifications/${item.id}/read`).catch(() => null);
    }
    if (item.link) navigate(item.link);
  }

  async function readAll() {
    await api.post('/api/notifications/read-all').catch(() => null);
    void load();
  }

  const unread = data?.unread ?? 0;
  return (
    <div ref={ref} className="menu-anchor">
      <button
        type="button"
        className="icon-btn bell-btn"
        onClick={toggle}
        aria-expanded={open}
        title={t.notifications.bell}
        aria-label={`${t.notifications.bell}: ${t.notifications.unread(unread)}`}
      >
        <Bell />
        {unread > 0 && <span className="n">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif" role="dialog" aria-label={t.notifications.title}>
          <div className="nh">
            <span>{t.notifications.title}</span>
            {unread > 0 ? (
              <button type="button" className="notif-readall" onClick={() => void readAll()}>
                <CheckCheck /> {t.notifications.markAllRead}
              </button>
            ) : (
              <span className="text-xs font-normal text-faint">{t.notifications.unread(0)}</span>
            )}
          </div>
          <div className="nb">
            {data && data.items.length === 0 && (
              <EmptyState icon={<Bell />} title={t.notifications.empty} description={t.notifications.emptyHint} />
            )}
            {data?.items.map((item) => (
              <button key={item.id} type="button" className={cx('ni', !item.readAt && 'unread')} onClick={() => void openItem(item)}>
                {ICONS[item.kind] ?? ICONS.system}
                <span className="min-w-0 flex-1">
                  <span className="notif-title">{item.title}</span>
                  {item.body && <span className="notif-body">{item.body}</span>}
                  <span className="w">
                    {t.notifications.kinds[item.kind]} · {formatDateTime(item.createdAt)}
                  </span>
                </span>
                {!item.readAt && <span className="notif-dot" aria-label={t.notifications.markRead} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
