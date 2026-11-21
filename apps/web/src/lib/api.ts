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

/**
 * O que fazer quando a sessão cai (401 fora do login). O AuthProvider devolve
 * uma promessa que resolve depois do login de novo pela janela da sessão
 * expirada (tarefa 119): `true` = o mesmo usuário entrou e o pedido é repetido;
 * `false` = saiu ou entrou outro, e o pedido falha com `session_expired`.
 * `null` = não há console para manter (o 401 falha na hora).
 */
type UnauthorizedHandler = () => Promise<boolean> | null;

let onUnauthorized: UnauthorizedHandler | null = null;
let sessionExpired = false;

/** O AuthProvider registra o que fazer quando a sessão cai. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

/** Sessão caída à espera do login de novo: as sondagens (sino, lembretes) param enquanto isso. */
export const isSessionExpired = () => sessionExpired;
export function setSessionExpired(value: boolean) {
  sessionExpired = value;
}

/** As rotas da própria sessão não esperam o login de novo: o 401 delas é a resposta. */
const SESSION_ROUTES = ['/api/auth/login', '/api/auth/logout', '/api/auth/me'];

/**
 * Chamado por quem recebeu um 401 (request, upload, download). Devolve `true`
 * quando o pedido pode ser repetido; senão, quem chamou lança o erro.
 */
export async function recoverSession(path: string): Promise<boolean> {
  if (SESSION_ROUTES.some((route) => path.startsWith(route))) return false;
  const waiting = onUnauthorized?.() ?? null;
  if (!waiting) return false;
  sessionExpired = true;
  return waiting;
}

export const sessionExpiredError = () => new ApiError(401, 'session_expired', t.auth.sessionExpired);

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

export type RequestOptions = { signal?: AbortSignal };

export async function request<T>(method: string, path: string, body?: unknown, init?: RequestOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: init?.signal,
    });
  } catch {
    if (init?.signal?.aborted) throw new ApiError(0, 'aborted', t.errors.network);
    throw new ApiError(0, 'network', t.errors.network);
  }
  const data = response.headers.get('content-type')?.includes('json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    if (response.status === 401 && !path.startsWith('/api/auth/login')) {
      // O 401 sai da checagem da sessão, antes de qualquer rota: nada foi
      // gravado, e repetir depois do login de novo é seguro.
      if (await recoverSession(path)) return request<T>(method, path, body, init);
      if (SESSION_ROUTES.some((route) => path.startsWith(route))) {
        throw new ApiError(response.status, error?.code ?? 'http', error?.message ?? t.errors.generic, error?.details);
      }
      throw sessionExpiredError();
    }
    throw new ApiError(response.status, error?.code ?? 'http', error?.message ?? t.errors.generic, error?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, init?: RequestOptions) => request<T>('GET', withQuery(path, query), undefined, init),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', withQuery(path, query)),
};
