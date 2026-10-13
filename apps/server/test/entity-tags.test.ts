import { todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '../src/agents/tool-handlers';
import { loadAccess } from '../src/authz/access';
import type { ServiceContext } from '../src/context';
import { client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * F6 (spec 003/014/011): tags e favoritas de entidade — catálogo do admin,
 * atribuição por quem edita o cadastro, arquivamento da tag em uso, filtros
 * da listagem, auditoria, filtro por entidade nos relatórios, nós do canvas
 * e as tools dos agentes.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

const year = todayIso().slice(0, 4);
const period = `from=${year}-01-01&to=${year}-12-31`;

async function people() {
  const adminSession = await userSession(h, 'admin');
  const admin = client(h, adminSession.cookie);
  const s = await scenario(h, admin);
  const editorSession = await userSession(h);
  const viewerSession = await userSession(h);
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editorSession.id, role: 'editor' });
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerSession.id, role: 'viewer' });
  return {
    s,
    admin,
    adminSession,
    editor: client(h, editorSession.cookie),
    editorSession,
    viewer: client(h, viewerSession.cookie),
  };
}

describe('tags de entidade (spec 003)', () => {
  it('só o admin gerencia o catálogo; nome único sem maiúsculas; em uso arquiva, sem uso apaga; restaurar', async () => {
    const { admin, editor, viewer, s } = await people();
    const name = `Cliente ${uid()}`;
    await editor.post('/api/entity-tags', { name, colorSlot: 3 }, 403);
    const tag = await admin.post('/api/entity-tags', { name, colorSlot: 3 });
    expect(tag).toMatchObject({ name, colorSlot: 3, archivedAt: null, usageCount: 0 });
    const dup = await admin.raw('POST', '/api/entity-tags', { name: name.toUpperCase(), colorSlot: 4 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toMatch(/Já existe uma tag com esse nome/);
    await admin.post('/api/entity-tags', { name: 'x', colorSlot: 13 }, 400);
    await editor.patch(`/api/entity-tags/${tag.id}`, { colorSlot: 5 }, 403);
    expect((await admin.patch(`/api/entity-tags/${tag.id}`, { colorSlot: 5 })).colorSlot).toBe(5);

    // Viewer lê o catálogo.
    expect((await viewer.get('/api/entity-tags')).some((t: any) => t.id === tag.id)).toBe(true);

    // Sem uso: apaga.
    const loose = await admin.post('/api/entity-tags', { name: `Solta ${uid()}`, colorSlot: 1 });
    expect(await admin.del(`/api/entity-tags/${loose.id}`)).toEqual({ deleted: true, archived: false });

    // Em uso: arquiva; continua na entidade (esmaecida), sai do catálogo padrão e não pode ser atribuída de novo.
    await editor.patch(`/api/entities/${s.supplier.id}`, { tagIds: [tag.id] });
    expect((await admin.get('/api/entity-tags')).find((t: any) => t.id === tag.id).usageCount).toBe(1);
    expect(await admin.del(`/api/entity-tags/${tag.id}`)).toEqual({ deleted: false, archived: true });
    expect((await admin.get('/api/entity-tags')).some((t: any) => t.id === tag.id)).toBe(false);
    expect((await admin.get('/api/entity-tags?archived=1')).find((t: any) => t.id === tag.id).archivedAt).not.toBeNull();
    const kept = await admin.get(`/api/entities/${s.supplier.id}`);
    expect(kept.tags).toEqual([{ id: tag.id, name, colorSlot: 5, archived: true }]);
    // Manter o conjunto com a arquivada funciona; atribuí-la a outra entidade, não.
    await editor.patch(`/api/entities/${s.supplier.id}`, { tagIds: [tag.id] });
    const refused = await editor.raw('PATCH', `/api/entities/${s.holderB.id}`, { tagIds: [tag.id] });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toMatch(/arquivada/);
    // Quem edita o cadastro remove a arquivada.
    expect((await editor.patch(`/api/entities/${s.supplier.id}`, { tagIds: [] })).tags).toEqual([]);

    await editor.post(`/api/entity-tags/${tag.id}/restore`, {}, 403);
    expect((await admin.post(`/api/entity-tags/${tag.id}/restore`)).archivedAt).toBeNull();
  });

  it('quem edita o cadastro atribui tags e marca favorita (auditado na entidade); viewer não', async () => {
    const { admin, editor, viewer, editorSession, s } = await people();
    const a = await admin.post('/api/entity-tags', { name: `A ${uid()}`, colorSlot: 2 });
    const b = await admin.post('/api/entity-tags', { name: `B ${uid()}`, colorSlot: 9 });

    const created = await editor.post('/api/entities', {
      kind: 'person',
      name: `Com tags ${s.tag}`,
      tagIds: [b.id, a.id],
      isFavorite: true,
    });
    expect(created.isFavorite).toBe(true);
    expect(created.tags.map((t: any) => t.id).sort()).toEqual([a.id, b.id].sort());

    await viewer.patch(`/api/entities/${created.id}`, { isFavorite: false }, 403);
    await viewer.patch(`/api/entities/${created.id}`, { tagIds: [] }, 403);
    const updated = await editor.patch(`/api/entities/${created.id}`, { tagIds: [a.id], isFavorite: false });
    expect(updated.tags.map((t: any) => t.id)).toEqual([a.id]);
    expect(updated.isFavorite).toBe(false);
    const missing = await editor.raw('PATCH', `/api/entities/${created.id}`, { tagIds: [crypto.randomUUID()] });
    expect(missing.statusCode).toBe(422);

    // Histórico da entidade: favorita e as ligações (record_id = entity_id), com o ator.
    const history = await editor.get(`/api/audit/record?table=entities&recordId=${created.id}`);
    const links = history.filter((e: any) => e.tableName === 'entity_tag_links');
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(links.every((e: any) => e.userId === editorSession.id && e.actorKind === 'human')).toBe(true);
    expect(links.some((e: any) => e.action === 'delete' && e.oldData?.tag_id === b.id)).toBe(true);
    expect(history.some((e: any) => e.tableName === 'entities' && e.changedColumns?.includes('is_favorite'))).toBe(true);
  });

  it('listagem: favoritas, filtro por tags (qualquer uma / todas) e favoritas primeiro na busca', async () => {
    const { admin, viewer } = await people();
    const tag = uid();
    const a = await admin.post('/api/entity-tags', { name: `Fa ${tag}`, colorSlot: 2 });
    const b = await admin.post('/api/entity-tags', { name: `Fb ${tag}`, colorSlot: 3 });
    const both = await admin.post('/api/entities', { kind: 'company', name: `Zeta ${tag}`, tagIds: [a.id, b.id] });
    const onlyA = await admin.post('/api/entities', { kind: 'company', name: `Alfa ${tag}`, tagIds: [a.id] });
    const fav = await admin.post('/api/entities', { kind: 'company', name: `Beta ${tag}`, isFavorite: true });

    const ids = (list: any[]) => list.map((e) => e.id);
    const any = await viewer.get(`/api/entities?tagIds=${a.id},${b.id}`);
    expect(ids(any).sort()).toEqual([both.id, onlyA.id].sort());
    expect(ids(await viewer.get(`/api/entities?tagIds=${a.id},${b.id}&tagMode=all`))).toEqual([both.id]);
    const favorites = await viewer.get(`/api/entities?favorites=1&q=${tag}`);
    expect(ids(favorites)).toEqual([fav.id]);
    expect(ids(await viewer.get(`/api/entities?favorites=1&tagIds=${a.id}`))).toEqual([]);
    // Com busca, as favoritas vêm primeiro.
    const search = await viewer.get(`/api/entities?q=${tag}`);
    expect(search[0].id).toBe(fav.id);
    expect(search.find((e: any) => e.id === both.id).tags).toHaveLength(2);
    // Tag arquivada sai do filtro.
    await admin.del(`/api/entity-tags/${b.id}`);
    expect(ids(await viewer.get(`/api/entities?tagIds=${b.id}`))).toEqual([]);
  });
});

describe('filtro por entidade nos relatórios e no canvas (spec 014)', () => {
  it('relatórios só com as entidades do filtro; sem casar nada, vazio; canvas traz tags e favorita nos nós', async () => {
    const { admin, viewer, s } = await people();
    const tag = await admin.post('/api/entity-tags', { name: `Forn ${s.tag}`, colorSlot: 6 });
    await admin.patch(`/api/entities/${s.supplier.id}`, { tagIds: [tag.id], isFavorite: true });
    for (const [entity, amount] of [
      [s.supplier.id, 12_000],
      [s.holderB.id, 30_000],
    ] as const) {
      await admin.post('/api/titles', {
        caixaId: s.caixaA.id,
        direction: 'payable',
        entityId: entity,
        categoryId: s.expense.id,
        description: 'Conta',
        competenceDate: `${year}-03-01`,
        dueDate: todayIso(),
        amountCents: amount,
        mirrorCaixaId: null,
      });
    }
    const base = `${period}&caixaIds=${s.caixaA.id}`;
    const all = await viewer.get(`/api/reports/categories?${base}`);
    expect(all.entityFilter).toBeNull();
    expect(all.lines.reduce((sum: number, l: any) => sum + l.amountCents, 0)).toBe(42_000);
    const byTag = await viewer.get(`/api/reports/categories?${base}&tagIds=${tag.id}`);
    expect(byTag.entityFilter.entityCount).toBe(1);
    expect(byTag.lines.reduce((sum: number, l: any) => sum + l.amountCents, 0)).toBe(12_000);

    const entities = await viewer.get(`/api/reports/entities?${base}&favorites=1`);
    expect([...new Set(entities.lines.map((l: any) => l.entityId))]).toEqual([s.supplier.id]);

    const projection = await viewer.get(`/api/reports/projection?caixaIds=${s.caixaA.id}&tagIds=${tag.id}`);
    const row = projection.lines.find((l: any) => l.financialAccountId === null && l.horizonDays === 30);
    expect(row.payableCents).toBe(12_000);
    expect(row.balanceTodayCents).toBe(100_000);

    // Tag + favoritas sem interseção: nada casa.
    const other = await admin.post('/api/entity-tags', { name: `Vazia ${s.tag}`, colorSlot: 7 });
    const none = await viewer.get(`/api/reports/categories?${base}&tagIds=${other.id}&favorites=1`);
    expect(none).toMatchObject({ entityFilter: { entityCount: 0 }, lines: [] });

    const graph = await viewer.get(`/api/flow?${period}&caixaIds=${s.caixaA.id}`);
    const node = graph.nodes.find((n: any) => n.kind === 'entity' && n.id === s.supplier.id);
    expect(node).toMatchObject({ tagIds: [tag.id], isFavorite: true });
    expect(graph.nodes.find((n: any) => n.kind === 'caixa')).toMatchObject({ tagIds: [], isFavorite: false });
  });
});

describe('tools dos agentes (spec 011)', () => {
  it('list_entity_tags, set_entity_tags e set_entity_favorite com prévia; list_entities e relatórios filtram', async () => {
    const { admin, adminSession, s } = await people();
    const tag = await admin.post('/api/entity-tags', { name: `Tool ${s.tag}`, colorSlot: 8 });
    const archived = await admin.post('/api/entity-tags', { name: `Velha ${s.tag}`, colorSlot: 1 });
    await admin.patch(`/api/entities/${s.holderA.id}`, { tagIds: [archived.id] });
    await admin.del(`/api/entity-tags/${archived.id}`);

    const actor = { id: adminSession.id, username: adminSession.username, email: '', role: 'admin' as const, isActive: true };
    const ctx: ServiceContext = { db: h.db, access: await loadAccess(h.db, actor), config: h.config, actorKind: 'agent', agentRunId: null };
    const meta = { toolUseId: 't', runId: null };

    const tags = (await TOOL_HANDLERS.list_entity_tags.run(ctx, {}, meta)) as any[];
    expect(tags.find((t) => t.id === tag.id)).toEqual({ id: tag.id, name: tag.name, colorSlot: 8, usageCount: 0 });
    expect(tags.some((t) => t.id === archived.id)).toBe(false);

    const preview = await TOOL_HANDLERS.set_entity_tags.preview!(ctx, { entityId: s.supplier.id, tagIds: [tag.id] });
    expect(preview.rows[0]).toEqual({ label: 'Tags', before: '—', after: tag.name });
    await expect(TOOL_HANDLERS.set_entity_tags.preview!(ctx, { entityId: s.supplier.id, tagIds: [archived.id] })).rejects.toThrow(
      /arquivada/,
    );
    await TOOL_HANDLERS.set_entity_tags.run(ctx, { entityId: s.supplier.id, tagIds: [tag.id] }, meta);
    const fav = await TOOL_HANDLERS.set_entity_favorite.preview!(ctx, { entityId: s.supplier.id, favorite: true });
    expect(fav.rows[0]).toEqual({ label: 'Favorita', before: 'Não', after: 'Sim' });
    await TOOL_HANDLERS.set_entity_favorite.run(ctx, { entityId: s.supplier.id, favorite: true }, meta);

    const listed = (await TOOL_HANDLERS.list_entities.run(
      ctx,
      { tagIds: [tag.id], tagMode: 'any', favoritesOnly: true, limit: 50 },
      meta,
    )) as any[];
    expect(listed.map((e) => e.id)).toEqual([s.supplier.id]);
    expect(listed[0]).toMatchObject({ isFavorite: true, tags: [{ id: tag.id, archived: false }] });

    const report = (await TOOL_HANDLERS.report_entities.run(
      ctx,
      { from: `${year}-01-01`, to: `${year}-12-31`, basis: 'competence', tagIds: [tag.id], tagMode: 'all', favoritesOnly: false },
      meta,
    )) as any;
    expect(report.entityFilter).toEqual({ entityCount: 1 });

    const audit = await h.db.execute<{ actor_kind: string }>(
      sql`SELECT actor_kind FROM audit_log WHERE table_name = 'entity_tag_links' AND record_id = ${s.supplier.id}`,
    );
    expect(audit.rows.map((r) => r.actor_kind)).toEqual(['agent']);
  });
});
