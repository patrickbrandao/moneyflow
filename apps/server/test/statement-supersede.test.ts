import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { client, type Harness, newSession, scenario, startApp, uid, userSession } from './helpers';

/*
 * Lote provisório e a troca pelo consolidado (spec 031): as conciliações do
 * provisório passam para o consolidado com os MESMOS lançamentos (nada
 * excluído nem lançado de novo), as sobras de cada lado, a data deslocada
 * resolvida pela sugestão da IA (provedor falso), o fechamento de mês
 * recusado com pendência, a divergência do intervalo depois da troca, a troca
 * na importação e as tools.
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let h: Harness;
let llm: FakeLlm;
type Api = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof userSession>>;
let adminSession: Session;
let admin: Api;
let agent: { id: string };
const createdAgents: string[] = [];

type Tx = { date: string; cents: number; name: string; fitid?: string };

/** OFX 2.x de uma conta com as transações dadas e o saldo (LEDGERBAL) opcional. */
function ofx(start: string, end: string, txs: Tx[], balance?: { cents: number; on: string }) {
  const d = (iso: string) => iso.replaceAll('-', '');
  const money = (cents: number) => (cents / 100).toFixed(2);
  const list = txs
    .map(
      (tx, i) => `<STMTTRN><TRNTYPE>${tx.cents < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${d(tx.date)}100000</DTPOSTED>
<TRNAMT>${money(tx.cents)}</TRNAMT><FITID>${tx.fitid ?? `${uid()}-${i}`}</FITID><NAME>${tx.name}</NAME></STMTTRN>`,
    )
    .join('\n');
  const ledger = balance ? `<LEDGERBAL><BALAMT>${money(balance.cents)}</BALAMT><DTASOF>${d(balance.on)}</DTASOF></LEDGERBAL>` : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>077</BANKID><BRANCHID>0001</BRANCHID><ACCTID>12345-6</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${d(start)}</DTSTART><DTEND>${d(end)}</DTEND>
${list}
</BANKTRANLIST>${ledger}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
}

async function importOfx(session: Session, accountId: string, file: Buffer, query = '') {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/statement-imports?accountId=${accountId}&fileName=extrato-${uid()}.ofx${query}`,
    payload: file,
    headers: { cookie: session.cookie, 'content-type': 'application/x-ofx' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function drain() {
  for (let i = 0; i < 60; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

async function movementCount(accountId: string) {
  const r = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM movements WHERE financial_account_id = ${accountId}`);
  return Number(r.rows[0]!.n);
}

const byName = (lines: any[], name: string) => {
  const line = lines.find((l) => l.description === name);
  if (!line) throw new Error(`linha ${name} não encontrada`);
  return line;
};

/** Sessão nova, "chamar <tool> <json>" e a aprovação (as escritas do kit estão em ask). */
async function call(name: string, input: Record<string, unknown>) {
  const conversation = await newSession(admin, agent.id);
  const sent = await admin.post(`/api/conversations/${conversation.id}/messages`, {
    text: `chamar ${name} ${JSON.stringify(input)}`,
    attachmentIds: [],
  });
  await drain();
  let detail = await admin.get(`/api/conversations/${conversation.id}`);
  const confirmation = detail.confirmations.find((c: any) => c.status === 'pending');
  if (confirmation) {
    await admin.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' });
    await drain();
    detail = await admin.get(`/api/conversations/${conversation.id}`);
  }
  const result = detail.messages.filter((m: any) => m.role === 'tool').at(-1)?.content[0];
  const text = typeof result?.content === 'string' ? result.content : '';
  let value: any = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { preview: confirmation?.preview, error: result?.is_error ? text : null, value: result?.is_error ? null : value };
}

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  h = await startApp({ AI_REQUEST_BACKOFF_MS: '0' });
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  const provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F17 ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-f17',
    defaultModels: { text: 'claude-sonnet-5-5' },
  });
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  const kit = await admin.post('/api/admin/ai/tool-kits', {
    name: `F17 ask ${uid()}`,
    tools: catalog.filter((tool) => !tool.secret).map((tool) => ({ name: tool.name, mode: tool.kind === 'read' ? 'allow' : 'ask' })),
  });
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente F17 ${uid()}`,
    systemPrompt: 'Agente dos testes da F17.',
    defaultProviderId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 2000, max_tool_iterations: 4 },
    toolKitId: kit.id,
    isActive: true,
  });
  createdAgents.push(agent.id);
  // O agente dos fluxos (a sugestão de pares) é este, com o provedor falso.
  await admin.patch(`/api/admin/ai/agents/${agent.id}`, { useForFlows: true });
  await drain();
});

afterAll(async () => {
  for (const id of createdAgents) await admin.patch(`/api/admin/ai/agents/${id}`, { isActive: false, useForFlows: false });
  await h.close();
  await llm.close();
});

beforeEach(() => {
  llm.queue = [];
});

describe('lote provisório e a troca pelo consolidado (spec 031)', () => {
  it('transfere as conciliações sem duplicar, deixa as sobras de cada lado, resolve a data deslocada pela IA e zera o intervalo', async () => {
    const s = await scenario(h, admin);
    const acc = s.accountA.id;

    // Setembro consolidado e conciliado: o "lote anterior" do intervalo.
    const sep = await importOfx(
      adminSession,
      acc,
      ofx('2026-09-01', '2026-09-30', [{ date: '2026-09-15', cents: -1_000, name: 'CONTA LUZ' }], { cents: 99_000, on: '2026-09-30' }),
    );
    await admin.post(`/api/statement-lines/${sep.lines[0].id}/create`, {
      mode: 'adjustment',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });

    // Um título a pagar que a linha do PIX vai baixar.
    const pix = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: 'Pagamento José',
      competenceDate: '2026-10-01',
      dueDate: '2026-10-05',
      amountCents: 40_000,
    });

    // O parcial do mês, provisório (o saldo do banco ainda sem o que vem depois).
    const prov = await importOfx(
      adminSession,
      acc,
      ofx(
        '2026-10-01',
        '2026-10-15',
        [
          { date: '2026-10-03', cents: -5_990, name: 'TARIFA PACOTE', fitid: 'SAME-1' },
          { date: '2026-10-05', cents: -40_000, name: 'PIX JOSE' },
          { date: '2026-10-06', cents: 150_000, name: 'PIX RECEBIDO CLIENTE' },
          { date: '2026-10-08', cents: -2_000, name: 'IOF' },
          { date: '2026-10-09', cents: -3_500, name: 'UBER' },
          { date: '2026-10-10', cents: -7_700, name: 'LANCHE' },
          { date: '2026-10-11', cents: -1_200, name: 'ESTACIONAMENTO' },
          { date: '2026-10-14', cents: -500, name: 'TAXA AVULSA' },
        ],
        { cents: 188_110, on: '2026-10-15' },
      ),
      '&provisional=true',
    );
    expect(prov).toMatchObject({ provisional: true, supersededBy: null });
    const P = (name: string) => byName(prov.lines, name);
    const create = (name: string, extra: Record<string, unknown> = {}) =>
      admin.post(`/api/statement-lines/${P(name).id}/create`, {
        mode: 'adjustment',
        entityId: s.supplier.id,
        categoryId: s.expense.id,
        ...extra,
      });
    await create('TARIFA PACOTE');
    await admin.post(`/api/statement-lines/${P('PIX JOSE').id}/match`, { titleId: pix.id });
    await admin.post(`/api/statement-lines/${P('PIX RECEBIDO CLIENTE').id}/create`, {
      mode: 'title',
      entityId: s.supplier.id,
      categoryId: s.income.id,
    });
    await admin.post(`/api/statement-lines/${P('IOF').id}/ignore`);
    await admin.patch(`/api/statement-lines/${P('UBER').id}`, { entityId: s.supplier.id, categoryId: s.expense.id });
    await create('LANCHE');
    await create('ESTACIONAMENTO');
    const before = await movementCount(acc);
    const lancheMovement = (await admin.get(`/api/statement-imports/${prov.id}`)).lines.find(
      (l: any) => l.description === 'LANCHE',
    ).movementId;

    // O consolidado: mesmas transações com outras descrições (e a mesma FITID numa delas), uma data deslocada e uma nova.
    const cons = await importOfx(
      adminSession,
      acc,
      ofx(
        '2026-10-01',
        '2026-10-31',
        [
          { date: '2026-10-03', cents: -5_990, name: 'TARIFA PCT MENSAL', fitid: 'SAME-1' },
          { date: '2026-10-05', cents: -40_000, name: 'PIX ENVIADO JOSE' },
          { date: '2026-10-06', cents: 150_000, name: 'PIX REC' },
          { date: '2026-10-08', cents: -2_000, name: 'IOF OPER' },
          { date: '2026-10-09', cents: -3_500, name: 'UBER TRIP' },
          { date: '2026-10-12', cents: -7_700, name: 'LANCHONETE' },
          { date: '2026-10-20', cents: -10_000, name: 'COMPRA NOVA' },
        ],
        { cents: 181_810, on: '2026-10-31' },
      ),
    );
    // A dedup não conta o provisório: as 7 linhas entram; sem a troca, a tela oferece o provisório sobreposto.
    expect(cons.lineCount).toBe(7);
    expect(cons.provisionalOverlap.map((p: any) => p.id)).toEqual([prov.id]);
    // Enquanto o provisório está ativo, ele é o "lote anterior" do intervalo.
    expect(cons.intervalDifferenceCents).toBe(
      cons.differenceCents - (await admin.get(`/api/statement-imports/${prov.id}`)).differenceCents,
    );

    // Prévia: nada gravado.
    const preview = await admin.post(`/api/statement-imports/${cons.id}/supersede`, { dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, provisionalImportIds: [prov.id] });
    expect((await admin.get(`/api/statement-imports/${prov.id}`)).supersededBy).toBeNull();

    const result = await admin.post(`/api/statement-imports/${cons.id}/supersede`, {});
    const names = (items: any[]) => items.map((i) => i.description).sort();
    expect(names(result.transferred)).toEqual(
      ['LANCHE', 'PIX JOSE', 'PIX RECEBIDO CLIENTE', 'TARIFA PACOTE'].filter((n) => n !== 'LANCHE'),
    );
    expect(names(result.paired)).toEqual(['IOF', 'UBER']);
    expect(names(result.dropped)).toEqual(['TAXA AVULSA']);
    expect(names(result.pending)).toEqual(['ESTACIONAMENTO', 'LANCHE']);
    expect(result.pending.every((p: any) => p.reason === 'no_pair')).toBe(true);
    expect(names(result.consolidatedLeftover)).toEqual(['COMPRA NOVA', 'LANCHONETE']);

    // Mudou o vínculo: os mesmos movimentos, nada lançado de novo; o título continua pago.
    expect(await movementCount(acc)).toBe(before);
    expect((await admin.get(`/api/titles/${pix.id}`)).status).toBe('paid');
    const consDetail = await admin.get(`/api/statement-imports/${cons.id}`);
    const C = (name: string) => byName(consDetail.lines, name);
    const provAfter = await admin.get(`/api/statement-imports/${prov.id}`);
    const Pa = (name: string) => byName(provAfter.lines, name);
    expect(C('TARIFA PCT MENSAL')).toMatchObject({ status: 'matched', createdEntry: 'adjustment' });
    expect(C('PIX ENVIADO JOSE')).toMatchObject({ status: 'matched', createdEntry: 'settlement' });
    expect(C('PIX REC')).toMatchObject({ status: 'matched', createdEntry: 'title' });
    expect(C('IOF OPER').status).toBe('ignored');
    expect(C('UBER TRIP')).toMatchObject({ status: 'new', entityId: s.supplier.id, classificationSource: 'user' });
    expect(Pa('TARIFA PACOTE')).toMatchObject({
      status: 'superseded',
      supersedeOutcome: 'transferred',
      supersededByLineId: C('TARIFA PCT MENSAL').id,
    });
    expect(Pa('TAXA AVULSA')).toMatchObject({ status: 'superseded', supersedeOutcome: 'dropped' });
    expect(Pa('LANCHE')).toMatchObject({ status: 'matched', supersedeOutcome: 'pending', movementId: lancheMovement });

    // O provisório substituído: fora da divergência, somente leitura; o consolidado conta as sobras.
    expect(provAfter.supersededBy).toMatchObject({ id: cons.id });
    expect(provAfter.differenceCents).toBeNull();
    expect(consDetail.supersedePending).toBe(2);
    expect(consDetail.supersedes.map((x: any) => x.id)).toEqual([prov.id]);
    const readOnly = await admin.raw('POST', `/api/statement-lines/${Pa('UBER').id}/unignore`);
    expect(readOnly.statusCode).toBe(422);
    expect((await admin.raw('POST', `/api/statement-imports/${prov.id}/rematch`)).statusCode).toBe(422);
    expect((await admin.raw('DELETE', `/api/statement-imports/${cons.id}`)).statusCode).toBe(422);

    // Com sobra pendente, o mês não fecha, nem com force.
    const closing = await admin.raw('POST', `/api/caixas/${s.caixaA.id}/closings`, { month: '2026-10', force: true });
    expect(closing.statusCode, closing.body).toBe(422);

    // Sobra sem par: excluir o lançamento que nasceu dela.
    const resolved = await admin.post(`/api/statement-imports/${cons.id}/superseded-lines/resolve`, {
      items: [{ lineId: Pa('ESTACIONAMENTO').id, action: 'delete_entry' }],
    });
    expect(resolved).toEqual({ done: 1, failed: [] });
    expect(await movementCount(acc)).toBe(before - 1);

    // As sugestões de classificação enfileiradas pela importação rodam antes (o provedor falso responde na ordem).
    await drain();
    // Data deslocada: a IA sugere o par (o de valor diferente e a linha repetida são descartados) e aprovar transfere.
    llm.queue = [
      {
        text: JSON.stringify({
          pairs: [
            { provisionalLineId: Pa('LANCHE').id, consolidatedLineId: C('COMPRA NOVA').id, reason: 'valor diferente' },
            { provisionalLineId: Pa('LANCHE').id, consolidatedLineId: C('LANCHONETE').id, reason: 'mesmo valor, dois dias depois' },
          ],
        }),
      },
    ];
    const queued = await admin.post(`/api/statement-imports/${cons.id}/superseded-lines/suggest`);
    expect(queued).toMatchObject({ queued: true, lines: 1 });
    await drain();
    const pending = await admin.get(`/api/statement-imports/${cons.id}/superseded-lines?outcome=pending`);
    expect(pending).toHaveLength(1);
    expect(pending[0].supersedeSuggestion).toMatchObject({ lineId: C('LANCHONETE').id, reason: 'mesmo valor, dois dias depois' });
    const approved = await admin.post(`/api/statement-imports/${cons.id}/superseded-lines/suggestions`, {
      lineIds: [Pa('LANCHE').id],
      decision: 'approve',
    });
    expect(approved).toEqual({ done: 1, failed: [] });
    const lanchonete = byName((await admin.get(`/api/statement-imports/${cons.id}`)).lines, 'LANCHONETE');
    expect(lanchonete).toMatchObject({ status: 'matched', movementId: lancheMovement, createdEntry: 'adjustment' });

    // Sobras do consolidado seguem a conciliação normal; conciliado, a divergência e o intervalo zeram.
    await admin.post(`/api/statement-lines/${C('UBER TRIP').id}/create`, {
      mode: 'adjustment',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });
    await admin.post(`/api/statement-lines/${C('COMPRA NOVA').id}/create`, {
      mode: 'adjustment',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });
    const final = await admin.get(`/api/statement-imports/${cons.id}`);
    expect(final.supersedePending).toBe(0);
    expect(final.differenceCents).toBe(0);
    expect(final.intervalDifferenceCents).toBe(0);
    const lots = await admin.get(`/api/statement-imports?accountId=${acc}`);
    expect(lots.find((l: any) => l.id === prov.id).intervalDifferenceCents).toBeNull();

    // Sem pendência, o mês fecha (com force: há linhas não conciliadas de outros lotes? não; fecha direto).
    const closed = await admin.raw('POST', `/api/caixas/${s.caixaA.id}/closings`, { month: '2026-10' });
    expect(closed.statusCode, closed.body).toBe(200);
  });

  it('na importação: o parcial mais novo substitui o anterior e o consolidado troca na mesma transação, antes do casamento', async () => {
    const s = await scenario(h, admin);
    const acc = s.accountA.id;
    const first = await importOfx(
      adminSession,
      acc,
      ofx('2026-10-01', '2026-10-10', [{ date: '2026-10-03', cents: -5_000, name: 'MERCADO' }]),
      '&provisional=true',
    );
    await admin.post(`/api/statement-lines/${first.lines[0].id}/create`, {
      mode: 'adjustment',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
    });

    // O parcial mais novo do mesmo mês cobre o anterior: a troca é automática.
    const second = await importOfx(
      adminSession,
      acc,
      ofx('2026-10-01', '2026-10-20', [
        { date: '2026-10-03', cents: -5_000, name: 'MERCADO BOM PRECO' },
        { date: '2026-10-18', cents: -900, name: 'PADARIA' },
      ]),
      '&provisional=true',
    );
    expect(second.superseded).toMatchObject({ provisionalImportIds: [first.id] });
    expect(second.superseded.transferred).toHaveLength(1);
    expect(byName(second.lines, 'MERCADO BOM PRECO')).toMatchObject({ status: 'matched', createdEntry: 'adjustment' });

    // Um lote só pode ser provisório de conta; marcar e desmarcar.
    const other = await importOfx(adminSession, acc, ofx('2026-08-01', '2026-08-31', [{ date: '2026-08-10', cents: -100, name: 'X' }]));
    expect((await admin.put(`/api/statement-imports/${other.id}/provisional`, { provisional: true })).provisional).toBe(true);
    expect((await admin.put(`/api/statement-imports/${other.id}/provisional`, { provisional: false })).provisional).toBe(false);

    // O consolidado com a troca escolhida na importação: a linha já entra conciliada pelo movimento do provisório.
    const before = await movementCount(acc);
    const cons = await importOfx(
      adminSession,
      acc,
      ofx('2026-10-01', '2026-10-31', [
        { date: '2026-10-03', cents: -5_000, name: 'MERCADO' },
        { date: '2026-10-18', cents: -900, name: 'PADARIA SAO JOAO' },
      ]),
      `&supersede=${second.id}`,
    );
    expect(cons.superseded).toMatchObject({ provisionalImportIds: [second.id] });
    expect(cons.provisionalOverlap).toBeUndefined();
    expect(byName(cons.lines, 'MERCADO')).toMatchObject({ status: 'matched', createdEntry: 'adjustment' });
    expect(byName(cons.lines, 'PADARIA SAO JOAO').status).toBe('new');
    expect(await movementCount(acc)).toBe(before);
    expect((await admin.get(`/api/statement-imports/${second.id}`)).supersededBy).toMatchObject({ id: cons.id });
    // Substituído é final.
    expect((await admin.raw('PUT', `/api/statement-imports/${second.id}/provisional`, { provisional: false })).statusCode).toBe(422);
  });

  it('as tools: marcar provisório, substituir (prévia = a troca sem gravar) e decidir as sobras', async () => {
    const s = await scenario(h, admin);
    const acc = s.accountA.id;
    const prov = await importOfx(
      adminSession,
      acc,
      ofx('2026-10-01', '2026-10-10', [
        { date: '2026-10-02', cents: -1_500, name: 'CAFE' },
        { date: '2026-10-04', cents: -2_500, name: 'LIVRO' },
      ]),
    );
    const marked = await call('set_statement_import_provisional', { importId: prov.id, provisional: true });
    expect(marked.error).toBeNull();
    expect(marked.value.provisional).toBe(true);
    for (const line of prov.lines)
      await admin.post(`/api/statement-lines/${line.id}/create`, { mode: 'adjustment', entityId: s.supplier.id, categoryId: s.expense.id });

    const cons = await importOfx(
      adminSession,
      acc,
      ofx('2026-10-01', '2026-10-31', [{ date: '2026-10-02', cents: -1_500, name: 'CAFETERIA' }]),
    );
    const swapped = await call('supersede_statement_import', { importId: cons.id });
    expect(swapped.preview.rows).toEqual(expect.arrayContaining([expect.objectContaining({ after: '1' })]));
    expect(swapped.value.transferred).toHaveLength(1);
    expect(swapped.value.pending).toHaveLength(1);

    const livro = (await admin.get(`/api/statement-imports/${cons.id}/superseded-lines?outcome=pending`))[0];
    const kept = await call('resolve_superseded_lines', { importId: cons.id, items: [{ lineId: livro.id, action: 'keep' }] });
    expect(kept.value).toEqual({ done: 1, failed: [] });
    const after = await admin.get(`/api/statement-imports/${cons.id}/superseded-lines`);
    expect(after.find((l: any) => l.id === livro.id)).toMatchObject({ status: 'superseded', supersedeOutcome: 'kept' });
    expect((await admin.get(`/api/statement-imports/${cons.id}`)).supersedePending).toBe(0);
  });
});
