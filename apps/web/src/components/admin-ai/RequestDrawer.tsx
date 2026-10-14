import { type AiRequestBodyPart, type AiRequestDetail, buildCurl, formatDateTime, t } from '@moneyflow/shared';
import { Download, MessageSquare, Radio, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAgents } from '../../agents/AgentsProvider';
import { formatInt } from '../../agents/format';
import { downloadFile } from '../../lib/download';
import { useAction, useApi } from '../../lib/hooks';
import { formatBytes } from '../attachments/AttachmentsPanel';
import { LoadError } from '../domain';
import { Badge, Button, CopyButton, cx, Skel, Tabs } from '../ui';
import { JsonViewer } from './JsonViewer';
import { RequestStatusBadge } from './RequestsTable';

const r = t.agentsUi.admin.requests;
const d = r.drawer;

const ms = (value: number | null) => (value === null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toLocaleString('pt-BR')} s`);

/**
 * Gaveta do detalhe da requisição (spec 023): resumo com os links para a
 * conversa e a execução (somente leitura), a linha do tempo das tentativas,
 * cabeçalhos e corpo enviados e a resposta (montada e o stream bruto), e o
 * "Copiar como cURL" sem a chave.
 */
export function RequestDrawer({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const { data, error, reload } = useApi<AiRequestDetail>(`/api/admin/ai/requests/${requestId}`);
  const agents = useAgents();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="drawer page-drawer request-drawer" aria-label={d.title} data-testid="request-drawer">
      <div className="dh">
        <Radio size={18} />
        <span className="t">
          {d.title}
          {data && <span className="ml-2 font-normal text-faint">{r.operations[data.operation] ?? data.operation}</span>}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} title={`${t.common.close} (Esc)`} aria-label={t.common.close}>
          <X />
        </button>
      </div>
      <div className="db">
        {error && <LoadError error={error} onRetry={() => void reload()} />}
        {!data && !error && <Skel h={240} />}
        {data && (
          <>
            <div className="sec">
              <div className="flex flex-wrap items-center gap-1.5">
                <RequestStatusBadge status={data.status} />
                {data.httpStatus !== null && (
                  <Badge tone="outline" mono>
                    HTTP {data.httpStatus}
                  </Badge>
                )}
                {data.streaming && <Badge tone="info">{d.streaming}</Badge>}
                <span className="flex-1" />
                <CopyButton
                  label={d.copyCurl}
                  text={buildCurl({
                    method: data.method,
                    url: data.url,
                    headers: data.requestHeaders,
                    body: data.requestBody?.text ?? null,
                    providerKind: data.providerKind,
                  })}
                />
              </div>
              <dl className="kv mt-3">
                <dt>{d.provider}</dt>
                <dd>{data.providerName ?? '—'}</dd>
                <dt>{d.operation}</dt>
                <dd>
                  {r.operations[data.operation] ?? data.operation}
                  {data.purpose && ` · ${t.agentsUi.admin.usage.purposes[data.purpose] ?? data.purpose}`}
                </dd>
                <dt>{d.model}</dt>
                <dd className="mono">{data.model ?? '—'}</dd>
                <dt>{d.endpoint}</dt>
                <dd className="mono break-all">
                  {data.method} {data.path}
                </dd>
                <dt>{d.agent}</dt>
                <dd>{data.agentName ?? '—'}</dd>
                <dt>{d.user}</dt>
                <dd>{data.username ? `@${data.username}` : '—'}</dd>
                {data.conversationId && (
                  <>
                    <dt>{d.conversation}</dt>
                    <dd>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => agents.open({ id: data.conversationId!, title: data.conversationTitle })}
                        title={d.openConversation}
                        data-testid="request-open-conversation"
                      >
                        <MessageSquare size={12} /> {data.conversationTitle ?? data.conversationId.slice(0, 8)}
                      </button>
                    </dd>
                  </>
                )}
                {data.runId && (
                  <>
                    <dt>{d.run}</dt>
                    <dd className="mono">{data.runId}</dd>
                  </>
                )}
                <dt>{d.started}</dt>
                <dd>{formatDateTime(data.startedAt)}</dd>
                <dt>{d.duration}</dt>
                <dd>{ms(data.durationMs)}</dd>
                <dt>{d.firstByte}</dt>
                <dd>{ms(data.firstByteMs)}</dd>
                <dt>{d.tokens}</dt>
                <dd>
                  {d.tokensLine(
                    formatInt(data.inputTokens),
                    formatInt(data.outputTokens),
                    formatInt(data.cacheWriteTokens),
                    formatInt(data.cacheReadTokens),
                  )}
                </dd>
                <dt>{d.size}</dt>
                <dd>{d.sizeLine(formatBytes(data.requestBytes ?? 0), formatBytes(data.responseBytes ?? 0))}</dd>
                {data.errorMessage && (
                  <>
                    <dt>{d.error}</dt>
                    <dd className="text-danger">{data.errorMessage}</dd>
                  </>
                )}
              </dl>
            </div>

            <div className="sec">
              <div className="eyebrow">
                {d.attempts} ({data.attemptList.length})
              </div>
              <ol className="attempt-list" data-testid="request-attempts">
                {data.attemptList.map((a) => (
                  <li key={a.attempt} className={cx('attempt', a.errorType ? 'is-error' : 'is-ok')} data-testid="request-attempt">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{d.attempt(a.attempt)}</strong>
                      <span className="text-faint">{formatDateTime(a.startedAt)}</span>
                      {a.httpStatus !== null && (
                        <Badge tone={a.errorType ? 'danger' : 'ok'} mono>
                          {a.httpStatus}
                        </Badge>
                      )}
                      {a.errorType && <Badge tone="outline">{a.errorType}</Badge>}
                      <span className="text-faint">{ms(a.durationMs)}</span>
                      {a.retryAfterMs !== null && <span className="text-faint">{d.retryAfter(a.retryAfterMs)}</span>}
                    </div>
                    {a.errorMessage && <div className="mt-1 text-xs text-dim">{a.errorMessage}</div>}
                    {a.rateLimitHeaders && (
                      <div className="mt-1 text-xs">
                        <span className="text-faint">{d.rateLimit}: </span>
                        <span className="mono">
                          {Object.entries(a.rateLimitHeaders)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(' · ')}
                        </span>
                      </div>
                    )}
                    {a.responseBody && (
                      <details className="mt-1">
                        <summary className="text-xs text-faint">{d.errorBody}</summary>
                        <JsonViewer text={a.responseBody} name={`tentativa-${a.attempt}`} />
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            {!data.requestBody && !data.responseBody && !data.responseStream && !data.requestHeaders ? (
              <div className="sec">
                <p className="text-[13px] text-muted">{d.noBodies}</p>
              </div>
            ) : (
              <>
                <BodySection
                  title={d.requestPart}
                  requestId={data.id}
                  tabs={[
                    { key: 'body', label: d.body, part: data.requestBody, download: 'request' },
                    { key: 'headers', label: d.headers, headers: data.requestHeaders },
                  ]}
                />
                <BodySection
                  title={d.responsePart}
                  requestId={data.id}
                  tabs={[
                    { key: 'body', label: d.assembled, part: data.responseBody, download: 'response' },
                    ...(data.streaming ? [{ key: 'stream', label: d.stream, part: data.responseStream, download: 'stream' as const }] : []),
                    { key: 'headers', label: d.headers, headers: data.responseHeaders },
                  ]}
                />
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

type BodyTab = {
  key: string;
  label: string;
  part?: AiRequestBodyPart | null;
  headers?: Record<string, string> | null;
  download?: 'request' | 'response' | 'stream';
};

function BodySection({ title, requestId, tabs }: { title: string; requestId: string; tabs: BodyTab[] }) {
  const [active, setActive] = useState(tabs[0]!.key);
  const tab = tabs.find((x) => x.key === active) ?? tabs[0]!;
  const { run, busy } = useAction();
  return (
    <div className="sec" data-testid={`request-section-${title}`}>
      <div className="eyebrow">{title}</div>
      <Tabs value={tab.key} onChange={setActive} items={tabs.map((x) => ({ key: x.key, label: x.label }))} />
      <div className="mt-2">
        {tab.headers !== undefined ? (
          tab.headers ? (
            <JsonViewer text={JSON.stringify(tab.headers)} name="cabecalhos" />
          ) : (
            <p className="text-[13px] text-muted">{d.noPart}</p>
          )
        ) : !tab.part ? (
          <p className="text-[13px] text-muted">{d.noPart}</p>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs text-faint">{formatBytes(tab.part.bytes)}</span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    downloadFile(`/api/admin/ai/requests/${requestId}/body?part=${tab.download}`, `requisicao-${tab.download}`),
                  )
                }
              >
                <Download /> {d.download}
              </Button>
            </div>
            {tab.part.text === null ? (
              <p className="text-[13px] text-muted">{d.tooLarge(formatBytes(tab.part.bytes))}</p>
            ) : tab.key === 'stream' ? (
              <pre className="json-raw">{tab.part.text}</pre>
            ) : (
              <JsonViewer text={tab.part.text} name={`requisicao-${tab.download}`} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
