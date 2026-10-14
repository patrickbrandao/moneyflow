import Anthropic from '@anthropic-ai/sdk';
import type { AiRequestOperation, AiUsagePurpose, AssistantBlock, NeutralMessage } from '@moneyflow/shared';
import { attachmentLabel } from './attachment-label';
import { failureOutcome, type RequestLogBase, RequestRecorder } from './request-log';
import { type LlmClient, type LlmCredentials, LlmError, type LlmRequest, type LlmStopReason } from './types';

/*
 * Adaptador da Claude API (Messages API, @anthropic-ai/sdk) com streaming,
 * tool use, prompt caching (spec 022: pontos de cache na última tool, no fim da
 * parte estável do sistema e no fim da parte por usuário — 3 dos 4 que a API
 * aceita; a parte volátil vai depois) e entrada de imagem/PDF.
 *
 * Num servidor compatível (base_url), os interruptores do provedor (spec 024)
 * desligam o cache de prompt (nenhum cache_control) e o raciocínio (nem
 * thinking nem output_config.effort), mesmo que o agente peça.
 *
 * Raciocínio: nos modelos atuais (família 5.x) o pensamento é adaptativo e
 * não aceita budget_tokens nem temperature/top_p; thinking_budget_tokens > 0
 * liga o modo adaptativo com resumo visível, e os modelos 4.5 ou anteriores
 * ainda recebem o orçamento fixo. Os blocos de raciocínio voltam intactos só
 * para o mesmo provedor e modelo (com a assinatura).
 */

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_MAX_TOKENS = 16000;

/** Modelos que ainda usam thinking.budget_tokens e aceitam temperature/top_p. */
function isLegacyModel(model: string) {
  return (
    /claude-(3|(opus|sonnet|haiku)-4-[0-5]\b|(opus|sonnet|haiku)-4$|(opus|sonnet|haiku)-4-\d{8})/.test(model) || !/^claude-/.test(model)
  );
}

function stopReason(reason: string | null | undefined): LlmStopReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'other';
}

async function toParams(request: LlmRequest): Promise<Anthropic.MessageParam[]> {
  const out: Anthropic.MessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      // Resultados de tool vêm antes de qualquer texto no mesmo turno do usuário.
      last.content = [...last.content, ...blocks];
    } else out.push({ role, content: blocks });
  };
  for (const message of request.messages as NeutralMessage[]) {
    if (message.role === 'user') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text.trim()) blocks.push({ type: 'text', text: block.text });
          continue;
        }
        const file = await request.loadAttachment(block.attachment_id);
        // O id do anexo vai ao modelo (as tools de importação o recebem, spec 027).
        blocks.push({ type: 'text', text: attachmentLabel(block, file) });
        if (!file) {
          blocks.push({ type: 'text', text: `[anexo ${block.attachment_id} indisponível]` });
        } else if ('text' in file) {
          blocks.push({ type: 'text', text: file.text });
        } else if (IMAGE_TYPES.has(file.mime)) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: file.mime as 'image/png', data: file.data.toString('base64') },
          });
        } else if (file.mime === 'application/pdf') {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') },
            title: file.fileName,
          });
        } else if (file.mime.startsWith('text/') || /json|xml|csv|ofx/.test(file.mime)) {
          blocks.push({
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: file.data.toString('utf8') },
            title: file.fileName,
          });
        } else {
          blocks.push({ type: 'text', text: `[anexo ${file.fileName} (${file.mime}) em formato não suportado]` });
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '…' });
      push('user', blocks);
    } else if (message.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text) blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        } else if (block.type === 'thinking') {
          if (block.provider === 'anthropic' && block.model === request.model && block.signature) {
            blocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
          }
        } else if (block.type === 'redacted_thinking') {
          if (block.provider === 'anthropic' && block.model === request.model) blocks.push({ type: 'redacted_thinking', data: block.data });
        }
      }
      push('assistant', blocks);
    } else {
      push(
        'user',
        message.content.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        })),
      );
    }
  }
  return out;
}

export function anthropicClient(credentials: LlmCredentials, log: RequestLogBase = {}): LlmClient {
  // Um cliente por chamada: o fetch dele é o invólucro do registro (spec 023). As tentativas são do invólucro (maxRetries: 0).
  const open = (recorder: RequestRecorder) =>
    new Anthropic({
      apiKey: credentials.apiKey ?? 'sem-chave',
      baseURL: credentials.baseUrl ?? undefined,
      maxRetries: 0,
      timeout: 10 * 60 * 1000,
      fetch: recorder.fetch,
    });
  const recorderFor = (operation: AiRequestOperation, purpose: AiUsagePurpose | null, model: string | null) =>
    new RequestRecorder({ ...log, baseUrl: credentials.baseUrl }, { operation, purpose: purpose ?? null, model });

  const wrap = (error: unknown, signal?: AbortSignal): never => {
    if (error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIUserAbortError)) {
      const status = typeof error.status === 'number' ? error.status : null;
      const message = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message;
      throw new LlmError(
        String(message).slice(0, 500),
        status,
        status === null || status === 408 || status === 409 || status === 429 || status >= 500,
      );
    }
    if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error;
    // Queda no meio do stream (depois do primeiro byte, sem nova tentativa): a execução volta à fila (spec 023).
    throw new LlmError(String(error instanceof Error ? error.message : error).slice(0, 500), null, true);
  };

  return {
    kind: 'anthropic',
    async chat(request) {
      const legacy = isLegacyModel(request.model);
      const params = request.params;
      const cacheOn = credentials.promptCache !== false;
      const thinkingAllowed = credentials.thinking !== false;
      const cache = cacheOn ? { cache_control: { type: 'ephemeral' as const } } : {};
      const tools: Anthropic.Tool[] = request.tools.map((tool, index) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        ...(index === request.tools.length - 1 ? cache : {}),
      }));
      const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: request.system, ...cache }];
      if (request.systemUser) system.push({ type: 'text', text: request.systemUser, ...cache });
      if (request.systemVolatile) system.push({ type: 'text', text: request.systemVolatile });
      const thinkingOn = thinkingAllowed && (params.thinking_budget_tokens ?? 0) > 0;
      const maxTokens = params.max_tokens ?? DEFAULT_MAX_TOKENS;
      const body: Anthropic.MessageStreamParams = {
        model: request.model,
        max_tokens: legacy && thinkingOn ? Math.max(maxTokens, (params.thinking_budget_tokens ?? 0) + 1024) : maxTokens,
        system,
        messages: await toParams(request),
        ...(tools.length ? { tools } : {}),
      };
      if (thinkingOn) {
        (body as { thinking?: unknown }).thinking = legacy
          ? { type: 'enabled', budget_tokens: Math.max(1024, params.thinking_budget_tokens ?? 1024) }
          : { type: 'adaptive', display: 'summarized' };
      }
      if (legacy && !thinkingOn) {
        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.top_p !== undefined) body.top_p = params.top_p;
      }
      if (!legacy && thinkingAllowed && params.reasoning_effort) {
        const effort = params.reasoning_effort === 'minimal' ? 'low' : params.reasoning_effort;
        (body as { output_config?: unknown }).output_config = { effort };
      }

      let final: Anthropic.Message;
      const recorder = recorderFor(request.operation ?? 'chat', request.purpose ?? 'chat', request.model);
      const client = open(recorder);
      try {
        const stream = client.messages.stream(body, { signal: request.signal });
        stream.on('streamEvent', (event) => {
          if (event.type !== 'content_block_delta') return;
          if (event.delta.type === 'text_delta') request.onText?.(event.delta.text);
          else if (event.delta.type === 'thinking_delta') request.onThinking?.(event.delta.thinking);
        });
        final = await stream.finalMessage();
      } catch (error) {
        await recorder.finish(failureOutcome(error, request.signal));
        return wrap(error, request.signal);
      }

      const content: AssistantBlock[] = [];
      for (const block of final.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use')
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
        else if (block.type === 'thinking')
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature,
            provider: 'anthropic',
            model: request.model,
          });
        else if (block.type === 'redacted_thinking')
          content.push({ type: 'redacted_thinking', data: block.data, provider: 'anthropic', model: request.model });
      }
      const usage = {
        inputTokens: final.usage.input_tokens ?? 0,
        outputTokens: final.usage.output_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      };
      const requestId = await recorder.finish({ status: 'ok', usage, responseBody: final });
      return { content, stopReason: stopReason(final.stop_reason), model: final.model ?? request.model, usage, requestId };
    },
    async listModels(operation = 'list_models') {
      const recorder = recorderFor(operation, null, null);
      const client = open(recorder);
      try {
        const ids: string[] = [];
        for await (const model of client.models.list({ limit: 100 })) ids.push(model.id);
        await recorder.finish({ status: 'ok' });
        return ids;
      } catch (error) {
        await recorder.finish(failureOutcome(error));
        return wrap(error);
      }
    },
  };
}
