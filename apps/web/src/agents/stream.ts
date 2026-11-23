import { type AiRunEvent, SseParser } from '@moneyflow/shared';

/*
 * Acompanha o SSE de uma execução (GET /api/runs/:id/events) com fetch +
 * ReadableStream: assim o cookie de sessão vai junto e dá para mandar o
 * Last-Event-ID ao reconectar. Enquanto a execução não termina (evento
 * `done`), reconecta com backoff exponencial (1 s → 30 s).
 *
 * Aba em segundo plano (tarefa 122): a conexão fecha e volta quando a aba
 * aparece, do último evento visto (Last-Event-ID), sem contar como queda. Uma
 * conexão longa a menos por aba escondida (o HTTP/1.1 tem 6 por origem).
 */

export type FollowResult = 'done' | 'gone' | 'aborted';

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Espera a aba voltar a aparecer (ou o cancelamento). */
function untilVisible(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || !hidden()) return resolve();
    const done = () => {
      document.removeEventListener('visibilitychange', onChange);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const onChange = () => {
      if (!hidden()) done();
    };
    document.addEventListener('visibilitychange', onChange);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function followRun(
  runId: string,
  {
    signal,
    onEvent,
    onConnection,
    after,
  }: {
    signal: AbortSignal;
    /** O evento e o seq dele (o Last-Event-ID; null nos sintéticos, como o `done` de uma execução expurgada). */
    onEvent: (event: AiRunEvent, seq: number | null) => void;
    /** true = conectado; false = caiu e vai tentar de novo. */
    onConnection?: (connected: boolean) => void;
    /** Último seq já visto (null = desde o início). */
    after?: number | null;
  },
): Promise<FollowResult> {
  let last: string | null = after === undefined || after === null ? null : String(after);
  let attempt = 0;
  while (!signal.aborted) {
    if (hidden()) {
      await untilVisible(signal);
      continue;
    }
    // Uma conexão por volta: cancelada pelo chamador ou pela aba que some.
    const connection = new AbortController();
    let paused = false;
    const abort = () => connection.abort();
    const onVisibility = () => {
      if (!hidden()) return;
      paused = true;
      connection.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (last !== null) headers['last-event-id'] = last;
      const response = await fetch(`/api/runs/${runId}/events`, {
        credentials: 'same-origin',
        headers,
        signal: connection.signal,
        cache: 'no-store',
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) return 'gone';
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      attempt = 0;
      onConnection?.(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (event.id !== null) last = event.id;
          let data: AiRunEvent;
          try {
            data = JSON.parse(event.data) as AiRunEvent;
          } catch {
            continue;
          }
          if (!data || typeof data !== 'object' || !('type' in data)) data = { ...(data as object), type: event.event } as AiRunEvent;
          const seq = event.id !== null && Number.isFinite(Number(event.id)) ? Number(event.id) : null;
          onEvent(data, seq);
          if (data.type === 'done') {
            void reader.cancel().catch(() => {});
            return 'done';
          }
        }
      }
    } catch {
      if (signal.aborted) return 'aborted';
    } finally {
      signal.removeEventListener('abort', abort);
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (signal.aborted) return 'aborted';
    // A aba sumiu: espera ela voltar (no topo do laço) e retoma do último evento, sem backoff.
    if (paused) continue;
    onConnection?.(false);
    attempt += 1;
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)), signal);
  }
  return 'aborted';
}
