import { caixaHiddenCategories, categories } from '@moneyflow/db';
import type { CategoryNode, categoryCreateInput, categoryUpdateInput, DeleteResult } from '@moneyflow/shared';
import { asc, eq, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound } from '../errors';
import { deleteOrArchive } from './util';

/*
 * Plano global de categorias (spec 008): receita/despesa, grupo → subcategoria.
 * Leitura para todos; escrita só do admin (o plano é compartilhado por todas as caixas).
 * Ocultar um grupo numa caixa oculta também os filhos (herança na aplicação).
 */

export async function categoryTree(
  ctx: ServiceContext,
  opts: { caixaId?: string; kind?: 'income' | 'expense'; archived?: boolean } = {},
): Promise<CategoryNode[]> {
  if (opts.caixaId) ctx.access.assertRead(opts.caixaId);
  const rows = await ctx.db.select().from(categories).orderBy(asc(categories.name));
  const hidden = new Set(
    opts.caixaId
      ? (await ctx.db.select().from(caixaHiddenCategories).where(eq(caixaHiddenCategories.caixaId, opts.caixaId))).map((h) => h.categoryId)
      : [],
  );
  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) {
    if (opts.kind && row.kind !== opts.kind) continue;
    if (!opts.archived && row.archivedAt) continue;
    nodes.set(row.id, {
      id: row.id,
      kind: row.kind as 'income' | 'expense',
      parentId: row.parentId,
      name: row.name,
      colorSlot: row.colorSlot,
      icon: row.icon,
      archivedAt: row.archivedAt,
      hidden: hidden.has(row.id),
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) {
      if (parent.hidden) node.hidden = true;
      parent.children.push(node);
    } else if (!node.parentId) roots.push(node);
  }
  return roots.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'pt-BR') : a.kind === 'expense' ? -1 : 1));
}

export async function createCategory(ctx: ServiceContext, input: z.output<typeof categoryCreateInput>) {
  ctx.access.assertAdmin();
  const [row] = await ctx.db.insert(categories).values(input).returning();
  return row!;
}

export async function updateCategory(ctx: ServiceContext, id: string, input: z.output<typeof categoryUpdateInput>) {
  ctx.access.assertAdmin();
  const patch: Partial<typeof categories.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.parentId !== undefined) patch.parentId = input.parentId;
  if (input.colorSlot !== undefined) patch.colorSlot = input.colorSlot;
  if (input.icon !== undefined) patch.icon = input.icon;
  const [row] = await ctx.db.update(categories).set(patch).where(eq(categories.id, id)).returning();
  if (!row) throw notFound();
  return row;
}

export async function deleteCategory(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  ctx.access.assertAdmin();
  const [row] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, id));
  if (!row) throw notFound();
  return deleteOrArchive(
    async () => (await ctx.db.delete(categories).where(eq(categories.id, id))).rowCount ?? 0,
    // Arquivar o grupo arquiva as subcategorias.
    () =>
      ctx.db
        .update(categories)
        .set({ archivedAt: sql`now()` })
        .where(or(eq(categories.id, id), eq(categories.parentId, id))),
  );
}

export async function restoreCategory(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await ctx.db.update(categories).set({ archivedAt: null }).where(eq(categories.id, id));
}
