import { type AccountRow, type PlannedAccount, type TitleDetail, t } from '@moneyflow/shared';
import { Pencil } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, Field, Modal } from '../ui';

/*
 * Conta prevista (spec 033): a conta das parcelas do contrato e a de cada
 * título. Conta corrente ou poupança desta caixa ou de outra em que o usuário
 * escreve; de outra caixa, pede a conta de passagem (desta caixa), onde a baixa
 * é registrada com a transferência a partir da conta prevista.
 */

const P = t.contracts.payment;

export function usePaymentAccounts() {
  return useApi<AccountRow[]>('/api/accounts');
}

/** Seletores da conta prevista e, se ela é de outra caixa, da conta de passagem. */
export function PlannedAccountSelect({
  caixaId,
  accounts,
  accountId,
  transitId,
  onChange,
  label = P.account,
  hint = P.accountHint,
}: {
  caixaId: string;
  accounts: AccountRow[];
  accountId: string | null;
  transitId: string | null;
  onChange: (accountId: string | null, transitId: string | null) => void;
  label?: string;
  hint?: string;
}) {
  const payable = accounts.filter(
    (a) => (a.kind === 'checking' || a.kind === 'savings') && (!a.archivedAt || a.id === accountId) && (a.canWrite || a.id === accountId),
  );
  const groups = [...new Set(payable.map((a) => a.caixaName))];
  const selected = accounts.find((a) => a.id === accountId) ?? null;
  const otherCaixa = selected !== null && selected.caixaId !== caixaId;
  const transits = accounts.filter((a) => a.caixaId === caixaId && (!a.archivedAt || a.id === transitId));
  return (
    <>
      <Field label={label} hint={hint}>
        <select
          className="field"
          value={accountId ?? ''}
          aria-label={label}
          onChange={(e) => {
            const next = accounts.find((a) => a.id === e.target.value) ?? null;
            const keepTransit = next && next.caixaId !== caixaId ? transitId : null;
            onChange(next?.id ?? null, keepTransit);
          }}
        >
          <option value="">{P.accountNone}</option>
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {payable
                .filter((a) => a.caixaName === group)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {otherCaixa && (
        <Field label={P.transit} hint={P.transitHint}>
          <select
            className="field"
            value={transitId ?? ''}
            aria-label={P.transit}
            onChange={(e) => onChange(accountId, e.target.value || null)}
          >
            <option value="">—</option>
            {transits.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </>
  );
}

/** Nome da conta prevista com a marca "própria" (parcela que não segue o contrato). */
export function PlannedAccountLabel({ planned, showCustom = true }: { planned: PlannedAccount; showCustom?: boolean }) {
  if (!planned.plannedAccountId) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {planned.plannedAccountName ?? '—'}
      {showCustom && planned.plannedAccountCustom && (
        <Badge tone="outline" title={P.plannedCustom}>
          {P.plannedCustom}
        </Badge>
      )}
    </span>
  );
}

/** Botão de trocar a conta prevista de um título em aberto ou parcial (abre o modal). */
export function PlannedAccountButton({
  title,
  onSaved,
}: {
  title: { titleId: string; caixaId: string } & PlannedAccount;
  onSaved: (detail: TitleDetail) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    // O botão fica dentro de linhas clicáveis: nada do modal (portal) chega ao clique da linha.
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="row-action"
        aria-label={`${P.plannedAccount}: ${title.plannedAccountName ?? P.accountNone}`}
        title={P.plannedAccount}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Pencil />
      </button>
      {open && (
        <PlannedAccountModal
          title={title}
          onClose={() => setOpen(false)}
          onSaved={(detail) => {
            setOpen(false);
            onSaved(detail);
          }}
        />
      )}
    </span>
  );
}

export function PlannedAccountModal({
  title,
  onClose,
  onSaved,
}: {
  title: { titleId: string; caixaId: string } & PlannedAccount;
  onClose: () => void;
  onSaved: (detail: TitleDetail) => void;
}) {
  const accounts = usePaymentAccounts();
  const [accountId, setAccountId] = useState(title.plannedAccountId);
  const [transitId, setTransitId] = useState(title.plannedTransitAccountId);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const selected = accounts.data?.find((a) => a.id === accountId);
    if (selected && selected.caixaId !== title.caixaId && !transitId) return setError(P.plannedTransitNeeded);
    setError(null);
    const saved = await run(
      () => api.patch<TitleDetail>(`/api/titles/${title.titleId}`, { plannedAccountId: accountId, plannedTransitAccountId: transitId }),
      P.plannedSaved,
    );
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={P.plannedAccount} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-body form-grid">
          <PlannedAccountSelect
            caixaId={title.caixaId}
            accounts={accounts.data ?? []}
            accountId={accountId}
            transitId={transitId}
            label={P.plannedAccount}
            onChange={(a, tr) => {
              setAccountId(a);
              setTransitId(tr);
            }}
          />
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
