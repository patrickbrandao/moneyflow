import { attachments, type Executor, type Tx } from '@moneyflow/db';
import {
  blocksText,
  CONTRACT_MARKDOWN_MAX_BYTES,
  CONTRACT_PERIODICITIES,
  type ContractDocumentDto,
  type ContractDocumentVersionContent,
  type ContractDocumentVersionDto,
  type ContractReadingDto,
  type contractDocumentUpdateInput,
  type contractDocumentUploadQuery,
  type contractMarkdownCreateInput,
  type contractReadingQuery,
  type contractVersionCreateInput,
  isIsoDate,
  normalizeDocument,
  READJUSTMENT_INDEXES,
  t,
} from '@moneyflow/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { extractJson } from '../agents/flows';
import { loadMessages, loadRun } from '../agents/store';
import type { ServiceContext } from '../context';
import { AppError, notFound, unprocessable } from '../errors';
import { flowAgentId, waitRun } from './ai-flows';
import { assertUpload, cleanFileName, storeAttachment } from './attachments';
import { contractReadMode, loadContract } from './contracts';
import { createConversation, sendMessage } from './conversations';
import { newIds } from './title-pair';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Documentos dos contratos (spec 020): PDF (anexo imutável, só leitura) e
 * markdown versionado (cada salvamento é uma versão imutável; o documento
 * aponta para a atual; restaurar cria uma versão nova). Excluir arquiva.
 * A leitura do PDF por IA e a conversão PDF → markdown usam o agente dos
 * fluxos (spec 011), como a leitura de documentos dos títulos.
 */

const E = t.contracts.errors;

/* ---------------- leitura ---------------- */

const DOCUMENT_SELECT = sql`
  d.id, d.contract_id, d.kind, d.format, d.title, d.description, d.document_date, d.attachment_id, a.file_name, a.size_bytes,
  d.current_version_id, v.version AS current_version, v.created_at AS last_edited_at,
  (SELECT count(*)::int FROM contract_document_versions x WHERE x.document_id = d.id) AS version_count,
  d.source_document_id, d.archived_at, d.created_at`;

const DOCUMENT_FROM = sql`
  FROM contract_documents d
  LEFT JOIN attachments a ON a.id = d.attachment_id
  LEFT JOIN contract_document_versions v ON v.id = d.current_version_id`;

function toDocument(row: Record<string, unknown>): ContractDocumentDto & { contractId: string } {
  const r = camel<ContractDocumentDto & { contractId: string }>(row);
  return {
    ...r,
    sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
    currentVersion: r.currentVersion === null ? null : Number(r.currentVersion),
    lastEditedAt: iso(r.lastEditedAt),
    archivedAt: iso(r.archivedAt),
    createdAt: iso(r.createdAt)!,
  };
}

export async function listContractDocuments(db: Executor, contractId: string, archived = false): Promise<ContractDocumentDto[]> {
  const result = await db.execute(sql`
    SELECT ${DOCUMENT_SELECT} ${DOCUMENT_FROM}
     WHERE d.contract_id = ${contractId} AND ${archived ? sql`true` : sql`d.archived_at IS NULL`}
     ORDER BY coalesce(d.document_date, d.created_at::date) DESC, d.created_at DESC`);
  return result.rows.map((row) => {
    const { contractId: _c, ...doc } = toDocument(row);
    return doc;
  });
}

async function loadDocument(db: Executor, id: string, lock = false) {
  const result = await db.execute(
    sql`SELECT ${DOCUMENT_SELECT} ${DOCUMENT_FROM} WHERE d.id = ${id} ${lock ? sql`FOR UPDATE OF d` : sql``}`,
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  return toDocument(row);
}

/** Documento + contrato, conferindo leitura (dono ou espelho) ou escrita (só a caixa dona). */
async function documentAccess(ctx: ServiceContext, documentId: string, write: boolean) {
  const doc = await loadDocument(ctx.db, documentId);
  const contract = await loadContract(ctx.db, doc.contractId);
  if (write) ctx.access.assertWrite(contract.caixaId);
  else await contractReadMode(ctx, contract);
  return { doc, contract };
}

/** Leitura do anexo de um documento de contrato (download do PDF). */
export async function canReadContractDocument(ctx: ServiceContext, documentId: string): Promise<boolean> {
  try {
    await documentAccess(ctx, documentId, false);
    return true;
  } catch {
    return false;
  }
}

export async function getContractDocument(ctx: ServiceContext, id: string): Promise<ContractDocumentDto> {
  const { doc } = await documentAccess(ctx, id, false);
  const { contractId: _c, ...dto } = doc;
  return dto;
}

const VERSION_SELECT = sql`
  v.id, v.document_id, v.version, v.note, v.author_kind, u.username AS author_name, v.ai_run_id, r.version AS restored_from_version,
  octet_length(v.content) AS size_bytes, v.created_at`;

function toVersion(row: Record<string, unknown>): ContractDocumentVersionDto {
  const r = camel<ContractDocumentVersionDto>(row);
  return {
    ...r,
    version: Number(r.version),
    restoredFromVersion: r.restoredFromVersion === null ? null : Number(r.restoredFromVersion),
    sizeBytes: Number(r.sizeBytes),
    createdAt: iso(r.createdAt)!,
  };
}

export async function listVersions(ctx: ServiceContext, documentId: string): Promise<ContractDocumentVersionDto[]> {
  await documentAccess(ctx, documentId, false);
  const result = await ctx.db.execute(sql`
    SELECT ${VERSION_SELECT} FROM contract_document_versions v
      LEFT JOIN users u ON u.id = v.author_user_id
      LEFT JOIN contract_document_versions r ON r.id = v.restored_from_version_id
     WHERE v.document_id = ${documentId}
     ORDER BY v.version DESC`);
  return result.rows.map(toVersion);
}

export async function getVersion(ctx: ServiceContext, documentId: string, versionId: string): Promise<ContractDocumentVersionContent> {
  await documentAccess(ctx, documentId, false);
  const result = await ctx.db.execute(sql`
    SELECT ${VERSION_SELECT}, v.content FROM contract_document_versions v
      LEFT JOIN users u ON u.id = v.author_user_id
      LEFT JOIN contract_document_versions r ON r.id = v.restored_from_version_id
     WHERE v.document_id = ${documentId} AND v.id = ${versionId}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  return { ...toVersion(row), content: String(row.content) };
}

/* ---------------- escrita ---------------- */

type MarkdownSource = { authorKind: 'human' | 'agent'; aiRunId?: string | null; note?: string | null; sourceDocumentId?: string | null };

/** Cria um documento markdown com a versão 1 (o documento aponta para ela; FK checada no COMMIT). */
async function insertMarkdownDocument(
  ctx: ServiceContext,
  tx: Tx,
  contractId: string,
  meta: { kind: string; title: string; documentDate: string | null; description: string | null },
  content: string,
  source: MarkdownSource,
): Promise<string> {
  const [documentId, versionId] = await newIds(tx, 2);
  await tx.execute(sql`
    INSERT INTO contract_documents (id, contract_id, kind, format, title, description, document_date, current_version_id,
                                    source_document_id, created_by)
    VALUES (${documentId}, ${contractId}, ${meta.kind}, 'markdown', ${meta.title}, ${meta.description}, ${meta.documentDate}::date,
            ${versionId}, ${source.sourceDocumentId ?? null}, ${ctx.access.actor.id})`);
  await tx.execute(sql`
    INSERT INTO contract_document_versions (id, document_id, content, note, author_kind, author_user_id, ai_run_id)
    VALUES (${versionId}, ${documentId}, ${content}, ${source.note ?? null}, ${source.authorKind}, ${ctx.access.actor.id},
            ${source.aiRunId ?? null})`);
  return documentId!;
}

const isPdf = (mime: string, content: Buffer, name: string) =>
  mime.startsWith('application/pdf') || content.subarray(0, 5).toString('latin1') === '%PDF-' || /\.pdf$/i.test(name);
const isMarkdown = (mime: string, name: string) => /\.(md|markdown)$/i.test(name) || mime.startsWith('text/markdown');

/** Texto UTF-8 estrito (o .md enviado precisa ser UTF-8), sem BOM. */
function decodeMarkdown(content: Buffer): string {
  if (content.length > CONTRACT_MARKDOWN_MAX_BYTES) throw unprocessable(E.markdownTooLarge, 'markdown_too_large');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^﻿/, '');
  } catch {
    throw unprocessable(E.markdownNotUtf8, 'markdown_not_utf8');
  }
}

const titleFromName = (name: string) =>
  cleanFileName(name)
    .replace(/\.(pdf|md|markdown)$/i, '')
    .slice(0, 200) || name;

/** Upload cru: PDF (somente leitura) ou .md (vira a versão 1). */
export async function uploadContractDocument(
  ctx: ServiceContext,
  contractId: string,
  query: z.output<typeof contractDocumentUploadQuery>,
  file: { mime: string; content: Buffer },
): Promise<ContractDocumentDto> {
  const contract = await loadContract(ctx.db, contractId);
  ctx.access.assertWrite(contract.caixaId);
  const content = assertUpload(file.content);
  const meta = {
    kind: query.kind,
    title: query.title || titleFromName(query.fileName),
    documentDate: query.documentDate ?? null,
    description: query.description || null,
  };
  const pdf = isPdf(file.mime, content, query.fileName);
  if (!pdf && !isMarkdown(file.mime, query.fileName)) throw unprocessable(E.unsupportedFile, 'unsupported_file');
  const id = await withTx(ctx, async (tx) => {
    if (!pdf) return insertMarkdownDocument(ctx, tx, contractId, meta, decodeMarkdown(content), { authorKind: 'human' });
    const attachmentId = await storeAttachment(tx, ctx, { name: query.fileName, mime: 'application/pdf', content });
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO contract_documents (contract_id, kind, format, title, description, document_date, attachment_id, created_by)
      VALUES (${contractId}, ${meta.kind}, 'pdf', ${meta.title}, ${meta.description}, ${meta.documentDate}::date, ${attachmentId},
              ${ctx.access.actor.id})
      RETURNING id`);
    return inserted.rows[0]!.id;
  });
  return getContractDocument(ctx, id);
}

export async function createMarkdownDocument(
  ctx: ServiceContext,
  contractId: string,
  input: z.output<typeof contractMarkdownCreateInput>,
): Promise<ContractDocumentDto> {
  const contract = await loadContract(ctx.db, contractId);
  ctx.access.assertWrite(contract.caixaId);
  const id = await withTx(ctx, (tx) =>
    insertMarkdownDocument(ctx, tx, contractId, input, input.content, { authorKind: 'human', note: input.note }),
  );
  return getContractDocument(ctx, id);
}

export async function updateContractDocument(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof contractDocumentUpdateInput>,
): Promise<ContractDocumentDto> {
  await documentAccess(ctx, id, true);
  const sets: SQL[] = [];
  if (input.kind !== undefined) sets.push(sql`kind = ${input.kind}`);
  if (input.title !== undefined) sets.push(sql`title = ${input.title}`);
  if (input.documentDate !== undefined) sets.push(sql`document_date = ${input.documentDate}::date`);
  if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
  if (sets.length > 0)
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE contract_documents SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`));
  return getContractDocument(ctx, id);
}

/** Excluir só arquiva (some da lista, fica no histórico). */
export async function archiveContractDocument(ctx: ServiceContext, id: string, restore = false): Promise<ContractDocumentDto> {
  await documentAccess(ctx, id, true);
  await withTx(ctx, (tx) => tx.execute(sql`UPDATE contract_documents SET archived_at = ${restore ? null : sql`now()`} WHERE id = ${id}`));
  return getContractDocument(ctx, id);
}

async function appendVersion(
  ctx: ServiceContext,
  tx: Tx,
  documentId: string,
  content: string,
  extra: { note: string | null; restoredFrom?: string | null },
): Promise<number> {
  const inserted = await tx.execute<{ id: string; version: number }>(sql`
    INSERT INTO contract_document_versions (document_id, content, note, author_kind, author_user_id, restored_from_version_id)
    VALUES (${documentId}, ${content}, ${extra.note}, ${ctx.actorKind ?? 'human'}, ${ctx.access.actor.id}, ${extra.restoredFrom ?? null})
    RETURNING id, version`);
  const row = inserted.rows[0]!;
  await tx.execute(sql`UPDATE contract_documents SET current_version_id = ${row.id} WHERE id = ${documentId}`);
  return Number(row.version);
}

async function currentContent(tx: Executor, documentId: string): Promise<string | null> {
  const result = await tx.execute<{ content: string }>(sql`
    SELECT v.content FROM contract_documents d JOIN contract_document_versions v ON v.id = d.current_version_id WHERE d.id = ${documentId}`);
  return result.rows[0]?.content ?? null;
}

export async function saveVersion(
  ctx: ServiceContext,
  documentId: string,
  input: z.output<typeof contractVersionCreateInput>,
): Promise<{ version: number; document: ContractDocumentDto }> {
  const { doc } = await documentAccess(ctx, documentId, true);
  if (doc.format !== 'markdown') throw unprocessable(E.notMarkdown, 'not_markdown');
  const version = await withTx(ctx, async (tx) => {
    await loadDocument(tx, documentId, true);
    if ((await currentContent(tx, documentId)) === input.content) throw unprocessable(t.contracts.documents.noChanges, 'no_changes');
    return appendVersion(ctx, tx, documentId, input.content, { note: input.note });
  });
  return { version, document: await getContractDocument(ctx, documentId) };
}

/** Restaurar = nova versão com o conteúdo antigo (nada é apagado). */
export async function restoreVersion(
  ctx: ServiceContext,
  documentId: string,
  versionId: string,
): Promise<{ version: number; document: ContractDocumentDto }> {
  const { doc } = await documentAccess(ctx, documentId, true);
  if (doc.format !== 'markdown') throw unprocessable(E.notMarkdown, 'not_markdown');
  const version = await withTx(ctx, async (tx) => {
    await loadDocument(tx, documentId, true);
    const old = await tx.execute<{ content: string; version: number }>(
      sql`SELECT content, version FROM contract_document_versions WHERE id = ${versionId} AND document_id = ${documentId}`,
    );
    const row = old.rows[0];
    if (!row) throw notFound();
    return appendVersion(ctx, tx, documentId, row.content, {
      note: t.contracts.documents.restoredFrom(Number(row.version)),
      restoredFrom: versionId,
    });
  });
  return { version, document: await getContractDocument(ctx, documentId) };
}

/* ---------------- IA: leitura do contrato e PDF → markdown ---------------- */

/** Abre a conversa arquivada do fluxo, envia o arquivo e espera a execução (até AI_DOCUMENT_TIMEOUT_MS). */
async function runFlow(
  ctx: ServiceContext,
  purpose: 'contract_reading' | 'contract_markdown',
  file: { name: string; content: Buffer },
  text: string,
  failure: string,
) {
  const agentId = await flowAgentId(ctx);
  if (!agentId) throw new AppError(501, 'document_reader_unavailable', t.errors.documentReaderUnavailable);
  const conversation = await createConversation(
    ctx,
    { agentId, title: t.agents.flows.documentConversation(file.name).slice(0, 200) },
    { purpose, screenContext: { fileName: file.name }, archived: true },
  );
  const attachmentId = await withTx(ctx, (tx) =>
    storeAttachment(tx, ctx, { name: file.name, mime: 'application/pdf', content: file.content }),
  );
  const sent = await sendMessage(ctx, conversation.id, { text, attachmentIds: [attachmentId] });
  const run = await waitRun(ctx.db, sent.run.id, ctx.config.aiDocumentTimeoutMs);
  if (run?.status !== 'completed') {
    throw new AppError(422, 'document_unreadable', run?.status === 'failed' && run.error ? run.error : failure);
  }
  const messages = await loadMessages(ctx.db, conversation.id);
  const answer = [...messages].reverse().find((m) => m.role === 'assistant');
  return { text: answer ? blocksText(answer.content) : '', runId: sent.run.id, conversationId: conversation.id };
}

const str = (value: unknown, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const int = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => (list.includes(value as T) ? (value as T) : null);
const date = (value: unknown) => (typeof value === 'string' && isIsoDate(value) ? value : null);

/** POST /api/contracts/document: sugere os campos do contrato a partir do PDF (nada é gravado além da conversa do fluxo). */
export async function readContractWithAi(
  ctx: ServiceContext,
  query: z.output<typeof contractReadingQuery>,
  file: { content: Buffer },
): Promise<ContractReadingDto> {
  const content = assertUpload(file.content);
  let holder: string | null = null;
  if (query.caixaId) {
    ctx.access.assertRead(query.caixaId);
    const result = await ctx.db.execute<{ name: string; document: string | null }>(sql`
      SELECT e.name, e.document FROM caixas c JOIN entities e ON e.id = c.holder_entity_id WHERE c.id = ${query.caixaId}`);
    const row = result.rows[0];
    if (row) holder = `${row.name}${row.document ? ` (${row.document})` : ''}`;
  }
  const flow = await runFlow(
    ctx,
    'contract_reading',
    { name: query.fileName, content },
    `Leia o contrato anexo e devolva o JSON pedido.${holder ? ` O titular da caixa (nós) é: ${holder}.` : ''}`,
    E.documentUnreadable,
  );
  const data = (extractJson(flow.text) ?? {}) as Record<string, unknown>;
  const document = typeof data.counterpartyDocument === 'string' ? normalizeDocument(data.counterpartyDocument) : null;
  const reading: ContractReadingDto = {
    entityId: null,
    entityName: str(data.counterpartyName, 200),
    document: document || null,
    direction: oneOf(['receivable', 'payable'] as const, data.direction),
    name: str(data.name, 200),
    contractNumber: str(data.contractNumber, 60),
    startsOn: date(data.startsOn),
    durationMonths: int(data.durationMonths, 1, 120),
    totalCents: int(data.totalCents, 1, Number.MAX_SAFE_INTEGER),
    installmentCents: int(data.installmentCents, 1, Number.MAX_SAFE_INTEGER),
    periodicity: oneOf(CONTRACT_PERIODICITIES, data.periodicity),
    dueDay: int(data.dueDay, 1, 31),
    autoRenew: typeof data.autoRenew === 'boolean' ? data.autoRenew : null,
    noticeDays: int(data.noticeDays, 0, 365),
    readjustmentIndex: oneOf(READJUSTMENT_INDEXES, data.readjustmentIndex),
    readjustmentBaseDate: date(data.readjustmentBaseDate),
    terminationPenaltyText: str(data.terminationPenalty, 2000),
    conversationId: flow.conversationId,
  };
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

/** Tira cercas de código que o modelo às vezes põe em volta do markdown. */
export function stripFences(text: string): string {
  const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

/** Gera um documento markdown a partir de um PDF do contrato (versão 1 com autor = agente, apontando para o PDF). */
export async function convertPdfToMarkdown(ctx: ServiceContext, documentId: string): Promise<ContractDocumentDto> {
  const { doc, contract } = await documentAccess(ctx, documentId, true);
  if (doc.format !== 'pdf' || !doc.attachmentId) throw unprocessable(E.notPdf, 'not_pdf');
  const [file] = await ctx.db.select().from(attachments).where(eq(attachments.id, doc.attachmentId));
  if (!file) throw notFound();
  const flow = await runFlow(
    ctx,
    'contract_markdown',
    { name: file.fileName, content: Buffer.from(file.content as Uint8Array) },
    'Converta o contrato anexo em markdown.',
    E.conversionFailed,
  );
  const markdown = stripFences(flow.text);
  if (!markdown) throw new AppError(422, 'document_unreadable', E.conversionFailed);
  const content =
    Buffer.byteLength(markdown, 'utf8') > CONTRACT_MARKDOWN_MAX_BYTES ? markdown.slice(0, CONTRACT_MARKDOWN_MAX_BYTES / 4) : markdown;
  const run = await loadRun(ctx.db, flow.runId);
  const id = await withTx(ctx, (tx) =>
    insertMarkdownDocument(
      ctx,
      tx,
      contract.id,
      { kind: doc.kind, title: doc.title, documentDate: doc.documentDate, description: doc.description },
      content,
      { authorKind: 'agent', aiRunId: run?.id ?? null, note: t.contracts.documents.fromPdf(file.fileName), sourceDocumentId: doc.id },
    ),
  );
  return getContractDocument(ctx, id);
}
