import { addMonths, todayIso } from '@moneyflow/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materializeAll } from '../src/services/recurrence';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

const base = (s: Awaited<ReturnType<typeof scenario>>) => ({
  caixaId: s.caixaA.id,
  direction: 'payable' as const,
  entityId: s.holderB.id,
  categoryId: s.expense.id,
  description: 'Serviço',
  competenceDate: '2026-10-01',
  dueDate: '2026-10-15',
  amountCents: 90_000,
});

describe('espelhamento (spec 006)', () => {
  it('com permissão nas duas caixas o espelho nasce aceito na caixa principal da contraparte', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', base(s));
    expect(title.counterpartyCaixaId).toBe(s.caixaB.id);
    expect(title.mirror.caixaId).toBe(s.caixaB.id);
    expect(title.mirror.mirrorStatus).toBe('accepted');
    const mirror = await admin.get(`/api/titles/${title.mirror.id}`);
    expect(mirror.direction).toBe('receivable');
    expect(mirror.entityId).toBe(s.holderA.id);
    expect(mirror.amountCents).toBe(90_000);

    // Valor e vencimento andam juntos.
    await admin.patch(`/api/titles/${title.id}`, { amountCents: 95_000, dueDate: '2026-10-20' });
    const after = await admin.get(`/api/titles/${title.mirror.id}`);
    expect(after.amountCents).toBe(95_000);
    expect(after.dueDate).toBe('2026-10-20');
  });

  it('sem permissão na caixa da contraparte o espelho fica pendente até um editor de lá aceitar', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const authorUser = await userSession(h);
    const otherUser = await userSession(h);
    await admin.put(`/api/users/${authorUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    await admin.put(`/api/users/${otherUser.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'editor' }] });
    const author = client(h, authorUser.cookie);
    const other = client(h, otherUser.cookie);

    const title = await author.post('/api/titles', base(s));
    expect(title.mirror.mirrorStatus).toBe('pending');
    expect(title.mirror.canRead).toBe(false);
    await author.get(`/api/titles/${title.mirror.id}`, 404);

    const pending = await other.get(`/api/titles?caixaId=${s.caixaB.id}&status=pending_acceptance`);
    expect(pending.map((t: { id: string }) => t.id)).toEqual([title.mirror.id]);
    const overview = await other.get('/api/overview');
    expect(overview.pendingMirrors.map((t: { id: string }) => t.id)).toContain(title.mirror.id);

    const otherIncome = await admin.post('/api/categories', { kind: 'income', name: `Honorários ${s.tag}` });
    const accepted = await other.post(`/api/titles/${title.mirror.id}/mirror/accept`, { categoryId: otherIncome.id });
    expect(accepted.mirrorStatus).toBe('accepted');
    expect(accepted.categoryId).toBe(otherIncome.id);
    // O autor original não aceita pelo outro lado.
    await author.post(`/api/titles/${title.mirror.id}/mirror/accept`, {}, 404);
  });

  it('dispensa o espelho com mirrorCaixaId = null', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', { ...base(s), mirrorCaixaId: null });
    expect(title.mirror).toBeNull();
  });
});

describe('baixas (spec 005)', () => {
  it('baixa parcial com juros e desconto gera o movimento e atualiza a situação', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', { ...base(s), entityId: s.supplier.id });
    const partial = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-16',
      amountCents: 40_000,
      interestCents: 1_000,
      discountCents: 500,
      financialAccountId: s.accountA.id,
    });
    expect(partial.status).toBe('partial');
    expect(partial.openCents).toBe(50_000);
    expect(partial.settlements[0].cashCents).toBe(40_500);
    const statement = await admin.get(`/api/accounts/${s.accountA.id}/statement`);
    expect(statement.closingCents).toBe(100_000 - 40_500);
    expect(statement.rows[0].titleId).toBe(title.id);

    const over = await admin.post(`/api/titles/${title.id}/settlements`, { settledOn: '2026-10-17', amountCents: 60_000, financialAccountId: s.accountA.id }, 422);
    expect(over.error.code).toBe('settlements_overpayment_check');
    expect(over.error.message).toMatch(/saldo em aberto/);

    const paid = await admin.post(`/api/titles/${title.id}/settlements`, { settledOn: '2026-10-17', amountCents: 50_000, financialAccountId: s.accountA.id });
    expect(paid.status).toBe('paid');
  });

  it('pagar título da caixa B com conta da caixa A gera a transferência A → B', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', { ...base(s), caixaId: s.caixaB.id, entityId: s.supplier.id, amountCents: 30_000 });
    const settled = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 30_000,
      financialAccountId: s.accountB.id,
      sourceAccountId: s.accountA.id,
    });
    expect(settled.status).toBe('paid');
    expect(settled.settlements[0].transferId).toBeTruthy();
    const accounts = await admin.get('/api/accounts');
    const balance = (id: string) => accounts.find((a: { id: string }) => a.id === id).balanceCents;
    expect(balance(s.accountA.id)).toBe(70_000);
    expect(balance(s.accountB.id)).toBe(0);
    const transfers = await admin.get(`/api/transfers?caixaId=${s.caixaA.id}`);
    expect(transfers[0].settlementId).toBe(settled.settlements[0].id);
    // A transferência de uma baixa não se exclui sozinha.
    await admin.del(`/api/transfers/${transfers[0].id}`, 422);

    // Sem escrita na caixa A, não paga com a conta dela.
    const editorB = await userSession(h);
    await admin.put(`/api/users/${editorB.id}/memberships`, {
      memberships: [
        { caixaId: s.caixaB.id, role: 'editor' },
        { caixaId: s.caixaA.id, role: 'viewer' },
      ],
    });
    const other = await admin.post('/api/titles', { ...base(s), caixaId: s.caixaB.id, entityId: s.supplier.id, amountCents: 1_000 });
    await client(h, editorB.cookie).post(
      `/api/titles/${other.id}/settlements`,
      { settledOn: '2026-10-15', amountCents: 1_000, financialAccountId: s.accountB.id, sourceAccountId: s.accountA.id },
      403,
    );
  });

  it('estorno reabre o título, lança o movimento oposto e desfaz a transferência', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', { ...base(s), caixaId: s.caixaB.id, entityId: s.supplier.id, amountCents: 20_000 });
    const settled = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 20_000,
      financialAccountId: s.accountB.id,
      sourceAccountId: s.accountA.id,
    });
    const reversed = await admin.post(`/api/settlements/${settled.settlements[0].id}/reverse`, { reason: 'Pago em duplicidade', reversedOn: '2026-10-16' });
    expect(reversed.status).toBe('open');
    expect(reversed.settlements[0].reversedAt).toBeTruthy();
    const accounts = await admin.get('/api/accounts');
    const balance = (id: string) => accounts.find((a: { id: string }) => a.id === id).balanceCents;
    expect(balance(s.accountA.id)).toBe(100_000);
    expect(balance(s.accountB.id)).toBe(0);
    expect(await admin.get(`/api/transfers?caixaId=${s.caixaA.id}`)).toEqual([]);
    const statementB = await admin.get(`/api/accounts/${s.accountB.id}/statement`);
    expect(statementB.rows.map((r: { amountCents: number; isReversal: boolean }) => [r.amountCents, r.isReversal])).toEqual([
      [-20_000, false],
      [20_000, true],
    ]);
    await admin.post(`/api/settlements/${settled.settlements[0].id}/reverse`, { reason: 'de novo' }, 422);
  });

  it('baixa do espelho: duas pernas; o lado sem acesso fica com conta a definir', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const authorUser = await userSession(h);
    await admin.put(`/api/users/${authorUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const author = client(h, authorUser.cookie);
    const title = await author.post('/api/titles', base(s));
    const settled = await author.post(`/api/titles/${title.id}/settlements`, { settledOn: '2026-10-15', amountCents: 90_000, financialAccountId: s.accountA.id });
    expect(settled.status).toBe('paid');
    const mirror = await admin.get(`/api/titles/${title.mirror.id}`);
    expect(mirror.status).toBe('paid');
    expect(mirror.pendingAccountCount).toBe(1);
    const leg = mirror.settlements[0];
    expect(leg.financialAccountId).toBeNull();
    expect(leg.mirrorSettlementId).toBe(settled.settlements[0].id);

    const fixed = await admin.post(`/api/settlements/${leg.id}/account`, { financialAccountId: s.accountB.id });
    expect(fixed.pendingAccountCount).toBe(0);
    const accounts = await admin.get('/api/accounts');
    expect(accounts.find((a: { id: string }) => a.id === s.accountB.id).balanceCents).toBe(90_000);

    // Estornar uma perna estorna as duas.
    await author.post(`/api/settlements/${settled.settlements[0].id}/reverse`, { reason: 'erro', reversedOn: '2026-10-15' });
    expect((await admin.get(`/api/titles/${title.mirror.id}`)).status).toBe('open');
  });
});

describe('séries (recorrência e parcelamento)', () => {
  it('parcelamento cria as N parcelas (com espelho) e recorrência materializa 12 meses', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const first = await admin.post('/api/titles', { ...base(s), dueDate: today, competenceDate: today, series: { kind: 'installments', count: 3 } });
    expect(first.occurrence).toBe(1);
    expect(first.installmentsTotal).toBe(3);
    const series = await admin.get(`/api/titles?caixaId=${s.caixaA.id}`);
    expect(series.filter((t: { recurrenceRuleId: string }) => t.recurrenceRuleId === first.recurrenceRuleId).map((t: { occurrence: number }) => t.occurrence)).toEqual([1, 2, 3]);
    const mirrors = await admin.get(`/api/titles?caixaId=${s.caixaB.id}`);
    expect(mirrors.filter((t: { recurrenceRuleId: string }) => t.recurrenceRuleId === first.recurrenceRuleId)).toHaveLength(3);

    const monthly = await admin.post('/api/titles', {
      ...base(s),
      entityId: s.supplier.id,
      description: 'Aluguel',
      dueDate: today,
      competenceDate: today,
      series: { kind: 'recurrence', frequency: 'monthly' },
    });
    const all = (await admin.get(`/api/titles?caixaId=${s.caixaA.id}&limit=1000`)).filter(
      (t: { recurrenceRuleId: string }) => t.recurrenceRuleId === monthly.recurrenceRuleId,
    );
    expect(all).toHaveLength(13);
    expect(all.at(-1).dueDate).toBe(addMonths(today, 12));

    // O worker é idempotente e avança com o horizonte.
    const again = await materializeAll(h.db);
    expect(again.created).toBe(0);
    const later = await materializeAll(h.db, addMonths(today, 14));
    expect(later.created).toBeGreaterThanOrEqual(2);

    // "Esta e as próximas" encerra a série.
    const third = all[2];
    await admin.del(`/api/titles/${third.id}?scope=following`);
    const left = (await admin.get(`/api/titles?caixaId=${s.caixaA.id}&limit=1000`)).filter(
      (t: { recurrenceRuleId: string }) => t.recurrenceRuleId === monthly.recurrenceRuleId,
    );
    expect(left).toHaveLength(2);
    expect((await materializeAll(h.db, addMonths(today, 30))).created).toBe(0);
  });
});
