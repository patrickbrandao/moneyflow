import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('mantém ao menos um admin e impede autoexclusão', async () => {
    const adminUser = await userSession(h, 'admin');
    const admin = client(h, adminUser.cookie);
    const res = await admin.del(`/api/users/${adminUser.id}`, 422);
    expect(res.error.message).toMatch(/próprio usuário/);
  });
});
