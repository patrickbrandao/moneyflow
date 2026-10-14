import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Database } from '@moneyflow/db';
import { t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { RunEventsHub } from './agents/events-hub';
import { resolveSession, SESSION_COOKIE } from './auth/session';
import { loadAccess } from './authz/access';
import type { Config } from './config';
import { AppError, translateDbError } from './errors';
import { agentRoutes } from './routes/agents';
import { attachmentRoutes, UPLOAD_BODY_LIMIT } from './routes/attachments';
import { authRoutes } from './routes/auth';
import { backupRoutes } from './routes/backup';
import { caixaRoutes } from './routes/caixas';
import { cardRoutes } from './routes/cards';
import { contractRoutes } from './routes/contracts';
import { entityRoutes } from './routes/entities';
import { mcpRoutes } from './routes/mcp';
import { operationRoutes } from './routes/operation';
import { statementRoutes } from './routes/statements';
import { telegramRoutes } from './routes/telegram';
import { titleRoutes } from './routes/titles';
import { userRoutes } from './routes/users';
import { visionRoutes } from './routes/vision';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
  }
}

/** Rotas de /api acessíveis sem sessão. */
const PUBLIC = new Set(['/api/auth/login', '/api/auth/logout', '/api/health']);

export async function buildApp({
  db,
  config,
  logger = true,
}: {
  db: Database;
  config: Config;
  logger?: boolean | object;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger === true ? { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] } : logger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  app.decorate('db', db);
  app.decorate('config', config);
  // Eventos dos agentes (LISTEN ai_run_events → SSE) e o aviso de conclusão.
  const runEvents = new RunEventsHub(db, config, app.log);
  app.decorate('runEvents', runEvents);
  await runEvents.start();
  app.addHook('onClose', async () => runEvents.stop());
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('ctx', null as never);

  // Uploads (anexos, extratos, NF-e): o arquivo vai cru no corpo, com o próprio Content-Type
  // (rotas com config.rawUpload). JSON e texto puro só são interpretados nas demais rotas.
  app.removeContentTypeParser(['application/json', 'text/plain']);
  const isUpload = (request: { routeOptions: { config: unknown } }) =>
    Boolean((request.routeOptions.config as { rawUpload?: boolean } | undefined)?.rawUpload);
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (request, body, done) => {
    if (isUpload(request)) return done(null, body);
    if (body.length > 1024 * 1024) return done(Object.assign(new Error('payload too large'), { statusCode: 413 }), undefined);
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    } catch {
      done(Object.assign(new Error('invalid json'), { statusCode: 400 }), undefined);
    }
  });
  app.addContentTypeParser(['text/plain', '*'], { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (request, body, done) =>
    done(null, isUpload(request) || !String(request.headers['content-type'] ?? '').startsWith('text/plain') ? body : body.toString('utf8')),
  );

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) reply.headers(error.headers);
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const translated = translateDbError(error);
    if (translated) {
      request.log.info({ code: translated.code }, 'regra do banco');
      return reply.status(translated.status).send({ error: { code: translated.code, message: translated.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: t.auth.tooManyAttempts } });
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: t.errors.validation } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: 'internal', message: t.errors.generic } });
  });

  // Sessão: toda rota /api (menos as públicas) exige cookie válido de usuário ativo.
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    // O webhook do Telegram (spec 029) não tem sessão: autentica pelo segredo do cabeçalho.
    if (!path.startsWith('/api/') || PUBLIC.has(path) || path.startsWith('/api/telegram/webhook/')) return;
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await resolveSession(db, token) : null;
    if (!session) throw new AppError(401, 'unauthenticated', t.auth.unauthenticated);
    request.actor = session.actor;
    request.sessionId = session.sessionId;
    request.ctx = { db, config, access: await loadAccess(db, session.actor) };
  });

  app.get('/api/health', { logLevel: 'warn' }, async () => {
    await db.execute(sql`SELECT 1`);
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(entityRoutes);
  await app.register(caixaRoutes);
  await app.register(titleRoutes);
  await app.register(cardRoutes);
  await app.register(attachmentRoutes);
  await app.register(statementRoutes);
  await app.register(operationRoutes);
  await app.register(visionRoutes);
  await app.register(agentRoutes);
  await app.register(mcpRoutes);
  await app.register(backupRoutes);
  await app.register(contractRoutes);
  await app.register(telegramRoutes);

  // Em produção a API serve o SPA compilado (imagem única).
  const webDist = config.webDist ? resolve(config.webDist) : null;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders(res, path) {
        res.header('cache-control', path.includes(`${join(webDist, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.get('/*', (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: t.errors.notFound } });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'not_found', message: t.errors.notFound } }));
  return app;
}
