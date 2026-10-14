import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { type FakeMcp, startFakeMcp } from './fakes/fake-mcp';
import { client, type Harness, newSession, scenario, startApp, uid, userSession } from './helpers';

/*
 * Tools de controle total, lote F13b (spec 027), com o provedor falso:
 * configuração de IA, usuários e permissões, backup, fechamento e auditoria,
 * mensagens e tags de entidade. Para cada tool, a prévia, a execução, a
 * permissão negada (viewer, não admin) e a tool de admin ausente para quem não
 * é admin. Segredos: digitados no cartão (na decisão), executados pela API,
 * nunca no schema enviado ao modelo, e o valor não aparece em ai_messages,
 * ai_run_events, ai_tool_confirmations, audit_log nem ai_requests.
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let mcp: FakeMcp;
let telegram: Server;
const telegramCalls: string[] = [];
type Api = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof userSession>>;
let adminSession: Session;
let admin: Api;
let viewerSession: Session;
let editorSession: Session;
let agent: { id: string };
let s: Awaited<ReturnType<typeof scenario>>;

/** Todos os segredos digitados nos cartões deste arquivo (conferidos no fim). */
const typedSecrets: string[] = [];
const secret = (label: string) => {
  const value = `${label}-SEGREDO-${uid()}-${uid()}`;
  typedSecrets.push(value);
  return value;
};
const botToken = () => {
  const value = `${100000 + Math.floor(Math.random() * 800000)}:AAF${uid().replace(/[^A-Za-z0-9]/g, '')}Zx${uid().replace(/[^A-Za-z0-9]/g, '')}`;
  typedSecrets.push(value);
  return value;
};

async function drain() {
  for (let i = 0; i < 50; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

async function upload(session: Session, conversationId: string, name: string, mime: string, data: Buffer): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/attachments?fileName=${encodeURIComponent(name)}`,
    payload: data,
    headers: { cookie: session.cookie, 'content-type': mime },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id;
}

type CallOptions = {
  /** false = deixa a confirmação pendente (só a prévia). */
  approve?: boolean;
  /** Segredos digitados no cartão (campo → valor). */
  secrets?: Record<string, string>;
  /** Continua numa sessão existente (senão abre uma nova). */
  conversationId?: string;
  files?: { name: string; mime: string; data: Buffer }[];
};

/** "chamar <tool> <json>": o provedor falso chama a tool pedida. Devolve a prévia e o resultado para o modelo. */
async function call(session: Session, name: string, input: Record<string, unknown> | ((ids: string[]) => any), opts: CallOptions = {}) {
  const api = client(h, session.cookie);
  const conversationId = opts.conversationId ?? (await newSession(api, agent.id)).id;
  const ids: string[] = [];
  for (const file of opts.files ?? []) ids.push(await upload(session, conversationId, file.name, file.mime, file.data));
  const body = typeof input === 'function' ? input(ids) : input;
  const sent = await api.post(`/api/conversations/${conversationId}/messages`, {
    text: `chamar ${name} ${JSON.stringify(body)}`,
    attachmentIds: ids,
  });
  await drain();
  let detail = await api.get(`/api/conversations/${conversationId}`);
  const confirmation = detail.confirmations.find((c: any) => c.status === 'pending');
  if (confirmation && opts.approve !== false) {
    await api.post(`/api/runs/${sent.run.id}/confirmations`, {
      decision: 'approved',
      ...(opts.secrets ? { secrets: { [confirmation.id]: opts.secrets } } : {}),
    });
    await drain();
    detail = await api.get(`/api/conversations/${conversationId}`);
  }
  const toolMessage = detail.messages.filter((m: any) => m.role === 'tool').at(-1);
  const result = toolMessage?.content[0];
  return {
    conversationId,
    runId: sent.run.id as string,
    confirmation,
    preview: confirmation?.preview,
    toolMessageId: toolMessage?.id as string | undefined,
    error: result?.is_error ? (result.content as string) : null,
    value: result && !result.is_error ? parseResult(result.content) : null,
    raw: (result?.content ?? '') as string,
  };
}

/** Resultado para o modelo (o banco de teste compartilhado pode passar do limite e vir truncado: aí, o texto). */
function parseResult(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

const approved = async (
  session: Session,
  name: string,
  input: Record<string, unknown> | ((ids: string[]) => any),
  opts: CallOptions = {},
) => {
  const out = await call(session, name, input, opts);
  expect(out.error, out.error ?? '').toBeNull();
  expect(out.preview, `${name} sem prévia`).toBeTruthy();
  return out;
};

const rowsOf = (preview: any): Record<string, string> =>
  Object.fromEntries(
    preview.rows.map((r: any) => [r.label, (r.before !== undefined ? `${r.before} → ${r.after}` : String(r.after)).replace(/ /g, ' ')]),
  );

async function auditActor(table: string, recordId: string) {
  const r = await h.db.execute<{ actor_kind: string; agent_run_id: string | null }>(
    sql`SELECT actor_kind, agent_run_id FROM audit_log WHERE table_name = ${table} AND record_id = ${recordId} ORDER BY id DESC LIMIT 1`,
  );
  return r.rows[0];
}

/** Leitores dos segredos do admin (os mesmos do export do backup). */
async function readSecret(fn: string, id: string): Promise<unknown> {
  const r = await h.db.execute<{ v: unknown }>(sql`SELECT ${sql.raw(fn)}(${id}::uuid, ${adminSession.id}::uuid) AS v`);
  return r.rows[0]?.v ?? null;
}

const notOffered = (name: string) => `Tool desconhecida ou não habilitada: ${name}`;

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  telegram = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      telegramCalls.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: telegramCalls.length } }));
    });
  });
  await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
  const port = (telegram.address() as AddressInfo).port;
  h = await startApp({ TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_TIMEOUT_MS: '3000' });
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  viewerSession = await userSession(h);
  editorSession = await userSession(h);
  const provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F13b ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-f13b',
    defaultModels: { text: 'claude-sonnet-5-5' },
    // Corpos registrados: o teste confere que nenhum segredo chega às Requisições.
    logBodies: true,
  });
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  const kit = await admin.post('/api/admin/ai/tool-kits', {
    name: `F13b ${uid()}`,
    tools: catalog.map((tool) => ({ name: tool.name, mode: tool.suggestedMode })),
  });
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente F13b ${uid()}`,
    systemPrompt: 'Testes das tools de administração.',
    defaultProviderId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 2000, max_tool_iterations: 4 },
    toolKitId: kit.id,
    isActive: true,
  });
  s = await scenario(h, admin);
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerSession.id, role: 'viewer' });
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editorSession.id, role: 'editor' });
  mcp = await startFakeMcp('token-do-mcp-f13b');
});

afterAll(async () => {
  for (const a of await admin.get('/api/admin/ai/agents'))
    if (a.isActive) await admin.patch(`/api/admin/ai/agents/${a.id}`, { isActive: false });
  await h.close();
  await llm.close();
  await mcp.close();
  await new Promise((resolve) => telegram.close(resolve));
});

const toolsSent = () =>
  llm.calls.filter((c) => c.path === '/v1/messages' && Array.isArray(c.body.tools) && c.body.tools.length > 0).at(-1)!.body.tools as {
    name: string;
    input_schema: { properties: Record<string, unknown> };
  }[];

describe('registro, oferta e /mcp (spec 027)', () => {
  it('categorias novas; segredo fora do schema; as de admin não chegam a quem não é admin; /mcp sem segredo nem arquivo', async () => {
    const catalog: any[] = await admin.get('/api/admin/ai/tools');
    expect(catalog.find((x) => x.name === 'create_ai_provider')).toMatchObject({
      category: 'ai',
      adminOnly: true,
      secret: true,
      suggestedMode: 'ask',
    });
    expect(catalog.find((x) => x.name === 'set_user_password')).toMatchObject({ category: 'users', secret: true });
    expect(catalog.find((x) => x.name === 'export_backup')).toMatchObject({ category: 'backup', adminOnly: true });
    expect(catalog.find((x) => x.name === 'close_month')).toMatchObject({ category: 'closing', adminOnly: false, destructive: false });
    expect(catalog.find((x) => x.name === 'reopen_month')).toMatchObject({ category: 'closing', adminOnly: true, destructive: true });
    expect(catalog.find((x) => x.name === 'revoke_api_token')).toMatchObject({ category: 'users', adminOnly: false, destructive: true });
    expect(catalog.find((x) => x.name === 'import_backup')).toMatchObject({ destructive: true, adminOnly: true });

    await call(adminSession, 'list_users', { limit: 1 });
    const forAdmin = toolsSent();
    const schema = (name: string) => forAdmin.find((x) => x.name === name)!.input_schema.properties;
    // O campo de segredo não existe no schema enviado ao modelo.
    expect(Object.keys(schema('create_ai_provider'))).not.toContain('apiKey');
    expect(Object.keys(schema('update_ai_provider').changes as any)).not.toContain('apiKey');
    expect(Object.keys(schema('create_message_destination'))).not.toContain('botToken');
    expect(Object.keys(schema('set_user_password'))).toEqual(['userId']);
    expect(Object.keys(schema('create_user'))).not.toContain('password');
    expect(Object.keys(schema('create_mcp_server'))).not.toContain('headers');

    await call(viewerSession, 'list_notifications', {});
    const forViewer = toolsSent().map((x) => x.name);
    expect(forViewer).toEqual(
      expect.arrayContaining(['close_month', 'list_notifications', 'list_api_tokens', 'create_message_destination']),
    );
    for (const name of ['create_ai_provider', 'list_users', 'export_backup', 'reopen_month', 'create_entity_tag', 'set_caixa_member'])
      expect(forViewer).not.toContain(name);
    for (const name of [
      'list_users',
      'create_ai_provider',
      'create_tool_kit',
      'export_backup',
      'import_backup',
      'reopen_month',
      'archive_entity_tag',
    ]) {
      expect((await call(viewerSession, name, {})).error, name).toBe(notOffered(name));
    }

    // /mcp: as de segredo e as que geram arquivo nunca; as de admin só com token de admin.
    const tokenOf = async (session: Session) =>
      (await client(h, session.cookie).post('/api/account/api-tokens', { name: `MCP ${uid()}`, expiresInDays: 1 })).token;
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const listFor = async (token: string) => {
      const mcpClient = new Client({ name: 'teste-f13b', version: '1.0.0' });
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );
      try {
        return (await mcpClient.listTools()).tools.map((x) => x.name);
      } finally {
        await mcpClient.close();
      }
    };
    const adminTools = await listFor(await tokenOf(adminSession));
    expect(adminTools).toEqual(
      expect.arrayContaining(['list_users', 'create_tool_kit', 'simulate_import', 'import_backup', 'reopen_month']),
    );
    for (const name of [
      'create_ai_provider',
      'update_ai_provider',
      'set_user_password',
      'create_user',
      'create_message_destination',
      'create_mcp_server',
      'export_backup',
    ])
      expect(adminTools, name).not.toContain(name);
    const userTools = await listFor(await tokenOf(viewerSession));
    expect(userTools).toEqual(expect.arrayContaining(['close_month', 'list_api_tokens', 'revoke_api_token']));
    for (const name of ['list_users', 'reopen_month', 'create_tool_kit', 'import_backup']) expect(userTools).not.toContain(name);
  });
});

describe('tags de entidade (admin)', () => {
  it('criar, editar e arquivar; prévia e auditoria do agente', async () => {
    const created = await approved(adminSession, 'create_entity_tag', { name: `VIP ${uid()}`.slice(0, 40), colorSlot: 3 });
    expect(rowsOf(created.preview)).toMatchObject({ Cor: 'Cor 3' });
    const tagId = created.value.id;
    expect(await auditActor('entity_tags', tagId)).toEqual({ actor_kind: 'agent', agent_run_id: created.runId });
    const updated = await approved(adminSession, 'update_entity_tag', { tagId, changes: { colorSlot: 5 } });
    expect(rowsOf(updated.preview)).toEqual({ Cor: 'Cor 3 → Cor 5' });
    await admin.patch(`/api/entities/${s.supplier.id}`, { tagIds: [tagId] });
    const archived = await approved(adminSession, 'archive_entity_tag', { tagId });
    expect(archived.preview.warnings[0]).toContain('Em uso');
    expect(archived.value).toEqual({ deleted: false, archived: true });
    expect((await call(adminSession, 'archive_entity_tag', { tagId })).error).toBe('O registro já está arquivado.');
  });
});

describe('mensagens', () => {
  it('destino com o token digitado no cartão (write-only), assinaturas, teste e notificações; viewer negado', async () => {
    // Viewer: destino da caixa que só lê.
    expect(
      (await call(viewerSession, 'create_message_destination', { name: 'X', ownerKind: 'caixa', ownerCaixaId: s.caixaA.id, chatId: '123' }))
        .error,
    ).toBe('Você só tem leitura nesta caixa.');

    // Sem o token (campo obrigatório vazio): não cria.
    const missing = await call(adminSession, 'create_message_destination', { name: `Sem token ${uid()}`, chatId: '12345' });
    expect(missing.preview.secretFields).toEqual([expect.objectContaining({ key: 'botToken', label: 'Token do bot', required: true })]);
    expect(missing.error).toBe('Informe Token do bot no cartão de aprovação.');

    const token1 = botToken();
    const created = await approved(
      adminSession,
      'create_message_destination',
      { name: `Grupo ${uid()}`, ownerKind: 'caixa', ownerCaixaId: s.caixaA.id, chatId: '-100123' },
      { secrets: { botToken: token1 } },
    );
    expect(rowsOf(created.preview)).toMatchObject({ Dono: 'Da caixa', 'Token do bot': 'digitado no cartão' });
    const destinationId = created.value.id;
    expect(created.value.secrets).toEqual({ 'Token do bot': 'segredo definido' });
    expect(await readSecret('admin_message_destination_token', destinationId)).toBe(token1);
    expect(await auditActor('message_destinations', destinationId)).toEqual({ actor_kind: 'agent', agent_run_id: created.runId });

    // Editar sem digitar: o token fica; digitando: troca.
    const kept = await approved(adminSession, 'update_message_destination', { destinationId, changes: { chatId: '-100999' } });
    expect(rowsOf(kept.preview)).toEqual({ Chat: '-100123 → -100999' });
    expect(kept.value.secrets).toEqual({ 'Token do bot': 'segredo mantido (campo vazio)' });
    expect(await readSecret('admin_message_destination_token', destinationId)).toBe(token1);
    const token2 = botToken();
    await approved(adminSession, 'update_message_destination', { destinationId, changes: {} }, { secrets: { botToken: token2 } });
    expect(await readSecret('admin_message_destination_token', destinationId)).toBe(token2);

    const subs = await approved(adminSession, 'set_message_subscriptions', {
      destinationId,
      subscriptions: [{ eventKind: 'invoice_closed' }, { eventKind: 'overdue', params: { send_at: '09:00', repeat_every_days: 2 } }],
    });
    expect(Object.keys(rowsOf(subs.preview))).toHaveLength(2);
    expect(subs.value.map((x: any) => x.eventKind).sort()).toEqual(['invoice_closed', 'overdue']);
    const removed = await approved(adminSession, 'set_message_subscriptions', { destinationId, remove: ['overdue'] });
    expect(removed.value.map((x: any) => x.eventKind)).toEqual(['invoice_closed']);
    expect((await call(viewerSession, 'list_message_subscriptions', { destinationId })).value).toHaveLength(1);
    expect((await call(viewerSession, 'send_test_message', { destinationId })).error).toBe('Você não tem permissão para esta ação.');

    const sent = await approved(adminSession, 'send_test_message', { destinationId });
    expect(sent.preview).toMatchObject({ action: 'send' });
    expect(sent.value.status).toBe('sent');
    // O envio usou o token digitado no cartão.
    expect(telegramCalls.at(-1)).toContain(`/bot${token2}/sendMessage`);

    const notifications = await call(viewerSession, 'list_notifications', { unread: false, limit: 5 });
    expect(notifications.value).toHaveProperty('items');

    const archived = await approved(adminSession, 'archive_message_destination', { destinationId });
    expect(archived.value).toEqual({ deleted: false, archived: true });
  });
});

describe('fechamento e auditoria', () => {
  it('quem edita fecha; só o admin reabre; viewer negado; histórico do registro', async () => {
    expect((await call(viewerSession, 'close_month', { caixaId: s.caixaA.id, month: '2031-05' })).error).toBe(
      'Você só tem leitura nesta caixa.',
    );
    const closed = await approved(editorSession, 'close_month', { caixaId: s.caixaA.id, month: '2031-05', notes: 'conferido' });
    expect(rowsOf(closed.preview)).toMatchObject({ Mês: 'Aberto → Fechado', Observações: 'conferido' });
    expect(closed.value.closings.map((c: any) => c.month)).toContain('2031-05-01');
    expect((await call(editorSession, 'close_month', { caixaId: s.caixaA.id, month: '2031-05' })).error).toBe(
      'Este mês já está fechado nesta caixa.',
    );
    expect((await call(viewerSession, 'list_month_closings', { caixaId: s.caixaA.id })).value.closings).toHaveLength(1);
    expect((await call(editorSession, 'reopen_month', { caixaId: s.caixaA.id, month: '2031-05' })).error).toBe(notOffered('reopen_month'));
    const reopened = await approved(adminSession, 'reopen_month', { caixaId: s.caixaA.id, month: '2031-05' });
    expect(reopened.preview).toMatchObject({ action: 'delete' });
    expect(reopened.value.closings).toHaveLength(0);

    const history = await call(viewerSession, 'get_audit_history', { table: 'caixas', recordId: s.caixaA.id });
    expect(history.value.length).toBeGreaterThan(0);
    expect((await call(viewerSession, 'get_audit_history', { table: 'caixas', recordId: s.caixaB.id })).error).toBe(
      'Registro não encontrado.',
    );
  });
});

describe('usuários e permissões', () => {
  it('criar com a senha do cartão, editar, ativar, trocar a senha, acesso à caixa e tokens', async () => {
    const username = `agente-${uid()}`.slice(0, 30).toLowerCase();
    const password1 = secret('senha');
    const created = await approved(
      adminSession,
      'create_user',
      { username, email: `${username}@teste.local`, role: 'user' },
      { secrets: { password: password1 } },
    );
    expect(created.preview.secretFields).toEqual([expect.objectContaining({ key: 'password', required: true })]);
    expect(rowsOf(created.preview)).toMatchObject({ Login: username, Papel: 'Usuário', Senha: 'digitada no cartão' });
    const userId = created.value.id;
    const login = async (password: string) =>
      (await h.db.execute<{ id: string | null }>(sql`SELECT auth_login(${username}, ${password}) AS id`)).rows[0]?.id;
    expect(await login(password1)).toBe(userId);

    // Senha curta: o serviço recusa (o erro não traz o valor).
    const short = await call(adminSession, 'set_user_password', { userId }, { secrets: { password: '123' } });
    expect(short.error).toMatch(/^Entrada inválida para a tool: password/);
    const password2 = secret('nova');
    const changed = await approved(adminSession, 'set_user_password', { userId }, { secrets: { password: password2 } });
    expect(changed.value).toEqual({ id: userId, username, secrets: { Senha: 'segredo definido' } });
    expect(await login(password2)).toBe(userId);
    expect(await login(password1)).toBeNull();

    const edited = await approved(adminSession, 'update_user', { userId, changes: { role: 'admin' } });
    expect(rowsOf(edited.preview)).toEqual({ Papel: 'Usuário → Administrador' });
    const off = await approved(adminSession, 'set_user_active', { userId, active: false });
    expect(rowsOf(off.preview)).toEqual({ Ativo: 'Sim → Não' });
    expect(off.value.isActive).toBe(false);
    expect((await call(adminSession, 'set_user_active', { userId: adminSession.id, active: false })).error).toBe(
      'Você não pode desativar o próprio usuário.',
    );
    expect((await call(adminSession, 'list_users', { q: username })).value.map((u: any) => u.id)).toEqual([userId]);

    const member = await approved(adminSession, 'set_caixa_member', { caixaId: s.caixaB.id, userId, role: 'viewer' });
    expect(member.preview).toMatchObject({ title: 'Dar acesso à caixa', action: 'create' });
    const promoted = await approved(adminSession, 'set_caixa_member', { caixaId: s.caixaB.id, userId, role: 'editor' });
    expect(rowsOf(promoted.preview)).toEqual({ Papel: 'Leitor (só lê) → Editor (lê e escreve)' });
    expect(
      (await call(adminSession, 'list_caixa_members', { caixaId: s.caixaB.id })).value.find((m: any) => m.userId === userId).role,
    ).toBe('editor');
    const removed = await approved(adminSession, 'remove_caixa_member', { caixaId: s.caixaB.id, userId });
    expect(removed.value.find((m: any) => m.userId === userId)).toBeUndefined();
    // O viewer vê os membros da caixa que lê, mas não muda acessos.
    expect((await call(viewerSession, 'list_caixa_members', { caixaId: s.caixaA.id })).value.length).toBeGreaterThan(0);
    expect((await call(viewerSession, 'set_caixa_member', { caixaId: s.caixaA.id, userId, role: 'viewer' })).error).toBe(
      notOffered('set_caixa_member'),
    );

    // Tokens: os do próprio usuário (sem ser admin).
    const viewerApi = client(h, viewerSession.cookie);
    const token = await viewerApi.post('/api/account/api-tokens', { name: 'Para revogar', expiresInDays: 1 });
    expect((await call(viewerSession, 'list_api_tokens', {})).value.map((x: any) => x.id)).toContain(token.id);
    expect((await call(adminSession, 'revoke_api_token', { tokenId: token.id })).error).toBe('Registro não encontrado.');
    const revoked = await approved(viewerSession, 'revoke_api_token', { tokenId: token.id });
    expect(rowsOf(revoked.preview)).toEqual({ Situação: 'Ativo → Revogado' });
    expect(revoked.value.revokedAt).not.toBeNull();
    // Nenhuma tool cria token (o valor apareceria ao modelo).
    expect((await call(viewerSession, 'create_api_token', { name: 'x' })).error).toBe(notOffered('create_api_token'));
  });
});

describe('configuração de IA', () => {
  it('provedor com a chave do cartão, testar, modelos, preços, agentes, kits, MCP com cabeçalho secreto, configurações, uso e requisições', async () => {
    const key1 = secret('sk-ant');
    const created = await approved(
      adminSession,
      'create_ai_provider',
      { name: `Prov ${uid()}`, kind: 'anthropic', baseUrl: llm.url, defaultModels: { text: 'claude-sonnet-5-5' }, logBodies: true },
      { secrets: { apiKey: key1 } },
    );
    expect(created.preview.secretFields).toEqual([expect.objectContaining({ key: 'apiKey', required: false })]);
    expect(rowsOf(created.preview)).toMatchObject({ Tipo: 'Anthropic', 'Chave da API': 'digitada no cartão' });
    const providerId = created.value.id;
    expect(created.value.apiKeyHint).toBe(`…${key1.slice(-4)}`);
    expect(await readSecret('admin_ai_provider_api_key', providerId)).toBe(key1);

    // Testar e listar modelos usam a chave gravada (o cabeçalho vai ao provedor, nunca ao registro).
    const before = llm.calls.length;
    const tested = await call(adminSession, 'test_provider', { providerId });
    expect(tested.value.ok, JSON.stringify(tested.value)).toBe(true);
    expect(llm.calls.slice(before).some((c) => c.headers['x-api-key'] === key1)).toBe(true);
    expect((await call(adminSession, 'list_provider_models', { providerId })).value.models.length).toBeGreaterThan(0);

    const kept = await approved(adminSession, 'update_ai_provider', { providerId, changes: { notes: 'sem trocar a chave' } });
    expect(kept.value.secrets).toEqual({ 'Chave da API': 'segredo mantido (campo vazio)' });
    expect(await readSecret('admin_ai_provider_api_key', providerId)).toBe(key1);
    const key2 = secret('sk-ant-novo');
    const swapped = await approved(adminSession, 'update_ai_provider', { providerId, changes: {} }, { secrets: { apiKey: key2 } });
    expect(swapped.value.secrets).toEqual({ 'Chave da API': 'segredo definido' });
    expect(await readSecret('admin_ai_provider_api_key', providerId)).toBe(key2);
    const cleared = await approved(adminSession, 'update_ai_provider', { providerId, changes: { clearApiKey: true } });
    expect(cleared.preview.secretFields).toBeUndefined();
    expect(rowsOf(cleared.preview)['Chave da API']).toBe(`…${key2.slice(-4)} → apagada`);
    expect(await readSecret('admin_ai_provider_api_key', providerId)).toBeNull();

    // Preços.
    const price = await approved(adminSession, 'create_ai_price', {
      providerId,
      model: 'claude-sonnet-5-5',
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
    });
    expect(rowsOf(price.preview)).toMatchObject({ 'Entrada (por milhão)': '3', 'Saída (por milhão)': '15' });
    expect((await call(adminSession, 'list_ai_prices', {})).value.map((p: any) => p.id)).toContain(price.value.id);
    const priceGone = await approved(adminSession, 'delete_ai_price', { priceId: price.value.id });
    expect(priceGone.value).toEqual({ deleted: true });

    // Kits: o "só de leitura" a partir do catálogo.
    const reads = (await call(adminSession, 'list_agent_tools', { kind: 'read' })).value as any[];
    expect(reads.every((x) => x.kind === 'read')).toBe(true);
    const kit = await approved(adminSession, 'create_tool_kit', {
      name: `Só leitura ${uid()}`,
      tools: reads.map((x) => ({ name: x.name, mode: 'allow' })),
    });
    expect(rowsOf(kit.preview).Ferramentas).toBe(String(reads.length));
    const kitId = kit.value.id;
    expect((await call(adminSession, 'create_tool_kit', { name: 'X', tools: [{ name: 'nao_existe', mode: 'allow' }] })).error).toBe(
      notOffered('nao_existe'),
    );
    const renamed = await approved(adminSession, 'update_tool_kit', {
      kitId,
      changes: { tools: [...reads.map((x) => ({ name: x.name, mode: 'allow' })), { name: 'create_entity', mode: 'ask' }] },
    });
    expect(rowsOf(renamed.preview)).toMatchObject({ Entram: 'create_entity' });
    const copy = await approved(adminSession, 'duplicate_tool_kit', { kitId });
    expect(copy.value.name).toBe(`Cópia de ${kit.value.name}`);

    // Agentes.
    const newAgent = await approved(adminSession, 'create_ai_agent', {
      name: `Ag ${uid()}`,
      systemPrompt: 'Ajude.',
      defaultProviderId: providerId,
      model: 'claude-sonnet-5-5',
      toolKitId: kitId,
    });
    expect(rowsOf(newAgent.preview)).toMatchObject({ Provedor: created.value.name, 'Kit de ferramentas': kit.value.name });
    const agentId = newAgent.value.id;
    const promptChanged = await approved(adminSession, 'update_ai_agent', {
      agentId,
      changes: { systemPrompt: 'Ajude com calma.', promptNote: 'tom', toolKitId: copy.value.id },
    });
    expect(promptChanged.preview.warnings).toContain('O prompt muda criando a versão 2.');
    expect(rowsOf(promptChanged.preview)['Kit de ferramentas']).toBe(`${kit.value.name} → ${copy.value.name}`);
    expect(promptChanged.value.promptVersion).toBe(2);
    expect((await call(adminSession, 'delete_tool_kit', { kitId: copy.value.id })).error).toContain('O kit está em uso');
    expect((await approved(adminSession, 'delete_tool_kit', { kitId })).value).toEqual({ deleted: true });
    const agentGone = await approved(adminSession, 'archive_ai_agent', { agentId });
    expect(agentGone.value).toEqual({ deleted: true, archived: false });
    const providerGone = await approved(adminSession, 'archive_ai_provider', { providerId });
    expect(providerGone.value.deleted || providerGone.value.archived).toBe(true);

    // MCP: o valor do cabeçalho vem do cartão; atualizar as tools prova que ele foi gravado.
    const header = 'Bearer token-do-mcp-f13b';
    typedSecrets.push(header);
    const server = await approved(
      adminSession,
      'create_mcp_server',
      { name: `MCP ${uid()}`, url: mcp.url, secretHeaderNames: ['Authorization'], instructionsMode: 'system' },
      { secrets: { 'header:Authorization': header } },
    );
    expect(server.preview.secretFields).toEqual([
      expect.objectContaining({ key: 'header:Authorization', label: 'Cabeçalho Authorization' }),
    ]);
    expect(server.value.headerNames).toEqual(['Authorization']);
    const serverId = server.value.id;
    const refreshed = await call(adminSession, 'refresh_mcp_tools', { serverId });
    expect(refreshed.preview).toBeUndefined();
    expect(refreshed.value.tools.map((x: any) => x.name).sort()).toEqual(['create_ticket', 'echo']);
    expect(mcp.authHeaders.at(-1)).toBe(header);
    const mcpEdited = await approved(adminSession, 'update_mcp_server', {
      serverId,
      changes: { instructionsMode: 'user', removeHeaders: ['Authorization'] },
    });
    expect(rowsOf(mcpEdited.preview)).toMatchObject({
      'Instruções do servidor': 'No prompt de sistema → Bloco do usuário',
      'Cabeçalhos a remover': 'Authorization',
    });
    expect(mcpEdited.value.headerNames).toEqual([]);
    expect((await approved(adminSession, 'archive_mcp_server', { serverId })).value).toEqual({ deleted: true, archived: false });

    // Configurações, uso e requisições (só metadados).
    const settings = (await call(adminSession, 'get_app_settings', {})).value;
    expect(settings[0]).toMatchObject({ key: 'ai.request_retention_days' });
    const set = await approved(adminSession, 'set_app_setting', { key: 'ai.request_retention_days', value: 45 });
    expect(set.value).toMatchObject({ value: 45, source: 'database' });
    const reset = await approved(adminSession, 'set_app_setting', { key: 'ai.request_retention_days', value: null });
    expect(reset.value.source).toBe('env');
    const usage = await call(adminSession, 'get_ai_usage', { from: '2031-01' });
    expect(usage.error).toBeNull();
    expect(usage.raw).toContain('"byAgent"');
    const requests = (await call(adminSession, 'list_ai_requests', { limit: 5 })).value;
    expect(requests.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).not.toContain('request_body');
    expect(requests.items[0]).not.toHaveProperty('requestBody');
  });
});

describe('backup (admin)', () => {
  it('exporta como anexo da sessão, simula e importa a partir do anexo; o conteúdo do backup não vai ao modelo', async () => {
    const exported = await approved(adminSession, 'export_backup', { what: 'categories' });
    expect(exported.preview.warnings[0]).toContain('leva as chaves');
    expect(exported.value.file).toMatchObject({ mime: 'application/json' });
    expect(exported.value.file.fileName).toMatch(/^moneyflow-categories-\d{8}-\d{4}\.json$/);
    const attachmentId = exported.value.file.attachmentId;
    // O arquivo é anexo da mensagem da tool (sessão do agente) e o admin o baixa.
    const linked = await h.db.execute(
      sql`SELECT 1 FROM ai_message_attachments WHERE message_id = ${exported.toolMessageId} AND attachment_id = ${attachmentId}`,
    );
    expect(linked.rows).toHaveLength(1);
    const download = await h.app.inject({
      method: 'GET',
      url: `/api/attachments/${attachmentId}/download`,
      headers: { cookie: adminSession.cookie },
    });
    expect(download.statusCode).toBe(200);
    const content = download.rawPayload;
    expect(JSON.parse(content.toString('utf8'))).toMatchObject({ format: 'moneyflow-backup', kind: 'categories' });

    // Na mesma sessão, o arquivo gerado serve de entrada.
    const simulated = await call(adminSession, 'simulate_import', { attachmentId }, { conversationId: exported.conversationId });
    expect(simulated.preview).toBeUndefined();
    expect(simulated.value).toMatchObject({ kind: 'categories', dryRun: true });
    // Noutra sessão, não.
    expect((await call(adminSession, 'simulate_import', { attachmentId })).error).toBe(
      'O anexo não é desta sessão: use um arquivo enviado nesta conversa.',
    );

    // Um backup enviado no chat: o modelo recebe só o aviso, nunca o conteúdo.
    const providers = await admin.get('/api/backup/export/ai-providers');
    const backupJson = Buffer.from(JSON.stringify(providers));
    const imported = await approved(adminSession, 'import_backup', (ids) => ({ attachmentId: ids[0] }), {
      files: [{ name: 'provedores.json', mime: 'application/json', data: backupJson }],
    });
    expect(imported.preview).toMatchObject({ title: 'Importar backup', action: 'create' });
    expect(imported.value).toMatchObject({ kind: 'ai-providers', dryRun: false });
    const sentToModel = JSON.stringify(
      llm.calls
        .filter((c) => c.path === '/v1/messages')
        .slice(-3)
        .map((c) => c.body),
    );
    expect(sentToModel).toContain('o conteúdo não é enviado ao modelo');
    expect(sentToModel).not.toContain('sk-ant-test-f13b');
  });
});

describe('segredos (spec 027)', () => {
  it('o worker nunca executa uma tool de segredo: aprovada fora da API, volta "abra o console"', async () => {
    const tag = `Sem console ${uid()}`;
    const api = client(h, adminSession.cookie);
    const conversation = await newSession(api, agent.id);
    const sent = await api.post(`/api/conversations/${conversation.id}/messages`, {
      text: `chamar create_message_destination ${JSON.stringify({ name: tag, chatId: '777' })}`,
    });
    await drain();
    // Decisão direto no banco (sem a requisição de decisão da API, que executaria a tool).
    await h.db.execute(sql`SELECT * FROM ai_tool_confirmations_decide(${sent.run.id}::uuid, ${adminSession.id}::uuid, 'approved')`);
    await drain();
    const detail = await api.get(`/api/conversations/${conversation.id}`);
    const result = detail.messages.filter((m: any) => m.role === 'tool').at(-1).content[0];
    expect(result).toMatchObject({
      is_error: true,
      content: 'Esta ação precisa de um segredo: abra o console para digitar o segredo no cartão de aprovação.',
    });
    const created = await h.db.execute(sql`SELECT 1 FROM message_destinations WHERE name = ${tag}`);
    expect(created.rows).toHaveLength(0);
  });

  it('nenhum segredo digitado aparece em ai_messages, ai_run_events, ai_tool_confirmations, audit_log ou ai_requests', async () => {
    expect(typedSecrets.length).toBeGreaterThanOrEqual(6);
    for (const value of typedSecrets) {
      const like = `%${value}%`;
      const r = await h.db.execute<{ messages: number; events: number; confirmations: number; audit: number; requests: number }>(sql`
        SELECT (SELECT count(*)::int FROM ai_messages m WHERE m.content::text LIKE ${like}) AS messages,
               (SELECT count(*)::int FROM ai_run_events e WHERE e.payload::text LIKE ${like}) AS events,
               (SELECT count(*)::int FROM ai_tool_confirmations c WHERE c.input::text LIKE ${like} OR c.preview::text LIKE ${like}
                                                                  OR coalesce(c.reason, '') LIKE ${like}) AS confirmations,
               (SELECT count(*)::int FROM audit_log a WHERE coalesce(a.old_data::text, '') LIKE ${like}
                                                      OR coalesce(a.new_data::text, '') LIKE ${like}) AS audit,
               (SELECT count(*)::int FROM ai_requests q WHERE coalesce(q.request_body, '') LIKE ${like}
                                                         OR coalesce(q.response_body, '') LIKE ${like}
                                                         OR coalesce(q.request_headers::text, '') LIKE ${like}
                                                         OR coalesce(q.error_message, '') LIKE ${like}) AS requests`);
      expect(r.rows[0], value).toEqual({ messages: 0, events: 0, confirmations: 0, audit: 0, requests: 0 });
    }
    // E as Requisições têm corpos registrados (o provedor do agente registra), então a conferência vale.
    const bodies = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ai_requests WHERE request_body IS NOT NULL`);
    expect(bodies.rows[0]!.n).toBeGreaterThan(0);
  });
});
