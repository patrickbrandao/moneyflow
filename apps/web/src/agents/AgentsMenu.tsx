import { type AgentThreadDto, type ConversationDto, formatDateTime, t } from '@moneyflow/shared';
import { ArrowLeft, Bot, History, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx, EmptyState, useClickOutside, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useAgents } from './AgentsProvider';
import { AgentDot } from './ConversationPane';
import { isActiveStatus } from './format';
import { PreviousSessions } from './PreviousSessions';

const u = t.agentsUi;

/**
 * O ícone "Agentes" da topbar (spec 026): os agentes, cada um com a última
 * atividade, o título da sessão ativa e o indicador de execução; clicar abre a
 * janela do agente na sessão ativa. Cada agente tem "Sessões anteriores" (as
 * finalizadas, com busca), e a busca do topo cobre todas as sessões. O admin
 * pode listar os fios de todos os usuários (abrem em somente leitura).
 */
export function AgentsMenu() {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const agents = useAgents();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [threads, setThreads] = useState<AgentThreadDto[] | null>(null);
  const [hits, setHits] = useState<ConversationDto[] | null>(null);
  const [previous, setPrevious] = useState<AgentThreadDto | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Com um modal (renomear, excluir) ou a confirmação abertos, o clique fora não fecha a lista.
  useClickOutside(ref, () => !document.querySelector('.modal') && close(), open);
  const others = isAdmin && scope === 'all';

  const loadThreads = useCallback(async () => {
    const list = await api.get<AgentThreadDto[]>('/api/agents/threads', { userId: others ? 'all' : undefined }).catch(() => null);
    setThreads(list ?? []);
  }, [others]);

  // A contagem do ícone (execuções em andamento) vale também com a lista fechada.
  useEffect(() => {
    void loadThreads();
  }, [loadThreads, agents.listVersion, open]);

  useEffect(() => {
    if (!open || !q) {
      setHits(null);
      return;
    }
    let alive = true;
    setHits(null);
    api
      .get<ConversationDto[]>('/api/conversations', { q, userId: others ? 'all' : undefined, limit: 60 })
      .then((list) => alive && setHits(list))
      .catch(() => alive && setHits([]));
    return () => {
      alive = false;
    };
  }, [open, q, others, agents.listVersion]);

  useEffect(() => {
    if (!open) setPrevious(null);
  }, [open]);

  function openThread(thread: AgentThreadDto) {
    if (thread.userId === user.id) {
      agents.openAgent({
        agentId: thread.agentId,
        agentName: thread.agentName,
        colorSlot: thread.agentColorSlot,
        title: thread.active?.title ?? null,
      });
    } else if (thread.active) {
      agents.openConversation(thread.active);
    } else {
      setPrevious(thread);
      return;
    }
    close();
  }

  function openHit(conversation: ConversationDto) {
    agents.openConversation(conversation);
    close();
  }

  const running = (threads ?? []).filter((th) => th.userId === user.id && isActiveStatus(th.active?.activeRunStatus ?? null)).length;

  const threadRow = (th: AgentThreadDto) => {
    const status = th.active?.activeRunStatus ?? null;
    const readOnly = th.userId !== user.id;
    return (
      <div key={`${th.userId}:${th.agentId}`} className="agents-row" data-testid="agents-thread" data-agent-id={th.agentId}>
        <button
          type="button"
          className="agents-row-open"
          onClick={() => openThread(th)}
          title={u.actions.open}
          data-testid="agents-thread-open"
        >
          <AgentDot slot={th.agentColorSlot} />
          <span className="min-w-0 flex-1">
            <span className="agents-row-title">
              {th.agentName}
              {readOnly ? ` · ${u.list.byUser(th.username)}` : ''}
            </span>
            <span className="agents-row-snippet">{th.active ? (th.active.title ?? u.list.untitled) : u.list.noActive}</span>
            <span className="agents-row-meta">
              {th.lastActivityAt ? u.list.lastActivity(formatDateTime(th.lastActivityAt)) : u.list.never}
              {!th.agentUsable && ` · ${u.list.inactive}`}
              {isActiveStatus(status) && (
                <span className="agents-row-live" data-testid="agents-thread-running">
                  {' '}
                  · {status === 'awaiting_confirmation' ? u.list.awaiting : u.list.running}
                </span>
              )}
            </span>
          </span>
        </button>
        {th.finishedCount > 0 && (
          <span className="agents-row-actions always">
            <button
              type="button"
              className="row-action"
              title={u.list.previousCount(th.finishedCount)}
              aria-label={`${u.list.previous}: ${th.agentName}`}
              onClick={() => setPrevious(th)}
              data-testid="agents-thread-previous"
            >
              <History />
            </button>
          </span>
        )}
      </div>
    );
  };

  const hitRow = (c: ConversationDto) => (
    <div key={c.id} className="agents-row" data-testid="agents-search-hit" data-conversation-id={c.id}>
      <button type="button" className="agents-row-open" onClick={() => openHit(c)} title={u.actions.open}>
        <AgentDot slot={c.agentColorSlot} />
        <span className="min-w-0 flex-1">
          <span className="agents-row-title">{c.title ?? u.list.untitled}</span>
          {c.snippet && <span className="agents-row-snippet">{c.snippet}</span>}
          <span className="agents-row-meta">
            {c.agentName}
            {c.userId !== user.id ? ` · ${u.list.byUser(c.username)}` : ''} ·{' '}
            {c.archivedAt ? u.list.finishedOn(formatDateTime(c.archivedAt)) : u.list.activeBadge}
          </span>
        </span>
      </button>
    </div>
  );

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
        <div className={cx('notif agents-pop', previous && 'is-previous')} role="dialog" aria-label={u.list.title}>
          <div className="nh">
            {previous ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className="icon-btn"
                  title={u.list.back}
                  aria-label={u.list.back}
                  onClick={() => setPrevious(null)}
                  data-testid="agents-previous-back"
                >
                  <ArrowLeft />
                </button>
                <span className="truncate">{u.list.previousOf(previous.agentName)}</span>
              </span>
            ) : (
              <span>{u.list.title}</span>
            )}
            {isAdmin && !previous && (
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
          </div>
          {previous ? (
            <PreviousSessions
              key={`${previous.userId}:${previous.agentId}`}
              agentId={previous.agentId}
              userId={previous.userId}
              onOpen={close}
            />
          ) : (
            <>
              <div className="agents-search">
                <Search />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={u.list.search} aria-label={u.list.search} />
              </div>
              <div className="nb">
                {q ? (
                  <>
                    {hits === null && (
                      <div className="agents-loading">
                        <Loader2 className="spin" />
                      </div>
                    )}
                    {hits && hits.length === 0 && <EmptyState icon={<Search />} title={u.list.emptySearch} />}
                    {hits?.map(hitRow)}
                  </>
                ) : (
                  <>
                    {threads === null && (
                      <div className="agents-loading">
                        <Loader2 className="spin" />
                      </div>
                    )}
                    {threads && threads.length === 0 && (
                      <EmptyState
                        icon={<Bot />}
                        title={others ? u.list.emptyOthers : u.list.empty}
                        description={others ? undefined : u.list.emptyHint}
                      />
                    )}
                    {threads?.map(threadRow)}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
