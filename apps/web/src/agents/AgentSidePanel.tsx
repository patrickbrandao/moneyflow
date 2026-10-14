import { t } from '@moneyflow/shared';
import { Bot, Minus, PanelRightClose, PanelRightOpen, SquareArrowOutUpLeft, X } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useAgents } from './AgentsProvider';
import { PaneHeader, paneTarget } from './AgentWindows';
import { ConversationPane } from './ConversationPane';
import { agentColor } from './format';

const u = t.agentsUi;

/**
 * O agente ancorado à direita (um por vez), com o comportamento da sidebar
 * esquerda: recolher numa faixa estreita, expandir, alargar arrastando a
 * borda, minimizar (volta para a doca) e fechar. Ocupa uma coluna do grid do
 * shell, então o palco encolhe em vez de ficar por baixo; abaixo de 900px é
 * uma gaveta sobreposta.
 */
export function AgentSidePanel() {
  const agents = useAgents();
  const { docked, windows, panelCollapsed, panelWidth } = agents.state;
  const win = docked ? windows.find((w) => w.id === docked) : undefined;
  if (!win) return null;

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const start = panelWidth;
    const shell = document.querySelector<HTMLElement>('.shell');
    document.body.classList.add('agent-resizing');
    let width = start;
    const move = (e: PointerEvent) => {
      width = Math.max(320, Math.min(760, start + (startX - e.clientX)));
      // Ao vivo só no CSS (sem regravar o storage a cada pixel).
      shell?.style.setProperty('--agent-panel-w', `${width}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('agent-resizing');
      agents.setPanelWidth(width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  if (panelCollapsed) {
    return (
      <aside
        className="agent-side collapsed"
        data-testid="agent-side-panel"
        data-kind={win.kind}
        data-agent-id={win.agentId}
        data-conversation-id={win.conversationId ?? ''}
        aria-label={u.panel.label}
      >
        <button
          type="button"
          className="agent-side-strip"
          onClick={() => agents.setPanelCollapsed(false)}
          title={`${u.window.expand}: ${win.kind === 'agent' ? win.agentName : (win.title ?? u.list.untitled)}`}
          aria-label={u.window.expand}
        >
          <PanelRightOpen />
          <span className="agent-side-badge" style={{ background: agentColor(win.colorSlot) }}>
            <Bot />
          </span>
          <span className="agent-side-vtitle">{win.kind === 'agent' ? win.agentName : (win.title ?? win.agentName)}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="agent-side"
      data-testid="agent-side-panel"
      data-kind={win.kind}
      data-agent-id={win.agentId}
      data-conversation-id={win.conversationId ?? ''}
      aria-label={u.panel.label}
    >
      <div className="agent-side-grip" onPointerDown={startResize} title={u.window.resizePanel} aria-hidden />
      <ConversationPane
        key={win.id}
        target={paneTarget(win)}
        header={(info) => (
          <PaneHeader
            win={win}
            info={info}
            buttons={
              <>
                <button
                  type="button"
                  className="icon-btn agent-hide-narrow"
                  title={u.window.collapse}
                  aria-label={u.window.collapse}
                  onClick={() => agents.setPanelCollapsed(true)}
                >
                  <PanelRightClose />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={u.window.undock}
                  aria-label={u.window.undock}
                  onClick={() => agents.undock(win.id)}
                >
                  <SquareArrowOutUpLeft />
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
    </aside>
  );
}

/** Largura que o painel ocupa no grid do shell (0 = sem painel). */
export function usePanelColumn(): string | null {
  const { docked, windows, panelCollapsed, panelWidth } = useAgents().state;
  if (!docked || !windows.some((w) => w.id === docked)) return null;
  return panelCollapsed ? '44px' : `${panelWidth}px`;
}
