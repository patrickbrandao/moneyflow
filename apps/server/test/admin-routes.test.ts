import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * Rotas de restaurar e de administração que nenhum outro teste chamava
 * (tarefa 126): caixa e conta, membros, categorias ocultas e o plano de
 * categorias, mapeamentos de CSV e regras, destino e fila de mensagens,
 * documentos de contrato, receitas de conciliação, o interruptor da
 * conciliação com IA, as tarefas agendadas na visão do admin e a exclusão de
 * provedor, preço e servidor MCP. Em cada uma: quem não pode recebe 403 (ou
 * 404, quando nem vê), quem pode muda o estado.
 */

let h: Harness;
let admin: ReturnType<typeof client>;
const createdAgents: string[] = [];
const createdProviders: string[] = [];

beforeAll(async () => {
  // A Bot API num endereço fechado: o "enviar teste" falha na hora e a mensagem fica na fila (para cancelar).
  h = await startApp({ TELEGRAM_API_BASE: 'http://127.0.0.1:9', TELEGRAM_TIMEOUT_MS: '1000' });
  admin = client(h, (await userSession(h, 'admin')).cookie);
});
afterAll(async () => {
  for (const id of createdAgents) await admin.patch(`/api/admin/ai/agents/${id}`, { isActive: false });
  for (const id of createdProviders) await admin.raw('PATCH', `/api/admin/ai/providers/${id}`, { isActive: false });
  await h.close();
});

type Api = ReturnType<typeof client>;

async function people() {
  const s = await scenario(h, admin);
  const editorSession = await userSession(h);
  const viewerSession = await userSession(h);
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editorSession.id, role: 'editor' });
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerSession.id, role: 'viewer' });
  return {
    s,
    editorSession,
    viewerSession,
    editor: client(h, editorSession.cookie),
    viewer: client(h, viewerSession.cookie),
  };
}

const status = async (api: Api, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET', url: string, body?: unknown) =>
  (await api.raw(method, url, body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}))).statusCode;

async function aiProvider() {
  const provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso 126 ${uid()}`,
    kind: 'anthropic',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: `sk-ant-126-${uid()}`,
    defaultModels: { text: 'claude-sonnet-5-5' },
  });
  createdProviders.push(provider.id);
  return provider;
}

async function aiAgent(providerId: string) {
  const agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente 126 ${uid()}`,
    systemPrompt: 'Agente dos testes da tarefa 126.',
    defaultProviderId: providerId,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 1000 },
    toolKitId: null,
    isActive: true,
  });
  createdAgents.push(agent.id);
  return agent;
}

/* ---------------- caixas, contas e membros ---------------- */

describe('caixa, conta e membros (spec 004)', () => {
  it('restaurar a caixa arquivada é do admin; restaurar a conta arquivada é de quem escreve na caixa', async () => {
    const { s, editor, viewer } = await people();
    const holder = await admin.post('/api/entities', { kind: 'company', name: `Titular C ${s.tag}` });
    const caixa = await admin.post('/api/caixas', { name: `Caixa C ${s.tag}`, holderEntityId: holder.id });
    await admin.post(`/api/caixas/${caixa.id}/accounts`, {
      kind: 'cash',
      name: 'Cofre C',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    // Com conta, a caixa é arquivada em vez de excluída.
    expect(await admin.del(`/api/caixas/${caixa.id}`)).toEqual({ deleted: false, archived: true });
    expect(await status(editor, 'POST', `/api/caixas/${caixa.id}/restore`)).toBe(403);
    expect((await admin.post(`/api/caixas/${caixa.id}/restore`)).archivedAt).toBeNull();
    await admin.post(`/api/caixas/${crypto.randomUUID()}/restore`, {}, 404);

    // Conta com histórico e saldo zero: arquiva; o leitor não restaura, o editor restaura.
    const account = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'savings',
      name: `Poupança ${s.tag}`,
      bankCode: '077',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    await admin.post(`/api/accounts/${account.id}/adjustments`, {
      occurredOn: '2026-02-01',
      amountCents: 1_000,
      description: 'Rendimento',
    });
    await admin.post(`/api/accounts/${account.id}/adjustments`, { occurredOn: '2026-02-02', amountCents: -1_000, description: 'Resgate' });
    expect(await editor.del(`/api/accounts/${account.id}`)).toEqual({ deleted: false, archived: true });
    const archived = (await admin.get(`/api/accounts?caixaId=${s.caixaA.id}&archived=true`)).find((a: any) => a.id === account.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(await status(viewer, 'POST', `/api/accounts/${account.id}/restore`)).toBe(403);
    expect(await editor.post(`/api/accounts/${account.id}/restore`)).toEqual({ ok: true });
    const active = (await admin.get(`/api/accounts?caixaId=${s.caixaA.id}`)).find((a: any) => a.id === account.id);
    expect(active.archivedAt).toBeNull();
  });

  it('PATCH do membro troca o papel (só o admin); o membro de outra caixa é 404', async () => {
    const { s, editor, viewerSession } = await people();
    const members = await admin.get(`/api/caixas/${s.caixaA.id}/members`);
    const viewerMember = members.find((m: any) => m.userId === viewerSession.id);
    expect(viewerMember.role).toBe('viewer');

    expect(await status(editor, 'PATCH', `/api/caixas/${s.caixaA.id}/members/${viewerMember.id}`, { role: 'editor' })).toBe(403);
    await admin.patch(`/api/caixas/${s.caixaB.id}/members/${viewerMember.id}`, { role: 'editor' }, 404);
    const updated = await admin.patch(`/api/caixas/${s.caixaA.id}/members/${viewerMember.id}`, { role: 'editor' });
    expect(updated.find((m: any) => m.userId === viewerSession.id).role).toBe('editor');
    // O papel novo vale na hora: o ex-leitor escreve na caixa.
    const promoted = client(h, viewerSession.cookie);
    await promoted.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'cash',
      name: 'Cofre novo',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
  });

  it('categorias ocultas: quem lê vê a lista; quem escreve troca; o grupo oculto oculta os filhos na árvore da caixa', async () => {
    const { s, editor, viewer } = await people();
    const group = await admin.post('/api/categories', { kind: 'expense', name: `Grupo ${s.tag}` });
    const child = await admin.post('/api/categories', { kind: 'expense', name: `Filha ${s.tag}`, parentId: group.id });

    expect(await viewer.get(`/api/caixas/${s.caixaA.id}/hidden-categories`)).toEqual([]);
    expect(await status(viewer, 'PUT', `/api/caixas/${s.caixaA.id}/hidden-categories`, { categoryIds: [group.id] })).toBe(403);
    expect(await editor.put(`/api/caixas/${s.caixaA.id}/hidden-categories`, { categoryIds: [group.id, group.id] })).toEqual([group.id]);
    expect(await viewer.get(`/api/caixas/${s.caixaA.id}/hidden-categories`)).toEqual([group.id]);

    const tree = await viewer.get(`/api/categories?caixaId=${s.caixaA.id}&kind=expense`);
    const node = tree.find((c: any) => c.id === group.id);
    expect(node.hidden).toBe(true);
    expect(node.children.find((c: any) => c.id === child.id).hidden).toBe(true);
    // Só nesta caixa.
    expect((await admin.get(`/api/categories?caixaId=${s.caixaB.id}&kind=expense`)).find((c: any) => c.id === group.id).hidden).toBe(false);

    expect(await editor.put(`/api/caixas/${s.caixaA.id}/hidden-categories`, { categoryIds: [] })).toEqual([]);
  });
});

/* ---------------- usuários ---------------- */

describe('usuário (spec 002)', () => {
  it('GET /api/users/:id é do admin, traz os papéis por caixa e nunca a senha', async () => {
    const { s, editorSession, editor } = await people();
    const user = await admin.get(`/api/users/${editorSession.id}`);
    expect(user).toMatchObject({ id: editorSession.id, username: editorSession.username, role: 'user' });
    expect(user.memberships).toEqual([expect.objectContaining({ caixaId: s.caixaA.id, role: 'editor' })]);
    expect(JSON.stringify(user)).not.toContain(editorSession.password);
    expect(Object.keys(user)).not.toContain('password');
    expect(await status(editor, 'GET', `/api/users/${editorSession.id}`)).toBe(403);
    await admin.get(`/api/users/${crypto.randomUUID()}`, 404);
  });
});

/* ---------------- plano de categorias ---------------- */

describe('plano de categorias (spec 008)', () => {
  it('editar, excluir e restaurar são do admin; em uso, excluir o grupo arquiva o grupo e as filhas', async () => {
    const { s, editor } = await people();
    const group = await admin.post('/api/categories', { kind: 'expense', name: `Moradia ${s.tag}` });
    const child = await admin.post('/api/categories', { kind: 'expense', name: `Luz ${s.tag}`, parentId: group.id });
    await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: child.id,
      description: 'Conta de luz',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-15',
      amountCents: 10_000,
      mirrorCaixaId: null,
    });

    expect(await status(editor, 'PATCH', `/api/categories/${group.id}`, { name: 'x' })).toBe(403);
    const renamed = await admin.patch(`/api/categories/${group.id}`, { name: `Casa ${s.tag}`, colorSlot: 3 });
    expect(renamed).toMatchObject({ id: group.id, name: `Casa ${s.tag}`, colorSlot: 3 });
    await admin.patch(`/api/categories/${crypto.randomUUID()}`, { name: 'x' }, 404);

    expect(await status(editor, 'DELETE', `/api/categories/${group.id}`)).toBe(403);
    expect(await admin.del(`/api/categories/${group.id}`)).toEqual({ deleted: false, archived: true });
    const archived = (await admin.get('/api/categories?kind=expense&archived=true')).find((c: any) => c.id === group.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.children.find((c: any) => c.id === child.id).archivedAt).not.toBeNull();
    expect((await admin.get('/api/categories?kind=expense')).map((c: any) => c.id)).not.toContain(group.id);

    expect(await status(editor, 'POST', `/api/categories/${group.id}/restore`)).toBe(403);
    expect(await admin.post(`/api/categories/${group.id}/restore`)).toEqual({ ok: true });
    expect((await admin.get('/api/categories?kind=expense')).map((c: any) => c.id)).toContain(group.id);

    // Sem uso, exclui de vez.
    const unused = await admin.post('/api/categories', { kind: 'income', name: `Avulsa ${s.tag}` });
    expect(await admin.del(`/api/categories/${unused.id}`)).toEqual({ deleted: true, archived: false });
  });

  it('restaurar o grupo traz de volta as filhas arquivadas com ele; a arquivada antes, à parte, continua arquivada', async () => {
    const { s } = await people();
    const group = await admin.post('/api/categories', { kind: 'expense', name: `Veículos ${s.tag}` });
    const fuel = await admin.post('/api/categories', { kind: 'expense', name: `Combustível ${s.tag}`, parentId: group.id });
    const parking = await admin.post('/api/categories', { kind: 'expense', name: `Estacionamento ${s.tag}`, parentId: group.id });
    const tolls = await admin.post('/api/categories', { kind: 'expense', name: `Pedágio ${s.tag}`, parentId: group.id });
    // Em uso: excluir arquiva (o combustível e o estacionamento; o pedágio fica sem uso).
    for (const category of [fuel, parking]) {
      await admin.post('/api/titles', {
        caixaId: s.caixaA.id,
        direction: 'payable',
        entityId: s.supplier.id,
        categoryId: category.id,
        description: `Despesa ${category.name}`,
        competenceDate: '2026-10-01',
        dueDate: '2026-10-15',
        amountCents: 5_000,
        mirrorCaixaId: null,
      });
    }
    const archivedIds = async () =>
      new Set(
        (await admin.get('/api/categories?kind=expense&archived=true'))
          .flatMap((c: any) => [c, ...c.children])
          .filter((c: any) => c.archivedAt)
          .map((c: any) => c.id),
      );

    // O estacionamento sai antes, à parte; depois o grupo leva o combustível e o pedágio.
    expect(await admin.del(`/api/categories/${parking.id}`)).toEqual({ deleted: false, archived: true });
    expect(await admin.del(`/api/categories/${group.id}`)).toEqual({ deleted: false, archived: true });
    // Excluir o grupo já arquivado de novo não muda as datas.
    expect(await admin.del(`/api/categories/${group.id}`)).toEqual({ deleted: false, archived: true });
    let archived = await archivedIds();
    for (const category of [group, fuel, parking, tolls]) expect(archived.has(category.id), category.name).toBe(true);

    expect(await admin.post(`/api/categories/${group.id}/restore`)).toEqual({ ok: true });
    archived = await archivedIds();
    expect([group, fuel, tolls].filter((c) => archived.has(c.id))).toEqual([]);
    expect(archived.has(parking.id)).toBe(true);
    const active = (await admin.get('/api/categories?kind=expense')).find((c: any) => c.id === group.id);
    expect(active.children.map((c: any) => c.id).sort()).toEqual([fuel.id, tolls.id].sort());

    // A filha arquivada à parte volta sozinha; restaurar o que não existe é 404.
    expect(await admin.post(`/api/categories/${parking.id}/restore`)).toEqual({ ok: true });
    expect((await archivedIds()).has(parking.id)).toBe(false);
    await admin.post(`/api/categories/${crypto.randomUUID()}/restore`, {}, 404);
  });
});

/* ---------------- extrato: mapeamentos de CSV, regras e conciliação com IA ---------------- */

describe('mapeamentos de CSV e regras da conta (specs 009 e 032)', () => {
  const columns = { date: 'data', description: 'histórico', amount: 'valor' };

  it('PATCH troca o padrão (um por conta) e os campos; DELETE apaga; o leitor recebe 403', async () => {
    const { s, editor, viewer } = await people();
    const first = await editor.post('/api/csv-mappings', { financialAccountId: s.accountA.id, name: 'Banco', columns, isDefault: true });
    const second = await editor.post('/api/csv-mappings', { financialAccountId: s.accountA.id, name: 'Outro', columns });
    expect(second.isDefault).toBe(false);

    const updated = await editor.patch(`/api/csv-mappings/${second.id}`, {
      name: 'Banco novo',
      delimiter: ',',
      skipRows: 2,
      isDefault: true,
    });
    expect(updated).toMatchObject({ id: second.id, name: 'Banco novo', delimiter: ',', skipRows: 2, isDefault: true });
    const list = await viewer.get(`/api/csv-mappings?accountId=${s.accountA.id}`);
    expect(list.map((m: any) => [m.id, m.isDefault])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);

    expect(await status(viewer, 'PATCH', `/api/csv-mappings/${first.id}`, { name: 'x' })).toBe(403);
    expect(await status(viewer, 'DELETE', `/api/csv-mappings/${first.id}`)).toBe(403);
    await editor.patch(`/api/csv-mappings/${crypto.randomUUID()}`, { name: 'x' }, 404);
    expect(await editor.del(`/api/csv-mappings/${first.id}`)).toEqual({ deleted: true, archived: false });
    expect((await editor.get(`/api/csv-mappings?accountId=${s.accountA.id}`)).map((m: any) => m.id)).toEqual([second.id]);
  });

  it('PATCH da regra de classificação muda o padrão e a prioridade; o leitor recebe 403', async () => {
    const { s, editor, viewer } = await people();
    const rule = await editor.post('/api/classification-rules', {
      accountId: s.accountA.id,
      pattern: 'TARIFA',
      direction: 'out',
      categoryId: s.expense.id,
    });
    const updated = await editor.patch(`/api/classification-rules/${rule.id}`, {
      pattern: 'TAR PACOTE',
      matchKind: 'starts_with',
      priority: 5,
    });
    expect(updated).toMatchObject({ id: rule.id, pattern: 'TAR PACOTE', matchKind: 'starts_with', priority: 5, categoryId: s.expense.id });
    // A regra continua com um alvo e, com categoria, com o sentido (o banco confere no PATCH também).
    expect((await editor.patch(`/api/classification-rules/${rule.id}`, { categoryId: null }, 422)).error.code).toBe(
      'classification_rules_target_check',
    );
    await editor.patch(`/api/classification-rules/${rule.id}`, { direction: null }, 422);
    expect(await status(viewer, 'PATCH', `/api/classification-rules/${rule.id}`, { priority: 1 })).toBe(403);
    await editor.patch(`/api/classification-rules/${crypto.randomUUID()}`, { priority: 1 }, 404);
  });

  it('PUT .../reconcile-ai/auto liga e desliga a conciliação com IA da conta do lote; o leitor recebe 403', async () => {
    const { s, editorSession, editor, viewer } = await people();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`,
      payload: readFileSync(join(import.meta.dirname, 'fixtures', 'extrato-ofx1.ofx')),
      headers: { cookie: editorSession.cookie, 'content-type': 'application/x-ofx' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();

    expect(await status(viewer, 'PUT', `/api/statement-imports/${imp.id}/reconcile-ai/auto`, { enabled: true })).toBe(403);
    expect((await editor.put(`/api/statement-imports/${imp.id}/reconcile-ai/auto`, { enabled: true })).autoEnabled).toBe(true);
    expect((await viewer.get(`/api/statement-imports/${imp.id}/reconcile-ai`)).autoEnabled).toBe(true);
    expect((await admin.get(`/api/accounts?caixaId=${s.caixaA.id}`)).find((a: any) => a.id === s.accountA.id).aiAutoReconcile).toBe(true);
    expect((await editor.put(`/api/statement-imports/${imp.id}/reconcile-ai/auto`, { enabled: false })).autoEnabled).toBe(false);
  });
});

/* ---------------- mensagens ---------------- */

describe('destino e fila de mensagens (spec 013)', () => {
  it('cancelar a mensagem na fila e restaurar o destino arquivado são do dono; outro usuário nem vê (404)', async () => {
    const ownerSession = await userSession(h);
    const owner = client(h, ownerSession.cookie);
    const stranger = client(h, (await userSession(h)).cookie);
    const dest = await owner.post('/api/message-destinations', {
      name: `Fila ${uid()}`,
      botToken: '123456789:AAHfakeFAKEfake_0123456789abc',
      chatId: '77',
    });

    // A Bot API não responde: a mensagem de teste fica na fila para outra tentativa.
    const sent = await owner.post(`/api/message-destinations/${dest.id}/test`);
    expect(['pending', 'failed']).toContain(sent.status);
    expect(await status(stranger, 'POST', `/api/message-outbox/${sent.messageId}/cancel`)).toBe(404);
    expect(await owner.post(`/api/message-outbox/${sent.messageId}/cancel`)).toEqual({ ok: true });
    const canceled = await owner.get(`/api/message-outbox?destinationId=${dest.id}&status=canceled`);
    expect(canceled.map((m: any) => m.id)).toEqual([sent.messageId]);
    // Já cancelada, não cancela de novo.
    await owner.post(`/api/message-outbox/${sent.messageId}/cancel`, {}, 422);
    await owner.post(`/api/message-outbox/${crypto.randomUUID()}/cancel`, {}, 404);

    // Com histórico na fila, excluir arquiva; restaurar volta desativado.
    expect(await owner.del(`/api/message-destinations/${dest.id}`)).toEqual({ deleted: false, archived: true });
    expect(await status(stranger, 'POST', `/api/message-destinations/${dest.id}/restore`)).toBe(404);
    const restored = await owner.post(`/api/message-destinations/${dest.id}/restore`);
    expect(restored).toMatchObject({ id: dest.id, archivedAt: null, isActive: false });
    // O token continua fora da resposta.
    expect(JSON.stringify(restored)).not.toContain('AAHfakeFAKEfake');
  });
});

/* ---------------- documentos de contrato ---------------- */

describe('documentos de contrato (spec 020)', () => {
  it('PATCH troca os metadados; excluir arquiva e restaurar desarquiva; o leitor recebe 403', async () => {
    const { s, editor, viewer } = await people();
    const contract = await editor.post('/api/contracts', {
      caixaId: s.caixaA.id,
      entityId: s.supplier.id,
      direction: 'payable',
      categoryId: s.expense.id,
      name: `Contrato docs ${s.tag}`,
      startsOn: '2026-11-01',
      mirrorCaixaId: null,
      activate: false,
    });
    const doc = await editor.post(`/api/contracts/${contract.id}/documents/markdown`, { title: 'Minuta', content: '# Minuta' });

    const updated = await editor.patch(`/api/contract-documents/${doc.id}`, {
      kind: 'amendment',
      title: 'Aditivo 1',
      documentDate: '2026-11-05',
      description: 'Reajuste',
    });
    expect(updated).toMatchObject({
      id: doc.id,
      kind: 'amendment',
      title: 'Aditivo 1',
      documentDate: '2026-11-05',
      description: 'Reajuste',
    });
    expect(await status(viewer, 'PATCH', `/api/contract-documents/${doc.id}`, { title: 'x' })).toBe(403);

    expect((await editor.del(`/api/contract-documents/${doc.id}`)).archivedAt).not.toBeNull();
    expect(await status(viewer, 'POST', `/api/contract-documents/${doc.id}/restore`)).toBe(403);
    expect((await editor.post(`/api/contract-documents/${doc.id}/restore`)).archivedAt).toBeNull();
    await editor.post(`/api/contract-documents/${crypto.randomUUID()}/restore`, {}, 404);
  });
});

/* ---------------- receitas de conciliação ---------------- */

describe('receitas de conciliação (spec 030)', () => {
  it('restaurar a receita arquivada é de quem edita a caixa dela; o leitor recebe 403', async () => {
    const { s, editor, viewer } = await people();
    const agent = await aiAgent((await aiProvider()).id);
    const recipe = await editor.post('/api/reconcile-recipes', {
      caixaId: s.caixaA.id,
      agentId: agent.id,
      name: 'Tarifas',
      instruction: 'Ignore as tarifas.',
      accountIds: [s.accountA.id],
    });
    expect(await editor.del(`/api/reconcile-recipes/${recipe.id}`)).toEqual({ deleted: false, archived: true });
    expect(await status(viewer, 'POST', `/api/reconcile-recipes/${recipe.id}/restore`)).toBe(403);
    const restored = await editor.post(`/api/reconcile-recipes/${recipe.id}/restore`);
    expect(restored).toMatchObject({ id: recipe.id, archivedAt: null, isActive: true });
  });
});

/* ---------------- administração da IA ---------------- */

describe('administração da IA (specs 011 e 029)', () => {
  it('tarefa agendada pela visão do admin: ler, editar, histórico e excluir; quem não é admin recebe 403', async () => {
    const agent = await aiAgent((await aiProvider()).id);
    const ownerSession = await userSession(h);
    const owner = client(h, ownerSession.cookie);
    const task = await admin.post('/api/admin/ai/agent-tasks', {
      userId: ownerSession.id,
      agentId: agent.id,
      name: 'Resumo',
      instruction: 'Olá',
      schedule: { kind: 'daily', time: '06:00' },
    });
    for (const [method, url] of [
      ['GET', `/api/admin/ai/agent-tasks/${task.id}`],
      ['PATCH', `/api/admin/ai/agent-tasks/${task.id}`],
      ['GET', `/api/admin/ai/agent-tasks/${task.id}/runs`],
      ['DELETE', `/api/admin/ai/agent-tasks/${task.id}`],
    ] as const) {
      expect(await status(owner, method, url, method === 'PATCH' ? { name: 'x' } : undefined), `${method} ${url}`).toBe(403);
    }

    expect(await admin.get(`/api/admin/ai/agent-tasks/${task.id}`)).toMatchObject({ id: task.id, userId: ownerSession.id, name: 'Resumo' });
    const off = await admin.patch(`/api/admin/ai/agent-tasks/${task.id}`, { name: 'Resumo do dia', isActive: false });
    expect(off).toMatchObject({ name: 'Resumo do dia', isActive: false, nextRunAt: null });
    // O dono vê a edição do admin.
    expect((await owner.get(`/api/account/agent-tasks/${task.id}`)).name).toBe('Resumo do dia');
    expect(await admin.get(`/api/admin/ai/agent-tasks/${task.id}/runs`)).toEqual([]);
    expect(await admin.del(`/api/admin/ai/agent-tasks/${task.id}`)).toEqual({ deleted: true, archived: false });
    await admin.get(`/api/admin/ai/agent-tasks/${task.id}`, 404);
  });

  it('/mcp só aceita POST: GET e DELETE dão 401 sem a chave e 405 com ela (servidor sem sessão)', async () => {
    const user = client(h, (await userSession(h)).cookie);
    const created = await user.post('/api/account/api-tokens', { name: `MCP ${uid()}` });
    for (const method of ['GET', 'DELETE'] as const) {
      const anonymous = await h.app.inject({ method, url: '/mcp' });
      expect(anonymous.statusCode, method).toBe(401);
      const res = await h.app.inject({ method, url: '/mcp', headers: { authorization: `Bearer ${created.token}` } });
      expect(res.statusCode, method).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
    await user.del(`/api/account/api-tokens/${created.id}`);
  });

  it('excluir provedor (sem uso apaga, em uso por agente arquiva), preço e servidor MCP; quem não é admin recebe 403', async () => {
    const user = client(h, (await userSession(h)).cookie);
    const unused = await aiProvider();
    const used = await aiProvider();
    await aiAgent(used.id);
    expect(await status(user, 'DELETE', `/api/admin/ai/providers/${unused.id}`)).toBe(403);
    expect(await admin.del(`/api/admin/ai/providers/${unused.id}`)).toEqual({ deleted: true, archived: false });
    expect(await admin.del(`/api/admin/ai/providers/${used.id}`)).toEqual({ deleted: false, archived: true });
    const providers = await admin.get('/api/admin/ai/providers');
    expect(providers.map((p: any) => p.id)).not.toContain(unused.id);
    await admin.del(`/api/admin/ai/providers/${unused.id}`, 404);

    const price = await admin.post('/api/admin/ai/prices', {
      providerId: used.id,
      model: `modelo-${uid()}`,
      inputPricePerMillion: 1,
      outputPricePerMillion: 2,
    });
    expect(await status(user, 'DELETE', `/api/admin/ai/prices/${price.id}`)).toBe(403);
    expect(await admin.del(`/api/admin/ai/prices/${price.id}`)).toEqual({ deleted: true });
    await admin.del(`/api/admin/ai/prices/${price.id}`, 404);

    const secret = `Bearer segredo-${uid()}`;
    const server = await admin.post('/api/admin/ai/mcp-servers', {
      name: `MCP 126 ${uid()}`,
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: secret },
      isActive: false,
    });
    expect(JSON.stringify(await admin.get('/api/admin/ai/mcp-servers'))).not.toContain(secret);
    expect(await status(user, 'DELETE', `/api/admin/ai/mcp-servers/${server.id}`)).toBe(403);
    expect(await admin.del(`/api/admin/ai/mcp-servers/${server.id}`)).toEqual({ deleted: true, archived: false });
    expect((await admin.get('/api/admin/ai/mcp-servers')).map((m: any) => m.id)).not.toContain(server.id);
  });
});
