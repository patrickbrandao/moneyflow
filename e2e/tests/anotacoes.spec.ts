import { expect, type Page, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Anotações e lembretes (F21, spec 035).
 *
 * 1. O alarme: dois lembretes "uma vez" no próximo minuto (fuso de São Paulo),
 *    criados pela API; o worker os dispara (MESSAGE_INTERVAL_MS) e a sondagem
 *    do ícone os acha. O play() do <audio> é trocado por um dublê: primeiro
 *    recusa (autoplay bloqueado → "Clique para ativar o som do alarme"), o
 *    clique seguinte libera e toca o som do manifest; depois adiar, dispensar
 *    e "Marcar todos como lidos" zeram o contador e param o som.
 * 2. O calendário anual e mensal com as bolinhas, o dia clicado filtrando a
 *    tabela, os chips de tipo, a janela com o lembrete mensal, a aba
 *    Anotações da entidade e o selo na listagem de entidades.
 */

const TZ = 'America/Sao_Paulo';

/** Data (AAAA-MM-DD) e horário (HH:MM) de um instante, em São Paulo. */
function spParts(at: Date) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  return { date, time };
}

/** O próximo minuto cheio com folga de 5 s (o lembrete dispara em até ~65 s). */
function nextMinute() {
  const now = Date.now();
  let at = Math.ceil(now / 60_000) * 60_000;
  if (at - now < 5_000) at += 60_000;
  return spParts(new Date(at));
}

async function createEntity(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/entities', { data: { kind: 'company', name } });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function createNote(page: Page, data: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/notes', { data: { objectType: 'entity', ...data } });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Dublê do play(): recusa enquanto window.__allowPlay for falso e registra o que tocou. */
async function stubAudio(page: Page) {
  await page.addInitScript(() => {
    // roda no navegador; o tsconfig do e2e não carrega a lib DOM
    type Media = { src: string };
    const w = globalThis as unknown as {
      __allowPlay: boolean;
      __plays: string[];
      HTMLMediaElement: { prototype: { play: (this: Media) => Promise<void>; pause: () => void } };
    };
    w.__allowPlay = false;
    w.__plays = [];
    w.HTMLMediaElement.prototype.play = function play(this: Media) {
      if (!w.__allowPlay) return Promise.reject(new DOMException('bloqueado', 'NotAllowedError'));
      w.__plays.push(this.src);
      return Promise.resolve();
    };
    w.HTMLMediaElement.prototype.pause = () => {};
  });
}

test('alarme: dispara, autoplay bloqueado e liberado, adiar, dispensar e marcar todos', async ({ page }) => {
  test.setTimeout(240_000);
  await stubAudio(page);
  await loginAsAdmin(page);
  // Começa sem disparos não lidos de execuções anteriores.
  await page.request.post('/api/note-reminders/firings/read-all', { data: {} });

  const suffix = Date.now().toString(36);
  const entityId = await createEntity(page, `E2E Lembrete ${suffix}`);
  const { date, time } = nextMinute();
  const snoozeTitle = `E2E adiar ${suffix}`;
  const dismissTitle = `E2E dispensar ${suffix}`;
  for (const title of [snoozeTitle, dismissTitle]) {
    await createNote(page, {
      kind: 'reminder',
      title,
      objectId: entityId,
      noteDate: date,
      reminder: { timeOfDay: time, repeat: 'once', sound: 'chime', ringSeconds: 120 },
    });
  }

  await page.goto('/notes');
  const alarm = page.getByTestId('reminder-alarm');
  await expect(alarm).toHaveAccessibleName('Lembretes: nenhum não lido');

  // O worker dispara; a sondagem acha os dois e tenta tocar: o navegador recusa.
  await expect(alarm).toHaveAccessibleName('Clique para ativar o som do alarme', { timeout: 150_000 });
  await expect(alarm).toHaveClass(/blocked/);
  await expect(page.getByRole('status').filter({ hasText: 'Clique para ativar o som do alarme' })).toBeVisible();
  const popover = page.getByRole('dialog', { name: 'Lembretes' });
  await expect(popover).toBeVisible();
  await expect(popover.locator('[data-firing]', { hasText: snoozeTitle })).toBeVisible();
  await expect(popover.locator('[data-firing]', { hasText: dismissTitle })).toBeVisible();

  // O próximo clique libera o som: toca o do lembrete (carrilhão) em loop.
  await page.evaluate(() => {
    (globalThis as unknown as { __allowPlay: boolean }).__allowPlay = true;
  });
  await page.getByRole('heading', { name: 'Anotações', exact: true }).click();
  await expect(alarm).toHaveAccessibleName('Lembretes: 2 não lidos');
  await expect(alarm).toHaveClass(/ringing/);
  const plays = await page.evaluate(() => (globalThis as unknown as { __plays: string[] }).__plays);
  expect(plays.some((src) => src.endsWith('/sounds/chime.wav'))).toBe(true);

  // Adiar: continua não lido (adiado até…); dispensar: lido. O som para quando nenhum toca mais.
  if (!(await popover.isVisible())) await alarm.click();
  const snoozed = popover.locator('[data-firing]', { hasText: snoozeTitle });
  await snoozed.getByRole('button', { name: 'Adiar 5 min' }).click();
  await expect(snoozed).toContainText('adiado até');
  await expect(alarm).toHaveAccessibleName('Lembretes: 2 não lidos');
  const dismissed = popover.locator('[data-firing]', { hasText: dismissTitle });
  await dismissed.getByRole('button', { name: 'Dispensar', exact: true }).click();
  await expect(alarm).toHaveAccessibleName('Lembretes: 1 não lido');
  await expect(dismissed.getByRole('button', { name: 'Dispensar', exact: true })).toHaveCount(0);
  await expect(alarm).not.toHaveClass(/ringing/);

  // Marcar todos como lidos zera o contador.
  await popover.getByRole('button', { name: 'Marcar todos como lidos' }).click();
  await expect(alarm).toHaveAccessibleName('Lembretes: nenhum não lido');

  // O título leva à anotação (?note=).
  await popover.getByRole('button', { name: snoozeTitle }).click();
  await expect(page).toHaveURL(/\/notes\?note=/);
  await expect(page.getByRole('dialog', { name: snoozeTitle })).toBeVisible();
});

test('calendário anual e mensal, dia filtrando a tabela, janela do lembrete, aba da entidade e selo', async ({ page }) => {
  await loginAsAdmin(page);
  const suffix = Date.now().toString(36);
  const entityName = `E2E Anotada ${suffix}`;
  const entityId = await createEntity(page, entityName);
  const year = new Date().getFullYear();
  // Um ano à frente (variando por execução): o calendário só tem as anotações deste teste nesses dias.
  const y = year + 2 + (Date.now() % 60);
  const day = `${y}-02-14`;
  const infoTitle = `E2E info ${suffix}`;
  const severeTitle = `E2E grave ${suffix}`;
  const goodTitle = `E2E boa ${suffix}`;
  await createNote(page, { kind: 'info', title: infoTitle, objectId: entityId, noteDate: day, body: '# Título\n\nTexto **forte**.' });
  await createNote(page, { kind: 'severe', title: severeTitle, objectId: entityId, noteDate: day });
  await createNote(page, { kind: 'good', title: goodTitle, objectId: entityId, noteDate: `${y}-06-20` });

  // Visão anual: 12 mini-meses e as bolinhas do dia, com as contagens no tooltip.
  await page.goto(`/notes?year=${y}`);
  await expect(page.locator('.note-mini')).toHaveCount(12);
  const cell = page.locator(`.note-year [data-day="${day}"]`);
  await expect(cell.locator('.note-dot')).toHaveCount(2);
  await expect(cell).toHaveAttribute('title', /Informação: 1, Nota grave: 1/);
  await expect(page.locator(`.note-year [data-day="${y}-06-20"] .note-dot`)).toHaveCount(1);

  // Clicar no mês abre a visão mensal (estado na URL), com as bolinhas maiores.
  await page.getByRole('button', { name: `Abrir Fevereiro de ${y}` }).click();
  await expect(page).toHaveURL(/view=month/);
  await expect(page.getByRole('heading', { name: `Fevereiro de ${y}` })).toBeVisible();
  const monthCell = page.locator(`.note-month [data-day="${day}"]`);
  await expect(monthCell.locator('.note-dot.lg')).toHaveCount(2);

  // Clicar no dia filtra a tabela para ele (o dia vira o período).
  await monthCell.click();
  await expect(monthCell).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('De', { exact: true })).toHaveValue(day);
  await expect(page.getByLabel('Até', { exact: true })).toHaveValue(day);
  await expect(page.locator(`tr[data-note="${infoTitle}"]`)).toBeVisible();
  await expect(page.locator(`tr[data-note="${severeTitle}"]`)).toBeVisible();
  await expect(page.locator(`tr[data-note="${goodTitle}"]`)).toHaveCount(0);

  // Chip de tipo: só a grave.
  await page.locator('.notes-filters').getByRole('button', { name: 'Nota grave' }).click();
  await expect(page).toHaveURL(/kinds=severe/);
  await expect(page.locator(`tr[data-note="${infoTitle}"]`)).toHaveCount(0);
  await expect(page.locator(`tr[data-note="${severeTitle}"]`)).toBeVisible();
  await page.locator('.notes-filters').getByRole('button', { name: 'Nota grave' }).click();
  await expect(page).not.toHaveURL(/kinds=/);
  await expect(page.locator(`tr[data-note="${infoTitle}"]`)).toBeVisible();

  // A janela: corpo renderizado, guia Escopo; e um lembrete mensal pela tela.
  await page.locator(`tr[data-note="${infoTitle}"]`).click();
  const view = page.getByRole('dialog', { name: infoTitle });
  await expect(view.getByRole('heading', { name: 'Título' })).toBeVisible();
  await view.getByRole('tab', { name: 'Escopo' }).click();
  await expect(view.getByText('@admin')).toBeVisible();
  await view.getByRole('button', { name: 'Cancelar' }).click();

  await page.getByRole('button', { name: 'Nova anotação' }).click();
  const create = page.getByRole('dialog', { name: 'Nova anotação' });
  await create.getByRole('radio', { name: 'Lembrete' }).click();
  const reminderTitle = `E2E mensal ${suffix}`;
  await create.getByLabel('Título').fill(reminderTitle);
  await create.getByRole('textbox', { name: 'Entidade' }).fill(entityName);
  await create.getByRole('option', { name: entityName }).click();
  await expect(create.getByLabel(/^Início/)).toHaveValue(day);
  await create.getByRole('tab', { name: 'Lembrete' }).click();
  await create.getByLabel('Repetição').selectOption('monthly_day');
  await create.getByLabel('Dia do mês').fill('10');
  await expect(create.getByTestId('reminder-description')).toContainText('todo dia 10 às 09:00');
  await create.getByRole('button', { name: 'Salvar' }).click();
  await expect(create).toBeHidden();

  // Aba Anotações da entidade: todas as dela (sem período), e a nova já vinculada.
  await page.goto(`/entities/${entityId}`);
  await page.getByRole('tab', { name: /Anotações/ }).click();
  await expect(page).toHaveURL(/tab=notes/);
  for (const title of [infoTitle, severeTitle, goodTitle, reminderTitle]) {
    await expect(page.locator(`tr[data-note="${title}"]`).first()).toBeVisible();
  }
  await expect(page.locator(`tr[data-note="${reminderTitle}"]`).first()).toContainText('todo dia 10 às 09:00');
  await page.getByRole('button', { name: 'Nova anotação' }).click();
  const fromEntity = page.getByRole('dialog', { name: 'Nova anotação' });
  await expect(fromEntity.getByRole('textbox', { name: 'Entidade' })).toHaveValue(entityName);
  const badTitle = `E2E ruim ${suffix}`;
  await fromEntity.getByRole('radio', { name: 'Nota ruim' }).click();
  await fromEntity.getByLabel('Título').fill(badTitle);
  await fromEntity.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator(`tr[data-note="${badTitle}"]`)).toBeVisible();

  // Selo na listagem: a cor da mais grave (grave), com as contagens no tooltip.
  await page.goto('/entities?kind=all');
  await page.getByPlaceholder('Nome, fantasia ou CPF/CNPJ').fill(entityName);
  const badge = page.getByRole('row', { name: new RegExp(entityName) }).locator('[data-note-badge]');
  await expect(badge).toHaveAttribute('data-note-badge', 'severe');
  await expect(badge).toHaveAttribute('title', /Nota grave: 1/);
});
