import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SseParser } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { mcpExposedName } from '../src/agents/mcp-client';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { startAgentWorker } from '../src/agents/worker';
import { type FakeMcp, startFakeMcp } from './fakes/fake-mcp';
import { client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * Fase 4 (agentes de IA, spec 011), sem chamar APIs reais: provedor falso
 * (Anthropic e OpenAI-compatível via base_url) e servidor MCP falso. Execução
 * completa com tool de leitura, escrita com confirmação aprovada e rejeitada,
 * permissões, cancelamento, retomada, uso/custo, MCP client e o /mcp próprio,
 * e os segredos que nunca saem pela API nem vão para a auditoria.
 */

const API_KEY = 'sk-ant-test-SEGREDO-0001';
const MCP_SECRET = 'mcp-SEGREDO-xyz-123';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let mcp: FakeMcp;
let admin: ReturnType<typeof client>;
let adminSession: Awaited<ReturnType<typeof userSession>>;
let provider: any;
let agent: any;

/** Roda a fila de execuções no próprio teste (o worker, sem timers). */
async function drain(stale = '1 hour') {
  for (let i = 0; i < 50; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, ${stale}::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

async function runStatus(runId: string) {
  const r = await h.db.execute<{ status: string; error: string | null; attempts: number }>(
    sql`SELECT status, error, attempts FROM ai_runs WHERE id = ${runId}`,
  );
  return r.rows[0]!;
}

async function chat(api: ReturnType<typeof client>, conversationId: string, text: string) {
  return api.post(`/api/conversations/${conversationId}/messages`, { text });
}

/** Lê o SSE inteiro (a execução já terminou: o stream fecha no done). */
async function sse(cookie: string, runId: string, lastEventId?: number) {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/runs/${runId}/events`,
    headers: { cookie, ...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}) },
  });
  expect(res.headers['content-type']).toContain('text/event-stream');
  return new SseParser().push(res.body).map((e) => ({ id: e.id, event: e.event, data: JSON.parse(e.data) }));
}

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  mcp = await startFakeMcp(MCP_SECRET);
  h = await startApp();
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  provider = await admin.post('/api/admin/ai/providers', { name: `Falso ${uid()}`, kind: 'anthropic', baseUrl: llm.url, apiKey: API_KEY });
  await admin.post('/api/admin/ai/prices', {
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    cacheReadPricePerMillion: 0.2,
  });
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Assistente teste ${uid()}`,
    systemPrompt: 'Você ajuda nos testes.',
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 2000, max_tool_iterations: 6 },
    isActive: true,
  });
});
afterAll(async () => {
  // Os outros arquivos de teste usam o mesmo banco e esperam "sem agente configurado".
  for (const a of await admin.get('/api/admin/ai/agents'))
    if (a.isActive) await admin.patch(`/api/admin/ai/agents/${a.id}`, { isActive: false });
  await h.close();
  await llm.close();
  await mcp.close();
});
beforeEach(() => {
  llm.queue = [];
});

describe('administração', () => {
  it('chave write-only: nunca volta pela API nem vai para a auditoria; testar conexão lista modelos', async () => {
    expect(provider.apiKeyHint).toBe('…0001');
    const list = await admin.raw('GET', '/api/admin/ai/providers');
    expect(list.body).not.toContain('SEGREDO');
    const test = await admin.post(`/api/admin/ai/providers/${provider.id}/test`);
    expect(test).toMatchObject({ ok: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
    expect(llm.calls.at(-1)!.headers['x-api-key']).toBe(API_KEY);
    // Editar sem chave mantém a atual.
    await admin.patch(`/api/admin/ai/providers/${provider.id}`, { notes: 'editado', apiKey: '' });
    expect((await admin.post(`/api/admin/ai/providers/${provider.id}/test`)).ok).toBe(true);
    const audit = await h.db.execute<{ data: string }>(
      sql`SELECT coalesce(old_data::text, '') || coalesce(new_data::text, '') AS data FROM audit_log WHERE table_name = 'ai_providers'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const row of audit.rows) expect(row.data).not.toContain('SEGREDO');
    // Usuário comum não administra.
    const user = client(h, (await userSession(h)).cookie);
    await user.get('/api/admin/ai/providers', 403);
    await user.post('/api/admin/ai/agents', { name: 'x' }, 403);
  });

  it('agente: tools desconhecidas recusadas, ativo exige provedor e modelo', async () => {
    await admin.post('/api/admin/ai/agents', { name: `Ruim ${uid()}`, enabledTools: ['nao_existe'] }, 400);
    await admin.post('/api/admin/ai/agents', { name: `Sem modelo ${uid()}`, isActive: true }, 422);
    const tools = await admin.get('/api/admin/ai/tools');
    expect(tools.find((t: any) => t.name === 'send_telegram_message')).toMatchObject({ kind: 'write', confirm: 'always' });
    const options = await client(h, (await userSession(h)).cookie).get('/api/agents');
    expect(options.some((a: any) => a.id === agent.id)).toBe(true);
  });
});

describe('execução do agente', () => {
  it('tool de leitura: run completo com streaming, título automático, uso e custo, SSE com Last-Event-ID', async () => {
    const s = await scenario(h, admin);
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const sent = await chat(admin, conversation.id, 'Pode listar caixas?');
    expect(sent.run.status).toBe('queued');
    // Uma execução ativa por conversa.
    await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'de novo' }, 409);
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');

    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    expect(detail.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolUse = detail.messages[1].content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'list_caixas' });
    expect(detail.messages[2].content[0].content).toContain(s.caixaA.name);
    expect(detail.messages[3].content[0].text).toMatch(/^Pronto:/);
    expect(detail.conversation.title).toBe('Conversa de teste');
    expect(detail.readOnly).toBe(false);
    // Uso: 2 chamadas de chat + 1 de título; custo em USD (input 120 × 2 + output 30 × 10 por milhão).
    const usd = detail.usage.find((u: any) => u.currency === 'USD');
    expect(usd.calls).toBe(3);
    expect(usd.costMicros).toBe(3 * (120 * 2 + 30 * 10));
    expect(detail.messages[1].usage[0]).toMatchObject({ inputTokens: 120, outputTokens: 30, currency: 'USD' });
    const run = await admin.get(`/api/runs/${sent.run.id}`);
    expect(run).toMatchObject({ status: 'completed', inputTokens: 360, costCurrency: 'USD' });

    // Prompt caching e o system prompt do agente chegaram ao provedor.
    const request = llm.calls.find((c) => c.path === '/v1/messages' && JSON.stringify(c.body.system).includes('Você ajuda nos testes'))!;
    expect(request.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(request.body.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(request.body.tools.some((t: any) => t.name === 'create_title')).toBe(true);

    const events = await sse(adminSession.cookie, sent.run.id);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('status');
    expect(types).toEqual(expect.arrayContaining(['text_delta', 'tool_start', 'tool_result', 'message', 'usage', 'title']));
    expect(types.at(-1)).toBe('done');
    expect(events.at(-1)!.data).toMatchObject({ status: 'completed' });
    const middle = Number(events[3]!.id);
    const resumed = await sse(adminSession.cookie, sent.run.id, middle);
    expect(Number(resumed[0]!.id)).toBe(middle + 1);
    expect(resumed.at(-1)!.event).toBe('done');
  });

  it('escrita com confirmação aprovada: cartão com prévia, aplica como agente na auditoria', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const name = `ACME Agente ${uid()}`;
    const sent = await chat(admin, conversation.id, `criar entidade ${name}`);
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('awaiting_confirmation');
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    expect(detail.confirmations).toHaveLength(1);
    const card = detail.confirmations[0];
    expect(card).toMatchObject({ toolName: 'create_entity', status: 'pending' });
    expect(card.preview).toMatchObject({ title: 'Criar entidade', action: 'create' });
    expect(card.preview.rows).toEqual(expect.arrayContaining([{ label: 'Nome', after: name }]));
    expect((await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).length).toBe(0);

    // Outro usuário não decide.
    const other = client(h, (await userSession(h)).cookie);
    await other.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' }, 404);

    const decided = await admin.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' });
    expect(decided).toEqual({ decided: 1, pending: 0, runStatus: 'queued' });
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    const created = await admin.get(`/api/entities?q=${encodeURIComponent(name)}`);
    expect(created).toHaveLength(1);
    const audit = await h.db.execute<{ actor_kind: string; agent_run_id: string; user_id: string }>(
      sql`SELECT actor_kind, agent_run_id, user_id FROM audit_log WHERE table_name = 'entities' AND record_id = ${created[0].id}`,
    );
    expect(audit.rows[0]).toEqual({ actor_kind: 'agent', agent_run_id: sent.run.id, user_id: adminSession.id });
    const final = await admin.get(`/api/conversations/${conversation.id}`);
    expect(final.messages.at(-1).content[0].text).toMatch(/^Pronto:/);
  });

  it('escrita rejeitada: nada é gravado e o modelo recebe a recusa com o motivo', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const name = `Recusada ${uid()}`;
    const sent = await chat(admin, conversation.id, `criar entidade ${name}`);
    await drain();
    await admin.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'rejected', reason: 'não quero' });
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    expect(await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).toHaveLength(0);
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    const result = detail.messages.find((m: any) => m.role === 'tool').content[0];
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain('não quero');
    expect(detail.messages.at(-1).content[0].text).toMatch(/^Não deu certo/);
  });

  it('permissões: o agente só enxerga as caixas do usuário que o acionou; admin lê a conversa (somente leitura)', async () => {
    const s = await scenario(h, admin);
    const userSess = await userSession(h);
    const user = client(h, userSess.cookie);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: userSess.id, role: 'editor' });
    const conversation = await user.post('/api/conversations', { agentId: agent.id });
    await chat(user, conversation.id, 'listar caixas');
    await drain();
    let detail = await user.get(`/api/conversations/${conversation.id}`);
    const listed = detail.messages.find((m: any) => m.role === 'tool').content[0].content;
    expect(listed).toContain(s.caixaA.name);
    expect(listed).not.toContain(s.caixaB.name);

    await chat(user, conversation.id, `chamar get_caixa {"caixaId":"${s.caixaB.id}"}`);
    await drain();
    detail = await user.get(`/api/conversations/${conversation.id}`);
    const denied = detail.messages.filter((m: any) => m.role === 'tool').at(-1).content[0];
    expect(denied).toMatchObject({ is_error: true, content: 'Registro não encontrado.' });

    // Admin lê, mas não conversa nem renomeia; outro usuário nem vê.
    const asAdmin = await admin.get(`/api/conversations/${conversation.id}`);
    expect(asAdmin.readOnly).toBe(true);
    await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'oi' }, 403);
    await admin.patch(`/api/conversations/${conversation.id}`, { title: 'x' }, 403);
    const all = await admin.get(`/api/conversations?userId=${userSess.id}`);
    expect(all.map((c: any) => c.id)).toContain(conversation.id);
    await user.get(`/api/conversations?userId=all`, 403);
    await client(h, (await userSession(h)).cookie).get(`/api/conversations/${conversation.id}`, 404);
  });

  it('cancelamento: na fila cancela na hora; rodando, o worker para e fecha como canceled', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const queued = await chat(admin, conversation.id, 'oi');
    const canceled = await admin.post(`/api/runs/${queued.run.id}/cancel`);
    expect(canceled.status).toBe('canceled');

    const slow = await chat(admin, conversation.id, 'responda devagar');
    const claimed = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour')`);
    expect(claimed.rows[0]!.id).toBe(slow.run.id);
    const job = processRun({ db: h.db, config: h.config, log }, claimed.rows[0]!);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const asked = await admin.post(`/api/runs/${slow.run.id}/cancel`);
    expect(asked.cancelRequested).toBe(true);
    await job;
    expect((await runStatus(slow.run.id)).status).toBe('canceled');
    const events = await sse(adminSession.cookie, slow.run.id);
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { status: 'canceled' } });
    // A conversa segue utilizável.
    const next = await chat(admin, conversation.id, 'oi de novo');
    await drain();
    expect((await runStatus(next.run.id)).status).toBe('completed');
  });

  it('retomada: reserva abandonada por um worker que caiu é retomada por outro', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const sent = await chat(admin, conversation.id, 'listar caixas');
    const claimed = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour')`);
    expect(claimed.rows[0]!.id).toBe(sent.run.id);
    // O "worker" morre sem heartbeat: a reserva envelhece.
    await h.db.execute(sql`UPDATE ai_runs SET locked_at = now() - interval '1 hour' WHERE id = ${sent.run.id}`);
    await drain('10 seconds');
    const status = await runStatus(sent.run.id);
    expect(status.status).toBe('completed');
    // O heartbeat do worker antigo descobre que perdeu a reserva.
    await expect(h.db.execute(sql`SELECT ai_run_heartbeat(${sent.run.id}::uuid, ${claimed.rows[0]!.lock_token}::uuid)`)).rejects.toThrow();
  });

  it('falha do provedor: erro 500 repetido termina como failed com a mensagem', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    llm.queue = Array.from({ length: 12 }, () => ({ status: 400 }));
    const sent = await chat(admin, conversation.id, 'oi');
    await drain();
    const status = await runStatus(sent.run.id);
    expect(status.status).toBe('failed');
    expect(status.error).toMatch(/provedor de IA/);
    expect(status.error).not.toContain('SEGREDO');
  });
});

describe('provedor OpenAI-compatível', () => {
  it('tools e streaming pelo Chat Completions, com uso normalizado', async () => {
    const openai = await admin.post('/api/admin/ai/providers', {
      name: `OpenAI falso ${uid()}`,
      kind: 'openai',
      baseUrl: `${llm.url}/v1`,
      apiKey: 'sk-openai-SEGREDO-02',
    });
    const gpt = await admin.post('/api/admin/ai/agents', {
      name: `GPT teste ${uid()}`,
      providerId: openai.id,
      model: 'fake-gpt',
      isActive: true,
      enabledTools: ['list_caixas', 'search_records'],
    });
    const conversation = await admin.post('/api/conversations', { agentId: gpt.id });
    llm.queue = [{ toolCalls: [{ name: 'list_caixas', input: {} }], usage: { input: 50, output: 5, cacheRead: 30 } }];
    const sent = await chat(admin, conversation.id, 'quais caixas?');
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    expect(detail.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(detail.messages[1].usage[0]).toMatchObject({ inputTokens: 50, cacheReadTokens: 30, costMicros: null, hasUnpriced: true });
    const call = llm.calls.filter((c) => c.path === '/v1/chat/completions' && c.body.tools).at(-1)!;
    expect(call.headers.authorization).toBe('Bearer sk-openai-SEGREDO-02');
    expect(call.body.tools.map((t: any) => t.function.name)).toEqual(['search_records', 'list_caixas']);
    expect(call.body.messages.some((m: any) => m.role === 'tool')).toBe(true);
  });
});

describe('MCP', () => {
  it('client: cabeçalhos secretos write-only, cache de tools, leitura direta e escrita com confirmação', async () => {
    const server = await admin.post('/api/admin/ai/mcp-servers', {
      name: `Fake MCP ${uid()}`,
      url: mcp.url,
      headers: { Authorization: `Bearer ${MCP_SECRET}` },
      visibility: 'global',
    });
    expect(server.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify(server)).not.toContain(MCP_SECRET);
    const refreshed = await admin.post(`/api/admin/ai/mcp-servers/${server.id}/refresh`);
    expect(refreshed.toolsError).toBeNull();
    expect(refreshed.tools.map((t: any) => t.name).sort()).toEqual(['create_ticket', 'echo']);
    expect(refreshed.tools.find((t: any) => t.name === 'echo').annotations.readOnlyHint).toBe(true);
    // Trocar só um cabeçalho e conferir que nada vaza.
    const patched = await admin.patch(`/api/admin/ai/mcp-servers/${server.id}`, { setHeaders: { 'X-Extra': 'a' } });
    expect(patched.headerNames).toEqual(['Authorization', 'X-Extra']);
    expect((await admin.raw('GET', '/api/admin/ai/mcp-servers')).body).not.toContain(MCP_SECRET);

    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const echo = mcpExposedName(server.name, 'echo');
    await chat(admin, conversation.id, `chamar ${echo} {"text":"oi"}`);
    await drain();
    let detail = await admin.get(`/api/conversations/${conversation.id}`);
    expect(detail.messages.find((m: any) => m.role === 'tool').content[0].content).toBe('eco: oi');
    expect(mcp.authHeaders.at(-1)).toBe(`Bearer ${MCP_SECRET}`);

    const ticket = mcpExposedName(server.name, 'create_ticket');
    const sent = await chat(admin, conversation.id, `chamar ${ticket} {"title":"Falta luz"}`);
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('awaiting_confirmation');
    detail = await admin.get(`/api/conversations/${conversation.id}`);
    expect(detail.confirmations[0]).toMatchObject({ toolName: ticket });
    await admin.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved', ids: [detail.confirmations[0].id] });
    await drain();
    expect(mcp.calls.at(-1)).toEqual({ tool: 'create_ticket', args: { title: 'Falta luz' } });
    await admin.patch(`/api/admin/ai/mcp-servers/${server.id}`, { isActive: false });
  });

  it('servidor próprio /mcp: token pessoal (mostrado uma vez), permissões do dono, ator agent, revogação', async () => {
    const s = await scenario(h, admin);
    const userSess = await userSession(h);
    const user = client(h, userSess.cookie);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: userSess.id, role: 'editor' });
    const created = await user.post('/api/account/api-tokens', { name: 'Claude Desktop', expiresInDays: 30 });
    expect(created.token).toMatch(/^mf_/);
    expect(created.token.startsWith(created.tokenPrefix)).toBe(true);
    const list = await user.raw('GET', '/api/account/api-tokens');
    expect(list.body).not.toContain(created.token);

    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const connect = async (token: string) => {
      const mcpClient = new Client({ name: 'teste', version: '1.0.0' });
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );
      return mcpClient;
    };
    const mcpClient = await connect(created.token);
    const tools = await mcpClient.listTools();
    const createEntity = tools.tools.find((t) => t.name === 'create_entity')!;
    expect(createEntity.annotations).toMatchObject({ readOnlyHint: false });
    expect(tools.tools.find((t) => t.name === 'list_caixas')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const caixas = await mcpClient.callTool({ name: 'list_caixas', arguments: {} });
    const text = (caixas.content as { text: string }[])[0]!.text;
    expect(text).toContain(s.caixaA.name);
    expect(text).not.toContain(s.caixaB.name);

    const name = `Via MCP ${uid()}`;
    const result = await mcpClient.callTool({ name: 'create_entity', arguments: { kind: 'company', name } });
    expect(result.isError).toBeFalsy();
    const entity = JSON.parse((result.content as { text: string }[])[0]!.text);
    const audit = await h.db.execute<{ actor_kind: string; agent_run_id: string | null; user_id: string }>(
      sql`SELECT actor_kind, agent_run_id, user_id FROM audit_log WHERE table_name = 'entities' AND record_id = ${entity.id}`,
    );
    expect(audit.rows[0]).toEqual({ actor_kind: 'agent', agent_run_id: null, user_id: userSess.id });
    const invalid = await mcpClient.callTool({ name: 'create_entity', arguments: { kind: 'x' } });
    expect(invalid.isError).toBe(true);
    await mcpClient.close();

    // Uso registrado e revogação.
    const used = (await user.get('/api/account/api-tokens'))[0];
    expect(used.lastUsedAt).not.toBeNull();
    await user.del(`/api/account/api-tokens/${created.id}`);
    await expect(connect(created.token)).rejects.toThrow();
    const bad = await fetch(`${address}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mf_invalidoinvalidoinvalido',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(bad.status).toBe(401);
    // O hash nunca é legível pelo papel da aplicação.
    await expect(h.db.execute(sql`SELECT token_hash FROM user_api_tokens LIMIT 1`)).rejects.toThrow();
  });
});

describe('conversas', () => {
  it('renomear, fixar, arquivar, buscar, bifurcar e excluir (com anexos órfãos)', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const pdf = Buffer.from('%PDF-1.4\n% teste\n');
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/attachments?fileName=nota.pdf`,
      payload: pdf,
      headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
    });
    expect(up.statusCode, up.body).toBe(200);
    const attachment = up.json();
    await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'orçamento da reforma', attachmentIds: [attachment.id] });
    await drain();
    const anthropicCall = llm.calls
      .filter((c) => c.path === '/v1/messages')
      .find((c) => JSON.stringify(c.body.messages).includes('orçamento da reforma'))!;
    expect(anthropicCall.body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });

    // Anexo de mensagem: dono e admin baixam; outro usuário não.
    const other = await userSession(h);
    const download = await h.app.inject({
      method: 'GET',
      url: `/api/attachments/${attachment.id}/download`,
      headers: { cookie: other.cookie },
    });
    expect(download.statusCode).toBe(404);

    await admin.patch(`/api/conversations/${conversation.id}`, { title: 'Reforma da casa', pinned: true });
    let list = await admin.get('/api/conversations');
    expect(list[0]).toMatchObject({ id: conversation.id, title: 'Reforma da casa', titleSource: 'user' });
    const found = await admin.get('/api/conversations?q=reforma');
    expect(found.map((c: any) => c.id)).toContain(conversation.id);

    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    const fork = await admin.post(`/api/conversations/${conversation.id}/fork`, { messageId: detail.messages.at(-1).id, title: 'Cópia' });
    const forked = await admin.get(`/api/conversations/${fork.id}`);
    expect(forked.messages).toHaveLength(detail.messages.length);
    expect(forked.conversation.forkedFromConversationId).toBe(conversation.id);

    await admin.patch(`/api/conversations/${conversation.id}`, { archived: true });
    list = await admin.get('/api/conversations');
    expect(list.map((c: any) => c.id)).not.toContain(conversation.id);
    expect((await admin.get('/api/conversations?archived=1')).map((c: any) => c.id)).toContain(conversation.id);

    // O anexo continua ligado à bifurcação; excluindo as duas, o arquivo some.
    await admin.del(`/api/conversations/${conversation.id}`);
    expect((await h.db.execute(sql`SELECT 1 FROM attachments WHERE id = ${attachment.id}`)).rows).toHaveLength(1);
    await admin.del(`/api/conversations/${fork.id}`);
    expect((await h.db.execute(sql`SELECT 1 FROM attachments WHERE id = ${attachment.id}`)).rows).toHaveLength(0);
  });
});

describe('IA nos fluxos', () => {
  it('leitura de documento pré-preenche o título; conciliação recebe sugestões do agente para aprovar em lote', async () => {
    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/title-entry/document?fileName=boleto.pdf',
        payload: Buffer.from('%PDF-1.4\n% boleto\n'),
        headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        kind: 'boleto',
        amountCents: 12345,
        dueDate: '2030-05-10',
        description: 'Conta lida do documento',
      });
      // A conversa do fluxo não aparece na lista.
      expect((await admin.get('/api/conversations?archived=1')).map((c: any) => c.id)).not.toContain(res.json().conversationId);

      const s = await scenario(h, admin);
      const ofx = readFileSync(join(import.meta.dirname, 'fixtures', 'extrato-ofx1.ofx'));
      const imp = await h.app.inject({
        method: 'POST',
        url: `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`,
        payload: ofx,
        headers: { cookie: adminSession.cookie, 'content-type': 'application/x-ofx' },
      });
      expect(imp.statusCode, imp.body).toBe(200);
      const importId = imp.json().id;
      let lines: any[] = [];
      for (let i = 0; i < 50; i += 1) {
        lines = (await admin.get(`/api/statement-imports/${importId}`)).lines.filter((l: any) => l.classificationSource === 'agent');
        if (lines.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].categoryId).not.toBeNull();
      const decided = await admin.post('/api/statement-lines/suggestions', { lineIds: [lines[0].id], decision: 'approve' });
      expect(decided.updated).toBe(1);
      const after = (await admin.get(`/api/statement-imports/${importId}`)).lines.find((l: any) => l.id === lines[0].id);
      expect(after.classificationSource).toBe('user');
    } finally {
      await stop();
    }
  });
});
