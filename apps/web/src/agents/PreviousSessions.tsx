import { type AgentSessionsPage, type ConversationDto, formatDateTime, t } from '@moneyflow/shared';
import { GitBranch, History, Loader2, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Modal, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useAgents } from './AgentsProvider';
import { AgentDot } from './ConversationPane';
import { useConversationActions } from './useConversationActions';

const u = t.agentsUi;
const PAGE = 20;

/**
 * As sessões finalizadas de um agente (spec 026), mais recentes primeiro, com
 * busca e "Carregar mais". Abrir mostra a sessão numa janela de leitura (com
 * "Bifurcar daqui"); o dono também bifurca e exclui pela linha. O admin vê as
 * de outro usuário (`userId`), só para ler.
 */
export function PreviousSessions({ agentId, userId, onOpen }: { agentId: string; userId?: string; onOpen?: () => void }) {
  const user = useUser();
  const agents = useAgents();
  const own = !userId || userId === user.id;
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const [items, setItems] = useState<ConversationDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const { actions, modal } = useConversationActions();
  const generation = useRef(0);

  const fetchPage = useCallback(
    (offset: number) =>
      api.get<AgentSessionsPage>(`/api/agents/${agentId}/sessions`, {
        q: q || undefined,
        userId: own ? undefined : userId,
        limit: PAGE,
        offset,
      }),
    [agentId, q, own, userId],
  );

  useEffect(() => {
    const mine = ++generation.current;
    setItems(null);
    fetchPage(0)
      .then((page) => {
        if (mine !== generation.current) return;
        setItems(page.items);
        setHasMore(page.hasMore);
      })
      .catch(() => {
        if (mine === generation.current) setItems([]);
      });
  }, [fetchPage, agents.listVersion]);

  async function more() {
    if (!items) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(items.length);
      setItems([...items, ...page.items.filter((c) => !items.some((i) => i.id === c.id))]);
      setHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  function open(c: ConversationDto) {
    agents.openConversation(c);
    onOpen?.();
  }

  return (
    <div className="agents-previous" data-testid="agent-previous-sessions">
      <div className="agents-search">
        <Search />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={u.list.previousSearch}
          aria-label={u.list.previousSearch}
        />
      </div>
      <div className="agents-previous-list">
        {items === null && (
          <div className="agents-loading">
            <Loader2 className="spin" />
          </div>
        )}
        {items && items.length === 0 && <EmptyState icon={<History />} title={q ? u.list.emptySearch : u.list.previousEmpty} />}
        {items?.map((c) => (
          <div key={c.id} className="agents-row" data-testid="agent-previous-session" data-conversation-id={c.id}>
            <button
              type="button"
              className="agents-row-open"
              onClick={() => open(c)}
              title={u.actions.open}
              data-testid="agent-previous-open"
            >
              <AgentDot slot={c.agentColorSlot} />
              <span className="min-w-0 flex-1">
                <span className="agents-row-title">{c.title ?? u.list.untitled}</span>
                {c.snippet && <span className="agents-row-snippet">{c.snippet}</span>}
                <span className="agents-row-meta">
                  {u.list.finishedOn(formatDateTime(c.archivedAt ?? c.lastMessageAt ?? c.createdAt))}
                  {!own ? ` · ${u.list.byUser(c.username)}` : ''}
                </span>
              </span>
            </button>
            {own && (
              <span className="agents-row-actions">
                <button
                  type="button"
                  className="row-action"
                  title={u.actions.forkHint}
                  aria-label={u.actions.fork}
                  onClick={async () => {
                    if (await actions.fork(c)) onOpen?.();
                  }}
                >
                  <GitBranch />
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
        ))}
        {hasMore && (
          <div className="agents-more">
            <Button size="sm" variant="ghost" onClick={() => void more()} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="spin" /> : null} {u.list.loadMore}
            </Button>
          </div>
        )}
      </div>
      {modal}
    </div>
  );
}

/** "Sessões anteriores" a partir da janela do agente. */
export function PreviousSessionsModal({
  agentId,
  agentName,
  open,
  onClose,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open} title={u.list.previousOf(agentName)} onClose={onClose}>
      {open && <PreviousSessions agentId={agentId} onOpen={onClose} />}
    </Modal>
  );
}
