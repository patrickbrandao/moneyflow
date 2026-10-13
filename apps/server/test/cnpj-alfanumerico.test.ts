import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_CONSTRAINT_MESSAGES, formatCnpj } from '@moneyflow/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '../src/agents/tool-handlers';
import { loadAccess } from '../src/authz/access';
import type { ServiceContext } from '../src/context';
import { dedupHashes } from '../src/services/statements';
import { alphaCnpj, client, type Harness, startApp, uid, userSession } from './helpers';

/*
 * CNPJ alfanumérico em toda a aplicação (spec 003, tarefa 015): cadastro,
 * edição e duplicata com o documento em minúsculas e pontuado, busca da
 * listagem e dos agentes pelo documento e a NF-e com emitente, destinatário
 * e chave alfanuméricos (NT 2025.001). Lookup, backup, BR Code e extrato têm
 * os casos nos testes de cada área.
 */

let h: Harness;
let admin: ReturnType<typeof client>;
let ctx: ServiceContext;
const meta = { toolUseId: 't', runId: null };

beforeAll(async () => {
  h = await startApp();
  const session = await userSession(h, 'admin');
  admin = client(h, session.cookie);
  const actor = { id: session.id, username: session.username, email: '', role: 'admin' as const, isActive: true };
  ctx = { db: h.db, access: await loadAccess(h.db, actor), config: h.config, actorKind: 'agent', agentRunId: null };
});
afterAll(() => h.close());

/** Como o usuário digitaria: pontuado e em minúsculas. */
const typed = (cnpj: string) => formatCnpj(cnpj).toLowerCase();

describe('entidade com CNPJ alfanumérico', () => {
  it('cria e edita normalizando (maiúsculas, sem pontuação) e recusa a duplicata', async () => {
    const cnpj = alphaCnpj();
    const created = await admin.post('/api/entities', { kind: 'company', name: `Alfa ${uid()}`, document: typed(cnpj) });
    expect(created.document).toBe(cnpj);

    const other = alphaCnpj();
    const edited = await admin.patch(`/api/entities/${created.id}`, { document: ` ${typed(other)} ` });
    expect(edited.document).toBe(other);
    expect((await admin.get(`/api/entities/${created.id}`)).document).toBe(other);

    // Duplicata, em minúsculas e com pontuação, cai na unicidade do documento.
    const dup = await admin.raw('POST', '/api/entities', { kind: 'company', name: `Outra ${uid()}`, document: typed(other) });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toBe(DB_CONSTRAINT_MESSAGES.entities_document_key);
    // DV errado é recusado.
    const bad = `${other.slice(0, 13)}${(Number(other[13]) + 1) % 10}`;
    expect((await admin.raw('POST', '/api/entities', { kind: 'company', name: `Ruim ${uid()}`, document: bad })).statusCode).toBe(400);
  });

  it('a listagem acha pelo prefixo do documento digitado em minúsculas e pontuado', async () => {
    const cnpj = alphaCnpj();
    const entity = await admin.post('/api/entities', { kind: 'company', name: `Busca ${uid()}`, document: cnpj });
    const prefix = typed(cnpj).slice(0, 10); // ex.: "12.abc.345"
    const found = await admin.get(`/api/entities?q=${encodeURIComponent(prefix)}`);
    expect(found.map((e: any) => e.id)).toContain(entity.id);
  });
});

describe('agentes: busca pelo documento', () => {
  it('search_records e semantic_search (sem embeddings) acham pelo CNPJ alfanumérico e pelo numérico', async () => {
    const alpha = alphaCnpj();
    const numeric = '11444777000161';
    const name = `Doc ${uid()}`;
    const entity = await admin.post('/api/entities', { kind: 'company', name, document: alpha });
    const numericEntity =
      (await admin.get(`/api/entities?q=${numeric}`)).find((e: any) => e.document === numeric) ??
      (await admin.post('/api/entities', { kind: 'company', name: `Numérico ${uid()}`, document: numeric }));

    const records = (await TOOL_HANDLERS.search_records.run(ctx, { query: typed(alpha).slice(0, 10), limit: 10 }, meta)) as any[];
    expect(records.find((r) => r.kind === 'entity' && r.id === entity.id)).toBeTruthy();
    const byNumeric = (await TOOL_HANDLERS.search_records.run(ctx, { query: '11.444.777', limit: 10 }, meta)) as any[];
    expect(byNumeric.some((r) => r.kind === 'entity' && r.id === numericEntity.id)).toBe(true);

    const semantic = (await TOOL_HANDLERS.semantic_search.run(ctx, { query: formatCnpj(alpha), types: ['entity'], limit: 5 }, meta)) as any;
    expect(semantic.mode).toBe('trigram');
    // O acerto pelo documento vale 1 e vem antes dos trigramas.
    expect(semantic.hits[0]).toMatchObject({ type: 'entity', id: entity.id, score: 1 });
    const prefix = (await TOOL_HANDLERS.semantic_search.run(ctx, { query: typed(alpha).slice(0, 6), limit: 50 }, meta)) as any;
    expect(prefix.hits.some((hit: any) => hit.id === entity.id)).toBe(true);
    const numericHit = (await TOOL_HANDLERS.semantic_search.run(ctx, { query: numeric, types: ['entity'], limit: 5 }, meta)) as any;
    expect(numericHit.hits[0]).toMatchObject({ id: numericEntity.id, score: 1 });
  });
});

describe('NF-e com CNPJ alfanumérico (NT 2025.001)', () => {
  it('importa a nota com chave, emitente e destinatário alfanuméricos', async () => {
    const recipientDoc = 'A1B2C3D4000193';
    const recipient =
      (await admin.get(`/api/entities?q=${recipientDoc}`)).find((e: any) => e.document === recipientDoc) ??
      (await admin.post('/api/entities', { kind: 'company', name: 'Destinatário Alfa Exemplo S.A.', document: typed(recipientDoc) }));
    const session = await userSession(h, 'admin');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/title-entry/nfe?fileName=nfe-alfa.xml',
      payload: readFileSync(join(import.meta.dirname, 'fixtures', 'nfe-cnpj-alfanumerico.xml')),
      headers: { cookie: session.cookie, 'content-type': 'text/xml' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const nfe = res.json();
    expect(nfe).toMatchObject({
      accessKey: '35261012ABC34501DE35550010000123461876543224',
      number: 12346,
      totalCents: 25_000,
      issuer: { document: '12ABC34501DE35' },
      recipient: { entityId: recipient.id, document: recipientDoc },
    });
    const issuer = await admin.get(`/api/entities/${nfe.issuer.entityId}`);
    expect(issuer).toMatchObject({ kind: 'company', document: '12ABC34501DE35' });
    const detail = await admin.get(`/api/nfe/${nfe.nfeDocumentId}`);
    expect(detail.accessKey ?? detail.access_key).toBe('35261012ABC34501DE35550010000123461876543224');
  });
});

describe('extrato: dedup congelado', () => {
  it('o dedup_hash das linhas sem FITID com CNPJ alfanumérico não muda (hash fixo de antes da tarefa 015)', () => {
    const lines = [
      { postedOn: '2026-10-10', amountCents: -15_000, description: 'PIX ENVIADO 12.ABC.345/01DE-35 FORNECEDOR ALFA', fitid: null },
      { postedOn: '2026-10-10', amountCents: -15_000, description: 'PIX RECEBIDO 12abc34501de35 Cliente Ação', fitid: null },
    ];
    expect(dedupHashes(lines)).toEqual([
      'abcd3a19c04c40a560b96d344af298bd29531333fcab96d917c7da3546a44d4e',
      'a9c58533a378b32e954428360338c36e5d338aa14c9bffaf20c0e5f5f18804d7',
    ]);
  });
});
