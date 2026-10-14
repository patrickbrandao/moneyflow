import type { AgentParams, AiRequestOperation, AiUsagePurpose, AssistantBlock, JsonSchema, NeutralMessage } from '@moneyflow/shared';

/*
 * Interface neutra dos provedores de LLM (spec 011). Os adaptadores
 * (anthropic.ts, openai.ts) convertem o histórico de blocos neutros para o
 * formato do provedor, fazem a chamada com streaming e devolvem os blocos do
 * assistente e o uso já normalizados para ai_usage.
 */

export type LlmTool = { name: string; description: string; inputSchema: JsonSchema };

export type LlmAttachment = { fileName: string; mime: string; data: Buffer };

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

export type LlmCredentials = { kind: 'anthropic' | 'openai'; baseUrl: string | null; apiKey: string | null };

export interface LlmClient {
  readonly kind: 'anthropic' | 'openai';
  chat(request: LlmRequest): Promise<LlmResponse>;
  /** Lista os modelos; `operation` distingue o "Testar conexão" (test_connection) do listar avulso. */
  listModels(operation?: 'test_connection' | 'list_models'): Promise<string[]>;
}

export const emptyUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });

/** Erro do provedor, com mensagem segura (sem chaves) e se vale tentar de novo. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
