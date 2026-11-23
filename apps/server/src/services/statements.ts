import { createHash } from 'node:crypto';
import { attachments, type Executor, statementCsvMappings, statementImports, statementLines, type Tx } from '@moneyflow/db';
import {
  addDays,
  applyCsvMapping,
  type CardChargeOccurrence,
  type CardChargeSuggestion,
  type CsvMapping,
  cardChargeMatch,
  csvBankBalance,
  decodeCsvFile,
  decodeStatementFile,
  detectCsvEncoding,
  detectDelimiter,
  detectStatementEncoding,
  type importBankBalanceInput,
  importLink,
  type importRenameInput,
  type LineStatus,
  type MatchCandidate,
  normalizeDescriptionForDedup,
  type ObligationMatch,
  type OfxInspectStatement,
  type OfxStatement,
  type OfxTargetAccount,
  type obligationMatchQuery,
  parseCsv,
  parseOfxStatements,
  pickMatch,
  pickOfxStatement,
  pickSeriesOccurrences,
  type SeriesCandidateInfo,
  type SeriesOccurrenceRow,
  type StatementFitidCollisions,
  type StatementImportDetail,
  type StatementImportSummary,
  type StatementInspect,
  type StatementInvalidRows,
  type StatementLineRow,
  type SupersedeResult,
  scoreCandidate,
  seriesMatch,
  splitSettlement,
  type statementImportQuery,
  t,
} from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { AppError, failureReason, notFound, unprocessable } from '../errors';
import { cleanFileName, storeAttachment } from './attachments';
import { getAccount } from './caixas';
import { expectedCardOccurrences, insertChargePurchase, toSuggestion } from './card-charges';
import { loadCard } from './card-core';
import { settleFromLine } from './line-settle';
import { createNotifications } from './notifications';
import { TERMS_SQL, termsOf } from './series-core';
import { activeProvisionals, assertActiveProvisionals, lockImports, previewSupersedeForFile, supersedeInTx } from './statement-supersede';
import { withTx } from './tx';
import { camel, iso } from './util';

/*
 * Import de extratos (spec 009): OFX 1.x/2.x e CSV (mapeamento salvo por
 * conta), arquivo original como anexo, deduplicação por FITID ou hash,
 * classificação pelas regras aprendidas e casamento assistido (valor exato,
 * data ±3 dias, descrição/entidade). Vale para conta corrente/poupança e para
 * a fatura do cartão (linhas casam com itens da fatura ou viram compras).
 */

/** `ofx`: a conta de destino como o OFX a descreve, para escolher o extrato de um arquivo com várias contas. */
export type StatementTarget =
  | { kind: 'account'; accountId: string; caixaId: string; ofx: OfxTargetAccount }
  | { kind: 'card'; cardId: string; caixaId: string; ofx: OfxTargetAccount };

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
    // Conta arquivada não importa extrato novo (spec 032); os lotes antigos continuam legíveis (tarefa 080).
    if (write && account.archivedAt) throw unprocessable(t.errors.statementAccountArchived, 'statement_account_archived');
    return {
      kind: 'account',
      accountId: account.id,
      caixaId: account.caixaId,
      ofx: {
        kind: account.kind === 'savings' ? 'savings' : 'checking',
        bankCode: account.bankCode,
        branch: account.branch,
        accountNumber: account.accountNumber,
      },
    };
  }
  if (ref.cardCaixaId) {
    if (write) ctx.access.assertWrite(ref.cardCaixaId);
    else ctx.access.assertRead(ref.cardCaixaId);
    await loadCard(db, ref.cardCaixaId);
    return { kind: 'card', cardId: ref.cardCaixaId, caixaId: ref.cardCaixaId, ofx: { kind: 'creditcard' } };
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
  /** OFX com várias contas: as que ficaram de fora (rótulos). */
  ofxLeftOut: string[];
  /** CSV: as linhas com data ou valor inválidos, que não entram (tarefa 140). */
  invalidRows: { row: number; message: string }[];
};

const ofxLabel = (st: OfxStatement) => t.statements.ofxAccountLabel(st);

function ofxLines(st: OfxStatement): ParsedLine[] {
  return st.transactions.map((tr, i) => ({
    lineNumber: i + 1,
    postedOn: tr.postedOn,
    amountCents: tr.amountCents,
    description: tr.description || tr.name || tr.memo || '—',
    fitid: tr.fitid,
    raw: { fitid: tr.fitid, type: tr.type, name: tr.name, memo: tr.memo, checkNum: tr.checkNum, amountCents: tr.amountCents },
  }));
}

function readOfxStatements(text: string): OfxStatement[] {
  try {
    return parseOfxStatements(text);
  } catch (error) {
    throw unprocessable(error instanceof Error ? error.message : t.errors.statementFormat, 'statement_format');
  }
}

/**
 * O extrato a importar de um OFX (spec 009): o pedido (`ofxStatement`, posição
 * 1, 2, …) ou o único cuja conta casa com a de destino. Num arquivo com várias
 * contas sem casamento, recusa com a lista para o usuário escolher.
 */
function chooseOfxStatement(statements: OfxStatement[], target: StatementTarget, position?: number): number {
  if (position !== undefined) {
    if (position > statements.length) throw unprocessable(t.errors.statementOfxStatement, 'statement_ofx_statement');
    return position - 1;
  }
  const pick = pickOfxStatement(statements, target.ofx);
  if (pick.index !== null) return pick.index;
  const list = statements.map((st, i) => `${i + 1} = ${ofxLabel(st)}`).join('; ');
  throw unprocessable(t.errors.statementOfxChooseAccount(list), 'statement_ofx_choose_account');
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

/**
 * Lê o arquivo (OFX ou CSV com o mapeamento) e devolve as linhas no ponto de
 * vista do titular. OFX com várias contas: só as linhas do extrato escolhido
 * (`ofxStatement` ou o que casa com a conta), nunca as das outras contas.
 */
export async function parseStatementFile(
  db: Executor,
  target: StatementTarget,
  bytes: Buffer,
  opts: { mappingId?: string; inline?: InlineCsvMapping; ofxStatement?: number } = {},
): Promise<ParsedFile> {
  const { mappingId, inline } = opts;
  const text = decodeStatementFile(bytes);
  if (looksLikeOfx(text)) {
    const statements = readOfxStatements(text);
    const index = chooseOfxStatement(statements, target, opts.ofxStatement);
    const ofx = statements[index]!;
    return {
      format: 'ofx',
      lines: ofxLines(ofx),
      periodStart: ofx.periodStart,
      periodEnd: ofx.periodEnd,
      bankBalance: ofx.ledgerBalance,
      csvMappingId: null,
      ofxLeftOut: statements.filter((_, i) => i !== index).map(ofxLabel),
      invalidRows: [],
    };
  }

  const mapping = inline ? { ...inline, id: null } : await findMapping(db, target, mappingId);
  if (!mapping) throw unprocessable(t.errors.csvMappingRequired, 'csv_mapping_required');
  const csvText = decodeCsvFile(bytes, mapping.encoding);
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
  return {
    format: 'csv',
    lines,
    periodStart: null,
    periodEnd: null,
    bankBalance: csvBankBalance(applied.lines),
    csvMappingId: mapping.id,
    ofxLeftOut: [],
    invalidRows: applied.errors,
  };
}

type DedupLine = Pick<ParsedLine, 'postedOn' | 'amountCents' | 'description' | 'fitid'>;

/** A linha da conta que tem a chave `fitid:<FITID>` (data e valor), para reconhecer a colisão de FITID. */
export type FitidHolder = { postedOn: string; amountCents: number };

const fitidKey = (fitid: string) => `fitid:${fitid}`.slice(0, 200);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Chave de deduplicação (docs/016): `fitid:<FITID>` ou SHA-256 de data|valor|descrição normalizada|ordem.
 * A normalização do dedup é congelada (normalizeDescriptionForDedup): o hash das linhas já importadas não muda.
 *
 * FITID que não é único (tarefa 089): se a conta já tem `fitid:<FITID>` com outra data ou outro valor
 * (`holders`), ou se o FITID se repete no arquivo, a linha é outra transação e recebe a chave de reserva
 * `fitid:<FITID>#<SHA-256 de FITID|data|valor|descrição normalizada|ordem entre as iguais>`. A linha com a
 * mesma data e o mesmo valor da que tem a chave é a mesma transação (duplicada), uma vez só. O reimport do
 * mesmo arquivo dá as mesmas chaves, em qualquer ordem.
 */
export function dedupHashes(lines: DedupLine[], holders: ReadonlyMap<string, FitidHolder> = new Map()): string[] {
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  const reserved = new Map<string, number>();
  return lines.map((line) => {
    if (line.fitid) {
      const key = fitidKey(line.fitid);
      if (!taken.has(key)) {
        const holder = holders.get(key);
        if (!holder || (holder.postedOn === line.postedOn && holder.amountCents === line.amountCents)) {
          taken.add(key);
          return key;
        }
      }
      // 6 + 129 + 1 + 64 = 200, o limite de statement_lines_dedup_hash_check.
      const base = `${line.fitid}|${line.postedOn}|${line.amountCents}|${normalizeDescriptionForDedup(line.description)}`;
      const ordinal = reserved.get(base) ?? 0;
      reserved.set(base, ordinal + 1);
      return `fitid:${line.fitid.slice(0, 129)}#${sha256(`${base}|${ordinal}`)}`;
    }
    const base = `${line.postedOn}|${line.amountCents}|${normalizeDescriptionForDedup(line.description)}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return sha256(`${base}|${ordinal}`);
  });
}

/**
 * A deduplicação não conta as linhas dos lotes provisórios (spec 031): o consolidado traz o mês inteiro. Pela
 * cópia na linha, que o banco mantém para o índice parcial statement_lines_account_dedup_key (tarefa 139).
 */
const notProvisional = sql`NOT statement_lines.provisional`;

/**
 * As linhas do arquivo contra as da conta (ou do cartão): a chave de cada uma,
 * as que já existem (`known`) e as novas que entram pela chave de reserva do
 * FITID repetido (tarefa 089). Duas consultas, qualquer que seja o tamanho do arquivo.
 */
async function dedupAgainstTarget(db: Executor, target: StatementTarget, lines: ParsedLine[]) {
  const ownerColumn = target.kind === 'account' ? sql`financial_account_id` : sql`card_caixa_id`;
  const ownerId = target.kind === 'account' ? target.accountId : target.cardId;
  const inList = (keys: string[]) =>
    sql.join(
      keys.map((h) => sql`${h}`),
      sql`, `,
    );
  const fitidKeys = [...new Set(lines.flatMap((l) => (l.fitid ? [fitidKey(l.fitid)] : [])))];
  const holders = new Map<string, FitidHolder>();
  if (fitidKeys.length > 0) {
    const rows = await db.execute<{ dedup_hash: string; posted_on: string; amount_cents: number }>(sql`
      SELECT dedup_hash, posted_on, amount_cents FROM statement_lines WHERE ${ownerColumn} = ${ownerId}::uuid
         AND ${notProvisional} AND dedup_hash IN (${inList(fitidKeys)})`);
    for (const r of rows.rows) holders.set(r.dedup_hash, { postedOn: r.posted_on, amountCents: Number(r.amount_cents) });
  }
  const hashes = dedupHashes(lines, holders);
  const existing = await db.execute<{ dedup_hash: string }>(sql`
    SELECT dedup_hash FROM statement_lines WHERE ${ownerColumn} = ${ownerId}::uuid
       AND ${notProvisional} AND dedup_hash IN (${inList(hashes)})`);
  const known = new Set(existing.rows.map((r) => r.dedup_hash));
  const fresh = lines.map((line, i) => ({ line, hash: hashes[i]! })).filter((x) => !known.has(x.hash));
  const collided = fresh.filter((x) => x.line.fitid && x.hash !== fitidKey(x.line.fitid));
  const fitidCollisions: StatementFitidCollisions | undefined = collided.length
    ? {
        total: collided.length,
        lines: collided.slice(0, SHOWN_ROWS).map(({ line }) => ({
          fitid: line.fitid!,
          postedOn: line.postedOn,
          amountCents: line.amountCents,
          description: line.description,
        })),
      }
    : undefined;
  return { fresh, fitidCollisions };
}

/** Quantas linhas inválidas ou colisões a resposta lista (o total vem junto). */
const SHOWN_ROWS = 50;

const invalidRowsOf = (parsed: ParsedFile): StatementInvalidRows | undefined =>
  parsed.invalidRows.length ? { total: parsed.invalidRows.length, rows: parsed.invalidRows.slice(0, SHOWN_ROWS) } : undefined;

/**
 * Prévia de um import (sem gravar): formato, período e quantas linhas são
 * novas ou já importadas (spec 027, cartão de aprovação do import_statement),
 * com as linhas do CSV que não foram lidas e as colisões de FITID.
 */
export async function previewStatementImport(
  ctx: ServiceContext,
  ref: { accountId?: string; cardCaixaId?: string },
  bytes: Buffer,
  opts: { mappingId?: string; inline?: InlineCsvMapping; ofxStatement?: number; provisional?: boolean; supersede?: string[] },
) {
  const target = await resolveTarget(ctx, ref, true);
  if ((opts.provisional || opts.supersede?.length) && target.kind !== 'account')
    throw unprocessable(t.errors.statementProvisionalAccountOnly, 'statement_provisional_account_only');
  // A troca pedida vale só para provisórios ativos da conta, como na execução (tarefa 142).
  if (target.kind === 'account') await assertActiveProvisionals(ctx.db, target.accountId, opts.supersede ?? []);
  const parsed = await parseStatementFile(ctx.db, target, bytes, opts);
  if (parsed.lines.length === 0) throw unprocessable(t.errors.statementEmpty, 'statement_empty');
  const dedup = await dedupAgainstTarget(ctx.db, target, parsed.lines);
  const fresh = dedup.fresh.map((x) => x.line);
  const dates = parsed.lines.map((l) => l.postedOn).sort();
  const periodStart = [parsed.periodStart, dates[0]].filter(Boolean).sort()[0] ?? null;
  const periodEnd = [parsed.periodEnd, dates.at(-1)].filter(Boolean).sort().at(-1) ?? null;
  // Spec 031: os provisórios ativos sobrepostos e, com a troca, o resultado dela sem gravar.
  const overlap =
    target.kind === 'account' && periodStart && periodEnd
      ? await activeProvisionals(ctx.db, target.accountId, { periodStart, periodEnd })
      : [];
  const supersedeIds = opts.provisional ? [...new Set([...overlap.map((p) => p.id), ...(opts.supersede ?? [])])] : (opts.supersede ?? []);
  const superseded = supersedeIds.length ? await previewSupersedeForFile(ctx.db, supersedeIds, fresh) : null;
  return {
    target,
    provisional: Boolean(opts.provisional),
    provisionalOverlap: overlap,
    superseded,
    format: parsed.format,
    periodStart,
    periodEnd,
    lines: parsed.lines.length,
    fresh: fresh.length,
    duplicated: parsed.lines.length - fresh.length,
    inCents: fresh.filter((l) => l.amountCents > 0).reduce((sum, l) => sum + l.amountCents, 0),
    outCents: fresh.filter((l) => l.amountCents < 0).reduce((sum, l) => sum + l.amountCents, 0),
    ofxLeftOut: parsed.ofxLeftOut,
    invalidRows: invalidRowsOf(parsed),
    fitidCollisions: dedup.fitidCollisions,
  };
}

function inspectOfx(st: OfxStatement, index: number): OfxInspectStatement {
  return {
    position: index + 1,
    kind: st.kind,
    bankId: st.bankId,
    branchId: st.branchId,
    accountId: st.accountId,
    accountType: st.accountType,
    periodStart: st.periodStart,
    periodEnd: st.periodEnd,
    ledgerBalance: st.ledgerBalance,
    count: st.transactions.length,
    sample: st.transactions
      .slice(0, 20)
      .map((tr) => ({ postedOn: tr.postedOn, amountCents: tr.amountCents, description: tr.description, fitid: tr.fitid })),
  };
}

/**
 * Leitura prévia do arquivo. Com a conta ou o cartão de destino, um OFX com
 * várias contas já vem com o extrato que casa (`selected`) ou o palpite pelo tipo.
 */
export async function inspectStatement(
  ctx: ServiceContext,
  bytes: Buffer,
  ref: { accountId?: string; cardCaixaId?: string } = {},
): Promise<StatementInspect> {
  const text = decodeStatementFile(bytes);
  // A codificação detectada (tarefa 088): no CSV, a tela a pré-seleciona no mapeamento.
  if (looksLikeOfx(text)) {
    const statements = readOfxStatements(text);
    const target = ref.accountId || ref.cardCaixaId ? (await resolveTarget(ctx, ref, false)).ofx : null;
    const pick = target ? pickOfxStatement(statements, target) : pickOfxStatement(statements, { kind: 'checking' });
    const all = statements.map(inspectOfx);
    const shown = all[pick.index ?? pick.suggested ?? 0]!;
    return {
      format: 'ofx',
      encoding: detectStatementEncoding(bytes),
      ofx: {
        ...shown,
        statements: all,
        selected: target && pick.index !== null ? pick.index + 1 : null,
        suggested: pick.suggested !== null ? pick.suggested + 1 : null,
      },
      csv: null,
    };
  }
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) throw unprocessable(t.errors.statementFormat, 'statement_format');
  return { format: 'csv', encoding: detectCsvEncoding(bytes), ofx: null, csv: { delimiter, rows: rows.slice(0, 20) } };
}

/* ---------------- import ---------------- */

export async function importStatement(
  ctx: ServiceContext,
  query: z.output<typeof statementImportQuery>,
  file: { mime: string; content: Buffer },
): Promise<StatementImportDetail> {
  const target = await resolveTarget(ctx, query, true);
  if ((query.provisional || query.supersede.length > 0) && target.kind !== 'account')
    throw unprocessable(t.errors.statementProvisionalAccountOnly, 'statement_provisional_account_only');
  const parsed = await parseStatementFile(ctx.db, target, file.content, query);
  if (parsed.lines.length === 0) throw unprocessable(t.errors.statementEmpty, 'statement_empty');

  const result = await withTx(ctx, async (tx) => {
    const { fresh, fitidCollisions } = await dedupAgainstTarget(tx, target, parsed.lines);
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
        provisional: query.provisional,
      })
      .returning({ id: statementImports.id });

    // As regras de todas as linhas numa consulta só (tarefa 139).
    const rules = await rulesFor(
      tx,
      ruleTargetOf(target),
      fresh.map(({ line }) => line),
    );
    const usage = new Map<string, number>();
    const values = fresh.map(({ line, hash }, i) => {
      const rule = rules[i];
      if (rule) usage.set(rule.id, (usage.get(rule.id) ?? 0) + 1);
      return {
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
        classificationSource: rule ? ('rule' as const) : null,
        raw: line.raw,
      };
    });
    for (let i = 0; i < values.length; i += 500) await tx.insert(statementLines).values(values.slice(i, i + 500));
    await bumpRuleUsage(tx, usage);
    // Spec 031: a troca dos provisórios antes do casamento automático (as conciliações passam, nada é lançado de novo).
    // Um provisório novo substitui sempre os provisórios ativos que ele cobre; o consolidado, os escolhidos.
    let superseded: SupersedeResult | undefined;
    let provisionalOverlap: StatementImportDetail['provisionalOverlap'];
    if (target.kind === 'account') {
      const active = await activeProvisionals(tx, target.accountId, { periodStart, periodEnd }, imp!.id);
      const ids = query.provisional ? [...new Set([...active.map((p) => p.id), ...query.supersede])] : query.supersede;
      if (ids.length > 0) {
        await lockImports(tx, ids);
        superseded = await supersedeInTx(tx, imp!.id, ids);
      }
      const left = active.filter((p) => !ids.includes(p.id));
      if (!query.provisional && left.length > 0) provisionalOverlap = left;
    }
    await autoMatch(ctx, tx, imp!.id);
    return { id: imp!.id, skipped: parsed.lines.length - fresh.length, superseded, provisionalOverlap, fitidCollisions };
  });
  const detail = await getImport(ctx, result.id);
  const invalidRows = invalidRowsOf(parsed);
  return {
    ...detail,
    skippedDuplicates: result.skipped,
    ...(parsed.ofxLeftOut.length ? { ofxLeftOut: parsed.ofxLeftOut } : {}),
    ...(invalidRows ? { invalidRows } : {}),
    ...(result.fitidCollisions ? { fitidCollisions: result.fitidCollisions } : {}),
    ...(result.superseded ? { superseded: result.superseded } : {}),
    ...(result.provisionalOverlap ? { provisionalOverlap: result.provisionalOverlap } : {}),
  };
}

type Rule = { id: string; entityId: string | null; categoryId: string | null };

/** Alvo das regras de uma linha (spec 032): a conta corrente/poupança ou o cartão, exatamente um. */
export type RuleTarget = { accountId: string | null; cardCaixaId: string | null };

export const ruleTargetOf = (target: StatementTarget): RuleTarget =>
  target.kind === 'account' ? { accountId: target.accountId, cardCaixaId: null } : { accountId: null, cardCaixaId: target.cardId };

/** Regra aplicável (classification_rule_for, só as do alvo da linha) com a entidade/categoria dela. */
export async function ruleFor(tx: Executor, target: RuleTarget, description: string, amountCents: number): Promise<Rule | null> {
  return (await rulesFor(tx, target, [{ description, amountCents }]))[0] ?? null;
}

/**
 * O ruleFor de várias linhas do mesmo alvo, na ordem delas: uma consulta só
 * para o lote inteiro, com uma chamada de classification_rule_for por linha
 * (tarefa 139; a importação e o "Aplicar regras" usam esta).
 */
export async function rulesFor(
  tx: Executor,
  target: RuleTarget,
  lines: { description: string; amountCents: number }[],
): Promise<(Rule | null)[]> {
  if (lines.length === 0) return [];
  const items = lines.map((l, i) => ({ i, d: l.description, v: l.amountCents }));
  const result = await tx.execute<{ i: number; id: string; entity_id: string | null; category_id: string | null }>(sql`
    WITH x AS MATERIALIZED (
      SELECT x.i, classification_rule_for(${target.accountId}::uuid, ${target.cardCaixaId}::uuid, x.d, x.v) AS rule_id
        FROM json_to_recordset(${JSON.stringify(items)}::json) AS x(i int, d text, v bigint))
    SELECT x.i, r.id, r.entity_id, r.category_id FROM x JOIN classification_rules r ON r.id = x.rule_id`);
  const out: (Rule | null)[] = lines.map(() => null);
  for (const row of result.rows) out[Number(row.i)] = { id: row.id, entityId: row.entity_id, categoryId: row.category_id };
  return out;
}

/** Soma o uso das regras (importação e "Aplicar regras", spec 009) numa consulta só. */
export async function bumpRuleUsage(tx: Executor, usage: Map<string, number>) {
  if (usage.size === 0) return;
  const rows = [...usage].map(([id, n]) => ({ id, n }));
  await tx.execute(sql`
    UPDATE classification_rules r SET usage_count = r.usage_count + x.n, last_used_at = now()
      FROM json_to_recordset(${JSON.stringify(rows)}::json) AS x(id uuid, n int)
     WHERE r.id = x.id`);
}

/* ---------------- casamento assistido ---------------- */

type LineRow = {
  id: string;
  posted_on: string;
  amount_cents: number;
  description: string;
  financial_account_id: string | null;
  card_caixa_id: string | null;
  /** Na fatura do cartão, a fatura do lote (tarefa 141): as parcelas dela vêm no lugar das de outras faturas. */
  card_invoice_id?: string | null;
};

/** Pré-filtro largo das ocorrências de série e das cobranças esperadas: a janela vai a 45 dias e o mesmo mês soma até 31. */
const SERIES_PREFILTER_DAYS = 76;

const bigintArray = (values: number[]) => sql`${`{${values.join(',')}}`}::bigint[]`;

type SeriesRow = { direction: 'payable' | 'receivable'; occ: SeriesOccurrenceRow };
type PoolItem = MatchCandidate & { invoiceId: string };

/**
 * O que as linhas de um lote (da mesma conta ou do mesmo cartão) podem casar,
 * lido de uma vez para o intervalo das datas e os valores delas (tarefa 139):
 * movimentos livres da conta, títulos em aberto da caixa, ocorrências de
 * série e, na fatura, os itens e as cobranças esperadas. Cada linha filtra o
 * seu pedaço em memória (candidatesFromPool), com o mesmo resultado da
 * consulta por linha.
 */
type CandidatePool = {
  windowDays: number;
  moves: MatchCandidate[];
  titles: MatchCandidate[];
  series: SeriesRow[];
  items: PoolItem[];
  charges: CardChargeOccurrence[];
};

async function loadCandidatePool(tx: Executor, lines: LineRow[], windowDays: number): Promise<CandidatePool> {
  const pool: CandidatePool = { windowDays, moves: [], titles: [], series: [], items: [], charges: [] };
  const first = lines[0];
  if (!first) return pool;
  const dates = lines.map((l) => l.posted_on).sort();
  const from = addDays(dates[0]!, -windowDays);
  const to = addDays(dates.at(-1)!, windowDays);
  const amounts = [...new Set(lines.map((l) => Number(l.amount_cents)))];
  if (first.card_caixa_id) {
    const items = await tx.execute<{
      id: string;
      invoice_id: string;
      date: string;
      amount_cents: number;
      description: string;
      entity_name: string | null;
    }>(sql`
      SELECT i.id, i.card_invoice_id AS invoice_id, p.purchased_on AS date, -i.amount_cents AS amount_cents, p.description,
             e.name AS entity_name
        FROM card_invoice_items i
        JOIN card_invoices v ON v.id = i.card_invoice_id
        JOIN card_purchases p ON p.id = i.card_purchase_id
        JOIN entities e ON e.id = p.entity_id
       WHERE v.card_caixa_id = ${first.card_caixa_id} AND i.kind = 'installment'
         AND -i.amount_cents = ANY (${bigintArray(amounts)})
         AND p.purchased_on BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.card_invoice_item_id = i.id AND sl.status = 'matched')
       -- Parcelas iguais da mesma compra (tarefa 141): a de menor número em aberto primeiro.
       ORDER BY i.installment_number, p.purchased_on, i.id`);
    pool.items = items.rows.map((r) => ({
      kind: 'card_item' as const,
      id: r.id,
      invoiceId: r.invoice_id,
      date: r.date,
      amountCents: Number(r.amount_cents),
      description: r.description,
      entityName: r.entity_name,
    }));
    pool.charges = await expectedCardOccurrences(
      tx,
      first.card_caixa_id,
      addDays(dates[0]!, -SERIES_PREFILTER_DAYS),
      addDays(dates.at(-1)!, SERIES_PREFILTER_DAYS),
    );
    return pool;
  }
  const accountId = first.financial_account_id;
  if (!accountId) return pool;
  const moves = await tx.execute<{
    id: string;
    date: string;
    amount_cents: number;
    description: string | null;
    entity_name: string | null;
  }>(sql`
    SELECT m.id, m.occurred_on AS date, m.amount_cents, coalesce(m.description, t.description) AS description, e.name AS entity_name
      FROM movements m
      LEFT JOIN settlements s ON s.id = m.settlement_id
      LEFT JOIN titles t ON t.id = s.title_id
      LEFT JOIN entities e ON e.id = coalesce(m.entity_id, t.entity_id)
     WHERE m.financial_account_id = ${accountId} AND m.amount_cents = ANY (${bigintArray(amounts)})
       AND m.occurred_on BETWEEN ${from}::date AND ${to}::date
       AND NOT EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.movement_id = m.id AND sl.status = 'matched')
     ORDER BY m.occurred_on, m.id`);
  pool.moves = moves.rows.map((r) => ({
    kind: 'movement' as const,
    id: r.id,
    date: r.date,
    amountCents: Number(r.amount_cents),
    description: r.description ?? '',
    entityName: r.entity_name,
  }));
  const titles = await tx.execute<{ id: string; date: string; amount_cents: number; description: string; entity_name: string }>(sql`
    SELECT t.id, t.due_date AS date,
           CASE t.direction WHEN 'payable' THEN -b.open_cents ELSE b.open_cents END AS amount_cents,
           t.description, e.name AS entity_name
      FROM titles t
      JOIN title_balances b ON b.title_id = t.id
      JOIN entities e ON e.id = t.entity_id
      JOIN financial_accounts a ON a.id = ${accountId}::uuid
     WHERE t.caixa_id = a.caixa_id AND t.status IN ('open', 'partial') AND t.archived_at IS NULL
       AND b.open_cents = ANY (${bigintArray([...new Set(amounts.map(Math.abs))])})
       AND t.due_date BETWEEN ${from}::date AND ${to}::date
     ORDER BY t.due_date, t.id`);
  pool.titles = titles.rows.map((r) => ({
    kind: 'title' as const,
    id: r.id,
    date: r.date,
    amountCents: Number(r.amount_cents),
    description: r.description,
    entityName: r.entity_name,
  }));
  pool.series = await seriesRows(tx, accountId, addDays(dates[0]!, -SERIES_PREFILTER_DAYS), addDays(dates.at(-1)!, SERIES_PREFILTER_DAYS));
  return pool;
}

/**
 * Candidatos de uma linha a partir do que o lote leu: movimentos da conta,
 * títulos em aberto da caixa (valor exato, ±3 dias), as ocorrências de séries
 * pela regra de reconhecimento da série (specs 033 e 034) e, na fatura do
 * cartão, os itens e as cobranças esperadas das obrigações no cartão. Com a
 * fatura no lote, só as parcelas dela (as de outras faturas só se ela não tiver
 * nenhuma; tarefa 141).
 */
function candidatesFromPool(pool: CandidatePool, line: LineRow): MatchCandidate[] {
  const from = addDays(line.posted_on, -pool.windowDays);
  const to = addDays(line.posted_on, pool.windowDays);
  const amount = Number(line.amount_cents);
  const near = (c: MatchCandidate) => c.amountCents === amount && c.date >= from && c.date <= to;
  if (line.card_caixa_id) {
    let items = pool.items.filter(near);
    if (line.card_invoice_id) {
      const ofLot = items.filter((i) => i.invoiceId === line.card_invoice_id);
      if (ofLot.length > 0) items = ofLot;
    }
    const wideFrom = addDays(line.posted_on, -SERIES_PREFILTER_DAYS);
    const wideTo = addDays(line.posted_on, SERIES_PREFILTER_DAYS);
    const matchLine = { postedOn: line.posted_on, amountCents: amount, description: line.description };
    return [
      ...items.map(({ invoiceId: _invoice, ...candidate }) => candidate),
      ...pool.charges
        .filter((c) => c.dueDate >= wideFrom && c.dueDate <= wideTo)
        .map((c) => cardChargeMatch(matchLine, c))
        .filter((c): c is MatchCandidate => c !== null),
    ];
  }
  return [...seriesFromRows(pool.series, line), ...pool.moves.filter(near), ...pool.titles.filter(near)];
}

/** Candidatos de uma linha (o casar à mão usa uma janela maior que a do casamento automático). */
export async function candidatesFor(tx: Executor, line: LineRow, windowDays = 3): Promise<MatchCandidate[]> {
  return candidatesFromPool(await loadCandidatePool(tx, [line], windowDays), line);
}

/**
 * Ocorrências em aberto (ou parciais) de séries da caixa da conta, com a conta
 * prevista igual à da conta (ou sem conta), com vencimento no intervalo.
 */
async function seriesRows(tx: Executor, accountId: string, from: string, to: string, entityId?: string): Promise<SeriesRow[]> {
  const result = await tx.execute(sql`
    SELECT t.id, t.direction, t.due_date, t.amount_cents, b.open_cents, t.description, e.name AS entity_name,
           t.recurrence_rule_id AS rule_id, t.occurrence, r.installments_total, t.contract_id, c.name AS contract_name,
           t.planned_account_id, ${TERMS_SQL}
      FROM titles t
      JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
      JOIN title_balances b ON b.title_id = t.id
      JOIN entities e ON e.id = t.entity_id
      LEFT JOIN contracts c ON c.id = t.contract_id
      JOIN financial_accounts a ON a.id = ${accountId}::uuid
     WHERE t.caixa_id = a.caixa_id AND (t.planned_account_id IS NULL OR t.planned_account_id = a.id)
       AND t.status IN ('open', 'partial') AND t.archived_at IS NULL AND b.open_cents > 0
       AND t.due_date BETWEEN ${from}::date AND ${to}::date
       ${entityId ? sql`AND t.entity_id = ${entityId}` : sql``}
     ORDER BY t.due_date, t.id`);
  return result.rows.map((raw) => {
    const r = camel<Record<string, unknown>>(raw);
    return {
      direction: r.direction as SeriesRow['direction'],
      occ: {
        titleId: String(r.id),
        ruleId: String(r.ruleId),
        contractId: (r.contractId as string | null) ?? null,
        contractName: (r.contractName as string | null) ?? null,
        occurrence: r.occurrence === null ? null : Number(r.occurrence),
        occurrencesTotal: r.installmentsTotal === null ? null : Number(r.installmentsTotal),
        description: String(r.description),
        entityName: (r.entityName as string | null) ?? null,
        dueDate: String(r.dueDate),
        amountCents: Number(r.amountCents),
        openCents: Number(r.openCents),
        plannedAccountId: (r.plannedAccountId as string | null) ?? null,
        terms: termsOf(raw as Parameters<typeof termsOf>[0]),
      },
    };
  });
}

/**
 * As ocorrências de série na direção da linha que batem pela regra da série
 * (seriesMatch: o mesmo mês ou a janela; exato, encargos, desconto, tolerância
 * ou parcial).
 */
function seriesFromRows(rows: SeriesRow[], line: LineRow): MatchCandidate[] {
  if (!line.financial_account_id) return [];
  const from = addDays(line.posted_on, -SERIES_PREFILTER_DAYS);
  const to = addDays(line.posted_on, SERIES_PREFILTER_DAYS);
  const direction = Number(line.amount_cents) < 0 ? 'payable' : 'receivable';
  const matchLine = {
    postedOn: line.posted_on,
    amountCents: Number(line.amount_cents),
    description: line.description,
    accountId: line.financial_account_id,
  };
  return rows
    .filter((r) => r.direction === direction && r.occ.dueDate >= from && r.occ.dueDate <= to)
    .map((r) => seriesMatch(matchLine, r.occ))
    .filter((c): c is MatchCandidate => c !== null);
}

async function seriesCandidates(tx: Executor, line: LineRow, entityId?: string): Promise<MatchCandidate[]> {
  if (!line.financial_account_id) return [];
  const from = addDays(line.posted_on, -SERIES_PREFILTER_DAYS);
  const to = addDays(line.posted_on, SERIES_PREFILTER_DAYS);
  return seriesFromRows(await seriesRows(tx, line.financial_account_id, from, to, entityId), line);
}

/**
 * "É o pagamento de…?" (spec 034): as ocorrências em aberto das séries da
 * conta (no cofre, o lançamento manual é o fato) que a regra de reconhecimento
 * aceita para um lançamento avulso na data e no valor, uma por série, da mais
 * provável à menos.
 */
export async function obligationMatches(
  ctx: ServiceContext,
  accountId: string,
  query: z.output<typeof obligationMatchQuery>,
): Promise<ObligationMatch[]> {
  const account = await getAccount(ctx, accountId);
  const line: LineRow = {
    id: '',
    posted_on: query.occurredOn,
    amount_cents: query.amountCents,
    description: '',
    financial_account_id: account.id,
    card_caixa_id: null,
  };
  const matchLine = { postedOn: query.occurredOn, amountCents: query.amountCents, description: '' };
  const candidates = pickSeriesOccurrences(matchLine, await seriesCandidates(ctx.db, line, query.entityId));
  return candidates
    .map((c) => ({ c, score: scoreCandidate(matchLine, c) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map(({ c }) => ({
      titleId: c.id,
      ruleId: c.series!.ruleId,
      description: c.description,
      occurrence: c.series!.occurrence,
      dueDate: c.series!.dueDate,
      openCents: c.series!.split.amountCents,
      contractId: c.series!.contractId,
      contractName: c.series!.contractName,
      split: c.series!.split,
    }));
}

/**
 * Casa as linhas novas do lote: conciliada (um movimento/item claro) ou
 * sugerida (confirmação em lote). Ocorrência de série com "baixar sem
 * confirmação" vira conciliada com a baixa já feita (auto_settled); na
 * fatura, a cobrança esperada com valor exato vira a compra ligada. O sino
 * avisa uma vez por lote quantas foram baixadas. Os candidatos vêm de uma
 * leitura só e os vínculos são gravados num UPDATE só (tarefa 139): fora a
 * baixa automática, o número de consultas não cresce com as linhas. O
 * `used` garante, como antes, que um movimento, título ou item vai para uma
 * linha só.
 */
export async function autoMatch(ctx: ServiceContext, tx: Tx, importId: string) {
  const lines = await tx.execute<LineRow>(sql`
    SELECT l.id, l.posted_on, l.amount_cents, l.description, l.financial_account_id, l.card_caixa_id, i.card_invoice_id
      FROM statement_lines l JOIN statement_imports i ON i.id = l.statement_import_id
     WHERE l.statement_import_id = ${importId} AND l.status = 'new'
     ORDER BY l.posted_on, l.line_number`);
  const first = lines.rows[0];
  if (!first) return { matched: 0, suggested: 0, autoSettled: 0, autoSettleFailed: 0 };
  // As sugestões em aberto da mesma conta (ou do mesmo cartão), pela coluna do alvo, que tem índice.
  const owner = first.card_caixa_id
    ? sql`card_caixa_id = ${first.card_caixa_id}::uuid`
    : sql`financial_account_id = ${first.financial_account_id}::uuid`;
  const pending = await tx.execute<{ ref: string }>(sql`
    SELECT coalesce(movement_id, title_id, card_invoice_item_id)::text AS ref FROM statement_lines
     WHERE ${owner} AND status = 'suggested'`);
  const used = new Set(pending.rows.map((r) => r.ref));
  const pool = await loadCandidatePool(tx, lines.rows, 3);
  const links: LineLink[] = [];
  let matched = 0;
  let suggested = 0;
  let autoSettled = 0;
  let autoSettleFailed = 0;
  for (const line of lines.rows) {
    const pick = pickMatch(
      { postedOn: line.posted_on, amountCents: Number(line.amount_cents), description: line.description },
      candidatesFromPool(pool, line),
      used,
    );
    if (!pick) continue;
    used.add(pick.candidate.id);
    if (pick.autoSettle) {
      const settled = await autoSettleLine(ctx, tx, importId, line, pick.candidate);
      if (settled === true) {
        autoSettled += 1;
        matched += 1;
        continue;
      }
      if (settled === 'failed') autoSettleFailed += 1;
    }
    // A cobrança esperada não tem lançamento para sugerir: a tela mostra "Lançar como cobrança de…".
    if (pick.candidate.kind === 'card_charge') continue;
    links.push({ id: line.id, status: pick.status, kind: pick.candidate.kind, ref: pick.candidate.id });
    if (pick.status === 'matched') matched += 1;
    else suggested += 1;
  }
  await linkLines(tx, links);
  if (autoSettled > 0) await notifyAutoSettled(ctx, tx, importId, autoSettled);
  return { matched, suggested, autoSettled, autoSettleFailed };
}

type LineLink = { id: string; status: 'matched' | 'suggested'; kind: 'movement' | 'title' | 'card_item'; ref: string };

/** Grava os vínculos do casamento automático (linhas novas) num UPDATE só. */
async function linkLines(tx: Tx, links: LineLink[]) {
  if (links.length === 0) return;
  await tx.execute(sql`
    UPDATE statement_lines l
       SET status = x.status,
           matched_at = CASE WHEN x.status = 'matched' THEN now() ELSE l.matched_at END,
           movement_id = CASE WHEN x.kind = 'movement' THEN x.ref ELSE l.movement_id END,
           title_id = CASE WHEN x.kind = 'title' THEN x.ref ELSE l.title_id END,
           card_invoice_item_id = CASE WHEN x.kind = 'card_item' THEN x.ref ELSE l.card_invoice_item_id END
      FROM json_to_recordset(${JSON.stringify(links)}::json) AS x(id uuid, status text, kind text, ref uuid)
     WHERE l.id = x.id`);
}

/**
 * A baixa sem confirmação de uma linha, num savepoint: na conta, a baixa
 * repartida da ocorrência; na fatura, a compra ligada à cobrança esperada. Se
 * o usuário não escreve na caixa, a linha fica como sugestão sem tentar; se o
 * lançamento falha, também, e o log da requisição registra o motivo (o código
 * do erro, sem valores; tarefa 136): devolve 'failed'.
 */
async function autoSettleLine(
  ctx: ServiceContext,
  tx: Tx,
  importId: string,
  line: LineRow,
  candidate: MatchCandidate,
): Promise<boolean | 'failed'> {
  try {
    if (candidate.kind === 'card_charge' && line.card_caixa_id && candidate.series) {
      if (!ctx.access.canWrite(line.card_caixa_id)) return false;
      await tx.transaction(async (sp) => {
        const created = await insertChargePurchase(ctx, sp, {
          cardCaixaId: line.card_caixa_id!,
          ruleId: candidate.series!.ruleId,
          occurrence: candidate.series!.occurrence!,
          purchasedOn: line.posted_on,
          amountCents: Math.abs(Number(line.amount_cents)),
        });
        await sp.execute(sql`
          UPDATE statement_lines SET status = 'matched', matched_at = now(), card_invoice_item_id = ${created.itemId}::uuid,
                 created_entry = 'purchase', auto_settled = true
           WHERE id = ${line.id}`);
        await sp.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        await sp.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      });
      return true;
    }
    const caixa = await tx.execute<{ caixa_id: string }>(
      sql`SELECT caixa_id FROM financial_accounts WHERE id = ${line.financial_account_id}::uuid`,
    );
    const caixaId = caixa.rows[0]?.caixa_id;
    if (!caixaId || !ctx.access.canWrite(caixaId)) return false;
    await tx.transaction(async (sp) => {
      const settled = await settleFromLine(
        ctx,
        sp,
        {
          id: line.id,
          caixaId,
          financialAccountId: line.financial_account_id,
          postedOn: line.posted_on,
          amountCents: Number(line.amount_cents),
        },
        candidate.id,
      );
      await sp.execute(sql`
        UPDATE statement_lines SET status = 'matched', matched_at = now(), movement_id = ${settled.movementId}::uuid,
               created_entry = ${settled.createdEntry}, auto_settled = true
         WHERE id = ${line.id}`);
      await sp.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await sp.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    });
    return true;
  } catch (error) {
    const { code, pgCode, constraint } = failureReason(error);
    ctx.log?.warn({ importId, lineId: line.id, code, pgCode, constraint }, 'baixa automática virou sugestão');
    return 'failed';
  }
}

/**
 * Sugestões "Lançar como cobrança de <obrigação> de <mês>" das linhas novas da
 * fatura (spec 034): cada linha com a cobrança esperada que a regra casa, sem
 * repetir a mesma ocorrência em duas linhas.
 */
export async function cardChargeSuggestions(
  db: Executor,
  cardCaixaId: string,
  lines: Pick<StatementLineRow, 'id' | 'postedOn' | 'amountCents' | 'description' | 'status'>[],
): Promise<Map<string, CardChargeSuggestion>> {
  const pending = lines.filter((l) => l.status === 'new' && l.amountCents < 0);
  const out = new Map<string, CardChargeSuggestion>();
  if (pending.length === 0) return out;
  const dates = pending.map((l) => l.postedOn).sort();
  const expected = await expectedCardOccurrences(db, cardCaixaId, addDays(dates[0]!, -76), addDays(dates.at(-1)!, 76));
  if (expected.length === 0) return out;
  const byId = new Map(expected.map((e) => [`${e.ruleId}:${e.occurrence}`, e]));
  const used = new Set<string>();
  for (const line of pending) {
    const candidates = expected.map((e) => cardChargeMatch(line, e)).filter((c): c is MatchCandidate => c !== null);
    const pick = pickMatch(line, candidates, used);
    if (!pick) continue;
    used.add(pick.candidate.id);
    out.set(line.id, toSuggestion(byId.get(pick.candidate.id)!));
  }
  return out;
}

async function notifyAutoSettled(ctx: ServiceContext, tx: Tx, importId: string, count: number) {
  const result = await tx.execute<{
    caixa_id: string;
    financial_account_id: string | null;
    card_caixa_id: string | null;
    name: string;
  }>(sql`
    SELECT coalesce(a.caixa_id, i.card_caixa_id) AS caixa_id, i.financial_account_id, i.card_caixa_id, coalesce(a.name, k.name) AS name
      FROM statement_imports i
      LEFT JOIN financial_accounts a ON a.id = i.financial_account_id
      LEFT JOIN caixas k ON k.id = i.card_caixa_id
     WHERE i.id = ${importId}`);
  const imp = result.rows[0];
  if (!imp) return;
  await createNotifications(tx, [
    {
      userId: ctx.access.actor.id,
      kind: 'system',
      title: t.statements.autoSettledTitle(count),
      body: t.statements.autoSettledBody(imp.name),
      link: importLink({
        id: importId,
        caixaId: imp.caixa_id,
        financialAccountId: imp.financial_account_id,
        cardCaixaId: imp.card_caixa_id,
      }),
      caixaId: imp.caixa_id,
      data: { importId, count },
      dedupKey: `auto_settled:${importId}`,
    },
  ]);
}

/* ---------------- leitura ---------------- */

const importSql = sql`
  SELECT b.statement_import_id AS id, b.financial_account_id, a.name AS account_name, b.card_caixa_id, i.card_invoice_id,
         coalesce(a.caixa_id, b.card_caixa_id) AS caixa_id, i.format, f.file_name, i.attachment_id,
         b.period_start, b.period_end, b.bank_balance_on, b.bank_balance_cents,
         -- Lote substituído (spec 031): fora da divergência.
         CASE WHEN i.superseded_by_import_id IS NULL THEN b.app_balance_cents END AS app_balance_cents,
         CASE WHEN i.superseded_by_import_id IS NULL THEN b.difference_cents END AS difference_cents,
         CASE WHEN i.superseded_by_import_id IS NULL THEN b.difference_cents - prev.difference_cents END AS interval_difference_cents,
         a.opening_date AS account_opening_date,
         b.lines AS line_count, b.matched_lines, b.suggested_lines, b.new_lines, b.ignored_lines, u.username AS imported_by, i.created_at,
         i.provisional,
         CASE WHEN i.superseded_by_import_id IS NOT NULL
              THEN json_build_object('id', i.superseded_by_import_id, 'fileName', sf.file_name, 'at', i.superseded_at) END AS superseded_by,
         coalesce((SELECT json_agg(json_build_object('id', x.id, 'fileName', xf.file_name) ORDER BY x.period_start)
                     FROM statement_imports x JOIN attachments xf ON xf.id = x.attachment_id
                    WHERE x.superseded_by_import_id = i.id), '[]'::json) AS supersedes,
         (SELECT count(*)::int FROM statement_lines pl JOIN statement_imports px ON px.id = pl.statement_import_id
           WHERE px.superseded_by_import_id = i.id AND pl.supersede_outcome = 'pending') AS supersede_pending
    FROM statement_import_balances b
    JOIN statement_imports i ON i.id = b.statement_import_id
    JOIN attachments f ON f.id = i.attachment_id
    LEFT JOIN financial_accounts a ON a.id = b.financial_account_id
    LEFT JOIN users u ON u.id = i.imported_by_user_id
    LEFT JOIN statement_imports si ON si.id = i.superseded_by_import_id
    LEFT JOIN attachments sf ON sf.id = si.attachment_id
    -- Divergência do intervalo (spec 009): a acumulada menos a do lote anterior com saldo, na ordem da data do saldo.
    LEFT JOIN LATERAL (
      SELECT pb.difference_cents
        FROM statement_import_balances pb
        JOIN statement_imports pi ON pi.id = pb.statement_import_id
       WHERE pb.financial_account_id = b.financial_account_id AND pb.bank_balance_on IS NOT NULL
         AND pi.superseded_by_import_id IS NULL
         AND (pb.bank_balance_on, pi.created_at) < (b.bank_balance_on, i.created_at)
       ORDER BY pb.bank_balance_on DESC, pi.created_at DESC
       LIMIT 1
    ) prev ON b.bank_balance_on IS NOT NULL`;

const toImport = (row: Record<string, unknown>): StatementImportSummary => {
  const r = camel<StatementImportSummary>(row);
  const interval = r.intervalDifferenceCents as number | string | null;
  const supersededBy = r.supersededBy ? { ...r.supersededBy, at: iso(r.supersededBy.at)! } : null;
  return {
    ...r,
    intervalDifferenceCents: interval === null ? null : Number(interval),
    createdAt: iso(r.createdAt)!,
    supersededBy,
    supersedePending: Number(r.supersedePending ?? 0),
  };
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
  // Fatura do cartão (spec 034): as linhas novas que são a cobrança esperada de uma obrigação.
  if (summary.cardCaixaId && lines.length > 0 && !summary.supersededBy) {
    const charges = await cardChargeSuggestions(ctx.db, summary.cardCaixaId, lines);
    for (const line of lines) {
      const charge = charges.get(line.id);
      if (charge) line.cardCharge = charge;
    }
  }
  return { ...summary, canWrite: ctx.access.canWrite(summary.caixaId), lines };
}

/** Lote substituído (spec 031) é somente leitura. */
export function assertNotSuperseded(detail: { supersededBy: unknown }) {
  if (detail.supersededBy) throw unprocessable(t.errors.statementImportSuperseded, 'statement_import_superseded');
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
    SELECT l.id, l.statement_import_id AS import_id, l.financial_account_id AS line_account_id, l.line_number, l.posted_on, l.amount_cents, l.description, l.fitid, l.status, l.movement_id, l.title_id,
           l.card_invoice_item_id, l.created_entry, l.auto_settled, l.entity_id, e.name AS entity_name, l.category_id, c.name AS category_name,
           coalesce(c.color_slot, pc.color_slot) AS category_color_slot, l.classification_source, l.classification_rule_id,
           l.supersede_outcome, l.superseded_by_line_id,
           CASE WHEN sg.id IS NOT NULL THEN json_build_object('lineId', sg.id, 'reason', l.supersede_suggestion_reason,
             'postedOn', sg.posted_on, 'description', sg.description) END AS supersede_suggestion,
           CASE
             WHEN l.movement_id IS NOT NULL THEN json_build_object('kind', 'movement', 'date', m.occurred_on,
               'description', coalesce(m.description, mt.description, ''), 'amountCents', m.amount_cents, 'entityName', me.name)
             WHEN l.title_id IS NOT NULL THEN json_build_object('kind', 'title', 'date', t.due_date, 'description', t.description,
               'amountCents', CASE t.direction WHEN 'payable' THEN -tb.open_cents ELSE tb.open_cents END, 'entityName', te.name,
               -- Ocorrência de série (specs 033 e 034): o que a repartição precisa.
               'seriesRef', CASE WHEN sr.id IS NOT NULL THEN json_build_object('ruleId', sr.id, 'contractId', ct.id, 'contractName', ct.name,
                 'occurrence', t.occurrence, 'occurrencesTotal', sr.installments_total, 'dueDate', t.due_date,
                 'amountCents', t.amount_cents, 'openCents', tb.open_cents, 'plannedAccountId', t.planned_account_id,
                 'auto_settle', sr.auto_settle, 'late_fee_percent', sr.late_fee_percent,
                 'interest_month_percent', sr.interest_month_percent, 'early_discount_percent', sr.early_discount_percent,
                 'tolerance_cents', sr.tolerance_cents, 'match_window_days', sr.match_window_days) END)
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
      LEFT JOIN recurrence_rules sr ON sr.id = t.recurrence_rule_id
      LEFT JOIN contracts ct ON ct.id = t.contract_id
      LEFT JOIN card_invoice_items ci ON ci.id = l.card_invoice_item_id
      LEFT JOIN card_purchases p ON p.id = ci.card_purchase_id
      LEFT JOIN entities pe ON pe.id = p.entity_id
      LEFT JOIN statement_lines sg ON sg.id = l.supersede_suggested_line_id
     WHERE ${where}
     ORDER BY ${order}${limit}`);
  return result.rows.map((row) => {
    const { lineAccountId, ...r } = camel<StatementLineRow & { lineAccountId: string | null }>(row);
    const target = r.target as (StatementLineRow['target'] & { amountCents: number | string; seriesRef?: SeriesRef | null }) | null;
    if (!target) return { ...r, target: null };
    const { seriesRef, ...rest } = target;
    const series = seriesRef && r.status === 'suggested' ? suggestionOf({ ...r, lineAccountId }, seriesRef) : null;
    return { ...r, target: { ...rest, amountCents: Number(target.amountCents), ...(series ? { series } : {}) } };
  });
}

type SeriesRef = Parameters<typeof termsOf>[0] & {
  ruleId: string;
  contractId: string | null;
  contractName: string | null;
  occurrence: number | null;
  occurrencesTotal: number | null;
  dueDate: string;
  amountCents: number | string;
  openCents: number | string;
  plannedAccountId: string | null;
};

/** A repartição que a linha sugerida faria na ocorrência de série (specs 033 e 034). */
function suggestionOf(line: StatementLineRow & { lineAccountId?: string | null }, ref: SeriesRef): SeriesCandidateInfo | null {
  const terms = termsOf(ref);
  const split = splitSettlement(
    Math.abs(line.amountCents),
    { dueDate: ref.dueDate, amountCents: Number(ref.amountCents), openCents: Number(ref.openCents) },
    terms,
    line.postedOn,
  );
  if (!split) return null;
  return {
    ruleId: ref.ruleId,
    contractId: ref.contractId,
    contractName: ref.contractName,
    occurrence: ref.occurrence === null ? null : Number(ref.occurrence),
    occurrencesTotal: ref.occurrencesTotal === null ? null : Number(ref.occurrencesTotal),
    dueDate: ref.dueDate,
    sameAccount: !!line.lineAccountId && ref.plannedAccountId === line.lineAccountId,
    autoSettle: terms.autoSettle,
    split,
  };
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
  assertNotSuperseded(detail);
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
    const content = Buffer.from(file!.content);
    const parsed = await parseStatementFile(ctx.db, target, content, {
      mappingId: imp?.csvMappingId ?? undefined,
      ofxStatement: await importedOfxStatement(ctx, id, content),
    });
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

/**
 * De um OFX com várias contas, o extrato que este lote importou: o que tem
 * mais linhas no lote (pela chave de deduplicação). Um só extrato: undefined.
 */
async function importedOfxStatement(ctx: ServiceContext, importId: string, content: Buffer): Promise<number | undefined> {
  const text = decodeStatementFile(content);
  if (!looksLikeOfx(text)) return undefined;
  const statements = readOfxStatements(text);
  if (statements.length < 2) return undefined;
  const result = await ctx.db.execute<{ dedup_hash: string }>(
    sql`SELECT dedup_hash FROM statement_lines WHERE statement_import_id = ${importId}::uuid`,
  );
  const mine = new Set(result.rows.map((r) => r.dedup_hash));
  const overlap = statements.map((st) => dedupHashes(ofxLines(st)).filter((h) => mine.has(h)).length);
  return overlap.indexOf(Math.max(...overlap)) + 1;
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
  // O substituído guarda o histórico da troca, e o substituto é referenciado por ele (spec 031).
  assertNotSuperseded(detail);
  if (detail.supersedes.length > 0) throw unprocessable(t.errors.statementImportSupersedes, 'statement_import_supersedes');
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
  assertNotSuperseded(detail);
  await withTx(ctx, (tx) => autoMatch(ctx, tx, id));
  return getImport(ctx, id);
}
