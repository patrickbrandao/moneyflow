import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scheduleText } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import {
  buttonData,
  callbackUpdate,
  type FakeTelegram,
  groupUpdate,
  photoUpdate,
  startFakeTelegram,
  textUpdate,
  voiceUpdate,
} from '../../../e2e/fakes/fake-telegram';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { drainTranscriptions } from '../src/agents/transcriptions';
import { tasksTick } from '../src/services/agent-tasks';
import { client, type Harness, scenario, startApp, TINY_PNG, uid, userSession } from './helpers';

/*
 * Fluxos autônomos dos agentes (spec 029), com o provedor de IA falso e a Bot
 * API falsa: tarefas agendadas (disparo único, atraso de até 6 h, pulado com
 * execução ativa, ask aguardando com o sino, orçamento de fluxos), conciliação
 * completa ao importar (kit allow concilia, ask gera o lote, desligado mantém
 * as sugestões, roda como quem importou) e o Telegram de entrada (segredo,
 * dedup, chat não pareado, código de uso único que expira, sessão ativa do
 * console, nota de voz transcrita, botões Aprovar/Recusar, comandos).
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let tg: FakeTelegram;
type Api = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof userSession>>;
let adminSession: Session;
let admin: Api;
let provider: { id: string };
let audioProvider: { id: string };
/** Kit com as escritas em ask (o "Padrão") e um com tudo em allow. */
let askAgent: { id: string; name: string };
let allowAgent: { id: string; name: string };
let audioAgent: { id: string; name: string };
const createdAgents: string[] = [];
let base: Awaited<ReturnType<typeof scenario>>;

/** Usuário comum que edita uma caixa (cadastra entidades, como as tools pedem). */
async function editorUser() {
  const session = await userSession(h);
  await admin.post(`/api/caixas/${base.caixaA.id}/members`, { userId: session.id, role: 'editor' });
  return session;
}

const deps = () => ({ db: h.db, config: h.config, log });

async function drain() {
  for (let i = 0; i < 60; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun(deps(), run);
  }
}

async function runOf(runId: string) {
  const r = await h.db.execute<{ status: string; user_id: string; conversation_id: string; error: string | null }>(
    sql`SELECT status, user_id, conversation_id, error FROM ai_runs WHERE id = ${runId}`,
  );
  return r.rows[0]!;
}

async function makeAgent(name: string, toolKitId: string | null, providerId = provider.id, model = 'claude-sonnet-5-5') {
  const agent = await admin.post('/api/admin/ai/agents', {
    name: `${name} ${uid()}`,
    systemPrompt: 'Agente dos testes da F15.',
    defaultProviderId: providerId,
    model,
    params: { max_tokens: 2000, max_tool_iterations: 6 },
    toolKitId,
    isActive: true,
  });
  createdAgents.push(agent.id);
  return agent;
}

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  tg = await startFakeTelegram(0, '127.0.0.1');
  h = await startApp({
    TELEGRAM_API_BASE: tg.url,
    TELEGRAM_TIMEOUT_MS: '3000',
    PUBLIC_BASE_URL: 'https://moneyflow.test',
    AI_TRANSCRIPTION_TIMEOUT_MS: '2500',
    AI_REQUEST_BACKOFF_MS: '0',
  });
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F15 ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-f15',
    defaultModels: { text: 'claude-sonnet-5-5' },
  });
  audioProvider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F15 áudio ${uid()}`,
    kind: 'openai',
    apiKey: `sk-f15-${uid()}`,
    baseUrl: `${llm.url}/v1`,
    defaultModels: { text: 'fake-gpt', transcription: 'fake-whisper' },
  });
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  const askKit = await admin.post('/api/admin/ai/tool-kits', {
    name: `F15 ask ${uid()}`,
    tools: catalog.map((tool) => ({ name: tool.name, mode: tool.suggestedMode })),
  });
  const allowKit = await admin.post('/api/admin/ai/tool-kits', {
    name: `F15 allow ${uid()}`,
    tools: catalog.filter((tool) => !tool.secret).map((tool) => ({ name: tool.name, mode: 'allow' })),
  });
  askAgent = await makeAgent('Agente F15 ask', askKit.id);
  allowAgent = await makeAgent('Agente F15 allow', allowKit.id);
  audioAgent = await makeAgent('Agente F15 áudio', askKit.id, audioProvider.id, 'fake-gpt');
  base = await scenario(h, admin);
  // Banco reaproveitado: sobras de rodadas anteriores saem da fila antes dos casos.
  await drainTranscriptions(deps());
  await drain();
});

afterAll(async () => {
  await h.db.execute(sql`UPDATE ai_scheduled_tasks SET is_active = false WHERE agent_id = ANY (${`{${createdAgents.join(',')}}`}::uuid[])`);
  for (const id of createdAgents) await admin.patch(`/api/admin/ai/agents/${id}`, { isActive: false, useForFlows: false });
  await admin.patch(`/api/admin/ai/providers/${provider.id}`, { isActive: false });
  await admin.patch(`/api/admin/ai/providers/${audioProvider.id}`, { isActive: false });
  await h.close();
  await llm.close();
  await tg.close();
});

beforeEach(() => {
  llm.queue = [];
});

/* ====================================================================================================== */

describe('tarefas agendadas', () => {
  /** Agenda diária N horas atrás (São Paulo) e o próximo disparo forçado para esse horário já passado. */
  async function dueHoursAgo(taskId: string, hours: number) {
    await h.db.execute(sql`
      UPDATE ai_scheduled_tasks
         SET schedule = jsonb_build_object('kind', 'daily', 'time',
                          to_char((now() AT TIME ZONE 'America/Sao_Paulo') - make_interval(hours => ${hours}), 'HH24:MI'))
       WHERE id = ${taskId}`);
    await h.db.execute(sql`UPDATE ai_scheduled_tasks SET next_run_at = ai_schedule_prev_run(schedule, now()) WHERE id = ${taskId}`);
  }

  async function runsOf(taskId: string) {
    const r = await h.db.execute<{ status: string; skip_reason: string | null; run_id: string | null; conversation_id: string | null }>(
      sql`SELECT status, skip_reason, run_id, conversation_id FROM ai_scheduled_task_runs WHERE task_id = ${taskId} ORDER BY created_at`,
    );
    return r.rows;
  }

  it('cadastro: as próprias em Minha conta, o admin para qualquer um; agenda em texto e próximo disparo do banco', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const other = client(h, (await userSession(h)).cookie);
    const task = await me.post('/api/account/agent-tasks', {
      agentId: askAgent.id,
      name: 'Resumo da semana',
      instruction: 'Olá',
      schedule: { kind: 'weekly', time: '08:00', weekdays: [3, 1] },
      // Pela conta, o dono é sempre quem cria.
      userId: adminSession.id,
    });
    expect(task).toMatchObject({ userId: owner.id, createdByUserId: owner.id, isActive: true, lastRun: null });
    expect(task.schedule).toEqual({ kind: 'weekly', time: '08:00', weekdays: [1, 3] });
    expect(scheduleText(task.schedule)).toBe('toda segunda e quarta às 08:00');
    expect(task.nextRunAt).not.toBeNull();
    await other.raw('GET', `/api/account/agent-tasks/${task.id}`).then((res) => expect(res.statusCode).toBe(404));
    expect(await other.get('/api/account/agent-tasks')).toEqual([]);
    const off = await me.patch(`/api/account/agent-tasks/${task.id}`, { isActive: false });
    expect(off.nextRunAt).toBeNull();
    const bad = await me.raw('POST', '/api/account/agent-tasks', {
      agentId: askAgent.id,
      name: 'x',
      instruction: 'y',
      schedule: { kind: 'monthly', time: '25:00' },
    });
    expect(bad.statusCode).toBe(400);

    // O admin cria para outro usuário e vê todas.
    const forOwner = await admin.post('/api/admin/ai/agent-tasks', {
      userId: owner.id,
      agentId: askAgent.id,
      name: 'Do admin',
      instruction: 'Olá',
      schedule: { kind: 'monthly', time: '07:30', day: 'last' },
    });
    expect(forOwner).toMatchObject({ userId: owner.id, createdByUserId: adminSession.id });
    expect(scheduleText(forOwner.schedule)).toBe('todo último dia do mês às 07:30');
    const all = await admin.get(`/api/admin/ai/agent-tasks?userId=${owner.id}`);
    expect(all.map((x: any) => x.id).sort()).toEqual([task.id, forOwner.id].sort());
    expect((await me.raw('GET', '/api/admin/ai/agent-tasks')).statusCode).toBe(403);
    await me.del(`/api/account/agent-tasks/${forOwner.id}`);
    expect(await me.get('/api/account/agent-tasks')).toHaveLength(1);
  });

  it('dispara uma vez por horário (com a sessão e a execução ligadas); atraso de até 6 h roda, acima disso pula', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const task = await me.post('/api/account/agent-tasks', {
      agentId: askAgent.id,
      name: `Diária ${uid()}`,
      instruction: 'Olá, tarefa',
      schedule: { kind: 'daily', time: '06:00' },
    });
    await dueHoursAgo(task.id, 5);
    await tasksTick(h.db, h.config);
    let runs = await runsOf(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'started', skip_reason: null });
    expect(runs[0]!.run_id).toBeTruthy();
    // O mesmo horário não dispara de novo (o próximo foi para depois de agora; forçado de volta, o único barra).
    await tasksTick(h.db, h.config);
    await h.db.execute(sql`UPDATE ai_scheduled_tasks SET next_run_at = ai_schedule_prev_run(schedule, now()) WHERE id = ${task.id}`);
    await tasksTick(h.db, h.config);
    expect(await runsOf(task.id)).toHaveLength(1);

    const conversation = await h.db.execute<{ purpose: string; user_id: string; archived: boolean; title: string }>(sql`
      SELECT purpose, user_id, archived_at IS NOT NULL AS archived, title FROM ai_conversations WHERE id = ${runs[0]!.conversation_id}`);
    expect(conversation.rows[0]).toMatchObject({ purpose: 'scheduled_task', user_id: owner.id, archived: true });
    expect(conversation.rows[0]!.title).toContain(task.name);
    await drain();
    expect(await runOf(runs[0]!.run_id!)).toMatchObject({ status: 'completed', user_id: owner.id });
    const usage = await h.db.execute<{ purpose: string }>(sql`SELECT DISTINCT purpose FROM ai_usage WHERE run_id = ${runs[0]!.run_id}`);
    expect(usage.rows.map((r) => r.purpose)).toEqual(['scheduled_task']);
    // A sessão da tarefa fica fora do fio do chat.
    const threads = await me.get('/api/agents/threads');
    expect(threads.find((x: any) => x.agentId === askAgent.id)?.active ?? null).toBeNull();
    const history = await me.get(`/api/account/agent-tasks/${task.id}/runs`);
    expect(history[0]).toMatchObject({ status: 'started', runStatus: 'completed', conversationId: runs[0]!.conversation_id });

    // 8 h de atraso: pulado (missed_window), registrado.
    await dueHoursAgo(task.id, 8);
    await tasksTick(h.db, h.config);
    runs = await runsOf(task.id);
    expect(runs.at(-1)).toMatchObject({ status: 'skipped', skip_reason: 'missed_window', run_id: null });
    expect((await me.get(`/api/account/agent-tasks/${task.id}`)).lastRun).toMatchObject({ status: 'skipped', skipReason: 'missed_window' });
  });

  it('pula com a execução anterior ativa; "Rodar agora" do dono e do admin', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const task = await me.post('/api/account/agent-tasks', {
      agentId: askAgent.id,
      name: `Ativa ${uid()}`,
      instruction: 'Olá',
      schedule: { kind: 'daily', time: '06:00' },
      isActive: false,
    });
    const first = await me.post(`/api/account/agent-tasks/${task.id}/run`);
    expect(first).toMatchObject({ triggerKind: 'manual', status: 'started', runStatus: 'queued' });
    // Pelo agendamento, com a anterior na fila: pulado.
    await me.patch(`/api/account/agent-tasks/${task.id}`, { isActive: true });
    await dueHoursAgo(task.id, 1);
    await tasksTick(h.db, h.config);
    expect((await runsOf(task.id)).at(-1)).toMatchObject({ status: 'skipped', skip_reason: 'previous_run_active' });
    // O admin roda a tarefa de outro: também pulado enquanto a anterior roda.
    const byAdmin = await admin.post(`/api/admin/ai/agent-tasks/${task.id}/run`);
    expect(byAdmin).toMatchObject({ status: 'skipped', skipReason: 'previous_run_active' });
    await drain();
    const again = await admin.post(`/api/admin/ai/agent-tasks/${task.id}/run`);
    expect(again.status).toBe('started');
    // A execução é do dono, não de quem clicou.
    expect((await runOf(again.runId)).user_id).toBe(owner.id);
    await drain();
    expect((await client(h, (await userSession(h)).cookie).raw('POST', `/api/account/agent-tasks/${task.id}/run`)).statusCode).toBe(404);
  });

  it('a escrita em ask deixa a execução aguardando e o sino avisa (ai_awaiting_approval); aprovar conclui', async () => {
    const owner = await editorUser();
    const me = client(h, owner.cookie);
    const name = `Entidade da tarefa ${uid()}`;
    const task = await me.post('/api/account/agent-tasks', {
      agentId: askAgent.id,
      name: `Cadastro ${uid()}`,
      instruction: `criar entidade ${name}`,
      schedule: { kind: 'daily', time: '06:00' },
    });
    const started = await me.post(`/api/account/agent-tasks/${task.id}/run`);
    await drain();
    expect((await runOf(started.runId)).status).toBe('awaiting_confirmation');
    const bell = await me.get('/api/notifications');
    const notice = bell.items.find((n: any) => n.kind === 'ai_awaiting_approval');
    expect(notice).toMatchObject({ title: `A tarefa ${task.name} espera sua aprovação`, link: `/?conversation=${started.conversationId}` });
    // O aviso de conclusão comum não duplica a espera.
    expect(bell.items.filter((n: any) => n.kind === 'agent_completed')).toHaveLength(0);
    await me.post(`/api/runs/${started.runId}/confirmations`, { decision: 'approved' });
    await drain();
    expect((await runOf(started.runId)).status).toBe('completed');
    const entity = await h.db.execute(sql`SELECT 1 FROM entities WHERE name = ${name}`);
    expect(entity.rows).toHaveLength(1);
  });

  it('orçamento de fluxos estourado pula o disparo (budget_exceeded)', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const price = await admin.post('/api/admin/ai/prices', {
      providerId: provider.id,
      model: 'claude-sonnet-5-5',
      inputPricePerMillion: 2,
      outputPricePerMillion: 10,
    });
    const budget = await admin.post('/api/admin/ai/budgets', { scope: 'flows', monthlyLimit: 0.000001 });
    try {
      await h.db.execute(sql`
        INSERT INTO ai_usage (provider_id, model, user_id, purpose, input_tokens)
        VALUES (${provider.id}, 'claude-sonnet-5-5', ${owner.id}, 'document_reading', 100)`);
      const task = await me.post('/api/account/agent-tasks', {
        agentId: askAgent.id,
        name: `Orçamento ${uid()}`,
        instruction: 'Olá',
        schedule: { kind: 'daily', time: '06:00' },
      });
      await dueHoursAgo(task.id, 1);
      await tasksTick(h.db, h.config);
      expect((await runsOf(task.id)).at(-1)).toMatchObject({ status: 'skipped', skip_reason: 'budget_exceeded', run_id: null });
      expect((await me.post(`/api/account/agent-tasks/${task.id}/run`)).status).toBe('skipped');
    } finally {
      // O preço fica (o uso medido o referencia); o provedor é desativado no fim.
      await admin.del(`/api/admin/ai/budgets/${budget.id}`);
      void price;
    }
  });

  it('tools: list/create/update/delete/run_agent_task_now com prévia; o usuário só as próprias, o admin as de qualquer um', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const session = await me.post(`/api/agents/${askAgent.id}/sessions`);
    const sent = await me.post(`/api/conversations/${session.id}/messages`, {
      text: `chamar create_agent_task ${JSON.stringify({
        agentId: askAgent.id,
        name: 'Pela tool',
        instruction: 'Olá',
        schedule: { kind: 'daily', time: '09:15' },
      })}`,
    });
    await drain();
    let detail = await me.get(`/api/conversations/${session.id}`);
    const card = detail.confirmations.find((c: any) => c.status === 'pending');
    expect(card.preview.rows.find((r: any) => r.label === 'Agenda').after).toBe('todo dia às 09:15');
    await me.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' });
    await drain();
    const tasks = await me.get('/api/account/agent-tasks');
    expect(tasks.map((x: any) => x.name)).toContain('Pela tool');

    // Para outro usuário, só o admin (o usuário recebe o erro na tool).
    const other = await me.post(`/api/conversations/${session.id}/messages`, {
      text: `chamar create_agent_task ${JSON.stringify({
        userId: adminSession.id,
        agentId: askAgent.id,
        name: 'Alheia',
        instruction: 'Olá',
        schedule: { kind: 'daily', time: '09:15' },
      })}`,
    });
    await drain();
    detail = await me.get(`/api/conversations/${session.id}`);
    const toolMessage = detail.messages.filter((m: any) => m.role === 'tool').at(-1);
    expect(toolMessage.content[0].is_error).toBe(true);
    expect((await runOf(other.run.id)).status).toBe('completed');
    await me.post(`/api/conversations/${session.id}/finish`);
  });
});

/* ====================================================================================================== */

describe('conciliação completa ao importar', () => {
  const ofx = () => readFileSync(join(import.meta.dirname, 'fixtures', 'extrato-ofx1.ofx'));

  async function setup(agent: { id: string }) {
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { useForFlows: true });
    const s = await scenario(h, admin);
    const editor = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editor.id, role: 'editor' });
    return { s, editor, api: client(h, editor.cookie) };
  }

  async function importAs(editor: Session, accountId: string) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports?accountId=${accountId}&fileName=extrato.ofx`,
      payload: ofx(),
      headers: { cookie: editor.cookie, 'content-type': 'application/x-ofx' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it('desligado: o import mantém as sugestões de classificação (classify_lines)', async () => {
    const { s, editor, api } = await setup(allowAgent);
    const state = await api.get(`/api/statement-imports/${(await importAs(editor, s.accountA.id)).id}/reconcile-ai`);
    expect(state).toMatchObject({ autoEnabled: false, run: null, agent: { id: allowAgent.id, hasKit: true } });
    const s2 = await scenario(h, admin);
    await admin.post(`/api/caixas/${s2.caixaA.id}/members`, { userId: editor.id, role: 'editor' });
    const imp = await importAs(editor, s2.accountA.id);
    expect(imp.aiSuggestion?.queued).toBe(true);
    expect(imp.aiReconcile).toBeUndefined();
    await drain();
  });

  it('kit em allow: concilia e lança sozinho, como quem importou (ator agent)', async () => {
    const { s, editor, api } = await setup(allowAgent);
    // O interruptor fica na conta (só corrente/poupança).
    await api.patch(`/api/accounts/${s.accountA.id}`, { aiAutoReconcile: true });
    expect((await api.raw('PATCH', `/api/accounts/${s.accountB.id}`, { aiAutoReconcile: true })).statusCode).toBe(404);
    const cofre = await admin.raw('PATCH', `/api/accounts/${s.accountB.id}`, { aiAutoReconcile: true });
    expect(cofre.statusCode).toBe(422);

    const imp = await importAs(editor, s.accountA.id);
    expect(imp.aiReconcile).toMatchObject({ queued: true });
    expect(imp.aiSuggestion).toBeUndefined();
    const lines = imp.lines.filter((l: any) => l.status === 'new');
    const debit = lines.find((l: any) => l.amountCents < 0)!;
    const others = lines.filter((l: any) => l.id !== debit.id).map((l: any) => l.id);
    llm.queue = [
      {
        toolCalls: [
          { name: 'create_from_statement_line', input: { lineId: debit.id, mode: 'adjustment', categoryId: s.expense.id } },
          { name: 'ignore_statement_lines', input: { lineIds: others } },
        ],
      },
      { text: 'Conciliei o lote.' },
    ];
    await drain();
    const run = await runOf(imp.aiReconcile.runId);
    expect(run).toMatchObject({ status: 'completed', user_id: editor.id });
    const detail = await api.get(`/api/statement-imports/${imp.id}`);
    expect(detail.lines.find((l: any) => l.id === debit.id).status).toBe('matched');
    expect(detail.lines.filter((l: any) => others.includes(l.id)).every((l: any) => l.status === 'ignored')).toBe(true);
    const audit = await h.db.execute<{ actor_kind: string; user_id: string }>(sql`
      SELECT actor_kind, user_id FROM audit_log WHERE table_name = 'statement_lines' AND record_id = ${debit.id} ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'agent', user_id: editor.id });
    // Só as tools internas do kit (nenhum MCP) e o prompt da conciliação.
    const call = llm.calls.filter((c) => c.path === '/v1/messages').at(-1)!;
    expect(JSON.stringify(call.body.system)).toContain('conciliar um lote de extrato');
    const state = await api.get(`/api/statement-imports/${imp.id}/reconcile-ai`);
    expect(state).toMatchObject({ autoEnabled: true, run: { status: 'completed' }, confirmations: [], canDecide: true });
  });

  it('kit com ask: gera o lote de confirmações; aprova as selecionadas e recusa o resto com motivo; o sino avisa quem importou', async () => {
    const { s, editor, api } = await setup(askAgent);
    const imp = await importAs(editor, s.accountA.id);
    await drain();
    // "Conciliar com IA" sob demanda (o interruptor está desligado).
    const lines = (await api.get(`/api/statement-imports/${imp.id}`)).lines.filter((l: any) => l.status === 'new');
    llm.queue = [
      { toolCalls: lines.slice(0, 3).map((l: any) => ({ name: 'ignore_statement_lines', input: { lineIds: [l.id] } })) },
      { text: 'Propus as ações.' },
    ];
    const started = await api.post(`/api/statement-imports/${imp.id}/reconcile-ai`);
    expect(started).toMatchObject({ queued: true });
    expect((await api.raw('POST', `/api/statement-imports/${imp.id}/reconcile-ai`)).statusCode).toBe(409);
    await drain();
    const state = await api.get(`/api/statement-imports/${imp.id}/reconcile-ai`);
    expect(state.run.status).toBe('awaiting_confirmation');
    expect(state.confirmations).toHaveLength(3);
    expect(state.canDecide).toBe(true);
    // Outro leitor vê o lote, mas não decide.
    expect((await admin.get(`/api/statement-imports/${imp.id}/reconcile-ai`)).canDecide).toBe(false);
    const bell = await api.get('/api/notifications');
    expect(bell.items.find((n: any) => n.kind === 'ai_awaiting_approval')).toMatchObject({
      title: 'A conciliação com IA de extrato.ofx espera sua aprovação',
    });
    const [first, ...rest] = state.confirmations;
    await api.post(`/api/runs/${state.run.id}/confirmations`, { decision: 'approved', ids: [first.id] });
    await api.post(`/api/runs/${state.run.id}/confirmations`, {
      decision: 'rejected',
      ids: rest.map((c: any) => c.id),
      reason: 'Ainda não',
    });
    await drain();
    const after = await api.get(`/api/statement-imports/${imp.id}`);
    const ignored = after.lines.filter((l: any) => l.status === 'ignored').map((l: any) => l.id);
    expect(ignored).toEqual([first.input.lineIds[0]]);
    expect((await runOf(state.run.id)).status).toBe('completed');
  });
});

/* ====================================================================================================== */

describe('Telegram de entrada', () => {
  const token = () =>
    `${700000 + Math.floor(Math.random() * 200000)}:AAF${uid().replace(/[^A-Za-z0-9]/g, '')}x${uid().replace(/[^A-Za-z0-9]/g, '')}`;
  let user: Session;
  let api: Api;
  let destination: any;
  let botToken: string;
  const chat = 900_000_000 + Math.floor(Math.random() * 90_000_000);

  async function hook(destinationId: string, update: object, secret?: string | null) {
    const webhook = [...tg.webhooks.values()].find((w) => w.url.endsWith(destinationId));
    const header = secret === undefined ? webhook?.secret : secret;
    return h.app.inject({
      method: 'POST',
      url: `/api/telegram/webhook/${destinationId}`,
      payload: update,
      headers: header === null ? {} : { 'x-telegram-bot-api-secret-token': header ?? '' },
    });
  }
  const said = (chatId: number) => tg.messagesTo(chatId).map((c) => String(c.body.text));

  async function pair(chatId: number, destinationId = destination.id, session: Session = user) {
    const code = await client(h, session.cookie).post('/api/account/telegram/pairing-codes', { destinationId });
    expect(code.code).toMatch(/^[A-Z0-9]{8}$/);
    const res = await hook(destinationId, textUpdate(chatId, `/start ${code.code.toLowerCase()}`, { username: 'tester_f15' }));
    expect(res.statusCode, res.body).toBe(200);
    return code;
  }

  beforeAll(async () => {
    user = await editorUser();
    api = client(h, user.cookie);
    botToken = token();
    destination = await api.post('/api/message-destinations', { name: `Bot F15 ${uid()}`, botToken, chatId: '-1001234567' });
  });

  it('ligar "Receber mensagens" chama setWebhook com o segredo (o Telegram recusou = nada muda); config da URL pública', async () => {
    expect(await api.get('/api/message-destinations/inbound-config')).toEqual({
      publicBaseUrl: 'https://moneyflow.test',
      source: 'env',
      available: true,
    });
    const noAgent = await api.raw('PATCH', `/api/message-destinations/${destination.id}`, { inboundEnabled: true });
    expect(noAgent.statusCode).toBe(422);
    tg.failNext.setWebhook = 1;
    const refused = await api.raw('PATCH', `/api/message-destinations/${destination.id}`, {
      inboundEnabled: true,
      inboundAgentId: askAgent.id,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toContain('O Telegram recusou o webhook');
    expect((await api.get(`/api/message-destinations/${destination.id}`)).inboundEnabled).toBe(false);

    const on = await api.patch(`/api/message-destinations/${destination.id}`, { inboundEnabled: true, inboundAgentId: askAgent.id });
    expect(on).toMatchObject({ inboundEnabled: true, inboundAgentId: askAgent.id, inboundAgentName: askAgent.name });
    const webhook = tg.webhooks.get(botToken)!;
    expect(webhook.url).toBe(`https://moneyflow.test/api/telegram/webhook/${destination.id}`);
    expect(webhook.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(webhook.allowedUpdates).toEqual(['message', 'callback_query']);
    // O segredo só fica como hash, ilegível pela aplicação e fora da auditoria.
    const stored = await h.db.execute<{ v: string }>(
      sql`SELECT admin_message_destination_webhook_secret(${destination.id}::uuid, ${adminSession.id}::uuid) AS v`,
    );
    expect(stored.rows[0]!.v).toBe(createHash('sha256').update(webhook.secret, 'utf8').digest('hex'));
    const audit = await h.db.execute<{ j: string }>(sql`
      SELECT coalesce(old_data::text, '') || coalesce(new_data::text, '') AS j FROM audit_log
       WHERE table_name = 'message_destinations' AND record_id = ${destination.id}`);
    expect(audit.rows.map((r) => r.j).join('')).not.toContain(stored.rows[0]!.v);

    // Outro destino com o mesmo bot não liga a entrada (um webhook por bot).
    const twin = await api.post('/api/message-destinations', { name: `Gêmeo ${uid()}`, botToken, chatId: '-1007654321' });
    const clash = await api.raw('PATCH', `/api/message-destinations/${twin.id}`, { inboundEnabled: true, inboundAgentId: askAgent.id });
    expect(clash.statusCode).toBe(409);
    await api.del(`/api/message-destinations/${twin.id}`);
  });

  it('segredo errado ou ausente dá 401; update_id repetido é ignorado; chat não pareado recebe o aviso; grupo é ignorado', async () => {
    expect((await hook(destination.id, textUpdate(chat + 1, 'oi'), 'segredo-errado')).statusCode).toBe(401);
    expect((await hook(destination.id, textUpdate(chat + 1, 'oi'), null)).statusCode).toBe(401);
    const update = textUpdate(chat + 1, 'oi');
    expect((await hook(destination.id, update)).statusCode).toBe(200);
    expect(said(chat + 1)).toEqual([expect.stringContaining('Este chat não está pareado com o MoneyFlow')]);
    expect((await hook(destination.id, update)).statusCode).toBe(200);
    expect(said(chat + 1)).toHaveLength(1);
    await hook(destination.id, groupUpdate(-100_555, chat + 1, 'oi'));
    expect(tg.messagesTo(-100_555)).toHaveLength(0);
  });

  it('o código de pareamento é de uso único e expira; parear liga o chat ao usuário', async () => {
    const code = await pair(chat);
    expect(said(chat).at(-1)).toContain(`Pareado com o MoneyFlow como ${user.username}`);
    const link = (await api.get('/api/account/telegram')).links[0];
    expect(link).toMatchObject({ destinationId: destination.id, chatId: String(chat), telegramUsername: 'tester_f15', revokedAt: null });
    // De novo, noutro chat: já usado.
    await hook(destination.id, textUpdate(chat + 2, `/start ${code.code}`));
    expect(said(chat + 2).at(-1)).toContain('Código inválido, expirado ou já usado');
    // Expirado (gravado já vencido).
    const expired = `EX${uid()
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .padEnd(6, '7')
      .slice(0, 6)}`;
    await h.db.execute(sql`
      INSERT INTO telegram_pairing_codes (user_id, destination_id, code_hash, created_at, expires_at)
      VALUES (${user.id}, ${destination.id}, ${createHash('sha256').update(expired, 'utf8').digest('hex')}, now() - interval '20 minutes',
              now() - interval '11 minutes')`);
    await hook(destination.id, textUpdate(chat + 3, `/start ${expired}`));
    expect(said(chat + 3).at(-1)).toContain('Código inválido, expirado ou já usado');
    // Outro usuário não gera código para um destino pessoal alheio.
    const stranger = client(h, (await userSession(h)).cookie);
    expect((await stranger.raw('POST', '/api/account/telegram/pairing-codes', { destinationId: destination.id })).statusCode).toBe(404);
    expect((await stranger.get('/api/account/telegram')).destinations).toEqual([]);
    expect((await admin.get('/api/account/telegram?all=true')).links.some((l: any) => l.id === link.id)).toBe(true);
  });

  it('a mensagem entra na sessão ativa do console; "digitando…"; a resposta volta em HTML; com a anterior rodando, "aguarde"', async () => {
    const session = await api.post(`/api/agents/${askAgent.id}/sessions`);
    await hook(destination.id, textUpdate(chat, 'Olá pelo Telegram'));
    await hook(destination.id, textUpdate(chat, 'Outra antes da resposta'));
    expect(said(chat).at(-1)).toContain('Ainda estou trabalhando na anterior: aguarde ou envie /parar');
    const typingBefore = tg.calls.filter((c) => c.method === 'sendChatAction').length;
    await drain();
    expect(tg.calls.filter((c) => c.method === 'sendChatAction').length).toBeGreaterThan(typingBefore);
    const thread = await api.get(`/api/agents/${askAgent.id}/thread`);
    expect(thread.session.conversation.id).toBe(session.id);
    expect(thread.session.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(thread.session.messages[0].content[0].text).toBe('Olá pelo Telegram');
    const reply = tg.messagesTo(chat).at(-1)!;
    expect(reply.body).toMatchObject({ parse_mode: 'HTML', text: 'Olá! Sou o agente de teste.' });
  });

  it('botões: Aprovar decide a confirmação; Recusar pede o motivo na mensagem seguinte; quem decide primeiro vale', async () => {
    const name = `Entidade TG ${uid()}`;
    await hook(destination.id, textUpdate(chat, `criar entidade ${name}`));
    await drain();
    const card = tg.messagesTo(chat).at(-1)!;
    expect(String(card.body.text)).toContain('<b>Aprovar?</b>');
    const approve = buttonData(card, 'Aprovar')!;
    expect(approve).toMatch(/^ok:/);
    await hook(destination.id, callbackUpdate(chat, approve));
    expect(tg.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    // O mesmo botão de novo: já decidida.
    await hook(destination.id, callbackUpdate(chat, approve));
    await drain();
    expect((await h.db.execute(sql`SELECT 1 FROM entities WHERE name = ${name}`)).rows).toHaveLength(1);
    expect(said(chat).at(-1)).toContain('Pronto:');

    const other = `Recusada TG ${uid()}`;
    await hook(destination.id, textUpdate(chat, `criar entidade ${other}`));
    await drain();
    const reject = buttonData(tg.messagesTo(chat).at(-1), 'Recusar')!;
    await hook(destination.id, callbackUpdate(chat, reject));
    expect(said(chat).at(-1)).toContain('Envie o motivo');
    await hook(destination.id, textUpdate(chat, 'Não quero esse cadastro'));
    expect(said(chat).at(-1)).toContain('Recusado');
    const decided = await h.db.execute<{ status: string; reason: string }>(
      sql`SELECT status, reason FROM ai_tool_confirmations WHERE id = ${reject.slice(3)}`,
    );
    expect(decided.rows[0]).toMatchObject({ status: 'rejected', reason: 'Não quero esse cadastro' });
    await drain();
    expect((await h.db.execute(sql`SELECT 1 FROM entities WHERE name = ${other}`)).rows).toHaveLength(0);
  });

  it('comandos /agente, /parar, /nova e /ajuda', async () => {
    await hook(destination.id, textUpdate(chat, '/agente'));
    expect(said(chat).at(-1)).toContain(askAgent.name);
    await hook(destination.id, textUpdate(chat, '/parar'));
    expect(said(chat).at(-1)).toContain('Nenhuma execução em andamento');
    await hook(destination.id, textUpdate(chat, 'devagar'));
    await hook(destination.id, textUpdate(chat, '/parar'));
    expect(said(chat).at(-1)).toContain('Execução parada');
    await hook(destination.id, textUpdate(chat, '/nova'));
    expect(said(chat).at(-1)).toContain('Sessão finalizada');
    expect((await api.get(`/api/agents/${askAgent.id}/thread`)).session).toBeNull();
    await hook(destination.id, textUpdate(chat, '/ajuda'));
    expect(said(chat).at(-1)).toContain('/nova');
  });

  it('nota de voz é transcrita e entra na conversa; foto vira anexo; agente sem transcrição avisa o que não leu', async () => {
    const voiceToken = token();
    const voiceDest = await api.post('/api/message-destinations', {
      name: `Bot voz ${uid()}`,
      botToken: voiceToken,
      chatId: '-1009998887',
    });
    await api.patch(`/api/message-destinations/${voiceDest.id}`, { inboundEnabled: true, inboundAgentId: audioAgent.id });
    const voiceChat = chat + 50;
    await pair(voiceChat, voiceDest.id);
    const audio = Buffer.from('OggS fake voice note');
    const fileId = tg.addFile(audio, 'audio/ogg', 'oga');
    await hook(voiceDest.id, voiceUpdate(voiceChat, fileId, audio.length));
    expect(tg.calls.some((c) => c.method === 'getFile' && c.body.file_id === fileId)).toBe(true);
    await drainTranscriptions(deps());
    await drain();
    const thread = await api.get(`/api/agents/${audioAgent.id}/thread`);
    const attachment = thread.session.attachments[0];
    expect(attachment).toMatchObject({ mimeType: 'audio/ogg', durationMs: 3000 });
    expect(attachment.transcription).toMatchObject({ status: 'done', text: `transcrição de teste (${audio.length} bytes)` });
    expect(JSON.stringify(llm.calls.filter((c) => c.path === '/v1/chat/completions').at(-1)!.body)).toContain('transcrição de teste');

    // Foto com legenda: vira anexo da mensagem.
    const photoId = tg.addFile(TINY_PNG, 'image/png', 'jpg');
    await hook(voiceDest.id, photoUpdate(voiceChat, photoId, TINY_PNG.length, 'Veja a foto'));
    await drain();
    const withPhoto = await api.get(`/api/agents/${audioAgent.id}/thread`);
    const photoMessage = withPhoto.session.messages.filter((m: any) => m.role === 'user').at(-1);
    expect(photoMessage.content.map((b: any) => b.type)).toEqual(['attachment', 'text']);
    expect(photoMessage.content[0]).toMatchObject({ mime_type: 'image/jpeg', file_name: expect.stringMatching(/^foto-/) });
    await api.patch(`/api/message-destinations/${voiceDest.id}`, { inboundEnabled: false });
    expect(tg.webhooks.has(voiceToken)).toBe(false);

    // Agente sem áudio→texto: avisa o que não leu e não manda nada ao agente.
    const before = (await api.get(`/api/agents/${askAgent.id}/thread`)).session?.messages.length ?? 0;
    const lost = tg.addFile(audio, 'audio/ogg', 'oga');
    await hook(destination.id, voiceUpdate(chat, lost, audio.length));
    expect(said(chat).at(-1)).toContain('O agente não transcreve áudio');
    expect((await api.get(`/api/agents/${askAgent.id}/thread`)).session?.messages.length ?? 0).toBe(before);
  });

  it('desfazer o pareamento; desativar o destino desliga a entrada no mesmo UPDATE e chama deleteWebhook', async () => {
    const links = (await api.get('/api/account/telegram')).links.filter((l: any) => !l.revokedAt && l.destinationId === destination.id);
    await api.del(`/api/account/telegram/links/${links[0].id}`);
    await hook(destination.id, textUpdate(chat, 'oi de novo'));
    expect(said(chat).at(-1)).toContain('não está pareado');
    const off = await api.patch(`/api/message-destinations/${destination.id}`, { isActive: false });
    expect(off).toMatchObject({ isActive: false, inboundEnabled: false });
    expect(tg.webhooks.has(botToken)).toBe(false);
    // Desligada a entrada, o webhook recusa.
    expect((await hook(destination.id, textUpdate(chat, 'oi'), 'qualquer')).statusCode).toBe(401);
  });
});
