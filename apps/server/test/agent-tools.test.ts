import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nfeAccessKeyDv } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from '../../../e2e/fakes/fake-llm';
import { type ClaimedRun, processRun } from '../src/agents/runner';
import { startAgentWorker } from '../src/agents/worker';
import { registerDocumentReader } from '../src/services/title-entry';
import { client, type Harness, minimalPdf, newSession, scenario, startApp, uid, userSession } from './helpers';

/*
 * Tools de controle total, lote F13a (spec 027), com o provedor falso: para
 * cada tool, a prévia do cartão "Aplicar?", a execução sobre o mesmo serviço
 * da API, a permissão negada (viewer, não admin; as só de admin nem são
 * oferecidas) e, nas de importação, o anexo que precisa ser da sessão da
 * execução (no /mcp, um anexo que o dono do token lê).
 */

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));
const BOLETO = '34191.79001 10104.351001 47910.201509 1 16050000123456';
const PIX =
  '00020126590014br.gov.bcb.pix0118fulano@exemplo.com0215Aluguel outubro5204000053039865406123.455802BR5913Fulano de Tal6009Sao Paulo62130509PEDIDO1236304CB0B';

let h: Harness;
let llm: FakeLlm;
type Api = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof userSession>>;
let adminSession: Session;
let admin: Api;
let viewerSession: Session;
let agent: { id: string };
let s: Awaited<ReturnType<typeof scenario>>;

/** Roda a fila de execuções no próprio teste (o worker, sem timers). */
async function drain() {
  for (let i = 0; i < 50; i += 1) {
    const result = await h.db.execute<ClaimedRun>(sql`SELECT * FROM ai_run_claim(1, '1 hour'::interval)`);
    const run = result.rows[0];
    if (!run) return;
    await processRun({ db: h.db, config: h.config, log }, run);
  }
}

async function runStatus(runId: string) {
  const r = await h.db.execute<{ status: string; error: string | null }>(sql`SELECT status, error FROM ai_runs WHERE id = ${runId}`);
  return r.rows[0]!;
}

async function upload(session: Session, conversationId: string, name: string, mime: string, data: Buffer): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/attachments?fileName=${encodeURIComponent(name)}`,
    payload: data,
    headers: { cookie: session.cookie, 'content-type': mime },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id;
}

type FileSpec = { name: string; mime: string; data: Buffer };
type CallOptions = {
  /** Anexos enviados com a mensagem (o input recebe os ids). */
  files?: FileSpec[];
  /** false = deixa a confirmação pendente (só a prévia). */
  approve?: boolean;
  /** Worker de verdade em segundo plano (tools que esperam uma execução aninhada do agente dos fluxos). */
  worker?: boolean;
};

/**
 * Sessão nova com o agente e "chamar <tool> <json>" (o cérebro do provedor
 * falso chama a tool pedida). Devolve a prévia (quando a tool pediu
 * aprovação) e o resultado devolvido ao modelo, já decodificado.
 */
async function call(
  session: Session,
  name: string,
  input: Record<string, unknown> | ((ids: string[]) => Record<string, unknown>),
  opts: CallOptions = {},
) {
  const api = client(h, session.cookie);
  const conversation = await newSession(api, agent.id);
  const ids: string[] = [];
  for (const file of opts.files ?? []) ids.push(await upload(session, conversation.id, file.name, file.mime, file.data));
  const body = typeof input === 'function' ? input(ids) : input;
  const sent = await api.post(`/api/conversations/${conversation.id}/messages`, {
    text: `chamar ${name} ${JSON.stringify(body)}`,
    attachmentIds: ids,
  });
  const settle = async () => {
    if (!opts.worker) return drain();
    for (let i = 0; i < 600; i += 1) {
      const { status } = await runStatus(sent.run.id);
      if (['awaiting_confirmation', 'completed', 'failed', 'canceled'].includes(status)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await settle();
  let detail = await api.get(`/api/conversations/${conversation.id}`);
  const confirmation = detail.confirmations.find((c: any) => c.status === 'pending');
  if (confirmation && opts.approve !== false) {
    await api.post(`/api/runs/${sent.run.id}/confirmations`, { decision: 'approved' });
    await settle();
    detail = await api.get(`/api/conversations/${conversation.id}`);
  }
  const result = detail.messages.filter((m: any) => m.role === 'tool').at(-1)?.content[0];
  return {
    conversationId: conversation.id as string,
    runId: sent.run.id as string,
    attachmentIds: ids,
    preview: confirmation?.preview,
    error: result?.is_error ? (result.content as string) : null,
    value: result && !result.is_error ? parseResult(result.content) : null,
  };
}

/** Resultado para o modelo (num banco de teste reaproveitado, uma lista grande vem truncada: aí, o texto). */
function parseResult(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** Escrita aprovada: a prévia e o valor devolvido. */
const approved = async (
  session: Session,
  name: string,
  input: Record<string, unknown> | ((ids: string[]) => any),
  opts: CallOptions = {},
) => {
  const out = await call(session, name, input, opts);
  expect(out.error, out.error ?? '').toBeNull();
  expect(out.preview, `${name} sem prévia`).toBeTruthy();
  return out;
};

/** Linhas da prévia como { rótulo: 'antes → depois' | 'depois' } (o espaço do R$ normalizado). */
const rowsOf = (preview: any): Record<string, string> =>
  Object.fromEntries(
    preview.rows.map((r: any) => [
      r.label,
      (r.before !== undefined ? `${r.before} → ${r.after}` : String(r.after)).replace(/\u00a0/g, ' '),
    ]),
  );

let listening: string | null = null;
/** Endereço do app para o cliente MCP (escuta uma vez só no arquivo). */
async function listenOnce() {
  listening ??= await h.app.listen({ port: 0, host: '127.0.0.1' });
  return listening;
}

/** Ator agent + execução na auditoria do registro. */
async function auditActor(table: string, recordId: string) {
  const r = await h.db.execute<{ actor_kind: string; agent_run_id: string | null }>(
    sql`SELECT actor_kind, agent_run_id FROM audit_log WHERE table_name = ${table} AND record_id = ${recordId} ORDER BY id DESC LIMIT 1`,
  );
  return r.rows[0];
}

beforeAll(async () => {
  llm = await startFakeLlm(0, '127.0.0.1');
  h = await startApp();
  adminSession = await userSession(h, 'admin');
  admin = client(h, adminSession.cookie);
  viewerSession = await userSession(h);
  const provider = await admin.post('/api/admin/ai/providers', {
    name: `Falso F13a ${uid()}`,
    kind: 'anthropic',
    baseUrl: llm.url,
    apiKey: 'sk-ant-test-f13a',
    defaultModels: { text: 'claude-sonnet-5-5' },
  });
  // Kit com todas as tools no modo sugerido: as escritas pedem aprovação (a prévia do cartão).
  const catalog: any[] = await admin.get('/api/admin/ai/tools');
  const kit = await admin.post('/api/admin/ai/tool-kits', {
    name: `F13a ${uid()}`,
    tools: catalog.map((tool) => ({ name: tool.name, mode: tool.suggestedMode })),
  });
  agent = await admin.post('/api/admin/ai/agents', {
    name: `Agente F13a ${uid()}`,
    systemPrompt: 'Testes das tools de controle total.',
    defaultProviderId: provider.id,
    model: 'claude-sonnet-5-5',
    params: { max_tokens: 2000, max_tool_iterations: 4 },
    toolKitId: kit.id,
    isActive: true,
  });
  s = await scenario(h, admin);
  await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: viewerSession.id, role: 'viewer' });
});

afterAll(async () => {
  registerDocumentReader(null);
  // Os outros arquivos de teste usam o mesmo banco e esperam "sem agente configurado".
  for (const a of await admin.get('/api/admin/ai/agents'))
    if (a.isActive) await admin.patch(`/api/admin/ai/agents/${a.id}`, { isActive: false });
  await h.close();
  await llm.close();
});

describe('registro e oferta (spec 027)', () => {
  it('o catálogo traz as categorias novas; as só de admin não chegam ao modelo de quem não é admin', async () => {
    const catalog: any[] = await admin.get('/api/admin/ai/tools');
    expect(catalog.find((t) => t.name === 'import_statement')).toMatchObject({ category: 'imports', kind: 'write', suggestedMode: 'ask' });
    expect(catalog.find((t) => t.name === 'archive_caixa')).toMatchObject({ category: 'caixas', adminOnly: true, destructive: true });
    expect(catalog.find((t) => t.name === 'list_categories')).toMatchObject({ category: 'categories' });

    const toolsSent = () =>
      llm.calls
        .filter((c) => c.path === '/v1/messages' && Array.isArray(c.body.tools) && c.body.tools.length > 0)
        .at(-1)!
        .body.tools.map((t: any) => t.name);
    await call(viewerSession, 'list_contracts', {});
    expect(toolsSent()).toContain('create_contract');
    expect(toolsSent()).not.toContain('create_category');
    expect(toolsSent()).not.toContain('archive_caixa');
    await call(adminSession, 'list_contracts', {});
    expect(toolsSent()).toEqual(expect.arrayContaining(['create_category', 'archive_caixa', 'import_statement']));

    for (const name of ['create_category', 'update_category', 'archive_category', 'archive_caixa']) {
      const out = await call(viewerSession, name, {});
      expect(out.error).toBe(`Tool desconhecida ou não habilitada: ${name}`);
    }
  });
});

describe('contratos', () => {
  it('criar (rascunho), editar, ativar, aditivo, markdown, documentos, renovação e rescisão', async () => {
    const base = {
      caixaId: s.caixaA.id,
      entityId: s.supplier.id,
      direction: 'receivable',
      categoryId: s.income.id,
      name: `Suporte ${uid()}`,
      startsOn: '2031-01-01',
      durationMonths: 12,
      periodicity: 'monthly',
      totalCents: 120_000,
      dueDay: 10,
      dueMonthOffset: 0,
      mirrorCaixaId: null,
    };
    // Viewer não cria contrato na caixa que só lê.
    expect((await call(viewerSession, 'create_contract', base)).error).toBe('Você só tem leitura nesta caixa.');

    const created = await approved(adminSession, 'create_contract', base);
    expect(created.preview).toMatchObject({ title: 'Criar contrato', action: 'create' });
    expect(rowsOf(created.preview)).toMatchObject({
      Parcelas: '12 (mensal)',
      'Valor total do ciclo': 'R$ 1.200,00',
      Espelho: 'Sem espelho',
    });
    expect(created.preview.warnings[0]).toContain('rascunho');
    const contractId = created.value.id;
    expect(created.value).toMatchObject({ status: 'draft' });
    expect(await auditActor('contracts', contractId)).toEqual({ actor_kind: 'agent', agent_run_id: created.runId });

    const listed = await call(adminSession, 'list_contracts', { caixaId: s.caixaA.id, q: base.name });
    expect(listed.value.map((c: any) => c.id)).toEqual([contractId]);
    expect((await call(viewerSession, 'get_contract', { contractId })).value).toMatchObject({ id: contractId, canWrite: false });

    const edited = await approved(adminSession, 'update_contract', { contractId, changes: { totalCents: 240_000, noticeDays: 45 } });
    expect(rowsOf(edited.preview)).toMatchObject({ 'Valor total do ciclo': 'R$ 1.200,00 → R$ 2.400,00', 'Aviso prévio (dias)': '30 → 45' });
    expect((await call(viewerSession, 'update_contract', { contractId, changes: { noticeDays: 10 } })).error).toBe(
      'Você só tem leitura nesta caixa.',
    );

    const activated = await approved(adminSession, 'activate_contract', { contractId });
    expect(rowsOf(activated.preview)).toMatchObject({ Situação: 'Rascunho → Vigente', 'Parcela 1/12': 'R$ 200,00 · venc. 10/01/2031' });
    expect(activated.value.status).toBe('active');
    expect(activated.value.cycles[0].installments).toHaveLength(12);
    // Vigente: valores só por aditivo (a prévia já recusa).
    expect((await call(adminSession, 'update_contract', { contractId, changes: { totalCents: 1000 } })).error).toBe(
      'Contrato vigente: prazo, valor, vencimento, periodicidade e categoria mudam por aditivo ou na renovação.',
    );

    const amended = await approved(adminSession, 'add_contract_amendment', {
      contractId,
      amendment: { effectiveOn: '2031-07-01', installmentCents: 25_000 },
    });
    expect(rowsOf(amended.preview)['Parcela 7']).toBe('R$ 200,00 · venc. 10/07/2031 → R$ 250,00 · venc. 10/07/2031');
    expect(amended.value.contract.cycles[0].installments[6].amountCents).toBe(25_000);

    // Markdown: documento novo (versão 1 do agente) e nova versão com o diff.
    const doc = await approved(adminSession, 'save_contract_markdown', {
      contractId,
      title: 'Contrato assinado',
      content: '# Contrato\n\nCláusula 1.',
    });
    expect(doc.preview).toMatchObject({ title: 'Criar documento markdown', action: 'create' });
    const documentId = doc.value.id;
    const version = await approved(adminSession, 'save_contract_markdown', {
      documentId,
      content: '# Contrato\n\nCláusula 1.\nCláusula 2.',
      note: 'segunda cláusula',
    });
    expect(rowsOf(version.preview)).toMatchObject({ Versão: '1 → 2', Linhas: '+1 / −0' });
    const read = await call(viewerSession, 'get_contract_document', { documentId });
    expect(read.value.version).toMatchObject({ version: 2, content: '# Contrato\n\nCláusula 1.\nCláusula 2.' });
    expect(read.value.versions.map((v: any) => v.authorKind)).toEqual(['agent', 'agent']);
    expect((await call(adminSession, 'save_contract_markdown', { documentId, content: read.value.version.content })).error).toBe(
      'Nada mudou desde a versão atual.',
    );

    // Renovação: recusar sem tarefa aberta falha na prévia; aprovar gera o próximo ciclo.
    expect((await call(adminSession, 'decide_contract_renewal', { contractId, decision: 'decline' })).error).toBe(
      'Não há tarefa de renovação aberta.',
    );
    const renewed = await approved(adminSession, 'decide_contract_renewal', {
      contractId,
      decision: 'approve',
      renewal: { durationMonths: 12, periodicity: 'quarterly', totalCents: 400_000, dueDay: 5, dueMonthOffset: 0 },
    });
    expect(rowsOf(renewed.preview)).toMatchObject({
      'Novo ciclo': '01/01/2032 a 31/12/2032',
      'Parcela 1/4': 'R$ 1.000,00 · venc. 05/01/2032',
    });
    expect(renewed.value.contract.cycles).toHaveLength(2);

    const terminated = await approved(adminSession, 'terminate_contract', {
      contractId,
      termination: { terminatedOn: '2031-09-15', notes: 'acordo' },
    });
    expect(terminated.preview).toMatchObject({ title: 'Rescindir contrato', action: 'delete' });
    expect(rowsOf(terminated.preview).Situação).toBe('Vigente → Rescindido');
    expect(terminated.value.contract.status).toBe('terminated');

    // Viewer: nenhuma escrita no contrato da caixa que só lê (a prévia já recusa, sem pedir aprovação).
    const denied: [string, Record<string, unknown>][] = [
      ['activate_contract', { contractId }],
      ['add_contract_amendment', { contractId, amendment: { effectiveOn: '2031-08-01', installmentCents: 100 } }],
      ['terminate_contract', { contractId, termination: { terminatedOn: '2031-08-01' } }],
      ['decide_contract_renewal', { contractId, decision: 'decline' }],
      ['save_contract_markdown', { documentId, content: 'outro' }],
      ['save_contract_markdown', { contractId, title: 'Outro', content: 'x' }],
      ['convert_contract_pdf', { documentId }],
    ];
    for (const [name, input] of denied) {
      const out = await call(viewerSession, name, input);
      expect(out.error, name).toBe('Você só tem leitura nesta caixa.');
      expect(out.preview, name).toBeUndefined();
    }
  });

  it('PDF da sessão vira documento do contrato e a conversão em markdown roda pelo agente dos fluxos', async () => {
    const contract = await admin.post('/api/contracts', {
      caixaId: s.caixaA.id,
      entityId: s.supplier.id,
      direction: 'payable',
      categoryId: s.expense.id,
      name: `Aluguel ${uid()}`,
      startsOn: '2031-02-01',
      durationMonths: 12,
      periodicity: 'monthly',
      totalCents: 600_000,
      dueDay: 5,
      dueMonthOffset: 0,
      mirrorCaixaId: null,
    });
    const pdf = { name: 'contrato-aluguel.pdf', mime: 'application/pdf', data: minimalPdf(['Contrato de aluguel', 'Cláusula 1']) };
    const attached = await approved(
      adminSession,
      'attach_file',
      (ids) => ({ attachmentId: ids[0], target: 'contract', targetId: contract.id }),
      {
        files: [pdf],
      },
    );
    expect(rowsOf(attached.preview)).toMatchObject({ 'Anexar a': `Contrato ${contract.name}`, Documento: 'Contrato' });
    expect(attached.value).toMatchObject({ format: 'pdf', title: 'contrato-aluguel' });

    const stop = startAgentWorker(h.db, h.config, log, { pollMs: 100, maintenanceMs: 3_600_000 });
    try {
      const converted = await approved(adminSession, 'convert_contract_pdf', { documentId: attached.value.id }, { worker: true });
      expect(converted.preview.warnings[0]).toContain('agente dos fluxos');
      expect(converted.value).toMatchObject({ format: 'markdown', sourceDocumentId: attached.value.id, currentVersion: 1 });
    } finally {
      await stop();
    }
    // Um markdown não converte.
    const markdown = await call(adminSession, 'save_contract_markdown', { contractId: contract.id, title: 'Rascunho', content: 'x' }, {});
    expect((await call(adminSession, 'convert_contract_pdf', { documentId: markdown.value.id })).error).toBe(
      'Só um documento PDF pode ser convertido.',
    );
  });
});

describe('importação a partir de anexo', () => {
  it('extrato OFX da sessão: prévia com as linhas novas, import, duplicado recusado, outra sessão e viewer negados', async () => {
    const accountA = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'checking',
      name: `Banco OFX ${uid()}`,
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const ofx = { name: 'extrato.ofx', mime: 'application/x-ofx', data: fixture('extrato-ofx2.ofx') };
    const imported = await approved(adminSession, 'import_statement', (ids) => ({ attachmentId: ids[0], accountId: accountA.id }), {
      files: [ofx],
    });
    const rows = rowsOf(imported.preview);
    expect(rows).toMatchObject({ Arquivo: expect.stringMatching(/^extrato\.ofx/), Formato: 'OFX' });
    expect(Number(rows['Linhas novas'])).toBeGreaterThan(0);
    expect(imported.value).toMatchObject({ financialAccountId: accountA.id, format: 'ofx', fileName: 'extrato.ofx' });
    expect(imported.value.lines.length).toBe(Number(rows['Linhas novas']));
    expect(await auditActor('statement_imports', imported.value.id)).toEqual({ actor_kind: 'agent', agent_run_id: imported.runId });
    // O modelo recebeu o rótulo do anexo com o id (é assim que ele sabe o attachmentId).
    const sent = llm.calls
      .filter((c) => c.path === '/v1/messages')
      .find((c) => JSON.stringify(c.body.messages).includes(imported.attachmentIds[0]!));
    expect(JSON.stringify(sent!.body.messages[0].content[0])).toContain(`attachmentId ${imported.attachmentIds[0]}`);

    // O mesmo arquivo de novo: tudo duplicado, recusado já na prévia.
    const again = await call(adminSession, 'import_statement', (ids) => ({ attachmentId: ids[0], accountId: accountA.id }), {
      files: [ofx],
    });
    expect(again.error).toBe('Todas as linhas do arquivo já tinham sido importadas.');
    expect(again.preview).toBeUndefined();

    // Anexo de outra sessão (a anterior, já finalizada): recusado.
    const foreign = await call(adminSession, 'import_statement', { attachmentId: imported.attachmentIds[0], accountId: accountA.id });
    expect(foreign.error).toBe('O anexo não é desta sessão: use um arquivo enviado nesta conversa.');

    // Viewer da caixa não importa.
    const denied = await call(viewerSession, 'import_statement', (ids) => ({ attachmentId: ids[0], accountId: s.accountA.id }), {
      files: [ofx],
    });
    expect(denied.error).toBe('Você só tem leitura nesta caixa.');
  });

  it('CSV com o mapeamento informado: é salvo e usado no import', async () => {
    const accountA = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'checking',
      name: `Banco CSV ${uid()}`,
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const csv = Buffer.from('Data;Descrição;Valor\n03/10/2026;PADARIA;-12,50\n04/10/2026;PIX RECEBIDO;300,00\n');
    const out = await approved(
      adminSession,
      'import_statement',
      (ids) => ({
        attachmentId: ids[0],
        accountId: accountA.id,
        csvMapping: { name: 'Banco do agente', columns: { date: 0, description: 1, amount: 2 } },
      }),
      { files: [{ name: 'extrato.csv', mime: 'text/csv', data: csv }] },
    );
    expect(rowsOf(out.preview)).toMatchObject({ Formato: 'CSV', 'Linhas novas': '2', 'Mapeamento CSV (salvo)': 'Banco do agente' });
    expect(out.value.lines.map((l: any) => l.amountCents)).toEqual([-1250, 30_000]);
    const mappings = await admin.get(`/api/csv-mappings?accountId=${accountA.id}`);
    expect(mappings.map((m: any) => m.name)).toEqual(['Banco do agente']);
  });

  it('NF-e da sessão: prévia da nota, import com o título sugerido; leitura de documento e de linha digitável/PIX', async () => {
    // NF-e única (a chave muda a cada execução, para não colidir com outros testes no mesmo banco).
    const xml = fixture('nfe-exemplo.xml').toString('utf8');
    const oldKey = /<chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(xml)![1]!;
    const base = `${oldKey.slice(0, 35)}${String(randomInt(10_000_000, 99_999_999))}`;
    const key = `${base}${nfeAccessKeyDv(base)}`;
    const nfe = Buffer.from(xml.replaceAll(oldKey, key).replace(/<cNF>\d{8}<\/cNF>/, `<cNF>${key.slice(35, 43)}</cNF>`));
    const imported = await approved(adminSession, 'import_nfe', (ids) => ({ attachmentId: ids[0] }), {
      files: [{ name: 'nota.xml', mime: 'application/xml', data: nfe }],
    });
    expect(rowsOf(imported.preview)).toMatchObject({ Valor: 'R$ 433,09', Itens: '3' });
    expect(imported.preview.warnings).toEqual(['O título não é criado aqui: use create_title com o nfeDocumentId devolvido.']);
    expect(imported.value).toMatchObject({ accessKey: key, alreadyImported: false, totalCents: 43_309 });
    expect(imported.value.suggestedTitle).toMatchObject({
      direction: 'payable',
      entityId: imported.value.issuer.entityId,
      amountCents: 43_309,
      nfeDocumentId: imported.value.nfeDocumentId,
    });
    // Viewer não cadastra (a NF-e cria a entidade do emitente).
    const denied = await call(viewerSession, 'import_nfe', (ids) => ({ attachmentId: ids[0] }), {
      files: [{ name: 'nota.xml', mime: 'application/xml', data: nfe }],
    });
    expect(denied.error).toBeTruthy();

    // Leitura de documento (o leitor do teste no lugar do agente dos fluxos): lê o anexo da sessão, sem gravar.
    registerDocumentReader(async (_ctx, file) => ({
      kind: 'boleto',
      entityName: `Lido de ${file.name}`,
      document: null,
      amountCents: file.content.length,
      dueDate: '2031-05-10',
      boletoLine: null,
      pixPayload: null,
      description: file.mime,
      entityId: null,
      conversationId: null,
    }));
    const png = { name: 'boleto.pdf', mime: 'application/pdf', data: minimalPdf(['Boleto']) };
    const readDoc = await call(viewerSession, 'read_document', (ids) => ({ attachmentId: ids[0] }), { files: [png] });
    expect(readDoc.preview).toBeUndefined();
    expect(readDoc.value).toMatchObject({ kind: 'boleto', entityName: 'Lido de boleto.pdf', description: 'application/pdf' });
    const otherSession = await call(viewerSession, 'read_document', { attachmentId: readDoc.attachmentIds[0] });
    expect(otherSession.error).toBe('O anexo não é desta sessão: use um arquivo enviado nesta conversa.');
    registerDocumentReader(null);

    const boleto = await call(viewerSession, 'parse_payment_code', { code: BOLETO });
    expect(boleto.value).toMatchObject({ kind: 'boleto', bankCode: '341', amountCents: 123_456 });
    const pix = await call(viewerSession, 'parse_payment_code', { code: PIX });
    expect(pix.value).toMatchObject({ kind: 'pix', pixKey: 'fulano@exemplo.com', amountCents: 12_345, merchantName: 'Fulano de Tal' });
    expect((await call(viewerSession, 'parse_payment_code', { code: '123' })).error).toBeTruthy();
  });

  it('anexar arquivo da sessão a um título; viewer e outra sessão negados', async () => {
    const title = await admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: `Conta anexada ${uid()}`,
      competenceDate: '2031-03-01',
      dueDate: '2031-03-10',
      amountCents: 9_900,
      mirrorCaixaId: null,
    });
    const file = { name: 'comprovante.pdf', mime: 'application/pdf', data: minimalPdf(['Comprovante']) };
    const attached = await approved(adminSession, 'attach_file', (ids) => ({ attachmentId: ids[0], target: 'title', targetId: title.id }), {
      files: [file],
    });
    expect(rowsOf(attached.preview)['Anexar a']).toContain(title.description);
    expect(attached.value).toMatchObject({ id: attached.attachmentIds[0], fileName: 'comprovante.pdf' });
    const listed = await admin.get(`/api/attachments?target=title&targetId=${title.id}`);
    expect(listed.map((a: any) => a.id)).toEqual([attached.attachmentIds[0]]);

    const foreign = await call(adminSession, 'attach_file', {
      attachmentId: attached.attachmentIds[0],
      target: 'title',
      targetId: title.id,
    });
    expect(foreign.error).toBe('O anexo não é desta sessão: use um arquivo enviado nesta conversa.');
    const denied = await call(viewerSession, 'attach_file', (ids) => ({ attachmentId: ids[0], target: 'title', targetId: title.id }), {
      files: [file],
    });
    expect(denied.error).toBe('Você só tem leitura nesta caixa.');
  });

  it('/mcp (sem sessão): importa com um anexo que o dono do token lê; anexo alheio recusado; só admin vê as de admin', async () => {
    const owner = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaB.id}/members`, { userId: owner.id, role: 'editor' });
    const ownerApi = client(h, owner.cookie);
    const account = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
      kind: 'checking',
      name: `Banco MCP ${uid()}`,
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    // Um anexo do próprio dono (enviado numa sessão dele) e um do admin.
    const ownConversation = await newSession(ownerApi, agent.id);
    const own = await upload(owner, ownConversation.id, 'extrato.ofx', 'application/x-ofx', fixture('extrato-ofx1.ofx'));
    const adminConversation = await newSession(admin, agent.id);
    const alien = await upload(adminSession, adminConversation.id, 'extrato.ofx', 'application/x-ofx', fixture('extrato-ofx1.ofx'));

    const token = (await ownerApi.post('/api/account/api-tokens', { name: 'MCP F13a', expiresInDays: 1 })).token;
    const address = await listenOnce();
    const mcpClient = new Client({ name: 'teste-f13a', version: '1.0.0' });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const tools = (await mcpClient.listTools()).tools;
      expect(tools.find((t) => t.name === 'import_statement')).toBeTruthy();
      expect(tools.find((t) => t.name === 'archive_caixa')).toBeUndefined();
      expect(tools.find((t) => t.name === 'reopen_invoice')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

      const refused = await mcpClient.callTool({ name: 'import_statement', arguments: { attachmentId: alien, accountId: account.id } });
      expect(refused.isError).toBe(true);
      expect((refused.content as { text: string }[])[0]!.text).toBe('Registro não encontrado.');
      const result = await mcpClient.callTool({ name: 'import_statement', arguments: { attachmentId: own, accountId: account.id } });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const detail = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(detail).toMatchObject({ financialAccountId: account.id, format: 'ofx' });
      expect(await auditActor('statement_imports', detail.id)).toEqual({ actor_kind: 'agent', agent_run_id: null });

      // upload_file (só do /mcp): o OFX com corrente e poupança vai para a poupança, que importa só o extrato dela.
      expect(tools.find((t) => t.name === 'upload_file')).toBeTruthy();
      const text = (r: Awaited<ReturnType<typeof mcpClient.callTool>>) => (r.content as { text: string }[])[0]!.text;
      const bad = await mcpClient.callTool({ name: 'upload_file', arguments: { fileName: 'x.ofx', contentBase64: 'não é base64!' } });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toBe('Conteúdo inválido: envie o arquivo em base64.');
      const sent = await mcpClient.callTool({
        name: 'upload_file',
        arguments: { fileName: 'poupanca.ofx', contentBase64: fixture('extrato-duas-contas.ofx').toString('base64') },
      });
      expect(sent.isError, text(sent)).toBeFalsy();
      const file = JSON.parse(text(sent));
      expect(file).toMatchObject({ fileName: 'poupanca.ofx', mimeType: 'application/x-ofx' });
      const savings = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
        kind: 'savings',
        name: `Poupança MCP ${uid()}`,
        bankCode: '033',
        accountNumber: '60000987-6',
        openingBalanceCents: 0,
        openingDate: '2026-01-01',
      });
      const imported = await mcpClient.callTool({
        name: 'import_statement',
        arguments: { attachmentId: file.attachmentId, accountId: savings.id },
      });
      expect(imported.isError, text(imported)).toBeFalsy();
      const savingsLot = JSON.parse(text(imported));
      expect(savingsLot).toMatchObject({ financialAccountId: savings.id, lineCount: 2, bankBalanceCents: 120_840 });

      // Saldo do banco do lote pela tool: valor e data, limpar e voltar ao do arquivo.
      const set = await mcpClient.callTool({
        name: 'set_statement_import_balance',
        arguments: { importId: savingsLot.id, mode: 'set', bankBalanceCents: 99_999, bankBalanceOn: '2026-10-15' },
      });
      expect(set.isError, text(set)).toBeFalsy();
      expect(JSON.parse(text(set))).toMatchObject({ bankBalanceCents: 99_999, bankBalanceOn: '2026-10-15' });
      expect(JSON.parse(text(set))).not.toHaveProperty('lines');
      const cleared = await mcpClient.callTool({
        name: 'set_statement_import_balance',
        arguments: { importId: savingsLot.id, mode: 'clear' },
      });
      expect(JSON.parse(text(cleared))).toMatchObject({ bankBalanceCents: null, bankBalanceOn: null });
      const fromFile = await mcpClient.callTool({
        name: 'set_statement_import_balance',
        arguments: { importId: savingsLot.id, mode: 'file' },
      });
      expect(JSON.parse(text(fromFile))).toMatchObject({ bankBalanceCents: 120_840, bankBalanceOn: '2026-10-31' });
    } finally {
      await mcpClient.close();
    }
  });
});

describe('cartão de crédito', () => {
  it('fechar, reabrir, encargo, estorno, pagar parcial e antecipado; o viewer da pagadora não escreve', async () => {
    const issuer = await admin.post('/api/entities', { kind: 'company', name: `Emissor ${uid()}` });
    const card = await admin.post('/api/caixas', {
      name: `Cartão F13a ${uid()}`,
      kind: 'credit_card',
      holderEntityId: issuer.id,
      defaultPayerCaixaId: s.caixaA.id,
      creditLimitCents: 500_000,
      closingDay: 3,
      dueDay: 10,
      cardLast4: '4321',
    });
    const purchase = await admin.post(`/api/cards/${card.id}/purchases`, {
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      purchasedOn: '2026-09-12',
      description: 'Monitor',
      amountCents: 100_000,
    });
    const invoiceId = purchase.items[0].invoiceId;

    const charge = await approved(adminSession, 'create_card_charge', {
      cardId: card.id,
      charge: { chargeKind: 'iof', amountCents: 380, categoryId: s.expense.id, chargedOn: '2026-09-20' },
    });
    expect(rowsOf(charge.preview)).toMatchObject({ Tipo: 'IOF', Valor: 'R$ 3,80' });
    expect(charge.value).toMatchObject({ kind: 'charge', chargeKind: 'iof', amountCents: 380 });

    const refund = await approved(adminSession, 'refund_card_purchase', {
      purchaseId: purchase.id,
      refund: { amountCents: 10_000, refundedOn: '2026-09-25' },
    });
    expect(rowsOf(refund.preview)['Ainda não estornado']).toBe('R$ 1.000,00 → R$ 900,00');
    expect(refund.value).toMatchObject({ kind: 'refund', amountCents: 10_000, refundedPurchaseId: purchase.id });
    expect(
      (
        await call(adminSession, 'refund_card_purchase', {
          purchaseId: purchase.id,
          refund: { amountCents: 95_000, refundedOn: '2026-09-25' },
        })
      ).error,
    ).toBe('O estorno passa do valor ainda não estornado da compra.');

    const closed = await approved(adminSession, 'close_invoice', { invoiceId });
    expect(rowsOf(closed.preview)).toMatchObject({ Situação: 'Aberta → Fechada', [`A pagar por ${s.caixaA.name}`]: 'R$ 903,80' });
    expect(closed.value.closedAt).not.toBeNull();
    expect((await call(adminSession, 'close_invoice', { invoiceId })).error).toBe('A fatura já está fechada.');

    const reopened = await approved(adminSession, 'reopen_invoice', { invoiceId });
    expect(reopened.preview).toMatchObject({ title: 'Reabrir fatura', action: 'delete' });
    expect(reopened.value.closedAt).toBeNull();
    await approved(adminSession, 'close_invoice', { invoiceId });

    // Pagamento parcial: o resto rola, com juros.
    const paid = await approved(adminSession, 'pay_invoice', {
      invoiceId,
      payerCaixaId: s.caixaA.id,
      settledOn: '2026-10-10',
      amountCents: 50_000,
      financialAccountId: s.accountA.id,
      charges: [{ chargeKind: 'interest', amountCents: 1_200, categoryId: s.expense.id }],
    });
    expect(rowsOf(paid.preview)).toMatchObject({
      'Em aberto': 'R$ 903,80',
      'Pago agora': 'R$ 500,00',
      'Rola para a próxima fatura': 'R$ 403,80',
      'Encargo: Juros': 'R$ 12,00',
    });
    expect(paid.value.settledCents).toBe(50_000);
    // Com pagamento, não reabre (a prévia já avisa).
    expect((await call(adminSession, 'reopen_invoice', { invoiceId })).error).toBe('A fatura tem pagamento: estorne-o antes de reabrir.');

    // Antecipado na fatura aberta seguinte: valor e conta obrigatórios.
    const next = (await admin.get(`/api/cards/${card.id}`)).invoices.find(
      (i: any) => i.closedAt === null && i.referenceMonth > '2026-10-01',
    );
    expect(
      (
        await call(adminSession, 'pay_invoice', {
          invoiceId: next.id,
          payerCaixaId: s.caixaA.id,
          settledOn: '2026-10-20',
          amountCents: 10_000,
        })
      ).error,
    ).toBe('Fatura aberta: o pagamento antecipado precisa de valor maior que zero e da conta (financialAccountId).');
    const advance = await approved(adminSession, 'pay_invoice', {
      invoiceId: next.id,
      payerCaixaId: s.caixaA.id,
      settledOn: '2026-10-20',
      amountCents: 10_000,
      financialAccountId: s.accountA.id,
    });
    expect(advance.preview.title).toBe('Pagar fatura (antecipado)');
    expect(advance.value.settledCents).toBe(10_000);

    // Viewer da caixa A (a pagadora): lê o cartão e a fatura por ela, mas não fecha nem lança.
    expect((await call(viewerSession, 'close_invoice', { invoiceId: next.id })).error).toBe('Você só tem leitura nesta caixa.');
    const cardDenied: [string, Record<string, unknown>][] = [
      ['reopen_invoice', { invoiceId }],
      [
        'pay_invoice',
        { invoiceId, payerCaixaId: s.caixaA.id, settledOn: '2026-10-11', amountCents: 100, financialAccountId: s.accountA.id },
      ],
      ['refund_card_purchase', { purchaseId: purchase.id, refund: { amountCents: 100, refundedOn: '2026-10-01' } }],
    ];
    for (const [name, input] of cardDenied)
      expect((await call(viewerSession, name, input)).error, name).toBe('Você só tem leitura nesta caixa.');
    expect(
      (
        await call(viewerSession, 'create_card_charge', {
          cardId: card.id,
          charge: { chargeKind: 'fee', amountCents: 100, categoryId: s.expense.id, chargedOn: '2026-10-01' },
        })
      ).error,
    ).toBe('Você só tem leitura nesta caixa.');
  });
});

describe('caixas e contas', () => {
  it('criar e editar caixa e conta, movimento avulso, arquivar conta e caixa (admin); viewer negado', async () => {
    const holder = await admin.post('/api/entities', { kind: 'person', name: `Titular F13a ${uid()}` });
    const caixa = await approved(adminSession, 'create_caixa', { name: `Casa ${uid()}`, holderEntityId: holder.id, isPrimary: true });
    expect(rowsOf(caixa.preview)).toMatchObject({ Tipo: 'Geral', Titular: holder.name, 'Principal do titular': 'Sim' });
    expect(caixa.value).toMatchObject({ holderEntityId: holder.id, isPrimary: true });
    expect(await auditActor('caixas', caixa.value.id)).toEqual({ actor_kind: 'agent', agent_run_id: caixa.runId });

    const renamed = await approved(adminSession, 'update_caixa', { caixaId: caixa.value.id, changes: { name: 'Casa nova' } });
    expect(rowsOf(renamed.preview).Nome).toBe(`${caixa.value.name} → Casa nova`);

    const account = await approved(adminSession, 'create_account', {
      caixaId: caixa.value.id,
      account: { kind: 'checking', name: 'Conta F13a', bankCode: '001', openingBalanceCents: 5_000, openingDate: '2026-01-01' },
    });
    expect(rowsOf(account.preview)).toMatchObject({ Tipo: 'Conta corrente', 'Saldo de abertura': 'R$ 50,00' });
    const updated = await approved(adminSession, 'update_account', { accountId: account.value.id, changes: { name: 'Conta principal' } });
    expect(rowsOf(updated.preview).Nome).toBe('Conta F13a → Conta principal');

    const adjustment = await approved(adminSession, 'create_adjustment', {
      accountId: account.value.id,
      adjustment: { occurredOn: '2026-02-01', amountCents: -1_500, description: 'Tarifa', categoryId: s.expense.id },
    });
    expect(rowsOf(adjustment.preview)).toMatchObject({ Saída: 'R$ 15,00', Descrição: 'Tarifa' });
    expect(adjustment.value.id).toBeTruthy();

    // Conta com movimento: arquivada; caixa com conta: arquivada (só admin).
    const archivedAccount = await approved(adminSession, 'archive_account', { accountId: account.value.id });
    expect(archivedAccount.preview.action).toBe('delete');
    expect(archivedAccount.value).toEqual({ deleted: false, archived: true });
    const archivedCaixa = await approved(adminSession, 'archive_caixa', { caixaId: caixa.value.id });
    expect(archivedCaixa.value).toEqual({ deleted: false, archived: true });
    expect((await call(adminSession, 'archive_caixa', { caixaId: caixa.value.id })).error).toBe('O registro já está arquivado.');

    // Viewer: só lê a caixa A.
    expect(
      (
        await call(viewerSession, 'create_adjustment', {
          accountId: s.accountA.id,
          adjustment: { occurredOn: '2026-02-01', amountCents: 100, description: 'x' },
        })
      ).error,
    ).toBe('Você só tem leitura nesta caixa.');
    expect((await call(viewerSession, 'update_caixa', { caixaId: s.caixaA.id, changes: { name: 'x' } })).error).toBe(
      'Você só tem leitura nesta caixa.',
    );
    expect((await call(viewerSession, 'archive_account', { accountId: s.accountA.id })).error).toBe('Você só tem leitura nesta caixa.');
    expect(
      (
        await call(viewerSession, 'create_account', {
          caixaId: s.caixaA.id,
          account: { kind: 'cash', name: 'x', openingBalanceCents: 0, openingDate: '2026-01-01' },
        })
      ).error,
    ).toBe('Você só tem leitura nesta caixa.');
    expect((await call(viewerSession, 'update_account', { accountId: s.accountA.id, changes: { name: 'x' } })).error).toBe(
      'Você só tem leitura nesta caixa.',
    );
    // Cadastro global de caixa: só admin ou quem edita alguma caixa (o viewer não edita nenhuma).
    expect((await call(viewerSession, 'create_caixa', { name: 'x', holderEntityId: holder.id })).error).toBe(
      'Você não tem permissão para esta ação.',
    );
  });
});

describe('conciliação: avulso, desfazer e excluir e lotes em páginas', () => {
  it('delete_adjustment, unmatch_statement_line com deleteEntry e as páginas de list/get_statement_import', async () => {
    const account = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'checking',
      name: `Conciliação ${uid()}`,
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const movementExists = async (id: string) => (await h.db.execute(sql`SELECT 1 FROM movements WHERE id = ${id}`)).rows.length > 0;

    // Excluir avulso: prévia com os dados, execução, e o viewer negado.
    const fee = await admin.post(`/api/accounts/${account.id}/adjustments`, {
      occurredOn: '2026-02-01',
      amountCents: -1_500,
      description: 'Tarifa avulsa',
      categoryId: s.expense.id,
    });
    expect((await call(viewerSession, 'delete_adjustment', { movementId: fee.id })).error).toBe('Você só tem leitura nesta caixa.');
    const deleted = await approved(adminSession, 'delete_adjustment', { movementId: fee.id });
    expect(deleted.preview.action).toBe('delete');
    expect(rowsOf(deleted.preview)).toMatchObject({ Saída: 'R$ 15,00 → —', Data: '01/02/2026 → —' });
    expect(deleted.value).toEqual({ deleted: true });
    expect(await movementExists(fee.id)).toBe(false);

    // Lote importado: páginas das linhas, filtro por situação e só o resumo.
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/statement-imports?accountId=${account.id}&fileName=extrato.ofx`,
      payload: fixture('extrato-ofx2.ofx'),
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-ofx' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const imp = res.json();
    const imports = await call(adminSession, 'list_statement_imports', { accountId: account.id, limit: 1 });
    expect(imports.value).toMatchObject({ total: 1, offset: 0, nextOffset: null });
    expect(imports.value.imports[0].id).toBe(imp.id);
    const page = await call(adminSession, 'get_statement_import', { importId: imp.id, statuses: ['new'], limit: 4 });
    expect(page.value).toMatchObject({ id: imp.id, lineTotal: 6, offset: 0, nextOffset: 4 });
    expect(page.value.lines).toHaveLength(4);
    expect(page.value.lines[0]).not.toHaveProperty('importId');
    expect(page.value.lines[0]).not.toHaveProperty('movementId');
    const rest = await call(adminSession, 'get_statement_import', { importId: imp.id, statuses: ['new'], limit: 4, offset: 4 });
    expect(rest.value).toMatchObject({ lineTotal: 6, nextOffset: null });
    expect(rest.value.lines).toHaveLength(2);
    expect((await call(adminSession, 'get_statement_import', { importId: imp.id, limit: 0 })).value).toMatchObject({
      lineCount: 6,
      lines: [],
    });

    // Linha lançada como avulso: a leitura mostra createdEntry; desfazer sem excluir avisa a duplicação.
    const lineId = imp.lines.find((l: any) => l.fitid === 'OFX2-0005').id;
    const created = await admin.post(`/api/statement-lines/${lineId}/create`, { mode: 'adjustment', learnRule: false });
    const matched = await call(adminSession, 'get_statement_import', { importId: imp.id, statuses: ['matched'] });
    expect(matched.value.lines).toEqual([expect.objectContaining({ id: lineId, createdEntry: 'adjustment' })]);
    const kept = await call(adminSession, 'unmatch_statement_line', { lineId }, { approve: false });
    expect(kept.preview.warnings.join(' ')).toContain('duplica o valor');
    const removed = await approved(adminSession, 'unmatch_statement_line', { lineId, deleteEntry: true });
    expect(rowsOf(removed.preview).Lançamento).toBe('Movimento avulso → Excluído');
    expect(removed.value).toMatchObject({ status: 'new', createdEntry: null });
    expect(await movementExists(created.movementId)).toBe(false);

    // Linha nova não tem o que desfazer; casada com um avulso que já existia, deleteEntry é recusado já na prévia.
    expect((await call(adminSession, 'unmatch_statement_line', { lineId, deleteEntry: true })).error).toBe(
      'Esta linha não está conciliada.',
    );
    const other = await admin.post(`/api/accounts/${account.id}/adjustments`, {
      occurredOn: '2026-10-18',
      amountCents: 7_525,
      description: 'Rendimento',
    });
    await admin.post(`/api/statement-lines/${lineId}/match`, { movementId: other.id });
    expect((await call(adminSession, 'unmatch_statement_line', { lineId, deleteEntry: true })).error).toBe(
      'O lançamento desta linha não nasceu dela: desfaça só a conciliação e corrija o lançamento à mão.',
    );
    // Avulso conciliado não sai pela tool de exclusão.
    expect((await call(adminSession, 'delete_adjustment', { movementId: other.id })).error).toMatch(/concilia/i);

    // Saldo do banco do lote pelo agente: prévia antes → depois; o viewer não escreve.
    expect(
      (
        await call(viewerSession, 'set_statement_import_balance', {
          importId: imp.id,
          mode: 'set',
          bankBalanceCents: 1,
          bankBalanceOn: '2026-10-31',
        })
      ).error,
    ).toBe('Você só tem leitura nesta caixa.');
    const balance = await approved(adminSession, 'set_statement_import_balance', {
      importId: imp.id,
      mode: 'set',
      bankBalanceCents: -26_772,
      bankBalanceOn: '2026-10-31',
    });
    expect(balance.preview.action).toBe('update');
    expect(rowsOf(balance.preview)['Saldo do banco']).toMatch(/→ .*267,72 em 31\/10\/2026$/);
    expect(balance.value).toMatchObject({ id: imp.id, bankBalanceCents: -26_772, bankBalanceOn: '2026-10-31' });
  });
});

describe('títulos e baixas', () => {
  const newTitle = (overrides: Record<string, unknown> = {}) =>
    admin.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.supplier.id,
      categoryId: s.expense.id,
      description: `Título F13a ${uid()}`,
      competenceDate: '2031-04-01',
      dueDate: '2031-04-10',
      amountCents: 7_000,
      mirrorCaixaId: null,
      ...overrides,
    });

  it('cancelar, arquivar, excluir, aceitar e contestar espelho, excluir transferência; viewer negado', async () => {
    const toCancel = await newTitle();
    const canceled = await approved(adminSession, 'cancel_title', { titleId: toCancel.id });
    expect(rowsOf(canceled.preview).Situação).toBe('Em aberto → Cancelado');
    expect(canceled.value.status).toBe('canceled');
    expect((await call(adminSession, 'cancel_title', { titleId: toCancel.id })).error).toBe('O título já está cancelado.');

    const toArchive = await newTitle();
    const archived = await approved(adminSession, 'archive_title', { titleId: toArchive.id });
    expect(archived.value.archivedAt).not.toBeNull();
    expect(archived.value.status).toBe('open');

    const toDelete = await newTitle();
    const deleted = await approved(adminSession, 'delete_title', { titleId: toDelete.id });
    expect(rowsOf(deleted.preview).Resultado).toBe('Em aberto → Excluído');
    expect(deleted.value).toEqual({ deleted: true, archived: false });

    // Espelho pendente: um editor só da caixa A cria um título contra o titular da B (sem escrita lá).
    const editorSession = await userSession(h);
    await admin.post(`/api/caixas/${s.caixaA.id}/members`, { userId: editorSession.id, role: 'editor' });
    const editor = client(h, editorSession.cookie);
    const pair = await editor.post('/api/titles', {
      caixaId: s.caixaA.id,
      direction: 'payable',
      entityId: s.holderB.id,
      categoryId: s.expense.id,
      description: `Espelho F13a ${uid()}`,
      competenceDate: '2031-04-01',
      dueDate: '2031-04-10',
      amountCents: 3_000,
    });
    const mirrorId = pair.mirrorTitleId;
    expect((await admin.get(`/api/titles/${mirrorId}`)).mirrorStatus).toBe('pending');
    const disputed = await approved(adminSession, 'dispute_mirror', { titleId: mirrorId, reason: 'não reconheço' });
    expect(rowsOf(disputed.preview)).toMatchObject({ Espelho: 'Aguardando aceite → Contestado', Motivo: 'não reconheço' });
    expect(disputed.value.mirrorStatus).toBe('disputed');
    const accepted = await approved(adminSession, 'accept_mirror', { titleId: mirrorId, categoryId: s.income.id });
    expect(rowsOf(accepted.preview).Espelho).toBe('Contestado → Aceito');
    expect(accepted.value).toMatchObject({ mirrorStatus: 'accepted', categoryId: s.income.id });
    expect((await call(adminSession, 'accept_mirror', { titleId: mirrorId })).error).toBe(
      'Este título não é um espelho aguardando aceite.',
    );
    // O espelho está na caixa B, que o viewer nem enxerga.
    expect((await call(viewerSession, 'dispute_mirror', { titleId: mirrorId })).error).toBe('Registro não encontrado.');
    expect((await call(viewerSession, 'accept_mirror', { titleId: mirrorId })).error).toBe('Registro não encontrado.');

    const transfer = await admin.post('/api/transfers', {
      fromAccountId: s.accountA.id,
      toAccountId: s.accountB.id,
      amountCents: 2_500,
      transferredOn: '2026-03-01',
      description: 'Reserva',
    });
    expect((await call(viewerSession, 'delete_transfer', { transferId: transfer.id })).error).toBe('Você só tem leitura nesta caixa.');
    const removed = await approved(adminSession, 'delete_transfer', { transferId: transfer.id });
    expect(removed.preview).toMatchObject({ title: 'Excluir transferência', action: 'delete' });
    expect(removed.value).toEqual({ deleted: true, archived: false });
    await admin.get(`/api/transfers/${transfer.id}`, 404);

    // Viewer: só leitura.
    const other = await newTitle();
    for (const name of ['cancel_title', 'archive_title', 'delete_title']) {
      expect((await call(viewerSession, name, { titleId: other.id })).error, name).toBe('Você só tem leitura nesta caixa.');
    }
  });
});

describe('categorias e regras', () => {
  it('categorias (admin) e regras de classificação: prévia, execução e permissão', async () => {
    const created = await approved(adminSession, 'create_category', { kind: 'expense', name: `Cat F13a ${uid()}`, colorSlot: 3 });
    expect(rowsOf(created.preview)).toMatchObject({ Tipo: 'Despesa', 'Cor (1–12)': '3' });
    const categoryId = created.value.id;
    const updated = await approved(adminSession, 'update_category', { categoryId, changes: { name: 'Cat renomeada', colorSlot: 5 } });
    expect(rowsOf(updated.preview)).toMatchObject({ Nome: `${created.value.name} → Cat renomeada`, 'Cor (1–12)': '3 → 5' });
    const archived = await approved(adminSession, 'archive_category', { categoryId });
    expect(archived.value).toEqual({ deleted: true, archived: false });

    // Regras por conta (spec 032): a corrente e a poupança da mesma caixa não compartilham regra.
    const savingsA = await admin.post(`/api/caixas/${s.caixaA.id}/accounts`, {
      kind: 'savings',
      name: `Poupança regras ${uid()}`,
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const checkingB = await admin.post(`/api/caixas/${s.caixaB.id}/accounts`, {
      kind: 'checking',
      name: `Corrente B ${uid()}`,
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const pattern = `PADARIA ${uid()}`;
    const rule = await approved(adminSession, 'create_classification_rule', {
      accountId: s.accountA.id,
      pattern,
      direction: 'out',
      categoryId: s.expense.id,
    });
    expect(rowsOf(rule.preview)).toMatchObject({
      Conta: `${s.caixaA.name} · ${s.accountA.name}`,
      'Tipo do padrão': 'Contém',
      Direção: 'Saída',
      Categoria: s.expense.name,
    });
    expect(rule.value).toMatchObject({ financialAccountId: s.accountA.id, caixaId: s.caixaA.id, cardCaixaId: null, origin: 'manual' });
    const ruleId = rule.value.id;
    const listed = (input: Record<string, unknown>) =>
      call(viewerSession, 'list_classification_rules', input).then((r) => (r.value as any[]).map((x) => x.id));
    expect(await listed({ accountId: s.accountA.id })).toContain(ruleId);
    expect(await listed({ accountId: savingsA.id })).not.toContain(ruleId);
    expect(await listed({ caixaId: s.caixaA.id })).toContain(ruleId);

    // Regra de outra caixa: o admin vê; o leitor da caixa A, não.
    const ruleB = await approved(adminSession, 'create_classification_rule', {
      accountId: checkingB.id,
      pattern: `MERCADO ${uid()}`,
      direction: 'out',
      categoryId: s.expense.id,
    });
    expect(await listed({})).not.toContain(ruleB.value.id);
    expect((await call(adminSession, 'list_classification_rules', {})).value.map((r: any) => r.id)).toEqual(
      expect.arrayContaining([ruleId, ruleB.value.id]),
    );
    expect((await call(viewerSession, 'list_classification_rules', { accountId: checkingB.id })).error).toBe('Registro não encontrado.');

    // Copiar para a poupança: a da corrente e a da caixa B entram; a repetida no destino é pulada.
    const already = await admin.post('/api/classification-rules', {
      accountId: savingsA.id,
      pattern: ruleB.value.pattern.toLowerCase(),
      direction: 'out',
      entityId: s.supplier.id,
    });
    const copy = await approved(adminSession, 'copy_classification_rules', {
      ruleIds: [ruleId, ruleB.value.id],
      accountId: savingsA.id,
    });
    expect(copy.preview.summary).toBe(`1 regra(s) para ${s.caixaA.name} · ${savingsA.name}, 1 pulada(s)`);
    expect(rowsOf(copy.preview)).toMatchObject({
      [`${s.caixaA.name} · ${s.accountA.name}`]: `Contém "${pattern}" (saída) → ${s.expense.name}`,
      [`${s.caixaB.name} · ${checkingB.name}`]: `Contém "${ruleB.value.pattern}" (saída): pulada, já existe uma regra igual no destino`,
    });
    expect(copy.value.copied).toHaveLength(1);
    expect(copy.value.copied[0]).toMatchObject({
      financialAccountId: savingsA.id,
      pattern,
      origin: 'copy',
      copiedFromRuleId: ruleId,
      usageCount: 0,
      categoryId: s.expense.id,
    });
    expect(copy.value.skipped).toEqual([
      { ruleId: ruleB.value.id, pattern: ruleB.value.pattern, matchKind: 'contains', reason: 'exists', existingRuleId: already.id },
    ]);
    expect(await auditActor('classification_rules', copy.value.copied[0].id)).toMatchObject({ actor_kind: 'agent' });
    // Leitor: copiar para a conta que só lê é negado.
    expect((await call(viewerSession, 'copy_classification_rules', { ruleIds: [ruleId], accountId: savingsA.id })).error).toBe(
      'Você só tem leitura nesta caixa.',
    );

    const changed = await approved(adminSession, 'update_classification_rule', { ruleId, changes: { priority: 10 } });
    expect(rowsOf(changed.preview).Prioridade).toBe('100 → 10');
    expect((await call(viewerSession, 'update_classification_rule', { ruleId, changes: { priority: 1 } })).error).toBe(
      'Você só tem leitura nesta caixa.',
    );
    expect((await call(viewerSession, 'archive_classification_rule', { ruleId })).error).toBe('Você só tem leitura nesta caixa.');
    const ruleArchived = await approved(adminSession, 'archive_classification_rule', { ruleId });
    expect(rowsOf(ruleArchived.preview)).toMatchObject({ Conta: `${s.caixaA.name} · ${s.accountA.name}` });
    expect(ruleArchived.value).toEqual({ deleted: false, archived: true });

    // Viewer: regra na conta que só lê negada; sem conta (o antigo "global") recusada pelo schema; cofre não tem regra.
    expect(
      (await call(viewerSession, 'create_classification_rule', { accountId: s.accountA.id, pattern: 'X', entityId: s.supplier.id })).error,
    ).toBe('Você só tem leitura nesta caixa.');
    expect((await call(adminSession, 'create_classification_rule', { pattern: 'X', entityId: s.supplier.id })).error).toContain(
      'Informe a conta (corrente ou poupança) ou o cartão da regra',
    );
    expect(
      (await call(adminSession, 'create_classification_rule', { accountId: s.accountB.id, pattern: 'X', entityId: s.supplier.id })).error,
    ).toBe('Regras de classificação são de conta corrente, poupança ou cartão.');

    // /mcp: listar e copiar pelo token do admin (a cópia arquivada fica de fora: pulada com o motivo).
    const token = (await admin.post('/api/account/api-tokens', { name: `MCP regras ${uid()}`, expiresInDays: 1 })).token;
    const mcpClient = new Client({ name: 'teste-f18', version: '1.0.0' });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${await listenOnce()}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const text = (r: Awaited<ReturnType<typeof mcpClient.callTool>>) => (r.content as { text: string }[])[0]!.text;
      const list = await mcpClient.callTool({ name: 'list_classification_rules', arguments: { accountId: savingsA.id } });
      expect(list.isError, text(list)).toBeFalsy();
      expect(JSON.parse(text(list)).map((r: any) => r.pattern)).toEqual(expect.arrayContaining([pattern]));
      const viaMcp = await mcpClient.callTool({
        name: 'copy_classification_rules',
        arguments: { ruleIds: [ruleId, ruleB.value.id], accountId: checkingB.id },
      });
      expect(viaMcp.isError, text(viaMcp)).toBeFalsy();
      expect(JSON.parse(text(viaMcp))).toMatchObject({
        copied: [],
        skipped: [
          { ruleId, reason: 'archived' },
          { ruleId: ruleB.value.id, reason: 'exists', existingRuleId: ruleB.value.id },
        ],
      });
    } finally {
      await mcpClient.close();
    }
  });
});
