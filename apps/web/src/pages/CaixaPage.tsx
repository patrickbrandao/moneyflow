import { type CaixaDetail, t } from '@moneyflow/shared';
import {
  Archive,
  ArchiveRestore,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarCheck,
  FileText,
  Landmark,
  ListChecks,
  Pencil,
  Star,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CaixaFormModal } from '../components/CaixaFormModal';
import { AccountsTab } from '../components/caixa/AccountsTab';
import { MembersTab } from '../components/caixa/MembersTab';
import { StatementTab } from '../components/caixa/StatementTab';
import { CardCaixaView } from '../components/card/CardCaixaView';
import { ClosingTab } from '../components/closing/ClosingTab';
import { LoadError, Money, PageHead, RoleBadge } from '../components/domain';
import { ReconciliationTab } from '../components/reconciliation/ReconciliationTab';
import { useCrumbs } from '../components/shell/Layout';
import { TitlesTab } from '../components/titles/TitlesTab';
import { Badge, Button, Skel, Tabs, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useAction, useApi } from '../lib/hooks';
import { caixaTab } from '../lib/links';

const TABS = ['payables', 'receivables', 'accounts', 'statement', 'reconciliation', 'closing', 'members'] as const;
type Tab = (typeof TABS)[number];

/** Detalhe da caixa: títulos a pagar e a receber, contas, extrato e membros. */
export function CaixaPage() {
  const { id = '', tab: rawTab } = useParams();
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'payables';
  const user = useUser();
  const navigate = useNavigate();
  const { data: caixa, error, reload } = useApi<CaixaDetail>(`/api/caixas/${id}`);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  const { run } = useAction();
  useCrumbs(caixa ? [{ label: caixa.name }] : []);

  useRegisterCommands(
    caixa
      ? [
          {
            id: 'caixa-payables',
            label: `${caixa.name} › ${t.caixa.payables}`,
            group: 'Ir para',
            icon: <ArrowUpRight />,
            run: () => navigate(caixaTab(caixa.id, 'payables')),
          },
          {
            id: 'caixa-receivables',
            label: `${caixa.name} › ${t.caixa.receivables}`,
            group: 'Ir para',
            icon: <ArrowDownLeft />,
            run: () => navigate(caixaTab(caixa.id, 'receivables')),
          },
          {
            id: 'caixa-statement',
            label: `${caixa.name} › ${t.caixa.statement}`,
            group: 'Ir para',
            icon: <FileText />,
            run: () => navigate(caixaTab(caixa.id, 'statement')),
          },
          ...(caixa.canWrite
            ? [
                {
                  id: 'caixa-edit',
                  label: `Editar caixa ${caixa.name}`,
                  group: 'Recurso' as const,
                  icon: <Pencil />,
                  run: () => setEditing(true),
                },
              ]
            : []),
        ]
      : [],
    [caixa?.id, caixa?.canWrite],
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

  async function archive() {
    if (!caixa) return;
    const ok = await confirm({
      title: `Excluir a caixa ${caixa.name}?`,
      description: 'Sem vínculos ela é excluída; com títulos ou contas, é arquivada.',
      confirmLabel: t.common.delete,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () => api.del<{ archived: boolean }>(`/api/caixas/${caixa.id}`),
      (r) => t.common.deletedOrArchived(r.archived),
    );
    if (result?.archived) void reload();
    else if (result) navigate('/caixas');
  }

  async function restore() {
    if (caixa && (await run(() => api.post(`/api/caixas/${caixa.id}/restore`), 'Caixa restaurada.'))) void reload();
  }

  const refresh = () => void reload();

  return (
    <div className="page wide">
      <PageHead
        title={caixa.name}
        sub={
          <>
            {t.caixa.holder}:{' '}
            <Link className="link" to={`/entities/${caixa.holderEntityId}`}>
              {caixa.holderName}
            </Link>
            {caixa.description ? ` · ${caixa.description}` : ''}
          </>
        }
        actions={
          <>
            {caixa.canWrite && !caixa.archivedAt && (
              <Button variant="ghost" onClick={() => setEditing(true)}>
                <Pencil /> {t.common.edit}
              </Button>
            )}
            {user.role === 'admin' &&
              (caixa.archivedAt ? (
                <Button variant="ghost" onClick={() => void restore()}>
                  <ArchiveRestore /> {t.common.restore}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => void archive()}>
                  <Archive /> {t.common.delete}
                </Button>
              ))}
          </>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <RoleBadge role={caixa.myRole} />
          {caixa.isPrimary && (
            <Badge tone="outline">
              <Star /> {t.common.primary}
            </Badge>
          )}
          {caixa.archivedAt && <Badge tone="outline">{t.common.archived}</Badge>}
        </div>
      </PageHead>

      {caixa.kind === 'credit_card' ? (
        <CardCaixaView caixa={caixa} tab={rawTab} onChanged={refresh} />
      ) : (
        <>
          <div className="stat-tiles">
            <Link to={caixaTab(caixa.id, 'accounts')} className="stat-tile">
              <div className="v">
                <Money cents={caixa.balanceCents} />
              </div>
              <div className="k">
                <Landmark /> {t.caixa.balance.toLowerCase()}
              </div>
            </Link>
            <Link to={caixaTab(caixa.id, 'receivables')} className="stat-tile">
              <div className="v">
                <Money cents={caixa.receivableOpenCents} />
              </div>
              <div className="k">
                <ArrowDownLeft /> {t.caixa.receivableOpen.toLowerCase()}
              </div>
            </Link>
            <Link to={caixaTab(caixa.id, 'payables')} className="stat-tile">
              <div className="v">
                <Money cents={caixa.payableOpenCents} />
              </div>
              <div className="k">
                <ArrowUpRight /> {t.caixa.payableOpen.toLowerCase()}
              </div>
            </Link>
            <Link to={`${caixaTab(caixa.id, 'payables')}?status=overdue`} className="stat-tile">
              <div className="v">{caixa.overdueCount}</div>
              <div className="k">vencidos · {<Money cents={caixa.overdueCents} />}</div>
            </Link>
          </div>

          <Tabs
            value={tab}
            items={[
              { key: 'payables', label: t.caixa.payables, icon: <ArrowUpRight />, to: caixaTab(caixa.id, 'payables') },
              { key: 'receivables', label: t.caixa.receivables, icon: <ArrowDownLeft />, to: caixaTab(caixa.id, 'receivables') },
              {
                key: 'accounts',
                label: t.caixa.accounts,
                icon: <Landmark />,
                count: caixa.accounts.filter((a) => !a.archivedAt).length,
                to: caixaTab(caixa.id, 'accounts'),
              },
              { key: 'statement', label: t.caixa.statement, icon: <FileText />, to: caixaTab(caixa.id, 'statement') },
              {
                key: 'reconciliation',
                label: t.caixa.reconciliation,
                icon: <ListChecks />,
                to: caixaTab(caixa.id, 'reconciliation'),
              },
              { key: 'closing', label: t.caixa.closing, icon: <CalendarCheck />, to: caixaTab(caixa.id, 'closing') },
              { key: 'members', label: t.caixa.members, icon: <Users />, to: caixaTab(caixa.id, 'members') },
            ]}
          />

          {tab === 'payables' && <TitlesTab key="p" caixa={caixa} direction="payable" onChanged={refresh} />}
          {tab === 'receivables' && <TitlesTab key="r" caixa={caixa} direction="receivable" onChanged={refresh} />}
          {tab === 'accounts' && <AccountsTab caixa={caixa} onChanged={refresh} />}
          {tab === 'statement' && <StatementTab caixa={caixa} onChanged={refresh} />}
          {tab === 'reconciliation' && <ReconciliationTab caixa={caixa} onChanged={refresh} />}
          {tab === 'closing' && <ClosingTab caixa={caixa} />}
          {tab === 'members' && <MembersTab caixa={caixa} />}
        </>
      )}

      {editing && (
        <CaixaFormModal
          open
          caixa={caixa}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
