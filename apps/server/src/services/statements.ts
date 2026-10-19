import { createHash } from 'node:crypto';
import { attachments, type Executor, statementCsvMappings, statementImports, statementLines, type Tx } from '@moneyflow/db';
import {
  addDays,
  applyCsvMapping,
  type CsvMapping,
  decodeStatementFile,
  detectDelimiter,
  type importBankBalanceInput,
  type importRenameInput,
  type LineStatus,
  type MatchCandidate,
  normalizeDescriptionForDedup,
  parseCsv,
  parseOfx,
  pickMatch,
  type StatementImportDetail,
  type StatementImportSummary,
  type StatementInspect,
  type StatementLineRow,
  type statementImportQuery,
  t,
} from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { AppError, notFound, unprocessable } from '../errors';
import { cleanFileName, storeAttachment } from './attachments';
import { getAccount } from './caixas';
import { loadCard } from './card-core';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Import de extratos (spec 009): OFX 1.x/2.x e CSV (mapeamento salvo por
 * conta), arquivo original como anexo, deduplicação por FITID ou hash,
 * classificação pelas regras aprendidas e casamento assistido (valor exato,
 * data ±3 dias, descrição/entidade). Vale para conta corrente/poupança e para
 * a fatura do cartão (linhas casam com itens da fatura ou viram compras).
 */

export type StatementTarget = { kind: 'account'; accountId: string; caixaId: string } | { kind: 'card'; cardId: string; caixaId: string };

export async function resolveTarget(
  ctx: ServiceContext,
  ref: { accountId?: string | null; cardCaixaId?: string | null },
  write: boolean,
  db: Executor = ctx.db,
): Promise<StatementTarget> {
  if (ref.accountId) {
    const account = await getAccount(ctx, ref.accountId, db);
    if (write) ctx.access.assertWrite(account.caixaId);
    if (write && account.kind !== 'checking' && account.kind !== 'savings') {
      throw unprocessable(t.errors.statementTarget, 'statement_imports_account_kind_check');
    }
    return { kind: 'account', accountId: account.id, caixaId: account.caixaId };
  }
  if (ref.cardCaixaId) {
    if (write) ctx.access.assertWrite(ref.cardCaixaId);
    else ctx.access.assertRead(ref.cardCaixaId);
    await loadCard(db, ref.cardCaixaId);
    return { kind: 'card', cardId: ref.cardCaixaId, caixaId: ref.cardCaixaId };
  }
  throw unprocessable(t.errors.statementTarget);
}

const looksLikeOfx = (text: string) => /<OFX>|OFXHEADER\s*:/i.test(text.slice(0, 4096));

type ParsedLine = {
  lineNumber: number;
  postedOn: string;
  amountCents: number;
  description: string;
  fitid: string | null;
  raw: Record<string, unknown>;
};

type ParsedFile = {
  format: 'ofx' | 'csv';
  lines: ParsedLine[];
  periodStart: string | null;
  periodEnd: string | null;
  bankBalance: { amountCents: number; date: string } | null;
  csvMappingId: string | null;
};

function decodeWith(bytes: Buffer, encoding: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  return new TextDecoder(encoding === 'latin1' ? 'latin1' : encoding).decode(bytes);
}

function mappingOf(row: InlineCsvMapping): CsvMapping {
  return {
    hasHeader: row.hasHeader,
    skipRows: row.skipRows,
    dateFormat: row.dateFormat,
    decimalSeparator: row.decimalSeparator as ',' | '.',
    columns: row.columns as CsvMapping['columns'],
  };
}

async function findMapping(db: Executor, target: StatementTarget, mappingId?: string) {
  const owner =
    target.kind === 'account' ? sql`financial_account_id = ${target.accountId}::uuid` : sql`card_caixa_id = ${target.cardId}::uuid`;
  const result = await db.execute<{ id: string }>(
    mappingId
      ? sql`SELECT id FROM statement_csv_mappings WHERE id = ${mappingId} AND ${owner}`
      : sql`SELECT id FROM statement_csv_mappings WHERE ${owner} ORDER BY is_default DESC, created_at LIMIT 1`,
  );
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(statementCsvMappings).where(eq(statementCsvMappings.id, id));
  return row ?? null;
}

/** Mapeamento CSV ainda não salvo (prévia da tool import_statement, spec 027). */
export type InlineCsvMapping = Pick<
  typeof statementCsvMappings.$inferSelect,
  'delimiter' | 'encoding' | 'hasHeader' | 'skipRows' | 'dateFormat' | 'decimalSeparator' | 'columns'
>;

/** Lê o arquivo (OFX ou CSV com o mapeamento) e devolve as linhas no ponto de vista do titular. */
export async function parseStatementFile(
  db: Executor,
  target: StatementTarget,
  bytes: Buffer,
  mappingId?: string,
  inline?: InlineCsvMapping,
): Promise<ParsedFile> {
  const text = decodeStatementFile(bytes);
  if (looksLikeOfx(text)) {
    let ofx: ReturnType<typeof parseOfx>;
    try {
      ofx = parseOfx(text);
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : t.errors.statementFormat, 'statement_format');
    }
    return {
      format: 'ofx',
      lines: ofx.transactions.map((tr, i) => ({
        lineNumber: i + 1,
        postedOn: tr.postedOn,
        amountCents: tr.amountCents,
        description: tr.description || tr.name || tr.memo || '—',
        fitid: tr.fitid,
        raw: { fitid: tr.fitid, type: tr.type, name: tr.name, memo: tr.memo, checkNum: tr.checkNum, amountCents: tr.amountCents },
      })),
      periodStart: ofx.periodStart,
      periodEnd: ofx.periodEnd,
      bankBalance: ofx.ledgerBalance,
      csvMappingId: null,
    };
  }

  const mapping = inline ? { ...inline, id: null } : await findMapping(db, target, mappingId);
  if (!mapping) throw unprocessable(t.errors.csvMappingRequired, 'csv_mapping_required');
  const csvText = decodeWith(bytes, mapping.encoding);
  let applied: ReturnType<typeof applyCsvMapping>;
  try {
    applied = applyCsvMapping(parseCsv(csvText, mapping.delimiter), mappingOf(mapping));
  } catch (error) {
    throw unprocessable(error instanceof Error ? error.message : t.errors.statementFormat, 'statement_format');
  }
  let lines = applied.lines.map((line) => ({
    lineNumber: line.row,
    postedOn: line.postedOn,
    amountCents: line.amountCents,
    description: line.description || '—',
    fitid: line.fitid,
    raw: line.raw as Record<string, unknown>,
  }));
  // Fatura de cartão em CSV costuma trazer compras positivas: no app, compra sai (−).
  if (target.kind === 'card' && lines.filter((l) => l.amountCents > 0).length > lines.length / 2) {
    lines = lines.map((l) => ({ ...l, amountCents: -l.amountCents }));
  }
  const withBalance = applied.lines.filter((l) => l.balanceCents !== null);
  const last = withBalance.reduce<(typeof withBalance)[number] | null>((acc, l) => (!acc || l.postedOn >= acc.postedOn ? l : acc), null);
  return {
    format: 'csv',
    lines,
    periodStart: null,
    periodEnd: null,
    bankBalance: last ? { amountCents: last.balanceCents!, date: last.postedOn } : null,
    csvMappingId: mapping.id,
  };
}

/**
 * Chave de deduplicação (docs/016): `fitid:<FITID>` ou SHA-256 de data|valor|descrição normalizada|ordem.
 * A normalização do dedup é congelada (normalizeDescriptionForDedup): o hash das linhas já importadas não muda.
 */
export function dedupHashes(lines: Pick<ParsedLine, 'postedOn' | 'amountCents' | 'description' | 'fitid'>[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    if (line.fitid) return `fitid:${line.fitid}`.slice(0, 200);
    const base = `${line.postedOn}|${line.amountCents}|${normalizeDescriptionForDedup(line.description)}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return createHash('sha256').update(`${base}|${ordinal}`).digest('hex');
  });
}

/**
 * Prévia de um import (sem gravar): formato, período e quantas linhas são
 * novas ou já importadas (spec 027, cartão de aprovação do import_statement).
 */
export async function previewStatementImport(
  ctx: ServiceContext,
  ref: { accountId?: string; cardCaixaId?: string },
  bytes: Buffer,
  opts: { mappingId?: string; inline?: InlineCsvMapping },
) {
  const target = await resolveTarget(ctx, ref, true);
  const parsed = await parseStatementFile(ctx.db, target, bytes, opts.mappingId, opts.inline);
  if (parsed.lines.length === 0) throw unprocessable(t.errors.statementEmpty, 'statement_empty');
  const hashes = dedupHashes(parsed.lines);
  const ownerColumn = target.kind === 'account' ? sql`financial_account_id` : sql`card_caixa_id`;
  const ownerId = target.kind === 'account' ? target.accountId : target.cardId;
  const existing = await ctx.db.execute<{ dedup_hash: string }>(sql`
    SELECT dedup_hash FROM statement_lines WHERE ${ownerColumn} = ${ownerId}::uuid
       AND dedup_hash IN (${sql.join(
         hashes.map((h) => sql`${h}`),
         sql`, `,
       )})`);
  const known = new Set(existing.rows.map((r) => r.dedup_hash));
  const dates = parsed.lines.map((l) => l.postedOn).sort();
  const fresh = parsed.lines.filter((_, i) => !known.has(hashes[i]!));
  return {
    target,
    format: parsed.format,
    periodStart: [parsed.periodStart, dates[0]].filter(Boolean).sort()[0] ?? null,
    periodEnd: [parsed.periodEnd, dates.at(-1)].filter(Boolean).sort().at(-1) ?? null,
    lines: parsed.lines.length,
    fresh: fresh.length,
    duplicated: parsed.lines.length - fresh.length,
    inCents: fresh.filter((l) => l.amountCents > 0).reduce((sum, l) => sum + l.amountCents, 0),
    outCents: fresh.filter((l) => l.amountCents < 0).reduce((sum, l) => sum + l.amountCents, 0),
  };
}

export async function inspectStatement(ctx: ServiceContext, bytes: Buffer): Promise<StatementInspect> {
  void ctx;
  const text = decodeStatementFile(bytes);
  if (looksLikeOfx(text)) {
    try {
      const ofx = parseOfx(text);
      return {
        format: 'ofx',
        encoding: 'auto',
        ofx: {
          kind: ofx.kind,
          bankId: ofx.bankId,
          accountId: ofx.accountId,
          periodStart: ofx.periodStart,
          periodEnd: ofx.periodEnd,
          ledgerBalance: ofx.ledgerBalance,
          count: ofx.transactions.length,
          sample: ofx.transactions
            .slice(0, 20)
            .map((tr) => ({ postedOn: tr.postedOn, amountCents: tr.amountCents, description: tr.description, fitid: tr.fitid })),
        },
        csv: null,
      };
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : t.errors.statementFormat, 'statement_format');
    }
  }
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) throw unprocessable(t.errors.statementFormat, 'statement_format');
  return { format: 'csv', encoding: 'auto', ofx: null, csv: { delimiter, rows: rows.slice(0, 20) } };
}

/* ---------------- import ---------------- */

export async function importStatement(
  ctx: ServiceContext,
  query: z.output<typeof statementImportQuery>,
  file: { mime: string; content: Buffer },
): Promise<StatementImportDetail> {
  const target = await resolveTarget(ctx, query, true);
  const parsed = await parseStatementFile(ctx.db, target, file.content, query.mappingId);
  if (parsed.lines.length === 0) throw unprocessable(t.errors.statementEmpty, 'statement_empty');
  const hashes = dedupHashes(parsed.lines);

  const result = await withTx(ctx, async (tx) => {
    const ownerColumn = target.kind === 'account' ? sql`financial_account_id` : sql`card_caixa_id`;
    const ownerId = target.kind === 'account' ? target.accountId : target.cardId;
    const existing = await tx.execute<{ dedup_hash: string }>(sql`
      SELECT dedup_hash FROM statement_lines WHERE ${ownerColumn} = ${ownerId}::uuid
         AND dedup_hash IN (${sql.join(
           hashes.map((h) => sql`${h}`),
           sql`, `,
         )})`);
    const known = new Set(existing.rows.map((r) => r.dedup_hash));
    const fresh = parsed.lines.map((line, i) => ({ line, hash: hashes[i]! })).filter((x) => !known.has(x.hash));
    if (fresh.length === 0) throw new AppError(409, 'statement_duplicated', t.errors.statementAllDuplicated);

    const dates = parsed.lines.map((l) => l.postedOn).sort();
    const periodStart = [parsed.periodStart, dates[0]].filter(Boolean).sort()[0]!;
    const periodEnd = [parsed.periodEnd, dates.at(-1)].filter(Boolean).sort().at(-1)!;
    const bank =
      query.bankBalanceCents !== undefined && query.bankBalanceOn
        ? { amountCents: query.bankBalanceCents, date: query.bankBalanceOn }
        : target.kind === 'account'
          ? parsed.bankBalance
          : null;

    const attachmentId = await storeAttachment(tx, ctx, { name: query.fileName, mime: file.mime, content: file.content });
    const [imp] = await tx
      .insert(statementImports)
      .values({
        financialAccountId: target.kind === 'account' ? target.accountId : null,
        cardCaixaId: target.kind === 'card' ? target.cardId : null,
        cardInvoiceId: target.kind === 'card' ? (query.cardInvoiceId ?? null) : null,
        format: parsed.format,
        attachmentId,
        csvMappingId: parsed.csvMappingId,
        periodStart,
        periodEnd,
        bankBalanceCents: bank?.amountCents ?? null,
        bankBalanceOn: bank?.date ?? null,
        importedByUserId: ctx.access.actor.id,
      })
      .returning({ id: statementImports.id });

    const usage = new Map<string, number>();
    const values = [];
    for (const { line, hash } of fresh) {
      const rule = await ruleFor(tx, target.caixaId, line.description, line.amountCents);
      if (rule) usage.set(rule.id, (usage.get(rule.id) ?? 0) + 1);
      values.push({
        statementImportId: imp!.id,
        financialAccountId: target.kind === 'account' ? target.accountId : null,
        cardCaixaId: target.kind === 'card' ? target.cardId : null,
        lineNumber: line.lineNumber,
        postedOn: line.postedOn,
        amountCents: line.amountCents,
        description: line.description.slice(0, 1000),
        fitid: line.fitid,
        dedupHash: hash,
        entityId: rule?.entityId ?? null,
        categoryId: rule?.categoryId ?? null,
        classificationRuleId: rule?.id ?? null,
        classificationSource: rule ? 'rule' : null,
        raw: line.raw,
      });
    }
    for (let i = 0; i < values.length; i += 500) await tx.insert(statementLines).values(values.slice(i, i + 500));
    for (const [ruleId, count] of usage) {
      await tx.execute(
        sql`UPDATE classification_rules SET usage_count = usage_count + ${count}, last_used_at = now() WHERE id = ${ruleId}`,
      );
    }
    await autoMatch(tx, imp!.id);
    return { id: imp!.id, skipped: parsed.lines.length - fresh.length };
  });
  const detail = await getImport(ctx, result.id);
  return { ...detail, skippedDuplicates: result.skipped };
}

type Rule = { id: string; entityId: string | null; categoryId: string | null };

/** Regra aplicável (classification_rule_for) com a entidade/categoria dela. */
export async function ruleFor(tx: Executor, caixaId: string, description: string, amountCents: number): Promise<Rule | null> {
  const result = await tx.execute<{ id: string; entity_id: string | null; category_id: string | null }>(sql`
    SELECT r.id, r.entity_id, r.category_id FROM classification_rules r
     WHERE r.id = classification_rule_for(${caixaId}::uuid, ${description}, ${amountCents}::bigint)`);
  const row = result.rows[0];
  return row ? { id: row.id, entityId: row.entity_id, categoryId: row.category_id } : null;
}

/* ---------------- casamento assistido ---------------- */

type LineRow = {
  id: string;
  posted_on: string;
  amount_cents: number;
  description: string;
  financial_account_id: string | null;
  card_caixa_id: string | null;
};

/** Candidatos de uma linha: movimentos da conta, títulos em aberto da caixa, itens da fatura do cartão. */
export async function candidatesFor(tx: Executor, line: LineRow, windowDays = 3): Promise<MatchCandidate[]> {
  const from = addDays(line.posted_on, -windowDays);
  const to = addDays(line.posted_on, windowDays);
  if (line.card_caixa_id) {
    const items = await tx.execute<{ id: string; date: string; amount_cents: number; description: string; entity_name: string | null }>(sql`
      SELECT i.id, p.purchased_on AS date, -i.amount_cents AS amount_cents, p.description, e.name AS entity_name
        FROM card_invoice_items i
        JOIN card_invoices v ON v.id = i.card_invoice_id
        JOIN card_purchases p ON p.id = i.card_purchase_id
        JOIN entities e ON e.id = p.entity_id
       WHERE v.card_caixa_id = ${line.card_caixa_id} AND i.kind = 'installment'
         AND -i.amount_cents = ${line.amount_cents}
         AND p.purchased_on BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.card_invoice_item_id = i.id AND sl.status = 'matched')`);
    return items.rows.map((r) => ({
      kind: 'card_item' as const,
      id: r.id,
      date: r.date,
      amountCents: Number(r.amount_cents),
      description: r.description,
      entityName: r.entity_name,
    }));
  }
  const [moves, open] = await Promise.all([
    tx.execute<{ id: string; date: string; amount_cents: number; description: string | null; entity_name: string | null }>(sql`
      SELECT m.id, m.occurred_on AS date, m.amount_cents, coalesce(m.description, t.description) AS description, e.name AS entity_name
        FROM movements m
        LEFT JOIN settlements s ON s.id = m.settlement_id
        LEFT JOIN titles t ON t.id = s.title_id
        LEFT JOIN entities e ON e.id = coalesce(m.entity_id, t.entity_id)
       WHERE m.financial_account_id = ${line.financial_account_id} AND m.amount_cents = ${line.amount_cents}
         AND m.occurred_on BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.movement_id = m.id AND sl.status = 'matched')`),
    tx.execute<{ id: string; date: string; amount_cents: number; description: string; entity_name: string }>(sql`
      SELECT t.id, t.due_date AS date,
             CASE t.direction WHEN 'payable' THEN -b.open_cents ELSE b.open_cents END AS amount_cents,
             t.description, e.name AS entity_name
        FROM titles t
        JOIN title_balances b ON b.title_id = t.id
        JOIN entities e ON e.id = t.entity_id
        JOIN financial_accounts a ON a.id = ${line.financial_account_id}::uuid
       WHERE t.caixa_id = a.caixa_id AND t.status IN ('open', 'partial') AND t.archived_at IS NULL
         AND b.open_cents = abs(${line.amount_cents}::bigint)
         AND t.direction = ${line.amount_cents < 0 ? 'payable' : 'receivable'}
         AND t.due_date BETWEEN ${from}::date AND ${to}::date`),
  ]);
  return [
    ...moves.rows.map((r) => ({
      kind: 'movement' as const,
      id: r.id,
      date: r.date,
      amountCents: Number(r.amount_cents),
      description: r.description ?? '',
      entityName: r.entity_name,
    })),
    ...open.rows.map((r) => ({
      kind: 'title' as const,
      id: r.id,
      date: r.date,
      amountCents: Number(r.amount_cents),
      description: r.description,
      entityName: r.entity_name,
    })),
  ];
}

/** Casa as linhas novas do lote: conciliada (um movimento/item claro) ou sugerida (confirmação em lote). */
export async function autoMatch(tx: Tx, importId: string) {
  const lines = await tx.execute<LineRow>(sql`
    SELECT id, posted_on, amount_cents, description, financial_account_id, card_caixa_id
      FROM statement_lines WHERE statement_import_id = ${importId} AND status = 'new'
     ORDER BY posted_on, line_number`);
  const pending = await tx.execute<{ ref: string }>(sql`
    SELECT coalesce(movement_id, title_id, card_invoice_item_id)::text AS ref FROM statement_lines
     WHERE status = 'suggested' AND coalesce(financial_account_id, card_caixa_id) =
           (SELECT coalesce(financial_account_id, card_caixa_id) FROM statement_imports WHERE id = ${importId})`);
  const used = new Set(pending.rows.map((r) => r.ref));
  let matched = 0;
  let suggested = 0;
  for (const line of lines.rows) {
    const candidates = await candidatesFor(tx, line);
    const pick = pickMatch(
      { postedOn: line.posted_on, amountCents: Number(line.amount_cents), description: line.description },
      candidates,
      used,
    );
    if (!pick) continue;
    used.add(pick.candidate.id);
    const link =
      pick.candidate.kind === 'movement'
        ? sql`movement_id = ${pick.candidate.id}::uuid`
        : pick.candidate.kind === 'title'
          ? sql`title_id = ${pick.candidate.id}::uuid`
          : sql`card_invoice_item_id = ${pick.candidate.id}::uuid`;
    if (pick.status === 'matched') {
      await tx.execute(sql`UPDATE statement_lines SET status = 'matched', matched_at = now(), ${link} WHERE id = ${line.id}`);
      matched += 1;
    } else {
      await tx.execute(sql`UPDATE statement_lines SET status = 'suggested', ${link} WHERE id = ${line.id}`);
      suggested += 1;
    }
  }
  return { matched, suggested };
}

/* ---------------- leitura ---------------- */

const importSql = sql`
  SELECT b.statement_import_id AS id, b.financial_account_id, a.name AS account_name, b.card_caixa_id, i.card_invoice_id,
         coalesce(a.caixa_id, b.card_caixa_id) AS caixa_id, i.format, f.file_name, i.attachment_id,
         b.period_start, b.period_end, b.bank_balance_on, b.bank_balance_cents, b.app_balance_cents, b.difference_cents,
         b.difference_cents - prev.difference_cents AS interval_difference_cents, a.opening_date AS account_opening_date,
         b.lines AS line_count, b.matched_lines, b.suggested_lines, b.new_lines, b.ignored_lines, u.username AS imported_by, i.created_at
    FROM statement_import_balances b
    JOIN statement_imports i ON i.id = b.statement_import_id
    JOIN attachments f ON f.id = i.attachment_id
    LEFT JOIN financial_accounts a ON a.id = b.financial_account_id
    LEFT JOIN users u ON u.id = i.imported_by_user_id
    -- Divergência do intervalo (spec 009): a acumulada menos a do lote anterior com saldo, na ordem da data do saldo.
    LEFT JOIN LATERAL (
      SELECT pb.difference_cents
        FROM statement_import_balances pb
        JOIN statement_imports pi ON pi.id = pb.statement_import_id
       WHERE pb.financial_account_id = b.financial_account_id AND pb.bank_balance_on IS NOT NULL
         AND (pb.bank_balance_on, pi.created_at) < (b.bank_balance_on, i.created_at)
       ORDER BY pb.bank_balance_on DESC, pi.created_at DESC
       LIMIT 1
    ) prev ON b.bank_balance_on IS NOT NULL`;

const toImport = (row: Record<string, unknown>): StatementImportSummary => {
  const r = camel<StatementImportSummary>(row);
  const interval = r.intervalDifferenceCents as number | string | null;
  return { ...r, intervalDifferenceCents: interval === null ? null : Number(interval), createdAt: iso(r.createdAt)! };
};

export async function listImports(ctx: ServiceContext, ref: { accountId?: string; cardCaixaId?: string }) {
  const target = await resolveTarget(ctx, ref, false);
  const where = target.kind === 'account' ? sql`i.financial_account_id = ${target.accountId}` : sql`i.card_caixa_id = ${target.cardId}`;
  const result = await ctx.db.execute(sql`${importSql} WHERE ${where} ORDER BY i.created_at DESC LIMIT 200`);
  return result.rows.map(toImport);
}

export async function getImport(ctx: ServiceContext, id: string, withLines = true): Promise<StatementImportDetail> {
  const result = await ctx.db.execute(sql`${importSql} WHERE i.id = ${id}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  const summary = toImport(raw);
  ctx.access.assertRead(summary.caixaId);
  const lines = withLines ? await listLines(ctx.db, sql`l.statement_import_id = ${id}`) : [];
  return { ...summary, canWrite: ctx.access.canWrite(summary.caixaId), lines };
}

type Page = { limit: number; offset: number };
const nextOffset = (page: Page, shown: number, total: number) => (page.offset + shown < total ? page.offset + shown : null);

/**
 * Página dos lotes da conta ou do cartão, do mais recente ao mais antigo, com
 * o total (spec 011: as tools leem em páginas para não passar do limite do
 * resultado).
 */
export async function listImportsPage(ctx: ServiceContext, ref: { accountId?: string; cardCaixaId?: string }, page: Page) {
  const target = await resolveTarget(ctx, ref, false);
  const where = target.kind === 'account' ? sql`i.financial_account_id = ${target.accountId}` : sql`i.card_caixa_id = ${target.cardId}`;
  const count = await ctx.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM statement_imports i WHERE ${where}`);
  const total = Number(count.rows[0]?.total ?? 0);
  const result = await ctx.db.execute(
    sql`${importSql} WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const imports = result.rows.map(toImport);
  return { total, offset: page.offset, nextOffset: nextOffset(page, imports.length, total), imports };
}

/** O lote com uma página das linhas (filtradas por situação), para as tools (spec 011). */
export async function getImportPage(ctx: ServiceContext, id: string, query: Page & { statuses?: LineStatus[] }) {
  const { lines: _all, ...summary } = await getImport(ctx, id, false);
  const where = [sql`l.statement_import_id = ${id}`];
  if (query.statuses?.length)
    where.push(
      sql`l.status IN (${sql.join(
        query.statuses.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    );
  const filter = sql.join(where, sql` AND `);
  const count = await ctx.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM statement_lines l WHERE ${filter}`);
  const lineTotal = Number(count.rows[0]?.total ?? 0);
  // limit 0 = só o resumo (a próxima página começa no mesmo offset).
  const lines = query.limit === 0 ? [] : await listLines(ctx.db, filter, { limit: query.limit, offset: query.offset });
  return { ...summary, lineTotal, offset: query.offset, nextOffset: nextOffset(query, lines.length, lineTotal), lines };
}

export async function listLines(
  db: Executor,
  where: ReturnType<typeof sql>,
  opts: { newestFirst?: boolean; limit?: number; offset?: number } = {},
): Promise<StatementLineRow[]> {
  const order = opts.newestFirst ? sql`l.posted_on DESC, l.line_number DESC` : sql`l.posted_on, l.line_number`;
  const limit = sql`${opts.limit ? sql` LIMIT ${opts.limit}` : sql``}${opts.offset ? sql` OFFSET ${opts.offset}` : sql``}`;
  const result = await db.execute(sql`
    SELECT l.id, l.statement_import_id AS import_id, l.line_number, l.posted_on, l.amount_cents, l.description, l.fitid, l.status, l.movement_id, l.title_id,
           l.card_invoice_item_id, l.created_entry, l.entity_id, e.name AS entity_name, l.category_id, c.name AS category_name,
           coalesce(c.color_slot, pc.color_slot) AS category_color_slot, l.classification_source, l.classification_rule_id,
           CASE
             WHEN l.movement_id IS NOT NULL THEN json_build_object('kind', 'movement', 'date', m.occurred_on,
               'description', coalesce(m.description, mt.description, ''), 'amountCents', m.amount_cents, 'entityName', me.name)
             WHEN l.title_id IS NOT NULL THEN json_build_object('kind', 'title', 'date', t.due_date, 'description', t.description,
               'amountCents', CASE t.direction WHEN 'payable' THEN -tb.open_cents ELSE tb.open_cents END, 'entityName', te.name)
             WHEN l.card_invoice_item_id IS NOT NULL THEN json_build_object('kind', 'card_item', 'date', p.purchased_on,
               'description', p.description, 'amountCents', -ci.amount_cents, 'entityName', pe.name)
           END AS target
      FROM statement_lines l
      LEFT JOIN entities e ON e.id = l.entity_id
      LEFT JOIN categories c ON c.id = l.category_id
      LEFT JOIN categories pc ON pc.id = c.parent_id
      LEFT JOIN movements m ON m.id = l.movement_id
      LEFT JOIN settlements ms ON ms.id = m.settlement_id
      LEFT JOIN titles mt ON mt.id = ms.title_id
      LEFT JOIN entities me ON me.id = coalesce(m.entity_id, mt.entity_id)
      LEFT JOIN titles t ON t.id = l.title_id
      LEFT JOIN title_balances tb ON tb.title_id = t.id
      LEFT JOIN entities te ON te.id = t.entity_id
      LEFT JOIN card_invoice_items ci ON ci.id = l.card_invoice_item_id
      LEFT JOIN card_purchases p ON p.id = ci.card_purchase_id
      LEFT JOIN entities pe ON pe.id = p.entity_id
     WHERE ${where}
     ORDER BY ${order}${limit}`);
  return result.rows.map((row) => {
    const r = camel<StatementLineRow>(row);
    const target = r.target as (StatementLineRow['target'] & { amountCents: number | string }) | null;
    return { ...r, target: target ? { ...target, amountCents: Number(target.amountCents) } : null };
  });
}

/**
 * Saldo do banco do lote (spec 009): trocar valor e data, limpar ou voltar ao
 * saldo do arquivo (relido do OFX guardado). Só lote de conta.
 */
export async function setImportBankBalance(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof importBankBalanceInput>,
): Promise<StatementImportDetail> {
  const detail = await getImport(ctx, id);
  ctx.access.assertWrite(detail.caixaId);
  if (!detail.financialAccountId) throw unprocessable(t.errors.statementBalanceAccountOnly, 'statement_balance_account_only');
  let balance: { amountCents: number; date: string } | null = null;
  if (input.mode === 'set') balance = { amountCents: input.amountCents, date: input.on };
  if (input.mode === 'file') {
    const [file] = await ctx.db.select({ content: attachments.content }).from(attachments).where(eq(attachments.id, detail.attachmentId));
    const target = await resolveTarget(ctx, { accountId: detail.financialAccountId }, true);
    const [imp] = await ctx.db
      .select({ csvMappingId: statementImports.csvMappingId })
      .from(statementImports)
      .where(eq(statementImports.id, id));
    const parsed = await parseStatementFile(ctx.db, target, Buffer.from(file!.content), imp?.csvMappingId ?? undefined);
    if (!parsed.bankBalance) throw unprocessable(t.errors.statementNoFileBalance, 'statement_no_file_balance');
    balance = parsed.bankBalance;
  }
  await withTx(ctx, (tx) =>
    tx
      .update(statementImports)
      .set({ bankBalanceCents: balance?.amountCents ?? null, bankBalanceOn: balance?.date ?? null })
      .where(eq(statementImports.id, id)),
  );
  return getImport(ctx, id);
}

/** Renomeia o arquivo do lote (spec 009): o anexo é só deste lote; o conteúdo não muda. */
export async function renameImport(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof importRenameInput>,
): Promise<StatementImportDetail> {
  const detail = await getImport(ctx, id);
  ctx.access.assertWrite(detail.caixaId);
  await withTx(ctx, (tx) =>
    tx
      .update(attachments)
      .set({ fileName: cleanFileName(input.fileName) })
      .where(eq(attachments.id, detail.attachmentId)),
  );
  return getImport(ctx, id);
}

export const LINE_SEARCH_LIMIT = 200;

/** Busca por descrição nas linhas dos lotes da conta (ou do cartão), em todos ou nos escolhidos (spec 009). */
export async function searchLines(
  ctx: ServiceContext,
  query: { accountId?: string; cardCaixaId?: string; q: string; importIds: string[] },
): Promise<StatementLineRow[]> {
  const target = await resolveTarget(ctx, query, false);
  const where = [
    target.kind === 'account' ? sql`l.financial_account_id = ${target.accountId}` : sql`l.card_caixa_id = ${target.cardId}`,
    sql`l.description ILIKE ${`%${query.q}%`}`,
  ];
  if (query.importIds.length > 0)
    where.push(
      sql`l.statement_import_id IN (${sql.join(
        query.importIds.map((importId) => sql`${importId}::uuid`),
        sql`, `,
      )})`,
    );
  return listLines(ctx.db, sql.join(where, sql` AND `), { newestFirst: true, limit: LINE_SEARCH_LIMIT });
}

export async function deleteImport(ctx: ServiceContext, id: string) {
  const detail = await getImport(ctx, id);
  ctx.access.assertWrite(detail.caixaId);
  await withTx(ctx, async (tx) => {
    await tx.delete(statementImports).where(eq(statementImports.id, id));
    const rest = await tx.execute(sql`SELECT 1 FROM attachment_links WHERE attachment_id = ${detail.attachmentId} LIMIT 1`);
    if (rest.rows.length === 0) await tx.delete(attachments).where(eq(attachments.id, detail.attachmentId));
  });
  return { deleted: true, archived: false };
}

/** Roda o casamento de novo nas linhas novas do lote (depois de lançar títulos/movimentos). */
export async function rematchImport(ctx: ServiceContext, id: string) {
  const detail = await getImport(ctx, id);
  ctx.access.assertWrite(detail.caixaId);
  await withTx(ctx, (tx) => autoMatch(tx, id));
  return getImport(ctx, id);
}
