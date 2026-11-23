import { type AiRunStatus, t, type UsageTotals } from '@moneyflow/shared';

/* Formatação dos agentes no console: nomes de tools, custo e status. */

const u = t.agentsUi;

const intFormat = new Intl.NumberFormat('pt-BR');
export const formatInt = (n: number) => intFormat.format(n);

/** Custo em milionésimos da moeda → "US$ 0,0123" / "R$ 0,05". */
export function formatCost(micros: number | null, currency: 'USD' | 'BRL' | null): string {
  if (micros === null || currency === null) return u.usage.unpriced;
  const value = micros / 1e6;
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Uma linha de uso: "1.234 entrada · 567 saída · US$ 0,01". */
export function usageLine(totals: UsageTotals[]): string {
  if (totals.length === 0) return u.usage.noUsage;
  let input = 0;
  let output = 0;
  const costs: string[] = [];
  let unpriced = false;
  for (const row of totals) {
    input += row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    output += row.outputTokens;
    if (row.costMicros !== null && row.currency) costs.push(formatCost(row.costMicros, row.currency));
    if (row.hasUnpriced || row.costMicros === null) unpriced = true;
  }
  const parts = [u.usage.tokens(formatInt(input), formatInt(output)), ...costs];
  if (unpriced) parts.push(u.usage.unpriced);
  return parts.join(' · ');
}

export const isActiveStatus = (status: AiRunStatus | null | undefined) =>
  status === 'queued' || status === 'running' || status === 'awaiting_confirmation';

/** Variável CSS da cor do agente (color_slot 1–12). */
export const agentColor = (slot: number | null | undefined) => `var(--port-${slot && slot >= 1 && slot <= 12 ? slot : 1})`;
