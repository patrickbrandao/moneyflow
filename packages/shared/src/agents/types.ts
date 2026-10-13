import type { AiBlock, AiRole } from './blocks';
import type { ToolPreview } from './preview';
import type { AgentToolKind } from './tools';

/* DTOs da API dos agentes (spec 011). Segredos nunca aparecem: só dicas/nomes. */

export type AiProviderKind = 'anthropic' | 'openai';
export type McpVisibility = 'global' | 'public' | 'private';
export type AiRunStatus = 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'canceled';
export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type AiProviderDto = {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string | null;
  /** "…abcd" (últimos 4); null = sem chave. A chave em si nunca sai da API. */
  apiKeyHint: string | null;
  embeddingModel: string | null;
  isActive: boolean;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type AiProviderTestResult = { ok: boolean; message: string; models: string[] };

export type AiPriceDto = {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  currency: 'USD' | 'BRL';
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheWritePricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
  validFrom: string;
};

export type AgentParams = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_tool_iterations?: number;
  thinking_budget_tokens?: number;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
};

export type AgentMcpLinkDto = { mcpServerId: string; name: string; visibility: McpVisibility; enabledTools: string[] | null };

export type AiAgentDto = {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  params: AgentParams;
  enabledTools: string[] | null;
  requireWriteConfirmation: boolean;
  colorSlot: number;
  icon: string | null;
  isActive: boolean;
  /** Atende os fluxos automáticos (só um por vez; precisa estar ativo). */
  useForFlows: boolean;
  archivedAt: string | null;
  createdAt: string;
  mcpServers: AgentMcpLinkDto[];
};

/** Agente como o usuário comum vê (para escolher numa conversa nova). */
export type AgentOptionDto = {
  id: string;
  name: string;
  description: string | null;
  colorSlot: number;
  icon: string | null;
  isActive: boolean;
};

export type AgentToolInfo = {
  name: string;
  title: string;
  description: string;
  kind: AgentToolKind;
  confirm: 'agent' | 'always' | 'never';
};

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
};

export type McpServerDto = {
  id: string;
  name: string;
  url: string;
  /** Só os nomes dos cabeçalhos secretos. */
  headerNames: string[];
  visibility: McpVisibility;
  isActive: boolean;
  tools: McpToolInfo[] | null;
  toolsCachedAt: string | null;
  toolsError: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type UsageTotals = {
  currency: 'USD' | 'BRL' | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Milionésimos da moeda (null = sem preço cadastrado). */
  costMicros: number | null;
  hasUnpriced: boolean;
};

/** Finalidade de uma chamada medida em ai_usage (as quatro últimas são os fluxos automáticos). */
export type AiUsagePurpose =
  | 'chat'
  | 'title'
  | 'embedding'
  | 'document_reading'
  | 'classify_lines'
  | 'contract_reading'
  | 'contract_markdown';

export type AiUsageReport = {
  byUser: (UsageTotals & { month: string; userId: string | null; username: string | null; runs: number })[];
  byAgent: (UsageTotals & {
    month: string;
    agentId: string | null;
    agentName: string | null;
    model: string;
    runs: number;
    users: number;
  })[];
  byPurpose: (UsageTotals & { month: string; purpose: AiUsagePurpose; runs: number; users: number })[];
};

export type ScreenContext = {
  route?: string;
  title?: string;
  caixaId?: string;
  caixaName?: string;
  record?: { kind: string; id: string; label?: string };
  filters?: Record<string, string | number | boolean | null>;
};

export type ConversationDto = {
  id: string;
  userId: string;
  username: string;
  agentId: string;
  agentName: string;
  agentColorSlot: number;
  title: string | null;
  titleSource: 'auto' | 'user';
  pinnedAt: string | null;
  archivedAt: string | null;
  forkedFromConversationId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  activeRunId: string | null;
  activeRunStatus: AiRunStatus | null;
  /** Resultado de busca: trecho com o termo entre « ». */
  snippet?: string | null;
};

export type AiMessageDto = {
  id: string;
  seq: number;
  role: AiRole;
  content: AiBlock[];
  runId: string | null;
  createdAt: string;
  usage: UsageTotals[];
};

export type AiRunDto = {
  id: string;
  conversationId: string;
  status: AiRunStatus;
  error: string | null;
  model: string;
  lastEventSeq: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  costCurrency: 'USD' | 'BRL' | null;
  cancelRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
};

export type ToolConfirmationDto = {
  id: string;
  runId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  preview: ToolPreview | null;
  status: ConfirmationStatus;
  reason: string | null;
  decidedAt: string | null;
};

export type ConversationDetail = {
  conversation: ConversationDto;
  messages: AiMessageDto[];
  activeRun: AiRunDto | null;
  confirmations: ToolConfirmationDto[];
  usage: UsageTotals[];
  /** true = quem vê não é o dono (admin lendo): sem enviar, decidir ou cancelar. */
  readOnly: boolean;
};

export type SendMessageResult = { message: AiMessageDto; run: AiRunDto };
export type DecideResult = { decided: number; pending: number; runStatus: AiRunStatus };

/** Eventos do SSE de uma execução (event_type + payload). */
export type AiRunEvent =
  | { type: 'status'; status: AiRunStatus; error?: string | null }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; toolUseId: string; name: string; title: string }
  | { type: 'tool_result'; toolUseId: string; name: string; isError: boolean; summary: string }
  | { type: 'message'; message: AiMessageDto }
  | { type: 'confirmation'; confirmations: ToolConfirmationDto[] }
  | { type: 'usage'; run: AiRunDto }
  | { type: 'title'; title: string }
  | { type: 'error'; message: string }
  | { type: 'done'; status: AiRunStatus; error?: string | null };

export type ApiTokenDto = {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
};

/** Criação: o token completo vem só nesta resposta. */
export type ApiTokenCreated = ApiTokenDto & { token: string };

/** Leitura de documento por IA (title-entry/document). */
export type DocumentReadingDto = {
  kind: 'boleto' | 'invoice' | 'receipt' | 'unknown';
  entityName?: string | null;
  document?: string | null;
  amountCents?: number | null;
  dueDate?: string | null;
  boletoLine?: string | null;
  pixPayload?: string | null;
  description?: string | null;
  entityId?: string | null;
  conversationId?: string | null;
};

export type ClassificationSuggestResult = { queued: boolean; runId: string | null; lines: number };
