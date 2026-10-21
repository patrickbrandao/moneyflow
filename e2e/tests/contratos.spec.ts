import { expect, type Page, test } from '@playwright/test';

/*
 * Contratos sobre séries (specs 020 e 034): criar pela tela o contrato com
 * uma obrigação na conta corrente, importar o extrato com o pagamento,
 * confirmar a sugestão e ver a ocorrência paga na guia Pagamentos; renovar
 * pela tela. E o cofre: "É o pagamento de…?" no lançamento avulso baixa a
 * ocorrência prevista. Caixa, contas, titular e contraparte vêm da API.
 */

const username = process.env.E2E_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin12345';

/** Primeiro dia do mês seguinte ao de hoje + `months` (AAAA-MM-DD). */
function monthFromNow(months: number, day = 1) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + months, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ofx(txs: { date: string; cents: number; name: string; fitid: string }[]) {
  const d = (iso: string) => iso.replaceAll('-', '');
  const list = txs
    .map(
      (tx) =>
        `<STMTTRN><TRNTYPE>${tx.cents < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${d(tx.date)}100000</DTPOSTED><TRNAMT>${(tx.cents / 100).toFixed(2)}</TRNAMT><FITID>${tx.fitid}</FITID><NAME>${tx.name}</NAME></STMTTRN>`,
    )
    .join('\n');
  const dates = txs.map((tx) => d(tx.date)).sort();
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>077</BANKID><BRANCHID>0001</BRANCHID><ACCTID>888-1</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${dates[0]}</DTSTART><DTEND>${dates.at(-1)}</DTEND>
${list}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
}

async function setup(page: Page, tag: string) {
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E despesa contrato ${tag}`, colorSlot: 3 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Locatária ${tag}` });
  const landlord = `E2E Locadora ${tag}`;
  await post('/api/entities', { kind: 'company', name: landlord });
  const caixa = await post('/api/caixas', { name: `E2E Locação ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Corrente ${tag}`,
    bankCode: '077',
    openingBalanceCents: 1_000_000,
    openingDate: '2026-01-01',
  });
  const cofre = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'cash',
    name: `Cofre ${tag}`,
    openingBalanceCents: 0,
    openingDate: '2026-01-01',
  });
  return { post, expense, caixa, account, cofre, landlord };
}

test('contrato: obrigação na conta, o pagamento no extrato vira a ocorrência paga; renovar estende', async ({ page }) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  const { expense, caixa, account, landlord } = await setup(page, tag);

  // 1. O contrato pela tela: eu pago, vigência de 6 meses a partir do mês que vem, aluguel de R$ 1.500,00 no dia 10 na corrente.
  const startsOn = monthFromNow(1);
  const firstDue = monthFromNow(1, 10);
  const name = `Locação ${tag}`;
  await page.goto('/contracts?new=1');
  const dialog = page.getByRole('dialog', { name: 'Novo contrato' });
  await dialog.getByLabel('Caixa', { exact: true }).selectOption({ label: caixa.name });
  await dialog.getByRole('button', { name: 'Eu pago' }).click();
  await dialog.getByLabel('Contraparte').fill(landlord);
  await dialog.getByRole('option', { name: new RegExp(landlord) }).click();
  await dialog.getByLabel('Nome / objeto').fill(name);
  await dialog.getByLabel('Categoria padrão').selectOption({ label: expense.name });
  await dialog.getByLabel('Início da vigência').fill(startsOn);
  await dialog.getByLabel('Fim da vigência').fill(monthFromNow(7, 0));
  const row = dialog.getByTestId('obligation-row').first();
  await row.getByTestId('obligation-description').fill('Aluguel');
  await row.getByLabel('Valor').fill('1.500,00');
  await row.getByLabel('Primeiro vencimento').fill(firstDue);
  await row.getByTestId('obligation-account').selectOption({ label: `${account.name} · Corrente/pagamento` });
  await dialog.getByTestId('contract-create').click();

  // 2. Detalhe: a obrigação na corrente, com a próxima ocorrência.
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const contractId = page.url().match(/contracts\/([0-9a-f-]{36})/)![1];
  const obligation = page.getByTestId('contract-obligations').getByTestId('obligation-row').first();
  await expect(obligation).toContainText('Aluguel');
  await expect(obligation).toContainText(account.name);
  await expect(obligation).toContainText('R$ 1.500,00');

  // 3. O extrato com o aluguel pago no vencimento: a sugestão aponta a ocorrência; confirmar baixa.
  const res = await page.request.post(`/api/statement-imports?accountId=${account.id}&fileName=locacao-${tag}.ofx`, {
    data: ofx([{ date: firstDue, cents: -150_000, name: 'PIX ALUGUEL', fitid: `${tag}-1` }]),
    headers: { 'content-type': 'application/x-ofx' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const imp = await res.json();
  await page.goto(`/caixas/${caixa.id}/reconciliation?account=${account.id}&import=${imp.id}`);
  const line = page.getByRole('row').filter({ hasText: 'PIX ALUGUEL' });
  await expect(line).toContainText('Sugerida');
  await expect(line.getByTestId('contract-split')).toContainText(name);
  await line.getByRole('button', { name: 'Confirmar' }).click();
  await expect(line).toContainText('Conciliada');

  // 4. Pagamentos: a primeira ocorrência paga no dia, pela conciliação.
  await page.goto(`/contracts/${contractId}?tab=payments`);
  const first = page.getByTestId('contract-payments').getByTestId('payment-row').first();
  await expect(first).toContainText('#1');
  await expect(first.getByTestId('payment-days')).toHaveText('no dia');
  await expect(first).toContainText('Conciliação');

  // 5. Renovar: a nova vigência e a obrigação estendida.
  await page.getByTestId('contract-renew').click();
  const renew = page.getByRole('dialog', { name: 'Renovar contrato' });
  await expect(renew.getByTestId('renewal-preview')).toContainText('Aluguel');
  await renew.getByTestId('renewal-submit').click();
  await expect(page.getByText('Contrato renovado.')).toBeVisible();
  await page.goto(`/contracts/${contractId}?tab=history`);
  await expect(page.getByTestId('contract-cycles')).toContainText('Vigência 2');
});

test('cofre: o lançamento avulso que é o pagamento da obrigação baixa a ocorrência', async ({ page }) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await page.goto('/');
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  const { post, expense, caixa, cofre, landlord } = await setup(page, tag);
  const entities = await (await page.request.get(`/api/entities?q=${encodeURIComponent(landlord)}`)).json();
  const due = monthFromNow(1, 5);
  await post('/api/contracts', {
    caixaId: caixa.id,
    entityId: entities[0].id,
    direction: 'payable',
    categoryId: expense.id,
    name: `Condomínio ${tag}`,
    startsOn: monthFromNow(1),
    endsOn: monthFromNow(4, 0),
    mirrorCaixaId: null,
    obligations: [{ description: 'Condomínio', amountCents: 40_000, firstDueDate: due, accountId: cofre.id }],
  });

  // Os previstos do cofre.
  await page.goto(`/caixas/${caixa.id}/accounts/${cofre.id}/statement`);
  await expect(page.getByTestId('planned-occurrences').getByTestId('planned-occurrence')).toHaveCount(3);

  // Lançamento avulso de saída com a contraparte: "É o pagamento de…?" e baixar a ocorrência.
  await page.getByRole('button', { name: 'Lançamento avulso' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Saída' }).click();
  await dialog.getByLabel('Valor').fill('400,00');
  await dialog.getByLabel('Data').fill(due);
  await dialog.getByLabel('Entidade').fill(landlord);
  await dialog.getByRole('option', { name: new RegExp(landlord) }).click();
  const offer = dialog.getByTestId('obligation-match-offer').first();
  await expect(offer).toContainText('Condomínio');
  await offer.getByTestId('obligation-match-settle').click();
  await expect(page.getByTestId('planned-occurrences').getByTestId('planned-occurrence')).toHaveCount(2);
});
