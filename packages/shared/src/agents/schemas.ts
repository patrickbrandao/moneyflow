import { z } from 'zod';
import { ptBR } from '../i18n/pt-BR';
import { id, optionalText, queryBool, requiredText } from '../schemas/common';
import { scanPromptVariables } from './prompt-vars';
import { AGENT_TOOL_MODES } from './tools';

/* Entradas da API dos agentes (spec 011): administração, conversas e tokens. */

const modelName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/, 'Nome de modelo inválido.');
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\/\S+$/, 'Informe uma URL http(s).');
const toolList = z
  .array(z.string().regex(/^[A-Za-z0-9_./-]{1,128}$/))
  .max(500)
  .nullable();

export const AI_PROVIDER_KINDS = ['anthropic', 'openai'] as const;

export const aiProviderCreateInput = z.object({
  name: requiredText(120),
  kind: z.enum(AI_PROVIDER_KINDS),
  baseUrl: httpUrl
    .max(500)
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  /** Write-only: nunca devolvida. */
  apiKey: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  embeddingModel: modelName
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  isActive: z.boolean().default(true),
  /** Registrar corpos e cabeçalhos das requisições (spec 023). */
  logBodies: z.boolean().default(false),
  notes: optionalText(),
});

export const aiProviderUpdateInput = z.object({
  name: requiredText(120).optional(),
  baseUrl: httpUrl
    .max(500)
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v === undefined ? undefined : v || null)),
  /** Vazio/omitido = mantém a atual; para apagar use clearApiKey. */
  apiKey: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || undefined),
  clearApiKey: z.boolean().default(false),
  embeddingModel: modelName
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v === undefined ? undefined : v || null)),
  isActive: z.boolean().optional(),
  logBodies: z.boolean().optional(),
  notes: optionalText().optional(),
});

export const aiPriceInput = z.object({
  providerId: id,
  model: modelName,
  currency: z.enum(['USD', 'BRL']).default('USD'),
  inputPricePerMillion: z.number().min(0).max(1e7),
  outputPricePerMillion: z.number().min(0).max(1e7),
  cacheWritePricePerMillion: z
    .number()
    .min(0)
    .max(1e7)
    .nullish()
    .transform((v) => v ?? null),
  cacheReadPricePerMillion: z
    .number()
    .min(0)
    .max(1e7)
    .nullish()
    .transform((v) => v ?? null),
  validFrom: z.iso.datetime({ offset: true }).optional(),
});

export const agentParamsInput = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().gt(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
    max_tool_iterations: z.number().int().min(1).max(200).optional(),
    thinking_budget_tokens: z.number().int().min(0).max(1_000_000).optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  })
  .strict();

export const agentMcpLinkInput = z.object({ mcpServerId: id, enabledTools: toolList.default(null) });

/** Prompt do agente: variável desconhecida é recusada ao salvar (spec 022), com o nome. */
const systemPrompt = z
  .string()
  .max(200_000)
  .superRefine((text, issue) => {
    const { unknown } = scanPromptVariables(text);
    if (unknown.length > 0) issue.addIssue({ code: 'custom', message: ptBR.agents.errors.unknownVariables(unknown) });
  });

/** Campos do agente sem valores padrão (o PATCH só muda o que vier). */
const agentFields = {
  name: requiredText(120),
  description: optionalText(2000),
  systemPrompt,
  /** Nota da versão do prompt criada nesta gravação (spec 022; só vale quando o prompt muda). */
  promptNote: optionalText(500),
  providerId: id.nullish().transform((v) => v ?? null),
  model: modelName
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  params: agentParamsInput,
  /** Kit de ferramentas (spec 021); null = sem kit = todas as tools internas, sem aprovação. */
  toolKitId: id.nullish().transform((v) => v ?? null),
  colorSlot: z.number().int().min(1).max(12),
  icon: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  isActive: z.boolean(),
  /** Agente dos fluxos automáticos (leitura de documento, conciliação, contrato); só um por vez. */
  useForFlows: z.boolean(),
  mcpServers: z.array(agentMcpLinkInput).max(100).optional(),
};

export const aiAgentCreateInput = z.object({
  ...agentFields,
  systemPrompt: agentFields.systemPrompt.default(''),
  params: agentParamsInput.default({}),
  colorSlot: agentFields.colorSlot.default(1),
  isActive: agentFields.isActive.default(false),
  useForFlows: agentFields.useForFlows.default(false),
});

/**
 * Edição parcial: sem os padrões da criação (no Zod 4, `.partial()` mantém o
 * `.default()`, e um PATCH com um campo só desativaria o agente e zeraria o prompt).
 */
export const aiAgentUpdateInput = z.object(agentFields).partial();

/* Kit de ferramentas (spec 021): lista de permissões das tools internas, cada uma em allow ou ask. */
const kitToolInput = z.object({
  name: z.string().regex(/^[A-Za-z0-9_./-]{1,128}$/, 'Nome de tool inválido.'),
  /** Sempre informado (o banco não tem padrão): o modo sugerido é preenchido pela tela. */
  mode: z.enum(AGENT_TOOL_MODES),
});
const kitTools = z
  .array(kitToolInput)
  .max(500)
  .refine((tools) => new Set(tools.map((x) => x.name)).size === tools.length, 'Tool repetida no kit.');

export const toolKitCreateInput = z.object({
  name: requiredText(120),
  description: optionalText(2000),
  tools: kitTools.default([]),
});

/** Edição parcial; `tools`, quando vem, substitui o conjunto inteiro. */
export const toolKitUpdateInput = z.object({
  name: requiredText(120).optional(),
  description: optionalText(2000).optional(),
  tools: kitTools.optional(),
});

/** Duplicar: nome da cópia opcional ("Cópia de …" quando omitido). */
export const toolKitDuplicateInput = z.object({ name: requiredText(120).optional() });

/** Ver o prompt montado de um agente para um usuário (spec 022), sem chamar o modelo. */
export const promptPreviewInput = z.object({ userId: id });

/** Minha conta → IA (spec 022): instruções para todos os agentes e a caixa principal. */
export const userAiSettingsInput = z.object({
  instructions: z.string().max(20_000).default(''),
  primaryCaixaId: id.nullish().transform((v) => v ?? null),
});

export const MCP_VISIBILITIES = ['global', 'public', 'private'] as const;
/** O que fazer com as instructions do servidor MCP (spec 022): ignorar (padrão), no prompt de sistema ou como bloco user. */
export const MCP_INSTRUCTIONS_MODES = ['ignore', 'system', 'user'] as const;
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, 'Nome de cabeçalho inválido.');

export const mcpServerCreateInput = z.object({
  name: requiredText(120),
  url: httpUrl,
  /** Write-only: nome → valor (ex.: Authorization). */
  headers: z.record(headerName, z.string().max(8000)).default({}),
  visibility: z.enum(MCP_VISIBILITIES).default('public'),
  instructionsMode: z.enum(MCP_INSTRUCTIONS_MODES).default('ignore'),
  isActive: z.boolean().default(true),
  notes: optionalText(),
});

export const mcpServerUpdateInput = z.object({
  name: requiredText(120).optional(),
  url: httpUrl.optional(),
  /** Define/troca só estes cabeçalhos (os demais ficam). */
  setHeaders: z.record(headerName, z.string().max(8000)).default({}),
  /** Remove estes cabeçalhos. */
  removeHeaders: z.array(headerName).max(30).default([]),
  visibility: z.enum(MCP_VISIBILITIES).optional(),
  instructionsMode: z.enum(MCP_INSTRUCTIONS_MODES).optional(),
  isActive: z.boolean().optional(),
  notes: optionalText().optional(),
});

export const aiUsageQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

/* ---------------- requisições ao provedor (spec 023) ---------------- */

export const AI_REQUEST_OPERATIONS = [
  'chat',
  'title',
  'embedding',
  'vision_describe',
  'transcription',
  'speech',
  'test_connection',
  'list_models',
] as const;
export const AI_REQUEST_STATUSES = ['running', 'ok', 'error', 'canceled'] as const;
export const AI_USAGE_PURPOSES = [
  'chat',
  'title',
  'embedding',
  'document_reading',
  'classify_lines',
  'contract_reading',
  'contract_markdown',
] as const;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal('').transform(() => undefined));
const optionalId = id.optional().or(z.literal('').transform(() => undefined));

export const aiRequestListQuery = z.object({
  /** Período (datas de início, no fuso de São Paulo, inclusivo). */
  from: day,
  to: day,
  providerId: optionalId,
  agentId: optionalId,
  userId: optionalId,
  runId: optionalId,
  conversationId: optionalId,
  operation: z
    .enum(AI_REQUEST_OPERATIONS)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  purpose: z
    .enum(AI_USAGE_PURPOSES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  status: z
    .enum(AI_REQUEST_STATUSES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  model: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const aiRequestBodyQuery = z.object({ part: z.enum(['request', 'response', 'stream']) });

export const appSettingInput = z.object({ value: z.unknown().refine((v) => v !== undefined, 'Informe o valor.') });

/* ---------------- conversas ---------------- */

export const screenContextInput = z
  .object({
    route: z.string().max(500).optional(),
    title: z.string().max(200).optional(),
    caixaId: id.optional(),
    caixaName: z.string().max(200).optional(),
    record: z.object({ kind: z.string().max(50), id: z.string().max(100), label: z.string().max(300).optional() }).optional(),
    filters: z.record(z.string().max(50), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

export const conversationListQuery = z.object({
  q: z.string().trim().max(500).optional(),
  archived: queryBool,
  /** Admin: conversas de outro usuário (ou "all"). */
  userId: z.union([id, z.literal('all')]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const conversationCreateInput = z.object({
  agentId: id,
  title: z.string().trim().min(1).max(200).optional(),
  screenContext: screenContextInput.optional(),
});

export const conversationUpdateInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const conversationForkInput = z.object({ messageId: id, title: z.string().trim().min(1).max(200).optional() });

export const messageSendInput = z
  .object({
    text: z.string().max(100_000).default(''),
    attachmentIds: z.array(id).max(20).default([]),
    screenContext: screenContextInput.optional(),
  })
  .refine((v) => v.text.trim() !== '' || v.attachmentIds.length > 0, {
    message: 'Escreva uma mensagem ou anexe um arquivo.',
    path: ['text'],
  });

export const confirmationDecisionInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  /** Omitido = todas as pendentes ("aprovar tudo"). */
  ids: z.array(id).min(1).max(500).optional(),
  reason: z.string().trim().max(2000).optional(),
});

export const apiTokenCreateInput = z.object({
  name: requiredText(120),
  /** Validade em dias (omitida = não expira). */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
});

export const suggestionDecisionInput = z.object({
  lineIds: z.array(id).min(1).max(1000),
  decision: z.enum(['approve', 'reject']),
});
