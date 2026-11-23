import { t } from '@moneyflow/shared';
import { type DragEvent, type ReactNode, Suspense, useRef, useState } from 'react';
import { LoadError } from '../components/domain';
import { ErrorBoundary } from '../components/shell/PageSlot';
import { cx, Skel } from '../components/ui';
import { lazyNamed } from '../lib/lazy';
import type { ComposerHandle } from './ConversationBody';
import { agentColor } from './format';
import { hasRecord, readRecord, recordMarkdown } from './records';
import { type ConversationState, type PaneDetail, type PaneTarget, useConversation } from './useConversation';

/** O miolo da sessão, sob demanda (tarefa 128): só baixa quando a primeira janela de agente abre. */
const ConversationBody = lazyNamed(() => import('./ConversationBody'), 'ConversationBody');

const u = t.agentsUi;

export type PaneHeaderInfo = {
  detail: PaneDetail | null;
  state: ConversationState;
};

/**
 * O miolo de uma sessão (janela flutuante ou painel): cabeçalho fornecido por
 * quem embrulha, mensagens, confirmações, composer e rodapé de uso. A sessão
 * finalizada e a de outro usuário ficam em somente leitura (spec 026).
 */
export function ConversationPane({
  target,
  header,
  audioMode: audioModeOn = false,
}: {
  target: PaneTarget;
  header: (info: PaneHeaderInfo) => ReactNode;
  /** Modo áudio da janela (vem de quem embrulha: a conversa não assina o estado das janelas, tarefa 120). */
  audioMode?: boolean;
}) {
  const state = useConversation(target);
  const { detail, error } = state;
  // Sessão de um fluxo (tarefa agendada, conciliação, spec 029): sem composer, mas o dono aprova as ações pendentes.
  const flow = Boolean(detail?.conversation && detail.conversation.purpose !== 'chat');
  const finished = Boolean(detail?.conversation?.archivedAt) && !flow;
  const readOnly = (detail?.readOnly ?? false) || finished || flow;
  const canDecide = !(detail?.readOnly ?? false) && !finished;
  const agentInactive = target.kind === 'agent' && state.agent !== null && !state.agent.isActive;
  // Modo áudio (spec 025): por janela, só com texto→áudio no agente.
  const audioMode = Boolean(audioModeOn && detail?.media.speech);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle | null>(null);

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (readOnly || !detail) return;
    if (hasRecord(event) || event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!dragging) setDragging(true);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (readOnly || !detail) return;
    const record = readRecord(event);
    if (record) {
      event.preventDefault();
      composer.current?.insert(recordMarkdown(record));
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) {
      event.preventDefault();
      for (const file of files) composer.current?.attachFile(file);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: só recebe arquivos arrastados; pelo teclado, o botão Anexar faz o mesmo.
    <div
      className={cx('agent-pane', dragging && 'is-drop')}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {header({ detail, state })}
      {error ? (
        <div className="agent-scroll">
          <LoadError error={error} onRetry={() => void state.reload()} />
        </div>
      ) : !detail ? (
        <PaneSkeleton />
      ) : (
        <>
          {detail.readOnly ? (
            <div className="agent-readonly">{u.window.readOnly}</div>
          ) : finished ? (
            <div className="agent-readonly" data-testid="agent-finished-notice">
              {u.window.finished}
            </div>
          ) : flow ? (
            <div className="agent-readonly" data-testid="agent-flow-notice">
              {u.window.flowSession}
            </div>
          ) : agentInactive ? (
            <div className="agent-readonly">{u.window.agentInactive}</div>
          ) : null}
          <ErrorBoundary
            resetKey={state.conversationId ?? ''}
            fallback={
              <div className="agent-scroll">
                <LoadError error={new Error(t.shell.pageErrorHint)} onRetry={() => window.location.reload()} />
              </div>
            }
          >
            <Suspense fallback={<PaneSkeleton />}>
              <ConversationBody
                state={state}
                detail={detail}
                readOnly={readOnly}
                canDecide={canDecide}
                agentInactive={agentInactive}
                audioMode={audioMode}
                composerRef={composer}
              />
            </Suspense>
          </ErrorBoundary>
        </>
      )}
      {dragging && <div className="agent-drop-hint">{u.chat.dropHint}</div>}
    </div>
  );
}

function PaneSkeleton() {
  return (
    <div className="agent-scroll">
      <Skel h={48} className="mb-3" />
      <Skel h={80} className="mb-3" />
      <Skel h={36} />
    </div>
  );
}

/** Ponto com a cor do agente. */
export function AgentDot({ slot }: { slot: number | null | undefined }) {
  return <span className="agent-dot" style={{ background: agentColor(slot) }} aria-hidden />;
}
