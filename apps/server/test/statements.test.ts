import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TOOLS } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '../src/agents/tool-handlers';
import { loadAccess } from '../src/authz/access';
import type { ServiceContext } from '../src/context';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));

/** Upload cru (o arquivo no corpo, parâmetros na query). */
async function upload(cookie: string, url: string, body: Buffer, contentType = 'application/octet-stream') {
  return h.app.inject({ method: 'POST', url, payload: body, headers: { cookie, 'content-type': contentType } });
}

/** Título baixado pela linha conciliada (linha → movimento → baixa). */
async function titleOfLine(lineId: string) {
  const r = await h.db.execute<{ title_id: string }>(sql`
    SELECT st.title_id FROM statement_lines l
      JOIN movements m ON m.id = l.movement_id JOIN settlements st ON st.id = m.settlement_id
     WHERE l.id = ${lineId}`);
  return r.rows[0]?.title_id ?? null;
}

describe('extratos e conciliação (spec 009)', () => {
  it('importa OFX, deduplica, casa movimento e título, classifica por regra e aprende com a correção', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);

    // Já lançados no app: a assinatura (movimento avulso) e duas contas a pagar.
    const streaming = await admin.post(`/api/accounts/${s.accountA.id}/adjustments`, {
      occurredOn: '2026-10-03',
      amountCents: -5_990,
      description: 'Assinatura streaming',
      categoryId: s.expense.id,
    });
    const market = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Supermercado do mês',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-07',
      amountCents: 23_015,
    });
    const pix = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Pagamento José',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-21',
      amountCents: 40_000,
    });
    // Regra: "internet" → fornecedor + despesa.
    await admin.post('/api/classification-rules', {
      accountId: s.accountA.id,
      pattern: 'internet',
      direction: 'out',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });

    const url = `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`;
    const res = await upload(adminSession.cookie, url, fixture('extrato-ofx2.ofx'), 'application/x-ofx');
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();
    expect(imp.format).toBe('ofx');
    expect(imp.lineCount).toBe(6);
    expect(imp.bankBalanceCents).toBe(278_620);
    const byFitid = (fitid: string) => imp.lines.find((l: any) => l.fitid === fitid);
    expect(byFitid('OFX2-0001')).toMatchObject({ status: 'matched', movementId: streaming.id });
    expect(byFitid('OFX2-0003')).toMatchObject({ status: 'suggested', titleId: market.id });
    expect(byFitid('OFX2-0006')).toMatchObject({ status: 'suggested', titleId: pix.id });
    expect(byFitid('OFX2-0004')).toMatchObject({
      status: 'new',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      classificationSource: 'rule',
    });

    // O mesmo arquivo de novo: tudo duplicado.
    expect((await upload(adminSession.cookie, url, fixture('extrato-ofx2.ofx'))).statusCode).toBe(409);

    // Movimento conciliado não sai; título sugerido sai e a linha volta a "nova".
    await admin.del(`/api/movements/${streaming.id}`, 422);
    await admin.del(`/api/titles/${pix.id}`);
    const after = await admin.get(`/api/statement-imports/${imp.id}`);
    expect(after.lines.find((l: any) => l.fitid === 'OFX2-0006')).toMatchObject({ status: 'new', titleId: null });

    // Confirmação em lote: o título sugerido vira baixa na conta do extrato.
    const confirmed = await admin.post('/api/statement-lines/confirm', { lineIds: [byFitid('OFX2-0003').id] });
    expect(confirmed).toEqual({ confirmed: 1, failed: [] });
    expect((await admin.get(`/api/titles/${market.id}`)).status).toBe('paid');

    // Linha nova vira movimento avulso; a correção vira regra.
    const created = await admin.post(`/api/statement-lines/${byFitid('OFX2-0002').id}/create`, {
      mode: 'adjustment',
      entityId: s.holderB.id,
      categoryId: s.income.id,
    });
    expect(created.status).toBe('matched');
    const rules = await admin.get(`/api/classification-rules?caixaId=${s.caixaA.id}`);
    expect(rules.find((r: any) => r.origin === 'correction')).toMatchObject({ direction: 'in', entityId: s.holderB.id });

    // Linha nova vira título já baixado.
    const asTitle = await admin.post(`/api/statement-lines/${byFitid('OFX2-0004').id}/create`, { mode: 'title' });
    expect(asTitle.status).toBe('matched');
    await admin.post(`/api/statement-lines/${byFitid('OFX2-0005').id}/ignore`);

    // Saldo do banco × app em 31/10: 1.000 − 59,90 − 230,15 + 1.500 − 99,00 = 2.110,95.
    const [summary] = await admin.get(`/api/statement-imports?accountId=${s.accountA.id}`);
    expect(summary.appBalanceCents).toBe(211_095);
    expect(summary.differenceCents).toBe(278_620 - 211_095);
    expect(summary).toMatchObject({ matchedLines: 4, newLines: 1, ignoredLines: 1, suggestedLines: 0 });

    // O arquivo original fica como anexo.
    const file = await h.app.inject({
      method: 'GET',
      url: `/api/attachments/${summary.attachmentId}/download`,
      headers: { cookie: adminSession.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('OFX2-0001');
  });

  it('lança a linha como título baixado com o espelho escolhido na tela: outra caixa da entidade, a principal ou nenhum (spec 006)', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const caixaB2 = await admin.post('/api/caixas', { name: `Caixa B2 ${s.tag}`, holderEntityId: s.holderB.id });
    const res = await upload(
      adminSession.cookie,
      `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`,
      fixture('extrato-ofx2.ofx'),
      'application/x-ofx',
    );
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();
    const line = (fitid: string) => imp.lines.find((l: any) => l.fitid === fitid);
    const create = (fitid: string, body: Record<string, unknown>, status?: number) =>
      admin.post(
        `/api/statement-lines/${line(fitid).id}/create`,
        { mode: 'title', entityId: s.holderB.id, learnRule: false, ...body },
        status,
      );

    // Outra caixa da entidade, com a categoria do espelho escolhida.
    await create('OFX2-0002', { categoryId: s.income.id, mirrorCaixaId: caixaB2.id, mirrorCategoryId: s.expense.id });
    const chosen = await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0002').id)}`);
    expect(chosen).toMatchObject({ direction: 'receivable', status: 'paid', amountCents: 150_000 });
    expect(chosen.mirror).toMatchObject({ caixaId: caixaB2.id, mirrorStatus: 'accepted' });
    expect(await admin.get(`/api/titles/${chosen.mirror.id}`)).toMatchObject({
      direction: 'payable',
      entityId: s.holderA.id,
      categoryId: s.expense.id,
    });

    // Omitido: a caixa principal da entidade.
    await create('OFX2-0005', { categoryId: s.income.id });
    const primary = await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0005').id)}`);
    expect(primary.mirror).toMatchObject({ caixaId: s.caixaB.id });

    // Dispensado.
    await create('OFX2-0004', { categoryId: s.expense.id, mirrorCaixaId: null });
    expect(await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0004').id)}`)).toMatchObject({ status: 'paid', mirror: null });

    // Caixa que não é da entidade: recusada, e a linha continua nova.
    await create('OFX2-0006', { categoryId: s.expense.id, mirrorCaixaId: s.caixaA.id }, 422);
    const after = await admin.get(`/api/statement-imports/${imp.id}`);
    expect(after.lines.find((l: any) => l.fitid === 'OFX2-0006')).toMatchObject({ status: 'new' });
  });

  it('importa CSV com mapeamento salvo por conta', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const noMapping = await upload(
      adminSession.cookie,
      `/api/statement-imports?accountId=${s.accountA.id}&fileName=x.csv`,
      fixture('extrato-itau.csv'),
    );
    expect(noMapping.statusCode).toBe(422);
    expect(noMapping.json().error.code).toBe('csv_mapping_required');

    const inspect = await upload(adminSession.cookie, '/api/statements/inspect?fileName=x.csv', fixture('extrato-itau.csv'), 'text/csv');
    expect(inspect.json()).toMatchObject({ format: 'csv', csv: { delimiter: ';' } });

    const mapping = await admin.post('/api/csv-mappings', {
      financialAccountId: s.accountA.id,
      name: 'Itaú',
      delimiter: ';',
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: ',',
      columns: { date: 'data', description: 'lançamento', amount: 'valor', balance: 'saldo' },
      isDefault: true,
    });
    const res = await upload(
      adminSession.cookie,
      `/api/statement-imports?accountId=${s.accountA.id}&fileName=x.csv`,
      fixture('extrato-itau.csv'),
      'text/csv',
    );
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();
    expect(imp.lineCount).toBe(6);
    expect(imp.format).toBe('csv');
    expect(imp.bankBalanceCents).toBe(107_988);
    expect((await admin.get(`/api/csv-mappings?accountId=${s.accountA.id}`))[0].id).toBe(mapping.id);
  });

  it('importa a fatura do cartão: casa com as compras e linha nova vira compra', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
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
    await admin.post(`/api/cards/${card.id}/purchases`, {
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-10-01',
      description: 'Posto Estrela',
      amountCents: 12_000,
    });
    const res = await upload(
      adminSession.cookie,
      `/api/statement-imports?cardCaixaId=${card.id}&fileName=fatura.ofx`,
      fixture('fatura-cartao.ofx'),
    );
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();
    expect(imp.lineCount).toBe(7);
    const posto = imp.lines.find((l: any) => l.amountCents === -12_000);
    expect(posto.status).toBe('matched');
    const gym = imp.lines.find((l: any) => l.amountCents === -25_000);
    const created = await admin.post(`/api/statement-lines/${gym.id}/create`, {
      mode: 'purchase',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });
    expect(created).toMatchObject({ status: 'matched', createdEntry: 'purchase' });
    // A correção aprende na regra do cartão (sem conta; spec 032), e só nele.
    const cardRules = await admin.get(`/api/classification-rules?cardCaixaId=${card.id}`);
    expect(cardRules).toEqual([
      expect.objectContaining({
        origin: 'correction',
        caixaId: card.id,
        cardCaixaId: card.id,
        financialAccountId: null,
        caixaKind: 'credit_card',
      }),
    ]);
    const purchases = await admin.get(`/api/cards/${card.id}/purchases`);
    expect(purchases.map((p: any) => p.amountCents).sort()).toEqual([12_000, 25_000]);

    // Desfazer e excluir: a compra lançada pela linha sai da fatura; a casada com a compra existente não tem marca.
    expect(posto.createdEntry).toBeNull();
    await admin.post(`/api/statement-lines/${gym.id}/unmatch`, { deleteEntry: true });
    expect((await admin.get(`/api/cards/${card.id}/purchases`)).map((p: any) => p.amountCents)).toEqual([12_000]);

    // De novo na mesma descrição: atualiza a mesma regra do cartão (ON CONFLICT do índice com a conta nula).
    await admin.patch(`/api/statement-lines/${gym.id}`, { entityId: s.holderB.id, categoryId: s.expense.id, learnRule: true });
    const relearned = await admin.get(`/api/classification-rules?cardCaixaId=${card.id}`);
    expect(relearned).toEqual([expect.objectContaining({ id: cardRules[0].id, entityId: s.holderB.id })]);
  });

  it('regras por conta (spec 032): cada conta classifica com as suas, aprende, aplica e copia só na conta', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const savings = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'savings',
      name: 'Poupança A',
      bankCode: '077',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const rule = (body: Record<string, unknown>, status?: number) => admin.post('/api/classification-rules', body, status);
    // A mesma descrição, regras diferentes na corrente e na poupança da mesma caixa.
    const internetA = await rule({ accountId: s.accountA.id, pattern: 'internet', direction: 'out', entityId: s.supplier.id });
    const internetS = await rule({ accountId: savings.id, pattern: 'internet', direction: 'out', entityId: s.holderB.id });
    expect(internetA).toMatchObject({
      financialAccountId: s.accountA.id,
      accountName: 'Banco A',
      targetName: 'Banco A',
      caixaKind: 'general',
    });
    // Unicidade por conta; cofre, as duas contas ou nenhuma: recusados.
    const dup = await rule({ accountId: s.accountA.id, pattern: 'INTERNET', direction: 'out', entityId: s.holderB.id }, 409);
    expect(dup.error.message).toBe('Já existe uma regra igual nesta conta (mesmo tipo, padrão e direção).');
    await rule({ accountId: s.accountB.id, pattern: 'x', entityId: s.supplier.id }, 422);
    await rule({ accountId: s.accountA.id, cardCaixaId: s.caixaA.id, pattern: 'x', entityId: s.supplier.id }, 400);
    await rule({ caixaId: s.caixaA.id, pattern: 'x', entityId: s.supplier.id }, 400);

    const importInto = async (accountId: string) => {
      const res = await upload(
        adminSession.cookie,
        `/api/statement-imports?accountId=${accountId}&fileName=extrato.ofx`,
        fixture('extrato-ofx2.ofx'),
        'application/x-ofx',
      );
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const impA = await importInto(s.accountA.id);
    const impS = await importInto(savings.id);
    const byFitid = (imp: any, fitid: string) => imp.lines.find((l: any) => l.fitid === fitid);
    expect(byFitid(impA, 'OFX2-0004')).toMatchObject({ entityId: s.supplier.id, classificationRuleId: internetA.id });
    expect(byFitid(impS, 'OFX2-0004')).toMatchObject({ entityId: s.holderB.id, classificationRuleId: internetS.id });

    // A correção aprende na conta da linha (a poupança), não na corrente.
    await admin.patch(`/api/statement-lines/${byFitid(impS, 'OFX2-0005').id}`, {
      entityId: s.holderA.id,
      categoryId: s.income.id,
      learnRule: true,
    });
    const savingsRules = await admin.get(`/api/classification-rules?accountId=${savings.id}`);
    expect(savingsRules.find((r: any) => r.origin === 'correction')).toMatchObject({ financialAccountId: savings.id, direction: 'in' });
    expect((await admin.get(`/api/classification-rules?accountId=${s.accountA.id}`)).map((r: any) => r.id)).toEqual([internetA.id]);
    expect((await admin.get(`/api/classification-rules?caixaId=${s.caixaA.id}`)).length).toBe(3);

    // Aplicar regras na corrente não toca a poupança.
    await admin.del(`/api/classification-rules/${internetS.id}`);
    expect(await admin.post('/api/classification-rules/apply', { accountId: s.accountA.id })).toEqual({ updated: 0 });
    expect(byFitid(await admin.get(`/api/statement-imports/${impS.id}`), 'OFX2-0004')).toMatchObject({
      classificationRuleId: internetS.id,
    });
    expect(await admin.post('/api/classification-rules/apply', { accountId: savings.id })).toEqual({ updated: 1 });

    // Copiar da corrente para a poupança: a "supermercado" já existe lá e é pulada; a internet entra como cópia.
    const marketA = await rule({ accountId: s.accountA.id, pattern: 'supermercado', direction: 'out', entityId: s.supplier.id });
    const marketS = await rule({ accountId: savings.id, pattern: 'Supermercado', direction: 'out', entityId: s.holderB.id });
    const copied = await admin.post('/api/classification-rules/copy', { ruleIds: [internetA.id, marketA.id], accountId: savings.id });
    expect(copied.copied).toEqual([
      expect.objectContaining({ financialAccountId: savings.id, pattern: 'internet', origin: 'copy', copiedFromRuleId: internetA.id }),
    ]);
    expect(copied.skipped).toEqual([
      { ruleId: marketA.id, pattern: 'supermercado', matchKind: 'contains', reason: 'exists', existingRuleId: marketS.id },
    ]);
    expect(copied.hint).toContain('Aplicar regras');
    // Copiar não reaplica; o "Aplicar regras" da poupança usa a cópia.
    expect(byFitid(await admin.get(`/api/statement-imports/${impS.id}`), 'OFX2-0004').classificationRuleId).toBeNull();
    expect(await admin.post('/api/classification-rules/apply', { accountId: savings.id })).toEqual({ updated: 2 });
    expect(byFitid(await admin.get(`/api/statement-imports/${impS.id}`), 'OFX2-0004')).toMatchObject({
      classificationRuleId: copied.copied[0].id,
      entityId: s.supplier.id,
    });

    // Leitor da caixa A: lê as regras dela, não as de outra caixa; não copia nem aplica.
    const checkingB = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
      kind: 'checking',
      name: 'Corrente B',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const ruleB = await rule({ accountId: checkingB.id, pattern: 'aluguel', direction: 'out', entityId: s.supplier.id });
    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const viewer = client(h, viewerUser.cookie);
    const seen = (await viewer.get('/api/classification-rules')).map((r: any) => r.id);
    expect(seen).toEqual(expect.arrayContaining([internetA.id, marketA.id]));
    expect(seen).not.toContain(ruleB.id);
    expect((await viewer.get(`/api/classification-rules?accountId=${s.accountA.id}`))[0].canWrite).toBe(false);
    await viewer.get(`/api/classification-rules?accountId=${checkingB.id}`, 404);
    await viewer.post('/api/classification-rules/copy', { ruleIds: [internetA.id], accountId: savings.id }, 403);
    await viewer.post('/api/classification-rules/apply', { accountId: savings.id }, 403);
    // Origem de outra caixa que não lê: não encontrada (mesmo para o admin, a regra existe; o leitor não).
    await admin.put(`/api/users/${viewerUser.id}/memberships`, {
      memberships: [{ caixaId: s.caixaA.id, role: 'editor' }],
    });
    await viewer.post('/api/classification-rules/copy', { ruleIds: [ruleB.id], accountId: savings.id }, 404);
    expect((await viewer.post('/api/classification-rules/copy', { ruleIds: [internetA.id], accountId: savings.id })).skipped).toHaveLength(
      1,
    );
  });
});

describe('desfazer e excluir o lançamento que nasceu da linha (spec 009)', () => {
  const exists = async (table: 'movements' | 'titles' | 'settlements', id: string) =>
    (await h.db.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id}`)).rows.length > 0;

  it('avulso, título com espelho e baixa num título existente saem junto; relançar não duplica', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const market = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Supermercado do mês',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-07',
      amountCents: 23_015,
    });
    const res = await upload(
      adminSession.cookie,
      `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`,
      fixture('extrato-ofx2.ofx'),
      'application/x-ofx',
    );
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();
    const line = (fitid: string) => imp.lines.find((l: any) => l.fitid === fitid);
    const unmatch = (fitid: string, body?: Record<string, unknown>, status?: number) =>
      admin.post(`/api/statement-lines/${line(fitid).id}/unmatch`, body, status);

    // Movimento avulso: a marca adjustment; desfazer e excluir tira o movimento; relançar cria um só.
    const adjusted = await admin.post(`/api/statement-lines/${line('OFX2-0005').id}/create`, {
      mode: 'adjustment',
      categoryId: s.income.id,
      learnRule: false,
    });
    expect(adjusted).toMatchObject({ status: 'matched', createdEntry: 'adjustment' });
    const firstMovement = adjusted.movementId;
    expect(await unmatch('OFX2-0005', { deleteEntry: true })).toMatchObject({ status: 'new', movementId: null, createdEntry: null });
    expect(await exists('movements', firstMovement)).toBe(false);
    const again = await admin.post(`/api/statement-lines/${line('OFX2-0005').id}/create`, {
      mode: 'adjustment',
      categoryId: s.income.id,
      learnRule: false,
    });
    const count = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM movements WHERE financial_account_id = ${s.accountA.id} AND amount_cents = 7525`,
    );
    expect(count.rows[0]!.n).toBe(1);

    // Título já baixado com espelho na caixa principal da entidade: título, espelho e baixa saem.
    const asTitle = await admin.post(`/api/statement-lines/${line('OFX2-0002').id}/create`, {
      mode: 'title',
      entityId: s.holderB.id,
      categoryId: s.income.id,
      learnRule: false,
    });
    expect(asTitle.createdEntry).toBe('title');
    const title = await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0002').id)}`);
    expect(title.mirror).toMatchObject({ caixaId: s.caixaB.id });
    const settlementId = title.settlements[0].id;
    await unmatch('OFX2-0002', { deleteEntry: true });
    expect(await exists('titles', title.id)).toBe(false);
    expect(await exists('titles', title.mirror.id)).toBe(false);
    expect(await exists('settlements', settlementId)).toBe(false);
    expect(await exists('movements', asTitle.movementId)).toBe(false);

    // Baixa ao confirmar a sugestão de um título que já existia: a baixa sai e o título volta a aberto.
    expect(line('OFX2-0003')).toMatchObject({ status: 'suggested', titleId: market.id, createdEntry: null });
    await admin.post('/api/statement-lines/confirm', { lineIds: [line('OFX2-0003').id] });
    expect((await admin.get(`/api/titles/${market.id}`)).status).toBe('paid');
    const confirmedLine = (await admin.get(`/api/statement-imports/${imp.id}`)).lines.find((l: any) => l.fitid === 'OFX2-0003');
    expect(confirmedLine.createdEntry).toBe('settlement');
    await unmatch('OFX2-0003', { deleteEntry: true });
    expect(await admin.get(`/api/titles/${market.id}`)).toMatchObject({ status: 'open', settlements: [] });

    // Casada com um movimento que já existia: só desfazer; deleteEntry é recusado e nada muda.
    await unmatch('OFX2-0005');
    expect(await exists('movements', again.movementId)).toBe(true);
    await admin.post(`/api/statement-lines/${line('OFX2-0005').id}/match`, { movementId: again.movementId });
    const refused = await unmatch('OFX2-0005', { deleteEntry: true }, 422);
    expect(refused.error.code).toBe('line_entry_not_created');
    expect((await admin.get(`/api/statement-imports/${imp.id}`)).lines.find((l: any) => l.fitid === 'OFX2-0005').status).toBe('matched');

    // O lançamento mudou depois (baixa estornada): recusado, a linha continua conciliada.
    const changed = await admin.post(`/api/statement-lines/${line('OFX2-0006').id}/create`, {
      mode: 'title',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      learnRule: false,
    });
    const changedTitle = await admin.get(`/api/titles/${await titleOfLine(line('OFX2-0006').id)}`);
    await admin.post(`/api/settlements/${changedTitle.settlements[0].id}/reverse`, { reason: 'teste', reversedOn: '2026-10-25' });
    expect((await unmatch('OFX2-0006', { deleteEntry: true }, 422)).error.code).toBe('line_entry_changed');
    expect(await exists('titles', changedTitle.id)).toBe(true);
    expect((await admin.get(`/api/statement-imports/${imp.id}`)).lines.find((l: any) => l.id === changed.id).status).toBe('matched');
  });
});

describe('aplicar regras e buscar nas linhas (spec 009)', () => {
  it('reaplica as regras às linhas novas sem mexer nas do usuário nem nas do agente', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const url = `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`;
    const imp = (await upload(adminSession.cookie, url, fixture('extrato-ofx2.ofx'), 'application/x-ofx')).json();
    const byFitid = (lines: any[], fitid: string) => lines.find((l: any) => l.fitid === fitid);
    // Sem regras no import: nada classificado.
    expect(byFitid(imp.lines, 'OFX2-0004')).toMatchObject({ status: 'new', classificationSource: null, importId: imp.id });

    // O usuário classifica o PIX enviado; o agente sugere o PIX recebido (ainda pendente).
    await admin.patch(`/api/statement-lines/${byFitid(imp.lines, 'OFX2-0006').id}`, { entityId: s.holderB.id });
    await h.db.execute(sql`UPDATE statement_lines SET classification_source = 'agent', entity_id = ${s.holderB.id}
                            WHERE id = ${byFitid(imp.lines, 'OFX2-0002').id}`);

    // Regras criadas depois do import: "internet" e "pix" (essa pegaria as duas linhas de PIX).
    const internet = await admin.post('/api/classification-rules', {
      accountId: s.accountA.id,
      pattern: 'internet',
      direction: 'out',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });
    await admin.post('/api/classification-rules', { accountId: s.accountA.id, pattern: 'pix', entityId: s.supplier.id });

    // Leitor não aplica.
    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const viewer = client(h, viewerUser.cookie);
    await viewer.post(`/api/statement-imports/${imp.id}/apply-rules`, {}, 403);
    await viewer.post('/api/classification-rules/apply', { accountId: s.accountA.id }, 403);

    expect(await admin.post(`/api/statement-imports/${imp.id}/apply-rules`)).toEqual({ updated: 1 });
    const after = (await admin.get(`/api/statement-imports/${imp.id}`)).lines;
    expect(byFitid(after, 'OFX2-0004')).toMatchObject({
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      classificationSource: 'rule',
      classificationRuleId: internet.id,
    });
    expect(byFitid(after, 'OFX2-0006')).toMatchObject({ classificationSource: 'user', entityId: s.holderB.id });
    expect(byFitid(after, 'OFX2-0002')).toMatchObject({ classificationSource: 'agent', entityId: s.holderB.id });
    const rule = (await admin.get(`/api/classification-rules?caixaId=${s.caixaA.id}`)).find((r: any) => r.id === internet.id);
    expect(rule.usageCount).toBe(1);

    // De novo, pela caixa: nada muda e o uso não conta outra vez.
    expect(await admin.post('/api/classification-rules/apply', { accountId: s.accountA.id })).toEqual({ updated: 0 });

    // Regra arquivada: a linha classificada por ela perde a classificação.
    await admin.del(`/api/classification-rules/${internet.id}`);
    expect(await admin.post('/api/classification-rules/apply', { accountId: s.accountA.id })).toEqual({ updated: 1 });
    const cleared = (await admin.get(`/api/statement-imports/${imp.id}`)).lines;
    expect(byFitid(cleared, 'OFX2-0004')).toMatchObject({ classificationSource: null, entityId: null, categoryId: null });
  });

  it('busca pela descrição em todos os lotes da conta ou nos escolhidos', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const url = `/api/statement-imports?accountId=${s.accountA.id}&fileName=extrato.ofx`;
    const imp = (await upload(adminSession.cookie, url, fixture('extrato-ofx2.ofx'), 'application/x-ofx')).json();

    const all = await admin.get(`/api/statement-lines?accountId=${s.accountA.id}&q=pix`);
    expect(all.map((l: any) => l.fitid)).toEqual(['OFX2-0006', 'OFX2-0002']);
    expect(all.every((l: any) => l.importId === imp.id)).toBe(true);

    const chosen = await admin.get(`/api/statement-lines?accountId=${s.accountA.id}&q=PIX&importIds=${imp.id}`);
    expect(chosen).toHaveLength(2);
    const other = '00000000-0000-4000-8000-000000000000';
    expect(await admin.get(`/api/statement-lines?accountId=${s.accountA.id}&q=pix&importIds=${other}`)).toEqual([]);
    // Outra conta não vê as linhas desta; texto curto demais é recusado.
    expect(await admin.get(`/api/statement-lines?accountId=${s.accountB.id}&q=pix`)).toEqual([]);
    await admin.get(`/api/statement-lines?accountId=${s.accountA.id}&q=p`, 400);

    // Quem não lê a caixa não busca.
    const outsider = client(h, (await userSession(h)).cookie);
    const res = await outsider.raw('GET', `/api/statement-lines?accountId=${s.accountA.id}&q=pix`);
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('OFX com extratos de várias contas (spec 009)', () => {
  it('importa só o extrato da conta de destino; sem casamento pede a escolha; o saldo do arquivo é o do extrato do lote', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const file = fixture('extrato-duas-contas.ofx');
    const checking = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'checking',
      name: 'Santander CC',
      bankCode: '033',
      accountNumber: '1300012-3',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const savings = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'savings',
      name: 'Santander Poupança',
      bankCode: '033',
      accountNumber: '60000987-6',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const inspect = (accountId: string) =>
      upload(adminSession.cookie, `/api/statements/inspect?accountId=${accountId}&fileName=x.ofx`, file).then((r) => r.json());
    const importUrl = (accountId: string, extra = '') => `/api/statement-imports?accountId=${accountId}&fileName=duas.ofx${extra}`;
    const fitids = (imp: any) => imp.lines.map((l: any) => l.fitid).sort();

    // A leitura prévia lista as duas contas e já escolhe a que casa com o número cadastrado.
    const seen = await inspect(checking.id);
    expect(seen.ofx).toMatchObject({ position: 1, accountId: '013000123', count: 3, selected: 1 });
    expect(seen.ofx.statements.map((st: any) => [st.accountId, st.accountType, st.count])).toEqual([
      ['013000123', 'CHECKING', 3],
      ['600009876', 'SAVINGS', 2],
    ]);
    expect((await inspect(savings.id)).ofx).toMatchObject({ position: 2, selected: 2, ledgerBalance: { amountCents: 120_840 } });

    // Conta corrente: só as 3 linhas dela, saldo do extrato dela, e a poupança avisada como de fora.
    const res = await upload(adminSession.cookie, importUrl(checking.id), file, 'application/x-ofx');
    expect(res.statusCode, res.body).toBe(200);
    const cc = res.json();
    expect(fitids(cc)).toEqual(['DUAS-CC-001', 'DUAS-CC-002', 'DUAS-CC-003']);
    expect(cc).toMatchObject({ bankBalanceCents: 265_010, bankBalanceOn: '2026-10-31', ofxLeftOut: ['Poupança 600009876 (banco 033)'] });

    // Poupança pelo número cadastrado: só as linhas dela.
    const pp = (await upload(adminSession.cookie, importUrl(savings.id), file, 'application/x-ofx')).json();
    expect(fitids(pp)).toEqual(['DUAS-PP-001', 'DUAS-PP-002']);
    expect(pp.bankBalanceCents).toBe(120_840);

    // Conta sem número cadastrado: nada casa, o import pede a escolha e lista as contas do arquivo.
    const inspected = await inspect(s.accountA.id);
    expect(inspected.ofx).toMatchObject({ selected: null, suggested: 1 });
    const refused = await upload(adminSession.cookie, importUrl(s.accountA.id), file, 'application/x-ofx');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('statement_ofx_choose_account');
    expect(refused.json().error.message).toContain('2 = Poupança 600009876 (banco 033)');
    const missing = await upload(adminSession.cookie, importUrl(s.accountA.id, '&ofxStatement=3'), file, 'application/x-ofx');
    expect(missing.json().error.code).toBe('statement_ofx_statement');

    // Escolhido o 2º extrato: as linhas e o saldo da poupança; "voltar ao saldo do arquivo" relê o mesmo extrato.
    const chosen = (await upload(adminSession.cookie, importUrl(s.accountA.id, '&ofxStatement=2'), file, 'application/x-ofx')).json();
    expect(fitids(chosen)).toEqual(['DUAS-PP-001', 'DUAS-PP-002']);
    expect(chosen).toMatchObject({ bankBalanceCents: 120_840, ofxLeftOut: ['Conta corrente 013000123 (banco 033)'] });
    await admin.put(`/api/statement-imports/${chosen.id}/bank-balance`, { mode: 'clear' });
    const restored = await admin.put(`/api/statement-imports/${chosen.id}/bank-balance`, { mode: 'file' });
    expect(restored).toMatchObject({ bankBalanceCents: 120_840, bankBalanceOn: '2026-10-31' });
  });
});

describe('saldo do banco do lote (spec 009)', () => {
  it('edita, limpa e volta ao saldo do arquivo; divergência do intervalo contra o lote anterior', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const url = (name: string) => `/api/statement-imports?accountId=${s.accountA.id}&fileName=${name}`;
    const first = (await upload(adminSession.cookie, url('a.ofx'), fixture('extrato-ofx2.ofx'), 'application/x-ofx')).json();
    // O mesmo extrato com outros FITIDs: mesmo saldo do banco na mesma data, nenhuma divergência nova.
    const copy = Buffer.from(fixture('extrato-ofx2.ofx').toString('latin1').replaceAll('OFX2-', 'OFX3-'), 'latin1');
    const second = (await upload(adminSession.cookie, url('b.ofx'), copy, 'application/x-ofx')).json();
    expect(first).toMatchObject({ bankBalanceCents: 278_620, bankBalanceOn: '2026-10-31', intervalDifferenceCents: null });
    expect(first.accountOpeningDate).toBe('2026-01-01');
    expect(second.intervalDifferenceCents).toBe(0);

    // Leitor não edita.
    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    await client(h, viewerUser.cookie).put(`/api/statement-imports/${second.id}/bank-balance`, { mode: 'clear' }, 403);

    const edited = await admin.put(`/api/statement-imports/${second.id}/bank-balance`, {
      mode: 'set',
      amountCents: 288_620,
      on: '2026-10-31',
    });
    expect(edited).toMatchObject({ bankBalanceCents: 288_620, differenceCents: first.differenceCents + 10_000 });
    expect(edited.intervalDifferenceCents).toBe(10_000);

    const cleared = await admin.put(`/api/statement-imports/${second.id}/bank-balance`, { mode: 'clear' });
    expect(cleared).toMatchObject({ bankBalanceCents: null, bankBalanceOn: null, differenceCents: null, intervalDifferenceCents: null });

    const restored = await admin.put(`/api/statement-imports/${second.id}/bank-balance`, { mode: 'file' });
    expect(restored).toMatchObject({ bankBalanceCents: 278_620, bankBalanceOn: '2026-10-31', intervalDifferenceCents: 0 });
    await admin.put(`/api/statement-imports/${second.id}/bank-balance`, { mode: 'set', amountCents: 1 }, 400);
  });
});

describe('renomear o arquivo do lote (spec 009)', () => {
  it('troca o nome do anexo, sem caminho; leitor não renomeia e nome vazio é recusado', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const imp = (
      await upload(
        adminSession.cookie,
        `/api/statement-imports?accountId=${s.accountA.id}&fileName=a.ofx`,
        fixture('extrato-ofx2.ofx'),
        'application/x-ofx',
      )
    ).json();

    const renamed = await admin.put(`/api/statement-imports/${imp.id}/file-name`, { fileName: 'pasta/Extrato outubro.ofx' });
    expect(renamed.fileName).toBe('Extrato outubro.ofx');
    expect(renamed.lineCount).toBe(imp.lineCount);
    const listed = await admin.get(`/api/statement-imports?accountId=${s.accountA.id}`);
    expect(listed.find((i: any) => i.id === imp.id).fileName).toBe('Extrato outubro.ofx');

    await admin.put(`/api/statement-imports/${imp.id}/file-name`, { fileName: '  ' }, 400);
    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    await client(h, viewerUser.cookie).put(`/api/statement-imports/${imp.id}/file-name`, { fileName: 'x.ofx' }, 403);
  });
});

/* ---------------- ocorrências de série no extrato (specs 033 e 034) ---------------- */

function ofxOf(lines: { date: string; cents: number; memo: string }[]) {
  const key = Math.random().toString(36).slice(2, 10);
  const trn = lines
    .map(
      (l, i) =>
        `<STMTTRN><TRNTYPE>${l.cents < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${l.date.replaceAll('-', '')}120000</DTPOSTED>` +
        `<TRNAMT>${(l.cents / 100).toFixed(2)}</TRNAMT><FITID>${key}-${i}</FITID><NAME>${l.memo}</NAME></STMTTRN>`,
    )
    .join('\n');
  const dates = lines.map((l) => l.date.replaceAll('-', '')).sort();
  return Buffer.from(`OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>341</BANKID><ACCTID>9</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${dates[0]}</DTSTART><DTEND>${dates.at(-1)}</DTEND>
${trn}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
}

describe('ocorrências de série no extrato (specs 033 e 034)', () => {
  it('conta prevista da ocorrência: só a conta da série acha a ocorrência; "esta e as próximas" leva a conta junto', async () => {
    const { admin, s, rule, rows, importLines } = await rentSetup();
    const other = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'savings',
      name: 'Poupança A',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    // A linha na poupança não acha a ocorrência prevista na corrente (pela regra da série; nem pelo valor exato, fora dos 3 dias).
    const imp = await importLines(other.id, [{ date: '2026-11-20', cents: -200_000, memo: 'PIX ALUGUEL' }]);
    expect(imp.lines[0].status).toBe('new');
    // Conta de outra caixa não vale como conta prevista (sem conta de passagem desde a F20).
    const otherCaixa = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
      kind: 'checking',
      name: 'Banco B',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const refused = await admin.raw('PATCH', `/api/titles/${rows[1].id}`, { plannedAccountId: otherCaixa.id });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('titles_planned_account_check');
    // Só esta: conta própria; esta e as próximas: as seguintes em aberto mudam e seguem a série.
    expect(await admin.patch(`/api/titles/${rows[1].id}`, { plannedAccountId: other.id })).toMatchObject({
      plannedAccountId: other.id,
      plannedAccountCustom: true,
    });
    await admin.patch(`/api/titles/${rows[2].id}`, { plannedAccountId: other.id, scope: 'following' });
    const after = await h.db.execute<{ occurrence: number; planned_account_id: string }>(sql`
      SELECT occurrence, planned_account_id FROM titles WHERE recurrence_rule_id = ${rule.id} ORDER BY occurrence`);
    expect(after.rows.map((r) => r.planned_account_id === other.id)).toEqual([false, true, true, true, true, true]);
    // A ocorrência nova do worker copia a conta da mais recente.
    const series = await admin.get(`/api/series/${rule.id}`);
    expect(series).toMatchObject({ accountId: s.accountA.id });
    const imp2 = await importLines(other.id, [{ date: '2027-01-20', cents: -200_000, memo: 'PIX ALUGUEL' }]);
    expect(imp2.lines[0]).toMatchObject({ status: 'suggested', titleId: rows[2].id });
  });

  it('tools: candidatos e prévia de match_statement_line com a repartição; update_series e update_title com a conta prevista', async () => {
    const { s, rule, rows, importLines } = await rentSetup({ lateFeePercent: 2, interestMonthPercent: 1 });
    const imp = await importLines(s.accountA.id, [{ date: '2026-11-20', cents: -204_667, memo: 'PIX ALUGUEL' }]);
    const [line] = imp.lines;
    const session = await userSession(h, 'admin');
    const actor = {
      id: session.id,
      username: session.username,
      email: `${session.username}@teste.local`,
      role: 'admin' as const,
      isActive: true,
    };
    const ctx: ServiceContext = { db: h.db, access: await loadAccess(h.db, actor), config: h.config };
    const tool = (name: string, raw: Record<string, unknown>) => {
      const input = AGENT_TOOLS.find((d) => d.name === name)!.input.parse(raw);
      const handler = TOOL_HANDLERS[name as keyof typeof TOOL_HANDLERS]!;
      return {
        preview: () => handler.preview!(ctx, input as never),
        run: () => handler.run(ctx, input as never, {} as never) as Promise<any>,
      };
    };
    const candidates = await tool('list_line_candidates', { lineId: line.id }).run();
    expect(candidates[0]).toMatchObject({
      id: rows[0].id,
      series: { ruleId: rule.id, occurrence: 1, split: { kind: 'charges', fineCents: 4_000, interestCents: 667, days: 10 } },
    });
    const preview = await tool('match_statement_line', { lineId: line.id, titleId: rows[0].id }).preview();
    expect(preview.rows).toEqual(
      expect.arrayContaining([
        { label: 'Principal', after: '2000,00' },
        { label: 'Multa', after: '40,00' },
        { label: 'Juros', after: '6,67' },
      ]),
    );
    expect((preview.warnings ?? []).join(' ')).toContain('10 dia(s) de atraso');

    const update = await tool('update_series', { ruleId: rule.id, changes: { toleranceCents: 1_000, autoSettle: true } }).preview();
    expect(update.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Baixar sem confirmação', after: 'Sim' })]));
    const updated = await tool('update_series', { ruleId: rule.id, changes: { toleranceCents: 1_000, autoSettle: true } }).run();
    expect(updated.terms).toMatchObject({ toleranceCents: 1_000, autoSettle: true });
    const other = await client(h, session.cookie).post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'checking',
      name: 'Banco A2',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const titlePreview = await tool('update_title', { titleId: rows[1].id, changes: { plannedAccountId: other.id } }).preview();
    expect(titlePreview.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Conta prevista' })]));
    expect(titlePreview.warnings?.[0]).toContain('conta própria');
    const edited = await tool('update_title', { titleId: rows[1].id, changes: { plannedAccountId: other.id } }).run();
    expect(edited).toMatchObject({ plannedAccountId: other.id, plannedAccountCustom: true });
  });

  /** Aluguel a pagar de R$ 2.000,00 (dia 10), série solta na conta corrente, nov/2026 a abr/2027. */
  async function rentSetup(terms: Record<string, unknown> = {}) {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const first = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: `Aluguel ${s.tag}`,
      competenceDate: '2026-11-01',
      dueDate: '2026-11-10',
      amountCents: 200_000,
      mirrorCaixaId: null,
      plannedAccountId: s.accountA.id,
      seriesTerms: terms,
      series: { kind: 'recurrence', frequency: 'monthly', intervalCount: 1, endsOn: '2027-04-30' },
    });
    const listed = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM titles WHERE recurrence_rule_id = ${first.rule.id} ORDER BY occurrence`,
    );
    const importLines = async (accountId: string, lines: { date: string; cents: number; memo: string }[]) => {
      const res = await upload(
        adminSession.cookie,
        `/api/statement-imports?accountId=${accountId}&fileName=extrato.ofx`,
        ofxOf(lines),
        'application/x-ofx',
      );
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    return { admin, s, rule: first.rule, rows: listed.rows as any[], importLines };
  }
});
