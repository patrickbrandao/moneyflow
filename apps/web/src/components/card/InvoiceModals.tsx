import {
  type AccountRow,
  formatAccounting,
  type InvoiceAdvanceInput,
  type InvoiceDetail,
  type InvoicePaymentInput,
  type InvoiceSummary,
  t,
  todayIso,
} from '@moneyflow/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, Money } from '../domain';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal, Skel } from '../ui';
import { monthLabel, useGeneralCaixas } from './shared';

const LATER = '__later__';

/** Contas da pagadora em que o usuário pode lançar. */
function usePayerAccounts(payerCaixaId: string | null) {
  return useApi<AccountRow[]>(payerCaixaId ? `/api/accounts?caixaId=${payerCaixaId}&writable=1` : null);
}

function AccountSelect({
  payerCaixaId,
  value,
  onChange,
  allowLater,
}: {
  payerCaixaId: string | null;
  value: string;
  onChange: (id: string) => void;
  allowLater?: boolean;
}) {
  const accounts = usePayerAccounts(payerCaixaId);
  const list = useMemo(() => (accounts.data ?? []).filter((a) => !a.archivedAt), [accounts.data]);
  // Primeira conta como padrão, assim que a lista chega (ou a pagadora muda).
  useEffect(() => {
    if (!accounts.data) return;
    if (!list.some((a) => a.id === value) && value !== LATER) onChange(list[0]?.id ?? (allowLater ? LATER : ''));
  }, [accounts.data, list, value, onChange, allowLater]);
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t.card.payAccount}>
      {!allowLater && list.length === 0 && <option value="">{t.card.noAccounts}</option>}
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {formatAccounting(a.balanceCents)}
        </option>
      ))}
      {allowLater && <option value={LATER}>{t.card.accountLater}</option>}
    </select>
  );
}

/* ---------------- fechar ---------------- */

/** Fechamento com o total por pagadora e a categoria (opcional) do título de cada uma. */
export function CloseInvoiceModal({ invoiceId, onClose, onDone }: { invoiceId: string; onClose: () => void; onDone: () => void }) {
  const { data: invoice, error, reload } = useApi<InvoiceDetail>(`/api/card-invoices/${invoiceId}`);
  const [categories, setCategories] = useState<Record<string, string | null>>({});
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payerCategoryIds: Record<string, string> = {};
    for (const [payer, category] of Object.entries(categories)) if (category) payerCategoryIds[payer] = category;
    const ok = await run(() => api.post(`/api/card-invoices/${invoiceId}/close`, { payerCategoryIds }), t.card.closed);
    if (ok) onDone();
  }

  return (
    <Modal open title={invoice ? t.card.closeTitle(monthLabel(invoice.referenceMonth)) : t.card.closeInvoice} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <LoadError error={error} onRetry={() => void reload()} />}
          {!invoice && !error && <Skel h={120} />}
          {invoice && (
            <>
              <p className="d mb-3">{t.card.closeIntro}</p>
              {invoice.payers.length === 0 ? (
                <p className="notice">{t.card.closeEmpty}</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>{t.card.payer}</th>
                        <th className="num">{t.card.total}</th>
                        <th>{t.card.closeCategory}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.payers.map((p) => (
                        <tr key={p.payerCaixaId}>
                          <td className="row-title">{p.payerCaixaName}</td>
                          <td className="num">
                            <Money cents={p.itemsCents} />
                          </td>
                          <td>
                            <CategorySelect
                              kind="expense"
                              caixaId={p.payerCaixaId}
                              value={categories[p.payerCaixaId] ?? null}
                              onChange={(id) => setCategories((c) => ({ ...c, [p.payerCaixaId]: id }))}
                              allowEmpty={t.card.closeCategoryAuto}
                              ariaLabel={`${t.card.closeCategory}: ${p.payerCaixaName}`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>{t.card.total}</td>
                        <td className="num">
                          <Money cents={invoice.totalCents} />
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !invoice}>
            {busy ? t.common.saving : t.card.closeInvoice}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- pagar (fatura fechada) ---------------- */

type ChargeDraft = { key: number; chargeKind: string; amountCents: number | null; categoryId: string | null; description: string };

/**
 * Pagamento da fatura fechada por uma pagadora: total (valor = aberto) ou
 * parcial (o restante rola; encargos do emissor entram na próxima fatura).
 */
export function PayInvoiceModal({
  invoice,
  initialPayerId,
  onClose,
  onDone,
}: {
  invoice: InvoiceDetail;
  initialPayerId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const payable = invoice.payers.filter((p) => p.canWritePayer && p.openCents > 0);
  const initial = payable.find((p) => p.payerCaixaId === initialPayerId) ?? payable[0];
  const [payerId, setPayerId] = useState<string | null>(initial?.payerCaixaId ?? null);
  const payer = payable.find((p) => p.payerCaixaId === payerId) ?? null;
  const [accountId, setAccountId] = useState('');
  const [settledOn, setSettledOn] = useState(todayIso());
  const [amount, setAmount] = useState<number | null>(initial?.openCents ?? null);
  const [charges, setCharges] = useState<ChargeDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  const open = payer?.openCents ?? 0;
  const rest = open - (amount ?? 0);

  function pickPayer(id: string) {
    setPayerId(id);
    setAccountId('');
    setAmount(payable.find((p) => p.payerCaixaId === id)?.openCents ?? null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!payer) return;
    if (amount === null || amount < 0) return setError(t.errors.invalidAmount);
    if (amount > open) return setError(t.card.overOpen(formatAccounting(open)));
    for (const c of charges) {
      if (!c.amountCents || c.amountCents <= 0) return setError(t.errors.invalidAmount);
      if (!c.categoryId) return setError(t.card.chargeCategory);
    }
    setError(null);
    const body: InvoicePaymentInput = {
      payerCaixaId: payer.payerCaixaId,
      settledOn,
      amountCents: amount,
      financialAccountId: accountId && accountId !== LATER ? accountId : null,
      charges:
        rest > 0
          ? charges.map((c) => ({
              chargeKind: c.chargeKind as 'interest',
              amountCents: c.amountCents!,
              categoryId: c.categoryId!,
              description: c.description,
            }))
          : [],
      notes,
    };
    const ok = await run(() => api.post(`/api/card-invoices/${invoice.id}/pay`, body), t.card.paidOk);
    if (ok) onDone();
  }

  return (
    <Modal open title={t.card.payTitle(monthLabel(invoice.referenceMonth))} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          {payable.length === 0 ? (
            <p className="notice">{t.card.nothingToPay}</p>
          ) : (
            <div className="form-grid cols-2">
              <Field label={t.card.payer}>
                <select className="field" value={payerId ?? ''} onChange={(e) => pickPayer(e.target.value)} aria-label={t.card.payer}>
                  {payable.map((p) => (
                    <option key={p.payerCaixaId} value={p.payerCaixaId}>
                      {p.payerCaixaName} · {formatAccounting(p.openCents)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t.card.payAccount}>
                <AccountSelect payerCaixaId={payerId} value={accountId} onChange={setAccountId} allowLater />
              </Field>
              <Field label={t.card.settledOn}>
                <input type="date" className="field" value={settledOn} onChange={(e) => setSettledOn(e.target.value)} required />
              </Field>
              <Field label={t.card.amountPaid} hint={`${t.card.open}: ${formatAccounting(open)}`}>
                <MoneyInput key={payerId ?? ''} value={amount} onChange={setAmount} ariaLabel={t.card.amountPaid} />
              </Field>
              {amount !== null && rest > 0 && (
                <p className="notice warn span-all">{amount === 0 ? t.card.nothingPaid : t.card.rollsOver(formatAccounting(rest))}</p>
              )}
              {amount !== null && rest > 0 && (
                <div className="span-all">
                  <p className="label">{t.card.charges}</p>
                  {charges.map((c) => (
                    <div key={c.key} className="card-charge-row">
                      <select
                        className="field field-auto"
                        value={c.chargeKind}
                        aria-label={t.card.chargeKind}
                        onChange={(e) => setCharges((all) => all.map((x) => (x.key === c.key ? { ...x, chargeKind: e.target.value } : x)))}
                      >
                        {Object.entries(t.card.chargeKinds).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <MoneyInput
                        value={c.amountCents}
                        ariaLabel={`${t.common.amount} (${t.card.chargeKinds[c.chargeKind]})`}
                        onChange={(v) => setCharges((all) => all.map((x) => (x.key === c.key ? { ...x, amountCents: v } : x)))}
                      />
                      <CategorySelect
                        kind="expense"
                        value={c.categoryId}
                        ariaLabel={t.card.chargeCategory}
                        onChange={(id) => setCharges((all) => all.map((x) => (x.key === c.key ? { ...x, categoryId: id } : x)))}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.common.remove}
                        title={t.common.remove}
                        onClick={() => setCharges((all) => all.filter((x) => x.key !== c.key))}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setCharges((all) => [
                        ...all,
                        { key: Date.now(), chargeKind: 'interest', amountCents: null, categoryId: null, description: '' },
                      ])
                    }
                  >
                    <Plus /> {t.card.addCharge}
                  </Button>
                </div>
              )}
              <Field label={t.common.notes} className="span-all">
                <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          )}
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !payer}>
            {busy ? t.common.saving : t.card.payInvoice}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- pagamento antecipado (fatura aberta) ---------------- */

export function AdvanceModal({
  invoice,
  defaultPayerId,
  onClose,
  onDone,
}: {
  invoice: InvoiceSummary;
  defaultPayerId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const caixas = useGeneralCaixas(true);
  const [payerId, setPayerId] = useState<string>('');
  const effectivePayer = payerId || (caixas.find((c) => c.id === defaultPayerId)?.id ?? caixas[0]?.id ?? '');
  const [accountId, setAccountId] = useState('');
  const [settledOn, setSettledOn] = useState(todayIso());
  const [amount, setAmount] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!effectivePayer) return;
    if (!amount || amount <= 0) return setError(t.errors.invalidAmount);
    if (!accountId) return setError(t.card.chooseAccount);
    setError(null);
    const body: InvoiceAdvanceInput = {
      payerCaixaId: effectivePayer,
      settledOn,
      amountCents: amount,
      financialAccountId: accountId,
      categoryId,
      notes,
    };
    const ok = await run(() => api.post(`/api/card-invoices/${invoice.id}/advance`, body), t.card.advancedOk);
    if (ok) onDone();
  }

  return (
    <Modal open title={t.card.advanceTitle(monthLabel(invoice.referenceMonth))} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid cols-2">
            <Field label={t.card.payer}>
              <select
                className="field"
                value={effectivePayer}
                onChange={(e) => {
                  setPayerId(e.target.value);
                  setAccountId('');
                }}
                aria-label={t.card.payer}
              >
                {caixas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.card.payAccount}>
              <AccountSelect payerCaixaId={effectivePayer || null} value={accountId} onChange={setAccountId} />
            </Field>
            <Field label={t.card.settledOn}>
              <input type="date" className="field" value={settledOn} onChange={(e) => setSettledOn(e.target.value)} required />
            </Field>
            <Field label={t.common.amount}>
              <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.common.amount} autoFocus />
            </Field>
            <Field label={t.card.advanceCategory} className="span-all">
              <CategorySelect
                kind="expense"
                caixaId={effectivePayer || null}
                value={categoryId}
                onChange={setCategoryId}
                allowEmpty={t.card.closeCategoryAuto}
                ariaLabel={t.card.advanceCategory}
              />
            </Field>
            <Field label={t.common.notes} className="span-all">
              <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !effectivePayer}>
            {busy ? t.common.saving : t.card.advance}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- datas da fatura aberta ---------------- */

export function InvoiceDatesModal({ invoice, onClose, onDone }: { invoice: InvoiceSummary; onClose: () => void; onDone: () => void }) {
  const [closingDate, setClosingDate] = useState(invoice.closingDate);
  const [dueDate, setDueDate] = useState(invoice.dueDate);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => api.patch(`/api/card-invoices/${invoice.id}`, { closingDate, dueDate }), t.card.datesSaved);
    if (ok) onDone();
  }

  return (
    <Modal open title={`${t.card.datesTitle} · ${monthLabel(invoice.referenceMonth)}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid cols-2">
          <Field label={t.card.closingDate}>
            <input type="date" className="field" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} required />
          </Field>
          <Field label={t.card.dueDate}>
            <input type="date" className="field" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
          </Field>
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
