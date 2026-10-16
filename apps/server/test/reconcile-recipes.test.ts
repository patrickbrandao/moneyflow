import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { recipesTick } from '../src/services/reconcile-recipes';
import { client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * Receitas de conciliação (spec 030), com o provedor de IA falso: cadastro e
 * permissão (leitor só vê, global só o admin, variável desconhecida), o play
 * com kit allow conciliando nas linhas do escopo, a linha fora do escopo
 * recusada pela tool, o 409 com execução ativa no lote e a sequência de duas
 * receitas ao importar (a segunda só com o que sobrou).
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
type Api = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof userSession>>;
let admin: Api;
let provider: { id: string };
let agent: { id: string; name: string };

const ofx = () => readFileSync(join(import.meta.dirname, 'fixtures', 'extrato-ofx1.ofx'));

async function drain() {
  for (let i = 0; i < 60; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

/** Caixa com um editor e um leitor. */
async function setup() {
  const s = await scenario(h, admin);
  const editor = await userSession(h);
  const viewer = await userSession(h);
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editor.id, role: 'editor' });
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewer.id, role: 'viewer' });
  return { s, editor, viewer, api: client(h, editor.cookie), viewerApi: client(h, viewer.cookie) };
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

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  h = await startApp({ AI_REQUEST_BACKOFF_MS: '0' });
  admin = client(h, (await userSession(h, 'admin')).cookie);
  provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F16 ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-f16',
    defaultModels: { text: 'claude-sonnet-5-5' },
  });
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  const allowKit = await admin.post('/api/admin/ai/tool-kits', {
    name: `F16 allow ${uid()}`,
    tools: catalog.filter((tool) => !tool.secret).map((tool) => ({ name: tool.name, mode: 'allow' })),
  });
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente F16 ${uid()}`,
    systemPrompt: 'Agente dos testes da F16.',
    defaultProviderId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 2000, max_tool_iterations: 6 },
    toolKitId: allowKit.id,
    isActive: true,
  });
  await drain();
});

afterAll(async () => {
  await admin.patch(`/api/admin/ai/agents/${agent.id}`, { isActive: false });
  await admin.patch(`/api/admin/ai/providers/${provider.id}`, { isActive: false });
  await h.close();
  await llm.close();
});

beforeEach(() => {
  llm.queue = [];
});

describe('receitas de conciliação', () => {
  it('cadastro: quem escreve na caixa edita, o leitor só vê, global só o admin; variável desconhecida recusada', async () => {
    const { s, api, viewerApi } = await setup();
    const recipe = await api.post('/api/reconcile-recipes', {
      caixaId: s.caixaA.id,
      agentId: agent.id,
      name: 'Tarifas',
      instruction: 'Ignore as tarifas de {{conta.nome}}.',
      accountIds: [s.accountA.id],
    });
    expect(recipe).toMatchObject({
      canEdit: true,
      caixaName: s.caixaA.name,
      agentHasKit: true,
      targets: [{ kind: 'account', id: s.accountA.id }],
    });

    const seen = await viewerApi.get(`/api/reconcile-recipes?caixaId=${s.caixaA.id}`);
    expect(seen.map((r: any) => r.id)).toEqual([recipe.id]);
    expect(seen[0].canEdit).toBe(false);
    expect((await viewerApi.raw('PATCH', `/api/reconcile-recipes/${recipe.id}`, { name: 'x' })).statusCode).toBe(403);
    expect(
      (await viewerApi.raw('POST', '/api/reconcile-recipes', { caixaId: s.caixaA.id, agentId: agent.id, name: 'y', instruction: 'z' }))
        .statusCode,
    ).toBe(403);

    const unknown = await api.raw('POST', '/api/reconcile-recipes', {
      caixaId: s.caixaA.id,
      agentId: agent.id,
      name: 'Errada',
      instruction: 'Use {{lote.inexistente}}',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain('{{lote.inexistente}}');

    // Global: só o admin.
    const globalBody = { caixaId: null, agentId: agent.id, name: `Global ${uid()}`, instruction: 'Concilie {{lote.arquivo}}.' };
    expect((await api.raw('POST', '/api/reconcile-recipes', globalBody)).statusCode).toBe(403);
    const global = await admin.post('/api/reconcile-recipes', globalBody);
    expect(global.caixaId).toBeNull();
    expect((await api.get('/api/reconcile-recipes?caixaId=global')).some((r: any) => r.id === global.id && !r.canEdit)).toBe(true);

    // "Rodar ao importar" exige vínculo (checado no COMMIT).
    const noTarget = await api.raw('PATCH', `/api/reconcile-recipes/${recipe.id}`, { runOnImport: true, accountIds: [] });
    expect(noTarget.statusCode).toBe(422);

    const updated = await api.patch(`/api/reconcile-recipes/${recipe.id}`, { name: 'Tarifas do banco', position: 3 });
    expect(updated).toMatchObject({ name: 'Tarifas do banco', position: 3 });
    expect((await api.del(`/api/reconcile-recipes/${recipe.id}`)).archived).toBe(true);
    const archived = await api.get(`/api/reconcile-recipes?caixaId=${s.caixaA.id}&archived=true`);
    expect(archived.find((r: any) => r.id === recipe.id)).toMatchObject({ isActive: false });
    await admin.del(`/api/reconcile-recipes/${global.id}`);
  });

  it('play com kit allow concilia só o escopo: a tool recusa a linha fora dele; 409 com execução ativa no lote', async () => {
    const { s, editor, api } = await setup();
    const recipe = await api.post('/api/reconcile-recipes', {
      caixaId: s.caixaA.id,
      agentId: agent.id,
      name: 'Débitos',
      instruction: 'Lance os débitos de {{lote.arquivo}} ({{linhas.total}} linha(s)).',
      accountIds: [s.accountA.id],
    });
    const imp = await importAs(editor, s.accountA.id);
    await drain(); // as sugestões de classificação do import (interruptor desligado)
    const panel = await api.get(`/api/statement-imports/${imp.id}/recipes`);
    expect(panel.recipes[0]).toMatchObject({ id: recipe.id, linked: true });
    expect(panel).toMatchObject({ busy: false, canRun: true });
    const lines = (await api.get(`/api/statement-imports/${imp.id}`)).lines.filter((l: any) => l.status === 'new');
    const debit = lines.find((l: any) => l.amountCents < 0)!;
    const other = lines.find((l: any) => l.id !== debit.id)!;

    const started = await api.post(`/api/statement-imports/${imp.id}/recipes/${recipe.id}/run`, { lineIds: [debit.id] });
    expect(started).toMatchObject({ lines: 1, run: { status: 'started', triggerKind: 'manual', lineCount: 1 } });
    // Uma execução de conciliação por lote: o play e a conciliação genérica respondem 409.
    expect((await api.raw('POST', `/api/statement-imports/${imp.id}/recipes/${recipe.id}/run`, {})).statusCode).toBe(409);
    expect((await api.raw('POST', `/api/statement-imports/${imp.id}/reconcile-ai`)).statusCode).toBe(409);

    llm.queue = [
      {
        toolCalls: [
          { name: 'ignore_statement_lines', input: { lineIds: [other.id] } },
          { name: 'create_from_statement_line', input: { lineId: debit.id, mode: 'adjustment', categoryId: s.expense.id } },
        ],
      },
      { text: 'Lancei o débito.' },
    ];
    await drain();
    const after = await api.get(`/api/statement-imports/${imp.id}`);
    expect(after.lines.find((l: any) => l.id === debit.id).status).toBe('matched');
    expect(after.lines.find((l: any) => l.id === other.id).status).toBe('new');
    const tool = await h.db.execute<{ content: unknown }>(sql`
      SELECT content FROM ai_messages WHERE conversation_id = ${started.conversationId} AND role = 'tool' ORDER BY seq LIMIT 1`);
    expect(JSON.stringify(tool.rows[0]!.content)).toContain(t.agents.recipes.outOfScope);
    // A instrução renderizada é a mensagem do usuário; o bloco da receita vai ao prompt.
    const first = await h.db.execute<{ content: unknown }>(sql`
      SELECT content FROM ai_messages WHERE conversation_id = ${started.conversationId} AND role = 'user' ORDER BY seq LIMIT 1`);
    expect(JSON.stringify(first.rows[0]!.content)).toContain('Lance os débitos de extrato.ofx (1 linha(s)).');
    const call = llm.calls.filter((c) => c.path === '/v1/messages').at(-1)!;
    expect(JSON.stringify(call.body.system)).toContain('Receita de conciliação: Débitos');
    // Rodou como quem clicou, com o ator agent.
    const audit = await h.db.execute<{ actor_kind: string; user_id: string }>(sql`
      SELECT actor_kind, user_id FROM audit_log WHERE table_name = 'statement_lines' AND record_id = ${debit.id} ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'agent', user_id: editor.id });

    await recipesTick(h.db, h.config, log);
    const runs = await api.get(`/api/reconcile-recipes/${recipe.id}/runs`);
    expect(runs[0]).toMatchObject({ status: 'completed', runStatus: 'completed', userId: editor.id });
    const state = await api.get(`/api/statement-imports/${imp.id}/reconcile-ai`);
    expect(state.recipeName).toBe('Débitos');
  });

  it('ao importar: duas receitas em sequência, a segunda só com as linhas que sobraram', async () => {
    const { s, editor, api } = await setup();
    await api.patch(`/api/accounts/${s.accountA.id}`, { aiAutoReconcile: true });
    const body = (name: string, position: number) => ({
      caixaId: s.caixaA.id,
      agentId: agent.id,
      name,
      instruction: `Receita ${name}.`,
      accountIds: [s.accountA.id],
      runOnImport: true,
      position,
    });
    const second = await api.post('/api/reconcile-recipes', body('Segunda', 2));
    const firstRecipe = await api.post('/api/reconcile-recipes', body('Primeira', 1));

    const imp = await importAs(editor, s.accountA.id);
    expect(imp.aiReconcile).toMatchObject({ queued: true, recipes: 2 });
    const pending = imp.lines.filter((l: any) => l.status === 'new' || l.status === 'suggested');
    let panel = await api.get(`/api/statement-imports/${imp.id}/recipes`);
    expect(panel.busy).toBe(true);
    const byRecipe = (id: string) => panel.runs.find((r: any) => r.recipeId === id);
    expect(byRecipe(firstRecipe.id)).toMatchObject({ status: 'started', triggerKind: 'import', lineCount: pending.length });
    expect(byRecipe(second.id)).toMatchObject({ status: 'queued', lineCount: null });

    // A primeira ignora uma linha; a segunda começa só com o resto.
    llm.queue = [{ toolCalls: [{ name: 'ignore_statement_lines', input: { lineIds: [pending[0].id] } }] }, { text: 'Feito.' }];
    await drain();
    const tick = await recipesTick(h.db, h.config, log);
    expect(tick.started).toBe(1);
    panel = await api.get(`/api/statement-imports/${imp.id}/recipes`);
    expect(byRecipe(firstRecipe.id).status).toBe('completed');
    expect(byRecipe(second.id)).toMatchObject({ status: 'started', lineCount: pending.length - 1 });

    llm.queue = [{ text: 'Nada a fazer.' }];
    await drain();
    await recipesTick(h.db, h.config, log);
    panel = await api.get(`/api/statement-imports/${imp.id}/recipes`);
    expect(byRecipe(second.id).status).toBe('completed');
    expect(panel.busy).toBe(false);
  });
});
