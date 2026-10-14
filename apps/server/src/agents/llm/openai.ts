import type { AssistantBlock, NeutralMessage } from '@moneyflow/shared';
import OpenAI from 'openai';
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

export function openaiClient(credentials: LlmCredentials): LlmClient {
  const client = new OpenAI({
    apiKey: credentials.apiKey ?? 'sem-chave',
    baseURL: credentials.baseUrl ?? undefined,
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });

  const wrap = (error: unknown): never => {
    if (error instanceof OpenAI.APIError) {
      const status = typeof error.status === 'number' ? error.status : null;
      throw new LlmError(String(error.message).slice(0, 500), status, status === null || status === 429 || status >= 500);
    }
    throw error;
  };

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
        return wrap(error);
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
      return { content, stopReason: calls.size > 0 ? 'tool_use' : stopReason(finish), model, usage };
    },
    async listModels() {
      try {
        const ids: string[] = [];
        for await (const model of client.models.list()) ids.push(model.id);
        return ids.sort();
      } catch (error) {
        return wrap(error);
      }
    },
  };
}

/** Embeddings (1536 dimensões, o tamanho fixo de ai_embeddings). */
export async function embedTexts(
  credentials: LlmCredentials,
  model: string,
  texts: string[],
): Promise<{ vectors: number[][]; tokens: number }> {
  const client = new OpenAI({ apiKey: credentials.apiKey ?? 'sem-chave', baseURL: credentials.baseUrl ?? undefined, maxRetries: 2 });
  try {
    const response = await client.embeddings.create({
      model,
      input: texts,
      ...(/text-embedding-3/.test(model) ? { dimensions: 1536 } : {}),
    });
    return {
      vectors: response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]),
      tokens: response.usage?.prompt_tokens ?? 0,
    };
  } catch (error) {
    if (error instanceof OpenAI.APIError) throw new LlmError(String(error.message).slice(0, 500), error.status ?? null, true);
    throw error;
  }
}
