import { DB_CODE_MESSAGES, DB_CONSTRAINT_MESSAGES, t } from '@moneyflow/shared';
import type { ZodError } from 'zod';

/** Erro de negócio com status HTTP e mensagem pt-BR pronta para a interface. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
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

type PgLike = { code: string; constraint?: string; message: string; detail?: string };

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

/** Traduz erros do banco (23514/23505/23503…) para AppError com mensagem pt-BR útil. */
export function translateDbError(error: unknown): AppError | null {
  const pg = findPgError(error);
  if (!pg) return null;
  // Flag em uso (spec 024): o banco põe os nomes dos agentes no DETAIL.
  if (pg.constraint === 'ai_providers_capability_in_use_check' && pg.detail) {
    return new AppError(422, pg.constraint, t.agents.errors.capabilityInUse(pg.detail));
  }
  const byConstraint = pg.constraint ? DB_CONSTRAINT_MESSAGES[pg.constraint] : undefined;
  const message = byConstraint ?? DB_CODE_MESSAGES[pg.code];
  if (!message) return null;
  const status = pg.code === '42501' ? 403 : pg.code === '23505' ? 409 : 422;
  return new AppError(status, pg.constraint ?? `pg_${pg.code}`, message);
}
