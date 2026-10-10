import { createHash, randomBytes } from 'node:crypto';
import { type Database, sessions, userColumns, users } from '@moneyflow/db';
import type { GlobalRole } from '@moneyflow/shared';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Actor } from '../authz/access';

/*
 * Sessão em cookie httpOnly com token aleatório; no banco fica só o hash
 * (sessions.id = sha256 hex do token), então um dump da tabela não dá acesso.
 */

export const SESSION_COOKIE = 'mf_session';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Database, userId: string, days: number, meta: { ip?: string; userAgent?: string }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt: expiresAt.toISOString(),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });
  return { token, expiresAt };
}

/** Usuário ativo dono do token, ou null. Atualiza last_seen_at no máximo a cada 5 min. */
export async function resolveSession(db: Database, token: string): Promise<{ actor: Actor; sessionId: string } | null> {
  const id = hashToken(token);
  const [row] = await db
    .select({ ...userColumns, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, sql`now()`), eq(users.isActive, true)))
    .limit(1);
  if (!row) return null;
  if (Date.now() - new Date(row.lastSeenAt).getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, id));
  }
  return {
    sessionId: id,
    actor: { id: row.id, username: row.username, email: row.email, role: row.role as GlobalRole, isActive: row.isActive },
  };
}

export async function deleteSession(db: Database, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function purgeExpiredSessions(db: Database) {
  await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));
}
