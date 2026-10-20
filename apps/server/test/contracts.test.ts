import { addDays, addMonths, spClock, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractMaintenance } from '../src/services/contract-worker';
import { produceNotifications } from '../src/services/message-worker';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

/* Contratos (spec 020): ciclo, parcelas, aditivo, rescisão, renovação, documentos, espelho e avisos. */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

type Scenario = Awaited<ReturnType<typeof scenario>>;

const base = (s: Scenario, extra: Record<string, unknown> = {}) => ({
  caixaId: s.caixaA.id,
  entityId: s.holderB.id,
  direction: 'receivable',
  categoryId: s.income.id,
  name: `Suporte mensal ${s.tag}`,
  contractNumber: `CT-${s.tag}`,
  startsOn: '2027-03-01',
  durationMonths: 12,
  periodicity: 'monthly',
  totalCents: 6_000_001,
  dueDay: 10,
  dueMonthOffset: 1,
  ...extra,
});

async function setup() {
  const session = await userSession(h, 'admin');
  const admin = client(h, session.cookie);
  const s = await scenario(h, admin);
  return { session, admin, s };
}

const installments = (contract: any) => contract.cycles[0].installments as any[];

describe('cadastro e ativação', () => {
  it('rascunho sem títulos; ativar gera o ciclo inteiro com o resto na 1ª parcela, vencimento por dia fixo e espelho', async () => {
    const { admin, s } = await setup();
    const draft = await admin.post('/api/contracts', base(s));
    expect(draft.status).toBe('draft');
    expect(draft.counterpartyCaixaId).toBe(s.caixaB.id);
    expect(draft.cycles[0]).toMatchObject({ seq: 1, startsOn: '2027-03-01', endsOn: '2028-02-29', installmentsCount: 12 });
    expect(installments(draft)).toEqual([]);

    // Rascunho: tudo editável (inclusive o prazo).
    const edited = await admin.patch(`/api/contracts/${draft.id}`, { dueDay: 10, durationMonths: 12, notes: 'ok' });
    expect(edited.notes).toBe('ok');

    const active = await admin.post(`/api/contracts/${draft.id}/activate`);
    expect(active.status).toBe('active');
    const rows = installments(active);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ installment: 1, competenceDate: '2027-03-01', dueDate: '2027-04-10', amountCents: 500_001 });
    expect(rows[11]).toMatchObject({ installment: 12, competenceDate: '2028-02-01', dueDate: '2028-03-10', amountCents: 500_000 });
    expect(rows.reduce((acc, r) => acc + r.amountCents, 0)).toBe(6_000_001);
    expect(active.cycles[0].totals.contractedCents).toBe(6_000_001);

    // São títulos normais, com o contrato e n/N, espelhados na caixa da contraparte.
    const title = await admin.get(`/api/titles/${rows[0].titleId}`);
    expect(title).toMatchObject({
      origin: 'contract',
      contractId: active.id,
      contractName: active.name,
      contractInstallment: 1,
      contractInstallmentsCount: 12,
      direction: 'receivable',
    });
    expect(title.mirror).toMatchObject({ caixaId: s.caixaB.id, mirrorStatus: 'accepted' });
    const mirror = await admin.get(`/api/titles/${title.mirror.id}`);
    expect(mirror).toMatchObject({ direction: 'payable', contractId: active.id, contractInstallment: 1, amountCents: 500_001 });

    // Vigente: prazo e valor só por aditivo/renovação; ativar de novo não.
    await admin.patch(`/api/contracts/${active.id}`, { totalCents: 1 }, 422);
    await admin.post(`/api/contracts/${active.id}/activate`, {}, 422);
    const renamed = await admin.patch(`/api/contracts/${active.id}`, { autoRenew: true, noticeDays: 45 });
    expect(renamed).toMatchObject({ autoRenew: true, noticeDays: 45 });

    // Lista e filtros.
    const list = await admin.get(`/api/contracts?caixaId=${s.caixaA.id}&status=current`);
    expect(list.map((c: any) => c.id)).toContain(active.id);
    expect(await admin.get(`/api/contracts?entityId=${s.holderB.id}&direction=payable`)).toEqual([]);
  });

  it('valida a duração pelo período, a categoria pela direção e a contraparte', async () => {
    const { admin, s } = await setup();
    await admin.post('/api/contracts', base(s, { durationMonths: 10, periodicity: 'quarterly' }), 400);
    await admin.post('/api/contracts', base(s, { categoryId: s.expense.id }), 422);
    await admin.post('/api/contracts', base(s, { entityId: s.holderA.id }), 422);
    const quarterly = await admin.post('/api/contracts', base(s, { periodicity: 'quarterly', activate: true, mirrorCaixaId: null }));
    expect(quarterly.counterpartyCaixaId).toBeNull();
    expect(installments(quarterly).map((r: any) => [r.competenceDate, r.amountCents])).toEqual([
      ['2027-03-01', 1_500_001],
      ['2027-06-01', 1_500_000],
      ['2027-09-01', 1_500_000],
      ['2027-12-01', 1_500_000],
    ]);
    // Rascunho sem vínculos é excluído; vigente é arquivado.
    const draft = await admin.post('/api/contracts', base(s, { contractNumber: null }));
    expect(await admin.del(`/api/contracts/${draft.id}`)).toEqual({ deleted: true, archived: false });
    expect(await admin.del(`/api/contracts/${quarterly.id}`)).toEqual({ deleted: false, archived: true });
    expect((await admin.post(`/api/contracts/${quarterly.id}/restore`)).archivedAt).toBeNull();
  });
});

describe('aditivo e rescisão', () => {
  it('aditivo recalcula as parcelas em aberto sem baixa (nos dois lados) e guarda o antes → depois', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', base(s, { activate: true }));
    const rows = installments(contract);
    // A parcela de agosto recebe uma baixa parcial: não muda.
    await admin.post(`/api/titles/${rows[5].titleId}/settlements`, {
      settledOn: '2027-09-10',
      amountCents: 100_000,
      financialAccountId: s.accountA.id,
    });

    const body = { effectiveOn: '2027-08-01', installmentCents: 550_000, dueDay: 5 };
    const preview = await admin.post(`/api/contracts/${contract.id}/amendments?dryRun=1`, body);
    expect(preview.contract).toBeNull();
    expect(preview.preview.affected).toHaveLength(6);
    expect(preview.preview.skipped).toEqual([expect.objectContaining({ installment: 6, reason: 'settled' })]);
    expect((await admin.get(`/api/titles/${rows[6].titleId}`)).amountCents).toBe(500_000);

    const applied = await admin.post(`/api/contracts/${contract.id}/amendments`, body);
    const after = installments(applied.contract);
    expect(after[6]).toMatchObject({ amountCents: 550_000, dueDate: '2027-10-05' });
    expect(after[5]).toMatchObject({ amountCents: 500_000, dueDate: '2027-09-10' });
    expect(after[4]).toMatchObject({ amountCents: 500_000, dueDate: '2027-08-10' });
    const mirror = await admin.get(`/api/titles/${(await admin.get(`/api/titles/${after[6].titleId}`)).mirror.id}`);
    expect(mirror).toMatchObject({ amountCents: 550_000, dueDate: '2027-10-05' });
    expect(applied.contract.cycles[0]).toMatchObject({ dueDay: 5, totalCents: 6_300_001 });
    expect(applied.contract.amendments[0]).toMatchObject({
      effectiveOn: '2027-08-01',
      affectedCount: 6,
      skippedCount: 1,
      changes: { before: { dueDay: 10, installmentCents: 500_000 }, after: { dueDay: 5, installmentCents: 550_000 } },
    });

    // Total restante dividido com o resto na primeira afetada.
    const rest = await admin.post(`/api/contracts/${contract.id}/amendments`, {
      effectiveOn: '2028-01-01',
      remainingTotalCents: 1_000_001,
    });
    expect(
      installments(rest.contract)
        .slice(10)
        .map((r: any) => r.amountCents),
    ).toEqual([500_001, 500_000]);
    await admin.post(`/api/contracts/${contract.id}/amendments`, { effectiveOn: '2028-01-01' }, 400);
  });

  it('rescisão cancela as parcelas seguintes sem baixa, ajusta a do mês, lança a multa e encerra', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', base(s, { activate: true, autoRenew: true }));
    const rows = installments(contract);
    await admin.post(`/api/titles/${rows[9].titleId}/settlements`, {
      settledOn: '2027-11-10',
      amountCents: 500_000,
      financialAccountId: s.accountA.id,
    });
    const body = {
      terminatedOn: '2027-09-10',
      currentInstallmentCents: 166_667,
      penalty: { direction: 'receivable', amountCents: 200_000, dueDate: '2027-10-10', categoryId: s.income.id },
    };
    const preview = await admin.post(`/api/contracts/${contract.id}/terminate?dryRun=1`, body);
    expect(preview.preview.current).toMatchObject({ installment: 7, proratedCents: Math.round((500_000 * 10) / 30) });
    expect(preview.preview.canceled.map((r: any) => r.installment)).toEqual([8, 9, 11, 12]);
    expect(preview.preview.keptSettled).toBe(1);

    const done = await admin.post(`/api/contracts/${contract.id}/terminate`, body);
    expect(done.contract).toMatchObject({ status: 'terminated', terminatedOn: '2027-09-10' });
    const after = installments(done.contract);
    expect(after[6].amountCents).toBe(166_667);
    expect(after.filter((r: any) => r.status === 'canceled').map((r: any) => r.installment)).toEqual([8, 9, 11, 12]);
    expect(after[9].status).toBe('paid');
    expect(done.contract.extraTitles).toEqual([expect.objectContaining({ amountCents: 200_000, installment: null })]);
    const penalty = await admin.get(`/api/titles/${done.contract.extraTitles[0].titleId}`);
    expect(penalty.mirror?.caixaId).toBe(s.caixaB.id);
    // Espelho cancelado junto.
    const canceledMirror = await admin.get(`/api/titles/${(await admin.get(`/api/titles/${after[7].titleId}`)).mirror.id}`);
    expect(canceledMirror.status).toBe('canceled');
    // Rescindido não muda mais.
    await admin.post(`/api/contracts/${contract.id}/amendments`, { effectiveOn: '2027-12-01', installmentCents: 1 }, 422);
    await admin.post(
      `/api/contracts/${contract.id}/renew`,
      { durationMonths: 12, periodicity: 'monthly', totalCents: 1200, dueDay: 1, dueMonthOffset: 0 },
      422,
    );
  });
});

describe('renovação', () => {
  it('o worker abre a tarefa na antecedência (nada é lançado); aprovar cria o ciclo seguinte com as parcelas', async () => {
    const { admin, s } = await setup();
    const today = todayIso();
    const startsOn = addDays(addMonths(today, -12), 30); // termina daqui a ~29 dias
    const contract = await admin.post(
      '/api/contracts',
      base(s, { startsOn, autoRenew: true, renewalLeadDays: 60, readjustmentIndex: 'ipca', activate: true }),
    );
    // A ativação já roda o ciclo de vida: dentro da antecedência, a tarefa abre.
    expect(contract.status).toBe('renewal_pending');
    expect(contract.renewalTasks).toEqual([expect.objectContaining({ status: 'open', dueOn: contract.cycles[0].endsOn })]);
    const titlesBefore = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM titles WHERE contract_id = ${contract.id}`);

    // Rodar a manutenção de novo não duplica nem lança nada.
    await contractMaintenance(h.db, today);
    const titlesAfter = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM titles WHERE contract_id = ${contract.id}`);
    expect(titlesAfter.rows[0]!.n).toBe(titlesBefore.rows[0]!.n);

    // Aviso no sino para os membros da caixa (e os admins).
    await produceNotifications(h.db, h.config, { ...spClock(), time: '23:59' });
    const notes = await h.db.execute<{ kind: string }>(sql`SELECT kind FROM notifications WHERE data ->> 'contractId' = ${contract.id}`);
    expect(notes.rows.map((r) => r.kind)).toContain('contract_renewal_pending');

    const body = {
      durationMonths: 12,
      periodicity: 'monthly',
      totalCents: 6_270_001,
      readjustmentPercent: 4.5,
      dueDay: 10,
      dueMonthOffset: 1,
    };
    const preview = await admin.post(`/api/contracts/${contract.id}/renew?dryRun=1`, body);
    expect(preview.preview.startsOn).toBe(addDays(contract.cycles[0].endsOn, 1));
    expect(preview.preview.installments).toHaveLength(12);

    const renewed = await admin.post(`/api/contracts/${contract.id}/renew`, body);
    expect(renewed.contract.status).toBe('active');
    expect(renewed.contract.cycles[0]).toMatchObject({ seq: 2, totalCents: 6_270_001, readjustmentPercent: 4.5 });
    expect(renewed.contract.cycles[0].installments).toHaveLength(12);
    expect(renewed.contract.renewalTasks[0]).toMatchObject({ status: 'approved', newCycleId: renewed.contract.cycles[0].id });
  });

  it('sem resposta a tarefa fica vencida; "não renovar" encerra no fim do ciclo; quem só lê não decide', async () => {
    const { admin, s } = await setup();
    const viewerSession = await userSession(h);
    await admin.put(`/api/users/${viewerSession.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const viewer = client(h, viewerSession.cookie);
    const today = todayIso();
    // Ciclo que já acabou ontem, com renovação automática: a tarefa abre vencida e nada é lançado.
    const startsOn = addDays(addMonths(today, -12), -1);
    const contract = await admin.post('/api/contracts', base(s, { startsOn, autoRenew: true, activate: true }));
    expect(contract.status).toBe('renewal_pending');
    expect(contract.openTask).toMatchObject({ overdue: true });
    await contractMaintenance(h.db, addDays(today, 30));
    expect((await admin.get(`/api/contracts/${contract.id}`)).status).toBe('renewal_pending');

    await viewer.post(`/api/contracts/${contract.id}/decline-renewal`, {}, 403);
    const declined = await admin.post(`/api/contracts/${contract.id}/decline-renewal`, { notes: 'Cliente saiu' });
    // Passado o fim, recusar encerra.
    expect(declined.status).toBe('ended');
    expect(declined.renewalTasks[0]).toMatchObject({ status: 'declined', decisionNotes: 'Cliente saiu' });

    // Sem renovação automática: o worker só encerra no fim.
    const manual = await admin.post(
      '/api/contracts',
      base(s, { startsOn: addMonths(today, -12), autoRenew: false, activate: true, contractNumber: null }),
    );
    await contractMaintenance(h.db, addDays(today, 1));
    expect((await admin.get(`/api/contracts/${manual.id}`)).status).toBe('ended');
    // "Renovar" continua disponível para quem escreve.
    const renewed = await admin.post(`/api/contracts/${manual.id}/renew`, {
      durationMonths: 6,
      periodicity: 'semiannual',
      totalCents: 300_000,
      dueDay: 5,
      dueMonthOffset: 0,
    });
    expect(renewed.contract.status).toBe('active');
    expect(renewed.contract.cycles[0].installments).toHaveLength(1);
  });
});

describe('espelho e permissões', () => {
  it('quem lê a caixa da contraparte vê o contrato pela parcela espelhada, sem editar; estranhos não veem', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', base(s, { activate: true }));
    const otherSession = await userSession(h);
    await admin.put(`/api/users/${otherSession.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'editor' }] });
    const other = client(h, otherSession.cookie);
    const seen = await other.get(`/api/contracts/${contract.id}`);
    expect(seen).toMatchObject({ viaMirror: true, canWrite: false });
    // As parcelas vistas são as da caixa dele (lado espelho).
    expect(installments(seen)[0].caixaId).toBe(s.caixaB.id);
    expect((await other.get('/api/contracts')).map((c: any) => c.id)).toContain(contract.id);
    await other.post(`/api/contracts/${contract.id}/amendments`, { effectiveOn: '2027-05-01', installmentCents: 1 }, 404);

    const stranger = client(h, (await userSession(h)).cookie);
    await stranger.get(`/api/contracts/${contract.id}`, 404);
    expect((await stranger.get('/api/contracts')).map((c: any) => c.id)).not.toContain(contract.id);

    // Toda escrita sai com o ator humano na auditoria.
    const audit = await h.db.execute<{ actor_kind: string }>(
      sql`SELECT DISTINCT actor_kind FROM audit_log WHERE table_name = 'contracts' AND record_id = ${contract.id}`,
    );
    expect(audit.rows.map((r) => r.actor_kind)).toEqual(['human']);
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

  it('markdown versionado (salvar, comparar, restaurar), PDF somente leitura e arquivar', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post('/api/contracts', base(s, { activate: true }));
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
    const versions = await admin.get(`/api/contract-documents/${doc.id}/versions`);
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const restored = await admin.post(`/api/contract-documents/${doc.id}/versions/${versions[1].id}/restore`);
    expect(restored.version).toBe(3);
    const current = await admin.get(`/api/contract-documents/${doc.id}/versions/${restored.document.currentVersionId}`);
    expect(current).toMatchObject({ version: 3, restoredFromVersion: 1, content: '# Contrato\n\nCláusula 1: R$ 100\n' });

    // Versões são imutáveis no banco.
    const update = h.db.execute(sql`UPDATE contract_document_versions SET note = 'x' WHERE document_id = ${doc.id}`);
    await expect(update).rejects.toThrow();

    // .md que não é UTF-8 é recusado; outro formato também.
    expect((await upload(session.cookie, contract.id, 'ruim.md', Buffer.from([0xff, 0xfe, 0x00]), 'text/markdown')).statusCode).toBe(422);
    expect((await upload(session.cookie, contract.id, 'planilha.xlsx', Buffer.from('x'), 'application/octet-stream')).statusCode).toBe(422);

    const pdf = await upload(session.cookie, contract.id, 'contrato.pdf', Buffer.from('%PDF-1.4\n% contrato\n'), 'application/pdf');
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.json()).toMatchObject({ format: 'pdf', fileName: 'contrato.pdf' });
    await admin.post(`/api/contract-documents/${pdf.json().id}/versions`, { content: 'x' }, 422);
    const download = await admin.raw('GET', `/api/attachments/${pdf.json().attachmentId}/download?inline=1`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain('%PDF-1.4');
    // Quem lê a contraparte (pelo espelho) baixa; estranho não.
    const otherSession = await userSession(h);
    await admin.put(`/api/users/${otherSession.id}/memberships`, { memberships: [{ caixaId: s.caixaB.id, role: 'viewer' }] });
    expect((await client(h, otherSession.cookie).raw('GET', `/api/attachments/${pdf.json().attachmentId}/download`)).statusCode).toBe(200);
    expect(
      (await client(h, (await userSession(h)).cookie).raw('GET', `/api/attachments/${pdf.json().attachmentId}/download`)).statusCode,
    ).toBe(404);
    // Sem agente de IA: a conversão responde 501.
    await admin.post(`/api/contract-documents/${pdf.json().id}/convert`, {}, 501);

    // Excluir arquiva (some da lista, fica no histórico).
    await admin.del(`/api/contract-documents/${doc.id}`);
    const detail = await admin.get(`/api/contracts/${contract.id}`);
    expect(detail.documents.map((d: any) => d.id)).toEqual([pdf.json().id]);

    // Documento num aditivo.
    const amendmentDoc = await admin.post(`/api/contracts/${contract.id}/documents/markdown`, {
      kind: 'amendment',
      title: 'Aditivo 1',
      content: '# Aditivo',
    });
    const amended = await admin.post(`/api/contracts/${contract.id}/amendments`, {
      effectiveOn: '2027-09-01',
      dueDay: 20,
      documentId: amendmentDoc.id,
    });
    expect(amended.contract.amendments[0]).toMatchObject({ documentTitle: 'Aditivo 1' });
  });
});

describe('painel e entidade', () => {
  it('painel de recorrentes soma por competência sem contar o par espelhado duas vezes', async () => {
    const { admin, s } = await setup();
    const today = todayIso();
    const startsOn = `${today.slice(0, 7)}-01`;
    await admin.post('/api/contracts', base(s, { startsOn, activate: true, totalCents: 120_000 }));
    const panel = await admin.get(`/api/contracts/panel?caixas=${s.caixaA.id},${s.caixaB.id}`);
    expect(panel.months).toHaveLength(12);
    expect(panel.months[0]).toMatchObject({ month: startsOn, receivableCents: 10_000, payableCents: 0, netCents: 10_000 });
    // Só a caixa da contraparte: o lado espelho aparece como despesa.
    const onlyB = await admin.get(`/api/contracts/panel?caixas=${s.caixaB.id}`);
    expect(onlyB.months[0]).toMatchObject({ receivableCents: 0, payableCents: 10_000 });
    const byEntity = await admin.get(`/api/contracts?entityId=${s.holderB.id}`);
    expect(byEntity.length).toBeGreaterThan(0);
  });
});

/* ---------------- pagamentos no extrato (spec 033) ---------------- */

type StmtLine = { date: string; cents: number; memo: string };

/** OFX mínimo de conta corrente (FITID único por linha). */
function ofxOf(lines: StmtLine[]) {
  const key = Math.random().toString(36).slice(2, 10);
  const trn = lines
    .map(
      (l, i) => `<STMTTRN><TRNTYPE>${l.cents < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${l.date.replaceAll('-', '')}120000</DTPOSTED>
<TRNAMT>${(l.cents / 100).toFixed(2)}</TRNAMT><FITID>${key}-${i}</FITID><NAME>${l.memo}</NAME></STMTTRN>`,
    )
    .join('\n');
  const dates = lines.map((l) => l.date.replaceAll('-', '')).sort();
  return Buffer.from(`OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>077</BANKID><ACCTID>1</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${dates[0]}</DTSTART><DTEND>${dates.at(-1)}</DTEND>
${trn}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
}

async function importOfx(cookie: string, accountId: string, lines: StmtLine[]) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/statement-imports?accountId=${accountId}&fileName=extrato.ofx`,
    payload: ofxOf(lines),
    headers: { cookie, 'content-type': 'application/x-ofx' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Aluguel a pagar de R$ 2.000,00 por mês em 2027, vencimento dia 10, com multa 2%, juros 1% a.m. e desconto 5%. */
const rent = (s: Scenario, extra: Record<string, unknown> = {}) =>
  base(s, {
    entityId: s.supplier.id,
    direction: 'payable',
    categoryId: s.expense.id,
    name: `Aluguel ${s.tag}`,
    contractNumber: null,
    mirrorCaixaId: null,
    startsOn: '2027-01-01',
    totalCents: 2_400_000,
    dueMonthOffset: 0,
    paymentAccountId: s.accountA.id,
    lateFeePercent: 2,
    interestMonthPercent: 1,
    earlyDiscountPercent: 5,
    matchWindowDays: 30,
    activate: true,
    ...extra,
  });

describe('pagamentos no extrato (spec 033)', () => {
  it('atraso com multa e juros, desconto antes do vencimento e o atraso pagando a mais antiga; o resumo de pagamentos', async () => {
    const { session, admin, s } = await setup();
    const contract = await admin.post('/api/contracts', rent(s));
    const rows = installments(contract);
    expect(rows[0]).toMatchObject({ plannedAccountId: s.accountA.id, plannedAccountCustom: false });
    expect(contract).toMatchObject({ paymentAccountId: s.accountA.id, lateFeePercent: 2, matchWindowDays: 30, autoSettle: false });
    // Abril pago à mão adiantado (março fica em aberto).
    await admin.post(`/api/titles/${rows[3].titleId}/settlements`, {
      settledOn: '2027-04-02',
      amountCents: 200_000,
      financialAccountId: s.accountA.id,
    });

    const imp = await importOfx(session.cookie, s.accountA.id, [
      // Janeiro 10 dias atrasado: multa 2% = 40,00; juros 1% a.m. × 10/30 = 6,67.
      { date: '2027-01-20', cents: -204_667, memo: 'PIX ALUGUEL JANEIRO' },
      // Fevereiro 2 dias antes, com o desconto de 5%.
      { date: '2027-02-08', cents: -190_000, memo: 'PIX ALUGUEL FEVEREIRO' },
      // O valor do aluguel em abril (já pago): paga março, a mais antiga em aberto da janela.
      { date: '2027-04-08', cents: -200_000, memo: 'PIX ALUGUEL' },
    ]);
    const [jan, feb, apr] = imp.lines;
    expect(imp.lines.map((l: any) => l.status)).toEqual(['suggested', 'suggested', 'suggested']);
    expect(jan.titleId).toBe(rows[0].titleId);
    expect(jan.target.contract).toMatchObject({
      contractId: contract.id,
      installment: 1,
      installmentsCount: 12,
      split: { kind: 'charges', amountCents: 200_000, fineCents: 4_000, interestCents: 667, discountCents: 0, days: 10 },
    });
    expect(feb.titleId).toBe(rows[1].titleId);
    expect(feb.target.contract.split).toMatchObject({ kind: 'discount', discountCents: 10_000, days: -2 });
    expect(apr.titleId).toBe(rows[2].titleId);

    // Os candidatos (e as tools) trazem a repartição.
    const candidates = await admin.get(`/api/statement-lines/${jan.id}/candidates`);
    expect(candidates[0]).toMatchObject({ kind: 'title', id: rows[0].titleId, contract: { split: { fineCents: 4_000 } } });

    const confirmed = await admin.post('/api/statement-lines/confirm', { lineIds: [jan.id, feb.id, apr.id] });
    expect(confirmed).toEqual({ confirmed: 3, failed: [] });
    const janTitle = await admin.get(`/api/titles/${rows[0].titleId}`);
    expect(janTitle.status).toBe('paid');
    expect(janTitle.settlements[0]).toMatchObject({ amountCents: 200_000, fineCents: 4_000, interestCents: 667, cashCents: 204_667 });

    const payments = await admin.get(`/api/contracts/${contract.id}/payments?cycleId=${contract.cycles[0].id}`);
    const byInstallment = new Map(payments.rows.map((r: any) => [r.installment, r]));
    expect(byInstallment.get(1)).toMatchObject({
      paidOn: '2027-01-20',
      days: 10,
      fineCents: 4_000,
      interestCents: 667,
      lastOrigin: 'reconciliation',
    });
    expect(byInstallment.get(2)).toMatchObject({ paidOn: '2027-02-08', days: -2, discountCents: 10_000 });
    expect(byInstallment.get(3)).toMatchObject({ paidOn: '2027-04-08', days: 29, accountId: s.accountA.id, accountName: 'Banco A' });
    expect(byInstallment.get(4)).toMatchObject({ paidOn: '2027-04-02', days: -8, lastOrigin: 'manual' });
    expect(byInstallment.get(5)).toMatchObject({ status: 'open', days: null, overdue: false, plannedAccountName: 'Banco A' });
    expect(payments.summary).toMatchObject({
      installments: 12,
      paid: 4,
      onTimePercent: 50,
      maxDelayDays: 29,
      chargesCents: 4_667,
      discountCents: 10_000,
      open: 8,
      overdue: 0,
    });
    const january = payments.months.find((m: any) => m.month === '2027-01-01');
    expect(january).toEqual({ month: '2027-01-01', plannedCents: 200_000, paidCents: 200_000, chargesCents: 4_667, discountCents: 0 });
    // Abril: previsto o de abril; pagos o de março (08/04) e o de abril.
    expect(payments.months.find((m: any) => m.month === '2027-04-01')).toMatchObject({ plannedCents: 200_000, paidCents: 400_000 });
  });

  it('troca da conta da parcela (fica própria) e a do contrato, aplicada às que seguem; a tolerância tem teto de 10%', async () => {
    const { admin, s } = await setup();
    const contract = await admin.post('/api/contracts', rent(s));
    const rows = installments(contract);
    const second = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'savings',
      name: 'Poupança A',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const third = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'checking',
      name: 'Banco A2',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    // A parcela 1 paga não muda; a 2 ganha conta própria.
    await admin.post(`/api/titles/${rows[0].titleId}/settlements`, {
      settledOn: '2027-01-10',
      amountCents: 200_000,
      financialAccountId: s.accountA.id,
    });
    const own = await admin.patch(`/api/titles/${rows[1].titleId}`, { plannedAccountId: second.id });
    expect(own).toMatchObject({ plannedAccountId: second.id, plannedAccountName: 'Poupança A', plannedAccountCustom: true });
    // Título pago não troca a conta prevista.
    await admin.patch(`/api/titles/${rows[0].titleId}`, { plannedAccountId: second.id }, 422);
    // Conta de outra caixa sem a de passagem: o banco recusa.
    const otherCaixa = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
      kind: 'checking',
      name: 'Banco B',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const refused = await h.app.inject({
      method: 'PATCH',
      url: `/api/titles/${rows[2].titleId}`,
      payload: { plannedAccountId: otherCaixa.id },
      headers: { cookie: (await userSession(h, 'admin')).cookie },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('titles_planned_transit_account_check');

    expect((await admin.get(`/api/contracts/${contract.id}`)).followingOpenInstallments).toBe(10);
    // Só no contrato: as parcelas ficam.
    const onlyContract = await admin.patch(`/api/contracts/${contract.id}`, { paymentAccountId: third.id });
    expect(installments(onlyContract)[2].plannedAccountId).toBe(s.accountA.id);
    // Aplicando: as que seguem mudam; a paga e a própria não.
    const applied = await admin.patch(`/api/contracts/${contract.id}`, { paymentAccountId: third.id, applyAccountToInstallments: true });
    const after = installments(applied);
    expect(after[0].plannedAccountId).toBe(s.accountA.id);
    expect(after[1].plannedAccountId).toBe(second.id);
    expect(after.slice(2).every((r: any) => r.plannedAccountId === third.id)).toBe(true);
    // Conta de outra caixa no contrato pede a passagem; com ela, vale.
    await admin.patch(`/api/contracts/${contract.id}`, { paymentAccountId: otherCaixa.id }, 422);
    const cross = await admin.patch(`/api/contracts/${contract.id}`, { paymentAccountId: otherCaixa.id, transitAccountId: s.accountA.id });
    expect(cross).toMatchObject({ paymentAccountId: otherCaixa.id, transitAccountId: s.accountA.id, paymentAccountCaixaId: s.caixaB.id });
    // Voltar para uma conta da própria caixa solta a passagem.
    expect(await admin.patch(`/api/contracts/${contract.id}`, { paymentAccountId: s.accountA.id })).toMatchObject({
      transitAccountId: null,
    });

    // Tolerância: até 10% da parcela (R$ 200,00).
    await admin.patch(`/api/contracts/${contract.id}`, { toleranceCents: 20_001 }, 422);
    expect((await admin.patch(`/api/contracts/${contract.id}`, { toleranceCents: 20_000 })).toleranceCents).toBe(20_000);
    // Excluir a conta referenciada: recusado com a mensagem do banco.
    const removal = await h.app.inject({
      method: 'DELETE',
      url: `/api/accounts/${second.id}`,
      headers: { cookie: (await userSession(h, 'admin')).cookie },
    });
    expect(removal.json()).not.toMatchObject({ deleted: true });
  });
});
