import { type AccountRow, type CaixaSummary, t } from '@moneyflow/shared';
import { useMemo } from 'react';
import { canWriteCaixa } from '../../lib/access';
import { useUser } from '../../lib/auth';
import { useApi } from '../../lib/hooks';

/*
 * Onde uma obrigação (ou série) pode viver (spec 034): as contas corrente,
 * poupança e cofre em que o usuário escreve, os cartões e as caixas pagadoras.
 * Usado no editor da obrigação, na edição da série e no aditivo.
 */

export type ObligationOptions = {
  caixas: CaixaSummary[];
  /** Corrente, poupança e cofre em que o usuário escreve, fora das caixas da contraparte. */
  accounts: AccountRow[];
  cards: CaixaSummary[];
  payers: CaixaSummary[];
  loading: boolean;
};

const MONEY_KINDS = new Set(['checking', 'savings', 'cash']);

export function useObligationOptions(counterpartyId: string | null | undefined): ObligationOptions {
  const user = useUser();
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const accounts = useApi<AccountRow[]>('/api/accounts?writable=1');
  return useMemo(() => {
    const all = caixas.data ?? [];
    const holderOf = new Map(all.map((c) => [c.id, c.holderEntityId]));
    return {
      caixas: all,
      accounts: (accounts.data ?? []).filter(
        (a) => MONEY_KINDS.has(a.kind) && !a.archivedAt && a.canWrite && (!counterpartyId || holderOf.get(a.caixaId) !== counterpartyId),
      ),
      cards: all.filter((c) => c.kind === 'credit_card' && !c.archivedAt && canWriteCaixa(user, c.id)),
      payers: all.filter((c) => c.kind === 'general' && !c.archivedAt && canWriteCaixa(user, c.id)),
      loading: caixas.loading || accounts.loading,
    };
  }, [caixas.data, caixas.loading, accounts.data, accounts.loading, counterpartyId, user]);
}

/** Seletor de conta agrupado por caixa. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  label,
  empty = '—',
  testId,
}: {
  accounts: AccountRow[];
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  empty?: string;
  testId?: string;
}) {
  const groups = [...new Set(accounts.map((a) => a.caixaName))];
  return (
    <select
      className="field"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={label}
      data-testid={testId}
    >
      <option value="">{empty}</option>
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {accounts
            .filter((a) => a.caixaName === group)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {t.caixa.accountKinds[a.kind] ?? a.kind}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
