import type { AgentToolInput, AgentToolName, ToolPreview } from '@moneyflow/shared';
import { t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { assertReadable } from '../services/attachments';

/*
 * Peças comuns dos executores das tools (tool-handlers.ts e
 * tool-handlers-operation.ts): os tipos dos handlers, os nomes legíveis das
 * prévias (respeitando a permissão) e o anexo usado como entrada (spec 027).
 */

export type ToolCallMeta = {
  toolUseId: string;
  runId: string | null;
  /**
   * Segredos digitados no cartão de aprovação (spec 027), só nas tools com
   * `secrets`: chave = `secretFields[].key` da prévia. Chegam da requisição de
   * decisão, em memória, e nunca são gravados nem devolvidos.
   */
  secrets?: Readonly<Record<string, string>>;
};

/**
 * Arquivo gerado por uma tool (`producesFile`, spec 027): o handler devolve
 * `{ file, ...resto }`; o runtime grava o anexo, liga-o à mensagem da tool na
 * sessão e entrega ao modelo só id, nome, tipo e tamanho.
 */
export type GeneratedFile = { fileName: string; mime: string; content: Buffer };

export type Handler<N extends AgentToolName> = {
  run: (ctx: ServiceContext, input: AgentToolInput<N>, meta: ToolCallMeta) => Promise<unknown>;
  preview?: (ctx: ServiceContext, input: AgentToolInput<N>) => Promise<ToolPreview>;
};

export type Handlers<N extends AgentToolName = AgentToolName> = { [K in N]: Handler<K> };

/* ---------------- nomes para as prévias (respeitando a permissão) ---------------- */

export type NameKind = 'entity' | 'caixa' | 'category' | 'account';

export async function nameOf(ctx: ServiceContext, kind: NameKind, id: string | null | undefined) {
  if (!id) return null;
  if (kind === 'entity') {
    const r = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM entities WHERE id = ${id}`);
    return r.rows[0]?.name ?? id;
  }
  if (kind === 'category') {
    const r = await ctx.db.execute<{ name: string; kind: string }>(sql`SELECT name, kind FROM categories WHERE id = ${id}`);
    return r.rows[0]?.name ?? id;
  }
  if (kind === 'caixa') {
    if (!ctx.access.canRead(id)) return id;
    const r = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM caixas WHERE id = ${id}`);
    return r.rows[0]?.name ?? id;
  }
  const r = await ctx.db.execute<{ name: string; caixa_id: string; caixa_name: string }>(
    sql`SELECT a.name, a.caixa_id, c.name AS caixa_name FROM financial_accounts a JOIN caixas c ON c.id = a.caixa_id WHERE a.id = ${id}`,
  );
  const row = r.rows[0];
  if (!row || !ctx.access.canRead(row.caixa_id)) return id;
  return `${row.name} (${row.caixa_name})`;
}

export const named = (ctx: ServiceContext, kind: NameKind) => async (value: unknown) => (await nameOf(ctx, kind, value as string)) ?? '';

/** Troca ids por nomes antes do diff (os campos de nome viram texto). */
export async function withNames(ctx: ServiceContext, values: Record<string, unknown>, map: Record<string, NameKind>) {
  const out = { ...values };
  for (const [key, kind] of Object.entries(map)) {
    if (out[key] !== undefined && out[key] !== null) out[key] = await named(ctx, kind)(out[key]);
  }
  return out;
}

/* ---------------- anexo como entrada (spec 027) ---------------- */

export type ToolFile = { id: string; fileName: string; mime: string; sizeBytes: number; content: Buffer };

/**
 * Anexo usado como entrada de uma tool (importação, anexar). Numa execução,
 * só um anexo de mensagem da sessão da execução (a conversa do run); no /mcp
 * (sem sessão), qualquer anexo que o dono do token lê.
 */
export async function toolAttachment(ctx: ServiceContext, attachmentId: string): Promise<ToolFile> {
  if (ctx.agentRunId) {
    const inSession = await ctx.db.execute(sql`
      SELECT 1 FROM ai_message_attachments ma
        JOIN ai_messages m ON m.id = ma.message_id
        JOIN ai_runs r ON r.conversation_id = m.conversation_id
       WHERE ma.attachment_id = ${attachmentId} AND r.id = ${ctx.agentRunId}
       LIMIT 1`);
    if (inSession.rows.length === 0) throw unprocessable(t.agents.errors.attachmentNotInSession, 'attachment_not_in_session');
  } else {
    await assertReadable(ctx, attachmentId);
  }
  const result = await ctx.db.execute<{ id: string; file_name: string; mime_type: string; size_bytes: number; content: Buffer }>(
    sql`SELECT id, file_name, mime_type, size_bytes, content FROM attachments WHERE id = ${attachmentId}`,
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  return {
    id: row.id,
    fileName: row.file_name,
    mime: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    content: Buffer.from(row.content),
  };
}
