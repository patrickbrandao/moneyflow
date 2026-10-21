import {
  caixas,
  type Executor,
  entities,
  entityAddresses,
  entityBankAccounts,
  entityContacts,
  entityLinks,
  entityPixKeys,
} from '@moneyflow/db';
import {
  type addressInput,
  type bankAccountInput,
  type CnpjLookup,
  type contactInput,
  type DeleteResult,
  type EntityDetail,
  type EntityFilter,
  type EntityKind,
  type EntityLink,
  type EntitySummary,
  type entityCreateInput,
  type entityListQuery,
  type entityUpdateInput,
  isValidDocument,
  type linkInput,
  normalizeDocument,
  type pixKeyInput,
  t,
} from '@moneyflow/shared';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Access } from '../authz/access';
import type { ServiceContext } from '../context';
import { AppError, notFound } from '../errors';
import { lookupCnpj } from '../integrations/lookup';
import { entityFilterCondition, replaceEntityTags } from './entity-tags';
import { badgeFromCounts, noteCountsSql } from './notes';
import { deleteOrArchive, withTx } from './tx';
import { camel } from './util';

/* Entidades (spec 003): cadastro global, visível a todos; escrita para admin ou editores. */

const summarySelect = (access: Access) => sql`
  e.id, e.kind, e.name, e.trade_name, e.document, e.archived_at,
  (SELECT json_build_object('keyType', p.key_type, 'keyValue', p.key_value)
     FROM entity_pix_keys p WHERE p.entity_id = e.id AND p.is_primary) AS primary_pix,
  (SELECT count(*)::int FROM caixas c WHERE c.holder_entity_id = e.id AND c.archived_at IS NULL) AS caixa_count,
  e.is_favorite,
  coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name::text, 'colorSlot', t.color_slot, 'archived', t.archived_at IS NOT NULL)
                            ORDER BY t.archived_at IS NOT NULL, lower(t.name::text))
              FROM entity_tag_links l JOIN entity_tags t ON t.id = l.tag_id WHERE l.entity_id = e.id), '[]'::json) AS tags,
  ${noteCountsSql(access)} AS note_counts`;

type SummaryRow = Omit<EntitySummary, 'archivedAt' | 'noteBadge'> & { archivedAt: Date | string | null; noteCounts: unknown };

const toSummary = (row: Record<string, unknown>): EntitySummary => {
  const { noteCounts, ...r } = camel<SummaryRow>(row);
  return { ...r, archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null, noteBadge: badgeFromCounts(noteCounts) };
};

export async function listEntities(
  ctx: ServiceContext,
  query: Omit<z.output<typeof entityListQuery>, keyof EntityFilter> & Partial<EntityFilter>,
): Promise<EntitySummary[]> {
  const q = query.q?.trim();
  const doc = q ? normalizeDocument(q) : '';
  const conditions = [query.archived ? sql`e.archived_at IS NOT NULL` : sql`e.archived_at IS NULL`];
  if (query.kind) conditions.push(sql`e.kind = ${query.kind}`);
  const filter = await entityFilterCondition(ctx, query);
  if (filter) conditions.push(filter);
  if (q) {
    conditions.push(sql`(
      e.name % ${q} OR e.trade_name % ${q}
      OR e.name ILIKE ${`%${q}%`} OR e.trade_name ILIKE ${`%${q}%`}
      ${doc.length >= 3 ? sql`OR e.document LIKE ${`${doc}%`}` : sql``}
    )`);
  }
  // Com busca, as favoritas vêm primeiro e depois a semelhança (spec 003).
  const order = q
    ? sql`e.is_favorite DESC, greatest(similarity(e.name, ${q}), similarity(coalesce(e.trade_name, ''), ${q})) DESC, e.name`
    : sql`e.name`;
  const result = await ctx.db.execute(sql`
    SELECT ${summarySelect(ctx.access)} FROM entities e
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY ${order} LIMIT ${query.limit}`);
  return result.rows.map(toSummary);
}

export async function getEntity(ctx: ServiceContext, id: string): Promise<EntityDetail> {
  const result = await ctx.db.execute(
    sql`SELECT ${summarySelect(ctx.access)}, e.birth_date, e.notes, e.created_at, e.updated_at FROM entities e WHERE e.id = ${id}`,
  );
  const base = result.rows[0];
  if (!base) throw notFound();
  const summary = toSummary(base);
  const [contacts, addresses, bankAccounts, pixKeys, linksOut, linksIn, held] = await Promise.all([
    ctx.db
      .select()
      .from(entityContacts)
      .where(eq(entityContacts.entityId, id))
      .orderBy(asc(entityContacts.kind), desc(entityContacts.isPrimary)),
    ctx.db.select().from(entityAddresses).where(eq(entityAddresses.entityId, id)).orderBy(asc(entityAddresses.createdAt)),
    ctx.db.select().from(entityBankAccounts).where(eq(entityBankAccounts.entityId, id)).orderBy(asc(entityBankAccounts.createdAt)),
    ctx.db
      .select()
      .from(entityPixKeys)
      .where(eq(entityPixKeys.entityId, id))
      .orderBy(desc(entityPixKeys.isPrimary), asc(entityPixKeys.createdAt)),
    ctx.db
      .select({ link: entityLinks, other: entities.name })
      .from(entityLinks)
      .innerJoin(entities, eq(entities.id, entityLinks.relatedEntityId))
      .where(eq(entityLinks.entityId, id)),
    ctx.db
      .select({ link: entityLinks, other: entities.name })
      .from(entityLinks)
      .innerJoin(entities, eq(entities.id, entityLinks.entityId))
      .where(eq(entityLinks.relatedEntityId, id)),
    ctx.db.select().from(caixas).where(eq(caixas.holderEntityId, id)).orderBy(desc(caixas.isPrimary), asc(caixas.name)),
  ]);
  const links: EntityLink[] = [
    ...linksOut.map(({ link, other }) => ({
      id: link.id,
      direction: 'out' as const,
      kind: link.kind as EntityLink['kind'],
      otherEntityId: link.relatedEntityId,
      otherEntityName: other,
      notes: link.notes,
    })),
    ...linksIn.map(({ link, other }) => ({
      id: link.id,
      direction: 'in' as const,
      kind: link.kind as EntityLink['kind'],
      otherEntityId: link.entityId,
      otherEntityName: other,
      notes: link.notes,
    })),
  ];
  const r = camel<{ birthDate: string | null; notes: string | null; createdAt: Date; updatedAt: Date }>(base);
  return {
    ...summary,
    birthDate: r.birthDate,
    notes: r.notes,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    contacts: contacts.map((c) => ({ id: c.id, kind: c.kind as 'phone', value: c.value, label: c.label, isPrimary: c.isPrimary })),
    addresses: addresses.map(({ entityId: _e, createdAt: _c, updatedAt: _u, ...a }) => a),
    bankAccounts: bankAccounts.map(({ entityId: _e, createdAt: _c, updatedAt: _u, ...b }) => ({
      ...b,
      accountType: b.accountType as 'checking',
    })),
    pixKeys: pixKeys.map(({ entityId: _e, createdAt: _c, updatedAt: _u, ...p }) => ({ ...p, keyType: p.keyType as 'cpf' })),
    links,
    caixas: held.map((c) => ({
      id: c.id,
      name: c.name,
      isPrimary: c.isPrimary,
      archivedAt: c.archivedAt,
      visible: ctx.access.canRead(c.id),
    })),
  };
}

export async function createEntity(ctx: ServiceContext, input: z.output<typeof entityCreateInput>): Promise<EntityDetail> {
  ctx.access.assertRegistryWrite();
  const id = await withTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(entities)
      .values({
        kind: input.kind,
        name: input.name,
        tradeName: input.kind === 'company' ? input.tradeName : null,
        document: input.document,
        birthDate: input.kind === 'person' ? input.birthDate : null,
        notes: input.notes,
        isFavorite: input.isFavorite ?? false,
      })
      .returning({ id: entities.id });
    if (input.tagIds?.length) await replaceEntityTags(tx, row!.id, input.tagIds);
    return row!.id;
  });
  return getEntity(ctx, id);
}

/* ---- consulta de CNPJ e cadastro a partir dela (tools dos agentes) ---- */

/** Entidade já cadastrada com o documento (arquivada inclusive; o documento é único). */
export async function findByDocument(ctx: ServiceContext, document: string) {
  const [row] = await ctx.db
    .select({ id: entities.id, name: entities.name, archivedAt: entities.archivedAt })
    .from(entities)
    .where(eq(entities.document, normalizeDocument(document)));
  return row ? { id: row.id, name: row.name, archived: row.archivedAt !== null } : null;
}

/** A ficha do CNPJ (spec 003) com a entidade que já o usa, se houver. */
export async function lookupCnpjWithEntity(ctx: ServiceContext, cnpj: string) {
  const data = await lookupCnpj(cnpj, ctx.config);
  return { ...data, existingEntity: await findByDocument(ctx, data.document) };
}

/**
 * Cadastra a empresa com a ficha do CNPJ: razão social, fantasia, e-mail e
 * telefone (contatos principais) e o endereço, tudo numa transação.
 */
export async function createEntityFromCnpj(
  ctx: ServiceContext,
  input: { cnpj: string; notes?: string | null; tagIds: string[]; isFavorite: boolean },
  data?: CnpjLookup,
): Promise<EntityDetail> {
  ctx.access.assertRegistryWrite();
  const ficha = data ?? (await lookupCnpj(input.cnpj, ctx.config));
  if (!ficha.name) throw new AppError(404, 'lookup_not_found', t.errors.lookupNotFound);
  if (await findByDocument(ctx, ficha.document)) throw new AppError(409, 'conflict', t.errors.entityDocumentExists);
  const id = await withTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(entities)
      .values({
        kind: 'company',
        name: ficha.name.slice(0, 200),
        tradeName: ficha.tradeName?.slice(0, 200) ?? null,
        document: ficha.document,
        notes: input.notes?.trim() || null,
        isFavorite: input.isFavorite,
      })
      .returning({ id: entities.id });
    const entityId = row!.id;
    const contacts = [
      ficha.email ? { kind: 'email' as const, value: ficha.email.slice(0, 200) } : null,
      ficha.phone ? { kind: 'phone' as const, value: ficha.phone.slice(0, 200) } : null,
    ].filter((c) => c !== null);
    if (contacts.length > 0) await tx.insert(entityContacts).values(contacts.map((c) => ({ entityId, ...c, isPrimary: true })));
    if (ficha.address) await tx.insert(entityAddresses).values({ entityId, ...ficha.address });
    if (input.tagIds.length > 0) await replaceEntityTags(tx, entityId, [...new Set(input.tagIds.map((v) => v.toLowerCase()))]);
    return entityId;
  });
  return getEntity(ctx, id);
}

async function entityKind(db: Executor, id: string): Promise<EntityKind> {
  const [row] = await db.select({ kind: entities.kind }).from(entities).where(eq(entities.id, id));
  if (!row) throw notFound();
  return row.kind as EntityKind;
}

export async function updateEntity(ctx: ServiceContext, id: string, input: z.output<typeof entityUpdateInput>): Promise<EntityDetail> {
  ctx.access.assertRegistryWrite();
  const kind = await entityKind(ctx.db, id);
  if (input.document && !isValidDocument(kind, input.document)) {
    throw new AppError(400, 'validation', kind === 'person' ? t.errors.invalidCpf : t.errors.invalidCnpj);
  }
  const patch: Partial<typeof entities.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.tradeName !== undefined) patch.tradeName = kind === 'company' ? input.tradeName : null;
  if (input.document !== undefined) patch.document = input.document;
  if (input.birthDate !== undefined) patch.birthDate = kind === 'person' ? input.birthDate : null;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.isFavorite !== undefined) patch.isFavorite = input.isFavorite;
  if (Object.keys(patch).length > 0 || input.tagIds !== undefined) {
    await withTx(ctx, async (tx) => {
      if (Object.keys(patch).length > 0) await tx.update(entities).set(patch).where(eq(entities.id, id));
      if (input.tagIds !== undefined) await replaceEntityTags(tx, id, input.tagIds);
    });
  }
  return getEntity(ctx, id);
}

/** Substitui as tags da entidade (quem edita o cadastro; só tags ativas entram). */
export async function setEntityTags(ctx: ServiceContext, id: string, tagIds: string[]): Promise<EntityDetail> {
  return updateEntity(ctx, id, { tagIds: [...new Set(tagIds.map((v) => v.toLowerCase()))] });
}

/** Marca ou desmarca a favorita (global). */
export async function setEntityFavorite(ctx: ServiceContext, id: string, favorite: boolean): Promise<EntityDetail> {
  return updateEntity(ctx, id, { isFavorite: favorite });
}

export async function deleteEntity(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  ctx.access.assertRegistryWrite();
  await entityKind(ctx.db, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.delete(entities).where(eq(entities.id, id))).rowCount ?? 0,
      (t) => t.update(entities).set({ archivedAt: sql`now()` }).where(eq(entities.id, id)),
    ),
  );
}

export async function restoreEntity(ctx: ServiceContext, id: string): Promise<EntityDetail> {
  ctx.access.assertRegistryWrite();
  await withTx(ctx, (tx) => tx.update(entities).set({ archivedAt: null }).where(eq(entities.id, id)));
  return getEntity(ctx, id);
}

/* ---- filhos: contatos, endereços, dados bancários, PIX, vínculos ---- */

async function guardChild(ctx: ServiceContext, entityId: string) {
  ctx.access.assertRegistryWrite();
  await entityKind(ctx.db, entityId);
}

export async function addContact(ctx: ServiceContext, entityId: string, input: z.output<typeof contactInput>) {
  await guardChild(ctx, entityId);
  const value = input.kind === 'email' ? input.value.toLowerCase() : input.value;
  await withTx(ctx, async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(entityContacts)
        .set({ isPrimary: false })
        .where(and(eq(entityContacts.entityId, entityId), eq(entityContacts.kind, input.kind)));
    }
    await tx.insert(entityContacts).values({ entityId, ...input, value });
  });
  return getEntity(ctx, entityId);
}

export async function updateContact(ctx: ServiceContext, entityId: string, contactId: string, input: z.output<typeof contactInput>) {
  await guardChild(ctx, entityId);
  const value = input.kind === 'email' ? input.value.toLowerCase() : input.value;
  await withTx(ctx, async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(entityContacts)
        .set({ isPrimary: false })
        .where(and(eq(entityContacts.entityId, entityId), eq(entityContacts.kind, input.kind)));
    }
    const result = await tx
      .update(entityContacts)
      .set({ ...input, value })
      .where(and(eq(entityContacts.id, contactId), eq(entityContacts.entityId, entityId)));
    if (!result.rowCount) throw notFound();
  });
  return getEntity(ctx, entityId);
}

export async function deleteContact(ctx: ServiceContext, entityId: string, contactId: string) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) => tx.delete(entityContacts).where(and(eq(entityContacts.id, contactId), eq(entityContacts.entityId, entityId))));
  return getEntity(ctx, entityId);
}

export async function addAddress(ctx: ServiceContext, entityId: string, input: z.output<typeof addressInput>) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) => tx.insert(entityAddresses).values({ entityId, ...input }));
  return getEntity(ctx, entityId);
}

export async function updateAddress(ctx: ServiceContext, entityId: string, addressId: string, input: z.output<typeof addressInput>) {
  await guardChild(ctx, entityId);
  const result = await withTx(ctx, (tx) =>
    tx
      .update(entityAddresses)
      .set(input)
      .where(and(eq(entityAddresses.id, addressId), eq(entityAddresses.entityId, entityId))),
  );
  if (!result.rowCount) throw notFound();
  return getEntity(ctx, entityId);
}

export async function deleteAddress(ctx: ServiceContext, entityId: string, addressId: string) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) =>
    tx.delete(entityAddresses).where(and(eq(entityAddresses.id, addressId), eq(entityAddresses.entityId, entityId))),
  );
  return getEntity(ctx, entityId);
}

export async function addBankAccount(ctx: ServiceContext, entityId: string, input: z.output<typeof bankAccountInput>) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) => tx.insert(entityBankAccounts).values({ entityId, ...input }));
  return getEntity(ctx, entityId);
}

export async function updateBankAccount(
  ctx: ServiceContext,
  entityId: string,
  accountId: string,
  input: z.output<typeof bankAccountInput>,
) {
  await guardChild(ctx, entityId);
  const result = await withTx(ctx, (tx) =>
    tx
      .update(entityBankAccounts)
      .set(input)
      .where(and(eq(entityBankAccounts.id, accountId), eq(entityBankAccounts.entityId, entityId))),
  );
  if (!result.rowCount) throw notFound();
  return getEntity(ctx, entityId);
}

export async function deleteBankAccount(ctx: ServiceContext, entityId: string, accountId: string) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) =>
    tx.delete(entityBankAccounts).where(and(eq(entityBankAccounts.id, accountId), eq(entityBankAccounts.entityId, entityId))),
  );
  return getEntity(ctx, entityId);
}

export async function addPixKey(ctx: ServiceContext, entityId: string, input: z.output<typeof pixKeyInput>) {
  await guardChild(ctx, entityId);
  await withTx(ctx, async (tx) => {
    const [existing] = await tx.select({ n: sql<number>`count(*)::int` }).from(entityPixKeys).where(eq(entityPixKeys.entityId, entityId));
    // A primeira chave já nasce principal.
    const isPrimary = input.isPrimary || (existing?.n ?? 0) === 0;
    if (isPrimary) await tx.update(entityPixKeys).set({ isPrimary: false }).where(eq(entityPixKeys.entityId, entityId));
    await tx.insert(entityPixKeys).values({ entityId, ...input, isPrimary });
  });
  return getEntity(ctx, entityId);
}

export async function updatePixKey(ctx: ServiceContext, entityId: string, keyId: string, input: z.output<typeof pixKeyInput>) {
  await guardChild(ctx, entityId);
  await withTx(ctx, async (tx) => {
    if (input.isPrimary) await tx.update(entityPixKeys).set({ isPrimary: false }).where(eq(entityPixKeys.entityId, entityId));
    const result = await tx
      .update(entityPixKeys)
      .set(input)
      .where(and(eq(entityPixKeys.id, keyId), eq(entityPixKeys.entityId, entityId)));
    if (!result.rowCount) throw notFound();
  });
  return getEntity(ctx, entityId);
}

export async function deletePixKey(ctx: ServiceContext, entityId: string, keyId: string) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) => tx.delete(entityPixKeys).where(and(eq(entityPixKeys.id, keyId), eq(entityPixKeys.entityId, entityId))));
  return getEntity(ctx, entityId);
}

export async function addLink(ctx: ServiceContext, entityId: string, input: z.output<typeof linkInput>) {
  await guardChild(ctx, entityId);
  await entityKind(ctx.db, input.relatedEntityId);
  await withTx(ctx, (tx) => tx.insert(entityLinks).values({ entityId, ...input }));
  return getEntity(ctx, entityId);
}

export async function deleteLink(ctx: ServiceContext, entityId: string, linkId: string) {
  await guardChild(ctx, entityId);
  await withTx(ctx, (tx) =>
    tx
      .delete(entityLinks)
      .where(and(eq(entityLinks.id, linkId), or(eq(entityLinks.entityId, entityId), eq(entityLinks.relatedEntityId, entityId)))),
  );
  return getEntity(ctx, entityId);
}
