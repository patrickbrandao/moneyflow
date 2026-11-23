import {
  type AccountRow,
  formatAccounting,
  formatDate,
  type SettlementCreateInput,
  type SettlementReversalInfo,
  type TitleDetail,
  t,
  todayIso,
} from '@moneyflow/shared';
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
  accountId: initialAccountId,
  onClose,
  onSaved,
}: {
  title: TitleDetail;
  /** Conta já escolhida (ex.: "Baixar" nos previstos da tela da conta); omitida = a conta prevista do título. */
  accountId?: string;
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
  // A baixa vem na conta prevista (spec 034: sempre uma conta da caixa do título, cofre inclusive).
  const [accountId, setAccountId] = useState<string>(initialAccountId ?? title.plannedAccountId ?? '');
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
    if (principal > title.openCents) return setError(t.settlement.principalTooHigh(formatAccounting(title.openCents)));
    if (cash < 0) return setError(t.errors.invalidAmount);
    if (useOther && !sourceId) return setError(t.settlement.chooseOtherAccount);
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
    const saved = await run(() => api.post<TitleDetail>(`/api/titles/${title.id}/settlements`, body), t.settlement.registered);
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
            <Field label={t.settlement.principal} hint={t.settlement.principalHint}>
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
                {payable ? t.settlement.payWithOther : t.settlement.receiveInOther}
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
                  <option value="">{t.common.choose}</option>
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
                hint={mirrorWritable ? undefined : t.settlement.mirrorNoPermission}
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

/**
 * Estorno de uma baixa (e da perna do espelho), com motivo. Para refazer a baixa, a data certa é a dela (tarefa 045).
 * Desfazer a transferência pede escrita na caixa da outra conta: sem ela, a opção fica desmarcada e travada (tarefa 081).
 */
export function ReverseModal({
  settlementId,
  settledOn,
  hasTransfer,
  undoAllowed,
  onClose,
  onSaved,
}: {
  settlementId: string;
  settledOn: string;
  hasTransfer: boolean;
  undoAllowed: boolean;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const [reason, setReason] = useState('');
  const [reversedOn, setReversedOn] = useState(todayIso());
  const [undoTransfer, setUndoTransfer] = useState(undoAllowed);
  const { run, busy } = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () =>
        api.post<TitleDetail>(`/api/settlements/${settlementId}/reverse`, {
          reason,
          reversedOn,
          undoTransfer: undoAllowed && undoTransfer,
        }),
      t.settlement.reversedToast,
    );
    if (saved) onSaved(saved);
  }
  return (
    <Modal open title={t.settlement.reverse} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <p className="d">{t.settlement.reverseHint}</p>
        <Field label={t.settlement.reverseReason}>
          <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
        </Field>
        <Field label={t.common.date}>
          <input
            type="date"
            className="field"
            value={reversedOn}
            min={settledOn}
            onChange={(e) => setReversedOn(e.target.value)}
            required
          />
          <span className="hint">
            {t.settlement.reverseRedoHint(formatDate(settledOn))}{' '}
            {reversedOn !== settledOn && (
              <button type="button" className="link" onClick={() => setReversedOn(settledOn)}>
                {formatDate(settledOn)}
              </button>
            )}
          </span>
        </Field>
        {hasTransfer && (
          <label className="check">
            <input
              type="checkbox"
              checked={undoAllowed && undoTransfer}
              disabled={!undoAllowed}
              onChange={(e) => setUndoTransfer(e.target.checked)}
            />{' '}
            {t.settlement.undoTransfer}
          </label>
        )}
        {hasTransfer && !undoAllowed && <p className="notice info">{t.settlement.undoTransferLocked}</p>}
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

/**
 * Corrige a data do estorno (tarefa 045): a prévia das pernas e contas que mudam (de /reversal) e a nova data, com a
 * da baixa como sugestão. Estorno conciliado ou perna noutra caixa sem escrita: a tela explica e não deixa salvar.
 */
export function ReversalDateModal({
  settlementId,
  onClose,
  onSaved,
}: {
  settlementId: string;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const info = useApi<SettlementReversalInfo>(`/api/settlements/${settlementId}/reversal`);
  const [reversedOn, setReversedOn] = useState<string | null>(null);
  const { run, busy } = useAction();
  const data = info.data;
  const date = reversedOn ?? data?.settledOn ?? '';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () => api.post<TitleDetail>(`/api/settlements/${settlementId}/reversal-date`, { reversedOn: date }),
      t.settlement.reversalDateSaved,
    );
    if (saved) onSaved(saved);
  }
  return (
    <Modal open title={t.settlement.reversalDate} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <p className="d">{t.settlement.reversalDateHint}</p>
        <Field label={t.settlement.reversalNewDate}>
          <input
            type="date"
            className="field"
            value={date}
            min={data?.settledOn}
            onChange={(e) => setReversedOn(e.target.value)}
            required
            disabled={!data}
          />
          {data && <span className="hint">{t.settlement.reverseRedoHint(formatDate(data.settledOn))}</span>}
        </Field>
        {data && (
          <div>
            <span className="label">{t.settlement.reversalLegs}</span>
            <div className="item-list">
              {data.legs.map((leg) => (
                <div key={leg.settlementId} className="item">
                  <div className="grow text-[13px]">
                    <div className="text-ink">
                      {leg.caixaName}
                      {leg.accountName ? ` · ${leg.accountName}` : ''}
                    </div>
                    <div className="text-[12px] text-muted">
                      {leg.occurredOn
                        ? `${formatDate(leg.occurredOn)} → ${date ? formatDate(date) : '—'}`
                        : t.settlement.reversalNoMovement}
                      {leg.reconciled && ` · ${t.settlement.reversalReconciled}`}
                      {leg.occurredOn && !leg.canWrite && ` · ${t.settlement.reversalReadOnly}`}
                    </div>
                  </div>
                  {leg.amountCents !== null && <span className="money">{formatAccounting(leg.amountCents)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {data && !data.canChange && (
          <p className="notice warn">
            {data.legs.some((l) => l.reconciled)
              ? t.settlement.reversalReconciled
              : data.legs.some((l) => l.occurredOn && !l.canWrite)
                ? t.errors.reversalDateOtherCaixa
                : t.settlement.reversalNoMovement}
          </p>
        )}
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !data?.canChange || !date}>
            {t.common.save}
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
      t.settlement.accountSet,
    );
    if (saved) onSaved(saved);
  }
  return (
    <Modal open title={t.settlement.setAccount} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label={t.settlement.account}>
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)} required autoFocus>
            <option value="">{t.common.choose}</option>
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
