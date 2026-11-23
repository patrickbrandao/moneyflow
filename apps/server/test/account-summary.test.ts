import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
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

    // A lista de cada fatia soma o mesmo valor da pizza (spec 004).
    const group = s.expense.parentId ?? s.expense.id;
    const entries = await admin.get(
      `/api/accounts/${s.accountA.id}/category-entries?from=2026-08-01&to=2026-10-31&kind=expense&groups=${group}`,
    );
    expect(entries.map((e: { amountCents: number }) => e.amountCents)).toEqual([700, 30_000]);
    expect(entries[0]).toMatchObject({ occurredOn: '2026-10-08', movementKind: 'adjustment', description: 'Tarifa', titleId: null });
    expect(entries[1]).toMatchObject({
      occurredOn: '2026-09-10',
      movementKind: 'settlement',
      titleId: payable.id,
      titleDirection: 'payable',
      entityName: s.supplier.name,
      categoryName: s.expense.name,
    });
    const none = await admin.get(`/api/accounts/${s.accountA.id}/category-entries?from=2026-08-01&to=2026-10-31&kind=income&groups=none`);
    expect(none).toEqual([expect.objectContaining({ amountCents: 1_500, description: 'Rendimento', categoryId: null })]);
    const both = await admin.get(
      `/api/accounts/${s.accountA.id}/category-entries?from=2026-08-01&to=2026-10-31&kind=income&groups=none,${s.income.parentId ?? s.income.id}`,
    );
    expect(both).toHaveLength(2);

    // A outra conta enxerga só o que é dela; cofre não concilia extrato.
    const other = await admin.get(`/api/accounts/${s.accountB.id}/summary?from=2026-10-01&to=2026-10-31`);
    expect(other.months[0]).toMatchObject({ inflowCents: 0, transferInCents: 10_000, closingCents: 10_000 });
    expect(other.categories).toEqual([]);
    expect(other.reconciliation).toBeNull();

    // Saldo do fim do mês pelo acumulado (tarefa 092): nulo antes da abertura, o saldo inicial no mês dela,
    // e o período começando no meio do mês conta o mês inteiro, como financial_account_balance_at.
    const late = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'cash',
      name: 'Cofre tardio',
      openingBalanceCents: 5_000,
      openingDate: '2026-09-15',
    });
    await admin.post(`/api/accounts/${late.id}/adjustments`, { occurredOn: '2026-09-20', amountCents: 300, description: 'Antes' });
    await admin.post(`/api/accounts/${late.id}/adjustments`, { occurredOn: '2026-10-02', amountCents: 1_000, description: 'Depois' });
    const lateSummary = await admin.get(`/api/accounts/${late.id}/summary?from=2026-08-20&to=2026-10-01`);
    expect(lateSummary.months).toEqual([
      expect.objectContaining({ month: '2026-08-01', inflowCents: 0, closingCents: null }),
      expect.objectContaining({ month: '2026-09-01', inflowCents: 300, closingCents: 5_300 }),
      expect.objectContaining({ month: '2026-10-01', inflowCents: 0, closingCents: 6_300 }),
    ]);
    const fromSeptember = await admin.get(`/api/accounts/${late.id}/summary?from=2026-09-25&to=2026-10-31`);
    expect(fromSeptember.months.map((m: { closingCents: number | null }) => m.closingCents)).toEqual([5_300, 6_300]);
  });

  it('exige leitura na caixa e um período válido', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const outsider = client(h, (await userSession(h)).cookie);
    await outsider.get(`/api/accounts/${s.accountA.id}/summary?from=2026-01-01&to=2026-12-31`, 404);
    await outsider.get(`/api/accounts/${s.accountA.id}/category-entries?from=2026-01-01&to=2026-12-31&kind=expense&groups=none`, 404);
    const noGroups = await admin.raw(
      'GET',
      `/api/accounts/${s.accountA.id}/category-entries?from=2026-01-01&to=2026-12-31&kind=expense&groups=`,
    );
    expect(noGroups.statusCode).toBe(400);
    const backwards = await admin.raw('GET', `/api/accounts/${s.accountA.id}/summary?from=2026-12-01&to=2026-01-31`);
    expect(backwards.statusCode).toBeGreaterThanOrEqual(400);
    const tooLong = await admin.raw('GET', `/api/accounts/${s.accountA.id}/summary?from=2020-01-01&to=2026-12-31`);
    expect(tooLong.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('conta arquivada (tarefa 080)', () => {
  it('só arquiva com saldo zero e não recebe movimento nem extrato novo; o histórico continua legível', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const s = await scenario(h, admin);
    const ofx = readFileSync(join(import.meta.dirname, 'fixtures', 'extrato-ofx2.ofx'));
    const importOfx = (accountId: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/statement-imports?accountId=${accountId}&fileName=extrato.ofx`,
        payload: ofx,
        headers: { cookie: session.cookie, 'content-type': 'application/x-ofx' },
      });
    expect((await importOfx(s.accountA.id)).statusCode).toBe(200);
    const newTitle = (amountCents: number) =>
      admin.post('/api/titles', {
        caixaId: s.caixaA.id,
        direction: 'payable',
        entityId: s.supplier.id,
        categoryId: s.expense.id,
        description: `Conta ${amountCents}`,
        competenceDate: '2026-10-01',
        dueDate: '2026-10-15',
        amountCents,
        mirrorCaixaId: null,
      });
    const title = await newTitle(10_000);
    const paid = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 10_000,
      financialAccountId: s.accountA.id,
    });

    // Com saldo (1.000,00 − 100,00), a conta não sai do total da caixa.
    const refused = await admin.raw('DELETE', `/api/accounts/${s.accountA.id}`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('account_archive_balance');
    expect(refused.json().error.message).toContain('900,00');

    // Zerada por um avulso, arquiva; a caixa e o calendário mostram o mesmo saldo.
    const today = todayIso();
    await admin.post(`/api/accounts/${s.accountA.id}/adjustments`, { occurredOn: today, amountCents: -90_000, description: 'Saque final' });
    expect(await admin.del(`/api/accounts/${s.accountA.id}`)).toEqual({ deleted: false, archived: true });
    const caixa = await admin.get(`/api/caixas/${s.caixaA.id}`);
    const [day] = await admin.get(`/api/calendar/balances?caixaId=${s.caixaA.id}&from=${today}&to=${today}`);
    expect(caixa.balanceCents).toBe(0);
    expect(day.realizedCents).toBe(caixa.balanceCents);

    // Nada novo na conta arquivada: avulso, baixa, transferência e extrato.
    const archived = async (res: { statusCode: number; json: () => any }, code: string) => {
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe(code);
    };
    await archived(
      await admin.raw('POST', `/api/accounts/${s.accountA.id}/adjustments`, { occurredOn: today, amountCents: 100, description: 'X' }),
      'account_archived',
    );
    const other = await newTitle(5_000);
    await archived(
      await admin.raw('POST', `/api/titles/${other.id}/settlements`, {
        settledOn: today,
        amountCents: 5_000,
        financialAccountId: s.accountA.id,
      }),
      'account_archived',
    );
    await archived(
      await admin.raw('POST', '/api/transfers', {
        fromAccountId: s.accountA.id,
        toAccountId: s.accountB.id,
        amountCents: 100,
        transferredOn: today,
        description: 'Resto',
      }),
      'account_archived',
    );
    await archived(await importOfx(s.accountA.id), 'statement_account_archived');

    // O histórico continua: os lotes antigos e o estorno de uma baixa antiga.
    expect(await admin.get(`/api/statement-imports?accountId=${s.accountA.id}`)).toHaveLength(1);
    const reversed = await admin.post(`/api/settlements/${paid.settlements[0].id}/reverse`, { reason: 'erro', reversedOn: today });
    expect(reversed.status).toBe('open');
  });
});

describe('saldo atual sem o lançado com data futura (tarefa 130)', () => {
  it('a conta, a caixa e a visão geral mostram o saldo de hoje, com o agendado à parte', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Pagamento agendado',
      competenceDate: today,
      dueDate: addDays(today, 10),
      amountCents: 20_000,
      mirrorCaixaId: null,
    });
    await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: addDays(today, 10),
      amountCents: 20_000,
      financialAccountId: s.accountA.id,
    });
    // Uma conta que abre amanhã: o saldo inicial é lançado com data futura.
    await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'cash',
      name: 'Abre amanhã',
      openingBalanceCents: 3_000,
      openingDate: addDays(today, 1),
    });

    const atToday = await h.db.execute<{ cents: string }>(
      sql`SELECT financial_account_balance_at(${s.accountA.id}::uuid, ${today}::date) AS cents`,
    );
    expect(Number(atToday.rows[0]!.cents)).toBe(100_000);
    const accounts = await admin.get(`/api/accounts?caixaId=${s.caixaA.id}`);
    expect(accounts.find((a: { id: string }) => a.id === s.accountA.id)).toMatchObject({ balanceCents: 100_000, futureCents: -20_000 });
    expect(accounts.find((a: { name: string }) => a.name === 'Abre amanhã')).toMatchObject({ balanceCents: 0, futureCents: 3_000 });

    const caixa = await admin.get(`/api/caixas/${s.caixaA.id}`);
    expect(caixa).toMatchObject({ balanceCents: 100_000, futureCents: -17_000 });
    const [day] = await admin.get(`/api/calendar/balances?caixaId=${s.caixaA.id}&from=${today}&to=${today}`);
    expect(day.realizedCents).toBe(caixa.balanceCents);
    const [accountDay] = await admin.get(`/api/calendar/balances?accountId=${s.accountA.id}&from=${today}&to=${today}`);
    expect(accountDay.realizedCents).toBe(100_000);

    const statement = await admin.get(`/api/accounts/${s.accountA.id}/statement`);
    expect(statement.account).toMatchObject({ balanceCents: 100_000, futureCents: -20_000 });
    const overview = await admin.get('/api/overview');
    expect(overview.caixas.find((c: { id: string }) => c.id === s.caixaA.id)).toMatchObject({
      balanceCents: 100_000,
      futureCents: -17_000,
    });
    expect(overview.totals.futureCents).toBe(overview.caixas.reduce((sum: number, c: { futureCents: number }) => sum + c.futureCents, 0));
  });
});
