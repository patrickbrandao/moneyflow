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
  type contactInput,
  type DeleteResult,
  type EntityDetail,
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
import type { ServiceContext } from '../context';
import { AppError, notFound } from '../errors';
import { camel, deleteOrArchive } from './util';

/* Entidades (spec 003): cadastro global, visível a todos; escrita para admin ou editores. */

const summarySelect = sql`
  e.id, e.kind, e.name, e.trade_name, e.document, e.archived_at,
  (SELECT json_build_object('keyType', p.key_type, 'keyValue', p.key_value)
     FROM entity_pix_keys p WHERE p.entity_id = e.id AND p.is_primary) AS primary_pix,
  (SELECT count(*)::int FROM caixas c WHERE c.holder_entity_id = e.id AND c.archived_at IS NULL) AS caixa_count`;

type SummaryRow = Omit<EntitySummary, 'archivedAt'> & { archivedAt: Date | string | null };

const toSummary = (row: Record<string, unknown>): EntitySummary => {
  const r = camel<SummaryRow>(row);
  return { ...r, archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null };
};

export async function listEntities(ctx: ServiceContext, query: z.output<typeof entityListQuery>): Promise<EntitySummary[]> {
  const q = query.q?.trim();
  const doc = q ? normalizeDocument(q) : '';
  const conditions = [query.archived ? sql`e.archived_at IS NOT NULL` : sql`e.archived_at IS NULL`];
  if (query.kind) conditions.push(sql`e.kind = ${query.kind}`);
  if (q) {
    conditions.push(sql`(
      e.name % ${q} OR e.trade_name % ${q}
      OR e.name ILIKE ${`%${q}%`} OR e.trade_name ILIKE ${`%${q}%`}
      ${doc.length >= 3 ? sql`OR e.document LIKE ${`${doc}%`}` : sql``}
    )`);
  }
  const order = q ? sql`greatest(similarity(e.name, ${q}), similarity(coalesce(e.trade_name, ''), ${q})) DESC, e.name` : sql`e.name`;
  const result = await ctx.db.execute(sql`
    SELECT ${summarySelect} FROM entities e
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY ${order} LIMIT ${query.limit}`);
  return result.rows.map(toSummary);
}

export async function getEntity(ctx: ServiceContext, id: string): Promise<EntityDetail> {
  const result = await ctx.db.execute(
    sql`SELECT ${summarySelect}, e.birth_date, e.notes, e.created_at, e.updated_at FROM entities e WHERE e.id = ${id}`,
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
  const [row] = await ctx.db
    .insert(entities)
    .values({
      kind: input.kind,
      name: input.name,
      tradeName: input.kind === 'company' ? input.tradeName : null,
      document: input.document,
      birthDate: input.kind === 'person' ? input.birthDate : null,
      notes: input.notes,
    })
    .returning({ id: entities.id });
  return getEntity(ctx, row!.id);
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
  if (Object.keys(patch).length > 0) await ctx.db.update(entities).set(patch).where(eq(entities.id, id));
  return getEntity(ctx, id);
}

export async function deleteEntity(ctx: ServiceContext, id: string): Promise<DeleteResult> {
  ctx.access.assertRegistryWrite();
  await entityKind(ctx.db, id);
  return deleteOrArchive(
    async () => (await ctx.db.delete(entities).where(eq(entities.id, id))).rowCount ?? 0,
    () => ctx.db.update(entities).set({ archivedAt: sql`now()` }).where(eq(entities.id, id)),
  );
}

export async function restoreEntity(ctx: ServiceContext, id: string): Promise<EntityDetail> {
  ctx.access.assertRegistryWrite();
  await ctx.db.update(entities).set({ archivedAt: null }).where(eq(entities.id, id));
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
  await ctx.db.transaction(async (tx) => {
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
  await ctx.db.transaction(async (tx) => {
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
  await ctx.db.delete(entityContacts).where(and(eq(entityContacts.id, contactId), eq(entityContacts.entityId, entityId)));
  return getEntity(ctx, entityId);
}

export async function addAddress(ctx: ServiceContext, entityId: string, input: z.output<typeof addressInput>) {
  await guardChild(ctx, entityId);
  await ctx.db.insert(entityAddresses).values({ entityId, ...input });
  return getEntity(ctx, entityId);
}

export async function updateAddress(ctx: ServiceContext, entityId: string, addressId: string, input: z.output<typeof addressInput>) {
  await guardChild(ctx, entityId);
  const result = await ctx.db
    .update(entityAddresses)
    .set(input)
    .where(and(eq(entityAddresses.id, addressId), eq(entityAddresses.entityId, entityId)));
  if (!result.rowCount) throw notFound();
  return getEntity(ctx, entityId);
}

export async function deleteAddress(ctx: ServiceContext, entityId: string, addressId: string) {
  await guardChild(ctx, entityId);
  await ctx.db.delete(entityAddresses).where(and(eq(entityAddresses.id, addressId), eq(entityAddresses.entityId, entityId)));
  return getEntity(ctx, entityId);
}

export async function addBankAccount(ctx: ServiceContext, entityId: string, input: z.output<typeof bankAccountInput>) {
  await guardChild(ctx, entityId);
  await ctx.db.insert(entityBankAccounts).values({ entityId, ...input });
  return getEntity(ctx, entityId);
}

export async function updateBankAccount(
  ctx: ServiceContext,
  entityId: string,
  accountId: string,
  input: z.output<typeof bankAccountInput>,
) {
  await guardChild(ctx, entityId);
  const result = await ctx.db
    .update(entityBankAccounts)
    .set(input)
    .where(and(eq(entityBankAccounts.id, accountId), eq(entityBankAccounts.entityId, entityId)));
  if (!result.rowCount) throw notFound();
  return getEntity(ctx, entityId);
}

export async function deleteBankAccount(ctx: ServiceContext, entityId: string, accountId: string) {
  await guardChild(ctx, entityId);
  await ctx.db.delete(entityBankAccounts).where(and(eq(entityBankAccounts.id, accountId), eq(entityBankAccounts.entityId, entityId)));
  return getEntity(ctx, entityId);
}

export async function addPixKey(ctx: ServiceContext, entityId: string, input: z.output<typeof pixKeyInput>) {
  await guardChild(ctx, entityId);
  await ctx.db.transaction(async (tx) => {
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
  await ctx.db.transaction(async (tx) => {
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
  await ctx.db.delete(entityPixKeys).where(and(eq(entityPixKeys.id, keyId), eq(entityPixKeys.entityId, entityId)));
  return getEntity(ctx, entityId);
}

export async function addLink(ctx: ServiceContext, entityId: string, input: z.output<typeof linkInput>) {
  await guardChild(ctx, entityId);
  await entityKind(ctx.db, input.relatedEntityId);
  await ctx.db.insert(entityLinks).values({ entityId, ...input });
  return getEntity(ctx, entityId);
}

export async function deleteLink(ctx: ServiceContext, entityId: string, linkId: string) {
  await guardChild(ctx, entityId);
  await ctx.db
    .delete(entityLinks)
    .where(and(eq(entityLinks.id, linkId), or(eq(entityLinks.entityId, entityId), eq(entityLinks.relatedEntityId, entityId))));
  return getEntity(ctx, entityId);
}
