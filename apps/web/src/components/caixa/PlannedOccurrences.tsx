import { formatDate, type TitleDetail, type TitleRow, t } from '@moneyflow/shared';
import { CalendarClock, CircleDollarSign, Handshake } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAction, useApi, useListLimit } from '../../lib/hooks';
import { titleLink } from '../../lib/links';
import { ListCutNotice, LoadError, Money, TitleStatusBadge } from '../domain';
import { SettlementModal } from '../titles/SettlementModal';
import { Badge, Button, Panel } from '../ui';

const PL = t.contracts.planned;

/**
 * Previstos da conta (spec 034): as ocorrências em aberto das séries com esta
 * conta prevista, separadas dos movimentos. "Baixar" abre a baixa já nesta
 * conta, na data de hoje e no valor em aberto (editáveis); no cofre é o único
 * jeito de registrar o fato.
 */
export function PlannedOccurrences({
  caixaId,
  accountId,
  canWrite,
  onChanged,
}: {
  caixaId: string;
  accountId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  // O servidor já ordena pelo vencimento; pede uma linha a mais para avisar do corte (tarefa 116).
  const list = useListLimit(accountId);
  const { data, error, reload, loading } = useApi<TitleRow[]>(
    `/api/titles?plannedAccountId=${accountId}&status=unpaid&limit=${list.limit + 1}`,
    { keepPrevious: list.growing },
  );
  const [settling, setSettling] = useState<TitleDetail | null>(null);
  const { run, busy } = useAction();
  const cut = Boolean(data && data.length > list.limit);
  const rows = data && cut ? data.slice(0, list.limit) : (data ?? []);

  async function openSettle(id: string) {
    const detail = await run(() => api.get<TitleDetail>(`/api/titles/${id}`));
    if (detail) setSettling(detail);
  }

  return (
    <Panel title={PL.title} icon={<CalendarClock />} className="mb-4">
      <section data-testid="planned-occurrences" aria-label={PL.title}>
        <p className="hint -mt-2 mb-2">{PL.hint}</p>
        {error && <LoadError error={error} onRetry={() => void reload()} />}
        {data && rows.length === 0 && <p className="text-[13px] text-faint">{PL.empty}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.title.due}</th>
                  <th>{t.common.description}</th>
                  <th>{t.common.status}</th>
                  <th className="num">{t.title.open}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-testid="planned-occurrence" data-title-id={row.id}>
                    <td className="mono text-xs">{formatDate(row.dueDate)}</td>
                    <td>
                      <Link
                        to={titleLink({ id: row.id, caixaId, direction: row.direction })}
                        className="row-title hover:text-[var(--accent-soft)]"
                      >
                        {row.description}
                      </Link>
                      <span className="row-sub inline-flex flex-wrap items-center gap-1">
                        {row.entityName}
                        {row.occurrence && <Badge mono>{t.title.occurrenceOf(row.occurrence, row.installmentsTotal)}</Badge>}
                        {row.contractName && (
                          <span className="inline-flex items-center gap-1">
                            <Handshake className="size-3" /> {row.contractName}
                          </span>
                        )}
                      </span>
                    </td>
                    <td>
                      <TitleStatusBadge title={row} />
                    </td>
                    <td className="num">
                      <Money cents={row.direction === 'payable' ? -row.openCents : row.openCents} signed />
                    </td>
                    <td className="text-right">
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          data-testid="planned-settle"
                          aria-label={`${PL.settle}: ${row.description} ${formatDate(row.dueDate)}`}
                          onClick={() => void openSettle(row.id)}
                        >
                          <CircleDollarSign /> {PL.settle}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cut && <ListCutNotice shown={rows.length} total={null} canMore={list.canMore} loading={loading} onMore={list.more} />}
      </section>
      {settling && (
        <SettlementModal
          title={settling}
          accountId={accountId}
          onClose={() => setSettling(null)}
          onSaved={() => {
            setSettling(null);
            void reload();
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}
