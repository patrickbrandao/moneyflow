import { expect, type Page, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Esc pela pilha de camadas (tarefa 115): cada Esc fecha só a camada de cima.
 * A lista do seletor de entidade fecha sem levar o "Novo título"; a confirmação
 * aberta da gaveta fecha sem levar a gaveta; a "Nova tag" volta às "Tags de entidade".
 * E as listas pelo teclado (tarefa 114): o nome da linha é um botão ou um link.
 */

async function base(page: Page, tag: string) {
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E Esc despesa ${tag}`, colorSlot: 4 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Esc Titular ${tag}` });
  const supplier = await post('/api/entities', { kind: 'company', name: `E2E Esc Fornecedor ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E Esc Caixa ${tag}`, holderEntityId: holder.id, isPrimary: false });
  return { post, expense, supplier, caixa };
}

test('Esc fecha só a lista do seletor, depois o modal; e só a confirmação aberta da gaveta', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, expense, supplier, caixa } = await base(page, tag);

  // 1. "Novo título": a lista da entidade aberta, o Esc fecha só ela.
  await page.goto(`/caixas/${caixa.id}/payables?new=1`);
  const form = page.getByRole('dialog', { name: 'Novo título a pagar' });
  await form.getByLabel('Descrição').fill(`Digitado ${tag}`);
  await form.getByLabel('Recebedor (a quem pagamos)').click();
  await expect(form.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form.getByRole('listbox')).toBeHidden();
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Descrição')).toHaveValue(`Digitado ${tag}`);
  // O segundo Esc fecha o modal.
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();

  // 2. A confirmação de "Cancelar título" aberta da gaveta: o Esc fecha só a confirmação.
  const title = await post('/api/titles', {
    caixaId: caixa.id,
    direction: 'payable',
    entityId: supplier.id,
    categoryId: expense.id,
    description: `Esc gaveta ${tag}`,
    competenceDate: '2026-11-01',
    dueDate: '2026-11-20',
    amountCents: 12_345,
    mirrorCaixaId: null,
  });
  await page.goto(`/caixas/${caixa.id}/payables?title=${title.id}`);
  const drawer = page.getByRole('complementary', { name: `Esc gaveta ${tag}` });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Cancelar título' }).click();
  const confirm = page.getByRole('dialog', { name: 'Cancelar o título?' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(drawer).toBeVisible();
  // Nada foi cancelado, e o próximo Esc fecha a gaveta.
  expect((await (await page.request.get(`/api/titles/${title.id}`)).json()).status).toBe('open');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('Esc na "Nova tag" volta às "Tags de entidade"', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/entities?kind=all');
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'Tags de entidade' });
  await manage.getByRole('button', { name: 'Nova tag' }).click();
  const form = page.getByRole('dialog', { name: 'Nova tag' });
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(manage).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(manage).toBeHidden();
});

test('teclado: o nome do título abre a gaveta, o foco entra nela e volta à linha; a caixa e a entidade abrem pelo link (tarefa 114)', async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, expense, supplier, caixa } = await base(page, tag);
  const description = `Teclado ${tag}`;
  await post('/api/titles', {
    caixaId: caixa.id,
    direction: 'payable',
    entityId: supplier.id,
    categoryId: expense.id,
    description,
    competenceDate: '2026-11-01',
    dueDate: '2026-11-20',
    amountCents: 4_321,
    mirrorCaixaId: null,
  });

  // Título: o nome é um botão; Enter abre a gaveta com o foco no título dela; Esc devolve o foco ao botão.
  await page.goto(`/caixas/${caixa.id}/payables`);
  const open = page.getByRole('button', { name: description, exact: true });
  await open.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('complementary', { name: description });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.dh .t')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(open).toBeFocused();

  // Caixa e entidade: o nome é um link da linha.
  await page.goto('/caixas');
  await page.getByRole('link', { name: caixa.name, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/caixas/${caixa.id}`));
  await page.goto('/entities?kind=all');
  await page.getByPlaceholder('Nome, fantasia ou CPF/CNPJ').fill(supplier.name);
  await page
    .getByRole('row', { name: new RegExp(supplier.name) })
    .getByRole('link', { name: supplier.name })
    .focus();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/entities/${supplier.id}`));
});
