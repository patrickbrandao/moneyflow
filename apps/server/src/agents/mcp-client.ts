import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolInfo } from '@moneyflow/shared';

/*
 * MCP client (spec 011): só Streamable HTTP (sem stdio). Os cabeçalhos
 * secretos chegam do banco (ai_run_mcp_headers / admin_mcp_server_headers) e
 * nunca são logados. Uma sessão por servidor durante a execução.
 */

const TIMEOUT_MS = 60_000;

export type McpSession = {
  /** As instructions da resposta do initialize (spec 022); null = o servidor não mandou. */
  instructions(): string | null;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
};

export async function connectMcp(url: string, headers: Record<string, string>): Promise<McpSession> {
  const client = new Client({ name: 'moneyflow', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport, { timeout: TIMEOUT_MS });
  return {
    instructions() {
      const text = client.getInstructions();
      return typeof text === 'string' && text.trim() ? text : null;
    },
    async listTools() {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: TIMEOUT_MS });
        for (const tool of result.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations
              ? {
                  readOnlyHint: tool.annotations.readOnlyHint,
                  destructiveHint: tool.annotations.destructiveHint,
                  title: tool.annotations.title,
                }
              : undefined,
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS });
      const parts = (Array.isArray(result.content) ? result.content : []) as { type: string; text?: string; mimeType?: string }[];
      const text = parts
        .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ''}]`))
        .join('\n');
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      return { text: text || (structured ? JSON.stringify(structured) : ''), isError: Boolean(result.isError) };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

/** Nome exposto ao modelo: "<servidor>__<tool>", só [A-Za-z0-9_-], até 64 caracteres. */
export function mcpExposedName(serverName: string, toolName: string): string {
  const slug = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
  const server = slug(serverName).slice(0, 20) || 'mcp';
  return `${server}__${slug(toolName)}`.slice(0, 64);
}
