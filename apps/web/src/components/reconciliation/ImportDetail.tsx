import {
  type ApplyRulesResult,
  type CardOverview,
  type ClassificationSuggestResult,
  formatDate,
  formatSignedBRL,
  type LineStatus,
  type StatementImportDetail,
  type StatementLineRow,
  t,
} from '@moneyflow/shared';
import { ArrowLeft, Check, CheckCheck, Download, Landmark, Loader2, Pencil, RefreshCw, RotateCcw, Sparkles, Wand2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { followRun } from '../../agents/stream';
import { api } from '../../lib/api';
import { useRegisterCommands } from '../../lib/commands';
import { useAction, useApi } from '../../lib/hooks';
import { caixaTab } from '../../lib/links';
import { useParamState } from '../../lib/params';
import { attachmentUrl } from '../../lib/upload';
import { LoadError, Money, SkelRows } from '../domain';
import { ModalActions, MoneyInput } from '../forms';
import { useToast } from '../Toast';
import { Badge, Button, cx, EmptyRow, Field, Modal, Skel, Tabs, type Tone } from '../ui';
import { LineActions, LineClassification, LinePair } from './LineActions';
import { RecipesPanel } from './RecipesPanel';
import { ReconcileAiPanel } from './ReconcileAiPanel';

const s = t.statements;
const ai = t.agentsUi.flows;

const STATUS_TONE: Record<LineStatus, Tone> = { matched: 'ok', suggested: 'accent', new: 'warn', ignored: 'outline' };

export function LineStatusBadge({ status }: { status: LineStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{s.statuses[status]}</Badge>;
}

/** Saldo do banco × saldo do app, com a divergência destacada. */
export function BalanceCompare({
  bank,
  app,
  diff,
  interval = null,
}: {
  bank: number | null;
  app: number | null;
  diff: number | null;
  interval?: number | null;
}) {
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
      {interval !== null && (
        <span className={cx('text-xs', interval !== 0 ? 'rec-diff' : 'row-sub')} title={s.intervalDifferenceHint}>
          {s.intervalDifference}: {formatSignedBRL(interval)}
        </span>
      )}
    </span>
  );
}

/** A conta abriu depois do início do extrato: o saldo do app não cobre o começo (spec 009). */
export const openingAfterStart = (imp: { accountOpeningDate: string | null; periodStart: string }) =>
  Boolean(imp.accountOpeningDate && imp.accountOpeningDate > imp.periodStart);

/** Link para a edição da conta (saldo inicial e data de abertura) na aba Contas. */
export const adjustAccountLink = (caixaId: string, accountId: string) => `${caixaTab(caixaId, 'accounts')}?editAccount=${accountId}`;

/** Saldo do banco do lote: trocar, limpar ou voltar ao do arquivo (spec 009). */
function BalanceModal({ detail, onClose, onSaved }: { detail: StatementImportDetail; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState<number | null>(detail.bankBalanceCents);
  const [on, setOn] = useState(detail.bankBalanceOn ?? detail.periodEnd);
  const { run, busy } = useAction();

  async function save(body: { mode: 'set'; amountCents: number; on: string } | { mode: 'clear' } | { mode: 'file' }) {
    if (await run(() => api.put(`/api/statement-imports/${detail.id}/bank-balance`, body), s.balanceSaved)) onSaved();
  }

  return (
    <Modal open title={s.editBalanceTitle} onClose={onClose}>
      <form
        className="form-grid cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount !== null) void save({ mode: 'set', amountCents: amount, on });
        }}
      >
        <p className="span-all text-[13px] text-muted">{s.editBalanceHint}</p>
        <Field label={t.common.amount}>
          <MoneyInput value={amount} onChange={setAmount} allowNegative ariaLabel={s.bankBalance} />
        </Field>
        <Field label={s.bankBalanceOn}>
          <input type="date" className="field" value={on} onChange={(e) => setOn(e.target.value)} required />
        </Field>
        <div className="span-all">
          <ModalActions>
            <Button variant="ghost" disabled={busy} onClick={() => void save({ mode: 'file' })}>
              <RotateCcw /> {s.restoreFileBalance}
            </Button>
            <Button variant="ghost" disabled={busy || detail.bankBalanceCents === null} onClick={() => void save({ mode: 'clear' })}>
              {s.clearBalance}
            </Button>
            <Button type="submit" disabled={busy || amount === null}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </ModalActions>
        </div>
      </form>
    </Modal>
  );
}

/** Renomear o arquivo do lote (spec 009): troca só o nome do anexo. */
function RenameModal({ detail, onClose, onSaved }: { detail: StatementImportDetail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(detail.fileName);
  const { run, busy } = useAction();

  async function save() {
    if (await run(() => api.put(`/api/statement-imports/${detail.id}/file-name`, { fileName: name.trim() }), s.fileRenamed)) onSaved();
  }

  return (
    <Modal open title={s.renameFileTitle} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={s.fileName}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            required
            autoFocus
            // Abre com o nome selecionado sem a extensão, para digitar por cima.
            onFocus={(e) => {
              const dot = e.target.value.lastIndexOf('.');
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
            }}
          />
        </Field>
        <ModalActions>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === detail.fileName}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

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
  const [editingBalance, setEditingBalance] = useState(false);
  const [renaming, setRenaming] = useState(false);
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

  async function rematch() {
    if (await run(() => api.post(`/api/statement-imports/${importId}/rematch`), s.rematched)) changed();
  }

  // Reaplica as regras às linhas novas deste lote (spec 009).
  async function applyRules() {
    const result = await run(
      () => api.post<ApplyRulesResult>(`/api/statement-imports/${importId}/apply-rules`),
      (r) => s.rulesApplied(r.updated),
    );
    if (result) changed();
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
          <Button variant="ghost" size="sm" onClick={() => void applyRules()} disabled={busy} title={s.applyRulesImportHint}>
            <Wand2 /> {s.applyRules}
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
            {canWrite && (
              <button type="button" className="link mt-1 inline-flex items-center gap-1 text-xs" onClick={() => setRenaming(true)}>
                <Pencil className="size-3" /> {s.renameFile}
              </button>
            )}
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
            <BalanceCompare
              bank={data.bankBalanceCents}
              app={data.appBalanceCents}
              diff={data.differenceCents}
              interval={data.intervalDifferenceCents}
            />
            {canWrite && data.financialAccountId && (
              <button type="button" className="link mt-1 inline-flex items-center gap-1 text-xs" onClick={() => setEditingBalance(true)}>
                <Pencil className="size-3" /> {s.editBalance}
              </button>
            )}
          </div>
        </div>
      ) : (
        <Skel h={64} className="mb-3" />
      )}

      {data?.financialAccountId && openingAfterStart(data) && (
        <div className="notice warn mb-3 flex flex-wrap items-center gap-2" data-testid="opening-warning">
          <span className="min-w-0 flex-1">{s.openingAfterStart(formatDate(data.accountOpeningDate!))}</span>
          {canWrite && (
            <Link className="btn btn-ghost btn-sm" to={adjustAccountLink(data.caixaId, data.financialAccountId)}>
              <Landmark /> {s.adjustAccount}
            </Link>
          )}
        </div>
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
                  <LinePair line={line} />
                </td>
                <td className="rec-mid">
                  <LineClassification line={line} />
                </td>
                <td className="text-right">
                  {canWrite && (
                    <LineActions
                      line={line}
                      isCard={isCard}
                      caixaId={caixaId}
                      card={card}
                      onChanged={changed}
                      onConfirm={(lineId) => void confirmLines([lineId])}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renaming && data && (
        <RenameModal
          detail={data}
          onClose={() => setRenaming(false)}
          onSaved={() => {
            setRenaming(false);
            changed();
          }}
        />
      )}
      {editingBalance && data && (
        <BalanceModal
          detail={data}
          onClose={() => setEditingBalance(false)}
          onSaved={() => {
            setEditingBalance(false);
            changed();
          }}
        />
      )}
    </>
  );
}
