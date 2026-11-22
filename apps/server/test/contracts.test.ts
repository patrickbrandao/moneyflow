import { addMonths, spClock, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Access } from '../src/authz/access';
import { contractMaintenance } from '../src/services/contract-worker';
import { syncLifecycle } from '../src/services/contracts';
import { produceNotifications, recipientsByCaixa } from '../src/services/message-worker';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

/*
 * Contratos sobre séries (specs 020 e 034): o contrato com as obrigações
 * (séries nas contas, cofre inclusive, e cobranças esperadas no cartão), a
 * regra de reconhecimento pela série no extrato, o cofre, a fatura do cartão
 * e a não cobrada, aditivo, renovação, rescisão, documentos, espelho e avisos.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

type Scenario = Awaited<ReturnType<typeof scenario>>;

async function setup() {
  const session = await userSession(h, 'admin');
  const admin = client(h, session.cookie);
  const s = await scenario(h, admin);
  return { session, admin, s };
}

/** Aluguel de R$ 2.000,00 (dia 10) na conta corrente, com multa 2%, juros 1% a.m., desconto 5% e janela de 30 dias. */
const rentObligation = (s: Scenario, extra: Record<string, unknown> = {}) => ({
  kind: 'account',
  description: 'Aluguel',
  amountCents: 200_000,
  frequency: 'monthly',
  firstDueDate: '2026-11-10',
  accountId: s.accountA.id,
  lateFeePercent: 2,
  interestMonthPercent: 1,
  earlyDiscountPercent: 5,
  matchWindowDays: 30,
  ...extra,
});

/** Condomínio de R$ 500,00 (dia 5) pago em dinheiro: o cofre da caixa B. */
const condoObligation = (s: Scenario, extra: Record<string, unknown> = {}) => ({
  kind: 'account',
  description: 'Condomínio',
  amountCents: 50_000,
  frequency: 'monthly',
  firstDueDate: '2026-11-05',
  accountId: s.accountB.id,
  ...extra,
});

/** Contrato a pagar de nov/2026 a abr/2027 com o fornecedor, sem espelho. */
const lease = (s: Scenario, obligations: unknown[], extra: Record<string, unknown> = {}) => ({
  caixaId: s.caixaA.id,
  entityId: s.supplier.id,
  direction: 'payable',
  categoryId: s.expense.id,
  name: `Locação ${s.tag}`,
  contractNumber: `CT-${s.tag}`,
  startsOn: '2026-11-01',
  endsOn: '2027-04-30',
  mirrorCaixaId: null,
  obligations,
  ...extra,
});

const obligation = (contract: any, description: string) => contract.obligations.find((o: any) => o.description === description);

/** Fecha o mês na caixa direto no banco (sem as checagens da tela), como quem concluiu a conciliação. */
async function closeMonth(userId: string, caixaId: string, month: string) {
  await h.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true), set_config('app.actor_kind', 'human', true)`);
    await tx.execute(sql`INSERT INTO period_closings (caixa_id, month, closed_by_user_id) VALUES (${caixaId}, ${month}::date, ${userId})`);
  });
}

/** O ciclo de vida de um contrato pelo calendário, como o worker (acesso de sistema), sem tocar nos outros contratos do banco. */
async function lifecycle(contractId: string, today: string) {
  const access = new Access(
    { id: '00000000-0000-0000-0000-000000000000', username: 'system', email: '', role: 'admin', isActive: true },
    new Map(),
  );
  return h.db.transaction((tx) => syncLifecycle({ db: h.db, access, config: h.config }, tx, contractId, today));
}

async function occurrences(ruleId: string) {
  const result = await h.db.execute<{ id: string; occurrence: number; due_date: string; amount_cents: string; status: string }>(sql`
    SELECT id, occurrence, due_date, amount_cents, status FROM titles
     WHERE recurrence_rule_id = ${ruleId} AND mirror_status IS NULL ORDER BY occurrence`);
  return result.rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
}

/* ---------------- OFX de conta e de cartão ---------------- */

type StmtLine = { date: string; cents: number; memo: string };

function ofxOf(lines: StmtLine[], card = false) {
  const key = Math.random().toString(36).slice(2, 10);
  const trn = lines
    .map(
      (l, i) => `<STMTTRN><TRNTYPE>${l.cents < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${l.date.replaceAll('-', '')}120000</DTPOSTED>
<TRNAMT>${(l.cents / 100).toFixed(2)}</TRNAMT><FITID>${key}-${i}</FITID><NAME>${l.memo}</NAME></STMTTRN>`,
    )
    .join('\n');
  const dates = lines.map((l) => l.date.replaceAll('-', '')).sort();
  const list = `<BANKTRANLIST><DTSTART>${dates[0]}</DTSTART><DTEND>${dates.at(-1)}</DTEND>\n${trn}\n</BANKTRANLIST>`;
  return Buffer.from(
    card
      ? `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL</CURDEF>
<CCACCTFROM><ACCTID>4111********1111</ACCTID></CCACCTFROM>${list}</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`
      : `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>077</BANKID><ACCTID>1</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>${list}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  );
}

async function importOfx(cookie: string, target: string, lines: StmtLine[], card = false) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/statement-imports?${target}&fileName=${card ? 'fatura' : 'extrato'}.ofx`,
    payload: ofxOf(lines, card),
    headers: { cookie, 'content-type': 'application/x-ofx' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/* ---------------- cadastro ---------------- */

describe('cadastro com obrigações (spec 034)', () => {
  it('contrato com duas obrigações em contas diferentes (corrente e cofre de outra caixa): séries com a conta em cada ocorrência', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s), condoObligation(s)]));
    expect(contract).toMatchObject({ status: 'active', startsOn: '2026-11-01', endsOn: '2027-04-30', obligationCount: 2 });
    expect(contract.cycles).toEqual([expect.objectContaining({ seq: 1, startsOn: '2026-11-01', endsOn: '2027-04-30', legacy: null })]);

    const rent = obligation(contract, 'Aluguel');
    const condo = obligation(contract, 'Condomínio');
    expect(rent).toMatchObject({
      kind: 'account',
      caixaId: s.caixaA.id,
      contractId: contract.id,
      accountId: s.accountA.id,
      accountKind: 'checking',
      amountCents: 200_000,
      frequency: 'monthly',
      anchorDay: 10,
      endsOn: '2027-04-30',
      terms: {
        lateFeePercent: 2,
        interestMonthPercent: 1,
        earlyDiscountPercent: 5,
        matchWindowDays: 30,
        toleranceCents: 0,
        autoSettle: false,
      },
      openCount: 6,
    });
    // O condomínio mora onde o dinheiro se move: a caixa do cofre (B), não a do contrato.
    expect(condo).toMatchObject({ caixaId: s.caixaB.id, accountId: s.accountB.id, accountKind: 'cash', anchorDay: 5, openCount: 6 });
    expect(condo.terms).toMatchObject({ matchWindowDays: 15, lateFeePercent: null });

    // As ocorrências são títulos normais: série, contrato, conta prevista e a descrição sem n/N.
    const rows = await occurrences(rent.id);
    expect(rows.map((r) => r.due_date)).toEqual(['2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10', '2027-03-10', '2027-04-10']);
    const title = await admin.get(`/api/titles/${rows[0]!.id}`);
    expect(title).toMatchObject({
      origin: 'recurrence',
      contractId: contract.id,
      contractName: contract.name,
      description: 'Aluguel',
      occurrence: 1,
      plannedAccountId: s.accountA.id,
      plannedAccountKind: 'checking',
      competenceDate: '2026-11-01',
    });
    expect(title.rule).toMatchObject({ id: rent.id, caixaId: s.caixaA.id, contractId: contract.id, terms: { lateFeePercent: 2 } });
    const condoTitle = await admin.get(`/api/titles/${(await occurrences(condo.id))[0]!.id}`);
    expect(condoTitle).toMatchObject({ caixaId: s.caixaB.id, contractId: contract.id, plannedAccountKind: 'cash', direction: 'payable' });

    // A lista: vigência, obrigações e a próxima ocorrência.
    const list = await admin.get(`/api/contracts?caixaId=${s.caixaA.id}&status=current`);
    const row = list.find((c: any) => c.id === contract.id);
    expect(row).toMatchObject({ obligationCount: 2, withoutAccount: 0, nextOccurrence: { dueDate: '2026-11-05', amountCents: 50_000 } });

    // Vigente: a vigência só muda por renovar/rescindir; o resto da configuração fica livre.
    await admin.patch(`/api/contracts/${contract.id}`, { endsOn: '2027-12-31' }, 422);
    expect(await admin.patch(`/api/contracts/${contract.id}`, { autoRenew: true, noticeDays: 45 })).toMatchObject({
      autoRenew: true,
      noticeDays: 45,
    });
    // Toda escrita sai com o ator humano na auditoria.
    const audit = await h.db.execute<{ actor_kind: string }>(
      sql`SELECT DISTINCT actor_kind FROM audit_log WHERE table_name IN ('contracts', 'recurrence_rules') AND record_id IN (${contract.id}, ${rent.id})`,
    );
    expect(audit.rows.map((r) => r.actor_kind)).toEqual(['human']);
  });

  it('rascunho sem obrigações, ativar e acrescentar; validações da obrigação e o teto da tolerância', async () => {
    const { admin, s } = await setup();
    const draft = await admin.post('/api/contracts', lease(s, [], { endsOn: null, contractNumber: null }));
    expect(draft).toMatchObject({ status: 'draft', endsOn: null, obligations: [] });
    // Rascunho não tem obrigações.
    await admin.post(`/api/contracts/${draft.id}/obligations`, rentObligation(s), 422);
    await admin.post('/api/contracts', lease(s, [rentObligation(s)], { activate: false }), 400);
    expect((await admin.patch(`/api/contracts/${draft.id}`, { endsOn: '2027-04-30' })).endsOn).toBe('2027-04-30');
    expect((await admin.post(`/api/contracts/${draft.id}/activate`)).status).toBe('active');
    const added = await admin.post(`/api/contracts/${draft.id}/obligations`, rentObligation(s, { endsOn: '2027-01-31' }));
    expect(obligation(added, 'Aluguel')).toMatchObject({ endsOn: '2027-01-31', openCount: 3 });

    // Categoria de outra direção, conta de uma caixa da contraparte, cartão em contrato a receber, tolerância acima de 10%.
    await admin.post(`/api/contracts/${draft.id}/obligations`, rentObligation(s, { categoryId: s.income.id }), 422);
    await admin.post(`/api/contracts/${draft.id}/obligations`, rentObligation(s, { toleranceCents: 20_001 }), 422);
    const ok = await admin.post(
      `/api/contracts/${draft.id}/obligations`,
      rentObligation(s, { description: 'Taxa', toleranceCents: 20_000 }),
    );
    expect(obligation(ok, 'Taxa').terms.toleranceCents).toBe(20_000);
    const receivable = await admin.post(
      '/api/contracts',
      lease(s, [], { entityId: s.holderB.id, direction: 'receivable', categoryId: s.income.id, contractNumber: null, activate: true }),
    );
    // A conta é da caixa B, cujo titular é a contraparte (holderB).
    await admin.post(`/api/contracts/${receivable.id}/obligations`, condoObligation(s, { categoryId: s.income.id }), 422);
    await admin.post(
      `/api/contracts/${receivable.id}/obligations`,
      { kind: 'card', description: 'X', amountCents: 100, firstDueDate: '2026-11-15', cardCaixaId: s.caixaA.id },
      422,
    );

    // Excluir: rascunho some; vigente arquiva.
    const other = await admin.post('/api/contracts', lease(s, [], { contractNumber: null }));
    expect(await admin.del(`/api/contracts/${other.id}`)).toEqual({ deleted: true, archived: false });
    expect(await admin.del(`/api/contracts/${draft.id}`)).toEqual({ deleted: false, archived: true });
    expect((await admin.post(`/api/contracts/${draft.id}/restore`)).archivedAt).toBeNull();
  });

  it('ligar uma série solta ao contrato e desligar; a série precisa ter a direção e a contraparte do contrato', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s)]));
    const loose = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'IPTU',
      competenceDate: '2026-11-01',
      dueDate: '2026-11-20',
      amountCents: 30_000,
      mirrorCaixaId: null,
      plannedAccountId: s.accountA.id,
      series: { kind: 'recurrence', frequency: 'monthly', intervalCount: 1, endsOn: '2027-02-28' },
    });
    expect(loose.rule).toMatchObject({ caixaId: s.caixaA.id, contractId: null, terms: { matchWindowDays: 15 } });
    const unlinked = await admin.get(`/api/series?caixaId=${s.caixaA.id}&unlinked=1`);
    expect(unlinked.map((r: any) => r.id)).toContain(loose.rule.id);

    const linked = await admin.post(`/api/contracts/${contract.id}/obligations/link`, { ruleId: loose.rule.id });
    expect(obligation(linked, 'IPTU')).toMatchObject({ contractId: contract.id, openCount: 4 });
    expect((await admin.get(`/api/titles/${loose.id}`)).contractId).toBe(contract.id);
    // Outra contraparte não liga.
    const otherSeries = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.holderB.id,
      categoryId: s.expense.id,
      description: 'Outro',
      competenceDate: '2026-11-01',
      dueDate: '2026-11-20',
      amountCents: 1_000,
      mirrorCaixaId: null,
      series: { kind: 'recurrence', frequency: 'monthly', intervalCount: 1, endsOn: '2027-01-31' },
    });
    await admin.post(`/api/contracts/${contract.id}/obligations/link`, { ruleId: otherSeries.rule.id }, 422);
    // Desligar pela série: as ocorrências voltam a não ter contrato.
    const series = await admin.patch(`/api/series/${loose.rule.id}`, { contractId: null });
    expect(series.contractId).toBeNull();
    expect((await admin.get(`/api/titles/${loose.id}`)).contractId).toBeNull();
  });
});

/* ---------------- reconhecimento no extrato ---------------- */

describe('reconhecer o pagamento pela série (specs 033 e 034)', () => {
  it('aluguel atrasado com multa e juros, desconto antes do vencimento e o atraso pagando a mais antiga, baixados pelo extrato', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s), condoObligation(s)]));
    const rent = obligation(contract, 'Aluguel');
    const rows = await occurrences(rent.id);
    // Fevereiro pago à mão adiantado (janeiro fica em aberto).
    await admin.post(`/api/titles/${rows[3]!.id}/settlements`, {
      settledOn: '2027-02-02',
      amountCents: 200_000,
      financialAccountId: s.accountA.id,
    });

    const imp = await importOfx(session.cookie, `accountId=${s.accountA.id}`, [
      // Novembro 10 dias atrasado: multa 2% = 40,00; juros 1% a.m. × 10/30 = 6,67.
      { date: '2026-11-20', cents: -204_667, memo: 'PIX ALUGUEL NOVEMBRO' },
      // Dezembro 2 dias antes, com o desconto de 5%.
      { date: '2026-12-08', cents: -190_000, memo: 'PIX ALUGUEL DEZEMBRO' },
      // O valor do aluguel em fevereiro (já pago): paga janeiro, o mais antigo em aberto da janela.
      { date: '2027-02-08', cents: -200_000, memo: 'PIX ALUGUEL' },
    ]);
    const [nov, dec, feb] = imp.lines;
    expect(imp.lines.map((l: any) => l.status)).toEqual(['suggested', 'suggested', 'suggested']);
    expect(nov.titleId).toBe(rows[0]!.id);
    expect(nov.target.series).toMatchObject({
      ruleId: rent.id,
      contractId: contract.id,
      occurrence: 1,
      sameAccount: true,
      split: { kind: 'charges', amountCents: 200_000, fineCents: 4_000, interestCents: 667, discountCents: 0, days: 10 },
    });
    expect(dec.titleId).toBe(rows[1]!.id);
    expect(dec.target.series.split).toMatchObject({ kind: 'discount', discountCents: 10_000, days: -2 });
    expect(feb.titleId).toBe(rows[2]!.id);

    // Os candidatos trazem a repartição; o condomínio do cofre (outra caixa) não aparece na conta corrente.
    const candidates = await admin.get(`/api/statement-lines/${nov.id}/candidates`);
    expect(candidates[0]).toMatchObject({ kind: 'title', id: rows[0]!.id, series: { split: { fineCents: 4_000 } } });
    expect(candidates.some((c: any) => c.series?.ruleId === obligation(contract, 'Condomínio').id)).toBe(false);

    expect(await admin.post('/api/statement-lines/confirm', { lineIds: [nov.id, dec.id, feb.id] })).toEqual({ confirmed: 3, failed: [] });
    const novTitle = await admin.get(`/api/titles/${rows[0]!.id}`);
    expect(novTitle.status).toBe('paid');
    // Baixa na conta da linha, sem transferência.
    expect(novTitle.settlements[0]).toMatchObject({
      amountCents: 200_000,
      fineCents: 4_000,
      interestCents: 667,
      cashCents: 204_667,
      financialAccountId: s.accountA.id,
      transferId: null,
    });
    const matched = (await admin.get(`/api/statement-imports/${imp.id}`)).lines[0];
    expect(matched).toMatchObject({ status: 'matched', createdEntry: 'settlement' });

    // Pagamentos: as duas obrigações, com os dias e o resumo.
    const payments = await admin.get(`/api/contracts/${contract.id}/payments?cycleId=${contract.cycles[0].id}`);
    const rentRows = payments.rows.filter((r: any) => r.ruleId === rent.id);
    expect(rentRows).toHaveLength(6);
    expect(rentRows[0]).toMatchObject({
      kind: 'title',
      occurrence: 1,
      paidOn: '2026-11-20',
      days: 10,
      fineCents: 4_000,
      interestCents: 667,
      lastOrigin: 'reconciliation',
      accountName: 'Banco A',
    });
    expect(rentRows[1]).toMatchObject({ paidOn: '2026-12-08', days: -2, discountCents: 10_000 });
    expect(rentRows[2]).toMatchObject({ paidOn: '2027-02-08', days: 29 });
    expect(rentRows[3]).toMatchObject({ paidOn: '2027-02-02', days: -8, lastOrigin: 'manual' });
    expect(rentRows[4]).toMatchObject({ status: 'open', plannedAccountName: 'Banco A' });
    expect(payments.summary).toMatchObject({ occurrences: 12, paid: 4, onTimePercent: 50, maxDelayDays: 29, chargesCents: 4_667 });
    const november = payments.months.find((m: any) => m.month === '2026-11-01');
    // Previsto: aluguel + condomínio; pago: o principal do aluguel.
    expect(november).toEqual({ month: '2026-11-01', plannedCents: 250_000, paidCents: 200_000, chargesCents: 4_667, discountCents: 0 });
  });

  it('baixar sem confirmação pela série: só o candidato único, com o aviso do sino; a série sem ajustes casa só no valor exato', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s)]));
    const rent = obligation(contract, 'Aluguel');
    const rows = await occurrences(rent.id);
    const updated = await admin.patch(`/api/series/${rent.id}`, { autoSettle: true, toleranceCents: 500 });
    expect(updated.terms).toMatchObject({ autoSettle: true, toleranceCents: 500 });
    await admin.patch(`/api/series/${rent.id}`, { toleranceCents: 20_001 }, 422);

    const imp = await importOfx(session.cookie, `accountId=${s.accountA.id}`, [
      { date: '2026-11-10', cents: -200_000, memo: 'PIX ALUGUEL' },
      { date: '2026-12-10', cents: -100_000, memo: 'PIX ALUGUEL METADE' },
      { date: '2027-01-12', cents: -199_800, memo: 'PIX ALUGUEL' },
    ]);
    const [nov, dec, jan] = imp.lines;
    expect(nov).toMatchObject({ status: 'matched', createdEntry: 'settlement', autoSettled: true });
    expect((await admin.get(`/api/titles/${rows[0]!.id}`)).status).toBe('paid');
    // Parcial e só pela tolerância: sugestão.
    expect(dec).toMatchObject({ status: 'suggested', autoSettled: false });
    expect(dec.target.series.split).toMatchObject({ kind: 'partial', amountCents: 100_000 });
    expect(jan.target.series.split.kind).toBe('tolerance');
    const bell = await admin.get('/api/notifications?limit=50');
    expect(bell.items.find((n: any) => n.link?.includes(imp.id))).toMatchObject({
      kind: 'system',
      title: '1 ocorrência(s) de série baixada(s) sem confirmação',
    });
    expect((await admin.get(`/api/contracts/${contract.id}/payments`)).rows[0]).toMatchObject({ lastOrigin: 'auto', days: 0 });
    const undone = await admin.post(`/api/statement-lines/${nov.id}/unmatch`, { deleteEntry: true });
    expect(undone).toMatchObject({ status: 'new', autoSettled: false, createdEntry: null });
    expect((await admin.get(`/api/titles/${rows[0]!.id}`)).status).toBe('open');

    // Série recorrente comum (sem contrato): a regra vale para ela; sem ajustes, só o valor exato no mês ou na janela.
    const light = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.holderB.id,
      categoryId: s.expense.id,
      description: 'Energia',
      competenceDate: '2026-11-01',
      dueDate: '2026-11-03',
      amountCents: 15_000,
      mirrorCaixaId: null,
      plannedAccountId: s.accountA.id,
      series: { kind: 'recurrence', frequency: 'monthly', intervalCount: 1, endsOn: '2027-01-31' },
    });
    const late = await importOfx(session.cookie, `accountId=${s.accountA.id}`, [{ date: '2026-11-25', cents: -15_000, memo: 'CONTA LUZ' }]);
    expect(late.lines[0]).toMatchObject({ status: 'suggested', titleId: light.id });
    expect(late.lines[0].target.series).toMatchObject({ contractId: null, ruleId: light.rule.id, split: { kind: 'exact', days: 22 } });
  });

  it('cofre: os previstos da conta, "Baixar" e o "É o pagamento de…?" do lançamento avulso', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [condoObligation(s, { lateFeePercent: 2 })]));
    const condo = obligation(contract, 'Condomínio');
    const planned = await admin.get(`/api/titles?plannedAccountId=${s.accountB.id}&status=unpaid`);
    expect(planned.map((t: any) => t.dueDate)).toEqual([
      '2026-11-05',
      '2026-12-05',
      '2027-01-05',
      '2027-02-05',
      '2027-03-05',
      '2027-04-05',
    ]);

    // Avulso de R$ 510,00 com o fornecedor no dia 12/11: casa com novembro (atraso de 7 dias, com a multa).
    const matches = await admin.get(
      `/api/accounts/${s.accountB.id}/obligation-matches?occurredOn=2026-11-12&amountCents=-51000&entityId=${s.supplier.id}`,
    );
    expect(matches).toEqual([
      expect.objectContaining({
        titleId: planned[0].id,
        ruleId: condo.id,
        contractName: contract.name,
        split: expect.objectContaining({ kind: 'charges', fineCents: 1_000, days: 7 }),
      }),
    ]);
    // Outra entidade ou outro valor: nada.
    expect(
      await admin.get(
        `/api/accounts/${s.accountB.id}/obligation-matches?occurredOn=2026-11-12&amountCents=-51000&entityId=${s.holderA.id}`,
      ),
    ).toEqual([]);
    expect(await admin.get(`/api/accounts/${s.accountB.id}/obligation-matches?occurredOn=2026-11-12&amountCents=-90000`)).toEqual([]);

    // "Baixar a ocorrência": a baixa e o movimento no cofre.
    const m = matches[0];
    const settled = await admin.post(`/api/titles/${m.titleId}/settlements`, {
      settledOn: '2026-11-12',
      amountCents: m.split.amountCents,
      fineCents: m.split.fineCents,
      interestCents: m.split.interestCents,
      discountCents: m.split.discountCents,
      financialAccountId: s.accountB.id,
    });
    expect(settled.status).toBe('paid');
    const statement = await admin.get(`/api/accounts/${s.accountB.id}/statement?from=2026-11-01&to=2026-11-30`);
    expect(statement.rows.map((r: any) => r.amountCents)).toEqual([-51_000]);
    const payments = await admin.get(`/api/contracts/${contract.id}/payments`);
    expect(payments.rows[0]).toMatchObject({ status: 'paid', days: 7, fineCents: 1_000, accountName: 'Cofre B', lastOrigin: 'manual' });
    expect((await admin.get(`/api/titles?plannedAccountId=${s.accountB.id}&status=unpaid`)).length).toBe(5);
  });
});

/* ---------------- cartão ---------------- */

describe('obrigação no cartão (spec 034)', () => {
  async function cardSetup() {
    const { session, admin, s } = await setup();
    const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${s.tag}` });
    const card = await admin.post('/api/caixas', {
      name: `Cartão ${s.tag}`,
      kind: 'credit_card',
      holderEntityId: issuer.id,
      defaultPayerCaixaId: s.caixaA.id,
      creditLimitCents: 500_000,
      closingDay: 25,
      dueDay: 5,
      cardLast4: '1111',
    });
    const contract = await admin.post(
      '/api/contracts',
      lease(s, [
        {
          kind: 'card',
          description: 'Streaming',
          amountCents: 5_990,
          firstDueDate: '2026-11-15',
          cardCaixaId: card.id,
          toleranceCents: 100,
        },
      ]),
    );
    return { session, admin, s, card, contract, rule: obligation(contract, 'Streaming') };
  }

  it('a cobrança esperada casa na fatura ("Lançar como cobrança de…"), a compra à mão liga à ocorrência e a não cobrada avisa uma vez', async () => {
    const { session, admin, s, card, contract, rule } = await cardSetup();
    expect(rule).toMatchObject({
      kind: 'card',
      caixaId: card.id,
      payerCaixaId: s.caixaA.id,
      amountCents: 5_990,
      direction: 'payable',
      entityId: s.supplier.id,
    });
    // Sem títulos: as ocorrências são calculadas pelo calendário.
    expect(await occurrences(rule.id)).toEqual([]);

    const imp = await importOfx(
      session.cookie,
      `cardCaixaId=${card.id}`,
      [{ date: '2026-11-16', cents: -5_990, memo: 'STREAMFLIX' }],
      true,
    );
    const [line] = imp.lines;
    expect(line.status).toBe('new');
    expect(line.cardCharge).toMatchObject({
      ruleId: rule.id,
      occurrence: 1,
      dueDate: '2026-11-15',
      expectedCents: 5_990,
      contractId: contract.id,
    });
    const candidates = await admin.get(`/api/statement-lines/${line.id}/candidates`);
    expect(candidates[0]).toMatchObject({ kind: 'card_charge', id: `${rule.id}:1`, series: { occurrence: 1 } });

    const charged = await admin.post(`/api/statement-lines/${line.id}/card-charge`, { ruleId: rule.id, occurrence: 1 });
    expect(charged).toMatchObject({ status: 'matched', createdEntry: 'purchase' });
    const purchase = await h.db.execute<{
      contract_id: string;
      recurrence_rule_id: string;
      occurrence: number;
      payer_caixa_id: string;
    }>(sql`
      SELECT p.contract_id, p.recurrence_rule_id, p.occurrence, p.payer_caixa_id FROM card_purchases p
        JOIN card_invoice_items i ON i.card_purchase_id = p.id WHERE i.id = ${charged.cardInvoiceItemId}`);
    expect(purchase.rows[0]).toMatchObject({
      contract_id: contract.id,
      recurrence_rule_id: rule.id,
      occurrence: 1,
      payer_caixa_id: s.caixaA.id,
    });
    // A mesma ocorrência não recebe outra compra.
    await admin.post(
      `/api/cards/${card.id}/purchases`,
      {
        entityId: s.supplier.id,
        categoryId: s.expense.id,
        purchasedOn: '2026-11-17',
        description: 'Duplicada',
        amountCents: 5_990,
        charge: { ruleId: rule.id, occurrence: 1 },
      },
      409,
    );

    // "É cobrança de um contrato?": as esperadas perto da data e do valor; a compra à mão liga à ocorrência 3.
    const expected = await admin.get(`/api/cards/${card.id}/expected-charges?date=2027-01-14&amountCents=5990`);
    expect(expected.map((e: any) => e.occurrence)).toEqual([3]);
    const manual = await admin.post(`/api/cards/${card.id}/purchases`, {
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      purchasedOn: '2027-01-14',
      description: 'Streaming jan',
      amountCents: 5_990,
      charge: { ruleId: rule.id, occurrence: 3 },
    });
    expect(manual).toMatchObject({ recurrenceRuleId: rule.id, occurrence: 3, contractId: contract.id, contractName: contract.name });

    // Dezembro: a fatura que fecha em 25/12 fecha sem a compra → não cobrada (e o aviso, uma vez por ocorrência).
    const overview = await admin.get(`/api/cards/${card.id}`);
    const december = overview.invoices.find((i: any) => i.closingDate === '2026-12-25');
    await admin.post(`/api/card-invoices/${december.id}/close`, {});
    const payments = await admin.get(`/api/contracts/${contract.id}/payments`);
    const cardRows = payments.rows.filter((r: any) => r.kind === 'card_charge');
    expect(cardRows.slice(0, 3).map((r: any) => [r.occurrence, r.status])).toEqual([
      [1, 'charged'],
      [2, 'not_charged'],
      [3, 'charged'],
    ]);
    expect(cardRows[0]).toMatchObject({ paidOn: '2026-11-16', days: 1, lastOrigin: 'reconciliation', settledCents: 5_990 });
    expect(cardRows[1]).toMatchObject({ notCharged: true, settledCents: 0 });
    expect(payments.summary.notCharged).toBe(1);

    const clock = spClock(new Date('2027-01-10T12:00:00-03:00'));
    await produceNotifications(h.db, h.config, clock);
    await produceNotifications(h.db, h.config, clock);
    const missing = await h.db.execute<{ n: number; title: string }>(sql`
      SELECT count(*)::int AS n, min(title) AS title FROM notifications
       WHERE kind = 'contract_charge_missing' AND dedup_key = ${`contract_charge_missing:${rule.id}:2`}
       GROUP BY user_id LIMIT 1`);
    expect(missing.rows[0]).toMatchObject({ n: 1, title: 'Cobrança não feita no cartão: Streaming de dez/2026' });
  });

  it('baixar sem confirmação na fatura, o aditivo muda o valor esperado dali em diante e o encerramento da série', async () => {
    const { session, admin, card, contract, rule } = await cardSetup();
    await admin.patch(`/api/series/${rule.id}`, { autoSettle: true });
    const imp = await importOfx(
      session.cookie,
      `cardCaixaId=${card.id}`,
      [
        { date: '2026-11-15', cents: -5_990, memo: 'STREAMFLIX' },
        { date: '2026-12-16', cents: -6_050, memo: 'STREAMFLIX' },
      ],
      true,
    );
    const [nov, dec] = imp.lines;
    expect(nov).toMatchObject({ status: 'matched', createdEntry: 'purchase', autoSettled: true });
    // Só pela tolerância: fica a sugestão.
    expect(dec).toMatchObject({ status: 'new', cardCharge: { occurrence: 2 } });

    const amended = await admin.post(`/api/contracts/${contract.id}/amendments`, {
      effectiveOn: '2027-02-01',
      ruleIds: [rule.id],
      amountCents: 6_490,
    });
    expect(amended.preview.cardFrom).toEqual([{ ruleId: rule.id, fromOccurrence: 4, beforeCents: 5_990, afterCents: 6_490 }]);
    const expected = await admin.get(`/api/cards/${card.id}/expected-charges?date=2027-01-31`);
    expect(expected.find((e: any) => e.occurrence === 4).expectedCents).toBe(6_490);
    expect(expected.find((e: any) => e.occurrence === 3).expectedCents).toBe(5_990);

    // A série no cartão encerra pela regra (não há títulos).
    const ended = await admin.post(`/api/series/${rule.id}/end`, { endsOn: '2027-02-28' });
    expect(ended).toMatchObject({ endsOn: '2027-02-28', series: { endsOn: '2027-02-28' } });
    const payments = await admin.get(`/api/contracts/${contract.id}/payments`);
    expect(payments.rows.filter((r: any) => r.kind === 'card_charge').map((r: any) => r.occurrence)).toEqual([1, 2, 3, 4]);
  });

  it('a cobrança no cartão não muda de dia (aditivo ou edição): as datas esperadas do passado ficam (tarefa 137)', async () => {
    const { admin, contract, rule } = await cardSetup();
    const dueDates = async () =>
      (await admin.get(`/api/contracts/${contract.id}/payments`)).rows
        .filter((r: any) => r.kind === 'card_charge')
        .map((r: any) => r.dueDate);
    const before = await dueDates();
    expect(before.slice(0, 2)).toEqual(['2026-11-15', '2026-12-15']);
    const amended = await admin.raw('POST', `/api/contracts/${contract.id}/amendments?dryRun=1`, {
      effectiveOn: '2027-03-01',
      ruleIds: [rule.id],
      anchorDay: 2,
    });
    expect(amended.statusCode).toBe(422);
    expect(amended.json().error.code).toBe('card_charge_anchor_day');
    const patched = await admin.raw('PATCH', `/api/series/${rule.id}`, { anchorDay: 2, effectiveOn: '2027-03-01' });
    expect(patched.statusCode).toBe(422);
    expect(await dueDates()).toEqual(before);
    // O resto da edição continua valendo no cartão.
    expect((await admin.patch(`/api/series/${rule.id}`, { description: 'Streaming HD', effectiveOn: '2027-03-01' })).description).toBe(
      'Streaming HD',
    );
  });
});

/* ---------------- aditivo, renovação e rescisão ---------------- */

describe('aditivo, renovação e rescisão como operações da série (spec 034)', () => {
  it('aditivo: "esta e as próximas" nas obrigações escolhidas a partir da data; ocorrências com baixa ficam', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s), condoObligation(s)]));
    const rent = obligation(contract, 'Aluguel');
    const condo = obligation(contract, 'Condomínio');
    const rows = await occurrences(rent.id);
    // Fevereiro com baixa parcial: não muda.
    await admin.post(`/api/titles/${rows[3]!.id}/settlements`, {
      settledOn: '2027-02-10',
      amountCents: 50_000,
      financialAccountId: s.accountA.id,
    });

    const body = { effectiveOn: '2027-01-01', ruleIds: [rent.id], amountCents: 220_000, anchorDay: 5 };
    const preview = await admin.post(`/api/contracts/${contract.id}/amendments?dryRun=1`, body);
    expect(preview.contract).toBeNull();
    expect(preview.preview.affected.map((a: any) => [a.occurrence, a.after.amountCents, a.after.dueDate])).toEqual([
      [3, 220_000, '2027-01-05'],
      [5, 220_000, '2027-03-05'],
      [6, 220_000, '2027-04-05'],
    ]);
    expect(preview.preview.skipped).toEqual([expect.objectContaining({ occurrence: 4, reason: 'settled' })]);
    expect((await occurrences(rent.id))[2]!.amount_cents).toBe(200_000);

    const applied = await admin.post(`/api/contracts/${contract.id}/amendments`, body);
    const after = await occurrences(rent.id);
    expect(after.map((r) => [r.due_date, r.amount_cents])).toEqual([
      ['2026-11-10', 200_000],
      ['2026-12-10', 200_000],
      ['2027-01-05', 220_000],
      ['2027-02-10', 200_000],
      ['2027-03-05', 220_000],
      ['2027-04-05', 220_000],
    ]);
    expect(obligation(applied.contract, 'Aluguel')).toMatchObject({ anchorDay: 5 });
    expect(applied.contract.amendments[0]).toMatchObject({
      effectiveOn: '2027-01-01',
      ruleIds: [rent.id],
      affectedCount: 3,
      skippedCount: 1,
      changes: { before: { amountCents: 200_000, anchorDay: 10 }, after: { amountCents: 220_000, anchorDay: 5 } },
    });

    // Reajuste em % no condomínio a partir de março.
    await admin.post(`/api/contracts/${contract.id}/amendments`, {
      effectiveOn: '2027-03-01',
      ruleIds: [condo.id],
      readjustmentPercent: 4.5,
    });
    expect((await occurrences(condo.id)).map((r) => r.amount_cents)).toEqual([50_000, 50_000, 50_000, 50_000, 52_250, 52_250]);
    // Obrigação de outro contrato não entra.
    const other = await admin.post('/api/contracts', lease(s, [rentObligation(s)], { contractNumber: null }));
    await admin.post(
      `/api/contracts/${contract.id}/amendments`,
      { effectiveOn: '2027-03-01', ruleIds: [obligation(other, 'Aluguel').id], amountCents: 1 },
      404,
    );
  });

  it('renovar estende a vigência e as obrigações; o worker renova sozinho (com aviso) ou encerra', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s)]));
    const rent = obligation(contract, 'Aluguel');
    const preview = await admin.post(`/api/contracts/${contract.id}/renew?dryRun=1`, { endsOn: '2027-10-31' });
    expect(preview.preview).toMatchObject({
      startsOn: '2027-05-01',
      endsOn: '2027-10-31',
      // A série acompanha a vigência: termina no novo fim (tarefa 087).
      rules: [{ ruleId: rent.id, endsOn: '2027-10-31', kind: 'account' }],
    });
    await admin.post(`/api/contracts/${contract.id}/renew`, { endsOn: '2027-04-30' }, 422);
    const renewed = await admin.post(`/api/contracts/${contract.id}/renew`, { endsOn: '2027-10-31' });
    expect(renewed.contract).toMatchObject({ status: 'active', endsOn: '2027-10-31' });
    expect(renewed.contract.cycles.map((y: any) => [y.seq, y.startsOn, y.endsOn])).toEqual([
      [2, '2027-05-01', '2027-10-31'],
      [1, '2026-11-01', '2027-04-30'],
    ]);
    const horizon = addMonths(todayIso(), 12);
    const expectedDue = ['2027-05-10', '2027-06-10', '2027-07-10', '2027-08-10', '2027-09-10', '2027-10-10'].filter((d) => d <= horizon);
    expect((await occurrences(rent.id)).map((r) => r.due_date).slice(6)).toEqual(expectedDue);

    // Indeterminado não renova.
    const open = await admin.post('/api/contracts', lease(s, [], { endsOn: null, contractNumber: null, activate: true }));
    await admin.post(`/api/contracts/${open.id}/renew`, { endsOn: '2030-01-01' }, 422);

    // Worker: renovação automática (pelo mesmo prazo até cobrir hoje) e o encerramento de quem não renova.
    const past = { startsOn: '2026-01-01', endsOn: '2026-06-30', contractNumber: null };
    const auto = await admin.post(
      '/api/contracts',
      lease(s, [rentObligation(s, { firstDueDate: '2026-01-10' })], { ...past, autoRenew: true }),
    );
    const stop = await admin.post('/api/contracts', lease(s, [rentObligation(s, { firstDueDate: '2026-01-10' })], past));
    const result = await contractMaintenance(h.db, todayIso(), (ids) => recipientsByCaixa(h.db, ids));
    expect(result.failed).toBe(0);
    const autoAfter = await admin.get(`/api/contracts/${auto.id}`);
    expect(autoAfter.status).toBe('active');
    expect(autoAfter.endsOn >= todayIso()).toBe(true);
    expect(autoAfter.cycles[0].startsOn).toBe('2026-07-01');
    expect(obligation(autoAfter, 'Aluguel').endsOn > '2026-06-30').toBe(true);
    expect((await admin.get(`/api/contracts/${stop.id}`)).status).toBe('ended');
    const notice = await h.db.execute<{ title: string }>(
      sql`SELECT title FROM notifications WHERE dedup_key = ${`contract_renewed:${auto.id}:2`} LIMIT 1`,
    );
    expect(notice.rows[0]?.title).toContain('renovado automaticamente');
    // Encerrado pode ser renovado à mão.
    expect((await admin.post(`/api/contracts/${stop.id}/renew`, { endsOn: '2027-06-30' })).contract.status).toBe('active');
  });

  it('renovar até o meio do mês ou com vencimento no dia 31 não perde a última ocorrência (tarefa 087)', async () => {
    const { admin, s } = await setup();
    const day31 = rentObligation(s, { description: 'Dia 31', amountCents: 10_000, firstDueDate: '2026-12-31' });
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s), day31]));
    const mid = await admin.post(`/api/contracts/${contract.id}/renew?dryRun=1`, { endsOn: '2027-08-15' });
    expect(mid.preview.rules.map((r: any) => r.endsOn)).toEqual(['2027-08-15', '2027-08-15']);
    await admin.post(`/api/contracts/${contract.id}/renew`, { endsOn: '2027-08-15' });
    const rent = obligation(contract, 'Aluguel');
    expect((await occurrences(rent.id)).map((r) => r.due_date).at(-1)).toBe('2027-08-10');
    // Renovar de novo até 31/10: a de dia 31 ganha a de outubro.
    const renewed = await admin.post(`/api/contracts/${contract.id}/renew`, { endsOn: '2027-10-31' });
    expect(obligation(renewed.contract, 'Dia 31').endsOn).toBe('2027-10-31');
    const due = (await occurrences(obligation(contract, 'Dia 31').id)).map((r) => r.due_date);
    expect(due.slice(-3)).toEqual(['2027-08-31', '2027-09-30', '2027-10-31']);
  });

  it('renovação automática atrasada: uma vigência por prazo e a seguinte pelo mesmo prazo (tarefa 086)', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post(
      '/api/contracts',
      lease(s, [rentObligation(s, { amountCents: 1_000, firstDueDate: '2023-01-10' })], {
        startsOn: '2023-01-01',
        endsOn: '2023-12-31',
        autoRenew: true,
        contractNumber: null,
      }),
    );
    expect(await lifecycle(contract.id, '2026-11-21')).toMatchObject({ action: 'renewed', seq: 4, endsOn: '2026-12-31' });
    let after = await admin.get(`/api/contracts/${contract.id}`);
    expect(after.cycles.map((y: any) => [y.seq, y.startsOn, y.endsOn])).toEqual([
      [4, '2026-01-01', '2026-12-31'],
      [3, '2025-01-01', '2025-12-31'],
      [2, '2024-01-01', '2024-12-31'],
      [1, '2023-01-01', '2023-12-31'],
    ]);
    expect(obligation(after, 'Aluguel').endsOn).toBe('2026-12-31');
    // A passada seguinte estende por 12 meses, não por 36.
    await lifecycle(contract.id, '2027-01-02');
    after = await admin.get(`/api/contracts/${contract.id}`);
    expect(after.endsOn).toBe('2027-12-31');
    expect(after.cycles[0]).toMatchObject({ seq: 5, startsOn: '2027-01-01', endsOn: '2027-12-31' });
    expect(obligation(after, 'Aluguel').endsOn).toBe('2027-12-31');
  });

  it('encerrado sem renovar: as obrigações sem fim (ou ligadas depois) terminam no fim; as com baixa ficam (tarefa 083)', async () => {
    const { admin, s } = await setup();
    const past = { startsOn: '2026-01-01', endsOn: '2026-06-30', contractNumber: null };
    const contract = await admin.post(
      '/api/contracts',
      lease(
        s,
        [
          rentObligation(s, { firstDueDate: '2026-01-10', endsOn: null }),
          rentObligation(s, { description: 'Até antes', firstDueDate: '2026-01-10', endsOn: '2026-03-31' }),
        ],
        past,
      ),
    );
    const rent = obligation(contract, 'Aluguel');
    expect(rent.endsOn).toBeNull();
    // Série solta sem fim, ligada depois; julho dela já pago.
    const loose = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'IPTU',
      competenceDate: '2026-01-01',
      dueDate: '2026-01-20',
      amountCents: 30_000,
      mirrorCaixaId: null,
      series: { kind: 'recurrence', frequency: 'monthly', intervalCount: 1, endsOn: null },
    });
    await admin.post(`/api/contracts/${contract.id}/obligations/link`, { ruleId: loose.rule.id });
    const iptu = await occurrences(loose.rule.id);
    await admin.post(`/api/titles/${iptu[7]!.id}/settlements`, {
      settledOn: '2026-08-20',
      amountCents: 30_000,
      financialAccountId: s.accountA.id,
    });

    expect(await lifecycle(contract.id, '2026-11-21')).toEqual({ action: 'ended' });
    const ended = await admin.get(`/api/contracts/${contract.id}`);
    expect(ended.status).toBe('ended');
    expect(obligation(ended, 'Aluguel').endsOn).toBe('2026-06-30');
    expect(obligation(ended, 'Até antes').endsOn).toBe('2026-03-31');
    const rentRows = await occurrences(rent.id);
    expect(rentRows.slice(0, 6).every((r) => r.status === 'open')).toBe(true);
    expect(rentRows.slice(6).every((r) => r.status === 'canceled')).toBe(true);
    expect(rentRows.length).toBeGreaterThan(6);
    // IPTU: termina no vencimento de agosto (pago); julho, sem baixa, sai junto com as seguintes.
    expect(obligation(ended, 'IPTU').endsOn).toBe('2026-08-20');
    expect((await occurrences(loose.rule.id)).slice(5, 9).map((r) => r.status)).toEqual(['open', 'canceled', 'paid', 'canceled']);
  });

  it('rescindir encerra as séries na data (canceladas sem apagar), ajusta a última ocorrência e lança a multa avulsa', async () => {
    const { admin, s } = await setup();
    const fee = rentObligation(s, { description: 'Taxa', amountCents: 1_000, firstDueDate: '2026-11-15', endsOn: '2026-12-31' });
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s), condoObligation(s), fee]));
    const rent = obligation(contract, 'Aluguel');
    const rows = await occurrences(rent.id);
    await admin.post(`/api/titles/${rows[0]!.id}/settlements`, {
      settledOn: '2026-11-10',
      amountCents: 200_000,
      financialAccountId: s.accountA.id,
    });

    const body = {
      terminatedOn: '2027-01-15',
      lastAmounts: [{ titleId: rows[2]!.id, amountCents: 96_774 }],
      penalty: { direction: 'payable', amountCents: 100_000, dueDate: '2027-02-10', categoryId: s.expense.id },
      notes: 'Mudança',
    };
    const preview = await admin.post(`/api/contracts/${contract.id}/terminate?dryRun=1`, body);
    expect(preview.preview.canceled.filter((c: any) => c.ruleId === rent.id).map((c: any) => c.occurrence)).toEqual([4, 5, 6]);
    expect(preview.preview.canceled).toHaveLength(6);
    expect(preview.preview.last.find((l: any) => l.ruleId === rent.id)).toMatchObject({
      titleId: rows[2]!.id,
      periodEnd: '2027-01-31',
      proratedCents: 96_774,
      settled: false,
    });

    const done = await admin.post(`/api/contracts/${contract.id}/terminate`, body);
    expect(done.contract).toMatchObject({
      status: 'terminated',
      terminatedOn: '2027-01-15',
      endsOn: '2027-01-15',
      terminationNotes: 'Mudança',
    });
    const after = await occurrences(rent.id);
    expect(after.map((r) => r.status)).toEqual(['paid', 'open', 'open', 'canceled', 'canceled', 'canceled']);
    expect(after[2]!.amount_cents).toBe(96_774);
    expect(obligation(done.contract, 'Aluguel').endsOn).toBe('2027-01-15');
    // A obrigação que já acabava antes da data não é estendida.
    expect(obligation(done.contract, 'Taxa').endsOn).toBe('2026-12-31');
    expect(done.contract.extraTitles).toEqual([expect.objectContaining({ amountCents: 100_000, direction: 'payable', status: 'open' })]);
    const penalty = await admin.get(`/api/titles/${done.contract.extraTitles[0].titleId}`);
    expect(penalty).toMatchObject({ origin: 'manual', contractId: contract.id, recurrenceRuleId: null });
    await admin.post(`/api/contracts/${contract.id}/renew`, { endsOn: '2028-01-01' }, 422);
    await admin.post(`/api/contracts/${contract.id}/terminate`, body, 422);
  });
});

describe('rescisão com a data em mês fechado (tarefa 138)', () => {
  it('a última ocorrência em mês fechado não muda, a multa pede competência aberta e a rescisão conclui', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post(
      '/api/contracts',
      lease(s, [rentObligation(s, { firstDueDate: '2026-08-10' })], { startsOn: '2026-08-01', endsOn: '2027-01-31', contractNumber: null }),
    );
    const rows = await occurrences(obligation(contract, 'Aluguel').id);
    await closeMonth(session.id, s.caixaA.id, '2026-09-01');
    const penalty = { direction: 'payable', amountCents: 50_000, dueDate: '2026-12-10', categoryId: s.expense.id };
    const body = { terminatedOn: '2026-09-15', lastAmounts: [{ titleId: rows[1]!.id, amountCents: 100_000 }] };

    const preview = await admin.post(`/api/contracts/${contract.id}/terminate?dryRun=1`, body);
    expect(preview.preview.last).toEqual([expect.objectContaining({ titleId: rows[1]!.id, closed: true, settled: false })]);
    expect(preview.preview.canceled.map((c: any) => c.occurrence)).toEqual([3, 4, 5, 6]);
    // A multa na competência da rescisão (setembro, fechado) é recusada já na prévia; numa competência aberta, entra.
    const refused = await admin.raw('POST', `/api/contracts/${contract.id}/terminate?dryRun=1`, { ...body, penalty });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: 'penalty_closed_month', message: expect.stringContaining('set/2026') });

    const done = await admin.post(`/api/contracts/${contract.id}/terminate`, {
      ...body,
      penalty: { ...penalty, competenceDate: '2026-11-01' },
    });
    expect(done.contract).toMatchObject({ status: 'terminated', terminatedOn: '2026-09-15' });
    const after = await occurrences(obligation(contract, 'Aluguel').id);
    expect(after.map((r) => r.status)).toEqual(['open', 'open', 'canceled', 'canceled', 'canceled', 'canceled']);
    expect(after[1]!.amount_cents).toBe(200_000);
    const fine = await admin.get(`/api/titles/${done.contract.extraTitles[0].titleId}`);
    expect(fine).toMatchObject({ competenceDate: '2026-11-01', amountCents: 50_000 });
  });
});

describe('rescisão e a sugestão do extrato (tarefa 129)', () => {
  it('a linha sugerida para uma ocorrência cancelada pela rescisão volta a "nova"', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s)]));
    const rows = await occurrences(obligation(contract, 'Aluguel').id);
    const imp = await importOfx(session.cookie, `accountId=${s.accountA.id}`, [
      { date: '2026-12-10', cents: -200_000, memo: 'PIX ALUGUEL DEZEMBRO' },
    ]);
    expect(imp.lines[0]).toMatchObject({ status: 'suggested', titleId: rows[1]!.id });
    await admin.post(`/api/contracts/${contract.id}/terminate`, { terminatedOn: '2026-11-15' });
    expect((await occurrences(obligation(contract, 'Aluguel').id))[1]!.status).toBe('canceled');
    const after = await admin.get(`/api/statement-imports/${imp.id}`);
    expect(after.lines[0]).toMatchObject({ status: 'new', titleId: null });
  });
});

/* ---------------- espelho, documentos e painel ---------------- */

describe('espelho e permissões', () => {
  it('quem lê a caixa da contraparte vê o contrato pelo título espelhado, sem editar; estranhos não veem', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', {
      ...lease(s, [rentObligation(s, { categoryId: s.income.id })]),
      entityId: s.holderB.id,
      direction: 'receivable',
      categoryId: s.income.id,
      mirrorCaixaId: undefined,
    });
    expect(contract.counterpartyCaixaId).toBe(s.caixaB.id);
    const rows = await occurrences(obligation(contract, 'Aluguel').id);
    const title = await admin.get(`/api/titles/${rows[0]!.id}`);
    expect(title.mirror).toMatchObject({ caixaId: s.caixaB.id, mirrorStatus: 'accepted' });
    expect(await admin.get(`/api/titles/${title.mirror.id}`)).toMatchObject({
      direction: 'payable',
      contractId: contract.id,
      occurrence: 1,
    });

    const otherSession = await userSession(h);
    await admin.put(`/api/users/${otherSession.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'editor' }] });
    const other = client(h, otherSession.cookie);
    const seen = await other.get(`/api/contracts/${contract.id}`);
    expect(seen).toMatchObject({ viaMirror: true, canWrite: false });
    expect((await other.get('/api/contracts')).map((c: any) => c.id)).toContain(contract.id);
    await other.post(
      `/api/contracts/${contract.id}/amendments`,
      { effectiveOn: '2027-01-01', ruleIds: [obligation(contract, 'Aluguel').id], amountCents: 1 },
      404,
    );

    // Pagamentos pelo espelho: as ocorrências do lado legível, sem os ids do lado do contrato (tarefa 134).
    const mirrorRows = (await other.get(`/api/contracts/${contract.id}/payments`)).rows;
    expect(mirrorRows).toHaveLength(6);
    expect(mirrorRows[0]).toMatchObject({ kind: 'title', titleId: title.mirror.id, caixaId: s.caixaB.id, accountId: null });
    const listed = (await other.get('/api/contracts')).find((c: any) => c.id === contract.id);
    expect(listed).toMatchObject({ obligationCount: 0, withoutAccount: 0, nextOccurrence: { titleId: title.mirror.id } });

    const stranger = client(h, (await userSession(h)).cookie);
    await stranger.get(`/api/contracts/${contract.id}`, 404);
    expect((await stranger.get('/api/contracts')).map((c: any) => c.id)).not.toContain(contract.id);
  });

  it('leitor só da caixa do contrato não vê a próxima ocorrência, as contagens nem as cobranças no cartão de caixas que não lê (tarefa 134)', async () => {
    const { admin, s } = await setup();
    const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${s.tag}` });
    const card = await admin.post('/api/caixas', {
      name: `Cartão ${s.tag}`,
      kind: 'credit_card',
      holderEntityId: issuer.id,
      defaultPayerCaixaId: s.caixaB.id,
      creditLimitCents: 500_000,
      closingDay: 25,
      dueDay: 5,
      cardLast4: '2222',
    });
    const streaming = { kind: 'card', description: 'Streaming', amountCents: 5_990, firstDueDate: '2026-11-15', cardCaixaId: card.id };
    // O condomínio (dia 5) é do cofre da caixa B e vence antes do aluguel (dia 10, caixa A).
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s), condoObligation(s), streaming]));
    expect((await admin.get(`/api/contracts?caixaId=${s.caixaA.id}`)).find((c: any) => c.id === contract.id)).toMatchObject({
      obligationCount: 3,
      nextOccurrence: { dueDate: '2026-11-05' },
    });

    const readerSession = await userSession(h);
    await admin.put(`/api/users/${readerSession.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const reader = client(h, readerSession.cookie);
    const row = (await reader.get(`/api/contracts?caixaId=${s.caixaA.id}`)).find((c: any) => c.id === contract.id);
    expect(row).toMatchObject({ obligationCount: 1, withoutAccount: 0, nextOccurrence: { dueDate: '2026-11-10', amountCents: 200_000 } });
    expect((await reader.get(`/api/contracts/${contract.id}`)).nextOccurrence.dueDate).toBe('2026-11-10');
    const payments = (await reader.get(`/api/contracts/${contract.id}/payments`)).rows;
    expect(payments.length).toBeGreaterThan(0);
    expect(payments.every((r: any) => r.kind === 'title' && r.caixaId === s.caixaA.id)).toBe(true);
    // Quem lê a pagadora vê as cobranças no cartão.
    await admin.put(`/api/users/${readerSession.id}/memberships`, {
      memberships: [
        { caixaId: s.caixaA.id, role: 'viewer' },
        { caixaId: s.caixaB.id, role: 'viewer' },
      ],
    });
    const withPayer = (await reader.get(`/api/contracts/${contract.id}/payments`)).rows;
    expect(withPayer.some((r: any) => r.kind === 'card_charge')).toBe(true);
  });
});

describe('documentos', () => {
  async function upload(cookie: string, contractId: string, name: string, body: Buffer, mime: string, kind = 'contract') {
    return h.app.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/documents?fileName=${encodeURIComponent(name)}&kind=${kind}`,
      payload: body,
      headers: { cookie, 'content-type': mime },
    });
  }

  it('markdown versionado (salvar, comparar, restaurar), PDF somente leitura, arquivar e o documento do aditivo', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post('/api/contracts', lease(s, [rentObligation(s)]));
    const md = await upload(session.cookie, contract.id, 'contrato.md', Buffer.from('# Contrato\n\nCláusula 1: R$ 100\n'), 'text/markdown');
    expect(md.statusCode, md.body).toBe(200);
    const doc = md.json();
    expect(doc).toMatchObject({ format: 'markdown', currentVersion: 1, versionCount: 1, title: 'contrato' });

    const v2 = await admin.post(`/api/contract-documents/${doc.id}/versions`, {
      content: '# Contrato\n\nCláusula 1: R$ 150\n',
      note: 'reajuste',
    });
    expect(v2.version).toBe(2);
    await admin.post(`/api/contract-documents/${doc.id}/versions`, { content: '# Contrato\n\nCláusula 1: R$ 150\n' }, 422);
    // Duas edições abertas na mesma versão: a segunda a salvar recebe 409 e nada é gravado (tarefa 135).
    const opened = (await admin.get(`/api/contract-documents/${doc.id}`)).currentVersionId;
    const first = await admin.post(`/api/contract-documents/${doc.id}/versions`, { content: '# A\n', baseVersionId: opened });
    const late = await admin.raw('POST', `/api/contract-documents/${doc.id}/versions`, { content: '# B\n', baseVersionId: opened });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatchObject({ code: 'version_conflict', message: expect.stringContaining('versão 3') });
    expect(first.version).toBe(3);
    // Restaurar a 2 (versão 4) volta ao conteúdo que o resto do teste espera.
    const v2id = (await admin.get(`/api/contract-documents/${doc.id}/versions`)).find((v: any) => v.version === 2).id;
    await admin.post(`/api/contract-documents/${doc.id}/versions/${v2id}/restore`);
    const versions = await admin.get(`/api/contract-documents/${doc.id}/versions`);
    expect(versions.map((v: any) => v.version)).toEqual([4, 3, 2, 1]);
    const restored = await admin.post(`/api/contract-documents/${doc.id}/versions/${versions[3].id}/restore`);
    expect(restored.version).toBe(5);
    const current = await admin.get(`/api/contract-documents/${doc.id}/versions/${restored.document.currentVersionId}`);
    expect(current).toMatchObject({ version: 5, restoredFromVersion: 1, content: '# Contrato\n\nCláusula 1: R$ 100\n' });
    await expect(h.db.execute(sql`UPDATE contract_document_versions SET note = 'x' WHERE document_id = ${doc.id}`)).rejects.toThrow();
    expect((await upload(session.cookie, contract.id, 'ruim.md', Buffer.from([0xff, 0xfe, 0x00]), 'text/markdown')).statusCode).toBe(422);
    expect((await upload(session.cookie, contract.id, 'planilha.xlsx', Buffer.from('x'), 'application/octet-stream')).statusCode).toBe(422);

    const pdf = await upload(session.cookie, contract.id, 'contrato.pdf', Buffer.from('%PDF-1.4\n% contrato\n'), 'application/pdf');
    expect(pdf.statusCode, pdf.body).toBe(200);
    await admin.post(`/api/contract-documents/${pdf.json().id}/versions`, { content: 'x' }, 422);
    const download = await admin.raw('GET', `/api/attachments/${pdf.json().attachmentId}/download?inline=1`);
    expect(download.statusCode).toBe(200);
    await admin.post(`/api/contract-documents/${pdf.json().id}/convert`, {}, 501);

    await admin.del(`/api/contract-documents/${doc.id}`);
    expect((await admin.get(`/api/contracts/${contract.id}`)).documents.map((d: any) => d.id)).toEqual([pdf.json().id]);

    const amendmentDoc = await admin.post(`/api/contracts/${contract.id}/documents/markdown`, {
      kind: 'amendment',
      title: 'Aditivo 1',
      content: '# Aditivo',
    });
    const amended = await admin.post(`/api/contracts/${contract.id}/amendments`, {
      effectiveOn: '2027-02-01',
      ruleIds: [obligation(contract, 'Aluguel').id],
      anchorDay: 20,
      documentId: amendmentDoc.id,
    });
    expect(amended.contract.amendments[0]).toMatchObject({ documentTitle: 'Aditivo 1' });
  });
});

describe('painel e avisos', () => {
  it('painel de recorrentes soma as obrigações por competência sem contar o par espelhado duas vezes; avisos pela vigência', async () => {
    const { admin, s } = await setup();
    const today = todayIso();
    const startsOn = `${today.slice(0, 7)}-01`;
    const endsOn = addMonths(startsOn, 3);
    const contract = await admin.post('/api/contracts', {
      ...lease(s, [rentObligation(s, { amountCents: 10_000, firstDueDate: `${today.slice(0, 7)}-28`, categoryId: s.income.id })], {
        startsOn,
        endsOn,
        noticeDays: 30,
      }),
      entityId: s.holderB.id,
      direction: 'receivable',
      categoryId: s.income.id,
      mirrorCaixaId: undefined,
    });
    const panel = await admin.get(`/api/contracts/panel?caixas=${s.caixaA.id},${s.caixaB.id}`);
    expect(panel.months).toHaveLength(12);
    expect(panel.months[0]).toMatchObject({ month: startsOn, receivableCents: 10_000, payableCents: 0, netCents: 10_000 });
    const onlyB = await admin.get(`/api/contracts/panel?caixas=${s.caixaB.id}`);
    expect(onlyB.months[0]).toMatchObject({ receivableCents: 0, payableCents: 10_000 });
    expect(panel.renewSoon.map((c: any) => c.id)).toContain(contract.id);

    // Aviso de fim da vigência pelo dia do contrato (D-30, D-7, D-0).
    const clock = spClock(new Date(`${addMonths(endsOn, 0).slice(0, 10)}T12:00:00-03:00`));
    await produceNotifications(h.db, h.config, clock);
    const ending = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'contract_ending' AND dedup_key = ${`contract_ending:${contract.id}:${endsOn}:D-0`}`,
    );
    expect(ending.rows[0]!.n).toBeGreaterThan(0);
  });
});
