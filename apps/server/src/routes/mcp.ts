import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { userColumns, users } from '@moneyflow/db';
import { AGENT_TOOLS, agentTool, t, toolJsonSchema } from '@moneyflow/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TOOL_HANDLERS } from '../agents/tool-handlers';
import { resultText, toolErrorMessage } from '../agents/tools-runtime';
import { type Actor, loadAccess } from '../authz/access';
import type { ServiceContext } from '../context';
import { authenticateApiToken } from '../services/api-tokens';

/*
 * Servidor MCP próprio (spec 011) em /mcp: Streamable HTTP sem estado (uma
 * instância de servidor por requisição), autenticado por token pessoal
 * (Authorization: Bearer mf_…), expondo as MESMAS tools dos agentes com as
 * permissões do dono do token e o ator `agent` (sem execução local, então sem
 * agent_run_id). As escritas executam direto: a confirmação fica a cargo do
 * cliente MCP, guiado pelas anotações readOnlyHint/destructiveHint.
 */

function mcpServerFor(ctx: ServiceContext) {
  const server = new Server({ name: 'moneyflow', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: AGENT_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toolJsonSchema(tool) as { type: 'object'; properties?: Record<string, unknown> },
      annotations: {
        title: tool.title,
        readOnlyHint: tool.kind === 'read',
        destructiveHint: tool.kind === 'write' ? tool.destructive === true || tool.name.startsWith('update_') : false,
        idempotentHint: tool.kind === 'read',
        openWorldHint: tool.name === 'send_telegram_message' || tool.name === 'notify_user',
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = agentTool(request.params.name);
    if (!tool) return { content: [{ type: 'text', text: t.agents.errors.toolUnknown(request.params.name) }], isError: true };
    try {
      const input = tool.input.parse(request.params.arguments ?? {});
      const handler = TOOL_HANDLERS[tool.name as keyof typeof TOOL_HANDLERS] as {
        run: (ctx: ServiceContext, input: unknown, meta: { toolUseId: string; runId: string | null }) => Promise<unknown>;
      };
      const value = await handler.run(ctx, input, { toolUseId: randomUUID(), runId: null });
      return { content: [{ type: 'text', text: resultText(value) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: toolErrorMessage(error) }], isError: true };
    }
  });
  return server;
}

const unauthorized = (reply: FastifyReply) =>
  reply
    .status(401)
    .header('www-authenticate', 'Bearer realm="moneyflow"')
    .send({ jsonrpc: '2.0', error: { code: -32001, message: t.agents.errors.tokenInvalid }, id: null });

export async function mcpRoutes(app: FastifyInstance) {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const auth = token ? await authenticateApiToken(app.db, token, request.ip ?? null) : null;
    if (!auth) return unauthorized(reply);
    const [user] = await app.db.select(userColumns).from(users).where(eq(users.id, auth.user_id));
    if (!user?.isActive) return unauthorized(reply);
    if (request.method !== 'POST') {
      return reply
        .status(405)
        .header('allow', 'POST')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    }
    const actor: Actor = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role as Actor['role'],
      isActive: user.isActive,
    };
    const ctx: ServiceContext = {
      db: app.db,
      config: app.config,
      access: await loadAccess(app.db, actor),
      actorKind: 'agent',
      agentRunId: null,
    };

    const server = mcpServerFor(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };
  app.post('/mcp', handle);
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
}
