import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

describe('resumo da conta (spec 004)', () => {
  it('separa entradas, saídas e transferências por mês, com o saldo do fim do mês e as categorias pelo caixa', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = (direction: 'payable' | 'receivable', categoryId: string, amountCents: number) =>
      admin.post('/api/titles', {
        caixaId: s.caixaA.id,
        direction,
        entityId: s.supplier.id,
        categoryId,
        description: `${direction} ${s.tag}`,
        competenceDate: '2026-09-01',
        dueDate: '2026-09-10',
        amountCents,
      });
    const payable = await title('payable', s.expense.id, 90_000);
    await admin.post(`/api/titles/${payable.id}/settlements`, {
      settledOn: '2026-09-10',
      amountCents: 30_000,
      financialAccountId: s.accountA.id,
    });
    const receivable = await title('receivable', s.income.id, 50_000);
    await admin.post(`/api/titles/${receivable.id}/settlements`, {
      settledOn: '2026-10-05',
      amountCents: 50_000,
      financialAccountId: s.accountA.id,
    });
    await admin.post(`/api/accounts/${s.accountA.id}/adjustments`, {
      occurredOn: '2026-10-07',
      amountCents: 1_500,
      description: 'Rendimento',
    });
    await admin.post(`/api/accounts/${s.accountA.id}/adjustments`, {
      occurredOn: '2026-10-08',
      amountCents: -700,
      description: 'Tarifa',
      categoryId: s.expense.id,
    });
    await admin.post('/api/transfers', {
      fromAccountId: s.accountA.id,
      toAccountId: s.accountB.id,
      amountCents: 10_000,
      transferredOn: '2026-10-09',
    });

    const summary = await admin.get(`/api/accounts/${s.accountA.id}/summary?from=2026-08-01&to=2026-10-31`);
    expect(summary.account.id).toBe(s.accountA.id);
    expect(summary.months).toEqual([
      { month: '2026-08-01', inflowCents: 0, outflowCents: 0, transferInCents: 0, transferOutCents: 0, closingCents: 100_000 },
      { month: '2026-09-01', inflowCents: 0, outflowCents: 30_000, transferInCents: 0, transferOutCents: 0, closingCents: 70_000 },
      { month: '2026-10-01', inflowCents: 51_500, outflowCents: 700, transferInCents: 0, transferOutCents: 10_000, closingCents: 110_800 },
    ]);
    const byCategory = (kind: string, categoryId: string | null) =>
      summary.categories.find((c: { kind: string; categoryId: string | null }) => c.kind === kind && c.categoryId === categoryId);
    expect(byCategory('expense', s.expense.id)).toMatchObject({ amountCents: 30_700, entries: 2, categoryName: s.expense.name });
    expect(byCategory('income', s.income.id)).toMatchObject({ amountCents: 50_000, entries: 1 });
    // Avulso sem categoria: receita pelo sinal, sem nome.
    expect(byCategory('income', null)).toMatchObject({ amountCents: 1_500, entries: 1, categoryName: null });
    // Transferência não entra nas categorias.
    expect(summary.categories).toHaveLength(3);
    expect(summary.reconciliation).toEqual({ imports: 0, lastImportId: null, lastPeriodEnd: null, newLines: 0, suggestedLines: 0 });

    // A outra conta enxerga só o que é dela; cofre não concilia extrato.
    const other = await admin.get(`/api/accounts/${s.accountB.id}/summary?from=2026-10-01&to=2026-10-31`);
    expect(other.months[0]).toMatchObject({ inflowCents: 0, transferInCents: 10_000, closingCents: 10_000 });
    expect(other.categories).toEqual([]);
    expect(other.reconciliation).toBeNull();
  });

  it('exige leitura na caixa e um período válido', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const outsider = client(h, (await userSession(h)).cookie);
    await outsider.get(`/api/accounts/${s.accountA.id}/summary?from=2026-01-01&to=2026-12-31`, 404);
    const backwards = await admin.raw('GET', `/api/accounts/${s.accountA.id}/summary?from=2026-12-01&to=2026-01-31`);
    expect(backwards.statusCode).toBeGreaterThanOrEqual(400);
    const tooLong = await admin.raw('GET', `/api/accounts/${s.accountA.id}/summary?from=2020-01-01&to=2026-12-31`);
    expect(tooLong.statusCode).toBeGreaterThanOrEqual(400);
  });
});
