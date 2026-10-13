import { z } from 'zod';
import { ptBR } from '../i18n/pt-BR';
import { entityFilterFields, id, isoDate, optionalText, queryBool, requiredText } from './common';

/*
 * Entradas da fase 3 (visão): relatórios e canvas de fluxo (spec 014),
 * mensagens (013) e notificações do sino.
 */

const E = ptBR.errors;

/** Lista de caixas na query, separada por vírgula; vazia = todas as legíveis. */
const caixaIdList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter(Boolean) : []))
  .pipe(z.array(id).max(200));

const period = {
  from: isoDate,
  to: isoDate,
  caixaIds: caixaIdList,
};

const checkPeriod = (q: { from: string; to: string }) => q.to >= q.from;

/* ---------------- relatórios ---------------- */

export const REPORT_BASES = ['competence', 'cash'] as const;

export const reportQuery = z
  .object({ ...period, basis: z.enum(REPORT_BASES).default('competence'), ...entityFilterFields })
  .refine(checkPeriod, { message: E.invalidPeriod, path: ['to'] });

export const projectionQuery = z.object({
  caixaIds: caixaIdList,
  ...entityFilterFields,
  horizons: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map(Number) : [30, 60, 90]))
    .pipe(z.array(z.number().int().min(1).max(1100)).min(1).max(6)),
});

/* ---------------- canvas de fluxo ---------------- */

export const flowQuery = z.object(period).refine(checkPeriod, { message: E.invalidPeriod, path: ['to'] });

const nodeKind = z.enum(['caixa', 'entity']);

/** Linhas da gaveta: de uma aresta (origem + destino + tipo) ou de um nó (todas as que o tocam). */
export const flowLinesQuery = z
  .object({
    ...period,
    nodeKind: nodeKind.optional(),
    nodeId: id.optional(),
    sourceKind: nodeKind.optional(),
    sourceId: id.optional(),
    targetKind: nodeKind.optional(),
    targetId: id.optional(),
    edgeKind: z.enum(['payment', 'receipt', 'transfer', 'card_invoice', 'card_purchase']).optional(),
    payerCaixaId: id.optional(),
    /** Ids de entidades (folhas agrupadas): linhas que tocam qualquer uma delas. */
    entityIds: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(',').filter(Boolean) : []))
      .pipe(z.array(id).max(500)),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .refine(checkPeriod, { message: E.invalidPeriod, path: ['to'] });

export const canvasPositionsInput = z.object({
  layout: z.string().trim().min(1).max(60).default('default'),
  positions: z
    .array(
      z.object({
        nodeKind: z.enum(['caixa', 'entity', 'category_group']),
        nodeId: id,
        x: z.number().finite().min(-1e7).max(1e7),
        y: z.number().finite().min(-1e7).max(1e7),
      }),
    )
    .max(2000),
});

/* ---------------- mensagens ---------------- */

export const MESSAGE_EVENT_KINDS = [
  'due_reminder',
  'overdue',
  'daily_summary',
  'weekly_summary',
  'invoice_closed',
  'card_limit',
  'reconciliation_divergence',
  'agent_completed',
  'agent_message',
  'contract_notice_deadline',
  'contract_ending',
  'contract_renewal_pending',
  'contract_readjustment',
] as const;

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, E.invalidTime);
const intList = (min: number, max: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(1)
    .max(10)
    .refine((list) => new Set(list).size === list.length, E.duplicateValues);

/** Parâmetros por evento (os mesmos de message_subscription_params_valid no banco). */
export const messageParamsSchemas = {
  due_reminder: z.strictObject({ days_before: intList(0, 60), send_at: hhmm }),
  overdue: z.strictObject({ send_at: hhmm, repeat_every_days: z.number().int().min(1).max(30).optional() }),
  daily_summary: z.strictObject({ send_at: hhmm }),
  weekly_summary: z.strictObject({ send_at: hhmm, weekday: z.number().int().min(1).max(7) }),
  invoice_closed: z.strictObject({}),
  card_limit: z.strictObject({ thresholds_percent: intList(1, 200) }),
  reconciliation_divergence: z.strictObject({ min_difference_cents: z.number().int().min(0).max(999_999_999_999_999).optional() }),
  agent_completed: z.strictObject({}),
  agent_message: z.strictObject({}),
  contract_notice_deadline: z.strictObject({ days_before: intList(0, 180), send_at: hhmm }),
  contract_ending: z.strictObject({ days_before: intList(0, 180), send_at: hhmm }),
  contract_renewal_pending: z.strictObject({ send_at: hhmm, repeat_every_days: z.number().int().min(1).max(30).optional() }),
  contract_readjustment: z.strictObject({ send_at: hhmm }),
} satisfies Record<(typeof MESSAGE_EVENT_KINDS)[number], z.ZodType>;

/** Parâmetros padrão de cada evento ao assinar. */
export const DEFAULT_MESSAGE_PARAMS: Record<(typeof MESSAGE_EVENT_KINDS)[number], Record<string, unknown>> = {
  due_reminder: { days_before: [3, 1, 0], send_at: '08:00' },
  overdue: { send_at: '08:00', repeat_every_days: 1 },
  daily_summary: { send_at: '07:30' },
  weekly_summary: { send_at: '07:30', weekday: 1 },
  invoice_closed: {},
  card_limit: { thresholds_percent: [80, 100] },
  reconciliation_divergence: { min_difference_cents: 0 },
  agent_completed: {},
  agent_message: {},
  contract_notice_deadline: { days_before: [15, 7, 1, 0], send_at: '08:00' },
  contract_ending: { days_before: [30, 7, 0], send_at: '08:00' },
  contract_renewal_pending: { send_at: '08:00', repeat_every_days: 7 },
  contract_readjustment: { send_at: '08:00' },
};

/** Token do bot: <id numérico>:<chave>. */
export const botToken = z
  .string()
  .trim()
  .regex(/^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$/, E.invalidBotToken);

/** chat_id numérico (grupos negativos) ou @canal. */
export const chatId = z
  .string()
  .trim()
  .regex(/^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/, E.invalidChatId);

export const destinationCreateInput = z
  .object({
    name: requiredText(120),
    ownerKind: z.enum(['user', 'caixa', 'global']).default('user'),
    ownerCaixaId: id.nullish(),
    botToken,
    chatId,
    isActive: z.boolean().default(true),
    notes: optionalText(),
  })
  .refine((v) => (v.ownerKind === 'caixa') === Boolean(v.ownerCaixaId), { message: E.destinationOwner, path: ['ownerCaixaId'] });

export const destinationUpdateInput = z.object({
  name: requiredText(120).optional(),
  /** Ausente ou vazio = mantém o token atual (write-only). */
  botToken: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(botToken.optional()),
  chatId: chatId.optional(),
  isActive: z.boolean().optional(),
  notes: optionalText().optional(),
});

export const subscriptionInput = z
  .object({
    eventKind: z.enum(MESSAGE_EVENT_KINDS),
    params: z.record(z.string(), z.unknown()).default({}),
    isActive: z.boolean().default(true),
    caixaIds: z.array(id).max(200).default([]),
  })
  .superRefine((v, ctx) => {
    const result = messageParamsSchemas[v.eventKind].safeParse(v.params);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['params', ...issue.path] } as never);
    }
  });

export const outboxQuery = z.object({
  destinationId: id.optional(),
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'canceled']).optional(),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/* ---------------- notificações ---------------- */

export const notificationQuery = z.object({
  unread: queryBool,
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

export type ReportQuery = z.input<typeof reportQuery>;
export type FlowQuery = z.input<typeof flowQuery>;
export type FlowLinesQuery = z.input<typeof flowLinesQuery>;
export type CanvasPositionsInput = z.input<typeof canvasPositionsInput>;
export type DestinationCreateInput = z.input<typeof destinationCreateInput>;
export type DestinationUpdateInput = z.input<typeof destinationUpdateInput>;
export type SubscriptionInput = z.input<typeof subscriptionInput>;
