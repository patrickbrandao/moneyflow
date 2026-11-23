import { expect, test } from '@playwright/test';
import { ADMIN_STATE, baseURL } from '../support/session';

/*
 * Sessão que cai com o console aberto (tarefa 119): o formulário continua na
 * tela, a janela de login abre por cima e, entrando de novo, o salvar que
 * recebeu o 401 é repetido sem redigitar. A sessão cai porque o admin troca a
 * senha do usuário (encerra as sessões dele), por outro contexto.
 */

test('sessão revogada: o formulário fica, o login abre por cima e o salvar é repetido', async ({ page, browser }) => {
  const tag = Date.now().toString(36);
  const admin = await browser.newContext({ storageState: ADMIN_STATE, baseURL });
  const username = `e2e-sessao-${tag}`;
  const first = `E2e-${tag}-um`;
  const second = `E2e-${tag}-dois`;
  const created = await admin.request.post('/api/users', {
    data: { username, email: `${username}@example.test`, password: first, role: 'admin' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const user = await created.json();

  try {
    // Entra como o usuário novo (o cookie fica no contexto da página).
    const login = await page.request.post('/api/auth/login', { data: { login: username, password: first } });
    expect(login.ok(), await login.text()).toBeTruthy();
    await page.goto('/entities?new=1');
    const form = page.getByRole('dialog', { name: 'Nova entidade' });
    await form.getByRole('button', { name: 'Empresa' }).click();
    const name = `E2E Sessão ${tag}`;
    await form.getByLabel('Nome', { exact: true }).fill(name);

    // O admin troca a senha do usuário: as sessões dele acabam.
    const patched = await admin.request.patch(`/api/users/${user.id}`, { data: { password: second } });
    expect(patched.ok(), await patched.text()).toBeTruthy();

    // O salvar recebe o 401: a janela de login abre por cima e o formulário continua preenchido.
    await form.getByRole('button', { name: 'Salvar' }).click();
    const relogin = page.getByTestId('session-expired');
    await expect(relogin).toBeVisible();
    await expect(form.getByLabel('Nome', { exact: true })).toHaveValue(name);
    // O Esc não fecha a janela da sessão nem o formulário de baixo.
    await page.keyboard.press('Escape');
    await expect(relogin).toBeVisible();
    await expect(form).toBeVisible();

    await expect(relogin.getByLabel('Usuário ou e-mail')).toHaveValue(username);
    await relogin.getByLabel('Senha').fill(second);
    await relogin.getByRole('button', { name: 'Entrar' }).click();
    await expect(relogin).toBeHidden();
    // O salvar que esperava foi repetido: a entidade nasce e a ficha abre, sem redigitar.
    await expect(page.getByRole('heading', { name })).toBeVisible();
  } finally {
    await admin.request.patch(`/api/users/${user.id}`, { data: { isActive: false } });
    await admin.close();
  }
});
