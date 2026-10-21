import { type AccountRow, type PlannedAccount, type TitleDetail, t } from '@moneyflow/shared';
import { Pencil } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, Field, Modal } from '../ui';

/*
 * Conta prevista (spec 034): a conta da caixa do título — corrente, poupança
 * ou cofre — onde o pagamento sai ou o recebimento entra. Não há conta de
 * passagem: a série mora na caixa da conta. Numa ocorrência de série, a troca
 * vale "só esta" (fica própria) ou "esta e as próximas" em aberto.
 */

const P = t.contracts.payment;
const PL = t.contracts.planned;

export const PLANNED_KINDS = new Set(['checking', 'savings', 'cash']);

/** Contas da caixa que podem ser a conta prevista (as arquivadas só se já forem a escolhida). */
export function plannedAccountOptions(accounts: AccountRow[], caixaId: string, current: string | null): AccountRow[] {
  return accounts.filter(
    (a) => a.caixaId === caixaId && PLANNED_KINDS.has(a.kind) && (!a.archivedAt || a.id === current) && (a.canWrite || a.id === current),
  );
}

/** Todas as contas legíveis (o seletor filtra pela caixa). */
export function usePaymentAccounts() {
  return useApi<AccountRow[]>('/api/accounts');
}

/** Contas da caixa (todas, para o seletor da conta prevista). */
export function useCaixaAccounts(caixaId: string | null) {
  return useApi<AccountRow[]>(caixaId ? `/api/accounts?caixaId=${caixaId}` : null);
}

/** Seletor da conta prevista: só as contas da caixa do título, cofre inclusive. */
export function PlannedAccountSelect({
  caixaId,
  accounts,
  accountId,
  onChange,
  label = P.plannedAccount,
  hint = PL.accountHint,
  className,
}: {
  caixaId: string;
  accounts: AccountRow[];
  accountId: string | null;
  onChange: (accountId: string | null) => void;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const options = plannedAccountOptions(accounts, caixaId, accountId);
  return (
    <Field label={label} hint={hint} className={className}>
      <select
        className="field"
        value={accountId ?? ''}
        aria-label={label}
        data-testid="planned-account-select"
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{P.plannedNone}</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {t.caixa.accountKinds[a.kind]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Nome da conta prevista com a marca "própria" (ocorrência que não segue a série). */
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

/** O título cuja conta prevista se troca; com série, oferece "só esta" ou "esta e as próximas". */
export type PlannedAccountTarget = {
  titleId: string;
  caixaId: string;
  /** Série da ocorrência (qualquer um dos dois nomes). */
  recurrenceRuleId?: string | null;
  ruleId?: string | null;
} & Pick<PlannedAccount, 'plannedAccountId' | 'plannedAccountName'>;

/** Botão de trocar a conta prevista de um título em aberto ou parcial (abre o modal). */
export function PlannedAccountButton({ title, onSaved }: { title: PlannedAccountTarget; onSaved: (detail: TitleDetail) => void }) {
  const [open, setOpen] = useState(false);
  return (
    // O botão fica dentro de linhas clicáveis: nada do modal (portal) chega ao clique da linha.
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="row-action"
        aria-label={`${P.plannedAccount}: ${title.plannedAccountName ?? P.plannedNone}`}
        title={P.plannedAccount}
        data-testid="planned-account-edit"
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
  title: PlannedAccountTarget;
  onClose: () => void;
  onSaved: (detail: TitleDetail) => void;
}) {
  const accounts = useCaixaAccounts(title.caixaId);
  const inSeries = Boolean(title.recurrenceRuleId ?? title.ruleId);
  const [accountId, setAccountId] = useState(title.plannedAccountId);
  const [scope, setScope] = useState<'this' | 'following'>(inSeries ? 'following' : 'this');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const saved = await run(
      () => api.patch<TitleDetail>(`/api/titles/${title.titleId}`, { plannedAccountId: accountId, scope }),
      P.plannedSaved,
    );
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={P.plannedAccount} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-body form-grid">
          <PlannedAccountSelect caixaId={title.caixaId} accounts={accounts.data ?? []} accountId={accountId} onChange={setAccountId} />
          {inSeries && (
            <fieldset className="grid gap-1" data-testid="planned-account-scope">
              <legend className="mb-1 text-[13px] text-muted">{PL.scope}</legend>
              <label className="check">
                <input type="radio" name="planned-scope" checked={scope === 'this'} onChange={() => setScope('this')} />
                {PL.scopeThis}
              </label>
              <label className="check">
                <input type="radio" name="planned-scope" checked={scope === 'following'} onChange={() => setScope('following')} />
                {PL.scopeFollowing}
              </label>
            </fieldset>
          )}
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || accounts.loading}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
