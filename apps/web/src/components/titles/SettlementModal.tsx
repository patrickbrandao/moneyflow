import { type AccountRow, formatAccounting, type SettlementCreateInput, type TitleDetail, t, todayIso } from '@moneyflow/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal } from '../ui';

const LATER = '__later__';

/**
 * Baixa (spec 005/006): parcial, com juros/multa/desconto; conta desta caixa
 * ou "definir depois"; opcionalmente paga/recebe com a conta de OUTRA caixa
 * (gera a transferência); no par espelhado, a conta da outra perna se houver
 * permissão lá — senão aquele lado fica "conta a definir".
 */
export function SettlementModal({
  title,
  onClose,
  onSaved,
}: {
  title: TitleDetail;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const payable = title.direction === 'payable';
  const accounts = useApi<AccountRow[]>('/api/accounts?writable=1');
  const [settledOn, setSettledOn] = useState(todayIso());
  const [principal, setPrincipal] = useState<number | null>(title.openCents);
  const [interest, setInterest] = useState<number | null>(null);
  const [fine, setFine] = useState<number | null>(null);
  const [discount, setDiscount] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [useOther, setUseOther] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [mirrorAccountId, setMirrorAccountId] = useState<string>(LATER);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  const all = accounts.data ?? [];
  const own = useMemo(() => all.filter((a) => a.caixaId === title.caixaId), [all, title.caixaId]);
  const others = useMemo(() => all.filter((a) => a.caixaId !== title.caixaId && a.caixaId !== title.mirror?.caixaId), [all, title]);
  const mirrorAccounts = useMemo(() => all.filter((a) => a.caixaId === title.mirror?.caixaId), [all, title.mirror?.caixaId]);
  const mirrorWritable = Boolean(title.mirror?.canWrite);

  const cash = (principal ?? 0) + (interest ?? 0) + (fine ?? 0) - (discount ?? 0);
  const ownAccount = accountId || (own[0]?.id ?? LATER);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!principal || principal <= 0) return setError(t.errors.invalidAmount);
    if (principal > title.openCents)
      return setError(`O principal não pode passar do saldo em aberto (${formatAccounting(title.openCents)}).`);
    if (cash < 0) return setError(t.errors.invalidAmount);
    if (useOther && !sourceId) return setError('Escolha a conta da outra caixa.');
    if (useOther && ownAccount === LATER) return setError(t.errors.accountRequiredForTransfer);
    setError(null);
    const body: SettlementCreateInput = {
      settledOn,
      amountCents: principal,
      interestCents: interest ?? 0,
      fineCents: fine ?? 0,
      discountCents: discount ?? 0,
      financialAccountId: ownAccount === LATER ? null : ownAccount,
      sourceAccountId: useOther ? sourceId : null,
      mirrorAccountId: title.mirror && mirrorWritable && mirrorAccountId !== LATER ? mirrorAccountId : null,
      notes,
    };
    const saved = await run(() => api.post<TitleDetail>(`/api/titles/${title.id}/settlements`, body), 'Baixa registrada.');
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={`${payable ? t.title.pay : t.title.receive}: ${title.description}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="d mb-3">
            {title.entityName} · em aberto <span className="mono">{formatAccounting(title.openCents)}</span>
          </p>
          <div className="form-grid cols-2">
            <Field label={t.settlement.settledOn}>
              <input type="date" className="field" value={settledOn} onChange={(e) => setSettledOn(e.target.value)} required />
            </Field>
            <Field label={t.settlement.principal} hint="Menor que o saldo em aberto = baixa parcial.">
              <MoneyInput value={principal} onChange={setPrincipal} ariaLabel={t.settlement.principal} />
            </Field>
            <Field label={t.settlement.interest}>
              <MoneyInput value={interest} onChange={setInterest} ariaLabel={t.settlement.interest} />
            </Field>
            <Field label={t.settlement.fine}>
              <MoneyInput value={fine} onChange={setFine} ariaLabel={t.settlement.fine} />
            </Field>
            <Field label={t.settlement.discount}>
              <MoneyInput value={discount} onChange={setDiscount} ariaLabel={t.settlement.discount} />
            </Field>
            <Field label={t.settlement.cash}>
              <input className="field field-mono" value={formatAccounting(cash)} readOnly tabIndex={-1} />
            </Field>

            <Field
              label={useOther ? t.settlement.bridgeAccount : payable ? t.settlement.payWith : t.settlement.receiveIn}
              className="span-all"
            >
              <select className="field" value={ownAccount} onChange={(e) => setAccountId(e.target.value)} aria-label={t.settlement.account}>
                {own.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {formatAccounting(a.balanceCents)}
                  </option>
                ))}
                {!useOther && <option value={LATER}>{t.settlement.accountLater}</option>}
              </select>
            </Field>

            {others.length > 0 && (
              <label className="check span-all">
                <input type="checkbox" checked={useOther} onChange={(e) => setUseOther(e.target.checked)} />
                {payable ? 'Pagar com a conta de outra caixa (gera transferência)' : 'Receber na conta de outra caixa (gera transferência)'}
              </label>
            )}
            {useOther && (
              <Field label={t.settlement.otherCaixaAccount} className="span-all">
                <select
                  className="field"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  aria-label={t.settlement.otherCaixaAccount}
                >
                  <option value="">Escolha…</option>
                  {others.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.caixaName} › {a.name} · {formatAccounting(a.balanceCents)}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {title.mirror && (
              <Field
                label={`${t.settlement.mirrorAccount} (${title.mirror.caixaName})`}
                className="span-all"
                hint={mirrorWritable ? undefined : 'Sem permissão na outra caixa: aquele lado fica baixado com a conta a definir.'}
              >
                <select
                  className="field"
                  value={mirrorWritable ? mirrorAccountId : LATER}
                  disabled={!mirrorWritable}
                  onChange={(e) => setMirrorAccountId(e.target.value)}
                  aria-label={t.settlement.mirrorAccount}
                >
                  <option value={LATER}>{t.settlement.accountLater}</option>
                  {mirrorAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

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
          <Button type="submit" disabled={busy || accounts.loading}>
            {busy ? t.common.saving : payable ? t.title.pay : t.title.receive}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Estorno de uma baixa (e da perna do espelho), com motivo. */
export function ReverseModal({
  settlementId,
  hasTransfer,
  onClose,
  onSaved,
}: {
  settlementId: string;
  hasTransfer: boolean;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const [reason, setReason] = useState('');
  const [reversedOn, setReversedOn] = useState(todayIso());
  const [undoTransfer, setUndoTransfer] = useState(true);
  const { run, busy } = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () => api.post<TitleDetail>(`/api/settlements/${settlementId}/reverse`, { reason, reversedOn, undoTransfer }),
      'Baixa estornada.',
    );
    if (saved) onSaved(saved);
  }
  return (
    <Modal open title={t.settlement.reverse} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <p className="d">O estorno lança o movimento oposto na conta (o histórico fica) e reabre o saldo do título.</p>
        <Field label={t.settlement.reverseReason}>
          <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
        </Field>
        <Field label={t.common.date}>
          <input type="date" className="field" value={reversedOn} onChange={(e) => setReversedOn(e.target.value)} required />
        </Field>
        {hasTransfer && (
          <label className="check">
            <input type="checkbox" checked={undoTransfer} onChange={(e) => setUndoTransfer(e.target.checked)} /> {t.settlement.undoTransfer}
          </label>
        )}
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
            {t.settlement.reverse}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Informa a conta de uma baixa "conta a definir". */
export function SetAccountModal({
  settlementId,
  caixaId,
  onClose,
  onSaved,
}: {
  settlementId: string;
  caixaId: string;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const accounts = useApi<AccountRow[]>(`/api/accounts?caixaId=${caixaId}`);
  const [accountId, setAccountId] = useState('');
  const { run, busy } = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () => api.post<TitleDetail>(`/api/settlements/${settlementId}/account`, { financialAccountId: accountId }),
      'Conta definida.',
    );
    if (saved) onSaved(saved);
  }
  return (
    <Modal open title={t.settlement.setAccount} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={t.settlement.account}>
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)} required autoFocus>
            <option value="">Escolha…</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !accountId}>
            {t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
