import { type CaixaSummary, t } from '@moneyflow/shared';
import { CreditCard, Plus, Star, Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { recordDragProps } from '../agents/records';
import { RowLink } from '../components/a11y';
import { CaixaFormModal } from '../components/CaixaFormModal';
import { FutureEntries, LoadError, Money, PageHead, RoleBadge, SkelRows } from '../components/domain';

import { Badge, Button, EmptyRow, Tabs } from '../components/ui';
import { useUser } from '../lib/auth';
import { useRegisterCommands } from '../lib/commands';
import { useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

/** Caixas que o usuário enxerga, com saldo e posição em aberto. */
export function CaixasPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [isNew, setNew] = useParamState('new');
  const [archived, setArchived] = useParamState('archived');
  const { data, error, reload } = useApi<CaixaSummary[]>(`/api/caixas${archived ? '?archived=1' : ''}`);

  useRegisterCommands(
    user.canEditRegistry ? [{ id: 'caixa-new', label: t.palette.newCaixa, group: 'Criar', icon: <Plus />, run: () => setNew('1') }] : [],
    [user.canEditRegistry],
  );

  return (
    <div className="page wide">
      <PageHead
        title={t.nav.caixas}
        sub={t.caixa.page.sub}
        actions={
          user.canEditRegistry && (
            <Button onClick={() => setNew('1')}>
              <Plus /> {t.palette.newCaixa}
            </Button>
          )
        }
      />
      <Tabs
        value={archived ? 'archived' : 'active'}
        onChange={(key) => setArchived(key === 'archived' ? '1' : null)}
        items={[
          { key: 'active', label: t.caixa.page.active },
          { key: 'archived', label: t.caixa.page.archived },
        ]}
      />
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.caixa.page.caixa}</th>
                <th>{t.caixa.holder}</th>
                <th>{t.caixa.page.yourRole}</th>
                <th className="num">{t.caixa.balance}</th>
                <th className="num">{t.caixa.receivableOpen}</th>
                <th className="num">{t.caixa.payableOpen}</th>
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={6} />}
              {data && data.length === 0 && (
                <EmptyRow colSpan={6}>
                  {archived ? t.caixa.page.noArchived : user.canEditRegistry ? t.caixa.page.noneYet : t.caixa.page.noAccess}
                </EmptyRow>
              )}
              {data?.map((caixa) => (
                <tr
                  key={caixa.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/caixas/${caixa.id}`)}
                  {...recordDragProps({ kind: 'caixa', id: caixa.id, label: caixa.name })}
                >
                  <td>
                    <span className="flex items-center gap-2">
                      {caixa.kind === 'credit_card' ? (
                        <CreditCard className="size-4 text-muted" aria-label={t.caixa.kinds.credit_card} />
                      ) : (
                        <Wallet className="size-4 text-muted" />
                      )}
                      <RowLink to={`/caixas/${caixa.id}`}>{caixa.name}</RowLink>
                      {caixa.kind === 'credit_card' && <CardEnding last4={caixa.cardLast4} />}
                      {caixa.isPrimary && (
                        <Badge tone="outline" title={t.caixa.isPrimary}>
                          <Star /> {t.common.primary}
                        </Badge>
                      )}
                    </span>
                    {caixa.description && <span className="row-sub">{caixa.description}</span>}
                  </td>
                  <td className="text-dim">{caixa.holderName}</td>
                  <td>
                    <RoleBadge role={caixa.myRole} />
                  </td>
                  <td className="num">
                    <Money cents={caixa.balanceCents} />
                    <FutureEntries cents={caixa.futureCents} />
                  </td>
                  <td className="num">
                    <Money cents={caixa.receivableOpenCents} muted={caixa.receivableOpenCents === 0} />
                  </td>
                  <td className="num">
                    <Money cents={caixa.payableOpenCents} muted={caixa.payableOpenCents === 0} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isNew && (
        <CaixaFormModal
          open
          onClose={() => setNew(null)}
          onSaved={(caixa) => {
            setNew(null);
            navigate(`/caixas/${caixa.id}`);
          }}
        />
      )}
    </div>
  );
}

/** Final do cartão (vem no resumo da caixa). */
function CardEnding({ last4 }: { last4: string | null }) {
  return (
    <Badge tone="outline" mono title={t.caixa.kinds.credit_card}>
      {last4 ? t.card.endingIn(last4) : t.caixa.kinds.credit_card}
    </Badge>
  );
}
