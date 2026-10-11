import { type CalendarItem, formatDate, t } from '@moneyflow/shared';
import { CircleDollarSign, CreditCard, ExternalLink, History, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { invoiceLink, titleLink } from '../../lib/links';
import { CategoryLabel, Money } from '../domain';
import { Badge, Button, useClickOutside } from '../ui';
import { CalendarStatusBadge } from './AgendaView';

/** Painel flutuante de um item do calendário: dados, links e "Baixar". */
export function ItemPopover({
  item,
  anchor,
  onClose,
  onSettle,
  onHistory,
  busy,
}: {
  item: CalendarItem;
  anchor: HTMLElement;
  onClose: () => void;
  onSettle: (item: CalendarItem) => void;
  onHistory: (item: CalendarItem) => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useClickOutside(ref, onClose);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    const width = box?.width ?? 340;
    const height = box?.height ?? 260;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 6) : below;
    setPos({ top, left });
  }, [anchor]);

  const canSettle = item.itemKind === 'title' && item.titleId && item.canWrite && item.openCents > 0 && item.calendarStatus !== 'paid';
  const invoiceTo = item.cardInvoiceId ? invoiceLink(item.cardInvoiceId, item.direction === 'payable' ? item.caixaId : null) : null;

  return createPortal(
    <div
      ref={ref}
      className="cal-pop"
      role="dialog"
      aria-label={item.description}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
    >
      <div className="flex items-center gap-2">
        <CalendarStatusBadge item={item} />
        <Badge tone="outline">{t.title.directions[item.direction]}</Badge>
        {item.itemKind === 'card_invoice' && <Badge tone="outline">{t.calendar.invoiceForecast}</Badge>}
        <span className="flex-1" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t.common.close}>
          <X />
        </button>
      </div>
      <p className="t">{item.description}</p>
      <p className="s">{[item.entityName, item.caixaName].filter(Boolean).join(' · ')}</p>
      <dl className="kv">
        <dt>{t.title.due}</dt>
        <dd className="mono">{formatDate(item.dueDate)}</dd>
        <dt>{t.title.amount}</dt>
        <dd>
          <Money cents={item.amountCents} />
        </dd>
        {item.openCents !== item.amountCents && (
          <>
            <dt>{t.title.open}</dt>
            <dd>
              <Money cents={item.openCents} />
            </dd>
          </>
        )}
        {item.categoryName && (
          <>
            <dt>{t.title.category}</dt>
            <dd>
              <CategoryLabel name={item.categoryName} slot={item.categoryColorSlot} />
            </dd>
          </>
        )}
      </dl>
      <div className="acts">
        {canSettle && (
          <Button size="sm" disabled={busy} onClick={() => onSettle(item)}>
            <CircleDollarSign /> {item.direction === 'payable' ? t.title.pay : t.title.receive}
          </Button>
        )}
        {item.titleId && (
          <Link className="btn btn-ghost btn-sm" to={titleLink({ id: item.titleId, caixaId: item.caixaId, direction: item.direction })}>
            <ExternalLink /> {t.calendar.openTitle}
          </Link>
        )}
        {invoiceTo && (
          <Link className="btn btn-ghost btn-sm" to={invoiceTo}>
            <CreditCard /> {t.calendar.openInvoice}
          </Link>
        )}
        {item.titleId && (
          <Button size="sm" variant="quiet" onClick={() => onHistory(item)}>
            <History /> {t.calendar.history}
          </Button>
        )}
      </div>
    </div>,
    document.body,
  );
}
