import { type CaixaDetail, type CardOverview, formatDate, t } from '@moneyflow/shared';
import { CreditCard, Gauge, List, Lock, Plus, Receipt, ShoppingBag, Upload, Users, Wallet } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUser } from '../../lib/auth';
import { useRegisterCommands } from '../../lib/commands';
import { useApi } from '../../lib/hooks';
import { type CaixaTab, caixaTab } from '../../lib/links';
import { MembersTab } from '../caixa/MembersTab';
import { LoadError, Money } from '../domain';
import { StatementImportPanel } from '../reconciliation/StatementImportPanel';
import { Button, Skel, Tabs } from '../ui';
import { type CardAction, InvoicesTab, LimitTab, OpenInvoiceTab } from './CardTabs';
import { AdvanceModal, CloseInvoiceModal, InvoiceDatesModal } from './InvoiceModals';
import { ChargeModal, PurchaseFormModal } from './PurchaseFormModal';
import { PurchasesTab } from './PurchasesTab';
import { monthLabel } from './shared';
import '../../styles/card.css';

const TABS = ['invoice', 'invoices', 'purchases', 'limit', 'import', 'members'] as const;
type Tab = (typeof TABS)[number];

/** Caixa de cartão: resumo do limite e da fatura aberta, e as abas da spec 007. */
export function CardCaixaView({ caixa, tab: rawTab, onChanged }: { caixa: CaixaDetail; tab: string | undefined; onChanged: () => void }) {
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'invoice';
  const navigate = useNavigate();
  const { data: overview, error, reload } = useApi<CardOverview>(`/api/cards/${caixa.id}`);
  const [action, setAction] = useState<CardAction | null>(null);
  const [version, setVersion] = useState(0);
  const canWrite = caixa.canWrite && !caixa.archivedAt;
  const user = useUser();
  // Antecipar sai de uma conta da pagadora: basta editar alguma caixa.
  const canAdvance = user.role === 'admin' || user.memberships.some((m) => m.role === 'editor');
  const open = overview?.openInvoice ?? null;
  const defaultPayerId = caixa.card?.defaultPayerCaixaId ?? overview?.settings.defaultPayerCaixaId ?? '';

  const refresh = () => {
    void reload();
    setVersion((v) => v + 1);
    onChanged();
  };
  const done = () => {
    setAction(null);
    refresh();
  };

  useRegisterCommands(
    [
      ...(canWrite
        ? [
            {
              id: 'card-new-purchase',
              label: t.card.newPurchaseIn(caixa.name),
              group: 'Criar' as const,
              icon: <Plus />,
              run: () => setAction('purchase'),
            },
            {
              id: 'card-close-invoice',
              label: `${t.card.closeInvoice} ${open ? monthLabel(open.referenceMonth) : ''} · ${caixa.name}`,
              group: 'Recurso' as const,
              icon: <Lock />,
              disabled: open ? (false as const) : t.card.noOpenInvoice,
              run: () => setAction('close'),
            },
          ]
        : []),
      {
        id: 'card-invoices',
        label: `${t.card.goInvoices} · ${caixa.name}`,
        group: 'Ir para' as const,
        icon: <Receipt />,
        run: () => navigate(caixaTab(caixa.id, 'invoices')),
      },
      {
        id: 'card-purchases',
        label: `${caixa.name} › ${t.card.tabs.purchases}`,
        group: 'Ir para' as const,
        icon: <ShoppingBag />,
        run: () => navigate(caixaTab(caixa.id, 'purchases')),
      },
    ],
    [caixa.id, caixa.name, canWrite, open?.id],
  );

  const items: { key: Tab; icon: ReactNode; count?: number }[] = [
    { key: 'invoice', icon: <Receipt /> },
    { key: 'invoices', icon: <List />, count: overview?.invoices.length },
    { key: 'purchases', icon: <ShoppingBag /> },
    { key: 'limit', icon: <Gauge /> },
    { key: 'import', icon: <Upload /> },
    { key: 'members', icon: <Users /> },
  ];

  return (
    <>
      {error && <LoadError error={error} onRetry={() => void reload()} />}
      {!overview && !error && (
        <div className="stat-tiles">
          {[0, 1, 2, 3].map((i) => (
            <Skel key={i} h={68} />
          ))}
        </div>
      )}
      {overview && (
        <>
          <p className="card-meta">
            <CreditCard className="size-4" /> {t.card.endingIn(overview.settings.cardLast4)} · {t.card.closingDay}{' '}
            {overview.settings.closingDay} · {t.card.dueDay} {overview.settings.dueDay} · {t.card.payer}:{' '}
            <Link className="link" to={`/caixas/${overview.settings.defaultPayerCaixaId}`}>
              {overview.settings.defaultPayerName}
            </Link>
          </p>
          <div className="stat-tiles">
            <Link to={caixaTab(caixa.id, 'limit')} className="stat-tile">
              <div className="v">
                <Money cents={overview.creditLimitCents} />
              </div>
              <div className="k">
                <CreditCard /> {t.card.creditLimit.toLowerCase()}
              </div>
            </Link>
            <Link to={caixaTab(caixa.id, 'limit')} className="stat-tile">
              <div className="v">
                <Money cents={overview.usedCents} />
              </div>
              <div className="k">
                <Gauge /> {t.card.used.toLowerCase()}
              </div>
            </Link>
            <Link to={caixaTab(caixa.id, 'limit')} className="stat-tile">
              <div className="v">
                <Money cents={overview.availableCents} className={overview.availableCents < 0 ? 'out' : undefined} />
              </div>
              <div className="k">
                <Wallet /> {t.card.available.toLowerCase()}
              </div>
            </Link>
            <Link to={caixaTab(caixa.id, 'invoice')} className="stat-tile">
              <div className="v">{open ? <Money cents={open.totalCents} /> : '—'}</div>
              <div className="k">
                <Receipt /> {t.card.openInvoice.toLowerCase()}
                {open ? ` ${monthLabel(open.referenceMonth)} · ${t.card.dueOn(formatDate(open.dueDate))}` : ''}
              </div>
            </Link>
          </div>
          {open?.closeSuggested && (
            <div className="notice warn mb-4 flex flex-wrap items-center gap-3">
              <span className="flex-1">{t.card.closeSuggested}</span>
              {canWrite && (
                <Button size="sm" onClick={() => setAction('close')}>
                  <Lock /> {t.card.closeInvoice}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <Tabs
        value={tab}
        items={items.map((item) => ({
          key: item.key,
          label: t.card.tabs[item.key],
          icon: item.icon,
          count: item.count,
          to: caixaTab(caixa.id, item.key as CaixaTab),
        }))}
      />

      {overview && tab === 'invoice' && (
        <OpenInvoiceTab
          overview={overview}
          canWrite={canWrite}
          canAdvance={canAdvance}
          version={version}
          onAction={setAction}
          onChanged={refresh}
        />
      )}
      {overview && tab === 'invoices' && <InvoicesTab overview={overview} />}
      {tab === 'purchases' && (
        <PurchasesTab
          cardCaixaId={caixa.id}
          cardName={caixa.name}
          canWrite={canWrite}
          onNew={() => setAction('purchase')}
          version={version}
          onChanged={refresh}
        />
      )}
      {overview && tab === 'limit' && <LimitTab overview={overview} />}
      {tab === 'import' && <StatementImportPanel caixaId={caixa.id} cardCaixaId={caixa.id} canWrite={canWrite} onChanged={refresh} />}
      {tab === 'members' && <MembersTab caixa={caixa} />}

      {action === 'purchase' && (
        <PurchaseFormModal cardCaixaId={caixa.id} defaultPayerId={defaultPayerId} onClose={() => setAction(null)} onSaved={done} />
      )}
      {action === 'charge' && (
        <ChargeModal cardCaixaId={caixa.id} defaultPayerId={defaultPayerId} onClose={() => setAction(null)} onSaved={done} />
      )}
      {action === 'close' && open && <CloseInvoiceModal invoiceId={open.id} onClose={() => setAction(null)} onDone={done} />}
      {action === 'advance' && open && (
        <AdvanceModal invoice={open} defaultPayerId={defaultPayerId} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === 'dates' && open && <InvoiceDatesModal invoice={open} onClose={() => setAction(null)} onDone={done} />}
    </>
  );
}
