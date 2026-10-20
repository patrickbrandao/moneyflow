import { readFileSync } from 'node:fs';
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
  // Com um agente dos fluxos configurado (outros testes), a linha pode chegar com a entidade sugerida e travada.
  const swapEntity = createDialog.getByRole('button', { name: 'Trocar entidade' });
  if (await swapEntity.isVisible()) await swapEntity.click();
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

test('regras por conta (spec 032): a regra da corrente não aparece na poupança e é copiada pelo modal', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, supplier, caixa, account } = await base(page, tag);
  const savings = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'savings',
    name: `Poupança regras ${tag}`,
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });
  const pattern = `academia ${tag}`;

  // Cria a regra na corrente pela guia Regras.
  await page.goto(`/caixas/${caixa.id}/reconciliation?view=rules&account=${account.id}`);
  await expect(page.getByLabel('Conta das regras')).toHaveValue(account.id);
  await page.getByRole('button', { name: 'Nova regra' }).click();
  const form = page.getByRole('dialog', { name: 'Nova regra' });
  await expect(form.getByLabel('Conta', { exact: true })).toHaveValue(account.name);
  await form.getByLabel('Padrão', { exact: true }).fill(pattern);
  await form.getByLabel('Entidade', { exact: true }).fill(supplier.name);
  await form.getByRole('option', { name: new RegExp(supplier.name) }).click();
  await form.getByRole('button', { name: 'Salvar' }).click();
  await expect(form).toBeHidden();
  const rules = page.getByTestId('rules-table');
  await expect(rules).toContainText(pattern);

  // A poupança da mesma caixa não tem a regra.
  await page.getByLabel('Conta das regras').selectOption(savings.id);
  await expect(rules).toContainText('Nenhuma regra ainda');
  await expect(rules).not.toContainText(pattern);

  // Copiar da corrente para a poupança pelo modal.
  await page.getByRole('button', { name: 'Copiar regras de outra conta' }).click();
  const copy = page.getByRole('dialog', { name: `Copiar regras para ${savings.name}` });
  await copy.getByLabel('Conta de origem').selectOption(`accountId=${account.id}`);
  await copy.getByRole('checkbox', { name: pattern }).check();
  await copy.getByRole('button', { name: 'Copiar 1 regra' }).click();
  await expect(page.getByText('1 regra(s) copiada(s). Use “Aplicar regras” para reclassificar as linhas novas.')).toBeVisible();
  await expect(copy).toBeHidden();
  await expect(rules.getByRole('row', { name: new RegExp(pattern) })).toContainText('Cópia');

  // De novo: a regra já existe no destino e fica desabilitada.
  await page.getByRole('button', { name: 'Copiar regras de outra conta' }).click();
  await copy.getByLabel('Conta de origem').selectOption(`accountId=${account.id}`);
  await expect(copy.getByRole('checkbox', { name: pattern })).toBeDisabled();
  await expect(copy).toContainText('já existe no destino');

  // A aba Regras da tela da poupança mostra a mesma lista, presa na conta.
  await page.goto(`/caixas/${caixa.id}/accounts/${savings.id}/rules`);
  await expect(page.getByTestId('rules-table')).toContainText(pattern);
});

test('conciliação: título da caixa, última conta lembrada, aplicar regras e buscar nos lotes', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, expense, supplier, caixa } = await base(page, tag);
  const savings = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'savings',
    name: `Poupança F2 ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });
  const upload = await page.request.post(`/api/statement-imports?accountId=${savings.id}&fileName=extrato-ofx2.ofx`, {
    data: readFileSync(join(FIXTURES, 'extrato-ofx2.ofx')),
    headers: { 'content-type': 'application/x-ofx' },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  // Com um agente dos fluxos ligado por outro teste na mesma pilha, o import enfileira sugestões do agente,
  // que o "Aplicar regras" não sobrescreve (spec 009): espera a execução e começa sem elas.
  const imported = await upload.json();
  const runId: string | null = imported.aiSuggestion?.runId ?? null;
  if (runId) {
    await expect
      .poll(async () => (await (await page.request.get(`/api/runs/${runId}`)).json()).status, { timeout: 30_000 })
      .toMatch(/completed|failed|canceled|awaiting_confirmation/);
    const detail = await (await page.request.get(`/api/statement-imports/${imported.id}`)).json();
    for (const line of detail.lines as { id: string; classificationSource: string | null }[]) {
      if (line.classificationSource !== 'agent') continue;
      const cleared = await page.request.patch(`/api/statement-lines/${line.id}`, { data: { entityId: null, categoryId: null } });
      expect(cleared.ok(), await cleared.text()).toBeTruthy();
    }
  }

  // Escolhe a poupança; sai pelo nome da caixa no título e volta: a conta escolhida continua.
  await page.goto(`/caixas/${caixa.id}/reconciliation`);
  await page.getByLabel('Conta', { exact: true }).selectOption(savings.id);
  await expect(page.getByRole('button', { name: 'extrato-ofx2.ofx' })).toBeVisible();
  await page.getByRole('heading', { level: 1 }).getByRole('link', { name: caixa.name }).click();
  await expect(page).toHaveURL(new RegExp(`/caixas/${caixa.id}$`));
  await page.getByRole('tab', { name: 'Conciliação', exact: true }).click();
  await expect(page.getByLabel('Conta', { exact: true })).toHaveValue(savings.id);

  // Regra criada depois do import: o "Aplicar regras" do lote classifica a linha nova.
  await post('/api/classification-rules', {
    accountId: savings.id,
    pattern: 'internet',
    direction: 'out',
    entityId: supplier.id,
    categoryId: expense.id,
  });
  await page.getByRole('button', { name: 'extrato-ofx2.ofx' }).click();
  await page.getByRole('button', { name: 'Aplicar regras' }).click();
  await expect(page.getByText('1 linha(s) reclassificada(s) pelas regras.')).toBeVisible();
  await expect(page.getByRole('row', { name: /INTERNET/ })).toContainText(supplier.name);
  await page.getByRole('button', { name: 'Voltar aos lotes' }).click();

  // Busca por descrição nos lotes da conta, com as ações da linha no resultado.
  await page.getByLabel('Buscar nas linhas').fill('pix');
  const results = page.getByTestId('line-search-results');
  await expect(results).toContainText('2 linha(s) encontrada(s) · em todos os lotes');
  const sent = results.getByRole('row', { name: /PIX ENVIADO/ });
  await sent.getByRole('button', { name: 'Ignorar' }).click();
  await expect(sent).toContainText('Ignorada');
  await page.getByLabel('Marcar o lote extrato-ofx2.ofx para a busca').check();
  await expect(results).toContainText('em 1 lote(s) marcado(s)');
});

test('saldo do lote: o do OFX aplicado, editar, aviso do saldo inicial e lotes em ordem', async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAsAdmin(page);
  const { post, caixa } = await base(page, tag);
  // Conta aberta em 15/10, depois do início do extrato (01/10).
  const late = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Conta tardia ${tag}`,
    bankCode: '077',
    openingBalanceCents: 0,
    openingDate: '2026-10-15',
  });

  await page.goto(`/caixas/${caixa.id}/reconciliation?account=${late.id}`);
  await page.getByRole('button', { name: 'Importar extrato' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Importar extrato' });
  await dialog.getByLabel('escolha um arquivo').setInputFiles(join(FIXTURES, 'extrato-ofx2.ofx'));
  // O saldo do arquivo já vale; o campo só abre em "Informar outro saldo".
  await expect(dialog.getByTestId('file-balance')).toContainText('R$ 2.786,20 em 31/10/2026');
  await expect(dialog.getByLabel('Saldo do banco')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Informar outro saldo' }).click();
  await expect(dialog.getByLabel('Saldo do banco')).toBeVisible();
  await dialog.getByRole('button', { name: 'usar o do arquivo' }).click();
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();

  // No lote: o saldo do arquivo, o aviso do saldo inicial e a edição do saldo.
  await expect(page.getByText('R$ 2.786,20').first()).toBeVisible();
  await expect(page.getByTestId('opening-warning')).toContainText('15/10/2026');
  await page.getByRole('button', { name: 'Editar saldo' }).click();
  const balance = page.getByRole('dialog', { name: 'Saldo do banco do lote' });
  await balance.getByLabel('Saldo do banco').fill('1.000,00');
  await balance.getByRole('button', { name: 'Salvar' }).click();
  await expect(balance).toBeHidden();
  await expect(page.getByText('R$ 1.000,00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Editar saldo' }).click();
  await balance.getByRole('button', { name: 'Voltar ao saldo do arquivo' }).click();
  await expect(balance).toBeHidden();
  await expect(page.getByText('R$ 2.786,20').first()).toBeVisible();

  // Outro lote com período anterior: a lista fica em ordem cronológica (mais antigo primeiro).
  const older = readFileSync(join(FIXTURES, 'extrato-ofx2.ofx'), 'latin1').replaceAll('OFX2-', 'OLD-').replaceAll('202610', '202609');
  const res = await page.request.post(`/api/statement-imports?accountId=${late.id}&fileName=zz-setembro.ofx`, {
    data: Buffer.from(older, 'latin1'),
    headers: { 'content-type': 'application/x-ofx' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  await page.getByRole('button', { name: 'Voltar aos lotes' }).click();
  await page.reload();
  const files = page.locator('table.data tbody tr .row-title');
  await expect(files).toHaveText(['zz-setembro.ofx', 'extrato-ofx2.ofx']);
  await page.getByRole('columnheader', { name: 'Arquivo' }).getByRole('button').click();
  await expect(files).toHaveText(['extrato-ofx2.ofx', 'zz-setembro.ofx']);

  // O atalho do aviso abre a edição da conta.
  await page.getByRole('link', { name: 'Ajustar a conta' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Editar conta' })).toBeVisible();
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
