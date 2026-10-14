import type { Executor } from '@moneyflow/db';
import {
  type AgentOptionDto,
  type AiRunDto,
  type ConversationDetail,
  type ConversationDto,
  type confirmationDecisionInput,
  type conversationCreateInput,
  type conversationForkInput,
  type conversationListQuery,
  type conversationUpdateInput,
  type DecideResult,
  isImageMime,
  type messageSendInput,
  type SendMessageResult,
  t,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { FlowPurpose } from '../agents/flows';
import { visionMode } from '../agents/inferences';
import {
  appendEvent,
  conversationUsage,
  insertMessage,
  loadConfirmations,
  loadConversationConfirmations,
  loadMessages,
  loadRun,
  messageDto,
  messageUsage,
  pendingToolUses,
  RUN_COLUMNS,
  type RunRow,
  runDto,
} from '../agents/store';
import type { ServiceContext } from '../context';
import { AppError, findPgError, forbidden, notFound, unprocessable } from '../errors';
import { chatAttachments, mediaCapabilities, messageAttachmentIds } from './chat-media';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Conversas com os agentes (spec 011): o dono conversa, renomeia, fixa,
 * arquiva, exclui, bifurca e decide as confirmações; o admin lê as de todos
 * (somente leitura). Enviar mensagem só enfileira a execução: o loop roda no
 * worker e o console acompanha pelo SSE de eventos.
 */

type ConversationRow = {
  id: string;
  user_id: string;
  username: string;
  agent_id: string;
  agent_name: string;
  agent_color_slot: number;
  title: string | null;
  title_source: 'auto' | 'user';
  pinned_at: unknown;
  archived_at: unknown;
  forked_from_conversation_id: string | null;
  last_message_at: unknown;
  created_at: unknown;
  active_run_id: string | null;
  active_run_status: ConversationDto['activeRunStatus'];
  screen_context: Record<string, unknown> | null;
};

const SELECT = sql`
  SELECT c.id, c.user_id, u.username, c.agent_id, a.name AS agent_name, a.color_slot AS agent_color_slot, c.title, c.title_source,
         c.pinned_at, c.archived_at, c.forked_from_conversation_id, c.last_message_at, c.created_at, c.screen_context,
         r.id AS active_run_id, r.status AS active_run_status
    FROM ai_conversations c
    JOIN users u ON u.id = c.user_id
    JOIN ai_agents a ON a.id = c.agent_id
    LEFT JOIN ai_runs r ON r.conversation_id = c.id AND r.status IN ('queued', 'running', 'awaiting_confirmation')`;

/** Conversas dos fluxos (leitura de documento, classificação) não aparecem na lista. */
const NOT_FLOW = sql`c.purpose = 'chat'`;

function toDto(r: ConversationRow, snippet?: string | null): ConversationDto {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentColorSlot: Number(r.agent_color_slot),
    title: r.title,
    titleSource: r.title_source,
    pinnedAt: iso(r.pinned_at),
    archivedAt: iso(r.archived_at),
    forkedFromConversationId: r.forked_from_conversation_id,
    lastMessageAt: iso(r.last_message_at),
    createdAt: iso(r.created_at)!,
    activeRunId: r.active_run_id,
    activeRunStatus: r.active_run_status,
    ...(snippet !== undefined ? { snippet } : {}),
  };
}

async function conversationRow(db: Executor, id: string): Promise<ConversationRow | null> {
  const result = await db.execute<ConversationRow>(sql`${SELECT} WHERE c.id = ${id}`);
  return result.rows[0] ?? null;
}

/** Carrega a conversa: o dono sempre; o admin só para ler. */
export async function loadConversation(ctx: ServiceContext, id: string, mode: 'read' | 'own'): Promise<ConversationRow> {
  const row = await conversationRow(ctx.db, id);
  if (!row) throw notFound();
  const own = row.user_id === ctx.access.actor.id;
  if (own) return row;
  if (!ctx.access.isAdmin) throw notFound();
  if (mode === 'own') throw forbidden(t.agents.errors.readOnly);
  return row;
}

/* ---------------- agentes visíveis ---------------- */

export async function listAgentOptions(ctx: ServiceContext): Promise<AgentOptionDto[]> {
  void ctx.access;
  const result = await ctx.db.execute<{
    id: string;
    name: string;
    description: string | null;
    color_slot: number;
    icon: string | null;
  }>(sql`
    SELECT a.id, a.name, a.description, a.color_slot, a.icon
      FROM ai_agents a JOIN ai_providers p ON p.id = a.provider_id
     WHERE a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL
     ORDER BY lower(a.name)`);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    colorSlot: Number(r.color_slot),
    icon: r.icon,
    isActive: true,
  }));
}

/* ---------------- conversas ---------------- */

export async function listConversations(ctx: ServiceContext, q: z.output<typeof conversationListQuery>): Promise<ConversationDto[]> {
  let userId: string | null = ctx.access.actor.id;
  if (q.userId && q.userId !== ctx.access.actor.id) {
    ctx.access.assertAdmin();
    userId = q.userId === 'all' ? null : q.userId;
  }
  if (q.q) {
    const hits = await ctx.db.execute<{ conversation_id: string; snippet: string | null }>(
      sql`SELECT conversation_id, snippet FROM ai_conversation_search(${q.q}, ${userId}::uuid, ${q.archived}, ${q.limit})`,
    );
    if (hits.rows.length === 0) return [];
    const ids = hits.rows.map((h) => h.conversation_id);
    const rows = await ctx.db.execute<ConversationRow>(sql`${SELECT} WHERE c.id = ANY (${`{${ids.join(',')}}`}::uuid[]) AND ${NOT_FLOW}`);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    return hits.rows.filter((h) => byId.has(h.conversation_id)).map((h) => toDto(byId.get(h.conversation_id)!, h.snippet));
  }
  const result = await ctx.db.execute<ConversationRow>(sql`
    ${SELECT}
     WHERE ${userId ? sql`c.user_id = ${userId}` : sql`true`} AND ${NOT_FLOW}
       AND ${q.archived ? sql`c.archived_at IS NOT NULL` : sql`c.archived_at IS NULL`}
     ORDER BY c.pinned_at DESC NULLS LAST, coalesce(c.last_message_at, c.created_at) DESC
     LIMIT ${q.limit}`);
  return result.rows.map((r) => toDto(r));
}

async function assertAgentUsable(db: Executor, agentId: string) {
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT (a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL) AS ok
      FROM ai_agents a LEFT JOIN ai_providers p ON p.id = a.provider_id WHERE a.id = ${agentId}`);
  const row = result.rows[0];
  if (!row) throw notFound(t.agents.errors.agentNotFound);
  if (!row.ok) throw unprocessable(t.agents.errors.agentInactive, 'agent_inactive');
}

export async function createConversation(
  ctx: ServiceContext,
  input: z.output<typeof conversationCreateInput>,
  extra?: { purpose?: FlowPurpose; screenContext?: Record<string, unknown>; archived?: boolean },
) {
  await assertAgentUsable(ctx.db, input.agentId);
  const screen = extra?.screenContext ?? input.screenContext ?? null;
  // A finalidade é imutável no banco: a conversa de fluxo nasce com ela no INSERT.
  const purpose = extra?.purpose ?? 'chat';
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_conversations (user_id, agent_id, title, title_source, screen_context, archived_at, purpose)
      VALUES (${ctx.access.actor.id}, ${input.agentId}, ${input.title ?? null}, ${input.title ? 'user' : 'auto'},
              ${screen ? JSON.stringify(screen) : null}::jsonb, ${extra?.archived ? sql`now()` : null}, ${purpose})
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return toDto((await conversationRow(ctx.db, id))!);
}

export async function getConversation(ctx: ServiceContext, id: string): Promise<ConversationDetail> {
  const row = await loadConversation(ctx, id, 'read');
  const messages = await loadMessages(ctx.db, id);
  const usage = await messageUsage(
    ctx.db,
    messages.filter((m) => m.role === 'assistant').map((m) => m.id),
  );
  const active = row.active_run_id ? await loadRun(ctx.db, row.active_run_id) : null;
  const attachments = await chatAttachments(ctx.db, messageAttachmentIds(messages.filter((m) => m.role === 'user')));
  return {
    conversation: toDto(row),
    messages: messages.map((m) => messageDto(m, usage.get(m.id) ?? [])),
    activeRun: active ? runDto(active) : null,
    confirmations: await loadConversationConfirmations(ctx.db, id, active?.id ?? null),
    usage: await conversationUsage(ctx.db, id),
    readOnly: row.user_id !== ctx.access.actor.id,
    attachments,
    media: await mediaCapabilities(ctx.db, row.agent_id),
  };
}

export async function updateConversation(ctx: ServiceContext, id: string, input: z.output<typeof conversationUpdateInput>) {
  await loadConversation(ctx, id, 'own');
  const sets: SQL[] = [];
  if (input.title !== undefined) sets.push(sql`title = ${input.title}, title_source = 'user'`);
  if (input.pinned !== undefined) sets.push(input.pinned ? sql`pinned_at = coalesce(pinned_at, now())` : sql`pinned_at = NULL`);
  if (input.archived !== undefined) sets.push(input.archived ? sql`archived_at = coalesce(archived_at, now())` : sql`archived_at = NULL`);
  if (sets.length > 0) await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_conversations SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`));
  return toDto((await conversationRow(ctx.db, id))!);
}

/** Exclui a conversa (mensagens, execuções e eventos em cascata) e os anexos que ficarem órfãos, na mesma transação. */
export async function deleteConversation(ctx: ServiceContext, id: string) {
  await loadConversation(ctx, id, 'own');
  await withTx(ctx, async (tx) => {
    const files = await tx.execute<{ attachment_id: string }>(sql`
      SELECT DISTINCT ma.attachment_id FROM ai_message_attachments ma JOIN ai_messages m ON m.id = ma.message_id
       WHERE m.conversation_id = ${id}`);
    await tx.execute(sql`DELETE FROM ai_conversations WHERE id = ${id}`);
    const ids = files.rows.map((f) => f.attachment_id);
    if (ids.length > 0) {
      await tx.execute(sql`
        DELETE FROM attachments a WHERE a.id = ANY (${`{${ids.join(',')}}`}::uuid[])
           AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id)`);
    }
  });
  return { deleted: true };
}

export async function forkConversation(ctx: ServiceContext, id: string, input: z.output<typeof conversationForkInput>) {
  await loadConversation(ctx, id, 'own');
  const rows = await loadMessages(ctx.db, id);
  let cut = rows.findIndex((m) => m.id === input.messageId);
  if (cut === -1) throw notFound();
  // Avança o corte até não sobrar tool_use sem resultado.
  while (pendingToolUses(rows.slice(0, cut + 1)).length > 0 && cut < rows.length - 1) cut += 1;
  if (pendingToolUses(rows.slice(0, cut + 1)).length > 0) throw unprocessable(t.agents.errors.forkCut);
  const newId = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(
      sql`SELECT ai_conversation_fork(${rows[cut]!.id}::uuid, ${ctx.access.actor.id}::uuid, ${input.title ?? null}) AS id`,
    );
    return result.rows[0]!.id;
  });
  return toDto((await conversationRow(ctx.db, newId))!);
}

/* ---------------- anexos e mensagens ---------------- */

/** Imagem num agente sem visão (spec 024): recusada ao anexar, inclusive nos fluxos (422). */
export async function assertReadsImages(db: Executor, agentId: string, mimes: string[]) {
  if (!mimes.some(isImageMime)) return;
  const agent = await db.execute<{ provider_id: string | null }>(sql`SELECT provider_id FROM ai_agents WHERE id = ${agentId}`);
  if ((await visionMode(db, agentId, agent.rows[0]?.provider_id ?? null)) === 'none') {
    throw unprocessable(t.agents.errors.agentNoVision, 'agent_no_vision');
  }
}

/** Anexos citados numa mensagem: enviados pelo próprio usuário e ainda soltos ou já desta conversa. */
async function assertAttachments(ctx: ServiceContext, conversationId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const result = await ctx.db.execute<{ id: string; file_name: string; mime_type: string }>(sql`
    SELECT a.id, a.file_name, a.mime_type FROM attachments a
     WHERE a.id = ANY (${`{${ids.join(',')}}`}::uuid[]) AND a.uploaded_by_user_id = ${ctx.access.actor.id}
       AND (NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id)
            OR EXISTS (SELECT 1 FROM ai_message_attachments ma JOIN ai_messages m ON m.id = ma.message_id
                        WHERE ma.attachment_id = a.id AND m.conversation_id = ${conversationId}))`);
  if (result.rows.length !== new Set(ids).size) throw notFound();
  const byId = new Map(result.rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!);
}

export async function sendMessage(ctx: ServiceContext, id: string, input: z.output<typeof messageSendInput>): Promise<SendMessageResult> {
  const conversation = await loadConversation(ctx, id, 'own');
  await assertAgentUsable(ctx.db, conversation.agent_id);
  const files = await assertAttachments(ctx, id, input.attachmentIds);
  await assertReadsImages(
    ctx.db,
    conversation.agent_id,
    files.map((f) => f.mime_type),
  );
  const content = [
    ...files.map((f) => ({ type: 'attachment' as const, attachment_id: f.id, file_name: f.file_name, mime_type: f.mime_type })),
    ...(input.text.trim() ? [{ type: 'text' as const, text: input.text }] : []),
  ];
  try {
    return await withTx(ctx, async (tx) => {
      if (input.screenContext) {
        await tx.execute(sql`UPDATE ai_conversations SET screen_context = ${JSON.stringify(input.screenContext)}::jsonb WHERE id = ${id}`);
      }
      const message = await insertMessage(tx, id, 'user', content, null);
      const run = await tx.execute<RunRow>(sql`
        INSERT INTO ai_runs AS r (conversation_id, user_id, agent_id, trigger_message_id)
        VALUES (${id}, ${ctx.access.actor.id}, ${conversation.agent_id}, ${message.id})
        RETURNING ${RUN_COLUMNS}`);
      await appendEvent(tx, run.rows[0]!.id, { type: 'status', status: 'queued' });
      return { message: messageDto(message), run: runDto(run.rows[0]!) };
    });
  } catch (error) {
    if (findPgError(error)?.constraint === 'ai_runs_conversation_active_key') {
      throw new AppError(409, 'run_active', t.agents.errors.runActive);
    }
    throw error;
  }
}

/* ---------------- execuções ---------------- */

async function loadRunFor(ctx: ServiceContext, runId: string, mode: 'read' | 'own') {
  const run = await loadRun(ctx.db, runId);
  if (!run) throw notFound();
  await loadConversation(ctx, run.conversation_id, mode);
  return run;
}

export async function getRun(ctx: ServiceContext, runId: string): Promise<AiRunDto> {
  return runDto(await loadRunFor(ctx, runId, 'read'));
}

/** Parar: na fila ou esperando confirmação, cancela na hora; rodando, pede ao worker (ele encerra). */
export async function cancelRun(ctx: ServiceContext, runId: string): Promise<AiRunDto> {
  const run = await loadRunFor(ctx, runId, 'own');
  if (!['queued', 'running', 'awaiting_confirmation'].includes(run.status)) throw unprocessable(t.agents.errors.runNotActive);
  await withTx(ctx, async (tx) => {
    const locked = await tx.execute<{ status: string }>(sql`SELECT status FROM ai_runs WHERE id = ${runId} FOR UPDATE`);
    const status = locked.rows[0]?.status;
    if (status === 'running') {
      await tx.execute(sql`UPDATE ai_runs SET cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = ${runId}`);
      await appendEvent(tx, runId, { type: 'status', status: 'running' });
      return;
    }
    if (status !== 'queued' && status !== 'awaiting_confirmation') return;
    // Fecha os tool_use pendentes para o histórico continuar válido.
    const pending = pendingToolUses(await loadMessages(tx, run.conversation_id));
    if (pending.length > 0 && status === 'awaiting_confirmation') {
      await insertMessage(
        tx,
        run.conversation_id,
        'tool',
        pending.map((use) => ({ type: 'tool_result' as const, tool_use_id: use.id, content: t.agents.errors.canceled, is_error: true })),
        runId,
      );
    }
    await tx.execute(
      sql`UPDATE ai_runs SET status = 'canceled', cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = ${runId}`,
    );
    await appendEvent(tx, runId, { type: 'done', status: 'canceled', error: null });
  });
  return runDto((await loadRun(ctx.db, runId))!);
}

export async function decideConfirmations(
  ctx: ServiceContext,
  runId: string,
  input: z.output<typeof confirmationDecisionInput>,
): Promise<DecideResult> {
  await loadRunFor(ctx, runId, 'own');
  return withTx(ctx, async (tx) => {
    const result = await tx.execute<{ decided: number; pending: number; run_status: DecideResult['runStatus'] }>(sql`
      SELECT * FROM ai_tool_confirmations_decide(${runId}::uuid, ${ctx.access.actor.id}::uuid, ${input.decision},
                                                 ${input.ids ? `{${input.ids.join(',')}}` : null}::uuid[], ${input.reason ?? null})`);
    const row = result.rows[0]!;
    await appendEvent(tx, runId, { type: 'confirmation', confirmations: await loadConfirmations(tx, runId, true) });
    if (row.run_status === 'queued') await appendEvent(tx, runId, { type: 'status', status: 'queued' });
    return { decided: Number(row.decided), pending: Number(row.pending), runStatus: row.run_status };
  });
}

/** Eventos de uma execução depois de `after` (SSE). */
export async function runEvents(db: Executor, runId: string, after: number) {
  const result = await db.execute<{ seq: number; event_type: string; payload: Record<string, unknown> }>(sql`
    SELECT seq, event_type, payload FROM ai_run_events WHERE run_id = ${runId} AND seq > ${after} ORDER BY seq LIMIT 500`);
  return result.rows.map((r) => ({ seq: Number(r.seq), type: r.event_type, payload: r.payload }));
}
