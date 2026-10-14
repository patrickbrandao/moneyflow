import { describe, expect, it } from 'vitest';
import {
  aiBudgetCreateInput,
  aiBudgetUpdateInput,
  aiUsagePanelQuery,
  budgetAlertMessage,
  budgetScopeLabel,
  budgetThreshold,
  cacheHitRate,
  dedupKeys,
  formatMicros,
  fromMicros,
  MESSAGE_EVENT_KINDS,
  messageParamsSchemas,
  toMicros,
} from '../src';

/* Orçamentos, limite por minuto e painel de uso (spec 028): as partes puras. */

const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('orçamentos de IA', () => {
  it('entrada: alvo conforme o escopo, valor em unidades da moeda, aviso de 1 a 99', () => {
    const id = '0190a0f0-0000-7000-8000-000000000001';
    expect(aiBudgetCreateInput.parse({ scope: 'global', monthlyLimit: 50 })).toMatchObject({
      currency: 'USD',
      alertPercent: 80,
      isActive: true,
    });
    expect(aiBudgetCreateInput.safeParse({ scope: 'user', monthlyLimit: 5 }).success).toBe(false);
    expect(aiBudgetCreateInput.safeParse({ scope: 'user', userId: id, monthlyLimit: 5 }).success).toBe(true);
    expect(aiBudgetCreateInput.safeParse({ scope: 'agent', agentId: id, userId: id, monthlyLimit: 5 }).success).toBe(false);
    expect(aiBudgetCreateInput.safeParse({ scope: 'flows', agentId: id, monthlyLimit: 5 }).success).toBe(false);
    expect(aiBudgetCreateInput.safeParse({ scope: 'global', monthlyLimit: 0 }).success).toBe(false);
    expect(aiBudgetCreateInput.safeParse({ scope: 'global', monthlyLimit: 5, alertPercent: 100 }).success).toBe(false);
    expect(aiBudgetUpdateInput.parse({ isActive: false })).toEqual({ isActive: false });
    expect(toMicros(12.345678)).toBe(12_345_678);
    expect(fromMicros(2_500_000)).toBe(2.5);
  });

  it('rótulo do escopo, valor formatado, limiar e o aviso do Telegram', () => {
    expect(budgetScopeLabel({ scope: 'global' })).toBe('global');
    expect(budgetScopeLabel({ scope: 'flows' })).toBe('fluxos automáticos');
    expect(budgetScopeLabel({ scope: 'agent', agentName: 'Assistente' })).toBe('agente Assistente');
    expect(budgetScopeLabel({ scope: 'user', username: 'ana' })).toBe('usuário @ana');
    expect(nbsp(formatMicros(8_000_000, 'USD'))).toBe('US$ 8,00');
    expect(nbsp(formatMicros(1_234, 'BRL'))).toBe('R$ 0,0012');
    expect(budgetThreshold('ok', 80)).toBeNull();
    expect(budgetThreshold('alert', 75)).toBe(75);
    expect(budgetThreshold('blocked', 75)).toBe(100);
    expect(dedupKeys.aiBudgetAlert('b1', '2026-10-01', 80)).toBe('ai_budget_alert:b1:2026-10:80');
    const alert = budgetAlertMessage({ scope: 'usuário @<ana>', threshold: 80, spent: 'US$ 8,00', limit: 'US$ 10,00', percent: '80%' });
    expect(alert.text).toContain('Orçamento de IA em 80%: usuário @&lt;ana&gt;');
    expect(alert.text).not.toContain('bloqueadas');
    const blocked = budgetAlertMessage({ scope: 'global', threshold: 100, spent: 'a', limit: 'b', percent: '100%', url: 'https://x/y' });
    expect(blocked.text).toContain('Orçamento de IA atingido: global');
    expect(blocked.text).toContain('bloqueadas');
    expect(blocked.text).toContain('href="https://x/y"');
    expect(MESSAGE_EVENT_KINDS).toContain('ai_budget_alert');
    expect(messageParamsSchemas.ai_budget_alert.safeParse({}).success).toBe(true);
    expect(messageParamsSchemas.ai_budget_alert.safeParse({ send_at: '08:00' }).success).toBe(false);
  });

  it('painel: taxa de cache e o período (início ≤ fim, até um ano)', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBeNull();
    expect(cacheHitRate({ inputTokens: 100, cacheWriteTokens: 100, cacheReadTokens: 200 })).toBe(0.5);
    expect(aiUsagePanelQuery.parse({ from: '2026-10-01', to: '2026-10-14', purpose: '', userId: '' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-14',
      providerId: undefined,
      agentId: undefined,
      userId: undefined,
      purpose: undefined,
    });
    expect(aiUsagePanelQuery.safeParse({ from: '2026-10-14', to: '2026-10-01' }).success).toBe(false);
    expect(aiUsagePanelQuery.safeParse({ from: '2024-01-01', to: '2026-10-01' }).success).toBe(false);
    expect(aiUsagePanelQuery.safeParse({ from: '2026-10-01', to: '2026-10-14', purpose: 'xyz' }).success).toBe(false);
  });
});
