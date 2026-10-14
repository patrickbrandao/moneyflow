import { t } from '@moneyflow/shared';
import { CircleCheckBig, Copy, GitBranch, Headphones, History, Minus, MoreHorizontal, PanelRight, Pencil, Trash2, X } from 'lucide-react';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../components/Toast';
import { cx, Menu, MenuItem } from '../components/ui';
import { type AgentWindow, useAgents } from './AgentsProvider';
import { AgentDot, ConversationPane, type PaneHeaderInfo } from './ConversationPane';
import { PreviousSessionsModal } from './PreviousSessions';
import type { PaneTarget } from './useConversation';
import { useConversationActions } from './useConversationActions';

const u = t.agentsUi;
export const NARROW_QUERY = '(max-width: 900px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches;

/** O alvo do miolo da janela: o fio do agente ou uma sessão fixa (leitura). */
export const paneTarget = (win: AgentWindow): PaneTarget =>
  win.kind === 'agent'
    ? { kind: 'agent', agentId: win.agentId || win.id, windowId: win.id }
    : { kind: 'session', conversationId: win.conversationId ?? win.id, windowId: win.id };

/**
 * Cabeçalho de uma janela (flutuante ou painel), spec 026: cor e nome do
 * agente, título da sessão e os botões. Na janela do agente: "Finalizar
 * sessão" (com confirmação), "Sessões anteriores" e o modo áudio (spec 025,
 * só quando o agente converte texto em áudio). Na de leitura de uma
 * finalizada: "Bifurcar daqui". O menu "…" mostra o id da sessão (copiar),
 * renomear e, na finalizada, excluir.
 */
export function PaneHeader({
  win,
  info,
  onPointerDown,
  buttons,
}: {
  win: AgentWindow;
  info: PaneHeaderInfo;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  buttons: ReactNode;
}) {
  const { detail, state } = info;
  const conversation = detail?.conversation ?? null;
  const isAgent = win.kind === 'agent';
  const readOnly = detail?.readOnly ?? false;
  const finished = Boolean(conversation?.archivedAt);
  // Carregando: o título salvo na janela; o fio sem sessão ativa: "Nova sessão".
  const title = conversation
    ? (conversation.title ?? u.list.untitled)
    : detail && isAgent
      ? u.window.newSession
      : (win.title ?? (isAgent ? u.window.newSession : u.list.untitled));
  const agentName = conversation?.agentName ?? state.agent?.name ?? win.agentName;
  const { actions, modal } = useConversationActions();
  const agents = useAgents();
  const toast = useToast();
  const [previous, setPrevious] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const audioMode = Boolean(win.audioMode);

  async function finish() {
    if (!(await actions.confirmFinish())) return;
    setFinishing(true);
    try {
      await state.finish();
      toast.success(u.actions.finished);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="agent-head" onPointerDown={onPointerDown}>
      <AgentDot slot={conversation?.agentColorSlot ?? state.agent?.colorSlot ?? win.colorSlot} />
      <div className="agent-head-title">
        <span className="t" title={title} data-testid="agent-session-title">
          {title}
        </span>
        <span className="s">
          {agentName}
          {readOnly && conversation ? ` · @${conversation.username}` : ''}
          {finished ? ` · ${u.list.finishedOn(new Date(conversation!.archivedAt!).toLocaleDateString('pt-BR'))}` : ''}
        </span>
      </div>
      {conversation && (
        <Menu
          align="right"
          trigger={(props) => (
            <button type="button" className="icon-btn" title={u.actions.more} aria-label={u.actions.more} {...props}>
              <MoreHorizontal />
            </button>
          )}
        >
          <MenuItem icon={<Copy />} onSelect={() => void actions.copyId(conversation)}>
            <span className="flex flex-col">
              <span>{u.actions.copyId}</span>
              <span className="agent-session-id" data-testid="agent-session-id">
                {conversation.id}
              </span>
            </span>
          </MenuItem>
          {!readOnly && (
            <MenuItem icon={<Pencil />} onSelect={() => actions.rename(conversation)}>
              {u.actions.rename}
            </MenuItem>
          )}
          {!readOnly && finished && (
            <MenuItem icon={<Trash2 />} danger onSelect={() => void actions.remove(conversation)}>
              {u.actions.delete}
            </MenuItem>
          )}
        </Menu>
      )}
      {!isAgent && finished && !readOnly && conversation && (
        <button
          type="button"
          className="icon-btn"
          title={u.actions.forkHint}
          aria-label={u.actions.fork}
          onClick={() => void actions.fork(conversation)}
          data-testid="agent-fork"
        >
          <GitBranch />
        </button>
      )}
      {isAgent && (
        <>
          <button
            type="button"
            className="icon-btn"
            title={u.actions.finish}
            aria-label={u.actions.finish}
            disabled={!conversation || finishing}
            onClick={() => void finish()}
            data-testid="agent-finish"
          >
            <CircleCheckBig />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={u.list.previous}
            aria-label={u.list.previous}
            onClick={() => setPrevious(true)}
            data-testid="agent-previous"
          >
            <History />
          </button>
        </>
      )}
      {detail?.media.speech && (
        <button
          type="button"
          className={cx('icon-btn', audioMode && 'is-on')}
          title={audioMode ? u.media.audioModeOn : u.media.audioModeOff}
          aria-label={audioMode ? u.media.audioModeOn : u.media.audioModeOff}
          aria-pressed={audioMode}
          onClick={() => agents.setAudioMode(win.id, !audioMode)}
          data-testid="agent-audio-mode"
        >
          <Headphones />
        </button>
      )}
      {buttons}
      {modal}
      {isAgent && (
        <PreviousSessionsModal agentId={win.agentId || win.id} agentName={agentName} open={previous} onClose={() => setPrevious(false)} />
      )}
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
      data-kind={win.kind}
      data-agent-id={win.agentId}
      data-conversation-id={win.conversationId ?? ''}
      aria-label={win.kind === 'agent' ? win.agentName : (win.title ?? u.list.untitled)}
    >
      <ConversationPane
        target={paneTarget(win)}
        header={(info) => (
          <PaneHeader
            win={win}
            info={info}
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
                title={`${u.window.restore}: ${win.kind === 'agent' ? win.agentName : (win.title ?? u.list.untitled)}`}
                data-testid="agent-dock-item"
                data-kind={win.kind}
                data-agent-id={win.agentId}
                data-conversation-id={win.conversationId ?? ''}
              >
                <AgentDot slot={win.colorSlot} />
                <span className="truncate">{win.kind === 'agent' ? win.agentName : (win.title ?? win.agentName ?? u.list.untitled)}</span>
              </button>
              <button
                type="button"
                className={cx('agent-dock-x')}
                aria-label={`${u.window.close}: ${win.kind === 'agent' ? win.agentName : (win.title ?? u.list.untitled)}`}
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
