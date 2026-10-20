import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Navegação caixa → conta (spec 004): abrir a conta pela faixa da caixa e ver
 * Resumo, Extrato e Conciliação só dela, sem os totais da caixa. A preparação
 * (caixa, duas contas, avulsos, transferência e um OFX) é feita pela API.
 */

const FIXTURES = join(import.meta.dirname, '../../apps/server/test/fixtures');

/** Hoje no fuso de São Paulo (YYYY-MM-DD): os avulsos caem no "mês" dos números do topo. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

async function setup(page: Page, tag: string) {
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E Conta despesa ${tag}`, colorSlot: 3 });
  const income = await post('/api/categories', { kind: 'income', name: `E2E Conta receita ${tag}`, colorSlot: 8 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Conta Titular ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E Conta Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const checking = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Corrente ${tag}`,
    bankCode: '077',
    openingBalanceCents: 100_000,
    openingDate: '2026-01-01',
  });
  const savings = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'savings',
    name: `Reserva ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });
  const on = today();
  await post(`/api/accounts/${checking.id}/adjustments`, {
    occurredOn: on,
    amountCents: 50_000,
    description: `Rendimento ${tag}`,
    categoryId: income.id,
  });
  await post(`/api/accounts/${checking.id}/adjustments`, {
    occurredOn: on,
    amountCents: -12_345,
    description: `Tarifa ${tag}`,
    categoryId: expense.id,
  });
  await post('/api/transfers', { fromAccountId: checking.id, toAccountId: savings.id, amountCents: 10_000, transferredOn: on });
  // Um extrato na corrente: as 6 linhas ficam a conciliar (nenhuma casa com os valores acima).
  const upload = await page.request.post(`/api/statement-imports?accountId=${checking.id}&fileName=extrato-ofx2.ofx`, {
    data: readFileSync(join(FIXTURES, 'extrato-ofx2.ofx')),
    headers: { 'content-type': 'application/x-ofx' },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  return { expense, income, caixa, checking, savings };
}

test('tela da conta: abrir pela faixa da caixa, Resumo, Extrato e Conciliação só da conta', async ({ page }) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await loginAsAdmin(page);
  const { expense, income, caixa, checking, savings } = await setup(page, tag);

  // A caixa continua com os totais gerais e mostra a faixa das contas.
  await page.goto(`/caixas/${caixa.id}`);
  await expect(page.getByText('a pagar em aberto')).toBeVisible();
  const strip = page.getByRole('navigation', { name: 'Contas desta caixa' });
  await expect(strip.getByRole('link')).toHaveCount(2);
  await strip.getByRole('link', { name: new RegExp(checking.name) }).click();

  // Tela da conta: título "Caixa › Conta", números só da conta, sem os da caixa.
  await expect(page).toHaveURL(new RegExp(`/caixas/${caixa.id}/accounts/${checking.id}$`));
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText(caixa.name);
  await expect(heading).toContainText(checking.name);
  const tiles = page.getByTestId('account-tiles');
  await expect(tiles).toContainText('1.276,55'); // 1.000,00 + 500,00 − 123,45 − 100,00
  await expect(tiles).toContainText('entradas no mês');
  await expect(tiles).toContainText('500,00');
  await expect(tiles).toContainText('123,45');
  await expect(tiles).toContainText('linhas a conciliar');
  await expect(tiles.getByText('6', { exact: true })).toBeVisible();
  await expect(page.getByText('a pagar em aberto')).toHaveCount(0);

  // Resumo: gráficos mensais, saldo, pizzas por categoria e a tabela mês a mês.
  await expect(page.getByRole('tab', { name: 'Resumo' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('account-flows').locator('svg')).toBeVisible();
  await expect(page.getByTestId('account-balance').locator('svg')).toBeVisible();
  await expect(page.getByTestId('account-expense-donut')).toContainText(expense.name);
  await expect(page.getByTestId('account-income-donut')).toContainText(income.name);
  const months = page.getByTestId('account-months');
  await expect(months.getByRole('row', { name: /^Total/ })).toContainText('100,00'); // transferência enviada

  // Extrato: preso na conta (sem o seletor), com os avulsos e a transferência para a outra conta.
  await page.getByRole('tab', { name: 'Extrato' }).click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${checking.id}/statement$`));
  await expect(page.getByRole('cell', { name: new RegExp(`Rendimento ${tag}`) })).toBeVisible();
  await expect(page.getByRole('cell', { name: new RegExp(`Tarifa ${tag}`) })).toBeVisible();
  await expect(page.getByText(new RegExp(`→ ${caixa.name} › ${savings.name}`))).toBeVisible();
  await expect(page.getByLabel('Conta', { exact: true })).toHaveCount(0);

  // Conciliação: os lotes desta conta e o caminho para as regras da caixa.
  await page.getByRole('tab', { name: 'Conciliação' }).click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${checking.id}/reconciliation$`));
  await expect(page.getByRole('button', { name: 'extrato-ofx2.ofx' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'regras da caixa' })).toHaveAttribute(
    'href',
    `/caixas/${caixa.id}/reconciliation?view=rules`,
  );

  // Trocar de conta mantém a aba: a poupança não tem lote.
  await page.getByLabel('Trocar de conta').selectOption(savings.id);
  await expect(page).toHaveURL(new RegExp(`/accounts/${savings.id}/reconciliation$`));
  await expect(heading).toContainText(savings.name);
  await expect(page.getByText('Nenhum extrato importado nesta conta.')).toBeVisible();

  // Voltar para a caixa.
  await page.getByRole('link', { name: 'Voltar para a caixa' }).click();
  await expect(page).toHaveURL(new RegExp(`/caixas/${caixa.id}/accounts$`));
});

/** Soma dias a uma data YYYY-MM-DD (UTC, sem fuso). */
const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test('faixa só com nome e saldo, período do extrato lembrado e negativo no formato contábil', async ({ page }) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await loginAsAdmin(page);
  const { caixa, checking } = await setup(page, tag);

  // A faixa mostra o nome e o saldo, sem o tipo da conta.
  await page.goto(`/caixas/${caixa.id}`);
  const strip = page.getByRole('navigation', { name: 'Contas desta caixa' });
  const chip = strip.getByRole('link', { name: new RegExp(checking.name) });
  await expect(chip).toContainText('R$');
  await expect(chip).not.toContainText('Corrente/pagamento');
  await expect(strip).not.toContainText('Poupança/investimento');

  // Extrato da conta: começa nos últimos 60 dias e nos próximos 30.
  await page.goto(`/caixas/${caixa.id}/accounts/${checking.id}/statement`);
  const from = page.getByLabel('De', { exact: true });
  const to = page.getByLabel('Até', { exact: true });
  const on = today();
  await expect(from).toHaveValue(plusDays(on, -60));
  await expect(to).toHaveValue(plusDays(on, 30));
  await expect(page.getByRole('button', { name: 'Padrão' })).toHaveAttribute('aria-pressed', 'true');

  // A tarifa sai entre parênteses, sem sinal, com a classe do negativo.
  const fee = page
    .locator('tr', { hasText: `Tarifa ${tag}` })
    .locator('.money')
    .first();
  await expect(fee).toHaveText(/^\(R\$\s123,45\)$/);
  await expect(fee).toHaveClass(/\bneg\b/);

  // Mês atual e depois o anterior (anda a partir do mês mostrado).
  await page.getByRole('button', { name: 'Mês atual' }).click();
  const monthStart = `${on.slice(0, 7)}-01`;
  await expect(from).toHaveValue(monthStart);
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  const prevEnd = plusDays(monthStart, -1);
  await expect(from).toHaveValue(`${prevEnd.slice(0, 7)}-01`);
  await expect(to).toHaveValue(prevEnd);

  // Sair e voltar: o filtro continua o mês anterior, na tela da conta e no Extrato da caixa.
  await page.getByRole('tab', { name: 'Resumo' }).click();
  await page.getByRole('tab', { name: 'Extrato' }).click();
  await expect(from).toHaveValue(`${prevEnd.slice(0, 7)}-01`);
  await page.goto(`/caixas/${caixa.id}/statement?account=${checking.id}`);
  await expect(page.getByLabel('De', { exact: true })).toHaveValue(`${prevEnd.slice(0, 7)}-01`);

  // Hoje e de volta ao padrão.
  await page.getByRole('button', { name: 'Hoje' }).click();
  await expect(page.getByLabel('De', { exact: true })).toHaveValue(on);
  await expect(page.getByLabel('Até', { exact: true })).toHaveValue(on);
  await page.getByRole('button', { name: 'Padrão' }).click();
  await expect(page.getByLabel('De', { exact: true })).toHaveValue(plusDays(on, -60));

  // Os títulos a pagar têm o mesmo filtro, com a memória própria (começam no padrão).
  await page.goto(`/caixas/${caixa.id}/payables`);
  await expect(page.getByLabel('Vencimento de')).toHaveValue(plusDays(on, -60));
  await expect(page.getByLabel('Vencimento até')).toHaveValue(plusDays(on, 30));
});
