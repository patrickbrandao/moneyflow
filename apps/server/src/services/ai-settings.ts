import type { Executor } from '@moneyflow/db';
import { t, type UserAiSettingsDto, type userAiSettingsInput } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Minha conta → IA (spec 022): as instruções do usuário para todos os agentes
 * (até 20 mil) e a "Minha caixa principal" (uma caixa general que ele lê).
 * Só o próprio usuário edita; o admin lê as de qualquer um. Sem linha em
 * user_ai_settings = sem instruções nem caixa principal.
 */

async function load(db: Executor, userId: string): Promise<UserAiSettingsDto> {
  const result = await db.execute<{
    instructions: string;
    primary_caixa_id: string | null;
    caixa_name: string | null;
    updated_at: unknown;
  }>(sql`
    SELECT s.instructions, s.primary_caixa_id, c.name AS caixa_name, s.updated_at
      FROM user_ai_settings s LEFT JOIN caixas c ON c.id = s.primary_caixa_id
     WHERE s.user_id = ${userId}`);
  const row = result.rows[0];
  return {
    instructions: row?.instructions ?? '',
    primaryCaixaId: row?.primary_caixa_id ?? null,
    primaryCaixaName: row?.caixa_name ?? null,
    updatedAt: iso(row?.updated_at ?? null),
  };
}

export function getMyAiSettings(ctx: ServiceContext) {
  return load(ctx.db, ctx.access.actor.id);
}

export async function putMyAiSettings(ctx: ServiceContext, input: z.output<typeof userAiSettingsInput>) {
  const userId = ctx.access.actor.id;
  if (input.primaryCaixaId) {
    // A caixa principal precisa ser uma que o usuário lê (o banco confere que é general).
    if (!ctx.access.canRead(input.primaryCaixaId)) throw notFound(t.agents.errors.primaryCaixaNotReadable);
    const found = await ctx.db.execute<{ kind: string }>(sql`SELECT kind FROM caixas WHERE id = ${input.primaryCaixaId}`);
    if (!found.rows[0]) throw notFound(t.agents.errors.primaryCaixaNotReadable);
    if (found.rows[0].kind !== 'general')
      throw unprocessable(t.agents.errors.primaryCaixaNotGeneral, 'user_ai_settings_primary_caixa_check');
  }
  await withTx(ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO user_ai_settings (user_id, instructions, primary_caixa_id)
      VALUES (${userId}, ${input.instructions}, ${input.primaryCaixaId})
      ON CONFLICT (user_id) DO UPDATE SET instructions = EXCLUDED.instructions, primary_caixa_id = EXCLUDED.primary_caixa_id`),
  );
  return load(ctx.db, userId);
}

/** O admin lê as instruções de qualquer usuário (somente leitura). */
export async function getUserAiSettings(ctx: ServiceContext, userId: string) {
  ctx.access.assertAdmin();
  const found = await ctx.db.execute(sql`SELECT 1 FROM users WHERE id = ${userId}`);
  if (found.rows.length === 0) throw notFound();
  return load(ctx.db, userId);
}
