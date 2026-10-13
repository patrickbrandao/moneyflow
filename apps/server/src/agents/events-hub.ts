import { type Database, pg } from '@moneyflow/db';
import { blocksText, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { emitAgentEvent } from '../services/message-worker';
import { SYNC_FLOW_PURPOSES } from './flows';
import { loadMessages } from './store';

/*
 * Hub de eventos dos agentes na API: uma conexão dedicada faz LISTEN no canal
 * ai_run_events (NOTIFY do ai_run_event_append, entregue no COMMIT) e acorda
 * os streams SSE abertos daquela execução, que leem do banco os eventos com
 * seq maior que o último enviado.
 *
 * Também decide o aviso "agente concluiu" (spec 011: fechar a janela não
 * interrompe; o sino avisa): quando a execução termina — ou passa a esperar
 * confirmação — e NINGUÉM está com o stream dela aberto nesta API, cria a
 * notificação agent_completed (sino + destinos que assinam o evento) via
 * emitAgentEvent. Com várias réplicas da API, cada uma só enxerga os próprios
 * streams (a dedup_key evita aviso duplicado no sino).
 */

type Listener = () => void;

export class RunEventsHub {
  private client: pg.Client | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.config.databaseUrl, application_name: 'moneyflow-events' });
    client.on('error', (error) => {
      this.log.warn({ err: error }, 'agentes: conexão de eventos caiu');
      this.reconnect();
    });
    client.on('notification', (message) => {
      if (message.channel !== 'ai_run_events' || !message.payload) return;
      try {
        const { run_id: runId, seq } = JSON.parse(message.payload) as { run_id: string; seq: number };
        this.dispatch(runId, Number(seq));
      } catch {
        // payload inesperado: ignora
      }
    });
    try {
      await client.connect();
      await client.query('LISTEN ai_run_events');
      this.client = client;
    } catch (error) {
      this.log.warn({ err: error }, 'agentes: não consegui escutar os eventos; tentando de novo');
      await client.end().catch(() => {});
      this.reconnect();
    }
  }

  private reconnect() {
    if (this.stopped || this.retry) return;
    const old = this.client;
    this.client = null;
    void old?.end().catch(() => {});
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
      // Quem estava ouvindo relê o banco (pode ter perdido NOTIFY no intervalo).
      for (const set of this.listeners.values()) for (const listener of set) listener();
    }, 2000);
  }

  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  /** Assina os eventos de uma execução; devolve a função para cancelar. */
  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(runId);
    };
  }

  private dispatch(runId: string, seq: number) {
    const set = this.listeners.get(runId);
    if (set && set.size > 0) {
      for (const listener of set) listener();
      return;
    }
    void this.notifyIfFinished(runId, seq).catch((error) => this.log.warn({ err: error, runId }, 'agentes: aviso de conclusão falhou'));
  }

  /** Ninguém olhando: avisa no sino quando a execução termina ou espera confirmação. */
  private async notifyIfFinished(runId: string, seq: number) {
    const result = await this.db.execute<{
      event_type: string;
      payload: { status?: string; error?: string | null };
      user_id: string;
      conversation_id: string;
      title: string | null;
      purpose: string | null;
    }>(sql`
      SELECT e.event_type, e.payload, r.user_id, r.conversation_id, c.title, c.screen_context ->> 'purpose' AS purpose
        FROM ai_run_events e JOIN ai_runs r ON r.id = e.run_id JOIN ai_conversations c ON c.id = r.conversation_id
       WHERE e.run_id = ${runId} AND e.seq = ${seq}`);
    const row = result.rows[0];
    if (!row || (row.purpose && SYNC_FLOW_PURPOSES.includes(row.purpose))) return;
    const status = row.payload.status;
    const done = row.event_type === 'done' && (status === 'completed' || status === 'failed');
    const awaiting = row.event_type === 'status' && status === 'awaiting_confirmation';
    if (!done && !awaiting) return;
    const messages = await loadMessages(this.db, row.conversation_id);
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && blocksText(m.content).trim());
    const text = (status === 'failed' ? (row.payload.error ?? '') : last ? blocksText(last.content) : '') || (row.title ?? '');
    const title = awaiting
      ? t.agents.notifications.awaitingTitle(row.title)
      : status === 'failed'
        ? t.agents.notifications.failedTitle(row.title)
        : t.agents.notifications.completedTitle(row.title);
    await emitAgentEvent(this.db, {
      kind: 'agent_completed',
      userId: row.user_id,
      agentRunId: runId,
      title,
      text: text.slice(0, 2000) || title,
      link: `/?conversation=${row.conversation_id}`,
      config: this.config,
    });
  }
}
