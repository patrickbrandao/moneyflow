import { expect, test } from '@playwright/test';

/*
 * Fluxo principal da F1: login → criar entidade → criar título a pagar → baixar.
 * A caixa, a conta e a categoria são preparadas pela API (já com a sessão do
 * login feito pela tela), para o teste rodar num banco vazio.
 */

const username = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';

test('login, entidade, título e baixa', async ({ page }) => {
  const tag = Date.now().toString(36);

  // 1. Login pela tela.
  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();

  // Preparação pela API (mesma sessão): categoria de despesa, titular, caixa e conta.
  const api = page.request;
  const category = await (
    await api.post('/api/categories', { data: { kind: 'expense', name: `E2E despesa ${tag}`, colorSlot: 5 } })
  ).json();
  const holder = await (await api.post('/api/entities', { data: { kind: 'company', name: `E2E Titular ${tag}` } })).json();
  const caixa = await (
    await api.post('/api/caixas', { data: { name: `E2E Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true } })
  ).json();
  const account = await api.post(`/api/caixas/${caixa.id}/accounts`, {
    data: { kind: 'checking', name: `Conta E2E ${tag}`, bankCode: '077', openingBalanceCents: 100_000, openingDate: '2026-01-01' },
  });
  expect(account.ok()).toBeTruthy();

  // 2. Nova entidade pela tela.
  const supplier = `Fornecedor E2E ${tag}`;
  await page.goto('/entities?new=1');
  const entityDialog = page.getByRole('dialog', { name: 'Nova entidade' });
  await entityDialog.getByRole('button', { name: 'Empresa' }).click();
  await entityDialog.getByLabel('Nome', { exact: true }).fill(supplier);
  await entityDialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('heading', { name: supplier })).toBeVisible();

  // 3. Título a pagar na caixa.
  await page.goto(`/caixas/${caixa.id}/payables?new=1`);
  const titleDialog = page.getByRole('dialog', { name: 'Novo título a pagar' });
  await titleDialog.getByLabel('Recebedor (a quem pagamos)').fill(supplier);
  await titleDialog.getByRole('option', { name: new RegExp(supplier) }).click();
  await titleDialog.getByLabel('Descrição').fill(`Serviço ${tag}`);
  await titleDialog.getByLabel('Categoria').selectOption({ label: category.name });
  await titleDialog.getByLabel('Valor').fill('123,45');
  await titleDialog.getByRole('button', { name: 'Salvar' }).click();

  // O título abre na gaveta; a lista mostra o valor.
  const drawer = page.getByRole('complementary', { name: `Serviço ${tag}` });
  await expect(drawer).toBeVisible();
  await expect(page.locator('table.data')).toContainText('R$ 123,45');

  // 4. Baixa total com a conta da caixa.
  await drawer.getByRole('button', { name: 'Pagar' }).click();
  const settleDialog = page.getByRole('dialog', { name: `Pagar: Serviço ${tag}` });
  await expect(settleDialog.getByLabel('Conta', { exact: true })).toHaveValue(/.+/);
  await settleDialog.getByRole('button', { name: 'Pagar' }).click();
  await expect(drawer.getByText('Pago', { exact: true })).toBeVisible();
  await expect(drawer).toContainText(`Conta E2E ${tag}`);

  // O saldo da conta caiu o valor pago (1.000,00 − 123,45).
  await page.goto(`/caixas/${caixa.id}/accounts`);
  await expect(page.locator('table.data')).toContainText('R$ 876,55');
});
