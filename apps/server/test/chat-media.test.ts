import { markdownToSpeech } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, silentWav, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { claimTranscriptions, drainTranscriptions, processTranscription } from '../src/agents/transcriptions';
import { client, type Harness, minimalPdf, startApp, uid, userSession } from './helpers';

/*
 * Chat multimídia (spec 025), com o provedor FALSO (transcrição e fala): o
 * upload de áudio enfileira a transcrição (derivado transcription), o worker a
 * processa com uso e requisição, a execução espera a pendente e o modelo recebe
 * o texto (nunca o áudio), a falha e o "tentar de novo", o TTS gerado uma vez e
 * reaproveitado (markdown falado), o agente sem áudio→texto, o PDF com páginas,
 * o Range do download e o admin em somente leitura.
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
let admin: ReturnType<typeof client>;
let owner: ReturnType<typeof client>;
let ownerSession: Awaited<ReturnType<typeof userSession>>;
/** Agente com todas as inferências (OpenAI compatível falso). */
let audioAgent: any;
/** Agente só com texto e visão (Anthropic compatível): não converte áudio. */
let plainAgent: any;
const created = { agents: [] as string[], providers: [] as string[] };

const deps = () => ({ db: h.db, config: h.config, log });

async function upload(conversationId: string, fileName: string, mime: string, payload: Buffer, query = '') {
  return h.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/attachments?fileName=${encodeURIComponent(fileName)}${query}`,
    payload,
    headers: { cookie: ownerSession.cookie, 'content-type': mime },
  });
}

async function runOnce() {
  const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
  const run = result.rows[0];
  if (run) await processRun(deps(), run);
  return run;
}

const chatCall = (marker: string) =>
  llm.calls.filter((c) => c.path === '/v1/chat/completions').find((c) => JSON.stringify(c.body.messages).includes(marker));

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  h = await startApp({ AI_TRANSCRIPTION_TIMEOUT_MS: '2500', AI_REQUEST_BACKOFF_MS: '0' });
  admin = client(h, (await userSession(h, 'admin')).cookie);
  ownerSession = await userSession(h, 'user');
  owner = client(h, ownerSession.cookie);
  const openai = await admin.post('/api/admin/ai/providers', {
    name: `Mídia ${uid()}`,
    kind: 'openai',
    apiKey: `sk-midia-${uid()}`,
    baseUrl: `${llm.url}/v1`,
    defaultModels: {
      text: 'fake-gpt',
      embeddings: 'text-embedding-3-small',
      transcription: 'fake-whisper',
      speech: 'fake-tts',
      speech_voice: 'nova',
    },
  });
  const claude = await admin.post('/api/admin/ai/providers', {
    name: `Mídia texto ${uid()}`,
    kind: 'anthropic',
    apiKey: `sk-midia-${uid()}`,
    baseUrl: llm.url,
    defaultModels: { text: 'claude-sonnet-5-5' },
  });
  created.providers.push(openai.id, claude.id);
  const base = { systemPrompt: 'Você ajuda nos testes de mídia.', params: { max_tokens: 1000, max_tool_iterations: 2 }, isActive: true };
  audioAgent = await admin.post('/api/admin/ai/agents', {
    ...base,
    name: `Agente áudio ${uid()}`,
    defaultProviderId: openai.id,
    model: 'fake-gpt',
  });
  plainAgent = await admin.post('/api/admin/ai/agents', {
    ...base,
    name: `Agente texto ${uid()}`,
    defaultProviderId: claude.id,
    model: 'claude-sonnet-5-5',
  });
  created.agents.push(audioAgent.id, plainAgent.id);
  // Banco reaproveitado: sobras de rodadas anteriores saem da fila antes dos casos.
  await drainTranscriptions(deps());
});

afterAll(async () => {
  for (const id of created.agents) await admin.patch(`/api/admin/ai/agents/${id}`, { isActive: false });
  for (const id of created.providers) await admin.patch(`/api/admin/ai/providers/${id}`, { isActive: false });
  await h.close();
  await llm.close();
});

beforeEach(() => {
  llm.queue = [];
  llm.audioQueue = [];
  llm.speechFormat = 'mp3';
});

describe('transcrição automática', () => {
  it('o upload de áudio grava a duração, enfileira o derivado e o worker transcreve com uso e requisição', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    const detail0 = await owner.get(`/api/conversations/${conversation.id}`);
    expect(detail0.media).toEqual({ transcription: true, speech: true });

    // .m4a sem tipo: a extensão decide; a duração vem do navegador.
    const res = await upload(conversation.id, 'nota.m4a', 'application/octet-stream', Buffer.from('m4a-falso'), '&durationMs=65000');
    expect(res.statusCode, res.body).toBe(200);
    const attachment = res.json();
    expect(attachment).toMatchObject({ mimeType: 'audio/mp4', durationMs: 65000, pageCount: null });
    expect(attachment.transcription).toMatchObject({ status: 'pending', model: 'fake-whisper', text: null });

    const pending = await owner.get(`/api/attachments/${attachment.id}/derivatives`);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'transcription', status: 'pending', attempts: 0 });
    const row = await h.db.execute<{ conversation_id: string }>(
      sql`SELECT conversation_id FROM ai_attachment_derivatives WHERE id = ${pending[0].id}`,
    );
    expect(row.rows[0]!.conversation_id).toBe(conversation.id);

    const [claimed] = await claimTranscriptions(h.db, 1);
    expect(claimed!.id).toBe(pending[0].id);
    expect(await processTranscription(deps(), claimed!)).toBe('done');
    const call = llm.calls.filter((c) => c.path === '/v1/audio/transcriptions').at(-1)!;
    expect(call.body).toMatchObject({ model: 'fake-whisper', language: 'pt' });

    const done = await owner.get(`/api/attachments/${attachment.id}/derivatives`);
    expect(done[0]).toMatchObject({ status: 'done', content: 'transcrição de teste (9 bytes)' });
    const usage = await h.db.execute<Record<string, any>>(sql`
      SELECT u.purpose, u.audio_seconds, u.user_id, u.agent_id, u.conversation_id, r.purpose AS request_purpose, r.operation
        FROM ai_usage u JOIN ai_requests r ON r.id = u.request_id
       WHERE u.conversation_id = ${conversation.id} AND u.purpose = 'transcription'`);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({
      purpose: 'transcription',
      user_id: ownerSession.id,
      agent_id: audioAgent.id,
      request_purpose: 'transcription',
      operation: 'transcription',
    });
    expect(Number(usage.rows[0]!.audio_seconds)).toBe(1.5);
  });

  it('a execução espera a transcrição pendente e o modelo recebe o texto, nunca o áudio', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    // WAV sem duração do navegador: a do cabeçalho.
    const res = await upload(conversation.id, 'recado.wav', 'audio/wav', silentWav(2500));
    const attachment = res.json();
    expect(attachment).toMatchObject({ mimeType: 'audio/wav', durationMs: 2500 });
    llm.audioQueue.push({ text: 'pague o boleto da luz amanhã' });
    const marker = `marcador-${uid()}`;
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: marker, attachmentIds: [attachment.id] });

    const claim = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const running = processRun(deps(), claim.rows[0]!);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Ainda esperando a transcrição: nada foi ao modelo.
    expect(chatCall(marker)).toBeUndefined();
    expect(await drainTranscriptions(deps())).toBe(1);
    await running;

    const call = chatCall(marker)!;
    const body = JSON.stringify(call.body.messages);
    expect(body).toContain('[Áudio \\"recado.wav\\" (0:02) — transcrição]: pague o boleto da luz amanhã');
    expect(body).not.toContain('input_audio');
    expect(body).not.toContain('não suportado');
    expect(body).not.toContain(silentWav(2500).toString('base64').slice(0, 40));
    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    expect(detail.attachments.find((a: any) => a.id === attachment.id).transcription).toMatchObject({
      status: 'done',
      text: 'pague o boleto da luz amanhã',
    });
  });

  it('esgotada a espera, o modelo recebe o áudio sem transcrição', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    const attachment = (await upload(conversation.id, 'lento.ogg', 'audio/ogg', Buffer.from('ogg'))).json();
    const marker = `espera-${uid()}`;
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: marker, attachmentIds: [attachment.id] });
    await runOnce();
    expect(JSON.stringify(chatCall(marker)!.body.messages)).toContain('[Áudio \\"lento.ogg\\" sem transcrição]');
    // A fila continua: a transcrição chega depois e fica para a próxima mensagem.
    await drainTranscriptions(deps());
  });

  it('a falha marca failed, o modelo recebe "sem transcrição" e o "tentar de novo" transcreve', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    const attachment = (await upload(conversation.id, 'ruim.mp3', 'audio/mpeg', Buffer.from('mp3'))).json();
    llm.audioQueue.push({ status: 400 });
    await drainTranscriptions(deps());
    const failed = await owner.get(`/api/attachments/${attachment.id}/derivatives`);
    expect(failed[0]).toMatchObject({ kind: 'transcription', status: 'failed', attempts: 1 });
    expect(failed[0].error).toBeTruthy();

    const marker = `falha-${uid()}`;
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: marker, attachmentIds: [attachment.id] });
    await runOnce();
    expect(JSON.stringify(chatCall(marker)!.body.messages)).toContain('[Áudio \\"ruim.mp3\\" sem transcrição]');

    // O admin lê, mas não pede de novo (somente leitura).
    const denied = await admin.raw('POST', `/api/attachments/${attachment.id}/transcribe`);
    expect(denied.statusCode).toBe(403);
    const retried = await owner.post(`/api/attachments/${attachment.id}/transcribe`);
    expect(retried).toMatchObject({ id: failed[0].id, status: 'pending', error: null });
    const again = await owner.post(`/api/attachments/${attachment.id}/transcribe`);
    expect(again.status).toBe('pending');
    await drainTranscriptions(deps());
    const done = await owner.get(`/api/attachments/${attachment.id}/derivatives`);
    expect(done[0]).toMatchObject({ status: 'done', attempts: 1 });
    // Inexistente: 404.
    const missing = await owner.raw('POST', '/api/attachments/00000000-0000-7000-8000-000000000000/transcribe');
    expect(missing.statusCode).toBe(404);
  });

  it('o agente sem áudio→texto não transcreve: o áudio fica como arquivo e o modelo recebe "sem transcrição"', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: plainAgent.id });
    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    expect(detail.media).toEqual({ transcription: false, speech: false });
    const attachment = (await upload(conversation.id, 'voz.webm', 'video/webm', Buffer.from('webm'))).json();
    expect(attachment).toMatchObject({ mimeType: 'audio/webm', transcription: null });
    expect(await owner.get(`/api/attachments/${attachment.id}/derivatives`)).toEqual([]);
    const retry = await owner.raw('POST', `/api/attachments/${attachment.id}/transcribe`);
    expect(retry.statusCode).toBe(404);

    const marker = `sem-audio-${uid()}`;
    const before = llm.calls.filter((c) => c.path === '/v1/audio/transcriptions').length;
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: marker, attachmentIds: [attachment.id] });
    await runOnce();
    const call = llm.calls.filter((c) => c.path === '/v1/messages').find((c) => JSON.stringify(c.body.messages).includes(marker))!;
    expect(JSON.stringify(call.body.messages)).toContain('[Áudio \\"voz.webm\\" sem transcrição]');
    expect(llm.calls.filter((c) => c.path === '/v1/audio/transcriptions')).toHaveLength(before);
  });
});

describe('texto→áudio (modo áudio)', () => {
  it('gera o áudio da mensagem uma vez (markdown falado) e reaproveita; uso com caracteres', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    llm.queue.push({
      text: '## Resumo\n\nVeja **isto** e [o link](https://exemplo.com).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx()\n```\nFim.',
    });
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: 'resuma' });
    await runOnce();
    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    const answer = detail.messages.find((m: any) => m.role === 'assistant');

    const before = llm.calls.filter((c) => c.path === '/v1/audio/speech').length;
    const first = await owner.post(`/api/conversations/${conversation.id}/messages/${answer.id}/speech`);
    expect(first.parts).toHaveLength(1);
    const speechCalls = llm.calls.filter((c) => c.path === '/v1/audio/speech');
    expect(speechCalls).toHaveLength(before + 1);
    expect(speechCalls.at(-1)!.body).toMatchObject({
      model: 'fake-tts',
      voice: 'nova',
      input: 'Resumo\n\nVeja isto e o link.\n\ntabela omitida.\n\ncódigo omitido.\nFim.',
    });
    const second = await owner.post(`/api/conversations/${conversation.id}/messages/${answer.id}/speech`);
    expect(second).toEqual(first);
    expect(llm.calls.filter((c) => c.path === '/v1/audio/speech')).toHaveLength(before + 1);

    // O áudio gerado é baixável pelo dono e pelo admin; o uso tem os caracteres e a requisição.
    const file = await h.app.inject({
      method: 'GET',
      url: `/api/attachments/${first.parts[0].attachmentId}/download?inline=1`,
      headers: { cookie: ownerSession.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/mpeg');
    const usage = await h.db.execute<Record<string, any>>(sql`
      SELECT characters, message_id, request_id, user_id FROM ai_usage WHERE conversation_id = ${conversation.id} AND purpose = 'speech'`);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ message_id: answer.id, user_id: ownerSession.id });
    expect(Number(usage.rows[0]!.characters)).toBe(first.parts[0].characters);
    expect(usage.rows[0]!.request_id).toBeTruthy();

    // O admin, em somente leitura, ouve o que o dono já gerou, mas não gera fala nova.
    expect(await admin.post(`/api/conversations/${conversation.id}/messages/${answer.id}/speech`)).toEqual(first);
    const question = detail.messages.find((m: any) => m.role === 'user');
    const denied = await admin.raw('POST', `/api/conversations/${conversation.id}/messages/${question.id}/speech`);
    expect(denied.statusCode).toBe(403);
    expect(llm.calls.filter((c) => c.path === '/v1/audio/speech')).toHaveLength(before + 1);
  });

  it('texto longo vira vários trechos; sem texto→áudio ou sem texto, recusa', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    const long = Array.from({ length: 900 }, (_, i) => `Frase número ${i} do texto longo.`).join(' ');
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: long });
    await runOnce();
    const detail = await owner.get(`/api/conversations/${conversation.id}`);
    const question = detail.messages.find((m: any) => m.role === 'user');
    const speech = await owner.post(`/api/conversations/${conversation.id}/messages/${question.id}/speech`);
    expect(speech.parts.length).toBeGreaterThan(1);
    expect(speech.parts.map((p: any) => p.blockIndex)).toEqual(speech.parts.map((_: any, i: number) => i));
    for (const part of speech.parts) expect(part.characters).toBeLessThanOrEqual(4096);

    const plain = await owner.post('/api/conversations', { agentId: plainAgent.id });
    await owner.post(`/api/conversations/${plain.id}/messages`, { text: 'oi' });
    await runOnce();
    const plainDetail = await owner.get(`/api/conversations/${plain.id}`);
    const refused = await owner.raw('POST', `/api/conversations/${plain.id}/messages/${plainDetail.messages[0].id}/speech`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('agent_no_speech');
  });

  it('markdownToSpeech: tabelas e código omitidos, links só com o texto', () => {
    expect(markdownToSpeech('# Título\n- item **forte**\n> citação com `código`')).toBe('Título\nitem forte\ncitação com código');
    expect(markdownToSpeech('Antes\n\n| x |\n|:-:|\n| 1 |\nDepois')).toBe('Antes\n\ntabela omitida.\nDepois');
    expect(markdownToSpeech('![logo](a.png) [site](https://a.b)')).toBe('logo site');
  });
});

describe('anexos: PDF, Range e admin', () => {
  it('o PDF grava as páginas; o download aceita Range; o admin lê os derivados de outra conversa', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    const pdf = (await upload(conversation.id, 'contrato.pdf', 'application/pdf', minimalPdf(['Linha um', 'Linha dois']))).json();
    expect(pdf).toMatchObject({ mimeType: 'application/pdf', pageCount: 1, durationMs: null, transcription: null });

    const audio = (await upload(conversation.id, 'trecho.wav', 'audio/wav', silentWav(1000))).json();
    const url = `/api/attachments/${audio.id}/download`;
    const headers = { cookie: ownerSession.cookie };
    const full = await h.app.inject({ method: 'GET', url, headers });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    const size = full.rawPayload.length;
    const part = await h.app.inject({ method: 'GET', url, headers: { ...headers, range: 'bytes=0-3' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${size}`);
    expect(part.rawPayload.toString('ascii')).toBe('RIFF');
    const tail = await h.app.inject({ method: 'GET', url, headers: { ...headers, range: 'bytes=-4' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload).toHaveLength(4);
    const beyond = await h.app.inject({ method: 'GET', url, headers: { ...headers, range: `bytes=${size}-` } });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${size}`);

    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: 'veja', attachmentIds: [pdf.id, audio.id] });
    await drainTranscriptions(deps());
    await runOnce();
    const read = await admin.get(`/api/conversations/${conversation.id}`);
    expect(read.readOnly).toBe(true);
    expect(read.attachments.map((a: any) => a.id).sort()).toEqual([pdf.id, audio.id].sort());
    expect(await admin.get(`/api/attachments/${audio.id}/derivatives`)).toEqual([expect.objectContaining({ status: 'done' })]);
    const adminRange = await admin.raw('GET', `/api/attachments/${audio.id}/download`);
    expect(adminRange.statusCode).toBe(200);
  });

  it('duração em PDF ou páginas em áudio são recusadas pelo banco com mensagem', async () => {
    const conversation = await owner.post('/api/conversations', { agentId: audioAgent.id });
    const pdf = (await upload(conversation.id, 'x.pdf', 'application/pdf', minimalPdf(['oi']))).json();
    let error: unknown;
    try {
      await h.db.execute(sql`UPDATE attachments SET duration_ms = 1000 WHERE id = ${pdf.id}`);
    } catch (e) {
      error = e;
    }
    const { translateDbError } = await import('../src/errors');
    expect(translateDbError(error)?.message).toContain('só um áudio tem duração');
  });
});
