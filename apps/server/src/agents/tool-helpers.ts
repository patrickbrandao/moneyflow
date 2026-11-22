import type { AgentToolDef, AgentToolInput, AgentToolName, PreviewRow, ToolPreview } from '@moneyflow/shared';
import { formatBRL, formatDate, previewValue, t } from '@moneyflow/shared';
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
  /** O "parar" da execução (tarefa 097): a tool MCP é abortada; um handler longo pode respeitá-lo. */
  signal?: AbortSignal;
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

/* ---------------- páginas das listas (tarefa 101) ---------------- */

/** Tira os campos nulos de uma linha (cabem mais itens por página no limite do resultado). */
export const withoutNulls = <T extends object>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as Partial<T>;

/**
 * Uma página de lista para o modelo: o serviço buscou `limit + 1` a partir de `offset`; o item a mais só diz
 * que há outra página (`nextOffset`; null = acabou).
 */
export function listPage<T>(rows: T[], i: { limit: number; offset: number }) {
  return { items: rows.slice(0, i.limit), offset: i.offset, nextOffset: rows.length > i.limit ? i.offset + i.limit : null };
}

/* ---------------- peças das prévias (tarefa 155: uma cópia só) ---------------- */

/** Lista curta para uma linha do cartão: até `max` itens e "e mais N". */
export const listed = (items: string[], max = 12) =>
  items.length > max ? `${items.slice(0, max).join(', ')} e mais ${items.length - max}` : items.join(', ') || '—';

export const yesNo = (v: boolean) => (v ? 'Sim' : 'Não');

/** Nome do agente e se ele tem kit (as prévias de tarefas e receitas); 404 se não existe. */
export async function agentSummary(ctx: ServiceContext, id: string): Promise<{ name: string; hasKit: boolean }> {
  const r = await ctx.db.execute<{ name: string; has_kit: boolean }>(
    sql`SELECT name, tool_kit_id IS NOT NULL AS has_kit FROM ai_agents WHERE id = ${id}`,
  );
  const row = r.rows[0];
  if (!row) throw notFound(t.agents.errors.agentNotFound);
  return { name: row.name, hasKit: row.has_kit };
}

/** Linha do extrato no cartão: data, descrição e valor (dd/mm/aaaa e R$, como o resto do cartão). */
export const lineLabel = (l: { postedOn: string; description: string; amountCents: number }) =>
  `${formatDate(l.postedOn)} · ${l.description} · ${formatBRL(l.amountCents)}`;

/** A linha do extrato da prévia, com a escrita conferida na caixa dela (conta ou cartão). */
export async function lineCaixa(ctx: ServiceContext, lineId: string) {
  const r = await ctx.db.execute<{ caixa_id: string; description: string; amount_cents: string | number; posted_on: string }>(sql`
    SELECT coalesce(a.caixa_id, l.card_caixa_id) AS caixa_id, l.description, l.amount_cents, l.posted_on
      FROM statement_lines l LEFT JOIN financial_accounts a ON a.id = l.financial_account_id WHERE l.id = ${lineId}`);
  const row = r.rows[0];
  if (!row) throw notFound();
  ctx.access.assertWrite(row.caixa_id);
  return { caixaId: row.caixa_id, description: row.description, amountCents: Number(row.amount_cents), postedOn: row.posted_on };
}

/** Prévia de lote: até 50 linhas no cartão, o resto avisado. */
export const PREVIEW_LINES = 50;
export const moreLines = (total: number, shown = PREVIEW_LINES) =>
  total > shown ? [`E mais ${total - shown} linha(s) não mostradas.`] : [];

/**
 * As linhas de um lote para o cartão (confirmar, ignorar, voltar, aprovar): todas conferidas (escrita na caixa
 * de cada uma), as primeiras `PREVIEW_LINES` mostradas e o aviso das demais.
 */
export async function linesPreview(
  ctx: ServiceContext,
  lineIds: string[],
  after: (lineId: string, index: number) => Promise<string> | string = () => '',
): Promise<{ rows: PreviewRow[]; warnings: string[] }> {
  const rows: PreviewRow[] = [];
  for (const [index, lineId] of lineIds.entries()) {
    const line = await lineCaixa(ctx, lineId);
    if (index < PREVIEW_LINES) {
      const text = await after(lineId, index);
      rows.push(text ? { label: lineLabel(line), after: text } : { label: 'Linha', after: lineLabel(line) });
    }
  }
  return { rows, warnings: moreLines(lineIds.length) };
}

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

/** Ids da entrada que viram nome na prévia genérica (respeitando a permissão). */
const INPUT_NAMES: Record<string, NameKind> = {
  caixaId: 'caixa',
  cardCaixaId: 'caixa',
  payerCaixaId: 'caixa',
  entityId: 'entity',
  categoryId: 'category',
  accountId: 'account',
  financialAccountId: 'account',
};

/**
 * Prévia de uma tool interna sem prévia própria (tarefa 157), como a das tools MCP: uma linha por argumento
 * preenchido, com os ids simples trocados por nomes, centavos em R$ e datas em dd/mm/aaaa; a leitura diz que
 * não grava, e a que fala com um serviço externo (`external`) avisa.
 */
export async function inputPreview(ctx: ServiceContext, def: AgentToolDef, input: unknown): Promise<ToolPreview> {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const values = await withNames(ctx, raw, INPUT_NAMES);
  const format = (key: string) => (/Cents$/.test(key) ? 'money' : /(Date|On)$|^(from|to)$/.test(key) ? 'date' : undefined);
  const rows = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => ({ label: key, after: previewValue(value, format(key)) }));
  return {
    title: def.title,
    summary: def.kind === 'read' ? t.agents.inputPreview.read : '',
    action: 'other',
    rows,
    warnings: def.external ? [t.agents.inputPreview.external] : [],
  };
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
