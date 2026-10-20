import { type CardChargeInput, type CardPurchaseDetail, type CardPurchaseInput, formatAccounting, t, todayIso } from '@moneyflow/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal } from '../ui';
import { useGeneralCaixas } from './shared';

function PayerSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const caixas = useGeneralCaixas();
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t.card.payer}>
      {!caixas.some((c) => c.id === value) && <option value={value}>…</option>}
      {caixas.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** Nova compra no cartão: recebedor final, categoria, pagadora, valor total e parcelas. */
export function PurchaseFormModal({
  cardCaixaId,
  defaultPayerId,
  onClose,
  onSaved,
}: {
  cardCaixaId: string;
  defaultPayerId: string;
  onClose: () => void;
  onSaved: (purchase: CardPurchaseDetail) => void;
}) {
  const [entity, setEntity] = useState<EntityOption | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [payerId, setPayerId] = useState(defaultPayerId);
  const [purchasedOn, setPurchasedOn] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [installments, setInstallments] = useState(1);
  const [first, setFirst] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  const n = Math.min(Math.max(installments || 1, 1), 99);
  const per = amount ? Math.floor(amount / n) : 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!entity) return setError(t.card.finalPayee);
    if (!categoryId) return setError(t.card.category);
    if (!amount || amount <= 0) return setError(t.errors.invalidAmount);
    setError(null);
    const body: CardPurchaseInput = {
      entityId: entity.id,
      categoryId,
      payerCaixaId: payerId,
      purchasedOn,
      description: description.trim() || entity.name,
      amountCents: amount,
      installmentsTotal: n,
      firstInstallment: Math.min(Math.max(first || 1, 1), n),
    };
    const saved = await run(() => api.post<CardPurchaseDetail>(`/api/cards/${cardCaixaId}/purchases`, body), t.card.purchaseCreated);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={t.card.newPurchase} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid cols-2">
            <Field label={t.card.finalPayee} className="span-all">
              <EntityPicker value={entity} onChange={setEntity} ariaLabel={t.card.finalPayee} autoFocus />
            </Field>
            <Field label={t.card.category}>
              <CategorySelect
                kind="expense"
                caixaId={cardCaixaId}
                value={categoryId}
                onChange={setCategoryId}
                ariaLabel={t.card.category}
              />
            </Field>
            <Field label={t.card.payer}>
              <PayerSelect value={payerId} onChange={setPayerId} />
            </Field>
            <Field label={t.card.purchasedOn}>
              <input type="date" className="field" value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} required />
            </Field>
            <Field label={t.common.description}>
              <input
                className="field"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={300}
                placeholder={entity?.name}
              />
            </Field>
            <Field label={t.card.totalAmount}>
              <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.card.totalAmount} />
            </Field>
            <Field label={t.card.installments} hint={amount ? t.card.perInstallment(n, formatAccounting(per)) : undefined}>
              <input
                type="number"
                className="field field-mono"
                min={1}
                max={99}
                value={installments}
                onChange={(e) => setInstallments(Number(e.target.value))}
              />
            </Field>
            <div className="span-all">
              <button type="button" className="link inline-flex items-center gap-1 text-[13px]" onClick={() => setAdvanced((a) => !a)}>
                {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} {t.card.advanced}
              </button>
            </div>
            {advanced && (
              <Field label={t.card.firstInstallment} hint={t.card.firstInstallmentHint}>
                <input
                  type="number"
                  className="field field-mono"
                  min={1}
                  max={n}
                  value={first}
                  onChange={(e) => setFirst(Number(e.target.value))}
                />
              </Field>
            )}
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.card.newPurchase}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Encargo do emissor (juros, IOF, multa, tarifa) lançado na fatura aberta. */
export function ChargeModal({
  cardCaixaId,
  defaultPayerId,
  onClose,
  onSaved,
}: {
  cardCaixaId: string;
  defaultPayerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [chargeKind, setChargeKind] = useState<CardChargeInput['chargeKind']>('interest');
  const [amount, setAmount] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [payerId, setPayerId] = useState(defaultPayerId);
  const [chargedOn, setChargedOn] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!amount || amount <= 0) return setError(t.errors.invalidAmount);
    if (!categoryId) return setError(t.card.chargeCategory);
    setError(null);
    const body: CardChargeInput = { chargeKind, amountCents: amount, categoryId, payerCaixaId: payerId, chargedOn, description };
    const ok = await run(() => api.post(`/api/cards/${cardCaixaId}/charges`, body), t.card.chargeOk);
    if (ok) onSaved();
  }

  return (
    <Modal open title={t.card.chargeTitle} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid cols-2">
          <Field label={t.card.chargeKind}>
            <select
              className="field"
              value={chargeKind}
              onChange={(e) => setChargeKind(e.target.value as CardChargeInput['chargeKind'])}
              autoFocus
            >
              {Object.entries(t.card.chargeKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.common.amount}>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.common.amount} />
          </Field>
          <Field label={t.card.chargeCategory} className="span-all">
            <CategorySelect
              kind="expense"
              caixaId={cardCaixaId}
              value={categoryId}
              onChange={setCategoryId}
              ariaLabel={t.card.chargeCategory}
            />
          </Field>
          <Field label={t.card.payer}>
            <PayerSelect value={payerId} onChange={setPayerId} />
          </Field>
          <Field label={t.card.chargedOn}>
            <input type="date" className="field" value={chargedOn} onChange={(e) => setChargedOn(e.target.value)} required />
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
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export { PayerSelect };
