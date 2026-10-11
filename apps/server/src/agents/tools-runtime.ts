import {
  AGENT_TOOLS,
  type AgentToolDef,
  type McpToolInfo,
  needsConfirmation,
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
 * Conjunto de tools de uma execução: as internas habilitadas no agente
 * (enabled_tools NULL = todas) e as dos servidores MCP efetivos do agente
 * (effective_agent_mcp_servers, prefixadas pelo servidor). Tools MCP contam
 * como escrita (pedem confirmação) salvo readOnlyHint = true.
 */

const MAX_RESULT_CHARS = 60_000;

export type ResolvedTool =
  | { source: 'internal'; name: string; def: AgentToolDef; write: boolean; title: string }
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

export class RunTools {
  private sessions = new Map<string, Promise<McpSession>>();

  private constructor(
    readonly list: LlmTool[],
    private readonly byName: Map<string, ResolvedTool>,
    private readonly servers: Map<string, { url: string; name: string }>,
    private readonly headersFor: (serverId: string) => Promise<Record<string, string>>,
  ) {}

  /**
   * Monta o conjunto do agente. `headersFor` lê os cabeçalhos secretos
   * (ai_run_mcp_headers na execução; admin_mcp_server_headers no teste do admin).
   */
  static async forAgent(
    db: ServiceContext['db'],
    agent: { id: string; enabledTools: string[] | null },
    headersFor: (serverId: string) => Promise<Record<string, string>>,
    opts: { mcp?: boolean } = {},
  ): Promise<RunTools> {
    const list: LlmTool[] = [];
    const byName = new Map<string, ResolvedTool>();
    const enabled = agent.enabledTools ? new Set(agent.enabledTools) : null;
    for (const def of AGENT_TOOLS) {
      if (enabled && !enabled.has(def.name)) continue;
      list.push({ name: def.name, description: def.description, inputSchema: toolJsonSchema(def) });
      byName.set(def.name, { source: 'internal', name: def.name, def, write: def.kind === 'write', title: def.title });
    }
    const servers = new Map<string, { url: string; name: string }>();
    if (opts.mcp === false) return new RunTools(list, byName, servers, headersFor);
    const rows = await db.execute<{ mcp_server_id: string; name: string; url: string; tools: McpToolInfo[] | null }>(
      sql`SELECT mcp_server_id, name, url, tools FROM effective_agent_mcp_servers WHERE agent_id = ${agent.id} ORDER BY name`,
    );
    for (const row of rows.rows) {
      servers.set(row.mcp_server_id, { url: row.url, name: row.name });
      for (const tool of row.tools ?? []) {
        const name = mcpExposedName(row.name, tool.name);
        if (byName.has(name)) continue;
        const readOnly = tool.annotations?.readOnlyHint === true;
        list.push({
          name,
          description: `[${row.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`.slice(0, 1024),
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        });
        byName.set(name, {
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
    return new RunTools(list, byName, servers, headersFor);
  }

  resolve(name: string): ResolvedTool | undefined {
    return this.byName.get(name);
  }

  requiresConfirmation(tool: ResolvedTool, agentRequires: boolean) {
    if (tool.source === 'internal') return needsConfirmation(tool.def, agentRequires);
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
    const handler = TOOL_HANDLERS[tool.name as keyof typeof TOOL_HANDLERS] as {
      preview?: (ctx: ServiceContext, input: unknown) => Promise<ToolPreview>;
    };
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
      const handler = TOOL_HANDLERS[tool.name as keyof typeof TOOL_HANDLERS] as {
        run: (ctx: ServiceContext, input: unknown, meta: ToolCallMeta) => Promise<unknown>;
      };
      const value = await handler.run(ctx, parsed, meta);
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
