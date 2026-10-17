import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      caixaId: s.caixaA.id,
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
    expect(created.status).toBe('matched');
    const purchases = await admin.get(`/api/cards/${card.id}/purchases`);
    expect(purchases.map((p: any) => p.amountCents).sort()).toEqual([12_000, 25_000]);
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
      caixaId: s.caixaA.id,
      pattern: 'internet',
      direction: 'out',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });
    await admin.post('/api/classification-rules', { caixaId: s.caixaA.id, pattern: 'pix', entityId: s.supplier.id });

    // Leitor não aplica.
    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const viewer = client(h, viewerUser.cookie);
    await viewer.post(`/api/statement-imports/${imp.id}/apply-rules`, {}, 403);
    await viewer.post('/api/classification-rules/apply', { caixaId: s.caixaA.id }, 403);

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
    expect(await admin.post('/api/classification-rules/apply', { caixaId: s.caixaA.id })).toEqual({ updated: 0 });

    // Regra arquivada: a linha classificada por ela perde a classificação.
    await admin.del(`/api/classification-rules/${internet.id}`);
    expect(await admin.post('/api/classification-rules/apply', { caixaId: s.caixaA.id })).toEqual({ updated: 1 });
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
