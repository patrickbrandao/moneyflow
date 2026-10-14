import type { Database } from '@moneyflow/db';
import { blocksText, type NeutralMessage, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { inferenceCredentials, inferenceRequestLog, type VisionMode, visionMode } from './inferences';
import { createLlmClient, type LlmAttachment } from './llm';
import { extractPdfText } from './pdf-text';

/*
 * Pré-processamento dos anexos de uma execução (spec 024), antes da chamada ao
 * modelo de texto (vale também para os fluxos, que são execuções):
 *  - visão direta (o provedor de visão é o do texto): o arquivo vai como está;
 *  - visão por descrição (outro provedor): o provedor de visão descreve/extrai
 *    o anexo uma vez por anexo e modelo; o texto fica em
 *    ai_attachment_derivatives (description) e vai ao modelo de texto como
 *    `[Imagem "nome" — descrição]: …`;
 *  - sem visão: o PDF vai pela camada de texto (pdf.js no servidor, derivado
 *    pdf_text) e a imagem vira um aviso (o upload já a recusa).
 * Os derivados são gravados em transações curtas, nunca durante a chamada.
 */

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF = 'application/pdf';

export const isImageMime = (mime: string) => IMAGE_TYPES.has(mime);

type FileRow = { fileName: string; mime: string; data: Buffer };

export type RunAttachmentsDeps = { db: Database; config: Config; log: FastifyBaseLogger };
export type RunAttachmentsScope = {
  runId: string;
  conversationId: string;
  agentId: string;
  userId: string;
  textProviderId: string | null;
  signal?: AbortSignal;
};

export class RunAttachments {
  private mode: VisionMode | null = null;
  private readonly cache = new Map<string, Promise<LlmAttachment | null>>();

  constructor(
    private readonly deps: RunAttachmentsDeps,
    private readonly scope: RunAttachmentsScope,
  ) {}

  /** Resolve todos os anexos do histórico antes da chamada (as descrições saem aqui, não no meio do stream). */
  async prepare(messages: NeutralMessage[]) {
    for (const message of messages) {
      if (message.role !== 'user') continue;
      for (const block of message.content) if (block.type === 'attachment') await this.load(block.attachment_id);
    }
  }

  /** O `loadAttachment` da chamada ao modelo. */
  readonly load = (attachmentId: string): Promise<LlmAttachment | null> => {
    let pending = this.cache.get(attachmentId);
    if (!pending) {
      pending = this.resolve(attachmentId);
      this.cache.set(attachmentId, pending);
      // Uma falha (provedor de visão fora) não fica guardada: a próxima volta tenta de novo.
      pending.catch(() => this.cache.delete(attachmentId));
    }
    return pending;
  };

  private async visionMode(): Promise<VisionMode> {
    this.mode ??= await visionMode(this.deps.db, this.scope.agentId, this.scope.textProviderId);
    return this.mode;
  }

  private async file(attachmentId: string): Promise<FileRow | null> {
    const result = await this.deps.db.execute<{ file_name: string; mime_type: string; content: Buffer }>(sql`
      SELECT a.file_name, a.mime_type, a.content
        FROM attachments a
        JOIN ai_message_attachments ma ON ma.attachment_id = a.id
        JOIN ai_messages m ON m.id = ma.message_id
       WHERE a.id = ${attachmentId} AND m.conversation_id = ${this.scope.conversationId}
       LIMIT 1`);
    const row = result.rows[0];
    return row ? { fileName: row.file_name, mime: row.mime_type, data: Buffer.from(row.content) } : null;
  }

  private async resolve(attachmentId: string): Promise<LlmAttachment | null> {
    const file = await this.file(attachmentId);
    if (!file) return null;
    const image = isImageMime(file.mime);
    if (!image && file.mime !== PDF) return file;
    const mode = await this.visionMode();
    if (mode === 'direct') return file;
    if (mode === 'describe') {
      const described = await this.describe(attachmentId, file);
      if (described !== null) {
        const text = image
          ? t.agents.attachments.imageDescription(file.fileName, described)
          : t.agents.attachments.documentDescription(file.fileName, described);
        return { fileName: file.fileName, mime: file.mime, text };
      }
    }
    if (image) return { fileName: file.fileName, mime: file.mime, text: t.agents.attachments.imageUnreadable(file.fileName) };
    const text = await this.pdfText(attachmentId, file);
    return {
      fileName: file.fileName,
      mime: file.mime,
      text: text ? t.agents.attachments.pdfText(file.fileName, text) : t.agents.attachments.pdfNoText(file.fileName),
    };
  }

  /** Descrição pelo provedor de visão (uma vez por anexo e modelo); null se a visão deixou de estar disponível. */
  private async describe(attachmentId: string, file: FileRow): Promise<string | null> {
    const { db, config, log } = this.deps;
    const creds = await inferenceCredentials(db, this.scope.agentId, 'vision', this.scope.userId);
    if (!creds?.model) return null;
    const model = creds.model;
    const cached = await db.execute<{ content: string }>(sql`
      SELECT content FROM ai_attachment_derivatives
       WHERE attachment_id = ${attachmentId} AND kind = 'description' AND provider_id = ${creds.providerId} AND model = ${model}
         AND status = 'done'`);
    if (cached.rows[0]) return cached.rows[0].content;

    const client = createLlmClient(creds, inferenceRequestLog(db, creds, config, { runId: this.scope.runId, log }));
    const response = await client.chat({
      model,
      system: t.agents.attachments.describePrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'attachment', attachment_id: attachmentId, file_name: file.fileName, mime_type: file.mime },
            { type: 'text', text: file.fileName },
          ],
        },
      ],
      tools: [],
      params: { max_tokens: 4096 },
      loadAttachment: async () => file,
      signal: this.scope.signal,
      operation: 'vision_describe',
      purpose: 'vision_describe',
    });
    const text = blocksText(response.content).trim().slice(0, 1_000_000) || '—';
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO ai_usage (run_id, provider_id, model, purpose, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
                              request_id)
        VALUES (${this.scope.runId}, ${creds.providerId}, ${model}, 'vision_describe', ${response.usage.inputTokens},
                ${response.usage.outputTokens}, ${response.usage.cacheWriteTokens}, ${response.usage.cacheReadTokens},
                ${response.requestId})`);
      await tx.execute(sql`
        INSERT INTO ai_attachment_derivatives (attachment_id, kind, provider_id, model, content, status)
        VALUES (${attachmentId}, 'description', ${creds.providerId}, ${model}, ${text}, 'done')
        ON CONFLICT ON CONSTRAINT ai_attachment_derivatives_key
        DO UPDATE SET content = EXCLUDED.content, status = 'done', error = NULL, locked_at = NULL`);
    });
    return text;
  }

  /** Camada de texto do PDF (derivado pdf_text, sem provedor); '' = PDF sem texto. */
  private async pdfText(attachmentId: string, file: FileRow): Promise<string> {
    const { db, log } = this.deps;
    const cached = await db.execute<{ content: string }>(sql`
      SELECT content FROM ai_attachment_derivatives
       WHERE attachment_id = ${attachmentId} AND kind = 'pdf_text' AND status = 'done'`);
    if (cached.rows[0]) return cached.rows[0].content;
    let text = '';
    try {
      text = await extractPdfText(file.data);
    } catch (error) {
      // PDF inválido ou protegido: segue como "sem texto".
      log.warn({ err: error, attachmentId }, 'agente: camada de texto do PDF falhou');
    }
    await db.execute(sql`
      INSERT INTO ai_attachment_derivatives (attachment_id, kind, content, status)
      VALUES (${attachmentId}, 'pdf_text', ${text}, 'done')
      ON CONFLICT ON CONSTRAINT ai_attachment_derivatives_key DO NOTHING`);
    return text;
  }
}
