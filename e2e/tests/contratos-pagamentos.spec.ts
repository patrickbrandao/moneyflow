import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Reconhecer o pagamento pela série (specs 033 e 034): o contrato de aluguel é
 * cadastrado pela tela com a obrigação na corrente e os ajustes (multa e
 * juros); o OFX com o aluguel pago 10 dias atrasado sugere a ocorrência com a
 * repartição; confirmar baixa a ocorrência e a guia Pagamentos mostra o atraso
 * na tabela e no gráfico. Caixa, conta, titular e fornecedor vêm da API.
 */

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
<BANKACCTFROM><BANKID>077</BANKID><BRANCHID>0001</BRANCHID><ACCTID>777-1</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${dates[0]}</DTSTART><DTEND>${dates.at(-1)}</DTEND>
${list}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
}

test('contrato com a obrigação na conta: o pagamento atrasado no extrato vira a baixa com multa e juros e aparece no gráfico', async ({
  page,
}) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await loginAsAdmin(page);
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E Aluguel despesa ${tag}`, colorSlot: 3 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Inquilina ${tag}` });
  const landlord = `E2E Imobiliária ${tag}`;
  await post('/api/entities', { kind: 'company', name: landlord });
  const caixa = await post('/api/caixas', { name: `E2E Aluguel ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Corrente aluguel ${tag}`,
    bankCode: '077',
    openingBalanceCents: 1_000_000,
    openingDate: '2026-01-01',
  });

  // 1. O contrato pela tela: eu pago, R$ 2.000,00 por mês de julho/2026 a junho/2027, dia 10, na corrente, com multa e juros.
  const name = `Aluguel sala ${tag}`;
  await page.goto('/contracts?new=1');
  const dialog = page.getByRole('dialog', { name: 'Novo contrato' });
  await dialog.getByLabel('Caixa', { exact: true }).selectOption({ label: caixa.name });
  await dialog.getByRole('button', { name: 'Eu pago' }).click();
  await dialog.getByLabel('Contraparte').fill(landlord);
  await dialog.getByRole('option', { name: new RegExp(landlord) }).click();
  await dialog.getByLabel('Nome / objeto').fill(name);
  await dialog.getByLabel('Categoria padrão').selectOption({ label: expense.name });
  await dialog.getByLabel('Início da vigência').fill('2026-07-01');
  await dialog.getByLabel('Fim da vigência').fill('2027-06-30');
  const obligation = dialog.getByTestId('obligation-row').first();
  await obligation.getByTestId('obligation-description').fill('Aluguel');
  await obligation.getByLabel('Valor').fill('2.000,00');
  await obligation.getByLabel('Primeiro vencimento').fill('2026-07-10');
  await obligation.getByTestId('obligation-account').selectOption({ label: `${account.name} · Corrente/pagamento` });
  const terms = obligation.getByTestId('obligation-terms');
  await terms.getByRole('button', { name: 'Ajustes de reconhecimento' }).click();
  await terms.getByLabel('Multa por atraso (%)').fill('2');
  await terms.getByLabel('Juros de mora (% ao mês)').fill('1');
  await dialog.getByTestId('contract-create').click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const contractId = page.url().match(/contracts\/([0-9a-f-]{36})/)![1];
  // A obrigação na corrente, com os ajustes.
  const row = page.getByTestId('contract-obligations').getByTestId('obligation-row').first();
  await expect(row).toContainText(account.name);
  await expect(row.getByTestId('obligation-terms-summary')).toContainText('2');

  // 2. O extrato com julho pago em 20/07 (10 dias de atraso): R$ 2.000,00 + multa R$ 40,00 + juros R$ 6,67.
  const res = await page.request.post(`/api/statement-imports?accountId=${account.id}&fileName=aluguel-${tag}.ofx`, {
    data: ofx([{ date: '2026-07-20', cents: -204_667, name: 'PIX ALUGUEL SALA', fitid: `${tag}-1` }]),
    headers: { 'content-type': 'application/x-ofx' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const imp = await res.json();

  // 3. A sugestão mostra a parcela e a repartição; confirmar baixa a parcela.
  await page.goto(`/caixas/${caixa.id}/reconciliation?account=${account.id}&import=${imp.id}`);
  const line = page.getByRole('row').filter({ hasText: 'PIX ALUGUEL SALA' });
  await expect(line).toContainText('Sugerida');
  const split = line.getByTestId('contract-split');
  await expect(split).toContainText(name);
  await expect(split).toContainText('10 dia(s) de atraso');
  await expect(split).toContainText('Multa R$ 40,00');
  await expect(split).toContainText('Juros R$ 6,67');
  await line.getByRole('button', { name: 'Confirmar' }).click();
  await expect(line).toContainText('Conciliada');

  // 4. Pagamentos: a parcela 1 paga com 10 dias de atraso, na tabela e no gráfico.
  await page.goto(`/contracts/${contractId}?tab=payments`);
  const payments = page.getByTestId('contract-payments');
  const first = payments.getByTestId('payment-row').first();
  await expect(first).toContainText('#1');
  await expect(first.getByTestId('payment-days')).toHaveText('+10 d');
  await expect(first).toContainText('Conciliação');
  await expect(payments.getByTestId('contract-payments-summary')).toContainText('R$ 46,67');
  // A 1ª barra: paga com 10 dias de atraso (as vencidas em aberto vêm depois, em tom de alerta).
  const firstBar = payments.getByTestId('contract-payments-delay').locator('g.uc-col').first();
  await expect(firstBar).toHaveAttribute('data-days', '10');
  await expect(firstBar).toHaveAttribute('data-overdue', 'false');
});
