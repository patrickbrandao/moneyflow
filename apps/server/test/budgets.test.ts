import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { startAgentWorker } from '../src/agents/worker';
import { produceMessages, produceNotifications } from '../src/services/message-worker';
import { client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * Orçamentos, limite por minuto e painel de uso (spec 028), com o provedor
 * falso: aviso em 80% uma vez só (sino e destino), bloqueio a 100% com o admin
 * isento, estouro no meio da execução (budget_exceeded), fluxos pulados, uso
 * sem preço fora do gasto, 429 com retry-after e o banco vencendo a variável.
 * Os orçamentos valem para o banco de teste inteiro: cada caso apaga os seus.
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const MODEL = 'claude-sonnet-5-5';
/** Modelo sem preço cadastrado (uso sem custo). */
const UNPRICED = 'claude-sem-preco';

let h: Harness;
let llm: FakeLlm;
type Session = Awaited<ReturnType<typeof userSession>>;
let adminSession: Session;
let admin: ReturnType<typeof client>;
let provider: any;
let agent: any;

async function drain() {
  for (let i = 0; i < 50; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

/** Uso medido direto em ai_usage (o banco calcula o custo pelo preço do modelo): US$ 2 por milhão de tokens de entrada. */
async function addUsage(opts: { userId: string | null; model?: string; input: number; purpose?: string; agentId?: string | null }) {
  await h.db.execute(sql`
    INSERT INTO ai_usage (provider_id, model, user_id, agent_id, purpose, input_tokens)
    VALUES (${provider.id}, ${opts.model ?? MODEL}, ${opts.userId}, ${opts.agentId ?? null}, ${opts.purpose ?? 'chat'}, ${opts.input})`);
}

async function notificationsOf(userId: string) {
  const r = await h.db.execute<{ title: string; dedup_key: string; link: string }>(
    sql`SELECT title, dedup_key, link FROM notifications WHERE user_id = ${userId} AND kind = 'ai_budget_alert' ORDER BY created_at, dedup_key`,
  );
  return r.rows;
}

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  h = await startApp();
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F14 ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-f14',
    defaultModels: { text: MODEL },
  });
  await admin.post('/api/admin/ai/prices', { providerId: provider.id, model: MODEL, inputPricePerMillion: 2, outputPricePerMillion: 10 });
  // Sem kit: todas as tools rodam direto. É o agente dos fluxos deste arquivo.
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente F14 ${uid()}`,
    systemPrompt: 'Testes de orçamento.',
    defaultProviderId: provider.id,
    model: MODEL,
    params: { max_tokens: 2000, max_tool_iterations: 6 },
    useForFlows: true,
    isActive: true,
  });
});
afterAll(async () => {
  // Os outros arquivos de teste usam o mesmo banco e esperam "sem agente configurado".
  for (const a of await admin.get('/api/admin/ai/agents'))
    if (a.isActive) await admin.patch(`/api/admin/ai/agents/${a.id}`, { isActive: false });
  await h.close();
  await llm.close();
});
beforeEach(() => {
  llm.queue = [];
});
afterEach(async () => {
  // Orçamento e limite valem para o banco inteiro: nada fica para os outros casos e arquivos.
  for (const b of await admin.get('/api/admin/ai/budgets')) await admin.del(`/api/admin/ai/budgets/${b.id}`);
  for (const key of ['ai.runs_per_minute', 'ai.flow_runs_per_minute']) await admin.del(`/api/admin/settings/${key}`);
});

describe('orçamentos: cadastro', () => {
  it('CRUD só do admin; um ativo por escopo, alvo e moeda (NULLS NOT DISTINCT); alvo conforme o escopo; auditado', async () => {
    const someone = await userSession(h);
    await client(h, someone.cookie).get('/api/admin/ai/budgets', 403);
    await client(h, someone.cookie).post('/api/admin/ai/budgets', { scope: 'global', monthlyLimit: 10 }, 403);

    const global = await admin.post('/api/admin/ai/budgets', { scope: 'global', monthlyLimit: 1000 });
    expect(global).toMatchObject({ scope: 'global', currency: 'USD', alertPercent: 80, isActive: true, monthlyLimitMicros: 1_000_000_000 });
    expect(global.current).toMatchObject({ status: 'ok', month: expect.stringMatching(/^\d{4}-\d{2}-01$/) });
    const dup = await admin.raw('POST', '/api/admin/ai/budgets', { scope: 'global', monthlyLimit: 5 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({
      code: 'ai_budgets_active_key',
      message: expect.stringContaining('Já existe um orçamento ativo'),
    });
    // Outra moeda e os inativos não colidem.
    await admin.post('/api/admin/ai/budgets', { scope: 'global', currency: 'BRL', monthlyLimit: 5 });
    const inactive = await admin.post('/api/admin/ai/budgets', { scope: 'global', monthlyLimit: 5, isActive: false });
    expect(inactive.current).toBeNull();
    const reactivate = await admin.raw('PATCH', `/api/admin/ai/budgets/${inactive.id}`, { isActive: true });
    expect(reactivate.statusCode).toBe(409);

    // Alvo conforme o escopo (zod antes do banco).
    const noTarget = await admin.raw('POST', '/api/admin/ai/budgets', { scope: 'user', monthlyLimit: 5 });
    expect(noTarget.statusCode).toBe(400);
    const extraTarget = await admin.raw('POST', '/api/admin/ai/budgets', { scope: 'flows', agentId: agent.id, monthlyLimit: 5 });
    expect(extraTarget.statusCode).toBe(400);
    const badPercent = await admin.raw('POST', '/api/admin/ai/budgets', { scope: 'flows', monthlyLimit: 5, alertPercent: 100 });
    expect(badPercent.statusCode).toBe(400);

    const mine = await admin.post('/api/admin/ai/budgets', { scope: 'user', userId: someone.id, monthlyLimit: 3, alertPercent: 50 });
    expect(mine).toMatchObject({ scope: 'user', userId: someone.id, username: someone.username, alertPercent: 50 });
    const edited = await admin.patch(`/api/admin/ai/budgets/${mine.id}`, { monthlyLimit: 4.5, currency: 'BRL' });
    expect(edited).toMatchObject({ monthlyLimitMicros: 4_500_000, currency: 'BRL', userId: someone.id });
    const audit = await h.db.execute<{ action: string; actor_kind: string; user_id: string }>(
      sql`SELECT action, actor_kind, user_id FROM audit_log WHERE table_name = 'ai_budgets' AND record_id = ${mine.id} ORDER BY id`,
    );
    expect(audit.rows).toEqual([
      { action: 'insert', actor_kind: 'human', user_id: adminSession.id },
      { action: 'update', actor_kind: 'human', user_id: adminSession.id },
    ]);
    expect(await admin.del(`/api/admin/ai/budgets/${mine.id}`)).toEqual({ deleted: true });
    expect((await admin.get('/api/admin/ai/budgets')).map((b: any) => b.id)).not.toContain(mine.id);
  });
});

describe('orçamentos: aviso e bloqueio', () => {
  it('o aviso em 80% sai uma vez só (usuário coberto, admins e o destino que assina); a 100% sai o de bloqueio', async () => {
    const user = await userSession(h);
    const budget = await admin.post('/api/admin/ai/budgets', { scope: 'user', userId: user.id, monthlyLimit: 10 });
    // Destino global assinando o evento (sem parâmetros) e um pessoal de outro usuário (não recebe o orçamento alheio).
    const destination = await admin.post('/api/message-destinations', {
      name: `Avisos IA ${uid()}`,
      ownerKind: 'global',
      botToken: `123456:AAF${uid()}${uid()}xyzxyz`,
      chatId: '-100123',
    });
    await admin.put(`/api/message-destinations/${destination.id}/subscriptions`, { eventKind: 'ai_budget_alert', params: {} });
    const other = await userSession(h);
    const personal = await client(h, other.cookie).post('/api/message-destinations', {
      name: `Pessoal ${uid()}`,
      botToken: `654321:AAF${uid()}${uid()}xyzxyz`,
      chatId: '987',
    });
    await client(h, other.cookie).put(`/api/message-destinations/${personal.id}/subscriptions`, { eventKind: 'ai_budget_alert' });
    const outbox = async (destinationId: string) =>
      (
        await h.db.execute<{ dedup_key: string; text: string }>(
          sql`SELECT dedup_key, payload ->> 'text' AS text FROM message_outbox WHERE destination_id = ${destinationId} ORDER BY created_at, dedup_key`,
        )
      ).rows;

    await addUsage({ userId: user.id, input: 3_000_000 }); // US$ 6 = 60%
    await produceNotifications(h.db, h.config);
    expect(await notificationsOf(user.id)).toEqual([]);

    await addUsage({ userId: user.id, input: 1_000_000 }); // US$ 8 = 80%
    for (let i = 0; i < 2; i += 1) {
      await produceNotifications(h.db, h.config);
      await produceMessages(h.db, h.config);
    }
    const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
    const key80 = `ai_budget_alert:${budget.id}:${month}:80`;
    expect(await notificationsOf(user.id)).toEqual([
      { title: `Orçamento de IA em 80%: usuário @${user.username}`, dedup_key: key80, link: '/account' },
    ]);
    expect(await notificationsOf(adminSession.id)).toEqual([
      { title: `Orçamento de IA em 80%: usuário @${user.username}`, dedup_key: key80, link: '/admin/ai/usage' },
    ]);
    expect((await notificationsOf(other.id)).length).toBe(0);
    const sent = (await outbox(destination.id)).map((m) => ({ ...m, text: m.text.replace(/\u00a0/g, ' ') }));
    expect(sent.map((m) => m.dedup_key)).toEqual([key80]);
    expect(sent[0]!.text).toContain('US$ 8,00 de US$ 10,00 (80%)');
    expect(await outbox(personal.id)).toEqual([]);

    await addUsage({ userId: user.id, input: 1_000_000 }); // US$ 10 = 100%
    await produceNotifications(h.db, h.config);
    await produceMessages(h.db, h.config);
    await produceNotifications(h.db, h.config);
    const after = await notificationsOf(user.id);
    expect(after.map((n) => n.dedup_key)).toEqual([key80, `ai_budget_alert:${budget.id}:${month}:100`]);
    expect(after[1]!.title).toBe(`Orçamento de IA atingido: usuário @${user.username}`);
    expect((await outbox(destination.id)).map((m) => m.dedup_key)).toEqual([key80, `ai_budget_alert:${budget.id}:${month}:100`]);
    expect((await outbox(destination.id))[1]!.text).toContain('bloqueadas');

    // Minha conta → IA: o meu uso do mês e o orçamento que me cobre.
    const mine = await client(h, user.cookie).get('/api/account/ai/usage');
    expect(mine.month).toBe(month);
    expect(mine.usage).toEqual([expect.objectContaining({ currency: 'USD', calls: 3, costMicros: 10_000_000 })]);
    expect(mine.budgets.map((b: any) => [b.id, b.current.status])).toEqual([[budget.id, 'blocked']]);
  });

  it('em 100%, a execução nova é recusada (429, escopo no texto); o admin passa e recebe o aviso', async () => {
    const user = await userSession(h);
    const api = client(h, user.cookie);
    await admin.post('/api/admin/ai/budgets', { scope: 'user', userId: user.id, monthlyLimit: 1 });
    await addUsage({ userId: user.id, input: 600_000 }); // US$ 1,20
    const refused = await api.raw('POST', `/api/agents/${agent.id}/messages`, { text: 'olá' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toEqual({
      code: 'budget_exceeded',
      message: `Orçamento de IA do mês atingido: usuário @${user.username}`,
    });
    // Nada foi gravado: nenhuma mensagem nem execução.
    const runs = await h.db.execute(sql`SELECT 1 FROM ai_runs WHERE user_id = ${user.id}`);
    expect(runs.rows).toHaveLength(0);

    // O orçamento do agente vale para todos que o usam; o admin que aciona fica isento.
    await admin.post('/api/admin/ai/budgets', { scope: 'agent', agentId: agent.id, monthlyLimit: 0.000001 });
    await addUsage({ userId: adminSession.id, agentId: agent.id, input: 10 });
    const other = await userSession(h);
    const blocked = await client(h, other.cookie).raw('POST', `/api/agents/${agent.id}/messages`, { text: 'olá' });
    expect(blocked.json().error.message).toBe(`Orçamento de IA do mês atingido: agente ${agent.name}`);
    const sent = await admin.post(`/api/agents/${agent.id}/messages`, { text: 'olá' });
    await drain();
    expect((await admin.get(`/api/runs/${sent.run.id}`)).status).toBe('completed');

    // O global cobre todos (o uso do banco de teste inteiro conta).
    for (const b of await admin.get('/api/admin/ai/budgets')) await admin.del(`/api/admin/ai/budgets/${b.id}`);
    await admin.post('/api/admin/ai/budgets', { scope: 'global', monthlyLimit: 0.000001 });
    const third = await userSession(h);
    const global = await client(h, third.cookie).raw('POST', `/api/agents/${agent.id}/messages`, { text: 'olá' });
    expect(global.statusCode).toBe(429);
    expect(global.json().error.message).toBe('Orçamento de IA do mês atingido: global');
  });

  it('o estouro no meio da execução termina failed com budget_exceeded, guardando o que já foi feito', async () => {
    const user = await userSession(h);
    const api = client(h, user.cookie);
    await admin.post('/api/admin/ai/budgets', { scope: 'user', userId: user.id, monthlyLimit: 10 });
    // 1ª chamada: pede uma tool e gasta US$ 12; antes da 2ª, o orçamento já estourou.
    llm.queue = [{ toolCalls: [{ name: 'list_caixas', input: {} }], usage: { input: 6_000_000, output: 0 } }];
    const sent = await api.post(`/api/agents/${agent.id}/messages`, { text: 'listar caixas' });
    await drain();
    const run = await api.get(`/api/runs/${sent.run.id}`);
    expect(run.status).toBe('failed');
    expect(run.error).toBe(`Orçamento de IA do mês atingido: usuário @${user.username}`);
    const events = await h.db.execute<{ payload: any }>(
      sql`SELECT payload FROM ai_run_events WHERE run_id = ${sent.run.id} AND event_type = 'error'`,
    );
    expect(events.rows.map((e) => e.payload)).toEqual([expect.objectContaining({ code: 'budget_exceeded' })]);
    // O que já foi feito fica: a resposta com a tool e o resultado da tool.
    const detail = await api.get(`/api/conversations/${sent.conversation.id}`);
    expect(detail.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(llm.calls.filter((c) => c.path === '/v1/messages').length).toBeGreaterThan(0);
  });

  it('o orçamento de fluxos pula a sugestão da conciliação e recusa a leitura de documento (o admin passa)', async () => {
    const s = await scenario(h, admin);
    const editor = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editor.id, role: 'editor' });
    await admin.post('/api/admin/ai/budgets', { scope: 'flows', monthlyLimit: 0.000001 });
    await addUsage({ userId: adminSession.id, input: 10, purpose: 'document_reading' });

    const ofx = readFileSync(join(import.meta.dirname, 'fixtures', 'extrato-ofx1.ofx'));
    const imp = await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`,
      payload: ofx,
      headers: { cookie: editor.cookie, 'content-type': 'application/x-ofx' },
    });
    expect(imp.statusCode, imp.body).toBe(200);
    expect(imp.json().aiSuggestion).toMatchObject({
      queued: false,
      runId: null,
      skippedReason: 'Orçamento de IA do mês atingido: fluxos automáticos',
    });
    expect((await h.db.execute(sql`SELECT 1 FROM ai_runs WHERE user_id = ${editor.id}`)).rows).toHaveLength(0);
    // O botão "Sugerir com IA" devolve o erro.
    const manual = await client(h, editor.cookie).raw('POST', `/api/statement-imports/${imp.json().id}/ai-suggest`);
    expect(manual.statusCode).toBe(429);

    const doc = await h.app.inject({
      method: 'POST',
      url: '/api/title-entry/document?fileName=boleto.pdf',
      payload: Buffer.from('%PDF-1.4\n% boleto\n'),
      headers: { cookie: editor.cookie, 'content-type': 'application/pdf' },
    });
    expect(doc.statusCode).toBe(429);
    expect(doc.json().error.code).toBe('budget_exceeded');
    // O chat do mesmo usuário não é fluxo: segue.
    const chat = await client(h, editor.cookie).post(`/api/agents/${agent.id}/messages`, { text: 'olá' });
    expect(chat.run.status).toBe('queued');
    await drain();
    // O admin que importa fica isento: a sugestão entra na fila.
    const byAdmin = await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports/${imp.json().id}/ai-suggest`,
      headers: { cookie: adminSession.cookie },
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(byAdmin.json().queued).toBe(true);
    await drain();
  });

  it('o uso sem preço não conta no gasto (aparece em "chamadas sem preço"), nem o de outra moeda', async () => {
    const user = await userSession(h);
    const budget = await admin.post('/api/admin/ai/budgets', { scope: 'user', userId: user.id, monthlyLimit: 1 });
    const brl = await admin.post('/api/admin/ai/budgets', { scope: 'user', userId: user.id, currency: 'BRL', monthlyLimit: 1 });
    await addUsage({ userId: user.id, model: UNPRICED, input: 50_000_000 });
    await addUsage({ userId: user.id, input: 100_000 }); // US$ 0,20
    const list = await admin.get('/api/admin/ai/budgets');
    expect(list.find((b: any) => b.id === budget.id).current).toMatchObject({
      spentMicros: 200_000,
      unpricedCalls: 1,
      status: 'ok',
      percent: 20,
    });
    expect(list.find((b: any) => b.id === brl.id).current).toMatchObject({ spentMicros: 0, status: 'ok' });
    const sent = await client(h, user.cookie).post(`/api/agents/${agent.id}/messages`, { text: 'olá' });
    expect(sent.run.status).toBe('queued');
    await drain();
  });
});

describe('limite de execuções por minuto', () => {
  it('429 com retry-after; o valor do banco vence a variável; vale para o admin; fluxos contam à parte', async () => {
    const user = await userSession(h);
    const api = client(h, user.cookie);
    // A variável deste harness é 1000; o banco passa a valer 2.
    const setting = await admin.put('/api/admin/settings/ai.runs_per_minute', { value: 2 });
    expect(setting).toMatchObject({ value: 2, source: 'database', envValue: 1000, envName: 'AI_RUNS_PER_MINUTE' });
    const invalid = await admin.raw('PUT', '/api/admin/settings/ai.runs_per_minute', { value: 0 });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('app_settings_value_check');

    for (let i = 0; i < 2; i += 1) {
      await api.post(`/api/agents/${agent.id}/messages`, { text: `olá ${i}` });
      await drain();
    }
    const limited = await api.raw('POST', `/api/agents/${agent.id}/messages`, { text: 'mais um' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(limited.json().error.message).toMatch(/Limite de 2 execuções de IA por minuto/);
    const retry = Number(limited.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);

    // Os fluxos têm o próprio limite (30 na variável, 1000 neste harness): a leitura de documento não é barrada pelo do chat.
    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
    try {
      const doc = await h.app.inject({
        method: 'POST',
        url: '/api/title-entry/document?fileName=boleto.pdf',
        payload: Buffer.from('%PDF-1.4\n% boleto\n'),
        headers: { cookie: user.cookie, 'content-type': 'application/pdf' },
      });
      expect(doc.statusCode, doc.body).toBe(200);
    } finally {
      await stop();
    }

    // O admin também tem limite (não fica isento como no orçamento).
    const adminLimited = async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await admin.raw('POST', `/api/agents/${agent.id}/messages`, { text: `admin ${i}` });
        if (res.statusCode === 429) return true;
        await drain();
      }
      return false;
    };
    expect(await adminLimited()).toBe(true);

    // "Usar o padrão": apaga o do banco e volta a valer a variável (1000).
    const reset = await admin.del('/api/admin/settings/ai.runs_per_minute');
    expect(reset).toMatchObject({ value: 1000, source: 'env' });
    const ok = await api.post(`/api/agents/${agent.id}/messages`, { text: 'agora vai' });
    expect(ok.run.status).toBe('queued');
    await drain();
  });
});

describe('painel de uso', () => {
  it('por dia, por modelo (com saúde), por finalidade e as conversas mais caras, com filtros; só admin', async () => {
    const user = await userSession(h);
    const api = client(h, user.cookie);
    llm.queue = [{ text: 'Resposta cara.', usage: { input: 1_000_000, output: 100_000, cacheRead: 500_000 } }];
    const sent = await api.post(`/api/agents/${agent.id}/messages`, { text: 'olá' });
    await drain();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    await api.get(`/api/admin/ai/usage/panel?from=${today}&to=${today}`, 403);
    const bad = await admin.raw('GET', `/api/admin/ai/usage/panel?from=${today}&to=2020-01-01`);
    expect(bad.statusCode).toBe(400);

    const panel = await admin.get(`/api/admin/ai/usage/panel?from=${today}&to=${today}&userId=${user.id}`);
    expect(panel).toMatchObject({ from: today, to: today, healthDays: 1 });
    const chatDay = panel.daily.find((d: any) => d.agentId === agent.id && d.currency === 'USD');
    expect(chatDay).toMatchObject({ day: today, providerId: provider.id, providerName: provider.name, agentName: agent.name });
    expect(chatDay.inputTokens).toBeGreaterThanOrEqual(1_000_000);
    expect(chatDay.cacheReadTokens).toBeGreaterThanOrEqual(500_000);
    const model = panel.byModel.find((m: any) => m.model === MODEL);
    expect(model).toMatchObject({ providerId: provider.id, currency: 'USD' });
    expect(model.health).toMatchObject({ errors: 0 });
    expect(model.health.requests).toBeGreaterThan(0);
    expect(panel.byPurpose.map((p: any) => p.purpose)).toContain('chat');
    expect(panel.topConversations[0]).toMatchObject({
      rank: 1,
      conversationId: sent.conversation.id,
      userId: user.id,
      username: user.username,
      agentId: agent.id,
      purpose: 'chat',
      currency: 'USD',
      archived: false,
    });
    // Filtro por finalidade sem uso: tudo vazio.
    const none = await admin.get(`/api/admin/ai/usage/panel?from=${today}&to=${today}&userId=${user.id}&purpose=speech`);
    expect([none.daily, none.byModel, none.byPurpose, none.topConversations]).toEqual([[], [], [], []]);
  });
});
