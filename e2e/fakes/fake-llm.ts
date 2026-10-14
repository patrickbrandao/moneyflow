import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Provedor de LLM FALSO para testes (integração da API e e2e): fala o
 * suficiente da Anthropic Messages API (/v1/messages com streaming SSE,
 * /v1/models) e da OpenAI (/v1/chat/completions com streaming, /v1/models,
 * /v1/embeddings com `dimensions`, /v1/audio/transcriptions em multipart e
 * /v1/audio/speech) para os SDKs oficiais, apontados por base_url. Nenhuma API
 * real é chamada. Um modelo de embeddings com "768" no nome devolve 768
 * dimensões (o teste da flag recusa); a transcrição devolve "transcrição de
 * teste (<n> bytes)" e duration; a fala, bytes de um "mp3" falso.
 *
 * O "cérebro" padrão é determinístico, guiado pelo texto do usuário:
 *  - "listar caixas"            → chama a tool list_caixas
 *  - "criar entidade <Nome>"    → chama a tool create_entity (escrita: pede confirmação)
 *  - "buscar <texto>"           → chama a tool search_records
 *  - "chamar <tool> <json>"     → chama a tool indicada com a entrada JSON
 *  - "devagar"                  → resposta longa e lenta (para testar o "parar")
 *  - resultado de tool          → "Pronto: <resumo do resultado>"
 *  - prompt de leitura de documento / de contrato / classificação / título → JSON ou título de teste
 *  - descrição de anexo (visão por descrição, spec 024) → "Descrição de teste: …"
 *  - conversão de contrato em markdown → um markdown curto
 *  - qualquer outra coisa       → "Olá! Sou o agente de teste."
 * Os testes podem trocar o cérebro (`brain`) ou enfileirar respostas (`queue`),
 * inclusive falhas: `{ status: 429, headers: { 'retry-after': '1' } }` (erro
 * HTTP com cabeçalhos) e `{ dropAfter: 2 }` (o stream cai depois de 2 pedaços,
 * com a resposta 200 já enviada) — para as tentativas da spec 023.
 */

export type FakeToolCall = { name: string; input: Record<string, unknown> };
export type FakeReply = {
  text?: string;
  toolCalls?: FakeToolCall[];
  /** Atraso entre os pedaços do texto (ms). */
  delayMs?: number;
  chunks?: number;
  usage?: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
  /** Responde com erro HTTP (ex.: 500, 429). */
  status?: number;
  /** Cabeçalhos extras da resposta de erro (ex.: retry-after, x-ratelimit-*). */
  headers?: Record<string, string>;
  /** Derruba a conexão depois de N pedaços do texto (queda no meio do stream). */
  dropAfter?: number;
};

export type NeutralView = {
  system: string;
  lastRole: 'user' | 'tool' | 'assistant';
  lastText: string;
  lastToolResults: { id: string; content: string; isError: boolean }[];
  toolNames: string[];
  hasDocument: boolean;
};

export type FakeCall = { api: 'anthropic' | 'openai'; path: string; headers: Record<string, string | string[] | undefined>; body: any };

export type FakeLlm = {
  url: string;
  port: number;
  calls: FakeCall[];
  queue: FakeReply[];
  brain: (view: NeutralView) => FakeReply;
  close: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultBrain(view: NeutralView): FakeReply {
  if (/Gere um título curto/.test(view.system)) return { text: 'Conversa de teste' };
  if (/Descreva o anexo para outro modelo/.test(view.system)) {
    return { text: view.hasDocument ? 'Descrição de teste: boleto de R$ 123,45 com vencimento em 10/05/2030.' : 'Sem anexo.' };
  }
  if (/ler o contrato anexado/.test(view.system)) {
    return {
      text: JSON.stringify({
        counterpartyName: 'Contraparte do PDF',
        counterpartyDocument: null,
        direction: 'receivable',
        name: view.hasDocument ? 'Suporte mensal (lido do PDF)' : 'Sem documento',
        contractNumber: 'CT-PDF-01',
        startsOn: '2030-03-01',
        durationMonths: 12,
        totalCents: 6000001,
        installmentCents: null,
        periodicity: 'monthly',
        dueDay: 10,
        autoRenew: true,
        noticeDays: 30,
        readjustmentIndex: 'ipca',
        readjustmentBaseDate: null,
        terminationPenalty: '20% do saldo restante',
      }),
    };
  }
  if (/converter o contrato anexado/.test(view.system)) {
    return { text: '```markdown\n# Contrato de prestação de serviços\n\n## Cláusula 1\nObjeto: suporte mensal.\n```' };
  }
  if (/ler o documento anexado/.test(view.system)) {
    return {
      text: JSON.stringify({
        kind: 'boleto',
        entityName: 'Fornecedor do Documento',
        document: null,
        amountCents: 12345,
        dueDate: '2030-05-10',
        boletoLine: null,
        pixPayload: null,
        description: view.hasDocument ? 'Conta lida do documento' : 'Sem documento',
      }),
    };
  }
  if (/sugerir entidade e categoria/.test(view.system)) {
    const json = /\{[\s\S]*\}$/.exec(view.lastText)?.[0];
    try {
      const payload = JSON.parse(json ?? '{}') as {
        lines?: { lineId: string; categoryKind: string; entityCandidates: { id: string }[] }[];
        categories?: { id: string; kind: string }[];
      };
      const suggestions = (payload.lines ?? []).map((line) => ({
        lineId: line.lineId,
        entityId: line.entityCandidates[0]?.id ?? null,
        categoryId: payload.categories?.find((c) => c.kind === line.categoryKind)?.id ?? null,
      }));
      return { text: `\`\`\`json\n${JSON.stringify({ suggestions })}\n\`\`\`` };
    } catch {
      return { text: '{"suggestions": []}' };
    }
  }
  if (view.lastRole === 'tool') {
    const result = view.lastToolResults[0];
    if (result?.isError) return { text: `Não deu certo: ${result.content.slice(0, 200)}` };
    return { text: `Pronto: ${(result?.content ?? '').slice(0, 300)}` };
  }
  const text = view.lastText.trim();
  if (/listar caixas/i.test(text)) return { text: 'Vou listar as caixas.', toolCalls: [{ name: 'list_caixas', input: {} }] };
  const entity = /criar entidade\s+(.+)$/i.exec(text);
  if (entity) {
    return {
      text: `Vou cadastrar ${entity[1]!.trim()}.`,
      toolCalls: [{ name: 'create_entity', input: { kind: 'company', name: entity[1]!.trim() } }],
    };
  }
  const query = /buscar\s+(.+)$/i.exec(text);
  if (query) return { toolCalls: [{ name: 'search_records', input: { query: query[1]!.trim() } }] };
  const call = /chamar\s+([A-Za-z0-9_-]+)\s*(\{[\s\S]*\})?\s*$/i.exec(text);
  if (call) return { toolCalls: [{ name: call[1]!, input: call[2] ? JSON.parse(call[2]) : {} }] };
  if (/devagar/i.test(text)) return { text: 'Pensando com calma… '.repeat(60), chunks: 60, delayMs: 150 };
  return { text: 'Olá! Sou o agente de teste.' };
}

/* ---------------- leitura das requisições ---------------- */

function viewAnthropic(body: any): NeutralView {
  const system = Array.isArray(body.system) ? body.system.map((b: any) => b.text).join('\n') : String(body.system ?? '');
  const last = body.messages?.[body.messages.length - 1];
  const blocks = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: String(last?.content ?? '') }];
  const results = blocks.filter((b: any) => b.type === 'tool_result');
  return {
    system,
    lastRole: results.length > 0 ? 'tool' : (last?.role ?? 'user'),
    lastText: blocks
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n'),
    lastToolResults: results.map((b: any) => ({
      id: b.tool_use_id,
      content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
      isError: Boolean(b.is_error),
    })),
    toolNames: (body.tools ?? []).map((t: any) => t.name),
    hasDocument: (body.messages ?? []).some(
      (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'document' || b.type === 'image'),
    ),
  };
}

function viewOpenAi(body: any): NeutralView {
  const messages = body.messages ?? [];
  const system = messages
    .filter((m: any) => m.role === 'system')
    .map((m: any) => m.content)
    .join('\n');
  const last = messages[messages.length - 1];
  const tools: any[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i -= 1) tools.unshift(messages[i]);
  const text = (m: any) =>
    typeof m?.content === 'string'
      ? m.content
      : (m?.content ?? [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n');
  return {
    system,
    lastRole: last?.role === 'tool' ? 'tool' : last?.role === 'assistant' ? 'assistant' : 'user',
    lastText: text(last),
    lastToolResults: tools.map((m) => ({ id: m.tool_call_id, content: String(m.content), isError: String(m.content).startsWith('ERRO:') })),
    toolNames: (body.tools ?? []).map((t: any) => t.function?.name),
    hasDocument: messages.some(
      (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'file' || p.type === 'image_url'),
    ),
  };
}

/* ---------------- respostas ---------------- */

function split(text: string, parts: number) {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

async function streamAnthropic(res: ServerResponse, body: any, reply: FakeReply) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': nextId('req') });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const usage = reply.usage ?? { input: 120, output: 30, cacheWrite: 0, cacheRead: 0 };
  send('message_start', {
    type: 'message_start',
    message: {
      id: nextId('msg'),
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        output_tokens: 1,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
      },
    },
  });
  let index = 0;
  if (reply.text) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    let sent = 0;
    for (const chunk of split(reply.text, reply.chunks ?? 3)) {
      if (res.destroyed) return;
      if (reply.dropAfter !== undefined && sent >= reply.dropAfter) {
        res.destroy();
        return;
      }
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
      sent += 1;
      if (reply.delayMs) await sleep(reply.delayMs);
    }
    send('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  for (const call of reply.toolCalls ?? []) {
    send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: nextId('toolu'), name: call.name, input: {} },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    });
    send('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: reply.toolCalls?.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

async function streamOpenAi(res: ServerResponse, body: any, reply: FakeReply) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = nextId('chatcmpl');
  const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    );
  chunk({ role: 'assistant', content: '' });
  let sent = 0;
  for (const piece of split(reply.text ?? '', reply.chunks ?? 3)) {
    if (res.destroyed) return;
    if (reply.dropAfter !== undefined && sent >= reply.dropAfter) {
      res.destroy();
      return;
    }
    chunk({ content: piece });
    sent += 1;
    if (reply.delayMs) await sleep(reply.delayMs);
  }
  (reply.toolCalls ?? []).forEach((call, index) => {
    chunk({
      tool_calls: [{ index, id: nextId('call'), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }],
    });
  });
  chunk({}, reply.toolCalls?.length ? 'tool_calls' : 'stop');
  const usage = reply.usage ?? { input: 120, output: 30, cacheRead: 0 };
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [],
      usage: {
        prompt_tokens: usage.input + (usage.cacheRead ?? 0),
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cacheRead ?? 0 },
      },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Vetor determinístico de 1536 dimensões (mesmo texto → mesmo vetor). */
export function fakeEmbedding(text: string): number[] {
  const out: number[] = [];
  let seed = createHash('sha256').update(text.toLowerCase()).digest();
  while (out.length < 1536) {
    for (const byte of seed) out.push((byte - 128) / 128);
    seed = createHash('sha256').update(seed).digest();
  }
  return out.slice(0, 1536);
}

/** Campos de um multipart/form-data (arquivos viram { fileName, contentType, bytes }). */
function parseMultipart(raw: Buffer, contentType: string): Record<string, unknown> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return {};
  const marker = `--${boundary[1] ?? boundary[2]}`;
  const out: Record<string, unknown> = {};
  for (const part of raw.toString('latin1').split(marker)) {
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const head = part.slice(0, split);
    const body = part.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    const fileName = /filename="([^"]*)"/.exec(head)?.[1];
    if (fileName !== undefined) {
      out[name] = {
        fileName,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null,
        bytes: Buffer.byteLength(body, 'latin1'),
      };
    } else out[name] = Buffer.from(body, 'latin1').toString('utf8');
  }
  return out;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const type = String(req.headers['content-type'] ?? '');
  if (/multipart\/form-data/i.test(type)) return parseMultipart(raw, type);
  const text = raw.toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function startFakeLlm(port = 0, host = '0.0.0.0'): Promise<FakeLlm> {
  const fake: FakeLlm = {
    url: '',
    port: 0,
    calls: [],
    queue: [],
    brain: defaultBrain,
    close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    try {
      let path = (req.url ?? '').split('?')[0]!;
      // Prefixo /nolist: um compatível sem listagem de modelos (GET /v1/models dá 404; o resto funciona).
      const noList = path.startsWith('/nolist/');
      if (noList) path = path.slice('/nolist'.length);
      const body = req.method === 'POST' ? await readBody(req) : {};
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && path === '/v1/models') {
        const anthropic = 'anthropic-version' in req.headers;
        fake.calls.push({ api: anthropic ? 'anthropic' : 'openai', path, headers: req.headers, body });
        if (noList) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
        return anthropic
          ? json(200, {
              data: ['claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => ({
                id,
                type: 'model',
                display_name: id,
                created_at: '2026-01-01T00:00:00Z',
              })),
              has_more: false,
              first_id: 'claude-sonnet-5-5',
              last_id: 'claude-opus-5-5',
            })
          : json(200, {
              object: 'list',
              data: ['fake-gpt', 'fake-embedding'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })),
            });
      }
      if (req.method === 'POST' && path === '/v1/embeddings') {
        fake.calls.push({ api: 'openai', path, headers: req.headers, body });
        const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
        // Modelo com "768" no nome: devolve 768 dimensões (o MoneyFlow exige 1536).
        const size = /768/.test(String(body.model)) ? 768 : 1536;
        return json(200, {
          object: 'list',
          model: body.model,
          data: inputs.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: fakeEmbedding(`${body.model}|${String(text)}`).slice(0, size),
          })),
          usage: { prompt_tokens: inputs.join(' ').length, total_tokens: inputs.join(' ').length },
        });
      }
      if (req.method === 'POST' && path === '/v1/audio/transcriptions') {
        fake.calls.push({ api: 'openai', path, headers: req.headers, body });
        const file = body.file as { bytes?: number } | undefined;
        return json(200, {
          text: `transcrição de teste (${file?.bytes ?? 0} bytes)`,
          usage: { type: 'duration', seconds: 1.5 },
        });
      }
      if (req.method === 'POST' && path === '/v1/audio/speech') {
        fake.calls.push({ api: 'openai', path, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00]));
        return;
      }
      const anthropic = req.method === 'POST' && path === '/v1/messages';
      const openai = req.method === 'POST' && path === '/v1/chat/completions';
      if (!anthropic && !openai) return json(404, { error: { type: 'not_found_error', message: `rota falsa desconhecida: ${path}` } });
      fake.calls.push({ api: anthropic ? 'anthropic' : 'openai', path, headers: req.headers, body });
      const view = anthropic ? viewAnthropic(body) : viewOpenAi(body);
      const reply = fake.queue.shift() ?? fake.brain(view);
      if (reply.status && reply.status >= 400) {
        return json(
          reply.status,
          anthropic ? { type: 'error', error: { type: 'api_error', message: 'falha simulada' } } : { error: { message: 'falha simulada' } },
          reply.headers,
        );
      }
      if (anthropic) await streamAnthropic(res, body, reply);
      else await streamOpenAi(res, body, reply);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actual = (server.address() as AddressInfo).port;
  fake.port = actual;
  fake.url = `http://127.0.0.1:${actual}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

/* Execução avulsa: `node --experimental-strip-types e2e/fakes/fake-llm.ts 18082`. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] ?? 18082);
  void startFakeLlm(port).then((fake) =>
    console.log(`provedor falso em ${fake.url} (Anthropic: base_url ${fake.url}; OpenAI: ${fake.url}/v1)`),
  );
}
