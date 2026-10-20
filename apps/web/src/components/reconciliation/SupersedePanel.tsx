import {
  formatDate,
  periodsOverlap,
  type StatementImportDetail,
  type StatementImportSummary,
  type StatementLineRow,
  type SupersedeResolveAction,
  type SupersedeResolveResult,
  type SupersedeResult,
  t,
} from '@moneyflow/shared';
import { Check, Loader2, Replace, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { followRun } from '../../agents/stream';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { Money } from '../domain';
import { ModalActions } from '../forms';
import { Badge, Button, EmptyRow, Field, Modal } from '../ui';

const S = t.statements.supersede;

/*
 * Lote provisório e a troca pelo consolidado na tela do lote (spec 031): o
 * modal da troca (com a prévia, a partir do provisório ou do consolidado) e o
 * painel das sobras do provisório, com casar/manter/excluir e a sugestão de
 * pares pela IA, aprovada em lote.
 */

/** Lotes não provisórios e não substituídos da conta que cobrem o período do provisório. */
export const consolidatedCandidates = (imports: StatementImportSummary[], provisional: StatementImportSummary) =>
  imports.filter((i) => i.id !== provisional.id && !i.provisional && !i.supersededBy && periodsOverlap(i, provisional));

/** Provisórios ativos sobrepostos a este lote (o aviso "Este extrato cobre o período do provisório"). */
export const overlappingProvisionals = (imports: StatementImportSummary[], lot: StatementImportSummary) =>
  imports.filter((i) => i.id !== lot.id && i.provisional && !i.supersededBy && periodsOverlap(i, lot));

/**
 * Substituir: escolhe o consolidado (quando parte do provisório), mostra a
 * prévia (a troca sem gravar) e confirma.
 */
export function SupersedeModal({
  consolidatedOptions,
  provisionalIds,
  onClose,
  onDone,
}: {
  /** Lotes que podem substituir (o primeiro vem escolhido). */
  consolidatedOptions: StatementImportSummary[];
  /** Provisórios a substituir; omitidos = os ativos sobrepostos ao consolidado. */
  provisionalIds?: string[];
  onClose: () => void;
  onDone: (result: SupersedeResult) => void;
}) {
  const [consolidatedId, setConsolidatedId] = useState(consolidatedOptions[0]?.id ?? '');
  const [preview, setPreview] = useState<SupersedeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    if (!consolidatedId) return;
    setPreview(null);
    setError(null);
    let alive = true;
    api
      .post<SupersedeResult>(`/api/statement-imports/${consolidatedId}/supersede`, { provisionalImportIds: provisionalIds, dryRun: true })
      .then((result) => alive && setPreview(result))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [consolidatedId, provisionalIds]);

  async function confirm() {
    const result = await run(
      () =>
        api.post<SupersedeResult>(`/api/statement-imports/${consolidatedId}/supersede`, {
          provisionalImportIds: preview?.provisionalImportIds,
        }),
      (r) => S.replaced(r.transferred.length),
    );
    if (result) onDone(result);
  }

  return (
    <Modal open title={S.previewTitle} onClose={onClose} wide>
      <div className="modal-body flex flex-col gap-3" data-testid="supersede-modal">
        {consolidatedOptions.length === 0 ? (
          <p className="notice warn">{S.noConsolidated}</p>
        ) : (
          consolidatedOptions.length > 1 && (
            <Field label={S.chooseConsolidated}>
              <select
                className="field"
                value={consolidatedId}
                onChange={(e) => setConsolidatedId(e.target.value)}
                aria-label={S.chooseConsolidated}
              >
                {consolidatedOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.fileName} · {formatDate(o.periodStart)} – {formatDate(o.periodEnd)}
                  </option>
                ))}
              </select>
            </Field>
          )
        )}
        {error && <p className="notice danger">{error}</p>}
        {!preview && !error && consolidatedId && (
          <p className="inline-flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="spin size-4" /> {S.previewing}
          </p>
        )}
        {preview && (
          <>
            <dl className="kv" data-testid="supersede-preview">
              <dt>{S.transferred}</dt>
              <dd>{preview.transferred.length}</dd>
              <dt>{S.paired}</dt>
              <dd>{preview.paired.length}</dd>
              <dt>{S.dropped}</dt>
              <dd>{preview.dropped.length}</dd>
              <dt>{S.pending}</dt>
              <dd>{preview.pending.length}</dd>
              <dt>{S.consolidatedLeftover}</dt>
              <dd>{preview.consolidatedLeftover.length}</dd>
            </dl>
            {preview.pending.length > 0 && <p className="notice warn">{S.pendingWarning(preview.pending.length)}</p>}
          </>
        )}
        <ModalActions>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || !preview}>
            <Replace /> {S.confirmReplace}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

/**
 * Sobras do provisório (no consolidado): as linhas conciliadas no provisório
 * sem par neste lote. Casar com uma linha do consolidado (mesmo valor, sem
 * par), manter ou excluir o lançamento; ou pedir pares à IA e aprovar em lote.
 */
export function LeftoversPanel({
  detail,
  canWrite,
  onChanged,
}: {
  detail: StatementImportDetail;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const superseded = useApi<StatementLineRow[]>(`/api/statement-imports/${detail.id}/superseded-lines`);
  const { run, busy } = useAction();
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<SupersedeResolveResult['failed']>([]);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const reload = superseded.reload;

  useEffect(() => {
    if (!suggesting) return;
    const controller = new AbortController();
    void followRun(suggesting, { signal: controller.signal, onEvent: () => {} }).then((result) => {
      if (result === 'aborted') return;
      setSuggesting(null);
      void reload();
    });
    return () => controller.abort();
  }, [suggesting, reload]);

  const all = superseded.data ?? [];
  const pending = all.filter((l) => l.supersedeOutcome === 'pending');
  if (superseded.data && pending.length === 0) return null;
  // Linhas do consolidado livres para casar: pendentes (nova/sugerida) e que não ficaram no lugar de outra provisória.
  const taken = new Set(all.map((l) => l.supersededByLineId).filter(Boolean));
  const free = detail.lines.filter((l) => (l.status === 'new' || l.status === 'suggested') && !taken.has(l.id));
  const withSuggestion = pending.filter((l) => l.supersedeSuggestion);
  const chosen = [...selected].filter((id) => withSuggestion.some((l) => l.id === id));

  const after = (result: SupersedeResolveResult | undefined) => {
    if (!result) return;
    setFailures(result.failed);
    setSelected(new Set());
    void reload();
    onChanged();
  };

  const resolve = async (lineId: string, action: SupersedeResolveAction) =>
    after(
      await run(
        () =>
          api.post<SupersedeResolveResult>(`/api/statement-imports/${detail.id}/superseded-lines/resolve`, {
            items: [{ lineId, action, ...(action === 'pair' ? { consolidatedLineId: pairs[lineId] } : {}) }],
          }),
        (r) => S.resolved(r.done),
      ),
    );

  async function suggest() {
    const result = await run(() =>
      api.post<{ queued: boolean; runId: string; lines: number }>(`/api/statement-imports/${detail.id}/superseded-lines/suggest`),
    );
    if (result?.runId) setSuggesting(result.runId);
  }

  const decide = async (decision: 'approve' | 'reject') =>
    after(
      await run(
        () =>
          api.post<SupersedeResolveResult>(`/api/statement-imports/${detail.id}/superseded-lines/suggestions`, {
            lineIds: chosen.length ? chosen : withSuggestion.map((l) => l.id),
            decision,
          }),
        (r) => S.resolved(r.done),
      ),
    );

  return (
    <section className="well mb-3 grid gap-2" data-testid="supersede-leftovers">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[13px]">{S.leftoverTitle(pending.length)}</strong>
        <span className="flex-1" />
        {canWrite && (
          <Button size="sm" variant="ghost" onClick={() => void suggest()} disabled={busy || Boolean(suggesting) || pending.length === 0}>
            {suggesting ? <Loader2 className="spin" /> : <Sparkles />} {S.suggestAi}
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted">{suggesting ? S.suggestQueued : S.leftoverHint}</p>
      {canWrite && withSuggestion.length > 0 && (
        <div className="notice info flex flex-wrap items-center gap-2" data-testid="supersede-suggestions">
          <Sparkles className="size-4 flex-none" />
          <strong className="min-w-0 flex-1">{S.aiProposes(withSuggestion.length)}</strong>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('reject')}>
            <X /> {S.rejectSuggestions}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void decide('approve')}>
            <Check /> {chosen.length ? S.approveSelected : S.approveAll}
          </Button>
        </div>
      )}
      {failures.length > 0 && (
        <ul className="notice danger list-disc pl-5">
          {failures.map((f) => (
            <li key={f.lineId}>
              {pending.find((l) => l.id === f.lineId)?.description ?? f.lineId}: {f.message}
            </li>
          ))}
        </ul>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {canWrite && <th className="w-8" />}
              <th>{t.common.date}</th>
              <th>{t.common.description}</th>
              <th className="num">{t.common.amount}</th>
              <th>{t.statements.pair}</th>
              <th>{S.pairWith}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!superseded.data && <EmptyRow colSpan={7}>{t.common.loading}</EmptyRow>}
            {pending.map((line) => {
              const candidates = free.filter((c) => c.amountCents === line.amountCents);
              const suggestion = line.supersedeSuggestion;
              return (
                <tr key={line.id} data-testid="supersede-leftover">
                  {canWrite && (
                    <td>
                      {suggestion && (
                        <input
                          type="checkbox"
                          aria-label={line.description}
                          checked={selected.has(line.id)}
                          onChange={() =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(line.id)) next.delete(line.id);
                              else next.add(line.id);
                              return next;
                            })
                          }
                        />
                      )}
                    </td>
                  )}
                  <td className="mono whitespace-nowrap text-xs">{formatDate(line.postedOn)}</td>
                  <td className="rec-wide">
                    <span className="row-title">{line.description}</span>
                    {suggestion && (
                      <span className="row-sub">
                        <Badge tone="accent">
                          <Sparkles /> {S.suggestionOf(formatDate(suggestion.postedOn), suggestion.description)}
                        </Badge>
                        {suggestion.reason ? ` ${suggestion.reason}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="num whitespace-nowrap">
                    <Money cents={line.amountCents} signed />
                  </td>
                  <td className="rec-wide text-[13px]">
                    {line.target ? `${line.target.description}${line.target.entityName ? ` · ${line.target.entityName}` : ''}` : '—'}
                  </td>
                  <td>
                    {canWrite &&
                      (candidates.length === 0 ? (
                        <span className="row-sub">{S.noPairCandidates}</span>
                      ) : (
                        <select
                          className="field"
                          aria-label={S.choosePair}
                          value={pairs[line.id] ?? ''}
                          onChange={(e) => setPairs((current) => ({ ...current, [line.id]: e.target.value }))}
                        >
                          <option value="">{S.choosePair}</option>
                          {candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {formatDate(c.postedOn)} · {c.description}
                            </option>
                          ))}
                        </select>
                      ))}
                  </td>
                  <td className="text-right">
                    {canWrite && (
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        <Button size="sm" disabled={busy || !pairs[line.id]} onClick={() => void resolve(line.id, 'pair')}>
                          <Replace /> {S.pairWith}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve(line.id, 'keep')}>
                          {S.actions.keep}
                        </Button>
                        {line.createdEntry && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve(line.id, 'delete_entry')}>
                            <Trash2 /> {S.actions.delete_entry}
                          </Button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
