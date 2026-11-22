import type { AgentParams, AiRequestOperation, AiUsagePurpose, AssistantBlock, JsonSchema, NeutralMessage } from '@moneyflow/shared';

/*
 * Interface neutra dos provedores de LLM (spec 011). Os adaptadores
 * (anthropic.ts, openai.ts) convertem o histórico de blocos neutros para o
 * formato do provedor, fazem a chamada com streaming e devolvem os blocos do
 * assistente e o uso já normalizados para ai_usage.
 */

export type LlmTool = { name: string; description: string; inputSchema: JsonSchema };

/**
 * Anexo como vai ao modelo: o arquivo (imagem/PDF direto, spec 024) ou o texto
 * que o substitui (descrição do provedor de visão, camada de texto do PDF, aviso).
 */
export type LlmAttachment = { fileName: string; mime: string; data: Buffer } | { fileName: string; mime: string; text: string };

export type LlmUsage = { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number };

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type LlmRequest = {
  model: string;
  /** Parte estável do prompt de sistema: termina no ponto de cache 1 (spec 022). */
  system: string;
  /** Parte estável por usuário (instruções e contexto automático): termina no ponto de cache 2. */
  systemUser?: string;
  /** Parte volátil (data, contexto da tela): vai depois dos pontos de cache. */
  systemVolatile?: string;
  messages: NeutralMessage[];
  tools: LlmTool[];
  params: AgentParams;
  /** Lê o arquivo de um bloco attachment (null = não encontrado). */
  loadAttachment: (attachmentId: string) => Promise<LlmAttachment | null>;
  signal?: AbortSignal;
  /** Operação e finalidade gravadas em ai_requests (spec 023; padrão chat/chat). */
  operation?: AiRequestOperation;
  purpose?: AiUsagePurpose;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
};

export type LlmResponse = {
  content: AssistantBlock[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  model: string;
  /** Requisição registrada (ai_requests), para ai_usage.request_id; null sem registro. */
  requestId: string | null;
};

export type LlmCredentials = {
  kind: 'anthropic' | 'openai';
  baseUrl: string | null;
  apiKey: string | null;
  /** Messages API (spec 024): false = não manda cache_control / thinking (padrão: manda). */
  promptCache?: boolean;
  thinking?: boolean;
};

export interface LlmClient {
  readonly kind: 'anthropic' | 'openai';
  chat(request: LlmRequest): Promise<LlmResponse>;
  /** Lista os modelos; `operation` distingue o "Testar conexão" (test_connection) do listar avulso. */
  listModels(operation?: 'test_connection' | 'list_models'): Promise<string[]>;
}

export const emptyUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });

/** Erro do provedor, com mensagem segura (sem chaves), se vale tentar de novo e o tipo reconhecido. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /** context_overflow: a requisição passou do contexto ou do tamanho que o provedor aceita (tarefa 098). */
    readonly code: 'context_overflow' | null = null,
  ) {
    super(message);
  }
}

/**
 * Erro de contexto ou de tamanho da requisição (tarefa 098): 413, ou 400 com a
 * mensagem de "prompt longo demais" de cada provedor (Anthropic: "prompt is too
 * long"; OpenAI: context_length_exceeded / maximum context length; compatíveis
 * variam). Não se repete: a próxima mensagem da sessão falharia igual.
 */
export function isContextOverflow(status: number | null, message: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  return /prompt is too long|context[_ ]length|maximum context|context window|too many (input )?tokens|request too large|too large for|reduce the length/i.test(
    message,
  );
}

/** O LlmError de um erro HTTP do provedor: repete 408/409/429/5xx e rede; reconhece o estouro de contexto. */
export function providerError(message: string, status: number | null): LlmError {
  const safe = String(message).slice(0, 500);
  if (isContextOverflow(status, safe)) return new LlmError(safe, status, false, 'context_overflow');
  return new LlmError(safe, status, status === null || status === 408 || status === 409 || status === 429 || status >= 500);
}
