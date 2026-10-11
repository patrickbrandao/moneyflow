import { type ApiError as ApiErrorBody, t } from '@moneyflow/shared';
import { ApiError, withQuery } from './api';

type Query = Record<string, string | number | boolean | null | undefined>;

/**
 * Upload de arquivo: o conteúdo vai cru no corpo, com o Content-Type do
 * arquivo; os parâmetros vão na query string (anexos, extratos, NF-e).
 */
export async function upload<T>(path: string, file: Blob & { name?: string }, query?: Query): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withQuery(path, { fileName: file.name, ...query }), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'network', t.errors.network);
  }
  const data = response.headers.get('content-type')?.includes('json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'http', error?.message ?? t.errors.generic, error?.details);
  }
  return data as T;
}

/** Link de download de um anexo (`inline` abre no navegador). */
export const attachmentUrl = (id: string, inline = false) => `/api/attachments/${id}/download${inline ? '?inline=1' : ''}`;
