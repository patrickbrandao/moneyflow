import { type AiProviderSummary, type AiUsagePeriodSummary, formatDateTime, t, type UsageTotals } from '@moneyflow/shared';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatCost, formatInt } from '../agents/format';
import { ProviderFormModal } from '../components/admin-ai/ProvidersTab';
import { RequestDrawer } from '../components/admin-ai/RequestDrawer';
import { RequestsTable } from '../components/admin-ai/RequestsTable';
import { ActiveBadge } from '../components/admin-ai/shared';
import { LoadError, PageHead, SkelRows } from '../components/domain';
import { Badge, Button, EmptyRow, Panel, Tabs } from '../components/ui';
import { useUser } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { useParamState } from '../lib/params';
import { NotFoundPage } from './NotFoundPage';

const p = t.agentsUi.admin.providerDetail;
const kinds = t.agentsUi.admin.providers.kinds;

/**
 * Detalhe do provedor (spec 023, só admin): cabeçalho com o botão Editar (o
 * mesmo modal da lista), o resumo de uso (mês, 30 dias, total; por finalidade
 * e por modelo), a saúde dos últimos 7 dias e as 50 requisições recentes.
 */
export function AdminAiProviderPage() {
  const user = useUser();
  const { id } = useParams();
  const { data, error, reload } = useApi<AiProviderSummary>(user.role === 'admin' && id ? `/api/admin/ai/providers/${id}/summary` : null);
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useParamState('request');
  if (user.role !== 'admin') return <NotFoundPage />;

  const provider = data?.provider;
  return (
    <div className="page wide">
      <Link to="/admin/ai" className="back-link mb-2 inline-flex items-center gap-1 text-xs text-faint">
        <ArrowLeft size={12} /> {p.back}
      </Link>
      <PageHead
        title={provider?.name ?? p.header}
        sub={provider ? kinds[provider.kind] : undefined}
        actions={
          provider && (
            <Button onClick={() => setEditing(true)} data-testid="provider-edit">
              <Pencil /> {t.common.edit}
            </Button>
          )
        }
      />
      {error && <LoadError error={error} onRetry={() => void reload()} />}
      {provider && (
        <div className="grid gap-6">
          <Panel>
            <dl className="kv provider-kv" data-testid="provider-header">
              <dt>{p.kind}</dt>
              <dd>{kinds[provider.kind]}</dd>
              <dt>{p.baseUrl}</dt>
              <dd className="mono">{provider.baseUrl ?? p.defaultBaseUrl}</dd>
              <dt>{p.key}</dt>
              <dd className="mono">{provider.apiKeyHint ?? p.noKey}</dd>
              {provider.embeddingModel && (
                <>
                  <dt>{p.embeddingModel}</dt>
                  <dd className="mono">{provider.embeddingModel}</dd>
                </>
              )}
              <dt>{t.common.status}</dt>
              <dd>
                <ActiveBadge active={provider.isActive} archived={Boolean(provider.archivedAt)} />
              </dd>
              <dt>{p.bodies}</dt>
              <dd>
                <Badge tone={provider.logBodies ? 'warn' : 'outline'}>{provider.logBodies ? p.bodiesOn : p.bodiesOff}</Badge>
              </dd>
            </dl>
          </Panel>

          <UsageSummary usage={data.usage} />

          <section>
            <h2 className="text-h3 mb-2">{p.health}</h2>
            <div className="table-wrap">
              <table className="data" data-testid="provider-health">
                <thead>
                  <tr>
                    <th>{p.model}</th>
                    <th className="num">{p.requests}</th>
                    <th className="num">{p.errorRate}</th>
                    <th className="num">{p.p50}</th>
                    <th className="num">{p.p95}</th>
                    <th className="num">{p.firstByte}</th>
                    <th className="num">{p.avgAttempts}</th>
                    <th>{p.lastError}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.health.length === 0 && <EmptyRow colSpan={8}>{p.healthEmpty}</EmptyRow>}
                  {data.health.map((h) => (
                    <tr key={h.model ?? '-'}>
                      <td className="mono text-xs">{h.model ?? p.noModel}</td>
                      <td className="num mono text-xs">{formatInt(h.requests)}</td>
                      <td className="num mono text-xs">
                        {h.errorRate === null ? '—' : `${(h.errorRate * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
                      </td>
                      <td className="num mono text-xs">{ms(h.p50Ms)}</td>
                      <td className="num mono text-xs">{ms(h.p95Ms)}</td>
                      <td className="num mono text-xs">
                        {ms(h.p50FirstByteMs)} / {ms(h.p95FirstByteMs)}
                      </td>
                      <td className="num mono text-xs">{h.avgAttempts === null ? '—' : h.avgAttempts.toLocaleString('pt-BR')}</td>
                      <td className="text-xs">{h.lastErrorAt ? formatDateTime(h.lastErrorAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-baseline gap-3">
              <h2 className="text-h3">{p.recent}</h2>
              <span className="text-xs text-faint">{p.recentHint}</span>
              <span className="flex-1" />
              <Link to="/admin/ai/requests" className="text-xs">
                {p.seeAll}
              </Link>
            </div>
            <RequestsTable items={data.recent} onOpen={setOpened} showProvider={false} />
          </section>
        </div>
      )}
      {!data && !error && (
        <table className="data">
          <tbody>
            <SkelRows cols={4} rows={6} />
          </tbody>
        </table>
      )}
      {editing && provider && (
        <ProviderFormModal
          provider={provider}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void reload();
          }}
        />
      )}
      {opened && <RequestDrawer key={opened} requestId={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

const ms = (value: number | null) =>
  value === null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

const PERIODS = ['month', 'last30Days', 'total'] as const;

function Cost({ row }: { row: UsageTotals }) {
  return <>{row.costMicros !== null && row.currency ? formatCost(row.costMicros, row.currency) : '—'}</>;
}

function UsageSummary({ usage }: { usage: AiProviderSummary['usage'] }) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('month');
  const labels = { month: p.month, last30Days: p.last30, total: p.total };
  const current: AiUsagePeriodSummary = usage[period];
  return (
    <section data-testid="provider-usage">
      <h2 className="text-h3 mb-2">{p.usage}</h2>
      <Tabs
        value={period}
        onChange={(key) => setPeriod(key as typeof period)}
        items={PERIODS.map((key) => ({ key, label: labels[key] }))}
      />
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {current.totals.length === 0 ? (
          <p className="text-[13px] text-muted">{p.noUsage}</p>
        ) : (
          <div className="usage-tiles lg:col-span-2">
            {current.totals.map((row) => (
              <div key={row.currency ?? 'none'} className="usage-tile">
                <div className="text-xs text-faint">{p.calls}</div>
                <div className="text-h3 mono">{formatInt(row.calls)}</div>
                <div className="mt-1 text-xs text-dim">
                  {p.input} {formatInt(row.inputTokens)} · {p.output} {formatInt(row.outputTokens)} · {p.cacheWrite}{' '}
                  {formatInt(row.cacheWriteTokens)} · {p.cacheRead} {formatInt(row.cacheReadTokens)}
                </div>
                <div className="mt-1 text-xs">
                  {p.cost}: <Cost row={row} />
                </div>
              </div>
            ))}
          </div>
        )}
        <SliceTable title={p.byPurpose} rows={current.byPurpose} label={(key) => t.agentsUi.admin.usage.purposes[key] ?? key} />
        <SliceTable title={p.byModel} rows={current.byModel} label={(key) => key} mono />
      </div>
    </section>
  );
}

function SliceTable({
  title,
  rows,
  label,
  mono,
}: {
  title: string;
  rows: AiUsagePeriodSummary['byPurpose'];
  label: (key: string) => string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="eyebrow mb-1">{title}</div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th />
              <th className="num">{p.calls}</th>
              <th className="num">{p.input}</th>
              <th className="num">{p.output}</th>
              <th className="num">{p.cost}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={5}>{p.noUsage}</EmptyRow>}
            {rows.map((row) => (
              <tr key={`${row.key}-${row.currency}`}>
                <td className={mono ? 'mono text-xs' : undefined}>{label(row.key)}</td>
                <td className="num mono text-xs">{formatInt(row.calls)}</td>
                <td className="num mono text-xs">{formatInt(row.inputTokens)}</td>
                <td className="num mono text-xs">{formatInt(row.outputTokens)}</td>
                <td className="num mono text-xs">
                  <Cost row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
