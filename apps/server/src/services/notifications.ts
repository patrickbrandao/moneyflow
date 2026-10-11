import type { Executor } from '@moneyflow/db';
import type { NotificationDto, NotificationKind, NotificationList } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound } from '../errors';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Notificações do sino (por usuário). O worker cria (ON CONFLICT (user_id,
 * dedup_key) DO NOTHING) e a API lista e marca como lida — sempre só as do
 * próprio usuário.
 */

export async function listNotifications(ctx: ServiceContext, q: { unread: boolean; limit: number }): Promise<NotificationList> {
  const me = ctx.access.actor.id;
  const [items, unread] = await Promise.all([
    ctx.db.execute(sql`
      SELECT id, kind, title, body, link, caixa_id, read_at, created_at FROM notifications
       WHERE user_id = ${me} ${q.unread ? sql`AND read_at IS NULL` : sql``}
       ORDER BY created_at DESC, id DESC LIMIT ${q.limit}`),
    ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${me} AND read_at IS NULL`),
  ]);
  return {
    unread: Number(unread.rows[0]?.n ?? 0),
    items: items.rows.map((row) => {
      const n = camel<NotificationDto>(row);
      return { ...n, readAt: iso(n.readAt), createdAt: iso(n.createdAt)! };
    }),
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
