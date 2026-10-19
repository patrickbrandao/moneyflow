import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@moneyflow/db';
import {
  type AdminApiTokenDto,
  type ApiTokenCreated,
  type ApiTokenDto,
  type adminApiTokenCreateInput,
  type adminApiTokenQuery,
  type apiTokenCreateInput,
  type GlobalRole,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { withTx } from './tx';
import { membershipsOf } from './users';
import { iso } from './util';

/*
 * Tokens pessoais de API (spec 011): autenticam o servidor MCP próprio (/mcp)
 * com as permissões do dono. O banco guarda só o SHA-256 (que nem o papel da
 * aplicação lê) e um prefixo visível; o token aparece UMA vez, na criação.
 */

export const hashApiToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const COLUMNS = sql`id, name, token_prefix, expires_at, revoked_at, last_used_at, last_used_ip, created_at`;

type Row = {
  id: string;
  name: string;
  token_prefix: string;
  expires_at: unknown;
  revoked_at: unknown;
  last_used_at: unknown;
  last_used_ip: string | null;
  created_at: unknown;
};

const toDto = (r: Row): ApiTokenDto => ({
  id: r.id,
  name: r.name,
  tokenPrefix: r.token_prefix,
  expiresAt: iso(r.expires_at),
  revokedAt: iso(r.revoked_at),
  lastUsedAt: iso(r.last_used_at),
  lastUsedIp: r.last_used_ip,
  createdAt: iso(r.created_at)!,
});

export async function listApiTokens(ctx: ServiceContext): Promise<ApiTokenDto[]> {
  const result = await ctx.db.execute<Row>(sql`
    SELECT ${COLUMNS} FROM user_api_tokens WHERE user_id = ${ctx.access.actor.id}
     ORDER BY revoked_at NULLS FIRST, created_at DESC`);
  return result.rows.map(toDto);
}

export async function createApiToken(ctx: ServiceContext, input: z.output<typeof apiTokenCreateInput>): Promise<ApiTokenCreated> {
  return insertToken(ctx, ctx.access.actor.id, input);
}

async function insertToken(ctx: ServiceContext, userId: string, input: z.output<typeof apiTokenCreateInput>): Promise<ApiTokenCreated> {
  const token = `mf_${randomBytes(32).toString('base64url')}`;
  const prefix = token.slice(0, 12);
  const row = await withTx(ctx, async (tx) => {
    const result = await tx.execute<Row>(sql`
      INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix, expires_at)
      VALUES (${userId}, ${input.name}, ${hashApiToken(token)}, ${prefix},
              ${input.expiresInDays ? sql`now() + make_interval(days => ${input.expiresInDays})` : null})
      RETURNING ${COLUMNS}`);
    return result.rows[0]!;
  });
  return { ...toDto(row), token };
}

export async function revokeApiToken(ctx: ServiceContext, id: string): Promise<ApiTokenDto> {
  return revoke(ctx, id, sql` AND user_id = ${ctx.access.actor.id}`);
}

async function revoke(ctx: ServiceContext, id: string, owner: ReturnType<typeof sql>): Promise<ApiTokenDto> {
  const row = await withTx(ctx, async (tx) => {
    const found = await tx.execute<Row>(sql`SELECT ${COLUMNS} FROM user_api_tokens WHERE id = ${id}${owner}`);
    if (!found.rows[0]) throw notFound();
    if (found.rows[0].revoked_at) return found.rows[0];
    const result = await tx.execute<Row>(sql`UPDATE user_api_tokens SET revoked_at = now() WHERE id = ${id} RETURNING ${COLUMNS}`);
    return result.rows[0]!;
  });
  return toDto(row);
}

/* ---------------- Administração → Controle MCP ---------------- */

type AdminRow = Row & { user_id: string; username: string; user_role: GlobalRole; user_active: boolean; created_by: string | null };

const ADMIN_SELECT = sql`
  SELECT k.id, k.name, k.token_prefix, k.expires_at, k.revoked_at, k.last_used_at, k.last_used_ip, k.created_at,
         k.user_id, u.username, u.role AS user_role, u.is_active AS user_active,
         (SELECT cu.username FROM audit_log a JOIN users cu ON cu.id = a.user_id
           WHERE a.table_name = 'user_api_tokens' AND a.record_id = k.id AND a.action = 'insert'
           ORDER BY a.created_at LIMIT 1) AS created_by
    FROM user_api_tokens k
    JOIN users u ON u.id = k.user_id`;

async function toAdminDtos(ctx: ServiceContext, rows: AdminRow[]): Promise<AdminApiTokenDto[]> {
  const memberships = await membershipsOf(ctx.db, [...new Set(rows.map((r) => r.user_id))]);
  return rows.map((r) => ({
    ...toDto(r),
    userId: r.user_id,
    username: r.username,
    userRole: r.user_role,
    userActive: r.user_active,
    // Admin vê todas as caixas: as associações não mudam os poderes dele.
    memberships: r.user_role === 'admin' ? [] : (memberships.get(r.user_id) ?? []),
    createdBy: r.created_by,
  }));
}

/** Todas as chaves MCP (de todos os usuários), com o dono e os poderes herdados. Só admin. */
export async function listAllApiTokens(ctx: ServiceContext, query: z.output<typeof adminApiTokenQuery>): Promise<AdminApiTokenDto[]> {
  ctx.access.assertAdmin();
  const where = [sql`true`];
  if (query.userId) where.push(sql`k.user_id = ${query.userId}`);
  if (!query.includeRevoked) where.push(sql`k.revoked_at IS NULL`);
  const result = await ctx.db.execute<AdminRow>(
    sql`${ADMIN_SELECT} WHERE ${sql.join(where, sql` AND `)} ORDER BY k.revoked_at NULLS FIRST, u.username, k.created_at DESC`,
  );
  return toAdminDtos(ctx, result.rows);
}

/** Gera uma chave para um usuário: ela age com os poderes dele (papel global e caixas), lidos a cada uso. */
export async function createApiTokenFor(
  ctx: ServiceContext,
  input: z.output<typeof adminApiTokenCreateInput>,
): Promise<AdminApiTokenDto & { token: string }> {
  ctx.access.assertAdmin();
  const owner = await ctx.db.execute<{ is_active: boolean }>(sql`SELECT is_active FROM users WHERE id = ${input.userId}`);
  if (!owner.rows[0]) throw notFound();
  if (!owner.rows[0].is_active) throw unprocessable(t.errors.apiTokenUserInactive, 'api_token_user_inactive');
  const created = await insertToken(ctx, input.userId, input);
  const result = await ctx.db.execute<AdminRow>(sql`${ADMIN_SELECT} WHERE k.id = ${created.id}`);
  const [dto] = await toAdminDtos(ctx, result.rows);
  return { ...dto!, token: created.token };
}

/** Revoga a chave de qualquer usuário. Só admin. */
export async function revokeAnyApiToken(ctx: ServiceContext, id: string): Promise<ApiTokenDto> {
  ctx.access.assertAdmin();
  return revoke(ctx, id, sql``);
}

/** Dono de um token válido (api_token_authenticate), ou null. */
export async function authenticateApiToken(db: Database, token: string, ip: string | null) {
  if (!/^mf_[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  const result = await db.execute<{ user_id: string; token_id: string }>(
    sql`SELECT user_id, token_id FROM api_token_authenticate(${hashApiToken(token)}, ${ip}::inet)`,
  );
  return result.rows[0] ?? null;
}
