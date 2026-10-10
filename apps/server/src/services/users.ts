import { caixaMembers, caixas, type Database, type Executor, sessions, userColumns, users } from '@moneyflow/db';
import {
  type CaixaRole,
  type changePasswordInput,
  type GlobalRole,
  type Me,
  type Membership,
  type membershipsSetInput,
  t,
  type UserRow,
  type userCreateInput,
  type userUpdateInput,
} from '@moneyflow/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { AppError, notFound, unprocessable } from '../errors';

/*
 * Usuários (spec 002). A senha é texto puro por decisão do produto, mas a
 * aplicação nunca a lê: moneyflow_app não tem SELECT em users.password.
 * Só admin_reveal_password() devolve a senha, e só para um admin ativo.
 */

/** INSERT com as colunas que o papel da aplicação pode inserir (o Drizzle listaria todas). */
export async function insertUser(
  db: Executor,
  input: { username: string; email: string; password: string; role: GlobalRole; isActive: boolean },
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO users (username, email, password, role, is_active)
    VALUES (${input.username}, ${input.email}, ${input.password}, ${input.role}, ${input.isActive})
    RETURNING id`);
  return result.rows[0]!.id;
}

async function membershipsOf(db: Executor, userIds: string[]): Promise<Map<string, Membership[]>> {
  const map = new Map<string, Membership[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({ userId: caixaMembers.userId, caixaId: caixaMembers.caixaId, caixaName: caixas.name, role: caixaMembers.role })
    .from(caixaMembers)
    .innerJoin(caixas, eq(caixas.id, caixaMembers.caixaId))
    .where(inArray(caixaMembers.userId, userIds))
    .orderBy(asc(caixas.name));
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ caixaId: row.caixaId, caixaName: row.caixaName, role: row.role as CaixaRole });
    map.set(row.userId, list);
  }
  return map;
}

function toRow(row: typeof users.$inferSelect | Omit<typeof users.$inferSelect, 'password'>, memberships: Membership[]): UserRow {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role as GlobalRole,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    memberships,
  };
}

export async function getMe(ctx: ServiceContext): Promise<Me> {
  const { actor } = ctx.access;
  const memberships = (await membershipsOf(ctx.db, [actor.id])).get(actor.id) ?? [];
  return { ...actor, canEditRegistry: ctx.access.canEditRegistry, memberships };
}

export async function listUsers(ctx: ServiceContext): Promise<UserRow[]> {
  ctx.access.assertAdmin();
  const rows = await ctx.db.select(userColumns).from(users).orderBy(asc(users.username));
  const memberships = await membershipsOf(
    ctx.db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toRow(row, memberships.get(row.id) ?? []));
}

export async function getUser(ctx: ServiceContext, id: string): Promise<UserRow> {
  ctx.access.assertAdmin();
  const [row] = await ctx.db.select(userColumns).from(users).where(eq(users.id, id));
  if (!row) throw notFound();
  return toRow(row, (await membershipsOf(ctx.db, [id])).get(id) ?? []);
}

export async function createUser(ctx: ServiceContext, input: z.output<typeof userCreateInput>): Promise<UserRow> {
  ctx.access.assertAdmin();
  const id = await insertUser(ctx.db, input);
  return getUser(ctx, id);
}

async function activeAdminCount(db: Executor, exceptId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, exceptId)));
  return row?.n ?? 0;
}

export async function updateUser(ctx: ServiceContext, id: string, input: z.output<typeof userUpdateInput>): Promise<UserRow> {
  ctx.access.assertAdmin();
  const self = id === ctx.access.actor.id;
  if (self && input.isActive === false) throw unprocessable(t.errors.selfDeactivate);
  await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select(userColumns).from(users).where(eq(users.id, id)).for('update');
    if (!current) throw notFound();
    const losesAdmin = current.role === 'admin' && current.isActive && (input.role === 'user' || input.isActive === false);
    if (losesAdmin && (await activeAdminCount(tx, id)) === 0) throw unprocessable(t.errors.lastAdmin);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.username !== undefined) patch.username = input.username;
    if (input.email !== undefined) patch.email = input.email;
    if (input.password !== undefined) patch.password = input.password;
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (Object.keys(patch).length > 0) await tx.update(users).set(patch).where(eq(users.id, id));
    // Trocar a senha encerra as sessões do usuário (desativar já faz isso por trigger).
    if (input.password !== undefined && !self) await tx.delete(sessions).where(eq(sessions.userId, id));
  });
  return getUser(ctx, id);
}

export async function deleteUser(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  if (id === ctx.access.actor.id) throw unprocessable(t.errors.selfDelete);
  await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select(userColumns).from(users).where(eq(users.id, id)).for('update');
    if (!current) throw notFound();
    if (current.role === 'admin' && current.isActive && (await activeAdminCount(tx, id)) === 0) throw unprocessable(t.errors.lastAdmin);
    await tx.delete(users).where(eq(users.id, id));
  });
}

export async function revealPassword(ctx: ServiceContext, id: string): Promise<string> {
  ctx.access.assertAdmin();
  const result = await ctx.db.execute<{ password: string }>(
    sql`SELECT admin_reveal_password(${id}::uuid, ${ctx.access.actor.id}::uuid) AS password`,
  );
  const password = result.rows[0]?.password;
  if (password === undefined) throw notFound();
  return password;
}

export async function setMemberships(ctx: ServiceContext, userId: string, input: z.output<typeof membershipsSetInput>) {
  ctx.access.assertAdmin();
  await ctx.db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound();
    await tx.delete(caixaMembers).where(eq(caixaMembers.userId, userId));
    const unique = new Map(input.memberships.map((m) => [m.caixaId, m.role]));
    if (unique.size > 0) {
      await tx.insert(caixaMembers).values([...unique].map(([caixaId, role]) => ({ userId, caixaId, role })));
    }
  });
  return getUser(ctx, userId);
}

/** Verifica a senha atual por auth_login (a aplicação não lê a senha). */
export async function changeOwnPassword(ctx: ServiceContext, input: z.output<typeof changePasswordInput>, currentSessionId: string) {
  const { actor } = ctx.access;
  const check = await ctx.db.execute<{ id: string | null }>(sql`SELECT auth_login(${actor.username}, ${input.currentPassword}) AS id`);
  if (check.rows[0]?.id !== actor.id) throw new AppError(422, 'current_password', t.errors.currentPasswordWrong);
  await ctx.db.transaction(async (tx) => {
    await tx.update(users).set({ password: input.newPassword }).where(eq(users.id, actor.id));
    await tx.delete(sessions).where(and(eq(sessions.userId, actor.id), ne(sessions.id, currentSessionId)));
  });
}

/** Login por username ou e-mail via auth_login(); devolve o id ou null. */
export async function authenticate(db: Database, login: string, password: string): Promise<string | null> {
  const result = await db.execute<{ id: string | null }>(sql`SELECT auth_login(${login}, ${password}) AS id`);
  return result.rows[0]?.id ?? null;
}
