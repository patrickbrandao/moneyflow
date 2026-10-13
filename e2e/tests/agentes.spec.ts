import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, type Request, request, test } from '@playwright/test';
import { defaultBrain, type FakeLlm, startFakeLlm } from '../fakes/fake-llm';
import { ADMIN_STATE, baseURL, loginAsAdmin } from '../support/session';

/*
 * Fase 4 (agentes de IA) contra a API real, com o provedor FALSO:
 *  - conversar, aprovar uma escrita no cartão "Aplicar?", ancorar e minimizar;
 *  - recusar uma escrita com motivo (o agente recebe e responde com ele);
 *  - reconexão do SSE no meio da resposta (Last-Event-ID, sem duplicar nem perder);
 *  - o admin lê a conversa de outro usuário em modo somente leitura;
 *  - "Usar nos fluxos automáticos" em /admin/ai e as sugestões da conciliação
 *    aprovadas e descartadas em lote na tela.
 *
 * O provedor falso (Anthropic Messages API) sobe aqui na porta E2E_LLM_PORT
 * (padrão 18082). O worker da pilha o alcança em E2E_LLM_BASE (padrão
 * http://host.docker.internal:18082, a pilha da raiz em Docker). Nada vai para
 * uma API de IA de verdade. O admin usa a sessão aberta no global-setup (o
 * /api/auth/login tem limite por minuto); só o outro usuário faz login aqui.
 */

const llmPort = Number(process.env.E2E_LLM_PORT ?? 18082);
const llmBase = process.env.E2E_LLM_BASE ?? `http://host.docker.internal:${llmPort}`;
const FIXTURES = join(import.meta.dirname, '../../apps/server/test/fixtures');

/** Resposta longa em vários pedaços, para derrubar o SSE no meio dela. */
const LONG_REPLY = Array.from({ length: 16 }, (_, i) => `Trecho ${String(i + 1).padStart(2, '0')} da resposta longa.`).join(' ');

let llm: FakeLlm;
let adminApi: APIRequestContext;
let provider: { id: string };
let agent: { id: string; name: string };
const tag = Date.now().toString(36);

async function apiLogin(login: string, secret: string) {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { login, password: secret } });
  expect(res.ok(), `login ${login}: ${await res.text()}`).toBeTruthy();
  return ctx;
}

async function postJson(api: APIRequestContext, url: string, data?: unknown) {
  const res = await api.post(url, { data: data ?? {} });
  expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
  return res.json();
}

/** Entra como admin com a sessão já aberta e começa sem janelas salvas. */
async function enter(page: Page) {
  await loginAsAdmin(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.includes('agents-ui')) localStorage.removeItem(key);
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
}

/** Nova conversa com o agente do e2e pelo ícone Agentes. */
async function newConversation(page: Page) {
  await page.getByTestId('agents-button').click();
  const select = page.getByTestId('agents-new-agent');
  await expect(select).toBeEnabled();
  await select.selectOption({ label: agent.name });
  await page.getByTestId('agents-new').click();
  const win = page.getByTestId('agent-window').last();
  await expect(win).toBeVisible();
  await expect(win).toHaveAttribute('data-conversation-id', /.+/);
  return win;
}

async function say(win: ReturnType<Page['getByTestId']>, text: string) {
  await expect(win.getByTestId('agent-composer')).toBeEnabled({ timeout: 30_000 });
  await win.getByTestId('agent-composer').fill(text);
  await win.getByTestId('agent-send').click();
}

test.beforeAll(async () => {
  llm = await startFakeLlm(llmPort);
  llm.brain = (view) => {
    if (view.lastRole === 'user' && /reconectar o stream/i.test(view.lastText)) return { text: LONG_REPLY, chunks: 16, delayMs: 60 };
    return defaultBrain(view);
  };
  adminApi = await request.newContext({ baseURL, storageState: ADMIN_STATE });
  provider = await postJson(adminApi, '/api/admin/ai/providers', {
    name: `E2E falso ${tag}`,
    kind: 'anthropic',
    baseUrl: llmBase,
    apiKey: 'sk-e2e-fake-key',
  });
  agent = await postJson(adminApi, '/api/admin/ai/agents', {
    name: `E2E Agente ${tag}`,
    description: 'Agente de teste do e2e',
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    isActive: true,
    colorSlot: 5,
  });
});

test.afterAll(async () => {
  if (adminApi) {
    if (agent) await adminApi.patch(`/api/admin/ai/agents/${agent.id}`, { data: { isActive: false } });
    if (provider) await adminApi.patch(`/api/admin/ai/providers/${provider.id}`, { data: { isActive: false } });
    await adminApi.dispose();
  }
  await llm?.close();
});

test('agente: conversa, aprova uma escrita, ancora no painel direito e minimiza', async ({ page }) => {
  await enter(page);
  const win = await newConversation(page);

  // Conversa simples, em streaming.
  await say(win, 'Olá, tudo bem?');
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
    timeout: 30_000,
  });

  // Escrita: o cartão "Aplicar?" mostra a prévia; aprovar aplica.
  const entityName = `E2E Entidade do agente ${tag}`;
  await say(win, `criar entidade ${entityName}`);
  const card = win.getByTestId('agent-confirmation');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(entityName);
  await card.getByTestId('agent-approve').first().click();
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Pronto:' })).toBeVisible({ timeout: 30_000 });
  const entities: { name: string }[] = await (await page.request.get(`/api/entities?q=${encodeURIComponent(entityName)}`)).json();
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
});

test('agente: recusar uma escrita com motivo; nada é gravado e o agente responde com o motivo', async ({ page }) => {
  await enter(page);
  const win = await newConversation(page);
  const entityName = `E2E Recusada ${tag}`;
  const reason = `Nome errado, era outro fornecedor ${tag}`;

  await say(win, `criar entidade ${entityName}`);
  const card = win.getByTestId('agent-confirmation');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(entityName);
  await card.getByRole('button', { name: 'Recusar', exact: true }).click();
  await card.getByLabel('Motivo (opcional)').fill(reason);
  await card.getByRole('button', { name: 'Recusar', exact: true }).click();

  // O cartão some, a tool fica como recusada e o agente responde com o motivo recebido.
  await expect(card).toHaveCount(0);
  const answer = win.getByTestId('agent-message-assistant').filter({ hasText: 'Não deu certo:' });
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(answer).toContainText(reason);
  await expect(win.locator('[data-testid="agent-tool"][data-tool="create_entity"]')).toHaveAttribute('data-status', 'rejected');
  await expect(win.getByTestId('agent-composer')).toBeEnabled({ timeout: 30_000 });

  const entities: { name: string }[] = await (await page.request.get(`/api/entities?q=${encodeURIComponent(entityName)}`)).json();
  expect(entities.filter((e) => e.name === entityName)).toHaveLength(0);
  // O modelo recebeu a recusa (tool_result com erro) com o motivo.
  const sent = llm.calls.some(
    (c) =>
      c.path === '/v1/messages' &&
      JSON.stringify(c.body.messages?.at(-1) ?? {}).includes(reason) &&
      JSON.stringify(c.body.messages?.at(-1) ?? {}).includes('"is_error":true'),
  );
  expect(sent).toBe(true);
});

test('agente: o SSE cai no meio da resposta e reconecta com Last-Event-ID, sem duplicar nem perder', async ({ page }) => {
  await enter(page);
  const win = await newConversation(page);
  const conversationId = (await win.getAttribute('data-conversation-id'))!;

  // A 1ª conexão de eventos da execução é cortada no meio: a resposta chega só até a metade dos text_delta
  // e o stream fecha sem o "done". O console tem de reconectar pedindo o que veio depois do último id visto.
  let cutAfterId: string | null = null;
  await page.route(
    '**/api/runs/*/events',
    async (route) => {
      const response = await route.fetch({ timeout: 60_000 });
      const frames = (await response.text()).split('\n\n').filter((f) => f.trim());
      const deltas = frames.filter((f) => /^event: text_delta$/m.test(f));
      expect(deltas.length).toBeGreaterThan(4);
      const cut = frames.indexOf(deltas[Math.floor(deltas.length / 2)]!);
      const kept = frames.slice(0, cut + 1);
      cutAfterId = /^id: (\d+)$/m.exec(kept.at(-1)!)?.[1] ?? null;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `${kept.join('\n\n')}\n\n` });
    },
    { times: 1 },
  );
  const eventRequests: Request[] = [];
  page.on('request', (req) => {
    if (/\/api\/runs\/[^/]+\/events/.test(req.url())) eventRequests.push(req);
  });

  await say(win, 'reconectar o stream, por favor');
  const final = win.locator('[data-testid="agent-message-assistant"]:not([data-live])').filter({ hasText: 'Trecho 01' });
  await expect(final).toHaveCount(1, { timeout: 45_000 });
  await expect(win.getByTestId('agent-composer')).toBeEnabled({ timeout: 30_000 });

  // Reconectou continuando do último id entregue (não do zero).
  expect(cutAfterId).not.toBeNull();
  expect(eventRequests.length).toBeGreaterThanOrEqual(2);
  const headers = await eventRequests[1]!.allHeaders();
  expect(headers['last-event-id']).toBe(cutAfterId);

  // A mensagem final está inteira e uma vez só, e a tela bate com o histórico da API.
  const text = (await final.innerText()).replace(/\s+/g, ' ').trim();
  expect(text).toBe(LONG_REPLY);
  const detail = await (await page.request.get(`/api/conversations/${conversationId}`)).json();
  const assistant = detail.messages.filter(
    (m: { role: string; content: { type: string; text?: string }[] }) =>
      m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text?.trim()),
  );
  expect(assistant).toHaveLength(1);
  await expect(win.locator('[data-testid="agent-message-assistant"]:not([data-live])')).toHaveCount(assistant.length);
  await expect(win.locator('[data-testid="agent-message-assistant"][data-live]')).toHaveCount(0);
});

test('agente: o admin abre a conversa de outro usuário em modo somente leitura', async ({ page }) => {
  // Outro usuário (de teste) conversa e deixa uma escrita esperando confirmação.
  const other = { username: `e2e-agente-${tag}`, password: `senha-e2e-${tag}` };
  const user = await postJson(adminApi, '/api/users', {
    username: other.username,
    email: `${other.username}@e2e.local`,
    password: other.password,
    role: 'user',
  });
  // Editor de uma caixa: pode cadastrar entidades (a escrita fica esperando o "Aplicar?").
  const holder = await postJson(adminApi, '/api/entities', { kind: 'person', name: `E2E Outro titular ${tag}` });
  const caixa = await postJson(adminApi, '/api/caixas', { name: `E2E Outro caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  await postJson(adminApi, `/api/caixas/${caixa.id}/members`, { userId: user.id, role: 'editor' });
  const otherApi = await apiLogin(other.username, other.password);
  const entityName = `E2E Pedido do outro ${tag}`;
  let runId: string | null = null;
  try {
    const conversation = await postJson(otherApi, '/api/conversations', { agentId: agent.id });
    const sent = await postJson(otherApi, `/api/conversations/${conversation.id}/messages`, { text: `criar entidade ${entityName}` });
    runId = sent.run.id;
    await expect
      .poll(async () => (await (await otherApi.get(`/api/runs/${runId}`)).json()).status, { timeout: 30_000 })
      .toBe('awaiting_confirmation');

    await enter(page);
    await page.getByTestId('agents-button').click();
    const list = page.getByRole('dialog', { name: 'Conversas' });
    await list.getByRole('button', { name: 'Todos os usuários' }).click();
    const row = list.locator('.agents-row').filter({ hasText: `@${other.username}` });
    await expect(row).toHaveCount(1);
    // Sem as ações de dono (fixar, renomear, arquivar, excluir).
    await expect(row.getByRole('button', { name: 'Excluir' })).toHaveCount(0);
    await row.getByRole('button').first().click();

    const win = page.locator(`[data-testid="agent-window"][data-conversation-id="${conversation.id}"]`);
    await expect(win).toBeVisible();
    await expect(win).toContainText('Você está lendo a conversa de outro usuário (somente leitura).');
    await expect(win).toContainText(`criar entidade ${entityName}`);
    // Sem compositor e sem aprovar/recusar, mesmo com a confirmação pendente.
    await expect(win.getByTestId('agent-composer')).toHaveCount(0);
    await expect(win.getByTestId('agent-confirmation')).toHaveCount(0);
    await expect(win.getByTestId('agent-approve')).toHaveCount(0);
    await expect(win.getByRole('button', { name: 'Recusar' })).toHaveCount(0);
    await expect(win.locator('[data-testid="agent-tool"][data-tool="create_entity"]')).toHaveAttribute('data-status', 'awaiting');

    // A API também recusa a decisão do admin numa conversa que não é dele.
    const decide = await adminApi.post(`/api/runs/${runId}/confirmations`, { data: { decision: 'approved' } });
    expect(decide.ok()).toBe(false);
  } finally {
    if (runId) await otherApi.post(`/api/runs/${runId}/cancel`);
    await otherApi.dispose();
  }
});

test('fluxos: "Usar nos fluxos automáticos" no admin; sugestões da conciliação aprovadas e descartadas em lote', async ({ page }) => {
  await enter(page);

  // Marca o agente do e2e como o agente dos fluxos pela tela (tarefa 012).
  await page.goto('/admin/ai/agents');
  const agentRow = page.getByRole('row').filter({ hasText: agent.name });
  await agentRow.getByRole('button', { name: 'Editar' }).click();
  const form = page.getByRole('dialog', { name: 'Editar agente' });
  await form.getByLabel('Usar nos fluxos automáticos').check();
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form).toBeHidden();
  await expect(agentRow).toContainText('Fluxos');
  const agents: { id: string; useForFlows: boolean }[] = await (await page.request.get('/api/admin/ai/agents')).json();
  expect(agents.filter((a) => a.useForFlows).map((a) => a.id)).toEqual([agent.id]);

  // Caixa e conta novas: todas as linhas do OFX entram como novas e vão para o agente classificar.
  const api = page.request;
  const post = (url: string, data: unknown) => postJson(api, url, data);
  await post('/api/categories', { kind: 'expense', name: `E2E IA despesa ${tag}`, colorSlot: 4 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E IA Titular ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E IA Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Conta IA ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });

  await page.goto(`/caixas/${caixa.id}/reconciliation`);
  await page.getByRole('button', { name: 'Importar extrato' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Importar extrato' });
  await dialog.getByLabel('escolha um arquivo').setInputFiles(join(FIXTURES, 'extrato-ofx2.ofx'));
  await expect(dialog).toContainText('Resumo do OFX');
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(dialog).toBeHidden();

  // A tela acompanha a execução do agente e mostra as sugestões sem recarregar.
  const banner = page.locator('.notice').filter({ hasText: 'sugestão(ões) do agente' });
  await expect(banner).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('ai-suggesting')).toHaveCount(0);
  const imports: { id: string }[] = await (await api.get(`/api/statement-imports?accountId=${account.id}`)).json();
  expect(imports).toHaveLength(1);
  type Line = { id: string; description: string; classificationSource: string | null; categoryId: string | null };
  const lines = async (): Promise<Line[]> => (await (await api.get(`/api/statement-imports/${imports[0]!.id}`)).json()).lines;
  const suggested = (await lines()).filter((l) => l.classificationSource === 'agent');
  expect(suggested.length).toBeGreaterThanOrEqual(3);
  await expect(banner).toContainText(`${suggested.length} sugestão(ões) do agente`);
  const [a, b, c] = suggested as [Line, Line, Line];

  // Aprova duas em lote (seleção na tabela).
  await page.getByRole('checkbox', { name: `Selecionar ${a.description}` }).check();
  await page.getByRole('checkbox', { name: `Selecionar ${b.description}` }).check();
  await banner.getByRole('button', { name: 'Aprovar sugestões (2)' }).click();
  await expect(page.getByText('2 sugestão(ões) aprovada(s).')).toBeVisible();
  await expect(banner).toContainText(`${suggested.length - 2} sugestão(ões) do agente`);

  // Descarta uma.
  await page.getByRole('checkbox', { name: `Selecionar ${c.description}` }).check();
  await banner.getByRole('button', { name: 'Descartar (1)' }).click();
  await expect(page.getByText('1 sugestão(ões) descartada(s).')).toBeVisible();

  const after = new Map((await lines()).map((l) => [l.id, l]));
  expect(after.get(a.id)).toMatchObject({ classificationSource: 'user', categoryId: a.categoryId });
  expect(after.get(b.id)).toMatchObject({ classificationSource: 'user', categoryId: b.categoryId });
  expect(after.get(c.id)).toMatchObject({ classificationSource: null, categoryId: null });
  const rest = suggested.slice(3);
  for (const line of rest) expect(after.get(line.id)?.classificationSource).toBe('agent');
  if (rest.length > 0) await expect(banner).toContainText(`${rest.length} sugestão(ões) do agente`);
  else await expect(banner).toHaveCount(0);
});
