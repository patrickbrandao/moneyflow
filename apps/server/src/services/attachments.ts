import {
  attachments,
  cardPurchaseAttachments,
  type Executor,
  entityAttachments,
  movementAttachments,
  settlementAttachments,
  type Tx,
  titleAttachments,
} from '@moneyflow/db';
import { type AttachmentRow, type AttachmentTarget, t } from '@moneyflow/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { canReadContractDocument } from './contract-documents';
import { withTx } from './tx';
import { camel } from './util';

/*
 * Anexos (specs 005, 008, 009, 010): o arquivo fica no Postgres (bytea, até
 * 20 MB) e se liga a títulos, baixas, movimentos, compras e entidades. O
 * arquivo de um import de extrato e o XML da NF-e são referenciados direto.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const LINKS = {
  title: { table: titleAttachments, column: titleAttachments.titleId, sqlTable: 'title_attachments', sqlColumn: 'title_id' },
  settlement: {
    table: settlementAttachments,
    column: settlementAttachments.settlementId,
    sqlTable: 'settlement_attachments',
    sqlColumn: 'settlement_id',
  },
  movement: {
    table: movementAttachments,
    column: movementAttachments.movementId,
    sqlTable: 'movement_attachments',
    sqlColumn: 'movement_id',
  },
  card_purchase: {
    table: cardPurchaseAttachments,
    column: cardPurchaseAttachments.cardPurchaseId,
    sqlTable: 'card_purchase_attachments',
    sqlColumn: 'card_purchase_id',
  },
  entity: { table: entityAttachments, column: entityAttachments.entityId, sqlTable: 'entity_attachments', sqlColumn: 'entity_id' },
} as const;

/** Caixa dona do alvo (null = entidade, cadastro global). */
async function targetCaixa(db: Executor, target: AttachmentTarget | 'statement_import' | 'nfe_document', id: string) {
  const query = {
    title: sql`SELECT caixa_id FROM titles WHERE id = ${id}`,
    settlement: sql`SELECT t.caixa_id FROM settlements s JOIN titles t ON t.id = s.title_id WHERE s.id = ${id}`,
    movement: sql`SELECT a.caixa_id FROM movements m JOIN financial_accounts a ON a.id = m.financial_account_id WHERE m.id = ${id}`,
    card_purchase: sql`SELECT card_caixa_id AS caixa_id FROM card_purchases WHERE id = ${id}`,
    entity: sql`SELECT NULL::uuid AS caixa_id FROM entities WHERE id = ${id}`,
    statement_import: sql`SELECT coalesce(a.caixa_id, i.card_caixa_id) AS caixa_id
      FROM statement_imports i LEFT JOIN financial_accounts a ON a.id = i.financial_account_id WHERE i.id = ${id}`,
    nfe_document: sql`SELECT NULL::uuid AS caixa_id FROM nfe_documents WHERE id = ${id}`,
  }[target];
  const result = await db.execute<{ caixa_id: string | null }>(query);
  const row = result.rows[0];
  if (!row) throw notFound();
  return row.caixa_id;
}

async function assertTarget(ctx: ServiceContext, target: AttachmentTarget, id: string, write: boolean) {
  const caixaId = await targetCaixa(ctx.db, target, id);
  if (caixaId === null) {
    if (write) ctx.access.assertRegistryWrite();
    return;
  }
  if (write) ctx.access.assertWrite(caixaId);
  else ctx.access.assertRead(caixaId);
}

const rowSql = sql`
  SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.sha256, u.username AS uploaded_by, a.created_at
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by_user_id`;

function toRow(row: Record<string, unknown>): AttachmentRow {
  const r = camel<AttachmentRow & { createdAt: Date | string }>(row);
  return { ...r, createdAt: new Date(r.createdAt).toISOString() };
}

/** Tipo MIME aceito pelo banco (minúsculo, sem parâmetros). */
export function cleanMime(value: string | undefined): string {
  const mime = (value ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : 'application/octet-stream';
}

/** Nome de arquivo sem caminho nem caracteres de controle. */
export function cleanFileName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? 'arquivo';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove caracteres de controle do nome
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'arquivo').slice(0, 255);
}

export function assertUpload(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.length === 0) throw unprocessable(t.errors.attachmentEmpty, 'attachment_empty');
  if (body.length > MAX_ATTACHMENT_BYTES) throw unprocessable(t.errors.attachmentTooLarge, 'attachment_too_large');
  return body;
}

/** Grava o arquivo (dentro de uma transação aberta) e devolve o id. */
export async function storeAttachment(
  tx: Tx,
  ctx: ServiceContext,
  file: { name: string; mime: string; content: Buffer; durationMs?: number | null; pageCount?: number | null },
) {
  const [row] = await tx
    .insert(attachments)
    .values({
      fileName: cleanFileName(file.name),
      mimeType: cleanMime(file.mime),
      content: file.content,
      uploadedByUserId: ctx.access.actor.id,
      // Spec 025: duração do áudio e páginas do PDF (o banco confere o tipo).
      durationMs: file.durationMs ?? null,
      pageCount: file.pageCount ?? null,
    })
    .returning({ id: attachments.id });
  return row!.id;
}

export async function linkAttachment(tx: Tx, target: AttachmentTarget, targetId: string, attachmentId: string) {
  const link = LINKS[target];
  await tx.execute(
    sql`INSERT INTO ${sql.identifier(link.sqlTable)} (${sql.identifier(link.sqlColumn)}, attachment_id) VALUES (${targetId}, ${attachmentId})
        ON CONFLICT DO NOTHING`,
  );
}

export async function uploadAttachment(
  ctx: ServiceContext,
  query: { target: AttachmentTarget; targetId: string; fileName: string },
  file: { mime: string; content: Buffer },
): Promise<AttachmentRow> {
  await assertTarget(ctx, query.target, query.targetId, true);
  const id = await withTx(ctx, async (tx) => {
    const attachmentId = await storeAttachment(tx, ctx, { name: query.fileName, ...file });
    await linkAttachment(tx, query.target, query.targetId, attachmentId);
    return attachmentId;
  });
  const result = await ctx.db.execute(sql`${rowSql} WHERE a.id = ${id}`);
  return toRow(result.rows[0]!);
}

export async function listAttachments(
  ctx: ServiceContext,
  query: { target: AttachmentTarget; targetId: string },
): Promise<AttachmentRow[]> {
  await assertTarget(ctx, query.target, query.targetId, false);
  const link = LINKS[query.target];
  const result = await ctx.db.execute(sql`${rowSql}
    JOIN ${sql.identifier(link.sqlTable)} l ON l.attachment_id = a.id
   WHERE l.${sql.identifier(link.sqlColumn)} = ${query.targetId}
   ORDER BY a.created_at`);
  return result.rows.map(toRow);
}

/** O anexo é legível se algum alvo dele for legível. */
export async function assertReadable(ctx: ServiceContext, attachmentId: string) {
  const links = await ctx.db.execute<{ target_kind: string; target_id: string }>(
    sql`SELECT target_kind, target_id FROM attachment_links WHERE attachment_id = ${attachmentId}`,
  );
  for (const link of links.rows) {
    if (link.target_kind === 'contract_document') {
      // PDF de contrato: quem lê o contrato (caixa dona ou, pelo espelho, a da contraparte).
      if (await canReadContractDocument(ctx, link.target_id)) return;
      continue;
    }
    if (link.target_kind === 'ai_message' || link.target_kind === 'ai_message_speech') {
      // Anexo de mensagem de agente (ou o áudio gerado dela, spec 025): o dono da conversa (e o admin, que lê todas).
      if (ctx.access.isAdmin) return;
      const owner = await ctx.db.execute<{ user_id: string }>(
        sql`SELECT c.user_id FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id WHERE m.id = ${link.target_id}`,
      );
      if (owner.rows[0]?.user_id === ctx.access.actor.id) return;
      continue;
    }
    const caixaId = await targetCaixa(ctx.db, link.target_kind as AttachmentTarget, link.target_id).catch(() => undefined);
    if (caixaId === null || (caixaId && ctx.access.canRead(caixaId))) return;
  }
  // Órfão (acabou de ser enviado por quem o vê) ou sem acesso.
  const [own] = await ctx.db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.uploadedByUserId, ctx.access.actor.id)));
  if (links.rows.length === 0 && own) return;
  if (!ctx.access.isAdmin) throw notFound();
}

export async function downloadAttachment(ctx: ServiceContext, id: string) {
  await assertReadable(ctx, id);
  const [row] = await ctx.db.select().from(attachments).where(eq(attachments.id, id));
  if (!row) throw notFound();
  return row;
}

/** Desliga o anexo do alvo; sem outras ligações, o arquivo é apagado. */
export async function unlinkAttachment(ctx: ServiceContext, id: string, query: { target: AttachmentTarget; targetId: string }) {
  await assertTarget(ctx, query.target, query.targetId, true);
  const link = LINKS[query.target];
  await withTx(ctx, async (tx) => {
    const removed = await tx.delete(link.table).where(and(eq(link.column, query.targetId), eq(link.table.attachmentId, id)));
    if (!removed.rowCount) throw notFound();
    const rest = await tx.execute(sql`SELECT 1 FROM attachment_links WHERE attachment_id = ${id} LIMIT 1`);
    if (rest.rows.length === 0) await tx.delete(attachments).where(eq(attachments.id, id));
  });
  return { deleted: true, archived: false };
}
