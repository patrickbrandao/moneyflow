import {
  type AgentOptionDto,
  type AgentTaskDto,
  type AgentTaskRunDto,
  type AgentTaskSchedule,
  formatDateTime,
  scheduleText,
  t,
  taskSkipReasonText,
  type UserRow,
} from '@moneyflow/shared';
import { CalendarClock, History, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAgents } from '../../agents/AgentsProvider';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { useToast } from '../Toast';
import { Badge, Button, cx, EmptyRow, Field, Modal, Panel, type Tone, useConfirm } from '../ui';

const k = t.agentsUi.tasks;

const RUN_TONE: Record<string, Tone> = {
  started: 'info',
  skipped: 'outline',
  failed: 'danger',
  completed: 'ok',
  awaiting_confirmation: 'warn',
  canceled: 'outline',
  queued: 'info',
  running: 'info',
};

/** Rótulo do último resultado de um disparo: o status da execução (começou) ou o motivo (pulado/falhou). */
function runLabel(run: AgentTaskRunDto): { label: string; tone: Tone; title?: string } {
  if (run.status === 'started' && run.runStatus) {
    return {
      label: k.runStatus[run.runStatus] ?? run.runStatus,
      tone: RUN_TONE[run.runStatus] ?? 'neutral',
      title: run.runError ?? undefined,
    };
  }
  return { label: k.status[run.status] ?? run.status, tone: RUN_TONE[run.status] ?? 'neutral', title: taskSkipReasonText(run.skipReason) };
}

/**
 * Tarefas agendadas dos agentes (spec 029). Em Minha conta, as do usuário
 * (rotas /api/account/agent-tasks); em /admin/ai (`admin`), as de todos, com
 * o dono escolhido ao criar (/api/admin/ai/agent-tasks).
 */
export function AgentTasksPanel({ admin = false }: { admin?: boolean }) {
  const base = admin ? '/api/admin/ai/agent-tasks' : '/api/account/agent-tasks';
  const { data, error, reload } = useApi<AgentTaskDto[]>(base);
  const [editing, setEditing] = useState<AgentTaskDto | 'new' | null>(null);
  const [history, setHistory] = useState<AgentTaskDto | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const { run } = useAction();

  async function runNow(task: AgentTaskDto) {
    const result = await run(() => api.post<AgentTaskRunDto>(`${base}/${task.id}/run`));
    if (!result) return;
    void reload();
    if (result.status === 'started') toast.success(k.runStarted);
    else toast.error(k.runSkipped(taskSkipReasonText(result.skipReason)));
  }

  async function remove(task: AgentTaskDto) {
    const ok = await confirm({ title: k.deleteConfirm(task.name), description: k.deleteHint, confirmLabel: t.common.delete, danger: true });
    if (ok && (await run(() => api.del(`${base}/${task.id}`), k.deleted))) void reload();
  }

  async function toggle(task: AgentTaskDto) {
    if (await run(() => api.patch(`${base}/${task.id}`, { isActive: !task.isActive }), k.saved)) void reload();
  }

  return (
    <Panel
      title={admin ? k.adminTitle : k.title}
      icon={<CalendarClock />}
      actions={
        <Button size="sm" onClick={() => setEditing('new')} data-testid="task-new">
          <Plus /> {k.new}
        </Button>
      }
    >
      <p className="panel-hint">{admin ? k.adminHint : k.hint}</p>
      {error ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="table-wrap mt-3">
          <table className="data" data-testid="tasks-table">
            <thead>
              <tr>
                <th>{k.name}</th>
                {admin && <th>{k.owner}</th>}
                <th>{k.agent}</th>
                <th>{k.schedule}</th>
                <th>{k.next}</th>
                <th>{k.last}</th>
                <th>{k.active}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && <SkelRows cols={admin ? 8 : 7} rows={2} />}
              {data?.length === 0 && <EmptyRow colSpan={admin ? 8 : 7}>{k.empty}</EmptyRow>}
              {data?.map((task) => {
                const last = task.lastRun ? runLabel(task.lastRun) : null;
                return (
                  <tr key={task.id} className={cx(!task.isActive && 'is-off')} data-testid="task-row">
                    <td>
                      <span className="row-title">{task.name}</span>
                      <span className="row-sub">{task.instruction.slice(0, 80)}</span>
                    </td>
                    {admin && <td className="mono text-xs">@{task.username}</td>}
                    <td>{task.agentName}</td>
                    <td>{scheduleText(task.schedule)}</td>
                    <td className="mono text-xs">{task.nextRunAt ? formatDateTime(task.nextRunAt) : '—'}</td>
                    <td>
                      {last ? (
                        <Badge tone={last.tone}>
                          <span title={last.title}>{last.label}</span>
                        </Badge>
                      ) : (
                        <span className="text-xs text-faint">{k.never}</span>
                      )}
                    </td>
                    <td>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={task.isActive}
                          onChange={() => void toggle(task)}
                          aria-label={`${k.active}: ${task.name}`}
                        />
                      </label>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button
                        type="button"
                        className="row-action"
                        title={k.runNow}
                        aria-label={`${k.runNow}: ${task.name}`}
                        onClick={() => void runNow(task)}
                      >
                        <Play />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title={k.history}
                        aria-label={`${k.history}: ${task.name}`}
                        onClick={() => setHistory(task)}
                      >
                        <History />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title={k.edit}
                        aria-label={`${k.edit}: ${task.name}`}
                        onClick={() => setEditing(task)}
                      >
                        <Pencil />
                      </button>
                      <button
                        type="button"
                        className="row-action danger"
                        title={t.common.delete}
                        aria-label={`${t.common.delete}: ${task.name}`}
                        onClick={() => void remove(task)}
                      >
                        <Trash2 />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TaskFormModal
          base={base}
          admin={admin}
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {history && <TaskHistoryModal base={base} task={history} onClose={() => setHistory(null)} onRunNow={() => runNow(history)} />}
    </Panel>
  );
}

function TaskFormModal({
  base,
  admin,
  task,
  onClose,
  onSaved,
}: {
  base: string;
  admin: boolean;
  task: AgentTaskDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const agents = useApi<AgentOptionDto[]>('/api/agents');
  const users = useApi<UserRow[]>(admin && !task ? '/api/users' : null);
  const [name, setName] = useState(task?.name ?? '');
  const [userId, setUserId] = useState('');
  const [agentId, setAgentId] = useState(task?.agentId ?? '');
  const [instruction, setInstruction] = useState(task?.instruction ?? '');
  const [kind, setKind] = useState<AgentTaskSchedule['kind']>(task?.schedule.kind ?? 'daily');
  const [time, setTime] = useState(task?.schedule.time ?? '08:00');
  const [weekdays, setWeekdays] = useState<number[]>(task?.schedule.kind === 'weekly' ? task.schedule.weekdays : [1]);
  const [day, setDay] = useState<string>(task?.schedule.kind === 'monthly' ? String(task.schedule.day) : '1');
  const [active, setActive] = useState(task?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const agentChoice = agentId || agents.data?.[0]?.id || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!agentChoice) return setError(k.noAgents);
    if (kind === 'weekly' && weekdays.length === 0) return setError(k.weekdays);
    setError(null);
    const schedule =
      kind === 'weekly'
        ? { kind, time, weekdays }
        : kind === 'monthly'
          ? { kind, time, day: day === 'last' ? 'last' : Number(day) }
          : { kind, time };
    const body = { name: name.trim(), agentId: agentChoice, instruction: instruction.trim(), schedule, isActive: active };
    const saved = await run(
      () =>
        task
          ? api.patch<AgentTaskDto>(`${base}/${task.id}`, body)
          : api.post<AgentTaskDto>(base, { ...body, ...(admin && userId ? { userId } : {}) }),
      k.saved,
    );
    if (saved) onSaved();
  }

  return (
    <Modal open title={task ? k.edit : k.new} onClose={onClose}>
      <form onSubmit={submit} autoComplete="off" data-testid="task-form">
        <div className="modal-body form-grid">
          <Field label={k.name}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </Field>
          <div className="form-grid cols-2">
            {admin && !task && (
              <Field label={k.owner}>
                <select className="field" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="task-owner">
                  <option value="">—</option>
                  {users.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      @{u.username}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={k.agent}>
              <select className="field" value={agentChoice} onChange={(e) => setAgentId(e.target.value)} required data-testid="task-agent">
                {agents.data?.length === 0 && <option value="">{k.noAgents}</option>}
                {agents.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={k.instruction} hint={k.instructionHint}>
            <textarea
              className="field"
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={20_000}
              required
              data-testid="task-instruction"
            />
          </Field>
          <div className="form-grid cols-2">
            <Field label={k.kind}>
              <select
                className="field"
                value={kind}
                onChange={(e) => setKind(e.target.value as AgentTaskSchedule['kind'])}
                data-testid="task-kind"
              >
                {(['daily', 'weekly', 'monthly'] as const).map((x) => (
                  <option key={x} value={x}>
                    {k.kinds[x]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={k.time}>
              <input
                className="field field-mono"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
                data-testid="task-time"
              />
            </Field>
          </div>
          {kind === 'weekly' && (
            <div role="group" aria-label={k.weekdays}>
              <span className="label">{k.weekdays}</span>
              <div className="flex flex-wrap gap-3">
                {k.weekdayShort.map((label, index) => {
                  const value = index + 1;
                  return (
                    <label key={label} className="check">
                      <input
                        type="checkbox"
                        checked={weekdays.includes(value)}
                        onChange={(e) =>
                          setWeekdays((list) =>
                            e.target.checked ? [...list, value].sort((a, b) => a - b) : list.filter((d) => d !== value),
                          )
                        }
                      />{' '}
                      {label}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          {kind === 'monthly' && (
            <Field label={k.day}>
              <select className="field" value={day} onChange={(e) => setDay(e.target.value)} data-testid="task-day">
                {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                <option value="last">{k.lastDay}</option>
              </select>
            </Field>
          )}
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {k.active}
          </label>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !instruction.trim()} data-testid="task-save">
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function TaskHistoryModal({
  base,
  task,
  onClose,
  onRunNow,
}: {
  base: string;
  task: AgentTaskDto;
  onClose: () => void;
  onRunNow: () => Promise<void>;
}) {
  const { data, error, reload } = useApi<AgentTaskRunDto[]>(`${base}/${task.id}/runs`);
  const agents = useAgents();
  return (
    <Modal open title={`${k.history}: ${task.name}`} onClose={onClose} wide>
      <div className="modal-body">
        <div className="flex justify-end gap-2 mb-3">
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            {k.refresh}
          </Button>
          <Button size="sm" onClick={() => void onRunNow().then(reload)} data-testid="task-run-now">
            <Play /> {k.runNow}
          </Button>
        </div>
        {error ? (
          <LoadError error={error} onRetry={() => void reload()} />
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="task-history">
              <thead>
                <tr>
                  <th>{k.scheduledFor}</th>
                  <th>{t.common.kind}</th>
                  <th>{t.common.status}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!data && <SkelRows cols={4} rows={2} />}
                {data?.length === 0 && <EmptyRow colSpan={4}>{k.historyEmpty}</EmptyRow>}
                {data?.map((r) => {
                  const label = runLabel(r);
                  return (
                    <tr key={r.id}>
                      <td className="mono text-xs">{formatDateTime(r.scheduledFor)}</td>
                      <td>{k.trigger[r.triggerKind]}</td>
                      <td>
                        <Badge tone={label.tone}>{label.label}</Badge>
                        {label.title && <span className="row-sub">{label.title}</span>}
                      </td>
                      <td className="text-right">
                        {r.conversationId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              void agents.openById(r.conversationId!);
                              onClose();
                            }}
                          >
                            {k.openSession}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
