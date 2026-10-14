import { type Executor, type Tx, userColumns, users } from '@moneyflow/db';
import {
  type AgentPromptPreviewDto,
  type AgentPromptVersionDto,
  type AgentToolInfo,
  type AiAgentDto,
  type AiPriceDto,
  type AiProviderDto,
  type AiProviderTestResult,
  type AiToolKitDto,
  type AiUsagePurpose,
  type AiUsageReport,
  type aiAgentCreateInput,
  type aiAgentUpdateInput,
  type aiPriceInput,
  type aiProviderCreateInput,
  type aiProviderUpdateInput,
  type aiUsageQuery,
  type McpInstructionsMode,
  type McpServerDto,
  type McpToolInfo,
  type mcpServerCreateInput,
  type mcpServerUpdateInput,
  t,
  type toolKitCreateInput,
  type toolKitDuplicateInput,
  type toolKitUpdateInput,
} from '@moneyflow/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { createLlmClient, LlmError } from '../agents/llm';
import { connectMcp } from '../agents/mcp-client';
import { assemblePrompt, loadPromptInputs, promptParts } from '../agents/prompt';
import { usageDto } from '../agents/store';
import { internalTool, internalTools } from '../agents/tools-runtime';
import { type Actor, loadAccess } from '../authz/access';
import type { ServiceContext } from '../context';
import { badRequest, findPgError, notFound, unprocessable } from '../errors';
import { deleteOrArchive, withTx } from './tx';
import { iso } from './util';

/*
 * Administração dos agentes (spec 011, só admin): provedores (chave
 * write-only: grava, nunca devolve; a tela vê api_key_hint), preços, agentes
 * (com o kit de ferramentas e os vínculos MCP), kits de ferramentas (spec
 * 021), servidores MCP (cabeçalhos write-only; a tela vê só
 * os nomes) e o painel de uso. Testar conexão e listar tools leem os segredos
 * só pelas funções admin_* do banco, que exigem um admin ativo.
 */

/* ---------------- provedores ---------------- */

const PROVIDER_COLUMNS = sql`p.id, p.name, p.kind, p.base_url, p.api_key_hint, p.embedding_model, p.is_active, p.log_bodies, p.notes,
  p.archived_at, p.created_at`;

type ProviderRow = {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai';
  base_url: string | null;
  api_key_hint: string | null;
  embedding_model: string | null;
  is_active: boolean;
  log_bodies: boolean;
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
  logBodies: r.log_bodies,
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

export async function getProvider(db: Executor, id: string): Promise<AiProviderDto> {
  const result = await db.execute<ProviderRow>(sql`SELECT ${PROVIDER_COLUMNS} FROM ai_providers p WHERE p.id = ${id}`);
  if (!result.rows[0]) throw notFound();
  return providerDto(result.rows[0]);
}

export async function createProvider(ctx: ServiceContext, input: z.output<typeof aiProviderCreateInput>) {
  ctx.access.assertAdmin();
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_providers (name, kind, base_url, api_key, embedding_model, is_active, log_bodies, notes, created_by_user_id)
      VALUES (${input.name}, ${input.kind}, ${input.baseUrl}, ${input.apiKey}, ${input.embeddingModel}, ${input.isActive}, ${input.logBodies},
              ${input.notes}, ${ctx.access.actor.id})
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
  if (input.logBodies !== undefined) sets.push(sql`log_bodies = ${input.logBodies}`);
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
  // Registrado como test_connection (spec 023), com as tentativas do invólucro.
  const client = createLlmClient(await adminCredentials(ctx, provider), {
    db: ctx.db,
    providerId: provider.id,
    userId: ctx.access.actor.id,
    logBodies: provider.logBodies,
    maxAttempts: ctx.config.aiRequestMaxAttempts,
    backoffMs: ctx.config.aiRequestBackoffMs,
  });
  try {
    const models = await client.listModels('test_connection');
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
  return internalTools().map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    kind: tool.kind,
    category: tool.category,
    destructive: tool.destructive === true,
    suggestedMode: tool.secrets?.length ? 'ask' : tool.suggestedMode,
    adminOnly: tool.adminOnly === true,
    secret: Boolean(tool.secrets?.length),
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
  tool_kit_id: string | null;
  tool_kit_name: string | null;
  color_slot: number;
  icon: string | null;
  is_active: boolean;
  use_for_flows: boolean;
  prompt_version: number | null;
  archived_at: unknown;
  created_at: unknown;
};

async function loadAgents(db: Executor, where = sql`true`): Promise<AiAgentDto[]> {
  const result = await db.execute<AgentRow>(sql`
    SELECT a.id, a.name, a.description, a.system_prompt, a.provider_id, p.name AS provider_name, a.model, a.params, a.tool_kit_id,
           k.name AS tool_kit_name, a.color_slot, a.icon, a.is_active, a.use_for_flows, a.archived_at, a.created_at,
           (SELECT max(v.version) FROM ai_agent_prompt_versions v WHERE v.agent_id = a.id) AS prompt_version
      FROM ai_agents a LEFT JOIN ai_providers p ON p.id = a.provider_id LEFT JOIN ai_tool_kits k ON k.id = a.tool_kit_id
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
    toolKitId: r.tool_kit_id,
    toolKitName: r.tool_kit_name,
    colorSlot: Number(r.color_slot),
    icon: r.icon,
    isActive: r.is_active,
    useForFlows: r.use_for_flows,
    promptVersion: r.prompt_version === null ? null : Number(r.prompt_version),
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

/** O kit escolhido no agente precisa existir (o 23503 da FK diria "em uso"). */
async function checkKit(db: Executor, kitId: string | null | undefined) {
  if (!kitId) return;
  const found = await db.execute(sql`SELECT 1 FROM ai_tool_kits WHERE id = ${kitId}`);
  if (found.rows.length === 0) throw badRequest(t.agents.errors.toolKitNotFound);
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

/** Só um agente atende os fluxos: desmarca o atual antes de marcar outro (na mesma transação). */
async function clearFlowAgent(tx: Tx, exceptId: string | null) {
  await tx.execute(sql`UPDATE ai_agents SET use_for_flows = false WHERE use_for_flows ${exceptId ? sql`AND id <> ${exceptId}` : sql``}`);
}

export async function createAgent(ctx: ServiceContext, input: z.output<typeof aiAgentCreateInput>) {
  ctx.access.assertAdmin();
  await checkKit(ctx.db, input.toolKitId);
  const id = await withTx(ctx, async (tx) => {
    if (input.useForFlows) await clearFlowAgent(tx, null);
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_agents (name, description, system_prompt, provider_id, model, params, tool_kit_id, color_slot, icon, is_active,
                             use_for_flows, created_by_user_id)
      VALUES (${input.name}, ${input.description}, ${input.systemPrompt}, ${input.providerId}, ${input.model},
              ${JSON.stringify(input.params)}::jsonb, ${input.toolKitId}, ${input.colorSlot}, ${input.icon}, ${input.isActive},
              ${input.useForFlows}, ${ctx.access.actor.id})
      RETURNING id`);
    const agentId = result.rows[0]!.id;
    // A versão 1 do prompt, com o autor e a nota (sem ela, o banco a criaria no COMMIT).
    await insertPromptVersion(tx, agentId, input.systemPrompt, input.promptNote, ctx.access.actor.id, null);
    if (input.mcpServers) await setLinks(tx, agentId, input.mcpServers);
    return agentId;
  });
  return getAgent(ctx.db, id);
}

export async function updateAgent(ctx: ServiceContext, id: string, input: z.output<typeof aiAgentUpdateInput>) {
  ctx.access.assertAdmin();
  const current = await getAgent(ctx.db, id);
  await checkKit(ctx.db, input.toolKitId);
  // O prompt muda só criando uma versão (o banco copia o conteúdo para o agente; spec 022).
  const newPrompt = input.systemPrompt !== undefined && input.systemPrompt !== current.systemPrompt ? input.systemPrompt : null;
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
  if (input.providerId !== undefined) sets.push(sql`provider_id = ${input.providerId}`);
  if (input.model !== undefined) sets.push(sql`model = ${input.model}`);
  if (input.params !== undefined) sets.push(sql`params = ${JSON.stringify(input.params)}::jsonb`);
  if (input.toolKitId !== undefined) sets.push(sql`tool_kit_id = ${input.toolKitId}`);
  if (input.colorSlot !== undefined) sets.push(sql`color_slot = ${input.colorSlot}`);
  if (input.icon !== undefined) sets.push(sql`icon = ${input.icon}`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  // Desativar o agente dos fluxos tira a marca no mesmo UPDATE (o banco exige marcado = ativo).
  if (input.useForFlows !== undefined) sets.push(sql`use_for_flows = ${input.useForFlows}`);
  else if (input.isActive === false) sets.push(sql`use_for_flows = false`);
  await withTx(ctx, async (tx) => {
    if (input.useForFlows) await clearFlowAgent(tx, id);
    if (newPrompt !== null) await insertPromptVersion(tx, id, newPrompt, input.promptNote, ctx.access.actor.id, null);
    if (sets.length > 0) await tx.execute(sql`UPDATE ai_agents SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    if (input.mcpServers) await setLinks(tx, id, input.mcpServers);
  });
  return getAgent(ctx.db, id);
}

/* ---------------- versões do prompt (spec 022) ---------------- */

/** Nova versão (o banco atribui o número, travando o agente, e copia o conteúdo para ai_agents.system_prompt). */
async function insertPromptVersion(
  tx: Tx,
  agentId: string,
  content: string,
  note: string | null | undefined,
  authorId: string,
  restoredFrom: string | null,
) {
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO ai_agent_prompt_versions (agent_id, content, note, created_by_user_id, restored_from_version_id)
    VALUES (${agentId}, ${content}, ${note ?? null}, ${authorId}, ${restoredFrom})
    RETURNING id`);
  return result.rows[0]!.id;
}

export async function listPromptVersions(ctx: ServiceContext, agentId: string): Promise<AgentPromptVersionDto[]> {
  ctx.access.assertAdmin();
  await getAgent(ctx.db, agentId);
  const result = await ctx.db.execute<{
    id: string;
    version: number;
    content: string;
    note: string | null;
    created_by_user_id: string | null;
    username: string | null;
    restored_from_version_id: string | null;
    restored_from_version: number | null;
    created_at: unknown;
  }>(sql`
    SELECT v.id, v.version, v.content, v.note, v.created_by_user_id, u.username, v.restored_from_version_id,
           r.version AS restored_from_version, v.created_at
      FROM ai_agent_prompt_versions v
      LEFT JOIN users u ON u.id = v.created_by_user_id
      LEFT JOIN ai_agent_prompt_versions r ON r.id = v.restored_from_version_id
     WHERE v.agent_id = ${agentId}
     ORDER BY v.version DESC`);
  return result.rows.map((r) => ({
    id: r.id,
    version: Number(r.version),
    content: r.content,
    note: r.note,
    createdByUserId: r.created_by_user_id,
    createdByUsername: r.username,
    restoredFromVersionId: r.restored_from_version_id,
    restoredFromVersion: r.restored_from_version === null ? null : Number(r.restored_from_version),
    createdAt: iso(r.created_at)!,
  }));
}

/** Restaurar = versão nova com o conteúdo antigo e a nota "Restaurada da versão N". */
export async function restorePromptVersion(ctx: ServiceContext, agentId: string, versionId: string) {
  ctx.access.assertAdmin();
  await getAgent(ctx.db, agentId);
  const found = await ctx.db.execute<{ version: number; content: string }>(
    sql`SELECT version, content FROM ai_agent_prompt_versions WHERE id = ${versionId} AND agent_id = ${agentId}`,
  );
  const source = found.rows[0];
  if (!source) throw notFound(t.agents.errors.promptVersionNotFound);
  await withTx(ctx, (tx) =>
    insertPromptVersion(
      tx,
      agentId,
      source.content,
      t.agents.systemPrompt.restoredNote(Number(source.version)),
      ctx.access.actor.id,
      versionId,
    ),
  );
  return getAgent(ctx.db, agentId);
}

/** "Ver prompt montado": o prompt final do agente para um usuário (conversa comum, sem tela), sem chamar o modelo. */
export async function previewPrompt(ctx: ServiceContext, agentId: string, userId: string): Promise<AgentPromptPreviewDto> {
  ctx.access.assertAdmin();
  const agent = await getAgent(ctx.db, agentId);
  const [user] = await ctx.db.select(userColumns).from(users).where(eq(users.id, userId));
  if (!user) throw notFound();
  const actor: Actor = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role as Actor['role'],
    isActive: user.isActive,
  };
  const access = await loadAccess(ctx.db, actor);
  const inputs = await loadPromptInputs(ctx.db, access, { id: agent.id, name: agent.name, system_prompt: agent.systemPrompt }, null);
  const prompt = assemblePrompt(inputs, { purpose: null, screen: null });
  return { userId: user.id, username: user.username, parts: promptParts(prompt), volatileVariables: prompt.volatileVariables };
}

export async function deleteAgent(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await getAgent(ctx.db, id);
  return withTx(ctx, (tx) =>
    deleteOrArchive(
      tx,
      async (sp) => (await sp.execute(sql`DELETE FROM ai_agents WHERE id = ${id} RETURNING id`)).rows.length,
      (t2) => t2.execute(sql`UPDATE ai_agents SET is_active = false, use_for_flows = false, archived_at = now() WHERE id = ${id}`),
    ),
  );
}

/* ---------------- kits de ferramentas (spec 021) ---------------- */

type ToolKitRow = { id: string; name: string; description: string | null; created_at: unknown; updated_at: unknown };

async function loadToolKits(db: Executor, where = sql`true`): Promise<AiToolKitDto[]> {
  const kits = await db.execute<ToolKitRow>(sql`
    SELECT k.id, k.name, k.description, k.created_at, k.updated_at FROM ai_tool_kits k WHERE ${where} ORDER BY lower(k.name)`);
  if (kits.rows.length === 0) return [];
  const ids = `{${kits.rows.map((k) => k.id).join(',')}}`;
  const tools = await db.execute<{ kit_id: string; tool_name: string; mode: 'allow' | 'ask' }>(sql`
    SELECT kit_id, tool_name, mode FROM ai_tool_kit_tools WHERE kit_id = ANY(${ids}::uuid[]) ORDER BY tool_name`);
  const agents = await db.execute<{ tool_kit_id: string; id: string; name: string; archived: boolean }>(sql`
    SELECT tool_kit_id, id, name, archived_at IS NOT NULL AS archived FROM ai_agents
     WHERE tool_kit_id = ANY(${ids}::uuid[]) ORDER BY archived_at NULLS FIRST, lower(name)`);
  // Na ordem do registro (categorias da tela); nomes que saíram do registro vêm no fim.
  const order = new Map(internalTools().map((tool, index) => [tool.name, index]));
  const rank = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER;
  return kits.rows.map((k) => ({
    id: k.id,
    name: k.name,
    description: k.description,
    tools: tools.rows
      .filter((x) => x.kit_id === k.id)
      .map((x) => ({ name: x.tool_name, mode: x.mode }))
      .sort((a, b) => rank(a.name) - rank(b.name)),
    agents: agents.rows.filter((a) => a.tool_kit_id === k.id).map((a) => ({ id: a.id, name: a.name, archived: a.archived })),
    createdAt: iso(k.created_at)!,
    updatedAt: iso(k.updated_at)!,
  }));
}

export async function listToolKits(ctx: ServiceContext): Promise<AiToolKitDto[]> {
  ctx.access.assertAdmin();
  return loadToolKits(ctx.db);
}

async function getToolKitRow(db: Executor, id: string) {
  const [kit] = await loadToolKits(db, sql`k.id = ${id}`);
  if (!kit) throw notFound(t.agents.errors.toolKitNotFound);
  return kit;
}

export async function getToolKit(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  return getToolKitRow(ctx.db, id);
}

/** Valida as tools contra o registro; as de segredo ficam sempre em ask. */
function kitToolRows(tools: { name: string; mode: 'allow' | 'ask' }[]) {
  const unknown = tools.filter((x) => !internalTool(x.name)).map((x) => x.name);
  if (unknown.length > 0) throw badRequest(t.agents.errors.toolUnknown(unknown.join(', ')));
  return tools.map((x) => ({ name: x.name, mode: internalTool(x.name)!.secrets?.length ? ('ask' as const) : x.mode }));
}

/** Substitui o conjunto de tools do kit (só o que mudou, para a auditoria contar a história certa). */
async function setKitTools(tx: Tx, kitId: string, tools: { name: string; mode: 'allow' | 'ask' }[]) {
  const keep = `{${tools.map((x) => `"${x.name}"`).join(',')}}`;
  await tx.execute(sql`DELETE FROM ai_tool_kit_tools WHERE kit_id = ${kitId} AND NOT (tool_name = ANY(${keep}::text[]))`);
  if (tools.length === 0) return;
  await tx.execute(sql`
    INSERT INTO ai_tool_kit_tools (kit_id, tool_name, mode)
    SELECT ${kitId}::uuid, x.name, x.mode FROM json_to_recordset(${JSON.stringify(tools)}::json) AS x(name text, mode text)
    ON CONFLICT (kit_id, tool_name) DO UPDATE SET mode = EXCLUDED.mode WHERE ai_tool_kit_tools.mode <> EXCLUDED.mode`);
}

export async function createToolKit(ctx: ServiceContext, input: z.output<typeof toolKitCreateInput>) {
  ctx.access.assertAdmin();
  const tools = kitToolRows(input.tools);
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_tool_kits (name, description, created_by_user_id)
      VALUES (${input.name}, ${input.description}, ${ctx.access.actor.id}) RETURNING id`);
    const kitId = result.rows[0]!.id;
    await setKitTools(tx, kitId, tools);
    return kitId;
  });
  return getToolKitRow(ctx.db, id);
}

export async function updateToolKit(ctx: ServiceContext, id: string, input: z.output<typeof toolKitUpdateInput>) {
  ctx.access.assertAdmin();
  await getToolKitRow(ctx.db, id);
  const tools = input.tools ? kitToolRows(input.tools) : null;
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
  await withTx(ctx, async (tx) => {
    if (sets.length > 0) await tx.execute(sql`UPDATE ai_tool_kits SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    if (tools) {
      await setKitTools(tx, id, tools);
      // Mudar só as tools também conta como edição do kit.
      if (sets.length === 0) await tx.execute(sql`UPDATE ai_tool_kits SET updated_at = now() WHERE id = ${id}`);
    }
  });
  return getToolKitRow(ctx.db, id);
}

/** Cópia do kit para ajustar: "Cópia de <nome>" (com " (n)" se já existir), as mesmas tools e modos, sem agentes. */
export async function duplicateToolKit(ctx: ServiceContext, id: string, input: z.output<typeof toolKitDuplicateInput>) {
  ctx.access.assertAdmin();
  const source = await getToolKitRow(ctx.db, id);
  const base = (input.name ?? t.agents.toolKits.copyName(source.name)).slice(0, 120);
  let name = base;
  if (!input.name) {
    const taken = await ctx.db.execute<{ name: string }>(sql`SELECT lower(name) AS name FROM ai_tool_kits`);
    const names = new Set(taken.rows.map((r) => r.name));
    for (let n = 2; names.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, 120 - suffix.length)}${suffix}`;
    }
  }
  const tools = source.tools.filter((x) => internalTool(x.name));
  return createToolKit(ctx, { name, description: source.description, tools });
}

/** Só o kit sem agentes ligados (inclusive os arquivados); em uso, o erro lista os agentes. */
export async function deleteToolKit(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  await getToolKitRow(ctx.db, id);
  try {
    await withTx(ctx, (tx) => tx.execute(sql`DELETE FROM ai_tool_kits WHERE id = ${id}`));
  } catch (error) {
    const pg = findPgError(error);
    if (pg?.code !== '23503' || pg.constraint !== 'ai_agents_tool_kit_id_fkey') throw error;
    const agents = await ctx.db.execute<{ name: string }>(
      sql`SELECT name FROM ai_agents WHERE tool_kit_id = ${id} ORDER BY archived_at NULLS FIRST, lower(name)`,
    );
    throw unprocessable(t.agents.errors.toolKitInUse(agents.rows.map((r) => r.name)), 'tool_kit_in_use');
  }
  return { deleted: true };
}

/* ---------------- servidores MCP ---------------- */

type McpRow = {
  id: string;
  name: string;
  url: string;
  secret_header_names: string[];
  visibility: McpServerDto['visibility'];
  instructions_mode: McpInstructionsMode;
  instructions_cache: string | null;
  is_active: boolean;
  tools_cache: McpToolInfo[] | null;
  tools_cached_at: unknown;
  tools_error: string | null;
  notes: string | null;
  archived_at: unknown;
  created_at: unknown;
};

const MCP_COLUMNS = sql`s.id, s.name, s.url, s.secret_header_names, s.visibility, s.instructions_mode, s.instructions_cache, s.is_active,
  s.tools_cache, s.tools_cached_at, s.tools_error, s.notes, s.archived_at, s.created_at`;

/** O banco aceita até 50 mil caracteres no cache das instructions. */
const MAX_MCP_INSTRUCTIONS = 50_000;

const mcpDto = (r: McpRow): McpServerDto => ({
  id: r.id,
  name: r.name,
  url: r.url,
  headerNames: r.secret_header_names ?? [],
  visibility: r.visibility,
  instructionsMode: r.instructions_mode,
  instructions: r.instructions_cache,
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
      INSERT INTO mcp_servers (name, url, secret_headers, visibility, instructions_mode, is_active, notes, created_by_user_id)
      VALUES (${input.name}, ${input.url}, ${JSON.stringify(input.headers)}::jsonb, ${input.visibility}, ${input.instructionsMode},
              ${input.isActive}, ${input.notes}, ${ctx.access.actor.id})
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
  if (input.instructionsMode !== undefined) sets.push(sql`instructions_mode = ${input.instructionsMode}`);
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

/** Testa o servidor e atualiza o cache de tools e das instructions do initialize (ou grava o erro). */
export async function refreshMcpServer(ctx: ServiceContext, id: string) {
  ctx.access.assertAdmin();
  const server = await getMcpServer(ctx.db, id);
  const headers = await ctx.db.execute<{ headers: Record<string, string> }>(
    sql`SELECT admin_mcp_server_headers(${id}::uuid, ${ctx.access.actor.id}::uuid) AS headers`,
  );
  let tools: McpToolInfo[] | null = null;
  let instructions: string | null = null;
  let error: string | null = null;
  try {
    const session = await connectMcp(server.url, headers.rows[0]?.headers ?? {});
    try {
      instructions = session.instructions()?.slice(0, MAX_MCP_INSTRUCTIONS) ?? null;
      tools = await session.listTools();
    } finally {
      await session.close();
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 2000) || 'erro desconhecido';
  }
  await withTx(ctx, (tx) =>
    tools
      ? tx.execute(sql`UPDATE mcp_servers SET tools_cache = ${JSON.stringify(tools)}::jsonb, tools_cached_at = now(), tools_error = NULL,
                               instructions_cache = ${instructions}
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
  const byPurpose = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT u.* FROM ai_usage_monthly_by_purpose u WHERE ${period} ORDER BY u.month DESC, u.purpose, u.currency NULLS LAST`);
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
    byPurpose: byPurpose.rows.map((r) => ({
      ...usageDto(r as never),
      month: month(r.month),
      purpose: r.purpose as AiUsagePurpose,
      runs: Number(r.runs),
      users: Number(r.users),
    })),
  };
}
