import type { Executor } from '@moneyflow/db';
import type {
  AiBlock,
  AiMessageDto,
  AiRole,
  AiRunDto,
  AiRunEvent,
  NeutralMessage,
  ToolConfirmationDto,
  UsageTotals,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { iso } from '../services/util';

/*
 * Acesso às tabelas dos agentes com SQL explícito (colunas listadas: nunca
 * ai_messages.search_tsv nem segredos). Usado pelo worker e pela API.
 */

export const MESSAGE_COLUMNS = sql`m.id, m.conversation_id, m.seq, m.role, m.content, m.run_id, m.created_at`;
export const RUN_COLUMNS = sql`r.id, r.conversation_id, r.user_id, r.agent_id, r.provider_id, r.model, r.trigger_message_id, r.status,
  r.error, r.cancel_requested_at, r.attempts, r.max_attempts, r.started_at, r.finished_at, r.last_event_seq, r.input_tokens,
  r.output_tokens, r.cache_write_tokens, r.cache_read_tokens, r.cost_micros, r.cost_currency, r.created_at`;

export type MessageRow = {
  id: string;
  conversation_id: string;
  seq: number;
  role: AiRole;
  content: AiBlock[];
  run_id: string | null;
  created_at: string | Date;
};

export type RunRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  agent_id: string;
  provider_id: string;
  model: string;
  trigger_message_id: string | null;
  status: AiRunDto['status'];
  error: string | null;
  cancel_requested_at: string | Date | null;
  attempts: number;
  max_attempts: number;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  last_event_seq: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_micros: number;
  cost_currency: 'USD' | 'BRL' | null;
  created_at: string | Date;
};

export function runDto(r: RunRow): AiRunDto {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    status: r.status,
    error: r.error,
    model: r.model,
    lastEventSeq: Number(r.last_event_seq),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    costMicros: Number(r.cost_micros),
    costCurrency: r.cost_currency,
    cancelRequested: r.cancel_requested_at !== null,
    createdAt: iso(r.created_at)!,
    finishedAt: iso(r.finished_at),
  };
}

type UsageRow = {
  currency: 'USD' | 'BRL' | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_micros: number | null;
  has_unpriced: boolean;
};

export function usageDto(u: UsageRow): UsageTotals {
  return {
    currency: u.currency,
    calls: Number(u.calls),
    inputTokens: Number(u.input_tokens),
    outputTokens: Number(u.output_tokens),
    cacheWriteTokens: Number(u.cache_write_tokens),
    cacheReadTokens: Number(u.cache_read_tokens),
    costMicros: u.cost_micros === null ? null : Number(u.cost_micros),
    hasUnpriced: Boolean(u.has_unpriced),
  };
}

export function messageDto(m: MessageRow, usage: UsageTotals[] = []): AiMessageDto {
  return { id: m.id, seq: Number(m.seq), role: m.role, content: m.content, runId: m.run_id, createdAt: iso(m.created_at)!, usage };
}

export async function loadRun(db: Executor, runId: string): Promise<RunRow | null> {
  const result = await db.execute<RunRow>(sql`SELECT ${RUN_COLUMNS} FROM ai_runs r WHERE r.id = ${runId}`);
  return result.rows[0] ?? null;
}

export async function loadMessages(db: Executor, conversationId: string): Promise<MessageRow[]> {
  const result = await db.execute<MessageRow>(
    sql`SELECT ${MESSAGE_COLUMNS} FROM ai_messages m WHERE m.conversation_id = ${conversationId} ORDER BY m.seq`,
  );
  return result.rows;
}

export async function messageUsage(db: Executor, messageIds: string[]): Promise<Map<string, UsageTotals[]>> {
  const map = new Map<string, UsageTotals[]>();
  if (messageIds.length === 0) return map;
  const result = await db.execute<UsageRow & { message_id: string }>(
    sql`SELECT * FROM ai_message_usage WHERE message_id = ANY (${`{${messageIds.join(',')}}`}::uuid[])`,
  );
  for (const row of result.rows) map.set(row.message_id, [...(map.get(row.message_id) ?? []), usageDto(row)]);
  return map;
}

export async function conversationUsage(db: Executor, conversationId: string): Promise<UsageTotals[]> {
  const result = await db.execute<UsageRow>(sql`
    SELECT currency, count(*)::int AS calls, sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
           sum(cache_write_tokens)::bigint AS cache_write_tokens, sum(cache_read_tokens)::bigint AS cache_read_tokens,
           sum(cost_micros)::bigint AS cost_micros, bool_or(cost_micros IS NULL) AS has_unpriced
      FROM ai_usage WHERE conversation_id = ${conversationId} GROUP BY currency ORDER BY currency NULLS LAST`);
  return result.rows.map(usageDto);
}

export async function insertMessage(db: Executor, conversationId: string, role: AiRole, content: AiBlock[], runId: string | null) {
  const result = await db.execute<MessageRow>(sql`
    INSERT INTO ai_messages AS m (conversation_id, role, content, run_id)
    VALUES (${conversationId}, ${role}, ${JSON.stringify(content)}::jsonb, ${runId})
    RETURNING ${MESSAGE_COLUMNS}`);
  return result.rows[0]!;
}

/** Grava um evento (seq + NOTIFY ai_run_events no COMMIT). */
export async function appendEvent(db: Executor, runId: string, event: AiRunEvent): Promise<number> {
  const { type, ...payload } = event;
  const result = await db.execute<{ seq: number }>(
    sql`SELECT ai_run_event_append(${runId}::uuid, ${type}, ${JSON.stringify(payload)}::jsonb) AS seq`,
  );
  return Number(result.rows[0]!.seq);
}

type ConfirmationRow = {
  id: string;
  run_id: string;
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  preview: ToolConfirmationDto['preview'];
  status: ToolConfirmationDto['status'];
  reason: string | null;
  decided_at: string | Date | null;
};

export function confirmationDto(c: ConfirmationRow): ToolConfirmationDto {
  return {
    id: c.id,
    runId: c.run_id,
    toolUseId: c.tool_use_id,
    toolName: c.tool_name,
    input: c.input,
    preview: c.preview,
    status: c.status,
    reason: c.reason,
    decidedAt: iso(c.decided_at),
  };
}

export async function loadConfirmations(db: Executor, runId: string, pendingOnly = false): Promise<ToolConfirmationDto[]> {
  const result = await db.execute<ConfirmationRow>(sql`
    SELECT id, run_id, tool_use_id, tool_name, input, preview, status, reason, decided_at
      FROM ai_tool_confirmations WHERE run_id = ${runId} ${pendingOnly ? sql`AND status = 'pending'` : sql``}
     ORDER BY created_at, id`);
  return result.rows.map(confirmationDto);
}

/**
 * As confirmações que a conversa mostra: as pendentes da execução ativa e as
 * já decididas de todas as execuções (para o histórico marcar a tool recusada
 * como recusada, não como erro, depois que a execução termina).
 */
export async function loadConversationConfirmations(
  db: Executor,
  conversationId: string,
  activeRunId: string | null,
): Promise<ToolConfirmationDto[]> {
  const result = await db.execute<ConfirmationRow>(sql`
    SELECT c.id, c.run_id, c.tool_use_id, c.tool_name, c.input, c.preview, c.status, c.reason, c.decided_at
      FROM ai_tool_confirmations c JOIN ai_runs r ON r.id = c.run_id
     WHERE r.conversation_id = ${conversationId}
       AND (c.status <> 'pending' OR c.run_id = ${activeRunId}::uuid)
     ORDER BY c.created_at, c.id`);
  return result.rows.map(confirmationDto);
}

/** Histórico neutro para o modelo (na ordem). */
export function toNeutral(rows: MessageRow[]): NeutralMessage[] {
  return rows.map((m) => ({ role: m.role, content: m.content }) as NeutralMessage);
}

/**
 * Tool uses do fim da conversa ainda sem resultado: os da última mensagem do
 * assistente, se depois dela só vierem resultados de tool.
 */
export function pendingToolUses(rows: MessageRow[]) {
  let lastAssistant = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const role = rows[i]!.role;
    if (role === 'assistant') {
      lastAssistant = i;
      break;
    }
    if (role === 'user') return [];
  }
  if (lastAssistant === -1) return [];
  const answered = new Set<string>();
  for (const m of rows.slice(lastAssistant + 1)) {
    for (const b of m.content) if (b.type === 'tool_result') answered.add(b.tool_use_id);
  }
  return rows[lastAssistant]!.content.filter(
    (b): b is Extract<AiBlock, { type: 'tool_use' }> => b.type === 'tool_use' && !answered.has(b.id),
  );
}
