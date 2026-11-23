import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

/*
 * Compra do cartão ligada à cobrança esperada (spec 034, tarefa 126):
 * POST /api/card-purchases/:id/charge-link liga a compra avulsa à ocorrência
 * e solta (charge: null), e a guia Pagamentos do contrato acompanha
 * ("cobrada" e, com a fatura fechada sem a compra, "não cobrada"); a série de
 * outro cartão, a ocorrência fora da série, o estorno e a ocorrência já
 * cobrada são recusados; quem só lê o cartão não liga. E as edições da compra
 * (PATCH /api/card-purchases/:id) e da fatura (PATCH /api/card-invoices/:id).
 * POST /api/series cria a cobrança esperada solta (sem contrato) no outro cartão.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

type Api = ReturnType<typeof client>;
type Scenario = Awaited<ReturnType<typeof scenario>>;

async function newCard(admin: Api, s: Scenario, label: string) {
  const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${label} ${s.tag}` });
  return admin.post('/api/caixas', {
    name: `Cartão ${label} ${s.tag}`,
    kind: 'credit_card',
    holderEntityId: issuer.id,
    defaultPayerCaixaId: s.caixaA.id,
    creditLimitCents: 500_000,
    closingDay: 25,
    dueDay: 5,
    cardLast4: '1111',
  });
}

async function setup() {
  const admin = client(h, (await userSession(h, 'admin')).cookie);
  const s = await scenario(h, admin);
  const card = await newCard(admin, s, 'A');
  const contract = await admin.post('/api/contracts', {
    caixaId: s.caixaA.id,
    entityId: s.supplier.id,
    direction: 'payable',
    categoryId: s.expense.id,
    name: `Assinatura ${s.tag}`,
    startsOn: '2026-11-01',
    endsOn: '2027-04-30',
    mirrorCaixaId: null,
    obligations: [
      { kind: 'card', description: 'Streaming', amountCents: 5_990, firstDueDate: '2026-11-15', cardCaixaId: card.id, toleranceCents: 100 },
    ],
  });
  const rule = contract.obligations.find((o: { description: string }) => o.description === 'Streaming');
  return { admin, s, card, contract, rule };
}

const purchase = (s: Scenario, purchasedOn: string, description: string) => ({
  entityId: s.supplier.id,
  categoryId: s.expense.id,
  purchasedOn,
  description,
  amountCents: 5_990,
});

async function cardRows(admin: Api, contractId: string) {
  const payments = await admin.get(`/api/contracts/${contractId}/payments`);
  return {
    rows: payments.rows
      .filter((r: { kind: string }) => r.kind === 'card_charge')
      .map((r: { occurrence: number; status: string }) => [r.occurrence, r.status]),
    notCharged: payments.summary.notCharged as number,
  };
}

describe('ligar a compra à cobrança esperada (spec 034)', () => {
  it('liga a compra avulsa, solta com charge: null e, com a fatura fechada sem ela, a ocorrência fica "não cobrada"', async () => {
    const { admin, s, card, contract, rule } = await setup();
    const loose = await admin.post(`/api/cards/${card.id}/purchases`, purchase(s, '2026-11-16', 'STREAMFLIX'));
    expect(loose).toMatchObject({ recurrenceRuleId: null, occurrence: null, contractId: null });

    const linked = await admin.post(`/api/card-purchases/${loose.id}/charge-link`, { charge: { ruleId: rule.id, occurrence: 1 } });
    expect(linked).toMatchObject({ id: loose.id, recurrenceRuleId: rule.id, occurrence: 1, contractId: contract.id });
    expect(await admin.get(`/api/card-purchases/${loose.id}`)).toMatchObject({ recurrenceRuleId: rule.id, occurrence: 1 });
    expect((await cardRows(admin, contract.id)).rows[0]).toEqual([1, 'charged']);
    // A ocorrência ligada sai das esperadas.
    const expected = await admin.get(`/api/cards/${card.id}/expected-charges?date=2026-11-16`);
    expect(expected.map((e: { occurrence: number }) => e.occurrence)).not.toContain(1);

    const unlinked = await admin.post(`/api/card-purchases/${loose.id}/charge-link`, { charge: null });
    expect(unlinked).toMatchObject({ recurrenceRuleId: null, occurrence: null, contractId: null });
    expect((await cardRows(admin, contract.id)).rows[0]).toEqual([1, 'expected']);

    // A fatura de novembro fecha sem compra ligada: não cobrada.
    const overview = await admin.get(`/api/cards/${card.id}`);
    const november = overview.invoices.find((i: { closingDate: string }) => i.closingDate === '2026-11-25');
    await admin.post(`/api/card-invoices/${november.id}/close`, {});
    let payments = await cardRows(admin, contract.id);
    expect(payments.rows[0]).toEqual([1, 'not_charged']);
    expect(payments.notCharged).toBe(1);

    // Ligar de novo (a compra já está na fatura fechada) volta a "cobrada".
    await admin.post(`/api/card-purchases/${loose.id}/charge-link`, { charge: { ruleId: rule.id, occurrence: 1 } });
    payments = await cardRows(admin, contract.id);
    expect(payments.rows[0]).toEqual([1, 'charged']);
    expect(payments.notCharged).toBe(0);
  });

  it('recusa a série de outro cartão, a ocorrência fora da série, a já cobrada e o estorno; quem só lê o cartão recebe 403', async () => {
    const { admin, s, card, rule } = await setup();
    const otherCard = await newCard(admin, s, 'B');
    // Cobrança esperada solta, sem contrato, no outro cartão (POST /api/series).
    const otherRule = await admin.post('/api/series', {
      kind: 'card',
      description: 'Nuvem',
      amountCents: 2_000,
      firstDueDate: '2026-11-10',
      cardCaixaId: otherCard.id,
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });
    expect(otherRule).toMatchObject({ kind: 'card', caixaId: otherCard.id, contractId: null, payerCaixaId: s.caixaA.id, endsOn: null });

    const first = await admin.post(`/api/cards/${card.id}/purchases`, purchase(s, '2026-11-16', 'Streaming nov'));
    const second = await admin.post(`/api/cards/${card.id}/purchases`, purchase(s, '2026-12-16', 'Streaming dez'));
    const link = (id: string, charge: unknown, expected?: number) =>
      admin.post(`/api/card-purchases/${id}/charge-link`, { charge }, expected);

    await link(first.id, { ruleId: otherRule.id, occurrence: 1 }, 404);
    // O contrato vai até abril de 2027: a 7ª ocorrência (maio) não existe.
    await link(first.id, { ruleId: rule.id, occurrence: 7 }, 422);
    await link(first.id, { ruleId: rule.id, occurrence: 1 });
    await link(second.id, { ruleId: rule.id, occurrence: 1 }, 409);
    expect((await admin.get(`/api/card-purchases/${second.id}`)).recurrenceRuleId).toBeNull();

    const refund = await admin.post(`/api/card-purchases/${second.id}/refund`, { refundedOn: '2026-12-17', amountCents: 5_990 });
    expect(refund.kind).toBe('refund');
    const refused = await link(refund.id, { ruleId: rule.id, occurrence: 2 }, 422);
    expect(refused.error.code).toBe('card_purchases_recurrence_check');

    const viewerUser = await userSession(h);
    await admin.post(`/api/caixas/${card.id}/members`, { userId: viewerUser.id, role: 'viewer' });
    const viewer = client(h, viewerUser.cookie);
    expect((await viewer.get(`/api/card-purchases/${first.id}`)).canWrite).toBe(false);
    await viewer.post(`/api/card-purchases/${first.id}/charge-link`, { charge: null }, 403);
    expect((await admin.get(`/api/card-purchases/${first.id}`)).occurrence).toBe(1);
  });
});

describe('editar a compra e a fatura (spec 007)', () => {
  it('PATCH da compra troca a descrição e as notas (e a pagadora só com a fatura aberta); PATCH da fatura troca o vencimento e as notas', async () => {
    const { admin, s, card } = await setup();
    const bought = await admin.post(`/api/cards/${card.id}/purchases`, purchase(s, '2026-11-16', 'Livraria'));
    const edited = await admin.patch(`/api/card-purchases/${bought.id}`, { description: 'Livraria Centro', notes: 'presente' });
    expect(edited).toMatchObject({ description: 'Livraria Centro', notes: 'presente', payerCaixaId: s.caixaA.id });
    const moved = await admin.patch(`/api/card-purchases/${bought.id}`, { payerCaixaId: s.caixaB.id });
    expect(moved.payerCaixaId).toBe(s.caixaB.id);

    const overview = await admin.get(`/api/cards/${card.id}`);
    const november = overview.invoices.find((i: { closingDate: string }) => i.closingDate === '2026-11-25');
    const invoice = await admin.patch(`/api/card-invoices/${november.id}`, { dueDate: '2026-12-07', notes: 'vencimento combinado' });
    expect(invoice).toMatchObject({ id: november.id, dueDate: '2026-12-07' });
    expect(invoice.payers.map((p: { payerCaixaId: string }) => p.payerCaixaId)).toEqual([s.caixaB.id]);

    // Com a fatura fechada, a pagadora não muda mais; a descrição muda.
    await admin.post(`/api/card-invoices/${november.id}/close`, {});
    await admin.patch(`/api/card-purchases/${bought.id}`, { payerCaixaId: s.caixaA.id }, 422);
    expect((await admin.patch(`/api/card-purchases/${bought.id}`, { description: 'Livraria (fechada)' })).description).toBe(
      'Livraria (fechada)',
    );

    const viewerUser = await userSession(h);
    await admin.post(`/api/caixas/${card.id}/members`, { userId: viewerUser.id, role: 'viewer' });
    const viewer = client(h, viewerUser.cookie);
    await viewer.patch(`/api/card-purchases/${bought.id}`, { description: 'x' }, 403);
    await viewer.patch(`/api/card-invoices/${november.id}`, { notes: 'x' }, 403);
  });
});
