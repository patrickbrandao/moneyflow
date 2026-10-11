import { type ApiError as ApiErrorBody, t } from '@moneyflow/shared';

/*
 * Cliente da API REST (/api). Sessão em cookie httpOnly: o navegador manda
 * sozinho; aqui só tratamos JSON e erros. As mensagens de erro já chegam em
 * pt-BR da API (inclusive as regras do banco traduzidas).
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

let onUnauthorized: (() => void) | null = null;

/** O AuthProvider registra o que fazer quando a sessão cai (401 fora do login). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', t.errors.network);
  }
  const data = response.headers.get('content-type')?.includes('json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    if (response.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized?.();
    throw new ApiError(response.status, error?.code ?? 'http', error?.message ?? t.errors.generic, error?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', withQuery(path, query)),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', withQuery(path, query)),
};
