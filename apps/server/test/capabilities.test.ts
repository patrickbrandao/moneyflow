import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type IndexState, indexEmbeddings, touchEmbeddingIndexes } from '../src/agents/embeddings';
import { resolveInference } from '../src/agents/inferences';
import { speak, transcribe } from '../src/agents/llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { client, type Harness, minimalPdf, startApp, TINY_PNG, uid, userSession } from './helpers';

/*
 * Capacidades dos provedores e provedor por inferência (spec 024), com o
 * provedor FALSO: flags padrão por tipo, Anthropic compatível (modelo de texto
 * obrigatório, cache e raciocínio desligados), provedor padrão preenchendo as
 * inferências, flag em uso recusada, testar conexão flag a flag, imagem
 * direta/descrita/recusada, PDF pela camada de texto, dois índices de
 * embeddings com a busca pelo par do agente, áudio no registro de requisições
 * e os preços de áudio.
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let admin: ReturnType<typeof client>;
let adminSession: Awaited<ReturnType<typeof userSession>>;
/** Anthropic compatível (texto + visão), com cache e raciocínio desligados (o padrão com base_url). */
let claude: any;
/** OpenAI compatível com todas as flags. */
let openai: any;
let kit: any;
const created = { agents: [] as string[], providers: [] as string[] };

async function newProvider(body: Record<string, unknown>) {
  const p = await admin.post('/api/admin/ai/providers', { name: `Cap ${uid()}`, apiKey: `sk-cap-${uid()}`, ...body });
  created.providers.push(p.id);
  return p;
}

async function newAgent(body: Record<string, unknown>) {
  const a = await admin.post('/api/admin/ai/agents', {
    name: `Agente cap ${uid()}`,
    systemPrompt: 'Você ajuda nos testes de capacidades.',
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 1000, max_tool_iterations: 3 },
    toolKitId: kit.id,
    isActive: true,
    ...body,
  });
  created.agents.push(a.id);
  return a;
}

async function drain() {
  for (let i = 0; i < 50; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

async function upload(conversationId: string, fileName: string, mime: string, payload: Buffer) {
  return h.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/attachments?fileName=${fileName}`,
    payload,
    headers: { cookie: adminSession.cookie, 'content-type': mime },
  });
}

/** Conversa nova com uma mensagem (anexos opcionais), já processada. */
async function ask(agentId: string, text: string, files: { name: string; mime: string; data: Buffer }[] = []) {
  const conversation = await admin.post('/api/conversations', { agentId });
  const ids: string[] = [];
  for (const file of files) {
    const res = await upload(conversation.id, file.name, file.mime, file.data);
    expect(res.statusCode, res.body).toBe(200);
    ids.push(res.json().id);
  }
  const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, { text, attachmentIds: ids });
  await drain();
  const run = await h.db.execute<{ status: string; error: string | null }>(
    sql`SELECT status, error FROM ai_runs WHERE id = ${sent.run.id}`,
  );
  expect(run.rows[0], JSON.stringify(run.rows[0])).toMatchObject({ status: 'completed' });
  return { conversation, attachmentIds: ids };
}

/** A chamada de chat (Anthropic) que levou o texto do usuário. */
const messagesCall = (marker: string) =>
  llm.calls.filter((c) => c.path === '/v1/messages').find((c) => JSON.stringify(c.body.messages).includes(marker))!;

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  h = await startApp();
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  claude = await newProvider({ kind: 'anthropic', baseUrl: llm.url, defaultModels: { text: 'claude-sonnet-5-5' } });
  openai = await newProvider({
    kind: 'openai',
    baseUrl: `${llm.url}/v1`,
    defaultModels: {
      text: 'fake-gpt',
      embeddings: 'text-embedding-3-small',
      transcription: 'fake-whisper',
      speech: 'fake-tts',
      speech_voice: 'alloy',
    },
  });
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  kit = await admin.post('/api/admin/ai/tool-kits', {
    name: `Kit cap ${uid()}`,
    tools: catalog.filter((x) => x.kind === 'read').map((x) => ({ name: x.name, mode: 'allow' })),
  });
});

afterAll(async () => {
  // Os demais arquivos usam o mesmo banco: nada de agente ativo nem provedor de embeddings em uso.
  for (const id of created.agents) await admin.patch(`/api/admin/ai/agents/${id}`, { isActive: false, useForFlows: false });
  for (const id of created.providers) await admin.patch(`/api/admin/ai/providers/${id}`, { isActive: false });
  await h.close();
  await llm.close();
});

beforeEach(() => {
  llm.queue = [];
});

describe('provedores: flags, modelos padrão e Anthropic compatível', () => {
  it('flags padrão por tipo; anthropic só texto e visão; compatível exige o modelo de texto; cache e raciocínio pela base_url', async () => {
    const official = await newProvider({ kind: 'anthropic' });
    expect(official).toMatchObject({ capabilities: ['text', 'vision'], promptCacheEnabled: true, thinkingEnabled: true });
    expect(claude).toMatchObject({
      capabilities: ['text', 'vision'],
      defaultModels: { text: 'claude-sonnet-5-5' },
      promptCacheEnabled: false,
      thinkingEnabled: false,
    });
    expect(openai.capabilities).toEqual(['text', 'vision', 'embeddings', 'transcription', 'speech']);

    // Anthropic com embeddings: recusado (a Messages API não tem).
    const bad = await admin.raw('POST', '/api/admin/ai/providers', {
      name: `Ruim ${uid()}`,
      kind: 'anthropic',
      apiKey: 'sk-ant-xxxxxxxx',
      capabilities: ['text', 'embeddings'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('só tem texto e visão');
    // Compatível sem o modelo de texto padrão.
    const noModel = await admin.raw('POST', '/api/admin/ai/providers', { name: `Ruim ${uid()}`, kind: 'anthropic', baseUrl: llm.url });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.body).toContain('modelo de texto padrão');

    // Modelos de flags desligadas são descartados; desmarcar a flag tira o modelo dela.
    const partial = await newProvider({
      kind: 'openai',
      capabilities: ['speech', 'text'],
      defaultModels: { text: 'fake-gpt', embeddings: 'fake-embedding', speech: 'fake-tts', speech_voice: 'nova' },
    });
    expect(partial.capabilities).toEqual(['text', 'speech']);
    expect(partial.defaultModels).toEqual({ text: 'fake-gpt', speech: 'fake-tts', speech_voice: 'nova' });
    const narrowed = await admin.patch(`/api/admin/ai/providers/${partial.id}`, { capabilities: ['text'] });
    expect(narrowed.defaultModels).toEqual({ text: 'fake-gpt' });
    // Ligar o cache num compatível que aceita.
    const toggled = await admin.patch(`/api/admin/ai/providers/${partial.id}`, { promptCacheEnabled: true });
    expect(toggled.promptCacheEnabled).toBe(true);
  });

  it('testar conexão flag a flag: chamada mínima por flag, embedding com 1536 dimensões, áudio; listagem indisponível sem erro', async () => {
    const before = llm.calls.length;
    const result = await admin.post(`/api/admin/ai/providers/${openai.id}/test`);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.checks.map((c: any) => [c.capability, c.ok, c.model])).toEqual([
      ['text', true, 'fake-gpt'],
      ['vision', true, 'fake-gpt'],
      ['embeddings', true, 'text-embedding-3-small'],
      ['transcription', true, 'fake-whisper'],
      ['speech', true, 'fake-tts'],
    ]);
    const calls = llm.calls.slice(before);
    expect(calls.find((c) => c.path === '/v1/embeddings')!.body).toMatchObject({ model: 'text-embedding-3-small', dimensions: 1536 });
    expect(calls.find((c) => c.path === '/v1/audio/transcriptions')!.body).toMatchObject({ model: 'fake-whisper' });
    expect(calls.find((c) => c.path === '/v1/audio/speech')!.body).toMatchObject({ model: 'fake-tts', voice: 'alloy' });
    const vision = calls.find((c) => c.path === '/v1/chat/completions' && JSON.stringify(c.body).includes('image_url'));
    expect(vision).toBeDefined();
    // Cada chamada é uma requisição test_connection, sem finalidade.
    const rows = await h.db.execute<{ path: string; purpose: string | null; status: string }>(sql`
      SELECT path, purpose, status FROM ai_requests WHERE provider_id = ${openai.id} AND operation = 'test_connection'`);
    expect(rows.rows.map((r) => r.path).sort()).toEqual(
      [
        '/v1/audio/speech',
        '/v1/audio/transcriptions',
        '/v1/chat/completions',
        '/v1/chat/completions',
        '/v1/embeddings',
        '/v1/models',
      ].sort(),
    );
    expect(rows.rows.every((r) => r.purpose === null && r.status === 'ok')).toBe(true);

    // Um modelo de embeddings com outra dimensão: a flag falha com a mensagem.
    const wrong = await newProvider({
      kind: 'openai',
      baseUrl: `${llm.url}/v1`,
      capabilities: ['embeddings'],
      defaultModels: { embeddings: 'fake-768' },
    });
    const failed = await admin.post(`/api/admin/ai/providers/${wrong.id}/test`);
    expect(failed.ok).toBe(false);
    expect(failed.checks).toEqual([expect.objectContaining({ capability: 'embeddings', ok: false })]);
    expect(failed.checks[0].message).toContain('1536 dimensões');

    // Compatível sem GET /v1/models: "listagem indisponível", e a chamada mínima ao modelo de texto passa.
    const nolist = await newProvider({ kind: 'anthropic', baseUrl: `${llm.url}/nolist`, defaultModels: { text: 'claude-sonnet-5-5' } });
    const listed = await admin.post(`/api/admin/ai/providers/${nolist.id}/test`);
    expect(listed).toMatchObject({ ok: true, modelsUnavailable: true, models: [] });
    expect(listed.message).toContain('Listagem indisponível');
    expect(listed.checks.map((c: any) => [c.capability, c.ok])).toEqual([
      ['text', true],
      ['vision', true],
    ]);
  });

  it('transcrição com log_bodies grava o corpo inteiro com o áudio em base64; sem ele, só os metadados; a fala vai em base64', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 7)]);
    const creds = { kind: 'openai' as const, baseUrl: `${llm.url}/v1`, apiKey: 'sk-audio-SEGREDO' };
    const logged = await newProvider({ kind: 'openai', baseUrl: `${llm.url}/v1`, logBodies: true });
    const out = await transcribe(
      creds,
      'fake-whisper',
      { fileName: 'nota.wav', mime: 'audio/wav', data: wav },
      {
        db: h.db,
        providerId: logged.id,
        logBodies: true,
      },
    );
    expect(out).toMatchObject({ text: 'transcrição de teste (68 bytes)', audioSeconds: 1.5 });
    const row = await h.db.execute<Record<string, any>>(sql`SELECT * FROM ai_requests WHERE id = ${out.requestId}`);
    expect(row.rows[0]).toMatchObject({
      operation: 'transcription',
      purpose: 'transcription',
      status: 'ok',
      path: '/v1/audio/transcriptions',
    });
    const body = JSON.parse(row.rows[0]!.request_body);
    expect(body.model).toBe('fake-whisper');
    expect(body.file).toMatchObject({ file_name: 'nota.wav', content_type: 'audio/wav', bytes: 68, base64: wav.toString('base64') });
    expect(row.rows[0]!.request_headers.authorization).toBe('[omitido]');

    const silent = await newProvider({ kind: 'openai', baseUrl: `${llm.url}/v1` });
    const quiet = await transcribe(
      creds,
      'fake-whisper',
      { fileName: 'nota.wav', mime: 'audio/wav', data: wav },
      {
        db: h.db,
        providerId: silent.id,
        logBodies: false,
      },
    );
    const quietRow = await h.db.execute<Record<string, any>>(sql`SELECT * FROM ai_requests WHERE id = ${quiet.requestId}`);
    expect(quietRow.rows[0]).toMatchObject({ request_body: null, response_body: null, status: 'ok' });
    expect(Number(quietRow.rows[0]!.request_bytes)).toBeGreaterThanOrEqual(68);

    const speech = await speak(creds, 'fake-tts', 'alloy', 'Olá, mundo', { db: h.db, providerId: logged.id, logBodies: true });
    expect(speech).toMatchObject({ mime: 'audio/mpeg', characters: 10 });
    const speechRow = await h.db.execute<{ response_body: string }>(
      sql`SELECT response_body FROM ai_requests WHERE id = ${speech.requestId}`,
    );
    expect(JSON.parse(speechRow.rows[0]!.response_body)).toMatchObject({
      content_type: 'audio/mpeg',
      base64: speech.audio.toString('base64'),
    });
  });

  it('preços de áudio: por minuto e por milhão de caracteres entram no custo', async () => {
    const price = await admin.post('/api/admin/ai/prices', {
      providerId: openai.id,
      model: 'fake-whisper',
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      audioInputPerMinute: 0.006,
      speechPerMillionChars: 15,
    });
    expect(price).toMatchObject({ audioInputPerMinute: 0.006, speechPerMillionChars: 15 });
    const usage = await h.db.execute<{ cost_micros: string; currency: string }>(sql`
      INSERT INTO ai_usage (provider_id, model, purpose, audio_seconds, characters)
      VALUES (${openai.id}, 'fake-whisper', 'transcription', 90, 1000) RETURNING cost_micros, currency`);
    // 1,5 min × 0,006 + 1000 × 15 / 1 milhão = 0,009 + 0,015 = 0,024 USD.
    expect(Number(usage.rows[0]!.cost_micros)).toBe(24_000);
    const summary = await admin.get(`/api/admin/ai/providers/${openai.id}/summary`);
    expect(summary.usage.total.byPurpose.find((x: any) => x.key === 'transcription')).toMatchObject({ audioSeconds: 90, characters: 1000 });
  });
});

describe('agente: provedor por inferência', () => {
  it('o provedor padrão preenche o que ele suporta; a escolha explícita vale; provedor sem a flag é recusado', async () => {
    const all = await newAgent({ defaultProviderId: openai.id, model: 'fake-gpt' });
    expect(all.providerId).toBe(openai.id);
    expect(all.inferences.map((i: any) => [i.capability, i.providerId, i.model, i.effectiveModel])).toEqual([
      ['vision', openai.id, null, 'fake-gpt'],
      ['embeddings', openai.id, null, 'text-embedding-3-small'],
      ['transcription', openai.id, null, 'fake-whisper'],
      ['speech', openai.id, null, 'fake-tts'],
    ]);
    expect(all.inferences.find((i: any) => i.capability === 'speech').effectiveVoice).toBe('alloy');
    expect(await resolveInference(h.db, all.id, 'speech')).toMatchObject({
      providerId: openai.id,
      model: 'fake-tts',
      voice: 'alloy',
      usable: true,
    });

    const onlyVision = await newAgent({ defaultProviderId: claude.id });
    expect(onlyVision.providerId).toBe(claude.id);
    expect(onlyVision.inferences.map((i: any) => i.capability)).toEqual(['vision']);

    // A escolha explícita não é trocada pelo padrão.
    const mixed = await newAgent({
      defaultProviderId: claude.id,
      inferences: [{ capability: 'embeddings', providerId: openai.id, model: 'emb-escolhido' }],
    });
    expect(mixed.inferences.map((i: any) => [i.capability, i.providerId, i.model])).toEqual([
      ['vision', claude.id, null],
      ['embeddings', openai.id, 'emb-escolhido'],
    ]);
    // Trocar o conjunto: o que não vem sai ("Nenhum").
    const none = await admin.patch(`/api/admin/ai/agents/${mixed.id}`, { inferences: [] });
    expect(none.inferences).toEqual([]);

    // Provedor sem a flag: recusado pelo banco com a mensagem.
    const res = await admin.raw('PATCH', `/api/admin/ai/agents/${mixed.id}`, {
      inferences: [{ capability: 'speech', providerId: claude.id }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('não tem esta capacidade');
  });

  it('desmarcar uma flag em uso é recusado com a lista dos agentes (o texto também)', async () => {
    const provider = await newProvider({ kind: 'openai', baseUrl: `${llm.url}/v1`, defaultModels: { text: 'fake-gpt' } });
    const agent = await newAgent({ name: `Usa visão ${uid()}`, defaultProviderId: provider.id, model: 'fake-gpt' });
    const res = await admin.raw('PATCH', `/api/admin/ai/providers/${provider.id}`, { capabilities: ['text', 'embeddings'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain(agent.name);
    const text = await admin.raw('PATCH', `/api/admin/ai/providers/${provider.id}`, {
      capabilities: ['vision', 'embeddings', 'transcription', 'speech'],
    });
    expect(text.statusCode).toBe(422);
    expect(text.json().error.message).toContain(agent.name);
    // Sem o agente usando, sai.
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { inferences: [] });
    const ok = await admin.patch(`/api/admin/ai/providers/${provider.id}`, { capabilities: ['text', 'speech'] });
    expect(ok.capabilities).toEqual(['text', 'speech']);
  });

  it('Anthropic compatível com cache e raciocínio desligados não manda cache_control, thinking nem effort', async () => {
    const agent = await newAgent({
      defaultProviderId: claude.id,
      params: { max_tokens: 4000, thinking_budget_tokens: 2000, reasoning_effort: 'high' },
    });
    const marker = `sem cache ${uid()}`;
    await ask(agent.id, marker);
    const body = messagesCall(marker).body;
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();

    // Ligados, voltam.
    await admin.patch(`/api/admin/ai/providers/${claude.id}`, { promptCacheEnabled: true, thinkingEnabled: true });
    try {
      const again = `com cache ${uid()}`;
      await ask(agent.id, again);
      const on = messagesCall(again).body;
      expect(on.system[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(on.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    } finally {
      await admin.patch(`/api/admin/ai/providers/${claude.id}`, { promptCacheEnabled: false, thinkingEnabled: false });
    }
  });
});

describe('visão: direta, por descrição, camada de texto do PDF e recusa', () => {
  it('imagem com a visão no provedor do texto vai direto ao modelo', async () => {
    const agent = await newAgent({ defaultProviderId: claude.id });
    const marker = `direta ${uid()}`;
    await ask(agent.id, marker, [{ name: 'foto.png', mime: 'image/png', data: TINY_PNG }]);
    const content = messagesCall(marker).body.messages[0].content;
    expect(content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
  });

  it('visão em outro provedor: descreve uma vez só (derivado em cache) e o texto vai ao modelo de texto', async () => {
    const agent = await newAgent({
      providerId: claude.id,
      inferences: [{ capability: 'vision', providerId: openai.id }],
    });
    const marker = `descrita ${uid()}`;
    const describes = () =>
      llm.calls.filter((c) => c.path === '/v1/chat/completions' && JSON.stringify(c.body).includes('Descreva o anexo'));
    const before = describes().length;
    const { conversation, attachmentIds } = await ask(agent.id, marker, [{ name: 'boleto.png', mime: 'image/png', data: TINY_PNG }]);
    expect(describes().length).toBe(before + 1);
    expect(describes().at(-1)!.body.model).toBe('fake-gpt');
    const sent = messagesCall(marker).body.messages[0].content;
    expect(sent[0]).toMatchObject({ type: 'text' });
    expect(sent[0].text).toBe('[Imagem "boleto.png" — descrição]: Descrição de teste: boleto de R$ 123,45 com vencimento em 10/05/2030.');
    expect(JSON.stringify(messagesCall(marker).body)).not.toContain('"image"');

    // A segunda mensagem da conversa reaproveita a descrição.
    const second = await admin.post(`/api/conversations/${conversation.id}/messages`, { text: `de novo ${uid()}` });
    await drain();
    expect((await h.db.execute<{ status: string }>(sql`SELECT status FROM ai_runs WHERE id = ${second.run.id}`)).rows[0]!.status).toBe(
      'completed',
    );
    expect(describes().length).toBe(before + 1);
    const derivative = await h.db.execute<{ kind: string; provider_id: string; model: string; status: string }>(sql`
      SELECT kind, provider_id, model, status FROM ai_attachment_derivatives WHERE attachment_id = ${attachmentIds[0]}`);
    expect(derivative.rows).toEqual([{ kind: 'description', provider_id: openai.id, model: 'fake-gpt', status: 'done' }]);
    // Uso da descrição: finalidade própria, no provedor de visão, ligado à execução.
    const usage = await h.db.execute<{ purpose: string; provider_id: string; model: string; run_id: string | null }>(sql`
      SELECT u.purpose, u.provider_id, u.model, u.run_id FROM ai_usage u
       WHERE u.conversation_id = ${conversation.id} AND u.purpose = 'vision_describe'`);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ provider_id: openai.id, model: 'fake-gpt' });
    expect(usage.rows[0]!.run_id).toBeTruthy();
  });

  it('sem visão: imagem recusada ao anexar (também nos fluxos); PDF pela camada de texto ou o aviso de PDF sem texto', async () => {
    const agent = await newAgent({ providerId: claude.id, useForFlows: true });
    expect(agent.inferences).toEqual([]);
    const conversation = await admin.post('/api/conversations', { agentId: agent.id });
    const image = await upload(conversation.id, 'foto.png', 'image/png', TINY_PNG);
    expect(image.statusCode).toBe(422);
    expect(image.json().error.message).toBe('Este agente não lê imagens.');
    // O fluxo de leitura de documento (agente dos fluxos sem visão) também recusa a imagem.
    const flow = await h.app.inject({
      method: 'POST',
      url: '/api/title-entry/document?fileName=boleto.png',
      payload: TINY_PNG,
      headers: { cookie: adminSession.cookie, 'content-type': 'image/png' },
    });
    expect(flow.statusCode).toBe(422);
    expect(flow.json().error.message).toBe('Este agente não lê imagens.');
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { useForFlows: false });

    const marker = `pdf texto ${uid()}`;
    const { attachmentIds } = await ask(agent.id, marker, [
      { name: 'conta.pdf', mime: 'application/pdf', data: minimalPdf(['Conta de luz', 'Total R$ 88,90 vence 15/06']) },
      { name: 'escaneado.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\n% sem texto\n') },
    ]);
    const content = messagesCall(marker).body.messages[0].content;
    expect(content.map((b: any) => b.type)).toEqual(['text', 'text', 'text']);
    expect(content[0].text).toBe('[PDF "conta.pdf" — camada de texto]:\nConta de luz\nTotal R$ 88,90 vence 15/06');
    expect(content[1].text).toBe('[PDF "escaneado.pdf"]: PDF sem texto e o agente não tem visão.');
    const derivatives = await h.db.execute<{ kind: string; provider_id: string | null; content: string }>(sql`
      SELECT kind, provider_id, content FROM ai_attachment_derivatives WHERE attachment_id = ${attachmentIds[0]}`);
    expect(derivatives.rows).toEqual([{ kind: 'pdf_text', provider_id: null, content: 'Conta de luz\nTotal R$ 88,90 vence 15/06' }]);
  });
});

describe('embeddings por par (provedor, modelo)', () => {
  it('dois agentes com modelos diferentes geram dois índices; a busca usa o do agente; índice incompleto avisa e completa com trigramas', async () => {
    const provider = await newProvider({
      kind: 'openai',
      baseUrl: `${llm.url}/v1`,
      capabilities: ['embeddings'],
      defaultModels: { embeddings: 'emb-a' },
    });
    const agentA = await newAgent({ providerId: claude.id, inferences: [{ capability: 'embeddings', providerId: provider.id }] });
    const name = `Oficina Estrela Cadente ${uid()}`;
    const entity = await admin.post('/api/entities', { kind: 'company', name });
    const state: IndexState = { since: new Map() };
    const index = async () => {
      for (let i = 0; i < 200; i += 1) {
        const round = await indexEmbeddings(h.db, h.config, state);
        expect(round.errors).toEqual([]);
        if (round.sources === 0 && round.embedded === 0) return;
      }
    };
    await index();

    // O segundo agente usa outro modelo do mesmo provedor: só registrado, o índice dele ainda está vazio.
    const agentB = await newAgent({
      providerId: claude.id,
      inferences: [{ capability: 'embeddings', providerId: provider.id, model: 'emb-b' }],
    });
    await touchEmbeddingIndexes(h.db);
    const pairs = await h.db.execute<{ model: string }>(
      sql`SELECT model FROM ai_embedding_indexes WHERE provider_id = ${provider.id} ORDER BY model`,
    );
    expect(pairs.rows.map((r) => r.model)).toEqual(['emb-a', 'emb-b']);

    const search = async (agentId: string) => {
      const before = llm.calls.length;
      const { conversation } = await ask(agentId, `chamar semantic_search ${JSON.stringify({ query: name, types: ['entity'], limit: 3 })}`);
      const detail = await admin.get(`/api/conversations/${conversation.id}`);
      const result = detail.messages.find((m: any) => m.role === 'tool').content[0];
      expect(result.is_error, result.content).toBeFalsy();
      const embedCall = llm.calls.slice(before).find((c) => c.path === '/v1/embeddings');
      return { payload: JSON.parse(result.content), model: embedCall?.body.model };
    };

    // B: em construção — o aviso, e a entidade vem pelos trigramas.
    const building = await search(agentB.id);
    expect(building.model).toBe('emb-b');
    expect(building.payload).toMatchObject({ mode: 'embeddings', building: true });
    expect(building.payload.notice).toContain('índice em construção');
    expect(building.payload.hits.map((x: any) => x.id)).toContain(entity.id);

    // A: completo — vetor do mesmo modelo, a entidade com semelhança 1.
    const complete = await search(agentA.id);
    expect(complete.model).toBe('emb-a');
    expect(complete.payload.building).toBeUndefined();
    expect(complete.payload.hits[0]).toMatchObject({ id: entity.id });
    expect(complete.payload.hits[0].score).toBeCloseTo(1, 5);

    // Indexado o B, os vetores dos dois pares existem e a busca de B deixa de avisar.
    await index();
    const vectors = await h.db.execute<{ model: string }>(sql`
      SELECT model FROM ai_embeddings WHERE object_type = 'entity' AND object_id = ${entity.id} AND provider_id = ${provider.id}
       ORDER BY model`);
    expect(vectors.rows.map((r) => r.model)).toEqual(['emb-a', 'emb-b']);
    const done = await search(agentB.id);
    expect(done.payload.building).toBeUndefined();
    expect(done.payload.hits[0]).toMatchObject({ id: entity.id });

    // Progresso do índice no detalhe do provedor.
    const summary = await admin.get(`/api/admin/ai/providers/${provider.id}/summary`);
    expect(summary.embeddingIndexes.map((x: any) => [x.model, x.inUse, x.pending])).toEqual([
      ['emb-a', true, 0],
      ['emb-b', true, 0],
    ]);
    expect(summary.embeddingIndexes[0].indexed).toBe(summary.embeddingIndexes[0].total);

    // Agente sem embeddings: só trigramas.
    const plain = await newAgent({ providerId: claude.id });
    const trigram = await search(plain.id);
    expect(trigram.model).toBeUndefined();
    expect(trigram.payload.mode).toBe('trigram');
  });
});
