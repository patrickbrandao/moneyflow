import type { Executor, Tx } from '@moneyflow/db';
import {
  type AiBlock,
  type AttachmentDerivativeDto,
  blocksText,
  type ChatAttachmentDto,
  chatMime,
  isAudioMime,
  isPdfMime,
  type MessageSpeechDto,
  markdownToSpeech,
  SPEECH_CHAR_LIMIT,
  splitSpeech,
  type TranscriptionDto,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { inferenceCredentials, inferenceRequestLog, resolveInference } from '../agents/inferences';
import { speak } from '../agents/llm';
import { pdfPageCount } from '../agents/pdf-text';
import type { ServiceContext } from '../context';
import { findPgError, forbidden, notFound, unprocessable } from '../errors';
import { assertReadable, assertUpload, storeAttachment } from './attachments';
import { assertReadsImages, loadConversation } from './conversations';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Chat multimídia (spec 025): o upload da conversa (tipo normalizado,
 * duração do áudio, páginas do PDF e a transcrição enfileirada), os derivados
 * de um anexo, o "tentar de novo" da transcrição e o áudio de uma mensagem
 * (texto→áudio sob demanda, sem fila, guardado como derivado speech por
 * mensagem e trecho).
 */

/* ---------------- capacidades do agente ---------------- */

/** O que o agente converte: áudio→texto e texto→áudio (provedor utilizável e modelo). */
export async function mediaCapabilities(db: Executor, agentId: string) {
  const [transcription, speech] = await Promise.all([
    resolveInference(db, agentId, 'transcription'),
    resolveInference(db, agentId, 'speech'),
  ]);
  return { transcription: Boolean(transcription?.usable && transcription.model), speech: Boolean(speech?.usable && speech.model) };
}

/* ---------------- anexos do chat ---------------- */

type TranscriptionRow = {
  id: string;
  attachment_id: string;
  status: TranscriptionDto['status'];
  content: string | null;
  error: string | null;
  model: string;
  updated_at: unknown;
};

const transcriptionDto = (r: TranscriptionRow): TranscriptionDto => ({
  id: r.id,
  status: r.status,
  text: r.content,
  error: r.error,
  model: r.model,
  updatedAt: iso(r.updated_at)!,
});

/** A transcrição mais recente de cada anexo, de qualquer provedor (a que vale para a tela e para a execução). */
export async function latestTranscriptions(db: Executor, attachmentIds: string[]): Promise<Map<string, TranscriptionDto>> {
  const map = new Map<string, TranscriptionDto>();
  if (attachmentIds.length === 0) return map;
  const result = await db.execute<TranscriptionRow>(sql`
    SELECT DISTINCT ON (attachment_id) id, attachment_id, status, content, error, model, updated_at
      FROM ai_attachment_derivatives
     WHERE attachment_id = ANY (${`{${attachmentIds.join(',')}}`}::uuid[]) AND kind = 'transcription'
     ORDER BY attachment_id, created_at DESC, id DESC`);
  for (const row of result.rows) map.set(row.attachment_id, transcriptionDto(row));
  return map;
}

/** Metadados dos anexos (sem o conteúdo), com a transcrição dos áudios. */
export async function chatAttachments(db: Executor, attachmentIds: string[]): Promise<ChatAttachmentDto[]> {
  const ids = [...new Set(attachmentIds)];
  if (ids.length === 0) return [];
  const result = await db.execute<{
    id: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    duration_ms: number | null;
    page_count: number | null;
    created_at: unknown;
  }>(sql`
    SELECT id, file_name, mime_type, size_bytes, duration_ms, page_count, created_at
      FROM attachments WHERE id = ANY (${`{${ids.join(',')}}`}::uuid[])`);
  const transcriptions = await latestTranscriptions(
    db,
    result.rows.filter((r) => isAudioMime(r.mime_type)).map((r) => r.id),
  );
  return result.rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    pageCount: r.page_count === null ? null : Number(r.page_count),
    createdAt: iso(r.created_at)!,
    transcription: transcriptions.get(r.id) ?? null,
  }));
}

/** Ids dos anexos citados nas mensagens. */
export function messageAttachmentIds(messages: { content: AiBlock[] }[]): string[] {
  const ids: string[] = [];
  for (const message of messages) for (const block of message.content) if (block.type === 'attachment') ids.push(block.attachment_id);
  return ids;
}

/** Duração de um WAV pelo cabeçalho (o navegador informa a dos demais formatos). */
export function wavDurationMs(data: Buffer): number | null {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= data.length) byteRate = data.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const bytes = Math.min(size, data.length - offset - 8);
      const ms = Math.round((bytes / byteRate) * 1000);
      return ms >= 1 ? ms : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Duração informada pelo navegador (query durationMs), se válida. */
export function parseDurationMs(raw: unknown): number | null {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return null;
  const ms = Math.round(n);
  return ms >= 1 && ms <= MAX_DURATION_MS ? ms : null;
}

/** Enfileira a transcrição do anexo com a inferência do agente (modelo nulo = não configurada: nada). */
async function enqueueTranscription(tx: Tx | Executor, attachmentId: string, providerId: string, model: string, conversationId: string) {
  const result = await tx.execute<TranscriptionRow>(sql`
    SELECT id, attachment_id, status, content, error, model, updated_at
      FROM ai_transcription_enqueue(${attachmentId}::uuid, ${providerId}::uuid, ${model}, ${conversationId}::uuid)`);
  return transcriptionDto(result.rows[0]!);
}

/**
 * Upload de um anexo da conversa: tipo normalizado (a extensão vale quando o
 * navegador não informa), páginas do PDF e duração do áudio gravadas no
 * anexo, e a transcrição enfileirada quando o agente converte áudio.
 */
export async function uploadChatAttachment(
  ctx: ServiceContext,
  conversationId: string,
  file: { name: string; mime: string; content: unknown; durationMs?: unknown },
): Promise<ChatAttachmentDto> {
  const conversation = await loadConversation(ctx, conversationId, 'own');
  const mime = chatMime(file.name, file.mime);
  await assertReadsImages(ctx.db, conversation.agent_id, [mime]);
  const content = assertUpload(file.content);
  const audio = isAudioMime(mime);
  const durationMs = audio ? (parseDurationMs(file.durationMs) ?? (mime === 'audio/wav' ? wavDurationMs(content) : null)) : null;
  const pageCount = isPdfMime(mime) ? await pdfPageCount(content) : null;
  const transcriber = audio ? await inferenceCredentials(ctx.db, conversation.agent_id, 'transcription', ctx.access.actor.id) : null;

  const attachmentId = await withTx(ctx, async (tx) => {
    const id = await storeAttachment(tx, ctx, { name: file.name, mime, content, durationMs, pageCount });
    if (transcriber?.model) await enqueueTranscription(tx, id, transcriber.providerId, transcriber.model, conversationId);
    return id;
  });
  return (await chatAttachments(ctx.db, [attachmentId]))[0]!;
}

/* ---------------- derivados e "tentar de novo" ---------------- */

export async function listDerivatives(ctx: ServiceContext, attachmentId: string): Promise<AttachmentDerivativeDto[]> {
  await assertReadable(ctx, attachmentId);
  const result = await ctx.db.execute<{
    id: string;
    kind: AttachmentDerivativeDto['kind'];
    status: AttachmentDerivativeDto['status'];
    content: string | null;
    error: string | null;
    provider_id: string | null;
    model: string | null;
    attempts: number;
    created_at: unknown;
    updated_at: unknown;
  }>(sql`
    SELECT id, kind, status, CASE WHEN kind = 'pdf_text' THEN NULL ELSE content END AS content, error, provider_id, model,
           attempts, created_at, updated_at
      FROM ai_attachment_derivatives
     WHERE attachment_id = ${attachmentId} AND kind IN ('description', 'pdf_text', 'transcription')
     ORDER BY created_at DESC, id DESC`);
  return result.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    content: r.content,
    error: r.error,
    providerId: r.provider_id,
    model: r.model,
    attempts: Number(r.attempts),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  }));
}

/** Conversa de um anexo do chat: a da mensagem que o cita ou a da transcrição pedida no upload. */
async function attachmentConversation(db: Executor, attachmentId: string): Promise<string | null> {
  const result = await db.execute<{ conversation_id: string }>(sql`
    SELECT m.conversation_id FROM ai_message_attachments ma JOIN ai_messages m ON m.id = ma.message_id
     WHERE ma.attachment_id = ${attachmentId}
    UNION ALL
    SELECT conversation_id FROM ai_attachment_derivatives
     WHERE attachment_id = ${attachmentId} AND kind = 'transcription' AND conversation_id IS NOT NULL
    LIMIT 1`);
  return result.rows[0]?.conversation_id ?? null;
}

/**
 * "Tentar de novo" (POST /api/attachments/:id/transcribe): só o dono da
 * conversa. Com a mesma inferência, a falha volta à fila com as tentativas
 * zeradas (ai_transcription_retry); se o agente agora usa outro provedor ou
 * modelo, é outra transcrição (enfileirada).
 */
export async function retryTranscription(ctx: ServiceContext, attachmentId: string): Promise<TranscriptionDto> {
  const conversationId = await attachmentConversation(ctx.db, attachmentId);
  if (!conversationId) throw notFound(t.agents.errors.transcriptionNotFound);
  const conversation = await loadConversation(ctx, conversationId, 'own');
  const file = await ctx.db.execute<{ mime_type: string }>(sql`SELECT mime_type FROM attachments WHERE id = ${attachmentId}`);
  if (!file.rows[0]) throw notFound();
  if (!isAudioMime(file.rows[0].mime_type)) throw unprocessable(t.agents.errors.notAudio, 'not_audio');
  const creds = await inferenceCredentials(ctx.db, conversation.agent_id, 'transcription', ctx.access.actor.id);
  if (!creds?.model) throw unprocessable(t.agents.errors.agentNoTranscription, 'agent_no_transcription');
  const model = creds.model;
  return withTx(ctx, async (tx) => {
    const queued = await enqueueTranscription(tx, attachmentId, creds.providerId, model, conversationId);
    if (queued.status !== 'failed') return queued;
    try {
      const result = await tx.execute<TranscriptionRow>(sql`
        SELECT id, attachment_id, status, content, error, model, updated_at FROM ai_transcription_retry(${queued.id}::uuid)`);
      return transcriptionDto(result.rows[0]!);
    } catch (error) {
      if (findPgError(error)?.code === 'P0002') throw notFound(t.agents.errors.transcriptionNotFound);
      throw error;
    }
  });
}

/* ---------------- texto→áudio de uma mensagem ---------------- */

/**
 * Áudio de uma mensagem de texto (modo áudio): o markdown vira texto falado,
 * dividido no limite do provedor; cada trecho é um derivado speech (mensagem +
 * block_index, provedor, modelo e voz) com o áudio em result_attachment_id.
 * O que já foi gerado é reaproveitado; nada é gerado sem o pedido.
 * O admin lendo a conversa de outro usuário (somente leitura) só ouve o que o
 * dono já gerou: gerar fala é escrita e custo, e fica com o dono.
 */
export async function messageSpeech(ctx: ServiceContext, conversationId: string, messageId: string): Promise<MessageSpeechDto> {
  const conversation = await loadConversation(ctx, conversationId, 'read');
  const readOnly = conversation.user_id !== ctx.access.actor.id;
  const message = await ctx.db.execute<{ role: string; content: AiBlock[] }>(sql`
    SELECT role, content FROM ai_messages WHERE id = ${messageId} AND conversation_id = ${conversationId}`);
  const row = message.rows[0];
  if (!row || (row.role !== 'user' && row.role !== 'assistant')) throw notFound();
  const text = markdownToSpeech(blocksText(row.content.filter((b) => b.type === 'text')));
  if (!text) throw unprocessable(t.agents.errors.speechNoText, 'speech_no_text');
  const creds = await inferenceCredentials(ctx.db, conversation.agent_id, 'speech', ctx.access.actor.id);
  if (!creds?.model) throw unprocessable(t.agents.errors.agentNoSpeech, 'agent_no_speech');
  const model = creds.model;
  const voice = creds.voice ?? 'alloy';

  const parts: MessageSpeechDto['parts'] = [];
  for (const [blockIndex, chunk] of splitSpeech(text, SPEECH_CHAR_LIMIT).entries()) {
    const cached = await ctx.db.execute<{ result_attachment_id: string }>(sql`
      SELECT result_attachment_id FROM ai_attachment_derivatives
       WHERE message_id = ${messageId} AND block_index = ${blockIndex} AND kind = 'speech' AND provider_id = ${creds.providerId}
         AND model = ${model} AND voice = ${voice} AND status = 'done'`);
    if (cached.rows[0]) {
      parts.push({ blockIndex, attachmentId: cached.rows[0].result_attachment_id, characters: chunk.length });
      continue;
    }
    if (readOnly) throw forbidden(t.agents.errors.readOnly);
    const audio = await speak(
      creds,
      model,
      voice,
      chunk,
      inferenceRequestLog(ctx.db, creds, ctx.config, {
        userId: ctx.access.actor.id,
        agentId: conversation.agent_id,
        conversationId,
      }),
    );
    const attachmentId = await withTx(ctx, async (tx) => {
      const created = await storeAttachment(tx, ctx, {
        name: `fala-${messageId.slice(0, 8)}-${blockIndex + 1}.${audio.mime === 'audio/wav' ? 'wav' : 'mp3'}`,
        mime: audio.mime,
        content: audio.audio,
      });
      const saved = await tx.execute<{ result_attachment_id: string }>(sql`
        INSERT INTO ai_attachment_derivatives (message_id, block_index, kind, provider_id, model, voice, result_attachment_id, status)
        VALUES (${messageId}, ${blockIndex}, 'speech', ${creds.providerId}, ${model}, ${voice}, ${created}, 'done')
        ON CONFLICT ON CONSTRAINT ai_attachment_derivatives_key DO UPDATE
           SET result_attachment_id = EXCLUDED.result_attachment_id, status = 'done', error = NULL, locked_at = NULL, lock_token = NULL
         WHERE ai_attachment_derivatives.status <> 'done'
        RETURNING result_attachment_id`);
      await tx.execute(sql`
        INSERT INTO ai_usage (provider_id, model, purpose, user_id, agent_id, conversation_id, message_id, characters, request_id)
        VALUES (${creds.providerId}, ${model}, 'speech', ${ctx.access.actor.id}, ${conversation.agent_id}, ${conversationId},
                ${messageId}, ${audio.characters}, ${audio.requestId})`);
      if (saved.rows[0]) return saved.rows[0].result_attachment_id;
      // Outro pedido gerou o mesmo trecho ao mesmo tempo: fica o dele.
      await tx.execute(sql`DELETE FROM attachments WHERE id = ${created}`);
      const existing = await tx.execute<{ result_attachment_id: string }>(sql`
        SELECT result_attachment_id FROM ai_attachment_derivatives
         WHERE message_id = ${messageId} AND block_index = ${blockIndex} AND kind = 'speech' AND provider_id = ${creds.providerId}
           AND model = ${model} AND voice = ${voice}`);
      return existing.rows[0]!.result_attachment_id;
    });
    parts.push({ blockIndex, attachmentId, characters: chunk.length });
  }
  return { messageId, parts };
}
