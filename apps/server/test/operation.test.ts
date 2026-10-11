import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrCode } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

let h: Harness;
let startedAt: string;
beforeAll(async () => {
  h = await startApp();
  startedAt = (await h.db.execute<{ now: string }>(sql`SELECT now()::text AS now`)).rows[0]!.now;
});
afterAll(() => h.close());

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));

describe('auditoria (spec 008)', () => {
  it('registra quem alterou, com antes/depois', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const editor = await userSession(h);
    await admin.put(`/api/users/${editor.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const author = client(h, editor.cookie);
    const title = await author.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Consultoria',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-15',
      amountCents: 10_000,
    });
    await author.patch(`/api/titles/${title.id}`, { amountCents: 12_000 });
    const history = await author.get(`/api/audit/record?table=titles&recordId=${title.id}`);
    expect(history.map((e: any) => e.action)).toEqual(['update', 'insert']);
    expect(history[0]).toMatchObject({ userId: editor.id, username: editor.username, actorKind: 'human' });
    expect(history[0].changedColumns).toContain('amount_cents');
    expect(history[0].oldData.amount_cents).toBe(10_000);
    expect(history[0].newData.amount_cents).toBe(12_000);

    // Sem acesso à caixa, sem histórico; o log geral é só do admin.
    const outsider = client(h, (await userSession(h)).cookie);
    await outsider.get(`/api/audit/record?table=titles&recordId=${title.id}`, 404);
    await outsider.get('/api/audit', 403);
    const log = await admin.get(`/api/audit?userId=${editor.id}&limit=10`);
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('toda escrita feita pela API registra o usuário (nenhuma linha de sistema)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    await admin.post(`/api/accounts/${s.accountA.id}/adjustments`, { occurredOn: '2026-10-02', amountCents: 500, description: 'Ajuste' });
    await admin.post('/api/categories', { kind: 'expense', name: `Cat ${s.tag}` });
    await admin.del(`/api/caixas/${s.caixaB.id}`);
    // Os usuários dos testes são criados direto no banco (helpers): fora isso, tudo tem ator.
    const result = await h.db.execute<{ table_name: string; n: number }>(sql`
      SELECT table_name, count(*)::int AS n FROM audit_log
       WHERE created_at >= ${startedAt}::timestamptz AND actor_kind = 'system' AND table_name <> 'users'
       GROUP BY table_name`);
    expect(result.rows).toEqual([]);
  });
});

describe('fechamento de mês (spec 008)', () => {
  it('bloqueia lançamentos do mês fechado até o admin reabrir', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const editor = await userSession(h);
    await admin.put(`/api/users/${editor.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const user = client(h, editor.cookie);

    // Linha de extrato pendente no mês: fechar pede confirmação (force).
    await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports?accountId=${s.accountA.id}&fileName=e.ofx`,
      payload: fixture('extrato-ofx2.ofx'),
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-ofx' },
    });
    const pending = await user.raw('POST', `/api/caixas/${s.caixaA.id}/closings`, { month: '2026-10' });
    expect(pending.statusCode).toBe(422);
    expect(pending.json().error.code).toBe('closing_unreconciled');
    const closed = await user.post(`/api/caixas/${s.caixaA.id}/closings`, { month: '2026-10', force: true });
    expect(closed.closings.map((c: any) => c.month)).toEqual(['2026-10-01']);
    expect(closed.closings[0].closedByUserId).toBe(editor.id);

    const blocked = await user.raw('POST', `/api/accounts/${s.accountA.id}/adjustments`, {
      occurredOn: '2026-10-05',
      amountCents: 100,
      description: 'Ajuste',
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('period_closings_locked_check');
    // Outro mês continua livre.
    await user.post(`/api/accounts/${s.accountA.id}/adjustments`, { occurredOn: '2026-11-05', amountCents: 100, description: 'Ajuste' });

    // A caixa com fechamento não é excluída: é arquivada.
    // Reabrir: só admin.
    await user.del(`/api/caixas/${s.caixaA.id}/closings/2026-10-01`, 403);
    const reopened = await admin.del(`/api/caixas/${s.caixaA.id}/closings/2026-10-01`);
    expect(reopened.closings).toEqual([]);
    await user.post(`/api/accounts/${s.accountA.id}/adjustments`, { occurredOn: '2026-10-05', amountCents: 100, description: 'Ajuste' });
  });

  it('estorno com desfazer transferência é barrado se a transferência caiu em mês fechado', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const accountB2 = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
      kind: 'checking',
      name: 'Banco B',
      bankCode: '341',
      openingBalanceCents: 50_000,
      openingDate: '2026-01-01',
    });
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Pago por B',
      competenceDate: '2026-09-01',
      dueDate: '2026-09-10',
      amountCents: 5_000,
      mirrorCaixaId: null,
    });
    const settled = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-09-10',
      amountCents: 5_000,
      financialAccountId: s.accountA.id,
      sourceAccountId: accountB2.id,
    });
    await admin.post(`/api/caixas/${s.caixaB.id}/closings`, { month: '2026-09' });
    const res = await admin.raw('POST', `/api/settlements/${settled.settlements[0].id}/reverse`, {
      reason: 'erro',
      reversedOn: '2026-10-11',
      undoTransfer: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('period_closings_locked_check');
    // Sem desfazer a transferência, o estorno sai (na data do estorno).
    await admin.post(`/api/settlements/${settled.settlements[0].id}/reverse`, { reason: 'erro', reversedOn: '2026-10-11', undoTransfer: false });
    // Caixa com fechamento é arquivada em vez de excluída.
    expect(await admin.del(`/api/caixas/${s.caixaB.id}`)).toEqual({ deleted: false, archived: true });
  });
});

describe('anexos', () => {
  it('envia, lista, baixa e remove o anexo de um título', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Com boleto',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-15',
      amountCents: 1_000,
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/attachments?target=title&targetId=${title.id}&fileName=${encodeURIComponent('boleto outubro.pdf')}`,
      payload: Buffer.from('%PDF-1.4 conteúdo de teste'),
      headers: { cookie: session.cookie, 'content-type': 'application/pdf' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const attachment = res.json();
    expect(attachment).toMatchObject({ fileName: 'boleto outubro.pdf', mimeType: 'application/pdf' });
    expect((await admin.get(`/api/titles/${title.id}`)).attachmentCount).toBe(1);
    const list = await admin.get(`/api/attachments?target=title&targetId=${title.id}`);
    expect(list).toHaveLength(1);
    const file = await h.app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}/download`, headers: { cookie: session.cookie } });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.body).toContain('conteúdo de teste');
    // Quem não lê a caixa não baixa.
    const outsider = await userSession(h);
    const denied = await h.app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}/download`, headers: { cookie: outsider.cookie } });
    expect(denied.statusCode).toBe(404);
    await admin.del(`/api/attachments/${attachment.id}?target=title&targetId=${title.id}`);
    expect(await admin.get(`/api/attachments?target=title&targetId=${title.id}`)).toEqual([]);
  });
});

describe('entrada de títulos (spec 010)', () => {
  it('boleto pela linha digitável grava o código de barras; não repete na caixa', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const base = {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Boleto',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-20',
      amountCents: 123_456,
      boletoBarcode: '34191.79001 10104.351001 47910.201509 1 16050000123456',
    };
    const title = await admin.post('/api/titles', base);
    expect(title.boletoBarcode).toBe('34191160500001234561790010104351004791020150');
    expect((await admin.raw('POST', '/api/titles', base)).statusCode).toBe(409);
    expect((await admin.raw('POST', '/api/titles', { ...base, boletoBarcode: '34191.79001 10104.351001 47910.201509 2 16050000123456' })).statusCode).toBe(422);
  });

  it('PIX copia-e-cola acha ou cria o recebedor pela chave', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const payload = buildBrCode({
      pixKey: `pix-${s.tag}@exemplo.com`,
      merchantName: `Fulano ${s.tag}`,
      merchantCity: 'Sao Paulo',
      amountCents: 4_990,
      txid: 'PEDIDO1',
    });
    const first = await admin.post('/api/title-entry/pix', { payload });
    expect(first).toMatchObject({ entity: null, amountCents: 4_990, pixKeyType: 'email' });
    const created = await admin.post('/api/title-entry/pix', { payload, createEntity: true });
    expect(created.createdEntity).toBe(true);
    const again = await admin.post('/api/title-entry/pix', { payload });
    expect(again.entity.id).toBe(created.entity.id);
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: created.entity.id,
      categoryId: s.expense.id,
      description: 'PIX',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-20',
      amountCents: 4_990,
      pixPayload: payload,
    });
    expect(title.pixPayload).toBe(payload);
    expect((await admin.raw('POST', '/api/title-entry/pix', { payload: `${payload.slice(0, -1)}0` })).statusCode).toBe(422);
  });

  it('NF-e: o emitente vira entidade, a nota guarda itens e XML; reimportar devolve a mesma', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const s = await scenario(h, admin);
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/title-entry/nfe?fileName=nfe.xml',
        payload: fixture('nfe-exemplo.xml'),
        headers: { cookie: session.cookie, 'content-type': 'text/xml' },
      });
    const res = await send();
    expect(res.statusCode, res.body).toBe(200);
    const nfe = res.json();
    expect(nfe).toMatchObject({ totalCents: 43_309, number: 12345, alreadyImported: false });
    expect(nfe.issuer.document).toBe('12345678000195');
    expect(nfe.duplicates).toHaveLength(2);
    const detail = await admin.get(`/api/nfe/${nfe.nfeDocumentId}`);
    expect(detail.items).toHaveLength(3);
    expect((await send()).json()).toMatchObject({ nfeDocumentId: nfe.nfeDocumentId, alreadyImported: true });
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: nfe.issuer.entityId,
      categoryId: s.expense.id,
      description: 'NF 12345',
      competenceDate: '2026-10-05',
      dueDate: '2026-11-10',
      amountCents: 21_655,
      nfeDocumentId: nfe.nfeDocumentId,
    });
    expect(title.nfeDocumentId).toBe(nfe.nfeDocumentId);
    // Leitura de PDF/imagem por IA: ponto de extensão, chega na F4.
    const reader = await h.app.inject({
      method: 'POST',
      url: '/api/title-entry/document?fileName=boleto.pdf',
      payload: Buffer.from('%PDF-1.4'),
      headers: { cookie: session.cookie, 'content-type': 'application/pdf' },
    });
    expect(reader.statusCode).toBe(501);
  });
});

describe('calendário (spec 012)', () => {
  it('lista títulos e faturas abertas por vencimento e o saldo projetado', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'receivable',
      entityId: s.supplier.id,
      categoryId: s.income.id,
      description: 'Recebimento',
      competenceDate: '2030-01-01',
      dueDate: '2030-01-20',
      amountCents: 30_000,
    });
    const items = await admin.get(`/api/calendar?from=2030-01-01&to=2030-01-31&caixaIds=${s.caixaA.id}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ titleId: title.id, calendarStatus: 'receivable', canWrite: true });
    // Arrastar = PATCH do vencimento.
    await admin.patch(`/api/titles/${title.id}`, { dueDate: '2030-01-25' });
    const moved = await admin.get(`/api/calendar?from=2030-01-01&to=2030-01-31&caixaIds=${s.caixaA.id}`);
    expect(moved[0].dueDate).toBe('2030-01-25');

    const days = await admin.get(`/api/calendar/balances?from=2030-01-24&to=2030-01-26&caixaId=${s.caixaA.id}`);
    expect(days.map((d: any) => d.projectedCents)).toEqual([100_000, 130_000, 130_000]);
    expect((await admin.raw('GET', `/api/calendar?from=2030-01-01&to=2035-01-01`)).statusCode).toBe(422);
  });
});
