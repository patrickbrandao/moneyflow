import { AUDIT_TABLES, type AuditEntry, formatDateTime, t, type UserRow } from '@moneyflow/shared';
import { ChevronDown, ChevronRight, History, ShieldAlert } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ActionBadge, ActorLabel, AuditDiff, columnLabel, tableLabel } from '../components/audit/AuditHistory';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { Button, CopyButton, cx, EmptyRow, EmptyState } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';

const PAGE = 50;
/** As tabelas do filtro: as de negócio e as auxiliares que também aparecem no log. */
const TABLE_OPTIONS = [...new Set<string>([...AUDIT_TABLES, ...Object.keys(t.audit.tables)])];

/** Log geral de auditoria (admin, spec 008): filtros, "carregar mais" e o antes/depois de cada linha. */
export function AuditPage() {
  const user = useUser();
  if (user.role !== 'admin') {
    return (
      <div className="page wide">
        <PageHead title={t.nav.audit} />
        <EmptyState icon={<ShieldAlert />} title={t.audit.adminOnly} />
      </div>
    );
  }
  return <AuditLog />;
}

function AuditLog() {
  const [table, setTable] = useParamState('table');
  const [userId, setUserId] = useParamState('user');
  const [actorKind, setActorKind] = useParamState('actor');
  const [from, setFrom] = useParamState('from');
  const [to, setTo] = useParamState('to');
  const [recordId, setRecordId] = useParamState('record');
  const users = useApi<UserRow[]>('/api/users');

  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const filters = { table, userId, actorKind, from, to, recordId: recordId && /^[0-9a-f-]{36}$/i.test(recordId) ? recordId : null };
  const key = JSON.stringify(filters);
  const filtered = Object.values(filters).some(Boolean);

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      try {
        const rows = await api.get<AuditEntry[]>('/api/audit', { ...JSON.parse(key), before, limit: PAGE });
        setEntries((current) => (before && current ? [...current, ...rows] : rows));
        setDone(rows.length < PAGE);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err)));
      } finally {
        setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    setEntries(null);
    setOpen(new Set());
    void load(null);
  }, [load]);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const last = entries?.[entries.length - 1];

  return (
    <div className="page wide">
      <PageHead title={t.nav.audit} sub={t.audit.pageSub} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="field field-auto"
          value={table ?? ''}
          onChange={(e) => setTable(e.target.value || null)}
          aria-label={t.audit.table}
        >
          <option value="">{t.audit.allTables}</option>
          {TABLE_OPTIONS.map((name) => (
            <option key={name} value={name}>
              {tableLabel(name)}
            </option>
          ))}
        </select>
        <select
          className="field field-auto"
          value={userId ?? ''}
          onChange={(e) => setUserId(e.target.value || null)}
          aria-label={t.audit.user}
        >
          <option value="">{t.audit.allUsers}</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <select
          className="field field-auto"
          value={actorKind ?? ''}
          onChange={(e) => setActorKind(e.target.value || null)}
          aria-label={t.audit.actorKind}
        >
          <option value="">{t.audit.allActors}</option>
          {(['human', 'agent', 'system'] as const).map((k) => (
            <option key={k} value={k}>
              {t.audit.actors[k]}
            </option>
          ))}
        </select>
        <input
          type="date"
          className="field field-auto"
          value={from ?? ''}
          onChange={(e) => setFrom(e.target.value || null)}
          aria-label={t.common.from}
          title={t.common.from}
        />
        <input
          type="date"
          className="field field-auto"
          value={to ?? ''}
          onChange={(e) => setTo(e.target.value || null)}
          aria-label={t.common.to}
          title={t.common.to}
        />
        <input
          className="field field-auto field-mono"
          value={recordId ?? ''}
          onChange={(e) => setRecordId(e.target.value.trim() || null)}
          placeholder={t.audit.recordId}
          aria-label={t.audit.recordId}
          size={24}
        />
      </div>

      {error && !entries ? (
        <LoadError error={error} onRetry={() => void load(null)} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th aria-label={t.audit.expand} />
                <th>{t.audit.when}</th>
                <th>{t.audit.table}</th>
                <th>{t.audit.record}</th>
                <th>{t.common.actions}</th>
                <th>{t.audit.who}</th>
                <th>{t.audit.what}</th>
              </tr>
            </thead>
            <tbody>
              {!entries && <SkelRows cols={7} rows={8} />}
              {entries && entries.length === 0 && <EmptyRow colSpan={7}>{filtered ? t.audit.emptyFiltered : t.audit.empty}</EmptyRow>}
              {entries?.map((entry) => {
                const expanded = open.has(entry.id);
                const changed = entry.action === 'update' ? (entry.changedColumns ?? []).filter((c) => c !== 'updated_at') : [];
                return (
                  <Fragment key={entry.id}>
                    <tr className={cx('cursor-pointer', expanded && 'is-selected')} onClick={() => toggle(entry.id)}>
                      <td>
                        <button
                          type="button"
                          className="row-action"
                          aria-expanded={expanded}
                          aria-label={expanded ? t.audit.collapse : t.audit.expand}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(entry.id);
                          }}
                        >
                          {expanded ? <ChevronDown /> : <ChevronRight />}
                        </button>
                      </td>
                      <td className="mono text-xs">{formatDateTime(entry.createdAt)}</td>
                      <td>{tableLabel(entry.tableName)}</td>
                      <td>
                        <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={() => {}}>
                          <button
                            type="button"
                            className="mono text-xs text-muted hover:text-ink"
                            title={t.audit.recordId}
                            onClick={() => setRecordId(entry.recordId)}
                          >
                            {entry.recordId.slice(0, 8)}…
                          </button>
                          <CopyButton text={entry.recordId} />
                        </span>
                      </td>
                      <td>
                        <ActionBadge action={entry.action} />
                      </td>
                      <td>
                        <ActorLabel entry={entry} />
                      </td>
                      <td className="text-[12px] text-muted">
                        {entry.action === 'update'
                          ? changed.slice(0, 4).map(columnLabel).join(', ') + (changed.length > 4 ? ` +${changed.length - 4}` : '')
                          : ''}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="audit-row-detail">
                        <td />
                        <td colSpan={6}>
                          <AuditDiff entry={entry} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {entries && entries.length > 0 && (
        <div className="mt-3 flex items-center gap-3">
          {done ? (
            <span className="text-[13px] text-faint">{t.audit.end}</span>
          ) : (
            <Button variant="ghost" disabled={loading} onClick={() => last && void load(last.id)}>
              <History /> {loading ? t.common.loading : t.audit.loadMore}
            </Button>
          )}
          {error && <span className="text-[13px] text-danger">{error.message}</span>}
        </div>
      )}
    </div>
  );
}
