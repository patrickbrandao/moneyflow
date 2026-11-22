import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insecureCookieWarning, loadConfig } from '../src/config';
import { client, type Harness, login, startApp, uid, userSession } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

describe('autenticação', () => {
  it('entra por username ou e-mail e devolve o usuário sem senha', async () => {
    const user = await userSession(h);
    const byEmail = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: `${user.username.toUpperCase()}@TESTE.LOCAL`, password: user.password },
    });
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.body).not.toContain(user.password);
    const cookie = byEmail.cookies.find((c) => c.name === 'mf_session')!;
    expect(cookie.httpOnly).toBe(true);
    const me = await client(h, `mf_session=${cookie.value}`).get('/api/auth/me');
    expect(me.username).toBe(user.username);
    expect(me).not.toHaveProperty('password');
  });

  it('recusa senha errada com mensagem pt-BR e exige sessão nas rotas', async () => {
    const user = await userSession(h);
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: user.username, password: 'errada' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/incorretos/);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'mf_session=falso' } })).statusCode).toBe(401);
  });

  it('logout encerra a sessão', async () => {
    const user = await userSession(h);
    const api = client(h, user.cookie);
    await api.post('/api/auth/logout');
    await api.get('/api/auth/me', 401);
  });

  it('desativar o usuário revoga as sessões na hora', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const user = await userSession(h);
    await admin.patch(`/api/users/${user.id}`, { isActive: false });
    await client(h, user.cookie).get('/api/auth/me', 401);
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: user.username, password: user.password } });
    expect(res.statusCode).toBe(401);
  });

  it('só o admin revela a senha; a listagem nunca a devolve', async () => {
    const adminUser = await userSession(h, 'admin');
    const admin = client(h, adminUser.cookie);
    const password = `segredo-${uid()}`;
    const created = await admin.post('/api/users', { username: `fulano-${uid()}`, email: `f-${uid()}@x.com`, password, role: 'user' });
    const list = await admin.raw('GET', '/api/users');
    expect(list.body).not.toContain(password);
    expect((await admin.post(`/api/users/${created.id}/reveal-password`)).password).toBe(password);
    const user = await userSession(h);
    await client(h, user.cookie).post(`/api/users/${created.id}/reveal-password`, {}, 403);
    await client(h, user.cookie).get('/api/users', 403);
  });

  it('troca a própria senha conferindo a atual', async () => {
    const user = await userSession(h);
    const api = client(h, user.cookie);
    const wrong = await api.post('/api/auth/password', { currentPassword: 'nao-e', newPassword: 'nova-senha-1' }, 422);
    expect(wrong.error.message).toMatch(/senha atual/);
    await api.post('/api/auth/password', { currentPassword: user.password, newPassword: 'nova-senha-1' });
    await login(h, user.username, 'nova-senha-1');
  });

  it('o admin que troca a própria senha em Usuários mantém só a sessão atual (tarefa 067)', async () => {
    const adminUser = await userSession(h, 'admin');
    const other = await login(h, adminUser.username, adminUser.password);
    const current = client(h, adminUser.cookie);
    await current.patch(`/api/users/${adminUser.id}`, { password: 'nova-senha-admin-1' });
    await current.get('/api/auth/me');
    await client(h, other).get('/api/auth/me', 401);
    // Trocar a senha de outro usuário encerra todas as sessões dele.
    const user = await userSession(h);
    const second = await login(h, user.username, user.password);
    await current.patch(`/api/users/${user.id}`, { password: 'nova-senha-user-1' });
    await client(h, user.cookie).get('/api/auth/me', 401);
    await client(h, second).get('/api/auth/me', 401);
  });

  it('mantém ao menos um admin e impede autoexclusão', async () => {
    const adminUser = await userSession(h, 'admin');
    const admin = client(h, adminUser.cookie);
    const res = await admin.del(`/api/users/${adminUser.id}`, 422);
    expect(res.error.message).toMatch(/próprio usuário/);
  });
});

describe('limite de login e IP do cliente (tarefa 050)', () => {
  const PEER = '203.0.113.7';
  const loginAs = (app: Harness, payload: object, xff?: string) =>
    app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: PEER,
      headers: xff ? { 'x-forwarded-for': xff } : {},
      payload,
    });
  const lastSessionIp = async (userId: string) =>
    (
      await h.db.execute<{ ip: string }>(
        sql`SELECT host(ip) AS ip FROM sessions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0]?.ip;

  it('sem TRUSTED_PROXIES, um X-Forwarded-For diferente a cada tentativa não contorna o limite', async () => {
    const user = await userSession(h);
    const limited = await startApp({ LOGIN_RATE_LIMIT: '10' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        codes.push((await loginAs(limited, { login: user.username, password: 'errada' }, `10.0.${i}.1, 198.51.100.9`)).statusCode);
      }
      expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(codes[10]).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('sem TRUSTED_PROXIES, sessions.ip grava o IP da conexão, mesmo com um X-Forwarded-For que não é IP', async () => {
    const user = await userSession(h);
    const app = await startApp({ LOGIN_RATE_LIMIT: '10' });
    try {
      const res = await loginAs(app, { login: user.username, password: user.password }, 'nao-e-ip');
      expect(res.statusCode, res.body).toBe(200);
      expect(await lastSessionIp(user.id)).toBe(PEER);
    } finally {
      await app.close();
    }
  });

  it('com o proxy em TRUSTED_PROXIES, o X-Forwarded-For vale: um limite por cliente e o IP dele na sessão', async () => {
    const user = await userSession(h);
    const proxied = await startApp({ LOGIN_RATE_LIMIT: '10', TRUSTED_PROXIES: `${PEER}/32, loopback` });
    try {
      // Cada cliente tem o seu balde.
      for (let i = 0; i < 11; i++) {
        expect((await loginAs(proxied, { login: user.username, password: 'errada' }, `10.1.${i}.1`)).statusCode).toBe(401);
      }
      // O mesmo cliente passa do limite.
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        codes.push((await loginAs(proxied, { login: user.username, password: 'errada' }, '198.51.100.30')).statusCode);
      }
      expect(codes[10]).toBe(429);
      const ok = await loginAs(proxied, { login: user.username, password: user.password }, '198.51.100.20');
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await lastSessionIp(user.id)).toBe('198.51.100.20');
      // O proxy só acrescenta: o valor à esquerda, que o cliente controla, não é confiável.
      const chained = await loginAs(proxied, { login: user.username, password: user.password }, '1.2.3.4, 198.51.100.21');
      expect(chained.statusCode, chained.body).toBe(200);
      expect(await lastSessionIp(user.id)).toBe('198.51.100.21');
    } finally {
      await proxied.close();
    }
  });
});

describe('ociosidade da sessão e cookie Secure (tarefa 066)', () => {
  const age = (userId: string, hours: number) =>
    h.db.execute(sql`UPDATE sessions SET last_seen_at = now() - make_interval(hours => ${hours}::int) WHERE user_id = ${userId}`);

  it('a sessão sem uso há mais que SESSION_IDLE_HOURS (padrão 72) cai; dentro do limite continua e renova', async () => {
    expect(h.config.sessionIdleHours).toBe(72);
    const user = await userSession(h);
    await age(user.id, 71);
    await client(h, user.cookie).get('/api/auth/me');
    const seen = await h.db.execute<{ fresh: boolean }>(
      sql`SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM sessions WHERE user_id = ${user.id}`,
    );
    expect(seen.rows[0]?.fresh).toBe(true);
    await age(user.id, 73);
    await client(h, user.cookie).get('/api/auth/me', 401);
  });

  it('SESSION_IDLE_HOURS=0 desliga a ociosidade (vale só a validade em dias)', async () => {
    const app = await startApp({ SESSION_IDLE_HOURS: '0' });
    try {
      const user = await userSession(app);
      await age(user.id, 24 * 20);
      await client(app, user.cookie).get('/api/auth/me');
    } finally {
      await app.close();
    }
  });

  it('recusa SESSION_IDLE_HOURS inválido', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', SESSION_IDLE_HOURS: '-1' })).toThrow(/SESSION_IDLE_HOURS/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', SESSION_IDLE_HOURS: '1.5' })).toThrow(/SESSION_IDLE_HOURS/);
  });

  it('avisa no boot quando a URL pública é HTTPS e o cookie não é Secure', () => {
    const base = { cookieSecure: false, publicUrl: null, publicBaseUrl: null };
    expect(insecureCookieWarning({ ...base, publicBaseUrl: 'https://mf.exemplo.com' })).toMatch(/COOKIE_SECURE=true/);
    expect(insecureCookieWarning({ ...base, publicUrl: 'HTTPS://mf.exemplo.com' })).toMatch(/COOKIE_SECURE/);
    expect(insecureCookieWarning({ ...base, publicUrl: 'http://localhost:3000' })).toBeNull();
    expect(insecureCookieWarning(base)).toBeNull();
    expect(insecureCookieWarning({ ...base, cookieSecure: true, publicBaseUrl: 'https://mf.exemplo.com' })).toBeNull();
  });
});

describe('limite do corpo nas rotas sem sessão (tarefa 106)', () => {
  const big = () => JSON.stringify({ login: 'x', password: 'y', pad: 'z'.repeat(2 * 1024 * 1024) });

  it('login e webhook do Telegram recusam um JSON de 2 MB com 413, antes de ler (content-length)', async () => {
    for (const url of ['/api/auth/login', `/api/telegram/webhook/${'0'.repeat(8)}-0000-4000-8000-000000000000`]) {
      const res = await h.app.inject({ method: 'POST', url, payload: big(), headers: { 'content-type': 'application/json' } });
      expect(res.statusCode, url).toBe(413);
      expect(res.json().error.code).toBe('payload_too_large');
    }
    // Um corpo de texto puro grande também (o parser genérico não lê mais 20 MB).
    const text = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: 'x'.repeat(2 * 1024 * 1024),
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(413);
  });
});
