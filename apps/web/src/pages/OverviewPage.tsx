import { type Overview, t } from '@moneyflow/shared';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarClock, Landmark, Plus, Search, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { LoadError, Money, PageHead } from '../components/domain';
import { TitleMiniTable } from '../components/TitleMiniTable';
import { ButtonLink, EmptyState, Kbd, Panel, Skel } from '../components/ui';
import { useUser } from '../lib/auth';
import { usePalette } from '../lib/commands';
import { useApi } from '../lib/hooks';

/** Visão geral: saldos por caixa, vencidos e a vencer, e o que espera ação. */
export function OverviewPage() {
  const user = useUser();
  const { open: openPalette } = usePalette();
  const { data, error, reload } = useApi<Overview>('/api/overview');

  if (error) {
    return (
      <div className="page">
        <LoadError error={error} onRetry={() => void reload()} />
      </div>
    );
  }

  const totals = data?.totals;
  return (
    <div className="page wide">
      <PageHead
        title={`Olá, ${user.name}`}
        sub="Saldos das suas caixas e o que vence agora."
        actions={
          <>
            <button type="button" className="search-trigger" onClick={() => openPalette()}>
              <Search />
              <span className="ph">Procurar…</span>
              <span className="keys">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            {user.canEditRegistry && (
              <ButtonLink to="/caixas?new=1" variant="primary">
                <Plus /> {t.palette.newCaixa}
              </ButtonLink>
            )}
          </>
        }
      />

      <div className="stat-tiles">
        <Link to="/caixas" className="stat-tile">
          <div className="v">{totals ? <Money cents={totals.balanceCents} /> : '—'}</div>
          <div className="k">
            <Landmark /> {t.caixa.balance.toLowerCase()}
          </div>
        </Link>
        <Link to="/caixas" className="stat-tile">
          <div className="v">{totals ? <Money cents={totals.receivableOpenCents} /> : '—'}</div>
          <div className="k">
            <ArrowDownLeft /> {t.caixa.receivableOpen.toLowerCase()}
          </div>
        </Link>
        <Link to="/caixas" className="stat-tile">
          <div className="v">{totals ? <Money cents={totals.payableOpenCents} /> : '—'}</div>
          <div className="k">
            <ArrowUpRight /> {t.caixa.payableOpen.toLowerCase()}
          </div>
        </Link>
        <a href="#vencidos" className="stat-tile">
          <div className="v">{totals ? <Money cents={totals.overdueCents} /> : '—'}</div>
          <div className="k">
            <AlertTriangle /> vencidos em aberto
          </div>
        </a>
      </div>

      <div className="grid gap-4">
        <Panel
          title={t.nav.caixas}
          icon={<Wallet />}
          actions={
            <Link to="/caixas" className="link-action">
              {t.common.seeAll}
            </Link>
          }
        >
          {!data && (
            <div className="grid gap-2">
              {[0, 1, 2].map((i) => (
                <Skel key={i} h={44} />
              ))}
            </div>
          )}
          {data && data.caixas.length === 0 && (
            <EmptyState
              icon={<Wallet />}
              title="Nenhuma caixa ainda"
              description={
                user.canEditRegistry
                  ? 'Crie a primeira caixa para lançar contas a pagar e a receber.'
                  : 'Peça a um administrador acesso a uma caixa.'
              }
            />
          )}
          {data && data.caixas.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Caixa</th>
                    <th className="num">{t.caixa.balance}</th>
                    <th className="num">{t.caixa.receivableOpen}</th>
                    <th className="num">{t.caixa.payableOpen}</th>
                    <th className="num">Vencidos</th>
                  </tr>
                </thead>
                <tbody>
                  {data.caixas.map((caixa) => (
                    <tr key={caixa.id}>
                      <td>
                        <Link to={`/caixas/${caixa.id}`} className="row-title hover:text-[var(--accent-soft)]">
                          {caixa.name}
                        </Link>
                        <span className="row-sub">{caixa.holderName}</span>
                      </td>
                      <td className="num">
                        <Money cents={caixa.balanceCents} />
                      </td>
                      <td className="num">
                        <Money cents={caixa.receivableOpenCents} muted={caixa.receivableOpenCents === 0} />
                      </td>
                      <td className="num">
                        <Money cents={caixa.payableOpenCents} muted={caixa.payableOpenCents === 0} />
                      </td>
                      <td className="num">
                        {caixa.overdueCount > 0 ? (
                          <Link to={`/caixas/${caixa.id}/payables?status=overdue`} className="link">
                            {caixa.overdueCount} · <Money cents={caixa.overdueCents} />
                          </Link>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {data && (data.pendingMirrors.length > 0 || data.pendingAccounts.length > 0) && (
          <Panel title="Aguardando você" icon={<AlertTriangle />}>
            <p className="panel-hint">Espelhos que outra caixa lançou contra as suas e baixas com a conta a definir.</p>
            <TitleMiniTable rows={[...data.pendingMirrors, ...data.pendingAccounts]} empty="" />
          </Panel>
        )}

        <div className="grid gap-4 xl:grid-cols-2">
          <div id="vencidos">
            <Panel title={t.title.overdue} icon={<AlertTriangle />}>
              <TitleMiniTable rows={data?.overdue} empty="Nada vencido." />
            </Panel>
          </div>
          <Panel title={t.title.upcoming} icon={<CalendarClock />}>
            <TitleMiniTable rows={data?.upcoming} empty="Nada vence nos próximos 30 dias." />
          </Panel>
        </div>
      </div>
    </div>
  );
}
