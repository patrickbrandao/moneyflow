import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Actor } from './authz/access';
import type { ServiceContext } from './context';
import { AppError, fromZod } from './errors';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Rota de upload: o corpo chega cru (Buffer), qualquer que seja o Content-Type. */
    rawUpload?: boolean;
  }
  interface FastifyRequest {
    actor: Actor | null;
    sessionId: string | null;
    ctx: ServiceContext;
  }
}

/** Valida com Zod e devolve 400 com a mensagem pt-BR do primeiro problema. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

export type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: unknown }>;
export type Reply = FastifyReply;

export const param = (request: Req, name: string) => {
  const value = request.params[name];
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new AppError(404, 'not_found', 'Registro não encontrado.');
  return value;
};
