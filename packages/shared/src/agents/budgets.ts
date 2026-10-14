import { z } from 'zod';
import { agentsStrings } from '../i18n/areas/agents';
import { id } from '../schemas/common';
import { AI_USAGE_PURPOSES } from './schemas';
import type { AiProviderHealthRow, AiUsagePurpose } from './types';

/*
 * Orçamentos, limites e painel de uso (spec 028): entradas da API e das tools,
 * os DTOs do painel e as funções puras de apoio (micros ⇄ valor, taxa de
 * cache, limiar do aviso). Sem banco: a API e o console importam daqui.
 */

export const AI_BUDGET_SCOPES = ['user', 'agent', 'flows', 'global'] as const;
export type AiBudgetScope = (typeof AI_BUDGET_SCOPES)[number];
export const AI_BUDGET_CURRENCIES = ['USD', 'BRL'] as const;
export type AiBudgetCurrency = (typeof AI_BUDGET_CURRENCIES)[number];
export type AiBudgetState = 'ok' | 'alert' | 'blocked';

/** Chaves de app_settings do limite por minuto (o banco vence a variável de ambiente). */
export const AI_RATE_SETTING_KEYS = { runs: 'ai.runs_per_minute', flows: 'ai.flow_runs_per_minute' } as const;

/** Valor mensal na moeda (ex.: 50 = US$ 50,00); gravado em milionésimos. */
const monthlyLimit = z
  .number()
  .positive('O valor do orçamento precisa ser maior que zero.')
  .max(1_000_000_000)
  .describe('Valor mensal na moeda do orçamento (ex.: 50 = US$ 50,00).');
const alertPercent = z.number().int().min(1).max(99).describe('Percentual do aviso (1–99, padrão 80).');

export const aiBudgetCreateInput = z
  .object({
    scope: z
      .enum(AI_BUDGET_SCOPES)
      .describe('user = um usuário (userId); agent = um agente (agentId); flows = os fluxos automáticos; global = o total do sistema.'),
    userId: id.nullish(),
    agentId: id.nullish(),
    currency: z.enum(AI_BUDGET_CURRENCIES).default('USD').describe('Moeda do preço dos modelos (USD ou BRL).'),
    monthlyLimit,
    alertPercent: alertPercent.default(80),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'user' ? !v.userId : v.userId)
      ctx.addIssue({ code: 'custom', path: ['userId'], message: 'Informe o usuário só no orçamento de um usuário.' });
    if (v.scope === 'agent' ? !v.agentId : v.agentId)
      ctx.addIssue({ code: 'custom', path: ['agentId'], message: 'Informe o agente só no orçamento de um agente.' });
  });

/** O escopo e o alvo não mudam: para outro alvo, crie outro orçamento. */
export const aiBudgetUpdateInput = z.object({
  currency: z.enum(AI_BUDGET_CURRENCIES).optional(),
  monthlyLimit: monthlyLimit.optional(),
  alertPercent: alertPercent.optional(),
  isActive: z.boolean().optional(),
});

const optionalId = id.optional().or(z.literal('').transform(() => undefined));
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');

/** Painel de uso: período em datas de São Paulo (inclusivo, até 366 dias) e os filtros. */
export const aiUsagePanelQuery = z
  .object({
    from: isoDay,
    to: isoDay,
    providerId: optionalId,
    agentId: optionalId,
    userId: optionalId,
    purpose: z
      .enum(AI_USAGE_PURPOSES)
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .refine((v) => v.from <= v.to, { message: 'O início do período é depois do fim.', path: ['from'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, {
    message: 'Escolha um período de até um ano.',
    path: ['to'],
  });

/* ---------------- DTOs ---------------- */

/** Situação do orçamento no mês (ai_budget_status). */
export type AiBudgetStatusDto = {
  month: string;
  spentMicros: number;
  /** Chamadas do escopo sem preço no mês (não entram no gasto). */
  unpricedCalls: number;
  percent: number;
  status: AiBudgetState;
};

export type AiBudgetDto = {
  id: string;
  scope: AiBudgetScope;
  userId: string | null;
  username: string | null;
  agentId: string | null;
  agentName: string | null;
  currency: AiBudgetCurrency;
  monthlyLimitMicros: number;
  alertPercent: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Mês corrente (só dos ativos). */
  current: AiBudgetStatusDto | null;
};

type Tokens = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

/** Uma linha diária do painel: dia × provedor × agente × moeda (moeda nula = sem preço). */
export type AiUsageDailyRow = Tokens & {
  day: string;
  providerId: string | null;
  providerName: string | null;
  agentId: string | null;
  agentName: string | null;
  currency: AiBudgetCurrency | null;
  costMicros: number | null;
  hasUnpriced: boolean;
};

export type AiUsageModelRow = Tokens & {
  providerId: string | null;
  providerName: string | null;
  model: string;
  currency: AiBudgetCurrency | null;
  costMicros: number | null;
  hasUnpriced: boolean;
  runs: number;
  /** Saúde do modelo nas requisições (ai_provider_health, spec 023), nos dias do período até hoje (máx. 365). */
  health: Pick<AiProviderHealthRow, 'requests' | 'errors' | 'errorRate' | 'p50Ms' | 'p95Ms'> | null;
};

export type AiUsagePurposeRow = Tokens & {
  purpose: AiUsagePurpose;
  currency: AiBudgetCurrency | null;
  costMicros: number | null;
  hasUnpriced: boolean;
  runs: number;
  users: number;
};

export type AiUsageTopConversation = Tokens & {
  rank: number;
  conversationId: string;
  title: string | null;
  purpose: string;
  userId: string | null;
  username: string | null;
  agentId: string | null;
  agentName: string | null;
  archived: boolean;
  currency: AiBudgetCurrency;
  costMicros: number;
  runs: number;
  unpricedCalls: number;
  lastUsedAt: string | null;
};

export type AiUsagePanel = {
  from: string;
  to: string;
  daily: AiUsageDailyRow[];
  byModel: AiUsageModelRow[];
  byPurpose: AiUsagePurposeRow[];
  topConversations: AiUsageTopConversation[];
  /** Dias da saúde dos modelos (ai_provider_health). */
  healthDays: number;
};

/** Minha conta → IA: o uso do mês e os orçamentos que me cobrem (o meu e o global). */
export type MyAiUsageDto = {
  month: string;
  usage: {
    currency: AiBudgetCurrency | null;
    calls: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number | null;
    hasUnpriced: boolean;
  }[];
  budgets: AiBudgetDto[];
};

/* ---------------- funções puras ---------------- */

export const toMicros = (value: number) => Math.round(value * 1_000_000);
export const fromMicros = (micros: number) => micros / 1_000_000;

/** Taxa de acerto do cache: lido ÷ entrada total (entrada + gravado + lido); null sem entrada. */
export function cacheHitRate(t: Pick<Tokens, 'inputTokens' | 'cacheWriteTokens' | 'cacheReadTokens'>): number | null {
  const total = t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens;
  return total > 0 ? t.cacheReadTokens / total : null;
}

/** Limiar do aviso alcançado: 100 bloqueado, o percentual de aviso em alerta, nenhum em ok. */
export function budgetThreshold(status: AiBudgetState, alertPercent: number): number | null {
  if (status === 'blocked') return 100;
  if (status === 'alert') return alertPercent;
  return null;
}

/** "global", "fluxos automáticos", "agente X" ou "usuário @fulano". */
export function budgetScopeLabel(b: { scope: AiBudgetScope; username?: string | null; agentName?: string | null }): string {
  const L = agentsStrings.budgetScope;
  if (b.scope === 'agent') return L.agent(b.agentName ?? null);
  if (b.scope === 'user') return L.user(b.username ?? null);
  return L[b.scope];
}

/** Valor na moeda: "US$ 12,34" / "R$ 5,00" (até 4 casas abaixo de um centavo). */
export function formatMicros(micros: number, currency: AiBudgetCurrency): string {
  const value = micros / 1_000_000;
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
