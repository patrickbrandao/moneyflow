import { addMonths, todayIso } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materializeRule } from '../src/services/recurrence';
import { client, type Harness, scenario, startApp, userSession } from './helpers';

/*
 * O par título + espelho nas rotas de estado (specs 005, 006 e 008; tarefa
 * 126): cancelar e reabrir mexem nos dois lados (reabrir só tira do
 * "cancelado": um pago fica pago); excluir com baixa arquiva o par e
 * restaurar desarquiva os dois, inclusive a ocorrência de série, que o worker
 * não recria; quem só lê não muda o estado.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.close());

type Scenario = Awaited<ReturnType<typeof scenario>>;

const base = (s: Scenario, extra: Record<string, unknown> = {}) => ({
  caixaId: s.caixaA.id,
  direction: 'payable' as const,
  entityId: s.holderB.id,
  categoryId: s.expense.id,
  description: 'Serviço',
  competenceDate: '2026-10-01',
  dueDate: '2026-10-15',
  amountCents: 90_000,
  ...extra,
});

async function setup() {
  const admin = client(h, (await userSession(h, 'admin')).cookie);
  const s = await scenario(h, admin);
  return { admin, s };
}

async function pairState(api: ReturnType<typeof client>, title: { id: string; mirror: { id: string } }) {
  const [original, mirror] = await Promise.all([api.get(`/api/titles/${title.id}`), api.get(`/api/titles/${title.mirror.id}`)]);
  return [
    { status: original.status, archived: original.archivedAt !== null },
    { status: mirror.status, archived: mirror.archivedAt !== null },
  ];
}

describe('cancelar e reabrir o par (spec 005)', () => {
  it('cancelar leva o título e o espelho a cancelado; reabrir devolve os dois a aberto; reabrir um aberto não muda nada', async () => {
    const { admin, s } = await setup();
    const title = await admin.post('/api/titles', base(s));
    expect(title.mirror.mirrorStatus).toBe('accepted');

    expect((await admin.post(`/api/titles/${title.id}/cancel`)).status).toBe('canceled');
    expect(await pairState(admin, title)).toEqual([
      { status: 'canceled', archived: false },
      { status: 'canceled', archived: false },
    ]);
    // A listagem das abertas da caixa B não mostra mais o espelho.
    const openB = await admin.get(`/api/titles?caixaId=${s.caixaB.id}&status=open`);
    expect(openB.map((t: { id: string }) => t.id)).not.toContain(title.mirror.id);

    // Pelo espelho, quem edita os dois lados reabre o par.
    expect((await admin.post(`/api/titles/${title.mirror.id}/reopen`)).status).toBe('open');
    expect(await pairState(admin, title)).toEqual([
      { status: 'open', archived: false },
      { status: 'open', archived: false },
    ]);
    expect((await admin.post(`/api/titles/${title.id}/reopen`)).status).toBe('open');
  });

  it('reabrir um título pago (ou parcial) não muda a situação de nenhum dos lados', async () => {
    const { admin, s } = await setup();
    const title = await admin.post('/api/titles', base(s));
    await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 30_000,
      financialAccountId: s.accountA.id,
      mirrorAccountId: s.accountB.id,
    });
    expect((await admin.post(`/api/titles/${title.id}/reopen`)).status).toBe('partial');
    await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-16',
      amountCents: 60_000,
      financialAccountId: s.accountA.id,
      mirrorAccountId: s.accountB.id,
    });
    const reopened = await admin.post(`/api/titles/${title.id}/reopen`);
    expect(reopened).toMatchObject({ status: 'paid', openCents: 0 });
    expect(await pairState(admin, title)).toEqual([
      { status: 'paid', archived: false },
      { status: 'paid', archived: false },
    ]);
  });

  it('o autor (editor só da caixa do original) cancela e reabre o par com o espelho pendente; quem só lê recebe 403', async () => {
    const { admin, s } = await setup();
    const authorUser = await userSession(h);
    const viewerUser = await userSession(h);
    await admin.put(`/api/users/${authorUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'editor' }] });
    await admin.put(`/api/users/${viewerUser.id}/memberships`, { memberships: [{ caixaId: s.caixaA.id, role: 'viewer' }] });
    const author = client(h, authorUser.cookie);
    const viewer = client(h, viewerUser.cookie);

    const title = await author.post('/api/titles', base(s));
    expect(title.mirror.mirrorStatus).toBe('pending');
    for (const action of ['cancel', 'reopen', 'restore']) {
      expect((await viewer.raw('POST', `/api/titles/${title.id}/${action}`, {})).statusCode, action).toBe(403);
    }

    await author.post(`/api/titles/${title.id}/cancel`);
    expect(await pairState(admin, title)).toEqual([
      { status: 'canceled', archived: false },
      { status: 'canceled', archived: false },
    ]);
    await author.post(`/api/titles/${title.id}/reopen`);
    expect(await pairState(admin, title)).toEqual([
      { status: 'open', archived: false },
      { status: 'open', archived: false },
    ]);
    // O espelho continua pendente de aceite.
    expect((await admin.get(`/api/titles/${title.mirror.id}`)).mirrorStatus).toBe('pending');
  });
});

describe('excluir e restaurar o par (spec 008)', () => {
  it('sem baixa, excluir apaga os dois lados; com baixa (mesmo estornada), arquiva o par e restaurar desarquiva os dois', async () => {
    const { admin, s } = await setup();
    const loose = await admin.post('/api/titles', base(s));
    expect(await admin.del(`/api/titles/${loose.id}`)).toEqual({ deleted: true, archived: false });
    await admin.get(`/api/titles/${loose.id}`, 404);
    await admin.get(`/api/titles/${loose.mirror.id}`, 404);

    const title = await admin.post('/api/titles', base(s));
    const settled = await admin.post(`/api/titles/${title.id}/settlements`, {
      settledOn: '2026-10-15',
      amountCents: 90_000,
      financialAccountId: s.accountA.id,
      mirrorAccountId: s.accountB.id,
    });
    await admin.post(`/api/settlements/${settled.settlements[0].id}/reverse`, { reason: 'lançada por engano' });
    expect(await admin.del(`/api/titles/${title.id}`)).toEqual({ deleted: false, archived: true });
    expect(await pairState(admin, title)).toEqual([
      { status: 'open', archived: true },
      { status: 'open', archived: true },
    ]);
    const listed = await admin.get(`/api/titles?caixaId=${s.caixaB.id}&limit=1000`);
    expect(listed.map((t: { id: string }) => t.id)).not.toContain(title.mirror.id);

    // Restaurar pelo espelho desarquiva o par; a baixa estornada continua no histórico.
    const restored = await admin.post(`/api/titles/${title.mirror.id}/restore`);
    expect(restored.archivedAt).toBeNull();
    expect(await pairState(admin, title)).toEqual([
      { status: 'open', archived: false },
      { status: 'open', archived: false },
    ]);
    const original = await admin.get(`/api/titles/${title.id}`);
    expect(original.settlements).toHaveLength(1);
    expect(original.settlements[0].reversedAt).not.toBeNull();
    await admin.post(`/api/titles/${crypto.randomUUID()}/restore`, {}, 404);
  });

  it('a ocorrência de série excluída "só esta" fica arquivada com o espelho; restaurar a traz de volta e o worker não a duplica', async () => {
    const { admin, s } = await setup();
    const today = todayIso();
    const first = await admin.post(
      '/api/titles',
      base(s, { dueDate: today, competenceDate: today, series: { kind: 'recurrence', frequency: 'monthly', endsOn: addMonths(today, 3) } }),
    );
    const ruleId = first.recurrenceRuleId;
    const occurrences = async () => {
      const result = await h.db.execute<{ id: string; occurrence: number; archived: boolean; mirror: boolean }>(sql`
        SELECT id, occurrence, archived_at IS NOT NULL AS archived, mirror_status IS NOT NULL AS mirror
          FROM titles WHERE recurrence_rule_id = ${ruleId} ORDER BY occurrence, mirror_status NULLS FIRST`);
      return result.rows;
    };
    const before = await occurrences();
    expect(before).toHaveLength(8);
    const second = before.find((r) => r.occurrence === 2 && !r.mirror)!;

    expect(await admin.del(`/api/titles/${second.id}?scope=this`)).toEqual({ deleted: false, archived: true });
    expect((await occurrences()).filter((r) => r.archived).map((r) => [r.occurrence, r.mirror])).toEqual([
      [2, false],
      [2, true],
    ]);
    // O worker não recria a vaga ocupada pela arquivada.
    await h.db.transaction((tx) => materializeRule(tx, ruleId, addMonths(today, 4)));
    expect(await occurrences()).toHaveLength(8);

    await admin.post(`/api/titles/${second.id}/restore`);
    const after = await occurrences();
    expect(after).toHaveLength(8);
    expect(after.filter((r) => r.archived)).toEqual([]);

    // A prévia de "encerrar a série" pela série (GET) não grava: as duas últimas seriam canceladas.
    const third = after.find((r) => r.occurrence === 3 && !r.mirror)!;
    const thirdDue = (await admin.get(`/api/titles/${third.id}`)).dueDate;
    const preview = await admin.get(`/api/series/${ruleId}/end?endsOn=${addMonths(thirdDue, -1)}`);
    expect(preview).toMatchObject({ ruleId, currentEndsOn: addMonths(today, 3), blocked: [] });
    expect(preview.toCancel.map((o: { occurrence: number }) => o.occurrence)).toEqual([3, 4]);
    expect((await occurrences()).filter((r) => r.archived)).toEqual([]);
    expect((await admin.get(`/api/titles/${third.id}`)).status).toBe('open');
  });
});
