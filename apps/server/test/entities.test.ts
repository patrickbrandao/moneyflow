import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alphaCnpj, client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * Filhos da entidade pela API (spec 003, tarefa 126): contatos, endereços,
 * dados bancários, chaves PIX (a principal e o CNPJ alfanumérico na edição) e
 * vínculos — criar, editar e apagar; o filho de outra entidade não muda
 * (404 na edição, sem efeito na exclusão); quem só lê não escreve; arquivar e
 * restaurar a entidade.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

type Api = ReturnType<typeof client>;

async function people() {
  const admin = client(h, (await userSession(h, 'admin')).cookie);
  const s = await scenario(h, admin);
  const editorSession = await userSession(h);
  const viewerSession = await userSession(h);
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editorSession.id, role: 'editor' });
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerSession.id, role: 'viewer' });
  return { admin, s, editor: client(h, editorSession.cookie), viewer: client(h, viewerSession.cookie) };
}

const newEntity = (api: Api, name = `Entidade ${uid()}`) => api.post('/api/entities', { kind: 'company', name });

describe('contatos (spec 003)', () => {
  it('cria, edita (e-mail em minúsculas, um principal por tipo) e apaga; o de outra entidade não muda', async () => {
    const { editor } = await people();
    const entity = await newEntity(editor);
    const other = await newEntity(editor);

    let detail = await editor.post(`/api/entities/${entity.id}/contacts`, {
      kind: 'email',
      value: 'Financeiro@Exemplo.COM',
      isPrimary: true,
    });
    const first = detail.contacts[0];
    expect(first).toMatchObject({ kind: 'email', value: 'financeiro@exemplo.com', isPrimary: true });
    detail = await editor.post(`/api/entities/${entity.id}/contacts`, { kind: 'email', value: 'outro@exemplo.com' });
    const second = detail.contacts.find((c: any) => c.id !== first.id);
    expect(second.isPrimary).toBe(false);

    // Tornar o segundo principal tira a marca do primeiro (mesmo tipo).
    detail = await editor.put(`/api/entities/${entity.id}/contacts/${second.id}`, {
      kind: 'email',
      value: 'Cobranca@Exemplo.com',
      label: 'Cobrança',
      isPrimary: true,
    });
    expect(detail.contacts.find((c: any) => c.id === second.id)).toMatchObject({
      value: 'cobranca@exemplo.com',
      label: 'Cobrança',
      isPrimary: true,
    });
    expect(detail.contacts.find((c: any) => c.id === first.id).isPrimary).toBe(false);

    // Pelo caminho de outra entidade: a edição é 404 e nada muda (nem a marca de principal da outra).
    await editor.post(`/api/entities/${other.id}/contacts`, { kind: 'email', value: 'a@b.com', isPrimary: true });
    await editor.put(`/api/entities/${other.id}/contacts/${first.id}`, { kind: 'email', value: 'x@y.com', isPrimary: true }, 404);
    expect((await editor.get(`/api/entities/${other.id}`)).contacts[0]).toMatchObject({ value: 'a@b.com', isPrimary: true });
    await editor.del(`/api/entities/${other.id}/contacts/${first.id}`);
    expect((await editor.get(`/api/entities/${entity.id}`)).contacts.map((c: any) => c.id)).toContain(first.id);

    detail = await editor.del(`/api/entities/${entity.id}/contacts/${first.id}`);
    expect(detail.contacts.map((c: any) => c.id)).toEqual([second.id]);
    await editor.put(`/api/entities/${entity.id}/contacts/${first.id}`, { kind: 'phone', value: '1199999' }, 404);
  });
});

describe('endereços (spec 003)', () => {
  it('cria com o CEP normalizado, edita, recusa CEP inválido e apaga', async () => {
    const { editor } = await people();
    const entity = await newEntity(editor);
    const other = await newEntity(editor);

    let detail = await editor.post(`/api/entities/${entity.id}/addresses`, {
      label: 'Sede',
      postalCode: '01001-000',
      street: 'Praça da Sé',
      number: '1',
      city: 'São Paulo',
      state: 'SP',
    });
    const address = detail.addresses[0];
    expect(address).toMatchObject({ label: 'Sede', postalCode: '01001000', street: 'Praça da Sé', number: '1' });

    detail = await editor.put(`/api/entities/${entity.id}/addresses/${address.id}`, {
      label: 'Filial',
      postalCode: '20040002',
      street: 'Rua da Assembleia',
      number: '10',
      complement: 'sala 2',
      city: 'Rio de Janeiro',
      state: 'RJ',
    });
    expect(detail.addresses).toHaveLength(1);
    expect(detail.addresses[0]).toMatchObject({
      id: address.id,
      label: 'Filial',
      postalCode: '20040002',
      complement: 'sala 2',
      state: 'RJ',
    });

    const bad = await editor.raw('PUT', `/api/entities/${entity.id}/addresses/${address.id}`, {
      postalCode: '123',
      city: 'X',
      state: 'SP',
    });
    expect(bad.statusCode).toBe(400);
    await editor.put(`/api/entities/${other.id}/addresses/${address.id}`, { label: 'Invasão', city: 'Recife', state: 'PE' }, 404);
    await editor.del(`/api/entities/${other.id}/addresses/${address.id}`);
    expect((await editor.get(`/api/entities/${entity.id}`)).addresses[0].label).toBe('Filial');

    detail = await editor.del(`/api/entities/${entity.id}/addresses/${address.id}`);
    expect(detail.addresses).toEqual([]);

    // A consulta de CEP recusa o CEP malformado antes de sair para o ViaCEP.
    expect((await editor.get('/api/lookup/cep/123', 400)).error.code).toBe('validation');
  });
});

describe('dados bancários (spec 003)', () => {
  it('cria, edita (conta com dígito em maiúscula), exige banco ou ISPB e apaga', async () => {
    const { editor } = await people();
    const entity = await newEntity(editor);
    const other = await newEntity(editor);

    let detail = await editor.post(`/api/entities/${entity.id}/bank-accounts`, {
      bankCode: '077',
      branch: '0001',
      accountNumber: '12345-x',
      accountType: 'checking',
      holderName: 'Titular',
    });
    const account = detail.bankAccounts[0];
    expect(account).toMatchObject({ bankCode: '077', branch: '0001', accountNumber: '12345-X', accountType: 'checking' });

    detail = await editor.put(`/api/entities/${entity.id}/bank-accounts/${account.id}`, {
      ispb: '18236120',
      branch: '0002',
      accountNumber: '999',
      accountType: 'savings',
      label: 'Poupança',
    });
    expect(detail.bankAccounts[0]).toMatchObject({
      id: account.id,
      bankCode: null,
      ispb: '18236120',
      accountNumber: '999',
      accountType: 'savings',
      label: 'Poupança',
    });

    const noBank = await editor.raw('PUT', `/api/entities/${entity.id}/bank-accounts/${account.id}`, {
      accountNumber: '1',
      accountType: 'checking',
    });
    expect(noBank.statusCode).toBe(400);
    await editor.put(
      `/api/entities/${other.id}/bank-accounts/${account.id}`,
      { bankCode: '001', accountNumber: '1', accountType: 'checking' },
      404,
    );
    await editor.del(`/api/entities/${other.id}/bank-accounts/${account.id}`);
    expect((await editor.get(`/api/entities/${entity.id}`)).bankAccounts).toHaveLength(1);

    detail = await editor.del(`/api/entities/${entity.id}/bank-accounts/${account.id}`);
    expect(detail.bankAccounts).toEqual([]);
  });
});

describe('chaves PIX (spec 003)', () => {
  it('a primeira nasce principal; trocar a principal pelo PUT; CNPJ alfanumérico em minúsculas normalizado na edição; apagar', async () => {
    const { editor } = await people();
    const entity = await newEntity(editor);
    const email = `pix-${uid()}@exemplo.com`;

    let detail = await editor.post(`/api/entities/${entity.id}/pix-keys`, { keyType: 'email', keyValue: email.toUpperCase() });
    const first = detail.pixKeys[0];
    expect(first).toMatchObject({ keyType: 'email', keyValue: email, isPrimary: true });

    const evp = crypto.randomUUID();
    detail = await editor.post(`/api/entities/${entity.id}/pix-keys`, { keyType: 'evp', keyValue: evp.toUpperCase() });
    const second = detail.pixKeys.find((k: any) => k.id !== first.id);
    expect(second).toMatchObject({ keyValue: evp, isPrimary: false });

    // O PUT troca a chave por um CNPJ alfanumérico digitado em minúsculas e com pontuação, e a torna principal.
    const cnpj = alphaCnpj();
    const typed = `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`.toLowerCase();
    detail = await editor.put(`/api/entities/${entity.id}/pix-keys/${second.id}`, {
      keyType: 'cnpj',
      keyValue: typed,
      label: 'Empresa',
      isPrimary: true,
    });
    expect(detail.pixKeys[0]).toMatchObject({ id: second.id, keyType: 'cnpj', keyValue: cnpj, label: 'Empresa', isPrimary: true });
    expect(detail.pixKeys.find((k: any) => k.id === first.id).isPrimary).toBe(false);
    // A listagem mostra a principal nova.
    const listed = (await editor.get(`/api/entities?q=${encodeURIComponent(entity.name)}`)).find((e: any) => e.id === entity.id);
    expect(listed.primaryPix).toEqual({ keyType: 'cnpj', keyValue: cnpj });

    // Chave inválida no PUT: 400, e a chave fica como estava.
    const invalid = await editor.raw('PUT', `/api/entities/${entity.id}/pix-keys/${second.id}`, {
      keyType: 'cnpj',
      keyValue: `${cnpj.slice(0, 12)}00`.toLowerCase(),
    });
    expect(invalid.statusCode).toBe(400);
    expect((await editor.get(`/api/entities/${entity.id}`)).pixKeys[0].keyValue).toBe(cnpj);

    detail = await editor.del(`/api/entities/${entity.id}/pix-keys/${second.id}`);
    expect(detail.pixKeys.map((k: any) => k.id)).toEqual([first.id]);
  });

  it('pelo caminho de outra entidade o PUT é 404 e a principal dela não perde a marca (a transação desfaz)', async () => {
    const { editor } = await people();
    const entity = await newEntity(editor);
    const other = await newEntity(editor);
    const mine = (await editor.post(`/api/entities/${entity.id}/pix-keys`, { keyType: 'evp', keyValue: crypto.randomUUID() })).pixKeys[0];
    const theirs = (await editor.post(`/api/entities/${other.id}/pix-keys`, { keyType: 'evp', keyValue: crypto.randomUUID() })).pixKeys[0];
    expect(theirs.isPrimary).toBe(true);

    await editor.put(
      `/api/entities/${other.id}/pix-keys/${mine.id}`,
      { keyType: 'evp', keyValue: crypto.randomUUID(), isPrimary: true },
      404,
    );
    expect((await editor.get(`/api/entities/${other.id}`)).pixKeys[0]).toMatchObject({ id: theirs.id, isPrimary: true });
    expect((await editor.get(`/api/entities/${entity.id}`)).pixKeys[0]).toMatchObject({ id: mine.id, keyValue: mine.keyValue });

    await editor.del(`/api/entities/${other.id}/pix-keys/${mine.id}`);
    expect((await editor.get(`/api/entities/${entity.id}`)).pixKeys).toHaveLength(1);
  });
});

describe('vínculos (spec 003)', () => {
  it('liga duas entidades (visível dos dois lados), apaga por qualquer lado e recusa entidade inexistente', async () => {
    const { editor } = await people();
    const entity = await newEntity(editor);
    const partner = await newEntity(editor);
    const third = await newEntity(editor);

    const detail = await editor.post(`/api/entities/${entity.id}/links`, {
      relatedEntityId: partner.id,
      kind: 'partner_of',
      notes: 'Sócio',
    });
    const link = detail.links[0];
    expect(link).toMatchObject({ direction: 'out', kind: 'partner_of', otherEntityId: partner.id, notes: 'Sócio' });
    expect((await editor.get(`/api/entities/${partner.id}`)).links[0]).toMatchObject({
      id: link.id,
      direction: 'in',
      otherEntityId: entity.id,
    });

    // Uma terceira entidade não apaga o vínculo das outras.
    await editor.del(`/api/entities/${third.id}/links/${link.id}`);
    expect((await editor.get(`/api/entities/${entity.id}`)).links).toHaveLength(1);
    // Pelo lado de quem recebe o vínculo, apaga.
    expect((await editor.del(`/api/entities/${partner.id}/links/${link.id}`)).links).toEqual([]);
    expect((await editor.get(`/api/entities/${entity.id}`)).links).toEqual([]);

    await editor.post(`/api/entities/${entity.id}/links`, { relatedEntityId: crypto.randomUUID(), kind: 'other' }, 404);
  });
});

describe('permissões e arquivamento (spec 003)', () => {
  it('quem só lê vê a entidade, mas não escreve nos filhos nem restaura (403)', async () => {
    const { editor, viewer } = await people();
    const entity = await newEntity(editor);
    const detail = await editor.post(`/api/entities/${entity.id}/contacts`, { kind: 'phone', value: '11999990000' });
    const contact = detail.contacts[0];
    const pix = (await editor.post(`/api/entities/${entity.id}/pix-keys`, { keyType: 'evp', keyValue: crypto.randomUUID() })).pixKeys[0];
    expect((await viewer.get(`/api/entities/${entity.id}`)).contacts).toHaveLength(1);

    const attempts: [string, string, unknown?][] = [
      ['POST', `/api/entities/${entity.id}/contacts`, { kind: 'phone', value: '1' }],
      ['PUT', `/api/entities/${entity.id}/contacts/${contact.id}`, { kind: 'phone', value: '2' }],
      ['DELETE', `/api/entities/${entity.id}/contacts/${contact.id}`],
      ['POST', `/api/entities/${entity.id}/addresses`, { street: 'Rua', city: 'Recife', state: 'PE' }],
      ['POST', `/api/entities/${entity.id}/bank-accounts`, { bankCode: '001', accountNumber: '1', accountType: 'checking' }],
      ['PUT', `/api/entities/${entity.id}/pix-keys/${pix.id}`, { keyType: 'evp', keyValue: crypto.randomUUID(), isPrimary: true }],
      ['DELETE', `/api/entities/${entity.id}/pix-keys/${pix.id}`],
      ['POST', `/api/entities/${entity.id}/links`, { relatedEntityId: entity.id, kind: 'other' }],
      ['DELETE', `/api/entities/${entity.id}`],
      ['POST', `/api/entities/${entity.id}/restore`, {}],
    ];
    for (const [method, url, body] of attempts) {
      const res = await viewer.raw(method as 'POST', url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const after = await editor.get(`/api/entities/${entity.id}`);
    expect(after.contacts).toEqual([contact]);
    expect(after.pixKeys).toEqual([pix]);
    expect(after.archivedAt).toBeNull();
  });

  it('em uso, excluir arquiva; restaurar desarquiva (editor de cadastro); sem uso, exclui de vez', async () => {
    const { admin, editor, s } = await people();
    // O titular da caixa A está em uso: arquiva.
    expect(await editor.del(`/api/entities/${s.holderA.id}`)).toEqual({ deleted: false, archived: true });
    const archived = await editor.get(`/api/entities/${s.holderA.id}`);
    expect(archived.archivedAt).not.toBeNull();
    expect((await editor.get('/api/entities?archived=false&limit=500')).map((e: any) => e.id)).not.toContain(s.holderA.id);

    const restored = await editor.post(`/api/entities/${s.holderA.id}/restore`);
    expect(restored).toMatchObject({ id: s.holderA.id, archivedAt: null });
    await admin.post(`/api/entities/${crypto.randomUUID()}/restore`, {}, 404);

    const loose = await newEntity(editor);
    expect(await editor.del(`/api/entities/${loose.id}`)).toEqual({ deleted: true, archived: false });
    await editor.get(`/api/entities/${loose.id}`, 404);

    // Toda escrita dos filhos sai com o ator humano na auditoria.
    const audit = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE table_name IN ('entity_contacts', 'entity_addresses', 'entity_bank_accounts', 'entity_pix_keys', 'entity_links')
         AND actor_kind = 'system' AND created_at > now() - interval '10 minutes'`);
    expect(audit.rows[0]!.n).toBe(0);
  });
});
