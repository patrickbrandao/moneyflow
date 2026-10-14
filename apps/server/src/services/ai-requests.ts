import type { Executor } from '@moneyflow/db';
import type {
  AiEmbeddingIndexDto,
  AiProviderHealthRow,
  AiProviderSummary,
  AiRequestBodyPart,
  AiRequestDetail,
  AiRequestListItem,
  AiRequestPage,
  AiUsagePeriodSummary,
  AiUsageSlice,
  AppSettingDto,
  aiRequestListQuery,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { embeddingSourceTotal } from '../agents/embeddings';
import { usageDto } from '../agents/store';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { getProvider } from './ai-admin';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Requisições ao provedor e detalhe do provedor (spec 023, só admin), e as
 * configurações do sistema gravadas pela tela (app_settings, que vencem a
 * variável de ambiente). A lista nunca lê os corpos; o detalhe lê até
 * DETAIL_BODY_LIMIT de cada parte (o resto sai pela rota de download).
 */

/* ---------------- configurações ---------------- */

type SettingDef = { env: string; envValue: (config: Config) => unknown };

/** Chaves que a tela grava (a validação do valor é do banco: app_setting_valid). */
const SETTINGS: Record<string, SettingDef> = {
  'ai.request_retention_days': { env: 'AI_REQUEST_RETENTION_DAYS', envValue: (config) => config.aiRequestRetentionDays },
  // Limite por minuto (spec 028): execuções de IA por usuário.
  'ai.runs_per_minute': { env: 'AI_RUNS_PER_MINUTE', envValue: (config) => config.aiRunsPerMinute },
  'ai.flow_runs_per_minute': { env: 'AI_FLOW_RUNS_PER_MINUTE', envValue: (config) => config.aiFlowRunsPerMinute },
};

function settingDef(key: string): SettingDef {
  const def = SETTINGS[key];
  if (!def) throw notFound();
  return def;
}

async function readSetting(db: Executor, key: string) {
  const result = await db.execute<{ value: unknown; updated_at: unknown; username: string | null }>(sql`
    SELECT s.value, s.updated_at, u.username
      FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by_user_id
     WHERE s.key = ${key}`);
  return result.rows[0] ?? null;
}

async function settingDto(ctx: ServiceContext, key: string): Promise<AppSettingDto> {
  const def = settingDef(key);
  const row = await readSetting(ctx.db, key);
  const envValue = def.envValue(ctx.config);
  return {
    key,
    value: row ? row.value : envValue,
    source: row ? 'database' : 'env',
    envValue,
    envName: def.env,
    updatedAt: row ? iso(row.updated_at) : null,
    updatedBy: row?.username ?? null,
  };
}

/** Todas as configurações que a tela grava (tool get_app_settings). */
export async function listSettings(ctx: ServiceContext): Promise<AppSettingDto[]> {
  ctx.access.assertAdmin();
  const out: AppSettingDto[] = [];
  for (const key of Object.keys(SETTINGS)) out.push(await settingDto(ctx, key));
  return out;
}

export async function getSetting(ctx: ServiceContext, key: string): Promise<AppSettingDto> {
  ctx.access.assertAdmin();
  return settingDto(ctx, key);
}

export async function putSetting(ctx: ServiceContext, key: string, value: unknown): Promise<AppSettingDto> {
  ctx.access.assertAdmin();
  settingDef(key);
  await withTx(ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO app_settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`),
  );
  return settingDto(ctx, key);
}

/** "Usar o padrão": apaga o valor do banco e volta a valer a variável de ambiente. */
export async function deleteSetting(ctx: ServiceContext, key: string): Promise<AppSettingDto> {
  ctx.access.assertAdmin();
  settingDef(key);
  await withTx(ctx, (tx) => tx.execute(sql`DELETE FROM app_settings WHERE key = ${key}`));
  return settingDto(ctx, key);
}

/** Prazo de retenção das requisições: app_settings vence AI_REQUEST_RETENTION_DAYS. */
export async function requestRetentionDays(db: Executor, config: Config): Promise<{ days: number; source: 'database' | 'env' }> {
  const row = await readSetting(db, 'ai.request_retention_days');
  const days = Number(row?.value);
  if (row && Number.isInteger(days) && days >= 1 && days <= 365) return { days, source: 'database' };
  return { days: config.aiRequestRetentionDays, source: 'env' };
}

/** Limites por minuto (spec 028): app_settings vence AI_RUNS_PER_MINUTE / AI_FLOW_RUNS_PER_MINUTE. */
export async function runsPerMinute(db: Executor, config: Config, flow: boolean): Promise<{ limit: number; source: 'database' | 'env' }> {
  const row = await readSetting(db, flow ? 'ai.flow_runs_per_minute' : 'ai.runs_per_minute');
  const value = Number(row?.value);
  if (row && Number.isInteger(value) && value >= 1 && value <= 1000) return { limit: value, source: 'database' };
  return { limit: flow ? config.aiFlowRunsPerMinute : config.aiRunsPerMinute, source: 'env' };
}

/* ---------------- requisições ---------------- */

const LIST_COLUMNS = sql`
  r.id, r.provider_id, p.name AS provider_name, r.agent_id, a.name AS agent_name, r.user_id, u.username, r.conversation_id, r.run_id,
  r.operation, r.purpose, r.model, r.method, r.path, r.streaming, r.status, r.http_status, r.error_message, r.started_at,
  r.finished_at, r.duration_ms, r.first_byte_ms, r.attempts, r.input_tokens, r.output_tokens, r.cache_write_tokens,
  r.cache_read_tokens, r.request_bytes, r.response_bytes,
  to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;

const LIST_FROM = sql`
  ai_requests r
  LEFT JOIN ai_providers p ON p.id = r.provider_id
  LEFT JOIN ai_agents a ON a.id = r.agent_id
  LEFT JOIN users u ON u.id = r.user_id`;

type ListRow = Record<string, unknown> & { cursor_at: string; id: string };

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function listItem(r: ListRow): AiRequestListItem {
  return {
    id: r.id,
    providerId: (r.provider_id as string) ?? null,
    providerName: (r.provider_name as string) ?? null,
    agentId: (r.agent_id as string) ?? null,
    agentName: (r.agent_name as string) ?? null,
    userId: (r.user_id as string) ?? null,
    username: (r.username as string) ?? null,
    conversationId: (r.conversation_id as string) ?? null,
    runId: (r.run_id as string) ?? null,
    operation: r.operation as AiRequestListItem['operation'],
    purpose: (r.purpose as AiRequestListItem['purpose']) ?? null,
    model: (r.model as string) ?? null,
    method: r.method as string,
    path: r.path as string,
    streaming: Boolean(r.streaming),
    status: r.status as AiRequestListItem['status'],
    httpStatus: num(r.http_status),
    errorMessage: (r.error_message as string) ?? null,
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
    durationMs: num(r.duration_ms),
    firstByteMs: num(r.first_byte_ms),
    attempts: Number(r.attempts ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    requestBytes: num(r.request_bytes),
    responseBytes: num(r.response_bytes),
  };
}

const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (
    !at ||
    !id ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw badRequest('Cursor inválido.');
  }
  return { at, id };
}

async function queryRequests(db: Executor, query: z.output<typeof aiRequestListQuery>): Promise<AiRequestPage> {
  const where: SQL[] = [];
  if (query.from) where.push(sql`r.started_at >= (${query.from}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  if (query.to) where.push(sql`r.started_at < (${query.to}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  if (query.providerId) where.push(sql`r.provider_id = ${query.providerId}`);
  if (query.agentId) where.push(sql`r.agent_id = ${query.agentId}`);
  if (query.userId) where.push(sql`r.user_id = ${query.userId}`);
  if (query.runId) where.push(sql`r.run_id = ${query.runId}`);
  if (query.conversationId) where.push(sql`r.conversation_id = ${query.conversationId}`);
  if (query.operation) where.push(sql`r.operation = ${query.operation}`);
  if (query.purpose) where.push(sql`r.purpose = ${query.purpose}`);
  if (query.status) where.push(sql`r.status = ${query.status}`);
  if (query.model) where.push(sql`strpos(lower(r.model), lower(${query.model})) > 0`);
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.push(sql`(r.started_at, r.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
  }
  const result = await db.execute<ListRow>(sql`
    SELECT ${LIST_COLUMNS} FROM ${LIST_FROM}
     WHERE ${where.length ? sql.join(where, sql` AND `) : sql`true`}
     ORDER BY r.started_at DESC, r.id DESC
     LIMIT ${query.limit + 1}`);
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(listItem),
    nextCursor: result.rows.length > query.limit && last ? encodeCursor(last.cursor_at, last.id) : null,
  };
}

export async function listRequests(ctx: ServiceContext, query: z.output<typeof aiRequestListQuery>): Promise<AiRequestPage> {
  ctx.access.assertAdmin();
  return queryRequests(ctx.db, query);
}

/** Até quanto de cada parte o detalhe traz (o resto se baixa pela rota body). */
const DETAIL_BODY_LIMIT = 8 * 1024 * 1024;

const DEFAULT_ORIGINS: Record<string, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };

function part(text: unknown, bytes: unknown): AiRequestBodyPart | null {
  if (bytes === null || bytes === undefined) return null;
  return { text: typeof text === 'string' ? text : null, bytes: Number(bytes), truncated: typeof text !== 'string' };
}

export async function getRequest(ctx: ServiceContext, id: string): Promise<AiRequestDetail> {
  ctx.access.assertAdmin();
  const result = await ctx.db.execute<ListRow>(sql`
    SELECT ${LIST_COLUMNS}, p.kind AS provider_kind, p.base_url AS provider_base_url, coalesce(p.log_bodies, false) AS log_bodies,
           c.title AS conversation_title, r.request_headers, r.response_headers,
           CASE WHEN octet_length(r.request_body) <= ${DETAIL_BODY_LIMIT} THEN r.request_body END AS request_body,
           octet_length(r.request_body) AS request_body_bytes,
           CASE WHEN octet_length(r.response_body) <= ${DETAIL_BODY_LIMIT} THEN r.response_body END AS response_body,
           octet_length(r.response_body) AS response_body_bytes,
           CASE WHEN octet_length(r.response_stream) <= ${DETAIL_BODY_LIMIT} THEN r.response_stream END AS response_stream,
           octet_length(r.response_stream) AS response_stream_bytes
      FROM ${LIST_FROM} LEFT JOIN ai_conversations c ON c.id = r.conversation_id
     WHERE r.id = ${id}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  const attempts = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT attempt, started_at, duration_ms, http_status, error_type, error_message, retry_after_ms, rate_limit_headers, response_body
      FROM ai_request_attempts WHERE request_id = ${id} ORDER BY attempt`);
  const path = row.path as string;
  const kind = (row.provider_kind as 'anthropic' | 'openai' | null) ?? null;
  let origin = kind ? DEFAULT_ORIGINS[kind]! : '';
  if (row.provider_base_url) {
    try {
      origin = new URL(row.provider_base_url as string).origin;
    } catch {
      /* base_url inválida: fica a padrão */
    }
  }
  return {
    ...listItem(row),
    url: path.startsWith('/') ? `${origin}${path}` : path,
    providerKind: kind,
    logBodies: Boolean(row.log_bodies),
    conversationTitle: (row.conversation_title as string) ?? null,
    requestHeaders: (row.request_headers as Record<string, string>) ?? null,
    responseHeaders: (row.response_headers as Record<string, string>) ?? null,
    requestBody: part(row.request_body, row.request_body_bytes),
    responseBody: part(row.response_body, row.response_body_bytes),
    responseStream: part(row.response_stream, row.response_stream_bytes),
    attemptList: attempts.rows.map((a) => ({
      attempt: Number(a.attempt),
      startedAt: iso(a.started_at)!,
      durationMs: num(a.duration_ms),
      httpStatus: num(a.http_status),
      errorType: (a.error_type as string) ?? null,
      errorMessage: (a.error_message as string) ?? null,
      retryAfterMs: num(a.retry_after_ms),
      rateLimitHeaders: (a.rate_limit_headers as Record<string, string>) ?? null,
      responseBody: (a.response_body as string) ?? null,
    })),
  };
}

const BODY_PARTS = {
  request: { column: sql`request_body`, mime: 'application/json; charset=utf-8', ext: 'json' },
  response: { column: sql`response_body`, mime: 'application/json; charset=utf-8', ext: 'json' },
  stream: { column: sql`response_stream`, mime: 'text/plain; charset=utf-8', ext: 'txt' },
} as const;

/** Uma parte do corpo para baixar (404 se não foi gravada). */
export async function requestBody(ctx: ServiceContext, id: string, which: keyof typeof BODY_PARTS) {
  ctx.access.assertAdmin();
  const spec = BODY_PARTS[which];
  const result = await ctx.db.execute<{ body: string | null }>(sql`SELECT ${spec.column} AS body FROM ai_requests WHERE id = ${id}`);
  const body = result.rows[0]?.body;
  if (body === null || body === undefined) throw notFound();
  return { body, mime: spec.mime, fileName: `requisicao-${id.slice(0, 8)}-${which}.${spec.ext}` };
}

/* ---------------- detalhe do provedor ---------------- */

type UsageGroupRow = {
  purpose: string | null;
  model: string | null;
  gp: number;
  gm: number;
  currency: string | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_micros: number | null;
  has_unpriced: boolean;
  audio_seconds: string | number | null;
  characters: string | number | null;
};

async function usagePeriod(db: Executor, providerId: string, period: SQL): Promise<AiUsagePeriodSummary> {
  const result = await db.execute<UsageGroupRow>(sql`
    SELECT purpose, model, grouping(purpose)::int AS gp, grouping(model)::int AS gm, currency, count(*)::int AS calls,
           sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
           sum(cache_write_tokens)::bigint AS cache_write_tokens, sum(cache_read_tokens)::bigint AS cache_read_tokens,
           sum(cost_micros)::bigint AS cost_micros, bool_or(cost_micros IS NULL) AS has_unpriced,
           sum(audio_seconds)::float8 AS audio_seconds, sum(characters)::bigint AS characters
      FROM ai_usage
     WHERE provider_id = ${providerId} AND ${period}
     GROUP BY GROUPING SETS ((currency), (purpose, currency), (model, currency))
     ORDER BY calls DESC`);
  const out: AiUsagePeriodSummary = { totals: [], byPurpose: [], byModel: [] };
  for (const row of result.rows) {
    const totals = {
      ...usageDto(row as Parameters<typeof usageDto>[0]),
      audioSeconds: Number(row.audio_seconds ?? 0),
      characters: Number(row.characters ?? 0),
    };
    if (Number(row.gp) === 1 && Number(row.gm) === 1) out.totals.push(totals);
    else if (Number(row.gp) === 0) out.byPurpose.push({ ...totals, key: row.purpose ?? '' } satisfies AiUsageSlice);
    else out.byModel.push({ ...totals, key: row.model ?? '' } satisfies AiUsageSlice);
  }
  return out;
}

export async function providerSummary(ctx: ServiceContext, id: string): Promise<AiProviderSummary> {
  ctx.access.assertAdmin();
  const provider = await getProvider(ctx.db, id);
  const [month, last30Days, total] = await Promise.all([
    usagePeriod(
      ctx.db,
      id,
      sql`created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
    ),
    usagePeriod(ctx.db, id, sql`created_at >= now() - interval '30 days'`),
    usagePeriod(ctx.db, id, sql`true`),
  ]);
  const health = await ctx.db.execute<Record<string, unknown>>(sql`SELECT * FROM ai_provider_health(7, ${id}::uuid)`);
  const recent = await queryRequests(ctx.db, { providerId: id, limit: 50 });
  // Progresso do índice de embeddings por modelo (spec 024): indexados / registros que a busca enxerga.
  const indexes = await ctx.db.execute<{ model: string; in_use: boolean; last_in_use_at: unknown; indexed: number; pending: number }>(
    sql`SELECT model, in_use, last_in_use_at, indexed, pending FROM ai_embedding_index_stats WHERE provider_id = ${id} ORDER BY model`,
  );
  const sourceTotal = indexes.rows.length > 0 ? await embeddingSourceTotal(ctx.db) : 0;
  return {
    provider,
    usage: { month, last30Days, total },
    health: health.rows.map(
      (h): AiProviderHealthRow => ({
        model: (h.model as string) ?? null,
        requests: Number(h.requests),
        ok: Number(h.ok),
        errors: Number(h.errors),
        canceled: Number(h.canceled),
        errorRate: num(h.error_rate),
        p50Ms: num(h.p50_ms),
        p95Ms: num(h.p95_ms),
        p50FirstByteMs: num(h.p50_first_byte_ms),
        p95FirstByteMs: num(h.p95_first_byte_ms),
        avgAttempts: num(h.avg_attempts),
        lastErrorAt: iso(h.last_error_at),
      }),
    ),
    recent: recent.items,
    embeddingIndexes: indexes.rows.map(
      (x): AiEmbeddingIndexDto => ({
        model: x.model,
        inUse: Boolean(x.in_use),
        lastInUseAt: iso(x.last_in_use_at),
        indexed: Number(x.indexed),
        pending: Number(x.pending),
        total: sourceTotal,
      }),
    ),
  };
}
