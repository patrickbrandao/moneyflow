import { attachmentTargetQuery, attachmentUploadQuery } from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import * as attachments from '../services/attachments';

/** Limite do corpo nas rotas de upload (o arquivo vai cru no corpo; 20 MB + folga). */
export const UPLOAD_BODY_LIMIT = attachments.MAX_ATTACHMENT_BYTES + 64 * 1024;

/** Content-Disposition com o nome em UTF-8 (RFC 5987) e um fallback ASCII. */
export function contentDisposition(fileName: string, inline = false) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Um intervalo `bytes=a-b`, `bytes=a-` ou `bytes=-n` (RFC 9110). Vários
 * intervalos ou outra unidade = 'invalid' (responde o arquivo inteiro).
 */
export function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' | 'unsatisfiable' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  if (size === 0) return 'unsatisfiable';
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  if (end < start) return 'invalid';
  return { start, end };
}

/**
 * Tipos que o navegador pode abrir inline sem executar script na origem do console
 * (tarefa 048). Qualquer outro tipo (HTML, SVG, XHTML, XML…) sai sempre como download.
 */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/[a-z0-9.+-]+|video\/(mp4|webm)|text\/plain|text\/markdown)$/;

/** CSP dos downloads que não são PDF: um documento aberto fica numa origem opaca, sem script. */
const DOWNLOAD_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";

export const isInlineSafeMime = (mime: string) => INLINE_SAFE.test(mime);

export async function attachmentRoutes(app: FastifyInstance) {
  app.get('/api/attachments', (r: Req) => attachments.listAttachments(r.ctx, parse(attachmentTargetQuery, r.query)));
  app.post('/api/attachments', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, (r: Req) =>
    attachments.uploadAttachment(r.ctx, parse(attachmentUploadQuery, r.query), {
      mime: r.headers['content-type'] ?? '',
      content: attachments.assertUpload(r.body),
    }),
  );
  // Range (spec 025): o player busca trechos do áudio; o conteúdo vem inteiro do banco (bytea, até 20 MB).
  app.get('/api/attachments/:id/download', async (r: Req, reply) => {
    const file = await attachments.downloadAttachment(r.ctx, param(r, 'id'));
    const inline = r.query.inline === '1' && isInlineSafeMime(file.mimeType);
    const content = Buffer.from(file.content);
    reply
      .header('content-type', file.mimeType)
      .header('content-disposition', contentDisposition(file.fileName, inline))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('accept-ranges', 'bytes');
    // O PDF fica sem o sandbox: ele bloqueia o visualizador do navegador numa aba nova.
    if (file.mimeType !== 'application/pdf') reply.header('content-security-policy', DOWNLOAD_CSP);
    const header = r.headers.range;
    if (!header) return reply.send(content);
    const range = parseRange(header, content.length);
    if (range === 'invalid') return reply.send(content);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${content.length}`).send();
    }
    return reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${content.length}`)
      .send(content.subarray(range.start, range.end + 1));
  });
  app.delete('/api/attachments/:id', (r: Req) =>
    attachments.unlinkAttachment(r.ctx, param(r, 'id'), parse(attachmentTargetQuery, r.query)),
  );
}
