import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

/** Cenário de cartão: emissor, cartão (fecha dia 3, vence dia 10) pago pela caixa A. */
async function cardScenario(admin: ReturnType<typeof client>) {
  const s = await scenario(h, admin);
  const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${s.tag}` });
  const store = await admin.post('/api/entities', { kind: 'company', name: `Loja ${s.tag}` });
  const card = await admin.post('/api/caixas', {
    name: `Cartão ${s.tag}`,
    kind: 'credit_card',
    holderEntityId: issuer.id,
    defaultPayerCaixaId: s.caixaA.id,
    creditLimitCents: 500_000,
    closingDay: 3,
    dueDay: 10,
    cardLast4: '1234',
  });
  return { ...s, issuer, store, card };
}

const invoiceOf = (overview: any, month: string) => overview.invoices.find((i: any) => i.referenceMonth === month);

describe('cartão de crédito (spec 007)', () => {
  it('cria o cartão com as faturas do horizonte e as datas pelo dia de fechamento/vencimento', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await cardScenario(admin);
    expect(s.card.kind).toBe('credit_card');
    expect(s.card.card).toMatchObject({ defaultPayerCaixaId: s.caixaA.id, closingDay: 3, dueDay: 10, cardLast4: '1234' });
    const overview = await admin.get(`/api/cards/${s.card.id}`);
    expect(overview.invoices.length).toBeGreaterThanOrEqual(4);
    const any = overview.invoices[0];
    expect(any.dueDate.slice(8)).toBe('10');
    expect(any.closingDate.slice(8)).toBe('03');
    expect(overview.availableCents).toBe(500_000);
  });

  it('compra parcelada, estorno, fechamento, pagamento parcial com carryover e encargos', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await cardScenario(admin);

    // 6× de 200,00 a partir da fatura 10/2026 (fecha 03/10).
    const parcelada = await admin.post(`/api/cards/${s.card.id}/purchases`, {
      entityId: s.store.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-09-12',
      description: 'Cadeira de escritório',
      amountCents: 120_000,
      installmentsTotal: 6,
    });
    expect(parcelada.items.map((i: any) => i.referenceMonth)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
      '2027-03-01',
    ]);
    expect(parcelada.items.every((i: any) => i.amountCents === 20_000)).toBe(true);
    expect(parcelada.payerCaixaId).toBe(s.caixaA.id);

    await admin.post(`/api/cards/${s.card.id}/purchases`, {
      entityId: s.store.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-09-05',
      description: 'Combustível',
      amountCents: 35_000,
    });
    // Estorno parcial da compra parcelada, na fatura aberta.
    const refund = await admin.post(`/api/card-purchases/${parcelada.id}/refund`, { amountCents: 8_000, refundedOn: '2026-09-20' });
    expect(refund.kind).toBe('refund');
    expect(refund.items[0].amountCents).toBe(-8_000);
    await admin.post(`/api/card-purchases/${parcelada.id}/refund`, { amountCents: 200_000, refundedOn: '2026-09-21' }, 422);

    let overview = await admin.get(`/api/cards/${s.card.id}`);
    const oct = invoiceOf(overview, '2026-10-01');
    expect(oct.totalCents).toBe(20_000 + 35_000 - 8_000);
    expect(overview.usedCents).toBe(120_000 + 35_000 - 8_000);

    // Fechamento: um par de títulos por pagadora ("a receber" no cartão, "a pagar" na pagadora).
    const closed = await admin.post(`/api/card-invoices/${oct.id}/close`, {});
    expect(closed.status).toBe('closed');
    expect(closed.payers).toHaveLength(1);
    const payerTitle = closed.titles.find((tr: any) => tr.caixaId === s.caixaA.id);
    expect(payerTitle).toMatchObject({ direction: 'payable', amountCents: 47_000, origin: 'card_invoice', cardInvoiceId: oct.id });
    expect(payerTitle.mirrorStatus).toBe('accepted');
    const cardTitle = closed.titles.find((tr: any) => tr.caixaId === s.card.id);
    expect(cardTitle).toMatchObject({ direction: 'receivable', amountCents: 47_000, mirrorStatus: null });

    // Itens de fatura fechada não mudam.
    await admin.del(`/api/card-purchases/${parcelada.id}`, 422);

    // Pagamento parcial de 300,00 com juros de 15,00: o resto (170,00) rola para 11/2026.
    const paid = await admin.post(`/api/card-invoices/${oct.id}/pay`, {
      payerCaixaId: s.caixaA.id,
      settledOn: '2026-10-10',
      amountCents: 30_000,
      financialAccountId: s.accountA.id,
      charges: [{ chargeKind: 'interest', amountCents: 1_500, categoryId: s.expense.id }],
    });
    expect(paid.billedCents).toBe(30_000);
    expect(paid.settledCents).toBe(30_000);
    expect(paid.carriedOutCents).toBe(17_000);
    const reducedTitle = await admin.get(`/api/titles/${payerTitle.id}`);
    expect(reducedTitle).toMatchObject({ amountCents: 30_000, status: 'paid' });
    // O lado do cartão foi baixado sem conta e não fica "conta a definir".
    const cardSide = await admin.get(`/api/titles/${cardTitle.id}`);
    expect(cardSide).toMatchObject({ status: 'paid', pendingAccountCount: 0 });

    overview = await admin.get(`/api/cards/${s.card.id}`);
    const nov = invoiceOf(overview, '2026-11-01');
    expect(nov.totalCents).toBe(20_000 + 17_000 + 1_500);
    const novDetail = await admin.get(`/api/card-invoices/${nov.id}`);
    expect(novDetail.lines.map((l: any) => l.itemKind).sort()).toEqual(['carryover', 'installment', 'installment']);
    expect(novDetail.lines.find((l: any) => l.purchaseKind === 'charge')).toMatchObject({ amountCents: 1_500, entityId: s.issuer.id });

    const account = (await admin.get(`/api/caixas/${s.caixaA.id}`)).accounts.find((a: any) => a.id === s.accountA.id);
    expect(account.balanceCents).toBe(100_000 - 30_000);

    // Com pagamento, a fatura não reabre.
    const reopen = await client(h, (await userSession(h, 'admin')).cookie).raw('POST', `/api/card-invoices/${oct.id}/reopen`);
    expect(reopen.statusCode).toBe(422);

    // Antecipação na fatura aberta 11/2026; no fechamento o título é o total menos a antecipação.
    const advanced = await admin.post(`/api/card-invoices/${nov.id}/advance`, {
      payerCaixaId: s.caixaA.id,
      settledOn: '2026-10-25',
      amountCents: 10_000,
      financialAccountId: s.accountA.id,
    });
    expect(advanced.status).toBe('open');
    expect(advanced.settledCents).toBe(10_000);
    const novClosed = await admin.post(`/api/card-invoices/${nov.id}/close`, {});
    const open = novClosed.titles.find((tr: any) => tr.caixaId === s.caixaA.id && tr.status === 'open');
    expect(open.amountCents).toBe(38_500 - 10_000);

    // Pagamento total pelo fluxo normal de baixa do título.
    await admin.post(`/api/titles/${open.id}/settlements`, {
      settledOn: '2026-11-10',
      amountCents: 28_500,
      financialAccountId: s.accountA.id,
    });
    const novPaid = await admin.get(`/api/card-invoices/${nov.id}`);
    expect(novPaid.status).toBe('paid');
  });

  it('reabre a fatura sem pagamento (os títulos somem) e a pagadora só vê as compras dela', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await cardScenario(admin);
    await admin.post(`/api/cards/${s.card.id}/purchases`, {
      entityId: s.store.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-09-15',
      description: 'Livros',
      amountCents: 9_990,
    });
    // Outra pagadora (caixa B) numa compra do mesmo cartão.
    await admin.post(`/api/cards/${s.card.id}/purchases`, {
      entityId: s.store.id,
      categoryId: s.expense.id,
      payerCaixaId: s.caixaB.id,
      purchasedOn: '2026-09-16',
      description: 'Presente',
      amountCents: 5_000,
    });
    const oct = invoiceOf(await admin.get(`/api/cards/${s.card.id}`), '2026-10-01');

    // Quem edita só a caixa B (sem acesso ao cartão nem à caixa A).
    const payerUser = await userSession(h);
    await admin.put(`/api/users/${payerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'editor' }] });
    const payer = client(h, payerUser.cookie);

    const closed = await admin.post(`/api/card-invoices/${oct.id}/close`, {});
    expect(closed.payers).toHaveLength(2);
    const bTitle = (await payer.get(`/api/titles?caixaId=${s.caixaB.id}&direction=payable`)).find((tr: any) => tr.cardInvoiceId === oct.id);
    expect(bTitle.amountCents).toBe(5_000);
    // Sem o payerCaixaId, a pagadora não enxerga a fatura; com ele, só as compras dela.
    await payer.get(`/api/card-invoices/${oct.id}`, 404);
    const mine = await payer.get(`/api/card-invoices/${oct.id}?payerCaixaId=${s.caixaB.id}`);
    expect(mine.lines.map((l: any) => l.description)).toEqual(['Presente']);
    await payer.get(`/api/card-invoices/${oct.id}?payerCaixaId=${s.caixaA.id}`, 404);

    const reopened = await admin.post(`/api/card-invoices/${oct.id}/reopen`);
    expect(reopened.status).toBe('open');
    expect(reopened.titles).toHaveLength(0);
    await payer.get(`/api/titles/${bTitle.id}`, 404);
  });

  it('crédito na fatura (estorno maior que as compras) rola como carryover negativo', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await cardScenario(admin);
    const purchase = await admin.post(`/api/cards/${s.card.id}/purchases`, {
      entityId: s.store.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-08-10',
      description: 'Notebook',
      amountCents: 300_000,
      installmentsTotal: 3,
    });
    expect(purchase.items[0].referenceMonth).toBe('2026-09-01');
    // Estorno total em 10/2026: a fatura 10 fica com 1.000 − 3.000 = −2.000.
    await admin.post(`/api/card-purchases/${purchase.id}/refund`, { amountCents: 300_000, refundedOn: '2026-09-10' });
    const oct = invoiceOf(await admin.get(`/api/cards/${s.card.id}`), '2026-10-01');
    expect(oct.totalCents).toBe(-200_000);
    const closed = await admin.post(`/api/card-invoices/${oct.id}/close`, {});
    expect(closed.titles).toHaveLength(0);
    expect(closed.carriedOutCents).toBe(-200_000);
    const nov = invoiceOf(await admin.get(`/api/cards/${s.card.id}`), '2026-11-01');
    expect(nov.totalCents).toBe(100_000 - 200_000);
  });
});
