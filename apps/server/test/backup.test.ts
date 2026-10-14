import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatCnpj } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alphaCnpj, client, dropFreshDatabases, freshDatabase, type Harness, login, scenario, startApp, uid, userSession } from './helpers';

/*
 * Backup e restauração (spec 019): exportação com segredos, importação com
 * merge (já cadastrados ficam, conflitos não entram e voltam com o motivo),
 * simulação e o JSON completo importado num banco novo.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(async () => {
  await h.close();
  // Os bancos novos dos testes abaixo não ficam no servidor (banco externo).
  await dropFreshDatabases();
});

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

  it('capacidades e inferências vão no arquivo (sem os caches); arquivo antigo (embedding_model) migra como a 0041 (spec 024)', async () => {
    if (skip) return;
    const api = client(b, adminB.cookie);
    const provider = await api.post('/api/admin/ai/providers', {
      name: `Capacidades ${uid()}`,
      kind: 'openai',
      apiKey: `sk-${uid()}`,
      capabilities: ['text', 'vision', 'embeddings'],
      defaultModels: { text: 'gpt-x', embeddings: 'emb-x' },
    });
    const agent = await api.post('/api/admin/ai/agents', { name: `Inferências ${uid()}`, defaultProviderId: provider.id, model: 'gpt-x' });
    const full = await b.app.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: adminB.cookie } });
    expect(full.statusCode, full.body.slice(0, 300)).toBe(200);
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(full.rawPayload))['moneyflow.json']!));
    const providerRow = json.tables.ai_providers.find((p: any) => p.id === provider.id);
    expect(providerRow).toMatchObject({
      capabilities: ['text', 'vision', 'embeddings'],
      default_models: { text: 'gpt-x', embeddings: 'emb-x' },
    });
    expect(providerRow.embedding_model).toBeUndefined();
    const inferences = json.tables.ai_agent_inferences.filter((i: any) => i.agent_id === agent.id);
    expect(inferences.map((i: any) => i.capability).sort()).toEqual(['embeddings', 'vision']);
    expect(json.tables.ai_attachment_derivatives).toBeUndefined();
    expect(json.tables.ai_embedding_indexes).toBeUndefined();
    // Reimportar: as inferências já cadastradas ficam.
    const again = await importFile(b, adminB.cookie, 'full', {
      ...json,
      tables: { ai_providers: [providerRow], ai_agent_inferences: inferences },
    });
    expect(failures(again)).toEqual([]);
    expect(sum(again, 'ai_agent_inferences').imported).toBe(0);

    // Arquivo antigo: provedores sem as colunas novas, com embedding_model; agentes sem inferências.
    const { capabilities: _c, default_models: _d, prompt_cache_enabled: _p, thinking_enabled: _t, ...legacy } = providerRow;
    const embedder = { ...legacy, id: randomUUID(), name: `Antigo emb ${uid()}`, embedding_model: 'emb-antigo' };
    const compat = {
      ...legacy,
      id: randomUUID(),
      name: `Antigo compatível ${uid()}`,
      kind: 'anthropic',
      base_url: 'http://127.0.0.1:9',
      api_key: null,
      embedding_model: null,
    };
    const orphan = { ...compat, id: randomUUID(), name: `Antigo sem modelo ${uid()}` };
    const agentRow = json.tables.ai_agents.find((a: any) => a.id === agent.id);
    const oldAgent = { ...agentRow, id: randomUUID(), name: `Agente antigo ${uid()}`, provider_id: compat.id, model: 'claude-antigo' };
    const report = await importFile(b, adminB.cookie, 'full', {
      ...json,
      tables: { ai_providers: [embedder, compat, orphan], ai_agents: [oldAgent] },
      references: {},
    });
    // O compatível sem agente no arquivo não tem modelo de texto: volta como conflito, com o motivo.
    expect(failures(report).map((i) => i.id)).toEqual([orphan.id]);
    expect(failures(report)[0]!.reason).toContain('modelo de texto padrão');
    const providers = await api.get('/api/admin/ai/providers');
    expect(providers.find((p: any) => p.id === embedder.id)).toMatchObject({
      capabilities: ['text', 'vision', 'embeddings', 'transcription', 'speech'],
      defaultModels: { embeddings: 'emb-antigo' },
    });
    expect(providers.find((p: any) => p.id === compat.id)).toMatchObject({
      capabilities: ['text', 'vision'],
      defaultModels: { text: 'claude-antigo' },
      promptCacheEnabled: false,
      thinkingEnabled: false,
    });
    const agents = await api.get('/api/admin/ai/agents');
    expect(agents.find((a: any) => a.id === oldAgent.id).inferences.map((i: any) => [i.capability, i.providerId])).toEqual([
      ['vision', compat.id],
      ['embeddings', embedder.id],
    ]);
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

  it('sessão ativa única (spec 026): a importada que traria uma 2ª ativa do par entra finalizada; no arquivo antigo fica a mais recente', async () => {
    if (skip) return;
    const api = client(b, adminB.cookie);
    const provider = await api.post('/api/admin/ai/providers', {
      name: `Provedor sessões ${uid()}`,
      kind: 'openai',
      apiKey: `sk-${uid()}`,
    });
    const base = { systemPrompt: 'Sessões.', providerId: provider.id, model: 'gpt-x', isActive: true };
    const withActive = await api.post('/api/admin/ai/agents', { ...base, name: `Com ativa ${uid()}` });
    const withoutActive = await api.post('/api/admin/ai/agents', { ...base, name: `Sem ativa ${uid()}` });
    // No banco: a sessão ativa do admin com o 1º agente.
    const current = await api.post(`/api/agents/${withActive.id}/sessions`, {});

    const full = await b.app.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: adminB.cookie } });
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(full.rawPayload))['moneyflow.json']!));
    // Arquivo de antes da 0043: várias ativas do mesmo par e o pinned_at que saiu.
    const row = (agentId: string, lastMessageAt: string | null) => ({
      id: randomUUID(),
      user_id: adminB.id,
      agent_id: agentId,
      title: `Importada ${uid()}`,
      title_source: 'user',
      pinned_at: null,
      archived_at: null,
      last_message_at: lastMessageAt,
      created_at: '2026-01-01T12:00:00Z',
    });
    const conflicting = [row(withActive.id, '2026-05-01T12:00:00Z'), row(withActive.id, null)];
    const [older, newest, empty] = [
      row(withoutActive.id, '2026-02-01T12:00:00Z'),
      row(withoutActive.id, '2026-06-01T12:00:00Z'),
      row(withoutActive.id, null),
    ];
    const file = { ...json, tables: { ai_conversations: [...conflicting, older, newest, empty] }, references: {} };

    const report = await importFile(b, adminB.cookie, 'full', file);
    expect(failures(report)).toEqual([]);
    expect(sum(report, 'ai_conversations').imported).toBe(5);
    const states = await b.db.execute<{ id: string; archived: boolean; archived_reason: string | null }>(sql`
      SELECT id, archived_at IS NOT NULL AS archived, archived_reason FROM ai_conversations
       WHERE id = ANY (${`{${[current.id, ...conflicting.map((c) => c.id), older!.id, newest!.id, empty!.id].join(',')}}`}::uuid[])`);
    const state = new Map(states.rows.map((r) => [r.id, r.archived ? r.archived_reason : 'active']));
    // O banco já tinha a ativa do 1º agente: as importadas entram finalizadas.
    expect(state.get(current.id)).toBe('active');
    for (const c of conflicting) expect(state.get(c.id)).toBe('import_conflict');
    // Sem ativa no banco: fica ativa a de mensagem mais recente; as outras, finalizadas.
    expect(state.get(newest!.id)).toBe('active');
    expect(state.get(older!.id)).toBe('import_conflict');
    expect(state.get(empty!.id)).toBe('import_conflict');
    const threads = await api.get('/api/agents/threads');
    expect(threads.find((th: any) => th.agentId === withoutActive.id).active.id).toBe(newest!.id);
    expect(threads.find((th: any) => th.agentId === withoutActive.id).finishedCount).toBe(2);
  });

  it('kits de ferramentas: ida e volta com as tools e o agente apontando pelo nome; arquivo antigo (enabled_tools) vira kit', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const bApi = client(b, adminB.cookie);
    const tag = uid();
    const kit = await a.post('/api/admin/ai/tool-kits', {
      name: `Kit backup ${tag}`,
      description: 'Ida e volta',
      tools: [
        { name: 'list_caixas', mode: 'allow' },
        { name: 'create_title', mode: 'ask' },
      ],
    });
    const agent = await a.post('/api/admin/ai/agents', { name: `Agente kit ${tag}`, toolKitId: kit.id });

    const full = await h.app.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: adminA.cookie } });
    expect(full.statusCode, full.body.slice(0, 300)).toBe(200);
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(full.rawPayload))['moneyflow.json']!));
    const kitRow = json.tables.ai_tool_kits.find((r: any) => r.id === kit.id);
    const toolRows = json.tables.ai_tool_kit_tools.filter((r: any) => r.kit_id === kit.id);
    const agentRow = json.tables.ai_agents.find((r: any) => r.id === agent.id);
    expect(kitRow).toMatchObject({ name: kit.name, description: 'Ida e volta' });
    expect(toolRows.map((r: any) => `${r.tool_name}:${r.mode}`).sort()).toEqual(['create_title:ask', 'list_caixas:allow']);
    expect(agentRow.tool_kit_id).toBe(kit.id);
    const fileOf = (tables: Record<string, unknown[]>) => ({ ...json, tables, references: {} });

    const file = fileOf({ ai_tool_kits: [kitRow], ai_tool_kit_tools: toolRows, ai_agents: [agentRow] });
    const report = await importFile(b, adminB.cookie, 'full', file);
    expect(failures(report)).toEqual([]);
    expect(sum(report, 'ai_tool_kits').imported).toBe(1);
    expect(sum(report, 'ai_tool_kit_tools').imported).toBe(2);
    expect(sum(report, 'ai_agents').imported).toBe(1);
    const imported = await bApi.get(`/api/admin/ai/tool-kits/${kit.id}`);
    expect(imported).toMatchObject({ name: kit.name, tools: kit.tools, agents: [{ id: agent.id, name: agent.name, archived: false }] });
    // Reimportar não duplica: o kit e as tools (sem id) já existem.
    const again = await importFile(b, adminB.cookie, 'full', file);
    expect(failures(again)).toEqual([]);
    expect(sum(again, 'ai_tool_kits').existing).toBe(1);
    expect(sum(again, 'ai_tool_kit_tools').imported).toBe(0);

    // Outro id com o mesmo nome (outra caixa de letras) é o mesmo kit: o agente do arquivo aponta para o daqui.
    const otherKit = randomUUID();
    const otherAgent = randomUUID();
    const byName = await importFile(
      b,
      adminB.cookie,
      'full',
      fileOf({
        ai_tool_kits: [{ ...kitRow, id: otherKit, name: kit.name.toUpperCase() }],
        ai_tool_kit_tools: [{ ...toolRows[0], kit_id: otherKit, tool_name: 'end_series', mode: 'ask' }],
        ai_agents: [{ ...agentRow, id: otherAgent, name: `Outro agente ${tag}`, tool_kit_id: otherKit }],
      }),
    );
    expect(failures(byName)).toEqual([]);
    expect(issuesOf(byName, 'ai_tool_kits')[0]?.reason).toMatch(/nome/);
    // As tools do kit do arquivo não entram no kit que já existia.
    expect(sum(byName, 'ai_tool_kit_tools').skipped).toBe(1);
    expect((await bApi.get('/api/admin/ai/agents')).find((x: any) => x.id === otherAgent).toolKitId).toBe(kit.id);
    expect((await bApi.get(`/api/admin/ai/tool-kits/${kit.id}`)).tools).toEqual(kit.tools);

    // Arquivo de antes do kit (v0.1.7): enabled_tools/require_write_confirmation viram kit pela regra da migration 0038.
    const { tool_kit_id: _kit, ...legacyBase } = agentRow;
    const legacy = (name: string, enabled: string[] | null, confirm: boolean) => ({
      ...legacyBase,
      id: randomUUID(),
      name: `${name} ${tag}`,
      enabled_tools: enabled,
      require_write_confirmation: confirm,
    });
    const listed = legacy('Lista', ['list_caixas', 'create_title', 'send_telegram_message', 'nao_existe'], false);
    const confirming = legacy('Confirma', null, true);
    const free = legacy('Livre', null, false);
    const legacyReport = await importFile(b, adminB.cookie, 'full', fileOf({ ai_agents: [listed, confirming, free] }));
    expect(failures(legacyReport)).toEqual([]);
    expect(sum(legacyReport, 'ai_agents').imported).toBe(3);
    expect(sum(legacyReport, 'ai_tool_kits').imported).toBe(2);
    const agents = await bApi.get('/api/admin/ai/agents');
    const kitOf = async (id: string) => {
      const row = agents.find((x: any) => x.id === id);
      return row.toolKitId ? bApi.get(`/api/admin/ai/tool-kits/${row.toolKitId}`) : null;
    };
    const listedKit = await kitOf(listed.id);
    expect(listedKit.name).toBe(`Kit – ${listed.name}`);
    expect(listedKit.tools).toEqual([
      { name: 'list_caixas', mode: 'allow' },
      { name: 'create_title', mode: 'allow' },
      { name: 'send_telegram_message', mode: 'ask' },
    ]);
    const confirmingKit = await kitOf(confirming.id);
    expect(confirmingKit.tools).toHaveLength(49);
    const catalog = await bApi.get('/api/admin/ai/tools');
    for (const tool of confirmingKit.tools) {
      expect(tool.mode, tool.name).toBe(catalog.find((x: any) => x.name === tool.name).suggestedMode);
    }
    expect(await kitOf(free.id)).toBeNull();
  });

  it('prompt (spec 022): as versões do agente vão e voltam com números, notas e a restauração; arquivo sem versões ganha a 1', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const bApi = client(b, adminB.cookie);
    const tag = uid();
    const agent = await a.post('/api/admin/ai/agents', { name: `Versões ${tag}`, systemPrompt: 'v1 do prompt', promptNote: 'criação' });
    await a.patch(`/api/admin/ai/agents/${agent.id}`, { systemPrompt: 'v2 do prompt', promptNote: 'ajuste' });
    const first = (await a.get(`/api/admin/ai/agents/${agent.id}/prompt-versions`)).at(-1);
    await a.post(`/api/admin/ai/agents/${agent.id}/prompt-versions/${first.id}/restore`);
    const original = await a.get(`/api/admin/ai/agents/${agent.id}/prompt-versions`);
    expect(original.map((v: any) => v.version)).toEqual([3, 2, 1]);

    const full = await h.app.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: adminA.cookie } });
    expect(full.statusCode, full.body.slice(0, 300)).toBe(200);
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(full.rawPayload))['moneyflow.json']!));
    const agentRow = json.tables.ai_agents.find((r: any) => r.id === agent.id);
    const versionRows = json.tables.ai_agent_prompt_versions.filter((r: any) => r.agent_id === agent.id);
    expect(versionRows).toHaveLength(3);
    const fileOf = (tables: Record<string, unknown[]>) => ({ ...json, tables, references: {} });

    const report = await importFile(b, adminB.cookie, 'full', fileOf({ ai_agents: [agentRow], ai_agent_prompt_versions: versionRows }));
    expect(failures(report)).toEqual([]);
    expect(sum(report, 'ai_agent_prompt_versions').imported).toBe(3);
    const imported = await bApi.get(`/api/admin/ai/agents/${agent.id}/prompt-versions`);
    expect(imported.map((v: any) => [v.id, v.version, v.content, v.note, v.restoredFromVersionId])).toEqual(
      original.map((v: any) => [v.id, v.version, v.content, v.note, v.restoredFromVersionId]),
    );
    expect((await bApi.get('/api/admin/ai/agents')).find((x: any) => x.id === agent.id)).toMatchObject({
      systemPrompt: 'v1 do prompt',
      promptVersion: 3,
    });
    // Reimportar: o agente já existe aqui e fica com o histórico dele.
    const again = await importFile(b, adminB.cookie, 'full', fileOf({ ai_agents: [agentRow], ai_agent_prompt_versions: versionRows }));
    expect(failures(again)).toEqual([]);
    expect(sum(again, 'ai_agent_prompt_versions').imported).toBe(0);

    // Arquivo de antes das versões (v0.1.7): o banco cria a versão 1 com o prompt do agente.
    const legacy = { ...agentRow, id: randomUUID(), name: `Sem versões ${tag}`, system_prompt: 'prompt antigo' };
    const legacyReport = await importFile(b, adminB.cookie, 'full', fileOf({ ai_agents: [legacy] }));
    expect(failures(legacyReport)).toEqual([]);
    const legacyVersions = await bApi.get(`/api/admin/ai/agents/${legacy.id}/prompt-versions`);
    expect(legacyVersions.map((v: any) => [v.version, v.content])).toEqual([[1, 'prompt antigo']]);
  });

  it('as instruções de IA do usuário vão no recurso usuários; a caixa principal ausente vira nula', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const s = await scenario(h, a);
    const someone = await userSession(h);
    await a.put(`/api/users/${someone.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    await client(h, someone.cookie).put('/api/account/ai', { instructions: 'Minhas instruções de backup', primaryCaixaId: s.caixaA.id });

    const file = await exportJson(h, adminA.cookie, 'users');
    expect(file.tables.user_ai_settings.find((r: any) => r.user_id === someone.id)).toMatchObject({
      instructions: 'Minhas instruções de backup',
      primary_caixa_id: s.caixaA.id,
    });
    const report = await importFile(b, adminB.cookie, 'users', file);
    expect(issuesOf(report, 'user_ai_settings', 'failed')).toEqual([]);
    expect(await client(b, adminB.cookie).get(`/api/users/${someone.id}/ai`)).toMatchObject({
      instructions: 'Minhas instruções de backup',
      primaryCaixaId: null,
    });
    const again = await importFile(b, adminB.cookie, 'users', file);
    expect(sum(again, 'user_ai_settings').imported).toBe(0);
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

  it('entidade casa pelo CNPJ alfanumérico (cadastrado em minúsculas e pontuado nos dois sistemas)', async () => {
    if (skip) return;
    const adminA = await userSession(h, 'admin');
    const a = client(h, adminA.cookie);
    const cnpj = alphaCnpj();
    const typed = formatCnpj(cnpj).toLowerCase();
    const source = await a.post('/api/entities', { kind: 'company', name: `Alfa no A ${uid()}`, document: typed });
    const target = await client(b, adminB.cookie).post('/api/entities', { kind: 'company', name: `Alfa no B ${uid()}`, document: typed });
    expect(source.id).not.toBe(target.id);

    const entities = await exportJson(h, adminA.cookie, 'entities');
    const row = entities.tables.entities.find((e: any) => e.id === source.id);
    expect(row.document).toBe(cnpj);
    const report = await importFile(b, adminB.cookie, 'entities', { ...entities, tables: { entities: [row] } });
    expect(issuesOf(report, 'entities').find((i) => i.id === source.id)?.reason).toMatch(/mesmo documento/);
    expect(sum(report, 'entities').imported).toBe(0);
    expect((await client(b, adminB.cookie).get(`/api/entities/${target.id}`)).name).toBe(target.name);
    await client(b, adminB.cookie).get(`/api/entities/${source.id}`, 404);
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
