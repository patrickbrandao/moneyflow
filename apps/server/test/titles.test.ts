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

  it('pelo espelho, só quem edita também o original exclui, arquiva, cancela ou encerra a série (tarefa 079)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const authorUser = await userSession(h);
    const otherUser = await userSession(h);
    await admin.put(`/api/users/${authorUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    await admin.put(`/api/users/${otherUser.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'editor' }] });
    const author = client(h, authorUser.cookie);
    const other = client(h, otherUser.cookie);

    // Título avulso: o editor só da caixa B não exclui, cancela, reabre nem restaura o par.
    const single = await author.post('/api/titles', base(s));
    const mirrorId = single.mirror.id;
    const denied = async (method: 'POST' | 'DELETE', url: string) => {
      const res = await other.raw(method, url, {});
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.message).toMatch(/original/);
    };
    await denied('DELETE', `/api/titles/${mirrorId}`);
    await denied('POST', `/api/titles/${mirrorId}/cancel`);
    await denied('POST', `/api/titles/${mirrorId}/restore`);
    await admin.post(`/api/titles/${single.id}/cancel`);
    await denied('POST', `/api/titles/${mirrorId}/reopen`);
    await admin.post(`/api/titles/${single.id}/reopen`);
    expect(await admin.get(`/api/titles/${single.id}`)).toMatchObject({ status: 'open', archivedAt: null });
    // Aceitar e contestar continuam com ele.
    expect((await other.post(`/api/titles/${mirrorId}/mirror/dispute`, { reason: 'não reconheço' })).mirrorStatus).toBe('disputed');

    // Série: nem "só esta" nem "este e os próximos" pelo espelho.
    const today = todayIso();
    const first = await author.post('/api/titles', {
      ...base(s),
      dueDate: today,
      competenceDate: today,
      series: { kind: 'recurrence', frequency: 'monthly', endsOn: addMonths(today, 5) },
    });
    const ruleId = first.recurrenceRuleId;
    const inCaixa = async (caixaId: string) =>
      ((await admin.get(`/api/titles?caixaId=${caixaId}&limit=1000`)) as { id: string; recurrenceRuleId: string; occurrence: number }[])
        .filter((t) => t.recurrenceRuleId === ruleId)
        .sort((a, b) => a.occurrence - b.occurrence);
    const mirrors = await inCaixa(s.caixaB.id);
    expect(mirrors).toHaveLength(6);
    await denied('DELETE', `/api/titles/${mirrors[2]!.id}?scope=following`);
    await denied('DELETE', `/api/titles/${mirrors[2]!.id}?scope=this`);
    expect(await inCaixa(s.caixaA.id)).toHaveLength(6);
    expect((await admin.get(`/api/series/${ruleId}`)).endsOn).toBe(addMonths(today, 5));

    // Quem escreve nas duas caixas continua podendo.
    await admin.del(`/api/titles/${mirrors[2]!.id}?scope=following`);
    expect(await inCaixa(s.caixaA.id)).toHaveLength(2);
    expect(await inCaixa(s.caixaB.id)).toHaveLength(2);
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

    const over = await admin.post(
      `/api/titles/${title.id}/settlements`,
      { settledOn: '2026-10-17', amountCents: 60_000, financialAccountId: s.accountA.id },
      422,
    );
    expect(over.error.code).toBe('settlements_overpayment_check');
    expect(over.error.message).toMatch(/saldo em aberto/);

    const paid = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-17',
      amountCents: 50_000,
      financialAccountId: s.accountA.id,
    });
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
    const reversed = await admin.post(`/api/settlements/${settled.settlements[0].id}/reverse`, {
      reason: 'Pago em duplicidade',
      reversedOn: '2026-10-16',
    });
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

  it('sem escrita na caixa da outra conta, o estorno não desfaz a transferência (tarefa 081)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', { ...base(s), caixaId: s.caixaB.id, entityId: s.supplier.id, amountCents: 30_000 });
    const settled = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 30_000,
      financialAccountId: s.accountB.id,
      sourceAccountId: s.accountA.id,
    });
    const legId = settled.settlements[0].id;
    const editorB = await userSession(h);
    await admin.put(`/api/users/${editorB.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'editor' }] });
    const editor = client(h, editorB.cookie);
    const balanceA = async () => (await admin.get('/api/accounts')).find((a: { id: string }) => a.id === s.accountA.id).balanceCents;

    const denied = await editor.post(
      `/api/settlements/${legId}/reverse`,
      { reason: 'erro', reversedOn: '2026-10-16', undoTransfer: true },
      403,
    );
    expect(denied.error.message).toMatch(/sem desfazer a transferência/);
    expect(await admin.get(`/api/transfers?caixaId=${s.caixaA.id}`)).toHaveLength(1);
    expect(await balanceA()).toBe(70_000);

    // Sem desfazer, o estorno sai; a conta da caixa A não muda.
    const reversed = await editor.post(`/api/settlements/${legId}/reverse`, {
      reason: 'erro',
      reversedOn: '2026-10-16',
      undoTransfer: false,
    });
    expect(reversed.status).toBe('open');
    expect(await admin.get(`/api/transfers?caixaId=${s.caixaA.id}`)).toHaveLength(1);
    expect(await balanceA()).toBe(70_000);
  });

  it('baixas simultâneas nos dois lados do espelho não se travam (tarefa 188)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    for (let i = 0; i < 20; i += 1) {
      const title = await admin.post('/api/titles', { ...base(s), amountCents: 2_000 });
      const [a, b] = await Promise.all([
        admin.raw('POST', `/api/titles/${title.id}/settlements`, {
          settledOn: '2026-10-15',
          amountCents: 1_000,
          financialAccountId: s.accountA.id,
        }),
        admin.raw('POST', `/api/titles/${title.mirror.id}/settlements`, {
          settledOn: '2026-10-15',
          amountCents: 1_000,
          financialAccountId: s.accountB.id,
        }),
      ]);
      expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([200, 200]);
      expect((await admin.get(`/api/titles/${title.id}`)).status).toBe('paid');
    }
  }, 120_000);

  it('baixa do espelho: duas pernas; o lado sem acesso fica com conta a definir', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const authorUser = await userSession(h);
    await admin.put(`/api/users/${authorUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const author = client(h, authorUser.cookie);
    const title = await author.post('/api/titles', base(s));
    const settled = await author.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 90_000,
      financialAccountId: s.accountA.id,
    });
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
    const first = await admin.post('/api/titles', {
      ...base(s),
      dueDate: today,
      competenceDate: today,
      series: { kind: 'installments', count: 3 },
    });
    expect(first.occurrence).toBe(1);
    expect(first.installmentsTotal).toBe(3);
    const series = await admin.get(`/api/titles?caixaId=${s.caixaA.id}`);
    expect(
      series
        .filter((t: { recurrenceRuleId: string }) => t.recurrenceRuleId === first.recurrenceRuleId)
        .map((t: { occurrence: number }) => t.occurrence),
    ).toEqual([1, 2, 3]);
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

describe('esta e as próximas no formulário do título (tarefa 075)', () => {
  type Row = { id: string; occurrence: number; amountCents: number; categoryId: string; notes: string | null; dueDate: string };
  const seriesOf = async (c: ReturnType<typeof client>, caixaId: string, ruleId: string) =>
    ((await c.get(`/api/titles?caixaId=${caixaId}&limit=1000`)) as (Row & { recurrenceRuleId: string })[])
      .filter((t) => t.recurrenceRuleId === ruleId)
      .sort((a, b) => a.occurrence - b.occurrence);
  /** O corpo que o formulário manda: todos os campos, mudados ou não. */
  const formBody = (t: Row & { description: string; competenceDate: string; entityId: string }, change: Record<string, unknown>) => ({
    description: t.description,
    categoryId: t.categoryId,
    amountCents: t.amountCents,
    dueDate: t.dueDate,
    competenceDate: t.competenceDate,
    notes: t.notes,
    entityId: t.entityId,
    scope: 'following',
    ...change,
  });

  it('só o que mudou vai para as seguintes; o reajuste e as notas delas ficam', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const first = await admin.post('/api/titles', {
      ...base(s),
      entityId: s.supplier.id,
      mirrorCaixaId: null,
      description: 'Aluguel',
      dueDate: today,
      competenceDate: today,
      amountCents: 100_000,
      // Com fim: os testes seguintes do arquivo contam o que o worker cria.
      series: { kind: 'recurrence', frequency: 'monthly', endsOn: addMonths(today, 12) },
    });
    const ruleId = first.recurrenceRuleId;
    const all = await seriesOf(admin, s.caixaA.id, ruleId);
    expect(all).toHaveLength(13);
    // Reajuste a partir da 7ª e uma nota própria na 5ª.
    await admin.patch(`/api/series/${ruleId}`, { amountCents: 110_000, effectiveOn: all[6]!.dueDate });
    await admin.patch(`/api/titles/${all[4]!.id}`, { notes: 'nota da 5ª', scope: 'this' });

    // Na 3ª, troca só a categoria com "Este e os próximos" (corpo completo do formulário).
    const other = await admin.post('/api/categories', { kind: 'expense', name: `Moradia ${s.tag}`, colorSlot: 2 });
    const third = await admin.get(`/api/titles/${all[2]!.id}`);
    await admin.patch(`/api/titles/${third.id}`, formBody(third, { categoryId: other.id }));
    const after = await seriesOf(admin, s.caixaA.id, ruleId);
    expect(after.slice(2).every((t) => t.categoryId === other.id)).toBe(true);
    expect(after.slice(0, 2).every((t) => t.categoryId === s.expense.id)).toBe(true);
    expect(after.map((t) => t.amountCents)).toEqual([...Array(6).fill(100_000), ...Array(7).fill(110_000)]);
    expect(after[4]!.notes).toBe('nota da 5ª');

    // Mudar as notas com "Este e os próximos" leva as notas novas.
    const fourth = await admin.get(`/api/titles/${after[3]!.id}`);
    await admin.patch(`/api/titles/${fourth.id}`, formBody(fourth, { notes: 'reajuste combinado' }));
    const notes = (await seriesOf(admin, s.caixaA.id, ruleId)).map((t) => t.notes);
    expect(notes.slice(3).every((n) => n === 'reajuste combinado')).toBe(true);
    expect(notes.slice(0, 3).every((n) => n === null)).toBe(true);
  });

  it('valor e dia novos vão para as seguintes em aberto, sem as de mês fechado nem as com baixa', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const start = `${addMonths(todayIso(), -3).slice(0, 7)}-10`;
    const first = await admin.post('/api/titles', {
      ...base(s),
      description: 'Condomínio',
      dueDate: start,
      competenceDate: start,
      amountCents: 50_000,
      series: { kind: 'recurrence', frequency: 'monthly' },
    });
    expect(first.mirror).not.toBeNull();
    const ruleId = first.recurrenceRuleId;
    const all = await seriesOf(admin, s.caixaA.id, ruleId);
    // A 3ª fica num mês fechado; a 5ª tem baixa.
    await admin.post(`/api/caixas/${s.caixaA.id}/closings`, { month: `${all[2]!.dueDate.slice(0, 7)}-01`, force: true });
    await admin.post(`/api/titles/${all[4]!.id}/settlements`, { settledOn: todayIso(), amountCents: 1_000, financialAccountId: null });

    const second = await admin.get(`/api/titles/${all[1]!.id}`);
    await admin.patch(`/api/titles/${second.id}`, formBody(second, { amountCents: 55_000, dueDate: `${second.dueDate.slice(0, 7)}-20` }));
    const after = await seriesOf(admin, s.caixaA.id, ruleId);
    const day = (t: Row) => t.dueDate.slice(8);
    expect(after[0]).toMatchObject({ amountCents: 50_000, dueDate: start });
    expect(after[1]).toMatchObject({ amountCents: 55_000 });
    expect(day(after[1]!)).toBe('20');
    // Mês fechado e baixa: ficam como estavam.
    expect(after[2]).toMatchObject({ amountCents: 50_000, dueDate: all[2]!.dueDate });
    expect(after[4]).toMatchObject({ amountCents: 50_000, dueDate: all[4]!.dueDate });
    const moved = after.filter((_, i) => i === 3 || i >= 5);
    expect(moved.every((t) => t.amountCents === 55_000 && day(t) === '20')).toBe(true);
    // O espelho acompanha, e a série passa a vencer no dia 20 (as novas ocorrências também).
    const mirrors = await seriesOf(admin, s.caixaB.id, ruleId);
    expect(mirrors.map((m) => [m.amountCents, m.dueDate])).toEqual(after.map((t) => [t.amountCents, t.dueDate]));
    expect((await admin.get(`/api/series/${ruleId}`)).anchorDay).toBe(20);
    await materializeAll(h.db, addMonths(todayIso(), 14));
    const last = (await seriesOf(admin, s.caixaA.id, ruleId)).at(-1)!;
    expect(day(last)).toBe('20');
    // Termina na última: os testes seguintes do arquivo contam o que o worker cria.
    await admin.post(`/api/series/${ruleId}/end`, { endsOn: last.dueDate });
  });
});

describe('encerrar série (spec 005)', () => {
  type Row = { id: string; occurrence: number; status: string; recurrenceRuleId: string; dueDate: string };
  const seriesOf = async (c: ReturnType<typeof client>, caixaId: string, ruleId: string) =>
    ((await c.get(`/api/titles?caixaId=${caixaId}&limit=1000`)) as Row[])
      .filter((t) => t.recurrenceRuleId === ruleId)
      .sort((a, b) => a.occurrence - b.occurrence);

  it('mantém N meses, cancela as seguintes com o espelho, bloqueia com baixa e estende depois', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const first = await admin.post('/api/titles', {
      ...base(s),
      description: 'Contrato Jorge',
      dueDate: today,
      competenceDate: today,
      amountCents: 50_000,
      series: { kind: 'recurrence', frequency: 'monthly' },
    });
    const ruleId = first.recurrenceRuleId;
    expect(first.mirror).not.toBeNull();
    const all = await seriesOf(admin, s.caixaA.id, ruleId);
    expect(all).toHaveLength(13);

    // Uma ocorrência depois da data com baixa bloqueia o encerramento.
    const sixth = all[5]!;
    await admin.post(`/api/titles/${sixth.id}/settlements`, { settledOn: today, amountCents: 10_000, financialAccountId: null });
    const keepUntil = addMonths(today, 2);
    const blockedPreview = await admin.get(`/api/titles/${first.id}/series/end?endsOn=${keepUntil}`);
    expect(blockedPreview.blocked.map((o: { occurrence: number }) => o.occurrence)).toEqual([6]);
    const refused = await admin.raw('POST', `/api/titles/${first.id}/series/end`, { endsOn: keepUntil });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('series_end_blocked');
    expect(refused.json().error.message).toContain('#6');
    expect((await seriesOf(admin, s.caixaA.id, ruleId)).every((t) => t.status !== 'canceled')).toBe(true);

    // Estornada a baixa, encerra mantendo 3 meses (1 a 3); a prévia bate com o resultado.
    const sixthDetail = await admin.get(`/api/titles/${sixth.id}`);
    await admin.post(`/api/settlements/${sixthDetail.settlements[0].id}/reverse`, { reason: 'contrato cancelado', reversedOn: today });
    const preview = await admin.get(`/api/titles/${first.id}/series/end?endsOn=${keepUntil}`);
    expect(preview.blocked).toEqual([]);
    expect(preview.toCancel).toHaveLength(10);
    const ended = await admin.post(`/api/titles/${all[1]!.id}/series/end`, { endsOn: keepUntil });
    expect(ended.toCancel.map((o: { occurrence: number }) => o.occurrence)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(ended.title.rule.endsOn).toBe(keepUntil);

    const after = await seriesOf(admin, s.caixaA.id, ruleId);
    expect(after).toHaveLength(13); // nada some: ficam canceladas, com histórico
    expect(after.filter((t) => t.status === 'canceled').map((t) => t.occurrence)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(after.slice(0, 3).every((t) => t.status === 'open')).toBe(true);
    const mirrors = await seriesOf(admin, s.caixaB.id, ruleId);
    expect(mirrors.filter((t) => t.status === 'canceled').map((t) => t.occurrence)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    // O worker não recria as canceladas nem passa do fim.
    expect((await materializeAll(h.db, addMonths(today, 30))).created).toBe(0);
    expect(await seriesOf(admin, s.caixaA.id, ruleId)).toHaveLength(13);

    // Estender até 5 meses reabre 4 a 6 (com o espelho); sem fim reabre o resto e volta a materializar.
    const extended = await admin.post(`/api/titles/${first.id}/series/end`, { endsOn: addMonths(today, 5) });
    expect(extended.toReopen.map((o: { occurrence: number }) => o.occurrence)).toEqual([4, 5, 6]);
    expect(extended.toCancel).toEqual([]);
    expect((await seriesOf(admin, s.caixaB.id, ruleId)).filter((t) => t.status === 'open').map((t) => t.occurrence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    const open = await admin.post(`/api/titles/${first.id}/series/end`, { endsOn: null });
    expect(open.toReopen).toHaveLength(7);
    expect(open.title.rule.endsOn).toBeNull();
    expect((await seriesOf(admin, s.caixaA.id, ruleId)).every((t) => t.status === 'open')).toBe(true);
    expect((await materializeAll(h.db, addMonths(today, 14))).created).toBeGreaterThanOrEqual(2);
  });

  it('um cancelamento avulso antes do fim anterior não é reaberto ao estender', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const first = await admin.post('/api/titles', {
      ...base(s),
      mirrorCaixaId: null,
      dueDate: today,
      competenceDate: today,
      series: { kind: 'recurrence', frequency: 'monthly', endsOn: addMonths(today, 3) },
    });
    const all = await seriesOf(admin, s.caixaA.id, first.recurrenceRuleId);
    expect(all).toHaveLength(4);
    await admin.post(`/api/titles/${all[1]!.id}/cancel`);
    const extended = await admin.post(`/api/titles/${first.id}/series/end`, { endsOn: addMonths(today, 5) });
    expect(extended.toReopen).toEqual([]);
    expect(extended.created).toBe(2);
    const after = await seriesOf(admin, s.caixaA.id, first.recurrenceRuleId);
    expect(after.map((t) => t.status)).toEqual(['open', 'canceled', 'open', 'open', 'open', 'open']);
  });

  it('parcelamento, data antes do início e leitor são recusados', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const installments = await admin.post('/api/titles', { ...base(s), series: { kind: 'installments', count: 3 } });
    await admin.post(`/api/titles/${installments.id}/series/end`, { endsOn: '2026-11-15' }, 422);
    const monthly = await admin.post('/api/titles', { ...base(s), series: { kind: 'recurrence', frequency: 'monthly' } });
    await admin.post(`/api/titles/${monthly.id}/series/end`, { endsOn: '2026-01-01' }, 422);

    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const viewer = client(h, viewerUser.cookie);
    await viewer.post(`/api/titles/${monthly.id}/series/end`, { endsOn: '2026-12-15' }, 403);
  });
});

describe('listagem cortada e os totais do filtro (tarefa 116)', () => {
  it('os totais contam o filtro inteiro, e o limite maior repete as mesmas primeiras linhas', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    // Cinco títulos no mesmo vencimento (o desempate é pelo id) e um sexto pago, fora do "em aberto".
    const amounts = [10_000, 20_000, 30_000, 40_000, 50_000];
    for (const [i, amountCents] of amounts.entries()) {
      await admin.post('/api/titles', { ...base(s), description: `Corte ${i}`, amountCents, mirrorCaixaId: null });
    }
    const paid = await admin.post('/api/titles', { ...base(s), description: 'Corte pago', amountCents: 7_000, mirrorCaixaId: null });
    await admin.post(`/api/titles/${paid.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 7_000,
      financialAccountId: s.accountA.id,
    });
    const partial = await admin.post('/api/titles', { ...base(s), description: 'Corte parcial', amountCents: 9_000, mirrorCaixaId: null });
    await admin.post(`/api/titles/${partial.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 4_000,
      financialAccountId: s.accountA.id,
    });

    const filter = `caixaId=${s.caixaA.id}&direction=payable&status=unpaid`;
    const firstPage = await admin.get(`/api/titles?${filter}&limit=2`);
    expect(firstPage).toHaveLength(2);
    const totals = await admin.get(`/api/titles/totals?${filter}&limit=2`);
    // O limite não conta nos totais: os 5 + o parcial; o pago fica de fora pelo filtro.
    expect(totals).toEqual({ count: 6, amountCents: 150_000 + 9_000, openCents: 150_000 + 5_000 });

    // "Carregar mais" pede a mesma consulta com um limite maior: as primeiras linhas são as mesmas.
    const more = await admin.get(`/api/titles?${filter}&limit=4`);
    expect(more.slice(0, 2).map((r: { id: string }) => r.id)).toEqual(firstPage.map((r: { id: string }) => r.id));
    const all = await admin.get(`/api/titles?${filter}&limit=10`);
    expect(new Set(all.map((r: { id: string }) => r.id)).size).toBe(6);

    // Todos os status: entra o pago.
    const everything = await admin.get(`/api/titles/totals?caixaId=${s.caixaA.id}&direction=payable`);
    expect(everything.count).toBe(7);

    // Sem acesso à caixa, os totais respondem 404, como a lista.
    const outsider = client(h, (await userSession(h)).cookie);
    await outsider.get(`/api/titles/totals?caixaId=${s.caixaA.id}`, 404);
  });
});
