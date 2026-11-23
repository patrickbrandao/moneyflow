import pino from 'pino';
import type { Config } from './config';
import { loggableError } from './errors';

/*
 * Opções comuns do log da API (Fastify) e do worker (pino): os cabeçalhos de
 * sessão fora e o serializador de erro sem os parâmetros das consultas nem as
 * linhas do Postgres (tarefa 070). Todo `log.*(erro)` e `log.*({ err })` passa
 * por ele.
 */

export const LOG_REDACT = ['req.headers.cookie', 'req.headers.authorization'];

export const logSerializers = {
  err: (error: unknown) => pino.stdSerializers.err(loggableError(error) as Error),
};

const errorLike = (value: unknown): value is Error =>
  Boolean(value) && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string';

/**
 * Antes do serializador: o pino usa a mensagem do erro como `msg` da linha (`log.error(erro)` ou
 * `log.error({ err })` sem texto), e ela leva os parâmetros. O gancho troca o erro pelo saneado.
 */
export const logHooks = {
  logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
    const [first, ...rest] = args;
    if (errorLike(first)) return method.apply(this, [loggableError(first), ...rest]);
    if (first && typeof first === 'object' && errorLike((first as { err?: unknown }).err)) {
      return method.apply(this, [{ ...(first as object), err: loggableError((first as { err: unknown }).err) }, ...rest]);
    }
    return method.apply(this, args);
  },
};

/** Opções do logger do Fastify: `true` (padrão), `false` ou opções próprias (os testes mandam um `stream`). */
export function apiLoggerOptions(config: Pick<Config, 'logLevel'>, logger: boolean | Record<string, unknown>) {
  if (logger === false) return false;
  const own = logger === true ? {} : logger;
  return {
    level: config.logLevel,
    redact: LOG_REDACT,
    ...own,
    serializers: { ...((own.serializers as Record<string, unknown> | undefined) ?? {}), ...logSerializers },
    hooks: logHooks,
  };
}

/** O logger do worker. */
export function workerLogger(config: Pick<Config, 'logLevel'>) {
  return pino({ level: config.logLevel, base: { mode: 'worker' }, serializers: logSerializers, hooks: logHooks });
}
