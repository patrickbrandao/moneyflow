import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

/*
 * Backup e restauração (spec 019): exportar as categorias pela tela e simular
 * a importação do mesmo arquivo — tudo "já cadastrado", nada gravado.
 */

const username = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
}

test('backup: exporta categorias e simula a importação do mesmo arquivo', async ({ page }) => {
  await login(page);
  // Garante ao menos uma categoria (a pilha pode estar sem o seed).
  const created = await page.request.post('/api/categories', {
    data: { kind: 'expense', name: `E2E backup ${Date.now().toString(36)}`, colorSlot: 2 },
  });
  expect(created.ok()).toBe(true);

  await page.getByRole('button', { name: 'Administração' }).click();
  await page.getByRole('link', { name: 'Backup e restauração' }).click();
  await expect(page.getByRole('heading', { name: 'Backup e restauração' })).toBeVisible();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar JSON' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^moneyflow-categories-\d{8}-\d{4}\.json$/);
  const file = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(file.format).toBe('moneyflow-backup');
  const total = file.tables.categories.length;

  await page.getByLabel('Arquivo de backup (.json ou .zip)').setInputFiles((await download.path())!);
  await page.getByRole('button', { name: 'Simular' }).click();
  await expect(page.getByText('Simulação (nada foi gravado)')).toBeVisible();
  const row = page.getByRole('row', { name: /^Categorias/ }).first();
  await expect(row).toContainText(String(total));
  await expect(page.getByRole('tab', { name: /Já cadastrados/ })).toContainText(String(total));
});
