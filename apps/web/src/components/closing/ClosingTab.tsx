import { addMonths, type CaixaDetail, type ClosingsOverview, formatDateTime, formatMonth, t, todayIso } from '@moneyflow/shared';
import { AlertTriangle, CalendarCheck, Info, ListChecks, Lock, LockOpen } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { caixaTab } from '../../lib/links';
import { LoadError, SkelRows } from '../domain';
import { FormError, ModalActions } from '../forms';
import { useToast } from '../Toast';
import { Badge, Button, EmptyRow, Field, Modal, Panel, Skel, useConfirm } from '../ui';

import '../../styles/reconciliation.css';

const c = t.closing;

/** 'YYYY-MM-DD…' ou 'YYYY-MM' → 'YYYY-MM-01'. */
const monthStart = (value: string) => `${value.slice(0, 7)}-01`;
const monthLabel = (value: string) => formatMonth(monthStart(value));

/** Aba Fechamento: meses fechados da caixa, fechar e reabrir (spec 008). */
export function ClosingTab({ caixa }: { caixa: CaixaDetail }) {
  const overview = useApi<ClosingsOverview>(`/api/caixas/${caixa.id}/closings`);
  const [closing, setClosing] = useState<string | null>(null);
  const confirm = useConfirm();
  const { run } = useAction();
  const data = overview.data;
  const canWrite = data?.canWrite ?? caixa.canWrite;
  const closedMonths = new Set((data?.closings ?? []).map((row) => monthStart(row.month)));

  useRegisterCommands(
    canWrite
      ? [{ id: 'closing-close', label: c.closeMonthIn(caixa.name), group: 'Recurso', icon: <Lock />, run: () => setClosing('') }]
      : [],
    [canWrite, caixa.id],
  );

  async function reopen(month: string) {
    const label = monthLabel(month);
    const ok = await confirm({ title: c.reopenTitle(label), description: c.reopenBody, confirmLabel: c.reopen, danger: true });
    if (ok && (await run(() => api.del(`/api/caixas/${caixa.id}/closings/${monthStart(month)}`), c.reopened(label)))) {
      void overview.reload();
    }
  }

  if (overview.error) return <LoadError error={overview.error} onRetry={() => void overview.reload()} />;

  return (
    <>
      <div className="rec-bar">
        <p className="notice info m-0 flex flex-1 items-start gap-2">
          <Info className="mt-0.5 size-4 flex-none" /> {c.explain}
        </p>
        {canWrite && (
          <Button onClick={() => setClosing('')}>
            <Lock /> {c.closeMonth}
          </Button>
        )}
      </div>
      {data && !canWrite && <p className="mb-3 text-[13px] text-muted">{c.readOnly}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title={c.closedMonths} icon={<CalendarCheck />}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{c.month}</th>
                  <th>{c.closedBy}</th>
                  <th>{c.closedAt}</th>
                  <th>{c.notes}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!data && <SkelRows cols={5} rows={3} />}
                {data?.closings.length === 0 && <EmptyRow colSpan={5}>{c.noClosings}</EmptyRow>}
                {data?.closings.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="inline-flex items-center gap-2">
                        <span className="row-title">{monthLabel(row.month)}</span>
                        <Badge tone="ok">
                          <Lock /> {c.status.closed}
                        </Badge>
                      </span>
                    </td>
                    <td className="text-dim">{row.closedBy ?? '—'}</td>
                    <td className="mono text-xs">{formatDateTime(row.createdAt)}</td>
                    <td className="text-dim">{row.notes ?? ''}</td>
                    <td className="text-right">
                      {data.canReopen ? (
                        <Button variant="ghost" size="sm" onClick={() => void reopen(row.month)}>
                          <LockOpen /> {c.reopen}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && !data.canReopen && data.closings.length > 0 && <p className="hint mt-2">{c.reopenAdminOnly}</p>}
        </Panel>

        <Panel title={c.pending} icon={<ListChecks />}>
          <p className="panel-hint mb-2">{c.pendingHint}</p>
          {!data && <Skel h={40} />}
          {data?.unreconciled.length === 0 && <p className="list-empty">{c.noPending}</p>}
          {data && data.unreconciled.length > 0 && (
            <ul className="item-list">
              {data.unreconciled.map((row) => (
                <li key={row.month} className="flex items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="row-title">{monthLabel(row.month)}</span>
                    <span className="row-sub">{c.pendingLines(row.lines)}</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    {closedMonths.has(monthStart(row.month)) && <Badge tone="warn">{c.status.closed}</Badge>}
                    <Link className="link text-[13px]" to={caixaTab(caixa.id, 'reconciliation')}>
                      {c.goReconcile}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {closing !== null && (
        <CloseMonthModal
          caixaId={caixa.id}
          closed={closedMonths}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            void overview.reload();
          }}
        />
      )}
    </>
  );
}

function CloseMonthModal({
  caixaId,
  closed,
  onClose,
  onDone,
}: {
  caixaId: string;
  closed: Set<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [month, setMonth] = useState(addMonths(todayIso(), -1).slice(0, 7));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const already = closed.has(monthStart(month));

  async function send(force: boolean) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/caixas/${caixaId}/closings`, { month, notes: notes.trim() || undefined, force: force || undefined });
      toast.success(c.closed(monthLabel(month)));
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'closing_unreconciled') setWarning(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  return (
    <Modal open title={c.closeMonth} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <p className="text-[13px] text-muted">{c.explain}</p>
        <Field label={c.month} hint={already ? c.alreadyClosed : undefined}>
          <input
            type="month"
            className="field"
            value={month}
            max={todayIso().slice(0, 7)}
            required
            onChange={(e) => {
              setMonth(e.target.value);
              setWarning(null);
            }}
          />
        </Field>
        <Field label={`${c.notes} (${t.common.optional})`}>
          <textarea
            className="field"
            rows={2}
            value={notes}
            maxLength={500}
            placeholder={c.notesPlaceholder}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        {warning && (
          <div className="alert warn" role="alert">
            <AlertTriangle />
            <div>
              <strong>{c.unreconciledTitle}</strong>
              <p>{warning}</p>
            </div>
          </div>
        )}
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          {warning ? (
            <Button variant="danger" onClick={() => void send(true)} disabled={busy}>
              {c.closeAnyway}
            </Button>
          ) : (
            <Button type="submit" disabled={busy || !month || already}>
              <Lock /> {c.closeMonth}
            </Button>
          )}
        </ModalActions>
      </form>
    </Modal>
  );
}
