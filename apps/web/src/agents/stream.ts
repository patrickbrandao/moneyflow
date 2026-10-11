import { type AiRunEvent, SseParser } from '@moneyflow/shared';

/*
 * Acompanha o SSE de uma execução (GET /api/runs/:id/events) com fetch +
 * ReadableStream: assim o cookie de sessão vai junto e dá para mandar o
 * Last-Event-ID ao reconectar. Enquanto a execução não termina (evento
 * `done`), reconecta com backoff exponencial (1 s → 30 s).
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

export async function followRun(
  runId: string,
  {
    signal,
    onEvent,
    onConnection,
    after,
  }: {
    signal: AbortSignal;
    onEvent: (event: AiRunEvent) => void;
    /** true = conectado; false = caiu e vai tentar de novo. */
    onConnection?: (connected: boolean) => void;
    /** Último seq já visto (null = desde o início). */
    after?: number | null;
  },
): Promise<FollowResult> {
  let last: string | null = after === undefined || after === null ? null : String(after);
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (last !== null) headers['last-event-id'] = last;
      const response = await fetch(`/api/runs/${runId}/events`, { credentials: 'same-origin', headers, signal, cache: 'no-store' });
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
          onEvent(data);
          if (data.type === 'done') {
            void reader.cancel().catch(() => {});
            return 'done';
          }
        }
      }
    } catch {
      if (signal.aborted) return 'aborted';
    }
    if (signal.aborted) return 'aborted';
    onConnection?.(false);
    attempt += 1;
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)), signal);
  }
  return 'aborted';
}
