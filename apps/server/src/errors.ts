import { DB_CODE_MESSAGES, DB_CONSTRAINT_MESSAGES, DB_NOT_NULL_MESSAGES, t } from '@moneyflow/shared';
import type { ZodError } from 'zod';

/** Erro de negócio com status HTTP e mensagem pt-BR pronta para a interface. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
    /** Cabeçalhos da resposta (ex.: retry-after no 429). */
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (message: string = t.errors.notFound) => new AppError(404, 'not_found', message);
export const forbidden = (message: string = t.errors.forbidden) => new AppError(403, 'forbidden', message);
export const unprocessable = (message: string, code = 'unprocessable') => new AppError(422, code, message);
export const badRequest = (message: string) => new AppError(400, 'bad_request', message);

export function fromZod(error: ZodError): AppError {
  const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  const first = details[0];
  return new AppError(
    400,
    'validation',
    first ? `${t.errors.validation} ${first.path ? `${first.path}: ` : ''}${first.message}` : t.errors.validation,
    details,
  );
}

type PgLike = { code: string; constraint?: string; message: string; detail?: string; table?: string; column?: string };

/** Acha o erro do Postgres na cadeia de causas (o Drizzle embrulha em DrizzleQueryError). */
export function findPgError(error: unknown): PgLike | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as Partial<PgLike> & { severity?: string; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code) && candidate.severity) return candidate as PgLike;
    current = candidate.cause;
  }
  return null;
}

/*
 * Erros para log sem segredo (tarefa 070). O Drizzle embrulha toda falha de consulta num
 * DrizzleQueryError com `params` (os valores da consulta: senha do login, token do bot, chave do
 * provedor) e com eles na mensagem ("Failed query: …\nparams: …"), que o serializador do pino copia
 * inteira, com a pilha e as causas. O erro do Postgres traz em `detail` a linha recusada ("Failing
 * row contains (…)", "Key (…)=(…)"). Aqui saem os valores; ficam o SQL, o código e a mensagem do
 * Postgres (em `pg`, que o serializador não leria da causa).
 */

const PARAMS_LINE = /\nparams: [\s\S]*?(?=\n\s+at |\ncaused by: |$)/g;
const HAS_PARAMS = /\nparams: /;

/** Tira a linha `params:` do Drizzle de um texto (mensagem ou pilha). */
export const redactQueryParams = (text: string) => text.replace(PARAMS_LINE, '\nparams: [omitidos]');

type ErrorLike = Error & Record<string, unknown>;
const isErrorLike = (value: unknown): value is ErrorLike =>
  Boolean(value) && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string';
const isQueryError = (e: ErrorLike) => typeof e.query === 'string' && 'params' in e;
const isPgError = (e: ErrorLike) => typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && 'severity' in e;
/** Campos do erro do Postgres que podem levar valores das linhas. */
const PG_VALUE_FIELDS = new Set(['detail']);

function pgSummary(error: unknown) {
  const pg = findPgError(error) as (PgLike & { severity?: string; routine?: string; schema?: string }) | null;
  if (!pg) return undefined;
  return {
    code: pg.code,
    severity: pg.severity,
    message: pg.message,
    constraint: pg.constraint,
    table: pg.table,
    column: pg.column,
    routine: pg.routine,
  };
}

function sanitize(error: unknown, seen: Set<unknown>): unknown {
  if (!isErrorLike(error) || seen.has(error) || seen.size > 8) return error;
  seen.add(error);
  const query = isQueryError(error);
  const pg = isPgError(error);
  const cause = 'cause' in error ? sanitize(error.cause, seen) : undefined;
  const message = query ? `Failed query: ${String(error.query)}` : redactQueryParams(error.message);
  if (!query && !pg && cause === error.cause && message === error.message && !HAS_PARAMS.test(String(error.stack ?? ''))) return error;
  // Mesmo protótipo (o `type` do log continua o nome da classe), sem os valores.
  const clone = Object.create(Object.getPrototypeOf(error)) as ErrorLike;
  for (const key of Object.keys(error)) {
    if (key === 'params' || key === 'cause' || (pg && PG_VALUE_FIELDS.has(key))) continue;
    clone[key] = error[key];
  }
  clone.message = message;
  const stack = String(error.stack ?? '');
  const header = `${error.name}: ${error.message}`;
  clone.stack = stack.startsWith(header) ? `${error.name}: ${message}${stack.slice(header.length)}` : redactQueryParams(stack);
  if (cause !== undefined) clone.cause = cause;
  if (query) clone.pg = pgSummary(error.cause);
  return clone;
}

/** O erro pronto para o log, sem os parâmetros da consulta nem as linhas do Postgres (tarefa 070). */
export function loggableError(error: unknown): unknown {
  return sanitize(error, new Set());
}

/**
 * Texto curto do erro para log, banco ou tela (o motivo de uma falha): a mensagem sem os parâmetros
 * da consulta e, na falha do Drizzle, o SQL com a mensagem do Postgres.
 */
export function errorText(error: unknown, max = 500): string {
  if (!isErrorLike(error)) return String(error ?? '').slice(0, max);
  if (isQueryError(error)) {
    const pg = findPgError(error);
    const cause = pg?.message ?? (isErrorLike(error.cause) ? redactQueryParams(error.cause.message) : '');
    // A causa primeiro: é o que importa e não some no corte.
    return (cause ? `${cause} (consulta: ${String(error.query)})` : `Failed query: ${String(error.query)}`).slice(0, max);
  }
  return redactQueryParams(error.message).slice(0, max);
}

/** Traduz erros do banco (23514/23505/23503…) para AppError com mensagem pt-BR útil. */
export function translateDbError(error: unknown): AppError | null {
  const pg = findPgError(error);
  if (!pg) return null;
  // Flag em uso (spec 024): o banco põe os nomes dos agentes no DETAIL.
  if (pg.constraint === 'ai_providers_capability_in_use_check' && pg.detail) {
    return new AppError(422, pg.constraint, t.agents.errors.capabilityInUse(pg.detail));
  }
  const byConstraint = pg.constraint ? DB_CONSTRAINT_MESSAGES[pg.constraint] : undefined;
  const byColumn = pg.code === '23502' && pg.table && pg.column ? DB_NOT_NULL_MESSAGES[`${pg.table}.${pg.column}`] : undefined;
  const message = byConstraint ?? byColumn ?? DB_CODE_MESSAGES[pg.code];
  if (!message) return null;
  const status = pg.code === '42501' ? 403 : pg.code === '23505' ? 409 : 422;
  return new AppError(status, pg.constraint ?? `pg_${pg.code}`, message);
}
