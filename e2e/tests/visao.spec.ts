import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { expect, type Page, test } from '@playwright/test';

/*
 * Fase 3 (visão e mensagens): canvas de fluxo com a gaveta; relatório por
 * categoria exportado em CSV; destino do Telegram cadastrado pela tela com
 * "Enviar teste" contra uma Bot API falsa.
 *
 * A Bot API falsa sobe aqui (porta E2E_TELEGRAM_PORT, padrão 18081) e a pilha
 * precisa apontar para ela: TELEGRAM_API_BASE=http://host.docker.internal:18081
 * no `docker compose up` (ver AGENTS.md). Nada vai para o Telegram de verdade.
 */

const username = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';
const telegramPort = Number(process.env.E2E_TELEGRAM_PORT ?? 18081);
const year = new Date().getFullYear();

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
}

/** Caixa com conta, fornecedor e um título pago no ano corrente (preparados pela API, com a sessão da tela). */
async function scenario(page: Page, tag: string) {
  const api = page.request;
  const post = async (url: string, data: unknown) => {
    const res = await api.post(url, { data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  const category = await post('/api/categories', { kind: 'expense', name: `E2E visão ${tag}`, colorSlot: 6 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Titular visão ${tag}` });
  const supplier = await post('/api/entities', { kind: 'company', name: `Fornecedor visão ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E Visão ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: 'Conta visão',
    bankCode: '077',
    openingBalanceCents: 500_000,
    openingDate: `${year}-01-01`,
  });
  const title = await post('/api/titles', {
    caixaId: caixa.id,
    direction: 'payable',
    entityId: supplier.id,
    categoryId: category.id,
    description: `Consultoria ${tag}`,
    competenceDate: `${year}-03-01`,
    dueDate: `${year}-03-10`,
    amountCents: 45_600,
  });
  await post(`/api/titles/${title.id}/settlements`, { settledOn: `${year}-03-10`, amountCents: 45_600, financialAccountId: account.id });
  return { category, supplier, caixa, title };
}

test('canvas de fluxo: nós, gaveta com o lançamento e link para o título', async ({ page }) => {
  const tag = Date.now().toString(36);
  await login(page);
  const s = await scenario(page, tag);

  await page.goto(`/flow?from=${year}-01-01&to=${year}-12-31&caixas=${s.caixa.id}&mode=realized`);
  await expect(page.getByRole('heading', { name: 'Fluxo de dinheiro' })).toBeVisible();
  const caixaNode = page.getByTestId(`rf__node-caixa:${s.caixa.id}`);
  await expect(caixaNode).toContainText(s.caixa.name);
  const supplierNode = page.getByTestId(`rf__node-entity:${s.supplier.id}`);
  await expect(supplierNode).toContainText('R$ 456,00');

  await supplierNode.click();
  const drawer = page.getByRole('complementary', { name: 'Lançamentos' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(`Consultoria ${tag}`);
  await drawer.getByRole('link', { name: new RegExp(`Consultoria ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/caixas/${s.caixa.id}/payables\\?title=${s.title.id}`));
});

test('relatório por categoria e exportação CSV', async ({ page }) => {
  const tag = Date.now().toString(36);
  await login(page);
  const s = await scenario(page, tag);

  await page.goto(`/reports?from=${year}-01-01&to=${year}-12-31&caixas=${s.caixa.id}`);
  await expect(page.getByRole('heading', { name: 'Relatórios' })).toBeVisible();
  await expect(page.locator('table.data')).toContainText(s.category.name);
  await expect(page.locator('table.data')).toContainText('R$ 456,00');

  await page.getByRole('button', { name: 'Exportar' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Exportar CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const [header, ...lines] = csv.slice(1).split('\r\n');
  expect(header).toMatch(/^Categoria;jan\/\d{4};/);
  expect(lines.some((line) => line.startsWith(`${s.category.name};`) && line.includes('456,00'))).toBe(true);
});

test.describe('mensagens', () => {
  let server: Server;
  const calls: { path: string; body: { chat_id: string; text: string; parse_mode: string } }[] = [];

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        calls.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(telegramPort, '0.0.0.0', resolve));
  });
  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('cadastrar destino do Telegram e enviar teste (Bot API falsa)', async ({ page }) => {
    const tag = Date.now().toString(36);
    const chatId = `-100${Date.now() % 1_000_000_000}`;
    const token = `424242${Date.now() % 1000}:E2EfakeTokenSoParaTeste_${tag}`;
    await login(page);

    await page.goto('/messages');
    await page.getByRole('button', { name: 'Novo destino' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Novo destino' });
    await dialog.getByLabel('Nome').fill(`Grupo E2E ${tag}`);
    await dialog.getByLabel('Token do bot').fill(token);
    await dialog.getByLabel('chat_id').fill(chatId);
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).toBeHidden();

    // A gaveta abre com o destino; o token nunca volta para a tela.
    const drawer = page.getByRole('complementary', { name: `Grupo E2E ${tag}` });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('token guardado');
    await expect(page.locator('body')).not.toContainText(token.split(':')[1]!);

    // Liga um evento (parâmetros padrão).
    await drawer.getByRole('checkbox', { name: 'Resumo diário' }).check();
    await expect(page.getByText('Evento salvo.')).toBeVisible();

    await drawer.getByRole('button', { name: 'Enviar teste' }).click();
    await expect(
      page.getByText('Mensagem de teste enviada.'),
      'a pilha precisa de TELEGRAM_API_BASE apontando para a Bot API falsa',
    ).toBeVisible();
    const call = calls.find((c) => c.body.chat_id === chatId);
    expect(call?.path).toBe(`/bot${token}/sendMessage`);
    expect(call?.body.parse_mode).toBe('HTML');
    expect(call?.body.text).toContain('Mensagem de teste do MoneyFlow');

    // Histórico de envios.
    await page.getByRole('tab', { name: 'Histórico de envios' }).click();
    const row = page.locator('table.data tbody tr', { hasText: `Grupo E2E ${tag}` }).first();
    await expect(row).toContainText('Enviada');
  });
});
