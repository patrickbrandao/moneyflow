import {
  type CardOverview,
  type ClassificationSuggestResult,
  formatDate,
  formatSignedBRL,
  type LineStatus,
  type StatementImportDetail,
  type StatementLineRow,
  t,
} from '@moneyflow/shared';
import {
  ArrowLeft,
  Ban,
  Check,
  CheckCheck,
  Download,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Tag,
  Undo2,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { followRun } from '../../agents/stream';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { useParamState } from '../../lib/params';
import { attachmentUrl } from '../../lib/upload';
import { CategoryLabel, LoadError, Money, SkelRows } from '../domain';
import { useToast } from '../Toast';
import { Badge, Button, cx, EmptyRow, Skel, Tabs, type Tone } from '../ui';
import { CreateModal, MatchModal } from './LineModals';
import { RecipesPanel } from './RecipesPanel';
import { ReconcileAiPanel } from './ReconcileAiPanel';

const s = t.statements;
const ai = t.agentsUi.flows;

const STATUS_TONE: Record<LineStatus, Tone> = { matched: 'ok', suggested: 'accent', new: 'warn', ignored: 'outline' };

export function LineStatusBadge({ status }: { status: LineStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{s.statuses[status]}</Badge>;
}

/** Saldo do banco × saldo do app, com a divergência destacada. */
export function BalanceCompare({ bank, app, diff }: { bank: number | null; app: number | null; diff: number | null }) {
  if (bank === null) return <span className="text-faint">—</span>;
  return (
    <span className="rec-pair">
      <span>
        <Money cents={bank} /> <span className="text-faint">×</span> {app === null ? '—' : <Money cents={app} />}
      </span>
      {diff !== null && diff !== 0 ? (
        <span className="rec-diff text-xs">
          {s.difference}: {formatSignedBRL(diff)}
        </span>
      ) : (
        <span className="row-sub">{s.noDifference}</span>
      )}
    </span>
  );
}

function RowAction({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className={cx('row-action', danger && 'danger')} title={label} aria-label={label} onClick={onClick}>
      {icon}
    </button>
  );
}

type Dialog = { kind: 'match' | 'create' | 'classify'; line: StatementLineRow } | null;

/** Execução do agente que está sugerindo a classificação das linhas (logo após importar ou pelo "Sugerir com IA"). */
export type SuggestionRun = { runId: string; lines: number };

/** Detalhe de um lote: linhas com status, par no app e as ações de conciliação. */
export function ImportDetail({
  importId,
  caixaId,
  card,
  onBack,
  onChanged,
  suggestionRun = null,
}: {
  importId: string;
  caixaId: string;
  card: CardOverview | null;
  onBack: () => void;
  onChanged: () => void;
  suggestionRun?: SuggestionRun | null;
}) {
  const detail = useApi<StatementImportDetail>(`/api/statement-imports/${importId}`);
  const [filter, setFilter] = useParamState('lines');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<{ lineId: string; message: string }[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, busy } = useAction();
  const data = detail.data;
  const isCard = Boolean(data?.cardCaixaId);
  const canWrite = Boolean(data?.canWrite);
  const suggested = data?.lines.filter((l) => l.status === 'suggested') ?? [];
  // Sugestões do agente (classificationSource 'agent'): aprovar vira classificação do usuário; descartar limpa.
  const agentLines = data?.lines.filter((l) => l.classificationSource === 'agent') ?? [];
  const suggestedIds = new Set(suggested.map((l) => l.id));
  const agentIds = new Set(agentLines.map((l) => l.id));
  const selectedSuggested = [...selected].filter((id) => suggestedIds.has(id));
  const selectedAgent = [...selected].filter((id) => agentIds.has(id));
  const toast = useToast();
  const [suggesting, setSuggesting] = useState<SuggestionRun | null>(suggestionRun);
  const [aiPanelKey, setAiPanelKey] = useState(0);
  const [recipesVersion, setRecipesVersion] = useState(0);
  const { reload } = detail;

  const changed = () => {
    void reload();
    onChanged();
  };

  // As sugestões chegam pelo worker: segue o SSE da execução e recarrega as linhas quando ela termina.
  const suggestingRunId = suggesting?.runId ?? null;
  useEffect(() => {
    if (!suggestingRunId) return;
    const controller = new AbortController();
    void followRun(suggestingRunId, { signal: controller.signal, onEvent: () => {} }).then((result) => {
      if (result === 'aborted') return;
      setSuggesting(null);
      void reload();
    });
    return () => controller.abort();
  }, [suggestingRunId, reload]);

  async function confirmLines(ids: string[]) {
    if (ids.length === 0) return;
    const result = await run(
      () =>
        api.post<{ confirmed: number; failed: { lineId: string; message: string }[] }>('/api/statement-lines/confirm', { lineIds: ids }),
      (r) => s.confirmed(r.confirmed),
    );
    if (!result) return;
    setFailures(result.failed);
    setSelected(new Set());
    changed();
  }

  const confirmAll = () => void confirmLines(selectedSuggested.length ? selectedSuggested : suggested.map((l) => l.id));

  async function decideSuggestions(decision: 'approve' | 'reject') {
    const ids = selectedAgent.length ? selectedAgent : [...agentIds];
    if (ids.length === 0) return;
    const result = await run(
      () => api.post<{ updated: number }>('/api/statement-lines/suggestions', { lineIds: ids, decision }),
      (r) => (decision === 'approve' ? ai.approved(r.updated) : ai.discarded(r.updated)),
    );
    if (!result) return;
    setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
    changed();
  }

  async function aiSuggest() {
    const result = await run(() => api.post<ClassificationSuggestResult>(`/api/statement-imports/${importId}/ai-suggest`));
    if (!result) return;
    if (!result.queued || result.lines === 0) return toast.success(ai.aiSuggestNothing);
    toast.success(ai.aiSuggestQueued(result.lines));
    if (result.runId) setSuggesting({ runId: result.runId, lines: result.lines });
  }

  useRegisterCommands(
    canWrite && suggested.length > 0
      ? [{ id: 'statement-confirm-suggested', label: s.confirmSuggested, group: 'Recurso', icon: <CheckCheck />, run: confirmAll }]
      : [],
    [canWrite, suggested.length, selected.size, importId],
  );

  async function lineAction(line: StatementLineRow, action: 'unmatch' | 'ignore' | 'unignore', message: string) {
    if (await run(() => api.post(`/api/statement-lines/${line.id}/${action}`), message)) changed();
  }

  async function rematch() {
    if (await run(() => api.post(`/api/statement-imports/${importId}/rematch`), s.rematched)) changed();
  }

  if (detail.error) return <LoadError error={detail.error} onRetry={() => void detail.reload()} />;

  const counts: Record<string, number> = { all: data?.lines.length ?? 0, matched: 0, suggested: 0, new: 0, ignored: 0 };
  for (const line of data?.lines ?? []) counts[line.status] = (counts[line.status] ?? 0) + 1;
  const status = filter ?? 'all';
  const lines = (data?.lines ?? []).filter((l) => status === 'all' || l.status === status);
  // Selecionáveis: as sugeridas e as do agente (aprovar em lote) e as novas (escopo do play das receitas, spec 030).
  const selectable = (l: StatementLineRow) => l.status === 'suggested' || l.status === 'new' || l.classificationSource === 'agent';
  const visibleSuggested = lines.filter(selectable);
  const pendingIds = new Set((data?.lines ?? []).filter((l) => l.status === 'new' || l.status === 'suggested').map((l) => l.id));
  const selectedPending = [...selected].filter((id) => pendingIds.has(id));
  const allChecked = visibleSuggested.length > 0 && visibleSuggested.every((l) => selected.has(l.id));
  const failedById = new Map(failures.map((f) => [f.lineId, f.message]));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="rec-bar">
        <Button variant="quiet" size="sm" onClick={onBack}>
          <ArrowLeft /> {s.back}
        </Button>
        <span className="flex-1" />
        {canWrite && (
          <Button variant="ghost" size="sm" onClick={() => void rematch()} disabled={busy}>
            <RefreshCw /> {s.rematch}
          </Button>
        )}
        {canWrite && (
          <Button variant="ghost" size="sm" onClick={() => void aiSuggest()} disabled={busy || Boolean(suggesting)}>
            <Sparkles /> {ai.aiSuggest}
          </Button>
        )}
        {canWrite && suggested.length > 0 && (
          <Button size="sm" onClick={confirmAll} disabled={busy}>
            <CheckCheck />{' '}
            {selectedSuggested.length ? s.confirmSelected(selectedSuggested.length) : `${s.confirmSuggested} (${suggested.length})`}
          </Button>
        )}
      </div>

      {data ? (
        <div className="well mb-3 flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-0">
            <span className="label">{s.file}</span>
            <a className="link inline-flex items-center gap-1" href={attachmentUrl(data.attachmentId)} title={s.download}>
              <Download className="size-3.5" /> {data.fileName}
            </a>
            <span className="row-sub">
              {data.format.toUpperCase()}
              {data.accountName ? ` · ${data.accountName}` : ''}
            </span>
          </div>
          <div>
            <span className="label">{s.period}</span>
            <span className="mono text-xs">
              {formatDate(data.periodStart)} – {formatDate(data.periodEnd)}
            </span>
          </div>
          <div>
            <span className="label">{s.lines}</span>
            <span className="text-[13px]">{s.counts(data.matchedLines, data.suggestedLines, data.newLines, data.ignoredLines)}</span>
          </div>
          <div>
            <span className="label">
              {s.bankBalance} × {s.appBalance.toLowerCase()}
              {data.bankBalanceOn ? ` · ${formatDate(data.bankBalanceOn)}` : ''}
            </span>
            <BalanceCompare bank={data.bankBalanceCents} app={data.appBalanceCents} diff={data.differenceCents} />
          </div>
        </div>
      ) : (
        <Skel h={64} className="mb-3" />
      )}

      {failures.length > 0 && (
        <div className="notice danger mb-3">
          <strong>{s.confirmFailures}:</strong>
          <ul className="mt-1 list-disc pl-5">
            {failures.map((f) => (
              <li key={f.lineId}>
                {data?.lines.find((l) => l.id === f.lineId)?.description ?? f.lineId}: {f.message}
              </li>
            ))}
          </ul>
          <button type="button" className="link mt-1" onClick={() => setFailures([])}>
            {t.common.close}
          </button>
        </div>
      )}

      {data && (
        <RecipesPanel
          importId={importId}
          selectedLineIds={selectedPending}
          version={recipesVersion}
          onStarted={() => setAiPanelKey((n) => n + 1)}
        />
      )}
      {data && (
        <ReconcileAiPanel
          key={aiPanelKey}
          importId={importId}
          canWrite={canWrite}
          onChanged={() => {
            changed();
            setRecipesVersion((n) => n + 1);
          }}
        />
      )}

      {suggesting && (
        <div className="notice info mb-3 flex items-center gap-2" data-testid="ai-suggesting">
          <Loader2 className="spin size-4 flex-none" />
          <span>{ai.aiSuggesting(suggesting.lines)}</span>
        </div>
      )}

      {canWrite && agentLines.length > 0 && (
        <div className="notice info mb-3 flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 flex-none" />
          <span className="min-w-0 flex-1">
            <strong>{ai.agentSuggestions(agentLines.length)}</strong> · {ai.agentSuggestionsHint}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decideSuggestions('reject')}>
            <X /> {ai.discardSuggestions(selectedAgent.length || agentLines.length)}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void decideSuggestions('approve')}>
            <Check /> {ai.approveSuggestions(selectedAgent.length || agentLines.length)}
          </Button>
        </div>
      )}

      <Tabs
        value={status}
        onChange={(key) => setFilter(key === 'all' ? null : key)}
        items={(['all', 'suggested', 'new', 'matched', 'ignored'] as const).map((key) => ({
          key,
          label: key === 'all' ? s.filterAll : s.statuses[key]!,
          count: counts[key] ?? 0,
        }))}
      />

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {canWrite && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label={s.selectAll}
                    title={s.selectAll}
                    checked={allChecked}
                    disabled={visibleSuggested.length === 0}
                    onChange={() => setSelected(allChecked ? new Set() : new Set([...selected, ...visibleSuggested.map((l) => l.id)]))}
                  />
                </th>
              )}
              <th>{t.common.date}</th>
              <th>{t.common.description}</th>
              <th className="num">{t.common.amount}</th>
              <th>{t.common.status}</th>
              <th>{s.pair}</th>
              <th>{s.classification}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!data && <SkelRows cols={8} />}
            {data && lines.length === 0 && <EmptyRow colSpan={canWrite ? 8 : 7}>{s.noLines}</EmptyRow>}
            {lines.map((line) => (
              <tr key={line.id} className={cx(line.status === 'ignored' && 'is-off', selected.has(line.id) && 'is-selected')}>
                {canWrite && (
                  <td>
                    {selectable(line) && (
                      <input
                        type="checkbox"
                        aria-label={s.selectLine(line.description)}
                        checked={selected.has(line.id)}
                        onChange={() => toggle(line.id)}
                      />
                    )}
                  </td>
                )}
                <td className="mono whitespace-nowrap text-xs">{formatDate(line.postedOn)}</td>
                <td className="rec-wide">
                  <span className="row-title">{line.description}</span>
                  {line.fitid && <span className="row-sub mono">{line.fitid}</span>}
                  {failedById.has(line.id) && <span className="row-sub text-danger">{failedById.get(line.id)}</span>}
                </td>
                <td className="num whitespace-nowrap">
                  <Money cents={line.amountCents} signed />
                </td>
                <td>
                  <LineStatusBadge status={line.status} />
                </td>
                <td className="rec-wide">
                  {line.target ? (
                    <span className="rec-pair">
                      <span className="row-title text-[13px]">{line.target.description}</span>
                      <span className="row-sub">
                        {s.targetKinds[line.target.kind]} · {formatDate(line.target.date)}
                        {line.target.entityName ? ` · ${line.target.entityName}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="text-faint text-xs">{s.noPair}</span>
                  )}
                </td>
                <td className="rec-mid">
                  {line.entityName || line.categoryName ? (
                    <span className="rec-pair">
                      {line.entityName && <span className="text-[13px]">{line.entityName}</span>}
                      {line.categoryName && <CategoryLabel name={line.categoryName} slot={line.categoryColorSlot} />}
                      {line.classificationSource === 'agent' ? (
                        <span className="ai-tag">
                          <Sparkles /> {s.bySource.agent}
                        </span>
                      ) : (
                        line.classificationSource && <span className="row-sub">{s.bySource[line.classificationSource]}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-faint text-xs">—</span>
                  )}
                </td>
                <td className="text-right">
                  {canWrite && (
                    <span className="row-actions">
                      {line.status === 'suggested' && (
                        <RowAction icon={<Check />} label={s.confirmLine} onClick={() => void confirmLines([line.id])} />
                      )}
                      {(line.status === 'new' || line.status === 'suggested') && (
                        <>
                          <RowAction icon={<Link2 />} label={s.matchManual} onClick={() => setDialog({ kind: 'match', line })} />
                          <RowAction icon={<Plus />} label={s.create} onClick={() => setDialog({ kind: 'create', line })} />
                          <RowAction icon={<Tag />} label={s.classify} onClick={() => setDialog({ kind: 'classify', line })} />
                        </>
                      )}
                      {(line.status === 'matched' || line.status === 'suggested') && (
                        <RowAction icon={<Undo2 />} label={s.unmatch} onClick={() => void lineAction(line, 'unmatch', s.unmatched)} />
                      )}
                      {line.status === 'ignored' ? (
                        <RowAction icon={<RotateCcw />} label={s.unignore} onClick={() => void lineAction(line, 'unignore', s.unignored)} />
                      ) : (
                        line.status !== 'matched' && (
                          <RowAction icon={<Ban />} label={s.ignore} danger onClick={() => void lineAction(line, 'ignore', s.ignored)} />
                        )
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'match' && (
        <MatchModal
          line={dialog.line}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            changed();
          }}
        />
      )}
      {(dialog?.kind === 'create' || dialog?.kind === 'classify') && (
        <CreateModal
          line={dialog.line}
          isCard={isCard}
          caixaId={caixaId}
          card={card}
          classifyOnly={dialog.kind === 'classify'}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            changed();
          }}
        />
      )}
    </>
  );
}
