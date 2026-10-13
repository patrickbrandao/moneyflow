import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Fluxos da F2 (operação): importar um OFX de exemplo e conciliar; fechar a
 * fatura do cartão e pagá-la. A preparação (caixa, conta, cartão, compras) é
 * feita pela API com a sessão do login; o que se testa é a tela.
 */

const FIXTURES = join(import.meta.dirname, '../../apps/server/test/fixtures');

/** Categoria de despesa, titular, caixa geral e conta corrente com R$ 1.000,00. */
async function base(page: Page, tag: string) {
  const api = page.request;
  const post = async (url: string, data: unknown) => {
    const res = await api.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E F2 despesa ${tag}`, colorSlot: 3 });
  const income = await post('/api/categories', { kind: 'income', name: `E2E F2 receita ${tag}`, colorSlot: 8 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E F2 Titular ${tag}` });
  const supplier = await post('/api/entities', { kind: 'company', name: `E2E F2 Fornecedor ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E F2 Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Conta F2 ${tag}`,
    bankCode: '077',
    openingBalanceCents: 100_000,
    openingDate: '2026-01-01',
  });
  return { post, expense, income, supplier, caixa, account };
}

test('importar OFX de exemplo e conciliar', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, expense, income, supplier, caixa, account } = await base(page, tag);
  // Já lançado no app: a assinatura (casa sozinha) e o supermercado a pagar (fica sugerido).
  await post(`/api/accounts/${account.id}/adjustments`, {
    occurredOn: '2026-10-03',
    amountCents: -5_990,
    description: 'Assinatura streaming',
    categoryId: expense.id,
  });
  const market = await post('/api/titles', {
    caixaId: caixa.id,
    direction: 'payable',
    entityId: supplier.id,
    categoryId: expense.id,
    description: `Supermercado ${tag}`,
    competenceDate: '2026-10-01',
    dueDate: '2026-10-07',
    amountCents: 23_015,
  });

  await page.goto(`/caixas/${caixa.id}/reconciliation`);
  await page.getByRole('button', { name: 'Importar extrato' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Importar extrato' });
  await dialog.getByLabel('escolha um arquivo').setInputFiles(join(FIXTURES, 'extrato-ofx2.ofx'));
  await expect(dialog).toContainText('Resumo do OFX');
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();

  // As linhas do lote: uma conciliada (a assinatura) e uma sugerida (o título).
  await expect(page.getByText('Conciliada', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sugerida', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /Confirmar sugeridas/ }).click();
  await expect(page.getByText('Sugerida', { exact: true })).toHaveCount(0);

  // A sugestão confirmada virou baixa do título na conta do extrato.
  const title = await (await page.request.get(`/api/titles/${market.id}`)).json();
  expect(title.status).toBe('paid');
  expect(title.settlements[0].financialAccountId).toBe(account.id);

  // Linha sem par vira título já baixado. O cliente é titular de duas caixas: a
  // principal vem como caixa do espelho e dá para trocar (spec 006).
  const customer = await post('/api/entities', { kind: 'person', name: `E2E F2 Cliente ${tag}` });
  const customerMain = await post('/api/caixas', { name: `E2E F2 Cliente casa ${tag}`, holderEntityId: customer.id, isPrimary: true });
  const customerOther = await post('/api/caixas', { name: `E2E F2 Cliente praia ${tag}`, holderEntityId: customer.id });
  await page
    .getByRole('row', { name: /Cliente Ômega/ })
    .getByRole('button', { name: 'Lançar' })
    .click();
  const createDialog = page.getByRole('dialog', { name: 'Lançar a linha' });
  await createDialog.getByLabel('Entidade', { exact: true }).fill(customer.name);
  await createDialog.getByRole('option', { name: new RegExp(customer.name) }).click();
  await createDialog.getByLabel('Categoria', { exact: true }).selectOption({ label: income.name });
  const mirrorCaixa = createDialog.getByLabel('Caixa da contraparte (espelho)');
  await expect(mirrorCaixa).toHaveValue(customerMain.id);
  await mirrorCaixa.selectOption(customerOther.id);
  await createDialog.getByRole('button', { name: 'Lançar', exact: true }).click();
  await expect(createDialog).toBeHidden();

  const [received] = await (await page.request.get(`/api/titles?caixaId=${caixa.id}&entityId=${customer.id}`)).json();
  expect(received).toMatchObject({ direction: 'receivable', status: 'paid', amountCents: 150_000 });
  const detail = await (await page.request.get(`/api/titles/${received.id}`)).json();
  expect(detail.mirror).toMatchObject({ caixaId: customerOther.id });
});

test('fechar a fatura do cartão e pagar', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, expense, supplier, caixa, account } = await base(page, tag);
  const issuer = await post('/api/entities', { kind: 'company', name: `E2E F2 Emissor ${tag}` });
  const card = await post('/api/caixas', {
    name: `E2E Cartão ${tag}`,
    kind: 'credit_card',
    holderEntityId: issuer.id,
    defaultPayerCaixaId: caixa.id,
    creditLimitCents: 500_000,
    closingDay: 3,
    dueDay: 10,
    cardLast4: '4321',
  });
  await post(`/api/cards/${card.id}/purchases`, {
    entityId: supplier.id,
    categoryId: expense.id,
    purchasedOn: '2026-09-12',
    description: `Compra E2E ${tag}`,
    amountCents: 45_000,
  });

  // Fatura aberta 10/2026 (fecha 03/10): fechar pela tela.
  await page.goto(`/caixas/${card.id}/invoice`);
  await expect(page.getByText(`Compra E2E ${tag}`)).toBeVisible();
  await page.getByRole('button', { name: 'Fechar fatura' }).first().click();
  const closeDialog = page.getByRole('dialog', { name: 'Fechar a fatura 10/2026?' });
  await closeDialog.getByRole('button', { name: 'Fechar fatura' }).click();
  await expect(closeDialog).toBeHidden();

  // A fatura fechada gerou o título "a pagar" na pagadora; pagar pela página da fatura.
  const overview = await (await page.request.get(`/api/cards/${card.id}`)).json();
  const oct = overview.invoices.find((i: { referenceMonth: string }) => i.referenceMonth === '2026-10-01');
  expect(oct.status).toBe('closed');
  await page.goto(`/card-invoices/${oct.id}`);
  await page.getByRole('button', { name: 'Pagar fatura' }).first().click();
  const payDialog = page.getByRole('dialog', { name: 'Pagar a fatura 10/2026' });
  await payDialog.getByLabel('Conta da pagadora').selectOption(account.id);
  await payDialog.getByRole('button', { name: 'Pagar fatura' }).click();
  await expect(payDialog).toBeHidden();
  await expect(page.getByText('Paga', { exact: true }).first()).toBeVisible();

  const paid = await (await page.request.get(`/api/card-invoices/${oct.id}`)).json();
  expect(paid).toMatchObject({ status: 'paid', settledCents: 45_000 });
  const balance = (await (await page.request.get(`/api/caixas/${caixa.id}`)).json()).accounts[0].balanceCents;
  expect(balance).toBe(100_000 - 45_000);
});
