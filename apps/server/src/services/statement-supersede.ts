import type { Executor, Tx } from '@moneyflow/db';
import {
  diffDays,
  formatBRL,
  pairSupersedeLines,
  periodsOverlap,
  type StatementLineRow,
  SUPERSEDE_SUGGESTION_MAX_DAYS,
  type SupersedeItem,
  type SupersedeOutcome,
  type SupersedeResolveResult,
  type SupersedeResult,
  type supersedeResolveItem,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { extractJson } from '../agents/flows';
import type { ServiceContext } from '../context';
import { AppError, notFound, translateDbError, unprocessable } from '../errors';
import { assertCanStartRun } from './ai-budgets';
import { flowAgentId } from './ai-flows';
import { createConversation, sendMessage } from './conversations';
import { lockImport } from './reconcile-recipes';
import { deleteCreatedEntry } from './reconciliation';
import { assertNotSuperseded, getImport, listLines } from './statements';
import { withTx } from './tx';

/*
 * Lote provisório e a troca pelo consolidado (spec 031). O provisório é um
 * extrato parcial do mês; o consolidado do banco o substitui numa transação:
 * casa as linhas pela regra fixa (pairSupersedeLines), passa as conciliações
 * para as linhas do consolidado MUDANDO O VÍNCULO (o lançamento fica, nada é
 * excluído nem lançado de novo) e deixa as conciliadas sem par como sobras
 * pendentes, que o usuário casa, mantém ou exclui (com sugestão da IA).
 */

type ImportRow = {
  id: string;
  financial_account_id: string | null;
  provisional: boolean;
  superseded_by_import_id: string | null;
  period_start: string;
  period_end: string;
  file_name: string;
};

async function loadImportRow(db: Executor, id: string): Promise<ImportRow | null> {
  const result = await db.execute<ImportRow>(sql`
    SELECT i.id, i.financial_account_id, i.provisional, i.superseded_by_import_id, i.period_start::text, i.period_end::text,
           f.file_name
      FROM statement_imports i JOIN attachments f ON f.id = i.attachment_id
     WHERE i.id = ${id}`);
  return result.rows[0] ?? null;
}

/** Provisórios ativos da conta (não substituídos), opcionalmente só os sobrepostos ao período. */
export async function activeProvisionals(
  db: Executor,
  accountId: string,
  period?: { periodStart: string; periodEnd: string },
  excludeId?: string,
) {
  const result = await db.execute<{ id: string; file_name: string; period_start: string; period_end: string }>(sql`
    SELECT i.id, f.file_name, i.period_start::text, i.period_end::text
      FROM statement_imports i JOIN attachments f ON f.id = i.attachment_id
     WHERE i.financial_account_id = ${accountId} AND i.provisional AND i.superseded_by_import_id IS NULL
       ${excludeId ? sql`AND i.id <> ${excludeId}` : sql``}
     ORDER BY i.period_start, i.created_at`);
  return result.rows
    .map((r) => ({ id: r.id, fileName: r.file_name, periodStart: r.period_start, periodEnd: r.period_end }))
    .filter((r) => !period || periodsOverlap(r, period));
}

/** Marca ou desmarca o lote como provisório. As regras (conta, mês fechado, sobreposição, dedup) são do banco. */
export async function setProvisional(ctx: ServiceContext, id: string, provisional: boolean) {
  const detail = await getImport(ctx, id, false);
  ctx.access.assertWrite(detail.caixaId);
  assertNotSuperseded(detail);
  if (!detail.financialAccountId) throw unprocessable(t.errors.statementProvisionalAccountOnly, 'statement_provisional_account_only');
  try {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE statement_imports SET provisional = ${provisional} WHERE id = ${id}`));
  } catch (error) {
    const translated = translateDbError(error);
    if (translated?.code === 'statement_lines_account_dedup_key')
      throw new AppError(409, 'statement_provisional_duplicated', t.errors.statementProvisionalDuplicated);
    throw error;
  }
  return getImport(ctx, id);
}

/* ---------------- plano da troca ---------------- */

type ProvLine = {
  id: string;
  posted_on: string;
  amount_cents: number;
  description: string;
  status: string;
  movement_id: string | null;
  created_entry: string | null;
  entity_id: string | null;
  category_id: string | null;
  classification_source: string | null;
};
type ConsLine = Pick<ProvLine, 'id' | 'posted_on' | 'amount_cents' | 'description' | 'status' | 'classification_source'>;

type PlanItem = { p: ProvLine; c: ConsLine | null; outcome: SupersedeOutcome; reason?: SupersedeItem['reason'] };
type Plan = { items: PlanItem[]; leftover: ConsLine[] };

const asSupersede = (l: { id: string; posted_on: string; amount_cents: number; description: string }) => ({
  id: l.id,
  postedOn: l.posted_on,
  amountCents: Number(l.amount_cents),
  description: l.description,
});

/** Casamento fixo e o desfecho de cada linha do provisório (spec 031, tabela "O que acontece com cada linha"). */
export function planSupersede(prov: ProvLine[], cons: ConsLine[]): Plan {
  const pairs = pairSupersedeLines(prov.map(asSupersede), cons.map(asSupersede));
  const byId = new Map(cons.map((c) => [c.id, c]));
  const used = new Set<string>();
  const items: PlanItem[] = prov.map((p) => {
    const pairId = pairs.get(p.id);
    const c = pairId ? byId.get(pairId)! : null;
    if (p.status === 'matched') {
      if (c && (c.status === 'new' || c.status === 'suggested')) {
        used.add(c.id);
        return { p, c, outcome: 'transferred' };
      }
      return { p, c: null, outcome: 'pending', reason: c ? 'consolidated_taken' : 'no_pair' };
    }
    if (c) {
      used.add(c.id);
      return { p, c, outcome: 'paired' };
    }
    return { p, c: null, outcome: 'dropped' };
  });
  return { items, leftover: cons.filter((c) => !used.has(c.id)) };
}

function planResult(plan: Plan, consolidatedImportId: string, provisionalImportIds: string[], dryRun: boolean): SupersedeResult {
  const item = (i: PlanItem): SupersedeItem => ({
    provisionalLineId: i.p.id,
    consolidatedLineId: i.c?.id ?? null,
    postedOn: i.p.posted_on,
    amountCents: Number(i.p.amount_cents),
    description: i.p.description,
    ...(i.reason ? { reason: i.reason } : {}),
  });
  const of = (outcome: SupersedeOutcome) => plan.items.filter((i) => i.outcome === outcome).map(item);
  return {
    consolidatedImportId,
    provisionalImportIds,
    dryRun,
    transferred: of('transferred'),
    paired: of('paired'),
    dropped: of('dropped'),
    pending: of('pending'),
    consolidatedLeftover: plan.leftover.map(asSupersede),
  };
}

async function provisionalLines(db: Executor, importIds: string[]): Promise<ProvLine[]> {
  const result = await db.execute<ProvLine>(sql`
    SELECT id, posted_on::text, amount_cents, description, status, movement_id, created_entry, entity_id, category_id,
           classification_source
      FROM statement_lines WHERE statement_import_id = ANY (${uuidArray(importIds)})
     ORDER BY posted_on, line_number`);
  return result.rows;
}

/** Linhas do substituto que ainda não ficaram no lugar de uma linha provisória. */
async function consolidatedLines(db: Executor, importId: string): Promise<ConsLine[]> {
  const result = await db.execute<ConsLine>(sql`
    SELECT l.id, l.posted_on::text, l.amount_cents, l.description, l.status, l.classification_source
      FROM statement_lines l
     WHERE l.statement_import_id = ${importId}
       AND NOT EXISTS (SELECT 1 FROM statement_lines x WHERE x.superseded_by_line_id = l.id)
     ORDER BY l.posted_on, l.line_number`);
  return result.rows;
}

const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * Valida os provisórios escolhidos (ou, omitidos, os ativos da conta sobrepostos
 * ao substituto) e devolve os ids.
 */
async function resolveProvisionals(db: Executor, substitute: ImportRow, requested?: string[]): Promise<string[]> {
  if (!substitute.financial_account_id) throw unprocessable(t.errors.statementProvisionalAccountOnly, 'statement_provisional_account_only');
  if (substitute.superseded_by_import_id) throw unprocessable(t.errors.statementImportSuperseded, 'statement_import_superseded');
  const active = await activeProvisionals(db, substitute.financial_account_id, undefined, substitute.id);
  if (!requested?.length) {
    const overlapping = active.filter((p) => periodsOverlap(p, { periodStart: substitute.period_start, periodEnd: substitute.period_end }));
    if (overlapping.length === 0) throw unprocessable(t.errors.supersedeNothing, 'supersede_nothing');
    return overlapping.map((p) => p.id);
  }
  const ok = new Set(active.map((p) => p.id));
  if (requested.some((id) => !ok.has(id))) throw unprocessable(t.errors.supersedeInvalidTarget, 'supersede_invalid_target');
  return [...new Set(requested)];
}

/**
 * A troca dentro da transação (também usada pela importação). Ordem: marca os
 * provisórios como substituídos, solta as linhas deles (a conciliação sai da
 * provisória antes de entrar na consolidada: o movimento só casa com uma linha)
 * e casa as consolidadas com os mesmos movimentos.
 */
export async function supersedeInTx(
  tx: Executor,
  substituteId: string,
  requested: string[] | undefined,
  opts: { dryRun?: boolean } = {},
): Promise<SupersedeResult> {
  const substitute = await loadImportRow(tx, substituteId);
  if (!substitute) throw notFound();
  const provisionalIds = await resolveProvisionals(tx, substitute, requested);
  const plan = planSupersede(await provisionalLines(tx, provisionalIds), await consolidatedLines(tx, substituteId));
  const result = planResult(plan, substituteId, provisionalIds, Boolean(opts.dryRun));
  if (opts.dryRun) return result;

  await tx.execute(sql`
    UPDATE statement_imports SET superseded_by_import_id = ${substituteId}, superseded_at = now()
     WHERE id = ANY (${uuidArray(provisionalIds)})`);
  for (const outcome of ['transferred', 'paired', 'dropped'] as const) {
    for (const item of plan.items.filter((i) => i.outcome === outcome)) {
      await tx.execute(sql`
        UPDATE statement_lines
           SET status = 'superseded', matched_at = NULL, movement_id = NULL, title_id = NULL, card_invoice_item_id = NULL,
               created_entry = NULL, supersede_outcome = ${outcome}, superseded_by_line_id = ${item.c?.id ?? null}
         WHERE id = ${item.p.id}`);
    }
  }
  const pending = plan.items.filter((i) => i.outcome === 'pending').map((i) => i.p.id);
  if (pending.length > 0) {
    await tx.execute(sql`UPDATE statement_lines SET supersede_outcome = 'pending' WHERE id = ANY (${uuidArray(pending)})`);
  }
  for (const { p, c, outcome } of plan.items) {
    if (!c) continue;
    if (outcome === 'transferred') {
      await transferTo(tx, c.id, p);
    } else if (p.status === 'ignored' && c.status === 'new') {
      await tx.execute(sql`
        UPDATE statement_lines SET status = 'ignored', movement_id = NULL, title_id = NULL, card_invoice_item_id = NULL
         WHERE id = ${c.id}`);
    } else if (p.classification_source === 'user' && c.classification_source !== 'user' && (p.entity_id || p.category_id)) {
      await tx.execute(sql`
        UPDATE statement_lines
           SET entity_id = ${p.entity_id}, category_id = ${p.category_id}, classification_source = 'user', classification_rule_id = NULL
         WHERE id = ${c.id}`);
    }
  }
  return result;
}

/** A linha do consolidado passa a conciliada com o movimento da provisória, com a mesma marca created_entry. */
async function transferTo(tx: Executor, consolidatedLineId: string, p: Pick<ProvLine, 'movement_id' | 'created_entry'>) {
  await tx.execute(sql`
    UPDATE statement_lines
       SET status = 'matched', matched_at = now(), movement_id = ${p.movement_id}, title_id = NULL, card_invoice_item_id = NULL,
           created_entry = ${p.created_entry}
     WHERE id = ${consolidatedLineId}`);
}

/** Toma o lock de cada lote e recusa (409) com conciliação com IA ou receita em andamento em algum deles. */
export async function lockImports(tx: Executor, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    if (await lockImport(tx, id)) throw new AppError(409, 'run_active', t.agents.errors.runActive);
  }
}

/** Substitui os provisórios por este lote (spec 031); `dryRun` = a prévia, sem gravar. */
export async function supersedeImports(
  ctx: ServiceContext,
  importId: string,
  input: { provisionalImportIds?: string[]; dryRun?: boolean },
): Promise<SupersedeResult> {
  const detail = await getImport(ctx, importId, false);
  ctx.access.assertWrite(detail.caixaId);
  assertNotSuperseded(detail);
  if (input.dryRun) return supersedeInTx(ctx.db, importId, input.provisionalImportIds, { dryRun: true });
  return withTx(ctx, async (tx) => {
    const substitute = await loadImportRow(tx, importId);
    const ids = await resolveProvisionals(tx, substitute!, input.provisionalImportIds);
    await lockImports(tx, [importId, ...ids]);
    return supersedeInTx(tx, importId, ids);
  });
}

/**
 * Prévia da troca na importação (antes de gravar): as linhas do arquivo entram
 * como novas (o casamento automático ainda não rodou).
 */
export async function previewSupersedeForFile(
  db: Executor,
  provisionalIds: string[],
  lines: { postedOn: string; amountCents: number; description: string }[],
): Promise<SupersedeResult> {
  const cons = lines.map((l, i) => ({
    id: `file-${i + 1}`,
    posted_on: l.postedOn,
    amount_cents: l.amountCents,
    description: l.description,
    status: 'new',
    classification_source: null,
  }));
  return planResult(planSupersede(await provisionalLines(db, provisionalIds), cons), '', provisionalIds, true);
}

/* ---------------- sobras do provisório ---------------- */

/** As linhas dos provisórios substituídos por este lote, com o desfecho (filtro opcional). */
export async function listSupersededLines(ctx: ServiceContext, importId: string, outcome?: SupersedeOutcome): Promise<StatementLineRow[]> {
  await getImport(ctx, importId, false);
  return listLines(
    ctx.db,
    sql`l.statement_import_id IN (SELECT id FROM statement_imports WHERE superseded_by_import_id = ${importId})
        ${outcome ? sql`AND l.supersede_outcome = ${outcome}` : sql``}`,
  );
}

type PendingLine = ProvLine & { import_id: string; caixa_id: string; card_invoice_item_id: string | null };

async function loadPending(tx: Tx, importId: string, lineId: string): Promise<PendingLine> {
  const result = await tx.execute<PendingLine>(sql`
    SELECT l.id, l.statement_import_id AS import_id, l.posted_on::text, l.amount_cents, l.description, l.status, l.movement_id,
           l.card_invoice_item_id, l.created_entry, l.entity_id, l.category_id, l.classification_source, a.caixa_id
      FROM statement_lines l
      JOIN statement_imports i ON i.id = l.statement_import_id
      JOIN financial_accounts a ON a.id = l.financial_account_id
     WHERE l.id = ${lineId} AND i.superseded_by_import_id = ${importId} AND l.supersede_outcome = 'pending'
       FOR UPDATE OF l`);
  const line = result.rows[0];
  if (!line) throw unprocessable(t.errors.supersedeLineNotPending, 'supersede_line_not_pending');
  return line;
}

/** Sai de pending: a linha solta o vínculo (e a sugestão) com o desfecho dado. */
async function closePending(tx: Executor, lineId: string, outcome: 'transferred' | 'kept' | 'entry_deleted', pairId: string | null) {
  await tx.execute(sql`
    UPDATE statement_lines
       SET status = 'superseded', matched_at = NULL, movement_id = NULL, title_id = NULL, card_invoice_item_id = NULL,
           created_entry = NULL, supersede_outcome = ${outcome}, superseded_by_line_id = ${pairId},
           supersede_suggested_line_id = NULL, supersede_suggestion_reason = NULL
     WHERE id = ${lineId}`);
}

async function pairPending(tx: Tx, importId: string, line: PendingLine, consolidatedLineId: string) {
  const result = await tx.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM statement_lines c
     WHERE c.id = ${consolidatedLineId} AND c.statement_import_id = ${importId} AND c.amount_cents = ${line.amount_cents}
       AND c.status IN ('new', 'suggested')
       AND NOT EXISTS (SELECT 1 FROM statement_lines x WHERE x.superseded_by_line_id = c.id)
       FOR UPDATE OF c`);
  if (!result.rows[0]) throw unprocessable(t.errors.supersedePairInvalid, 'supersede_pair_invalid');
  await closePending(tx, line.id, 'transferred', consolidatedLineId);
  await transferTo(tx, consolidatedLineId, line);
}

async function resolveOne(ctx: ServiceContext, tx: Tx, importId: string, item: z.output<typeof supersedeResolveItem>) {
  const line = await loadPending(tx, importId, item.lineId);
  ctx.access.assertWrite(line.caixa_id);
  if (item.action === 'pair') return pairPending(tx, importId, line, item.consolidatedLineId!);
  if (item.action === 'keep') return closePending(tx, line.id, 'kept', null);
  if (!line.created_entry) throw unprocessable(t.errors.lineEntryNotCreated, 'line_entry_not_created');
  await closePending(tx, line.id, 'entry_deleted', null);
  await deleteCreatedEntry(ctx, tx, {
    createdEntry: line.created_entry as never,
    movementId: line.movement_id,
    cardInvoiceItemId: line.card_invoice_item_id,
  });
}

/** Decide as sobras pendentes; cada linha num savepoint (uma falha volta com o motivo e não derruba as outras). */
export async function resolveSupersededLines(
  ctx: ServiceContext,
  importId: string,
  items: z.output<typeof supersedeResolveItem>[],
): Promise<SupersedeResolveResult> {
  const detail = await getImport(ctx, importId, false);
  ctx.access.assertWrite(detail.caixaId);
  const failed: SupersedeResolveResult['failed'] = [];
  let done = 0;
  await withTx(ctx, async (tx) => {
    for (const item of items) {
      try {
        await tx.transaction(async (sp) => {
          await resolveOne(ctx, sp, importId, item);
          await sp.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          await sp.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        });
        done += 1;
      } catch (error) {
        const message = translateDbError(error)?.message ?? (error instanceof Error ? error.message : String(error));
        failed.push({ lineId: item.lineId, message });
      }
    }
  });
  return { done, failed };
}

/* ---------------- sugestão de pares pela IA ---------------- */

/**
 * "Sugerir pares com IA" (spec 031): um fluxo JSON (supersede_pairs) do agente
 * dos fluxos com as sobras pendentes e as linhas do consolidado sem par de
 * mesmo valor; o resultado vira sugestão na linha pendente (applySupersedePairs).
 */
export async function suggestSupersedePairs(ctx: ServiceContext, importId: string) {
  const detail = await getImport(ctx, importId, false);
  ctx.access.assertWrite(detail.caixaId);
  const pending = await ctx.db.execute<{
    id: string;
    posted_on: string;
    amount_cents: number;
    description: string;
    entity_name: string | null;
    category_name: string | null;
    entry_description: string | null;
  }>(sql`
    SELECT l.id, l.posted_on::text, l.amount_cents, l.description, e.name AS entity_name, c.name AS category_name,
           coalesce(m.description, t.description) AS entry_description
      FROM statement_lines l
      JOIN statement_imports i ON i.id = l.statement_import_id
      LEFT JOIN movements m ON m.id = l.movement_id
      LEFT JOIN settlements s ON s.id = m.settlement_id
      LEFT JOIN titles t ON t.id = s.title_id
      LEFT JOIN entities e ON e.id = coalesce(m.entity_id, t.entity_id)
      LEFT JOIN categories c ON c.id = coalesce(m.category_id, t.category_id)
     WHERE i.superseded_by_import_id = ${importId} AND l.supersede_outcome = 'pending'
     ORDER BY l.posted_on, l.line_number LIMIT 200`);
  const amounts = [...new Set(pending.rows.map((r) => Number(r.amount_cents)))];
  const free = amounts.length
    ? await ctx.db.execute<{ id: string; posted_on: string; amount_cents: number; description: string }>(sql`
        SELECT l.id, l.posted_on::text, l.amount_cents, l.description FROM statement_lines l
         WHERE l.statement_import_id = ${importId} AND l.status IN ('new', 'suggested')
           AND l.amount_cents = ANY (${`{${amounts.join(',')}}`}::bigint[])
           AND NOT EXISTS (SELECT 1 FROM statement_lines x WHERE x.superseded_by_line_id = l.id)
         ORDER BY l.posted_on, l.line_number LIMIT 400`)
    : { rows: [] };
  const freeAmounts = new Set(free.rows.map((r) => Number(r.amount_cents)));
  const lines = pending.rows.filter((r) => freeAmounts.has(Number(r.amount_cents)));
  if (lines.length === 0) throw unprocessable(t.errors.supersedeNothingToSuggest, 'supersede_nothing_to_suggest');
  const agentId = await flowAgentId(ctx);
  if (!agentId) throw new AppError(501, 'ai_unavailable', t.agents.errors.providerMissing);
  await assertCanStartRun(ctx, agentId, true);

  const payload = {
    provisional: lines.map((r) => ({
      lineId: r.id,
      date: r.posted_on,
      amount: formatBRL(Number(r.amount_cents)),
      description: r.description,
      entry: { entity: r.entity_name, category: r.category_name, description: r.entry_description },
    })),
    consolidated: free.rows.map((r) => ({
      lineId: r.id,
      date: r.posted_on,
      amount: formatBRL(Number(r.amount_cents)),
      description: r.description,
    })),
  };
  const conversation = await createConversation(
    ctx,
    { agentId, title: t.agents.flows.supersedeConversation(detail.fileName).slice(0, 200) },
    {
      purpose: 'supersede_pairs',
      screenContext: { importId, lineIds: lines.map((r) => r.id), consolidatedLineIds: free.rows.map((r) => r.id) },
      archived: true,
    },
  );
  const sent = await sendMessage(ctx, conversation.id, {
    text: `Proponha os pares entre as sobras do extrato provisório e as linhas do consolidado ${detail.fileName}:\n${JSON.stringify(payload)}`,
    attachmentIds: [],
  });
  return { queued: true, runId: sent.run.id, lines: lines.length };
}

/**
 * Aplica a resposta do fluxo supersede_pairs: só o par de mesmo valor, data a
 * até 7 dias, linhas ainda elegíveis e cada uma uma vez; o resto é descartado.
 */
export async function applySupersedePairs(ctx: ServiceContext, screen: Record<string, unknown>, text: string) {
  const importId = typeof screen.importId === 'string' ? screen.importId : null;
  if (!importId) return;
  const allowedProv = new Set(Array.isArray(screen.lineIds) ? (screen.lineIds as string[]) : []);
  const allowedCons = new Set(Array.isArray(screen.consolidatedLineIds) ? (screen.consolidatedLineIds as string[]) : []);
  const parsed = extractJson(text) as { pairs?: { provisionalLineId?: unknown; consolidatedLineId?: unknown; reason?: unknown }[] } | null;
  const proposed = (parsed?.pairs ?? []).filter(
    (p): p is { provisionalLineId: string; consolidatedLineId: string; reason?: unknown } =>
      typeof p.provisionalLineId === 'string' &&
      typeof p.consolidatedLineId === 'string' &&
      allowedProv.has(p.provisionalLineId) &&
      allowedCons.has(p.consolidatedLineId),
  );
  if (proposed.length === 0) return;
  const ids = [...new Set(proposed.flatMap((p) => [p.provisionalLineId, p.consolidatedLineId]))];
  const rows = await ctx.db.execute<{
    id: string;
    statement_import_id: string;
    posted_on: string;
    amount_cents: number;
    status: string;
    supersede_outcome: string | null;
    taken: boolean;
    superseded_by: string | null;
  }>(sql`
    SELECT l.id, l.statement_import_id, l.posted_on::text, l.amount_cents, l.status, l.supersede_outcome,
           EXISTS (SELECT 1 FROM statement_lines x WHERE x.superseded_by_line_id = l.id) AS taken, i.superseded_by_import_id AS superseded_by
      FROM statement_lines l JOIN statement_imports i ON i.id = l.statement_import_id
     WHERE l.id = ANY (${uuidArray(ids)})`);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const usedProv = new Set<string>();
  const usedCons = new Set<string>();
  const accepted: { provId: string; consId: string; reason: string | null }[] = [];
  for (const pair of proposed) {
    const p = byId.get(pair.provisionalLineId);
    const c = byId.get(pair.consolidatedLineId);
    if (!p || !c || usedProv.has(p.id) || usedCons.has(c.id)) continue;
    if (p.superseded_by !== importId || p.supersede_outcome !== 'pending') continue;
    if (c.statement_import_id !== importId || c.taken || (c.status !== 'new' && c.status !== 'suggested')) continue;
    if (Number(p.amount_cents) !== Number(c.amount_cents)) continue;
    if (Math.abs(diffDays(p.posted_on, c.posted_on)) > SUPERSEDE_SUGGESTION_MAX_DAYS) continue;
    usedProv.add(p.id);
    usedCons.add(c.id);
    accepted.push({ provId: p.id, consId: c.id, reason: typeof pair.reason === 'string' ? pair.reason.slice(0, 500) : null });
  }
  if (accepted.length === 0) return;
  await withTx(ctx, async (tx) => {
    for (const a of accepted) {
      await tx.execute(sql`
        UPDATE statement_lines SET supersede_suggested_line_id = ${a.consId}, supersede_suggestion_reason = ${a.reason}
         WHERE id = ${a.provId} AND supersede_outcome = 'pending'`);
    }
  });
}

/** Aprova (casa com o par sugerido) ou descarta as sugestões da IA nas sobras. */
export async function decideSupersedeSuggestions(
  ctx: ServiceContext,
  importId: string,
  lineIds: string[],
  decision: 'approve' | 'reject',
): Promise<SupersedeResolveResult> {
  const detail = await getImport(ctx, importId, false);
  ctx.access.assertWrite(detail.caixaId);
  const result = await ctx.db.execute<{ id: string; suggested: string | null }>(sql`
    SELECT l.id, l.supersede_suggested_line_id AS suggested FROM statement_lines l
      JOIN statement_imports i ON i.id = l.statement_import_id
     WHERE l.id = ANY (${uuidArray(lineIds)}) AND i.superseded_by_import_id = ${importId}`);
  const suggested = new Map(result.rows.map((r) => [r.id, r.suggested]));
  const missing = lineIds.filter((id) => !suggested.get(id));
  const failed = missing.map((lineId) => ({ lineId, message: t.errors.supersedeNoSuggestion }));
  const valid = lineIds.filter((id) => suggested.get(id));
  if (valid.length === 0) return { done: 0, failed };
  if (decision === 'reject') {
    await withTx(ctx, (tx) =>
      tx.execute(sql`
        UPDATE statement_lines SET supersede_suggested_line_id = NULL, supersede_suggestion_reason = NULL
         WHERE id = ANY (${uuidArray(valid)})`),
    );
    return { done: valid.length, failed };
  }
  const resolved = await resolveSupersededLines(
    ctx,
    importId,
    valid.map((lineId) => ({ lineId, action: 'pair' as const, consolidatedLineId: suggested.get(lineId)! })),
  );
  return { done: resolved.done, failed: [...failed, ...resolved.failed] };
}
