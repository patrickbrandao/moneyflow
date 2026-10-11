import { type CardPurchaseDetail, formatBRL, formatDate, t, todayIso } from '@moneyflow/shared';
import { Pencil, Trash2, Undo2, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { entityLink, invoiceLink } from '../../lib/links';
import { CategoryLabel, LoadError, Money } from '../domain';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions, MoneyInput } from '../forms';
import { Badge, Button, Field, Modal, Skel, useConfirm } from '../ui';
import { PayerSelect } from './PurchaseFormModal';
import { monthLabel } from './shared';

/** Gaveta da compra: parcelas por fatura, estornos, editar, excluir e estornar. */
export function PurchaseDrawer({ purchaseId, onClose, onChanged }: { purchaseId: string; onClose: () => void; onChanged: () => void }) {
  const { data: p, error, reload, setData } = useApi<CardPurchaseDetail>(`/api/card-purchases/${purchaseId}`);
  const [modal, setModal] = useState<null | 'edit' | 'refund'>(null);
  const confirm = useConfirm();
  const { run } = useAction();

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modal) onClose();
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [onClose, modal]);

  const saved = (next: CardPurchaseDetail) => {
    setData(next);
    setModal(null);
    onChanged();
  };

  async function remove() {
    if (!p) return;
    const ok = await confirm({
      title: t.card.deleteConfirm,
      description: t.card.deleteDescription,
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (!ok) return;
    if (await run(() => api.del(`/api/card-purchases/${p.id}`), t.card.purchaseDeleted)) {
      onChanged();
      onClose();
    }
  }

  const refundable = p ? p.amountCents - p.refundedCents : 0;
  const isPurchase = p?.kind === 'purchase';

  return (
    <aside className="drawer page-drawer" aria-label={p?.description ?? t.card.purchase}>
      <div className="dh">
        <span className="t">{p?.description ?? t.common.loading}</span>
        <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)" aria-label={t.common.close}>
          <X />
        </button>
      </div>
      <div className="db">
        {error && <LoadError error={error} onRetry={() => void reload()} />}
        {!p && !error && <Skel h={160} />}
        {p && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={p.kind === 'refund' ? 'ok' : p.kind === 'charge' ? 'warn' : 'outline'}>
                {p.kind === 'charge' && p.chargeKind ? t.card.chargeKinds[p.chargeKind] : t.card.purchaseKinds[p.kind]}
              </Badge>
              {p.installmentsTotal > 1 && <Badge mono>{p.installmentsTotal}×</Badge>}
            </div>
            <div className="mt-3 text-[22px] font-semibold text-ink">
              <Money cents={p.kind === 'refund' ? -p.amountCents : p.amountCents} />
            </div>
            {isPurchase && p.refundedCents > 0 && (
              <p className="text-[13px] text-muted">
                {t.card.refunded}: <Money cents={p.refundedCents} /> · {t.card.notRefunded}: <Money cents={refundable} />
              </p>
            )}

            {p.canWrite && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setModal('edit')}>
                  <Pencil /> {t.common.edit}
                </Button>
                {isPurchase && refundable > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setModal('refund')}>
                    <Undo2 /> {t.card.refund}
                  </Button>
                )}
                {p.editable && p.refunds.length === 0 && (
                  <Button size="sm" variant="ghost" onClick={() => void remove()}>
                    <Trash2 /> {t.common.delete}
                  </Button>
                )}
              </div>
            )}

            <div className="sec">
              <p className="eyebrow">{t.common.details}</p>
              <dl className="kv">
                <dt>{t.card.finalPayee}</dt>
                <dd>
                  <Link className="link" to={entityLink(p.entityId)}>
                    {p.entityName}
                  </Link>
                </dd>
                <dt>{t.card.category}</dt>
                <dd>
                  <CategoryLabel name={p.categoryName} slot={p.categoryColorSlot} />
                </dd>
                <dt>{t.card.payer}</dt>
                <dd>{p.payerCaixaName}</dd>
                <dt>{t.card.purchasedOn}</dt>
                <dd className="mono">{formatDate(p.purchasedOn)}</dd>
                {p.firstInstallment > 1 && (
                  <>
                    <dt>{t.card.firstInstallment}</dt>
                    <dd className="mono">{p.firstInstallment}</dd>
                  </>
                )}
                {p.notes && (
                  <>
                    <dt>{t.common.notes}</dt>
                    <dd className="whitespace-pre-wrap">{p.notes}</dd>
                  </>
                )}
              </dl>
            </div>

            {p.items.length > 0 && (
              <div className="sec">
                <p className="eyebrow">{t.card.itemsByInvoice}</p>
                <ul className="card-mini-list">
                  {p.items.map((item) => (
                    <li key={item.id}>
                      <Link className="link mono" to={invoiceLink(item.invoiceId)}>
                        {monthLabel(item.referenceMonth)}
                      </Link>
                      <span className="mono text-xs text-muted">{t.card.installmentOf(item.installmentNumber, p.installmentsTotal)}</span>
                      <span className="flex-1" />
                      {item.invoiceClosed && <Badge tone="info">{t.card.invoiceStatuses.closed}</Badge>}
                      <Money cents={item.amountCents} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {p.refunds.length > 0 && (
              <div className="sec">
                <p className="eyebrow">{t.card.refunds}</p>
                <ul className="card-mini-list">
                  {p.refunds.map((r) => (
                    <li key={r.id}>
                      <span className="mono text-xs">{formatDate(r.purchasedOn)}</span>
                      <span className="min-w-0 flex-1 truncate">{r.description}</span>
                      <Money cents={-r.amountCents} className="in" />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!p.editable && p.canWrite && <p className="notice mt-4">{t.card.notEditable}</p>}
          </>
        )}
      </div>
      {p && modal === 'edit' && <EditPurchaseModal purchase={p} onClose={() => setModal(null)} onSaved={saved} />}
      {p && modal === 'refund' && <RefundModal purchase={p} max={refundable} onClose={() => setModal(null)} onSaved={saved} />}
    </aside>
  );
}

function EditPurchaseModal({
  purchase,
  onClose,
  onSaved,
}: {
  purchase: CardPurchaseDetail;
  onClose: () => void;
  onSaved: (p: CardPurchaseDetail) => void;
}) {
  const [description, setDescription] = useState(purchase.description);
  const [notes, setNotes] = useState(purchase.notes ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(purchase.categoryId);
  const [entity, setEntity] = useState<EntityOption | null>({ id: purchase.entityId, name: purchase.entityName });
  const [payerId, setPayerId] = useState(purchase.payerCaixaId);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const structural = purchase.editable;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (structural && !entity) return setError(t.card.finalPayee);
    setError(null);
    const body: Record<string, unknown> = { description, notes };
    if (structural) {
      if (categoryId && categoryId !== purchase.categoryId) body.categoryId = categoryId;
      if (entity && entity.id !== purchase.entityId) body.entityId = entity.id;
      if (payerId !== purchase.payerCaixaId) body.payerCaixaId = payerId;
    }
    const next = await run(() => api.patch<CardPurchaseDetail>(`/api/card-purchases/${purchase.id}`, body), t.card.purchaseUpdated);
    if (next) onSaved(next);
  }

  return (
    <Modal open title={`${t.common.edit}: ${purchase.description}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          {!structural && <p className="notice mb-3">{t.card.notEditable}</p>}
          <div className="form-grid cols-2">
            <Field label={t.common.description} className="span-all">
              <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={300} />
            </Field>
            {structural && (
              <>
                <Field label={t.card.finalPayee} className="span-all">
                  <EntityPicker value={entity} onChange={setEntity} ariaLabel={t.card.finalPayee} />
                </Field>
                <Field label={t.card.category}>
                  <CategorySelect
                    kind="expense"
                    caixaId={purchase.cardCaixaId}
                    value={categoryId}
                    onChange={setCategoryId}
                    ariaLabel={t.card.category}
                  />
                </Field>
                <Field label={t.card.payer}>
                  <PayerSelect value={payerId} onChange={setPayerId} />
                </Field>
              </>
            )}
            <Field label={t.common.notes} className="span-all">
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function RefundModal({
  purchase,
  max,
  onClose,
  onSaved,
}: {
  purchase: CardPurchaseDetail;
  max: number;
  onClose: () => void;
  onSaved: (p: CardPurchaseDetail) => void;
}) {
  const [amount, setAmount] = useState<number | null>(max);
  const [refundedOn, setRefundedOn] = useState(todayIso());
  const [description, setDescription] = useState(t.card.refundOf(purchase.description));
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!amount || amount <= 0 || amount > max) return setError(t.card.refundAmountHint(formatBRL(max)));
    setError(null);
    const next = await run(
      () => api.post<CardPurchaseDetail>(`/api/card-purchases/${purchase.id}/refund`, { amountCents: amount, refundedOn, description }),
      t.card.refundOk,
    );
    if (next) onSaved(next);
  }

  return (
    <Modal open title={t.card.refundTitle} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid cols-2">
          <Field label={t.common.amount} hint={t.card.refundAmountHint(formatBRL(max))}>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.common.amount} autoFocus />
          </Field>
          <Field label={t.card.refundDate}>
            <input type="date" className="field" value={refundedOn} onChange={(e) => setRefundedOn(e.target.value)} required />
          </Field>
          <Field label={t.common.description} className="span-all">
            <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
          </Field>
        </div>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.card.refund}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
