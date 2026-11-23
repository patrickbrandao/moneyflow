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
    /** Id da requisição no log do servidor (500, tarefa 186). */
    public requestId?: string,
  ) {
    super(message);
  }
}

/** O erro de uma resposta da API; no 500, a mensagem leva o começo do id da requisição (tarefa 186). */
export function apiErrorFrom(status: number, data: unknown): ApiError {
  const error = (data as ApiErrorBody | null)?.error;
  const requestId = error?.requestId;
  const message = requestId && error?.code === 'internal' ? t.errors.genericWithCode(requestId.slice(0, 8)) : error?.message;
  return new ApiError(status, error?.code ?? 'http', message ?? t.errors.generic, error?.details, requestId);
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
    if (response.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized?.();
    throw apiErrorFrom(response.status, data);
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
