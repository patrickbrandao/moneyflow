import { expect, type Page, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Respostas fora de hora e listas cortadas:
 * - tarefa 117: a prévia do "Encerrar série" é a da data na tela; trocada a
 *   data, "Aplicar" desliga até a prévia nova chegar;
 * - tarefa 118: a resposta lenta do filtro anterior da auditoria não substitui
 *   a do filtro atual;
 * - tarefa 116: a aba de títulos com mais títulos que a página avisa
 *   "Mostrando N de M", soma o filtro inteiro e carrega o resto.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function base(page: Page, tag: string) {
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E Resp despesa ${tag}`, colorSlot: 6 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Resp Titular ${tag}` });
  const supplier = await post('/api/entities', { kind: 'company', name: `E2E Resp Fornecedor ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E Resp Caixa ${tag}`, holderEntityId: holder.id, isPrimary: false });
  const title = (description: string, dueDate: string, extra: Record<string, unknown> = {}) =>
    post('/api/titles', {
      caixaId: caixa.id,
      direction: 'payable',
      entityId: supplier.id,
      categoryId: expense.id,
      description,
      competenceDate: dueDate,
      dueDate,
      amountCents: 1_000,
      mirrorCaixaId: null,
      ...extra,
    });
  return { post, caixa, title };
}

test('Encerrar série: trocada a data, "Aplicar" espera a prévia nova', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { caixa, title } = await base(page, tag);
  const first = await title(`Série ${tag}`, daysFromNow(0), { series: { kind: 'recurrence', frequency: 'monthly' } });

  await page.goto(`/caixas/${caixa.id}/payables?title=${first.id}`);
  const drawer = page.getByRole('complementary', { name: `Série ${tag}` });
  await drawer.getByRole('button', { name: /Encerrar série/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Encerrar ou estender a série' });
  const apply = dialog.getByRole('button', { name: 'Aplicar' });
  await expect(apply).toBeEnabled();

  // A prévia da data nova demora: até ela chegar, "Aplicar" fica desligado.
  await page.route('**/series/end?endsOn=*', async (route) => {
    await wait(1_500);
    await route.continue();
  });
  await dialog.getByLabel('Manter até (último vencimento)').fill(daysFromNow(65));
  await expect(apply).toBeDisabled();
  await expect(apply).toBeEnabled({ timeout: 10_000 });
  await page.unroute('**/series/end?endsOn=*');
});

test('auditoria: a resposta lenta sem filtro não substitui a do filtro escolhido', async ({ page }) => {
  await loginAsAdmin(page);
  let delayed = false;
  await page.route('**/api/audit?*', async (route) => {
    const url = new URL(route.request().url());
    if (!delayed && !url.searchParams.has('table')) {
      delayed = true;
      await wait(2_500);
    }
    await route.continue();
  });
  await page.goto('/audit');
  await page.getByLabel('Tabela', { exact: true }).selectOption('categories');
  // Passa o tempo da resposta atrasada: a tabela continua só com as linhas de Categorias.
  await wait(3_000);
  const tables = page.locator('table.data tbody tr td:nth-child(3)');
  await expect(tables.first()).toHaveText('Categorias');
  const texts = await tables.allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  expect(new Set(texts)).toEqual(new Set(['Categorias']));
});

test('títulos além da página: "Mostrando N de M", rodapé do filtro inteiro e "Carregar mais"', async ({ page }) => {
  test.setTimeout(120_000);
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { caixa, title } = await base(page, tag);
  // 305 títulos no mesmo vencimento, de R$ 10,00 cada.
  const due = daysFromNow(5);
  for (let i = 0; i < 305; i += 25) {
    await Promise.all(Array.from({ length: Math.min(25, 305 - i) }, (_, j) => title(`Lote ${tag} ${i + j}`, due)));
  }

  await page.goto(`/caixas/${caixa.id}/payables`);
  const notice = page.getByTestId('list-cut');
  await expect(notice).toContainText('Mostrando 300 de 305.');
  await expect(page.locator('table.data tfoot')).toContainText('305 títulos');
  await expect(page.locator('table.data tfoot')).toContainText('R$ 3.050,00');
  await notice.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator('table.data tbody tr')).toHaveCount(305);
});
