import { type AgentOptionDto, type ConversationDto, formatDateTime, t } from '@moneyflow/shared';
import { Archive, ArchiveRestore, Bot, GitBranch, Loader2, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { cx, EmptyState, useClickOutside, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useStored } from '../lib/storage';
import { conversationMeta, useAgents } from './AgentsProvider';
import { AgentDot } from './ConversationPane';
import { isActiveStatus } from './format';
import { useConversationActions } from './useConversationActions';

const u = t.agentsUi;

/**
 * O ícone "Agentes" da topbar: as conversas do usuário (fixadas primeiro,
 * busca com trecho, arquivadas), as ações de cada uma e "Nova conversa"
 * escolhendo o agente. O admin pode listar as conversas de todos (abrem em
 * modo somente leitura).
 */
export function AgentsMenu() {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const agents = useAgents();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const [archived, setArchived] = useState(false);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [items, setItems] = useState<ConversationDto[] | null>(null);
  const [options, setOptions] = useState<AgentOptionDto[] | null>(null);
  const [agentId, setAgentId] = useStored<string>('agents-last-agent', '');
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Com o modal de renomear ou a confirmação abertos, o clique fora não fecha a lista.
  useClickOutside(ref, () => !document.querySelector('.modal') && close(), open);
  const { actions, modal } = useConversationActions();
  const others = isAdmin && scope === 'all';

  const load = useCallback(async () => {
    const list = await api
      .get<ConversationDto[]>('/api/conversations', {
        q,
        archived: archived ? 1 : undefined,
        userId: others ? 'all' : undefined,
        limit: 60,
      })
      .catch(() => null);
    setItems(list ?? []);
  }, [q, archived, others]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, agents.listVersion]);

  useEffect(() => {
    if (!open || options) return;
    api
      .get<AgentOptionDto[]>('/api/agents')
      .then((list) => setOptions(list.filter((a) => a.isActive)))
      .catch(() => setOptions([]));
  }, [open, options]);

  const chosen = options?.find((a) => a.id === agentId) ?? options?.[0];

  async function create() {
    if (!chosen) return;
    setCreating(true);
    try {
      await agents.createConversation(chosen.id);
      setAgentId(chosen.id);
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  function openConversation(conversation: ConversationDto) {
    agents.open(conversationMeta(conversation));
    close();
  }

  const pinned = !q && !archived ? (items ?? []).filter((c) => c.pinnedAt) : [];
  const rest = (items ?? []).filter((c) => !pinned.includes(c));
  const running = (items ?? []).filter((c) => !others && isActiveStatus(c.activeRunStatus)).length;

  const row = (c: ConversationDto) => {
    const readOnly = c.userId !== user.id;
    return (
      <div key={c.id} className="agents-row">
        <button type="button" className="agents-row-open" onClick={() => openConversation(c)} title={u.actions.open}>
          <AgentDot slot={c.agentColorSlot} />
          <span className="min-w-0 flex-1">
            <span className="agents-row-title">{c.title ?? u.list.untitled}</span>
            {c.snippet && <span className="agents-row-snippet">{c.snippet}</span>}
            <span className="agents-row-meta">
              {c.agentName}
              {readOnly ? ` · ${u.list.byUser(c.username)}` : ''} · {formatDateTime(c.lastMessageAt ?? c.createdAt)}
              {isActiveStatus(c.activeRunStatus) && (
                <span className="agents-row-live">
                  {' '}
                  · {c.activeRunStatus === 'awaiting_confirmation' ? u.list.awaiting : u.list.running}
                </span>
              )}
            </span>
          </span>
        </button>
        {!readOnly && (
          <span className="agents-row-actions">
            <button
              type="button"
              className="row-action"
              title={c.pinnedAt ? u.actions.unpin : u.actions.pin}
              aria-label={c.pinnedAt ? u.actions.unpin : u.actions.pin}
              onClick={() => void actions.togglePin(c)}
            >
              {c.pinnedAt ? <PinOff /> : <Pin />}
            </button>
            <button
              type="button"
              className="row-action"
              title={u.actions.rename}
              aria-label={u.actions.rename}
              onClick={() => actions.rename(c)}
            >
              <Pencil />
            </button>
            <button
              type="button"
              className="row-action"
              title={u.actions.fork}
              aria-label={u.actions.fork}
              onClick={() => void actions.fork(c)}
            >
              <GitBranch />
            </button>
            <button
              type="button"
              className="row-action"
              title={c.archivedAt ? u.actions.unarchive : u.actions.archive}
              aria-label={c.archivedAt ? u.actions.unarchive : u.actions.archive}
              onClick={() => void actions.toggleArchive(c)}
            >
              {c.archivedAt ? <ArchiveRestore /> : <Archive />}
            </button>
            <button
              type="button"
              className="row-action danger"
              title={u.actions.delete}
              aria-label={u.actions.delete}
              onClick={() => void actions.remove(c)}
            >
              <Trash2 />
            </button>
          </span>
        )}
      </div>
    );
  };

  return (
    <div ref={ref} className="menu-anchor">
      <button
        type="button"
        className="icon-btn bell-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={u.openList}
        aria-label={u.openList}
        data-testid="agents-button"
      >
        <Bot />
        {running > 0 && <span className="n">{running}</span>}
      </button>
      {open && (
        <div className="notif agents-pop" role="dialog" aria-label={u.list.title}>
          <div className="nh">
            <span>{u.list.title}</span>
            <span className="flex items-center gap-1.5">
              {isAdmin && (
                <span className="segmented sm" role="group" aria-label={u.list.allUsers}>
                  <button
                    type="button"
                    className={cx(scope === 'mine' && 'active')}
                    aria-pressed={scope === 'mine'}
                    onClick={() => setScope('mine')}
                  >
                    {u.list.mine}
                  </button>
                  <button
                    type="button"
                    className={cx(scope === 'all' && 'active')}
                    aria-pressed={scope === 'all'}
                    onClick={() => setScope('all')}
                  >
                    {u.list.allUsers}
                  </button>
                </span>
              )}
              <button
                type="button"
                className={cx('agents-toggle', archived && 'on')}
                aria-pressed={archived}
                onClick={() => setArchived((a) => !a)}
                title={u.list.showArchived}
              >
                <Archive /> {u.list.showArchived}
              </button>
            </span>
          </div>
          <div className="agents-new">
            {options && options.length === 0 ? (
              <p className="text-[12px] text-muted">{u.list.noAgents}</p>
            ) : (
              <>
                <select
                  className="field field-sm"
                  value={chosen?.id ?? ''}
                  onChange={(e) => setAgentId(e.target.value)}
                  aria-label={u.list.chooseAgent}
                  data-testid="agents-new-agent"
                  disabled={!options}
                >
                  {(options ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void create()}
                  disabled={!chosen || creating}
                  data-testid="agents-new"
                >
                  {creating ? <Loader2 className="spin" /> : <Plus />} {u.list.newConversation}
                </button>
              </>
            )}
          </div>
          {chosen?.description && <p className="agents-desc">{chosen.description}</p>}
          <div className="agents-search">
            <Search />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={u.list.search} aria-label={u.list.search} />
          </div>
          <div className="nb">
            {items === null && (
              <div className="agents-loading">
                <Loader2 className="spin" />
              </div>
            )}
            {items && items.length === 0 && (
              <EmptyState
                icon={<Bot />}
                title={q ? u.list.emptySearch : archived ? u.list.emptyArchived : u.list.empty}
                description={q || archived ? undefined : u.list.emptyHint}
              />
            )}
            {pinned.length > 0 && <div className="grp">{u.list.pinned}</div>}
            {pinned.map(row)}
            {pinned.length > 0 && rest.length > 0 && <div className="grp">{archived ? u.list.archivedHeading : u.list.recent}</div>}
            {rest.map(row)}
          </div>
        </div>
      )}
      {modal}
    </div>
  );
}
