import { type Executor, type Tx, userColumns, users } from '@moneyflow/db';
import {
  type AgentInferenceDto,
  type AgentPromptPreviewDto,
  type AgentPromptVersionDto,
  type AgentToolInfo,
  AI_INFERENCE_CAPABILITIES,
  AI_KIND_CAPABILITIES,
  type AiAgentDto,
  type AiCapability,
  type AiDefaultModels,
  type AiInferenceCapability,
  type AiPriceDto,
  type AiProviderCapabilityCheck,
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
  inferencesFromProvider,
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
import {
  createLlmClient,
  embed,
  type LlmClient,
  type LlmCredentials,
  LlmError,
  type RequestLogBase,
  speak,
  transcribe,
} from '../agents/llm';
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

const PROVIDER_COLUMNS = sql`p.id, p.name, p.kind, p.base_url, p.api_key_hint, p.capabilities, p.default_models, p.prompt_cache_enabled,
  p.thinking_enabled, p.is_active, p.log_bodies, p.notes, p.archived_at, p.created_at`;

type ProviderRow = {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai';
  base_url: string | null;
  api_key_hint: string | null;
  capabilities: AiCapability[];
  default_models: AiDefaultModels | null;
  prompt_cache_enabled: boolean;
  thinking_enabled: boolean;
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
  capabilities: r.capabilities ?? [],
  defaultModels: r.default_models ?? {},
  promptCacheEnabled: r.prompt_cache_enabled,
  thinkingEnabled: r.thinking_enabled,
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

const textArray = (items: readonly string[]) => `{${items.join(',')}}`;

/** Modelos padrão só das flags ligadas (a voz, com texto→áudio): o banco recusa os demais (spec 024). */
function modelsFor(models: AiDefaultModels, capabilities: readonly AiCapability[]): AiDefaultModels {
  const out: AiDefaultModels = {};
  for (const [key, value] of Object.entries(models) as [keyof AiDefaultModels, string | undefined][]) {
    if (!value) continue;
    const flag = key === 'speech_voice' ? 'speech' : key;
    if (capabilities.includes(flag)) out[key] = value;
  }
  return out;
}

const sameModels = (a: AiDefaultModels, b: AiDefaultModels) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function assertKindCapabilities(kind: 'anthropic' | 'openai', capabilities: readonly AiCapability[]) {
  if (capabilities.some((c) => !AI_KIND_CAPABILITIES[kind].includes(c))) throw badRequest(t.agents.errors.anthropicCapabilities);
}

export async function createProvider(ctx: ServiceContext, input: z.output<typeof aiProviderCreateInput>) {
  ctx.access.assertAdmin();
  const capabilities = input.capabilities ?? AI_KIND_CAPABILITIES[input.kind];
  assertKindCapabilities(input.kind, capabilities);
  // Omitidos, as flags, o cache e o raciocínio ficam com o padrão do banco (pelo tipo e pela base_url).
  const columns: SQL[] = [
    sql`name`,
    sql`kind`,
    sql`base_url`,
    sql`api_key`,
    sql`default_models`,
    sql`is_active`,
    sql`log_bodies`,
    sql`notes`,
    sql`created_by_user_id`,
  ];
  const values: SQL[] = [
    sql`${input.name}`,
    sql`${input.kind}`,
    sql`${input.baseUrl}`,
    sql`${input.apiKey}`,
    sql`${JSON.stringify(modelsFor(input.defaultModels, capabilities))}::jsonb`,
    sql`${input.isActive}`,
    sql`${input.logBodies}`,
    sql`${input.notes}`,
    sql`${ctx.access.actor.id}`,
  ];
  if (input.capabilities) {
    columns.push(sql`capabilities`);
    values.push(sql`${textArray(input.capabilities)}::text[]`);
  }
  if (input.promptCacheEnabled !== undefined) {
    columns.push(sql`prompt_cache_enabled`);
    values.push(sql`${input.promptCacheEnabled}`);
  }
  if (input.thinkingEnabled !== undefined) {
    columns.push(sql`thinking_enabled`);
    values.push(sql`${input.thinkingEnabled}`);
  }
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_providers (${sql.join(columns, sql`, `)}) VALUES (${sql.join(values, sql`, `)}) RETURNING id`);
    return result.rows[0]!.id;
  });
  return getProvider(ctx.db, id);
}

export async function updateProvider(ctx: ServiceContext, id: string, input: z.output<typeof aiProviderUpdateInput>) {
  ctx.access.assertAdmin();
  const current = await getProvider(ctx.db, id);
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.baseUrl !== undefined) sets.push(sql`base_url = ${input.baseUrl}`);
  if (input.clearApiKey) sets.push(sql`api_key = NULL`);
  else if (input.apiKey) sets.push(sql`api_key = ${input.apiKey}`);
  const capabilities = input.capabilities ?? current.capabilities;
  if (input.capabilities !== undefined) {
    assertKindCapabilities(current.kind, input.capabilities);
    sets.push(sql`capabilities = ${textArray(input.capabilities)}::text[]`);
  }
  // Desmarcar uma flag tira o modelo dela no mesmo UPDATE (o banco exige).
  const models = modelsFor(input.defaultModels ?? current.defaultModels, capabilities);
  if (!sameModels(models, current.defaultModels)) sets.push(sql`default_models = ${JSON.stringify(models)}::jsonb`);
  if (input.promptCacheEnabled !== undefined) sets.push(sql`prompt_cache_enabled = ${input.promptCacheEnabled}`);
  if (input.thinkingEnabled !== undefined) sets.push(sql`thinking_enabled = ${input.thinkingEnabled}`);
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
async function adminCredentials(ctx: ServiceContext, provider: AiProviderDto): Promise<LlmCredentials> {
  const result = await ctx.db.execute<{ key: string | null }>(
    sql`SELECT admin_ai_provider_api_key(${provider.id}::uuid, ${ctx.access.actor.id}::uuid) AS key`,
  );
  return {
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: result.rows[0]?.key ?? null,
    promptCache: provider.promptCacheEnabled,
    thinking: provider.thinkingEnabled,
  };
}

/** PNG 1×1 (a chamada mínima da visão). */
const TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** WAV de 1 s de silêncio (16 kHz, mono, 16 bits): a chamada mínima da transcrição. */
function silentWav(seconds = 1, rate = 16000): Buffer {
  const samples = Math.round(seconds * rate);
  const data = samples * 2;
  const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + data, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(data, 40);
  return out;
}

const errorText = (error: unknown) =>
  (error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Listagem de modelos que o servidor não tem (compatíveis): "listagem indisponível", sem erro. */
const listingMissing = (error: unknown) => error instanceof LlmError && [404, 405, 501].includes(error.status ?? 0);

/** Uma chamada mínima por flag ligada (registrada como test_connection, spec 023). */
async function testCapability(
  credentials: LlmCredentials,
  client: LlmClient,
  log: RequestLogBase,
  provider: AiProviderDto,
  capability: AiCapability,
): Promise<AiProviderCapabilityCheck> {
  const models = provider.defaultModels;
  const model = capability === 'vision' ? (models.vision ?? models.text ?? null) : (models[capability] ?? null);
  if (!model) return { capability, ok: true, model: null, message: t.agentsUi.admin.providers.checkSkipped };
  try {
    if (capability === 'text' || capability === 'vision') {
      await client.chat({
        model,
        system: 'Teste de conexão. Responda só "ok".',
        messages: [
          {
            role: 'user',
            content:
              capability === 'vision'
                ? [
                    { type: 'attachment', attachment_id: 'teste', file_name: 'teste.png', mime_type: 'image/png' },
                    { type: 'text', text: 'ok' },
                  ]
                : [{ type: 'text', text: 'ok' }],
          },
        ],
        tools: [],
        params: { max_tokens: 16 },
        loadAttachment: async () => ({ fileName: 'teste.png', mime: 'image/png', data: TEST_IMAGE }),
        operation: 'test_connection',
      });
    } else if (capability === 'embeddings') {
      await embed(credentials, model, ['teste de conexão'], log, 'test_connection');
    } else if (capability === 'transcription') {
      await transcribe(credentials, model, { fileName: 'teste.wav', mime: 'audio/wav', data: silentWav() }, log, {
        operation: 'test_connection',
      });
    } else {
      await speak(credentials, model, models.speech_voice ?? 'alloy', 'ok', log, { operation: 'test_connection' });
    }
    return { capability, ok: true, model, message: t.agentsUi.admin.providers.checkOk };
  } catch (error) {
    return { capability, ok: false, model, message: errorText(error) };
  }
}

export async function testProvider(ctx: ServiceContext, id: string): Promise<AiProviderTestResult> {
  ctx.access.assertAdmin();
  const provider = await getProvider(ctx.db, id);
  const credentials = await adminCredentials(ctx, provider);
  // Registrado como test_connection (spec 023), com as tentativas do invólucro.
  const log: RequestLogBase = {
    db: ctx.db,
    providerId: provider.id,
    userId: ctx.access.actor.id,
    logBodies: provider.logBodies,
    maxAttempts: ctx.config.aiRequestMaxAttempts,
    backoffMs: ctx.config.aiRequestBackoffMs,
  };
  const client = createLlmClient(credentials, log);
  let models: string[] = [];
  let modelsUnavailable = false;
  let listError: string | null = null;
  try {
    models = await client.listModels('test_connection');
  } catch (error) {
    if (listingMissing(error)) modelsUnavailable = true;
    else listError = errorText(error);
  }
  const checks: AiProviderCapabilityCheck[] = [];
  // Sem conexão nenhuma (a listagem falhou de verdade), as flags não são testadas.
  if (!listError)
    for (const capability of provider.capabilities) checks.push(await testCapability(credentials, client, log, provider, capability));
  const failed = checks.filter((c) => !c.ok);
  const ok = !listError && failed.length === 0;
  const message = listError
    ? t.agents.errors.providerError(listError)
    : failed.length > 0
      ? t.agents.errors.providerError(failed.map((c) => `${t.agents.capabilities[c.capability]}: ${c.message}`).join(' · '))
      : modelsUnavailable
        ? t.agentsUi.admin.providers.modelsUnavailable
        : `Conexão ok: ${models.length} modelo(s) disponível(is).`;
  return { ok, message, models, modelsUnavailable, checks };
}

/** Modelos que o provedor oferece (a listagem dele, registrada como list_models; tool list_provider_models). */
export async function listProviderModels(ctx: ServiceContext, id: string): Promise<{ models: string[]; unavailable: boolean }> {
  ctx.access.assertAdmin();
  const provider = await getProvider(ctx.db, id);
  const client = createLlmClient(await adminCredentials(ctx, provider), {
    db: ctx.db,
    providerId: provider.id,
    userId: ctx.access.actor.id,
    logBodies: provider.logBodies,
    maxAttempts: ctx.config.aiRequestMaxAttempts,
    backoffMs: ctx.config.aiRequestBackoffMs,
  });
  try {
    return { models: await client.listModels('list_models'), unavailable: false };
  } catch (error) {
    if (listingMissing(error)) return { models: [], unavailable: true };
    throw unprocessable(t.agents.errors.providerError(errorText(error)), 'provider_error');
  }
}

/* ---------------- preços ---------------- */

export async function listPrices(ctx: ServiceContext): Promise<AiPriceDto[]> {
  ctx.access.assertAdmin();
  const result = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT m.id, m.provider_id, p.name AS provider_name, m.model, m.currency, m.input_price_per_million, m.output_price_per_million,
           m.cache_write_price_per_million, m.cache_read_price_per_million, m.audio_input_per_minute, m.speech_per_million_chars,
           m.valid_from
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
    audioInputPerMinute: r.audio_input_per_minute === null ? null : Number(r.audio_input_per_minute),
    speechPerMillionChars: r.speech_per_million_chars === null ? null : Number(r.speech_per_million_chars),
    validFrom: iso(r.valid_from)!,
  }));
}

export async function createPrice(ctx: ServiceContext, input: z.output<typeof aiPriceInput>) {
  ctx.access.assertAdmin();
  await getProvider(ctx.db, input.providerId);
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_model_prices (provider_id, model, currency, input_price_per_million, output_price_per_million,
                                   cache_write_price_per_million, cache_read_price_per_million, audio_input_per_minute,
                                   speech_per_million_chars, valid_from)
      VALUES (${input.providerId}, ${input.model}, ${input.currency}, ${input.inputPricePerMillion}, ${input.outputPricePerMillion},
              ${input.cacheWritePricePerMillion}, ${input.cacheReadPricePerMillion}, ${input.audioInputPerMinute},
              ${input.speechPerMillionChars}, coalesce(${input.validFrom ?? null}::timestamptz, now()))
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
  const inferences = await db.execute<{
    agent_id: string;
    capability: AiInferenceCapability;
    provider_id: string;
    provider_name: string;
    model: string | null;
    voice: string | null;
    effective_model: string | null;
    effective_voice: string | null;
  }>(sql`
    SELECT i.agent_id, i.capability, i.provider_id, p.name AS provider_name, i.model, i.voice,
           coalesce(i.model, p.default_models ->> i.capability,
                    CASE WHEN i.capability = 'vision' THEN p.default_models ->> 'text' END) AS effective_model,
           CASE WHEN i.capability = 'speech' THEN coalesce(i.voice, p.default_models ->> 'speech_voice') END AS effective_voice
      FROM ai_agent_inferences i JOIN ai_providers p ON p.id = i.provider_id
     ORDER BY array_position(${textArray(AI_INFERENCE_CAPABILITIES)}::text[], i.capability)`);
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
    inferences: inferences.rows
      .filter((i) => i.agent_id === r.id)
      .map(
        (i): AgentInferenceDto => ({
          capability: i.capability,
          providerId: i.provider_id,
          providerName: i.provider_name,
          model: i.model,
          voice: i.voice,
          effectiveModel: i.effective_model,
          effectiveVoice: i.effective_voice,
        }),
      ),
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

type InferenceInput = NonNullable<z.output<typeof aiAgentCreateInput>['inferences']>[number];

/**
 * Provedor padrão (spec 024): preenche o texto (se não veio) e as inferências que o provedor suporta e que não
 * vieram explicitamente.
 */
async function applyDefaultProvider(
  db: Executor,
  input: { defaultProviderId?: string; providerId?: string | null; inferences?: InferenceInput[] },
): Promise<{ providerId: string | null | undefined; inferences: InferenceInput[] | undefined }> {
  if (!input.defaultProviderId) return { providerId: input.providerId, inferences: input.inferences };
  const provider = await getProvider(db, input.defaultProviderId);
  const filled = inferencesFromProvider(provider);
  const given = new Map((input.inferences ?? []).map((x) => [x.capability, x]));
  for (const inference of filled.inferences) if (!given.has(inference.capability)) given.set(inference.capability, inference);
  return { providerId: input.providerId ?? filled.providerId, inferences: [...given.values()] };
}

/** Substitui as inferências do agente (só o que mudou, para a auditoria contar a história certa). */
async function setInferences(tx: Tx, agentId: string, inferences: InferenceInput[]) {
  const keep = inferences.map((x) => x.capability);
  await tx.execute(sql`
    DELETE FROM ai_agent_inferences WHERE agent_id = ${agentId} AND NOT (capability = ANY (${textArray(keep)}::text[]))`);
  for (const x of inferences) {
    const voice = x.capability === 'speech' ? x.voice : null;
    await tx.execute(sql`
      INSERT INTO ai_agent_inferences (agent_id, capability, provider_id, model, voice)
      VALUES (${agentId}, ${x.capability}, ${x.providerId}, ${x.model}, ${voice})
      ON CONFLICT (agent_id, capability) DO UPDATE
        SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, voice = EXCLUDED.voice
        WHERE (ai_agent_inferences.provider_id, ai_agent_inferences.model, ai_agent_inferences.voice)
              IS DISTINCT FROM (EXCLUDED.provider_id, EXCLUDED.model, EXCLUDED.voice)`);
  }
}

/** Só um agente atende os fluxos: desmarca o atual antes de marcar outro (na mesma transação). */
async function clearFlowAgent(tx: Tx, exceptId: string | null) {
  await tx.execute(sql`UPDATE ai_agents SET use_for_flows = false WHERE use_for_flows ${exceptId ? sql`AND id <> ${exceptId}` : sql``}`);
}

export async function createAgent(ctx: ServiceContext, input: z.output<typeof aiAgentCreateInput>) {
  ctx.access.assertAdmin();
  await checkKit(ctx.db, input.toolKitId);
  const filled = await applyDefaultProvider(ctx.db, input);
  const providerId = filled.providerId ?? null;
  const id = await withTx(ctx, async (tx) => {
    if (input.useForFlows) await clearFlowAgent(tx, null);
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_agents (name, description, system_prompt, provider_id, model, params, tool_kit_id, color_slot, icon, is_active,
                             use_for_flows, created_by_user_id)
      VALUES (${input.name}, ${input.description}, ${input.systemPrompt}, ${providerId}, ${input.model},
              ${JSON.stringify(input.params)}::jsonb, ${input.toolKitId}, ${input.colorSlot}, ${input.icon}, ${input.isActive},
              ${input.useForFlows}, ${ctx.access.actor.id})
      RETURNING id`);
    const agentId = result.rows[0]!.id;
    // A versão 1 do prompt, com o autor e a nota (sem ela, o banco a criaria no COMMIT).
    await insertPromptVersion(tx, agentId, input.systemPrompt, input.promptNote, ctx.access.actor.id, null);
    if (input.mcpServers) await setLinks(tx, agentId, input.mcpServers);
    if (filled.inferences) await setInferences(tx, agentId, filled.inferences);
    return agentId;
  });
  return getAgent(ctx.db, id);
}

export async function updateAgent(ctx: ServiceContext, id: string, input: z.output<typeof aiAgentUpdateInput>) {
  ctx.access.assertAdmin();
  const current = await getAgent(ctx.db, id);
  await checkKit(ctx.db, input.toolKitId);
  const filled = await applyDefaultProvider(ctx.db, input);
  // O prompt muda só criando uma versão (o banco copia o conteúdo para o agente; spec 022).
  const newPrompt = input.systemPrompt !== undefined && input.systemPrompt !== current.systemPrompt ? input.systemPrompt : null;
  const sets: SQL[] = [];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
  if (filled.providerId !== undefined) sets.push(sql`provider_id = ${filled.providerId}`);
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
    if (filled.inferences) await setInferences(tx, id, filled.inferences);
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
