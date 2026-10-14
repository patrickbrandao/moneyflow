import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { startAgentWorker } from '../src/agents/worker';
import { type FakeMcp, startFakeMcp } from './fakes/fake-mcp';
import { client, type Harness, newSession, scenario, startApp, uid, userSession } from './helpers';

/*
 * F8 (spec 022): montagem do prompt na ordem com os dois pontos de cache, instruções do usuário (Minha conta → IA),
 * contexto automático pelo Access, variáveis {{…}}, histórico de versões com restaurar, instructions dos MCP nos
 * modos ignore/system/user, e as conversas de fluxo sem as instruções do usuário. Provedor e MCP falsos.
 */

const MCP_SECRET = 'mcp-SEGREDO-prompt-1';
const MCP_TEXT = 'MCP-INSTRUCOES-DO-SERVIDOR: use sempre a tool echo antes de responder.';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let mcp: FakeMcp;
let bigMcp: FakeMcp;
let admin: ReturnType<typeof client>;
let adminSession: Awaited<ReturnType<typeof userSession>>;
let provider: any;
let agent: any;
const created: { agents: string[]; mcp: string[] } = { agents: [], mcp: [] };

async function drain() {
  for (let i = 0; i < 50; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

/** Manda uma mensagem, roda a execução e devolve a requisição de chat (não a do título) que chegou ao provedor. */
async function chatRequest(api: ReturnType<typeof client>, conversationId: string, text = 'olá') {
  llm.calls.length = 0;
  await api.post(`/api/conversations/${conversationId}/messages`, { text });
  await drain();
  const call = llm.calls.find((c) => c.path === '/v1/messages' && !/Gere um título/.test(JSON.stringify(c.body.system)));
  expect(call, 'chamada de chat ao provedor').toBeDefined();
  return call!.body as { system: { type: string; text: string; cache_control?: unknown }[]; messages: any[]; tools?: any[] };
}

async function newAgent(body: Record<string, unknown> = {}) {
  const a = await admin.post('/api/admin/ai/agents', {
    name: `Prompt ${uid()}`,
    systemPrompt: 'Você é o agente de teste do prompt.',
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 1000, max_tool_iterations: 3 },
    isActive: true,
    ...body,
  });
  created.agents.push(a.id);
  return a;
}

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  mcp = await startFakeMcp(MCP_SECRET, { instructions: MCP_TEXT });
  bigMcp = await startFakeMcp(MCP_SECRET, { instructions: 'x'.repeat(60_000) });
  h = await startApp();
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso prompt ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-prompt-0001',
    defaultModels: { text: 'claude-sonnet-5-5' },
    promptCacheEnabled: true,
  });
  agent = await newAgent({ systemPrompt: 'PROMPT-DO-AGENTE para {{usuario.nome}} ({{usuario.email}}), sou {{agente.nome}}.' });
});
afterAll(async () => {
  // Os outros arquivos de teste usam o mesmo banco e esperam "sem agente configurado" e nenhum MCP global.
  for (const id of created.agents) await admin.patch(`/api/admin/ai/agents/${id}`, { isActive: false });
  for (const id of created.mcp) await admin.patch(`/api/admin/ai/mcp-servers/${id}`, { isActive: false });
  await h.close();
  await llm.close();
  await mcp.close();
  await bigMcp.close();
});

describe('Minha conta → IA', () => {
  it('upsert das instruções e da caixa principal (só caixa comum que eu leio); admin lê, ninguém mais', async () => {
    const s = await scenario(h, admin);
    const userSess = await userSession(h);
    const user = client(h, userSess.cookie);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: userSess.id, role: 'viewer' });
    expect(await user.get('/api/account/ai')).toEqual({ instructions: '', primaryCaixaId: null, primaryCaixaName: null, updatedAt: null });

    await user.put('/api/account/ai', { instructions: 'Responda curto.', primaryCaixaId: s.caixaB.id }, 404);
    const saved = await user.put('/api/account/ai', { instructions: 'Responda curto.', primaryCaixaId: s.caixaA.id });
    expect(saved).toMatchObject({ instructions: 'Responda curto.', primaryCaixaId: s.caixaA.id, primaryCaixaName: s.caixaA.name });
    const again = await user.put('/api/account/ai', { instructions: 'Responda bem curto.' });
    expect(again).toMatchObject({ instructions: 'Responda bem curto.', primaryCaixaId: null });
    await user.put('/api/account/ai', { instructions: 'x'.repeat(20_001) }, 400);

    // Cartão não pode ser a caixa principal (o admin lê o cartão).
    const card = await admin.post('/api/caixas', {
      name: `Cartão ${uid()}`,
      kind: 'credit_card',
      holderEntityId: s.holderA.id,
      defaultPayerCaixaId: s.caixaA.id,
      creditLimitCents: 100_000,
      closingDay: 5,
      dueDay: 12,
      cardLast4: '4321',
    });
    await admin.put('/api/account/ai', { primaryCaixaId: card.id }, 422);

    expect(await admin.get(`/api/users/${userSess.id}/ai`)).toMatchObject({ instructions: 'Responda bem curto.' });
    await user.get(`/api/users/${adminSession.id}/ai`, 403);
    // Auditado com o usuário como registro e ator.
    const audit = await h.db.execute<{ actor: string | null }>(
      sql`SELECT user_id::text AS actor FROM audit_log WHERE table_name = 'user_ai_settings' AND record_id = ${userSess.id}`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    expect(audit.rows.every((r) => r.actor === userSess.id)).toBe(true);
  });
});

describe('montagem do prompt', () => {
  it('ordem e pontos de cache: base, agente (variáveis estáveis), MCP system, cache 1, instruções, contexto, cache 2, volátil', async () => {
    const server = await admin.post('/api/admin/ai/mcp-servers', {
      name: `MCP prompt ${uid()}`,
      url: mcp.url,
      headers: { Authorization: `Bearer ${MCP_SECRET}` },
      visibility: 'private',
    });
    created.mcp.push(server.id);
    expect(server.instructionsMode).toBe('ignore');
    const refreshed = await admin.post(`/api/admin/ai/mcp-servers/${server.id}/refresh`);
    expect(refreshed).toMatchObject({ toolsError: null, instructions: MCP_TEXT });
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { mcpServers: [{ mcpServerId: server.id, enabledTools: null }] });
    await admin.put('/api/account/ai', { instructions: 'INSTRUCOES-DO-ADMIN: prefira tabelas.' });

    // Modo ignore (padrão): o texto do servidor não vai ao modelo.
    const conversation = await newSession(admin, agent.id);
    let body = await chatRequest(admin, conversation.id);
    expect(JSON.stringify(body)).not.toContain('MCP-INSTRUCOES');
    expect(body.system).toHaveLength(3);
    const [stable, perUser, volatile] = body.system;
    expect(stable!.cache_control).toEqual({ type: 'ephemeral' });
    expect(perUser!.cache_control).toEqual({ type: 'ephemeral' });
    expect(volatile!.cache_control).toBeUndefined();
    expect(body.tools!.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(stable!.text.indexOf('Você é um agente do MoneyFlow')).toBe(0);
    expect(stable!.text).toContain(
      `PROMPT-DO-AGENTE para ${adminSession.username} (${adminSession.username}@teste.local), sou ${agent.name}.`,
    );
    expect(perUser!.text.indexOf(`Instruções de ${adminSession.username}\nINSTRUCOES-DO-ADMIN`)).toBe(0);
    expect(perUser!.text.indexOf('INSTRUCOES-DO-ADMIN')).toBeLessThan(perUser!.text.indexOf('Contexto do usuário'));
    expect(perUser!.text).toContain('administrador');
    expect(volatile!.text).toMatch(/^Hoje é \d{2}\/\d{2}\/\d{4}/);

    // Modo system: no prompt de sistema, depois do agente e antes do ponto de cache 1.
    await admin.patch(`/api/admin/ai/mcp-servers/${server.id}`, { instructionsMode: 'system' });
    body = await chatRequest(admin, conversation.id);
    const system = body.system[0]!.text;
    expect(system).toContain(`Instruções do servidor MCP ${server.name}\n${MCP_TEXT}`);
    expect(system.indexOf('PROMPT-DO-AGENTE')).toBeLessThan(system.indexOf('MCP-INSTRUCOES'));
    expect(body.system[1]!.text).not.toContain('MCP-INSTRUCOES');
    expect(JSON.stringify(body.messages)).not.toContain('MCP-INSTRUCOES');

    // Modo user: bloco do papel user no início do histórico enviado, nunca gravado na conversa.
    await admin.patch(`/api/admin/ai/mcp-servers/${server.id}`, { instructionsMode: 'user' });
    body = await chatRequest(admin, conversation.id, 'terceira mensagem');
    expect(body.system.map((b) => b.text).join('\n')).not.toContain('MCP-INSTRUCOES');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].text).toContain(MCP_TEXT);
    expect(body.messages[0].content[0].text).toContain(server.name);
    expect(JSON.stringify(body.messages.slice(1))).not.toContain('MCP-INSTRUCOES');
    const stored = await h.db.execute(
      sql`SELECT 1 FROM ai_messages WHERE conversation_id = ${conversation.id} AND content::text LIKE '%MCP-INSTRUCOES%'`,
    );
    expect(stored.rows).toHaveLength(0);

    // Sem instruções do usuário: a parte 2 começa no contexto.
    await admin.put('/api/account/ai', { instructions: '' });
    body = await chatRequest(admin, conversation.id);
    expect(body.system[1]!.text.indexOf('Contexto do usuário')).toBe(0);
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { mcpServers: [] });
  });

  it('cache das instructions do MCP cortado em 50 mil; trocar o modo é auditado, atualizar o cache não', async () => {
    const server = await admin.post('/api/admin/ai/mcp-servers', {
      name: `MCP grande ${uid()}`,
      url: bigMcp.url,
      headers: { Authorization: `Bearer ${MCP_SECRET}` },
      visibility: 'private',
      instructionsMode: 'system',
    });
    created.mcp.push(server.id);
    expect(server.instructionsMode).toBe('system');
    const refreshed = await admin.post(`/api/admin/ai/mcp-servers/${server.id}/refresh`);
    expect(refreshed.toolsError).toBeNull();
    expect(refreshed.instructions).toHaveLength(50_000);
    await admin.patch(`/api/admin/ai/mcp-servers/${server.id}`, { instructionsMode: 'nada' }, 400);
    const audit = await h.db.execute<{ op: string; changed: string[] | null }>(
      sql`SELECT action AS op, changed_columns AS changed FROM audit_log WHERE table_name = 'mcp_servers' AND record_id = ${server.id} ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.op)).toEqual(['insert']);
  });

  it('variável desconhecida é recusada ao salvar (400, com o nome); volátil leva o prompt para depois do ponto 2', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/ai/agents',
      payload: { name: `Ruim ${uid()}`, systemPrompt: 'Olá {{usuario.cpf}}' },
      headers: { cookie: adminSession.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('{{usuario.cpf}}');
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { systemPrompt: '{{nada}}' }, 400);

    const volatileAgent = await newAgent({
      systemPrompt: 'AGENTE-VOLATIL hoje é {{dia_semana}}, {{data}} ({{data_iso}}); literal \\{{data}}.',
    });
    const conversation = await newSession(admin, volatileAgent.id);
    const body = await chatRequest(admin, conversation.id);
    expect(body.system[0]!.text).not.toContain('AGENTE-VOLATIL');
    expect(body.system[1]!.text).not.toContain('AGENTE-VOLATIL');
    const last = body.system.at(-1)!;
    expect(last.cache_control).toBeUndefined();
    expect(last.text).toMatch(/^AGENTE-VOLATIL hoje é [a-zçá-]+, \d{2}\/\d{2}\/\d{4} \(\d{4}-\d{2}-\d{2}\); literal \{\{data\}\}\./);

    const preview = await admin.post(`/api/admin/ai/agents/${volatileAgent.id}/prompt-preview`, { userId: adminSession.id });
    expect(preview.volatileVariables).toBe(true);
    expect(preview.parts.map((p: any) => [p.kind, p.cacheBreakpoint])).toEqual([
      ['stable', true],
      ['user', true],
      ['volatile', false],
    ]);
    expect(preview.parts[2].text).toContain('AGENTE-VOLATIL');
  });

  it('contexto automático pelo Access: um viewer vê só as caixas dele (com contas e papel), a caixa principal e os cartões', async () => {
    const s = await scenario(h, admin);
    const card = await admin.post('/api/caixas', {
      name: `Cartão ctx ${uid()}`,
      kind: 'credit_card',
      holderEntityId: s.holderA.id,
      defaultPayerCaixaId: s.caixaA.id,
      creditLimitCents: 100_000,
      closingDay: 5,
      dueDay: 12,
      cardLast4: '4321',
    });
    const userSess = await userSession(h);
    const user = client(h, userSess.cookie);
    const members = await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: userSess.id, role: 'viewer' });
    const memberId = members.find((m: any) => m.userId === userSess.id).id;
    await user.put('/api/account/ai', { instructions: 'INSTRUCOES-DO-VIEWER', primaryCaixaId: s.caixaA.id });

    const preview = await admin.post(`/api/admin/ai/agents/${agent.id}/prompt-preview`, { userId: userSess.id });
    expect(preview.username).toBe(userSess.username);
    const context = preview.parts.find((p: any) => p.kind === 'user').text as string;
    expect(context).toContain('INSTRUCOES-DO-VIEWER');
    expect(context).toContain(`- ${s.caixaA.name} [viewer] ${s.caixaA.id}`);
    expect(context).toContain(`conta Banco A (Corrente/pagamento) id ${s.accountA.id}`);
    expect(context).toContain(`${card.name} [viewer] ${card.id}`);
    expect(context).toContain(`Caixa principal escolhida pelo usuário: ${s.caixaA.name} (titular ${s.holderA.name}`);
    expect(context).not.toContain(s.caixaB.name);
    expect(context).not.toContain(s.accountB.id);
    expect(context).not.toContain('administrador');
    expect(context).not.toContain('lista parcial');
    // As variáveis do usuário entram na parte estável (cache por usuário).
    expect(preview.parts[0].text).toContain(`PROMPT-DO-AGENTE para ${userSess.username}`);

    // Perder o acesso à caixa principal a tira do contexto e das variáveis.
    const withVars = await newAgent({ systemPrompt: 'Caixa: [{{usuario.caixa_principal}}] titular [{{empresa.titular_principal}}]' });
    let p2 = await admin.post(`/api/admin/ai/agents/${withVars.id}/prompt-preview`, { userId: userSess.id });
    expect(p2.parts[0].text).toContain(`Caixa: [${s.caixaA.name}] titular [${s.holderA.name}]`);
    await admin.del(`/api/caixas/${s.caixaA.id}/members/${memberId}`);
    p2 = await admin.post(`/api/admin/ai/agents/${withVars.id}/prompt-preview`, { userId: userSess.id });
    expect(p2.parts[0].text).toContain('Caixa: [] titular []');
    expect(p2.parts[1].text).not.toContain(s.caixaA.name);
    expect(p2.parts[1].text).toContain('O usuário não lê nenhuma caixa.');
  });

  it('contexto automático corta em 60 caixas com o aviso "lista parcial: use list_caixas"', async () => {
    const s = await scenario(h, admin);
    const userSess = await userSession(h);
    for (let i = 0; i < 61; i += 1) {
      const caixa = await admin.post('/api/caixas', {
        name: `Muitas ${s.tag} ${String(i).padStart(2, '0')}`,
        holderEntityId: s.holderA.id,
      });
      await admin.post(`/api/caixas/${caixa.id}/members`, { userId: userSess.id, role: 'editor' });
    }
    const preview = await admin.post(`/api/admin/ai/agents/${agent.id}/prompt-preview`, { userId: userSess.id });
    const context = preview.parts[1].text as string;
    expect(context.match(/\[editor\]/g)).toHaveLength(60);
    expect(context).toContain('(lista parcial: use list_caixas)');
  });
});

describe('versões do prompt', () => {
  it('versão a cada mudança (com nota e autor), nenhuma sem mudança, restaurar cria a versão nova; update direto recusado', async () => {
    const a = await newAgent({ systemPrompt: 'linha 1\nlinha 2', promptNote: 'primeira' });
    expect(a.promptVersion).toBe(1);
    let versions = await admin.get(`/api/admin/ai/agents/${a.id}/prompt-versions`);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      content: 'linha 1\nlinha 2',
      note: 'primeira',
      createdByUsername: adminSession.username,
    });

    // Mesmo prompt (e outros campos): nenhuma versão nova.
    await admin.patch(`/api/admin/ai/agents/${a.id}`, { systemPrompt: 'linha 1\nlinha 2', description: 'nova descrição' });
    const v2 = await admin.patch(`/api/admin/ai/agents/${a.id}`, { systemPrompt: 'linha 1\nlinha dois', promptNote: 'ajuste' });
    expect(v2).toMatchObject({ promptVersion: 2, systemPrompt: 'linha 1\nlinha dois', description: 'nova descrição' });
    versions = await admin.get(`/api/admin/ai/agents/${a.id}/prompt-versions`);
    expect(versions.map((v: any) => [v.version, v.note])).toEqual([
      [2, 'ajuste'],
      [1, 'primeira'],
    ]);

    const restored = await admin.post(`/api/admin/ai/agents/${a.id}/prompt-versions/${versions[1].id}/restore`);
    expect(restored).toMatchObject({ promptVersion: 3, systemPrompt: 'linha 1\nlinha 2' });
    versions = await admin.get(`/api/admin/ai/agents/${a.id}/prompt-versions`);
    expect(versions[0]).toMatchObject({
      version: 3,
      content: 'linha 1\nlinha 2',
      note: 'Restaurada da versão 1',
      restoredFromVersionId: versions[2].id,
      restoredFromVersion: 1,
    });

    // Versão de outro agente: 404; usuário comum: 403.
    const other = await newAgent();
    const otherVersion = (await admin.get(`/api/admin/ai/agents/${other.id}/prompt-versions`))[0];
    await admin.post(`/api/admin/ai/agents/${a.id}/prompt-versions/${otherVersion.id}/restore`, undefined, 404);
    const plain = client(h, (await userSession(h)).cookie);
    await plain.get(`/api/admin/ai/agents/${a.id}/prompt-versions`, 403);
    await plain.post(`/api/admin/ai/agents/${a.id}/prompt-preview`, { userId: adminSession.id }, 403);

    // O prompt só muda por versão: o UPDATE direto é recusado pelo banco.
    await expect(h.db.execute(sql`UPDATE ai_agents SET system_prompt = 'direto' WHERE id = ${a.id}`)).rejects.toThrow();
    // Escritas pela API não saem como ator system.
    const audit = await h.db.execute<{ actor: string | null }>(
      sql`SELECT user_id::text AS actor FROM audit_log WHERE table_name = 'ai_agent_prompt_versions' AND new_data ->> 'agent_id' = ${a.id}`,
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.every((r) => r.actor === adminSession.id)).toBe(true);
  });
});

describe('conversas de fluxo', () => {
  it('o fluxo (leitura de documento) recebe o contexto automático, mas não as instruções do usuário nem o MCP', async () => {
    const flowAgent = await newAgent({ useForFlows: true, systemPrompt: 'AGENTE-DOS-FLUXOS' });
    const server = await admin.post('/api/admin/ai/mcp-servers', {
      name: `MCP fluxo ${uid()}`,
      url: mcp.url,
      headers: { Authorization: `Bearer ${MCP_SECRET}` },
      visibility: 'private',
      instructionsMode: 'system',
    });
    created.mcp.push(server.id);
    await admin.post(`/api/admin/ai/mcp-servers/${server.id}/refresh`);
    await admin.patch(`/api/admin/ai/agents/${flowAgent.id}`, { mcpServers: [{ mcpServerId: server.id, enabledTools: null }] });
    await admin.put('/api/account/ai', { instructions: 'INSTRUCOES-FORA-DO-FLUXO' });

    llm.calls.length = 0;
    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/title-entry/document?fileName=boleto.pdf',
        payload: Buffer.from('%PDF-1.4\n% boleto\n'),
        headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
      });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await stop();
    }
    const call = llm.calls.find((c) => c.path === '/v1/messages' && /ler o documento anexado/.test(JSON.stringify(c.body.system)));
    expect(call).toBeDefined();
    const system = JSON.stringify(call!.body.system);
    expect(system).toContain('AGENTE-DOS-FLUXOS');
    expect(system).toContain('Contexto do usuário');
    expect(system).not.toContain('INSTRUCOES-FORA-DO-FLUXO');
    expect(system).not.toContain('MCP-INSTRUCOES');
    expect(JSON.stringify(call!.body.messages)).not.toContain('MCP-INSTRUCOES');

    // Numa conversa comum do mesmo agente, as instruções entram.
    const conversation = await newSession(admin, flowAgent.id);
    const body = await chatRequest(admin, conversation.id);
    expect(JSON.stringify(body.system)).toContain('INSTRUCOES-FORA-DO-FLUXO');
    expect(body.system[0]!.text).toContain('MCP-INSTRUCOES');
    await admin.put('/api/account/ai', { instructions: '' });
  });
});
