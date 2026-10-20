import { type AccountSummary, type CaixaDetail, formatDate, t, todayIso } from '@moneyflow/shared';
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  FileText,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Pencil,
  PlusCircle,
  Wallet,
  Wand2,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgentScreenContext } from '../agents/AgentsProvider';
import { AccountOverview, monthEnd, monthStart } from '../components/caixa/AccountOverview';
import { AccountFormModal, AdjustmentModal } from '../components/caixa/AccountsTab';
import { StatementTab } from '../components/caixa/StatementTab';
import { LoadError, Money, PageHead } from '../components/domain';
import { RulesPanel } from '../components/reconciliation/RulesPanel';
import { StatementImportPanel } from '../components/reconciliation/StatementImportPanel';
import { useCrumbs } from '../components/shell/Layout';
import { Badge, Button, ButtonLink, EmptyState, Skel, Tabs } from '../components/ui';
import { useRegisterCommands } from '../lib/commands';
import { useApi } from '../lib/hooks';
import { type AccountTab, accountLink, caixaTab } from '../lib/links';

const a = t.caixa.account;
const TABS = ['overview', 'statement', 'reconciliation', 'rules'] as const;

/**
 * Tela da conta financeira dentro da caixa (spec 004): o saldo, o resumo com os gráficos,
 * o extrato e a conciliação só desta conta, sem os totais da caixa nem as outras contas.
 */
export function FinancialAccountPage() {
  const { id = '', accountId = '', tab: rawTab } = useParams();
  const tab: AccountTab = TABS.includes(rawTab as AccountTab) ? (rawTab as AccountTab) : 'overview';
  const navigate = useNavigate();
  const { data: caixa, error, reload } = useApi<CaixaDetail>(`/api/caixas/${id}`);
  const account = caixa?.accounts.find((x) => x.id === accountId) ?? null;
  const month = monthStart(todayIso());
  const current = useApi<AccountSummary>(account ? `/api/accounts/${account.id}/summary?from=${month}&to=${monthEnd(month)}` : null);
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  // Muda a cada escrita feita aqui: o resumo e o extrato recarregam.
  const [version, setVersion] = useState(0);

  useCrumbs(caixa && account ? [{ label: caixa.name, to: `/caixas/${caixa.id}` }, { label: account.name }] : []);
  useAgentScreenContext(
    caixa && account
      ? {
          caixaId: caixa.id,
          caixaName: caixa.name,
          title: `${caixa.name} › ${account.name}`,
          record: { kind: 'financial_account', id: account.id, label: account.name },
          filters: { tab, accountId: account.id },
        }
      : null,
  );

  const reconciles = account ? account.kind === 'checking' || account.kind === 'savings' : false;
  const writable = Boolean(caixa?.canWrite && account && !account.archivedAt);

  useRegisterCommands(
    caixa && account
      ? [
          ...TABS.filter((key) => (key !== 'reconciliation' && key !== 'rules') || reconciles).map((key) => ({
            id: `account-${key}`,
            label: `${caixa.name} › ${account.name} › ${key === 'overview' ? a.overview : key === 'rules' ? a.rules : t.caixa[key]}`,
            group: 'Ir para' as const,
            icon:
              key === 'overview' ? <LayoutDashboard /> : key === 'statement' ? <FileText /> : key === 'rules' ? <Wand2 /> : <ListChecks />,
            run: () => navigate(accountLink(caixa.id, account.id, key)),
          })),
          ...(writable
            ? [
                {
                  id: 'account-adjustment',
                  label: `${t.caixa.adjustment} em ${account.name}`,
                  group: 'Criar' as const,
                  icon: <PlusCircle />,
                  run: () => setAdjusting(true),
                },
              ]
            : []),
        ]
      : [],
    [caixa?.id, account?.id, writable, reconciles],
  );

  if (error) {
    return (
      <div className="page">
        <LoadError error={error} onRetry={() => void reload()} />
      </div>
    );
  }
  if (!caixa) {
    return (
      <div className="page wide">
        <Skel h={34} w={280} />
        <Skel h={18} w={200} className="mt-3" />
        <Skel h={260} className="mt-6" />
      </div>
    );
  }
  if (!account) {
    return (
      <div className="page">
        <EmptyState
          icon={<Landmark />}
          title={a.notFound}
          action={
            <ButtonLink to={caixaTab(caixa.id, 'accounts')}>
              <ArrowLeft /> {a.backToCaixa}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const changed = () => {
    void reload();
    void current.reload();
    setVersion((v) => v + 1);
  };
  const bank = [account.bankCode, account.branch, account.accountNumber].filter(Boolean).join(' · ');
  const others = caixa.accounts.filter((x) => !x.archivedAt || x.id === account.id);
  const thisMonth = current.data?.months[0];
  const rec = current.data?.reconciliation;

  return (
    <div className="page wide">
      <PageHead
        title={
          <span className="acc-title">
            <span className="acc-title-caixa">
              <Link to={`/caixas/${caixa.id}`} className="hover:text-[var(--accent-soft)]" title={t.caixa.home}>
                {caixa.name}
              </Link>
              <span aria-hidden>›</span>
            </span>
            {account.name}
          </span>
        }
        sub={
          <>
            {a.ofCaixa}{' '}
            <Link className="link" to={`/caixas/${caixa.id}`}>
              {caixa.name}
            </Link>{' '}
            · {t.caixa.accountKinds[account.kind]}
            {bank ? <span className="mono"> · {bank}</span> : null}
          </>
        }
        actions={
          <>
            {others.length > 1 && (
              <select
                className="field field-auto"
                value={account.id}
                aria-label={a.switchAccount}
                title={a.switchAccount}
                onChange={(e) => navigate(accountLink(caixa.id, e.target.value, tab))}
              >
                {others.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            <ButtonLink to={caixaTab(caixa.id, 'accounts')}>
              <ArrowLeft /> {a.backToCaixa}
            </ButtonLink>
            {writable && (
              <>
                <Button variant="ghost" onClick={() => setAdjusting(true)}>
                  <PlusCircle /> {t.caixa.adjustment}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil /> {t.common.edit}
                </Button>
              </>
            )}
          </>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge tone="outline">
            <Wallet /> {t.caixa.accountKinds[account.kind]}
          </Badge>
          {account.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
        </div>
      </PageHead>

      <div className="stat-tiles" data-testid="account-tiles">
        <Link to={accountLink(caixa.id, account.id, 'statement')} className="stat-tile">
          <div className="v">
            <Money cents={account.balanceCents} />
          </div>
          <div className="k">
            <Landmark /> {a.balanceNow.toLowerCase()}
          </div>
        </Link>
        <div className="stat-tile">
          <div className="v">{thisMonth ? <Money cents={thisMonth.inflowCents} /> : <Skel h={24} w={110} />}</div>
          <div className="k">
            <ArrowDownLeft /> {a.inflowMonth.toLowerCase()}
          </div>
        </div>
        <div className="stat-tile">
          <div className="v">{thisMonth ? <Money cents={thisMonth.outflowCents} /> : <Skel h={24} w={110} />}</div>
          <div className="k">
            <ArrowUpRight /> {a.outflowMonth.toLowerCase()}
          </div>
        </div>
        {reconciles ? (
          <Link to={accountLink(caixa.id, account.id, 'reconciliation')} className="stat-tile">
            <div className="v">{rec ? rec.newLines + rec.suggestedLines : '—'}</div>
            <div className="k">
              <ListChecks /> {a.pendingLines.toLowerCase()}
              {rec && ` · ${rec.lastPeriodEnd ? a.lastStatementUntil(formatDate(rec.lastPeriodEnd)) : a.noImports}`}
            </div>
          </Link>
        ) : (
          <div className="stat-tile">
            <div className="v">
              <Money cents={account.openingBalanceCents} muted />
            </div>
            <div className="k">
              {t.caixa.openingBalance.toLowerCase()} · {formatDate(account.openingDate)}
            </div>
          </div>
        )}
      </div>

      <Tabs
        value={tab}
        items={[
          { key: 'overview', label: a.overview, icon: <LayoutDashboard />, to: accountLink(caixa.id, account.id) },
          { key: 'statement', label: t.caixa.statement, icon: <FileText />, to: accountLink(caixa.id, account.id, 'statement') },
          ...(reconciles
            ? [
                {
                  key: 'reconciliation',
                  label: t.caixa.reconciliation,
                  icon: <ListChecks />,
                  count: rec ? rec.newLines + rec.suggestedLines || undefined : undefined,
                  to: accountLink(caixa.id, account.id, 'reconciliation'),
                },
                { key: 'rules', label: a.rules, icon: <Wand2 />, to: accountLink(caixa.id, account.id, 'rules') },
              ]
            : []),
        ]}
      />

      {tab === 'overview' && <AccountOverview key={`${account.id}-${version}`} account={account} caixaName={caixa.name} />}
      {tab === 'statement' && (
        <StatementTab key={`${account.id}-${version}`} caixa={caixa} fixedAccountId={account.id} onChanged={changed} />
      )}
      {tab === 'reconciliation' &&
        (reconciles ? (
          <StatementImportPanel key={account.id} caixaId={caixa.id} accountId={account.id} canWrite={caixa.canWrite} onChanged={changed} />
        ) : (
          <EmptyState icon={<ListChecks />} title={a.noReconciliation} description={a.reconciliationKinds} />
        ))}
      {tab === 'rules' &&
        (reconciles ? (
          <RulesPanel
            key={account.id}
            caixaId={caixa.id}
            target={{ accountId: account.id }}
            targetName={account.name}
            canWrite={writable}
          />
        ) : (
          <EmptyState icon={<Wand2 />} title={a.noReconciliation} description={a.reconciliationKinds} />
        ))}

      {editing && (
        <AccountFormModal
          caixaId={caixa.id}
          account={account}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            changed();
          }}
        />
      )}
      {adjusting && (
        <AdjustmentModal
          account={account}
          onClose={() => setAdjusting(false)}
          onSaved={() => {
            setAdjusting(false);
            changed();
          }}
        />
      )}
    </div>
  );
}
