import { type CardOverview, formatAccounting, formatDate, type InvoiceDetail, t } from '@moneyflow/shared';
import { CalendarClock, CircleDollarSign, Lock, Plus, Receipt } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { invoiceLink } from '../../lib/links';
import { useParamState } from '../../lib/params';
import { LoadError, Money } from '../domain';
import { Button, EmptyRow, EmptyState } from '../ui';
import { PurchaseDrawer } from './PurchaseDrawer';
import { InvoiceLinesTable, InvoiceStatusBadge, monthLabel, PayerTotalsTable, useReloadOn } from './shared';

export type CardAction = 'purchase' | 'charge' | 'close' | 'advance' | 'dates';

/* ---------------- fatura aberta ---------------- */

export function OpenInvoiceTab({
  overview,
  canWrite,
  canAdvance,
  version,
  onAction,
  onChanged,
}: {
  overview: CardOverview;
  canWrite: boolean;
  canAdvance: boolean;
  version: number;
  onAction: (action: CardAction) => void;
  onChanged: () => void;
}) {
  const open = overview.openInvoice;
  const { data: invoice, error, reload } = useApi<InvoiceDetail>(open ? `/api/card-invoices/${open.id}` : null);
  useReloadOn(version, reload);
  const [purchaseId, setPurchaseId] = useParamState('purchase');

  if (!open) {
    return (
      <EmptyState
        icon={<Receipt />}
        title={t.card.noOpenInvoice}
        action={
          canWrite && (
            <Button onClick={() => onAction('purchase')}>
              <Plus /> {t.card.newPurchase}
            </Button>
          )
        }
      />
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="row-title">
          {t.card.invoice} {monthLabel(open.referenceMonth)}
        </span>
        <InvoiceStatusBadge status={open.status} />
        <span className="text-[13px] text-muted">
          {t.card.closesOn(formatDate(open.closingDate))} · {t.card.dueOn(formatDate(open.dueDate))}
        </span>
        {canWrite && (
          <Button size="sm" variant="quiet" onClick={() => onAction('dates')}>
            <CalendarClock /> {t.card.editDates}
          </Button>
        )}
        <span className="flex-1" />
        {canWrite && (
          <>
            <Button onClick={() => onAction('purchase')}>
              <Plus /> {t.card.newPurchase}
            </Button>
            <Button variant="ghost" onClick={() => onAction('charge')}>
              <Plus /> {t.card.newCharge}
            </Button>
            <Button variant="ghost" onClick={() => onAction('close')}>
              <Lock /> {t.card.closeInvoice}
            </Button>
          </>
        )}
        {canAdvance && (
          <Button variant="ghost" onClick={() => onAction('advance')}>
            <CircleDollarSign /> {t.card.advance}
          </Button>
        )}
      </div>

      {error && <LoadError error={error} onRetry={() => void reload()} />}
      {invoice && invoice.payers.length > 0 && (
        <div className="mb-4">
          <p className="eyebrow mb-2">{t.card.payers}</p>
          <PayerTotalsTable payers={invoice.payers} />
        </div>
      )}
      {!error && <InvoiceLinesTable lines={invoice?.lines} onOpenPurchase={setPurchaseId} />}

      {purchaseId && (
        <PurchaseDrawer
          key={purchaseId}
          purchaseId={purchaseId}
          onClose={() => setPurchaseId(null)}
          onChanged={() => {
            void reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

/* ---------------- faturas ---------------- */

export function InvoicesTab({ overview }: { overview: CardOverview }) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{t.card.competence}</th>
            <th>{t.card.closingDate}</th>
            <th>{t.card.dueDate}</th>
            <th className="num">{t.card.total}</th>
            <th className="num">{t.card.paid}</th>
            <th className="num">{t.card.open}</th>
            <th className="num">{t.card.carried}</th>
            <th>{t.card.status}</th>
          </tr>
        </thead>
        <tbody>
          {overview.invoices.length === 0 && <EmptyRow colSpan={8}>{t.card.noInvoices}</EmptyRow>}
          {overview.invoices.map((inv) => (
            <tr key={inv.id} className="cursor-pointer" onClick={() => navigate(invoiceLink(inv.id))}>
              <td>
                <Link className="link mono" to={invoiceLink(inv.id)} onClick={(e) => e.stopPropagation()}>
                  {monthLabel(inv.referenceMonth)}
                </Link>
              </td>
              <td className="mono text-xs">{formatDate(inv.closingDate)}</td>
              <td className="mono text-xs">{formatDate(inv.dueDate)}</td>
              <td className="num">
                <Money cents={inv.totalCents} />
              </td>
              <td className="num">
                <Money cents={inv.settledCents} muted={inv.settledCents === 0} />
              </td>
              <td className="num">
                <Money cents={inv.openCents} muted={inv.openCents === 0} />
              </td>
              <td className="num">
                <Money cents={inv.carriedOutCents} muted={inv.carriedOutCents === 0} />
              </td>
              <td>
                <InvoiceStatusBadge status={inv.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- limite ---------------- */

export function LimitTab({ overview }: { overview: CardOverview }) {
  const limit = overview.creditLimitCents;
  const pct = (cents: number) => (limit > 0 ? Math.min(100, Math.max(0, (cents / limit) * 100)) : 0);
  const max = Math.max(1, ...overview.committed.map((c) => c.amountCents));
  return (
    <div className="grid gap-6">
      <section className="panel">
        <p className="text-[13px] text-muted">{t.card.limitIntro}</p>
        <div
          className="card-meter mt-3"
          role="meter"
          aria-label={t.card.used}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={overview.usedCents}
        >
          <span style={{ width: `${pct(overview.usedCents)}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-[13px]">
          <span>
            {t.card.used}: <Money cents={overview.usedCents} /> ({t.card.usedPct(Math.round(pct(overview.usedCents)))})
          </span>
          <span>
            {t.card.available}: <Money cents={overview.availableCents} /> · {t.card.creditLimit}: <Money cents={limit} />
          </span>
        </div>
      </section>

      <section className="panel">
        <h2 className="mb-3">{t.card.committed}</h2>
        {overview.committed.length === 0 ? (
          <p className="list-empty">{t.card.noCommitted}</p>
        ) : (
          <ul className="card-bars">
            {overview.committed.map((c) => (
              <li key={c.referenceMonth}>
                <span className="mono text-xs">{monthLabel(c.referenceMonth)}</span>
                <span className="bar" aria-hidden>
                  <span style={{ width: `${(c.amountCents / max) * 100}%` }} />
                </span>
                <span className="mono text-xs" title={formatAccounting(c.amountCents)}>
                  <Money cents={c.amountCents} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
