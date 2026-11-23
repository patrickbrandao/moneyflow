import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Database, type Executor, userColumns, users } from '@moneyflow/db';
import { addDays, isoWeekday, todayIso } from '@moneyflow/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '../src/agents/tool-handlers';
import { type Actor, loadAccess } from '../src/authz/access';
import {
  consumeOutbox,
  emitAgentEvent,
  logMessageTick,
  type MessageLoopState,
  messageTick,
  produceMessages,
  produceNotifications,
} from '../src/services/message-worker';
import { deliver } from '../src/services/messages';
import { client, type Harness, scenario, startApp, uid, userSession } from './helpers';

/*
 * Fase 3: relatórios (permissão por caixa e is_internal), canvas de fluxo
 * (grafo, linhas e posições), mensagens (token write-only, assinaturas,
 * produtor com dedup, consumidor com a Bot API mockada) e o sino.
 */

type TelegramCall = { path: string; body: { chat_id: string; text: string; parse_mode: string } };
const telegram = { mode: 'ok' as 'ok' | '429' | '400', calls: [] as TelegramCall[], nextId: 100 };
let mock: Server;
let h: Harness;

const TOKEN = '123456789:AAHsecretSECRETsecret_0123456789abc';
const SECRET = TOKEN.split(':')[1]!;

beforeAll(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      telegram.calls.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
      res.setHeader('content-type', 'application/json');
      if (telegram.mode === '429') {
        res.statusCode = 429;
        res.end(
          JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }),
        );
      } else if (telegram.mode === '400') {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
      } else {
        telegram.nextId += 1;
        res.end(JSON.stringify({ ok: true, result: { message_id: telegram.nextId } }));
      }
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = (mock.address() as AddressInfo).port;
  h = await startApp({ TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_TIMEOUT_MS: '3000' });
});
afterAll(async () => {
  await h.close();
  await new Promise((resolve) => mock.close(resolve));
});
beforeEach(() => {
  telegram.mode = 'ok';
  telegram.calls = [];
});

/**
 * O banco de verdade, guardando o SQL de cada `execute` (fora das transações) e recusando o que casar
 * com `fail` (tarefas 104 e 166).
 */
function spyDb(fail: RegExp | null = null) {
  const dialect = new PgDialect();
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = new Proxy(h.db, {
    get(target, prop) {
      if (prop === 'execute') {
        return (query: SQL) => {
          const rendered = dialect.sqlToQuery(query);
          seen.push(rendered);
          if (fail?.test(rendered.sql)) return Promise.reject(new Error('falha simulada na consulta'));
          return target.execute(query);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database;
  return { db, seen };
}

const year = todayIso().slice(0, 4);
const period = `from=${year}-01-01&to=${year}-12-31`;

/** Cenário: A paga B (espelho, interno quando as duas estão na seleção), A paga fornecedor, cartão de A com compra. */
async function visionScenario(admin: ReturnType<typeof client>) {
  const s = await scenario(h, admin);
  const internal = await admin.post('/api/titles', {
    caixaId: s.caixaA.id,
    direction: 'payable',
    entityId: s.holderB.id,
    categoryId: s.expense.id,
    description: 'Mesada',
    competenceDate: `${year}-03-05`,
    dueDate: `${year}-03-10`,
    amountCents: 30_000,
  });
  const external = await admin.post('/api/titles', {
    caixaId: s.caixaA.id,
    direction: 'payable',
    entityId: s.supplier.id,
    categoryId: s.expense.id,
    description: 'Energia',
    competenceDate: `${year}-03-01`,
    dueDate: `${year}-03-15`,
    amountCents: 12_000,
  });
  await admin.post(`/api/titles/${external.id}/settlements`, {
    settledOn: `${year}-03-15`,
    amountCents: 12_000,
    financialAccountId: s.accountA.id,
  });
  const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${s.tag}` });
  const store = await admin.post('/api/entities', { kind: 'company', name: `Loja ${s.tag}` });
  const card = await admin.post('/api/caixas', {
    name: `Cartão ${s.tag}`,
    kind: 'credit_card',
    holderEntityId: issuer.id,
    defaultPayerCaixaId: s.caixaA.id,
    creditLimitCents: 100_000,
    closingDay: 3,
    dueDay: 10,
    cardLast4: '4321',
  });
  const purchase = await admin.post(`/api/cards/${card.id}/purchases`, {
    entityId: store.id,
    categoryId: s.expense.id,
    purchasedOn: todayIso(),
    description: 'Supermercado',
    amountCents: 85_000,
  });
  return { ...s, internal, external, issuer, store, card, purchase };
}

describe('relatórios (spec 014)', () => {
  it('por categoria: consolidado descarta o interno; viewer de uma caixa só enxerga ela', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await visionScenario(admin);
    const both = await admin.get(`/api/reports/categories?${period}&caixaIds=${s.caixaA.id},${s.caixaB.id}`);
    expect(both.basis).toBe('competence');
    expect(both.months).toHaveLength(12);
    // O cartão entra junto (pagadora padrão na seleção).
    expect(both.caixas.map((c: { id: string }) => c.id)).toContain(s.card.id);
    const mine = both.lines.filter((l: any) => l.categoryId === s.expense.id && l.caixaId === s.caixaA.id);
    const internal = mine.find((l: any) => l.isInternal);
    expect(internal.amountCents).toBe(30_000);
    expect(mine.filter((l: any) => !l.isInternal && l.source === 'title').reduce((a: number, l: any) => a + l.amountCents, 0)).toBe(12_000);
    const purchase = both.lines.find((l: any) => l.source === 'card_purchase' && l.cardCaixaId === s.card.id);
    expect(purchase).toMatchObject({ caixaId: s.caixaA.id, amountCents: 85_000, isInternal: false });
    expect(mine[0].groupName).toBe(`Despesa ${s.tag}`);

    // Só A: o mesmo título não é interno (B não está na lista).
    const onlyA = await admin.get(`/api/reports/categories?${period}&caixaIds=${s.caixaA.id}`);
    expect(onlyA.lines.some((l: any) => l.isInternal)).toBe(false);

    // Regime de caixa: só a baixa.
    const cash = await admin.get(`/api/reports/categories?${period}&caixaIds=${s.caixaA.id}&basis=cash`);
    const settled = cash.lines.filter((l: any) => l.categoryId === s.expense.id);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ source: 'settlement', amountCents: 12_000 });

    const viewerUser = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerUser.id, role: 'viewer' });
    const viewer = client(h, viewerUser.cookie);
    const scoped = await viewer.get(`/api/reports/categories?${period}`);
    const ids = scoped.caixas.map((c: { id: string }) => c.id);
    expect(ids).toContain(s.caixaA.id);
    expect(ids).toContain(s.card.id);
    expect(ids).not.toContain(s.caixaB.id);
    expect(scoped.lines.every((l: any) => l.caixaId !== s.caixaB.id)).toBe(true);
    await viewer.get(`/api/reports/categories?${period}&caixaIds=${s.caixaB.id}`, 404);
    await viewer.get(`/api/reports/categories?from=${year}-02-01&to=${year}-01-01`, 400);
  });

  it('por entidade rastreia o recebedor final pelo cartão; projeção 30/60/90 por caixa e conta', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await visionScenario(admin);
    const report = await admin.get(`/api/reports/entities?${period}&caixaIds=${s.caixaA.id}`);
    const store = report.lines.find((l: any) => l.entityId === s.store.id);
    expect(store).toMatchObject({ source: 'card_purchase', caixaId: s.caixaA.id, cardCaixaId: s.card.id, outflowCents: 85_000 });
    expect(store.cardName).toBe(`Cartão ${s.tag}`);

    const projection = await admin.get(`/api/reports/projection?caixaIds=${s.caixaA.id}`);
    expect(projection.horizons).toEqual([30, 60, 90]);
    const caixaRows = projection.lines.filter((l: any) => l.caixaId === s.caixaA.id && l.financialAccountId === null);
    expect(caixaRows.map((l: any) => l.horizonDays)).toEqual([30, 60, 90]);
    expect(projection.lines.some((l: any) => l.financialAccountId === s.accountA.id && l.accountName === 'Banco A')).toBe(true);
    // Cartão não entra na projeção (a fatura aparece na pagadora).
    expect(projection.lines.some((l: any) => l.caixaId === s.card.id)).toBe(false);
  });
});

describe('canvas de fluxo (spec 014)', () => {
  it('nós, arestas, linhas com link e posições por usuário', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await visionScenario(admin);
    const graph = await admin.get(`/api/flow?${period}&caixaIds=${s.caixaA.id},${s.caixaB.id}`);
    const nodeIds = graph.nodes.map((n: any) => n.id);
    expect(nodeIds).toEqual(expect.arrayContaining([s.caixaA.id, s.caixaB.id, s.card.id, s.supplier.id, s.store.id]));
    const caixaA = graph.nodes.find((n: any) => n.id === s.caixaA.id);
    expect(caixaA.kind).toBe('caixa');
    expect(caixaA.balanceCents).toBe(100_000 - 12_000);
    const card = graph.nodes.find((n: any) => n.id === s.card.id);
    expect(card).toMatchObject({ caixaKind: 'credit_card', cardUsedCents: 85_000, cardLimitCents: 100_000 });

    const paid = graph.edges.find((e: any) => e.sourceId === s.caixaA.id && e.targetId === s.supplier.id);
    expect(paid).toMatchObject({ edgeKind: 'payment', realizedCents: 12_000 });
    const pair = graph.edges.filter((e: any) => e.sourceId === s.caixaA.id && e.targetId === s.caixaB.id);
    expect(pair).toHaveLength(1); // o par espelhado conta uma vez só
    expect(pair[0].forecastCents).toBe(30_000);
    const purchase = graph.edges.find((e: any) => e.edgeKind === 'card_purchase' && e.targetId === s.store.id);
    expect(purchase).toMatchObject({ sourceId: s.card.id, payerCaixaId: s.caixaA.id, realizedCents: 85_000 });

    const lines = await admin.get(
      `/api/flow/lines?${period}&caixaIds=${s.caixaA.id},${s.caixaB.id}&sourceKind=caixa&sourceId=${s.caixaA.id}&targetKind=entity&targetId=${s.supplier.id}&edgeKind=payment`,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      refKind: 'settlement',
      description: 'Energia',
      realizedCents: 12_000,
      sourceName: `Caixa A ${s.tag}`,
    });
    expect(lines[0].link).toBe(`/caixas/${s.caixaA.id}/payables?title=${s.external.id}`);
    const storeLines = await admin.get(`/api/flow/lines?${period}&caixaIds=${s.caixaA.id}&nodeKind=entity&nodeId=${s.store.id}`);
    expect(storeLines[0].link).toBe(`/caixas/${s.card.id}/purchases?purchase=${s.purchase.id}`);

    await admin.put('/api/flow/positions', {
      positions: [
        { nodeKind: 'caixa', nodeId: s.caixaA.id, x: 10, y: 20 },
        { nodeKind: 'entity', nodeId: s.store.id, x: 300, y: -48 },
      ],
    });
    await admin.put('/api/flow/positions', { positions: [{ nodeKind: 'caixa', nodeId: s.caixaA.id, x: 48, y: 72 }] });
    const again = await admin.get(`/api/flow?${period}&caixaIds=${s.caixaA.id}`);
    expect(again.positions).toEqual(
      expect.arrayContaining([
        { nodeKind: 'caixa', nodeId: s.caixaA.id, x: 48, y: 72 },
        { nodeKind: 'entity', nodeId: s.store.id, x: 300, y: -48 },
      ]),
    );
    // Posições são do usuário: outro admin não as vê.
    const other = client(h, (await userSession(h, 'admin')).cookie);
    const theirs = await other.get(`/api/flow?${period}&caixaIds=${s.caixaA.id}`);
    expect(theirs.positions).toEqual([]);
    await admin.del('/api/flow/positions');
    expect((await admin.get(`/api/flow?${period}&caixaIds=${s.caixaA.id}`)).positions).toEqual([]);

    // Usuário sem a caixa B não a vê no grafo (vira o nó do titular) e não pode pedi-la.
    const viewerUser = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerUser.id, role: 'viewer' });
    const viewer = client(h, viewerUser.cookie);
    const scoped = await viewer.get(`/api/flow?${period}`);
    expect(scoped.nodes.some((n: any) => n.id === s.caixaB.id)).toBe(false);
    expect(scoped.nodes.some((n: any) => n.id === s.holderB.id && n.kind === 'entity')).toBe(true);
    await viewer.get(`/api/flow?${period}&caixaIds=${s.caixaB.id}`, 404);
  });
});

describe('mensagens (spec 013)', () => {
  it('destino: token write-only (nunca devolvido), permissões de dono e assinaturas validadas', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const userSessionA = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: userSessionA.id, role: 'viewer' });
    const user = client(h, userSessionA.cookie);

    const created = await user.post('/api/message-destinations', { name: `Meu Telegram ${s.tag}`, botToken: TOKEN, chatId: '987654' });
    expect(created).toMatchObject({ ownerKind: 'user', botId: '123456789', chatId: '987654', isActive: true, canManage: true });
    expect(JSON.stringify(created)).not.toContain(SECRET);
    const list = await user.raw('GET', '/api/message-destinations');
    expect(list.body).not.toContain(SECRET);
    expect(list.json().map((d: any) => d.id)).toContain(created.id);

    // Global só admin; destino de caixa exige escrita na caixa.
    await user.post('/api/message-destinations', { name: 'Global', ownerKind: 'global', botToken: TOKEN, chatId: '1' }, 403);
    await user.post(
      '/api/message-destinations',
      { name: 'Casa', ownerKind: 'caixa', ownerCaixaId: s.caixaA.id, botToken: TOKEN, chatId: '1' },
      403,
    );
    await user.post('/api/message-destinations', { name: 'Ruim', botToken: 'abc', chatId: '1' }, 400);
    const caixaDest = await admin.post('/api/message-destinations', {
      name: `Grupo da casa ${s.tag}`,
      ownerKind: 'caixa',
      ownerCaixaId: s.caixaA.id,
      botToken: TOKEN,
      chatId: '-100123',
    });
    // O viewer da caixa vê o destino da caixa, mas não gerencia.
    const seen = (await user.get('/api/message-destinations')).find((d: any) => d.id === caixaDest.id);
    expect(seen.canManage).toBe(false);
    await user.patch(`/api/message-destinations/${caixaDest.id}`, { name: 'x' }, 403);
    // Outro usuário nem vê o destino pessoal.
    const stranger = client(h, (await userSession(h)).cookie);
    await stranger.get(`/api/message-destinations/${created.id}`, 404);

    // Trocar o token: o novo também não volta; vazio mantém.
    const updated = await user.patch(`/api/message-destinations/${created.id}`, {
      botToken: '555666777:BBBnewSECRETnewSECRETnew_xyz',
      name: 'Renomeado',
    });
    expect(updated.botId).toBe('555666777');
    expect(JSON.stringify(updated)).not.toContain('BBBnewSECRET');
    expect((await user.patch(`/api/message-destinations/${created.id}`, { botToken: '' })).botId).toBe('555666777');

    // Assinaturas: parâmetros validados; filtro de caixas só com leitura.
    await user.put(
      `/api/message-destinations/${created.id}/subscriptions`,
      { eventKind: 'due_reminder', params: { days_before: [3] } },
      400,
    );
    await user.put(
      `/api/message-destinations/${created.id}/subscriptions`,
      { eventKind: 'daily_summary', params: { send_at: '25:00' } },
      400,
    );
    await user.put(
      `/api/message-destinations/${created.id}/subscriptions`,
      { eventKind: 'daily_summary', params: { send_at: '07:30' }, caixaIds: [s.caixaB.id] },
      404,
    );
    const subs = await user.put(`/api/message-destinations/${created.id}/subscriptions`, {
      eventKind: 'due_reminder',
      params: { days_before: [3, 0], send_at: '08:00' },
      caixaIds: [s.caixaA.id],
    });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      eventKind: 'due_reminder',
      caixaIds: [s.caixaA.id],
      params: { days_before: [3, 0], send_at: '08:00' },
    });
    const cleared = await user.put(`/api/message-destinations/${created.id}/subscriptions`, {
      eventKind: 'due_reminder',
      params: { days_before: [1], send_at: '09:00' },
    });
    expect(cleared[0]).toMatchObject({ caixaIds: [], params: { days_before: [1], send_at: '09:00' } });
    expect(await user.del(`/api/message-destinations/${created.id}/subscriptions/due_reminder`)).toEqual([]);

    // O token também não aparece na auditoria.
    const audit = await admin.raw('GET', `/api/audit?table=message_destinations&recordId=${created.id}`);
    expect(audit.statusCode).toBe(200);
    expect(audit.body).not.toContain(SECRET);
    expect(audit.body).not.toContain('BBBnewSECRET');
  });

  it('enviar teste: sucesso, 429 com retry_after e 400 permanente (com aviso no sino)', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const dest = await admin.post('/api/message-destinations', { name: `Teste ${Date.now()}`, botToken: TOKEN, chatId: '42' });

    const ok = await admin.post(`/api/message-destinations/${dest.id}/test`);
    expect(ok).toMatchObject({ status: 'sent', error: null });
    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(telegram.calls[0]!.body).toMatchObject({ chat_id: '42', parse_mode: 'HTML' });
    expect(telegram.calls[0]!.body.text).toContain('Mensagem de teste do MoneyFlow');

    telegram.mode = '429';
    const limited = await admin.post(`/api/message-destinations/${dest.id}/test`);
    expect(limited.status).toBe('pending');
    expect(limited.error).toContain('429');
    const row = await h.db.execute<{ attempts: number; wait: number }>(
      sql`SELECT attempts, extract(epoch FROM next_attempt_at - now())::int AS wait FROM message_outbox WHERE id = ${limited.messageId}`,
    );
    expect(row.rows[0]!.attempts).toBe(1);
    expect(Number(row.rows[0]!.wait)).toBeGreaterThanOrEqual(5);
    expect(Number(row.rows[0]!.wait)).toBeLessThanOrEqual(8);

    telegram.mode = '400';
    const bad = await admin.post(`/api/message-destinations/${dest.id}/test`);
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('chat not found');
    expect(bad.error).not.toContain(SECRET);

    const history = await admin.get(`/api/message-outbox?destinationId=${dest.id}`);
    expect(history.map((m: any) => m.status).sort()).toEqual(['failed', 'pending', 'sent']);
    expect(JSON.stringify(history)).not.toContain(SECRET);

    const bell = await admin.get('/api/notifications');
    expect(bell.items.some((n: any) => n.kind === 'message_failed' && n.link.includes(dest.id))).toBe(true);

    // Reenviar a que falhou: volta à fila, e o consumidor entrega.
    telegram.mode = 'ok';
    await admin.post(`/api/message-outbox/${bad.messageId}/resend`);
    await admin.post(`/api/message-outbox/${ok.messageId}/resend`, {}, 422);
    await consumeOutbox(h.db, h.config);
    const after = await admin.get(`/api/message-outbox?destinationId=${dest.id}&status=sent`);
    expect(after.map((m: any) => m.id)).toContain(bad.messageId);

    // Desativar cancela as pendentes (a do 429).
    await admin.patch(`/api/message-destinations/${dest.id}`, { isActive: false });
    const canceled = await admin.get(`/api/message-outbox?destinationId=${dest.id}&status=canceled`);
    expect(canceled.map((m: any) => m.id)).toContain(limited.messageId);
    await admin.post(`/api/message-destinations/${dest.id}/test`, {}, 422);
    // Com histórico, excluir arquiva.
    expect(await admin.del(`/api/message-destinations/${dest.id}`)).toEqual({ deleted: false, archived: true });
  });

  it('token indisponível: erro transitório volta à fila; P0002/42501 do banco falham de vez (tarefa 062)', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    const dest = await admin.post('/api/message-destinations', { name: `Token ${uid()}`, botToken: TOKEN, chatId: '62' });
    telegram.mode = '429';
    const queued = await admin.post(`/api/message-destinations/${dest.id}/test`);
    expect(queued.status).toBe('pending');
    telegram.mode = 'ok';
    const claim = async () => {
      const row = await h.db.execute<{ id: string; payload: any }>(
        sql`SELECT id, payload FROM message_outbox_claim_one(${queued.messageId}::uuid)`,
      );
      expect(row.rows).toHaveLength(1);
      return { id: row.rows[0]!.id, chatId: '62', destinationName: dest.name, payload: row.rows[0]!.payload };
    };
    // Executor dublê: a leitura do token (a 1ª consulta do deliver) lança; o resto vai ao banco.
    const flaky = (error: unknown): Executor => {
      let first = true;
      return {
        execute: (query: unknown) => {
          if (first) {
            first = false;
            return Promise.reject(error);
          }
          return h.db.execute(query as never);
        },
      } as unknown as Executor;
    };
    const failedBell = async () =>
      (
        await h.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM notifications WHERE dedup_key = ${`message_failed:${queued.messageId}`}`,
        )
      ).rows[0]!.n;
    const status = async () =>
      (await h.db.execute<{ status: string }>(sql`SELECT status FROM message_outbox WHERE id = ${queued.messageId}`)).rows[0]!.status;

    const transient = await deliver(flaky(new Error('Connection terminated unexpectedly')), h.config, await claim());
    expect(transient.status).toBe('pending');
    expect(await status()).toBe('pending');
    expect(await failedBell()).toBe(0);

    const inactive = Object.assign(new Error('message_destination_token: destino inativo'), { code: 'P0002', severity: 'ERROR' });
    const permanent = await deliver(flaky(inactive), h.config, await claim());
    expect(permanent.status).toBe('failed');
    expect(await status()).toBe('failed');
    expect(await failedBell()).toBe(1);
  });

  it('assinatura que falha ao gerar é logada e contada à parte das falhas de envio (tarefa 063)', async () => {
    const session = await userSession(h, 'admin');
    const admin = client(h, session.cookie);
    // Uma caixa legível no escopo (sem caixa, a assinatura nem consulta os vencimentos).
    await scenario(h, admin);
    const dest = await admin.post('/api/message-destinations', { name: `Falha ${uid()}`, botToken: TOKEN, chatId: '63' });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, {
      eventKind: 'due_reminder',
      params: { days_before: [0], send_at: '00:00' },
    });
    const sub = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM message_subscriptions WHERE destination_id = ${dest.id} AND event_kind = 'due_reminder'`,
    );
    // Data inválida no relógio: gerar os vencimentos falha nesta assinatura (as outras seguem).
    const produced = await produceMessages(h.db, h.config, { date: 'data-invalida', time: '23:59', weekday: 1 });
    expect(produced.subscriptionsFailed).toBeGreaterThanOrEqual(1);
    expect(produced.subscriptionErrors).toContainEqual({
      subscriptionId: sub.rows[0]!.id,
      eventKind: 'due_reminder',
      error: expect.stringContaining('data inválida'),
    });
    expect(produced).not.toHaveProperty('failed');
    // O laço junta produção e consumo sem sobrescrever; o worker loga cada assinatura que falhou.
    const result = { ...produced, created: 0, reminders: 0, sent: 0, failed: 2, retried: 0 };
    const logged: { level: string; obj: any; msg: string }[] = [];
    const fakeLog = {
      info: (obj: any, msg: string) => logged.push({ level: 'info', obj, msg }),
      warn: (obj: any, msg: string) => logged.push({ level: 'warn', obj, msg }),
    };
    logMessageTick(fakeLog, result);
    expect(logged.find((l) => l.level === 'info')!.obj).toMatchObject({ failed: 2, subscriptionsFailed: produced.subscriptionsFailed });
    expect(logged.find((l) => l.level === 'info')!.obj).not.toHaveProperty('subscriptionErrors');
    expect(logged.filter((l) => l.level === 'warn').map((l) => l.obj)).toContainEqual(
      expect.objectContaining({ subscriptionId: sub.rows[0]!.id, eventKind: 'due_reminder' }),
    );
    await admin.del(`/api/message-destinations/${dest.id}/subscriptions/due_reminder`);
  });

  it('produtor: vencimentos D-N e resumo diário com dedup; consumidor envia com HTML escapado e PIX copiável', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const due = addDays(today, 1);
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Água <&> "esgoto"',
      competenceDate: today,
      dueDate: due,
      amountCents: 4_321,
    });
    const dest = await admin.post('/api/message-destinations', {
      name: `Produtor ${s.tag}`,
      ownerKind: 'caixa',
      ownerCaixaId: s.caixaA.id,
      botToken: TOKEN,
      chatId: '77',
    });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, {
      eventKind: 'due_reminder',
      params: { days_before: [1], send_at: '08:00' },
    });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind: 'daily_summary', params: { send_at: '07:30' } });

    // Antes do horário: nada.
    const early = { date: today, time: '07:00', weekday: isoWeekday(today) };
    await produceMessages(h.db, h.config, early);
    const count = async () =>
      (await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM message_outbox WHERE destination_id = ${dest.id}`)).rows[0]!.n;
    expect(await count()).toBe(0);

    const late = { date: today, time: '09:00', weekday: isoWeekday(today) };
    await produceMessages(h.db, h.config, late);
    await produceMessages(h.db, h.config, late);
    const queued = await h.db.execute<{ event_kind: string; dedup_key: string }>(
      sql`SELECT event_kind, dedup_key FROM message_outbox WHERE destination_id = ${dest.id} ORDER BY event_kind`,
    );
    expect(queued.rows).toEqual([
      { event_kind: 'daily_summary', dedup_key: `daily_summary:${today}` },
      { event_kind: 'due_reminder', dedup_key: `due_reminder:${title.id}:D-1:${due}` },
    ]);

    await consumeOutbox(h.db, h.config);
    const reminder = telegram.calls.find((c) => c.body.chat_id === '77' && c.body.text.includes('Vence amanhã'));
    expect(reminder).toBeTruthy();
    expect(reminder!.body.text).toContain('Água &lt;&amp;&gt; &quot;esgoto&quot;');
    expect(reminder!.body.text).toContain('R$');
    const summary = telegram.calls.find((c) => c.body.chat_id === '77' && c.body.text.includes('Resumo do dia'));
    expect(summary!.body.text).toContain(`Caixa A ${s.tag}`);
    const sent = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM message_outbox WHERE destination_id = ${dest.id} AND status = 'sent' AND provider_message_id IS NOT NULL`,
    );
    expect(sent.rows[0]!.n).toBe(2);
    // Rodar de novo no mesmo dia não reenfileira.
    await produceMessages(h.db, h.config, late);
    expect(await count()).toBe(2);
  });

  it('mais de 30 títulos no mesmo dia: o teto anda entre as passadas e o resumo conta todos (tarefa 105)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const yesterday = addDays(today, -1);
    const create = (description: string, dueDate: string) =>
      admin.post('/api/titles', {
        caixaId: s.caixaA.id,
        direction: 'payable',
        entityId: s.supplier.id,
        categoryId: s.expense.id,
        description,
        competenceDate: dueDate,
        dueDate,
        amountCents: 1_000,
      });
    for (let i = 0; i < 35; i += 1) await create(`Hoje ${String(i).padStart(2, '0')}`, today);
    for (let i = 0; i < 31; i += 1) await create(`Atrasado ${String(i).padStart(2, '0')}`, yesterday);
    const dest = await admin.post('/api/message-destinations', {
      name: `Teto ${s.tag}`,
      ownerKind: 'caixa',
      ownerCaixaId: s.caixaA.id,
      botToken: TOKEN,
      chatId: '105',
    });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, {
      eventKind: 'due_reminder',
      params: { days_before: [0], send_at: '00:00' },
    });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind: 'overdue', params: { send_at: '00:00' } });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind: 'daily_summary', params: { send_at: '00:00' } });
    const counts = async () => {
      const rows = await h.db.execute<{ event_kind: string; n: number }>(
        sql`SELECT event_kind, count(*)::int AS n FROM message_outbox WHERE destination_id = ${dest.id} GROUP BY event_kind`,
      );
      return Object.fromEntries(rows.rows.map((r) => [r.event_kind, r.n]));
    };
    const clock = { date: today, time: '23:00', weekday: isoWeekday(today) };
    await produceMessages(h.db, h.config, clock);
    expect(await counts()).toEqual({ due_reminder: 30, overdue: 30, daily_summary: 1 });
    await produceMessages(h.db, h.config, clock);
    expect(await counts()).toEqual({ due_reminder: 35, overdue: 31, daily_summary: 1 });
    await produceMessages(h.db, h.config, clock);
    expect(await counts()).toEqual({ due_reminder: 35, overdue: 31, daily_summary: 1 });
    // O resumo lista 25 e conta os 35 do dia pela soma no banco; o total atrasado também.
    const summary = await h.db.execute<{ text: string }>(
      sql`SELECT payload->>'text' AS text FROM message_outbox WHERE destination_id = ${dest.id} AND event_kind = 'daily_summary'`,
    );
    expect(summary.rows[0]!.text).toContain('… e mais 10');
    expect(summary.rows[0]!.text).toContain('Atrasados: 31 títulos');
    await admin.patch(`/api/message-destinations/${dest.id}`, { isActive: false });
  });

  it('uma etapa que falha não para as outras: a mensagem sai e o lembrete dispara sem o sino (tarefa 104)', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const dest = await admin.post('/api/message-destinations', { name: `Etapas ${uid()}`, botToken: TOKEN, chatId: '104' });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind: 'agent_completed', params: {} });
    const runId = randomUUID();
    await emitAgentEvent(h.db, {
      kind: 'agent_completed',
      userId: adminSession.id,
      agentRunId: runId,
      eventKey: `run:${runId}:seq:1`,
      text: 'Pronto',
      config: h.config,
    });
    const entity = await admin.post('/api/entities', { kind: 'company', name: `Lembrete ${uid()}` });
    const note = await admin.post('/api/notes', {
      objectType: 'entity',
      objectId: entity.id,
      kind: 'reminder',
      title: 'Ligar para o banco',
      reminder: { timeOfDay: '10:00' },
    });
    await h.db.execute(sql`UPDATE note_reminders SET next_fire_at = now() - interval '1 minute' WHERE note_id = ${note.id}`);

    // As assinaturas (a etapa inteira do Telegram) e um bloco do sino falham; o resto da passada segue.
    const { db } = spyDb(/FROM message_subscriptions s\b|mirror_status = 'pending'/);
    const result = await messageTick(db, h.config);
    expect(result.stageErrors).toEqual(
      expect.arrayContaining([
        { stage: 'messages', error: expect.stringContaining('falha simulada') },
        { stage: 'notifications.mirror_pending', error: expect.stringContaining('falha simulada') },
      ]),
    );
    expect(result.subscriptionErrors).toEqual([]);
    expect(typeof result.created).toBe('number');
    const outbox = await h.db.execute<{ status: string }>(
      sql`SELECT status FROM message_outbox WHERE destination_id = ${dest.id} AND agent_run_id = ${runId}`,
    );
    expect(outbox.rows).toEqual([{ status: 'sent' }]);
    expect(telegram.calls.some((c) => c.body.chat_id === '104')).toBe(true);
    const firings = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM note_reminder_firings WHERE note_id = ${note.id}`);
    expect(firings.rows[0]!.n).toBe(1);

    // O worker loga cada etapa que falhou, com o nome.
    const warned: { obj: any; msg: string }[] = [];
    logMessageTick({ info: () => {}, warn: (obj, msg) => warned.push({ obj, msg }) }, result);
    expect(warned.map((w) => w.obj.stage)).toEqual(expect.arrayContaining(['messages', 'notifications.mirror_pending']));
    await admin.patch(`/api/message-destinations/${dest.id}`, { isActive: false });
  });

  it('sem recálculo à toa: resumo já enfileirado, cartões uma vez por passada e o sino caro espaçado (tarefa 166)', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const today = todayIso();
    const weekday = isoWeekday(today);
    await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Vence hoje',
      competenceDate: today,
      dueDate: today,
      amountCents: 2_000,
    });
    const dest = await admin.post('/api/message-destinations', {
      name: `Resumo ${s.tag}`,
      ownerKind: 'caixa',
      ownerCaixaId: s.caixaA.id,
      botToken: TOKEN,
      chatId: '166',
    });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind: 'daily_summary', params: { send_at: '00:00' } });
    await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, {
      eventKind: 'card_limit',
      params: { thresholds_percent: [80] },
    });
    const clock = { date: today, time: '09:00', weekday };
    const summaryQueries = (seen: { sql: string; params: unknown[] }[]) =>
      seen.filter((q) => q.sql.includes('financial_account_balances') && JSON.stringify(q.params).includes(s.caixaA.id)).length;
    const cardQueries = (seen: { sql: string }[]) => seen.filter((q) => q.sql.includes('card_limits')).length;

    const first = spyDb();
    await produceMessages(first.db, h.config, clock);
    expect(summaryQueries(first.seen)).toBe(1);
    const second = spyDb();
    await produceMessages(second.db, h.config, clock);
    expect(summaryQueries(second.seen)).toBe(0);
    const summaries = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM message_outbox WHERE destination_id = ${dest.id} AND event_kind = 'daily_summary'`,
    );
    expect(summaries.rows[0]!.n).toBe(1);

    // Com o estado do worker: os blocos caros rodam na primeira, de novo ao passar do NOTIFY_AT e depois de 5 min.
    const state: MessageLoopState = {};
    const t0 = Date.now();
    const bell = async () =>
      (
        await h.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM notifications WHERE dedup_key = ${`due_reminder:${s.caixaA.id}:${today}`}`,
        )
      ).rows[0]!.n;
    const run = async (time: string, now: number) => {
      const spy = spyDb();
      await produceNotifications(spy.db, h.config, { date: today, time, weekday }, { state, now });
      return cardQueries(spy.seen);
    };
    expect(h.config.notifyAt).toBe('08:00');
    expect(await run('07:00', t0)).toBe(1);
    expect(await run('07:01', t0 + 60_000)).toBe(0);
    expect(await bell()).toBe(0);
    expect(await run('08:00', t0 + 120_000)).toBe(1);
    expect(await bell()).toBeGreaterThan(0);
    expect(await run('08:01', t0 + 180_000)).toBe(0);
    expect(await run('08:06', t0 + 120_000 + 5 * 60_000)).toBe(1);

    // Uma passada inteira: o uso dos cartões sai uma vez para o Telegram e o sino.
    const tick = spyDb();
    await messageTick(tick.db, h.config, clock);
    expect(cardQueries(tick.seen)).toBe(1);
    await admin.patch(`/api/message-destinations/${dest.id}`, { isActive: false });
  });

  it('evento de agente: o mesmo evento emitido duas vezes (duas réplicas) gera um aviso por destino; outro seq gera outro', async () => {
    const owner = await userSession(h);
    const user = client(h, owner.cookie);
    const dest = await user.post('/api/message-destinations', { name: `Agente ${uid()}`, botToken: TOKEN, chatId: '88' });
    await user.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind: 'agent_completed', params: {} });
    const runId = randomUUID();
    const emit = (seq: number) =>
      emitAgentEvent(h.db, {
        kind: 'agent_completed',
        userId: owner.id,
        agentRunId: runId,
        eventKey: `run:${runId}:seq:${seq}`,
        title: 'Aguardando confirmação',
        text: 'Mesmo texto',
        link: '/?conversation=x',
        config: h.config,
      });
    expect((await emit(3)).queued).toBe(1);
    expect((await emit(3)).queued).toBe(0);
    const counts = async () => {
      const outbox = await h.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM message_outbox WHERE destination_id = ${dest.id} AND agent_run_id = ${runId}`,
      );
      const bell = await h.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${owner.id} AND kind = 'agent_completed'`,
      );
      return { outbox: outbox.rows[0]!.n, bell: bell.rows[0]!.n };
    };
    expect(await counts()).toEqual({ outbox: 1, bell: 1 });
    // Mesmo texto, outro evento da execução (seq diferente): outro aviso.
    expect((await emit(7)).queued).toBe(1);
    expect(await counts()).toEqual({ outbox: 2, bell: 2 });
  });

  it('evento de agente: o destino de caixa só recebe de quem lê a caixa dona dele (tarefa 049)', async () => {
    const adminSession = await userSession(h, 'admin');
    const admin = client(h, adminSession.cookie);
    const s = await scenario(h, admin);
    const member = await userSession(h);
    await admin.put(`/api/users/${member.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    const outsider = await userSession(h);
    const dest = await admin.post('/api/message-destinations', {
      name: `Grupo ${s.tag}`,
      ownerKind: 'caixa',
      ownerCaixaId: s.caixaA.id,
      botToken: TOKEN,
      chatId: '-100049',
    });
    for (const eventKind of ['agent_completed', 'agent_message', 'ai_awaiting_approval']) {
      await admin.put(`/api/message-destinations/${dest.id}/subscriptions`, { eventKind, params: {} });
    }
    // O destino pessoal de quem não lê a caixa continua recebendo.
    const personal = await client(h, outsider.cookie).post('/api/message-destinations', {
      name: `Pessoal ${uid()}`,
      botToken: TOKEN,
      chatId: '49',
    });
    await client(h, outsider.cookie).put(`/api/message-destinations/${personal.id}/subscriptions`, {
      eventKind: 'agent_completed',
      params: {},
    });
    const queuedFor = async (destinationId: string, runId: string) =>
      (
        await h.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM message_outbox WHERE destination_id = ${destinationId} AND agent_run_id = ${runId}`,
        )
      ).rows[0]!.n;
    const emit = async (
      userId: string,
      kind: 'agent_completed' | 'agent_message' | 'ai_awaiting_approval',
      caixaId: string | null = null,
    ) => {
      const runId = randomUUID();
      await emitAgentEvent(h.db, {
        kind,
        userId,
        agentRunId: runId,
        eventKey: `run:${runId}:seq:1`,
        text: 'Resumo financeiro',
        caixaId,
        config: h.config,
      });
      return runId;
    };
    for (const kind of ['agent_completed', 'agent_message'] as const) {
      expect(await queuedFor(dest.id, await emit(outsider.id, kind))).toBe(0);
      expect(await queuedFor(dest.id, await emit(member.id, kind))).toBe(1);
      expect(await queuedFor(dest.id, await emit(adminSession.id, kind))).toBe(1);
    }
    const outsiderRun = await emit(outsider.id, 'agent_completed');
    expect(await queuedFor(personal.id, outsiderRun)).toBe(1);
    expect(await queuedFor(dest.id, outsiderRun)).toBe(0);
    // Com caixa no evento (aprovação da conciliação): vai ao destino da caixa do lote, nunca ao de outra caixa.
    expect(await queuedFor(dest.id, await emit(member.id, 'ai_awaiting_approval', s.caixaA.id))).toBe(1);
    expect(await queuedFor(dest.id, await emit(adminSession.id, 'ai_awaiting_approval', s.caixaB.id))).toBe(0);
    expect(await queuedFor(dest.id, await emit(outsider.id, 'ai_awaiting_approval', s.caixaA.id))).toBe(0);
    // A tool notify_user (também a do /mcp) passa pelo mesmo caminho.
    const notify = async (userId: string) => {
      const [actor] = await h.db.select(userColumns).from(users).where(eq(users.id, userId));
      const ctx = { db: h.db, access: await loadAccess(h.db, actor as Actor), config: h.config };
      const toolUseId = `tu-${uid()}`;
      await TOOL_HANDLERS.notify_user.run(ctx, { title: 'Oi', text: 'Texto livre' }, { runId: null, toolUseId } as never);
      return queuedFor(dest.id, `mcp-${toolUseId}`);
    };
    expect(await notify(outsider.id)).toBe(0);
    expect(await notify(member.id)).toBe(1);
  });
});

describe('notificações (sino)', () => {
  it('espelho pendente vira notificação do editor da outra caixa; marcar lida e todas', async () => {
    const admin = client(h, (await userSession(h, 'admin')).cookie);
    const s = await scenario(h, admin);
    const authorUser = await userSession(h);
    const otherUser = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: authorUser.id, role: 'editor' });
    await admin.post(`/api/caixas/${s.caixaB.id}/members`, { userId: otherUser.id, role: 'editor' });
    const author = client(h, authorUser.cookie);
    const other = client(h, otherUser.cookie);
    const title = await author.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.holderB.id,
      categoryId: s.expense.id,
      description: `Aluguel ${s.tag}`,
      competenceDate: todayIso(),
      dueDate: addDays(todayIso(), 10),
      amountCents: 50_000,
    });
    expect(title.mirror.mirrorStatus).toBe('pending');

    await produceNotifications(h.db, h.config);
    await produceNotifications(h.db, h.config);
    const bell = await other.get('/api/notifications');
    const mine = bell.items.filter((n: any) => n.kind === 'mirror_pending' && n.title.includes(`Aluguel ${s.tag}`));
    expect(mine).toHaveLength(1);
    expect(mine[0].link).toBe(`/caixas/${s.caixaB.id}/receivables?title=${title.mirror.id}`);
    expect(bell.unread).toBeGreaterThanOrEqual(1);
    // O autor não recebe (não escreve na caixa B).
    expect((await author.get('/api/notifications')).items.some((n: any) => n.kind === 'mirror_pending' && n.title.includes(s.tag))).toBe(
      false,
    );
    // Ninguém marca a notificação de outro.
    await author.post(`/api/notifications/${mine[0].id}/read`, {}, 404);
    await other.post(`/api/notifications/${mine[0].id}/read`);
    const after = await other.get('/api/notifications?unread=1');
    expect(after.items.some((n: any) => n.id === mine[0].id)).toBe(false);
    await other.post('/api/notifications/read-all');
    expect((await other.get('/api/notifications')).unread).toBe(0);
  });
});
