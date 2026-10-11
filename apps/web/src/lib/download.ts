import { type ApiError as ApiErrorBody, t } from '@moneyflow/shared';
import { ApiError } from './api';

/** Nome do arquivo no Content-Disposition (filename* em UTF-8 tem prioridade). */
function fileNameOf(header: string | null, fallback: string) {
  if (!header) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

/**
 * Baixa um arquivo gerado pela API (GET), com as mensagens de erro da API em
 * vez de uma página de erro no navegador.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', t.errors.network);
  }
  if (!response.ok) {
    const data = response.headers.get('content-type')?.includes('json') ? await response.json().catch(() => null) : null;
    const error = (data as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'http', error?.message ?? t.errors.generic);
  }
  const name = fileNameOf(response.headers.get('content-disposition'), fallbackName);
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
