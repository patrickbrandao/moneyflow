import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/*
 * Servidor MCP FALSO (Streamable HTTP, sem estado) para os testes do MCP
 * client: exige o cabeçalho secreto Authorization e expõe duas tools,
 * echo (somente leitura) e create_ticket (escrita).
 */

export type FakeMcp = { url: string; calls: { tool: string; args: unknown }[]; authHeaders: string[]; close: () => Promise<void> };

export async function startFakeMcp(secret: string): Promise<FakeMcp> {
  const fake: FakeMcp = { url: '', calls: [], authHeaders: [], close: async () => {} };
  const build = () => {
    const server = new McpServer({ name: 'fake-mcp', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Repete o texto.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
      async ({ text }) => {
        fake.calls.push({ tool: 'echo', args: { text } });
        return { content: [{ type: 'text', text: `eco: ${text}` }] };
      },
    );
    server.registerTool(
      'create_ticket',
      { description: 'Abre um chamado.', inputSchema: { title: z.string() }, annotations: { readOnlyHint: false } },
      async ({ title }) => {
        fake.calls.push({ tool: 'create_ticket', args: { title } });
        return { content: [{ type: 'text', text: `chamado criado: ${title}` }] };
      },
    );
    return server;
  };
  const http: Server = createServer(async (req, res) => {
    fake.authHeaders.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return fake;
}
