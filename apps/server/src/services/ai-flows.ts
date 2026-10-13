import type { Executor } from '@moneyflow/db';
import {
  blocksText,
  type ClassificationSuggestResult,
  type DocumentReadingDto,
  formatBRL,
  isIsoDate,
  normalizeDocument,
  parseBoleto,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { extractJson } from '../agents/flows';
import { loadMessages, loadRun } from '../agents/store';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { assertUpload, storeAttachment } from './attachments';
import { createConversation, sendMessage } from './conversations';
import { getImport } from './statements';
import { withTx } from './tx';

/*
 * IA nos fluxos (specs 009, 010, 011): cada uso abre uma conversa arquivada
 * (marcada em ai_conversations.purpose, fora da lista de conversas) com o
 * "agente dos fluxos" — o de AI_FLOW_AGENT ou o primeiro ativo — e enfileira
 * uma execução normal no worker (credenciais pelo banco, uso e custo medidos,
 * auditoria como agente).
 */

/** Agente dos fluxos: AI_FLOW_AGENT (nome) ou o primeiro ativo com provedor ativo. */
export async function flowAgentId(ctx: ServiceContext): Promise<string | null> {
  const result = await ctx.db.execute<{ id: string }>(sql`
    SELECT a.id FROM ai_agents a JOIN ai_providers p ON p.id = a.provider_id
     WHERE a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL
       ${ctx.config.aiFlowAgent ? sql`AND lower(a.name) = lower(${ctx.config.aiFlowAgent})` : sql``}
     ORDER BY a.created_at, a.id LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

export async function waitRun(db: Executor, runId: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await loadRun(db, runId);
    if (!run) return null;
    if (['completed', 'failed', 'canceled'].includes(run.status)) return run;
    if (Date.now() > until) return run;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

const digits = (value: unknown) => (typeof value === 'string' ? value.replace(/\D/g, '') : '');
const text = (value: unknown, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** Leitura de PDF/imagem (boleto, nota, comprovante) para pré-preencher o título (spec 010). */
export async function readDocumentWithAi(
  ctx: ServiceContext,
  file: { name: string; mime: string; content: Buffer },
): Promise<DocumentReadingDto> {
  const agentId = await flowAgentId(ctx);
  if (!agentId) throw new AppError(501, 'document_reader_unavailable', t.errors.documentReaderUnavailable);
  const content = assertUpload(file.content);
  const conversation = await createConversation(
    ctx,
    { agentId, title: t.agents.flows.documentConversation(file.name).slice(0, 200) },
    { purpose: 'document_reading', screenContext: { fileName: file.name }, archived: true },
  );
  const attachmentId = await withTx(ctx, (tx) => storeAttachment(tx, ctx, { name: file.name, mime: file.mime, content }));
  const sent = await sendMessage(ctx, conversation.id, {
    text: 'Leia o documento anexo e devolva o JSON pedido.',
    attachmentIds: [attachmentId],
  });
  const run = await waitRun(ctx.db, sent.run.id, ctx.config.aiDocumentTimeoutMs);
  if (run?.status !== 'completed') {
    throw new AppError(422, 'document_unreadable', run?.status === 'failed' && run.error ? run.error : t.agents.errors.documentUnreadable);
  }
  const messages = await loadMessages(ctx.db, conversation.id);
  const answer = [...messages].reverse().find((m) => m.role === 'assistant');
  const data = (extractJson(answer ? blocksText(answer.content) : '') ?? {}) as Record<string, unknown>;

  const reading: DocumentReadingDto = {
    kind: ['boleto', 'invoice', 'receipt'].includes(String(data.kind)) ? (data.kind as DocumentReadingDto['kind']) : 'unknown',
    entityName: text(data.entityName, 200),
    document: digits(data.document) ? normalizeDocument(String(data.document)) : null,
    amountCents: Number.isInteger(data.amountCents) && (data.amountCents as number) > 0 ? (data.amountCents as number) : null,
    dueDate: typeof data.dueDate === 'string' && isIsoDate(data.dueDate) ? data.dueDate : null,
    boletoLine: digits(data.boletoLine).length >= 44 ? digits(data.boletoLine) : null,
    pixPayload: text(data.pixPayload, 512),
    description: text(data.description, 300),
    entityId: null,
    conversationId: conversation.id,
  };
  // A linha digitável manda no valor e no vencimento quando é válida.
  if (reading.boletoLine) {
    const boleto = parseBoleto(reading.boletoLine);
    if (boleto.ok) {
      reading.amountCents = boleto.amountCents ?? reading.amountCents;
      reading.dueDate = boleto.dueDate ?? reading.dueDate;
    } else reading.boletoLine = null;
  }
  if (reading.document) {
    const entity = await ctx.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM entities WHERE document = ${reading.document} AND archived_at IS NULL LIMIT 1`,
    );
    if (entity.rows[0]) {
      reading.entityId = entity.rows[0].id;
      reading.entityName = reading.entityName ?? entity.rows[0].name;
    }
  }
  return reading;
}

/**
 * Sugestões do agente para as linhas novas sem classificação de um import
 * (spec 009): enfileira a execução; as sugestões chegam como "sugerido pelo
 * agente" e esperam a aprovação em lote. `auto` (logo após importar) não falha.
 */
export async function suggestImportClassifications(
  ctx: ServiceContext,
  importId: string,
  opts: { auto?: boolean } = {},
): Promise<ClassificationSuggestResult> {
  const detail = await getImport(ctx, importId);
  if (!detail.canWrite) {
    if (opts.auto) return { queued: false, runId: null, lines: 0 };
    ctx.access.assertWrite(detail.caixaId);
  }
  const lines = detail.lines.filter((l) => l.status === 'new' && l.classificationSource === null).slice(0, 150);
  if (lines.length === 0) return { queued: false, runId: null, lines: 0 };
  const agentId = await flowAgentId(ctx);
  if (!agentId) {
    if (opts.auto) return { queued: false, runId: null, lines: lines.length };
    throw new AppError(501, 'ai_unavailable', t.agents.errors.providerMissing);
  }

  const lineIds = lines.map((l) => l.id);
  const candidates = await ctx.db.execute<{ line_id: string; entity_id: string; name: string }>(sql`
    SELECT l.id AS line_id, e.id AS entity_id, e.name
      FROM statement_lines l
      CROSS JOIN LATERAL (
        SELECT x.id, x.name FROM entities x WHERE x.archived_at IS NULL
         ORDER BY greatest(word_similarity(x.name, l.description), word_similarity(coalesce(x.trade_name, ''), l.description)) DESC
         LIMIT 5) e
     WHERE l.id = ANY (${`{${lineIds.join(',')}}`}::uuid[])`);
  const categories = await ctx.db.execute<{ id: string; name: string; kind: string }>(
    sql`SELECT id, name, kind FROM categories WHERE archived_at IS NULL ORDER BY kind, name`,
  );
  const isCard = Boolean(detail.cardCaixaId);
  const payload = {
    lines: lines.map((l) => ({
      lineId: l.id,
      date: l.postedOn,
      amount: formatBRL(l.amountCents),
      description: l.description,
      categoryKind: isCard || l.amountCents < 0 ? 'expense' : 'income',
      entityCandidates: candidates.rows.filter((c) => c.line_id === l.id).map((c) => ({ id: c.entity_id, name: c.name })),
    })),
    categories: categories.rows,
  };
  const conversation = await createConversation(
    ctx,
    { agentId, title: t.agents.flows.classifyConversation(detail.fileName).slice(0, 200) },
    { purpose: 'classify_lines', screenContext: { importId, lineIds }, archived: true },
  );
  const sent = await sendMessage(ctx, conversation.id, {
    text: `Sugira a classificação destas linhas do extrato ${detail.fileName}:\n${JSON.stringify(payload)}`,
    attachmentIds: [],
  });
  return { queued: true, runId: sent.run.id, lines: lines.length };
}
