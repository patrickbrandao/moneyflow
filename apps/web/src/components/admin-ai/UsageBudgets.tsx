import {
  AI_BUDGET_SCOPES,
  AI_RATE_SETTING_KEYS,
  type AiAgentDto,
  type AiBudgetCurrency,
  type AiBudgetDto,
  type AiBudgetScope,
  type AppSettingDto,
  budgetScopeLabel,
  formatMicros,
  fromMicros,
  t,
  type UserRow,
} from '@moneyflow/shared';
import { Gauge, Pencil, Plus, RotateCcw, Save, Timer, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, EmptyRow, Field, Modal, Panel, type Tone, useConfirm } from '../ui';
import { optionalNumber } from './shared';

const s = t.agentsUi.admin.usage;

const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const STATUS_TONE: Record<string, Tone> = { ok: 'ok', alert: 'warn', blocked: 'danger', inactive: 'outline' };

/** Barra do gasto no mês, com a marca do aviso e a do bloqueio (100%). */
export function BudgetMeter({ budget }: { budget: AiBudgetDto }) {
  const current = budget.current;
  const spent = current?.spentMicros ?? 0;
  const fill = Math.min(100, (spent / budget.monthlyLimitMicros) * 100);
  const state = current?.status ?? 'ok';
  return (
    <div data-testid="budget-meter" data-status={budget.isActive ? state : 'inactive'}>
      <div
        className={`budget-meter ${state === 'ok' ? '' : state}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill)}
        aria-label={s.spent}
      >
        <i style={{ width: `${fill}%` }} />
        <span className="mark" style={{ left: `calc(${budget.alertPercent}% - 1px)` }} title={s.alertMark(budget.alertPercent)} />
        <span className="mark block" title={s.blockMark} />
      </div>
      <div className="budget-row-text">
        {s.budgetBar(
          formatMicros(spent, budget.currency),
          formatMicros(budget.monthlyLimitMicros, budget.currency),
          pct(current?.percent ?? 0),
        )}
        {current && current.unpricedCalls > 0 && ` · ${s.unpricedCalls(current.unpricedCalls)}`}
      </div>
    </div>
  );
}

export function BudgetStatusBadge({ budget }: { budget: AiBudgetDto }) {
  const key = budget.isActive ? (budget.current?.status ?? 'ok') : 'inactive';
  return <Badge tone={STATUS_TONE[key]}>{s.status[key]}</Badge>;
}

/** Seção Orçamentos da guia Uso: barras do mês e o CRUD (spec 028). */
export function BudgetsSection() {
  const { data, error, reload } = useApi<AiBudgetDto[]>('/api/admin/ai/budgets');
  const [editing, setEditing] = useState<AiBudgetDto | 'new' | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();

  async function remove(budget: AiBudgetDto) {
    const label = budgetScopeLabel(budget);
    if (
      !(await confirm({
        title: s.budgetRemoveConfirm(label),
        description: s.budgetRemoveHint,
        confirmLabel: t.common.remove,
        danger: true,
      }))
    )
      return;
    if (await run(() => api.del(`/api/admin/ai/budgets/${budget.id}`), s.budgetRemoved)) void reload();
  }

  return (
    <Panel
      title={s.budgets}
      icon={<Gauge />}
      actions={
        <Button size="sm" onClick={() => setEditing('new')} data-testid="budget-new">
          <Plus /> {s.newBudget}
        </Button>
      }
    >
      <p className="panel-hint mb-3">{s.budgetsHint}</p>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap">
          <table className="data" data-testid="budgets-table">
            <thead>
              <tr>
                <th>{s.scope}</th>
                <th>{s.currency}</th>
                <th>{s.spent}</th>
                <th className="num">{s.alertPercent}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={6} rows={2} />}
              {data?.length === 0 && <EmptyRow colSpan={6}>{s.budgetsEmpty}</EmptyRow>}
              {data?.map((b) => (
                <tr key={b.id} data-testid="budget-row" data-budget={b.id}>
                  <td>{budgetScopeLabel(b)}</td>
                  <td className="mono text-xs">{b.currency}</td>
                  <td className="min-w-[220px]">
                    {b.isActive ? <BudgetMeter budget={b} /> : formatMicros(b.monthlyLimitMicros, b.currency)}
                  </td>
                  <td className="num mono text-xs">{b.alertPercent}%</td>
                  <td>
                    <BudgetStatusBadge budget={b} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button
                      type="button"
                      className="row-action"
                      title={s.editBudget}
                      aria-label={s.editBudget}
                      onClick={() => setEditing(b)}
                    >
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      className="row-action danger"
                      title={t.common.remove}
                      aria-label={t.common.remove}
                      onClick={() => void remove(b)}
                    >
                      <Trash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <BudgetFormModal
          budget={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </Panel>
  );
}

function BudgetFormModal({ budget, onClose, onSaved }: { budget: AiBudgetDto | null; onClose: () => void; onSaved: () => void }) {
  const [scope, setScope] = useState<AiBudgetScope>(budget?.scope ?? 'global');
  const [userId, setUserId] = useState(budget?.userId ?? '');
  const [agentId, setAgentId] = useState(budget?.agentId ?? '');
  const [currency, setCurrency] = useState<AiBudgetCurrency>(budget?.currency ?? 'USD');
  const [limit, setLimit] = useState(budget ? String(fromMicros(budget.monthlyLimitMicros)).replace('.', ',') : '');
  const [alert, setAlert] = useState(String(budget?.alertPercent ?? 80));
  const [active, setActive] = useState(budget?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const users = useApi<UserRow[]>(budget ? null : '/api/users');
  const agents = useApi<AiAgentDto[]>(budget ? null : '/api/admin/ai/agents');
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const monthlyLimit = optionalNumber(limit);
    const alertPercent = Number(alert);
    if (monthlyLimit === undefined || monthlyLimit <= 0) return setError(t.errors.validation);
    setError(null);
    const body = { currency, monthlyLimit, alertPercent, isActive: active };
    const saved = await run(
      () =>
        budget
          ? api.patch<AiBudgetDto>(`/api/admin/ai/budgets/${budget.id}`, body)
          : api.post<AiBudgetDto>('/api/admin/ai/budgets', {
              ...body,
              scope,
              ...(scope === 'user' ? { userId } : {}),
              ...(scope === 'agent' ? { agentId } : {}),
            }),
      s.budgetSaved,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={budget ? s.editBudget : s.newBudget} onClose={onClose}>
      <form onSubmit={submit} autoComplete="off" data-testid="budget-form">
        <div className="modal-body form-grid">
          {budget ? (
            <p className="panel-hint">{budgetScopeLabel(budget)}</p>
          ) : (
            <div className="form-grid cols-2">
              <Field label={s.scope}>
                <select
                  className="field"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as AiBudgetScope)}
                  data-testid="budget-scope"
                >
                  {AI_BUDGET_SCOPES.map((x) => (
                    <option key={x} value={x}>
                      {s.scopes[x]}
                    </option>
                  ))}
                </select>
              </Field>
              {scope === 'user' && (
                <Field label={s.user}>
                  <select className="field" value={userId} onChange={(e) => setUserId(e.target.value)} required data-testid="budget-user">
                    <option value="" />
                    {users.data?.map((u) => (
                      <option key={u.id} value={u.id}>
                        @{u.username}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {scope === 'agent' && (
                <Field label={s.agent}>
                  <select
                    className="field"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    required
                    data-testid="budget-agent"
                  >
                    <option value="" />
                    {agents.data?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
          <div className="form-grid cols-2">
            <Field label={s.monthlyLimit}>
              <input
                className="field field-mono"
                inputMode="decimal"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="0,00"
                required
                pattern="[0-9]+([.,][0-9]+)?"
                data-testid="budget-limit"
                autoFocus
              />
            </Field>
            <Field label={s.currency}>
              <select className="field" value={currency} onChange={(e) => setCurrency(e.target.value as AiBudgetCurrency)}>
                <option value="USD">USD</option>
                <option value="BRL">BRL</option>
              </select>
            </Field>
            <Field label={s.alertPercent}>
              <input
                className="field field-mono"
                type="number"
                min={1}
                max={99}
                step={1}
                value={alert}
                onChange={(e) => setAlert(e.target.value)}
                required
                data-testid="budget-alert"
              />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {s.active}
          </label>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy} data-testid="budget-save">
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Limite de execuções por minuto (sessões e fluxos): o valor do banco vence a variável; "Usar o padrão" apaga o do banco. */
export function RateLimitsPanel() {
  return (
    <Panel title={s.limits} icon={<Timer />}>
      <p className="panel-hint mb-3">{s.limitsHint}</p>
      <div className="grid gap-3">
        <SettingRow settingKey={AI_RATE_SETTING_KEYS.runs} label={s.runsPerMinute} testId="limit-runs" />
        <SettingRow settingKey={AI_RATE_SETTING_KEYS.flows} label={s.flowRunsPerMinute} testId="limit-flows" />
      </div>
    </Panel>
  );
}

function SettingRow({ settingKey, label, testId }: { settingKey: string; label: string; testId: string }) {
  const { data, error, reload, setData } = useApi<AppSettingDto>(`/api/admin/settings/${settingKey}`);
  const [value, setValue] = useState('');
  const { run, busy } = useAction();
  useEffect(() => {
    if (data) setValue(String(data.value ?? ''));
  }, [data]);
  if (error) return <LoadError error={error} onRetry={() => void reload()} />;
  const save = async () => {
    const saved = await run(() => api.put<AppSettingDto>(`/api/admin/settings/${settingKey}`, { value: Number(value) }), s.limitSaved);
    if (saved) setData(saved);
  };
  const reset = async () => {
    const saved = await run(() => api.del<AppSettingDto>(`/api/admin/settings/${settingKey}`), s.limitReset);
    if (saved) setData(saved);
  };
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid={testId}>
      <Field label={label}>
        <input
          className="field w-28"
          type="number"
          min={1}
          max={1000}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid={`${testId}-input`}
        />
      </Field>
      <Button disabled={busy || !data || value === '' || Number(value) === data.value} onClick={() => void save()}>
        <Save /> {t.common.save}
      </Button>
      <Button variant="ghost" disabled={busy || data?.source !== 'database'} onClick={() => void reset()}>
        <RotateCcw /> {s.useDefault}
      </Button>
      {data && (
        <span className="pb-2 text-xs text-faint" data-source={data.source}>
          <Badge tone={data.source === 'database' ? 'accent' : 'outline'}>
            {data.source === 'database' ? s.fromDb : s.fromEnv(data.envName ?? '', String(data.envValue))}
          </Badge>
        </span>
      )}
    </div>
  );
}
