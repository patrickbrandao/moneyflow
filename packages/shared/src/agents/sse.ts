/*
 * Parser incremental de text/event-stream (SSE): recebe pedaços de texto e
 * devolve os eventos completos. Usado pelo console (fetch com streaming, para
 * mandar Last-Event-ID e cookie) e pelos testes.
 */

export type SseEvent = { id: string | null; event: string; data: string };

export class SseParser {
  private buffer = '';
  private lastId: string | null = null;

  /** Último id visto (para reconectar com Last-Event-ID). */
  get lastEventId() {
    return this.lastId;
  }

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const events: SseEvent[] = [];
    let cut = this.buffer.indexOf('\n\n');
    while (cut !== -1) {
      const raw = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      const parsed = this.parseBlock(raw);
      if (parsed) events.push(parsed);
      cut = this.buffer.indexOf('\n\n');
    }
    return events;
  }

  private parseBlock(raw: string): SseEvent | null {
    let event = 'message';
    const data: string[] = [];
    let id: string | null = null;
    let sawId = false;
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id' && !value.includes('\0')) {
        id = value;
        sawId = true;
      }
    }
    if (sawId) this.lastId = id;
    if (data.length === 0) return null;
    return { id: sawId ? id : this.lastId, event, data: data.join('\n') };
  }
}

/** Formata um evento SSE (servidor). */
export function formatSse(event: { id?: string | number | null; event?: string; data: unknown }): string {
  const lines: string[] = [];
  if (event.id !== undefined && event.id !== null) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  const text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  for (const line of text.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}
