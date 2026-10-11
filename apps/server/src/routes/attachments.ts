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

export async function attachmentRoutes(app: FastifyInstance) {
  app.get('/api/attachments', (r: Req) => attachments.listAttachments(r.ctx, parse(attachmentTargetQuery, r.query)));
  app.post('/api/attachments', { bodyLimit: UPLOAD_BODY_LIMIT, config: { rawUpload: true } }, (r: Req) =>
    attachments.uploadAttachment(r.ctx, parse(attachmentUploadQuery, r.query), {
      mime: r.headers['content-type'] ?? '',
      content: attachments.assertUpload(r.body),
    }),
  );
  app.get('/api/attachments/:id/download', async (r: Req, reply) => {
    const file = await attachments.downloadAttachment(r.ctx, param(r, 'id'));
    const inline = r.query.inline === '1';
    reply
      .header('content-type', file.mimeType)
      .header('content-disposition', contentDisposition(file.fileName, inline))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff');
    return reply.send(file.content);
  });
  app.delete('/api/attachments/:id', (r: Req) =>
    attachments.unlinkAttachment(r.ctx, param(r, 'id'), parse(attachmentTargetQuery, r.query)),
  );
}
