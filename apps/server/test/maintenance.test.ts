import { sessions } from '@moneyflow/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOperational, startAgentWorker } from '../src/agents/worker';
import { hashToken, purgeExpiredSessions } from '../src/auth/session';
import { loadAccess } from '../src/authz/access';
import { storeUnlinkedAttachment } from '../src/services/attachments';
import { client, type Harness, minimalPdf, scenario, startApp, uid, userSession } from './helpers';

/*
 * Manutenção do worker (tarefas 103 e 162): a retenção operacional (operational_purge) pelo laço de manutenção dos
 * agentes, as sessões ociosas apagadas junto com as vencidas e as requisições ao provedor presas em running.
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let admin: ReturnType<typeof client>;
let adminSession: Awaited<ReturnType<typeof userSession>>;

beforeAll(async () => {
  h = await startApp();
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
});
afterAll(async () => {
  await h.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const attachmentExists = async (id: string) => (await h.db.execute(sql`SELECT 1 FROM attachments WHERE id = ${id}`)).rows.length > 0;
const age = (id: string, days: number) =>
  h.db.execute(sql`UPDATE attachments SET created_at = now() - make_interval(days => ${days}::int) WHERE id = ${id}`);

async function orphan(name: string) {
  const actor = { id: adminSession.id, username: adminSession.username, email: 'x@teste.local', role: 'admin' as const, isActive: true };
  const ctx = { db: h.db, config: h.config, access: await loadAccess(h.db, actor) };
  // O mesmo caminho do upload do chat antes da mensagem e do upload_file do /mcp: gravado sem vínculo.
  return (await storeUnlinkedAttachment(ctx, { name, mime: 'application/pdf', content: minimalPdf([name]) })).id;
}

describe('retenção operacional (tarefa 103)', () => {
  it('o laço de manutenção apaga o anexo sem vínculo de mais de 7 dias; o ligado e o recente ficam', async () => {
    const s = await scenario(h, admin);
    const old = await orphan(`velho ${uid()}.pdf`);
    const recent = await orphan(`recente ${uid()}.pdf`);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/attachments?target=entity&targetId=${s.supplier.id}&fileName=${encodeURIComponent(`ligado ${uid()}.pdf`)}`,
      payload: minimalPdf(['ligado']),
      headers: { cookie: adminSession.cookie, 'content-type': 'application/pdf' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const linked = res.json().id as string;
    await age(old, 8);
    await age(linked, 30);
    // Uma requisição ao provedor presa em running (tarefa 162): a mesma passada a fecha.
    const stuck = await h.db.execute<{ id: string }>(sql`
      INSERT INTO ai_requests (operation, purpose, model, path, started_at)
      VALUES ('chat', 'chat', 'presa', '/v1/messages', now() - interval '3 hours') RETURNING id`);
    const stuckId = stuck.rows[0]!.id;

    // A primeira manutenção roda ao subir o laço (os outros ritmos, longe).
    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 3_600_000, maintenanceMs: 3_600_000, taskIntervalMs: 3_600_000 });
    try {
      const deadline = Date.now() + 10_000;
      while ((await attachmentExists(old)) && Date.now() < deadline) await sleep(100);
    } finally {
      await stop(5000);
    }
    expect(await attachmentExists(old)).toBe(false);
    expect(await attachmentExists(recent)).toBe(true);
    expect(await attachmentExists(linked)).toBe(true);
    const request = await h.db.execute<{ status: string }>(sql`SELECT status FROM ai_requests WHERE id = ${stuckId}`);
    expect(request.rows[0]).toEqual({ status: 'error' });
    // A exclusão do anexo sai como sistema na auditoria (a transação da purga não tem app.user_id).
    const audit = await h.db.execute<{ actor_kind: string; user_id: string | null }>(sql`
      SELECT actor_kind, user_id FROM audit_log WHERE table_name = 'attachments' AND record_id = ${old} AND action = 'delete'`);
    expect(audit.rows).toEqual([{ actor_kind: 'system', user_id: null }]);
  });

  it('purgeOperational devolve só as contagens diferentes de zero e nada quando não há o que apagar', async () => {
    const first = await orphan(`a ${uid()}.pdf`);
    const second = await orphan(`b ${uid()}.pdf`);
    await age(first, 9);
    await age(second, 9);
    const purged = await purgeOperational(h.db);
    expect(purged.attachments).toBeGreaterThanOrEqual(2);
    expect(Object.values(purged).every((n) => n > 0)).toBe(true);
    expect(await purgeOperational(h.db)).toEqual({});
  });
});

describe('sessões ociosas (tarefa 103)', () => {
  it('a purga apaga as vencidas e as ociosas além de SESSION_IDLE_HOURS; a usada há pouco fica; 0 desliga a ociosidade', async () => {
    const make = async () => {
      const user = await userSession(h, 'user');
      return hashToken(decodeURIComponent(user.cookie.replace(/^mf_session=/, '')));
    };
    const idle = await make();
    const active = await make();
    const expired = await make();
    await h.db.update(sessions).set({ lastSeenAt: sql`now() - interval '100 hours'` }).where(eq(sessions.id, idle));
    await h.db.update(sessions).set({ lastSeenAt: sql`now() - interval '1 hour'` }).where(eq(sessions.id, active));
    await h.db
      .update(sessions)
      .set({
        createdAt: sql`now() - interval '31 days'`,
        lastSeenAt: sql`now() - interval '31 days'`,
        expiresAt: sql`now() - interval '1 day'`,
      })
      .where(eq(sessions.id, expired));
    const exists = async (id: string) => (await h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id))).length > 0;

    // Com a ociosidade desligada (0), só a vencida sai.
    expect(await purgeExpiredSessions(h.db, 0)).toBeGreaterThanOrEqual(1);
    expect([await exists(idle), await exists(active), await exists(expired)]).toEqual([true, true, false]);
    // Com 72 h, a ociosa também.
    expect(await purgeExpiredSessions(h.db, 72)).toBeGreaterThanOrEqual(1);
    expect([await exists(idle), await exists(active)]).toEqual([false, true]);
  });
});
