import { caixaHiddenCategories, categories } from '@moneyflow/db';
import type { CategoryNode, categoryCreateInput, categoryUpdateInput, DeleteResult } from '@moneyflow/shared';
import { asc, eq, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound } from '../errors';
import { deleteOrArchive, withTx } from './tx';

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
  const [row] = await withTx(ctx, (tx) => tx.insert(categories).values(input).returning());
  return row!;
}

export async function updateCategory(ctx: ServiceContext, id: string, input: z.output<typeof categoryUpdateInput>) {
  ctx.access.assertAdmin();
  const patch: Partial<typeof categories.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.parentId !== undefined) patch.parentId = input.parentId;
  if (input.colorSlot !== undefined) patch.colorSlot = input.colorSlot;
  if (input.icon !== undefined) patch.icon = input.icon;
  const [row] = await withTx(ctx, (tx) => tx.update(categories).set(patch).where(eq(categories.id, id)).returning());
  if (!row) throw notFound();
  return row;
}

export async function deleteCategory(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  ctx.access.assertAdmin();
  const [row] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, id));
  if (!row) throw notFound();
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.delete(categories).where(eq(categories.id, id))).rowCount ?? 0,
      // Arquivar o grupo arquiva as subcategorias. A que já estava arquivada fica com a data dela,
      // e o grupo já arquivado também: é o que o restaurar usa para saber quais filhas voltam.
      (t) =>
        t
          .update(categories)
          .set({ archivedAt: sql`coalesce(${categories.archivedAt}, now())` })
          .where(or(eq(categories.id, id), eq(categories.parentId, id))),
    ),
  );
}

/**
 * Restaurar desarquiva a categoria. No grupo, voltam junto as subcategorias
 * arquivadas pelo arquivamento dele: as que têm o mesmo `archived_at` (o
 * `now()` da transação que arquivou o grupo e as filhas). A filha arquivada
 * antes, à parte, continua arquivada (spec 008).
 */
export async function restoreCategory(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  const [row] = await ctx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, id));
  if (!row) throw notFound();
  await withTx(ctx, (tx) =>
    tx.execute(sql`
      UPDATE categories c SET archived_at = NULL
        FROM categories g
       WHERE g.id = ${id} AND g.archived_at IS NOT NULL
         AND (c.id = g.id OR (g.parent_id IS NULL AND c.parent_id = g.id AND c.archived_at = g.archived_at))`),
  );
}
