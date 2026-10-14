import { type AiRequestListItem, type AiRequestStatus, formatDateTime, t } from '@moneyflow/shared';
import { formatInt } from '../../agents/format';
import { SkelRows } from '../domain';
import { Badge, EmptyRow, type Tone } from '../ui';

const r = t.agentsUi.admin.requests;

const STATUS_TONE: Record<AiRequestStatus, Tone> = { running: 'info', ok: 'ok', error: 'danger', canceled: 'outline' };

export function RequestStatusBadge({ status }: { status: AiRequestStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{r.statuses[status] ?? status}</Badge>;
}

const duration = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

/** Tabela das requisições (guia Requisições e o detalhe do provedor); clicar abre a gaveta do detalhe. */
export function RequestsTable({
  items,
  onOpen,
  showProvider = true,
}: {
  items: AiRequestListItem[] | undefined;
  onOpen: (id: string) => void;
  showProvider?: boolean;
}) {
  const cols = showProvider ? 11 : 10;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{r.when}</th>
            {showProvider && <th>{r.provider}</th>}
            <th>{r.operation}</th>
            <th>{r.purpose}</th>
            <th>{r.model}</th>
            <th>{r.agent}</th>
            <th>{r.user}</th>
            <th>{r.status}</th>
            <th className="num">{r.attempts}</th>
            <th className="num">{r.duration}</th>
            <th className="num">{r.tokens}</th>
          </tr>
        </thead>
        <tbody>
          {!items && <SkelRows cols={cols} rows={4} />}
          {items?.length === 0 && <EmptyRow colSpan={cols}>{r.empty}</EmptyRow>}
          {items?.map((item) => (
            <tr
              key={item.id}
              className="cursor-pointer"
              onClick={() => onOpen(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onOpen(item.id);
              }}
              tabIndex={0}
              data-testid="request-row"
              data-request-id={item.id}
              data-status={item.status}
            >
              <td className="mono text-xs whitespace-nowrap">{formatDateTime(item.startedAt)}</td>
              {showProvider && <td>{item.providerName ?? '—'}</td>}
              <td>{r.operations[item.operation] ?? item.operation}</td>
              <td>{item.purpose ? (t.agentsUi.admin.usage.purposes[item.purpose] ?? item.purpose) : '—'}</td>
              <td className="mono text-xs">{item.model ?? '—'}</td>
              <td>{item.agentName ?? '—'}</td>
              <td>{item.username ? `@${item.username}` : '—'}</td>
              <td>
                <RequestStatusBadge status={item.status} />
                {item.httpStatus !== null && item.status === 'error' && (
                  <span className="ml-1 mono text-xs text-faint">{item.httpStatus}</span>
                )}
              </td>
              <td className="num mono text-xs">{item.attempts}</td>
              <td className="num mono text-xs">{duration(item.durationMs)}</td>
              <td className="num mono text-xs">
                {formatInt(item.inputTokens + item.cacheReadTokens + item.cacheWriteTokens)} / {formatInt(item.outputTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
