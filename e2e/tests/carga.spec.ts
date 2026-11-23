import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Telas sob demanda (tarefa 128): a visão geral não baixa o código das outras
 * telas (o canvas, a administração de IA, os contratos) nem o miolo da conversa
 * dos agentes; cada tela chega no seu pedaço ao navegar, sem recarregar a
 * página, e a paleta (⌘K), também sob demanda, troca de tela pelo "Ir para".
 * Os nomes dos pedaços são os do build (`/assets/<Nome>-<hash>.js`): rode
 * contra a pilha compilada (E2E_BASE_URL), não contra o Vite de desenvolvimento.
 */

const chunkName = (url: string) => /^\/assets\/([A-Za-z]+)-[\w-]+\.js$/.exec(new URL(url).pathname)?.[1] ?? null;

test('a visão geral não baixa as outras telas; o menu e a paleta trazem cada uma no seu pedaço', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    const name = request.resourceType() === 'script' ? chunkName(request.url()) : null;
    if (name) scripts.push(name);
  });

  await loginAsAdmin(page);
  // A casca e a visão geral prontas; a paleta pode chegar no ocioso, as telas não.
  await expect(page.getByRole('link', { name: 'Contratos' }).first()).toBeVisible();
  await page.waitForTimeout(1_000);
  for (const name of ['FlowPage', 'AdminAiPage', 'ContractsPage', 'ContractPage', 'ConversationBody', 'Markdown']) {
    expect(scripts, `${name} não carrega na visão geral`).not.toContain(name);
  }
  await page.evaluate(() => {
    (globalThis as unknown as { __semRecarga: boolean }).__semRecarga = true;
  });

  // Pelo menu: a tela chega no seu pedaço.
  await page.getByRole('link', { name: 'Contratos' }).first().click();
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByRole('heading', { name: 'Contratos', exact: true })).toBeVisible();
  expect(scripts).toContain('ContractsPage');
  expect(scripts).not.toContain('FlowPage');

  // Pela paleta (⌘K): "Ir para" o canvas.
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByPlaceholder('Procurar tela, entidade, caixa ou título…');
  await expect(input).toBeVisible();
  await input.fill('Fluxo');
  await page
    .getByRole('option', { name: /Fluxo$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/flow/);
  await expect(page.getByRole('heading', { name: 'Fluxo de dinheiro' })).toBeVisible();
  expect(scripts).toContain('FlowPage');

  // Tudo na mesma página: nenhuma troca recarregou o console.
  expect(await page.evaluate(() => (globalThis as unknown as { __semRecarga?: boolean }).__semRecarga)).toBe(true);
});
