import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AGENT_TOOLS, addDays, t, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type FakeTelegram, startFakeTelegram } from '../../../e2e/fakes/fake-telegram';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { consumeOutbox } from '../src/services/message-worker';
import { noteRemindersTick } from '../src/services/note-worker';
import { client, type Harness, newSession, startApp, uid, userSession } from './helpers';

/*
 * Anotações e lembretes (spec 035): visibilidade (privada, global, admin) e
 * edição só do autor e do admin; a listagem com as recorrências expandidas e
 * os filtros; o calendário; o selo da entidade; o disparo no worker (dedup, o
 * perdido uma vez só, adiar e re-disparar, dispensar, marcar todos), o sino e
 * o Telegram pela Bot API falsa; as preferências; e as tools (prévia,
 * execução, permissão negada e o /mcp).
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let tg: FakeTelegram;
type Api = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof userSession>>;
let adminSession: Session;
let admin: Api;
let aliceSession: Session;
let alice: Api;
let bobSession: Session;
let bob: Api;
let entity: { id: string; name: string };

beforeAll(async () => {
  tg = await startFakeTelegram(0, '127.0.0.1');
  h = await startApp({ TELEGRAM_API_BASE: tg.url, TELEGRAM_TIMEOUT_MS: '3000', APP_URL: 'https://moneyflow.test' });
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  aliceSession = await userSession(h);
  alice = client(h, aliceSession.cookie);
  bobSession = await userSession(h);
  bob = client(h, bobSession.cookie);
  entity = await admin.post('/api/entities', { kind: 'company', name: `Fornecedor notas ${uid()}` });
});

afterAll(async () => {
  await h.close();
  await tg.close();
});

const note = (api: Api, body: Record<string, unknown>, expected?: number) =>
  api.post('/api/notes', { objectType: 'entity', objectId: entity.id, ...body }, expected);

/** Entidade nova (a listagem e o selo sem as notas dos outros testes). */
async function freshEntity() {
  return admin.post('/api/entities', { kind: 'person', name: `Pessoa notas ${uid()}` });
}

async function firingsOf(noteId: string) {
  const r = await h.db.execute<{ id: string; scheduled_for: string; snooze_count: number; read_at: string | null }>(sql`
    SELECT id, scheduled_for::text, snooze_count, read_at::text FROM note_reminder_firings WHERE note_id = ${noteId} ORDER BY scheduled_for`);
  return r.rows;
}

async function bellOf(userId: string, firingId: string) {
  const r = await h.db.execute<{ dedup_key: string; link: string; title: string; read_at: string | null }>(sql`
    SELECT dedup_key, link, title, read_at::text FROM notifications
     WHERE user_id = ${userId} AND kind = 'note_reminder' AND data ->> 'firingId' = ${firingId} ORDER BY created_at`);
  return r.rows;
}

/** Força o lembrete a vencer: o próximo disparo `ago` atrás. */
const dueAgo = (noteId: string, ago: string) =>
  h.db.execute(sql`UPDATE note_reminders SET next_fire_at = now() - ${ago}::interval WHERE note_id = ${noteId}`);

describe('anotações: visibilidade e edição', () => {
  it('privada só do autor (e do admin); global para todos, editável só pelo autor e pelo admin', async () => {
    const e = await freshEntity();
    const priv = await note(alice, { kind: 'bad', title: 'Atrasa sempre', body: '**Cuidado**', objectId: e.id });
    const glob = await note(alice, { kind: 'good', title: 'Ótimo atendimento', scope: 'global', objectId: e.id });
    expect(priv).toMatchObject({ kind: 'bad', scope: 'private', authorId: aliceSession.id, canEdit: true, noteDate: todayIso() });
    expect(priv.object).toMatchObject({ type: 'entity', id: e.id, name: e.name });
    expect(priv.body).toBe('**Cuidado**');

    // Bob: a privada não existe; a global é somente leitura.
    await bob.get(`/api/notes/${priv.id}`, 404);
    expect(await bob.get(`/api/notes/${glob.id}`)).toMatchObject({ canEdit: false });
    await bob.patch(`/api/notes/${glob.id}`, { title: 'Mudei' }, 403);
    await bob.post(`/api/notes/${glob.id}/archive`, {}, 403);
    const bobList = await bob.get(`/api/entities/${e.id}/notes`);
    expect(bobList.items.map((n: any) => n.id)).toEqual([glob.id]);

    // Admin vê e edita tudo; o autor não muda.
    const adminList = await admin.get(`/api/notes?entityId=${e.id}`);
    expect(adminList.items.map((n: any) => n.id).sort()).toEqual([priv.id, glob.id].sort());
    const edited = await admin.patch(`/api/notes/${priv.id}`, { title: 'Atrasa às vezes', kind: 'severe' });
    expect(edited).toMatchObject({ title: 'Atrasa às vezes', kind: 'severe', authorId: aliceSession.id, canEdit: true });

    // Selo na listagem de entidades: a mais grave visível a cada um.
    const badgeFor = async (api: Api) =>
      (await api.get(`/api/entities?q=${encodeURIComponent(e.name)}`)).find((x: any) => x.id === e.id).noteBadge;
    expect(await badgeFor(alice)).toEqual({ kind: 'severe', counts: { severe: 1, good: 1 }, total: 2 });
    expect(await badgeFor(bob)).toEqual({ kind: 'good', counts: { good: 1 }, total: 1 });

    // Arquivar tira da listagem e do selo; o filtro "arquivadas" traz de volta; desarquivar.
    const archived = await alice.post(`/api/notes/${priv.id}/archive`);
    expect(archived.archivedAt).toBeTruthy();
    expect((await alice.get(`/api/notes?entityId=${e.id}`)).items.map((n: any) => n.id)).toEqual([glob.id]);
    expect((await alice.get(`/api/notes?entityId=${e.id}&archived=1`)).items.map((n: any) => n.id)).toEqual([priv.id]);
    expect(await badgeFor(alice)).toMatchObject({ kind: 'good' });
    expect((await alice.post(`/api/notes/${priv.id}/unarchive`)).archivedAt).toBeNull();

    // Auditoria com o ator humano.
    const audit = await h.db.execute<{ actor_kind: string; user_id: string }>(sql`
      SELECT actor_kind, user_id FROM audit_log WHERE table_name = 'notes' AND record_id = ${priv.id} ORDER BY id`);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'human', user_id: aliceSession.id });
  });

  it('validações: entidade inexistente, lembrete fora do tipo, filtro de autor só do admin', async () => {
    const missing = await alice.raw('POST', '/api/notes', {
      kind: 'info',
      title: 'x',
      objectType: 'entity',
      objectId: '00000000-0000-7000-8000-000000000000',
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toBe(t.notes.errors.entityNotFound);
    await note(alice, { kind: 'info', title: 'x', reminder: { timeOfDay: '10:00' } }, 400);
    const noN = await alice.raw('POST', '/api/notes', {
      kind: 'reminder',
      title: 'Sem X',
      objectType: 'entity',
      objectId: entity.id,
      reminder: { repeat: 'every_n_days' },
    });
    expect(noN.statusCode).toBe(422);
    expect(noN.json().error.message).toBe(t.notes.errors.everyNDaysRequired);
    await alice.get(`/api/notes?authorId=${bobSession.id}`, 422);
    await alice.get(`/api/notes?authorId=${aliceSession.id}`);
    await admin.get(`/api/notes?authorId=${aliceSession.id}`);
    await alice.get('/api/notes?from=2026-01-01', 400);
  });
});

describe('anotações: lembretes na listagem e no calendário', () => {
  it('o lembrete aparece em cada ocorrência (dia 31 cai no último dia do mês); filtros, cursor e calendário', async () => {
    const e = await freshEntity();
    const monthly = await note(alice, {
      kind: 'reminder',
      title: 'Cobrar aluguel',
      objectId: e.id,
      noteDate: '2027-01-15',
      reminder: { repeat: 'monthly_day', monthDay: 31, timeOfDay: '08:30' },
    });
    expect(monthly.noteDate).toBe('2027-01-15');
    expect(monthly.reminder).toMatchObject({
      repeat: 'monthly_day',
      monthDay: 31,
      everyNDays: null,
      startsOn: '2027-01-15',
      timeOfDay: '08:30',
      isActive: true,
      description: 'todo dia 31 às 08:30',
    });
    expect(new Date(monthly.reminder.nextFireAt).toISOString()).toBe('2027-01-31T11:30:00.000Z');
    const every = await note(alice, {
      kind: 'reminder',
      title: 'Regar',
      objectId: e.id,
      reminder: { repeat: 'every_n_days', everyNDays: 20, startsOn: '2027-01-01', endsOn: '2027-02-15' },
    });
    expect(every.noteDate).toBe('2027-01-01');
    expect(every.reminder.description).toBe('a cada 20 dias às 09:00 até 15/02/2027');
    const info = await note(alice, {
      kind: 'info',
      title: 'Contato novo: Maria',
      body: 'telefone 1234',
      objectId: e.id,
      noteDate: '2027-02-10',
    });
    const glob = await note(bob, { kind: 'severe', title: 'Processo', scope: 'global', objectId: e.id, noteDate: '2027-03-01' });

    const list = await alice.get(`/api/notes?entityId=${e.id}&from=2027-01-01&to=2027-04-30&order=asc`);
    expect(list.items.map((n: any) => `${n.occursOn} ${n.title}`)).toEqual([
      '2027-01-01 Regar',
      '2027-01-21 Regar',
      '2027-01-31 Cobrar aluguel',
      '2027-02-10 Regar',
      '2027-02-10 Contato novo: Maria',
      '2027-02-28 Cobrar aluguel',
      '2027-03-01 Processo',
      '2027-03-31 Cobrar aluguel',
      '2027-04-30 Cobrar aluguel',
    ]);
    expect(list.items[4]).toMatchObject({ id: info.id, bodyExcerpt: 'telefone 1234', canEdit: true });
    expect(list.items[6]).toMatchObject({ id: glob.id, canEdit: false, authorUsername: bobSession.username });

    // Filtros: tipos, escopo, texto e autor (admin).
    const only = async (query: string, api: Api = alice) =>
      (await api.get(`/api/notes?entityId=${e.id}&from=2027-01-01&to=2027-04-30&order=asc&${query}`)).items.map((n: any) => n.title);
    expect(await only('kinds=info,severe')).toEqual(['Contato novo: Maria', 'Processo']);
    expect(await only('scope=global')).toEqual(['Processo']);
    expect(new Set(await only('scope=mine'))).toEqual(new Set(['Regar', 'Cobrar aluguel', 'Contato novo: Maria']));
    expect(await only('q=telefone')).toEqual(['Contato novo: Maria']);
    expect(await only(`authorId=${bobSession.id}`, admin)).toEqual(['Processo']);

    // Paginação por cursor, sem repetir nem pular.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await alice.get(
        `/api/notes?entityId=${e.id}&from=2027-01-01&to=2027-04-30&limit=4${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.items.map((n: any) => `${n.occursOn} ${n.title}`));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...list.items.map((n: any) => `${n.occursOn} ${n.title}`)].reverse());

    // Sem período: uma linha por anotação, na data dela.
    const flat = await alice.get(`/api/entities/${e.id}/notes?order=asc`);
    expect(flat.items.map((n: any) => `${n.occursOn} ${n.title}`)).toEqual([
      '2027-01-01 Regar',
      '2027-01-15 Cobrar aluguel',
      '2027-02-10 Contato novo: Maria',
      '2027-03-01 Processo',
    ]);

    // Calendário: bolinhas por dia e tipo; o de Bob não vê as privadas de Alice.
    const calendar = await alice.get(`/api/notes/calendar?from=2027-02-01&to=2027-02-28&entityId=${e.id}`);
    expect(calendar).toEqual([
      { day: '2027-02-10', counts: { info: 1, reminder: 1 } },
      { day: '2027-02-28', counts: { reminder: 1 } },
    ]);
    expect(await alice.get(`/api/notes/calendar?from=2027-02-01&to=2027-02-28&entityId=${e.id}&kinds=info`)).toEqual([
      { day: '2027-02-10', counts: { info: 1 } },
    ]);
    expect(await bob.get(`/api/notes/calendar?from=2027-01-01&to=2027-04-30&entityId=${e.id}`)).toEqual([
      { day: '2027-03-01', counts: { severe: 1 } },
    ]);
    await alice.get('/api/notes/calendar?from=2027-01-01&to=2030-12-31', 422);
  });

  it('trocar o tipo cria ou remove o lembrete; a data da nota segue o início', async () => {
    const created = await note(alice, { kind: 'info', title: 'Vira lembrete', noteDate: '2027-05-05' });
    expect(created.reminder).toBeNull();
    const asReminder = await alice.patch(`/api/notes/${created.id}`, { kind: 'reminder' });
    expect(asReminder.reminder).toMatchObject({
      repeat: 'once',
      timeOfDay: '09:00',
      startsOn: '2027-05-05',
      description: 'em 05/05/2027 às 09:00',
    });
    const moved = await alice.patch(`/api/notes/${created.id}`, {
      reminder: { startsOn: '2027-06-01', repeat: 'daily', sendTelegram: true },
    });
    expect(moved).toMatchObject({ noteDate: '2027-06-01' });
    expect(moved.reminder).toMatchObject({ startsOn: '2027-06-01', repeat: 'daily', sendTelegram: true });
    const byDate = await alice.patch(`/api/notes/${created.id}`, { noteDate: '2027-07-01' });
    expect(byDate.reminder.startsOn).toBe('2027-07-01');
    const paused = await alice.patch(`/api/notes/${created.id}`, { reminder: { isActive: false } });
    expect(paused.reminder).toMatchObject({ isActive: false, nextFireAt: null });
    expect(paused.reminder.description).toContain('(pausado)');
    const back = await alice.patch(`/api/notes/${created.id}`, { kind: 'good' });
    expect(back).toMatchObject({ kind: 'good', reminder: null, noteDate: '2027-07-01' });
    const rows = await h.db.execute(sql`SELECT 1 FROM note_reminders WHERE note_id = ${created.id}`);
    expect(rows.rows).toHaveLength(0);
    await alice.patch(`/api/notes/${created.id}`, { reminder: { isActive: true } }, 422);
  });
});

describe('lembretes: disparo no worker', () => {
  it('dispara uma vez (o perdido vira um só), com sino e Telegram com dedup; adiar re-dispara; dispensar e marcar todos', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const destination = await me.post('/api/message-destinations', {
      name: `Meu Telegram ${uid()}`,
      ownerKind: 'user',
      botToken: `123456:${'A'.repeat(30)}`,
      chatId: '777001',
    });
    expect(destination.id).toBeTruthy();
    const settings = await me.get('/api/account/reminder-settings');
    expect(settings).toEqual({ sound: null, ringSeconds: 30, effectiveSound: 'bell', hasPersonalTelegram: true });

    const start = addDays(todayIso(), -5);
    const daily = await note(me, {
      kind: 'reminder',
      title: 'Ligar para o contador',
      noteDate: start,
      reminder: { repeat: 'daily', timeOfDay: '09:00', sendTelegram: true, sound: 'chime' },
    });
    // Vencido há 5 dias (worker parado): um disparo só, no horário previsto mais recente.
    await h.db.execute(sql`
      UPDATE note_reminders SET next_fire_at = (${start}::date + time '09:00') AT TIME ZONE 'America/Sao_Paulo' WHERE note_id = ${daily.id}`);
    const result = await noteRemindersTick(h.db, h.config);
    expect(result.reminders).toBeGreaterThanOrEqual(1);
    let firings = await firingsOf(daily.id);
    expect(firings).toHaveLength(1);
    const expected = await h.db.execute<{ prev: string; next_ok: boolean }>(sql`
      SELECT note_reminder_prev_fire('daily', '09:00', ${start}::date, NULL, NULL, NULL, now())::text AS prev,
             (SELECT next_fire_at > now() FROM note_reminders WHERE note_id = ${daily.id}) AS next_ok`);
    expect(firings[0]!.scheduled_for).toBe(expected.rows[0]!.prev);
    expect(expected.rows[0]!.next_ok).toBe(true);
    const firingId = firings[0]!.id;

    // O sino (link para a anotação) e a mensagem do Telegram, cada um uma vez.
    expect(await bellOf(owner.id, firingId)).toEqual([
      expect.objectContaining({
        dedup_key: `note_reminder:${firingId}:0`,
        link: `/notes?note=${daily.id}`,
        title: 'Lembrete: Ligar para o contador',
      }),
    ]);
    await consumeOutbox(h.db, h.config);
    const sent = tg.messagesTo('777001');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain('Lembrete: Ligar para o contador');
    expect(sent[0]!.body.text).toContain(`https://moneyflow.test/notes?note=${daily.id}`);

    // Rodar de novo (inclusive com o mesmo horário forçado de volta) não duplica.
    await noteRemindersTick(h.db, h.config);
    await h.db.execute(sql`UPDATE note_reminders SET next_fire_at = ${firings[0]!.scheduled_for}::timestamptz WHERE note_id = ${daily.id}`);
    await noteRemindersTick(h.db, h.config);
    expect(await firingsOf(daily.id)).toHaveLength(1);
    expect(await bellOf(owner.id, firingId)).toHaveLength(1);
    await consumeOutbox(h.db, h.config);
    expect(tg.messagesTo('777001')).toHaveLength(1);

    // O log do usuário: não lido, tocando, com o som do lembrete.
    let log1 = await me.get('/api/note-reminders/firings');
    expect(log1.unread).toBe(1);
    expect(log1.items[0]).toMatchObject({
      id: firingId,
      noteId: daily.id,
      kind: 'reminder',
      sound: 'chime',
      ringSeconds: 30,
      shouldRing: true,
    });
    expect(log1.serverTime).toBeTruthy();
    // Outro usuário não mexe no disparo.
    await alice.post(`/api/note-reminders/firings/${firingId}/dismiss`, {}, 404);
    await alice.post(`/api/note-reminders/firings/${firingId}/snooze`, { minutes: 5 }, 404);

    // Adiar: para de tocar; vencido o adiamento, o mesmo registro toca de novo (sino e Telegram com o contador).
    const snoozed = await me.post(`/api/note-reminders/firings/${firingId}/snooze`, { minutes: 10 });
    expect(snoozed).toMatchObject({ shouldRing: false, readAt: null, snoozeCount: 1 });
    expect(snoozed.snoozedUntil).toBeTruthy();
    await me.post(`/api/note-reminders/firings/${firingId}/snooze`, { minutes: 0 }, 400);
    // Antecipar o adiamento à mão conta como um adiamento novo (o contador é do banco): 2.
    await h.db.execute(sql`UPDATE note_reminder_firings SET snoozed_until = now() - interval '1 second' WHERE id = ${firingId}`);
    await noteRemindersTick(h.db, h.config);
    firings = await firingsOf(daily.id);
    expect(firings).toHaveLength(1);
    expect(firings[0]!.snooze_count).toBe(2);
    expect((await bellOf(owner.id, firingId)).map((n) => n.dedup_key)).toEqual([
      `note_reminder:${firingId}:0`,
      `note_reminder:${firingId}:2`,
    ]);
    await consumeOutbox(h.db, h.config);
    expect(tg.messagesTo('777001')).toHaveLength(2);
    log1 = await me.get('/api/note-reminders/firings');
    expect(log1.items[0]).toMatchObject({ id: firingId, shouldRing: true, snoozedUntil: null, snoozeCount: 2 });

    // Dispensar: lido, sem tocar, e o sino do disparo lido junto.
    const dismissed = await me.post(`/api/note-reminders/firings/${firingId}/dismiss`);
    expect(dismissed).toMatchObject({ shouldRing: false, snoozedUntil: null });
    expect(dismissed.readAt).toBeTruthy();
    expect((await bellOf(owner.id, firingId)).every((n) => n.read_at)).toBe(true);
    expect((await me.get('/api/note-reminders/firings?unread=1')).items).toEqual([]);

    // Marcar todos como lidos: dois disparos novos (outro lembrete) de uma vez.
    const other = await note(me, { kind: 'reminder', title: 'Outro', noteDate: start, reminder: { repeat: 'daily' } });
    await dueAgo(other.id, '1 minute');
    await noteRemindersTick(h.db, h.config);
    await dueAgo(daily.id, '1 minute');
    await noteRemindersTick(h.db, h.config);
    const before = await me.get('/api/note-reminders/firings');
    expect(before.unread).toBeGreaterThanOrEqual(1);
    const all = await me.post('/api/note-reminders/firings/read-all');
    expect(all.updated).toBe(before.unread);
    expect((await me.get('/api/note-reminders/firings')).unread).toBe(0);

    // Arquivada ou pausada: não dispara (o próximo disparo fica nulo).
    await me.post(`/api/notes/${other.id}/archive`);
    await dueAgo(other.id, '1 minute');
    const count = (await firingsOf(other.id)).length;
    await noteRemindersTick(h.db, h.config);
    expect(await firingsOf(other.id)).toHaveLength(count);

    // Sem destino pessoal, o Telegram é ignorado (o sino continua).
    await me.patch(`/api/message-destinations/${destination.id}`, { isActive: false });
    expect((await me.get('/api/account/reminder-settings')).hasPersonalTelegram).toBe(false);
    await dueAgo(daily.id, '1 minute');
    await noteRemindersTick(h.db, h.config);
    await consumeOutbox(h.db, h.config);
    expect(tg.messagesTo('777001')).toHaveLength(2);
  });

  it('preferências: som e segundos padrão, que valem nos disparos sem som próprio', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    expect(await me.put('/api/account/reminder-settings', { sound: 'digital', ringSeconds: 45 })).toMatchObject({
      sound: 'digital',
      ringSeconds: 45,
      effectiveSound: 'digital',
      hasPersonalTelegram: false,
    });
    await me.put('/api/account/reminder-settings', { sound: 'Não Vale', ringSeconds: 45 }, 400);
    await me.put('/api/account/reminder-settings', { sound: null, ringSeconds: 700 }, 400);
    const created = await note(me, { kind: 'reminder', title: 'Padrão', reminder: { repeat: 'daily' } });
    await dueAgo(created.id, '1 minute');
    await noteRemindersTick(h.db, h.config);
    const list = await me.get('/api/note-reminders/firings');
    expect(list.items[0]).toMatchObject({ noteId: created.id, sound: 'digital', ringSeconds: 45 });
    const reset = await me.put('/api/account/reminder-settings', { sound: null });
    expect(reset).toMatchObject({ sound: null, ringSeconds: 30, effectiveSound: 'bell' });
  });
});

/* ---------------- tools dos agentes ---------------- */

describe('tools das anotações (categoria Anotações)', () => {
  let llm: FakeLlm;
  let agent: { id: string };

  async function drain() {
    for (let i = 0; i < 50; i += 1) {
      const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
      const run = result.rows[0];
      if (!run) return;
      await processRun({ db: h.db, config: h.config, log }, run);
    }
  }

  /** "chamar <tool> <json>" numa sessão nova; aprova a confirmação (salvo approve false). */
  async function call(session: Session, name: string, input: Record<string, unknown>, approve = true) {
    const api = client(h, session.cookie);
    const conversation = await newSession(api, agent.id);
    const sent = await api.post(`/api/conversations/${conversation.id}/messages`, { text: `chamar ${name} ${JSON.stringify(input)}` });
    await drain();
    let detail = await api.get(`/api/conversations/${conversation.id}`);
    const confirmation = detail.confirmations.find((c: any) => c.status === 'pending');
    if (confirmation && approve) {
      await api.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' });
      await drain();
      detail = await api.get(`/api/conversations/${conversation.id}`);
    }
    const result = detail.messages.filter((m: any) => m.role === 'tool').at(-1)?.content[0];
    return {
      preview: confirmation?.preview,
      error: result?.is_error ? (result.content as string) : null,
      value: result && !result.is_error ? JSON.parse(result.content) : null,
    };
  }

  beforeAll(async () => {
    llm = await startFakeLlm(0, '127.0.0.1');
    const provider = await admin.post('/api/admin/ai/providers', {
      name: `Falso notas ${uid()}`,
      kind: 'anthropic',
      baseUrl: llm.url,
      apiKey: 'sk-ant-test-notas',
      defaultModels: { text: 'claude-sonnet-5-5' },
    });
    const catalog: any[] = await admin.get('/api/admin/ai/tools');
    const kit = await admin.post('/api/admin/ai/tool-kits', {
      name: `Notas ${uid()}`,
      tools: catalog.filter((tool) => tool.category === 'notes').map((tool) => ({ name: tool.name, mode: tool.suggestedMode })),
    });
    agent = await admin.post('/api/admin/ai/agents', {
      name: `Agente notas ${uid()}`,
      systemPrompt: 'Testes das tools de anotações.',
      defaultProviderId: provider.id,
      model: 'claude-sonnet-5-5',
      params: { max_tokens: 2000, max_tool_iterations: 4 },
      toolKitId: kit.id,
      isActive: true,
    });
  });

  afterAll(async () => {
    // Os outros arquivos de teste usam o mesmo banco e esperam "sem agente configurado".
    await admin.patch(`/api/admin/ai/agents/${agent.id}`, { isActive: false });
    await llm.close();
  });

  it('registro: nove tools na categoria, leituras em allow e escritas em ask, fora dos kits', () => {
    const tools = AGENT_TOOLS.filter((tool) => tool.category === 'notes');
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'archive_note',
        'create_note',
        'get_note',
        'list_notes',
        'list_reminder_firings',
        'mark_reminders_read',
        'note_calendar',
        'snooze_reminder',
        'update_note',
      ].sort(),
    );
    for (const tool of tools) expect(tool.suggestedMode).toBe(tool.kind === 'read' ? 'allow' : 'ask');
  });

  it('criar, listar, editar e arquivar pela conversa, com prévia; a global de outro autor é negada', async () => {
    const e = await freshEntity();
    const created = await call(aliceSession, 'create_note', {
      kind: 'reminder',
      title: 'Renovar seguro',
      objectId: e.id,
      noteDate: '2027-08-10',
      scope: 'global',
      reminder: { repeat: 'monthly_day', monthDay: 10, timeOfDay: '07:00' },
    });
    expect(created.error).toBeNull();
    expect(created.preview).toMatchObject({ title: t.notes.preview.create, action: 'create', warnings: [t.notes.preview.globalWarning] });
    const rows = Object.fromEntries(created.preview.rows.map((r: any) => [r.label, r.after]));
    expect(rows).toMatchObject({ Tipo: 'Lembrete', Título: 'Renovar seguro', Entidade: e.name, Escopo: 'Global', Data: '10/08/2027' });
    expect(created.value).toMatchObject({ kind: 'reminder', authorId: aliceSession.id, reminder: { description: 'todo dia 10 às 07:00' } });
    const noteId = created.value.id;

    const listed = await call(aliceSession, 'list_notes', { entityId: e.id, from: '2027-08-01', to: '2027-10-31' });
    expect(listed.preview).toBeUndefined();
    expect(listed.value.items.map((n: any) => n.occursOn)).toEqual(['2027-10-10', '2027-09-10', '2027-08-10']);
    const calendar = await call(aliceSession, 'note_calendar', { from: '2027-08-01', to: '2027-08-31', entityId: e.id });
    expect(calendar.value).toEqual([{ day: '2027-08-10', counts: { reminder: 1 } }]);
    expect((await call(aliceSession, 'get_note', { noteId })).value).toMatchObject({ id: noteId, title: 'Renovar seguro' });

    const updated = await call(aliceSession, 'update_note', { noteId, title: 'Renovar seguro do carro', reminder: { timeOfDay: '08:00' } });
    expect(updated.error).toBeNull();
    const diff = Object.fromEntries(updated.preview.rows.map((r: any) => [r.label, `${r.before} → ${r.after}`]));
    expect(diff.Título).toBe('Renovar seguro → Renovar seguro do carro');
    expect(updated.value.reminder.timeOfDay).toBe('08:00');

    // Bob lê a global, mas não edita nem arquiva (a prévia já recusa).
    expect((await call(bobSession, 'get_note', { noteId })).value).toMatchObject({ canEdit: false });
    const denied = await call(bobSession, 'archive_note', { noteId });
    expect(denied.error).toBe(t.notes.errors.readOnly);
    const archived = await call(aliceSession, 'archive_note', { noteId });
    expect(archived.preview).toMatchObject({ action: 'delete' });
    expect(archived.value.archivedAt).toBeTruthy();

    // Escrita do agente sai com o ator agent na auditoria.
    const audit = await h.db.execute<{ actor_kind: string }>(
      sql`SELECT actor_kind FROM audit_log WHERE table_name = 'notes' AND record_id = ${noteId} ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]!.actor_kind).toBe('agent');
  });

  it('disparos pela conversa: listar, adiar e marcar como lidos (só os do próprio usuário)', async () => {
    const owner = await userSession(h);
    const me = client(h, owner.cookie);
    const created = await note(me, { kind: 'reminder', title: 'Pagar DAS', reminder: { repeat: 'daily' } });
    await dueAgo(created.id, '1 minute');
    await noteRemindersTick(h.db, h.config);
    const listed = await call(owner, 'list_reminder_firings', { unreadOnly: true });
    expect(listed.value.unread).toBe(1);
    const firingId = listed.value.items[0].id;
    expect((await call(bobSession, 'snooze_reminder', { firingId, minutes: 5 })).error).toBe(t.notes.errors.firingNotFound);
    const snoozed = await call(owner, 'snooze_reminder', { firingId, minutes: 30 });
    expect(snoozed.preview).toMatchObject({ title: t.notes.preview.snooze, rows: [{ after: '30 min' }] });
    expect(snoozed.value).toMatchObject({ id: firingId, snoozeCount: 1 });
    const read = await call(owner, 'mark_reminders_read', {});
    expect(read.preview.summary).toBe(t.notes.preview.markReadAll);
    expect(read.value).toEqual({ updated: 1 });
  });

  it('/mcp: as tools das anotações ficam expostas e respeitam a visibilidade', async () => {
    const e = await freshEntity();
    const priv = await note(alice, { kind: 'info', title: 'Privada da Alice', objectId: e.id });
    const token = (await bob.post('/api/account/api-tokens', { name: `MCP notas ${uid()}`, expiresInDays: 1 })).token;
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const mcpClient = new Client({ name: 'teste-notas', version: '1.0.0' });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const text = (r: Awaited<ReturnType<typeof mcpClient.callTool>>) => (r.content as { text: string }[])[0]!.text;
      const tools = (await mcpClient.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['list_notes', 'create_note', 'snooze_reminder', 'mark_reminders_read']));
      const hidden = await mcpClient.callTool({ name: 'get_note', arguments: { noteId: priv.id } });
      expect(hidden.isError).toBe(true);
      expect(text(hidden)).toBe(t.notes.errors.notFound);
      const made = await mcpClient.callTool({
        name: 'create_note',
        arguments: { kind: 'good', title: 'Pelo MCP', objectId: e.id, objectType: 'entity' },
      });
      expect(made.isError, text(made)).toBeFalsy();
      expect(JSON.parse(text(made))).toMatchObject({ title: 'Pelo MCP', authorId: bobSession.id });
      const list = await mcpClient.callTool({ name: 'list_notes', arguments: { entityId: e.id } });
      expect(JSON.parse(text(list)).items.map((n: any) => n.title)).toEqual(['Pelo MCP']);
    } finally {
      await mcpClient.close();
    }
  });
});
