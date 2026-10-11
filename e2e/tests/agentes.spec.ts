import { expect, type Page, test } from '@playwright/test';
import { type FakeLlm, startFakeLlm } from '../fakes/fake-llm';

/*
 * Fase 4 (agentes de IA): abrir uma janela de conversa, conversar com o
 * provedor FALSO, aprovar uma escrita no cartão "Aplicar?", ancorar a
 * conversa no painel direito e minimizá-la para a doca.
 *
 * O provedor falso (Anthropic Messages API) sobe aqui na porta E2E_LLM_PORT
 * (padrão 18082). O worker da pilha o alcança em E2E_LLM_BASE (padrão
 * http://host.docker.internal:18082, a pilha da raiz em Docker). Nada vai para
 * uma API de IA de verdade.
 */

const username = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';
const llmPort = Number(process.env.E2E_LLM_PORT ?? 18082);
const llmBase = process.env.E2E_LLM_BASE ?? `http://host.docker.internal:${llmPort}`;

let llm: FakeLlm;

test.beforeAll(async () => {
  llm = await startFakeLlm(llmPort);
});
test.afterAll(async () => {
  await llm?.close();
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
}

test('agente: conversa, aprova uma escrita, ancora no painel direito e minimiza', async ({ page }) => {
  const tag = Date.now().toString(36);
  await login(page);
  // Começa sem janelas salvas de execuções anteriores.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.includes('agents-ui')) localStorage.removeItem(key);
  });
  await page.reload();

  const api = page.request;
  const post = async (url: string, data: unknown) => {
    const res = await api.post(url, { data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  const provider = await post('/api/admin/ai/providers', {
    name: `E2E falso ${tag}`,
    kind: 'anthropic',
    baseUrl: llmBase,
    apiKey: 'sk-e2e-fake-key',
  });
  const agent = await post('/api/admin/ai/agents', {
    name: `E2E Agente ${tag}`,
    description: 'Agente de teste do e2e',
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    isActive: true,
    colorSlot: 5,
  });

  try {
    // Nova conversa pelo ícone Agentes.
    await page.getByTestId('agents-button').click();
    const select = page.getByTestId('agents-new-agent');
    await expect(select).toBeEnabled();
    await select.selectOption({ label: agent.name });
    await page.getByTestId('agents-new').click();
    const win = page.getByTestId('agent-window').last();
    await expect(win).toBeVisible();

    // Conversa simples, em streaming.
    await win.getByTestId('agent-composer').fill('Olá, tudo bem?');
    await win.getByTestId('agent-send').click();
    await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
      timeout: 30_000,
    });

    // Escrita: o cartão "Aplicar?" mostra a prévia; aprovar aplica.
    const entityName = `E2E Entidade do agente ${tag}`;
    await expect(win.getByTestId('agent-composer')).toBeEnabled({ timeout: 30_000 });
    await win.getByTestId('agent-composer').fill(`criar entidade ${entityName}`);
    await win.getByTestId('agent-send').click();
    const card = win.getByTestId('agent-confirmation');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(entityName);
    await card.getByTestId('agent-approve').first().click();
    await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Pronto:' })).toBeVisible({ timeout: 30_000 });
    const entities: { name: string }[] = await (await api.get(`/api/entities?q=${encodeURIComponent(entityName)}`)).json();
    expect(entities.filter((e) => e.name === entityName)).toHaveLength(1);

    // Ancorar no painel direito (comportamento da sidebar) e minimizar para a doca.
    const conversationId = await win.getAttribute('data-conversation-id');
    await win.getByTestId('agent-dock-right').click();
    const panel = page.getByTestId('agent-side-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-conversation-id', conversationId!);
    await expect(panel.getByTestId('agent-message-assistant').filter({ hasText: 'Pronto:' })).toBeVisible();
    await panel.getByTestId('agent-minimize').click();
    await expect(panel).toHaveCount(0);
    const dockItem = page.locator(`[data-testid="agent-dock-item"][data-conversation-id="${conversationId}"]`);
    await expect(dockItem).toBeVisible();

    // A janela sobrevive à navegação e ao recarregamento (estado persistido).
    await page.goto('/caixas');
    await page.reload();
    await expect(page.locator(`[data-testid="agent-dock-item"][data-conversation-id="${conversationId}"]`)).toBeVisible();
    await page.locator(`[data-testid="agent-dock-item"][data-conversation-id="${conversationId}"]`).click();
    await expect(page.locator(`[data-testid="agent-window"][data-conversation-id="${conversationId}"]`)).toBeVisible();

    // O provedor falso recebeu as tools e o prompt com cache.
    const call = llm.calls.find((c) => c.path === '/v1/messages' && Array.isArray(c.body.tools));
    expect(call?.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  } finally {
    await api.patch(`/api/admin/ai/agents/${agent.id}`, { data: { isActive: false } });
    await api.patch(`/api/admin/ai/providers/${provider.id}`, { data: { isActive: false } });
  }
});
