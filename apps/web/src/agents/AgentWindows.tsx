import { type ConversationDetail, t } from '@moneyflow/shared';
import { Archive, ArchiveRestore, GitBranch, Minus, MoreHorizontal, PanelRight, Pencil, Pin, PinOff, X } from 'lucide-react';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx, Menu, MenuItem } from '../components/ui';
import { type AgentWindow, useAgents } from './AgentsProvider';
import { AgentDot, ConversationPane } from './ConversationPane';
import { useConversationActions } from './useConversationActions';

const u = t.agentsUi;
export const NARROW_QUERY = '(max-width: 900px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches;

/**
 * Cabeçalho de uma conversa (janela ou painel): cor do agente, título e os
 * botões. O menu "…" tem renomear, fixar, bifurcar e arquivar (não aparece
 * em modo somente leitura).
 */
export function PaneHeader({
  win,
  detail,
  onPointerDown,
  buttons,
}: {
  win: AgentWindow;
  detail: ConversationDetail | null;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  buttons: ReactNode;
}) {
  const conversation = detail?.conversation;
  const title = conversation?.title ?? win.title ?? u.list.untitled;
  const { actions, modal } = useConversationActions();
  return (
    <div className="agent-head" onPointerDown={onPointerDown}>
      <AgentDot slot={conversation?.agentColorSlot ?? win.colorSlot} />
      <div className="agent-head-title">
        <span className="t" title={title}>
          {title}
        </span>
        <span className="s">
          {conversation?.agentName ?? win.agentName}
          {detail?.readOnly && conversation ? ` · @${conversation.username}` : ''}
        </span>
      </div>
      {conversation && !detail?.readOnly && (
        <Menu
          align="right"
          trigger={(props) => (
            <button type="button" className="icon-btn" title={u.actions.more} aria-label={u.actions.more} {...props}>
              <MoreHorizontal />
            </button>
          )}
        >
          <MenuItem icon={<Pencil />} onSelect={() => actions.rename(conversation)}>
            {u.actions.rename}
          </MenuItem>
          <MenuItem icon={conversation.pinnedAt ? <PinOff /> : <Pin />} onSelect={() => void actions.togglePin(conversation)}>
            {conversation.pinnedAt ? u.actions.unpin : u.actions.pin}
          </MenuItem>
          <MenuItem icon={<GitBranch />} onSelect={() => void actions.fork(conversation)}>
            {u.actions.fork}
          </MenuItem>
          <MenuItem
            icon={conversation.archivedAt ? <ArchiveRestore /> : <Archive />}
            onSelect={() => void actions.toggleArchive(conversation)}
          >
            {conversation.archivedAt ? u.actions.unarchive : u.actions.archive}
          </MenuItem>
        </Menu>
      )}
      {buttons}
      {modal}
    </div>
  );
}

function FloatingWindow({ win, layer }: { win: AgentWindow; layer: number }) {
  const agents = useAgents();
  const [live, setLive] = useState<Pick<AgentWindow, 'x' | 'y' | 'w' | 'h'> | null>(null);
  const geometry = live ?? win;
  const latest = useRef(geometry);
  latest.current = geometry;

  function track(event: ReactPointerEvent, mode: 'move' | 'resize') {
    if (event.button !== 0 || isNarrow()) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { x: win.x, y: win.y, w: win.w, h: win.h };
    document.body.classList.add('agent-dragging');
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const next =
        mode === 'move'
          ? { ...start, x: start.x + dx, y: Math.max(0, start.y + dy) }
          : { ...start, w: Math.max(320, start.w + dx), h: Math.max(280, start.h + dy) };
      latest.current = next;
      setLive(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('agent-dragging');
      agents.setGeometry(win.id, latest.current);
      setLive(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  return (
    <section
      className="agent-win"
      style={{ left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h, zIndex: layer }}
      onPointerDownCapture={() => agents.focus(win.id)}
      data-testid="agent-window"
      data-conversation-id={win.id}
      aria-label={win.title ?? u.list.untitled}
    >
      <ConversationPane
        conversationId={win.id}
        header={({ detail }) => (
          <PaneHeader
            win={win}
            detail={detail}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('button, a, input, [role="menu"]')) return;
              track(event, 'move');
            }}
            buttons={
              <>
                <button
                  type="button"
                  className="icon-btn"
                  title={u.window.dockRight}
                  aria-label={u.window.dockRight}
                  onClick={() => agents.dockRight(win.id)}
                  data-testid="agent-dock-right"
                >
                  <PanelRight />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={u.window.minimize}
                  aria-label={u.window.minimize}
                  onClick={() => agents.minimize(win.id)}
                  data-testid="agent-minimize"
                >
                  <Minus />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={u.window.close}
                  aria-label={u.window.close}
                  onClick={() => agents.close(win.id)}
                  data-testid="agent-close"
                >
                  <X />
                </button>
              </>
            }
          />
        )}
      />
      <span
        className="agent-resize"
        title={u.window.resize}
        aria-hidden
        onPointerDown={(event) => {
          event.stopPropagation();
          track(event, 'resize');
        }}
      />
    </section>
  );
}

/** Janelas flutuantes e a doca das minimizadas (fora do fluxo, em portal no body). */
export function AgentWindowsLayer() {
  const agents = useAgents();
  const { windows, docked, panelWidth, panelCollapsed } = agents.state;
  // Ordem de empilhamento: z relativo entre as janelas, sempre abaixo de gavetas e modais.
  // (a ordem do DOM não muda, para não tirar o foco de quem está digitando).
  const floating = windows.filter((w) => !w.minimized && w.id !== docked);
  const rank = new Map([...floating].sort((a, b) => a.z - b.z).map((w, index) => [w.id, index]));
  const minimized = windows.filter((w) => w.minimized && w.id !== docked);
  const dockRight = docked && !isNarrow() ? (panelCollapsed ? 44 : panelWidth) + 24 : 16;

  return createPortal(
    <>
      {floating.map((win) => (
        <FloatingWindow key={win.id} win={win} layer={30 + (rank.get(win.id) ?? 0)} />
      ))}
      {minimized.length > 0 && (
        <nav className="agent-dock" aria-label={u.window.dock} data-testid="agent-dock" style={{ right: dockRight }}>
          {minimized.map((win) => (
            <span key={win.id} className="agent-dock-item">
              <button
                type="button"
                className="agent-dock-open"
                onClick={() => agents.restore(win.id)}
                title={`${u.window.restore}: ${win.title ?? u.list.untitled}`}
                data-testid="agent-dock-item"
                data-conversation-id={win.id}
              >
                <AgentDot slot={win.colorSlot} />
                <span className="truncate">{win.title ?? win.agentName ?? u.list.untitled}</span>
              </button>
              <button
                type="button"
                className={cx('agent-dock-x')}
                aria-label={`${u.window.close}: ${win.title ?? u.list.untitled}`}
                onClick={() => agents.close(win.id)}
              >
                <X />
              </button>
            </span>
          ))}
        </nav>
      )}
    </>,
    document.body,
  );
}
