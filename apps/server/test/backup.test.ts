import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, freshDatabase, type Harness, login, scenario, startApp, uid, userSession } from './helpers';

/*
 * Backup e restauração (spec 019): exportação com segredos, importação com
 * merge (já cadastrados ficam, conflitos não entram e voltam com o motivo),
 * simulação e o JSON completo importado num banco novo.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

type Report = {
  dryRun: boolean;
  summary: { table: string; total: number; imported: number; existing: number; skipped: number; failed: number }[];
  issues: { table: string; id: string; label: string; status: string; reason: string }[];
  issueCount: number;
};

async function exportJson(target: Harness, cookie: string, resource: string) {
  const res = await target.app.inject({ method: 'GET', url: `/api/backup/export/${resource}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['content-disposition']).toContain(`moneyflow-${resource}-`);
  return JSON.parse(res.body);
}

async function importFile(target: Harness, cookie: string, kind: string, body: object | Buffer, options: { dryRun?: boolean } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const res = await target.app.inject({
    method: 'POST',
    url: `/api/backup/import/${kind}${options.dryRun ? '?dryRun=1' : ''}`,
    payload,
    headers: { cookie, 'content-type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Report;
}

const sum = (report: Report, table: string) => report.summary.find((row) => row.table === table)!;
const issuesOf = (report: Report, table: string, status?: string) =>
  report.issues.filter((i) => i.table === table && (!status || i.status === status));
const failures = (report: Report) => report.issues.filter((i) => i.status === 'failed');

describe('backup: permissões e formato', () => {
  it('só admin acessa; arquivo inválido é recusado com mensagem', async () => {
    const user = await userSession(h);
    const asUser = client(h, user.cookie);
    await asUser.get('/api/backup/status', 403);
    await asUser.get('/api/backup/export/categories', 403);
    const admin = await userSession(h, 'admin');
    const status = await client(h, admin.cookie).get('/api/backup/status');
    expect(status).toMatchObject({ dumpAvailable: false });
    expect(status.dumpUnavailableReason).toBeTruthy();

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/backup/import/categories',
      payload: Buffer.from('{"nada": 1}'),
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/não é um backup/);
  });
});

describe('backup: categorias no mesmo sistema', () => {
  it('reimportar não muda nada; novas entram sob o pai; colisões por nome e dependências ausentes voltam com o motivo', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const tag = uid();
    const parent = await admin.post('/api/categories', { kind: 'expense', name: `Moradia ${tag}`, colorSlot: 3 });
    await admin.post('/api/categories', { kind: 'expense', name: `Aluguel ${tag}`, parentId: parent.id });

    const file = await exportJson(h, session.cookie, 'categories');
    expect(file).toMatchObject({ format: 'moneyflow-backup', kind: 'categories' });
    expect(file.tables.categories.find((c: any) => c.id === parent.id)).toMatchObject({ name: `Moradia ${tag}`, color_slot: 3 });

    const again = await importFile(h, session.cookie, 'categories', file);
    expect(sum(again, 'categories').imported).toBe(0);
    expect(sum(again, 'categories').existing).toBe(file.tables.categories.length);

    // Outro "sistema": mesmo pai com outro id (casa pelo nome), um filho novo sob ele e um órfão.
    const foreignParent = randomUUID();
    const crafted = {
      ...file,
      tables: {
        categories: [
          { id: foreignParent, kind: 'expense', parent_id: null, name: `MORADIA ${tag}`, color_slot: 5 },
          { id: randomUUID(), kind: 'expense', parent_id: foreignParent, name: `Condomínio ${tag}` },
          { id: randomUUID(), kind: 'expense', parent_id: foreignParent, name: `Aluguel ${tag}` },
          { id: randomUUID(), kind: 'expense', parent_id: randomUUID(), name: `Órfã ${tag}` },
          { id: 'nao-e-uuid', kind: 'expense', name: 'Sem id' },
        ],
      },
    };
    const sim = await importFile(h, session.cookie, 'categories', crafted, { dryRun: true });
    expect(sim.dryRun).toBe(true);
    expect(sum(sim, 'categories').imported).toBe(1);
    const before = await admin.get('/api/categories');
    expect(JSON.stringify(before)).not.toContain(`Condomínio ${tag}`);

    const report = await importFile(h, session.cookie, 'categories', crafted);
    expect(sum(report, 'categories')).toMatchObject({ total: 5, imported: 1, existing: 2, failed: 2 });
    const reasons = issuesOf(report, 'categories').map((i) => i.reason);
    expect(reasons).toContainEqual(expect.stringMatching(/mesmo nome/));
    expect(reasons).toContainEqual(expect.stringMatching(/não existe neste sistema/));
    expect(reasons).toContainEqual(expect.stringMatching(/identificador válido/));
    const [created] = (await h.db.execute<{ parent_id: string }>(sql`SELECT parent_id FROM categories WHERE name = ${`Condomínio ${tag}`}`))
      .rows;
    expect(created?.parent_id).toBe(parent.id);
  });
});

describe('backup: recursos num sistema novo', () => {
  let b: Harness;
  let adminB: Awaited<ReturnType<typeof userSession>>;
  let skip = false;
  beforeAll(async () => {
    const url = await freshDatabase();
    if (!url) {
      skip = true;
      return;
    }
    b = await startApp({}, url);
    adminB = await userSession(b, 'admin');
  });
  afterAll(() => b?.close());

  it('usuários levam senha, papéis e o hash dos tokens; papéis em caixas ausentes não entram', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const s = await scenario(h, a);
    const someone = await userSession(h);
    await a.put(`/api/users/${someone.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const token = await client(h, someone.cookie).post('/api/account/api-tokens', { name: 'cli' });

    const file = await exportJson(h, adminA.cookie, 'users');
    const exported = file.tables.users.find((u: any) => u.id === someone.id);
    expect(exported.password).toBe(someone.password);
    expect(file.tables.user_api_tokens.find((x: any) => x.id === token.id).token_hash).toBe(
      createHash('sha256').update(token.token).digest('hex'),
    );
    expect(file.references.caixas.some((c: any) => c.id === s.caixaA.id)).toBe(true);
    expect(JSON.stringify(file.references)).not.toContain(someone.password);

    const report = await importFile(b, adminB.cookie, 'users', file);
    expect(sum(report, 'users').failed).toBe(0);
    expect(issuesOf(report, 'caixa_members', 'failed')[0]?.reason).toMatch(/não existe neste sistema/);
    expect(sum(report, 'user_api_tokens').failed).toBe(0);

    await login(b, someone.username, someone.password);
    const auth = await b.db.execute(
      sql`SELECT * FROM api_token_authenticate(${createHash('sha256').update(token.token).digest('hex')}, '127.0.0.1')`,
    );
    expect(auth.rows).toHaveLength(1);

    // Reimportar: todos já cadastrados (pelo id), a senha atual permanece.
    const again = await importFile(b, adminB.cookie, 'users', file);
    expect(sum(again, 'users').imported).toBe(0);
  });

  it('provedores de IA levam a chave de API e os preços', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const apiKey = `sk-teste-${uid()}-${uid()}`;
    const provider = await a.post('/api/admin/ai/providers', { name: `Provedor ${uid()}`, kind: 'openai', apiKey });
    await a.post('/api/admin/ai/prices', { providerId: provider.id, model: 'gpt-x', inputPricePerMillion: 1.5, outputPricePerMillion: 6 });

    const file = await exportJson(h, adminA.cookie, 'ai-providers');
    expect(file.tables.ai_providers.find((p: any) => p.id === provider.id).api_key).toBe(apiKey);

    const report = await importFile(b, adminB.cookie, 'ai-providers', file);
    expect(failures(report)).toEqual([]);
    const key = await b.db.execute<{ k: string }>(sql`SELECT admin_ai_provider_api_key(${provider.id}::uuid, ${adminB.id}::uuid) AS k`);
    expect(key.rows[0]?.k).toBe(apiKey);
    const prices = await client(b, adminB.cookie).get('/api/admin/ai/prices');
    expect(prices.some((p: any) => p.providerId === provider.id && p.model === 'gpt-x')).toBe(true);
  });

  it('agente dos fluxos entra sem a marca se já há um marcado; conversa de backup antigo ganha a finalidade do screen_context', async () => {
    if (skip) return;
    const api = client(b, adminB.cookie);
    const provider = await api.post('/api/admin/ai/providers', { name: `Provedor fluxos ${uid()}`, kind: 'openai', apiKey: `sk-${uid()}` });
    const base = { systemPrompt: 'Fluxos.', providerId: provider.id, model: 'gpt-x', isActive: true };
    const marked = await api.post('/api/admin/ai/agents', { ...base, name: `Marcado ${uid()}`, useForFlows: true });
    const conversation = await api.post('/api/conversations', { agentId: marked.id });

    // O arquivo: um agente marcado e uma conversa de antes da coluna purpose (finalidade no screen_context).
    const full = await b.app.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: adminB.cookie } });
    expect(full.statusCode, full.body.slice(0, 300)).toBe(200);
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(full.rawPayload))['moneyflow.json']!));
    const agentRow = json.tables.ai_agents.find((a: any) => a.id === marked.id);
    expect(agentRow.use_for_flows).toBe(true);
    const conversationRow = json.tables.ai_conversations.find((c: any) => c.id === conversation.id);
    const { purpose: _purpose, ...legacyConversation } = conversationRow;
    const fileWith = (agentName: string) => {
      const agentId = randomUUID();
      const conversationId = randomUUID();
      return {
        agentId,
        conversationId,
        file: {
          ...json,
          tables: {
            ai_agents: [{ ...agentRow, id: agentId, name: agentName }],
            ai_conversations: [
              {
                ...legacyConversation,
                id: conversationId,
                agent_id: agentId,
                screen_context: { purpose: 'document_reading', fileName: 'antigo.pdf' },
              },
            ],
          },
          references: {},
        },
      };
    };

    const first = fileWith(`Do arquivo ${uid()}`);
    const report = await importFile(b, adminB.cookie, 'full', first.file);
    expect(failures(report)).toEqual([]);
    expect(sum(report, 'ai_agents').imported).toBe(1);
    const agents = await api.get('/api/admin/ai/agents');
    expect(agents.find((a: any) => a.id === first.agentId).useForFlows).toBe(false);
    expect(agents.filter((a: any) => a.useForFlows).map((a: any) => a.id)).toEqual([marked.id]);
    const imported = await b.db.execute<{ purpose: string; screen_context: Record<string, unknown> }>(
      sql`SELECT purpose, screen_context FROM ai_conversations WHERE id = ${first.conversationId}`,
    );
    expect(imported.rows[0]).toEqual({ purpose: 'document_reading', screen_context: { fileName: 'antigo.pdf' } });
    expect((await api.get('/api/conversations?archived=1')).map((c: any) => c.id)).not.toContain(first.conversationId);

    // Sem marcado no banco, o agente do arquivo entra com a marca.
    await api.patch(`/api/admin/ai/agents/${marked.id}`, { useForFlows: false });
    const second = fileWith(`Do arquivo ${uid()}`);
    expect(failures(await importFile(b, adminB.cookie, 'full', second.file))).toEqual([]);
    const after = await api.get('/api/admin/ai/agents');
    expect(after.filter((a: any) => a.useForFlows).map((a: any) => a.id)).toEqual([second.agentId]);
  });

  it('caixas exigem o titular; entidades casam pelo documento e conflitos de chave PIX voltam com o motivo', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const s = await scenario(h, a);
    await a.post(`/api/entities/${s.supplier.id}/contacts`, { kind: 'email', value: `contato-${s.tag}@teste.local` });

    const caixas = await exportJson(h, adminA.cookie, 'caixas');
    const first = await importFile(b, adminB.cookie, 'caixas', caixas);
    const missing = issuesOf(first, 'caixas').find((i) => i.id === s.caixaA.id);
    expect(missing?.reason).toMatch(/Depende de entidades .* não existe neste sistema/);
    expect(issuesOf(first, 'financial_accounts').find((i) => i.id === s.accountA.id)?.reason).toMatch(/Depende de caixas/);

    const entities = await exportJson(h, adminA.cookie, 'entities');
    const imported = await importFile(b, adminB.cookie, 'entities', entities);
    expect(failures(imported)).toEqual([]);
    const second = await importFile(b, adminB.cookie, 'caixas', caixas);
    expect(issuesOf(second, 'caixas').find((i) => i.id === s.caixaA.id)).toBeUndefined();
    const accounts = await client(b, adminB.cookie).get('/api/accounts');
    expect(accounts.find((x: any) => x.id === s.accountA.id)?.balanceCents).toBe(100_000);

    // Mesma pessoa com outro id (casa pelo CNPJ): fica a cadastrada, sem os contatos do arquivo.
    const cnpj = '11222333000181';
    const withDoc = await client(b, adminB.cookie).post('/api/entities', { kind: 'company', name: `Com CNPJ ${s.tag}`, document: cnpj });
    const pixOwner = await client(b, adminB.cookie).post('/api/entities', { kind: 'person', name: `Dono PIX ${s.tag}` });
    const pixValue = `pix-${s.tag}@teste.local`;
    await client(b, adminB.cookie).post(`/api/entities/${pixOwner.id}/pix-keys`, { keyType: 'email', keyValue: pixValue });
    const foreign = randomUUID();
    const conflicting = randomUUID();
    const crafted = {
      ...entities,
      tables: {
        entities: [
          { id: foreign, kind: 'company', name: 'Outro nome', document: cnpj },
          { id: conflicting, kind: 'person', name: `Conflito ${s.tag}` },
        ],
        entity_contacts: [{ id: randomUUID(), entity_id: foreign, kind: 'phone', value: '+5511999990000', is_primary: false }],
        entity_pix_keys: [{ id: randomUUID(), entity_id: conflicting, key_type: 'email', key_value: pixValue, is_primary: false }],
      },
    };
    const report = await importFile(b, adminB.cookie, 'entities', crafted);
    expect(issuesOf(report, 'entities').find((i) => i.id === foreign)?.reason).toMatch(/mesmo documento/);
    expect(issuesOf(report, 'entity_contacts')[0]).toMatchObject({ status: 'skipped' });
    expect(issuesOf(report, 'entity_pix_keys')[0]).toMatchObject({ status: 'failed' });
    expect(issuesOf(report, 'entity_pix_keys')[0]!.reason).toMatch(/chave PIX já está cadastrada/);
    expect(sum(report, 'entities').imported).toBe(1);
    const kept = await client(b, adminB.cookie).get(`/api/entities/${withDoc.id}`);
    expect(kept.name).toBe(`Com CNPJ ${s.tag}`);
  });

  it('entidades levam favorita, tags (arquivada inclusive, arquivada depois das ligações) e casam a tag pelo nome', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const tag = uid();
    const active = await a.post('/api/entity-tags', { name: `Ativa ${tag}`, colorSlot: 2 });
    const old = await a.post('/api/entity-tags', { name: `Velha ${tag}`, colorSlot: 5 });
    const entity = await a.post('/api/entities', {
      kind: 'person',
      name: `Com tags ${tag}`,
      tagIds: [active.id, old.id],
      isFavorite: true,
    });
    await a.del(`/api/entity-tags/${old.id}`);
    // No destino já existe uma tag com o mesmo nome (outro id e outra caixa de letras): é a mesma.
    const local = await client(b, adminB.cookie).post('/api/entity-tags', { name: `ATIVA ${tag}`, colorSlot: 9 });

    const file = await exportJson(h, adminA.cookie, 'entities');
    expect(file.tables.entity_tags.some((r: any) => r.id === old.id && r.archived_at)).toBe(true);
    expect(file.tables.entity_tag_links.filter((r: any) => r.entity_id === entity.id)).toHaveLength(2);

    const simulated = await importFile(b, adminB.cookie, 'entities', file, { dryRun: true });
    expect(failures(simulated)).toEqual([]);
    const report = await importFile(b, adminB.cookie, 'entities', file);
    expect(failures(report)).toEqual([]);
    expect(issuesOf(report, 'entity_tags').find((i) => i.id === active.id)?.reason).toMatch(/nome/);
    const imported = await client(b, adminB.cookie).get(`/api/entities/${entity.id}`);
    expect(imported.isFavorite).toBe(true);
    expect(imported.tags).toEqual([
      { id: local.id, name: `ATIVA ${tag}`, colorSlot: 9, archived: false },
      { id: old.id, name: `Velha ${tag}`, colorSlot: 5, archived: true },
    ]);
    // Reimportar não muda nada: a ligação (sem id) já existe.
    const again = await importFile(b, adminB.cookie, 'entities', file);
    expect(failures(again)).toEqual([]);
    expect(sum(again, 'entity_tag_links').imported).toBe(0);
  });
});

describe('backup: JSON completo num sistema novo', () => {
  it('exporta tudo (zip), simula sem gravar e importa sem conflitos; reimportar não duplica', async () => {
    const url = await freshDatabase();
    if (!url) return;
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const s = await scenario(h, admin);

    // Espelho baixado (duas pernas), baixa com transferência estornada, títulos cancelados.
    const mirrored = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.holderB.id,
      categoryId: s.expense.id,
      description: 'Serviço espelhado',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-15',
      amountCents: 30_000,
    });
    await admin.post(`/api/titles/${mirrored.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 10_000,
      financialAccountId: s.accountA.id,
    });
    const viaTransfer = await admin.post('/api/titles', {
      caixaId: s.caixaB.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Pago por outra caixa',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-15',
      amountCents: 20_000,
    });
    const settled = await admin.post(`/api/titles/${viaTransfer.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 20_000,
      financialAccountId: s.accountB.id,
      sourceAccountId: s.accountA.id,
    });
    await admin.post(`/api/settlements/${settled.settlements[0].id}/reverse`, { reason: 'Duplicado', reversedOn: '2026-10-16' });
    await admin.post(`/api/titles/${viaTransfer.id}/settlements`, {
      settledOn: '2026-10-17',
      amountCents: 20_000,
      financialAccountId: s.accountB.id,
    });
    const reversedThenCanceled = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'receivable',
      entityId: s.supplier.id,
      categoryId: s.income.id,
      description: 'Estornado e cancelado',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-20',
      amountCents: 5_000,
    });
    const rs = await admin.post(`/api/titles/${reversedThenCanceled.id}/settlements`, {
      settledOn: '2026-10-20',
      amountCents: 5_000,
      financialAccountId: s.accountA.id,
    });
    await admin.post(`/api/settlements/${rs.settlements[0].id}/reverse`, { reason: 'Erro', reversedOn: '2026-10-21' });
    await admin.post(`/api/titles/${reversedThenCanceled.id}/cancel`);
    await h.app.inject({
      method: 'POST',
      url: `/api/attachments?target=title&targetId=${mirrored.id}&fileName=nota.pdf`,
      payload: Buffer.from('%PDF-1.4 anexo do backup'),
      headers: { cookie: session.cookie, 'content-type': 'application/pdf' },
    });

    // Cartão: compra parcelada, estorno, fechamento, pagamento parcial com saldo rolado e encargo.
    const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${s.tag}` });
    const card = await admin.post('/api/caixas', {
      name: `Cartão ${s.tag}`,
      kind: 'credit_card',
      holderEntityId: issuer.id,
      defaultPayerCaixaId: s.caixaA.id,
      creditLimitCents: 500_000,
      closingDay: 3,
      dueDay: 10,
      cardLast4: '4321',
    });
    const purchase = await admin.post(`/api/cards/${card.id}/purchases`, {
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-09-12',
      description: 'Parcelada',
      amountCents: 60_000,
      installmentsTotal: 3,
    });
    await admin.post(`/api/card-purchases/${purchase.id}/refund`, { amountCents: 5_000, refundedOn: '2026-09-20' });
    const overview = await admin.get(`/api/cards/${card.id}`);
    const oct = overview.invoices.find((i: any) => i.referenceMonth === '2026-10-01');
    await admin.post(`/api/card-invoices/${oct.id}/close`, {});
    await admin.post(`/api/card-invoices/${oct.id}/pay`, {
      payerCaixaId: s.caixaA.id,
      settledOn: '2026-10-10',
      amountCents: 10_000,
      financialAccountId: s.accountA.id,
      charges: [{ chargeKind: 'interest', amountCents: 700, categoryId: s.expense.id }],
    });

    // Contratos (spec 020): renovação pendente com aditivo e documentos (markdown com 2 versões e PDF); um rescindido com multa.
    const contractBase = {
      caixaId: s.caixaA.id,
      entityId: s.holderB.id,
      direction: 'receivable',
      categoryId: s.income.id,
      durationMonths: 12,
      periodicity: 'monthly',
      totalCents: 120_001,
      dueDay: 10,
      dueMonthOffset: 1,
      activate: true,
    };
    const pending = await admin.post('/api/contracts', { ...contractBase, name: 'Suporte', startsOn: '2025-11-01', autoRenew: true });
    expect(pending.status).toBe('renewal_pending');
    await admin.post(`/api/contracts/${pending.id}/amendments`, { effectiveOn: '2026-08-01', installmentCents: 11_000 });
    const upload = (name: string, body: Buffer, mime: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/contracts/${pending.id}/documents?fileName=${name}&kind=contract`,
        payload: body,
        headers: { cookie: session.cookie, 'content-type': mime },
      });
    const md = (await upload('contrato.md', Buffer.from('# Contrato\nv1\n'), 'text/markdown')).json();
    await admin.post(`/api/contract-documents/${md.id}/versions`, { content: '# Contrato\nv2\n' });
    expect((await upload('contrato.pdf', Buffer.from('%PDF-1.4 contrato'), 'application/pdf')).statusCode).toBe(200);
    const terminated = await admin.post('/api/contracts', { ...contractBase, name: 'Consultoria', startsOn: '2027-01-01' });
    await admin.post(`/api/contracts/${terminated.id}/terminate`, {
      terminatedOn: '2027-03-15',
      penalty: { direction: 'receivable', amountCents: 5_000, dueDate: '2027-04-10', categoryId: s.income.id },
    });

    // Extrato importado e um mês fechado.
    const ofx = readFileSync(join(import.meta.dirname, 'fixtures/extrato-ofx1.ofx'));
    const imp = await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`,
      payload: ofx,
      headers: { cookie: session.cookie, 'content-type': 'application/octet-stream' },
    });
    expect(imp.statusCode, imp.body).toBe(200);
    await admin.post(`/api/caixas/${s.caixaB.id}/closings`, { month: '2026-01', force: true });

    const res = await h.app.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: session.cookie } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = res.rawPayload;
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(zip))['moneyflow.json']!));
    expect(json.kind).toBe('full');
    expect(json.tables.sessions).toBeUndefined();
    expect(json.tables.audit_log).toBeUndefined();
    expect(json.tables.users.find((u: any) => u.id === session.id).password).toBe(session.password);
    expect(json.tables.attachments.length).toBeGreaterThan(0);

    const b = await startApp({}, url);
    try {
      const adminB = await userSession(b, 'admin');
      const sim = await importFile(b, adminB.cookie, 'full', zip, { dryRun: true });
      expect(failures(sim)).toEqual([]);
      const count = await b.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM titles`);
      expect(count.rows[0]?.n).toBe(0);

      const report = await importFile(b, adminB.cookie, 'full', zip);
      expect(failures(report)).toEqual([]);
      expect(sum(report, 'titles').imported).toBe(json.tables.titles.length);
      expect(sum(report, 'movements').imported).toBe(json.tables.movements.length);

      // Mesmos saldos e situações nos dois sistemas.
      const accountsA = await admin.get('/api/accounts');
      const accountsB = await client(b, adminB.cookie).get('/api/accounts');
      const balances = (list: any[]) => Object.fromEntries(list.map((x) => [x.id, x.balanceCents]));
      expect(balances(accountsB)).toEqual(balances(accountsA));
      for (const id of [mirrored.id, mirrored.mirror.id, viaTransfer.id, reversedThenCanceled.id]) {
        const [ta, tb] = await Promise.all([admin.get(`/api/titles/${id}`), client(b, adminB.cookie).get(`/api/titles/${id}`)]);
        expect({ status: tb.status, amount: tb.amountCents, settlements: tb.settlements.length }).toEqual({
          status: ta.status,
          amount: ta.amountCents,
          settlements: ta.settlements.length,
        });
      }
      const invoiceB = await client(b, adminB.cookie).get(`/api/card-invoices/${oct.id}`);
      const invoiceA = await admin.get(`/api/card-invoices/${oct.id}`);
      expect(invoiceB.status).toBe(invoiceA.status);
      expect(invoiceB.totalCents).toBe(invoiceA.totalCents);

      // Contratos: mesma situação, ciclos, parcelas, aditivos, tarefas e documentos (com as versões).
      for (const id of [pending.id, terminated.id]) {
        const [ca, cb] = await Promise.all([admin.get(`/api/contracts/${id}`), client(b, adminB.cookie).get(`/api/contracts/${id}`)]);
        const shape = (c: any) => ({
          status: c.status,
          cycles: c.cycles.map((y: any) => ({
            seq: y.seq,
            total: y.totalCents,
            rows: y.installments.map((i: any) => [i.amountCents, i.status]),
          })),
          extra: c.extraTitles.length,
          amendments: c.amendments.length,
          tasks: c.renewalTasks.map((k: any) => k.status),
          documents: c.documents.map((d: any) => [d.format, d.currentVersion, d.versionCount]),
        });
        expect(shape(cb)).toEqual(shape(ca));
      }

      // O usuário do sistema de origem entra com a mesma senha.
      await login(b, session.username, session.password);

      const again = await importFile(b, adminB.cookie, 'full', zip);
      expect(again.summary.reduce((n, row) => n + row.imported, 0)).toBe(0);
      expect(failures(again)).toEqual([]);
    } finally {
      await b.close();
    }
  }, 180_000);
});
