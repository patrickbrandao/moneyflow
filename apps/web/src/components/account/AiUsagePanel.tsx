import { budgetScopeLabel, formatMicros, type MyAiUsageDto, t } from '@moneyflow/shared';
import { Gauge } from 'lucide-react';
import { formatInt } from '../../agents/format';
import { useApi } from '../../lib/hooks';
import { BudgetMeter, BudgetStatusBadge } from '../admin-ai/UsageBudgets';
import { LoadError } from '../domain';
import { Panel, Skel } from '../ui';

const a = t.agentsUi.account;

/** Minha conta → IA (spec 028): o meu uso no mês e o orçamento que me cobre (o meu e o global). */
export function AiUsagePanel() {
  const { data, error, reload } = useApi<MyAiUsageDto>('/api/account/ai/usage');
  return (
    <Panel title={a.usageTitle} icon={<Gauge />}>
      <p className="panel-hint">{a.usageHint}</p>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <Skel className="mt-3" h={40} />
      ) : (
        <div className="mt-3 grid gap-4" data-testid="account-ai-usage">
          {data.usage.length === 0 ? (
            <p className="text-sm text-muted">{a.usageEmpty}</p>
          ) : (
            <dl className="kv">
              {data.usage.map((u) => (
                <div key={u.currency ?? 'none'} className="contents">
                  <dt>{u.currency ? formatMicros(u.costMicros ?? 0, u.currency) : t.agentsUi.usage.unpriced}</dt>
                  <dd>
                    {a.calls(u.calls)} · {t.agentsUi.usage.tokens(formatInt(u.inputTokens), formatInt(u.outputTokens))}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div>
            <h3 className="mb-2 text-sm font-semibold">{a.budget}</h3>
            {data.budgets.length === 0 ? (
              <p className="text-sm text-muted">{a.noBudget}</p>
            ) : (
              <div className="grid gap-3">
                {data.budgets.map((b) => (
                  <div key={b.id} className="grid gap-1" data-testid="account-budget">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span>{budgetScopeLabel(b)}</span>
                      <BudgetStatusBadge budget={b} />
                    </div>
                    <BudgetMeter budget={b} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
