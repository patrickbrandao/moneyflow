import type { Executor } from '@moneyflow/db';
import {
  type AiBudgetCurrency,
  type AiBudgetDto,
  type AiBudgetScope,
  type AiBudgetState,
  type AiBudgetStatusDto,
  type AiUsageDailyRow,
  type AiUsageModelRow,
  type AiUsagePanel,
  type AiUsagePurpose,
  type AiUsagePurposeRow,
  type AiUsageTopConversation,
  type aiBudgetCreateInput,
  type aiBudgetUpdateInput,
  type aiUsagePanelQuery,
  budgetScopeLabel,
  budgetThreshold,
  type MyAiUsageDto,
  t,
  toMicros,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Actor } from '../authz/access';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { AppError, findPgError, notFound } from '../errors';
import { runsPerMinute } from './ai-requests';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Orçamentos de IA, limite de execuções por minuto e painel de uso (spec 028).
 *  - ai_budget_check (banco) diz os orçamentos estourados que valem para uma
 *    execução; a isenção do admin que aciona é daqui (o banco não sabe quem aciona);
 *  - o limite por minuto conta as execuções do usuário em ai_runs no último
 *    minuto, separando sessões (purpose chat) e fluxos; vale para o admin;
 *  - o painel lê ai_usage_daily, ai_usage_top_conversations e ai_provider_health.
 */

/* ---------------- orçamentos (CRUD, só admin) ---------------- */

type BudgetRow = {
  id: string;
  scope: AiBudgetScope;
  user_id: string | null;
  username: string | null;
  agent_id: string | null;
  agent_name: string | null;
  currency: AiBudgetCurrency;
  monthly_limit_micros: number;
  alert_percent: number;
  is_active: boolean;
  created_at: unknown;
  updated_at: unknown;
};

type StatusRow = {
  budget_id: string;
  scope: AiBudgetScope;
  user_id: string | null;
  agent_id: string | null;
  currency: AiBudgetCurrency;
  monthly_limit_micros: number;
  alert_percent: number;
  month: string;
  spent_micros: number;
  unpriced_calls: number;
  percent: number;
  status: AiBudgetState;
};

const BUDGET_SELECT = sql`
  SELECT b.id, b.scope, b.user_id, u.username, b.agent_id, a.name AS agent_name, b.currency, b.monthly_limit_micros,
         b.alert_percent, b.is_active, b.created_at, b.updated_at
    FROM ai_budgets b LEFT JOIN users u ON u.id = b.user_id LEFT JOIN ai_agents a ON a.id = b.agent_id`;

/** Ordem da tela: global, fluxos, agentes e usuários. */
const BUDGET_ORDER = sql`
  ORDER BY CASE b.scope WHEN 'global' THEN 0 WHEN 'flows' THEN 1 WHEN 'agent' THEN 2 ELSE 3 END,
           a.name NULLS FIRST, u.username NULLS FIRST, b.currency, b.is_active DESC, b.created_at`;

function statusDto(s: StatusRow): AiBudgetStatusDto {
  return {
    month: String(s.month).slice(0, 10),
    spentMicros: Number(s.spent_micros),
    unpricedCalls: Number(s.unpriced_calls),
    percent: Number(s.percent),
    status: s.status,
  };
}

function budgetDto(r: BudgetRow, status: Map<string, StatusRow>): AiBudgetDto {
  const current = status.get(r.id);
  return {
    id: r.id,
    scope: r.scope,
    userId: r.user_id,
    username: r.username,
    agentId: r.agent_id,
    agentName: r.agent_name,
    currency: r.currency,
    monthlyLimitMicros: Number(r.monthly_limit_micros),
    alertPercent: Number(r.alert_percent),
    isActive: r.is_active,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    current: current ? statusDto(current) : null,
  };
}

/** Situação dos orçamentos ativos no mês (null = o corrente em São Paulo). */
export async function budgetStatus(db: Executor, month: string | null = null): Promise<StatusRow[]> {
  const result = await db.execute<StatusRow>(sql`SELECT * FROM ai_budget_status(${month}::date)`);
  return result.rows;
}

async function budgetRows(db: Executor, where: SQL = sql`true`): Promise<BudgetRow[]> {
  const result = await db.execute<BudgetRow>(sql`${BUDGET_SELECT} WHERE ${where} ${BUDGET_ORDER}`);
  return result.rows;
}

export async function listBudgets(ctx: ServiceContext): Promise<AiBudgetDto[]> {
  ctx.access.assertAdmin();
  const [rows, status] = await Promise.all([budgetRows(ctx.db), budgetStatus(ctx.db)]);
  const byId = new Map(status.map((s) => [s.budget_id, s]));
  return rows.map((r) => budgetDto(r, byId));
}

export async function getBudget(ctx: ServiceContext, id: string): Promise<AiBudgetDto> {
  ctx.access.assertAdmin();
  const [row] = await budgetRows(ctx.db, sql`b.id = ${id}`);
  if (!row) throw notFound(t.agents.errors.budgetNotFound);
  const status = await budgetStatus(ctx.db);
  return budgetDto(row, new Map(status.map((s) => [s.budget_id, s])));
}

export async function createBudget(ctx: ServiceContext, input: z.output<typeof aiBudgetCreateInput>): Promise<AiBudgetDto> {
  ctx.access.assertAdmin();
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_budgets (scope, user_id, agent_id, currency, monthly_limit_micros, alert_percent, is_active)
      VALUES (${input.scope}, ${input.userId ?? null}, ${input.agentId ?? null}, ${input.currency}, ${toMicros(input.monthlyLimit)},
              ${input.alertPercent}, ${input.isActive})
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return getBudget(ctx, id);
}

export async function updateBudget(ctx: ServiceContext, id: string, input: z.output<typeof aiBudgetUpdateInput>): Promise<AiBudgetDto> {
  await getBudget(ctx, id);
  const sets: SQL[] = [];
  if (input.currency !== undefined) sets.push(sql`currency = ${input.currency}`);
  if (input.monthlyLimit !== undefined) sets.push(sql`monthly_limit_micros = ${toMicros(input.monthlyLimit)}`);
  if (input.alertPercent !== undefined) sets.push(sql`alert_percent = ${input.alertPercent}`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (sets.length > 0) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_budgets SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`));
  }
  return getBudget(ctx, id);
}

export async function deleteBudget(ctx: ServiceContext, id: string) {
  await getBudget(ctx, id);
  await withTx(ctx, (tx) => tx.execute(sql`DELETE FROM ai_budgets WHERE id = ${id}`));
  return { deleted: true };
}

/* ---------------- bloqueio e limite por minuto ---------------- */

/**
 * O primeiro orçamento estourado que vale para a execução (global, fluxos,
 * agente, usuário), como rótulo; null = pode seguir. O admin que aciona fica
 * isento (continua recebendo o aviso).
 */
export async function exceededBudget(
  db: Executor,
  actor: Pick<Actor, 'id' | 'role'>,
  agentId: string,
  isFlow: boolean,
): Promise<string | null> {
  if (actor.role === 'admin') return null;
  const result = await db.execute<{ scope: AiBudgetScope; username: string | null; agent_name: string | null }>(sql`
    SELECT c.scope, u.username, a.name AS agent_name
      FROM ai_budget_check(${actor.id}::uuid, ${agentId}::uuid, ${isFlow}) c
      LEFT JOIN users u ON u.id = c.user_id LEFT JOIN ai_agents a ON a.id = c.agent_id
     LIMIT 1`);
  const row = result.rows[0];
  return row ? budgetScopeLabel({ scope: row.scope, username: row.username, agentName: row.agent_name }) : null;
}

/** Recusa a execução nova com 429 se um orçamento que vale para ela está estourado. */
export async function assertBudget(ctx: ServiceContext, agentId: string, isFlow: boolean) {
  const scope = await exceededBudget(ctx.db, ctx.access.actor, agentId, isFlow);
  if (scope) throw new AppError(429, 'budget_exceeded', t.agents.errors.budgetExceeded(scope));
}

/**
 * Limite de execuções por minuto do usuário (sessões e fluxos contam à parte),
 * também para o admin: 429 com retry-after (segundos até a mais antiga da
 * janela sair dela).
 */
export async function assertRunRate(db: Executor, config: Config, userId: string, isFlow: boolean) {
  const { limit } = await runsPerMinute(db, config, isFlow);
  const result = await db.execute<{ n: number; wait: number | null }>(sql`
    SELECT count(*)::int AS n, ceil(60 - extract(epoch FROM now() - min(r.created_at)))::int AS wait
      FROM ai_runs r JOIN ai_conversations c ON c.id = r.conversation_id
     WHERE r.user_id = ${userId} AND r.created_at > now() - interval '1 minute' AND (c.purpose <> 'chat') = ${isFlow}`);
  const row = result.rows[0];
  if (!row || row.n < limit) return;
  const seconds = Math.min(60, Math.max(1, Number(row.wait ?? 60)));
  throw new AppError(429, 'rate_limited', t.agents.errors.rateLimited(limit, seconds), undefined, { 'retry-after': String(seconds) });
}

/** As duas checagens de uma execução nova: limite por minuto e orçamento. */
export async function assertCanStartRun(ctx: ServiceContext, agentId: string, isFlow: boolean) {
  await assertRunRate(ctx.db, ctx.config, ctx.access.actor.id, isFlow);
  await assertBudget(ctx, agentId, isFlow);
}

/* ---------------- avisos (message-worker) ---------------- */

export type BudgetAlert = {
  budgetId: string;
  scope: AiBudgetScope;
  userId: string | null;
  label: string;
  currency: AiBudgetCurrency;
  month: string;
  threshold: number;
  spentMicros: number;
  limitMicros: number;
  percent: number;
};

/** Os orçamentos ativos que passaram do aviso ou chegaram a 100% no mês corrente (o maior limiar alcançado). */
export async function budgetAlerts(db: Executor): Promise<BudgetAlert[]> {
  const result = await db.execute<StatusRow & { username: string | null; agent_name: string | null }>(sql`
    SELECT s.*, u.username, a.name AS agent_name
      FROM ai_budget_status() s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN ai_agents a ON a.id = s.agent_id
     WHERE s.status <> 'ok'`);
  return result.rows.map((r) => ({
    budgetId: r.budget_id,
    scope: r.scope,
    userId: r.user_id,
    label: budgetScopeLabel({ scope: r.scope, username: r.username, agentName: r.agent_name }),
    currency: r.currency,
    month: String(r.month).slice(0, 10),
    threshold: budgetThreshold(r.status, Number(r.alert_percent))!,
    spentMicros: Number(r.spent_micros),
    limitMicros: Number(r.monthly_limit_micros),
    percent: Number(r.percent),
  }));
}

/* ---------------- painel de uso (só admin) ---------------- */

const n = (v: unknown) => Number(v ?? 0);
const costOf = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const tokens = (r: Record<string, unknown>) => ({
  calls: n(r.calls),
  inputTokens: n(r.input_tokens),
  outputTokens: n(r.output_tokens),
  cacheWriteTokens: n(r.cache_write_tokens),
  cacheReadTokens: n(r.cache_read_tokens),
});
const SUMS = sql`
  sum(d.calls)::int AS calls, sum(d.input_tokens)::bigint AS input_tokens, sum(d.output_tokens)::bigint AS output_tokens,
  sum(d.cache_write_tokens)::bigint AS cache_write_tokens, sum(d.cache_read_tokens)::bigint AS cache_read_tokens,
  sum(d.cost_micros)::bigint AS cost_micros, bool_or(d.has_unpriced) AS has_unpriced`;

/** Dias entre duas datas AAAA-MM-DD (inclusivo). */
const spanDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

export async function usagePanel(ctx: ServiceContext, q: z.output<typeof aiUsagePanelQuery>): Promise<AiUsagePanel> {
  ctx.access.assertAdmin();
  const where = sql`d.day BETWEEN ${q.from}::date AND ${q.to}::date
    ${q.providerId ? sql`AND d.provider_id = ${q.providerId}` : sql``}
    ${q.agentId ? sql`AND d.agent_id = ${q.agentId}` : sql``}
    ${q.userId ? sql`AND d.user_id = ${q.userId}` : sql``}
    ${q.purpose ? sql`AND d.purpose = ${q.purpose}` : sql``}`;

  const daily = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT d.day, d.provider_id, p.name AS provider_name, d.agent_id, a.name AS agent_name, d.currency, ${SUMS}
      FROM ai_usage_daily d LEFT JOIN ai_providers p ON p.id = d.provider_id LEFT JOIN ai_agents a ON a.id = d.agent_id
     WHERE ${where}
     GROUP BY d.day, d.provider_id, p.name, d.agent_id, a.name, d.currency
     ORDER BY d.day, p.name NULLS LAST, a.name NULLS LAST, d.currency NULLS LAST`);
  const byModel = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT d.provider_id, p.name AS provider_name, d.model, d.currency, ${SUMS}, sum(d.runs)::int AS runs
      FROM ai_usage_daily d LEFT JOIN ai_providers p ON p.id = d.provider_id
     WHERE ${where}
     GROUP BY d.provider_id, p.name, d.model, d.currency
     ORDER BY sum(d.cost_micros) DESC NULLS LAST, sum(d.calls) DESC, d.model`);
  const byPurpose = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT d.purpose, d.currency, ${SUMS}, sum(d.runs)::int AS runs, count(DISTINCT d.user_id)::int AS users
      FROM ai_usage_daily d
     WHERE ${where}
     GROUP BY d.purpose, d.currency
     ORDER BY sum(d.cost_micros) DESC NULLS LAST, sum(d.calls) DESC, d.purpose`);
  let top: { rows: Record<string, unknown>[] };
  try {
    top = await ctx.db.execute<Record<string, unknown>>(sql`
      SELECT c.*, u.username, a.name AS agent_name
        FROM ai_usage_top_conversations(${q.from}::date, ${q.to}::date, 20, ${q.providerId ?? null}::uuid, ${q.agentId ?? null}::uuid,
                                        ${q.userId ?? null}::uuid, ${q.purpose ?? null}) c
        LEFT JOIN users u ON u.id = c.owner_user_id LEFT JOIN ai_agents a ON a.id = c.conversation_agent_id
       ORDER BY c.currency, c.rank`);
  } catch (error) {
    if (findPgError(error)?.code === '22023') throw new AppError(400, 'invalid_period', t.errors.validation);
    throw error;
  }

  // Saúde dos modelos: as requisições dos dias do período até hoje (ai_provider_health aceita 1–365).
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const healthDays = Math.min(365, Math.max(1, spanDays(q.from, today)));
  const health = await ctx.db.execute<Record<string, unknown>>(
    sql`SELECT * FROM ai_provider_health(${healthDays}, ${q.providerId ?? null}::uuid)`,
  );
  const healthOf = new Map(health.rows.map((h) => [`${h.provider_id}|${h.model}`, h]));

  return {
    from: q.from,
    to: q.to,
    healthDays,
    daily: daily.rows.map(
      (r): AiUsageDailyRow => ({
        ...tokens(r),
        day: String(r.day),
        providerId: (r.provider_id as string) ?? null,
        providerName: (r.provider_name as string) ?? null,
        agentId: (r.agent_id as string) ?? null,
        agentName: (r.agent_name as string) ?? null,
        currency: (r.currency as AiBudgetCurrency) ?? null,
        costMicros: costOf(r.cost_micros),
        hasUnpriced: Boolean(r.has_unpriced),
      }),
    ),
    byModel: byModel.rows.map((r): AiUsageModelRow => {
      const h = healthOf.get(`${r.provider_id}|${r.model}`);
      return {
        ...tokens(r),
        providerId: (r.provider_id as string) ?? null,
        providerName: (r.provider_name as string) ?? null,
        model: String(r.model),
        currency: (r.currency as AiBudgetCurrency) ?? null,
        costMicros: costOf(r.cost_micros),
        hasUnpriced: Boolean(r.has_unpriced),
        runs: n(r.runs),
        health: h
          ? {
              requests: n(h.requests),
              errors: n(h.errors),
              errorRate: h.error_rate === null ? null : Number(h.error_rate),
              p50Ms: h.p50_ms === null ? null : Number(h.p50_ms),
              p95Ms: h.p95_ms === null ? null : Number(h.p95_ms),
            }
          : null,
      };
    }),
    byPurpose: byPurpose.rows.map(
      (r): AiUsagePurposeRow => ({
        ...tokens(r),
        purpose: r.purpose as AiUsagePurpose,
        currency: (r.currency as AiBudgetCurrency) ?? null,
        costMicros: costOf(r.cost_micros),
        hasUnpriced: Boolean(r.has_unpriced),
        runs: n(r.runs),
        users: n(r.users),
      }),
    ),
    topConversations: top.rows.map(
      (r): AiUsageTopConversation => ({
        ...tokens(r),
        rank: n(r.rank),
        conversationId: String(r.conversation_id),
        title: (r.title as string) ?? null,
        purpose: String(r.conversation_purpose),
        userId: (r.owner_user_id as string) ?? null,
        username: (r.username as string) ?? null,
        agentId: (r.conversation_agent_id as string) ?? null,
        agentName: (r.agent_name as string) ?? null,
        archived: r.archived_at !== null,
        currency: r.currency as AiBudgetCurrency,
        costMicros: n(r.cost_micros),
        runs: n(r.runs),
        unpricedCalls: n(r.unpriced_calls),
        lastUsedAt: iso(r.last_used_at),
      }),
    ),
  };
}

/* ---------------- Minha conta → IA ---------------- */

/** O uso do próprio usuário no mês corrente e os orçamentos que o cobrem (o dele e o global). */
export async function myUsage(ctx: ServiceContext): Promise<MyAiUsageDto> {
  const me = ctx.access.actor.id;
  const usage = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT u.month, u.currency, u.calls, u.runs, u.input_tokens, u.output_tokens, u.cache_write_tokens, u.cache_read_tokens,
           u.cost_micros, u.has_unpriced
      FROM ai_usage_monthly_by_user u
     WHERE u.user_id = ${me} AND u.month = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date
     ORDER BY u.currency NULLS LAST`);
  const status = await budgetStatus(ctx.db);
  const mine = status.filter((s) => s.scope === 'global' || (s.scope === 'user' && s.user_id === me));
  const ids = mine.map((s) => s.budget_id);
  const rows = ids.length > 0 ? await budgetRows(ctx.db, sql`b.id = ANY (${`{${ids.join(',')}}`}::uuid[])`) : [];
  const byId = new Map(mine.map((s) => [s.budget_id, s]));
  const month = await ctx.db.execute<{ month: string }>(sql`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS month`);
  return {
    month: month.rows[0]!.month,
    usage: usage.rows.map((r) => ({
      currency: (r.currency as AiBudgetCurrency) ?? null,
      calls: n(r.calls),
      runs: n(r.runs),
      inputTokens: n(r.input_tokens) + n(r.cache_write_tokens) + n(r.cache_read_tokens),
      outputTokens: n(r.output_tokens),
      costMicros: costOf(r.cost_micros),
      hasUnpriced: Boolean(r.has_unpriced),
    })),
    budgets: rows.map((r) => budgetDto(r, byId)),
  };
}
