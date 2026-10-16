import type { AiBlock, AiRole } from './blocks';
import type { ToolPreview } from './preview';
import type { AgentToolCategory, AgentToolKind, AgentToolMode } from './tools';

/* DTOs da API dos agentes (spec 011). Segredos nunca aparecem: só dicas/nomes. */

export type AiProviderKind = 'anthropic' | 'openai';
/** Capacidades de um provedor (spec 024). */
export type AiCapability = 'text' | 'vision' | 'embeddings' | 'transcription' | 'speech';
/** Inferências do agente além do texto (o texto fica no próprio agente). */
export type AiInferenceCapability = Exclude<AiCapability, 'text'>;
/** Modelo padrão por capacidade ligada e a voz padrão do TTS (as chaves de ai_providers.default_models). */
export type AiDefaultModels = Partial<Record<AiCapability | 'speech_voice', string>>;
export type McpVisibility = 'global' | 'public' | 'private';
export type McpInstructionsMode = 'ignore' | 'system' | 'user';
export type AiRunStatus = 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'canceled';
export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type AiProviderDto = {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string | null;
  /** "…abcd" (últimos 4); null = sem chave. A chave em si nunca sai da API. */
  apiKeyHint: string | null;
  /** O que o provedor sabe fazer, em ordem canônica (spec 024). */
  capabilities: AiCapability[];
  defaultModels: AiDefaultModels;
  /** Messages API: manda cache_control / thinking (desligados por padrão num compatível). */
  promptCacheEnabled: boolean;
  thinkingEnabled: boolean;
  isActive: boolean;
  /** Registra corpos e cabeçalhos das requisições (spec 023). */
  logBodies: boolean;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
};

/** Resultado de uma flag no "Testar conexão" (uma chamada mínima por flag ligada). */
export type AiProviderCapabilityCheck = {
  capability: AiCapability;
  ok: boolean;
  /** Modelo usado na chamada (null = sem modelo padrão para a flag: não testada). */
  model: string | null;
  message: string;
};

export type AiProviderTestResult = {
  ok: boolean;
  message: string;
  models: string[];
  /** O provedor não tem listagem de modelos (compatíveis): digite o modelo; não é erro. */
  modelsUnavailable: boolean;
  checks: AiProviderCapabilityCheck[];
};

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
  /** Áudio: por minuto transcrito e por milhão de caracteres falados (spec 024); null = não cobra assim. */
  audioInputPerMinute: number | null;
  speechPerMillionChars: number | null;
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

/** Provedor de uma inferência do agente (spec 024); modelo/voz nulos = os padrões do provedor. */
export type AgentInferenceDto = {
  capability: AiInferenceCapability;
  providerId: string;
  providerName: string;
  model: string | null;
  voice: string | null;
  /** Modelo e voz em vigor (com os padrões do provedor); null = não configurado. */
  effectiveModel: string | null;
  effectiveVoice: string | null;
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
  /** Kit de ferramentas (spec 021); null = sem kit = todas as tools internas, sem aprovação. */
  toolKitId: string | null;
  toolKitName: string | null;
  colorSlot: number;
  icon: string | null;
  isActive: boolean;
  /** Atende os fluxos automáticos (só um por vez; precisa estar ativo). */
  useForFlows: boolean;
  /** Número da versão atual do prompt (spec 022). */
  promptVersion: number | null;
  archivedAt: string | null;
  createdAt: string;
  mcpServers: AgentMcpLinkDto[];
  /** Inferências além do texto (visão, embeddings, áudio→texto, texto→áudio); sem linha = "Nenhum". */
  inferences: AgentInferenceDto[];
};

/** Versão do prompt de um agente (spec 022): imutável; a última é o prompt atual. */
export type AgentPromptVersionDto = {
  id: string;
  version: number;
  content: string;
  note: string | null;
  createdByUserId: string | null;
  createdByUsername: string | null;
  restoredFromVersionId: string | null;
  restoredFromVersion: number | null;
  createdAt: string;
};

/** Uma parte do prompt montado, na ordem; `cacheBreakpoint` = ponto de cache da Anthropic logo depois dela. */
export type PromptPart = {
  kind: 'stable' | 'user' | 'volatile' | 'mcp_user';
  text: string;
  cacheBreakpoint: boolean;
};

/** "Ver prompt montado" (spec 022): o prompt final para um usuário, sem chamar o modelo. */
export type AgentPromptPreviewDto = {
  userId: string;
  username: string;
  parts: PromptPart[];
  /** O prompt do agente usa variáveis voláteis e foi para depois do ponto de cache 2. */
  volatileVariables: boolean;
};

/** Minha conta → IA (spec 022). */
export type UserAiSettingsDto = {
  instructions: string;
  primaryCaixaId: string | null;
  primaryCaixaName: string | null;
  updatedAt: string | null;
};

/** Agente como o usuário comum vê (para escolher numa conversa nova). */
export type AgentOptionDto = {
  id: string;
  name: string;
  description: string | null;
  colorSlot: number;
  icon: string | null;
  isActive: boolean;
  /** Tem kit de ferramentas (sem kit: lança sem pedir aprovação; aviso das receitas, spec 030). */
  hasKit?: boolean;
};

export type AgentToolInfo = {
  name: string;
  title: string;
  description: string;
  kind: AgentToolKind;
  category: AgentToolCategory;
  destructive: boolean;
  /** Modo usado quando a tool é marcada num kit. */
  suggestedMode: AgentToolMode;
  /** Só administrador: nunca oferecida a quem não é admin. */
  adminOnly: boolean;
  /** Tem campo de segredo: sempre ask, com ou sem kit. */
  secret: boolean;
};

/** Kit de ferramentas (spec 021). */
export type AiToolKitDto = {
  id: string;
  name: string;
  description: string | null;
  tools: { name: string; mode: AgentToolMode }[];
  /** Agentes ligados ao kit (inclusive os arquivados, que também impedem a exclusão). */
  agents: { id: string; name: string; archived: boolean }[];
  createdAt: string;
  updatedAt: string;
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
  /** O que fazer com as instructions do servidor (spec 022). */
  instructionsMode: McpInstructionsMode;
  /** Instructions do initialize em cache (null = o servidor não mandou ou nunca foi listado). */
  instructions: string | null;
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
  /** Áudio transcrito (s) e caracteres falados (spec 024); só onde a consulta soma (detalhe do provedor). */
  audioSeconds?: number;
  characters?: number;
};

/** Finalidade de uma chamada medida em ai_usage (as quatro últimas são os fluxos automáticos). */
export type AiUsagePurpose =
  | 'chat'
  | 'title'
  | 'embedding'
  | 'document_reading'
  | 'classify_lines'
  | 'contract_reading'
  | 'contract_markdown'
  | 'vision_describe'
  | 'transcription'
  | 'speech'
  | 'scheduled_task'
  | 'reconcile_statement';

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
  /** Finalizada (spec 026): a sessão `chat` com archived_at não volta a ser ativa. */
  archivedAt: string | null;
  archivedReason: SessionArchivedReason | null;
  forkedFromConversationId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  activeRunId: string | null;
  activeRunStatus: AiRunStatus | null;
  /** chat (sessão) ou o fluxo que criou a conversa (tarefa agendada, conciliação com IA, leitura…). */
  purpose: string;
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
  /** As pendentes da execução ativa e as já decididas da conversa (o histórico mostra a tool recusada como recusada). */
  confirmations: ToolConfirmationDto[];
  usage: UsageTotals[];
  /** true = quem vê não é o dono (admin lendo): sem enviar, decidir ou cancelar. */
  readOnly: boolean;
  /** Metadados dos anexos das mensagens (spec 025): duração, páginas e a transcrição do áudio. */
  attachments: ChatAttachmentDto[];
  /** O que o agente converte (spec 025): áudio→texto (microfone, transcrição) e texto→áudio (modo áudio). */
  media: { transcription: boolean; speech: boolean };
};

/* ---------------- chat multimídia (spec 025) ---------------- */

export type DerivativeStatus = 'pending' | 'running' | 'done' | 'failed';

/** Transcrição de um áudio (derivado transcription mais recente do anexo, de qualquer provedor). */
export type TranscriptionDto = {
  id: string;
  status: DerivativeStatus;
  text: string | null;
  error: string | null;
  model: string;
  updatedAt: string;
};

/** Anexo de uma mensagem do chat (o upload da conversa também devolve este formato). */
export type ChatAttachmentDto = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  pageCount: number | null;
  createdAt: string;
  /** Só áudio: null = sem transcrição (o agente não converte áudio). */
  transcription: TranscriptionDto | null;
};

/** GET /api/attachments/:id/derivatives: o que foi gerado a partir do anexo (o conteúdo da camada de texto do PDF fica de fora). */
export type AttachmentDerivativeDto = {
  id: string;
  kind: 'description' | 'pdf_text' | 'transcription';
  status: DerivativeStatus;
  content: string | null;
  error: string | null;
  providerId: string | null;
  model: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

/** POST /api/conversations/:id/messages/:messageId/speech: o áudio da mensagem, um anexo por trecho, na ordem. */
export type MessageSpeechDto = {
  messageId: string;
  parts: { blockIndex: number; attachmentId: string; characters: number }[];
};

export type SendMessageResult = { message: AiMessageDto; run: AiRunDto };

/* ---------------- sessões por agente (spec 026) ---------------- */

/** Por que a sessão foi finalizada: o usuário, o fork, a migração de várias ativas ou o conflito na importação. */
export type SessionArchivedReason = 'finished' | 'forked' | 'migrated_from_multi' | 'import_conflict';

/** O fio de um usuário com um agente: a sessão ativa e o resumo (menu Agentes). */
export type AgentThreadDto = {
  agentId: string;
  agentName: string;
  agentDescription: string | null;
  agentColorSlot: number;
  agentIcon: string | null;
  /** O agente e o provedor estão ativos (dá para conversar). */
  agentUsable: boolean;
  userId: string;
  username: string;
  /** A sessão ativa (null = a próxima mensagem cria uma). */
  active: ConversationDto | null;
  /** Última atividade em qualquer sessão do fio (null = nunca conversou). */
  lastActivityAt: string | null;
  finishedCount: number;
};

/** A janela do agente: o agente, o que ele converte e a sessão ativa (null = nenhuma ainda). */
export type AgentThreadView = {
  agent: AgentOptionDto;
  media: { transcription: boolean; speech: boolean };
  session: ConversationDetail | null;
};

export type AgentSessionsPage = { items: ConversationDto[]; hasMore: boolean };

/** Mensagem enviada ao agente: a sessão em que entrou (criada se não havia ativa). */
export type AgentSendResult = SendMessageResult & { conversation: ConversationDto; created: boolean };
export type DecideResult = { decided: number; pending: number; runStatus: AiRunStatus };

/** Eventos do SSE de uma execução (event_type + payload). */
export type AiRunEvent =
  | { type: 'status'; status: AiRunStatus; error?: string | null }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; toolUseId: string; name: string; title: string }
  | {
      type: 'tool_result';
      toolUseId: string;
      name: string;
      isError: boolean;
      summary: string;
      /**
       * Tool com segredo (spec 027): executada pela API na decisão; `content` é o
       * resultado para o modelo (sem o segredo), que o worker usa ao retomar.
       */
      prepared?: boolean;
      content?: string;
    }
  | { type: 'message'; message: AiMessageDto }
  | { type: 'confirmation'; confirmations: ToolConfirmationDto[] }
  | { type: 'usage'; run: AiRunDto }
  | { type: 'title'; title: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; status: AiRunStatus; error?: string | null }
  /**
   * Telegram de entrada (spec 029), interno: a execução veio de um chat pareado
   * (origin), o "Recusar" pediu o motivo (reason_requested/reason_done) e o que
   * já foi enviado ao chat (sent, por chave). O console ignora.
   */
  | {
      type: 'telegram';
      action: 'origin' | 'reason_requested' | 'reason_done' | 'sent';
      destinationId?: string;
      chatId?: string;
      confirmationId?: string;
      key?: string;
    };

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

export type ClassificationSuggestResult = {
  queued: boolean;
  runId: string | null;
  lines: number;
  /** Pulada (spec 028): orçamento de IA atingido ou limite por minuto, com a mensagem. */
  skippedReason?: string;
};

/* ---------------- requisições ao provedor (spec 023) ---------------- */

export type AiRequestOperation =
  | 'chat'
  | 'title'
  | 'embedding'
  | 'vision_describe'
  | 'transcription'
  | 'speech'
  | 'test_connection'
  | 'list_models';

export type AiRequestStatus = 'running' | 'ok' | 'error' | 'canceled';

export type AiRequestListItem = {
  id: string;
  providerId: string | null;
  providerName: string | null;
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  username: string | null;
  conversationId: string | null;
  runId: string | null;
  operation: AiRequestOperation;
  purpose: AiUsagePurpose | null;
  model: string | null;
  method: string;
  path: string;
  streaming: boolean;
  status: AiRequestStatus;
  httpStatus: number | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  firstByteMs: number | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  requestBytes: number | null;
  responseBytes: number | null;
};

export type AiRequestPage = { items: AiRequestListItem[]; nextCursor: string | null };

export type AiRequestAttemptDto = {
  attempt: number;
  startedAt: string;
  durationMs: number | null;
  httpStatus: number | null;
  errorType: string | null;
  errorMessage: string | null;
  retryAfterMs: number | null;
  rateLimitHeaders: Record<string, string> | null;
  responseBody: string | null;
};

/** Uma parte do corpo no detalhe: o texto, ou só o tamanho quando passa do limite da tela (baixe pela rota body). */
export type AiRequestBodyPart = { text: string | null; bytes: number; truncated: boolean };

export type AiRequestDetail = AiRequestListItem & {
  /** URL completa (origem do provedor + caminho), para o cURL. */
  url: string;
  providerKind: AiProviderKind | null;
  logBodies: boolean;
  conversationTitle: string | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  requestBody: AiRequestBodyPart | null;
  responseBody: AiRequestBodyPart | null;
  responseStream: AiRequestBodyPart | null;
  attemptList: AiRequestAttemptDto[];
};

export type AiUsageSlice = UsageTotals & { key: string };

export type AiUsagePeriodSummary = {
  totals: UsageTotals[];
  byPurpose: AiUsageSlice[];
  byModel: AiUsageSlice[];
};

export type AiProviderHealthRow = {
  model: string | null;
  requests: number;
  ok: number;
  errors: number;
  canceled: number;
  /** erros ÷ (ok + erros); null sem nenhuma. */
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p50FirstByteMs: number | null;
  p95FirstByteMs: number | null;
  avgAttempts: number | null;
  lastErrorAt: string | null;
};

export type AiProviderSummary = {
  provider: AiProviderDto;
  usage: { month: AiUsagePeriodSummary; last30Days: AiUsagePeriodSummary; total: AiUsagePeriodSummary };
  health: AiProviderHealthRow[];
  recent: AiRequestListItem[];
  /** Progresso do índice de embeddings por modelo (spec 024). */
  embeddingIndexes: AiEmbeddingIndexDto[];
};

/** Um índice de embeddings (provedor, modelo): indexados / total. */
export type AiEmbeddingIndexDto = {
  model: string;
  inUse: boolean;
  lastInUseAt: string | null;
  /** Vetores com o texto atual. */
  indexed: number;
  /** Na fila (texto novo ou alterado). */
  pending: number;
  /** Registros que a busca enxerga (entidades, títulos, compras de cartão, linhas de extrato). */
  total: number;
};

/** Configuração do sistema (spec 023): o valor do banco vence a variável de ambiente. */
export type AppSettingDto = {
  key: string;
  /** Valor em vigor (do banco ou, sem ele, da variável). */
  value: unknown;
  source: 'database' | 'env';
  /** Valor da variável de ambiente (o "padrão"). */
  envValue: unknown;
  envName: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};
