import { type AuditEntry, type EntityTag, formatAccounting, formatDate, formatDateTime, t } from '@moneyflow/shared';
import { Bot, Cog, UserRound } from 'lucide-react';
import '../../styles/attachments.css';
import { useApi } from '../../lib/hooks';
import { LoadError } from '../domain';
import { Badge, Button, Modal, Skel } from '../ui';

/* Histórico de alterações (spec 008): antes → depois de cada coluna, com dinheiro e datas formatados. */

/** Colunas que não dizem nada a quem lê o histórico. */
const NOISE = new Set(['updated_at', 'search_vector', 'embedding', 'search_text']);
const isSecret = (column: string) => /password|secret|token/i.test(column);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ENUM_COLUMNS = new Set(['status', 'mirror_status', 'direction', 'action', 'origin']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const columnLabel = (column: string) => t.audit.columns[column] ?? column;
export const tableLabel = (table: string) => t.audit.tables[table] ?? table;

/** Valor de uma coluna para exibição. */
export function formatAuditValue(column: string, value: unknown, names?: Map<string, string>): string {
  if (isSecret(column)) return t.audit.hidden;
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? t.common.yes : t.common.no;
  if (column.endsWith('_cents') && (typeof value === 'number' || (typeof value === 'string' && /^-?\d+$/.test(value)))) {
    return formatAccounting(Number(value));
  }
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return formatDate(value);
    if (ISO_INSTANT.test(value)) return formatDateTime(value);
    if (UUID.test(value)) return names?.get(value) ?? `${value.slice(0, 8)}…`;
    return ENUM_COLUMNS.has(column) ? (t.audit.values[value] ?? value) : value;
  }
  if (typeof value === 'number') return value.toLocaleString('pt-BR');
  return JSON.stringify(value);
}

/** As linhas do antes/depois de uma entrada. */
export function diffRows(
  entry: AuditEntry,
  names?: Map<string, string>,
): { column: string; before: string | null; after: string | null }[] {
  const old = entry.oldData ?? {};
  const next = entry.newData ?? {};
  let columns: string[];
  if (entry.action === 'update') {
    columns = entry.changedColumns?.length
      ? entry.changedColumns
      : Object.keys(next).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(next[k]));
  } else {
    const data = entry.action === 'insert' ? next : old;
    columns = Object.keys(data).filter((k) => data[k] !== null && data[k] !== '' && k !== 'id');
  }
  return columns
    .filter((c) => !NOISE.has(c))
    .map((column) => ({
      column,
      before: entry.action === 'insert' ? null : formatAuditValue(column, old[column], names),
      after: entry.action === 'delete' ? null : formatAuditValue(column, next[column], names),
    }));
}

export function ActorLabel({ entry }: { entry: Pick<AuditEntry, 'actorKind' | 'username'> }) {
  const icon =
    entry.actorKind === 'agent' ? (
      <Bot className="size-3.5" />
    ) : entry.actorKind === 'system' ? (
      <Cog className="size-3.5" />
    ) : (
      <UserRound className="size-3.5" />
    );
  const name = entry.username ?? (entry.actorKind === 'system' ? t.audit.systemActor : t.audit.agentActor);
  return (
    <span className="inline-flex items-center gap-1 text-dim" title={t.audit.actors[entry.actorKind]}>
      {icon}
      {name}
      {entry.actorKind === 'agent' && <Badge tone="info">{t.audit.actors.agent}</Badge>}
    </span>
  );
}

export function ActionBadge({ action }: { action: AuditEntry['action'] }) {
  return <Badge tone={action === 'insert' ? 'ok' : action === 'delete' ? 'danger' : 'outline'}>{t.audit.actions[action]}</Badge>;
}

/** Tabela antes → depois. */
export function AuditDiff({ entry, names }: { entry: AuditEntry; names?: Map<string, string> }) {
  const rows = diffRows(entry, names);
  if (rows.length === 0) return <p className="mt-2 text-[12px] text-faint">{t.audit.noChanges}</p>;
  const showBefore = entry.action !== 'insert';
  const showAfter = entry.action !== 'delete';
  return (
    <table className="audit-diff">
      <thead>
        <tr>
          <th>{t.audit.column}</th>
          {showBefore && <th>{t.audit.before}</th>}
          {showAfter && <th>{t.audit.after}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.column}>
            <td className="col" title={row.column}>
              {columnLabel(row.column)}
            </td>
            {showBefore && <td className={entry.action === 'update' ? 'old' : undefined}>{row.before}</td>}
            {showAfter && <td className="new">{row.after}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Lista do histórico de um registro (sem moldura). */
export function AuditHistoryList({ table, recordId }: { table: string; recordId: string }) {
  const { data, error, reload } = useApi<AuditEntry[]>(`/api/audit/record?table=${encodeURIComponent(table)}&recordId=${recordId}`);
  // Na entidade, o histórico inclui as ligações com tags (spec 003): mostra o nome da tag.
  const tags = useApi<EntityTag[]>(table === 'entities' ? '/api/entity-tags?archived=1' : null);
  const names = tags.data ? new Map(tags.data.map((tag) => [tag.id, tag.name])) : undefined;
  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  if (!data) {
    return (
      <div className="grid gap-2">
        <Skel h={56} />
        <Skel h={56} />
      </div>
    );
  }
  if (data.length === 0) return <p className="text-[13px] text-faint">{t.audit.empty}</p>;
  return (
    <div className="audit-list">
      {data.map((entry) => (
        <div key={entry.id} className="audit-entry">
          <div className="head">
            <ActionBadge action={entry.action} />
            <span className="mono">{formatDateTime(entry.createdAt)}</span>
            <ActorLabel entry={entry} />
            {entry.tableName !== table && <Badge tone="outline">{tableLabel(entry.tableName)}</Badge>}
          </div>
          <AuditDiff entry={entry} names={names} />
        </div>
      ))}
    </div>
  );
}

/** Janela "Histórico" de um registro: recebe a tabela e o id. */
export function AuditHistory({
  table,
  recordId,
  title,
  onClose,
}: {
  table: string;
  recordId: string;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Modal open title={title ?? t.audit.history} onClose={onClose} wide>
      <div className="modal-body max-h-[65vh] overflow-auto">
        <AuditHistoryList table={table} recordId={recordId} />
      </div>
      <div className="actions">
        <Button variant="ghost" onClick={onClose}>
          {t.common.close}
        </Button>
      </div>
    </Modal>
  );
}
