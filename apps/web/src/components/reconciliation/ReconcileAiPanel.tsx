import { type AiRunEvent, type ReconcileAiStartResult, type ReconcileAiStateDto, t } from '@moneyflow/shared';
import { Bot, Check, CheckCheck, Loader2, Sparkles, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useAgents } from '../../agents/AgentsProvider';
import { PreviewRows } from '../../agents/ConversationPane';
import { followRun } from '../../agents/stream';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { Badge, Button } from '../ui';

const k = t.agentsUi.reconcile;
const u = t.agentsUi;
const ACTIVE = new Set(['queued', 'running', 'awaiting_confirmation']);

/**
 * Conciliação completa com IA na tela do lote (spec 029): o interruptor
 * "Conciliar com IA ao importar" da conta/cartão, o botão "Conciliar com IA",
 * o "O agente está conciliando…" (segue o SSE da execução) e as aprovações em
 * lote das ações em ask ("O agente propõe N ações"). Ao terminar, recarrega as linhas.
 */
export function ReconcileAiPanel({ importId, canWrite, onChanged }: { importId: string; canWrite: boolean; onChanged: () => void }) {
  const path = `/api/statement-imports/${importId}/reconcile-ai`;
  const { data, reload, setData } = useApi<ReconcileAiStateDto>(path);
  const { run, busy } = useAction();
  const agents = useAgents();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const runId = data?.run && ACTIVE.has(data.run.status) && data.run.status !== 'awaiting_confirmation' ? data.run.id : null;

  // Enquanto o agente concilia: segue o SSE; a cada confirmação nova ou no fim, relê o estado e as linhas.
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    const onEvent = (event: AiRunEvent) => {
      if (event.type === 'confirmation' || (event.type === 'status' && event.status === 'awaiting_confirmation')) void reload();
    };
    void followRun(runId, { signal: controller.signal, onEvent }).then((result) => {
      if (result === 'aborted') return;
      void reload();
      changed.current();
    });
    return () => controller.abort();
  }, [runId, reload]);

  if (!data) return null;
  const pending = data.confirmations;
  const status = data.run?.status ?? null;

  async function toggleAuto(enabled: boolean) {
    const next = await run(() => api.put<ReconcileAiStateDto>(`${path}/auto`, { enabled }), k.autoSaved(enabled));
    if (next) setData(next);
  }

  async function start() {
    const started = await run(() => api.post<ReconcileAiStartResult>(path), k.started);
    if (started) void reload();
  }

  async function decide(decision: 'approved' | 'rejected', ids?: string[], why?: string) {
    if (!data?.run) return;
    const ok = await run(
      () => api.post(`/api/runs/${data.run!.id}/confirmations`, { decision, ...(ids ? { ids } : {}), ...(why ? { reason: why } : {}) }),
      k.decided,
    );
    if (!ok) return;
    setSelected(new Set());
    setRejecting(false);
    setReason('');
    void reload();
  }

  const chosen = [...selected].filter((id) => pending.some((c) => c.id === id));

  return (
    <div className="well mb-3 grid gap-2" data-testid="reconcile-ai">
      <div className="flex flex-wrap items-center gap-3">
        <Bot className="size-4 flex-none" />
        <strong className="text-[13px]">{k.title}</strong>
        {data.agent && !data.recipeName && <Badge tone="outline">{data.agent.name}</Badge>}
        {data.recipeName && <Badge tone="accent">{data.recipeName}</Badge>}
        <span className="flex-1" />
        {canWrite && (
          <label className="check text-[13px]">
            <input
              type="checkbox"
              checked={data.autoEnabled}
              disabled={busy}
              onChange={(e) => void toggleAuto(e.target.checked)}
              data-testid="reconcile-auto"
            />{' '}
            {k.auto}
          </label>
        )}
        {canWrite && data.agent && !(status && ACTIVE.has(status)) && (
          <Button size="sm" onClick={() => void start()} disabled={busy} data-testid="reconcile-start">
            <Sparkles /> {k.start}
          </Button>
        )}
      </div>
      {!data.agent && <p className="hint">{k.noAgent}</p>}
      {data.agent && !data.agent.hasKit && (canWrite || data.autoEnabled) && <p className="notice warn text-[12px]">{k.noKit}</p>}
      {(status === 'queued' || status === 'running') && (
        <div className="notice info flex items-center gap-2" data-testid="reconcile-running">
          <Loader2 className="spin size-4 flex-none" />
          <span>{data.recipeName ? t.agentsUi.recipes.running(data.recipeName) : k.running}</span>
        </div>
      )}
      {status === 'failed' && data.run?.error && <p className="notice danger text-[12px]">{k.failed(data.run.error)}</p>}
      {status === 'awaiting_confirmation' && pending.length > 0 && (
        <div className="agent-confirm" data-testid="reconcile-batch">
          <div className="agent-confirm-head">
            <span>
              {data.recipeName ? `${data.recipeName}: ` : ''}
              {k.proposes(pending.length)}
            </span>
            {data.conversationId && (
              <Button size="sm" variant="quiet" onClick={() => void agents.openById(data.conversationId!)}>
                {k.openSession}
              </Button>
            )}
          </div>
          <p className="hint">{data.canDecide ? k.proposesHint : k.otherUser}</p>
          <div className="agent-confirm-list">
            {pending.map((c) => (
              <label key={c.id} className="agent-confirm-item flex items-start gap-2">
                {data.canDecide && (
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(c.id)}
                    onChange={(e) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                    aria-label={c.preview?.title ?? c.toolName}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="agent-confirm-title">
                    {c.preview && <Badge tone="accent">{u.confirm.actions[c.preview.action] ?? c.preview.action}</Badge>}
                    <span>{c.preview?.title ?? c.toolName}</span>
                  </div>
                  {c.preview?.summary && <p className="agent-confirm-summary">{c.preview.summary}</p>}
                  {c.preview && <PreviewRows rows={c.preview.rows} />}
                  {c.preview?.warnings?.map((warning) => (
                    <p key={warning} className="notice warn mt-2 text-[12px]">
                      {warning}
                    </p>
                  ))}
                </div>
              </label>
            ))}
          </div>
          {data.canDecide &&
            (rejecting ? (
              <form
                className="agent-reject"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void decide('rejected', chosen.length ? chosen : undefined, reason.trim() || undefined);
                }}
              >
                <input
                  className="field field-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={k.rejectReason}
                  aria-label={k.rejectReason}
                  maxLength={2000}
                  autoFocus
                />
                <Button size="sm" variant="danger" type="submit" disabled={busy} data-testid="reconcile-reject-confirm">
                  {chosen.length ? k.rejectSelected(chosen.length) : k.reject}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setRejecting(false)}>
                  {t.common.cancel}
                </Button>
              </form>
            ) : (
              <div className="agent-confirm-actions">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(true)} data-testid="reconcile-reject">
                  <X /> {k.reject}
                </Button>
                {chosen.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void decide('approved', chosen)}
                    data-testid="reconcile-approve-selected"
                  >
                    <Check /> {k.approveSelected(chosen.length)}
                  </Button>
                )}
                <Button size="sm" disabled={busy} onClick={() => void decide('approved')} data-testid="reconcile-approve-all">
                  <CheckCheck /> {k.approveAll}
                </Button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
