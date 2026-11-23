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

  it('só quem edita a caixa principal do titular a troca; o admin troca qualquer uma (tarefa 072)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const editorUser = await userSession(h);
    await admin.put(`/api/users/${editorUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const editor = client(h, editorUser.cookie);
    const isPrimary = async (id: string) => (await admin.get(`/api/caixas/${id}`)).isPrimary;

    // Criando: a principal do titular B é a caixa B, que o editor não edita.
    const denied = await editor.post('/api/caixas', { name: `Toma B ${s.tag}`, holderEntityId: s.holderB.id, isPrimary: true }, 403);
    expect(denied.error.message).toMatch(/principal/);
    expect(await isPrimary(s.caixaB.id)).toBe(true);

    // Sem marcar a principal, cria; marcar depois pelo PATCH também é recusado.
    const plain = await editor.post('/api/caixas', { name: `Outra B ${s.tag}`, holderEntityId: s.holderB.id, isPrimary: false });
    expect(plain.isPrimary).toBe(false);
    await editor.patch(`/api/caixas/${plain.id}`, { isPrimary: true }, 403);
    // Caixa vazia de outro titular trocando para o titular B e marcando a principal.
    const empty = await editor.post('/api/caixas', { name: `Vazia ${s.tag}`, holderEntityId: s.supplier.id, isPrimary: false });
    await editor.patch(`/api/caixas/${empty.id}`, { holderEntityId: s.holderB.id, isPrimary: true }, 403);
    expect(await isPrimary(s.caixaB.id)).toBe(true);
    // Sem espelho capturado: o título contra o titular B continua espelhando na caixa B.
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'receivable',
      entityId: s.holderB.id,
      categoryId: s.income.id,
      description: 'Venda',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-20',
      amountCents: 10_000,
    });
    expect(title.counterpartyCaixaId).toBe(s.caixaB.id);

    // Quem edita a principal atual (caixa A) troca a do titular A.
    const newA = await editor.post('/api/caixas', { name: `Nova A ${s.tag}`, holderEntityId: s.holderA.id, isPrimary: true });
    expect(newA.isPrimary).toBe(true);
    expect(await isPrimary(s.caixaA.id)).toBe(false);

    // O admin troca a principal de qualquer titular.
    const adminB = await admin.post('/api/caixas', { name: `Admin B ${s.tag}`, holderEntityId: s.holderB.id, isPrimary: true });
    expect(adminB.isPrimary).toBe(true);
    expect(await isPrimary(s.caixaB.id)).toBe(false);
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
