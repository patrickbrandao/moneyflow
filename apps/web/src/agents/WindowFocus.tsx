import { useEffect, useRef } from 'react';
import { useAgents } from './AgentsProvider';

/**
 * Foco na janela do agente aberta ou restaurada agora (menu Agentes, doca,
 * link do sino; tarefa 114): vai para o compositor assim que ele estiver
 * habilitado; numa sessão só de leitura (sem compositor), para a própria
 * janela. Fica dentro da janela (ou do painel) e acha a raiz pelo pai.
 */
export function WindowFocus({ id }: { id: string }) {
  const { focusRequest } = useAgents();
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!focusRequest || focusRequest.id !== id) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const root = anchor.current?.parentElement;
      if (!root) return;
      const composer = root.querySelector<HTMLTextAreaElement>('[data-testid="agent-composer"]');
      if (composer && !composer.disabled) {
        composer.focus();
        return;
      }
      // A sessão ainda carrega: tenta de novo por até 3 s; sem compositor (leitura), fica na janela.
      tries += 1;
      if ((composer || tries < 5) && tries < 30) timer = setTimeout(attempt, 100);
      else root.focus();
    };
    attempt();
    return () => clearTimeout(timer);
  }, [focusRequest, id]);
  return <span ref={anchor} hidden />;
}
