import {
  AGENT_TOOLS,
  type AgentToolDef,
  type AgentToolMode,
  kitTools,
  type McpToolInfo,
  type ToolPreview,
  t,
  toolJsonSchema,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { ServiceContext } from '../context';
import { AppError, translateDbError } from '../errors';
import type { LlmTool } from './llm';
import { connectMcp, type McpSession, mcpExposedName } from './mcp-client';
import { TOOL_HANDLERS, type ToolCallMeta } from './tool-handlers';

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

export type ToolOutcome = { content: string; isError: boolean; summary: string; raw?: unknown };

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
      const parsed = tool.def.input.parse(input);
      const value = await handlerFor(tool.name).run(ctx, parsed, meta);
      return { content: resultText(value), isError: false, summary: summarize(value), raw: value };
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
