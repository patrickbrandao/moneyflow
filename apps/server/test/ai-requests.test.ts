import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { embedTexts } from '../src/agents/llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { purgeAiRequests } from '../src/agents/worker';
import { EXCLUDED_TABLES, fullTables, loadCatalog } from '../src/services/backup/catalog';
import { client, type Harness, startApp, uid, userSession } from './helpers';

/*
 * Requisições ao provedor (spec 023), com o provedor FALSO: cada chamada vira
 * uma linha em ai_requests com as tentativas do próprio MoneyFlow (429 seguido
 * de 200, 5xx esgotando e devolvendo a execução à fila, queda no meio do
 * stream sem repetir, cancelamento cortando a espera), corpos só com
 * log_bodies e sem credenciais, a purga pelo prazo do banco ou da variável,
 * o detalhe do provedor, as configurações e o 403 de quem não é admin.
 */

const API_KEY = 'sk-ant-test-REQ-SEGREDO-9876';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let admin: ReturnType<typeof client>;
let adminCookie: string;
let provider: any;
let agent: any;

/** Um processamento da execução (sem repetir a fila): o que o worker faz numa reserva. */
async function processOnce(stale = '1 hour') {
  const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, ${stale}::interval)`);
  const run = result.rows[0];
  if (!run) return null;
  await processRun({ db: h.db, config: h.config, log }, run);
  return run.id;
}

async function drain() {
  for (let i = 0; i < 20; i += 1) if (!(await processOnce())) return;
}

async function runStatus(runId: string) {
  const r = await h.db.execute<{ status: string; error: string | null }>(sql`SELECT status, error FROM ai_runs WHERE id = ${runId}`);
  return r.rows[0]!;
}

/** Requisições de chat da execução, na ordem. */
async function chatRequests(runId: string) {
  const r = await h.db.execute<Record<string, any>>(sql`
    SELECT * FROM ai_requests WHERE run_id = ${runId} AND operation = 'chat' ORDER BY started_at, id`);
  return r.rows;
}

const messageCalls = () => llm.calls.filter((c) => c.path === '/v1/messages').length;

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  // Backoff curto: as esperas de 1 s, 2 s… viram milissegundos (o retry-after continua valendo).
  h = await startApp({ AI_REQUEST_BACKOFF_MS: '5', AI_REQUEST_MAX_ATTEMPTS: '3', AI_REQUEST_RETENTION_DAYS: '30' });
  adminCookie = (await userSession(h, 'admin')).cookie;
  admin = client(h, adminCookie);
  provider = await admin.post('/api/admin/ai/providers', { name: `Req ${uid()}`, kind: 'anthropic', baseUrl: llm.url, apiKey: API_KEY });
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente req ${uid()}`,
    systemPrompt: 'Você ajuda nos testes de requisições.',
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 1000 },
    isActive: true,
  });
});
afterAll(async () => {
  for (const a of await admin.get('/api/admin/ai/agents'))
    if (a.isActive) await admin.patch(`/api/admin/ai/agents/${a.id}`, { isActive: false });
  await admin.del('/api/admin/settings/ai.request_retention_days').catch(() => {});
  await h.close();
  await llm.close();
});
beforeEach(() => {
  llm.queue = [];
});

describe('tentativas', () => {
  it('429 seguido de 200: 2 tentativas, 1 requisição ok com tokens, ligada ao uso; retry-after e rate limit gravados', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    llm.queue = [
      { status: 429, headers: { 'retry-after-ms': '40', 'anthropic-ratelimit-requests-remaining': '0' } },
      { text: 'Respondi depois do 429.', usage: { input: 50, output: 7 } },
    ];
    const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'oi' });
    const before = messageCalls();
    await processOnce();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    expect(messageCalls() - before).toBeGreaterThanOrEqual(2);

    const [request] = await chatRequests(sent.run.id);
    expect(request).toMatchObject({
      status: 'ok',
      attempts: 2,
      http_status: 200,
      operation: 'chat',
      purpose: 'chat',
      model: 'claude-sonnet-5-5',
      method: 'POST',
      path: '/v1/messages',
      streaming: true,
      provider_id: provider.id,
      agent_id: agent.id,
      conversation_id: conversation.id,
      error_message: null,
      request_body: null,
      request_headers: null,
      response_stream: null,
    });
    expect(Number(request!.input_tokens)).toBe(50);
    expect(Number(request!.output_tokens)).toBe(7);
    expect(Number(request!.response_bytes)).toBeGreaterThan(0);
    expect(Number(request!.request_bytes)).toBeGreaterThan(0);
    expect(request!.first_byte_ms).not.toBeNull();
    expect(request!.duration_ms).toBeGreaterThanOrEqual(40);

    const usage = await h.db.execute<{ request_id: string }>(
      sql`SELECT request_id FROM ai_usage WHERE run_id = ${sent.run.id} AND purpose = 'chat'`,
    );
    expect(usage.rows.map((u) => u.request_id)).toEqual([request!.id]);
    // O título automático também é uma requisição, com a própria operação e finalidade.
    const title = await h.db.execute<{ operation: string; purpose: string; status: string }>(
      sql`SELECT operation, purpose, status FROM ai_requests WHERE run_id = ${sent.run.id} AND operation = 'title'`,
    );
    expect(title.rows).toEqual([{ operation: 'title', purpose: 'title', status: 'ok' }]);

    const detail = await admin.get(`/api/admin/ai/requests/${request!.id}`);
    expect(detail.attemptList).toHaveLength(2);
    expect(detail.attemptList[0]).toMatchObject({
      attempt: 1,
      httpStatus: 429,
      errorType: 'rate_limit',
      retryAfterMs: 40,
      rateLimitHeaders: { 'anthropic-ratelimit-requests-remaining': '0', 'retry-after-ms': '40' },
      responseBody: null,
    });
    expect(detail.attemptList[0].errorMessage).toContain('falha simulada');
    expect(detail.attemptList[1]).toMatchObject({ attempt: 2, httpStatus: 200, errorType: null });
    expect(detail).toMatchObject({ url: `${llm.url}/v1/messages`, providerKind: 'anthropic', logBodies: false, requestBody: null });
  });

  it('três 5xx: a requisição termina em erro e a execução volta à fila; na próxima reserva, conclui', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    llm.queue = [{ status: 503 }, { status: 500 }, { status: 529 }];
    const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'oi' });
    const before = messageCalls();
    await processOnce();
    expect(messageCalls() - before).toBe(3);
    expect((await runStatus(sent.run.id)).status).toBe('queued');
    const [failed] = await chatRequests(sent.run.id);
    expect(failed).toMatchObject({ status: 'error', attempts: 3, http_status: 529 });
    expect(failed!.error_message).toContain('falha simulada');
    const attempts = await h.db.execute<{ http_status: number; error_type: string }>(
      sql`SELECT http_status, error_type FROM ai_request_attempts WHERE request_id = ${failed!.id} ORDER BY attempt`,
    );
    expect(attempts.rows).toEqual([
      { http_status: 503, error_type: 'server_error' },
      { http_status: 500, error_type: 'server_error' },
      { http_status: 529, error_type: 'overloaded' },
    ]);
    // Sem uso para a chamada que falhou.
    const usage = await h.db.execute(sql`SELECT 1 FROM ai_usage WHERE request_id = ${failed!.id}`);
    expect(usage.rows).toHaveLength(0);

    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
    const all = await chatRequests(sent.run.id);
    expect(all.map((r) => r.status)).toEqual(['error', 'ok']);
  });

  it('erro que não repete (400): uma tentativa só e a execução falha', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    llm.queue = [{ status: 400 }, { status: 400 }];
    const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'oi' });
    await processOnce();
    expect((await runStatus(sent.run.id)).status).toBe('failed');
    const [request] = await chatRequests(sent.run.id);
    expect(request).toMatchObject({ status: 'error', attempts: 1, http_status: 400 });
  });

  it('queda no meio do stream: não repete a chamada; a requisição termina em erro e a execução volta à fila', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    llm.queue = [{ text: 'Primeiro pedaço. Segundo pedaço. Terceiro pedaço.', chunks: 6, dropAfter: 2, delayMs: 20 }];
    const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'oi' });
    const before = messageCalls();
    await processOnce();
    expect(messageCalls() - before).toBe(1);
    expect((await runStatus(sent.run.id)).status).toBe('queued');
    const [request] = await chatRequests(sent.run.id);
    expect(request).toMatchObject({ status: 'error', attempts: 1, http_status: 200 });
    expect(request!.first_byte_ms).not.toBeNull();
    const attempt = await h.db.execute<{ error_type: string }>(
      sql`SELECT error_type FROM ai_request_attempts WHERE request_id = ${request!.id}`,
    );
    expect(attempt.rows).toEqual([{ error_type: 'stream_interrupted' }]);
    // Os deltas que já tinham chegado foram ao SSE.
    const deltas = await h.db.execute(sql`SELECT 1 FROM ai_run_events WHERE run_id = ${sent.run.id} AND event_type = 'text_delta'`);
    expect(deltas.rows.length).toBeGreaterThan(0);
    await drain();
    expect((await runStatus(sent.run.id)).status).toBe('completed');
  });

  it('cancelar a execução interrompe a espera do retry-after', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    llm.queue = [{ status: 429, headers: { 'retry-after': '30' } }];
    const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, { text: 'oi' });
    const claimed = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour')`);
    const started = Date.now();
    const job = processRun({ db: h.db, config: h.config, log }, claimed.rows[0]!);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await admin.post(`/api/runs/${sent.run.id}/cancel`);
    await job;
    // O heartbeat (3 s) descobre o pedido e corta a espera de 30 s.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await runStatus(sent.run.id)).status).toBe('canceled');
    const [request] = await chatRequests(sent.run.id);
    expect(request).toMatchObject({ status: 'canceled', attempts: 1, error_message: null });
  });
});

describe('corpos e segredos', () => {
  it('sem log_bodies nada de corpo; com ele, o corpo completo com o base64 do anexo, sem a chave nos cabeçalhos', async () => {
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(600, 7)]);
    const upload = async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/attachments?fileName=foto.png`,
        payload: png,
        headers: { cookie: adminCookie, 'content-type': 'image/png' },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };

    const first = await admin.post(`/api/conversations/${conversation.id}/messages`, {
      text: 'sem registro',
      attachmentIds: [(await upload()).id],
    });
    await drain();
    const [off] = await chatRequests(first.run.id);
    expect(off).toMatchObject({ request_body: null, request_headers: null, response_body: null, response_stream: null });

    await admin.patch(`/api/admin/ai/providers/${provider.id}`, { logBodies: true });
    const second = await admin.post(`/api/conversations/${conversation.id}/messages`, {
      text: 'com registro',
      attachmentIds: [(await upload()).id],
    });
    await drain();
    await admin.patch(`/api/admin/ai/providers/${provider.id}`, { logBodies: false });
    const [on] = await chatRequests(second.run.id);
    expect(on!.request_body).toContain(png.toString('base64'));
    expect(on!.request_body).toContain('com registro');
    expect(on!.request_headers['x-api-key']).toBe('[omitido]');
    expect(on!.request_headers['anthropic-version']).toBeTruthy();
    expect(on!.response_stream).toContain('event: message_start');
    expect(JSON.parse(on!.response_body)).toMatchObject({ role: 'assistant', model: 'claude-sonnet-5-5' });
    expect(on!.response_headers['content-type']).toContain('text/event-stream');

    // Nada da chave em lugar nenhum do registro, nem pela API.
    const leaked = await h.db.execute(sql`
      SELECT 1 FROM ai_requests r
       WHERE strpos(coalesce(r.request_body, '') || coalesce(r.request_headers::text, '') || coalesce(r.response_headers::text, '')
                    || coalesce(r.response_body, '') || coalesce(r.response_stream, ''), ${API_KEY}) > 0`);
    expect(leaked.rows).toHaveLength(0);
    const detail = await admin.raw('GET', `/api/admin/ai/requests/${on!.id}`);
    expect(detail.body).not.toContain(API_KEY);
    expect(detail.json().requestBody).toMatchObject({ truncated: false });
    expect(detail.json().responseStream.text).toContain('message_stop');

    const body = await admin.raw('GET', `/api/admin/ai/requests/${on!.id}/body?part=request`);
    expect(body.statusCode).toBe(200);
    expect(body.headers['content-disposition']).toContain('attachment');
    expect(body.body).toContain(png.toString('base64'));
    const stream = await admin.raw('GET', `/api/admin/ai/requests/${on!.id}/body?part=stream`);
    expect(stream.body).toContain('event: message_delta');
    expect((await admin.raw('GET', `/api/admin/ai/requests/${off!.id}/body?part=request`)).statusCode).toBe(404);
  });

  it('testar conexão e embeddings também viram requisições (test_connection sem finalidade; embedding ligado ao uso)', async () => {
    await admin.post(`/api/admin/ai/providers/${provider.id}/test`);
    const test = await h.db.execute<Record<string, any>>(sql`
      SELECT * FROM ai_requests WHERE provider_id = ${provider.id} AND operation = 'test_connection' ORDER BY started_at DESC LIMIT 1`);
    expect(test.rows[0]).toMatchObject({ status: 'ok', purpose: null, method: 'GET', path: '/v1/models?limit=100', streaming: false });
    expect(test.rows[0]!.user_id).toBeTruthy();

    const openai = await admin.post('/api/admin/ai/providers', {
      name: `Emb ${uid()}`,
      kind: 'openai',
      baseUrl: `${llm.url}/v1`,
      apiKey: 'sk-emb-SEGREDO',
      embeddingModel: 'fake-embedding',
      logBodies: true,
    });
    expect(openai.logBodies).toBe(true);
    const out = await embedTexts({ kind: 'openai', baseUrl: `${llm.url}/v1`, apiKey: 'sk-emb-SEGREDO' }, 'fake-embedding', ['abc'], {
      db: h.db,
      providerId: openai.id,
      logBodies: true,
    });
    expect(out.vectors[0]).toHaveLength(1536);
    const row = await h.db.execute<Record<string, any>>(sql`SELECT * FROM ai_requests WHERE id = ${out.requestId}`);
    expect(row.rows[0]).toMatchObject({ operation: 'embedding', purpose: 'embedding', status: 'ok', path: '/v1/embeddings' });
    expect(row.rows[0]!.request_headers.authorization).toBe('[omitido]');
    expect(JSON.parse(row.rows[0]!.response_body).data).toHaveLength(1);
    await admin.patch(`/api/admin/ai/providers/${openai.id}`, { isActive: false });
  });
});

describe('retenção e configurações', () => {
  async function oldRequest(daysAgo: number) {
    const r = await h.db.execute<{ id: string }>(sql`
      INSERT INTO ai_requests (provider_id, operation, purpose, model, path, started_at)
      VALUES (${provider.id}, 'chat', 'chat', 'claude-sonnet-5-5', '/v1/messages', now() - make_interval(days => ${daysAgo}::int))
      RETURNING id`);
    return r.rows[0]!.id;
  }
  const exists = async (id: string) => (await h.db.execute(sql`SELECT 1 FROM ai_requests WHERE id = ${id}`)).rows.length > 0;

  it('a purga respeita o prazo do banco e, sem ele, o da variável (AI_REQUEST_RETENTION_DAYS)', async () => {
    const setting = await admin.get('/api/admin/settings/ai.request_retention_days');
    expect(setting).toMatchObject({ source: 'env', value: 30, envValue: 30, envName: 'AI_REQUEST_RETENTION_DAYS' });

    const d20 = await oldRequest(20);
    const d40 = await oldRequest(40);
    const d70 = await oldRequest(70);
    // O uso fica, com o vínculo nulo.
    await h.db.execute(sql`
      INSERT INTO ai_usage (provider_id, model, purpose, input_tokens, request_id)
      VALUES (${provider.id}, 'claude-sonnet-5-5', 'chat', 1, ${d70})`);

    // Banco: 60 dias vence a variável (30).
    const saved = await admin.put('/api/admin/settings/ai.request_retention_days', { value: 60 });
    expect(saved).toMatchObject({ source: 'database', value: 60, envValue: 30 });
    expect(saved.updatedBy).toMatch(/^admin/);
    expect(await purgeAiRequests(h.db, h.config)).toBeGreaterThanOrEqual(1);
    expect([await exists(d20), await exists(d40), await exists(d70)]).toEqual([true, true, false]);
    const usage = await h.db.execute(
      sql`SELECT 1 FROM ai_usage WHERE request_id IS NULL AND input_tokens = 1 AND provider_id = ${provider.id}`,
    );
    expect(usage.rows.length).toBeGreaterThanOrEqual(1);

    // "Usar o padrão": volta a valer a variável.
    const reset = await admin.del('/api/admin/settings/ai.request_retention_days');
    expect(reset).toMatchObject({ source: 'env', value: 30 });
    await purgeAiRequests(h.db, h.config);
    expect([await exists(d20), await exists(d40)]).toEqual([true, false]);

    // Auditoria da configuração (record_id = md5(key)).
    const audit = await h.db.execute(sql`
      SELECT 1 FROM audit_log WHERE table_name = 'app_settings' AND record_id = md5('ai.request_retention_days')::uuid`);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('valores fora da faixa e chaves desconhecidas são recusados', async () => {
    const zero = await admin.raw('PUT', '/api/admin/settings/ai.request_retention_days', { value: 0 });
    expect(zero.statusCode).toBe(422);
    expect(zero.json().error).toMatchObject({ code: 'app_settings_value_check' });
    expect(zero.json().error.message).toContain('1 a 365');
    expect((await admin.raw('PUT', '/api/admin/settings/ai.request_retention_days', { value: '30' })).statusCode).toBe(422);
    expect((await admin.raw('PUT', '/api/admin/settings/ai.request_retention_days', {})).statusCode).toBe(400);
    expect((await admin.raw('GET', '/api/admin/settings/ai.nao_existe')).statusCode).toBe(404);
    expect((await admin.raw('PUT', '/api/admin/settings/nada', { value: 1 })).statusCode).toBe(404);
  });
});

describe('telas', () => {
  it('lista com filtros e cursor; detalhe do provedor com uso, saúde e as recentes', async () => {
    const page1 = await admin.get(`/api/admin/ai/requests?providerId=${provider.id}&limit=2`);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await admin.get(`/api/admin/ai/requests?providerId=${provider.id}&limit=2&cursor=${page1.nextCursor}`);
    expect(page2.items.length).toBeGreaterThan(0);
    const ids = new Set(page1.items.map((r: any) => r.id));
    expect(page2.items.some((r: any) => ids.has(r.id))).toBe(false);
    expect(page2.items[0].startedAt <= page1.items[1].startedAt).toBe(true);
    // A lista nunca traz corpos.
    expect(page1.items[0]).not.toHaveProperty('requestBody');

    const errors = await admin.get(`/api/admin/ai/requests?providerId=${provider.id}&status=error&operation=chat`);
    expect(errors.items.length).toBeGreaterThan(0);
    expect(errors.items.every((r: any) => r.status === 'error' && r.operation === 'chat')).toBe(true);
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const byDay = await admin.get(`/api/admin/ai/requests?from=${today}&to=${today}&model=sonnet`);
    expect(byDay.items.length).toBeGreaterThan(0);
    await admin.get('/api/admin/ai/requests?cursor=lixo', 400);

    const summary = await admin.get(`/api/admin/ai/providers/${provider.id}/summary`);
    expect(summary.provider).toMatchObject({ id: provider.id, logBodies: false });
    expect(summary.usage.total.totals[0].calls).toBeGreaterThan(0);
    expect(summary.usage.month.byPurpose.map((p: any) => p.key)).toContain('chat');
    expect(summary.usage.last30Days.byModel.map((p: any) => p.key)).toContain('claude-sonnet-5-5');
    const health = summary.health.find((row: any) => row.model === 'claude-sonnet-5-5');
    expect(health.requests).toBeGreaterThan(0);
    expect(health.errors).toBeGreaterThan(0);
    expect(health.errorRate).toBeGreaterThan(0);
    expect(health.p50Ms).not.toBeNull();
    expect(summary.recent.length).toBeGreaterThan(0);
    expect(summary.recent.length).toBeLessThanOrEqual(50);
  });

  it('quem não é admin recebe 403 em todas as rotas', async () => {
    const user = client(h, (await userSession(h)).cookie);
    const some = (await admin.get(`/api/admin/ai/requests?limit=1`)).items[0].id;
    await user.get('/api/admin/ai/requests', 403);
    await user.get(`/api/admin/ai/requests/${some}`, 403);
    await user.get(`/api/admin/ai/requests/${some}/body?part=request`, 403);
    await user.get(`/api/admin/ai/providers/${provider.id}/summary`, 403);
    await user.get('/api/admin/settings/ai.request_retention_days', 403);
    await user.put('/api/admin/settings/ai.request_retention_days', { value: 10 }, 403);
    await user.del('/api/admin/settings/ai.request_retention_days', 403);
  });

  it('backup: requisições fora do JSON completo; app_settings dentro', async () => {
    const catalog = await loadCatalog(h.db);
    const tables = fullTables(catalog);
    expect(EXCLUDED_TABLES.has('ai_requests')).toBe(true);
    expect(tables).not.toContain('ai_requests');
    expect(tables).not.toContain('ai_request_attempts');
    expect(tables).toContain('app_settings');
  });
});
