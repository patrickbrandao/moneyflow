import { type ContractDetail, formatAccounting, formatDate, formatDateTime, t } from '@moneyflow/shared';
import { Badge } from '../ui';

const C = t.contracts;

/** Valor de uma mudança do aditivo, legível. */
function changeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key.endsWith('Cents') && typeof value === 'number') return formatAccounting(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Histórico: vigências (as antigas com o resumo do ciclo), aditivos, rescisão e as tarefas de renovação antigas. */
export function ContractHistory({ contract }: { contract: ContractDetail }) {
  const A = C.amendment;
  const R = C.renewal;
  const H = C.history;
  const nameOf = (ruleId: string) => contract.obligations.find((o) => o.id === ruleId)?.description ?? ruleId.slice(0, 8);
  return (
    <div className="grid gap-5" data-testid="contract-history">
      <section>
        <h3 className="mb-2 text-sm font-semibold">{H.cycles}</h3>
        <ul className="item-list" data-testid="contract-cycles">
          {contract.cycles.map((cycle) => (
            <li key={cycle.id} className="item">
              <span className="grow min-w-0">
                <span className="row-title">
                  {C.cycleLabel(cycle.seq)} · {C.termRange(formatDate(cycle.startsOn), cycle.endsOn ? formatDate(cycle.endsOn) : null)}
                </span>
                {cycle.legacy && (
                  <span className="row-sub">
                    {C.legacyCycle(
                      cycle.legacy.installmentsCount,
                      C.periodicities[cycle.legacy.periodicity] ?? cycle.legacy.periodicity,
                      formatAccounting(cycle.legacy.totalCents),
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{A.history}</h3>
        {contract.amendments.length === 0 ? (
          <p className="hint">{A.noHistory}</p>
        ) : (
          <ul className="item-list" data-testid="contract-amendments">
            {contract.amendments.map((a) => {
              const keys = Object.keys(a.changes.after).filter(
                (key) => !(key.endsWith('Id') && `${key.slice(0, -2)}Name` in a.changes.after),
              );
              return (
                <li key={a.id} className="item">
                  <span className="grow min-w-0">
                    <span className="row-title flex flex-wrap items-center gap-2">
                      {formatDate(a.effectiveOn)}
                      {a.cycleSeq !== null && <span className="text-faint text-xs">{C.cycleLabel(a.cycleSeq)}</span>}
                      {a.documentTitle && <Badge tone="outline">{a.documentTitle}</Badge>}
                    </span>
                    {a.ruleIds.length > 0 && (
                      <span className="row-sub">
                        {A.obligations}: {a.ruleIds.map(nameOf).join(', ')}
                      </span>
                    )}
                    <span className="row-sub">
                      {keys
                        .map(
                          (key) =>
                            `${A.changeLabels[key] ?? key}: ${changeValue(key, a.changes.before[key])} → ${changeValue(key, a.changes.after[key])}`,
                        )
                        .join(' · ')}
                    </span>
                    <span className="row-sub">
                      {A.affected(a.affectedCount)}
                      {a.skippedCount > 0 && ` · ${A.skipped(a.skippedCount)}`} · {a.createdByName ?? '—'} · {formatDateTime(a.createdAt)}
                      {a.notes ? ` · ${a.notes}` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {contract.terminatedOn && (
        <section data-testid="contract-termination">
          <h3 className="mb-2 text-sm font-semibold">{H.termination}</h3>
          <p className="text-sm">{H.terminatedOn(formatDate(contract.terminatedOn))}</p>
          {contract.terminationNotes && <p className="hint whitespace-pre-wrap">{contract.terminationNotes}</p>}
        </section>
      )}

      {contract.renewalTasks.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{R.tasks}</h3>
          <ul className="item-list">
            {contract.renewalTasks.map((task) => (
              <li key={task.id} className="item">
                <span className="grow min-w-0">
                  <span className="row-title">
                    {C.cycleLabel(task.cycleSeq)} · {formatDate(task.openedOn)} – {formatDate(task.dueOn)}
                  </span>
                  <span className="row-sub">
                    {task.decidedAt ? R.decidedBy(task.decidedByName ?? '—', formatDateTime(task.decidedAt)) : '—'}
                    {task.decisionNotes ? ` · ${task.decisionNotes}` : ''}
                  </span>
                </span>
                <Badge tone={task.status === 'approved' ? 'ok' : 'neutral'}>{R.taskStatuses[task.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
