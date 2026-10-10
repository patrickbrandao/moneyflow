import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

describe('permissões por caixa', () => {
  it('admin vê tudo; usuário só as caixas de que é membro; viewer só lê; editor escreve', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const viewerUser = await userSession(h);
    const editorUser = await userSession(h);
    const outsider = client(h, (await userSession(h)).cookie);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editorUser.id, role: 'editor' });
    const viewer = client(h, viewerUser.cookie);
    const editor = client(h, editorUser.cookie);

    // Sem papel a caixa "não existe".
    await outsider.get(`/api/caixas/${s.caixaA.id}`, 404);
    expect((await outsider.get('/api/caixas')).map((c: { id: string }) => c.id)).not.toContain(s.caixaA.id);

    // Viewer lê, mas não escreve.
    const caixa = await viewer.get(`/api/caixas/${s.caixaA.id}`);
    expect(caixa.myRole).toBe('viewer');
    expect(caixa.canWrite).toBe(false);
    const title = {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Energia',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-20',
      amountCents: 15_000,
    };
    const denied = await viewer.post('/api/titles', title, 403);
    expect(denied.error.message).toMatch(/leitura/);
    await viewer.post('/api/entities', { kind: 'person', name: 'Nova' }, 403);
    await viewer.get(`/api/caixas/${s.caixaB.id}`, 404);

    // Editor escreve na caixa A, mas não na B.
    const created = await editor.post('/api/titles', title);
    expect(created.canWrite).toBe(true);
    await editor.post('/api/titles', { ...title, caixaId: s.caixaB.id }, 404);
    await editor.post(`/api/caixas/${s.caixaA.id}/accounts`, { kind: 'cash', name: 'Cofre', openingDate: '2026-01-01' });

    // Listas filtradas pela permissão.
    const viewerTitles = await viewer.get('/api/titles');
    expect(viewerTitles.every((t: { caixaId: string }) => t.caixaId === s.caixaA.id)).toBe(true);
    expect((await outsider.get('/api/titles')).length).toBe(0);
    const accounts = await viewer.get('/api/accounts');
    expect(accounts.every((a: { caixaId: string }) => a.caixaId === s.caixaA.id)).toBe(true);

    // Gestão de membros e usuários é do admin.
    await editor.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerUser.id, role: 'editor' }, 403);
  });

  it('traduz erros do banco para mensagens pt-BR', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    // Categoria de receita num título a pagar: titles_category_kind_check (23514).
    const res = await admin.post(
      '/api/titles',
      {
        caixaId: s.caixaA.id,
        direction: 'payable',
        entityId: s.supplier.id,
        categoryId: s.income.id,
        description: 'Errado',
        competenceDate: '2026-10-01',
        dueDate: '2026-10-20',
        amountCents: 100,
      },
      422,
    );
    expect(res.error.code).toBe('titles_category_kind_check');
    expect(res.error.message).toMatch(/categoria de despesa/);
    // Documento duplicado: 23505.
    await admin.post('/api/entities', { kind: 'person', name: 'X', document: '529.982.247-25' }).catch(() => undefined);
    const dup = await admin.post('/api/entities', { kind: 'person', name: 'Y', document: '52998224725' }, 409);
    expect(dup.error.message).toMatch(/documento/);
    // CPF inválido: validação antes do banco.
    const bad = await admin.post('/api/entities', { kind: 'person', name: 'Z', document: '123.456.789-00' }, 400);
    expect(bad.error.message).toMatch(/CPF inválido/);
  });

  it('exclui sem vínculos e arquiva com vínculos (spec 008)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const lonely = await admin.post('/api/entities', { kind: 'person', name: 'Sem vínculo' });
    expect(await admin.del(`/api/entities/${lonely.id}`)).toEqual({ deleted: true, archived: false });
    // Titular de caixa: arquiva.
    expect(await admin.del(`/api/entities/${s.holderA.id}`)).toEqual({ deleted: false, archived: true });
  });
});
