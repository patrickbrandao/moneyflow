import { type CaixaDetail, t } from '@moneyflow/shared';
import { ExternalLink, FileText, ListFilter, Wand2 } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { accountLink } from '../../lib/links';
import { useParamState, useSetParams } from '../../lib/params';
import { useStored } from '../../lib/storage';
import { EmptyState, Tabs } from '../ui';
import { RulesPanel } from './RulesPanel';
import { StatementImportPanel } from './StatementImportPanel';
import '../../styles/reconciliation.css';

const s = t.statements;

/** Aba Conciliação da caixa geral: extratos por conta, linhas e regras (spec 009). */
export function ReconciliationTab({ caixa, onChanged }: { caixa: CaixaDetail; onChanged: () => void }) {
  const accounts = caixa.accounts.filter((a) => (a.kind === 'checking' || a.kind === 'savings') && !a.archivedAt);
  const [view] = useParamState('view');
  const [accountParam] = useParamState('account');
  const setParams = useSetParams();
  // Última conta escolhida, por caixa e no navegador: abre nela quando o endereço não traz `account`.
  const [lastAccount, setLastAccount] = useStored<Record<string, string>>('reconciliation-account', {});
  const valid = (id: string | null | undefined) => (id && accounts.some((a) => a.id === id) ? id : null);
  const chosen = valid(accountParam);
  const accountId = chosen ?? valid(lastAccount[caixa.id]) ?? accounts[0]?.id ?? null;
  const caixaId = caixa.id;
  useEffect(() => {
    if (chosen) setLastAccount((current) => (current[caixaId] === chosen ? current : { ...current, [caixaId]: chosen }));
  }, [chosen, caixaId, setLastAccount]);
  const current = view === 'rules' ? 'rules' : 'statements';

  return (
    <>
      <div className="rec-bar">
        <Tabs
          value={current}
          onChange={(key) => setParams({ view: key === 'rules' ? 'rules' : null, import: null, lines: null })}
          items={[
            { key: 'statements', label: s.tabStatements, icon: <FileText /> },
            { key: 'rules', label: s.tabRules, icon: <Wand2 /> },
          ]}
        />
        <span className="flex-1" />
        {current === 'statements' && accounts.length > 0 && (
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            <ListFilter className="size-4" />
            <select
              className="field field-auto"
              value={accountId ?? ''}
              aria-label={s.account}
              onChange={(e) => setParams({ account: e.target.value, import: null, lines: null })}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {t.caixa.accountKinds[a.kind]}
                </option>
              ))}
            </select>
            {accountId && (
              <Link className="row-action" to={accountLink(caixa.id, accountId, 'reconciliation')} title={t.caixa.account.open}>
                <ExternalLink />
              </Link>
            )}
          </label>
        )}
      </div>

      {current === 'rules' ? (
        <RulesPanel caixa={caixa} />
      ) : accountId ? (
        <StatementImportPanel key={accountId} caixaId={caixa.id} accountId={accountId} canWrite={caixa.canWrite} onChanged={onChanged} />
      ) : (
        <EmptyState icon={<FileText />} title={s.noAccounts} description={s.noAccountsHint} />
      )}
    </>
  );
}
