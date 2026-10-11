import { userColumns, users } from '@moneyflow/db';
import type { GlobalRole } from '@moneyflow/shared';
import { changePasswordInput, loginInput, t } from '@moneyflow/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createSession, deleteSession, SESSION_COOKIE } from '../auth/session';
import { loadAccess } from '../authz/access';
import { AppError } from '../errors';
import { parse, type Req } from '../http';
import { authenticate, changeOwnPassword, getMe } from '../services/users';

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: app.config.loginRateLimit, timeWindow: '1 minute' } } },
    async (request: Req, reply) => {
      const input = parse(loginInput, request.body);
      const userId = await authenticate(app.db, input.login, input.password);
      if (!userId) throw new AppError(401, 'invalid_credentials', t.auth.invalid);
      const session = await createSession(app.db, userId, app.config.sessionDays, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      reply.setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: app.config.cookieSecure,
        path: '/',
        expires: session.expiresAt,
      });
      const [row] = await app.db.select(userColumns).from(users).where(eq(users.id, userId));
      const actor = { id: row!.id, username: row!.username, email: row!.email, role: row!.role as GlobalRole, isActive: row!.isActive };
      return getMe({ db: app.db, access: await loadAccess(app.db, actor), config: app.config });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(app.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => getMe(request.ctx));

  app.post('/api/auth/password', async (request: Req) => {
    await changeOwnPassword(request.ctx, parse(changePasswordInput, request.body), request.sessionId!);
    return { ok: true };
  });
}
