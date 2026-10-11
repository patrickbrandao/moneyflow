import type { Executor } from '@moneyflow/db';
import type { destinationCreateInput, destinationUpdateInput, outboxQuery, subscriptionInput } from '@moneyflow/shared';
import {
  agentMessage,
  formatDateTime,
  type MessageDestinationDto,
  type MessageEventKind,
  type MessagePayload,
  type MessageSubscriptionDto,
  type OutboxMessageDto,
  type OutboxStatus,
  type TestSendResult,
  t,
  testMessage,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Access } from '../authz/access';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { forbidden, notFound, unprocessable } from '../errors';
import { sendTelegramMessage } from '../integrations/telegram';
import { createNotifications } from './notifications';
import { deleteOrArchive, withTx } from './tx';
import { camel, iso } from './util';

/*
 * Mensagens (spec 013): cadastro central de destinos Telegram, assinaturas de
 * eventos e o histórico/fila (message_outbox).
 *
 * O bot token é write-only, como a senha: moneyflow_app nem consegue ler a
 * coluna (GRANT por coluna). NUNCA `SELECT *` nem `.returning()` sem colunas
 * em message_destinations; o token só é lido por message_destination_token()
 * de uma mensagem reservada (status sending), na hora do envio.
 *
 * Quem vê e quem gerencia:
 *   pessoal (owner_user_id)  → o dono (e o admin);
 *   de caixa (owner_caixa_id) → vê quem lê a caixa, gerencia quem escreve nela;
 *   global (sem dono)         → só o admin.
 */

/** Colunas legíveis de message_destinations (tudo menos bot_token). */
const DEST_COLUMNS = sql`d.id, d.channel, d.name, d.owner_user_id, d.owner_caixa_id, d.bot_id, d.chat_id, d.is_active,
  d.created_by_user_id, d.notes, d.archived_at, d.created_at, d.updated_at`;

type DestRow = {
  id: string;
  ownerUserId: string | null;
  ownerCaixaId: string | null;
  isActive: boolean;
  archivedAt: string | null;
  name: string;
  chatId: string | null;
};

export const ownerKindOf = (d: { ownerUserId: string | null; ownerCaixaId: string | null }) =>
  d.ownerUserId ? 'user' : d.ownerCaixaId ? 'caixa' : 'global';

function canSee(access: Access, d: Pick<DestRow, 'ownerUserId' | 'ownerCaixaId'>) {
  if (access.isAdmin) return true;
  if (d.ownerUserId) return d.ownerUserId === access.actor.id;
  if (d.ownerCaixaId) return access.canRead(d.ownerCaixaId);
  return false;
}

function canManage(access: Access, d: Pick<DestRow, 'ownerUserId' | 'ownerCaixaId'>) {
  if (access.isAdmin) return true;
  if (d.ownerUserId) return d.ownerUserId === access.actor.id;
  if (d.ownerCaixaId) return access.canWrite(d.ownerCaixaId);
  return false;
}

/** Filtro SQL dos destinos visíveis (alias d). */
function visibleFilter(access: Access): SQL {
  if (access.isAdmin) return sql`true`;
  const readable = access.readableCaixaIds() as string[];
  const caixaCond =
    readable.length > 0
      ? sql`d.owner_caixa_id IN (${sql.join(
          readable.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql`false`;
  return sql`(d.owner_user_id = ${access.actor.id}::uuid OR ${caixaCond})`;
}

async function loadDestination(ctx: ServiceContext, id: string, db: Executor = ctx.db): Promise<DestRow> {
  const result = await db.execute(sql`SELECT ${DEST_COLUMNS} FROM message_destinations d WHERE d.id = ${id}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  const d = camel<DestRow>(row);
  if (!canSee(ctx.access, d)) throw notFound();
  return d;
}

async function manageable(ctx: ServiceContext, id: string, db: Executor = ctx.db) {
  const d = await loadDestination(ctx, id, db);
  if (!canManage(ctx.access, d)) throw forbidden(ownerKindOf(d) === 'global' ? t.errors.destinationGlobalAdmin : undefined);
  return d;
}

/* ---------------- destinos ---------------- */

export async function listDestinations(ctx: ServiceContext): Promise<MessageDestinationDto[]> {
  const result = await ctx.db.execute(sql`
    SELECT ${DEST_COLUMNS}, u.username AS owner_username, c.name AS owner_caixa_name,
           (SELECT count(*)::int FROM message_subscriptions s WHERE s.destination_id = d.id AND s.is_active) AS subscriptions,
           (SELECT max(o.sent_at) FROM message_outbox o WHERE o.destination_id = d.id) AS last_sent_at,
           (SELECT count(*)::int FROM message_outbox o WHERE o.destination_id = d.id AND o.status = 'failed') AS failed_count
      FROM message_destinations d
      LEFT JOIN users u ON u.id = d.owner_user_id
      LEFT JOIN caixas c ON c.id = d.owner_caixa_id
     WHERE ${visibleFilter(ctx.access)}
     ORDER BY d.archived_at NULLS FIRST, lower(d.name)`);
  return result.rows.map((row) => toDestination(ctx, row));
}

function toDestination(ctx: ServiceContext, row: Record<string, unknown>): MessageDestinationDto {
  const r = camel<Omit<MessageDestinationDto, 'ownerKind' | 'canManage'> & { createdByUserId: string | null; updatedAt: unknown }>(row);
  return {
    id: r.id,
    channel: 'telegram',
    name: r.name,
    ownerKind: ownerKindOf(r),
    ownerUserId: r.ownerUserId,
    ownerUsername: r.ownerUsername ?? null,
    ownerCaixaId: r.ownerCaixaId,
    ownerCaixaName: r.ownerCaixaName ?? null,
    botId: r.botId,
    chatId: r.chatId,
    isActive: r.isActive,
    notes: r.notes,
    archivedAt: iso(r.archivedAt),
    createdAt: iso(r.createdAt)!,
    canManage: canManage(ctx.access, r),
    subscriptions: Number(r.subscriptions ?? 0),
    lastSentAt: iso(r.lastSentAt),
    failedCount: Number(r.failedCount ?? 0),
  };
}

export async function getDestination(ctx: ServiceContext, id: string): Promise<MessageDestinationDto> {
  await loadDestination(ctx, id);
  const all = await listDestinations(ctx);
  const found = all.find((d) => d.id === id);
  if (!found) throw notFound();
  return found;
}

export async function createDestination(ctx: ServiceContext, input: z.output<typeof destinationCreateInput>) {
  let ownerUserId: string | null = null;
  let ownerCaixaId: string | null = null;
  if (input.ownerKind === 'global') {
    if (!ctx.access.isAdmin) throw forbidden(t.errors.destinationGlobalAdmin);
  } else if (input.ownerKind === 'caixa') {
    ctx.access.assertWrite(input.ownerCaixaId!);
    ownerCaixaId = input.ownerCaixaId!;
  } else {
    ownerUserId = ctx.access.actor.id;
  }
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO message_destinations (channel, name, owner_user_id, owner_caixa_id, bot_token, chat_id, is_active, created_by_user_id, notes)
      VALUES ('telegram', ${input.name}, ${ownerUserId}, ${ownerCaixaId}, ${input.botToken}, ${input.chatId}, ${input.isActive},
              ${ctx.access.actor.id}, ${input.notes})
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return getDestination(ctx, id);
}

export async function updateDestination(ctx: ServiceContext, id: string, input: z.output<typeof destinationUpdateInput>) {
  const d = await manageable(ctx, id);
  if (d.archivedAt) throw unprocessable(t.errors.destinationArchived);
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.botToken !== undefined) sets.push(sql`bot_token = ${input.botToken}`);
  if (input.chatId !== undefined) sets.push(sql`chat_id = ${input.chatId}`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (input.notes !== undefined) sets.push(sql`notes = ${input.notes}`);
  if (sets.length > 0) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE message_destinations SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`));
  }
  return getDestination(ctx, id);
}

/** Sem histórico na outbox, exclui; com histórico (FK), arquiva e desativa (as pendentes são canceladas pelo banco). */
export async function deleteDestination(ctx: ServiceContext, id: string) {
  await manageable(ctx, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.execute(sql`DELETE FROM message_destinations WHERE id = ${id} RETURNING id`)).rows.length,
      (tx2) => tx2.execute(sql`UPDATE message_destinations SET is_active = false, archived_at = now() WHERE id = ${id}`),
    ),
  );
}

/** Restaura um destino arquivado (desativado: o usuário reativa quando quiser). */
export async function restoreDestination(ctx: ServiceContext, id: string) {
  await manageable(ctx, id);
  await withTx(ctx, (tx) => tx.execute(sql`UPDATE message_destinations SET archived_at = NULL, is_active = false WHERE id = ${id}`));
  return getDestination(ctx, id);
}

/* ---------------- assinaturas ---------------- */

export async function listSubscriptions(ctx: ServiceContext, destinationId: string): Promise<MessageSubscriptionDto[]> {
  await loadDestination(ctx, destinationId);
  const result = await ctx.db.execute(sql`
    SELECT s.id, s.destination_id, s.event_kind, s.params, s.is_active,
           coalesce((SELECT array_agg(x.caixa_id::text ORDER BY x.caixa_id) FROM message_subscription_caixas x WHERE x.subscription_id = s.id), '{}') AS caixa_ids
      FROM message_subscriptions s WHERE s.destination_id = ${destinationId} ORDER BY s.created_at`);
  return result.rows.map((row) => camel<MessageSubscriptionDto>(row));
}

export async function upsertSubscription(ctx: ServiceContext, destinationId: string, input: z.output<typeof subscriptionInput>) {
  const d = await manageable(ctx, destinationId);
  if (d.archivedAt) throw unprocessable(t.errors.destinationArchived);
  for (const caixaId of input.caixaIds) ctx.access.assertRead(caixaId);
  await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO message_subscriptions (destination_id, event_kind, params, is_active)
      VALUES (${destinationId}, ${input.eventKind}, ${JSON.stringify(input.params)}::jsonb, ${input.isActive})
      ON CONFLICT (destination_id, event_kind) DO UPDATE SET params = EXCLUDED.params, is_active = EXCLUDED.is_active
      RETURNING id`);
    const subscriptionId = result.rows[0]!.id;
    const keep = input.caixaIds.length > 0 ? sql`AND caixa_id <> ALL (${`{${input.caixaIds.join(',')}}`}::uuid[])` : sql``;
    await tx.execute(sql`DELETE FROM message_subscription_caixas WHERE subscription_id = ${subscriptionId} ${keep}`);
    if (input.caixaIds.length > 0) {
      await tx.execute(sql`
        INSERT INTO message_subscription_caixas (subscription_id, caixa_id)
        SELECT ${subscriptionId}::uuid, unnest(${`{${input.caixaIds.join(',')}}`}::uuid[])
        ON CONFLICT (subscription_id, caixa_id) DO NOTHING`);
    }
  });
  return listSubscriptions(ctx, destinationId);
}

export async function deleteSubscription(ctx: ServiceContext, destinationId: string, eventKind: MessageEventKind) {
  await manageable(ctx, destinationId);
  await withTx(ctx, (tx) =>
    tx.execute(sql`DELETE FROM message_subscriptions WHERE destination_id = ${destinationId} AND event_kind = ${eventKind}`),
  );
  return listSubscriptions(ctx, destinationId);
}

/* ---------------- histórico (outbox) ---------------- */

export async function listOutbox(ctx: ServiceContext, q: z.output<typeof outboxQuery>): Promise<OutboxMessageDto[]> {
  const where: SQL[] = [visibleFilter(ctx.access)];
  if (q.destinationId) where.push(sql`o.destination_id = ${q.destinationId}`);
  if (q.status) where.push(sql`o.status = ${q.status}`);
  if (q.before) where.push(sql`o.id < ${q.before}::uuid`);
  const result = await ctx.db.execute(sql`
    SELECT o.id, o.destination_id, d.name AS destination_name, d.owner_user_id, d.owner_caixa_id, o.event_kind, o.status,
           o.attempts, o.max_attempts, o.next_attempt_at, o.sent_at, o.last_error, o.payload ->> 'text' AS text, o.caixa_id, o.created_at
      FROM message_outbox o
      JOIN message_destinations d ON d.id = o.destination_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY o.id DESC
     LIMIT ${q.limit}`);
  return result.rows.map((row) => {
    const r = camel<OutboxMessageDto & { ownerUserId: string | null; ownerCaixaId: string | null }>(row);
    return {
      id: r.id,
      destinationId: r.destinationId,
      destinationName: r.destinationName,
      eventKind: r.eventKind,
      status: r.status,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.maxAttempts),
      nextAttemptAt: iso(r.nextAttemptAt)!,
      sentAt: iso(r.sentAt),
      lastError: r.lastError,
      text: r.text ?? '',
      caixaId: r.caixaId,
      createdAt: iso(r.createdAt)!,
      canManage: canManage(ctx.access, r),
    };
  });
}

async function outboxRow(ctx: ServiceContext, id: string) {
  const result = await ctx.db.execute<{ destination_id: string; status: OutboxStatus }>(
    sql`SELECT destination_id, status FROM message_outbox WHERE id = ${id}`,
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  await manageable(ctx, row.destination_id);
  return row;
}

/** Reenvio manual de uma mensagem que falhou: volta à fila com as tentativas zeradas. */
export async function resendMessage(ctx: ServiceContext, id: string) {
  const row = await outboxRow(ctx, id);
  if (row.status !== 'failed') throw unprocessable(t.errors.outboxNotFailed);
  await withTx(ctx, (tx) =>
    tx.execute(
      sql`UPDATE message_outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = ${id} AND status = 'failed'`,
    ),
  );
  return { ok: true };
}

export async function cancelMessage(ctx: ServiceContext, id: string) {
  const row = await outboxRow(ctx, id);
  if (row.status !== 'pending' && row.status !== 'failed') throw unprocessable(t.errors.outboxNotPending);
  await withTx(ctx, (tx) =>
    tx.execute(sql`
      UPDATE message_outbox SET status = 'canceled', last_error = coalesce(last_error, 'canceled_by_user')
       WHERE id = ${id} AND status IN ('pending', 'failed')`),
  );
  return { ok: true };
}

/* ---------------- envio ---------------- */

/**
 * "Enviar teste": enfileira uma mensagem `test` e já tenta entregá-la na hora
 * (reserva só ela, envia fora da transação e fecha), para a tela mostrar o
 * resultado. Se falhar de forma temporária, o worker tenta de novo.
 */
export async function sendTest(ctx: ServiceContext, destinationId: string): Promise<TestSendResult> {
  const d = await manageable(ctx, destinationId);
  if (d.archivedAt) throw unprocessable(t.errors.destinationArchived);
  if (!d.isActive) throw unprocessable(t.errors.destinationInactive);
  const payload = testMessage(d.name, formatDateTime(new Date()));
  const messageId = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO message_outbox (destination_id, event_kind, user_id, payload)
      VALUES (${destinationId}, 'test', ${ctx.access.actor.id}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return deliverNow(ctx, messageId, d, payload);
}

/** Reserva só esta mensagem (message_outbox_claim_one, transação curta) e entrega fora de transação. */
async function deliverNow(ctx: ServiceContext, messageId: string, d: DestRow, payload: MessagePayload): Promise<TestSendResult> {
  const claimed = await ctx.db.execute(sql`SELECT id FROM message_outbox_claim_one(${messageId}::uuid)`);
  if (claimed.rows.length === 0) return { messageId, status: 'pending', error: null };
  const outcome = await deliver(ctx.db, ctx.config, { id: messageId, chatId: d.chatId!, destinationName: d.name, payload });
  return { messageId, status: outcome.status, error: outcome.error };
}

/**
 * Mensagem de agente para um destino (tool "enviar mensagem", spec 011/013):
 * só para destinos que o usuário gerencia; enfileira como agent_message com a
 * execução do agente e tenta entregar na hora (o worker repete se falhar).
 */
export async function sendAgentMessage(
  ctx: ServiceContext,
  destinationId: string,
  text: string,
  dedupKey: string,
): Promise<TestSendResult> {
  const d = await manageable(ctx, destinationId);
  if (d.archivedAt) throw unprocessable(t.errors.destinationArchived);
  if (!d.isActive) throw unprocessable(t.errors.destinationInactive);
  const payload = agentMessage('agent_message', null, text, null);
  const messageId = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO message_outbox (destination_id, event_kind, dedup_key, user_id, agent_run_id, payload)
      VALUES (${destinationId}, 'agent_message', ${dedupKey.slice(0, 300)}, ${ctx.access.actor.id}, ${ctx.agentRunId ?? null},
              ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (destination_id, dedup_key) DO NOTHING
      RETURNING id`);
    return result.rows[0]?.id ?? null;
  });
  if (!messageId) return { messageId: '', status: 'pending', error: null };
  return deliverNow(ctx, messageId, d, payload);
}

export type ClaimedMessage = { id: string; chatId: string; destinationName: string; payload: MessagePayload };

/**
 * Entrega uma mensagem já reservada (status sending): lê o token pela função
 * do banco, chama a Bot API fora de transação e fecha com mark_sent ou
 * mark_failed (retry_after do 429; 400/401/403/404 = falha permanente).
 * Falha definitiva gera a notificação message_failed para o dono do destino.
 */
export async function deliver(
  db: Executor,
  config: Config,
  message: ClaimedMessage,
): Promise<{ status: OutboxStatus; error: string | null }> {
  let token: string;
  try {
    const result = await db.execute<{ token: string }>(sql`SELECT message_destination_token(${message.id}::uuid) AS token`);
    token = result.rows[0]!.token;
  } catch (error) {
    const status = await markFailed(db, message.id, 'token unavailable', null, true);
    if (status === 'failed') await notifyFailure(db, message.id, 'token unavailable');
    return { status, error: String((error as Error).message ?? error) };
  }
  const sent = await sendTelegramMessage(
    { apiBase: config.telegramApiBase, timeoutMs: config.telegramTimeoutMs },
    token,
    message.chatId,
    message.payload,
  );
  if (sent.ok) {
    await db.execute(sql`SELECT message_outbox_mark_sent(${message.id}::uuid, ${sent.messageId || null})`);
    return { status: 'sent', error: null };
  }
  const status = await markFailed(db, message.id, sent.error, sent.retryAfterSec, sent.permanent);
  if (status === 'failed') await notifyFailure(db, message.id, sent.error);
  return { status, error: sent.error };
}

async function markFailed(
  db: Executor,
  id: string,
  error: string,
  retryAfterSec: number | null,
  permanent: boolean,
): Promise<OutboxStatus> {
  const retry = retryAfterSec === null ? null : `${Math.ceil(retryAfterSec)} seconds`;
  const result = await db.execute<{ status: OutboxStatus }>(
    sql`SELECT message_outbox_mark_failed(${id}::uuid, ${error}, ${retry}::interval, ${permanent}) AS status`,
  );
  return result.rows[0]!.status;
}

/** Notifica o dono (pessoal) ou quem criou o destino (de caixa / global) que a mensagem não saiu. */
async function notifyFailure(db: Executor, messageId: string, error: string) {
  const result = await db.execute<{
    destination_id: string;
    name: string;
    owner_user_id: string | null;
    created_by_user_id: string | null;
    caixa_id: string | null;
  }>(sql`
    SELECT d.id AS destination_id, d.name, d.owner_user_id, d.created_by_user_id, o.caixa_id
      FROM message_outbox o JOIN message_destinations d ON d.id = o.destination_id WHERE o.id = ${messageId}`);
  const row = result.rows[0];
  if (!row) return;
  const users = [...new Set([row.owner_user_id, row.created_by_user_id].filter((u): u is string => Boolean(u)))];
  await createNotifications(
    db,
    users.map((userId) => ({
      userId,
      kind: 'message_failed' as const,
      title: t.notifications.messageFailed(row.name),
      body: t.notifications.messageFailedBody(error.slice(0, 300)),
      link: `/messages?tab=history&destination=${row.destination_id}&status=failed`,
      caixaId: row.caixa_id,
      data: { messageId, destinationId: row.destination_id },
      dedupKey: `message_failed:${messageId}`,
    })),
  );
}
