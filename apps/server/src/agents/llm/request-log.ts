import type { Executor } from '@moneyflow/db';
import { type AiRequestOperation, type AiUsagePurpose, OMITTED_HEADER } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { LlmUsage } from './types';

/*
 * Invólucro único das chamadas ao provedor de IA (spec 023). Entra como o
 * `fetch` customizado dos SDKs (Anthropic e OpenAI, ambos com maxRetries: 0):
 *  - cada chamada HTTP vira uma linha em ai_requests (INSERT no início, UPDATE
 *    no fim, fora da transação do negócio; nunca segura transação durante a
 *    chamada);
 *  - as tentativas são do MoneyFlow: até `maxAttempts` (AI_REQUEST_MAX_ATTEMPTS)
 *    para 408, 409, 429, 5xx/529, erro de rede e timeout, com backoff de
 *    1 s, 2 s, 4 s… com jitter, ou o retry-after informado (até 60 s); cada uma
 *    é uma linha em ai_request_attempts (o banco mantém o contador);
 *  - streaming só repete antes de a resposta chegar: depois de devolvida ao SDK,
 *    uma queda no meio do stream termina a requisição em erro;
 *  - cancelar (o signal da execução) interrompe a espera entre as tentativas;
 *  - corpos, cabeçalhos e o stream bruto só com `log_bodies` do provedor, e as
 *    credenciais dos cabeçalhos viram "[omitido]" antes de sair daqui.
 * Uma falha ao gravar o registro nunca derruba a chamada: vira um aviso no log.
 */

export type RequestLogBase = {
  /** Conexão do pool (nunca a transação do negócio). Sem ela, só as tentativas, sem registro. */
  db?: Executor | null;
  providerId?: string | null;
  runId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  /** ai_providers.log_bodies: só então corpos e cabeçalhos são enviados ao banco. */
  logBodies?: boolean;
  /** base_url do provedor (o caminho gravado fica sem o host dele). */
  baseUrl?: string | null;
  /** AI_REQUEST_MAX_ATTEMPTS (padrão 3). */
  maxAttempts?: number;
  /** Base do backoff, em ms (padrão 1000: 1 s, 2 s, 4 s…). */
  backoffMs?: number;
  log?: { warn: (obj: object, msg: string) => void };
};

export type RequestCall = { operation: AiRequestOperation; purpose: AiUsagePurpose | null; model: string | null };

export type RequestOutcome = {
  status: 'ok' | 'error' | 'canceled';
  error?: string | null;
  usage?: LlmUsage;
  /** Resposta montada (JSON final) do streaming; sem ela, a resposta crua (não streaming). */
  responseBody?: unknown;
};

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Tempo máximo até os cabeçalhos da resposta numa tentativa (depois, timeout e nova tentativa). */
const HEADERS_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 60_000;
/** Teto do que fica em memória para gravar (corpo de resposta e stream bruto). */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const RETRYABLE_STATUS = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'openai-organization',
  'openai-project',
  'cookie',
  'set-cookie',
]);
/** Cabeçalhos de credencial além da lista fixa (anthropic-*-key, tokens…). */
const SECRET_LIKE = /(api[-_]?key|token|secret|auth|password|credential|session)/i;

export const OMITTED = OMITTED_HEADER;

/** Cabeçalhos como objeto, com as credenciais omitidas. */
export function redactHeaders(headers: Headers | Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    out[lower] = SECRET_HEADERS.has(lower) || SECRET_LIKE.test(lower) ? OMITTED : String(value);
  }
  return out;
}

const RATE_LIMIT_HEADER = /(ratelimit|rate-limit|retry-after)/i;

function rateLimitHeaders(headers: Headers): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) if (RATE_LIMIT_HEADER.test(name)) out[name.toLowerCase()] = value;
  return Object.keys(out).length > 0 ? out : null;
}

/** retry-after-ms, ou retry-after em segundos ou data HTTP; null sem cabeçalho válido. */
export function parseRetryAfter(headers: Headers): number | null {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Espera do backoff: base × 2^(n−1) com jitter de ±20%, ou o retry-after (até 60 s). */
export function retryDelay(attempt: number, baseMs: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const exp = baseMs * 2 ** (attempt - 1);
  return Math.min(Math.round(exp * (0.8 + Math.random() * 0.4)), MAX_RETRY_AFTER_MS);
}

const SECRET_QUERY = /(key|token|secret|sig|password)/i;
const DEFAULT_HOSTS = new Set(['api.anthropic.com', 'api.openai.com']);

/** Caminho gravado: sem o host quando é o do base_url (ou o padrão do SDK); sem credenciais na URL. */
export function requestPath(url: string, baseUrl: string | null | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.replace(/\s+/g, '').slice(0, 2000) || '/';
  }
  for (const key of [...parsed.searchParams.keys()]) if (SECRET_QUERY.test(key)) parsed.searchParams.set(key, OMITTED);
  parsed.username = '';
  parsed.password = '';
  let base: URL | null = null;
  try {
    base = baseUrl ? new URL(baseUrl) : null;
  } catch {
    base = null;
  }
  const own = base ? base.origin === parsed.origin : DEFAULT_HOSTS.has(parsed.host);
  const path = `${parsed.pathname}${parsed.search}`;
  return (own ? path : `${parsed.origin}${path}`).replace(/\s+/g, '%20').slice(0, 2000);
}

/** Mensagem segura do corpo de erro do provedor (error.message), sem passar de 500 caracteres. */
function errorMessageFrom(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (message) return `HTTP ${status}: ${String(message)}`.slice(0, 500);
  } catch {
    /* corpo não JSON */
  }
  return `HTTP ${status}${text.trim() ? `: ${text.trim().slice(0, 300)}` : ''}`.slice(0, 500);
}

function errorType(status: number): string {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server_error';
  return 'http';
}

const safeError = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

function abortError(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? Object.assign(new Error('Requisição cancelada.'), { name: 'AbortError' });
}

/** Espera interrompível pelo signal (cancelar a execução corta a espera do backoff). */
function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type BodyInfo = { text: string | null; bytes: number | null; replayable: boolean; streaming: boolean };

function describeBody(body: RequestInit['body'] | undefined): BodyInfo {
  if (body === undefined || body === null) return { text: null, bytes: 0, replayable: true, streaming: false };
  if (typeof body === 'string') {
    let streaming = false;
    try {
      streaming = (JSON.parse(body) as { stream?: unknown })?.stream === true;
    } catch {
      streaming = false;
    }
    return { text: body, bytes: Buffer.byteLength(body), replayable: true, streaming };
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const buffer = Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
    return { text: buffer.toString('utf8'), bytes: buffer.length, replayable: true, streaming: false };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields: Record<string, string> = {};
    let bytes = 0;
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        fields[name] = value;
        bytes += Buffer.byteLength(value);
      } else {
        fields[name] = `[arquivo ${value.name || 'sem nome'} · ${value.type || 'binário'} · ${value.size} bytes]`;
        bytes += value.size;
      }
    }
    return { text: JSON.stringify(fields), bytes, replayable: true, streaming: false };
  }
  // Stream ou corpo de outro tipo: não dá para repetir nem gravar.
  return { text: null, bytes: null, replayable: false, streaming: false };
}

type Row = {
  id: string | null;
  t0: number;
  streaming: boolean;
  requestBytes: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
  failed: boolean;
  firstByteMs: number | null;
  responseBytes: number;
  responseHeaders: Record<string, string> | null;
  responseRaw: string;
  bodyDone: Promise<void>;
};

/**
 * Registro e tentativas de uma chamada lógica (uma mensagem, um listar
 * modelos, um lote de embeddings): crie um por chamada, passe `fetch` ao SDK
 * e chame `finish` no fim (no `finally`).
 */
export class RequestRecorder {
  private readonly rows: Row[] = [];
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(
    private readonly base: RequestLogBase,
    private readonly call: RequestCall,
    private readonly realFetch: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.maxAttempts = Math.max(1, Math.min(10, Math.floor(base.maxAttempts ?? 3)));
    this.backoffMs = Math.max(0, base.backoffMs ?? 1000);
  }

  /** Id da requisição principal (a última chamada HTTP), para ai_usage.request_id. */
  get requestId(): string | null {
    return this.rows.at(-1)?.id ?? null;
  }

  private warn(error: unknown, msg: string) {
    this.base.log?.warn({ err: error }, msg);
  }

  private async insertRow(method: string, url: string, headers: Headers, body: BodyInfo): Promise<string | null> {
    const db = this.base.db;
    if (!db) return null;
    const logBodies = this.base.logBodies === true;
    const model = this.call.model && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(this.call.model) ? this.call.model : null;
    try {
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO ai_requests (provider_id, agent_id, user_id, conversation_id, run_id, operation, purpose, model, method, path,
                                 streaming, request_bytes, request_headers, request_body)
        VALUES (${this.base.providerId ?? null}, ${this.base.agentId ?? null}, ${this.base.userId ?? null},
                ${this.base.conversationId ?? null}, ${this.base.runId ?? null}, ${this.call.operation},
                ${this.call.operation === 'test_connection' || this.call.operation === 'list_models' ? null : this.call.purpose},
                ${model}, ${method}, ${requestPath(url, this.base.baseUrl)}, ${body.streaming}, ${body.bytes},
                ${logBodies ? JSON.stringify(redactHeaders(headers)) : null}::jsonb, ${logBodies ? body.text : null})
        RETURNING id`);
      return result.rows[0]?.id ?? null;
    } catch (error) {
      this.warn(error, 'IA: falha ao registrar a requisição');
      return null;
    }
  }

  private async insertAttempt(
    row: Row,
    attempt: number,
    data: {
      startedAt: Date;
      durationMs: number;
      httpStatus?: number | null;
      errorType?: string | null;
      errorMessage?: string | null;
      retryAfterMs?: number | null;
      rateLimit?: Record<string, string> | null;
      responseBody?: string | null;
    },
  ) {
    const db = this.base.db;
    if (!db || !row.id) return;
    try {
      await db.execute(sql`
        INSERT INTO ai_request_attempts (request_id, attempt, started_at, duration_ms, http_status, error_type, error_message,
                                         retry_after_ms, rate_limit_headers, response_body)
        VALUES (${row.id}, ${attempt}, ${data.startedAt.toISOString()}::timestamptz, ${Math.max(0, Math.round(data.durationMs))},
                ${data.httpStatus ?? null}, ${data.errorType ?? null}, ${data.errorMessage?.slice(0, 4000) ?? null},
                ${data.retryAfterMs ?? null}, ${data.rateLimit ? JSON.stringify(data.rateLimit) : null}::jsonb,
                ${this.base.logBodies ? (data.responseBody ?? null) : null})`);
    } catch (error) {
      this.warn(error, 'IA: falha ao registrar a tentativa');
    }
  }

  /** O `fetch` do SDK: registra, tenta de novo quando vale a pena e acompanha o corpo da resposta. */
  readonly fetch: Fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = describeBody(init?.body);
    const signal = init?.signal ?? null;
    const t0 = performance.now();
    const id = await this.insertRow(method, url, headers, body);
    let resolveBody: () => void = () => {};
    const row: Row = {
      id,
      t0,
      streaming: body.streaming,
      requestBytes: body.bytes,
      httpStatus: null,
      errorMessage: null,
      failed: false,
      firstByteMs: null,
      responseBytes: 0,
      responseHeaders: null,
      responseRaw: '',
      bodyDone: new Promise<void>((resolve) => {
        resolveBody = resolve;
      }),
    };
    this.rows.push(row);
    const maxAttempts = body.replayable ? this.maxAttempts : 1;

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = new Date();
      const a0 = performance.now();
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(Object.assign(new Error('Tempo esgotado'), { name: 'TimeoutError' })),
        HEADERS_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await this.realFetch(input instanceof Request ? url : input, {
          ...init,
          signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const canceled = Boolean(signal?.aborted);
        const timedOut = !canceled && timeout.signal.aborted;
        await this.insertAttempt(row, attempt, {
          startedAt,
          durationMs: performance.now() - a0,
          errorType: canceled ? 'canceled' : timedOut ? 'timeout' : 'network',
          errorMessage: canceled ? 'Cancelada.' : safeError(error),
        });
        row.failed = true;
        row.errorMessage = canceled ? null : safeError(error);
        if (canceled || attempt >= maxAttempts) {
          resolveBody();
          throw error;
        }
        try {
          await wait(retryDelay(attempt, this.backoffMs, null), signal);
        } catch (abort) {
          resolveBody();
          throw abort;
        }
        continue;
      }
      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryAfterMs = parseRetryAfter(response.headers);
        const message = errorMessageFrom(response.status, text);
        await this.insertAttempt(row, attempt, {
          startedAt,
          durationMs: performance.now() - a0,
          httpStatus: response.status,
          errorType: errorType(response.status),
          errorMessage: message,
          retryAfterMs,
          rateLimit: rateLimitHeaders(response.headers),
          responseBody: text,
        });
        if (RETRYABLE_STATUS(response.status) && attempt < maxAttempts) {
          try {
            await wait(retryDelay(attempt, this.backoffMs, retryAfterMs), signal);
          } catch (abort) {
            row.failed = true;
            resolveBody();
            throw abort;
          }
          continue;
        }
        row.failed = true;
        row.httpStatus = response.status;
        row.errorMessage = message;
        row.responseHeaders = redactHeaders(response.headers);
        row.responseBytes = Buffer.byteLength(text);
        if (this.base.logBodies) row.responseRaw = text;
        resolveBody();
        return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
      }

      row.httpStatus = response.status;
      row.responseHeaders = redactHeaders(response.headers);
      if (!response.body) {
        await this.insertAttempt(row, attempt, { startedAt, durationMs: performance.now() - a0, httpStatus: response.status });
        resolveBody();
        return response;
      }
      return this.track(row, attempt, startedAt, a0, response, resolveBody, signal);
    }
  };

  /** Repassa o corpo ao SDK sem atrasar os deltas, contando bytes e guardando o bruto (só com log_bodies). */
  private track(
    row: Row,
    attempt: number,
    startedAt: Date,
    a0: number,
    response: Response,
    resolveBody: () => void,
    signal: AbortSignal | null,
  ): Response {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const capture = this.base.logBodies === true;
    let settled = false;
    const settle = async (error: unknown, kind: 'ok' | 'error' | 'canceled') => {
      if (settled) return;
      settled = true;
      if (capture) row.responseRaw += decoder.decode();
      if (kind !== 'ok') {
        row.failed = kind === 'error';
        if (kind === 'error') row.errorMessage = `Resposta interrompida: ${safeError(error)}`.slice(0, 500);
      }
      await this.insertAttempt(row, attempt, {
        startedAt,
        durationMs: performance.now() - a0,
        httpStatus: response.status,
        errorType: kind === 'ok' ? null : kind === 'canceled' ? 'canceled' : 'stream_interrupted',
        errorMessage: kind === 'error' ? safeError(error) : null,
        rateLimit: rateLimitHeaders(response.headers),
      });
      resolveBody();
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          // Cancelada pela execução (o SDK aborta a leitura) ou queda no meio do stream.
          void settle(error, signal?.aborted ? 'canceled' : 'error');
          controller.error(error);
          return;
        }
        if (chunk.done) {
          controller.close();
          void settle(null, 'ok');
          return;
        }
        const value = chunk.value;
        if (row.firstByteMs === null) row.firstByteMs = Math.max(0, Math.round(performance.now() - row.t0));
        row.responseBytes += value.byteLength;
        if (capture && row.responseRaw.length < MAX_CAPTURE_BYTES) row.responseRaw += decoder.decode(value, { stream: true });
        controller.enqueue(value);
      },
      cancel: async (reason) => {
        void settle(reason, 'canceled');
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /** Fecha o registro (UPDATE final) e devolve o id da requisição principal. */
  async finish(outcome: RequestOutcome): Promise<string | null> {
    const db = this.base.db;
    const main = this.rows.at(-1);
    if (!main) return null;
    // O corpo costuma já ter terminado; espera um pouco pela última tentativa.
    await Promise.race([Promise.all(this.rows.map((r) => r.bodyDone)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (!db) return main.id;
    const logBodies = this.base.logBodies === true;
    for (const row of this.rows) {
      if (!row.id) continue;
      const isMain = row === main;
      let status: RequestOutcome['status'] = isMain ? outcome.status : row.failed ? 'error' : 'ok';
      if (isMain && status === 'ok' && row.failed) status = 'error';
      const errorMessage =
        status === 'ok' ? null : status === 'canceled' ? null : (row.errorMessage ?? outcome.error ?? 'Falha na chamada ao provedor.');
      const usage = isMain ? outcome.usage : undefined;
      let responseBody: string | null = null;
      let responseStream: string | null = null;
      if (logBodies) {
        if (row.streaming) {
          responseStream = row.responseRaw || null;
          if (isMain && outcome.responseBody !== undefined) responseBody = JSON.stringify(outcome.responseBody);
          else if (row.failed) responseBody = row.responseRaw || null;
        } else {
          responseBody = row.responseRaw || (isMain && outcome.responseBody !== undefined ? JSON.stringify(outcome.responseBody) : null);
        }
      }
      try {
        await db.execute(sql`
          UPDATE ai_requests
             SET status = ${status}, finished_at = greatest(clock_timestamp(), started_at), http_status = ${row.httpStatus},
                 error_message = ${errorMessage?.slice(0, 4000) ?? null}, first_byte_ms = ${row.firstByteMs},
                 input_tokens = ${usage?.inputTokens ?? 0}, output_tokens = ${usage?.outputTokens ?? 0},
                 cache_write_tokens = ${usage?.cacheWriteTokens ?? 0}, cache_read_tokens = ${usage?.cacheReadTokens ?? 0},
                 response_bytes = ${row.responseBytes},
                 response_headers = ${logBodies && row.responseHeaders ? JSON.stringify(row.responseHeaders) : null}::jsonb,
                 response_body = ${responseBody}, response_stream = ${responseStream}
           WHERE id = ${row.id} AND status = 'running'`);
      } catch (error) {
        this.warn(error, 'IA: falha ao encerrar o registro da requisição');
      }
    }
    return main.id;
  }
}

/** Desfecho de uma chamada que falhou: cancelada (signal) ou erro, com a mensagem segura. */
export function failureOutcome(error: unknown, signal?: AbortSignal | null): RequestOutcome {
  if (signal?.aborted) return { status: 'canceled' };
  return { status: 'error', error: safeError(error) };
}
