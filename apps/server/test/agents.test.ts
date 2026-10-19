import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AGENT_TOOLS, formatBRL, SseParser } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type IndexState, indexEmbeddings } from '../src/agents/embeddings';
import { mcpExposedName } from '../src/agents/mcp-client';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { registerInternalTool } from '../src/agents/tools-runtime';
import { startAgentWorker } from '../src/agents/worker';
import { translateDbError } from '../src/errors';
import { withTx } from '../src/services/tx';
import { type FakeMcp, startFakeMcp } from './fakes/fake-mcp';
import { client, type Harness, newSession, scenario, startApp, uid, userSession } from './helpers';

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

/** Endereço do app para o /mcp (escuta uma vez por arquivo). */
async function mcpAddress() {
  const bound = h.app.server.address();
  if (bound && typeof bound === 'object') return `http://127.0.0.1:${bound.port}`;
  return h.app.listen({ port: 0, host: '127.0.0.1' });
}
let provider: any;
let agent: any;
let defaultKit: any;

/** Kit com as tools indicadas (padrão: todas) no modo sugerido de cada uma, salvo `modes`. */
async function createKit(name: string, names?: string[], modes: Record<string, 'allow' | 'ask'> = {}) {
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  const tools = catalog
    .filter((tool) => !names || names.includes(tool.name))
    .map((tool) => ({ name: tool.name, mode: modes[tool.name] ?? tool.suggestedMode }));
  return admin.post('/api/admin/ai/tool-kits', { name: `${name} ${uid()}`, tools });
}

/** Nomes das tools enviadas na última chamada de chat ao provedor falso (Anthropic). */
function lastToolNames(): string[] {
  const call = llm.calls
    .filter((c) => c.path === '/v1/messages' && Array.isArray(c.body.tools) && !/Gere um título/.test(JSON.stringify(c.body.system)))
    .at(-1)!;
  return call.body.tools.map((tool: any) => tool.name);
}

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
  // Anthropic compatível (base_url): modelo de texto obrigatório; cache e raciocínio ligados à mão (spec 024).
  provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: API_KEY,
    defaultModels: { text: 'claude-sonnet-5-5' },
    promptCacheEnabled: true,
    thinkingEnabled: true,
  });
  await admin.post('/api/admin/ai/prices', {
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    cacheReadPricePerMillion: 0.2,
  });
  // O agente principal usa um kit com todas as tools no modo sugerido (escritas pedem aprovação).
  defaultKit = await createKit('Padrão dos testes');
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Assistente teste ${uid()}`,
    systemPrompt: 'Você ajuda nos testes.',
    // O provedor padrão preenche o texto e a visão (o mesmo provedor: anexos direto ao modelo).
    defaultProviderId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 2000, max_tool_iterations: 6 },
    toolKitId: defaultKit.id,
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

  it('agente: kit inexistente recusado, ativo exige provedor e modelo; catálogo com categoria e modo sugerido', async () => {
    await admin.post('/api/admin/ai/agents', { name: `Ruim ${uid()}`, toolKitId: '00000000-0000-7000-8000-000000000000' }, 400);
    await admin.post('/api/admin/ai/agents', { name: `Sem modelo ${uid()}`, isActive: true }, 422);
    expect(agent).toMatchObject({ toolKitId: defaultKit.id, toolKitName: defaultKit.name });
    const tools = await admin.get('/api/admin/ai/tools');
    expect(tools.find((t: any) => t.name === 'send_telegram_message')).toMatchObject({
      kind: 'write',
      category: 'messages',
      suggestedMode: 'ask',
      destructive: false,
      adminOnly: false,
      secret: false,
    });
    expect(tools.find((t: any) => t.name === 'notify_user')).toMatchObject({ kind: 'write', suggestedMode: 'allow' });
    expect(tools.find((t: any) => t.name === 'unmatch_statement_line')).toMatchObject({ category: 'reconciliation', destructive: true });
    const options = await client(h, (await userSession(h)).cookie).get('/api/agents');
    expect(options.some((a: any) => a.id === agent.id)).toBe(true);
  });
});

describe('execução do agente', () => {
  it('tool de leitura: run completo com streaming, título automático, uso e custo, SSE com Last-Event-ID', async () => {
    const s = await scenario(h, admin);
    const conversation = await newSession(admin, agent.id);
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
    const conversation = await newSession(admin, agent.id);
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
    // Pelo nome exato: a busca é por semelhança e acharia o "ACME Agente" de uma rodada anterior num banco reaproveitado.
    expect((await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).filter((e: any) => e.name === name)).toHaveLength(0);

    // Outro usuário não decide.
    const other = client(h, (await userSession(h)).cookie);
    await other.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' }, 404);

    const decided = await admin.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' });
    expect(decided).toEqual({ decided: 1, pending: 0, runStatus: 'queued' });
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    const created = (await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).filter((e: any) => e.name === name);
    expect(created).toHaveLength(1);
    const audit = await h.db.execute<{ actor_kind: string; agent_run_id: string; user_id: string }>(
      sql`SELECT actor_kind, agent_run_id, user_id FROM audit_log WHERE table_name = 'entities' AND record_id = ${created[0].id}`,
    );
    expect(audit.rows[0]).toEqual({ actor_kind: 'agent', agent_run_id: sent.run.id, user_id: adminSession.id });
    const final = await admin.get(`/api/conversations/${conversation.id}`);
    expect(final.messages.at(-1).content[0].text).toMatch(/^Pronto:/);
  });

  it('escrita rejeitada: nada é gravado e o modelo recebe a recusa com o motivo', async () => {
    const conversation = await newSession(admin, agent.id);
    const name = `Recusada ${uid()}`;
    const sent = await chat(admin, conversation.id, `criar entidade ${name}`);
    await drain();
    await admin.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'rejected', reason: 'não quero' });
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    expect((await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).filter((e: any) => e.name === name)).toHaveLength(0);
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    const result = detail.messages.find((m: any) => m.role === 'tool').content[0];
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain('não quero');
    expect(detail.messages.at(-1).content[0].text).toMatch(/^Não deu certo/);
    // Com a execução encerrada, o detalhe ainda traz a decisão (a tela marca a tool como recusada, não como erro).
    expect(detail.activeRun).toBeNull();
    const toolUse = detail.messages.find((m: any) => m.role === 'assistant').content.find((b: any) => b.type === 'tool_use');
    expect(detail.confirmations).toEqual([
      expect.objectContaining({ runId: sent.run.id, toolUseId: toolUse.id, status: 'rejected', reason: 'não quero' }),
    ]);
  });

  it('permissões: o agente só enxerga as caixas do usuário que o acionou; admin lê a conversa (somente leitura)', async () => {
    const s = await scenario(h, admin);
    const userSess = await userSession(h);
    const user = client(h, userSess.cookie);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: userSess.id, role: 'editor' });
    const conversation = await newSession(user, agent.id);
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
    const conversation = await newSession(admin, agent.id);
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
    const conversation = await newSession(admin, agent.id);
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
    const conversation = await newSession(admin, agent.id);
    llm.queue = Array.from({ length: 12 }, () => ({ status: 400 }));
    const sent = await chat(admin, conversation.id, 'oi');
    await drain();
    const status = await runStatus(sent.run.id);
    expect(status.status).toBe('failed');
    expect(status.error).toMatch(/provedor de IA/);
    expect(status.error).not.toContain('SEGREDO');
  });
});

describe('kit de ferramentas (spec 021)', () => {
  /** Agente ativo com o kit dado (null = sem kit). */
  const kitAgent = (toolKitId: string | null, name = 'Kit') =>
    admin.post('/api/admin/ai/agents', {
      name: `${name} ${uid()}`,
      providerId: provider.id,
      model: 'claude-sonnet-5-5',
      params: { max_tokens: 2000, max_tool_iterations: 6 },
      toolKitId,
      isActive: true,
    });

  async function confirmationsOf(runId: string) {
    const r = await h.db.execute<{ tool_name: string; status: string }>(
      sql`SELECT tool_name, status FROM ai_tool_confirmations WHERE run_id = ${runId} ORDER BY created_at`,
    );
    return r.rows;
  }

  it('CRUD, duplicar, validação contra o registro, nome único sem distinção de maiúsculas e auditoria', async () => {
    const name = `Kit CRUD ${uid()}`;
    const kit = await admin.post('/api/admin/ai/tool-kits', {
      name,
      description: 'Teste',
      tools: [
        { name: 'create_title', mode: 'ask' },
        { name: 'list_caixas', mode: 'allow' },
      ],
    });
    // Na ordem do registro (a da tela).
    expect(kit).toMatchObject({
      name,
      description: 'Teste',
      agents: [],
      tools: [
        { name: 'list_caixas', mode: 'allow' },
        { name: 'create_title', mode: 'ask' },
      ],
    });
    await admin.post('/api/admin/ai/tool-kits', { name: name.toUpperCase() }, 409);
    await admin.post('/api/admin/ai/tool-kits', { name: `Outro ${uid()}`, tools: [{ name: 'nao_existe', mode: 'allow' }] }, 400);
    await admin.post('/api/admin/ai/tool-kits', { name: `Outro ${uid()}`, tools: [{ name: 'list_caixas' }] }, 400);
    await admin.post('/api/admin/ai/tool-kits', { name: `Outro ${uid()}`, tools: [{ name: 'list_caixas', mode: 'nunca' }] }, 400);

    // `tools` substitui o conjunto: sai create_title, list_caixas muda para ask, entra end_series.
    const edited = await admin.patch(`/api/admin/ai/tool-kits/${kit.id}`, {
      tools: [
        { name: 'end_series', mode: 'allow' },
        { name: 'list_caixas', mode: 'ask' },
      ],
    });
    expect(edited).toMatchObject({ name, description: 'Teste' });
    expect(edited.tools).toEqual([
      { name: 'list_caixas', mode: 'ask' },
      { name: 'end_series', mode: 'allow' },
    ]);
    expect((await admin.patch(`/api/admin/ai/tool-kits/${kit.id}`, { description: '' })).description).toBeNull();

    const copy = await admin.post(`/api/admin/ai/tool-kits/${kit.id}/duplicate`);
    expect(copy).toMatchObject({ name: `Cópia de ${name}`, tools: edited.tools, agents: [] });
    expect(copy.id).not.toBe(kit.id);
    const copy2 = await admin.post(`/api/admin/ai/tool-kits/${kit.id}/duplicate`);
    expect(copy2.name).toBe(`Cópia de ${name} (2)`);
    const named = await admin.post(`/api/admin/ai/tool-kits/${kit.id}/duplicate`, { name: `Ajustado ${uid()}` });
    expect(named.tools).toEqual(edited.tools);
    const list = await admin.get('/api/admin/ai/tool-kits');
    expect(list.map((k: any) => k.id)).toEqual(expect.arrayContaining([kit.id, copy.id, copy2.id, named.id]));

    // Auditoria: o kit e as tools dele (record_id = kit), com o admin como ator humano.
    const audit = await h.db.execute<{ table_name: string; action: string; actor_kind: string; user_id: string }>(sql`
      SELECT table_name, action, actor_kind, user_id FROM audit_log WHERE record_id = ${kit.id} ORDER BY created_at, id`);
    const kinds = audit.rows.map((r) => `${r.table_name}:${r.action}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['ai_tool_kits:insert', 'ai_tool_kit_tools:insert', 'ai_tool_kit_tools:update', 'ai_tool_kit_tools:delete']),
    );
    for (const row of audit.rows) expect(row).toMatchObject({ actor_kind: 'human', user_id: adminSession.id });

    // Só o admin administra kits.
    const user = client(h, (await userSession(h)).cookie);
    await user.get('/api/admin/ai/tool-kits', 403);
    await user.post('/api/admin/ai/tool-kits', { name: 'x' }, 403);
    await user.post(`/api/admin/ai/tool-kits/${kit.id}/duplicate`, {}, 403);

    for (const id of [copy.id, copy2.id, named.id]) expect(await admin.del(`/api/admin/ai/tool-kits/${id}`)).toEqual({ deleted: true });
    await admin.get(`/api/admin/ai/tool-kits/${copy.id}`, 404);
  });

  it('o kit em uso (inclusive por agente arquivado) não é excluído: o erro lista os agentes', async () => {
    const kit = await createKit('Em uso', ['list_caixas']);
    const active = await kitAgent(kit.id, 'Ativo com kit');
    const archived = await kitAgent(kit.id, 'Arquivado com kit');
    await newSession(admin, archived.id);
    expect(await admin.del(`/api/admin/ai/agents/${archived.id}`)).toMatchObject({ archived: true });
    expect((await admin.get(`/api/admin/ai/tool-kits/${kit.id}`)).agents).toEqual([
      { id: active.id, name: active.name, archived: false },
      { id: archived.id, name: archived.name, archived: true },
    ]);

    const res = await admin.raw('DELETE', `/api/admin/ai/tool-kits/${kit.id}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain(active.name);
    expect(res.json().error.message).toContain(archived.name);

    await admin.patch(`/api/admin/ai/agents/${active.id}`, { toolKitId: null, isActive: false });
    expect((await admin.del(`/api/admin/ai/tool-kits/${kit.id}`, 422)).error.message).toContain(archived.name);
    await admin.patch(`/api/admin/ai/agents/${archived.id}`, { toolKitId: null });
    expect(await admin.del(`/api/admin/ai/tool-kits/${kit.id}`)).toEqual({ deleted: true });
  });

  it('fora do kit não chega ao modelo; em allow a escrita roda sem confirmação; em ask a leitura pede confirmação', async () => {
    const kit = await createKit('Misto', ['list_caixas', 'create_entity'], { list_caixas: 'ask', create_entity: 'allow' });
    const mixed = await kitAgent(kit.id, 'Misto');
    const conversation = await newSession(admin, mixed.id);

    // Escrita em allow: executa direto, sem ai_tool_confirmations.
    const name = `Direto ${uid()}`;
    const write = await chat(admin, conversation.id, `criar entidade ${name}`);
    await drain();
    expect((await runStatus(write.run.id)).status).toBe('completed');
    expect(await confirmationsOf(write.run.id)).toEqual([]);
    expect((await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).filter((e: any) => e.name === name)).toHaveLength(1);
    // Só as tools do kit foram ao modelo, na ordem do registro.
    expect(lastToolNames()).toEqual(['list_caixas', 'create_entity']);

    // Leitura em ask: pede confirmação.
    const read = await chat(admin, conversation.id, 'listar caixas');
    await drain();
    expect((await runStatus(read.run.id)).status).toBe('awaiting_confirmation');
    expect(await confirmationsOf(read.run.id)).toEqual([{ tool_name: 'list_caixas', status: 'pending' }]);
    await admin.post(`/api/runs/${read.run.id}/confirmations`, { decision: 'approved' });
    await drain();
    expect((await runStatus(read.run.id)).status).toBe('completed');

    // Tool fora do kit: o modelo não a recebe e, se a chamar mesmo assim, recebe o erro (sem executar).
    const outside = await chat(admin, conversation.id, `chamar get_entity {"entityId":"${mixed.id}"}`);
    await drain();
    expect((await runStatus(outside.run.id)).status).toBe('completed');
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    const result = detail.messages.filter((m: any) => m.role === 'tool').at(-1).content[0];
    expect(result).toMatchObject({ is_error: true, content: 'Tool desconhecida ou não habilitada: get_entity' });
    expect(await confirmationsOf(outside.run.id)).toEqual([]);
  });

  it('sem kit: todas as tools internas, tudo roda direto (inclusive enviar mensagem e escritas)', async () => {
    const free = await kitAgent(null, 'Sem kit');
    expect(free).toMatchObject({ toolKitId: null, toolKitName: null });
    const conversation = await newSession(admin, free.id);
    const name = `Sem kit ${uid()}`;
    const sent = await chat(admin, conversation.id, `criar entidade ${name}`);
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    expect(await confirmationsOf(sent.run.id)).toEqual([]);
    expect((await admin.get(`/api/entities?q=${encodeURIComponent(name)}`)).filter((e: any) => e.name === name)).toHaveLength(1);
    expect(lastToolNames()).toEqual(AGENT_TOOLS.map((tool) => tool.name));
  });

  it('tool só de admin num kit não é oferecida a quem não é admin; o kit é relido a cada chamada ao modelo', async () => {
    let switchKitId = '';
    const unregister = [
      registerInternalTool(
        {
          name: 'test_admin_only',
          title: 'Tool de admin (teste)',
          description: 'Só para administradores (registrada no teste).',
          kind: 'read',
          category: 'search',
          suggestedMode: 'allow',
          adminOnly: true,
          input: z.object({}),
        },
        { run: async () => ({ ok: true }) },
      ),
      registerInternalTool(
        {
          name: 'test_kit_switch',
          title: 'Troca o kit (teste)',
          description: 'Tira list_caixas do kit e libera create_entity (registrada no teste).',
          kind: 'read',
          category: 'search',
          suggestedMode: 'allow',
          input: z.object({}),
        },
        {
          run: (ctx) =>
            withTx(ctx, async (tx) => {
              await tx.execute(sql`DELETE FROM ai_tool_kit_tools WHERE kit_id = ${switchKitId} AND tool_name = 'list_caixas'`);
              await tx.execute(
                sql`UPDATE ai_tool_kit_tools SET mode = 'allow' WHERE kit_id = ${switchKitId} AND tool_name = 'create_entity'`,
              );
              return { switched: true };
            }),
        },
      ),
    ];
    try {
      const catalog = await admin.get('/api/admin/ai/tools');
      expect(catalog.find((t: any) => t.name === 'test_admin_only')).toMatchObject({ adminOnly: true, category: 'search' });
      const kit = await createKit('Admin', ['list_caixas', 'test_admin_only']);
      const withAdminTool = await kitAgent(kit.id, 'Com tool de admin');

      const adminConversation = await newSession(admin, withAdminTool.id);
      await chat(admin, adminConversation.id, 'oi');
      await drain();
      expect(lastToolNames()).toEqual(['list_caixas', 'test_admin_only']);

      const userSess = await userSession(h);
      const user = client(h, userSess.cookie);
      const userConversation = await newSession(user, withAdminTool.id);
      await chat(user, userConversation.id, 'oi');
      await drain();
      expect(lastToolNames()).toEqual(['list_caixas']);
      const forced = await chat(user, userConversation.id, 'chamar test_admin_only {}');
      await drain();
      expect((await runStatus(forced.run.id)).status).toBe('completed');
      const detail = await user.get(`/api/conversations/${userConversation.id}`);
      expect(detail.messages.filter((m: any) => m.role === 'tool').at(-1).content[0]).toMatchObject({
        is_error: true,
        content: 'Tool desconhecida ou não habilitada: test_admin_only',
      });

      // Alterar o kit vale na próxima chamada ao modelo, na mesma execução.
      const switching = await createKit('Troca', ['list_caixas', 'test_kit_switch', 'create_entity']);
      switchKitId = switching.id;
      const switcher = await kitAgent(switching.id, 'Troca de kit');
      const conversation = await newSession(admin, switcher.id);
      const sent = await chat(admin, conversation.id, 'chamar test_kit_switch {}');
      const before = llm.calls.length;
      await drain();
      expect((await runStatus(sent.run.id)).status).toBe('completed');
      const calls = llm.calls
        .slice(before)
        .filter((c) => c.path === '/v1/messages' && Array.isArray(c.body.tools) && c.body.tools.length > 0)
        .map((c) => c.body.tools.map((tool: any) => tool.name));
      // (as tools registradas no teste vêm depois das de AGENT_TOOLS)
      expect(calls).toEqual([
        ['list_caixas', 'create_entity', 'test_kit_switch'],
        ['create_entity', 'test_kit_switch'],
      ]);
      expect((await admin.get(`/api/admin/ai/tool-kits/${switching.id}`)).tools).toEqual([
        { name: 'create_entity', mode: 'allow' },
        { name: 'test_kit_switch', mode: 'allow' },
      ]);
    } finally {
      for (const off of unregister) off();
    }
  });

  it('o retrato da v0.1.7 no banco (migration 0038) está contido no registro, com o mesmo tipo e modo sugerido', async () => {
    const legacy = await h.db.execute<{ tool_name: string; kind: string; confirm: string }>(
      sql`SELECT tool_name, kind, confirm FROM ai_legacy_tool_registry()`,
    );
    expect(legacy.rows).toHaveLength(49);
    expect(legacy.rows.filter((r) => r.kind === 'read')).toHaveLength(25);
    for (const row of legacy.rows) {
      const tool = AGENT_TOOLS.find((x) => x.name === row.tool_name);
      expect(tool, row.tool_name).toBeDefined();
      expect(tool!.kind).toBe(row.kind);
      // never ⇔ allow; agent/always (pediam confirmação) ⇔ ask.
      expect(tool!.suggestedMode).toBe(row.confirm === 'never' ? 'allow' : 'ask');
    }
    // Tools novas (F13 em diante) não estão no retrato: ele só precisa estar contido no registro.
    const registry = new Set<string>(AGENT_TOOLS.map((x) => x.name));
    expect(legacy.rows.every((r) => registry.has(r.tool_name))).toBe(true);
    expect(AGENT_TOOLS.length).toBeGreaterThan(legacy.rows.length);
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
    const kit = await createKit('Só leitura', ['list_caixas', 'search_records']);
    const gpt = await admin.post('/api/admin/ai/agents', {
      name: `GPT teste ${uid()}`,
      providerId: openai.id,
      model: 'fake-gpt',
      isActive: true,
      toolKitId: kit.id,
    });
    const conversation = await newSession(admin, gpt.id);
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

describe('embeddings', () => {
  it('provedor OpenAI-compatível com embeddings: indexa, grava o uso como embedding e a busca semântica acha o registro', async () => {
    const embedder = await admin.post('/api/admin/ai/providers', {
      name: `Embeddings falso ${uid()}`,
      kind: 'openai',
      baseUrl: `${llm.url}/v1`,
      apiKey: 'sk-embed-SEGREDO-03',
      capabilities: ['embeddings'],
      defaultModels: { embeddings: 'fake-embedding' },
    });
    // O agente usa o texto do provedor Anthropic falso e os embeddings deste (spec 024).
    const searcher = await admin.post('/api/admin/ai/agents', {
      name: `Busca ${uid()}`,
      providerId: provider.id,
      model: 'claude-sonnet-5-5',
      toolKitId: defaultKit.id,
      isActive: true,
      inferences: [{ capability: 'embeddings', providerId: embedder.id }],
    });
    try {
      const name = `Padaria Lua Azul ${uid()}`;
      const entity = await admin.post('/api/entities', { kind: 'company', name });

      // Indexação (o que a manutenção do worker faz): registra o par, grava os textos-fonte e depois os vetores pendentes.
      const state: IndexState = { since: new Map() };
      for (let i = 0; i < 100; i += 1) {
        const round = await indexEmbeddings(h.db, h.config, state);
        expect(round.errors).toEqual([]);
        if (round.sources === 0 && round.embedded === 0) break;
      }
      const indexed = await h.db.execute<{ source_text: string; needs_reindex: boolean; has_vector: boolean; caixa_id: string | null }>(sql`
        SELECT source_text, needs_reindex, embedding IS NOT NULL AS has_vector, caixa_id FROM ai_embeddings
         WHERE object_type = 'entity' AND object_id = ${entity.id} AND provider_id = ${embedder.id} AND model = 'fake-embedding'`);
      expect(indexed.rows).toEqual([{ source_text: name, needs_reindex: false, has_vector: true, caixa_id: null }]);
      const embedCall = llm.calls.find((c) => c.path === '/v1/embeddings' && c.body.input.includes(name));
      expect(embedCall?.headers.authorization).toBe('Bearer sk-embed-SEGREDO-03');
      expect(embedCall?.body.model).toBe('fake-embedding');
      const indexUsage = await h.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ai_usage
         WHERE provider_id = ${embedder.id} AND purpose = 'embedding' AND user_id IS NULL AND input_tokens > 0`);
      expect(indexUsage.rows[0]!.n).toBeGreaterThan(0);

      // A tool semantic_search vetoriza a consulta (uso atribuído ao usuário) e devolve a entidade.
      const conversation = await newSession(admin, searcher.id);
      const sent = await chat(
        admin,
        conversation.id,
        `chamar semantic_search ${JSON.stringify({ query: name, types: ['entity'], limit: 3 })}`,
      );
      await drain();
      expect((await runStatus(sent.run.id)).status).toBe('completed');
      const detail = await admin.get(`/api/conversations/${conversation.id}`);
      const result = detail.messages.find((m: any) => m.role === 'tool').content[0];
      expect(result.is_error).toBeFalsy();
      const payload = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
      expect(payload.mode).toBe('embeddings');
      expect(payload.hits[0]).toMatchObject({ type: 'entity', id: entity.id, text: name });
      expect(payload.hits[0].score).toBeCloseTo(1, 5);
      const queryUsage = await h.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ai_usage
         WHERE provider_id = ${embedder.id} AND purpose = 'embedding' AND user_id = ${adminSession.id}`);
      expect(queryUsage.rows[0]!.n).toBe(1);
      // A chave do provedor de embeddings não sai pela API.
      expect(JSON.stringify(await admin.get('/api/admin/ai/providers'))).not.toContain('sk-embed-SEGREDO-03');
    } finally {
      // Os demais testes usam o mesmo banco e esperam a busca por trigram.
      await admin.patch(`/api/admin/ai/agents/${searcher.id}`, { isActive: false });
      await admin.patch(`/api/admin/ai/providers/${embedder.id}`, { isActive: false });
    }
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

    const conversation = await newSession(admin, agent.id);
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

    const address = await mcpAddress();
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

  it('Controle MCP: o admin gera chaves para qualquer usuário, que herdam os poderes dele', async () => {
    const s = await scenario(h, admin);
    const viewerSess = await userSession(h);
    const viewer = client(h, viewerSess.cookie);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerSess.id, role: 'viewer' });

    // Só admin.
    await viewer.get('/api/admin/api-tokens', 403);
    await viewer.post('/api/admin/api-tokens', { userId: viewerSess.id, name: 'x' }, 403);

    const readerKey = await admin.post('/api/admin/api-tokens', { userId: viewerSess.id, name: 'Leitor da A' });
    expect(readerKey.token).toMatch(/^mf_/);
    expect(readerKey).toMatchObject({
      userId: viewerSess.id,
      userRole: 'user',
      userActive: true,
      createdBy: adminSession.username,
      memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }],
    });
    const adminKey = await admin.post('/api/admin/api-tokens', { userId: adminSession.id, name: `Admin ${uid()}` });
    expect(adminKey).toMatchObject({ userRole: 'admin', memberships: [] });

    // A chave aparece para o dono em Minha conta (e ele pode revogá-la); a lista do admin filtra por usuário.
    expect((await viewer.get('/api/account/api-tokens')).map((x: { id: string }) => x.id)).toContain(readerKey.id);
    const listed = await admin.raw('GET', `/api/admin/api-tokens?userId=${viewerSess.id}`);
    expect(listed.body).not.toContain(readerKey.token);
    expect(listed.json().map((x: { id: string }) => x.id)).toEqual([readerKey.id]);

    const address = await mcpAddress();
    const connect = async (token: string) => {
      const mcpClient = new Client({ name: 'teste', version: '1.0.0' });
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );
      return mcpClient;
    };
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

    // Leitor: só a caixa A, sem as tools de administração e sem escrever.
    const asReader = await connect(readerKey.token);
    const readerTools = (await asReader.listTools()).tools.map((x) => x.name);
    expect(readerTools).not.toContain('list_users');
    const readerCaixas = textOf(await asReader.callTool({ name: 'list_caixas', arguments: {} }));
    expect(readerCaixas).toContain(s.caixaA.name);
    expect(readerCaixas).not.toContain(s.caixaB.name);
    const denied = await asReader.callTool({ name: 'create_entity', arguments: { kind: 'company', name: `Leitor ${uid()}` } });
    expect(denied.isError).toBe(true);
    await asReader.close();

    // Admin: todas as caixas e as tools de administração.
    const asAdmin = await connect(adminKey.token);
    expect((await asAdmin.listTools()).tools.map((x) => x.name)).toContain('list_users');
    expect(textOf(await asAdmin.callTool({ name: 'list_caixas', arguments: {} }))).toContain(s.caixaB.name);
    await asAdmin.close();

    // Os poderes são lidos a cada uso: virar editor libera a escrita na hora.
    await admin.put(`/api/users/${viewerSess.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const asEditor = await connect(readerKey.token);
    const allowed = await asEditor.callTool({ name: 'create_entity', arguments: { kind: 'company', name: `Editor ${uid()}` } });
    expect(allowed.isError).toBeFalsy();
    await asEditor.close();

    // Revogação pelo admin; revogadas só com includeRevoked.
    await admin.del(`/api/admin/api-tokens/${readerKey.id}`);
    await expect(connect(readerKey.token)).rejects.toThrow();
    expect(await admin.get(`/api/admin/api-tokens?userId=${viewerSess.id}`)).toEqual([]);
    const withRevoked = await admin.get(`/api/admin/api-tokens?userId=${viewerSess.id}&includeRevoked=true`);
    expect(withRevoked[0]).toMatchObject({ id: readerKey.id, revokedAt: expect.any(String) });
    await admin.del(`/api/admin/api-tokens/${adminKey.id}`);

    // Usuário desativado não recebe chave.
    await admin.patch(`/api/users/${viewerSess.id}`, { isActive: false });
    await admin.post('/api/admin/api-tokens', { userId: viewerSess.id, name: 'Inativo' }, 422);
  });
});

describe('sessões (spec 026)', () => {
  it('renomear, buscar, bifurcar (finaliza a ativa) e excluir só a finalizada (com anexos órfãos)', async () => {
    const conversation = await newSession(admin, agent.id);
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
    // O rótulo com o attachmentId vem antes do arquivo (as tools de importação o recebem, spec 027).
    expect(anthropicCall.body.messages[0].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(attachment.id) });
    expect(anthropicCall.body.messages[0].content[1]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });

    // Anexo de mensagem: dono e admin baixam; outro usuário não.
    const other = await userSession(h);
    const download = await h.app.inject({
      method: 'GET',
      url: `/api/attachments/${attachment.id}/download`,
      headers: { cookie: other.cookie },
    });
    expect(download.statusCode).toBe(404);

    const renamed = await admin.patch(`/api/conversations/${conversation.id}`, { title: 'Reforma da casa' });
    expect(renamed).toMatchObject({ id: conversation.id, title: 'Reforma da casa', titleSource: 'user', archivedAt: null });
    expect(renamed).not.toHaveProperty('pinnedAt');
    const found = await admin.get('/api/conversations?q=reforma');
    expect(found.map((c: any) => c.id)).toContain(conversation.id);

    // Bifurcar da ativa: a cópia vira a ativa e a origem é finalizada (forked).
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    const fork = await admin.post(`/api/conversations/${conversation.id}/fork`, { messageId: detail.messages.at(-1).id, title: 'Cópia' });
    const forked = await admin.get(`/api/conversations/${fork.id}`);
    expect(forked.messages).toHaveLength(detail.messages.length);
    expect(forked.conversation.forkedFromConversationId).toBe(conversation.id);
    const source = (await admin.get(`/api/conversations/${conversation.id}`)).conversation;
    expect(source).toMatchObject({ archivedReason: 'forked' });
    expect(source.archivedAt).not.toBeNull();
    expect((await admin.get('/api/conversations?archived=1')).map((c: any) => c.id)).toContain(conversation.id);
    // A busca cobre as finalizadas também.
    expect((await admin.get('/api/conversations?q=reforma')).map((c: any) => c.id)).toEqual(
      expect.arrayContaining([conversation.id, fork.id]),
    );

    // A ativa não se exclui: finalize antes. O anexo continua ligado à bifurcação; excluindo as duas, o arquivo some.
    await admin.del(`/api/conversations/${fork.id}`, 422);
    await admin.del(`/api/conversations/${conversation.id}`);
    expect((await h.db.execute(sql`SELECT 1 FROM attachments WHERE id = ${attachment.id}`)).rows).toHaveLength(1);
    await admin.post(`/api/conversations/${fork.id}/finish`);
    await admin.del(`/api/conversations/${fork.id}`);
    expect((await h.db.execute(sql`SELECT 1 FROM attachments WHERE id = ${attachment.id}`)).rows).toHaveLength(0);
  });

  it('uma ativa por par; mensagem sem ativa cria; finalizar para a execução rodando; o modelo recebe só a ativa', async () => {
    const owner = await userSession(h);
    const api = client(h, owner.cookie);
    // Corrida de duas abas: as duas recebem a mesma sessão ativa.
    const [first, second] = await Promise.all([
      api.post(`/api/agents/${agent.id}/sessions`, {}),
      api.post(`/api/agents/${agent.id}/sessions`, {}),
    ]);
    expect(second.id).toBe(first.id);
    // A 2ª ativa do mesmo par é recusada (23505 traduzido).
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { agentId: agent.id },
      headers: { cookie: owner.cookie },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'ai_conversations_active_chat_key', message: expect.stringMatching(/sessão ativa/) });

    // A mensagem pelo agente entra na ativa.
    const token = `segredo-da-sessao-${uid()}`;
    const hello = await api.post(`/api/agents/${agent.id}/messages`, { text: `oi ${token}` });
    expect(hello).toMatchObject({ created: false, conversation: { id: first.id } });
    await drain();

    // Finalizar com a execução rodando: o parar é pedido e a sessão é arquivada na hora.
    const slow = await api.post(`/api/agents/${agent.id}/messages`, { text: 'responda devagar' });
    const claimed = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour')`);
    expect(claimed.rows[0]!.id).toBe(slow.run.id);
    const job = processRun({ db: h.db, config: h.config, log }, claimed.rows[0]!);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const finished = await api.post(`/api/conversations/${first.id}/finish`);
    expect(finished).toMatchObject({ id: first.id, archivedReason: 'finished' });
    expect(finished.archivedAt).not.toBeNull();
    expect((await api.get(`/api/runs/${slow.run.id}`)).cancelRequested).toBe(true);
    await job;
    expect((await runStatus(slow.run.id)).status).toBe('canceled');
    // Finalizar de novo não muda nada; a finalizada não recebe mensagem nem volta (23514).
    expect((await api.post(`/api/conversations/${first.id}/finish`)).archivedAt).toBe(finished.archivedAt);
    const closed = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${first.id}/messages`,
      payload: { text: 'ainda aí?' },
      headers: { cookie: owner.cookie },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('session_finished');
    const unarchive = await h.db
      .execute(sql`UPDATE ai_conversations SET archived_at = NULL WHERE id = ${first.id}`)
      .catch((error) => translateDbError(error));
    expect(unarchive).toMatchObject({ status: 422, message: expect.stringMatching(/Bifurque/) });

    // Sem ativa, a próxima mensagem cria a sessão nova; o modelo não recebe o histórico da finalizada.
    const before = llm.calls.length;
    const next = await api.post(`/api/agents/${agent.id}/messages`, { text: 'começo novo' });
    expect(next.created).toBe(true);
    expect(next.conversation.id).not.toBe(first.id);
    await drain();
    const sent = llm.calls
      .slice(before)
      .filter((c) => c.path === '/v1/messages' && JSON.stringify(c.body.messages).includes('começo novo'));
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) expect(JSON.stringify(call.body)).not.toContain(token);

    // O fio: a ativa, a última atividade e as finalizadas (paginadas, com busca).
    const threads = await api.get('/api/agents/threads');
    const thread = threads.find((th: any) => th.agentId === agent.id);
    expect(thread).toMatchObject({ agentName: agent.name, agentUsable: true, userId: owner.id, finishedCount: 1 });
    expect(thread.active.id).toBe(next.conversation.id);
    expect(thread.lastActivityAt).not.toBeNull();
    const sessions = await api.get(`/api/agents/${agent.id}/sessions`);
    expect(sessions).toMatchObject({ hasMore: false, items: [{ id: first.id, archivedReason: 'finished' }] });
    expect((await api.get(`/api/agents/${agent.id}/sessions?q=${token}`)).items.map((c: any) => c.id)).toEqual([first.id]);
    expect((await api.get(`/api/agents/${agent.id}/sessions?q=inexistente-${uid()}`)).items).toEqual([]);
    const view = await api.get(`/api/agents/${agent.id}/thread`);
    expect(view.agent).toMatchObject({ id: agent.id, isActive: true });
    expect(view.session.conversation.id).toBe(next.conversation.id);
    expect(view.media).toEqual({ transcription: false, speech: false });

    // Bifurcar da finalizada com a ativa na fila: a ativa é finalizada (forked), a execução cancelada e a cópia vira a ativa.
    const queued = await api.post(`/api/agents/${agent.id}/messages`, { text: 'na fila' });
    const firstDetail = await api.get(`/api/conversations/${first.id}`);
    const copy = await api.post(`/api/conversations/${first.id}/fork`, { messageId: firstDetail.messages.at(-1).id });
    expect(copy).toMatchObject({ archivedAt: null, forkedFromConversationId: first.id });
    expect((await runStatus(queued.run.id)).status).toBe('canceled');
    expect((await api.get(`/api/conversations/${next.conversation.id}`)).conversation.archivedReason).toBe('forked');
    expect((await api.get(`/api/agents/${agent.id}/thread`)).session.conversation.id).toBe(copy.id);
    const page = await api.get(`/api/agents/${agent.id}/sessions?limit=1`);
    expect(page.items.map((c: any) => c.id)).toEqual([next.conversation.id]);
    expect(page.hasMore).toBe(true);

    // Admin: lê os fios e as sessões dos outros; o usuário comum não.
    const ofOwner = await admin.get(`/api/agents/threads?userId=${owner.id}`);
    expect(ofOwner.map((th: any) => [th.agentId, th.userId, th.active?.id])).toEqual([[agent.id, owner.id, copy.id]]);
    expect((await admin.get('/api/agents/threads?userId=all')).some((th: any) => th.userId === owner.id)).toBe(true);
    expect((await admin.get(`/api/agents/${agent.id}/sessions?userId=${owner.id}`)).items.length).toBe(2);
    await api.get(`/api/agents/threads?userId=${adminSession.id}`, 403);
    await api.get(`/api/agents/${agent.id}/sessions?userId=${adminSession.id}`, 403);
    // O admin não finaliza nem bifurca a sessão de outro.
    await admin.post(`/api/conversations/${copy.id}/finish`, {}, 403);
  });
});

describe('conciliação pelo agente', () => {
  let autonomous: any;
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));

  beforeAll(async () => {
    autonomous = await admin.post('/api/admin/ai/agents', {
      name: `Conciliador ${uid()}`,
      systemPrompt: 'Você concilia extratos.',
      providerId: provider.id,
      model: 'claude-sonnet-5-5',
      params: { max_tokens: 2000, max_tool_iterations: 6 },
      // Sem kit: todas as tools internas, sem aprovação (spec 021).
      isActive: true,
    });
  });

  /** Uma chamada de tool pelo agente (o provedor falso pede "chamar <tool> <json>"); devolve o resultado. */
  async function callTool(agentId: string, name: string, input: unknown) {
    const conversation = await newSession(admin, agentId);
    const sent = await chat(admin, conversation.id, `chamar ${name} ${JSON.stringify(input)}`);
    await drain();
    const detail = await admin.get(`/api/conversations/${conversation.id}`);
    const result = detail.messages.find((m: any) => m.role === 'tool')?.content[0];
    return { runId: sent.run.id, status: (await runStatus(sent.run.id)).status, detail, result };
  }

  async function importStatement(url: string, file: string) {
    const res = await h.app.inject({
      method: 'POST',
      url,
      payload: fixture(file),
      headers: { cookie: adminSession.cookie, 'content-type': 'application/octet-stream' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function titleOfLine(lineId: string) {
    const r = await h.db.execute<{ title_id: string }>(sql`
      SELECT st.title_id FROM statement_lines l
        JOIN movements m ON m.id = l.movement_id JOIN settlements st ON st.id = m.settlement_id
       WHERE l.id = ${lineId}`);
    return r.rows[0]?.title_id ?? null;
  }

  it('lote na conta, sem confirmação: título em aberto vira baixa, linha sem título vira título baixado com espelho, falhas por linha', async () => {
    const s = await scenario(h, admin);
    const title = (body: Record<string, unknown>) =>
      admin.post('/api/titles', {
        caixaId: s.caixaA.id,
        direction: 'payable',
        entityId: s.supplier.id,
        categoryId: s.expense.id,
        competenceDate: '2026-10-01',
        ...body,
      });
    const market = await title({ description: 'Supermercado do mês', dueDate: '2026-10-07', amountCents: 23_015 });
    const imp = await importStatement(`/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`, 'extrato-ofx2.ofx');
    const line = (fitid: string) => imp.lines.find((l: any) => l.fitid === fitid);

    const { status, result, detail } = await callTool(autonomous.id, 'create_from_statement_lines', {
      items: [
        // PIX recebido de quem é titular da caixa B: título a receber baixado, espelhado (a pagar) na caixa B.
        { lineId: line('OFX2-0002').id, mode: 'title', entityId: s.holderB.id, categoryId: s.income.id },
        // Fornecedor sem caixa: título baixado sem espelho.
        { lineId: line('OFX2-0004').id, mode: 'title', entityId: s.supplier.id, categoryId: s.expense.id, learnRule: false },
        // Tarifa: movimento avulso.
        { lineId: line('OFX2-0001').id, mode: 'adjustment', categoryId: s.expense.id, learnRule: false },
        // Compra só vale em fatura de cartão: falha só esta linha.
        { lineId: line('OFX2-0005').id, mode: 'purchase' },
      ],
    });
    expect(status).toBe('completed');
    expect(detail.confirmations).toHaveLength(0);
    const created = JSON.parse(result.content);
    expect(created).toEqual({
      created: 3,
      failed: [{ lineId: line('OFX2-0005').id, message: 'Só linhas de fatura de cartão viram compra.' }],
    });

    const receivable = await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0002').id)}`);
    expect(receivable).toMatchObject({ direction: 'receivable', status: 'paid', entityId: s.holderB.id, amountCents: 150_000 });
    expect(receivable.mirror).toMatchObject({ caixaId: s.caixaB.id, mirrorStatus: 'accepted', status: 'paid' });
    const mirrored = await admin.get(`/api/titles/${receivable.mirror.id}`);
    expect(mirrored).toMatchObject({ direction: 'payable', entityId: s.holderA.id });
    const internet = await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0004').id)}`);
    expect(internet).toMatchObject({ status: 'paid', mirror: null });

    // Título em aberto (já sugerido) casado em lote: vira baixa na conta do extrato.
    const matched = await callTool(autonomous.id, 'match_statement_lines', {
      matches: [
        { lineId: line('OFX2-0003').id, titleId: market.id },
        { lineId: line('OFX2-0002').id, titleId: market.id },
      ],
    });
    expect(JSON.parse(matched.result.content)).toEqual({
      matched: 1,
      failed: [{ lineId: line('OFX2-0002').id, message: 'Esta linha já foi conciliada ou ignorada.' }],
    });
    expect(await admin.get(`/api/titles/${market.id}`)).toMatchObject({ status: 'paid', openCents: 0 });

    // Ignorar e voltar.
    const ignored = await callTool(autonomous.id, 'ignore_statement_lines', { lineIds: [line('OFX2-0005').id, line('OFX2-0003').id] });
    expect(JSON.parse(ignored.result.content)).toMatchObject({ updated: 1, failed: [{ lineId: line('OFX2-0003').id }] });
    const lines = async () => (await admin.get(`/api/statement-imports/${imp.id}`)).lines;
    expect((await lines()).find((l: any) => l.id === line('OFX2-0005').id).status).toBe('ignored');
    await callTool(autonomous.id, 'unignore_statement_lines', { lineIds: [line('OFX2-0005').id] });
    expect((await lines()).find((l: any) => l.id === line('OFX2-0005').id).status).toBe('new');

    // Escrita do agente sai como ator agent na auditoria.
    const audit = await h.db.execute<{ actor_kind: string }>(
      sql`SELECT DISTINCT actor_kind FROM audit_log WHERE table_name = 'titles' AND record_id = ${receivable.mirror.id}`,
    );
    expect(audit.rows).toEqual([{ actor_kind: 'agent' }]);
  });

  it('candidatos da linha, casamento errado desfeito e refeito; prévia do desfazer com o aviso da baixa', async () => {
    const s = await scenario(h, admin);
    const base = {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      competenceDate: '2026-10-01',
    };
    const pix = await admin.post('/api/titles', { ...base, description: 'Pagamento José', dueDate: '2026-10-21', amountCents: 40_000 });
    const wrong = await admin.post('/api/titles', { ...base, description: 'Aluguel', dueDate: '2026-10-25', amountCents: 100_000 });
    const imp = await importStatement(`/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`, 'extrato-ofx2.ofx');
    const lineId = imp.lines.find((l: any) => l.fitid === 'OFX2-0006').id;

    const candidates = JSON.parse((await callTool(autonomous.id, 'list_line_candidates', { lineId })).result.content);
    expect(candidates[0]).toMatchObject({ kind: 'title', id: pix.id });

    // Casou com o título errado: vira uma baixa parcial dele.
    await callTool(autonomous.id, 'match_statement_line', { lineId, titleId: wrong.id });
    expect((await admin.get(`/api/titles/${wrong.id}`)).openCents).toBe(60_000);

    // Com o agente que pede confirmação: a prévia avisa que a baixa (nascida da linha) fica sem deleteEntry.
    const asked = await callTool(agent.id, 'unmatch_statement_line', { lineId });
    expect(asked.status).toBe('awaiting_confirmation');
    const card = asked.detail.confirmations[0];
    expect(card).toMatchObject({
      toolName: 'unmatch_statement_line',
      preview: { title: 'Desfazer conciliação da linha', action: 'delete' },
    });
    expect(card.preview.rows[0].before).toContain('Aluguel');
    expect(card.preview.warnings[0]).toContain('relançar a linha duplica o valor');
    await admin.post(`/api/runs/${asked.runId}/confirmations`, { decision: 'approved' });
    await drain();
    const after = (await admin.get(`/api/statement-imports/${imp.id}`)).lines.find((l: any) => l.id === lineId);
    expect(after).toMatchObject({ status: 'new', movementId: null });

    // Desfazer de novo: a linha já não está conciliada (o erro volta ao modelo, sem pedir confirmação).
    const again = await callTool(agent.id, 'unmatch_statement_line', { lineId });
    expect(again.status).toBe('completed');
    expect(again.result).toMatchObject({ is_error: true });
    expect(again.result.content).toContain('não está conciliada');

    await callTool(autonomous.id, 'match_statement_lines', { matches: [{ lineId, titleId: pix.id }] });
    expect((await admin.get(`/api/titles/${pix.id}`)).status).toBe('paid');
  });

  it('casamento errado corrigido pelo agente: desfaz, estorna a baixa (com a perna do espelho) e casa com o título certo', async () => {
    const s = await scenario(h, admin);
    const base = { caixaId: s.caixaA.id, direction: 'payable', categoryId: s.expense.id, competenceDate: '2026-10-01' };
    const pix = await admin.post('/api/titles', {
      ...base,
      entityId: s.supplier.id,
      description: 'Pagamento José',
      dueDate: '2026-10-21',
      amountCents: 40_000,
    });
    // O título errado é de quem é titular da caixa B: espelhado (a receber) lá.
    const wrong = await admin.post('/api/titles', {
      ...base,
      entityId: s.holderB.id,
      description: 'Aluguel',
      dueDate: '2026-10-25',
      amountCents: 100_000,
    });
    const imp = await importStatement(`/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`, 'extrato-ofx2.ofx');
    const lineId = imp.lines.find((l: any) => l.fitid === 'OFX2-0006').id;

    await callTool(autonomous.id, 'match_statement_line', { lineId, titleId: wrong.id });
    const settled = await admin.get(`/api/titles/${wrong.id}`);
    expect(settled.openCents).toBe(60_000);
    const leg = settled.settlements[0];
    expect(leg).toMatchObject({ settledOn: '2026-10-22', cashCents: 40_000, financialAccountId: s.accountA.id });
    const reversal = { settlementId: leg.id, reason: 'Linha casada com o título errado', reversedOn: '2026-10-23' };

    // Estornar com a linha ainda conciliada: a prévia avisa para desfazer antes (recusado aqui).
    const early = await callTool(agent.id, 'reverse_settlement', reversal);
    expect(early.status).toBe('awaiting_confirmation');
    expect(early.detail.confirmations[0].preview.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('continua conciliada com o movimento desta baixa')]),
    );
    await admin.post(`/api/runs/${early.runId}/confirmations`, { decision: 'rejected', reason: 'desfazer antes' });
    await drain();
    expect((await admin.get(`/api/titles/${wrong.id}`)).openCents).toBe(60_000);

    await callTool(autonomous.id, 'unmatch_statement_line', { lineId });

    // Com o agente que pede confirmação: prévia com título, valor, data, conta e a perna do espelho.
    const asked = await callTool(agent.id, 'reverse_settlement', reversal);
    expect(asked.status).toBe('awaiting_confirmation');
    const card = asked.detail.confirmations[0];
    expect(card).toMatchObject({
      toolName: 'reverse_settlement',
      preview: { title: 'Estornar pagamento', summary: `Aluguel (${s.holderB.name})`, action: 'delete' },
    });
    expect(card.preview.rows).toEqual(
      expect.arrayContaining([
        { label: 'Data da baixa', before: '22/10/2026', after: '—' },
        { label: 'Valor', before: formatBRL(40_000), after: '—' },
        { label: 'Conta', before: s.accountA.name, after: '—' },
        { label: 'Perna do espelho', before: `${s.caixaB.name} · conta a definir`, after: 'Estornada' },
        { label: 'Em aberto', before: formatBRL(60_000), after: formatBRL(100_000) },
        { label: 'Motivo', after: reversal.reason },
      ]),
    );
    expect(card.preview.warnings).toHaveLength(1);
    await admin.post(`/api/runs/${asked.runId}/confirmations`, { decision: 'approved' });
    await drain();
    expect((await runStatus(asked.runId)).status).toBe('completed');

    // O título (e o espelho) voltam a em aberto; o movimento oposto zera a baixa na conta.
    const reopened = await admin.get(`/api/titles/${wrong.id}`);
    expect(reopened).toMatchObject({ status: 'open', openCents: 100_000 });
    expect(reopened.settlements[0]).toMatchObject({ id: leg.id, reversalReason: reversal.reason });
    expect(reopened.settlements[0].reversedAt).not.toBeNull();
    expect(await admin.get(`/api/titles/${reopened.mirror.id}`)).toMatchObject({ status: 'open', openCents: 100_000 });
    const net = await h.db.execute<{ total: string; count: string }>(
      sql`SELECT sum(amount_cents)::text AS total, count(*)::text AS count FROM movements WHERE settlement_id = ${leg.id}`,
    );
    expect(net.rows[0]).toEqual({ total: '0', count: '2' });
    const audit = await h.db.execute<{ actor_kind: string }>(
      sql`SELECT DISTINCT actor_kind FROM audit_log WHERE table_name = 'settlements' AND record_id = ${leg.id} AND action = 'update'`,
    );
    expect(audit.rows).toEqual([{ actor_kind: 'agent' }]);

    // Estornar de novo: o erro volta ao modelo sem pedir confirmação.
    const again = await callTool(agent.id, 'reverse_settlement', reversal);
    expect(again.status).toBe('completed');
    expect(again.result).toMatchObject({ is_error: true });
    expect(again.result.content).toContain('já foi estornada');

    await callTool(autonomous.id, 'match_statement_line', { lineId, titleId: pix.id });
    expect((await admin.get(`/api/titles/${pix.id}`)).status).toBe('paid');
    expect((await admin.get(`/api/statement-imports/${imp.id}`)).lines.find((l: any) => l.id === lineId).status).toBe('matched');
  });

  it('fatura do cartão: linha nova vira compra na caixa pagadora escolhida', async () => {
    const s = await scenario(h, admin);
    const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${s.tag}` });
    const card = await admin.post('/api/caixas', {
      name: `Cartão ${s.tag}`,
      kind: 'credit_card',
      holderEntityId: issuer.id,
      defaultPayerCaixaId: s.caixaA.id,
      creditLimitCents: 500_000,
      closingDay: 25,
      dueDay: 5,
      cardLast4: '2222',
    });
    const imp = await importStatement(`/api/statement-imports?cardCaixaId=${card.id}&fileName=fatura.ofx`, 'fatura-cartao.ofx');
    const gym = imp.lines.find((l: any) => l.amountCents === -25_000);

    const asked = await callTool(agent.id, 'create_from_statement_line', {
      lineId: gym.id,
      mode: 'purchase',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      payerCaixaId: s.caixaB.id,
    });
    expect(asked.detail.confirmations[0].preview.rows).toEqual(expect.arrayContaining([{ label: 'Caixa pagadora', after: s.caixaB.name }]));
    await admin.post(`/api/runs/${asked.runId}/confirmations`, { decision: 'approved' });
    await drain();
    expect((await runStatus(asked.runId)).status).toBe('completed');
    const purchases = await admin.get(`/api/cards/${card.id}/purchases`);
    expect(purchases.find((p: any) => p.amountCents === 25_000)).toMatchObject({ payerCaixaId: s.caixaB.id, entityId: s.supplier.id });
  });
});

describe('IA nos fluxos', () => {
  it('contrato: o PDF sugere os campos (nada é gravado) e vira um markdown versão 1 do agente (spec 020)', async () => {
    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
    try {
      const s = await scenario(h, admin);
      const pdf = Buffer.from('%PDF-1.4\n% contrato\n');
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/contracts/document?fileName=contrato.pdf&caixaId=${s.caixaA.id}`,
        payload: pdf,
        headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Suporte mensal (lido do PDF)',
        direction: 'receivable',
        startsOn: '2030-03-01',
        durationMonths: 12,
        totalCents: 6000001,
        periodicity: 'monthly',
        dueDay: 10,
        autoRenew: true,
        readjustmentIndex: 'ipca',
        terminationPenaltyText: '20% do saldo restante',
      });
      expect(await admin.get(`/api/contracts?caixaId=${s.caixaA.id}`)).toEqual([]);

      const contract = await admin.post('/api/contracts', {
        caixaId: s.caixaA.id,
        entityId: s.holderB.id,
        direction: 'receivable',
        categoryId: s.income.id,
        name: 'Suporte',
        startsOn: '2030-03-01',
        durationMonths: 12,
        periodicity: 'monthly',
        totalCents: 120_000,
        dueDay: 10,
        dueMonthOffset: 0,
      });
      const up = await h.app.inject({
        method: 'POST',
        url: `/api/contracts/${contract.id}/documents?fileName=contrato.pdf&kind=contract`,
        payload: pdf,
        headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
      });
      expect(up.statusCode, up.body).toBe(200);
      const md = await admin.post(`/api/contract-documents/${up.json().id}/convert`);
      expect(md).toMatchObject({ format: 'markdown', currentVersion: 1, sourceDocumentId: up.json().id, kind: 'contract' });
      const v1 = await admin.get(`/api/contract-documents/${md.id}/versions/${md.currentVersionId}`);
      expect(v1).toMatchObject({
        authorKind: 'agent',
        content: '# Contrato de prestação de serviços\n\n## Cláusula 1\nObjeto: suporte mensal.',
      });
      expect(v1.aiRunId).toBeTruthy();
      // Uso gravado com a finalidade do fluxo (tarefa 011).
      const md1 = await h.db.execute<{ purpose: string }>(sql`SELECT purpose FROM ai_usage WHERE run_id = ${v1.aiRunId}`);
      expect(md1.rows.map((r) => r.purpose)).toEqual(['contract_markdown']);
      const reading = await h.db.execute<{ purpose: string }>(sql`
        SELECT u.purpose FROM ai_usage u JOIN ai_conversations c ON c.id = u.conversation_id
         WHERE c.purpose = 'contract_reading'`);
      expect(reading.rows.length).toBeGreaterThan(0);
      expect(new Set(reading.rows.map((r) => r.purpose))).toEqual(new Set(['contract_reading']));
    } finally {
      await stop();
    }
  });

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
      // Rastro do ator (herdado da tarefa 005): a sugestão sai na auditoria como agente, com a execução do fluxo.
      const classifyRun = await h.db.execute<{ id: string }>(sql`
        SELECT r.id FROM ai_runs r JOIN ai_conversations c ON c.id = r.conversation_id
         WHERE c.purpose = 'classify_lines' AND c.screen_context ->> 'importId' = ${importId}`);
      expect(classifyRun.rows).toHaveLength(1);
      const suggestionAudit = await h.db.execute<{ actor_kind: string; agent_run_id: string | null; user_id: string | null }>(sql`
        SELECT actor_kind, agent_run_id, user_id FROM audit_log
         WHERE table_name = 'statement_lines' AND record_id = ${lines[0].id} AND action = 'update'
           AND new_data ->> 'classification_source' = 'agent'`);
      expect(suggestionAudit.rows).toEqual([{ actor_kind: 'agent', agent_run_id: classifyRun.rows[0]!.id, user_id: adminSession.id }]);
      const decided = await admin.post('/api/statement-lines/suggestions', { lineIds: [lines[0].id], decision: 'approve' });
      expect(decided.updated).toBe(1);
      const after = (await admin.get(`/api/statement-imports/${importId}`)).lines.find((l: any) => l.id === lines[0].id);
      expect(after.classificationSource).toBe('user');

      // Uso por finalidade (tarefa 011): cada fluxo grava a sua, e o painel separa os custos (o contrato rodou no teste anterior).
      const usage = async (conversationId: string) =>
        (await h.db.execute<{ purpose: string }>(sql`SELECT purpose FROM ai_usage WHERE conversation_id = ${conversationId}`)).rows.map(
          (r) => r.purpose,
        );
      expect(await usage(res.json().conversationId)).toEqual(['document_reading']);
      const classify = await h.db.execute<{ id: string }>(
        sql`SELECT id FROM ai_conversations WHERE purpose = 'classify_lines' AND screen_context ->> 'importId' = ${importId}`,
      );
      expect(await usage(classify.rows[0]!.id)).toEqual(['classify_lines']);
      const report = await admin.get('/api/admin/ai/usage');
      const purposes = new Set(report.byPurpose.map((r: any) => r.purpose));
      for (const purpose of ['document_reading', 'classify_lines', 'contract_reading', 'contract_markdown']) {
        expect(purposes, purpose).toContain(purpose);
      }
      const doc = report.byPurpose.find((r: any) => r.purpose === 'document_reading');
      expect(doc).toMatchObject({ currency: 'USD', hasUnpriced: false });
      expect(doc.calls).toBeGreaterThan(0);
      expect(doc.runs).toBeGreaterThan(0);
      expect(doc.inputTokens).toBeGreaterThan(0);
    } finally {
      await stop();
    }
  });

  it('agente dos fluxos escolhido no admin: marcar B faz a leitura usar B; um marcado por vez; desativar ou arquivar tira a marca (tarefa 012)', async () => {
    const base = { systemPrompt: 'Fluxos.', providerId: provider.id, model: 'claude-sonnet-5-5', isActive: true };
    const b = await admin.post('/api/admin/ai/agents', { ...base, name: `Fluxos B ${uid()}`, useForFlows: true });
    expect(b.useForFlows).toBe(true);
    const flowAgentOf = async (fileName: string) => {
      const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
      try {
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/title-entry/document?fileName=${fileName}`,
          payload: Buffer.from('%PDF-1.4\n% boleto\n'),
          headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
        });
        expect(res.statusCode, res.body).toBe(200);
        const row = await h.db.execute<{ agent_id: string }>(
          sql`SELECT agent_id FROM ai_conversations WHERE id = ${res.json().conversationId}`,
        );
        return row.rows[0]!.agent_id;
      } finally {
        await stop();
      }
    };
    expect(await flowAgentOf('b.pdf')).toBe(b.id);

    // Marcar C desmarca B na mesma transação.
    const c = await admin.post('/api/admin/ai/agents', { ...base, name: `Fluxos C ${uid()}` });
    expect(c).toMatchObject({ useForFlows: false, isActive: true });
    expect((await admin.patch(`/api/admin/ai/agents/${c.id}`, { useForFlows: true })).useForFlows).toBe(true);
    const marked = (await admin.get('/api/admin/ai/agents')).filter((a: any) => a.useForFlows).map((a: any) => a.id);
    expect(marked).toEqual([c.id]);
    expect(await flowAgentOf('c.pdf')).toBe(c.id);

    // Marcar um agente inativo é recusado com a mensagem traduzida.
    const off = await admin.raw('PATCH', `/api/admin/ai/agents/${b.id}`, { isActive: false, useForFlows: true });
    expect(off.statusCode).toBe(422);
    expect(off.json().error).toMatchObject({ code: 'ai_agents_use_for_flows_check' });
    expect(off.json().error.message).toMatch(/Só um agente ativo/);

    // Desativar o marcado tira a marca; sem marcado vale o primeiro ativo.
    const disabled = await admin.patch(`/api/admin/ai/agents/${c.id}`, { isActive: false });
    expect(disabled).toMatchObject({ isActive: false, useForFlows: false });
    const first = await h.db.execute<{ id: string }>(sql`
      SELECT a.id FROM ai_agents a JOIN ai_providers p ON p.id = a.provider_id
       WHERE a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL
       ORDER BY a.created_at, a.id LIMIT 1`);
    expect(await flowAgentOf('primeiro.pdf')).toBe(first.rows[0]!.id);

    // Arquivar o marcado (tem conversas, então arquiva em vez de excluir) também tira a marca.
    await admin.patch(`/api/admin/ai/agents/${b.id}`, { useForFlows: true });
    await admin.del(`/api/admin/ai/agents/${b.id}`);
    const archived = (await admin.get('/api/admin/ai/agents')).find((a: any) => a.id === b.id);
    expect(archived).toMatchObject({ isActive: false, useForFlows: false });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('a finalidade da conversa do fluxo fica na coluna: mandar mensagem com screenContext não a põe na lista (tarefa 013)', async () => {
    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
    let conversationId: string;
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/title-entry/document?fileName=nota.pdf',
        payload: Buffer.from('%PDF-1.4\n% nota\n'),
        headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
      });
      expect(res.statusCode, res.body).toBe(200);
      conversationId = res.json().conversationId;
    } finally {
      await stop();
    }
    const row = async () =>
      (
        await h.db.execute<{ purpose: string; screen_context: Record<string, unknown> }>(
          sql`SELECT purpose, screen_context FROM ai_conversations WHERE id = ${conversationId}`,
        )
      ).rows[0]!;
    expect(await row()).toMatchObject({ purpose: 'document_reading', screen_context: { fileName: 'nota.pdf' } });
    expect((await row()).screen_context).not.toHaveProperty('purpose');

    // Substituir o screen_context (como o console faz a cada mensagem) não apaga a finalidade.
    const sent = await admin.post(`/api/conversations/${conversationId}/messages`, {
      text: 'e agora?',
      screenContext: { route: '/titulos', title: 'Títulos' },
    });
    await admin.post(`/api/runs/${sent.run.id}/cancel`);
    expect(await row()).toMatchObject({ purpose: 'document_reading', screen_context: { route: '/titulos' } });
    for (const archived of ['0', '1']) {
      expect((await admin.get(`/api/conversations?archived=${archived}`)).map((c: any) => c.id)).not.toContain(conversationId);
    }
    // A finalidade é imutável no banco.
    await expect(h.db.execute(sql`UPDATE ai_conversations SET purpose = 'chat' WHERE id = ${conversationId}`)).rejects.toThrow();
  });
});
