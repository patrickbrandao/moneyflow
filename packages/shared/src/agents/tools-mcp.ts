import { z } from 'zod';
import { define } from './tool-def';

/*
 * Tools só do servidor /mcp próprio (spec 027): ficam fora de AGENT_TOOLS, dos
 * kits e das execuções dos agentes. No /mcp não há chat para anexar um arquivo,
 * então o cliente envia o conteúdo e recebe o attachmentId que as tools de
 * importação e de anexo usam.
 */

/** Tamanho máximo do arquivo enviado pelo /mcp (o corpo JSON leva o base64, ~4/3 disso). */
export const MCP_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Tipo pelo nome, quando o cliente não informa. */
export const UPLOAD_MIME_BY_EXTENSION: Record<string, string> = {
  ofx: 'application/x-ofx',
  qfx: 'application/x-ofx',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  xml: 'application/xml',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  zip: 'application/zip',
};

export const MCP_ONLY_TOOLS = [
  define({
    name: 'upload_file',
    category: 'imports',
    title: 'Enviar arquivo',
    description:
      'Grava um arquivo enviado pelo cliente MCP (OFX, CSV, XML da NF-e, PDF, imagem, backup) e devolve o attachmentId para import_statement, import_nfe, read_document, attach_file ou simulate_import/import_backup. Conteúdo em base64 (contentBase64), até 5 MB. O anexo fica sem vínculo até ser usado, e só quem o enviou (e o admin) o lê.',
    kind: 'write',
    input: z.object({
      fileName: z.string().trim().min(1).max(255).describe('Nome do arquivo, com a extensão (ex.: santander-poupanca-2019-08.ofx).'),
      mimeType: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('Tipo do arquivo (ex.: application/x-ofx); omitido = pela extensão do nome.'),
      contentBase64: z.string().min(1).describe('Conteúdo do arquivo em base64.'),
    }),
  }),
] as const;

export type McpOnlyToolName = (typeof MCP_ONLY_TOOLS)[number]['name'];

export const mcpOnlyTool = (name: string) => MCP_ONLY_TOOLS.find((tool) => tool.name === name);

/** Tipo do arquivo enviado: o informado ou o da extensão (desconhecido = binário). */
export function uploadMime(fileName: string, mimeType?: string): string {
  if (mimeType) return mimeType;
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  return UPLOAD_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}
