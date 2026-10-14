import type { Executor } from '@moneyflow/db';
import {
  type AgentOptionDto,
  type AgentSendResult,
  type AgentSessionsPage,
  type AgentThreadDto,
  type AgentThreadView,
  type AiRunDto,
  type agentSessionsQuery,
  type agentThreadsQuery,
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
import { sql } from 'drizzle-orm';
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
 * Conversas com os agentes (spec 011) organizadas em sessões (spec 026): cada
 * (usuário, agente) tem um fio contínuo com no máximo uma sessão ativa (a
 * conversa `chat` sem archived_at; o banco garante com um índice único). O dono
 * conversa na ativa, renomeia, finaliza (para a execução e arquiva), bifurca a
 * partir de uma finalizada, exclui as finalizadas e decide as confirmações; o
 * admin lê as de todos (somente leitura). Enviar mensagem só enfileira a
 * execução: o loop roda no worker e o console acompanha pelo SSE de eventos.
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
  purpose: string;
  archived_at: unknown;
  archived_reason: ConversationDto['archivedReason'];
  forked_from_conversation_id: string | null;
  last_message_at: unknown;
  created_at: unknown;
  active_run_id: string | null;
  active_run_status: ConversationDto['activeRunStatus'];
  screen_context: Record<string, unknown> | null;
};

const SELECT = sql`
  SELECT c.id, c.user_id, u.username, c.agent_id, a.name AS agent_name, a.color_slot AS agent_color_slot, c.title, c.title_source,
         c.purpose, c.archived_at, c.archived_reason, c.forked_from_conversation_id, c.last_message_at, c.created_at, c.screen_context,
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
    archivedAt: iso(r.archived_at),
    archivedReason: r.archived_reason ?? null,
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
      // A busca cobre todas as sessões (ativas e finalizadas, spec 026).
      sql`SELECT conversation_id, snippet FROM ai_conversation_search(${q.q}, ${userId}::uuid, true, ${q.limit})`,
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
     ORDER BY coalesce(c.last_message_at, c.created_at) DESC
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
  if (input.title !== undefined) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_conversations SET title = ${input.title}, title_source = 'user' WHERE id = ${id}`));
  }
  return toDto((await conversationRow(ctx.db, id))!);
}

/**
 * Exclui a conversa (mensagens, execuções e eventos em cascata) e os anexos que
 * ficarem órfãos, na mesma transação. A sessão ativa precisa ser finalizada
 * antes (spec 026; a regra é da aplicação, o banco não recusa o DELETE).
 */
export async function deleteConversation(ctx: ServiceContext, id: string) {
  const row = await loadConversation(ctx, id, 'own');
  if (row.purpose === 'chat' && !row.archived_at) throw unprocessable(t.agents.errors.sessionActiveDelete, 'session_active');
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

/**
 * Bifurca a partir de uma mensagem: a cópia vira a sessão ativa do par e o
 * banco finaliza a ativa anterior (`forked`). Se a ativa tem execução, o
 * "parar" é pedido antes, na mesma transação (o banco recusa arquivar sem ele).
 */
export async function forkConversation(ctx: ServiceContext, id: string, input: z.output<typeof conversationForkInput>) {
  const source = await loadConversation(ctx, id, 'own');
  const rows = await loadMessages(ctx.db, id);
  let cut = rows.findIndex((m) => m.id === input.messageId);
  if (cut === -1) throw notFound();
  // Avança o corte até não sobrar tool_use sem resultado.
  while (pendingToolUses(rows.slice(0, cut + 1)).length > 0 && cut < rows.length - 1) cut += 1;
  if (pendingToolUses(rows.slice(0, cut + 1)).length > 0) throw unprocessable(t.agents.errors.forkCut);
  const newId = await withTx(ctx, async (tx) => {
    if (source.purpose === 'chat') {
      const active = await activeSessionId(tx, ctx.access.actor.id, source.agent_id);
      if (active) await stopConversationRuns(tx, active);
    }
    const result = await tx.execute<{ id: string }>(
      sql`SELECT ai_conversation_fork(${rows[cut]!.id}::uuid, ${ctx.access.actor.id}::uuid, ${input.title ?? null}) AS id`,
    );
    return result.rows[0]!.id;
  });
  return toDto((await conversationRow(ctx.db, newId))!);
}

/* ---------------- sessões por agente (spec 026) ---------------- */

/** A sessão ativa (chat não finalizada) de um usuário com um agente; usa o índice único do par. */
export async function activeSessionId(db: Executor, userId: string, agentId: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id FROM ai_conversations
     WHERE user_id = ${userId} AND agent_id = ${agentId} AND purpose = 'chat' AND archived_at IS NULL`);
  return result.rows[0]?.id ?? null;
}

/**
 * A sessão ativa do ator com o agente, criada se não houver. Reutilizável por
 * quem fala com o fio fora do console (Telegram, spec 029). Duas abas criando
 * ao mesmo tempo: a segunda recebe 23505 e relê a ativa.
 */
export async function ensureActiveSession(
  ctx: ServiceContext,
  agentId: string,
  screenContext?: Record<string, unknown> | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
  if (existing) return { id: existing, created: false };
  await assertAgentUsable(ctx.db, agentId);
  try {
    const id = await withTx(ctx, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        INSERT INTO ai_conversations (user_id, agent_id, title_source, screen_context, purpose)
        VALUES (${ctx.access.actor.id}, ${agentId}, 'auto', ${screenContext ? JSON.stringify(screenContext) : null}::jsonb, 'chat')
        RETURNING id`);
      return result.rows[0]!.id;
    });
    return { id, created: true };
  } catch (error) {
    if (findPgError(error)?.constraint !== 'ai_conversations_active_chat_key') throw error;
    const winner = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
    if (!winner) throw error;
    return { id: winner, created: false };
  }
}

/** POST /api/agents/:agentId/sessions: a sessão ativa (criada se preciso), para anexar antes da 1ª mensagem. */
export async function startSession(ctx: ServiceContext, agentId: string, screenContext?: Record<string, unknown> | null) {
  const { id } = await ensureActiveSession(ctx, agentId, screenContext);
  return toDto((await conversationRow(ctx.db, id))!);
}

/** Mensagem para o agente: entra na sessão ativa, ou numa nova se não houver (spec 026). */
export async function sendToAgent(
  ctx: ServiceContext,
  agentId: string,
  input: z.output<typeof messageSendInput>,
): Promise<AgentSendResult> {
  const session = await ensureActiveSession(ctx, agentId, input.screenContext ?? null);
  const result = await sendMessage(ctx, session.id, input);
  return { ...result, conversation: toDto((await conversationRow(ctx.db, session.id))!), created: session.created };
}

/**
 * Para as execuções ativas da conversa, dentro da transação de quem chama: na
 * fila ou esperando confirmação, cancela na hora (fechando os tool_use
 * pendentes); rodando, pede o parar (`cancel_requested_at`) e o worker encerra
 * na próxima batida.
 */
async function stopConversationRuns(tx: Executor, conversationId: string) {
  const runs = await tx.execute<{ id: string }>(sql`
    SELECT id FROM ai_runs WHERE conversation_id = ${conversationId} AND status IN ('queued', 'running', 'awaiting_confirmation')`);
  for (const run of runs.rows) await stopRun(tx, run.id, conversationId);
}

/**
 * Finalizar sessão (spec 026): numa transação só, para a execução ativa e
 * arquiva com `archived_reason = 'finished'`. A próxima mensagem abre outra.
 * Finalizar de novo não muda nada.
 */
export async function finishSession(ctx: ServiceContext, id: string): Promise<ConversationDto> {
  const row = await loadConversation(ctx, id, 'own');
  if (row.purpose !== 'chat') throw unprocessable(t.agents.errors.sessionNotChat, 'not_a_session');
  if (!row.archived_at) {
    await withTx(ctx, async (tx) => {
      await stopConversationRuns(tx, id);
      await tx.execute(sql`
        UPDATE ai_conversations SET archived_at = now(), archived_reason = 'finished' WHERE id = ${id} AND archived_at IS NULL`);
    });
  }
  return toDto((await conversationRow(ctx.db, id))!);
}

type ThreadRow = {
  agent_id: string;
  agent_name: string;
  agent_description: string | null;
  agent_color_slot: number;
  agent_icon: string | null;
  agent_usable: boolean;
  user_id: string;
  username: string;
  last_activity_at: unknown;
  finished_count: number;
  active_id: string | null;
};

/**
 * Os fios (menu Agentes): por agente, a sessão ativa, a última atividade e
 * quantas finalizadas. Os seus: todos os agentes utilizáveis e os que já têm
 * sessões. Admin com `userId` (ou "all"): os fios que existem desse usuário
 * (ou de todos), em somente leitura.
 */
export async function listThreads(ctx: ServiceContext, q: z.output<typeof agentThreadsQuery>): Promise<AgentThreadDto[]> {
  const me = ctx.access.actor.id;
  const others = q.userId !== undefined && q.userId !== me;
  if (others) ctx.access.assertAdmin();
  const owner = others ? (q.userId === 'all' ? null : q.userId!) : me;
  const sessions = sql`
    SELECT c.user_id, c.agent_id,
           max(coalesce(c.last_message_at, c.created_at)) AS last_activity_at,
           count(*) FILTER (WHERE c.archived_at IS NOT NULL)::int AS finished_count,
           (array_agg(c.id) FILTER (WHERE c.archived_at IS NULL))[1] AS active_id
      FROM ai_conversations c
     WHERE c.purpose = 'chat' AND ${owner ? sql`c.user_id = ${owner}` : sql`true`}
     GROUP BY c.user_id, c.agent_id`;
  const agentCols = sql`a.id AS agent_id, a.name AS agent_name, a.description AS agent_description, a.color_slot AS agent_color_slot,
         a.icon AS agent_icon,
         coalesce(a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL, false) AS agent_usable`;
  const result = others
    ? await ctx.db.execute<ThreadRow>(sql`
        WITH s AS (${sessions})
        SELECT ${agentCols}, s.user_id, u.username, s.last_activity_at, s.finished_count, s.active_id
          FROM s JOIN ai_agents a ON a.id = s.agent_id LEFT JOIN ai_providers p ON p.id = a.provider_id
          JOIN users u ON u.id = s.user_id
         ORDER BY s.last_activity_at DESC NULLS LAST, lower(a.name), u.username`)
    : await ctx.db.execute<ThreadRow>(sql`
        WITH s AS (${sessions})
        SELECT ${agentCols}, ${me}::uuid AS user_id, u.username, s.last_activity_at, coalesce(s.finished_count, 0) AS finished_count,
               s.active_id
          FROM ai_agents a LEFT JOIN ai_providers p ON p.id = a.provider_id
          LEFT JOIN s ON s.agent_id = a.id
          JOIN users u ON u.id = ${me}
         WHERE s.agent_id IS NOT NULL
            OR (a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL)
         ORDER BY s.last_activity_at DESC NULLS LAST, lower(a.name)`);
  const activeIds = result.rows.map((r) => r.active_id).filter((id): id is string => Boolean(id));
  const actives =
    activeIds.length > 0
      ? await ctx.db.execute<ConversationRow>(sql`${SELECT} WHERE c.id = ANY (${`{${activeIds.join(',')}}`}::uuid[])`)
      : { rows: [] as ConversationRow[] };
  const byId = new Map(actives.rows.map((r) => [r.id, r]));
  return result.rows.map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentDescription: r.agent_description,
    agentColorSlot: Number(r.agent_color_slot),
    agentIcon: r.agent_icon,
    agentUsable: Boolean(r.agent_usable),
    userId: r.user_id,
    username: r.username,
    active: r.active_id && byId.has(r.active_id) ? toDto(byId.get(r.active_id)!) : null,
    lastActivityAt: iso(r.last_activity_at),
    finishedCount: Number(r.finished_count),
  }));
}

/** Sessões finalizadas de um agente (mais recentes primeiro), paginadas; `q` busca nelas. Admin: de outro usuário. */
export async function listSessions(
  ctx: ServiceContext,
  agentId: string,
  q: z.output<typeof agentSessionsQuery>,
): Promise<AgentSessionsPage> {
  const userId = q.userId ?? ctx.access.actor.id;
  if (userId !== ctx.access.actor.id) ctx.access.assertAdmin();
  const finished = sql`c.user_id = ${userId} AND c.agent_id = ${agentId} AND c.purpose = 'chat' AND c.archived_at IS NOT NULL`;
  if (q.q) {
    const hits = await ctx.db.execute<{ conversation_id: string; snippet: string | null }>(
      sql`SELECT conversation_id, snippet FROM ai_conversation_search(${q.q}, ${userId}::uuid, true, 500)`,
    );
    const ids = hits.rows.map((h) => h.conversation_id);
    if (ids.length === 0) return { items: [], hasMore: false };
    const rows = await ctx.db.execute<ConversationRow>(sql`${SELECT} WHERE c.id = ANY (${`{${ids.join(',')}}`}::uuid[]) AND ${finished}`);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    const matched = hits.rows.filter((h) => byId.has(h.conversation_id));
    const page = matched.slice(q.offset, q.offset + q.limit);
    return {
      items: page.map((h) => toDto(byId.get(h.conversation_id)!, h.snippet)),
      hasMore: matched.length > q.offset + q.limit,
    };
  }
  const result = await ctx.db.execute<ConversationRow>(sql`
    ${SELECT} WHERE ${finished}
     ORDER BY c.archived_at DESC, c.id DESC
     LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
  return { items: result.rows.slice(0, q.limit).map((r) => toDto(r)), hasMore: result.rows.length > q.limit };
}

/** A janela do agente: o agente, o que ele converte e a sessão ativa do ator (null = a próxima mensagem cria). */
export async function getThread(ctx: ServiceContext, agentId: string): Promise<AgentThreadView> {
  const agent = await ctx.db.execute<{
    id: string;
    name: string;
    description: string | null;
    color_slot: number;
    icon: string | null;
    usable: boolean;
  }>(sql`
    SELECT a.id, a.name, a.description, a.color_slot, a.icon,
           coalesce(a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL, false) AS usable
      FROM ai_agents a LEFT JOIN ai_providers p ON p.id = a.provider_id WHERE a.id = ${agentId}`);
  const row = agent.rows[0];
  if (!row) throw notFound(t.agents.errors.agentNotFound);
  const active = await activeSessionId(ctx.db, ctx.access.actor.id, agentId);
  return {
    agent: {
      id: row.id,
      name: row.name,
      description: row.description,
      colorSlot: Number(row.color_slot),
      icon: row.icon,
      isActive: Boolean(row.usable),
    },
    media: await mediaCapabilities(ctx.db, agentId),
    session: active ? await getConversation(ctx, active) : null,
  };
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
  // Sessão finalizada é somente leitura: nenhuma execução nova nela (spec 026).
  if (conversation.purpose === 'chat' && conversation.archived_at) {
    throw new AppError(409, 'session_finished', t.agents.errors.sessionFinished);
  }
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

/**
 * Para uma execução dentro da transação de quem chama: na fila ou esperando
 * confirmação, cancela na hora; rodando, pede ao worker (ele encerra).
 */
async function stopRun(tx: Executor, runId: string, conversationId: string) {
  const locked = await tx.execute<{ status: string }>(sql`SELECT status FROM ai_runs WHERE id = ${runId} FOR UPDATE`);
  const status = locked.rows[0]?.status;
  if (status === 'running') {
    await tx.execute(sql`UPDATE ai_runs SET cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = ${runId}`);
    await appendEvent(tx, runId, { type: 'status', status: 'running' });
    return;
  }
  if (status !== 'queued' && status !== 'awaiting_confirmation') return;
  // Fecha os tool_use pendentes para o histórico continuar válido.
  const pending = pendingToolUses(await loadMessages(tx, conversationId));
  if (pending.length > 0 && status === 'awaiting_confirmation') {
    await insertMessage(
      tx,
      conversationId,
      'tool',
      pending.map((use) => ({ type: 'tool_result' as const, tool_use_id: use.id, content: t.agents.errors.canceled, is_error: true })),
      runId,
    );
  }
  await tx.execute(
    sql`UPDATE ai_runs SET status = 'canceled', cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = ${runId}`,
  );
  await appendEvent(tx, runId, { type: 'done', status: 'canceled', error: null });
}

/** Parar: na fila ou esperando confirmação, cancela na hora; rodando, pede ao worker (ele encerra). */
export async function cancelRun(ctx: ServiceContext, runId: string): Promise<AiRunDto> {
  const run = await loadRunFor(ctx, runId, 'own');
  if (!['queued', 'running', 'awaiting_confirmation'].includes(run.status)) throw unprocessable(t.agents.errors.runNotActive);
  await withTx(ctx, (tx) => stopRun(tx, runId, run.conversation_id));
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
