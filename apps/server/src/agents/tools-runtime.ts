import {
  AGENT_TOOLS,
  type AgentToolDef,
  type AgentToolMode,
  formatFileSize,
  kitTools,
  type McpToolInfo,
  type ToolPreview,
  type ToolSecretField,
  t,
  toolJsonSchema,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { ServiceContext } from '../context';
import { AppError, translateDbError, unprocessable } from '../errors';
import { storeAttachment } from '../services/attachments';
import { withTx } from '../services/tx';
import type { LlmTool } from './llm';
import { connectMcp, type McpSession, mcpExposedName } from './mcp-client';
import { TOOL_HANDLERS, type ToolCallMeta } from './tool-handlers';
import type { GeneratedFile } from './tool-helpers';

/*
 * Conjunto de tools de uma execução (specs 011 e 021):
 *  - internas: pelo kit de ferramentas do agente (ai_agents.tool_kit_id →
 *    ai_tool_kit_tools). Sem kit, todas em allow; com kit, só as dele, no modo
 *    de cada uma. As de segredo ficam sempre em ask e as só de administrador
 *    saem quando quem aciona não é admin. O kit é relido a cada chamada ao
 *    modelo (refreshInternal), então mudar o kit vale na próxima chamada;
 *  - MCP: as dos servidores efetivos do agente (effective_agent_mcp_servers,
 *    prefixadas pelo servidor), montadas uma vez por execução. Contam como
 *    escrita (pedem confirmação) salvo readOnlyHint = true; o kit não se aplica.
 */

type InternalHandler = {
  run: (ctx: ServiceContext, input: unknown, meta: ToolCallMeta) => Promise<unknown>;
  preview?: (ctx: ServiceContext, input: unknown) => Promise<ToolPreview>;
};

/** Tools registradas fora de AGENT_TOOLS (testes: ainda não há tool só de admin real até a F13). */
const EXTRA_TOOLS = new Map<string, { def: AgentToolDef; handler: InternalHandler }>();

/** Registra uma tool interna extra; devolve a função que a remove. */
export function registerInternalTool(def: AgentToolDef, handler: InternalHandler): () => void {
  EXTRA_TOOLS.set(def.name, { def, handler });
  return () => {
    EXTRA_TOOLS.delete(def.name);
  };
}

/** Registro das tools internas: AGENT_TOOLS e as extras. */
export function internalTools(): AgentToolDef[] {
  return [...AGENT_TOOLS, ...[...EXTRA_TOOLS.values()].map((x) => x.def)];
}

export function internalTool(name: string): AgentToolDef | undefined {
  return internalTools().find((tool) => tool.name === name);
}

function handlerFor(name: string): InternalHandler {
  return EXTRA_TOOLS.get(name)?.handler ?? (TOOL_HANDLERS[name as keyof typeof TOOL_HANDLERS] as unknown as InternalHandler);
}

/** Kit do agente: null = sem kit (poder completo); senão nome → modo. */
export async function loadAgentKit(db: ServiceContext['db'], agentId: string): Promise<Map<string, AgentToolMode> | null> {
  const rows = await db.execute<{ tool_kit_id: string | null; tool_name: string | null; mode: AgentToolMode | null }>(sql`
    SELECT a.tool_kit_id, k.tool_name, k.mode
      FROM ai_agents a LEFT JOIN ai_tool_kit_tools k ON k.kit_id = a.tool_kit_id
     WHERE a.id = ${agentId}`);
  if (!rows.rows[0]?.tool_kit_id) return null;
  return new Map(rows.rows.filter((r) => r.tool_name && r.mode).map((r) => [r.tool_name!, r.mode!]));
}

const MAX_RESULT_CHARS = 60_000;

export type ResolvedTool =
  | { source: 'internal'; name: string; def: AgentToolDef; write: boolean; title: string; mode: AgentToolMode }
  | {
      source: 'mcp';
      name: string;
      serverId: string;
      serverName: string;
      toolName: string;
      write: boolean;
      title: string;
      destructive: boolean;
    };

/** `files` = anexos gerados (producesFile), ligados à mensagem da tool pelo runner. */
export type ToolOutcome = { content: string; isError: boolean; summary: string; raw?: unknown; files?: string[] };

const errorOutcome = (message: string): ToolOutcome => ({ content: message, isError: true, summary: message.slice(0, 200) });

/** Limite dos anexos (o banco recusa acima de 20 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Grava o arquivo gerado por uma tool (spec 027) como anexo do usuário e
 * devolve o valor para o modelo com só id, nome, tipo e tamanho.
 */
async function storeGeneratedFile(ctx: ServiceContext, value: unknown): Promise<{ value: unknown; files: string[] }> {
  if (!value || typeof value !== 'object' || !('file' in value)) return { value, files: [] };
  const { file, ...rest } = value as { file: GeneratedFile } & Record<string, unknown>;
  if (file.content.length > MAX_FILE_BYTES) {
    throw unprocessable(t.agents.errors.fileTooLarge(formatFileSize(file.content.length)), 'file_too_large');
  }
  const attachmentId = await withTx(ctx, (tx) => storeAttachment(tx, ctx, { name: file.fileName, mime: file.mime, content: file.content }));
  return {
    value: { ...rest, file: { attachmentId, fileName: file.fileName, mime: file.mime, sizeBytes: file.content.length } },
    files: [attachmentId],
  };
}

/** Troca qualquer ocorrência dos segredos por "[segredo]" (defesa: nenhum resultado os carrega). */
function scrubSecrets(outcome: ToolOutcome, secrets: Readonly<Record<string, string>>): ToolOutcome {
  const values = Object.values(secrets).filter((v) => v.length >= 4);
  if (values.length === 0) return outcome;
  const scrub = (text: string) => values.reduce((acc, v) => acc.split(v).join('[segredo]'), text);
  return { ...outcome, content: scrub(outcome.content), summary: scrub(outcome.summary), raw: undefined };
}

/**
 * Executa uma tool com segredo (spec 027) na requisição de decisão da API,
 * com os segredos em memória. O worker nunca executa essas tools: ele usa o
 * resultado que esta função produz (gravado no evento tool_result). O modelo
 * recebe o resultado do serviço e, por campo, "segredo definido" ou
 * "segredo mantido" — nunca o valor.
 */
export async function executeSecretTool(
  ctx: ServiceContext,
  name: string,
  input: Record<string, unknown>,
  meta: ToolCallMeta,
  fields: readonly ToolSecretField[],
): Promise<ToolOutcome> {
  const secrets = meta.secrets ?? {};
  const def = internalTool(name);
  if (!def?.secrets?.length) return errorOutcome(t.agents.errors.toolUnknown(name));
  try {
    const missing = fields.find((f) => f.required && !secrets[f.key]);
    if (missing) return errorOutcome(t.agents.errors.secretRequired(missing.label));
    const parsed = def.input.parse(input);
    const value = await handlerFor(name).run(ctx, parsed, meta);
    const status = Object.fromEntries(fields.map((f) => [f.label, secrets[f.key] ? t.agents.secrets.set : t.agents.secrets.kept] as const));
    const out =
      value && typeof value === 'object' && !Array.isArray(value) ? { secrets: status, ...value } : { secrets: status, result: value };
    return scrubSecrets({ content: resultText(out), isError: false, summary: summarize(value) }, secrets);
  } catch (error) {
    return scrubSecrets(errorOutcome(toolErrorMessage(error)), secrets);
  }
}

/** Texto do resultado para o modelo (JSON compacto, truncado). */
export function resultText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [resultado truncado: ${text.length} caracteres]` : text;
}

/** Mensagem segura de um erro de tool (regras do banco e de negócio em pt-BR). */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return t.agents.errors.toolInvalidInput(issue ? `${issue.path.join('.') || 'entrada'}: ${issue.message}` : 'inválida');
  }
  const db = translateDbError(error);
  if (db) return db.message;
  return t.errors.generic;
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(ns)`;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const label = v.description ?? v.name ?? v.title ?? v.id;
    if (typeof label === 'string') return label.slice(0, 120);
    if (Array.isArray(v.hits)) return `${v.hits.length} resultado(s)`;
    if (Array.isArray(v.lines)) return `${v.lines.length} linha(s)`;
  }
  return 'ok';
}

type ToolSet = { list: LlmTool[]; byName: Map<string, ResolvedTool> };
const emptySet = (): ToolSet => ({ list: [], byName: new Map() });

export class RunTools {
  private sessions = new Map<string, Promise<McpSession>>();
  private internal: ToolSet = emptySet();

  private constructor(
    private readonly agentId: string,
    private readonly opts: { internal: boolean; isAdmin: boolean },
    private readonly mcp: ToolSet,
    private readonly servers: Map<string, { url: string; name: string }>,
    private readonly headersFor: (serverId: string) => Promise<Record<string, string>>,
  ) {}

  /**
   * Monta o conjunto do agente. `headersFor` lê os cabeçalhos secretos
   * (ai_run_mcp_headers na execução). `internal: false` = sem tools internas
   * (fluxos automáticos); `isAdmin` = quem aciona é admin (tools adminOnly).
   */
  static async forAgent(
    db: ServiceContext['db'],
    agentId: string,
    headersFor: (serverId: string) => Promise<Record<string, string>>,
    opts: { internal?: boolean; mcp?: boolean; isAdmin: boolean },
  ): Promise<RunTools> {
    const mcp = emptySet();
    const servers = new Map<string, { url: string; name: string }>();
    if (opts.mcp !== false) {
      const rows = await db.execute<{ mcp_server_id: string; name: string; url: string; tools: McpToolInfo[] | null }>(
        sql`SELECT mcp_server_id, name, url, tools FROM effective_agent_mcp_servers WHERE agent_id = ${agentId} ORDER BY name`,
      );
      for (const row of rows.rows) {
        servers.set(row.mcp_server_id, { url: row.url, name: row.name });
        for (const tool of row.tools ?? []) {
          const name = mcpExposedName(row.name, tool.name);
          if (mcp.byName.has(name)) continue;
          const readOnly = tool.annotations?.readOnlyHint === true;
          mcp.list.push({
            name,
            description: `[${row.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`.slice(0, 1024),
            inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
          });
          mcp.byName.set(name, {
            source: 'mcp',
            name,
            serverId: row.mcp_server_id,
            serverName: row.name,
            toolName: tool.name,
            write: !readOnly,
            destructive: tool.annotations?.destructiveHint === true,
            title: tool.annotations?.title ?? tool.name,
          });
        }
      }
    }
    const tools = new RunTools(agentId, { internal: opts.internal !== false, isAdmin: opts.isAdmin }, mcp, servers, headersFor);
    await tools.refreshInternal(db);
    return tools;
  }

  /** Relê o kit do agente e remonta as tools internas (antes de cada chamada ao modelo). */
  async refreshInternal(db: ServiceContext['db']) {
    const next = emptySet();
    if (this.opts.internal) {
      const kit = await loadAgentKit(db, this.agentId);
      for (const { tool: def, mode } of kitTools(internalTools(), kit, this.opts.isAdmin)) {
        next.list.push({ name: def.name, description: def.description, inputSchema: toolJsonSchema(def) });
        next.byName.set(def.name, { source: 'internal', name: def.name, def, write: def.kind === 'write', title: def.title, mode });
      }
    }
    this.internal = next;
  }

  /** Tools enviadas ao modelo: internas (do kit) e as dos servidores MCP. */
  get list(): LlmTool[] {
    return [...this.internal.list, ...this.mcp.list.filter((tool) => !this.internal.byName.has(tool.name))];
  }

  resolve(name: string): ResolvedTool | undefined {
    return this.internal.byName.get(name) ?? this.mcp.byName.get(name);
  }

  /** Pede aprovação? Internas: o modo do kit (sem kit = allow; segredo = ask). MCP: escrita, salvo readOnlyHint. */
  requiresConfirmation(tool: ResolvedTool) {
    if (tool.source === 'internal') return tool.mode === 'ask';
    return tool.write;
  }

  /** Valida a entrada e calcula a prévia de uma escrita (lança AppError se não pode). */
  async preview(ctx: ServiceContext, tool: ResolvedTool, input: Record<string, unknown>): Promise<ToolPreview> {
    if (tool.source === 'mcp') {
      return {
        title: tool.title,
        summary: `Servidor MCP ${tool.serverName}`,
        action: 'other',
        rows: Object.entries(input).map(([key, value]) => ({
          label: key,
          after: typeof value === 'string' ? value : JSON.stringify(value),
        })),
        warnings: tool.destructive ? ['Ação externa que pode apagar ou desfazer dados.'] : [],
      };
    }
    const parsed = tool.def.input.parse(input);
    const handler = handlerFor(tool.name);
    if (handler.preview) return handler.preview(ctx, parsed);
    return { title: tool.title, summary: '', action: 'other', rows: [] };
  }

  async execute(ctx: ServiceContext, tool: ResolvedTool, input: Record<string, unknown>, meta: ToolCallMeta): Promise<ToolOutcome> {
    try {
      if (tool.source === 'mcp') {
        const session = await this.session(tool.serverId);
        const result = await session.callTool(tool.toolName, input);
        return { content: resultText(result.text), isError: result.isError, summary: result.isError ? result.text.slice(0, 200) : 'ok' };
      }
      // Tools com segredo só rodam na decisão da API (executeSecretTool), com o valor digitado no cartão.
      if (tool.def.secrets?.length) return errorOutcome(t.agents.errors.secretNeedsConsole);
      const parsed = tool.def.input.parse(input);
      const ran = await handlerFor(tool.name).run(ctx, parsed, meta);
      const { value, files } = tool.def.producesFile ? await storeGeneratedFile(ctx, ran) : { value: ran, files: [] };
      return { content: resultText(value), isError: false, summary: summarize(value), raw: value, ...(files.length ? { files } : {}) };
    } catch (error) {
      const message =
        tool.source === 'mcp' && !(error instanceof AppError)
          ? t.agents.errors.mcpUnavailable(tool.serverName, error instanceof Error ? error.message.slice(0, 300) : String(error))
          : toolErrorMessage(error);
      return { content: message, isError: true, summary: message.slice(0, 200) };
    }
  }

  private session(serverId: string): Promise<McpSession> {
    let session = this.sessions.get(serverId);
    if (!session) {
      const server = this.servers.get(serverId)!;
      session = this.headersFor(serverId).then((headers) => connectMcp(server.url, headers));
      session.catch(() => this.sessions.delete(serverId));
      this.sessions.set(serverId, session);
    }
    return session;
  }

  async close() {
    for (const session of this.sessions.values()) await session.then((s) => s.close()).catch(() => {});
    this.sessions.clear();
  }
}
