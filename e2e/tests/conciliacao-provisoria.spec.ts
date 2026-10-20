import { expect, type Page, test } from '@playwright/test';
import { loginAsAdmin } from '../support/session';

/*
 * Lote provisório e a troca pelo consolidado (spec 031): um extrato parcial
 * importado como provisório e conciliado (uma linha lançada, outra casada com
 * um título) é substituído pelo consolidado na própria importação. As
 * conciliações aparecem no consolidado, a sobra do provisório é decidida na
 * tela e o provisório fica substituído, fora da divergência. A preparação
 * (caixa, conta, título e o provisório conciliado) é feita pela API.
 */

type Tx = { date: string; cents: number; name: string };

/** OFX 2.x de uma conta com as transações dadas e o saldo do banco. */
function ofx(start: string, end: string, txs: Tx[], balance: { cents: number; on: string }) {
  const d = (iso: string) => iso.replaceAll('-', '');
  const money = (cents: number) => (cents / 100).toFixed(2);
  const list = txs
    .map(
      (tx, i) =>
        `<STMTTRN><TRNTYPE>${tx.cents < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${d(tx.date)}100000</DTPOSTED><TRNAMT>${money(tx.cents)}</TRNAMT><FITID>${d(start)}-${i}-${tx.name.replaceAll(' ', '')}</FITID><NAME>${tx.name}</NAME></STMTTRN>`,
    )
    .join('\n');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>077</BANKID><BRANCHID>0001</BRANCHID><ACCTID>12345-6</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${d(start)}</DTSTART><DTEND>${d(end)}</DTEND>
${list}
</BANKTRANLIST><LEDGERBAL><BALAMT>${money(balance.cents)}</BALAMT><DTASOF>${d(balance.on)}</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
}

async function setup(page: Page, tag: string) {
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  const expense = await post('/api/categories', { kind: 'expense', name: `E2E Provisório despesa ${tag}`, colorSlot: 5 });
  const holder = await post('/api/entities', { kind: 'company', name: `E2E Provisório Titular ${tag}` });
  const supplier = await post('/api/entities', { kind: 'company', name: `E2E Provisório Fornecedor ${tag}` });
  const caixa = await post('/api/caixas', { name: `E2E Provisório Caixa ${tag}`, holderEntityId: holder.id, isPrimary: true });
  const account = await post(`/api/caixas/${caixa.id}/accounts`, {
    kind: 'checking',
    name: `Corrente ${tag}`,
    bankCode: '077',
    openingBalanceCents: 100_000,
    openingDate: '2026-01-01',
  });
  const title = await post('/api/titles', {
    caixaId: caixa.id,
    direction: 'payable',
    entityId: supplier.id,
    categoryId: expense.id,
    description: `Aluguel ${tag}`,
    competenceDate: '2026-10-01',
    dueDate: '2026-10-05',
    amountCents: 80_000,
  });
  // O parcial do mês, provisório, conciliado: a tarifa lançada, o aluguel casado com o título e um café que o banco não confirma.
  const res = await page.request.post(`/api/statement-imports?accountId=${account.id}&fileName=parcial-${tag}.ofx&provisional=true`, {
    data: ofx(
      '2026-10-01',
      '2026-10-15',
      [
        { date: '2026-10-03', cents: -2_990, name: 'TARIFA PACOTE' },
        { date: '2026-10-05', cents: -80_000, name: 'PIX ALUGUEL' },
        { date: '2026-10-09', cents: -700, name: 'CAFE' },
      ],
      { cents: 16_310, on: '2026-10-15' },
    ),
    headers: { 'content-type': 'application/x-ofx' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const prov = await res.json();
  const line = (name: string) => prov.lines.find((l: { description: string }) => l.description === name).id as string;
  const create = { mode: 'adjustment', entityId: supplier.id, categoryId: expense.id };
  await post(`/api/statement-lines/${line('TARIFA PACOTE')}/create`, create);
  await post(`/api/statement-lines/${line('PIX ALUGUEL')}/match`, { titleId: title.id });
  await post(`/api/statement-lines/${line('CAFE')}/create`, create);
  return { caixa, account, prov };
}

test('troca do provisório pelo consolidado na importação: conciliações passam, a sobra é decidida e o provisório sai da divergência', async ({
  page,
}) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await loginAsAdmin(page);
  const { caixa, account, prov } = await setup(page, tag);

  await page.goto(`/caixas/${caixa.id}/reconciliation?account=${account.id}`);
  const provRow = page.getByRole('row').filter({ hasText: `parcial-${tag}.ofx` });
  await expect(provRow.getByText('Provisório', { exact: true })).toBeVisible();

  // Importa o consolidado: a troca do provisório sobreposto vem marcada.
  await page.getByRole('button', { name: 'Importar extrato' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Importar extrato' });
  await dialog.getByLabel('escolha um arquivo').setInputFiles({
    name: `consolidado-${tag}.ofx`,
    mimeType: 'application/x-ofx',
    buffer: ofx(
      '2026-10-01',
      '2026-10-31',
      [
        { date: '2026-10-03', cents: -2_990, name: 'TARIFA PCT SERVICOS' },
        { date: '2026-10-05', cents: -80_000, name: 'PIX ENVIADO ALUGUEL' },
        { date: '2026-10-25', cents: -1_000, name: 'PADARIA' },
      ],
      { cents: 16_010, on: '2026-10-31' },
    ),
  });
  await expect(dialog).toContainText('Resumo do OFX');
  const replace = dialog.getByRole('checkbox', { name: new RegExp(`Substituir o lote provisório parcial-${tag}`) });
  await expect(replace).toBeChecked();
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Provisório substituído: 2 conciliação(ões) passaram para o consolidado.')).toBeVisible();

  // O detalhe do consolidado: as duas linhas já conciliadas e a sobra do provisório (o café).
  const tarifa = page.getByRole('row').filter({ hasText: 'TARIFA PCT SERVICOS' });
  await expect(tarifa).toContainText('Conciliada');
  await expect(page.getByRole('row').filter({ hasText: 'PIX ENVIADO ALUGUEL' })).toContainText('Conciliada');
  const leftovers = page.getByTestId('supersede-leftovers');
  await expect(leftovers).toContainText('Sobras do provisório (1)');
  const cafe = leftovers.getByTestId('supersede-leftover').filter({ hasText: 'CAFE' });
  await cafe.getByRole('button', { name: 'Excluir o lançamento' }).click();
  await expect(page.getByText('1 sobra(s) resolvida(s).')).toBeVisible();
  await expect(leftovers).toHaveCount(0);

  // O provisório: substituído, somente leitura e fora da divergência.
  await page.getByRole('button', { name: 'Voltar aos lotes' }).click();
  const supersededRow = page.getByRole('row').filter({ hasText: `parcial-${tag}.ofx` });
  await expect(supersededRow).toContainText(`Substituído por consolidado-${tag}.ofx`);
  await expect(supersededRow).not.toContainText('Divergência');
  await supersededRow.getByRole('button', { name: `parcial-${tag}.ofx` }).click();
  await expect(page.getByTestId('superseded-note')).toBeVisible();
  await expect(page.getByTestId('supersede-outcome').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Casar de novo' })).toHaveCount(0);

  const detail = await (await page.request.get(`/api/statement-imports/${prov.id}`)).json();
  expect(detail.supersededBy).toMatchObject({ fileName: `consolidado-${tag}.ofx` });
  expect(detail.differenceCents).toBeNull();
});
