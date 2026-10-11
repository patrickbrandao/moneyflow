import { z } from 'zod';
import { id, optionalText, queryBool, requiredText } from '../schemas/common';

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

export const aiAgentCreateInput = z.object({
  name: requiredText(120),
  description: optionalText(2000),
  systemPrompt: z.string().max(200_000).default(''),
  providerId: id.nullish().transform((v) => v ?? null),
  model: modelName
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  params: agentParamsInput.default({}),
  /** null = todas as tools internas; [] = nenhuma. */
  enabledTools: toolList.default(null),
  requireWriteConfirmation: z.boolean().default(true),
  colorSlot: z.number().int().min(1).max(12).default(1),
  icon: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  isActive: z.boolean().default(false),
  mcpServers: z.array(agentMcpLinkInput).max(100).optional(),
});

export const aiAgentUpdateInput = aiAgentCreateInput.partial().extend({
  params: agentParamsInput.optional(),
  enabledTools: toolList.optional(),
});

export const MCP_VISIBILITIES = ['global', 'public', 'private'] as const;
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, 'Nome de cabeçalho inválido.');

export const mcpServerCreateInput = z.object({
  name: requiredText(120),
  url: httpUrl,
  /** Write-only: nome → valor (ex.: Authorization). */
  headers: z.record(headerName, z.string().max(8000)).default({}),
  visibility: z.enum(MCP_VISIBILITIES).default('public'),
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
