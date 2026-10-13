import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * CNPJ alfanumérico (spec 003, tarefa 015): cadastrar uma empresa digitando o
 * CNPJ alfanumérico em minúsculas e com pontuação (o campo passa a maiúsculas
 * enquanto se digita e formata no blur), salvar e achá-la pela busca da
 * listagem com o começo do documento.
 */

/** CNPJ alfanumérico fictício e válido: base [0-9A-Z]{12} + DV (cada caractere = ASCII − 48). */
function alphaCnpj(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const pick = (from: string) => from[Math.floor(Math.random() * from.length)]!;
  const base = `${pick(chars.slice(10))}${pick(chars.slice(0, 10))}${Array.from({ length: 10 }, () => pick(chars)).join('')}`;
  const dv = (s: string, weights: number[]) => {
    const sum = weights.reduce((acc, w, i) => acc + (s.charCodeAt(i) - 48) * w, 0);
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  const first = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = dv(`${base}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${first}${second}`;
}

const format = (c: string) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;

test('CNPJ alfanumérico: cadastra a empresa digitando em minúsculas e a acha pela busca', async ({ page }) => {
  await loginAsAdmin(page);
  const cnpj = alphaCnpj();
  const formatted = format(cnpj);
  const name = `E2E Alfa ${Date.now().toString(36)}`;

  await page.goto('/entities?new=1');
  const dialog = page.getByRole('dialog', { name: 'Nova entidade' });
  await dialog.getByRole('button', { name: 'Empresa' }).click();
  await dialog.getByLabel('Nome', { exact: true }).fill(name);
  const document = dialog.getByRole('textbox', { name: 'CNPJ' });
  await expect(document).toHaveAttribute('placeholder', '00.000.000/0000-00 ou 12.ABC.345/01DE-35');
  await document.pressSequentially(formatted.toLowerCase());
  // Maiúsculas já ao digitar; no blur, formatado.
  await expect(document).toHaveValue(formatted);
  await dialog.getByLabel('Nome', { exact: true }).click();
  await expect(document).toHaveValue(formatted);
  await expect(document).not.toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // A busca da listagem acha pelo começo do documento, digitado em minúsculas e pontuado.
  await page.goto('/entities?kind=all');
  await page.getByRole('tab', { name: 'Todos' }).click();
  await page.getByPlaceholder('Nome, fantasia ou CPF/CNPJ').fill(formatted.slice(0, 10).toLowerCase());
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(formatted);
});
