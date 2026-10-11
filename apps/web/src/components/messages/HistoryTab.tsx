import { formatDateTime, type MessageDestinationDto, type OutboxMessageDto, type OutboxStatus, t } from '@moneyflow/shared';
import { Ban, ChevronDown, ChevronRight, History, RotateCcw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { useParamState } from '../../lib/params';
import { LoadError, SkelRows } from '../domain';
import { Badge, Button, cx, EmptyRow, type Tone } from '../ui';

const PAGE = 50;
const STATUS_TONE: Record<OutboxStatus, Tone> = { pending: 'info', sending: 'info', sent: 'ok', failed: 'danger', canceled: 'outline' };

/** Texto HTML do Telegram → texto puro para a prévia (as tags somem, as entidades voltam). */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** Histórico de envios (outbox): filtros por destino e status, reenviar e cancelar. */
export function HistoryTab({ destinations }: { destinations: MessageDestinationDto[] }) {
  const [destinationId, setDestination] = useParamState('destination');
  const [status, setStatus] = useParamState('status');
  const [rows, setRows] = useState<OutboxMessageDto[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const { run, busy } = useAction();

  const load = useCallback(
    async (before: string | null) => {
      try {
        const page = await api.get<OutboxMessageDto[]>('/api/message-outbox', { destinationId, status, before, limit: PAGE });
        setRows((current) => (before && current ? [...current, ...page] : page));
        setDone(page.length < PAGE);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err)));
      }
    },
    [destinationId, status],
  );
  useEffect(() => {
    setRows(null);
    void load(null);
  }, [load]);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function act(id: string, action: 'resend' | 'cancel') {
    const ok = await run(
      () => api.post(`/api/message-outbox/${id}/${action}`),
      action === 'resend' ? t.messages.resent : t.messages.canceled,
    );
    if (ok) void load(null);
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="field field-auto"
          value={destinationId ?? ''}
          onChange={(e) => setDestination(e.target.value || null)}
          aria-label={t.messages.destination}
        >
          <option value="">{t.messages.allDestinations}</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          className="field field-auto"
          value={status ?? ''}
          onChange={(e) => setStatus(e.target.value || null)}
          aria-label={t.common.status}
        >
          <option value="">{t.messages.allStatuses}</option>
          {Object.entries(t.messages.statuses).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && !rows ? (
        <LoadError error={error} onRetry={() => void load(null)} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th aria-label={t.messages.message} />
                <th>{t.messages.createdAt}</th>
                <th>{t.messages.destination}</th>
                <th>{t.messages.event}</th>
                <th>{t.common.status}</th>
                <th className="num">{t.messages.attempts}</th>
                <th>{t.messages.error}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!rows && <SkelRows cols={8} rows={6} />}
              {rows && rows.length === 0 && <EmptyRow colSpan={8}>{t.messages.historyEmpty}</EmptyRow>}
              {rows?.map((row) => (
                <Fragment key={row.id}>
                  <tr className={cx('cursor-pointer', open.has(row.id) && 'is-selected')} onClick={() => toggle(row.id)}>
                    <td>
                      <span className="report-caret">{open.has(row.id) ? <ChevronDown /> : <ChevronRight />}</span>
                    </td>
                    <td className="mono text-xs">{formatDateTime(row.createdAt)}</td>
                    <td>{row.destinationName}</td>
                    <td>{t.messages.events[row.eventKind] ?? row.eventKind}</td>
                    <td>
                      <Badge tone={STATUS_TONE[row.status]}>{t.messages.statuses[row.status]}</Badge>
                    </td>
                    <td className="num mono">
                      {row.attempts}/{row.maxAttempts}
                    </td>
                    <td className="msg-error" title={row.lastError ?? ''}>
                      {row.status === 'sent' ? '' : (row.lastError ?? '')}
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()} onKeyDown={() => {}}>
                      {row.canManage && row.status === 'failed' && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(row.id, 'resend')}>
                          <RotateCcw /> {t.messages.resend}
                        </Button>
                      )}
                      {row.canManage && (row.status === 'pending' || row.status === 'failed') && (
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={busy}
                          onClick={() => void act(row.id, 'cancel')}
                          title={t.messages.cancel}
                        >
                          <Ban />
                        </Button>
                      )}
                    </td>
                  </tr>
                  {open.has(row.id) && (
                    <tr className="msg-detail">
                      <td />
                      <td colSpan={7}>
                        <pre className="msg-preview">{plain(row.text)}</pre>
                        <dl className="kv mt-2">
                          <dt>{t.messages.sentAt}</dt>
                          <dd>{row.sentAt ? formatDateTime(row.sentAt) : '—'}</dd>
                          {row.status === 'pending' && (
                            <>
                              <dt>{t.messages.nextAttempt}</dt>
                              <dd>{formatDateTime(row.nextAttemptAt)}</dd>
                            </>
                          )}
                          {row.lastError && (
                            <>
                              <dt>{t.messages.error}</dt>
                              <dd className="mono">{row.lastError}</dd>
                            </>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="mt-3">
          {done ? (
            <span className="text-[13px] text-faint">{t.messages.end}</span>
          ) : (
            <Button variant="ghost" onClick={() => void load(rows[rows.length - 1]!.id)}>
              <History /> {t.messages.loadMore}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
