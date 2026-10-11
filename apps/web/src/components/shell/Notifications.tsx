import { formatBRL, type Overview, t } from '@moneyflow/shared';
import { AlertTriangle, Bell, Info } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { titleLink } from '../../lib/links';
import { EmptyState, useClickOutside, usePolling } from '../ui';

type Notice = { id: string; text: string; to: string; tone: 'warn' | 'info' };

/**
 * O sino: pendências que pedem ação — espelhos aguardando aceite, baixas com
 * conta a definir e títulos vencidos por caixa —, cada uma com o link para a
 * tela que resolve. Atualiza a cada minuto com a aba visível.
 */
export function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const load = useCallback(async () => {
    const overview = await api.get<Overview>('/api/overview').catch(() => null);
    if (overview) setData(overview);
  }, []);
  usePolling(load, 60_000);

  const notices = useMemo<Notice[]>(() => {
    if (!data) return [];
    return [
      ...data.pendingMirrors.map((title) => ({
        id: `m-${title.id}`,
        tone: 'warn' as const,
        text: `${t.title.mirrorStatuses.pending}: ${title.description} · ${title.caixaName} · ${formatBRL(title.amountCents)}`,
        to: titleLink(title),
      })),
      ...data.pendingAccounts.map((title) => ({
        id: `a-${title.id}`,
        tone: 'warn' as const,
        text: `${t.title.pendingAccount}: ${title.description} · ${title.caixaName}`,
        to: titleLink(title),
      })),
      ...data.caixas
        .filter((caixa) => caixa.overdueCount > 0)
        .map((caixa) => ({
          id: `o-${caixa.id}`,
          tone: 'info' as const,
          text: `${caixa.overdueCount} vencido${caixa.overdueCount === 1 ? '' : 's'} em ${caixa.name} · ${formatBRL(caixa.overdueCents)}`,
          to: `/caixas/${caixa.id}/payables?status=overdue`,
        })),
    ];
  }, [data]);

  function toggle() {
    setOpen((o) => {
      if (!o) void load();
      return !o;
    });
  }

  return (
    <div ref={ref} className="menu-anchor">
      <button type="button" className="icon-btn bell-btn" onClick={toggle} aria-expanded={open} title="Pendências">
        <Bell />
        {notices.length > 0 && <span className="n">{notices.length > 99 ? '99+' : notices.length}</span>}
      </button>
      {open && (
        <div className="notif" role="dialog" aria-label="Pendências">
          <div className="nh">
            <span>Pendências</span>
            <span className="text-xs font-normal text-faint">
              {notices.length} pendente{notices.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="nb">
            {notices.length === 0 && (
              <EmptyState
                icon={<Bell />}
                title="Tudo em ordem"
                description="Nenhum espelho aguardando, nenhuma conta a definir e nada vencido."
              />
            )}
            {notices.map((notice) => (
              <Link key={notice.id} to={notice.to} className="ni" onClick={close}>
                {notice.tone === 'warn' ? <AlertTriangle className="ic" /> : <Info className="ic info" />}
                <span>{notice.text}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
