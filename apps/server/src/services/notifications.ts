import type { Executor } from '@moneyflow/db';
import { type NotificationDto, type NotificationKind, type NotificationList, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Notificações do sino (por usuário). O worker cria (ON CONFLICT (user_id,
 * dedup_key) DO NOTHING) e a API lista e marca como lida — sempre só as do
 * próprio usuário.
 */

/*
 * Ordem do sino (spec 013, tarefa 169): não lidas primeiro, depois a mais recente. O cursor leva a
 * posição da última da página (não lida?, criação, id), não o id: marcar uma como lida entre as
 * páginas não pula as não lidas que faltam.
 */
const encodeCursor = (unread: number, at: string, id: string) => Buffer.from(`${unread}|${at}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { unread: number; at: string; id: string } {
  const [unread, at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (
    (unread !== '0' && unread !== '1') ||
    !at ||
    !id ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw badRequest(t.notifications.invalidCursor);
  }
  return { unread: Number(unread), at, id };
}

export async function listNotifications(
  ctx: ServiceContext,
  q: { unread: boolean; limit: number; cursor?: string },
): Promise<NotificationList> {
  const me = ctx.access.actor.id;
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const [items, unread] = await Promise.all([
    ctx.db.execute<Record<string, unknown> & { unread_rank: number; cursor_at: string; id: string }>(sql`
      SELECT id, kind, title, body, link, caixa_id, read_at, created_at, (read_at IS NULL)::int AS unread_rank,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM notifications
       WHERE user_id = ${me} ${q.unread ? sql`AND read_at IS NULL` : sql``}
         ${after ? sql`AND ((read_at IS NULL)::int, created_at, id) < (${after.unread}::int, ${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
       ORDER BY (read_at IS NULL)::int DESC, created_at DESC, id DESC LIMIT ${q.limit + 1}`),
    ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${me} AND read_at IS NULL`),
  ]);
  const rows = items.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return {
    unread: Number(unread.rows[0]?.n ?? 0),
    items: rows.map(({ unread_rank: _rank, cursor_at: _at, ...row }) => {
      const n = camel<NotificationDto>(row);
      return { ...n, readAt: iso(n.readAt), createdAt: iso(n.createdAt)! };
    }),
    nextCursor: items.rows.length > q.limit && last ? encodeCursor(Number(last.unread_rank), last.cursor_at, last.id) : null,
  };
}

export async function markRead(ctx: ServiceContext, id: string) {
  const result = await withTx(ctx, (tx) =>
    tx.execute(sql`
      UPDATE notifications SET read_at = coalesce(read_at, now())
       WHERE id = ${id} AND user_id = ${ctx.access.actor.id} RETURNING id`),
  );
  if (result.rows.length === 0) throw notFound();
  return { ok: true };
}

export async function markAllRead(ctx: ServiceContext) {
  const result = await withTx(ctx, (tx) =>
    tx.execute(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${ctx.access.actor.id} AND read_at IS NULL RETURNING id`),
  );
  return { updated: result.rows.length };
}

export type NewNotification = {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  caixaId?: string | null;
  data?: Record<string, unknown>;
  dedupKey?: string | null;
};

/** Cria notificações (worker/serviços), ignorando as que já existem pela dedup_key. Devolve quantas entraram. */
export async function createNotifications(db: Executor, items: NewNotification[]): Promise<number> {
  if (items.length === 0) return 0;
  const values = items.map(
    (n) =>
      sql`(${n.userId}::uuid, ${n.kind}, ${n.title.slice(0, 200)}, ${n.body ?? null}, ${n.link ?? null}, ${n.caixaId ?? null}::uuid, ${JSON.stringify(n.data ?? {})}::jsonb, ${n.dedupKey ?? null})`,
  );
  const result = await db.execute(sql`
    INSERT INTO notifications (user_id, kind, title, body, link, caixa_id, data, dedup_key)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (user_id, dedup_key) DO NOTHING RETURNING id`);
  return result.rows.length;
}
