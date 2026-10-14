import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { type FakeLlm, startFakeLlm } from '../fakes/fake-llm';
import { type FakeTelegram, startFakeTelegram, textUpdate } from '../fakes/fake-telegram';
import { ADMIN_STATE, baseURL, loginAsAdmin } from '../support/session';

/*
 * Fase 3 (visão e mensagens): canvas de fluxo com a gaveta; relatório por
 * categoria exportado em CSV; destino do Telegram cadastrado pela tela com
 * "Enviar teste" contra uma Bot API falsa.
 *
 * E o Telegram de entrada (spec 029): ligar "Receber mensagens" no destino,
 * parear em Minha conta → Telegram e trocar mensagens com o agente. O webhook
 * é chamado direto pelo teste (simulando o Telegram), com o segredo que a Bot
 * API falsa recebeu no setWebhook: a pilha local não tem HTTPS público.
 *
 * A Bot API falsa (e2e/fakes/fake-telegram.ts) sobe aqui (porta
 * E2E_TELEGRAM_PORT, padrão 18081) e a pilha precisa apontar para ela:
 * TELEGRAM_API_BASE=http://host.docker.internal:18081 no `docker compose up`
 * (ver AGENTS.md). O agente do Telegram usa um provedor de IA falso próprio
 * (porta E2E_LLM_TELEGRAM_PORT, padrão 18083; o de agentes.spec usa a 18082).
 * Nada vai para o Telegram nem para uma API de IA de verdade.
 */

const telegramPort = Number(process.env.E2E_TELEGRAM_PORT ?? 18081);
const llmPort = Number(process.env.E2E_LLM_TELEGRAM_PORT ?? 18083);
const llmBase = process.env.E2E_LLM_TELEGRAM_BASE ?? `http://host.docker.internal:${llmPort}`;
const year = new Date().getFullYear();

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
  await loginAsAdmin(page);
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
  await loginAsAdmin(page);
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
  let tg: FakeTelegram;

  test.beforeAll(async () => {
    tg = await startFakeTelegram(telegramPort, '0.0.0.0');
  });
  test.afterAll(async () => {
    await tg?.close();
  });

  test('cadastrar destino do Telegram e enviar teste (Bot API falsa)', async ({ page }) => {
    const tag = Date.now().toString(36);
    const chatId = `-100${Date.now() % 1_000_000_000}`;
    const token = `424242${Date.now() % 1000}:E2EfakeTokenSoParaTeste_${tag}`;
    await loginAsAdmin(page);

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
    const call = tg.calls.find((c) => c.body.chat_id === chatId);
    expect(call).toMatchObject({ method: 'sendMessage', token });
    expect(call?.body.parse_mode).toBe('HTML');
    expect(call?.body.text).toContain('Mensagem de teste do MoneyFlow');

    // Histórico de envios.
    await page.getByRole('tab', { name: 'Histórico de envios' }).click();
    const row = page.locator('table.data tbody tr', { hasText: `Grupo E2E ${tag}` }).first();
    await expect(row).toContainText('Enviada');

    // Desativa o destino de teste: o worker da pilha não tenta enviar o resumo diário a um bot falso.
    const destinations = await (await page.request.get('/api/message-destinations')).json();
    const created = destinations.find((d: { name: string }) => d.name === `Grupo E2E ${tag}`);
    expect((await page.request.patch(`/api/message-destinations/${created.id}`, { data: { isActive: false } })).ok()).toBeTruthy();
  });
  test('Telegram de entrada (spec 029): ligar "Receber mensagens", parear pelo código e trocar mensagens com o agente', async ({
    page,
  }) => {
    const tag = Date.now().toString(36);
    const llm: FakeLlm = await startFakeLlm(llmPort);
    const adminApi: APIRequestContext = await request.newContext({ baseURL, storageState: ADMIN_STATE });
    const created: { provider?: string; agent?: string; destination?: string } = {};
    try {
      // URL pública HTTPS (o banco vence PUBLIC_BASE_URL): sem ela, "Receber mensagens" fica desligado.
      const setting = await adminApi.put('/api/admin/settings/telegram.public_base_url', { data: { value: 'https://moneyflow-e2e.test' } });
      expect(setting.ok(), await setting.text()).toBeTruthy();
      const provider = await (
        await adminApi.post('/api/admin/ai/providers', {
          data: {
            name: `E2E Telegram ${tag}`,
            kind: 'anthropic',
            baseUrl: llmBase,
            apiKey: 'sk-e2e-tg',
            defaultModels: { text: 'claude-sonnet-5-5' },
          },
        })
      ).json();
      created.provider = provider.id;
      const agent = await (
        await adminApi.post('/api/admin/ai/agents', {
          data: { name: `E2E Agente Telegram ${tag}`, defaultProviderId: provider.id, model: 'claude-sonnet-5-5', isActive: true },
        })
      ).json();
      created.agent = agent.id;
      const token = `525252${Date.now() % 1000}:E2EfakeTelegramEntrada_${tag}`;
      const destination = await (
        await adminApi.post('/api/message-destinations', { data: { name: `Bot entrada ${tag}`, botToken: token, chatId: '-1009876543' } })
      ).json();
      created.destination = destination.id;

      // Liga a entrada pela tela: o setWebhook chega à Bot API falsa com o segredo.
      await loginAsAdmin(page);
      await page.goto('/messages');
      const destinationRow = page.getByRole('row').filter({ hasText: `Bot entrada ${tag}` });
      await destinationRow.getByRole('button', { name: 'Ações' }).click();
      await page.getByRole('menuitem', { name: 'Editar' }).click();
      const dialog = page.getByRole('dialog', { name: 'Editar destino' });
      await dialog.getByLabel('Receber mensagens').check();
      await dialog.getByLabel('Agente que responde').selectOption({ label: agent.name });
      await dialog.getByRole('button', { name: 'Salvar' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('row').filter({ hasText: `Bot entrada ${tag}` })).toContainText(`Recebe mensagens (${agent.name})`);
      const webhook = tg.webhooks.get(token);
      expect(webhook?.url).toBe(`https://moneyflow-e2e.test/api/telegram/webhook/${destination.id}`);
      const hook = async (update: object) => {
        const res = await page.request.post(`/api/telegram/webhook/${destination.id}`, {
          data: update,
          headers: { 'x-telegram-bot-api-secret-token': webhook!.secret },
        });
        expect(res.status(), await res.text()).toBe(200);
      };
      const chat = 800_000_000 + (Date.now() % 90_000_000);
      const said = () => tg.messagesTo(chat).map((c) => String(c.body.text));

      // Chat ainda não pareado: o aviso.
      await hook(textUpdate(chat, 'Oi'));
      expect(said().at(-1)).toContain('Este chat não está pareado com o MoneyFlow');

      // Minha conta → Telegram: gera o código e o chat manda /start <código>.
      await page.goto('/account');
      await page.getByTestId('telegram-destination').selectOption({ label: `Bot entrada ${tag} · ${agent.name}` });
      await page.getByTestId('telegram-generate').click();
      const code = ((await page.getByTestId('telegram-code-value').textContent()) ?? '').replace('/start', '').trim();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
      await hook(textUpdate(chat, `/start ${code}`, { username: `e2e_${tag}` }));
      expect(said().at(-1)).toContain('Pareado com o MoneyFlow');
      await page.reload();
      await expect(page.getByTestId('telegram-links')).toContainText(`@e2e_${tag}`);

      // A conversa: a mensagem vai ao agente (sessão ativa do console) e a resposta volta ao chat.
      await hook(textUpdate(chat, 'Olá pelo Telegram'));
      await expect.poll(() => said().at(-1), { timeout: 45_000 }).toBe('Olá! Sou o agente de teste.');
      expect(tg.calls.some((c) => c.method === 'sendChatAction' && String(c.body.chat_id) === String(chat))).toBe(true);
      const thread = await (await page.request.get(`/api/agents/${agent.id}/thread`)).json();
      expect(thread.session.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
      await hook(textUpdate(chat, '/agente'));
      expect(said().at(-1)).toContain(agent.name);
    } finally {
      await adminApi.delete('/api/admin/settings/telegram.public_base_url');
      if (created.destination) await adminApi.patch(`/api/message-destinations/${created.destination}`, { data: { isActive: false } });
      if (created.agent) await adminApi.patch(`/api/admin/ai/agents/${created.agent}`, { data: { isActive: false } });
      if (created.provider) await adminApi.patch(`/api/admin/ai/providers/${created.provider}`, { data: { isActive: false } });
      await adminApi.dispose();
      await llm.close();
    }
  });
});
