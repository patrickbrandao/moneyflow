import { formatDate, type InvoiceDetail, type InvoicePayerTotal, t } from '@moneyflow/shared';
import { CircleDollarSign, Lock, LockOpen, Receipt } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AdvanceModal, CloseInvoiceModal, PayInvoiceModal } from '../components/card/InvoiceModals';
import { PurchaseDrawer } from '../components/card/PurchaseDrawer';
import { InvoiceLinesTable, InvoiceStatusBadge, monthLabel, PayerTotalsTable } from '../components/card/shared';
import { LoadError, Money, PageHead } from '../components/domain';
import { useCrumbs } from '../components/shell/Layout';
import { TitleMiniTable } from '../components/TitleMiniTable';
import { Button, Skel, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { caixaTab, invoiceLink } from '../lib/links';
import { useParamState } from '../lib/params';
import '../styles/card.css';

/** Detalhe da fatura do cartão (spec 007): totais por pagadora, linhas até o recebedor final e as ações. */
export function InvoicePage() {
  const { id = '' } = useParams();
  const [payer] = useParamState('payer');
  const [purchaseId, setPurchaseId] = useParamState('purchase');
  const user = useUser();
  const navigate = useNavigate();
  const {
    data: invoice,
    error,
    reload,
  } = useApi<InvoiceDetail>(`/api/card-invoices/${id}${payer ? `?payerCaixaId=${encodeURIComponent(payer)}` : ''}`);
  const [modal, setModal] = useState<null | { kind: 'close' } | { kind: 'pay'; payerId?: string } | { kind: 'advance' }>(null);
  const confirm = useConfirm();
  const { run } = useAction();

  const canReadCard = Boolean(invoice && (user.role === 'admin' || user.memberships.some((m) => m.caixaId === invoice.cardCaixaId)));
  const month = invoice ? monthLabel(invoice.referenceMonth) : '';
  useCrumbs(
    invoice
      ? [
          { label: invoice.cardName, to: canReadCard ? caixaTab(invoice.cardCaixaId, 'invoices') : undefined },
          { label: `${t.card.invoice} ${month}` },
        ]
      : [],
  );

  const canClose = Boolean(invoice?.canWrite && invoice.status === 'open');
  const canReopen = Boolean(invoice?.canWrite && invoice.status !== 'open' && invoice.settledCents === 0);
  const payable = (invoice?.payers ?? []).filter((p) => p.canWritePayer && p.openCents > 0);
  const canPay = Boolean(invoice && invoice.status === 'closed' && payable.length > 0);
  const canAdvance = Boolean(
    invoice && invoice.status === 'open' && (user.role === 'admin' || user.memberships.some((m) => m.role === 'editor')),
  );

  async function reopen() {
    if (!invoice) return;
    const ok = await confirm({ title: t.card.reopenConfirm, description: t.card.reopenDescription, confirmLabel: t.card.reopenInvoice });
    if (ok && (await run(() => api.post(`/api/card-invoices/${invoice.id}/reopen`), t.card.reopened))) void reload();
  }

  const done = () => {
    setModal(null);
    void reload();
  };

  useRegisterCommands(
    invoice
      ? [
          ...(canClose
            ? [
                {
                  id: 'inv-close',
                  label: `${t.card.closeInvoice} ${month}`,
                  group: 'Recurso' as const,
                  icon: <Lock />,
                  run: () => setModal({ kind: 'close' }),
                },
              ]
            : []),
          ...(canPay
            ? [
                {
                  id: 'inv-pay',
                  label: `${t.card.payInvoice} ${month}`,
                  group: 'Recurso' as const,
                  icon: <CircleDollarSign />,
                  run: () => setModal({ kind: 'pay' }),
                },
              ]
            : []),
          ...(canReadCard
            ? [
                {
                  id: 'inv-go-invoices',
                  label: `${t.card.goInvoices} · ${invoice.cardName}`,
                  group: 'Ir para' as const,
                  icon: <Receipt />,
                  run: () => navigate(caixaTab(invoice.cardCaixaId, 'invoices')),
                },
              ]
            : []),
        ]
      : [],
    [invoice, canClose, canPay, canReadCard],
  );

  if (error) {
    return (
      <div className="page">
        <LoadError error={error} onRetry={() => void reload()} />
      </div>
    );
  }
  if (!invoice) {
    return (
      <div className="page wide">
        <Skel h={34} w={280} />
        <Skel h={18} w={200} className="mt-3" />
        <Skel h={260} className="mt-6" />
      </div>
    );
  }

  const filteredPayer = invoice.payerCaixaId ? invoice.payers.find((p) => p.payerCaixaId === invoice.payerCaixaId) : null;

  const payAction = (p: InvoicePayerTotal) =>
    invoice.status === 'closed' && p.canWritePayer && p.openCents > 0 ? (
      <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'pay', payerId: p.payerCaixaId })}>
        <CircleDollarSign /> {t.card.payInvoice}
      </Button>
    ) : null;

  return (
    <div className="page wide">
      <PageHead
        title={`${t.card.invoice} ${month}`}
        sub={
          <>
            {canReadCard ? (
              <Link className="link" to={caixaTab(invoice.cardCaixaId, 'invoice')}>
                {invoice.cardName}
              </Link>
            ) : (
              invoice.cardName
            )}{' '}
            · {invoice.issuerName}
          </>
        }
        actions={
          <>
            {canClose && (
              <Button onClick={() => setModal({ kind: 'close' })}>
                <Lock /> {t.card.closeInvoice}
              </Button>
            )}
            {canPay && (
              <Button onClick={() => setModal({ kind: 'pay' })}>
                <CircleDollarSign /> {t.card.payInvoice}
              </Button>
            )}
            {canAdvance && (
              <Button variant="ghost" onClick={() => setModal({ kind: 'advance' })}>
                <CircleDollarSign /> {t.card.advance}
              </Button>
            )}
            {canReopen && (
              <Button variant="ghost" onClick={() => void reopen()}>
                <LockOpen /> {t.card.reopenInvoice}
              </Button>
            )}
          </>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <InvoiceStatusBadge status={invoice.status} />
          <span className="invoice-facts">
            <span>
              {t.card.closingDate} <b className="mono">{formatDate(invoice.closingDate)}</b>
            </span>
            <span>
              {t.card.dueDate} <b className="mono">{formatDate(invoice.dueDate)}</b>
            </span>
          </span>
        </div>
      </PageHead>

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="v">
            <Money cents={invoice.totalCents} />
          </div>
          <div className="k">{t.card.total.toLowerCase()}</div>
        </div>
        <div className="stat-tile">
          <div className="v">
            <Money cents={invoice.settledCents} />
          </div>
          <div className="k">{t.card.paid.toLowerCase()}</div>
        </div>
        <div className="stat-tile">
          <div className="v">
            <Money cents={invoice.openCents} />
          </div>
          <div className="k">{t.card.open.toLowerCase()}</div>
        </div>
        <div className="stat-tile">
          <div className="v">
            <Money cents={invoice.carriedOutCents} muted={invoice.carriedOutCents === 0} />
          </div>
          <div className="k">{t.card.carried.toLowerCase()}</div>
        </div>
      </div>

      {invoice.closeSuggested && <p className="notice warn mb-4">{t.card.closeSuggested}</p>}
      {filteredPayer && (
        <p className="notice info mb-4">
          {t.card.filteredPayer(filteredPayer.payerCaixaName)}{' '}
          {canReadCard && (
            <Link className="link" to={invoiceLink(invoice.id)}>
              {t.card.showAllPayers}
            </Link>
          )}
        </p>
      )}

      {invoice.payers.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2">{t.card.payers}</h2>
          <PayerTotalsTable payers={invoice.payers} actions={payAction} />
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2">{t.card.tabs.purchases}</h2>
        <InvoiceLinesTable
          lines={invoice.lines}
          showPayer={!invoice.payerCaixaId}
          onOpenPurchase={canReadCard ? setPurchaseId : undefined}
        />
      </section>

      {invoice.titles.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2">{t.card.invoiceTitles}</h2>
          <TitleMiniTable rows={invoice.titles} empty="" />
        </section>
      )}

      {purchaseId && canReadCard && (
        <PurchaseDrawer key={purchaseId} purchaseId={purchaseId} onClose={() => setPurchaseId(null)} onChanged={() => void reload()} />
      )}
      {modal?.kind === 'close' && <CloseInvoiceModal invoiceId={invoice.id} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'pay' && (
        <PayInvoiceModal invoice={invoice} initialPayerId={modal.payerId ?? payer} onClose={() => setModal(null)} onDone={done} />
      )}
      {modal?.kind === 'advance' && (
        <AdvanceModal
          invoice={invoice}
          defaultPayerId={invoice.payerCaixaId ?? invoice.payers.find((p) => p.canWritePayer)?.payerCaixaId}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
    </div>
  );
}
