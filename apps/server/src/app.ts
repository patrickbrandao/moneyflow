import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
import { apiLoggerOptions } from './log';
import { agentRoutes } from './routes/agents';
import { attachmentRoutes } from './routes/attachments';
import { authRoutes } from './routes/auth';
import { backupRoutes } from './routes/backup';
import { caixaRoutes } from './routes/caixas';
import { cardRoutes } from './routes/cards';
import { contractRoutes } from './routes/contracts';
import { entityRoutes } from './routes/entities';
import { mcpRoutes } from './routes/mcp';
import { noteRoutes } from './routes/notes';
import { operationRoutes } from './routes/operation';
import { reconcileRecipeRoutes } from './routes/reconcile-recipes';
import { statementRoutes } from './routes/statements';
import { telegramRoutes } from './routes/telegram';
import { titleRoutes } from './routes/titles';
import { userRoutes } from './routes/users';
import { visionRoutes } from './routes/vision';
import { registerSecurityHeaders, spaCsp } from './security-headers';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
  }
}

/** Id de requisição vindo do proxy: aceito só com TRUSTED_PROXIES e neste formato (tarefa 186). */
const PROXY_REQUEST_ID = /^[\w-]{8,64}$/;

/** Rotas de /api acessíveis sem sessão. */
const PUBLIC = new Set(['/api/auth/login', '/api/auth/logout', '/api/health']);

export async function buildApp({
  db,
  config,
  logger = true,
}: {
  db: Database;
  config: Config;
  logger?: boolean | Record<string, unknown>;
}): Promise<FastifyInstance> {
  const fromProxy = config.trustedProxies.length > 0;
  const app = Fastify({
    // Erros no log sem os parâmetros das consultas (senha, token, chave; tarefa 070).
    logger: apiLoggerOptions(config, logger),
    // Id único entre reinícios e réplicas (tarefa 186): o do proxy confiável (X-Request-Id) ou um UUID.
    genReqId: (req) => {
      const header = fromProxy ? req.headers['x-request-id'] : undefined;
      return typeof header === 'string' && PROXY_REQUEST_ID.test(header) ? header : randomUUID();
    },
    // Só os proxies de TRUSTED_PROXIES informam o IP do cliente (X-Forwarded-For); sem eles, o IP é o da
    // conexão. Nunca `true`: o cliente forjaria o IP e contornaria o limite de login (tarefa 050).
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
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
  // Sem bodyLimit nos parsers (tarefa 106): vale o da rota (os uploads declaram 20 MB e o /mcp, o do
  // upload_file em base64) ou o de 1 MB do servidor; acima dele, 413 sem ler o corpo (pelo
  // content-length) ou assim que passar do limite. Login e webhook do Telegram, sem sessão, ficam em 1 MB.
  app.removeContentTypeParser(['application/json', 'text/plain']);
  const isUpload = (request: { routeOptions: { config: unknown } }) =>
    Boolean((request.routeOptions.config as { rawUpload?: boolean } | undefined)?.rawUpload);
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    if (isUpload(request)) return done(null, body);
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    } catch {
      done(Object.assign(new Error('invalid json'), { statusCode: 400 }), undefined);
    }
  });
  app.addContentTypeParser(['text/plain', '*'], { parseAs: 'buffer' }, (request, body, done) =>
    done(null, isUpload(request) || !String(request.headers['content-type'] ?? '').startsWith('text/plain') ? body : body.toString('utf8')),
  );

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Cabeçalhos de segurança em toda resposta e a CSP no HTML do SPA (tarefa 065, docs/001).
  const webDist = config.webDist ? resolve(config.webDist) : null;
  const indexHtml = webDist && existsSync(join(webDist, 'index.html')) ? readFileSync(join(webDist, 'index.html'), 'utf8') : null;
  registerSecurityHeaders(app, indexHtml === null ? null : spaCsp(indexHtml));
  // O id da requisição em toda resposta: é o que o usuário informa e o que acha a linha no log.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) reply.headers(error.headers);
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const translated = translateDbError(error);
    if (translated) {
      // O prazo esgotado (503, tarefa 102) é aviso: mostra consulta lenta ou pool esgotado.
      if (translated.status === 503) request.log.warn({ code: translated.code }, 'banco: prazo esgotado');
      else request.log.info({ code: translated.code }, 'regra do banco');
      if (translated.headers) reply.headers(translated.headers);
      return reply.status(translated.status).send({ error: { code: translated.code, message: translated.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: t.auth.tooManyAttempts } });
    if (status === 413) return reply.status(413).send({ error: { code: 'payload_too_large', message: t.errors.payloadTooLarge } });
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: t.errors.validation } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: 'internal', message: t.errors.generic, requestId: request.id } });
  });

  // Sessão: toda rota /api (menos as públicas) exige cookie válido de usuário ativo. Decide pelo padrão
  // da rota que o roteador já resolveu (decodificado: `/%61pi/...` e a request-target absoluta casam a
  // mesma rota), e também pela URL crua, para que um /api/... inexistente siga respondendo 401 sem
  // cookie (tarefa 051).
  app.addHook('onRequest', async (request) => {
    const raw = request.url.split('?')[0]!;
    const route = request.routeOptions.url;
    const path = route ?? raw;
    const isApi = path.startsWith('/api/') || raw.startsWith('/api/');
    // O webhook do Telegram (spec 029) não tem sessão: autentica pelo segredo do cabeçalho.
    if (!isApi || PUBLIC.has(path) || path.startsWith('/api/telegram/webhook/')) return;
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await resolveSession(db, token, config.sessionIdleHours) : null;
    if (!session) throw new AppError(401, 'unauthenticated', t.auth.unauthenticated);
    request.actor = session.actor;
    request.sessionId = session.sessionId;
    request.ctx = { db, config, access: await loadAccess(db, session.actor), sessionId: session.sessionId, log: request.log };
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
  await app.register(reconcileRecipeRoutes);
  await app.register(noteRoutes);

  // Em produção a API serve o SPA compilado (imagem única).
  if (webDist && indexHtml !== null) {
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
