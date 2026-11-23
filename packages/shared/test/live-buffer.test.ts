import { describe, expect, it } from 'vitest';
import { createLiveBuffer, EMPTY_LIVE } from '../src';

/** Agendador manual: o "quadro" só roda quando o teste manda. */
function manualFrames() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => {
      const id = next++;
      queued.set(id, fn);
      return id;
    },
    cancel: (id: number) => void queued.delete(id),
    run() {
      const fns = [...queued.values()];
      queued.clear();
      for (const fn of fns) fn();
    },
    get pending() {
      return queued.size;
    },
  };
}

describe('texto ao vivo do agente: um aviso por quadro (tarefa 120)', () => {
  it('junta os deltas do mesmo quadro num aviso só', () => {
    const frames = manualFrames();
    const live = createLiveBuffer(frames.schedule, frames.cancel);
    let calls = 0;
    live.subscribe(() => calls++);
    for (const chunk of ['Ol', 'á, ', 'tudo', ' bem?']) live.push('text', chunk);
    live.push('thinking', 'pensando');
    expect(frames.pending).toBe(1);
    expect(live.get()).toBe(EMPTY_LIVE);
    frames.run();
    expect(calls).toBe(1);
    expect(live.get()).toEqual({ text: 'Olá, tudo bem?', thinking: 'pensando' });
    live.push('text', '!');
    frames.run();
    expect(calls).toBe(2);
    expect(live.get().text).toBe('Olá, tudo bem?!');
  });

  it('limpar descarta o que não saiu e avisa só se havia texto', () => {
    const frames = manualFrames();
    const live = createLiveBuffer(frames.schedule, frames.cancel);
    let calls = 0;
    const off = live.subscribe(() => calls++);
    live.clear();
    expect(calls).toBe(0);
    live.push('text', 'parcial');
    frames.run();
    live.push('text', ' que não chega');
    live.clear();
    expect(frames.pending).toBe(0);
    expect(live.get()).toBe(EMPTY_LIVE);
    expect(calls).toBe(2);
    off();
    live.push('text', 'x');
    frames.run();
    expect(calls).toBe(2);
  });

  it('o objeto lido é o mesmo enquanto nada muda (useSyncExternalStore)', () => {
    const frames = manualFrames();
    const live = createLiveBuffer(frames.schedule, frames.cancel);
    live.push('text', 'a');
    frames.run();
    const first = live.get();
    live.push('text', '');
    frames.run();
    expect(live.get()).toBe(first);
    live.dispose();
    live.push('text', 'b');
    live.dispose();
    expect(frames.pending).toBe(0);
  });
});
