import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, type Request, request, test } from '@playwright/test';
import { defaultBrain, type FakeLlm, silentWav, startFakeLlm } from '../fakes/fake-llm';
import { ADMIN_STATE, baseURL, loginAsAdmin } from '../support/session';

/*
 * Fase 4 (agentes de IA) contra a API real, com o provedor FALSO:
 *  - conversar, aprovar uma escrita no cartão "Aplicar?", ancorar e minimizar;
 *  - as sessões (spec 026): conversar, finalizar, a próxima mensagem numa
 *    sessão nova, abrir a anterior em leitura e bifurcar; e as janelas salvas
 *    por conversa (versão anterior) convertidas em janelas por agente;
 *  - recusar uma escrita com motivo (o agente recebe e responde com ele);
 *  - reconexão do SSE no meio da resposta (Last-Event-ID, sem duplicar nem perder);
 *  - o admin lê a sessão de outro usuário em modo somente leitura;
 *  - "Usar nos fluxos automáticos" em /admin/ai e as sugestões da conciliação
 *    aprovadas e descartadas em lote na tela;
 *  - o kit de ferramentas (spec 021): criar marcando a categoria Conciliação,
 *    pôr uma escrita em ask, ligar ao agente e ver o cartão de aprovação;
 *  - as tools de controle total (spec 027): anexar um OFX na conversa, pedir
 *    "importe e concilie" e aprovar o import e o lote de lançamentos; o admin
 *    pede "crie um kit só de leitura" e vê o kit na tela; e o cartão de segredo
 *    (trocar a chave de um provedor falso digitando o valor no cartão);
 *  - o prompt do agente (spec 022): editar, ver o histórico e o diff, restaurar,
 *    as variáveis e o "Ver prompt montado"; e Minha conta → IA;
 *  - as requisições ao provedor (spec 023): um 429 seguido de 200 na conversa,
 *    o detalhe do provedor pelo nome na lista, a gaveta com as duas tentativas,
 *    o Editar do detalhe e a retenção (banco vence a variável; "Usar o padrão");
 *  - as capacidades (spec 024): cadastrar um provedor OpenAI-compatível falso
 *    com todas as flags, testar flag a flag e criar um agente que herda tudo
 *    pelo "Provedor padrão";
 *  - os orçamentos (spec 028): orçamento baixo de um usuário na guia Uso, o
 *    aviso no sino e a conversa recusada com o escopo no texto;
 *  - os fluxos autônomos (spec 029): tarefa criada em Minha conta, "Rodar
 *    agora" e a aprovação pelo sino; o OFX importado com "Conciliar com IA"
 *    e o lote de aprovações na tela do lote;
 *  - o chat multimídia (spec 025): anexar um áudio e ver a transcrição, tocar
 *    e trocar a velocidade para 2x, o modo áudio tocando uma resposta, as
 *    prévias de imagem (ampliar e navegar) e de PDF, o markdown bruto/renderizado
 *    e a gravação pelo microfone (o fake media stream do Chromium).
 *
 * O provedor falso (Anthropic Messages API) sobe aqui na porta E2E_LLM_PORT
 * (padrão 18082). O worker da pilha o alcança em E2E_LLM_BASE (padrão
 * http://host.docker.internal:18082, a pilha da raiz em Docker). Nada vai para
 * uma API de IA de verdade. O admin usa a sessão aberta no global-setup (o
 * /api/auth/login tem limite por minuto); só o outro usuário faz login aqui.
 */

// Microfone falso do Chromium (gravação da spec 025), já com a permissão concedida.
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});

const llmPort = Number(process.env.E2E_LLM_PORT ?? 18082);
const llmBase = process.env.E2E_LLM_BASE ?? `http://host.docker.internal:${llmPort}`;
const FIXTURES = join(import.meta.dirname, '../../apps/server/test/fixtures');

/** Resposta longa em vários pedaços, para derrubar o SSE no meio dela. */
const LONG_REPLY = Array.from({ length: 16 }, (_, i) => `Trecho ${String(i + 1).padStart(2, '0')} da resposta longa.`).join(' ');

let llm: FakeLlm;
let adminApi: APIRequestContext;
let provider: { id: string };
let agent: { id: string; name: string };
const extraAgents: string[] = [];
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

/**
 * Janela do agente do e2e (ou outro, pelo nome) numa sessão nova: finaliza a
 * ativa pela API, se houver, e abre o agente pelo ícone Agentes (spec 026).
 */
async function freshSession(page: Page, agentName = agent.name) {
  const threads: { agentId: string; agentName: string; active: { id: string } | null }[] = await (
    await page.request.get('/api/agents/threads')
  ).json();
  const thread = threads.find((th) => th.agentName === agentName);
  expect(thread, `agente ${agentName} na lista`).toBeTruthy();
  if (thread!.active) await postJson(page.request, `/api/conversations/${thread!.active.id}/finish`);
  await page.getByTestId('agents-button').click();
  const row = page.locator(`[data-testid="agents-thread"][data-agent-id="${thread!.agentId}"]`);
  await expect(row).toContainText('Sem sessão ativa');
  await row.getByTestId('agents-thread-open').click();
  const win = page.locator(`[data-testid="agent-window"][data-kind="agent"][data-agent-id="${thread!.agentId}"]`);
  await expect(win).toBeVisible();
  await expect(win.getByTestId('agent-session-title')).toHaveText('Nova sessão');
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
    // Conciliação com IA (spec 029): lê o lote e propõe ignorar as duas primeiras linhas novas (escritas em ask).
    if (/conciliar um lote de extrato/.test(view.system)) {
      const importId = /statementImportId ([0-9a-f-]{36})/.exec(view.lastText)?.[1];
      if (view.lastRole === 'user' && importId) return { toolCalls: [{ name: 'get_statement_import', input: { importId } }] };
      const read = view.lastToolResults[0]?.content ?? '';
      if (view.lastRole === 'tool' && read.includes('"lines"')) {
        const lines = (JSON.parse(read).lines as { id: string; status: string }[]).filter((l) => l.status === 'new').slice(0, 2);
        return { toolCalls: lines.map((l) => ({ name: 'ignore_statement_lines', input: { lineIds: [l.id] } })) };
      }
      return { text: 'Conciliação do lote concluída.' };
    }
    return defaultBrain(view);
  };
  adminApi = await request.newContext({ baseURL, storageState: ADMIN_STATE });
  provider = await postJson(adminApi, '/api/admin/ai/providers', {
    name: `E2E falso ${tag}`,
    kind: 'anthropic',
    baseUrl: llmBase,
    apiKey: 'sk-e2e-fake-key',
    // Anthropic compatível: o modelo de texto padrão é obrigatório; o cache, ligado à mão (spec 024).
    defaultModels: { text: 'claude-sonnet-5-5' },
    promptCacheEnabled: true,
  });
  // Kit com todas as tools no modo sugerido (escritas pedem aprovação): o cartão "Aplicar?" dos testes abaixo.
  const catalog: { name: string; suggestedMode: string }[] = await (await adminApi.get('/api/admin/ai/tools')).json();
  const kit = await postJson(adminApi, '/api/admin/ai/tool-kits', {
    name: `E2E Kit padrão ${tag}`,
    tools: catalog.map((tool) => ({ name: tool.name, mode: tool.suggestedMode })),
  });
  agent = await postJson(adminApi, '/api/admin/ai/agents', {
    name: `E2E Agente ${tag}`,
    description: 'Agente de teste do e2e',
    // Texto e visão no provedor falso (spec 024).
    defaultProviderId: provider.id,
    model: 'claude-sonnet-5-5',
    toolKitId: kit.id,
    isActive: true,
    colorSlot: 5,
  });
  // Limite por minuto (spec 028): o admin manda muitas mensagens neste arquivo; o valor do banco vence AI_RUNS_PER_MINUTE.
  const limit = await adminApi.put('/api/admin/settings/ai.runs_per_minute', { data: { value: 1000 } });
  expect(limit.ok(), await limit.text()).toBeTruthy();
});

test.afterAll(async () => {
  if (adminApi) {
    await adminApi.delete('/api/admin/settings/ai.runs_per_minute');
    if (agent) await adminApi.patch(`/api/admin/ai/agents/${agent.id}`, { data: { isActive: false } });
    for (const id of extraAgents) await adminApi.patch(`/api/admin/ai/agents/${id}`, { data: { isActive: false } });
    if (provider) await adminApi.patch(`/api/admin/ai/providers/${provider.id}`, { data: { isActive: false } });
    await adminApi.dispose();
  }
  await llm?.close();
});

test('agente: conversa, aprova uma escrita, ancora no painel direito e minimiza', async ({ page }) => {
  await enter(page);
  const win = await freshSession(page);

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

test('sessões: conversar, finalizar, a próxima mensagem numa sessão nova, abrir a anterior em leitura e bifurcar', async ({ page }) => {
  await enter(page);
  const win = await freshSession(page);
  const marker = `primeira sessão ${tag}`;

  // Conversar: a 1ª mensagem cria a sessão ativa; o id aparece no menu da janela.
  await say(win, `Olá, ${marker}`);
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(win).toHaveAttribute('data-conversation-id', /.+/);
  const firstId = (await win.getAttribute('data-conversation-id'))!;
  await expect(win.getByTestId('agent-composer')).toBeEnabled({ timeout: 30_000 });
  await win.getByRole('button', { name: 'Mais ações' }).click();
  await expect(page.getByTestId('agent-session-id')).toHaveText(firstId);
  await page.keyboard.press('Escape');

  // Finalizar (com confirmação): a janela volta ao fio vazio.
  await win.getByTestId('agent-finish').click();
  const confirm = page.getByRole('dialog', { name: 'Finalizar a sessão?' });
  await confirm.getByRole('button', { name: 'Finalizar sessão' }).click();
  await expect(win).toHaveAttribute('data-conversation-id', '');
  await expect(win.getByTestId('agent-session-title')).toHaveText('Nova sessão');
  await expect(win.getByTestId('agent-message-user')).toHaveCount(0);

  // A próxima mensagem entra numa sessão nova, sem o histórico da anterior.
  await say(win, 'segunda sessão, por favor');
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(win).not.toHaveAttribute('data-conversation-id', firstId);
  const secondId = (await win.getAttribute('data-conversation-id'))!;
  expect(secondId).toMatch(/.+/);
  await expect(win.getByText(marker)).toHaveCount(0);
  await expect(win.getByTestId('agent-composer')).toBeEnabled({ timeout: 30_000 });

  // Sessões anteriores: a finalizada abre numa janela de leitura.
  await win.getByTestId('agent-previous').click();
  const previous = page.getByRole('dialog', { name: `Sessões anteriores — ${agent.name}` });
  const item = previous.locator(`[data-testid="agent-previous-session"][data-conversation-id="${firstId}"]`);
  await expect(item).toBeVisible();
  await item.getByTestId('agent-previous-open').click();
  await expect(previous).toBeHidden();
  const reader = page.locator(`[data-testid="agent-window"][data-kind="session"][data-conversation-id="${firstId}"]`);
  await expect(reader).toBeVisible();
  await expect(reader.getByTestId('agent-finished-notice')).toBeVisible();
  await expect(reader).toContainText(marker);
  await expect(reader.getByTestId('agent-composer')).toHaveCount(0);

  // Bifurcar daqui: a cópia vira a sessão ativa na janela do agente e a ativa anterior é finalizada.
  await reader.getByTestId('agent-fork').click();
  await expect(reader).toHaveCount(0);
  await expect(win).not.toHaveAttribute('data-conversation-id', secondId);
  await expect(win).not.toHaveAttribute('data-conversation-id', firstId);
  await expect(win).toContainText(marker, { timeout: 15_000 });
  const forkId = (await win.getAttribute('data-conversation-id'))!;
  const second = await (await page.request.get(`/api/conversations/${secondId}`)).json();
  expect(second.conversation.archivedReason).toBe('forked');
  const forked = await (await page.request.get(`/api/conversations/${forkId}`)).json();
  expect(forked.conversation).toMatchObject({ archivedAt: null, forkedFromConversationId: firstId });

  // O menu mostra o agente com a sessão ativa e as anteriores.
  await page.getByTestId('agents-button').click();
  const row = page.locator(`[data-testid="agents-thread"][data-agent-id="${agent.id}"]`);
  await expect(row).not.toContainText('Sem sessão ativa');
  await row.getByTestId('agents-thread-previous').click();
  await expect(page.locator(`[data-testid="agent-previous-session"][data-conversation-id="${secondId}"]`)).toBeVisible();
});

test('sessões: janelas salvas por conversa (versão anterior) viram a janela do agente', async ({ page }) => {
  await enter(page);
  const session = await postJson(page.request, `/api/agents/${agent.id}/sessions`, {});
  await page.evaluate((id) => {
    const old = { id, title: 'Janela antiga', agentName: 'Agente', colorSlot: 5, x: 80, y: 80, w: 420, h: 560, z: 1, minimized: false };
    localStorage.setItem('moneyflow:agents-ui', JSON.stringify({ windows: [old], docked: id, panelWidth: 400, panelCollapsed: false }));
  }, session.id);
  await page.reload();
  // A conversa ancorada (a ativa do próprio usuário) vira o painel do agente.
  const panel = page.getByTestId('agent-side-panel');
  await expect(panel).toHaveAttribute('data-kind', 'agent');
  await expect(panel).toHaveAttribute('data-agent-id', agent.id);
  await expect(panel).toHaveAttribute('data-conversation-id', session.id);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('moneyflow:agents-ui') ?? '{}'));
  expect(stored).toMatchObject({ v: 2, docked: agent.id, windows: [{ id: agent.id, kind: 'agent', agentId: agent.id }] });
});

test('agente: recusar uma escrita com motivo; nada é gravado e o agente responde com o motivo', async ({ page }) => {
  await enter(page);
  const win = await freshSession(page);
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
  const win = await freshSession(page);

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
  const conversationId = (await win.getAttribute('data-conversation-id'))!;
  expect(conversationId).toMatch(/.+/);
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

test('agente: o admin abre a sessão de outro usuário em modo somente leitura', async ({ page }) => {
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
    const list = page.getByRole('dialog', { name: 'Agentes' });
    await list.getByRole('button', { name: 'Todos os usuários' }).click();
    // O fio do outro usuário com o agente: a sessão ativa em execução (esperando a confirmação).
    const row = list.locator('[data-testid="agents-thread"]').filter({ hasText: `@${other.username}` });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('agents-thread-running')).toContainText('Aguardando confirmação');
    // Sem as ações de dono (renomear, excluir).
    await expect(row.getByRole('button', { name: 'Excluir' })).toHaveCount(0);
    await row.getByTestId('agents-thread-open').click();

    const win = page.locator(`[data-testid="agent-window"][data-kind="session"][data-conversation-id="${conversation.id}"]`);
    await expect(win).toBeVisible();
    await expect(win).toContainText('Você está lendo a sessão de outro usuário (somente leitura).');
    // Sem finalizar nem bifurcar a sessão de outro.
    await expect(win.getByTestId('agent-finish')).toHaveCount(0);
    await expect(win.getByTestId('agent-fork')).toHaveCount(0);
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

test('kit de ferramentas: marcar a Conciliação, pôr uma escrita em ask, ligar ao agente e ver o cartão de aprovação', async ({ page }) => {
  await enter(page);
  const api = page.request;
  const post = (url: string, data: unknown) => postJson(api, url, data);

  // Agente próprio, ainda sem kit, e uma linha de extrato de verdade para o agente pedir para ignorar.
  const kitAgent = await post('/api/admin/ai/agents', {
    name: `E2E Agente do kit ${tag}`,
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    isActive: true,
    colorSlot: 3,
  });
  extraAgents.push(kitAgent.id);
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Kit Titular ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E Kit Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Conta kit ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });
  const upload = await api.post(`/api/statement-imports?accountId=${account.id}&fileName=kit.ofx`, {
    data: readFileSync(join(FIXTURES, 'extrato-ofx2.ofx')),
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const statement: { id: string; lines: { id: string; status: string }[] } = await upload.json();
  const line = statement.lines[0]!;

  // Cria o kit pela tela: a categoria inteira, todas em allow, e uma escrita em ask.
  const kitName = `E2E Kit conciliação ${tag}`;
  await page.goto('/admin/ai/tool-kits');
  await page.getByRole('button', { name: 'Novo kit' }).first().click();
  const form = page.getByRole('dialog', { name: 'Novo kit' });
  await form.getByLabel('Nome').fill(kitName);
  await form.getByRole('checkbox', { name: 'Incluir todas as tools de Conciliação' }).check();
  const category = form.getByTestId('kit-category-reconciliation');
  await expect(category).toContainText('18 de 18');
  await category.getByRole('button', { name: 'todas allow' }).click();
  const tool = form.getByTestId('kit-tool-ignore_statement_lines');
  await expect(tool.getByRole('radio', { name: 'allow' })).toHaveAttribute('aria-checked', 'true');
  await tool.getByRole('radio', { name: 'ask' }).click();
  await expect(tool.getByRole('radio', { name: 'ask' })).toHaveAttribute('aria-checked', 'true');
  // Uma tool de outra categoria fica de fora.
  await expect(form.getByTestId('kit-tool-list_caixas')).toContainText('não incluída');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form).toBeHidden();
  const kitRow = page.getByRole('row').filter({ hasText: kitName });
  await expect(kitRow).toContainText('4 leitura · 14 escrita');
  await expect(kitRow).toContainText('1 em ask');
  await expect(kitRow).toContainText('Nenhum agente');

  // Liga o kit ao agente pelo formulário.
  await page.goto('/admin/ai/agents');
  const agentRow = page.getByRole('row').filter({ hasText: kitAgent.name });
  await agentRow.getByRole('button', { name: 'Editar' }).click();
  const agentForm = page.getByRole('dialog', { name: 'Editar agente' });
  await agentForm.getByTestId('agent-tool-kit').selectOption({ label: kitName });
  await agentForm.getByRole('button', { name: 'Salvar' }).click();
  await expect(agentForm).toBeHidden();
  await expect(agentRow).toContainText(kitName);

  // Na conversa, a escrita em ask mostra o cartão; aprovar aplica.
  const win = await freshSession(page, kitAgent.name);
  const before = llm.calls.length;
  await say(win, `chamar ignore_statement_lines {"lineIds":["${line.id}"]}`);
  const card = win.getByTestId('agent-confirmation');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Ignorar linhas do extrato');
  const sent = llm.calls.slice(before).find((c) => c.path === '/v1/messages' && Array.isArray(c.body.tools) && c.body.tools.length > 0);
  const offered: string[] = sent!.body.tools.map((x: { name: string }) => x.name);
  expect(offered).toHaveLength(18);
  expect(offered).toContain('ignore_statement_lines');
  expect(offered).not.toContain('list_caixas');
  await card.getByTestId('agent-approve').first().click();
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Pronto:' })).toBeVisible({ timeout: 30_000 });
  const after: { lines: { id: string; status: string }[] } = await (await api.get(`/api/statement-imports/${statement.id}`)).json();
  expect(after.lines.find((l) => l.id === line.id)?.status).toBe('ignored');

  // O kit em uso mostra o agente na lista.
  await page.goto('/admin/ai/tool-kits');
  await expect(page.getByRole('row').filter({ hasText: kitName })).toContainText(kitAgent.name);
});

test('controle total (spec 027): anexar um OFX na conversa e pedir "importe e concilie"', async ({ page }) => {
  const api = adminApi;
  const holder = await postJson(api, '/api/entities', { kind: 'company', name: `E2E F13a Titular ${tag}` });
  const caixa = await postJson(api, '/api/caixas', { name: `E2E F13a Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await postJson(api, `/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Conta F13a ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });

  // Provedor falso roteirizado: importa o anexo (o id vem no rótulo do anexo), lança as linhas novas e responde.
  const previous = llm.brain;
  llm.brain = (view) => {
    if (view.lastRole === 'user' && /importe e concilie/i.test(view.lastText)) {
      const attachmentId = /attachmentId ([0-9a-f-]{36})/.exec(view.lastText)?.[1];
      return {
        text: 'Vou importar o extrato.',
        toolCalls: [{ name: 'import_statement', input: { attachmentId, accountId: account.id } }],
      };
    }
    if (view.lastRole === 'tool' && !view.lastToolResults[0]?.isError) {
      try {
        const result = JSON.parse(view.lastToolResults[0]!.content);
        if (Array.isArray(result.lines) && result.financialAccountId === account.id) {
          const items = result.lines
            .filter((l: { status: string }) => l.status === 'new')
            .map((l: { id: string }) => ({ lineId: l.id, mode: 'adjustment' }));
          return { text: `Conciliando ${items.length} linha(s).`, toolCalls: [{ name: 'create_from_statement_lines', input: { items } }] };
        }
        if (typeof result.created === 'number' && Array.isArray(result.failed)) {
          return { text: `Extrato importado e conciliado: ${result.created} linha(s) lançada(s).` };
        }
      } catch {
        // resultado que não é JSON: segue o cérebro padrão
      }
    }
    return previous(view);
  };
  try {
    await enter(page);
    const win = await freshSession(page);
    await win.locator('input[type="file"]').setInputFiles(join(FIXTURES, 'extrato-ofx2.ofx'));
    await expect(win.getByTestId('composer-attachment').filter({ hasText: 'extrato-ofx2.ofx' })).toBeVisible();
    await say(win, 'importe e concilie');

    // 1º cartão: a prévia do import (arquivo, conta e linhas novas).
    const card = win.getByTestId('agent-confirmation');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Importar extrato');
    await expect(card).toContainText('extrato-ofx2.ofx');
    await expect(card).toContainText(`Conta F13a ${tag}`);
    await card.getByTestId('agent-approve').first().click();

    // 2º cartão: o lote de lançamentos a partir das linhas.
    await expect(win.getByTestId('agent-confirmation').filter({ hasText: 'Lançar linhas do extrato' })).toBeVisible({ timeout: 30_000 });
    await win
      .getByTestId('agent-confirmation')
      .filter({ hasText: 'Lançar linhas do extrato' })
      .getByTestId('agent-approve')
      .first()
      .click();
    await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Extrato importado e conciliado' })).toBeVisible({
      timeout: 30_000,
    });

    // O extrato entrou na conta com todas as linhas conciliadas, pelo agente.
    const imports: { id: string }[] = await (await api.get(`/api/statement-imports?accountId=${account.id}`)).json();
    expect(imports).toHaveLength(1);
    const detail = await (await api.get(`/api/statement-imports/${imports[0]!.id}`)).json();
    expect(detail.lines.length).toBeGreaterThan(0);
    expect(detail.lines.every((l: { status: string }) => l.status === 'matched')).toBe(true);
    await page.goto(`/caixas/${caixa.id}/reconciliation`);
    await expect(page.getByText('extrato-ofx2.ofx').first()).toBeVisible();
  } finally {
    llm.brain = previous;
  }
});

test('controle total, lote F13b (spec 027): o admin pede "crie um kit só de leitura" e vê o kit na tela', async ({ page }) => {
  const kitName = `E2E Kit só leitura ${tag}`;
  // Provedor falso roteirizado: lista as tools de leitura e cria o kit com elas (allow).
  const previous = llm.brain;
  llm.brain = (view) => {
    if (view.lastRole === 'user' && /crie um kit só de leitura/i.test(view.lastText)) {
      return { text: 'Vou ver as tools de leitura.', toolCalls: [{ name: 'list_agent_tools', input: { kind: 'read' } }] };
    }
    if (view.lastRole === 'tool' && !view.lastToolResults[0]?.isError) {
      try {
        const result = JSON.parse(view.lastToolResults[0]!.content);
        if (Array.isArray(result) && result.length > 0 && result.every((x: { kind?: string }) => x.kind === 'read')) {
          const tools = result.map((x: { name: string }) => ({ name: x.name, mode: 'allow' }));
          return {
            text: `Criando o kit com ${tools.length} tools.`,
            toolCalls: [{ name: 'create_tool_kit', input: { name: kitName, tools } }],
          };
        }
        if (result?.name === kitName) return { text: `Kit "${kitName}" criado.` };
      } catch {
        // resultado que não é JSON: segue o cérebro padrão
      }
    }
    return previous(view);
  };
  try {
    await enter(page);
    const win = await freshSession(page);
    await expect(win).toContainText('Chaves e senhas: o agente vai pedir no cartão de aprovação.');
    await say(win, 'crie um kit só de leitura');
    const card = win.getByTestId('agent-confirmation');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Criar kit de ferramentas');
    await expect(card).toContainText(kitName);
    await card.getByTestId('agent-approve').first().click();
    await expect(win.getByTestId('agent-message-assistant').filter({ hasText: `Kit "${kitName}" criado.` })).toBeVisible({
      timeout: 30_000,
    });

    // O kit aparece na tela de kits, só com leituras.
    await page.goto('/admin/ai/tool-kits');
    await expect(page.getByText(kitName).first()).toBeVisible();
    const kits: { name: string; tools: { name: string; mode: string }[] }[] = await (await adminApi.get('/api/admin/ai/tool-kits')).json();
    const kit = kits.find((k) => k.name === kitName)!;
    const catalog: { name: string; kind: string }[] = await (await adminApi.get('/api/admin/ai/tools')).json();
    const kinds = new Map(catalog.map((x) => [x.name, x.kind]));
    expect(kit.tools.length).toBeGreaterThan(10);
    expect(kit.tools.every((x) => kinds.get(x.name) === 'read' && x.mode === 'allow')).toBe(true);
  } finally {
    llm.brain = previous;
  }
});

test('controle total, lote F13b (spec 027): trocar a chave de um provedor pelo cartão de segredo', async ({ page }) => {
  const target = await postJson(adminApi, '/api/admin/ai/providers', {
    name: `E2E Provedor da chave ${tag}`,
    kind: 'anthropic',
    baseUrl: llmBase,
    apiKey: 'sk-e2e-chave-antiga-0000',
    defaultModels: { text: 'claude-sonnet-5-5' },
    isActive: false,
  });
  const newKey = `sk-e2e-chave-nova-${tag}-9Z7Q`;
  await enter(page);
  const win = await freshSession(page);
  await say(win, `chamar update_ai_provider ${JSON.stringify({ providerId: target.id, changes: { notes: 'chave trocada pelo agente' } })}`);
  const card = win.getByTestId('agent-confirmation');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Editar provedor de IA');
  const secrets = card.getByTestId('agent-secrets');
  await expect(secrets).toContainText('Segredos (não vão ao agente)');
  await expect(secrets).toContainText('Vazio mantém a chave atual.');
  const input = secrets.getByLabel('Chave da API');
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(newKey);
  await card.getByTestId('agent-approve').first().click();
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Pronto:' })).toBeVisible({ timeout: 30_000 });
  // O modelo recebeu só "segredo definido"; o valor não está em lugar nenhum da conversa.
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'segredo definido' })).toBeVisible();
  await expect(win).not.toContainText(newKey);
  const providers: { id: string; apiKeyHint: string | null; notes: string | null }[] = await (
    await adminApi.get('/api/admin/ai/providers')
  ).json();
  expect(providers.find((p) => p.id === target.id)).toMatchObject({ apiKeyHint: '…9Z7Q', notes: 'chave trocada pelo agente' });
  const sent = JSON.stringify(llm.calls.map((c) => c.body));
  expect(sent).not.toContain(newKey);
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

test('tarefa agendada (spec 029): criar em Minha conta, "Rodar agora" e aprovar pelo sino', async ({ page }) => {
  await enter(page);
  const taskName = `E2E Tarefa ${tag}`;
  const entityName = `E2E Entidade da tarefa ${tag}`;
  await page.goto('/account');
  await page.getByTestId('task-new').click();
  const form = page.getByRole('dialog', { name: 'Nova tarefa' });
  await form.getByLabel('Nome').fill(taskName);
  await form.getByTestId('task-agent').selectOption({ label: agent.name });
  await form.getByTestId('task-instruction').fill(`criar entidade ${entityName}`);
  await form.getByTestId('task-kind').selectOption('weekly');
  await form.getByRole('checkbox', { name: 'Qua', exact: true }).check();
  await form.getByTestId('task-time').fill('07:45');
  await form.getByTestId('task-save').click();
  await expect(form).toBeHidden();
  const row = page.getByTestId('task-row').filter({ hasText: taskName });
  await expect(row).toContainText('toda segunda e quarta às 07:45');

  // "Rodar agora": a execução roda no worker e para esperando a aprovação da escrita (kit com ask).
  await row.getByRole('button', { name: `Rodar agora: ${taskName}` }).click();
  await expect(page.getByText('Tarefa disparada: acompanhe pelo histórico.')).toBeVisible();
  const title = `A tarefa ${taskName} espera sua aprovação`;
  await expect
    .poll(
      async () => {
        const list = await (await page.request.get('/api/notifications?limit=30')).json();
        return list.items.some((n: { kind: string; title: string }) => n.kind === 'ai_awaiting_approval' && n.title === title);
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
  await page.reload();
  await expect(row).toContainText('Esperando aprovação');

  // O sino leva à sessão da tarefa (somente leitura, com o cartão de aprovação).
  await page.getByRole('button', { name: /^Notificações/ }).click();
  await page
    .getByRole('dialog', { name: 'Notificações' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const win = page.locator('[data-testid="agent-window"]').filter({ hasText: taskName }).last();
  await expect(win.getByTestId('agent-flow-notice')).toBeVisible();
  await expect(win.getByTestId('agent-composer')).toHaveCount(0);
  await win.getByTestId('agent-approve').click();
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Pronto:' })).toBeVisible({ timeout: 30_000 });
  const entities = await (await page.request.get(`/api/entities?q=${encodeURIComponent(entityName)}`)).json();
  expect(JSON.stringify(entities)).toContain(entityName);

  // Histórico com o disparo concluído e a tarefa desligada no fim (o worker da pilha não a dispara de novo).
  await page.goto('/account');
  await row.getByRole('button', { name: `Histórico de disparos: ${taskName}` }).click();
  const history = page.getByTestId('task-history');
  await expect(history).toContainText('Manual');
  await expect(history).toContainText('Concluída');
  await page.keyboard.press('Escape');
  await row.getByRole('checkbox', { name: `Ativa: ${taskName}` }).click();
  await expect(page.getByText('Tarefa salva.')).toBeVisible();
  await expect(row.getByRole('checkbox', { name: `Ativa: ${taskName}` })).not.toBeChecked();
});

test('conciliação com IA (spec 029): importar o OFX, "Conciliar com IA" e aprovar o lote proposto', async ({ page }) => {
  await enter(page);
  // O agente do e2e atende os fluxos (o mesmo kit: as escritas pedem aprovação).
  const patched = await page.request.patch(`/api/admin/ai/agents/${agent.id}`, { data: { useForFlows: true } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const api = page.request;
  const holder = await postJson(api, '/api/entities', { kind: 'company', name: `E2E Conc IA Titular ${tag}` });
  const caixa = await postJson(api, '/api/caixas', { name: `E2E Conc IA ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await postJson(api, `/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Conta conc IA ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });

  await page.goto(`/caixas/${caixa.id}/reconciliation`);
  await page.getByRole('button', { name: 'Importar extrato' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Importar extrato' });
  await dialog.getByLabel('escolha um arquivo').setInputFiles(join(FIXTURES, 'extrato-ofx1.ofx'));
  await expect(dialog).toContainText('Resumo do OFX');
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(dialog).toBeHidden();

  // O painel da conciliação com IA: o interruptor (desligado) e o botão sob demanda.
  const panel = page.getByTestId('reconcile-ai');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('reconcile-auto')).not.toBeChecked();
  await expect(page.getByTestId('ai-suggesting')).toHaveCount(0, { timeout: 45_000 });
  await panel.getByTestId('reconcile-start').click();
  await expect(page.getByText('O agente começou a conciliar o lote.')).toBeVisible();

  // O agente propõe duas ações (ask): o lote de aprovações na tela.
  const batch = panel.getByTestId('reconcile-batch');
  await expect(batch).toContainText('O agente propõe 2 ação(ões)', { timeout: 45_000 });
  await batch.getByTestId('reconcile-approve-all').click();
  await expect(page.getByText('Decisão enviada ao agente.')).toBeVisible();
  await expect(batch).toHaveCount(0, { timeout: 30_000 });
  const imports: { id: string }[] = await (await api.get(`/api/statement-imports?accountId=${account.id}`)).json();
  await expect
    .poll(
      async () => {
        const detail = await (await api.get(`/api/statement-imports/${imports[0]!.id}`)).json();
        return detail.lines.filter((l: { status: string }) => l.status === 'ignored').length;
      },
      { timeout: 30_000 },
    )
    .toBe(2);
  const state = await (await api.get(`/api/statement-imports/${imports[0]!.id}/reconcile-ai`)).json();
  expect(state.run.status).toBe('completed');

  // Liga o interruptor da conta pela tela do lote.
  await panel.getByTestId('reconcile-auto').click();
  await expect(page.getByText('Conciliação com IA ao importar ligada.')).toBeVisible();
  await expect(panel.getByTestId('reconcile-auto')).toBeChecked();
  const accounts: { id: string; aiAutoReconcile: boolean }[] = await (await api.get(`/api/accounts?caixaId=${caixa.id}`)).json();
  expect(accounts.find((a) => a.id === account.id)?.aiAutoReconcile).toBe(true);
});

test('prompt: editar o prompt, ver o histórico e o diff, restaurar; variáveis e o prompt montado', async ({ page }) => {
  const promptAgent = await postJson(adminApi, '/api/admin/ai/agents', {
    name: `E2E Prompt ${tag}`,
    systemPrompt: 'Primeira linha do prompt.\nSegunda linha original.',
  });
  extraAgents.push(promptAgent.id);
  await enter(page);
  await page.goto('/admin/ai/agents');
  const row = page.getByRole('row').filter({ hasText: promptAgent.name });

  // Editar o prompt com uma nota: vira a versão 2.
  await row.getByRole('button', { name: 'Editar' }).click();
  let form = page.getByRole('dialog', { name: 'Editar agente' });
  await expect(form.getByTestId('prompt-version')).toHaveText('Versão 1');
  await form.getByLabel('System prompt').fill('Primeira linha do prompt.\nSegunda linha mudada no e2e.');
  await form.getByLabel('Nota da versão (opcional)').fill('Ajuste do e2e');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form).toBeHidden();

  // Histórico: as duas versões, o diff de A (1) para B (2).
  await row.getByRole('button', { name: 'Editar' }).click();
  form = page.getByRole('dialog', { name: 'Editar agente' });
  await expect(form.getByTestId('prompt-version')).toHaveText('Versão 2');
  await form.getByRole('button', { name: 'Histórico' }).click();
  const history = page.getByRole('dialog', { name: `Histórico do prompt — ${promptAgent.name}` });
  await expect(history.getByTestId('prompt-version-2')).toContainText('Ajuste do e2e');
  await expect(history.getByTestId('prompt-version-2')).toContainText('atual');
  await history.getByLabel('A: versão 1').check();
  await history.getByLabel('B: versão 2').check();
  const diff = history.getByTestId('prompt-diff');
  await expect(diff.locator('.diff-line.del')).toContainText('Segunda linha original.');
  await expect(diff.locator('.diff-line.add')).toContainText('Segunda linha mudada no e2e.');
  await expect(history).toContainText('Diff da versão 1 para a 2');

  // Restaurar a versão 1: cria a versão 3 com a nota, e o formulário volta com o prompt antigo.
  await history.getByTestId('prompt-version-1').getByRole('button', { name: 'Restaurar' }).click();
  const confirm = page.getByRole('dialog', { name: 'Restaurar a versão 1?' });
  await confirm.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByText('Versão 1 restaurada como uma versão nova.')).toBeVisible();
  await expect(history.getByTestId('prompt-version-3')).toContainText('Restaurada da versão 1');
  await expect(history.getByTestId('prompt-version-3')).toContainText('atual');
  await history.getByTestId('prompt-version-3').getByRole('button').first().click();
  await expect(history.getByTestId('prompt-version-content')).toHaveText('Primeira linha do prompt.\nSegunda linha original.');
  await history.getByRole('button', { name: 'Voltar' }).click();
  form = page.getByRole('dialog', { name: 'Editar agente' });
  await expect(form.getByTestId('prompt-version')).toHaveText('Versão 3');
  await expect(form.getByLabel('System prompt')).toHaveValue('Primeira linha do prompt.\nSegunda linha original.');

  // Variável volátil inserida pela lista: a tela avisa que o prompt não será cacheado.
  await expect(form.getByTestId('prompt-volatile-warning')).toHaveCount(0);
  await form.getByTestId('prompt-variables').getByRole('button', { name: '{{data}}' }).click();
  await expect(form.getByLabel('System prompt')).toHaveValue(/\{\{data\}\}/);
  await expect(form.getByTestId('prompt-volatile-warning')).toContainText('não será cacheado');

  // Ver prompt montado (da versão salva), com os dois pontos de cache, sem chamar o modelo.
  await form.getByRole('button', { name: 'Ver prompt montado' }).click();
  const preview = page.getByRole('dialog', { name: `Prompt montado — ${promptAgent.name}` });
  await preview.getByLabel('Montar para o usuário').selectOption({ index: 1 });
  await expect(preview.getByTestId('prompt-preview')).toContainText('Segunda linha original.');
  await expect(preview.getByTestId('prompt-cache-mark')).toHaveCount(2);
  await preview.getByRole('button', { name: 'Voltar' }).click();
  await page.getByRole('dialog', { name: 'Editar agente' }).getByRole('button', { name: 'Cancelar' }).click();
  const versions = await (await adminApi.get(`/api/admin/ai/agents/${promptAgent.id}/prompt-versions`)).json();
  expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
});

test('Minha conta → IA: as instruções do usuário ficam salvas', async ({ page }) => {
  await enter(page);
  await page.goto('/account');
  const panel = page.getByTestId('account-ai');
  await panel.getByLabel('Minhas instruções').fill(`Instruções do e2e ${tag}`);
  await panel.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Configurações de IA salvas.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('account-ai').getByLabel('Minhas instruções')).toHaveValue(`Instruções do e2e ${tag}`);
  const res = await adminApi.put('/api/account/ai', { data: { instructions: '' } });
  expect(res.ok()).toBeTruthy();
});

test('orçamentos (spec 028): orçamento baixo, aviso no sino e bloqueio na conversa', async ({ page, browser }) => {
  // Um usuário comum (o admin que aciona fica isento do bloqueio) e um preço para o modelo do provedor falso.
  const other = { username: `e2e-orcamento-${tag}`, password: `senha-e2e-${tag}` };
  await postJson(adminApi, '/api/users', {
    username: other.username,
    email: `${other.username}@e2e.local`,
    password: other.password,
    role: 'user',
  });
  await postJson(adminApi, '/api/admin/ai/prices', {
    providerId: provider.id,
    model: 'claude-sonnet-5-5',
    inputPricePerMillion: 100,
    outputPricePerMillion: 100,
  });
  const otherApi = await apiLogin(other.username, other.password);
  const userContext = await browser.newContext({ storageState: await otherApi.storageState() });
  const userPage = await userContext.newPage();
  let budgetId: string | null = null;
  try {
    // O admin cria o orçamento baixo do usuário na guia Uso.
    await enter(page);
    await page.goto('/admin/ai/usage');
    await expect(page.getByTestId('usage-tiles')).toBeVisible();
    await page.getByTestId('budget-new').click();
    const form = page.getByTestId('budget-form');
    await form.getByTestId('budget-scope').selectOption('user');
    await form.getByTestId('budget-user').selectOption({ label: `@${other.username}` });
    await form.getByTestId('budget-limit').fill('0,01');
    await form.getByTestId('budget-alert').fill('50');
    await form.getByTestId('budget-save').click();
    await expect(page.getByText('Orçamento salvo.')).toBeVisible();
    const row = page.getByTestId('budget-row').filter({ hasText: `usuário @${other.username}` });
    await expect(row).toContainText('Dentro');
    budgetId = await row.getAttribute('data-budget');

    // O usuário conversa: a 1ª resposta custa mais que o orçamento (o bloqueio vale para a próxima execução).
    await userPage.goto('/');
    const win = await freshSession(userPage);
    await say(win, `olá do orçamento ${tag}`);
    await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
      timeout: 30_000,
    });

    // O worker gera o aviso (dedup por orçamento, mês e limiar) no sino do usuário e no dos admins.
    const title = `Orçamento de IA atingido: usuário @${other.username}`;
    await expect
      .poll(
        async () => {
          const list = await (await otherApi.get('/api/notifications?limit=30')).json();
          return list.items.filter((n: { kind: string }) => n.kind === 'ai_budget_alert').map((n: { title: string }) => n.title);
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toEqual([title]);
    await userPage.getByRole('button', { name: /^Notificações/ }).click();
    const bell = userPage.getByRole('dialog', { name: 'Notificações' });
    await expect(bell).toContainText(title);
    await expect(bell).toContainText('Novas execuções estão bloqueadas');
    await userPage.getByRole('button', { name: /^Notificações/ }).click();
    await expect(bell).toHaveCount(0);

    // A próxima mensagem é recusada (429) com o escopo no texto.
    await say(win, 'mais uma pergunta');
    await expect(userPage.getByText(`Orçamento de IA do mês atingido: usuário @${other.username}`)).toBeVisible();

    // Minha conta → IA mostra o uso do mês e o orçamento bloqueado.
    await userPage.goto('/account');
    await expect(userPage.getByTestId('account-budget')).toContainText(`usuário @${other.username}`);
    await expect(userPage.getByTestId('account-budget').getByTestId('budget-meter')).toHaveAttribute('data-status', 'blocked');

    // No painel do admin, a barra marca o bloqueio.
    await page.reload();
    await expect(
      page
        .getByTestId('budget-row')
        .filter({ hasText: `usuário @${other.username}` })
        .getByTestId('budget-meter'),
    ).toHaveAttribute('data-status', 'blocked');
  } finally {
    if (budgetId) await adminApi.delete(`/api/admin/ai/budgets/${budgetId}`);
    await userContext.close();
    await otherApi.dispose();
  }
});

test('requisições: detalhe do provedor, a requisição da conversa com as tentativas e a retenção (spec 023)', async ({ page }) => {
  await enter(page);
  // O provedor responde 429 na primeira tentativa: o MoneyFlow espera o retry-after e tenta de novo.
  llm.queue.push({ status: 429, headers: { 'retry-after-ms': '50', 'anthropic-ratelimit-requests-remaining': '0' } });
  const win = await freshSession(page);
  await say(win, `requisições do e2e ${tag}`);
  await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
    timeout: 30_000,
  });
  const conversationId = await win.getAttribute('data-conversation-id');
  const page1 = await (await adminApi.get(`/api/admin/ai/requests?providerId=${provider.id}&operation=chat&limit=50`)).json();
  const request = page1.items.find((r: { conversationId: string }) => r.conversationId === conversationId);
  expect(request).toMatchObject({ status: 'ok', attempts: 2 });

  // Lista de provedores → o nome abre o detalhe.
  await page.goto('/admin/ai');
  await page
    .getByTestId('provider-detail-link')
    .filter({ hasText: `E2E falso ${tag}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/ai/providers/${provider.id}$`));
  await expect(page.getByRole('heading', { name: `E2E falso ${tag}` })).toBeVisible();
  await expect(page.getByTestId('provider-header')).toContainText('não registrados');
  await expect(page.getByTestId('provider-usage')).toBeVisible();
  await expect(page.getByTestId('provider-health')).toContainText('claude-sonnet-5-5');

  // A requisição da conversa, com as duas tentativas (429 e 200).
  await page.locator(`[data-request-id="${request.id}"]`).click();
  const drawer = page.getByTestId('request-drawer');
  await expect(drawer).toBeVisible();
  const attempts = drawer.getByTestId('request-attempt');
  await expect(attempts).toHaveCount(2);
  await expect(attempts.first()).toContainText('429');
  await expect(attempts.first()).toContainText('rate_limit');
  await expect(attempts.nth(1)).toContainText('200');
  await expect(drawer).toContainText('Corpos não registrados');
  await drawer.getByRole('button', { name: 'Fechar' }).click();

  // O botão Editar abre o mesmo modal da lista.
  await page.getByTestId('provider-edit').click();
  await expect(page.getByRole('dialog', { name: 'Editar provedor' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Editar provedor' }).getByRole('button', { name: 'Cancelar' }).click();

  // Guia Requisições: a retenção salva no banco vence a variável; "Usar o padrão" volta para ela.
  await page.goto('/admin/ai/requests');
  await expect(page.getByTestId('request-row').first()).toBeVisible();
  const source = page.getByTestId('retention-source');
  await expect(source).toHaveAttribute('data-source', 'env');
  await page.getByTestId('retention-input').fill('45');
  await page.getByTestId('retention-save').click();
  await expect(source).toHaveAttribute('data-source', 'database');
  await page.reload();
  await expect(page.getByTestId('retention-input')).toHaveValue('45');
  await page.getByTestId('retention-default').click();
  await expect(page.getByTestId('retention-source')).toHaveAttribute('data-source', 'env');
  const setting = await (await adminApi.get('/api/admin/settings/ai.request_retention_days')).json();
  expect(setting).toMatchObject({ source: 'env', value: 30 });
});

test('capacidades: provedor OpenAI-compatível falso com todas as flags e um agente que herda tudo (spec 024)', async ({ page }) => {
  await enter(page);
  const name = `E2E OpenAI falso ${tag}`;
  await page.goto('/admin/ai');
  await page.getByRole('button', { name: 'Novo provedor' }).first().click();
  const form = page.getByRole('dialog', { name: 'Novo provedor' });
  await form.getByLabel('Nome').fill(name);
  await form.getByTestId('provider-kind').selectOption('openai');
  await form.getByLabel('URL base').fill(`${llmBase}/v1`);
  await form.getByLabel('Chave da API').fill('sk-e2e-openai-fake');
  // O tipo OpenAI vem com todas as flags marcadas e as sugestões de modelo.
  for (const capability of ['text', 'vision', 'embeddings', 'transcription', 'speech']) {
    await expect(form.getByTestId(`provider-cap-${capability}`)).toBeChecked();
  }
  await expect(form.getByTestId('provider-model-embeddings')).toHaveValue('text-embedding-3-small');
  await expect(form.getByTestId('provider-voice')).toHaveValue('alloy');
  await form.getByTestId('provider-model-text').fill('fake-gpt');
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form).toBeHidden();

  // Testar conexão: uma linha por flag, todas ok.
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row.locator('[data-capability]')).toHaveCount(5);
  await row.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(row.getByTestId('provider-test-result')).toContainText('Conexão funcionando', { timeout: 30_000 });
  const checks = row.getByTestId('provider-test-checks').locator('[data-capability]');
  await expect(checks).toHaveCount(5);
  await expect(row.getByTestId('provider-test-checks').locator('[data-ok="false"]')).toHaveCount(0);
  const providers: { id: string; name: string }[] = await (await adminApi.get('/api/admin/ai/providers')).json();
  const created = providers.find((x) => x.name === name)!;

  // Agente: o provedor padrão preenche o texto, o modelo e as quatro inferências.
  const agentName = `E2E Agente herda tudo ${tag}`;
  await page.goto('/admin/ai/agents');
  await page.getByRole('button', { name: 'Novo agente' }).first().click();
  const agentForm = page.getByRole('dialog', { name: 'Novo agente' });
  await agentForm.getByLabel('Nome', { exact: true }).fill(agentName);
  await agentForm.getByTestId('agent-default-provider').selectOption({ label: name });
  await expect(agentForm.getByTestId('agent-text-provider')).toHaveValue(created.id);
  await expect(agentForm.getByTestId('agent-model')).toHaveValue('fake-gpt');
  for (const capability of ['vision', 'embeddings', 'transcription', 'speech']) {
    await expect(agentForm.getByTestId(`agent-inference-${capability}`)).toHaveValue(created.id);
  }
  await agentForm.getByRole('button', { name: 'Salvar' }).click();
  await expect(agentForm).toBeHidden();
  const agentRow = page.getByRole('row').filter({ hasText: agentName });
  await expect(agentRow.getByTestId('agent-capabilities').locator('[data-capability]')).toHaveCount(5);
  const agents: { id: string; name: string; inferences: { capability: string; providerId: string; model: string | null }[] }[] = await (
    await adminApi.get('/api/admin/ai/agents')
  ).json();
  const saved = agents.find((a) => a.name === agentName)!;
  extraAgents.push(saved.id);
  expect(saved.inferences.map((i) => [i.capability, i.providerId, i.model])).toEqual([
    ['vision', created.id, null],
    ['embeddings', created.id, null],
    ['transcription', created.id, null],
    ['speech', created.id, null],
  ]);

  // Detalhe do provedor: as capacidades no cabeçalho.
  await page.goto(`/admin/ai/providers/${created.id}`);
  await expect(page.getByTestId('provider-detail-capabilities').locator(':scope > [data-capability]')).toHaveCount(5);
  await expect(page.getByTestId('provider-embedding-indexes')).toBeVisible();
  await adminApi.patch(`/api/admin/ai/agents/${saved.id}`, { data: { isActive: false } });
  await adminApi.patch(`/api/admin/ai/providers/${created.id}`, { data: { isActive: false } });
});

/* ---------------- chat multimídia (spec 025) ---------------- */

/** PDF mínimo de uma página com texto. */
function minimalPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** PNG 1×1 de uma cor (anexo de imagem). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('chat multimídia (spec 025)', () => {
  let mediaProvider: { id: string };
  let mediaAgent: { id: string; name: string };

  test.beforeAll(async () => {
    // OpenAI compatível falso com todas as flags: áudio→texto (transcrição) e texto→áudio (fala).
    mediaProvider = await postJson(adminApi, '/api/admin/ai/providers', {
      name: `E2E mídia ${tag}`,
      kind: 'openai',
      baseUrl: `${llmBase}/v1`,
      apiKey: 'sk-e2e-media-fake',
      defaultModels: { text: 'fake-gpt', transcription: 'fake-whisper', speech: 'fake-tts', speech_voice: 'alloy' },
    });
    mediaAgent = await postJson(adminApi, '/api/admin/ai/agents', {
      name: `E2E Agente mídia ${tag}`,
      defaultProviderId: mediaProvider.id,
      model: 'fake-gpt',
      isActive: true,
      colorSlot: 6,
    });
    extraAgents.push(mediaAgent.id);
  });

  test.afterAll(async () => {
    if (mediaProvider) await adminApi.patch(`/api/admin/ai/providers/${mediaProvider.id}`, { data: { isActive: false } });
  });

  test.beforeEach(() => {
    llm.audioQueue = [];
    llm.speechFormat = 'wav';
  });

  test('áudio: anexar, ver a transcrição, tocar em 2x e o modo áudio tocando uma resposta', async ({ page }) => {
    await enter(page);
    const win = await freshSession(page, mediaAgent.name);
    // Sem o modo áudio ligado, nenhuma mensagem tem play.
    await expect(win.getByTestId('agent-audio-mode')).toHaveAttribute('aria-pressed', 'false');

    llm.audioQueue.push({ text: 'Lembrete: pagar a conta de luz na sexta.', delayMs: 1500 });
    await win.locator('input[type="file"]').setInputFiles({ name: 'recado.wav', mimeType: 'audio/wav', buffer: silentWav(6000) });
    const chip = win.getByTestId('composer-attachment').filter({ hasText: 'recado.wav' });
    await expect(chip).toBeVisible();
    // O compositor mostra "Transcrevendo…" e deixa enviar mesmo assim.
    await expect(chip.getByTestId('transcription-status')).toHaveAttribute('data-status', /pending|running|done/);
    await say(win, 'ouça o recado');

    const audio = win.getByTestId('audio-attachment');
    await expect(audio).toBeVisible();
    await expect(audio.getByTestId('transcription')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(audio.getByTestId('transcription')).toContainText('Lembrete: pagar a conta de luz na sexta.');
    await expect(audio.getByTestId('audio-time')).toContainText('0:06');
    // O modelo recebeu a transcrição, nunca o áudio.
    await expect(win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' })).toBeVisible({
      timeout: 30_000,
    });
    const chat = llm.calls.find((c) => c.path === '/v1/chat/completions' && JSON.stringify(c.body).includes('ouça o recado'))!;
    expect(JSON.stringify(chat.body.messages)).toContain('— transcrição]: Lembrete: pagar a conta de luz na sexta.');

    // Tocar e trocar a velocidade para 2x (lembrada no navegador).
    const player = audio.getByTestId('audio-player');
    await player.getByTestId('audio-toggle').click();
    await expect(player).toHaveAttribute('data-playing', 'true');
    await player.getByTestId('audio-rate').selectOption('2');
    await expect(player).toHaveAttribute('data-rate', '2');
    expect(await player.locator('audio').evaluate((el) => (el as unknown as { playbackRate: number }).playbackRate)).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem('moneyflow:audio-rate'))).toBe('2');
    await player.getByTestId('audio-toggle').click();
    await expect(player).toHaveAttribute('data-playing', 'false');

    // Modo áudio: o fone liga; cada mensagem de texto ganha o play; clicar gera e toca a fala (uma vez).
    await win.getByTestId('agent-audio-mode').click();
    await expect(win.getByTestId('agent-audio-mode')).toHaveAttribute('aria-pressed', 'true');
    const answer = win.getByTestId('agent-message-assistant').filter({ hasText: 'Olá! Sou o agente de teste.' }).last();
    const speechCalls = () => llm.calls.filter((c) => c.path === '/v1/audio/speech').length;
    const before = speechCalls();
    await answer.getByTestId('agent-listen').click();
    const speech = answer.getByTestId('speech-player');
    await expect(speech).toBeVisible({ timeout: 30_000 });
    await expect(speech).toHaveAttribute('data-playing', 'true');
    // A velocidade lembrada vale para o próximo áudio.
    await expect(speech).toHaveAttribute('data-rate', '2');
    expect(speechCalls()).toBe(before + 1);
    expect(llm.calls.filter((c) => c.path === '/v1/audio/speech').at(-1)!.body).toMatchObject({ input: 'Olá! Sou o agente de teste.' });
    // Tocar um pausa o outro.
    await player.getByTestId('audio-toggle').click();
    await expect(player).toHaveAttribute('data-playing', 'true');
    await expect(speech).toHaveAttribute('data-playing', 'false');
    await player.getByTestId('audio-toggle').click();
  });

  test('prévias: imagem ampliada com navegação, PDF no visualizador e markdown bruto/renderizado', async ({ page }) => {
    await enter(page);
    const win = await freshSession(page, mediaAgent.name);
    const input = win.locator('input[type="file"]');
    await input.setInputFiles([
      { name: 'foto-1.png', mimeType: 'image/png', buffer: PNG },
      { name: 'foto-2.png', mimeType: 'image/png', buffer: PNG },
    ]);
    await input.setInputFiles({
      name: 'contrato.pdf',
      mimeType: 'application/pdf',
      buffer: minimalPdf(['Contrato de teste', 'Clausula 1']),
    });
    await input.setInputFiles({
      name: 'notas.md',
      mimeType: '',
      buffer: Buffer.from('# Notas da reunião\n\n- item **um**\n- item dois\n', 'utf8'),
    });
    await expect(win.getByTestId('composer-attachment')).toHaveCount(4);
    await say(win, 'veja os anexos');
    await expect(win.getByTestId('agent-message-assistant').last()).toBeVisible({ timeout: 30_000 });

    // Imagem: miniatura → ampliada, navegação entre as imagens da conversa e "baixar".
    const thumbs = win.getByTestId('image-thumb');
    await expect(thumbs).toHaveCount(2);
    await thumbs.first().click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText('1 de 2');
    // Os uploads correm em paralelo: a ordem das duas imagens pode variar.
    const first = (await lightbox.getByTestId('lightbox-image').getAttribute('alt')) ?? '';
    expect(['foto-1.png', 'foto-2.png']).toContain(first);
    await lightbox.getByRole('button', { name: 'Próxima' }).click();
    await expect(lightbox).toContainText('2 de 2');
    await expect(lightbox.getByTestId('lightbox-image')).not.toHaveAttribute('alt', first);
    await page.keyboard.press('ArrowRight');
    await expect(lightbox).toContainText('1 de 2');
    await expect(lightbox.getByTestId('lightbox-download')).toHaveAttribute('href', /\/api\/attachments\/.+\/download$/);
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);

    // PDF: cartão com as páginas; abre no visualizador pdf.js.
    const pdf = win.getByTestId('pdf-card');
    await expect(pdf).toContainText('contrato.pdf');
    await expect(pdf).toContainText('1 página');
    await pdf.click();
    const viewer = page.getByTestId('pdf-dialog');
    await expect(viewer.locator('.pdf-viewer')).toBeVisible();
    await expect(viewer).toContainText('Página 1 de 1', { timeout: 15_000 });
    await viewer.getByRole('button', { name: 'Fechar' }).click();
    await expect(viewer).toHaveCount(0);

    // Markdown: início do texto no cartão; renderizado e bruto no diálogo.
    const md = win.getByTestId('markdown-card');
    await expect(md).toContainText('Notas da reunião');
    await md.click();
    const doc = page.getByTestId('markdown-dialog');
    await expect(doc.getByTestId('markdown-document')).toHaveAttribute('data-mode', 'rendered');
    await expect(doc.locator('.agent-md h1')).toHaveText('Notas da reunião');
    await doc.getByRole('tab', { name: 'Bruto' }).click();
    await expect(doc.getByTestId('markdown-document')).toHaveAttribute('data-mode', 'raw');
    await expect(doc.locator('pre')).toContainText('# Notas da reunião');
    await expect(doc.locator('pre')).toContainText('- item **um**');
    await doc.getByRole('tab', { name: 'Renderizado' }).click();
    await expect(doc.locator('.agent-md strong')).toHaveText('um');
    await page.keyboard.press('Escape');
    await expect(doc).toHaveCount(0);
  });

  test('gravação pelo microfone (fake media stream): ouvir, descartar, regravar e anexar com transcrição', async ({ page }) => {
    await enter(page);
    const win = await freshSession(page, mediaAgent.name);
    llm.audioQueue.push({ text: 'Mensagem gravada pelo microfone.' });

    await win.getByTestId('agent-record').click();
    await expect(win.getByTestId('agent-recording')).toBeVisible();
    await expect(win.getByTestId('agent-recording')).toContainText('/ 10:00');
    await page.waitForTimeout(1200);
    await win.getByTestId('agent-record-stop').click();
    const review = win.getByTestId('agent-record-review');
    await expect(review).toBeVisible();
    await expect(review.getByTestId('agent-record-player')).toBeVisible();
    // Descartar volta ao início; gravar de novo e anexar.
    await review.getByTestId('agent-record-discard').click();
    await expect(review).toHaveCount(0);
    await win.getByTestId('agent-record').click();
    await expect(win.getByTestId('agent-recording')).toBeVisible();
    await page.waitForTimeout(1200);
    await win.getByTestId('agent-record-stop').click();
    await win.getByTestId('agent-record-use').click();
    const chip = win.getByTestId('composer-attachment').filter({ hasText: 'gravacao-' });
    await expect(chip).toBeVisible();
    await say(win, 'transcreva a gravação');
    const audio = win.getByTestId('audio-attachment');
    await expect(audio.getByTestId('transcription')).toContainText('Mensagem gravada pelo microfone.', { timeout: 30_000 });
    await expect(audio.getByTestId('audio-time')).toContainText(/ 0:0[1-2]/);
  });
});
