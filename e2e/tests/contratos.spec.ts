import { expect, test } from '@playwright/test';

/*
 * Contratos (spec 020): criar pela tela, ativar (gera as parcelas do ciclo),
 * ver a tarefa de renovação aberta na antecedência e aprová-la com reajuste
 * (gera o ciclo seguinte). Caixa, titular, contraparte e categoria vêm da API.
 */

const username = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';

/** Hoje − 11 meses (o ciclo de 12 meses termina daqui a ~1 mês: dentro da antecedência de 60 dias). */
function elevenMonthsAgo() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(Math.min(now.getDate(), 28)).padStart(2, '0')}`;
}

test('contrato: criar, ativar e aprovar a renovação', async ({ page }) => {
  const tag = Date.now().toString(36);

  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();

  const api = page.request;
  const category = await (await api.post('/api/categories', { data: { kind: 'income', name: `E2E receita ${tag}`, colorSlot: 4 } })).json();
  const holder = await (await api.post('/api/entities', { data: { kind: 'company', name: `E2E Prestadora ${tag}` } })).json();
  const caixa = await (
    await api.post('/api/caixas', { data: { name: `E2E Contratos ${tag}`, holderEntityId: holder.id, isPrimary: true } })
  ).json();
  const client = `E2E Cliente ${tag}`;
  expect((await api.post('/api/entities', { data: { kind: 'company', name: client } })).ok()).toBeTruthy();

  // 1. Novo contrato pela tela, salvo e ativado.
  const name = `Suporte mensal ${tag}`;
  await page.goto('/contracts?new=1');
  const dialog = page.getByRole('dialog', { name: 'Novo contrato' });
  await dialog.getByLabel('Caixa', { exact: true }).selectOption({ label: caixa.name });
  await dialog.getByLabel('Contraparte').fill(client);
  await dialog.getByRole('option', { name: new RegExp(client) }).click();
  await dialog.getByLabel('Nome / objeto').fill(name);
  await dialog.getByLabel('Categoria').selectOption({ label: category.name });
  await dialog.getByLabel('Início').fill(elevenMonthsAgo());
  await dialog.getByLabel('Valor total do ciclo').fill('1.200,01');
  await expect(dialog).toContainText('1ª R$ 100,01 · 2ª–12ª R$ 100,00');
  await dialog.getByLabel('Renova automaticamente').check();
  await dialog.getByRole('button', { name: 'Salvar e ativar' }).click();

  // 2. Detalhe: 12 parcelas e a tarefa de renovação aberta (dentro da antecedência).
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Renovação pendente', { exact: true })).toBeVisible();
  await expect(page.locator('table.data tbody tr')).toHaveCount(12);
  await expect(page.locator('table.data')).toContainText('R$ 100,01');

  // 3. Aprovar a renovação com reajuste de 10%: novo ciclo com as parcelas.
  await page.getByRole('button', { name: 'Renovar' }).first().click();
  const renew = page.getByRole('dialog', { name: 'Renovar contrato' });
  await renew.getByLabel('Reajuste (%)').fill('10');
  await expect(renew.getByLabel('Valor total do ciclo')).toHaveValue('1.320,01');
  await expect(renew).toContainText('Novo ciclo:');
  await renew.getByRole('button', { name: 'Renovar' }).click();
  await expect(page.getByText('Contrato renovado: 12 parcela(s) gerada(s).')).toBeVisible();
  await expect(page.getByText('Vigente', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Ciclo 2 ·/ })).toBeVisible();

  // 4. A lista mostra o contrato vigente.
  await page.goto('/contracts');
  await expect(page.locator('table.data')).toContainText(name);
});
