import type { Executor, Tx } from '@moneyflow/db';
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  type AgentToolInfo,
  type AiAgentDto,
  type AiPriceDto,
  type AiProviderDto,
  type AiProviderTestResult,
  type AiUsageReport,
  type aiAgentCreateInput,
  type aiAgentUpdateInput,
  type aiPriceInput,
  type aiProviderCreateInput,
  type aiProviderUpdateInput,
  type aiUsageQuery,
  type McpServerDto,
  type McpToolInfo,
  type mcpServerCreateInput,
  type mcpServerUpdateInput,
  t,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { createLlmClient, LlmError } from '../agents/llm';
import { connectMcp } from '../agents/mcp-client';
import { usageDto } from '../agents/store';
import type { ServiceContext } from '../context';
import { badRequest, notFound } from '../errors';
import { deleteOrArchive, withTx } from './tx';
import { iso } from './util';

/*
 * Administração dos agentes (spec 011, só admin): provedores (chave
 * write-only: grava, nunca devolve; a tela vê api_key_hint), preços, agentes
 * (com os vínculos MCP), servidores MCP (cabeçalhos write-only; a tela vê só
 * os nomes) e o painel de uso. Testar conexão e listar tools leem os segredos
 * só pelas funções admin_* do banco, que exigem um admin ativo.
 */

/* ---------------- provedores ---------------- */

const PROVIDER_COLUMNS = sql`p.id, p.name, p.kind, p.base_url, p.api_key_hint, p.embedding_model, p.is_active, p.notes, p.archived_at,
  p.created_at`;

type ProviderRow = {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai';
  base_url: string | null;
  api_key_hint: string | null;
  embedding_model: string | null;
  is_active: boolean;
  notes: string | null;
  archived_at: unknown;
  created_at: unknown;
};

const providerDto = (r: ProviderRow): AiProviderDto => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  baseUrl: r.base_url,
  apiKeyHint: r.api_key_hint,
  embeddingModel: r.embedding_model,
  isActive: r.is_active,
  notes: r.notes,
  archivedAt: iso(r.archived_at),
  createdAt: iso(r.created_at)!,
});

export async function listProviders(ctx: ServiceContext): Promise<AiProviderDto[]> {
  ctx.access.assertAdmin();
  const result = await ctx.db.execute<ProviderRow>(
    sql`SELECT ${PROVIDER_COLUMNS} FROM ai_providers p ORDER BY p.archived_at NULLS FIRST, lower(p.name)`,
  );
  return result.rows.map(providerDto);
}

async function getProvider(db: Executor, id: string): Promise<AiProviderDto> {
  const result = await db.execute<ProviderRow>(sql`SELECT ${PROVIDER_COLUMNS} FROM ai_providers p WHERE p.id = ${id}`);
  if (!result.rows[0]) throw notFound();
  return providerDto(result.rows[0]);
}

export async function createProvider(ctx: ServiceContext, input: z.output<typeof aiProviderCreateInput>) {
  ctx.access.assertAdmin();
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_providers (name, kind, base_url, api_key, embedding_model, is_active, notes, created_by_user_id)
      VALUES (${input.name}, ${input.kind}, ${input.baseUrl}, ${input.apiKey}, ${input.embeddingModel}, ${input.isActive}, ${input.notes},
              ${ctx.access.actor.id})
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return getProvider(ctx.db, id);
}

export async function updateProvider(ctx: ServiceContext, id: string, input: z.output<typeof aiProviderUpdateInput>) {
  ctx.access.assertAdmin();
  await getProvider(ctx.db, id);
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.baseUrl !== undefined) sets.push(sql`base_url = ${input.baseUrl}`);
  if (input.clearApiKey) sets.push(sql`api_key = NULL`);
  else if (input.apiKey) sets.push(sql`api_key = ${input.apiKey}`);
  if (input.embeddingModel !== undefined) sets.push(sql`embedding_model = ${input.embeddingModel}`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (input.notes !== undefined) sets.push(sql`notes = ${input.notes}`);
  if (sets.length > 0) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_providers SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`));
  }
  return getProvider(ctx.db, id);
}

export async function deleteProvider(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await getProvider(ctx.db, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.execute(sql`DELETE FROM ai_providers WHERE id = ${id} RETURNING id`)).rows.length,
      (t2) => t2.execute(sql`UPDATE ai_providers SET is_active = false, archived_at = now() WHERE id = ${id}`),
    ),
  );
}

/** Credenciais para uma ação do admin (nunca saem da API). */
async function adminCredentials(ctx: ServiceContext, provider: AiProviderDto) {
  const result = await ctx.db.execute<{ key: string | null }>(
    sql`SELECT admin_ai_provider_api_key(${provider.id}::uuid, ${ctx.access.actor.id}::uuid) AS key`,
  );
  return { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: result.rows[0]?.key ?? null };
}

export async function testProvider(ctx: ServiceContext, id: string): Promise<AiProviderTestResult> {
  ctx.access.assertAdmin();
  const provider = await getProvider(ctx.db, id);
  const client = createLlmClient(await adminCredentials(ctx, provider));
  try {
    const models = await client.listModels();
    return { ok: true, message: `Conexão ok: ${models.length} modelo(s) disponível(is).`, models };
  } catch (error) {
    const message = error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error);
    return { ok: false, message: t.agents.errors.providerError(message.slice(0, 300)), models: [] };
  }
}

/* ---------------- preços ---------------- */

export async function listPrices(ctx: ServiceContext): Promise<AiPriceDto[]> {
  ctx.access.assertAdmin();
  const result = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT m.id, m.provider_id, p.name AS provider_name, m.model, m.currency, m.input_price_per_million, m.output_price_per_million,
           m.cache_write_price_per_million, m.cache_read_price_per_million, m.valid_from
      FROM ai_model_prices m JOIN ai_providers p ON p.id = m.provider_id
     ORDER BY lower(p.name), m.model, m.valid_from DESC`);
  return result.rows.map((r) => ({
    id: r.id as string,
    providerId: r.provider_id as string,
    providerName: r.provider_name as string,
    model: r.model as string,
    currency: r.currency as 'USD' | 'BRL',
    inputPricePerMillion: Number(r.input_price_per_million),
    outputPricePerMillion: Number(r.output_price_per_million),
    cacheWritePricePerMillion: r.cache_write_price_per_million === null ? null : Number(r.cache_write_price_per_million),
    cacheReadPricePerMillion: r.cache_read_price_per_million === null ? null : Number(r.cache_read_price_per_million),
    validFrom: iso(r.valid_from)!,
  }));
}

export async function createPrice(ctx: ServiceContext, input: z.output<typeof aiPriceInput>) {
  ctx.access.assertAdmin();
  await getProvider(ctx.db, input.providerId);
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_model_prices (provider_id, model, currency, input_price_per_million, output_price_per_million,
                                   cache_write_price_per_million, cache_read_price_per_million, valid_from)
      VALUES (${input.providerId}, ${input.model}, ${input.currency}, ${input.inputPricePerMillion}, ${input.outputPricePerMillion},
              ${input.cacheWritePricePerMillion}, ${input.cacheReadPricePerMillion}, coalesce(${input.validFrom ?? null}::timestamptz, now()))
      RETURNING id`);
    return result.rows[0]!.id;
  });
  const all = await listPrices(ctx);
  return all.find((p) => p.id === id)!;
}

export async function deletePrice(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  const deleted = await withTx(ctx, (tx) => tx.execute(sql`DELETE FROM ai_model_prices WHERE id = ${id} RETURNING id`));
  if (deleted.rows.length === 0) throw notFound();
  return { deleted: true };
}

/* ---------------- tools e agentes ---------------- */

export function listToolCatalog(ctx: ServiceContext): AgentToolInfo[] {
  ctx.access.assertAdmin();
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    kind: tool.kind,
    confirm: tool.confirm,
  }));
}

type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  params: AiAgentDto['params'];
  enabled_tools: string[] | null;
  require_write_confirmation: boolean;
  color_slot: number;
  icon: string | null;
  is_active: boolean;
  archived_at: unknown;
  created_at: unknown;
};

async function loadAgents(db: Executor, where = sql`true`): Promise<AiAgentDto[]> {
  const result = await db.execute<AgentRow>(sql`
    SELECT a.id, a.name, a.description, a.system_prompt, a.provider_id, p.name AS provider_name, a.model, a.params, a.enabled_tools,
           a.require_write_confirmation, a.color_slot, a.icon, a.is_active, a.archived_at, a.created_at
      FROM ai_agents a LEFT JOIN ai_providers p ON p.id = a.provider_id
     WHERE ${where}
     ORDER BY a.archived_at NULLS FIRST, lower(a.name)`);
  const links = await db.execute<{
    agent_id: string;
    mcp_server_id: string;
    name: string;
    visibility: AiAgentDto['mcpServers'][number]['visibility'];
    enabled_tools: string[] | null;
  }>(sql`
    SELECT l.agent_id, l.mcp_server_id, s.name, s.visibility, l.enabled_tools
      FROM agent_mcp_servers l JOIN mcp_servers s ON s.id = l.mcp_server_id ORDER BY lower(s.name)`);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    systemPrompt: r.system_prompt,
    providerId: r.provider_id,
    providerName: r.provider_name,
    model: r.model,
    params: r.params ?? {},
    enabledTools: r.enabled_tools,
    requireWriteConfirmation: r.require_write_confirmation,
    colorSlot: Number(r.color_slot),
    icon: r.icon,
    isActive: r.is_active,
    archivedAt: iso(r.archived_at),
    createdAt: iso(r.created_at)!,
    mcpServers: links.rows
      .filter((l) => l.agent_id === r.id)
      .map((l) => ({ mcpServerId: l.mcp_server_id, name: l.name, visibility: l.visibility, enabledTools: l.enabled_tools })),
  }));
}

export async function listAgents(ctx: ServiceContext): Promise<AiAgentDto[]> {
  ctx.access.assertAdmin();
  return loadAgents(ctx.db);
}

async function getAgent(db: Executor, id: string) {
  const [agent] = await loadAgents(db, sql`a.id = ${id}`);
  if (!agent) throw notFound(t.agents.errors.agentNotFound);
  return agent;
}

function checkTools(tools: string[] | null | undefined) {
  if (!tools) return;
  const unknown = tools.filter((name) => !AGENT_TOOL_NAMES.includes(name));
  if (unknown.length > 0) throw badRequest(t.agents.errors.toolUnknown(unknown.join(', ')));
}

async function setLinks(tx: Tx, agentId: string, links: { mcpServerId: string; enabledTools: string[] | null }[]) {
  const keep = links.map((l) => l.mcpServerId);
  await tx.execute(sql`
    DELETE FROM agent_mcp_servers WHERE agent_id = ${agentId}
       ${keep.length ? sql`AND NOT (mcp_server_id = ANY (${`{${keep.join(',')}}`}::uuid[]))` : sql``}`);
  for (const link of links) {
    await tx.execute(sql`
      INSERT INTO agent_mcp_servers (agent_id, mcp_server_id, enabled_tools)
      VALUES (${agentId}, ${link.mcpServerId}, ${link.enabledTools === null ? null : `{${link.enabledTools.map((n) => `"${n}"`).join(',')}}`}::text[])
      ON CONFLICT (agent_id, mcp_server_id) DO UPDATE SET enabled_tools = EXCLUDED.enabled_tools`);
  }
}

const textArray = (values: string[] | null) => (values === null ? null : `{${values.map((v) => `"${v}"`).join(',')}}`);

export async function createAgent(ctx: ServiceContext, input: z.output<typeof aiAgentCreateInput>) {
  ctx.access.assertAdmin();
  checkTools(input.enabledTools);
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_agents (name, description, system_prompt, provider_id, model, params, enabled_tools, require_write_confirmation,
                             color_slot, icon, is_active, created_by_user_id)
      VALUES (${input.name}, ${input.description}, ${input.systemPrompt}, ${input.providerId}, ${input.model},
              ${JSON.stringify(input.params)}::jsonb, ${textArray(input.enabledTools)}::text[], ${input.requireWriteConfirmation},
              ${input.colorSlot}, ${input.icon}, ${input.isActive}, ${ctx.access.actor.id})
      RETURNING id`);
    const agentId = result.rows[0]!.id;
    if (input.mcpServers) await setLinks(tx, agentId, input.mcpServers);
    return agentId;
  });
  return getAgent(ctx.db, id);
}

export async function updateAgent(ctx: ServiceContext, id: string, input: z.output<typeof aiAgentUpdateInput>) {
  ctx.access.assertAdmin();
  await getAgent(ctx.db, id);
  checkTools(input.enabledTools);
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
  if (input.systemPrompt !== undefined) sets.push(sql`system_prompt = ${input.systemPrompt}`);
  if (input.providerId !== undefined) sets.push(sql`provider_id = ${input.providerId}`);
  if (input.model !== undefined) sets.push(sql`model = ${input.model}`);
  if (input.params !== undefined) sets.push(sql`params = ${JSON.stringify(input.params)}::jsonb`);
  if (input.enabledTools !== undefined) sets.push(sql`enabled_tools = ${textArray(input.enabledTools)}::text[]`);
  if (input.requireWriteConfirmation !== undefined) sets.push(sql`require_write_confirmation = ${input.requireWriteConfirmation}`);
  if (input.colorSlot !== undefined) sets.push(sql`color_slot = ${input.colorSlot}`);
  if (input.icon !== undefined) sets.push(sql`icon = ${input.icon}`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  await withTx(ctx, async (tx) => {
    if (sets.length > 0) await tx.execute(sql`UPDATE ai_agents SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    if (input.mcpServers) await setLinks(tx, id, input.mcpServers);
  });
  return getAgent(ctx.db, id);
}

export async function deleteAgent(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await getAgent(ctx.db, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.execute(sql`DELETE FROM ai_agents WHERE id = ${id} RETURNING id`)).rows.length,
      (t2) => t2.execute(sql`UPDATE ai_agents SET is_active = false, archived_at = now() WHERE id = ${id}`),
    ),
  );
}

/* ---------------- servidores MCP ---------------- */

type McpRow = {
  id: string;
  name: string;
  url: string;
  secret_header_names: string[];
  visibility: McpServerDto['visibility'];
  is_active: boolean;
  tools_cache: McpToolInfo[] | null;
  tools_cached_at: unknown;
  tools_error: string | null;
  notes: string | null;
  archived_at: unknown;
  created_at: unknown;
};

const MCP_COLUMNS = sql`s.id, s.name, s.url, s.secret_header_names, s.visibility, s.is_active, s.tools_cache, s.tools_cached_at, s.tools_error,
  s.notes, s.archived_at, s.created_at`;

const mcpDto = (r: McpRow): McpServerDto => ({
  id: r.id,
  name: r.name,
  url: r.url,
  headerNames: r.secret_header_names ?? [],
  visibility: r.visibility,
  isActive: r.is_active,
  tools: r.tools_cache,
  toolsCachedAt: iso(r.tools_cached_at),
  toolsError: r.tools_error,
  notes: r.notes,
  archivedAt: iso(r.archived_at),
  createdAt: iso(r.created_at)!,
});

export async function listMcpServers(ctx: ServiceContext): Promise<McpServerDto[]> {
  ctx.access.assertAdmin();
  const result = await ctx.db.execute<McpRow>(
    sql`SELECT ${MCP_COLUMNS} FROM mcp_servers s ORDER BY s.archived_at NULLS FIRST, lower(s.name)`,
  );
  return result.rows.map(mcpDto);
}

async function getMcpServer(db: Executor, id: string) {
  const result = await db.execute<McpRow>(sql`SELECT ${MCP_COLUMNS} FROM mcp_servers s WHERE s.id = ${id}`);
  if (!result.rows[0]) throw notFound();
  return mcpDto(result.rows[0]);
}

export async function createMcpServer(ctx: ServiceContext, input: z.output<typeof mcpServerCreateInput>) {
  ctx.access.assertAdmin();
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO mcp_servers (name, url, secret_headers, visibility, is_active, notes, created_by_user_id)
      VALUES (${input.name}, ${input.url}, ${JSON.stringify(input.headers)}::jsonb, ${input.visibility}, ${input.isActive}, ${input.notes},
              ${ctx.access.actor.id})
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return getMcpServer(ctx.db, id);
}

export async function updateMcpServer(ctx: ServiceContext, id: string, input: z.output<typeof mcpServerUpdateInput>) {
  ctx.access.assertAdmin();
  await getMcpServer(ctx.db, id);
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.url !== undefined) sets.push(sql`url = ${input.url}`);
  if (input.visibility !== undefined) sets.push(sql`visibility = ${input.visibility}`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (input.notes !== undefined) sets.push(sql`notes = ${input.notes}`);
  await withTx(ctx, async (tx) => {
    if (sets.length > 0) await tx.execute(sql`UPDATE mcp_servers SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    if (Object.keys(input.setHeaders).length > 0 || input.removeHeaders.length > 0) {
      await tx.execute(sql`
        SELECT mcp_server_merge_headers(${id}::uuid, ${JSON.stringify(input.setHeaders)}::jsonb,
                                        ${`{${input.removeHeaders.map((h) => `"${h}"`).join(',')}}`}::text[])`);
    }
  });
  return getMcpServer(ctx.db, id);
}

export async function deleteMcpServer(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await getMcpServer(ctx.db, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.execute(sql`DELETE FROM mcp_servers WHERE id = ${id} RETURNING id`)).rows.length,
      (t2) => t2.execute(sql`UPDATE mcp_servers SET is_active = false, archived_at = now() WHERE id = ${id}`),
    ),
  );
}

/** Testa o servidor e atualiza o cache de tools (ou grava o erro). */
export async function refreshMcpServer(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  const server = await getMcpServer(ctx.db, id);
  const headers = await ctx.db.execute<{ headers: Record<string, string> }>(
    sql`SELECT admin_mcp_server_headers(${id}::uuid, ${ctx.access.actor.id}::uuid) AS headers`,
  );
  let tools: McpToolInfo[] | null = null;
  let error: string | null = null;
  try {
    const session = await connectMcp(server.url, headers.rows[0]?.headers ?? {});
    try {
      tools = await session.listTools();
    } finally {
      await session.close();
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 2000) || 'erro desconhecido';
  }
  await withTx(ctx, (tx) =>
    tools
      ? tx.execute(sql`UPDATE mcp_servers SET tools_cache = ${JSON.stringify(tools)}::jsonb, tools_cached_at = now(), tools_error = NULL
                        WHERE id = ${id}`)
      : tx.execute(sql`UPDATE mcp_servers SET tools_error = ${error} WHERE id = ${id}`),
  );
  return getMcpServer(ctx.db, id);
}

/* ---------------- uso ---------------- */

export async function usageReport(ctx: ServiceContext, q: z.output<typeof aiUsageQuery>): Promise<AiUsageReport> {
  ctx.access.assertAdmin();
  const from = q.from ? `${q.from}-01` : null;
  const to = q.to ? `${q.to}-01` : null;
  const period = sql`(${from}::date IS NULL OR u.month >= ${from}::date) AND (${to}::date IS NULL OR u.month <= ${to}::date)`;
  const byUser = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT u.*, x.username FROM ai_usage_monthly_by_user u LEFT JOIN users x ON x.id = u.user_id
     WHERE ${period} ORDER BY u.month DESC, x.username NULLS LAST, u.currency NULLS LAST`);
  const byAgent = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT u.*, a.name AS agent_name FROM ai_usage_monthly_by_agent u LEFT JOIN ai_agents a ON a.id = u.agent_id
     WHERE ${period} ORDER BY u.month DESC, a.name NULLS LAST, u.model, u.currency NULLS LAST`);
  const month = (v: unknown) => String(v).slice(0, 7);
  return {
    byUser: byUser.rows.map((r) => ({
      ...usageDto(r as never),
      month: month(r.month),
      userId: (r.user_id as string) ?? null,
      username: (r.username as string) ?? null,
      runs: Number(r.runs),
    })),
    byAgent: byAgent.rows.map((r) => ({
      ...usageDto(r as never),
      month: month(r.month),
      agentId: (r.agent_id as string) ?? null,
      agentName: (r.agent_name as string) ?? null,
      model: r.model as string,
      runs: Number(r.runs),
      users: Number(r.users),
    })),
  };
}
