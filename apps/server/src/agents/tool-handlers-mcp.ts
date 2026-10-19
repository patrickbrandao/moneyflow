import { MCP_UPLOAD_MAX_BYTES, type mcpOnlyTool, t, uploadMime } from '@moneyflow/shared';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { unprocessable } from '../errors';
import { storeUnlinkedAttachment } from '../services/attachments';

/*
 * Handlers das tools só do /mcp (MCP_ONLY_TOOLS do shared): rodam direto, como
 * as demais no /mcp (a confirmação fica com o cliente), e nunca numa execução
 * de agente.
 */

type UploadInput = z.output<NonNullable<ReturnType<typeof mcpOnlyTool>>['input']>;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const MCP_ONLY_HANDLERS = {
  upload_file: {
    run: async (ctx: ServiceContext, i: UploadInput) => {
      const encoded = i.contentBase64.replace(/\s+/g, '');
      if (!BASE64.test(encoded) || encoded.length % 4 === 1) throw unprocessable(t.errors.uploadInvalidBase64, 'upload_invalid_base64');
      const content = Buffer.from(encoded, 'base64');
      if (content.length > MCP_UPLOAD_MAX_BYTES) throw unprocessable(t.errors.uploadTooLarge, 'upload_too_large');
      const file = await storeUnlinkedAttachment(ctx, { name: i.fileName, mime: uploadMime(i.fileName, i.mimeType), content });
      return { attachmentId: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: Number(file.sizeBytes) };
    },
  },
} satisfies Record<string, { run: (ctx: ServiceContext, input: UploadInput) => Promise<unknown> }>;
