/*
 * O texto ao vivo de uma execução (tarefa 120): os deltas do SSE chegam
 * dezenas de vezes por segundo; o buffer junta os de um quadro e avisa quem
 * assina uma vez por quadro. Fica fora do estado do React: só a bolha ao vivo
 * assina (`useSyncExternalStore`), e o resto da conversa não re-renderiza a
 * cada token. O agendador é injetado (no navegador, `requestAnimationFrame`).
 */

export type LiveStream = { text: string; thinking: string };

export type LiveBuffer = {
  get: () => LiveStream;
  subscribe: (listener: () => void) => () => void;
  /** Acrescenta um pedaço; o aviso sai no próximo quadro, junto com os outros do mesmo quadro. */
  push: (kind: 'text' | 'thinking', chunk: string) => void;
  /** Zera o texto e descarta o que ainda não saiu (a mensagem completa chegou, a execução acabou). */
  clear: () => void;
  /** Cancela o quadro pendente (desmontagem). */
  dispose: () => void;
};

export const EMPTY_LIVE: LiveStream = { text: '', thinking: '' };

export function createLiveBuffer(schedule: (flush: () => void) => number, cancel: (handle: number) => void): LiveBuffer {
  let value = EMPTY_LIVE;
  let pending = { text: '', thinking: '' };
  let handle: number | null = null;
  const listeners = new Set<() => void>();

  const emit = (next: LiveStream) => {
    if (next.text === value.text && next.thinking === value.thinking) return;
    value = next;
    for (const listener of [...listeners]) listener();
  };
  const flush = () => {
    handle = null;
    if (!pending.text && !pending.thinking) return;
    const next = { text: value.text + pending.text, thinking: value.thinking + pending.thinking };
    pending = { text: '', thinking: '' };
    emit(next);
  };
  const stop = () => {
    if (handle !== null) cancel(handle);
    handle = null;
  };

  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(kind, chunk) {
      if (!chunk) return;
      pending[kind] += chunk;
      if (handle === null) handle = schedule(flush);
    },
    clear() {
      stop();
      pending = { text: '', thinking: '' };
      emit(EMPTY_LIVE);
    },
    dispose: stop,
  };
}
