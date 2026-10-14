import {
  AI_REQUEST_OPERATIONS,
  AI_REQUEST_STATUSES,
  AI_USAGE_PURPOSES,
  type AiAgentDto,
  type AiProviderDto,
  type AiRequestListItem,
  type AiRequestPage,
  type AppSettingDto,
  t,
  type UserRow,
} from '@moneyflow/shared';
import { RotateCcw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, withQuery } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { useParamState } from '../../lib/params';
import { LoadError } from '../domain';
import { Badge, Button, Field, Panel } from '../ui';
import { RequestDrawer } from './RequestDrawer';
import { RequestsTable } from './RequestsTable';

const r = t.agentsUi.admin.requests;
const RETENTION_KEY = 'ai.request_retention_days';

type Filters = {
  from: string;
  to: string;
  providerId: string;
  agentId: string;
  userId: string;
  operation: string;
  purpose: string;
  status: string;
  model: string;
};

const EMPTY: Filters = { from: '', to: '', providerId: '', agentId: '', userId: '', operation: '', purpose: '', status: '', model: '' };

/** Lista paginada por cursor (a próxima página entra no fim). */
export function useRequestPages(query: Record<string, string>) {
  const key = JSON.stringify(query);
  const [items, setItems] = useState<AiRequestListItem[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      try {
        const page = await api.get<AiRequestPage>(withQuery('/api/admin/ai/requests', { ...JSON.parse(key), cursor: cursor ?? undefined }));
        setItems((current) => (cursor ? [...(current ?? []), ...page.items] : page.items));
        setNext(page.nextCursor);
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
    setItems(undefined);
    void load(null);
  }, [load]);

  return { items, next, error, loading, reload: () => load(null), more: () => (next ? load(next) : Promise.resolve()) };
}

/** Guia "Requisições" de /admin/ai (spec 023): todas as requisições, com filtros, cursor, retenção e a gaveta do detalhe. */
export function RequestsTab() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [opened, setOpened] = useParamState('request');
  const providers = useApi<AiProviderDto[]>('/api/admin/ai/providers');
  const agents = useApi<AiAgentDto[]>('/api/admin/ai/agents');
  const users = useApi<UserRow[]>('/api/users');
  const pages = useRequestPages(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>);
  const set = (key: keyof Filters) => (event: { target: { value: string } }) => setFilters((f) => ({ ...f, [key]: event.target.value }));

  return (
    <>
      <RetentionPanel />
      <div className="request-filters mb-3" data-testid="request-filters">
        <Field label={r.from}>
          <input className="field" type="date" value={filters.from} onChange={set('from')} max={filters.to || undefined} />
        </Field>
        <Field label={r.to}>
          <input className="field" type="date" value={filters.to} onChange={set('to')} min={filters.from || undefined} />
        </Field>
        <Field label={r.provider}>
          <select className="field" value={filters.providerId} onChange={set('providerId')} data-testid="request-filter-provider">
            <option value="">{r.all}</option>
            {providers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={r.agent}>
          <select className="field" value={filters.agentId} onChange={set('agentId')}>
            <option value="">{r.all}</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={r.user}>
          <select className="field" value={filters.userId} onChange={set('userId')}>
            <option value="">{r.all}</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username}
              </option>
            ))}
          </select>
        </Field>
        <Field label={r.operation}>
          <select className="field" value={filters.operation} onChange={set('operation')} data-testid="request-filter-operation">
            <option value="">{r.all}</option>
            {AI_REQUEST_OPERATIONS.map((op) => (
              <option key={op} value={op}>
                {r.operations[op] ?? op}
              </option>
            ))}
          </select>
        </Field>
        <Field label={r.purpose}>
          <select className="field" value={filters.purpose} onChange={set('purpose')}>
            <option value="">{r.all}</option>
            {AI_USAGE_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {t.agentsUi.admin.usage.purposes[p] ?? p}
              </option>
            ))}
          </select>
        </Field>
        <Field label={r.status}>
          <select className="field" value={filters.status} onChange={set('status')} data-testid="request-filter-status">
            <option value="">{r.all}</option>
            {AI_REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {r.statuses[s] ?? s}
              </option>
            ))}
          </select>
        </Field>
        <Field label={r.model}>
          <input className="field field-mono" value={filters.model} onChange={set('model')} spellCheck={false} />
        </Field>
        <div className="flex items-end">
          <Button variant="ghost" onClick={() => setFilters(EMPTY)} disabled={Object.values(filters).every((v) => !v)}>
            {r.clear}
          </Button>
        </div>
      </div>
      {pages.error ? (
        <LoadError error={pages.error} onRetry={() => void pages.reload()} />
      ) : (
        <>
          <RequestsTable items={pages.items} onOpen={setOpened} />
          {pages.next && (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" disabled={pages.loading} onClick={() => void pages.more()} data-testid="request-load-more">
                {r.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
      {opened && <RequestDrawer key={opened} requestId={opened} onClose={() => setOpened(null)} />}
    </>
  );
}

/** Retenção das requisições: o valor do banco vence a variável; "Usar o padrão" apaga o do banco. */
function RetentionPanel() {
  const { data, error, reload, setData } = useApi<AppSettingDto>(`/api/admin/settings/${RETENTION_KEY}`);
  const [value, setValue] = useState('');
  const { run, busy } = useAction();
  useEffect(() => {
    if (data) setValue(String(data.value ?? ''));
  }, [data]);

  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  const save = async () => {
    const saved = await run(
      () => api.put<AppSettingDto>(`/api/admin/settings/${RETENTION_KEY}`, { value: Number(value) }),
      r.retentionSaved,
    );
    if (saved) setData(saved);
  };
  const reset = async () => {
    const saved = await run(() => api.del<AppSettingDto>(`/api/admin/settings/${RETENTION_KEY}`), r.retentionReset);
    if (saved) setData(saved);
  };
  return (
    <Panel className="mb-4">
      <div className="flex flex-wrap items-end gap-3" data-testid="retention-panel">
        <Field label={r.retention} hint={r.retentionHint}>
          <input
            className="field w-28"
            type="number"
            min={1}
            max={365}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="retention-input"
          />
        </Field>
        <Button
          disabled={busy || !data || value === '' || Number(value) === data.value}
          onClick={() => void save()}
          data-testid="retention-save"
        >
          <Save /> {r.retentionSave}
        </Button>
        <Button variant="ghost" disabled={busy || data?.source !== 'database'} onClick={() => void reset()} data-testid="retention-default">
          <RotateCcw /> {r.retentionDefault}
        </Button>
        {data && (
          <span className="pb-2 text-xs text-faint" data-testid="retention-source" data-source={data.source}>
            <Badge tone={data.source === 'database' ? 'accent' : 'outline'}>{data.source === 'database' ? r.sourceDb : r.sourceEnv}</Badge>{' '}
            {data.source === 'database'
              ? r.retentionFromDb
              : r.retentionFromEnv(data.envName ?? 'AI_REQUEST_RETENTION_DAYS', String(data.envValue))}
          </span>
        )}
      </div>
    </Panel>
  );
}
