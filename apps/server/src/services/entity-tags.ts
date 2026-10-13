import { entityTagLinks, entityTags, type Tx } from '@moneyflow/db';
import type { DeleteResult, EntityFilter, EntityTag, entityTagCreateInput, entityTagUpdateInput } from '@moneyflow/shared';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { notFound } from '../errors';
import { deleteOrArchive, withTx } from './tx';
import { camel, iso } from './util';

/*
 * Tags de entidade (spec 003): catálogo global. Todos leem; só o admin cria,
 * edita, exclui (deleteOrArchive: em uso = arquivada) e restaura. Atribuir e
 * remover tags das entidades é de quem edita o cadastro (entities.ts). O
 * filtro por entidade (tags e favoritas) da listagem, dos relatórios e das
 * tools é resolvido aqui.
 */

const uuidArray = (ids: string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

export async function listTags(ctx: ServiceContext, opts: { archived?: boolean } = {}): Promise<EntityTag[]> {
  const result = await ctx.db.execute(sql`
    SELECT t.id, t.name::text AS name, t.color_slot, t.archived_at, t.created_at, t.updated_at,
           (SELECT count(*)::int FROM entity_tag_links l WHERE l.tag_id = t.id) AS usage_count
      FROM entity_tags t
     ${opts.archived ? sql`` : sql`WHERE t.archived_at IS NULL`}
     ORDER BY t.archived_at IS NOT NULL, lower(t.name::text)`);
  return result.rows.map((row) => {
    const r = camel<EntityTag>(row);
    return { ...r, archivedAt: iso(r.archivedAt), createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)! };
  });
}

async function getTag(ctx: ServiceContext, id: string): Promise<EntityTag> {
  const tag = (await listTags(ctx, { archived: true })).find((t) => t.id === id);
  if (!tag) throw notFound();
  return tag;
}

export async function createTag(ctx: ServiceContext, input: z.output<typeof entityTagCreateInput>): Promise<EntityTag> {
  ctx.access.assertAdmin();
  const [row] = await withTx(ctx, (tx) =>
    tx.insert(entityTags).values({ name: input.name, colorSlot: input.colorSlot }).returning({ id: entityTags.id }),
  );
  return getTag(ctx, row!.id);
}

export async function updateTag(ctx: ServiceContext, id: string, input: z.output<typeof entityTagUpdateInput>): Promise<EntityTag> {
  ctx.access.assertAdmin();
  const patch: Partial<typeof entityTags.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.colorSlot !== undefined) patch.colorSlot = input.colorSlot;
  if (Object.keys(patch).length > 0) {
    const result = await withTx(ctx, (tx) => tx.update(entityTags).set(patch).where(eq(entityTags.id, id)));
    if (!result.rowCount) throw notFound();
  }
  return getTag(ctx, id);
}

/** Sem uso, apaga; em uso (FK RESTRICT), arquiva: continua nas entidades, sai do seletor e do filtro. */
export async function deleteTag(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  ctx.access.assertAdmin();
  await getTag(ctx, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.delete(entityTags).where(eq(entityTags.id, id))).rowCount ?? 0,
      (t) => t.update(entityTags).set({ archivedAt: sql`now()` }).where(eq(entityTags.id, id)),
    ),
  );
}

export async function restoreTag(ctx: ServiceContext, id: string): Promise<EntityTag> {
  ctx.access.assertAdmin();
  await getTag(ctx, id);
  await withTx(ctx, (tx) => tx.update(entityTags).set({ archivedAt: null }).where(eq(entityTags.id, id)));
  return getTag(ctx, id);
}

/**
 * Substitui o conjunto de tags da entidade, dentro da transação de quem chama.
 * Mantém as ligações que já existem (inclusive com tag arquivada); só insere as
 * novas, e o banco recusa ligar uma tag arquivada (entity_tag_links_tag_active_check).
 */
export async function replaceEntityTags(tx: Tx, entityId: string, tagIds: string[]) {
  if (tagIds.length === 0) {
    await tx.delete(entityTagLinks).where(eq(entityTagLinks.entityId, entityId));
    return;
  }
  const arr = uuidArray(tagIds);
  await tx.execute(sql`DELETE FROM entity_tag_links WHERE entity_id = ${entityId}::uuid AND NOT (tag_id = ANY (${arr}))`);
  const current = new Set(
    (await tx.select({ tagId: entityTagLinks.tagId }).from(entityTagLinks).where(eq(entityTagLinks.entityId, entityId))).map(
      (r) => r.tagId,
    ),
  );
  const missing = tagIds.filter((tagId) => !current.has(tagId));
  // Uma por vez, na ordem: o erro (tag arquivada ou inexistente) sai do banco com a constraint.
  for (const tagId of missing) await tx.insert(entityTagLinks).values({ entityId, tagId });
}

/** Ids das tags ativas entre as pedidas. */
async function activeTagIds(ctx: ServiceContext, tagIds: string[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const result = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM entity_tags WHERE id = ANY (${uuidArray(tagIds)}) AND archived_at IS NULL`,
  );
  return result.rows.map((r) => r.id);
}

export const hasEntityFilter = (filter: Partial<EntityFilter> | undefined): filter is EntityFilter =>
  Boolean(filter && ((filter.tagIds?.length ?? 0) > 0 || filter.favorites));

/**
 * Condição SQL do filtro sobre a entidade `alias` (tags ativas, any/all, e
 * favoritas); null = sem filtro. `false` quando nenhuma tag pedida está ativa.
 */
export async function entityFilterCondition(ctx: ServiceContext, filter: Partial<EntityFilter> | undefined, alias = 'e') {
  if (!hasEntityFilter(filter)) return null;
  const e = sql.raw(alias);
  const parts: SQL[] = [];
  if (filter.favorites) parts.push(sql`${e}.is_favorite`);
  if (filter.tagIds.length > 0) {
    const active = await activeTagIds(ctx, filter.tagIds);
    if (active.length === 0) return sql`false`;
    const arr = uuidArray(active);
    parts.push(
      filter.tagMode === 'all'
        ? sql`(SELECT count(*) FROM entity_tag_links l WHERE l.entity_id = ${e}.id AND l.tag_id = ANY (${arr})) = ${active.length}`
        : sql`EXISTS (SELECT 1 FROM entity_tag_links l WHERE l.entity_id = ${e}.id AND l.tag_id = ANY (${arr}))`,
    );
  }
  return sql.join(parts, sql` AND `);
}

/**
 * Resolve o filtro numa lista de entidades (arquivadas inclusive: o histórico
 * delas conta nos relatórios); null = sem filtro.
 */
export async function resolveEntityFilter(ctx: ServiceContext, filter: Partial<EntityFilter> | undefined): Promise<string[] | null> {
  const condition = await entityFilterCondition(ctx, filter);
  if (!condition) return null;
  const result = await ctx.db.execute<{ id: string }>(sql`SELECT e.id FROM entities e WHERE ${condition}`);
  return result.rows.map((r) => r.id);
}

/** As tags de uma entidade (para prévias). */
export async function entityTagNames(ctx: ServiceContext, entityId: string) {
  const result = await ctx.db
    .select({ id: entityTags.id, name: entityTags.name })
    .from(entityTagLinks)
    .innerJoin(entityTags, eq(entityTags.id, entityTagLinks.tagId))
    .where(and(eq(entityTagLinks.entityId, entityId)));
  return result;
}
