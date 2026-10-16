import { type Database, type Executor, type Tx, userColumns, users } from '@moneyflow/db';
import {
  formatDate,
  type ImportRecipeDto,
  type ImportRecipesDto,
  type RecipeVariableValues,
  type ReconcileRecipeDto,
  type ReconcileRecipeRunDto,
  type ReconcileRecipeRunResult,
  type ReconcileRecipeTargetDto,
  type reconcileRecipeCreateInput,
  type reconcileRecipeListQuery,
  type reconcileRecipeUpdateInput,
  renderRecipeVariables,
  t,
  volatilePromptValues,
} from '@moneyflow/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { loadUserAiSettings } from '../agents/prompt';
import { appendEvent, insertMessage } from '../agents/store';
import { type Access, type Actor, loadAccess } from '../authz/access';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { AppError, forbidden, notFound, translateDbError, unprocessable } from '../errors';
import { assertCanStartRun, assertRunRate, exceededBudget } from './ai-budgets';
import { getImport } from './statements';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Receitas de conciliação (spec 030): instrução reutilizável com o agente
 * responsável, rodada sobre um lote de extrato numa sessão nova
 * (purpose reconcile_statement, screen_context { importId, recipeId, lineIds }).
 *  - Dona: uma caixa (quem escreve edita; quem lê vê) ou global (só o admin edita; todos veem).
 *  - Play (runRecipe): quem escreve na caixa do lote; uma execução de conciliação por lote, conferida com o
 *    lock do lote (ai_reconcile_import_lock + ai_reconcile_import_busy) na transação que cria a execução.
 *  - Ao importar (enqueueImportRecipes): as receitas "rodar ao importar" da conta/cartão entram na fila
 *    (ai_reconcile_recipe_runs queued) e rodam em sequência; o worker (recipesTick) fecha o status das
 *    execuções terminadas e reserva a próxima (ai_reconcile_recipe_claim), com as linhas ainda pendentes.
 *  - O escopo das linhas é garantido no servidor: o runner passa lineIds ao contexto e as tools de
 *    conciliação recusam as linhas fora dele (tools-runtime.ts).
 */

const uuids = (ids: string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

/* ---------------- leitura ---------------- */

type RunJson = {
  id: string;
  recipe_id: string;
  recipe_name: string;
  import_id: string;
  file_name: string;
  caixa_id: string;
  financial_account_id: string | null;
  card_caixa_id: string | null;
  user_id: string;
  username: string;
  trigger_kind: 'manual' | 'import';
  position: number | null;
  line_count: number | null;
  status: ReconcileRecipeRunDto['status'];
  skip_reason: string | null;
  conversation_id: string | null;
  run_id: string | null;
  run_status: ReconcileRecipeRunDto['runStatus'];
  run_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const RUN_JSON = sql`json_build_object('id', x.id, 'recipe_id', x.recipe_id, 'recipe_name', rr.name, 'import_id', x.import_id,
  'file_name', xf.file_name, 'caixa_id', coalesce(xa.caixa_id, xi.card_caixa_id), 'financial_account_id', xi.financial_account_id,
  'card_caixa_id', xi.card_caixa_id, 'user_id', x.user_id, 'username', xu.username, 'trigger_kind', x.trigger_kind, 'position', x.position,
  'line_count', cardinality(x.line_ids), 'status', x.status, 'skip_reason', x.skip_reason, 'conversation_id', x.conversation_id,
  'run_id', x.run_id, 'run_status', xr.status, 'run_error', xr.error, 'created_at', x.created_at, 'started_at', x.started_at,
  'finished_at', x.finished_at)`;

const RUNS_FROM = sql`ai_reconcile_recipe_runs x
  JOIN ai_reconcile_recipes rr ON rr.id = x.recipe_id
  JOIN statement_imports xi ON xi.id = x.import_id
  JOIN attachments xf ON xf.id = xi.attachment_id
  LEFT JOIN financial_accounts xa ON xa.id = xi.financial_account_id
  JOIN users xu ON xu.id = x.user_id
  LEFT JOIN ai_runs xr ON xr.id = x.run_id`;

type TargetJson = { kind: 'account' | 'card'; id: string; name: string; caixa_id: string };

type RecipeRow = {
  id: string;
  caixa_id: string | null;
  caixa_name: string | null;
  agent_id: string;
  agent_name: string;
  agent_has_kit: boolean;
  agent_active: boolean;
  name: string;
  description: string | null;
  instruction: string;
  run_on_import: boolean;
  position: number;
  is_active: boolean;
  archived_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  targets: TargetJson[];
  last_run: RunJson | null;
};

const RECIPE_SELECT = sql`
  SELECT rc.id, rc.caixa_id, c.name AS caixa_name, rc.agent_id, a.name AS agent_name, a.tool_kit_id IS NOT NULL AS agent_has_kit,
         (a.is_active AND a.archived_at IS NULL) AS agent_active, rc.name, rc.description, rc.instruction, rc.run_on_import,
         rc.position, rc.is_active, rc.archived_at, rc.created_at, rc.updated_at,
         coalesce((SELECT json_agg(json_build_object(
                     'kind', CASE WHEN tg.financial_account_id IS NOT NULL THEN 'account' ELSE 'card' END,
                     'id', coalesce(tg.financial_account_id, tg.card_caixa_id), 'name', coalesce(ta.name, tc.name),
                     'caixa_id', coalesce(ta.caixa_id, tc.id)) ORDER BY lower(coalesce(ta.name, tc.name)))
                     FROM ai_reconcile_recipe_targets tg
                     LEFT JOIN financial_accounts ta ON ta.id = tg.financial_account_id
                     LEFT JOIN caixas tc ON tc.id = tg.card_caixa_id
                    WHERE tg.recipe_id = rc.id), '[]'::json) AS targets,
         (SELECT ${RUN_JSON} FROM ${RUNS_FROM} WHERE x.recipe_id = rc.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_run
    FROM ai_reconcile_recipes rc
    JOIN ai_agents a ON a.id = rc.agent_id
    LEFT JOIN caixas c ON c.id = rc.caixa_id`;

function runDto(r: RunJson): ReconcileRecipeRunDto {
  return {
    id: r.id,
    recipeId: r.recipe_id,
    recipeName: r.recipe_name,
    importId: r.import_id,
    fileName: r.file_name,
    caixaId: r.caixa_id,
    financialAccountId: r.financial_account_id,
    cardCaixaId: r.card_caixa_id,
    userId: r.user_id,
    username: r.username,
    triggerKind: r.trigger_kind,
    position: r.position,
    lineCount: r.line_count === null ? null : Number(r.line_count),
    status: r.status,
    skipReason: r.skip_reason,
    conversationId: r.conversation_id,
    runId: r.run_id,
    runStatus: r.run_status ?? null,
    runError: r.run_error ?? null,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

const canEdit = (access: Access, caixaId: string | null) => (caixaId === null ? access.isAdmin : access.canWrite(caixaId));

function recipeDto(access: Access, r: RecipeRow): ReconcileRecipeDto {
  // Um alvo de uma caixa que o usuário não lê não aparece (a receita global pode vincular qualquer conta).
  const targets: ReconcileRecipeTargetDto[] = (r.targets ?? [])
    .filter((x) => access.canRead(x.caixa_id))
    .map((x) => ({ kind: x.kind, id: x.id, name: x.name, caixaId: x.caixa_id }));
  return {
    id: r.id,
    caixaId: r.caixa_id,
    caixaName: r.caixa_name,
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentHasKit: Boolean(r.agent_has_kit),
    agentActive: Boolean(r.agent_active),
    name: r.name,
    description: r.description,
    instruction: r.instruction,
    runOnImport: r.run_on_import,
    position: Number(r.position),
    isActive: r.is_active,
    archivedAt: iso(r.archived_at),
    targets,
    canEdit: canEdit(access, r.caixa_id),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    lastRun: r.last_run && access.canRead(r.last_run.caixa_id) ? runDto(r.last_run) : null,
  };
}

/** Receitas que o usuário vê: as globais e as das caixas que ele lê. */
function visibleFilter(access: Access): SQL {
  const ids = access.readableCaixaIds();
  if (ids === 'all') return sql`true`;
  if (ids.length === 0) return sql`rc.caixa_id IS NULL`;
  return sql`(rc.caixa_id IS NULL OR rc.caixa_id = ANY (${uuids(ids)}))`;
}

async function recipeRows(db: Executor, access: Access, where: SQL): Promise<RecipeRow[]> {
  const result = await db.execute<RecipeRow>(sql`
    ${RECIPE_SELECT} WHERE ${visibleFilter(access)} AND ${where}
     ORDER BY rc.caixa_id IS NULL, lower(c.name), rc.position, lower(rc.name), rc.id`);
  return result.rows;
}

async function loadRecipe(ctx: ServiceContext, id: string): Promise<RecipeRow> {
  const [row] = await recipeRows(ctx.db, ctx.access, sql`rc.id = ${id}`);
  if (!row) throw notFound(t.agents.recipes.notFound);
  return row;
}

export async function listRecipes(ctx: ServiceContext, q: z.output<typeof reconcileRecipeListQuery> = {}): Promise<ReconcileRecipeDto[]> {
  const where: SQL[] = [q.archived === 'true' ? sql`rc.archived_at IS NOT NULL` : sql`rc.archived_at IS NULL`];
  if (q.caixaId === 'global') where.push(sql`rc.caixa_id IS NULL`);
  else if (q.caixaId) where.push(sql`rc.caixa_id = ${q.caixaId}`);
  if (q.accountId) {
    where.push(
      sql`EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = rc.id AND t.financial_account_id = ${q.accountId})`,
    );
  }
  if (q.cardCaixaId) {
    where.push(sql`EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = rc.id AND t.card_caixa_id = ${q.cardCaixaId})`);
  }
  const rows = await recipeRows(ctx.db, ctx.access, sql.join(where, sql` AND `));
  return rows.map((r) => recipeDto(ctx.access, r));
}

export async function getRecipe(ctx: ServiceContext, id: string): Promise<ReconcileRecipeDto> {
  return recipeDto(ctx.access, await loadRecipe(ctx, id));
}

export async function listRecipeRuns(ctx: ServiceContext, id: string, limit = 50): Promise<ReconcileRecipeRunDto[]> {
  await loadRecipe(ctx, id);
  const result = await ctx.db.execute<{ j: RunJson }>(sql`
    SELECT ${RUN_JSON} AS j FROM ${RUNS_FROM}
     WHERE x.recipe_id = ${id} ORDER BY x.created_at DESC, x.id DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
  return result.rows
    .map((row) => row.j)
    .filter((r) => ctx.access.canRead(r.caixa_id))
    .map(runDto);
}

/* ---------------- cadastro ---------------- */

function assertCanEdit(access: Access, caixaId: string | null) {
  if (caixaId === null) {
    if (!access.isAdmin) throw forbidden(t.agents.recipes.globalAdminOnly);
    return;
  }
  access.assertWrite(caixaId);
}

async function assertAgentActive(db: Executor, agentId: string) {
  const result = await db.execute<{ ok: boolean }>(
    sql`SELECT (is_active AND archived_at IS NULL) AS ok FROM ai_agents WHERE id = ${agentId}`,
  );
  const row = result.rows[0];
  if (!row) throw notFound(t.agents.errors.agentNotFound);
  if (!row.ok) throw unprocessable(t.agents.recipes.agentRequired, 'agent_inactive');
}

/** Troca os vínculos pela lista dada (apaga os que saíram, insere os novos). */
async function replaceTargets(tx: Tx, recipeId: string, accountIds: string[], cardCaixaIds: string[]) {
  const accounts = [...new Set(accountIds)];
  const cards = [...new Set(cardCaixaIds)];
  await tx.execute(sql`
    DELETE FROM ai_reconcile_recipe_targets
     WHERE recipe_id = ${recipeId}
       AND NOT (coalesce(financial_account_id = ANY (${uuids(accounts)}), false) OR coalesce(card_caixa_id = ANY (${uuids(cards)}), false))`);
  for (const accountId of accounts) {
    await tx.execute(sql`
      INSERT INTO ai_reconcile_recipe_targets (recipe_id, financial_account_id)
      SELECT ${recipeId}, ${accountId}
       WHERE NOT EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets WHERE recipe_id = ${recipeId} AND financial_account_id = ${accountId})`);
  }
  for (const cardId of cards) {
    await tx.execute(sql`
      INSERT INTO ai_reconcile_recipe_targets (recipe_id, card_caixa_id)
      SELECT ${recipeId}, ${cardId}
       WHERE NOT EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets WHERE recipe_id = ${recipeId} AND card_caixa_id = ${cardId})`);
  }
}

export async function createRecipe(ctx: ServiceContext, input: z.output<typeof reconcileRecipeCreateInput>): Promise<ReconcileRecipeDto> {
  assertCanEdit(ctx.access, input.caixaId);
  await assertAgentActive(ctx.db, input.agentId);
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_reconcile_recipes (caixa_id, agent_id, name, description, instruction, run_on_import, position, is_active, created_by_user_id)
      VALUES (${input.caixaId}, ${input.agentId}, ${input.name}, ${input.description ?? null}, ${input.instruction}, ${input.runOnImport},
              ${input.position}, ${input.isActive}, ${ctx.access.actor.id})
      RETURNING id`);
    const recipeId = result.rows[0]!.id;
    await replaceTargets(tx, recipeId, input.accountIds, input.cardCaixaIds);
    return recipeId;
  });
  return getRecipe(ctx, id);
}

export async function updateRecipe(
  ctx: ServiceContext,
  id: string,
  input: z.output<typeof reconcileRecipeUpdateInput>,
): Promise<ReconcileRecipeDto> {
  const current = await loadRecipe(ctx, id);
  assertCanEdit(ctx.access, current.caixa_id);
  if (input.agentId && input.agentId !== current.agent_id) await assertAgentActive(ctx.db, input.agentId);
  const sets: SQL[] = [];
  if (input.agentId !== undefined) sets.push(sql`agent_id = ${input.agentId}`);
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.description !== undefined) sets.push(sql`description = ${input.description ?? null}`);
  if (input.instruction !== undefined) sets.push(sql`instruction = ${input.instruction}`);
  if (input.runOnImport !== undefined) sets.push(sql`run_on_import = ${input.runOnImport}`);
  if (input.position !== undefined) sets.push(sql`position = ${input.position}`);
  if (input.isActive !== undefined) {
    if (input.isActive && current.archived_at) throw unprocessable(t.agents.recipes.inactive);
    sets.push(sql`is_active = ${input.isActive}`);
  }
  await withTx(ctx, async (tx) => {
    if (sets.length > 0) await tx.execute(sql`UPDATE ai_reconcile_recipes SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    if (input.accountIds !== undefined || input.cardCaixaIds !== undefined) {
      const keep = (kind: 'account' | 'card') => current.targets.filter((x) => x.kind === kind).map((x) => x.id);
      await replaceTargets(tx, id, input.accountIds ?? keep('account'), input.cardCaixaIds ?? keep('card'));
    }
  });
  return getRecipe(ctx, id);
}

/** Excluir = arquivar (e desligar: arquivada não pode estar ativa). O histórico fica. */
export async function archiveRecipe(ctx: ServiceContext, id: string) {
  const current = await loadRecipe(ctx, id);
  assertCanEdit(ctx.access, current.caixa_id);
  if (current.archived_at) throw unprocessable(t.agents.errors.alreadyArchived);
  await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_reconcile_recipes SET archived_at = now(), is_active = false WHERE id = ${id}`));
  return { deleted: false, archived: true };
}

export async function restoreRecipe(ctx: ServiceContext, id: string): Promise<ReconcileRecipeDto> {
  const current = await loadRecipe(ctx, id);
  assertCanEdit(ctx.access, current.caixa_id);
  await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_reconcile_recipes SET archived_at = NULL, is_active = true WHERE id = ${id}`));
  return getRecipe(ctx, id);
}

/* ---------------- lote ---------------- */

type ImportInfo = {
  id: string;
  file_name: string;
  financial_account_id: string | null;
  card_caixa_id: string | null;
  caixa_id: string;
  account_name: string;
  caixa_name: string;
  holder_name: string | null;
  first_on: string | null;
  last_on: string | null;
};

async function importInfo(db: Executor, importId: string): Promise<ImportInfo | null> {
  const result = await db.execute<ImportInfo>(sql`
    SELECT i.id, f.file_name, i.financial_account_id, i.card_caixa_id, coalesce(fa.caixa_id, i.card_caixa_id) AS caixa_id,
           coalesce(fa.name, cc.name) AS account_name, c.name AS caixa_name, e.name AS holder_name,
           (SELECT min(l.posted_on)::text FROM statement_lines l WHERE l.statement_import_id = i.id) AS first_on,
           (SELECT max(l.posted_on)::text FROM statement_lines l WHERE l.statement_import_id = i.id) AS last_on
      FROM statement_imports i
      JOIN attachments f ON f.id = i.attachment_id
      LEFT JOIN financial_accounts fa ON fa.id = i.financial_account_id
      LEFT JOIN caixas cc ON cc.id = i.card_caixa_id
      JOIN caixas c ON c.id = coalesce(fa.caixa_id, i.card_caixa_id)
      LEFT JOIN entities e ON e.id = c.holder_entity_id
     WHERE i.id = ${importId}`);
  return result.rows[0] ?? null;
}

/** Linhas pendentes (novas e sugeridas) do lote, na ordem do extrato. */
async function pendingLineIds(db: Executor, importId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id FROM statement_lines WHERE statement_import_id = ${importId} AND status IN ('new', 'suggested')
     ORDER BY posted_on, line_number`);
  return result.rows.map((r) => r.id);
}

/** Receitas que valem para o lote: vinculadas à conta/cartão; ou sem vínculo, da caixa do lote ou globais. */
function applicableFilter(info: Pick<ImportInfo, 'financial_account_id' | 'card_caixa_id' | 'caixa_id'>): SQL {
  return sql`(EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = rc.id
                       AND (t.financial_account_id = ${info.financial_account_id}::uuid OR t.card_caixa_id = ${info.card_caixa_id}::uuid))
              OR (NOT EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = rc.id)
                  AND (rc.caixa_id IS NULL OR rc.caixa_id = ${info.caixa_id})))`;
}

const isLinked = (row: RecipeRow, info: Pick<ImportInfo, 'financial_account_id' | 'card_caixa_id'>) =>
  (row.targets ?? []).some((x) => x.id === info.financial_account_id || x.id === info.card_caixa_id);

/** O lote tem uma execução de conciliação ativa (receita ou genérica)? */
export async function importBusy(db: Executor, importId: string): Promise<boolean> {
  const result = await db.execute<{ busy: boolean }>(sql`SELECT ai_reconcile_import_busy(${importId}::uuid) AS busy`);
  return Boolean(result.rows[0]?.busy);
}

/** O painel Receitas da tela do lote: as receitas que valem (vinculadas primeiro), as execuções do lote e o escopo. */
export async function importRecipes(ctx: ServiceContext, importId: string): Promise<ImportRecipesDto> {
  const detail = await getImport(ctx, importId);
  const info = (await importInfo(ctx.db, importId))!;
  const rows = await recipeRows(ctx.db, ctx.access, sql`rc.archived_at IS NULL AND rc.is_active AND ${applicableFilter(info)}`);
  const rank = (r: RecipeRow) => (isLinked(r, info) ? 0 : r.caixa_id ? 1 : 2);
  const recipes: ImportRecipeDto[] = rows
    .map((r, index) => ({ r, index }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.index - b.index)
    .map(({ r }) => ({ ...recipeDto(ctx.access, r), linked: isLinked(r, info) }));
  const runs = await ctx.db.execute<{ j: RunJson }>(sql`
    SELECT ${RUN_JSON} AS j FROM ${RUNS_FROM} WHERE x.import_id = ${importId} ORDER BY x.created_at DESC, x.id DESC LIMIT 50`);
  return {
    recipes,
    runs: runs.rows.map((row) => runDto(row.j)),
    pendingLines: detail.lines.filter((l) => l.status === 'new' || l.status === 'suggested').length,
    busy: await importBusy(ctx.db, importId),
    canRun: detail.canWrite,
  };
}

/* ---------------- execução ---------------- */

/** Valores das variáveis da instrução (spec 022 + as do lote). */
async function recipeValues(
  db: Executor,
  access: Access,
  agentName: string,
  info: ImportInfo,
  lines: number,
): Promise<RecipeVariableValues> {
  const settings = await loadUserAiSettings(db, access);
  const period = info.first_on && info.last_on ? `${formatDate(info.first_on)} a ${formatDate(info.last_on)}` : '';
  return {
    'agente.nome': agentName,
    'usuario.nome': access.actor.username,
    'usuario.login': access.actor.username,
    'usuario.email': access.actor.email,
    'usuario.caixa_principal': settings.primaryCaixa?.name ?? '',
    'empresa.titular_principal': settings.primaryCaixa?.holderName ?? '',
    ...volatilePromptValues(),
    'lote.id': info.id,
    'lote.arquivo': info.file_name,
    'lote.periodo': period,
    'conta.nome': info.account_name,
    'caixa.nome': info.caixa_name,
    'caixa.titular': info.holder_name ?? '',
    'linhas.total': String(lines),
  };
}

/**
 * Cria, dentro da transação de quem chama, a sessão de conciliação do lote
 * (reconcile_statement, arquivada), a mensagem do usuário e a execução na fila.
 * Usada pelo play, pela fila do import e pela conciliação genérica (spec 029).
 */
export async function insertReconcileSession(
  tx: Executor,
  p: { userId: string; agentId: string; title: string; screenContext: Record<string, unknown>; text: string },
): Promise<{ conversationId: string; runId: string }> {
  const conversation = await tx.execute<{ id: string }>(sql`
    INSERT INTO ai_conversations (user_id, agent_id, title, title_source, screen_context, archived_at, purpose)
    VALUES (${p.userId}, ${p.agentId}, ${p.title.slice(0, 200)}, 'user', ${JSON.stringify(p.screenContext)}::jsonb, now(), 'reconcile_statement')
    RETURNING id`);
  const conversationId = conversation.rows[0]!.id;
  const message = await insertMessage(tx, conversationId, 'user', [{ type: 'text', text: p.text }], null);
  const run = await tx.execute<{ id: string }>(sql`
    INSERT INTO ai_runs (conversation_id, user_id, agent_id, trigger_message_id)
    VALUES (${conversationId}, ${p.userId}, ${p.agentId}, ${message.id})
    RETURNING id`);
  const runId = run.rows[0]!.id;
  await appendEvent(tx, runId, { type: 'status', status: 'queued' });
  return { conversationId, runId };
}

/** Toma o lock do lote e recusa (409) com execução de conciliação ativa nele. */
export async function lockImport(tx: Executor, importId: string): Promise<boolean> {
  await tx.execute(sql`SELECT ai_reconcile_import_lock(${importId}::uuid)`);
  return importBusy(tx, importId);
}

async function assertAgentUsable(db: Executor, agentId: string) {
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT (a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL) AS ok
      FROM ai_agents a LEFT JOIN ai_providers p ON p.id = a.provider_id WHERE a.id = ${agentId}`);
  if (!result.rows[0]?.ok) throw unprocessable(t.agents.errors.agentInactive, 'agent_inactive');
}

async function runById(db: Executor, id: string): Promise<ReconcileRecipeRunDto> {
  const result = await db.execute<{ j: RunJson }>(sql`SELECT ${RUN_JSON} AS j FROM ${RUNS_FROM} WHERE x.id = ${id}`);
  return runDto(result.rows[0]!.j);
}

/**
 * Play (spec 030): roda a receita no lote, nas linhas dadas (só as pendentes
 * contam) ou em todas as pendentes, numa sessão nova, como quem clicou.
 */
export async function runRecipe(
  ctx: ServiceContext,
  importId: string,
  recipeId: string,
  lineIds?: string[],
): Promise<ReconcileRecipeRunResult> {
  const detail = await getImport(ctx, importId);
  ctx.access.assertWrite(detail.caixaId);
  const recipe = await loadRecipe(ctx, recipeId);
  if (recipe.archived_at || !recipe.is_active) throw unprocessable(t.agents.recipes.inactive, 'recipe_inactive');
  const info = (await importInfo(ctx.db, importId))!;
  const applicable = await recipeRows(ctx.db, ctx.access, sql`rc.id = ${recipeId} AND ${applicableFilter(info)}`);
  if (applicable.length === 0) throw unprocessable(t.agents.recipes.notApplicable, 'recipe_not_applicable');

  const pending = await pendingLineIds(ctx.db, importId);
  let scope = pending;
  if (lineIds) {
    const inImport = new Set(detail.lines.map((l) => l.id));
    if (lineIds.some((id) => !inImport.has(id))) throw unprocessable(t.agents.recipes.lineNotInImport, 'line_not_in_import');
    const wanted = new Set(lineIds);
    scope = pending.filter((id) => wanted.has(id));
  }
  if (scope.length === 0) throw unprocessable(t.agents.recipes.noLines, 'nothing_to_reconcile');
  await assertAgentUsable(ctx.db, recipe.agent_id);
  // Orçamento e limite por minuto dos fluxos (spec 028), antes de criar a execução.
  await assertCanStartRun(ctx, recipe.agent_id, true);
  const values = await recipeValues(ctx.db, ctx.access, recipe.agent_name, info, scope.length);

  const created = await withTx(ctx, async (tx) => {
    if (await lockImport(tx, importId)) throw new AppError(409, 'run_active', t.agents.recipes.busy);
    const session = await insertReconcileSession(tx, {
      userId: ctx.access.actor.id,
      agentId: recipe.agent_id,
      title: t.agents.recipes.conversation(recipe.name, info.file_name),
      screenContext: { importId, recipeId, lineIds: scope },
      text: renderRecipeVariables(recipe.instruction, values),
    });
    const run = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_reconcile_recipe_runs (recipe_id, import_id, user_id, trigger_kind, status, line_ids, conversation_id, run_id)
      VALUES (${recipeId}, ${importId}, ${ctx.access.actor.id}, 'manual', 'started', ${uuids(scope)}, ${session.conversationId}, ${session.runId})
      RETURNING id`);
    return { ...session, recipeRunId: run.rows[0]!.id };
  });
  return {
    run: await runById(ctx.db, created.recipeRunId),
    runId: created.runId,
    conversationId: created.conversationId,
    lines: scope.length,
  };
}

/**
 * Ao importar (spec 030): enfileira as receitas "rodar ao importar" ativas da
 * conta/cartão do lote, na ordem, como quem importou. Devolve quantas.
 */
export async function enqueueImportRecipes(ctx: ServiceContext, importId: string): Promise<number> {
  const info = await importInfo(ctx.db, importId);
  if (!info) return 0;
  return withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_reconcile_recipe_runs (recipe_id, import_id, user_id, trigger_kind, position, status)
      SELECT rc.id, ${importId}, ${ctx.access.actor.id}, 'import', rc.position, 'queued'
        FROM ai_reconcile_recipes rc
        JOIN ai_agents a ON a.id = rc.agent_id AND a.is_active AND a.archived_at IS NULL
       WHERE rc.run_on_import AND rc.is_active AND rc.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM ai_reconcile_recipe_targets t WHERE t.recipe_id = rc.id
                      AND (t.financial_account_id = ${info.financial_account_id}::uuid OR t.card_caixa_id = ${info.card_caixa_id}::uuid))
       ORDER BY rc.position, rc.id
      ON CONFLICT (import_id, recipe_id) WHERE trigger_kind = 'import' DO NOTHING
      RETURNING id`);
    return result.rows.length;
  });
}

/* ---------------- fila do import (worker) ---------------- */

type ClaimRow = {
  recipe_run_id: string;
  recipe_id: string;
  import_id: string;
  user_id: string;
  agent_id: string;
  recipe_name: string;
  instruction: string;
  position: number;
};

async function closeRun(tx: Executor, id: string, status: 'skipped' | 'failed', reason: string) {
  await tx.execute(sql`
    UPDATE ai_reconcile_recipe_runs SET status = ${status}, skip_reason = ${reason.slice(0, 500) || t.errors.generic}
     WHERE id = ${id} AND status = 'started' AND run_id IS NULL`);
}

/** Ator da transação do worker: quem disparou (nada sai como system). */
async function setOwner(tx: Executor, userId: string) {
  await tx.execute(sql`
    SELECT set_config('app.user_id', ${userId}, true), set_config('app.actor_kind', 'human', true),
           set_config('app.agent_run_id', '', true)`);
}

/**
 * Começa uma execução reservada (started) dentro da transação da reserva: as
 * linhas pendentes agora (sem nenhuma, skipped no_lines), o limite por minuto e
 * o orçamento dos fluxos e, num savepoint, a sessão e a execução.
 */
async function startClaimed(tx: Tx, config: Config, row: ClaimRow): Promise<'started' | 'skipped' | 'failed'> {
  const [user] = await tx.select(userColumns).from(users).where(eq(users.id, row.user_id));
  if (!user?.isActive) {
    await closeRun(tx, row.recipe_run_id, 'skipped', 'user_inactive');
    return 'skipped';
  }
  const actor: Actor = { id: user.id, username: user.username, email: user.email, role: user.role as Actor['role'], isActive: true };
  const access = await loadAccess(tx, actor);
  const info = await importInfo(tx, row.import_id);
  if (!info || !access.canWrite(info.caixa_id)) {
    await closeRun(tx, row.recipe_run_id, 'failed', t.errors.readOnly);
    return 'failed';
  }
  const scope = await pendingLineIds(tx, row.import_id);
  if (scope.length === 0) {
    await closeRun(tx, row.recipe_run_id, 'skipped', 'no_lines');
    return 'skipped';
  }
  try {
    await assertRunRate(tx, config, row.user_id, true);
  } catch (error) {
    if (error instanceof AppError && error.status === 429) {
      await closeRun(tx, row.recipe_run_id, 'skipped', 'rate_limited');
      return 'skipped';
    }
    throw error;
  }
  if (await exceededBudget(tx, actor, row.agent_id, true)) {
    await closeRun(tx, row.recipe_run_id, 'skipped', 'budget_exceeded');
    return 'skipped';
  }
  try {
    const agent = await tx.execute<{ name: string }>(sql`SELECT name FROM ai_agents WHERE id = ${row.agent_id}`);
    const values = await recipeValues(tx, access, agent.rows[0]?.name ?? '', info, scope.length);
    await tx.transaction(async (sp) => {
      const session = await insertReconcileSession(sp, {
        userId: row.user_id,
        agentId: row.agent_id,
        title: t.agents.recipes.conversation(row.recipe_name, info.file_name),
        screenContext: { importId: row.import_id, recipeId: row.recipe_id, lineIds: scope },
        text: renderRecipeVariables(row.instruction, values),
      });
      await sp.execute(sql`
        UPDATE ai_reconcile_recipe_runs SET line_ids = ${uuids(scope)}, conversation_id = ${session.conversationId}, run_id = ${session.runId}
         WHERE id = ${row.recipe_run_id}`);
    });
    return 'started';
  } catch (error) {
    const reason = translateDbError(error)?.message ?? (error instanceof Error ? error.message : String(error));
    await closeRun(tx, row.recipe_run_id, 'failed', reason || t.errors.generic);
    return 'failed';
  }
}

/**
 * Próxima receita da fila do lote: reserva (ai_reconcile_recipe_claim) e
 * começa; as puladas e as que falharam dão a vez à seguinte. Devolve o id da
 * execução começada (ou null: fila vazia ou lote ocupado).
 */
export async function startNextRecipe(db: Database, config: Config, importId: string, log?: FastifyBaseLogger): Promise<string | null> {
  for (let i = 0; i < 50; i += 1) {
    const outcome = await db.transaction(async (tx) => {
      const claimed = await tx.execute<ClaimRow>(sql`SELECT * FROM ai_reconcile_recipe_claim(${importId}::uuid)`);
      const row = claimed.rows[0];
      if (!row) return null;
      await setOwner(tx, row.user_id);
      const status = await startClaimed(tx, config, row);
      return { status, id: row.recipe_run_id };
    });
    if (!outcome) return null;
    if (outcome.status === 'started') return outcome.id;
    log?.info({ importId, recipeRunId: outcome.id, status: outcome.status }, 'receitas: execução não começou');
  }
  return null;
}

/** Fecha as execuções de receita cuja ai_runs terminou (completed; failed/canceled = failed com o motivo). */
export async function closeFinishedRecipeRuns(db: Executor): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE ai_reconcile_recipe_runs x
       SET status = CASE WHEN r.status = 'completed' THEN 'completed' ELSE 'failed' END,
           skip_reason = CASE WHEN r.status = 'completed' THEN NULL
                              WHEN r.status = 'canceled' THEN 'canceled'
                              ELSE left(coalesce(nullif(btrim(r.error), ''), 'failed'), 500) END
      FROM ai_runs r
     WHERE r.id = x.run_id AND x.status = 'started' AND r.status IN ('completed', 'failed', 'canceled')
    RETURNING x.id`);
  return result.rows.length;
}

/**
 * Passada da fila das receitas no worker: fecha as execuções terminadas e
 * começa a próxima de cada lote com fila pendente e livre.
 */
export async function recipesTick(db: Database, config: Config, log?: FastifyBaseLogger) {
  const closed = await closeFinishedRecipeRuns(db);
  const pending = await db.execute<{ import_id: string }>(sql`SELECT import_id FROM ai_reconcile_recipe_pending_imports(20)`);
  let started = 0;
  for (const { import_id } of pending.rows) {
    if (await startNextRecipe(db, config, import_id, log)) started += 1;
  }
  return { closed, started };
}

/** Nome da receita de uma conversa de conciliação (screen_context.recipeId), ou null. */
export async function recipeNameOf(db: Executor, screen: Record<string, unknown> | null | undefined): Promise<string | null> {
  const recipeId = typeof screen?.recipeId === 'string' ? screen.recipeId : null;
  if (!recipeId) return null;
  const result = await db.execute<{ name: string }>(sql`SELECT name FROM ai_reconcile_recipes WHERE id = ${recipeId}`);
  return result.rows[0]?.name ?? null;
}
