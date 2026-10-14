import {
  type AiRequestOperation,
  type AiUsagePurpose,
  type AssistantBlock,
  EMBEDDING_DIMENSIONS,
  type NeutralMessage,
  t,
} from '@moneyflow/shared';
import OpenAI, { toFile } from 'openai';
import { failureOutcome, type RequestLogBase, RequestRecorder } from './request-log';
import { type LlmClient, type LlmCredentials, LlmError, type LlmRequest, type LlmStopReason } from './types';

/*
 * Adaptador OpenAI-compatível (Chat Completions com tools e streaming,
 * pacote openai): cobre a OpenAI API e servidores compatíveis via base_url
 * (Azure, OpenRouter, Ollama, vLLM…). Uso normalizado para ai_usage:
 * entrada sem cache = prompt_tokens − cached_tokens.
 */

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

function stopReason(reason: string | null | undefined): LlmStopReason {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'other';
}

async function toMessages(request: LlmRequest): Promise<ChatMessage[]> {
  // Mesma ordem das partes da Anthropic (spec 022), sem marcas de cache.
  const system = [request.system, request.systemUser, request.systemVolatile].filter(Boolean).join('\n\n');
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of request.messages as NeutralMessage[]) {
    if (message.role === 'user') {
      const parts: ContentPart[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text.trim()) parts.push({ type: 'text', text: block.text });
          continue;
        }
        const file = await request.loadAttachment(block.attachment_id);
        if (!file) parts.push({ type: 'text', text: `[anexo ${block.attachment_id} indisponível]` });
        else if ('text' in file) parts.push({ type: 'text', text: file.text });
        else if (IMAGE_TYPES.has(file.mime))
          parts.push({ type: 'image_url', image_url: { url: `data:${file.mime};base64,${file.data.toString('base64')}` } });
        else if (file.mime === 'application/pdf')
          parts.push({
            type: 'file',
            file: { filename: file.fileName, file_data: `data:application/pdf;base64,${file.data.toString('base64')}` },
          });
        else if (file.mime.startsWith('text/') || /json|xml|csv/.test(file.mime))
          parts.push({ type: 'text', text: `Arquivo ${file.fileName}:\n${file.data.toString('utf8')}` });
        else parts.push({ type: 'text', text: `[anexo ${file.fileName} (${file.mime}) em formato não suportado]` });
      }
      out.push({ role: 'user', content: parts.length ? parts : '…' });
    } else if (message.role === 'assistant') {
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      const calls = message.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const use = b as Extract<AssistantBlock, { type: 'tool_use' }>;
          return { id: use.id, type: 'function' as const, function: { name: use.name, arguments: JSON.stringify(use.input) } };
        });
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const block of message.content) {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error ? `ERRO: ${block.content}` : block.content });
      }
    }
  }
  return out;
}

/** Cliente do SDK com o fetch do invólucro (spec 023): as tentativas são dele, não do SDK. */
function openClient(credentials: LlmCredentials, recorder: RequestRecorder, timeout = 10 * 60 * 1000) {
  return new OpenAI({
    apiKey: credentials.apiKey ?? 'sem-chave',
    baseURL: credentials.baseUrl ?? undefined,
    maxRetries: 0,
    timeout,
    fetch: recorder.fetch,
  });
}

/** Erro do SDK → LlmError (ou o abort, como veio); queda no meio do stream volta a execução à fila. */
function wrapError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIUserAbortError)) {
    const status = typeof error.status === 'number' ? error.status : null;
    throw new LlmError(
      String(error.message).slice(0, 500),
      status,
      status === null || status === 408 || status === 409 || status === 429 || status >= 500,
    );
  }
  if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error;
  throw new LlmError(String(error instanceof Error ? error.message : error).slice(0, 500), null, true);
}

export function openaiClient(credentials: LlmCredentials, log: RequestLogBase = {}): LlmClient {
  const recorderFor = (operation: AiRequestOperation, purpose: AiUsagePurpose | null, model: string | null) =>
    new RequestRecorder({ ...log, baseUrl: credentials.baseUrl }, { operation, purpose, model });

  return {
    kind: 'openai',
    async chat(request) {
      const params = request.params;
      const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: request.model,
        messages: await toMessages(request),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function' as const,
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
      };
      if (params.max_tokens !== undefined) body.max_completion_tokens = params.max_tokens;
      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.top_p !== undefined) body.top_p = params.top_p;
      if (params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;

      let text = '';
      let finish: string | null = null;
      let model = request.model;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
      const recorder = recorderFor(request.operation ?? 'chat', request.purpose ?? 'chat', request.model);
      const client = openClient(credentials, recorder);
      try {
        const stream = await client.chat.completions.create(body, { signal: request.signal });
        for await (const chunk of stream) {
          if (chunk.model) model = chunk.model;
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            usage.inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached);
            usage.cacheReadTokens = cached;
            usage.outputTokens = chunk.usage.completion_tokens ?? 0;
          }
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            if (delta?.content) {
              text += delta.content;
              request.onText?.(delta.content);
            }
            const reasoning = (delta as { reasoning_content?: string; reasoning?: string } | undefined)?.reasoning_content;
            if (reasoning) request.onThinking?.(reasoning);
            for (const call of delta?.tool_calls ?? []) {
              const current = calls.get(call.index) ?? { id: '', name: '', args: '' };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.name += call.function.name;
              if (call.function?.arguments) current.args += call.function.arguments;
              calls.set(call.index, current);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }
      } catch (error) {
        await recorder.finish(failureOutcome(error, request.signal));
        return wrapError(error, request.signal);
      }

      const content: AssistantBlock[] = [];
      if (text) content.push({ type: 'text', text });
      let index = 0;
      for (const call of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
        let input: Record<string, unknown> = {};
        try {
          const parsed = call.args ? JSON.parse(call.args) : {};
          input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
        } catch {
          input = { __invalid_json: call.args.slice(0, 2000) };
        }
        index += 1;
        content.push({ type: 'tool_use', id: call.id || `call_${Date.now()}_${index}`, name: call.name, input });
      }
      const result = { content, stopReason: calls.size > 0 ? ('tool_use' as const) : stopReason(finish), model, usage };
      // Resposta montada (JSON final) para o registro com log_bodies.
      const requestId = await recorder.finish({ status: 'ok', usage, responseBody: { model, finish_reason: finish, content } });
      return { ...result, requestId };
    },
    async listModels(operation = 'list_models') {
      const recorder = recorderFor(operation, null, null);
      const client = openClient(credentials, recorder);
      try {
        const ids: string[] = [];
        for await (const model of client.models.list()) ids.push(model.id);
        await recorder.finish({ status: 'ok' });
        return ids.sort();
      } catch (error) {
        await recorder.finish(failureOutcome(error));
        return wrapError(error);
      }
    },
  };
}

/** Erro de uma chamada avulsa (embeddings, áudio) → LlmError. */
function wrapCallError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof LlmError) throw error;
  return wrapError(error, signal);
}

/**
 * Embeddings (spec 024): vetores de 1536 dimensões, o tamanho fixo de
 * ai_embeddings. Nos text-embedding-3-* o MoneyFlow pede `dimensions: 1536`;
 * um modelo que devolve outra dimensão é recusado com LlmError (o teste da
 * flag mostra "o modelo precisa produzir 1536 dimensões").
 */
export async function embed(
  credentials: LlmCredentials,
  model: string,
  texts: string[],
  log: RequestLogBase = {},
  operation: AiRequestOperation = 'embedding',
): Promise<{ vectors: number[][]; tokens: number; requestId: string | null }> {
  const recorder = new RequestRecorder({ ...log, baseUrl: credentials.baseUrl }, { operation, purpose: 'embedding', model });
  const client = openClient(credentials, recorder, 2 * 60 * 1000);
  let response: OpenAI.Embeddings.CreateEmbeddingResponse;
  try {
    response = await client.embeddings.create({
      model,
      input: texts,
      ...(/text-embedding-3/.test(model) ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
    });
  } catch (error) {
    await recorder.finish(failureOutcome(error));
    return wrapCallError(error);
  }
  const tokens = response.usage?.prompt_tokens ?? 0;
  const requestId = await recorder.finish({
    status: 'ok',
    usage: { inputTokens: tokens, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
  });
  const vectors = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
  const wrong = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
  if (wrong) throw new LlmError(t.agents.errors.embeddingDimensions(wrong.length), null, false);
  return { vectors, tokens, requestId };
}

export type TranscribeResult = {
  text: string;
  /** Duração do áudio (s), quando o provedor informa (cobrança por minuto). */
  audioSeconds: number | null;
  usage: { inputTokens: number; outputTokens: number };
  requestId: string | null;
};

/**
 * Áudio→texto (spec 024; usado pela 025): POST /audio/transcriptions com o
 * arquivo em multipart. Com log_bodies, o registro guarda o corpo inteiro,
 * com o áudio em base64; sem ele, só os metadados.
 */
export async function transcribe(
  credentials: LlmCredentials,
  model: string,
  audio: { fileName: string; mime: string; data: Buffer },
  log: RequestLogBase = {},
  opts: { operation?: AiRequestOperation; language?: string; signal?: AbortSignal } = {},
): Promise<TranscribeResult> {
  const recorder = new RequestRecorder(
    { ...log, baseUrl: credentials.baseUrl },
    { operation: opts.operation ?? 'transcription', purpose: 'transcription', model },
  );
  const client = openClient(credentials, recorder, 5 * 60 * 1000);
  let response: OpenAI.Audio.Transcription;
  try {
    response = await client.audio.transcriptions.create(
      {
        file: await toFile(audio.data, audio.fileName, { type: audio.mime }),
        model,
        response_format: 'json',
        ...(opts.language ? { language: opts.language } : {}),
      },
      { signal: opts.signal },
    );
  } catch (error) {
    await recorder.finish(failureOutcome(error, opts.signal));
    return wrapCallError(error, opts.signal);
  }
  const raw = response as OpenAI.Audio.Transcription & { duration?: number };
  const usage = raw.usage;
  const tokens =
    usage?.type === 'tokens'
      ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
      : { inputTokens: 0, outputTokens: 0 };
  const audioSeconds = usage?.type === 'duration' ? usage.seconds : typeof raw.duration === 'number' ? raw.duration : null;
  const requestId = await recorder.finish({ status: 'ok', usage: { ...tokens, cacheWriteTokens: 0, cacheReadTokens: 0 } });
  return { text: String(raw.text ?? ''), audioSeconds, usage: tokens, requestId };
}

/** Texto→áudio (spec 024; usado pela 025): POST /audio/speech, mp3. O uso é por caractere (characters). */
export async function speak(
  credentials: LlmCredentials,
  model: string,
  voice: string,
  text: string,
  log: RequestLogBase = {},
  opts: { operation?: AiRequestOperation; signal?: AbortSignal } = {},
): Promise<{ audio: Buffer; mime: string; characters: number; requestId: string | null }> {
  const recorder = new RequestRecorder(
    { ...log, baseUrl: credentials.baseUrl },
    { operation: opts.operation ?? 'speech', purpose: 'speech', model },
  );
  const client = openClient(credentials, recorder, 5 * 60 * 1000);
  let audio: Buffer;
  let mime: string;
  try {
    const response = await client.audio.speech.create({ model, voice, input: text, response_format: 'mp3' }, { signal: opts.signal });
    mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg';
    audio = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    await recorder.finish(failureOutcome(error, opts.signal));
    return wrapCallError(error, opts.signal);
  }
  const requestId = await recorder.finish({ status: 'ok' });
  return { audio, mime, characters: [...text].length, requestId };
}
