import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@moneyflow/db';
import type { ApiTokenCreated, ApiTokenDto, apiTokenCreateInput } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound } from '../errors';
import { withTx } from './tx';
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
  const token = `mf_${randomBytes(32).toString('base64url')}`;
  const prefix = token.slice(0, 12);
  const row = await withTx(ctx, async (tx) => {
    const result = await tx.execute<Row>(sql`
      INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix, expires_at)
      VALUES (${ctx.access.actor.id}, ${input.name}, ${hashApiToken(token)}, ${prefix},
              ${input.expiresInDays ? sql`now() + make_interval(days => ${input.expiresInDays})` : null})
      RETURNING ${COLUMNS}`);
    return result.rows[0]!;
  });
  return { ...toDto(row), token };
}

export async function revokeApiToken(ctx: ServiceContext, id: string): Promise<ApiTokenDto> {
  const row = await withTx(ctx, async (tx) => {
    const found = await tx.execute<Row>(sql`SELECT ${COLUMNS} FROM user_api_tokens WHERE id = ${id} AND user_id = ${ctx.access.actor.id}`);
    if (!found.rows[0]) throw notFound();
    if (found.rows[0].revoked_at) return found.rows[0];
    const result = await tx.execute<Row>(sql`UPDATE user_api_tokens SET revoked_at = now() WHERE id = ${id} RETURNING ${COLUMNS}`);
    return result.rows[0]!;
  });
  return toDto(row);
}

/** Dono de um token válido (api_token_authenticate), ou null. */
export async function authenticateApiToken(db: Database, token: string, ip: string | null) {
  if (!/^mf_[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  const result = await db.execute<{ user_id: string; token_id: string }>(
    sql`SELECT user_id, token_id FROM api_token_authenticate(${hashApiToken(token)}, ${ip}::inet)`,
  );
  return result.rows[0] ?? null;
}
