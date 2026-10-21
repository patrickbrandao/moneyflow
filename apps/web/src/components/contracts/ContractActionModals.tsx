import {
  type AmendmentPreview,
  addDays,
  type ContractActionResult,
  type ContractAmendmentInput,
  type ContractDetail,
  type ContractRenewalInput,
  type ContractTerminationInput,
  cycleEnd,
  formatAccounting,
  formatDate,
  formatMonth,
  type RenewalPreview,
  type TerminationPreview,
  t,
  termMonths,
  todayIso,
} from '@moneyflow/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { Badge, Button, Field, Modal } from '../ui';
import { AccountSelect, calendarText, useObligationOptions } from './ObligationFormModal';

const kindOf = (direction: 'receivable' | 'payable') => (direction === 'payable' ? 'expense' : 'income');
const C = t.contracts;

/** Pede a prévia (dryRun) sempre que o corpo muda; erros de validação viram mensagem. */
function usePreview<P>(path: string, body: unknown, enabled: boolean) {
  const [preview, setPreview] = useState<P | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .post<ContractActionResult<P>>(`${path}?dryRun=1`, JSON.parse(key))
        .then((result) => {
          if (!cancelled) {
            setPreview(result.preview);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setPreview(null);
            setError(err instanceof ApiError ? err.message : String(err));
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, key, enabled]);
  return { preview, error };
}

const pctOf = (text: string) => {
  if (text.trim() === '') return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/* ---------------- aditivo ---------------- */

/**
 * Aditivo (spec 034): a data de efeito, as obrigações atingidas e o que muda
 * (valor novo ou reajuste %, dia, conta da caixa da obrigação, categoria),
 * aplicado como "esta e as próximas"; a prévia mostra cada ocorrência, as
 * puladas e, no cartão, a partir de qual ocorrência o valor esperado muda.
 */
export function AmendmentModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const A = C.amendment;
  const live = contract.obligations.filter((o) => !o.endsOn || o.endsOn >= todayIso());
  const options = useObligationOptions(contract.entityId);
  const [effectiveOn, setEffectiveOn] = useState(todayIso() < contract.startsOn ? contract.startsOn : todayIso());
  const [ruleIds, setRuleIds] = useState<string[]>(() => (live.length > 0 ? live : contract.obligations).map((o) => o.id));
  const [mode, setMode] = useState<'keep' | 'value' | 'percent'>('value');
  const [value, setValue] = useState<number | null>(null);
  const [percent, setPercent] = useState('');
  const [anchorDay, setAnchorDay] = useState<number | ''>('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();

  const chosen = contract.obligations.filter((o) => ruleIds.includes(o.id));
  // Conta nova: só com obrigações em conta da mesma caixa (a conta tem de ser da caixa da série).
  const caixasChosen = [...new Set(chosen.map((o) => (o.kind === 'account' ? o.caixaId : '')))];
  const accountCaixa = caixasChosen.length === 1 && caixasChosen[0] ? caixasChosen[0] : null;
  const accountOptions = accountCaixa ? options.accounts.filter((a) => a.caixaId === accountCaixa) : [];
  useEffect(() => {
    if (!accountCaixa) setAccountId(null);
  }, [accountCaixa]);

  const pct = pctOf(percent);
  const body: ContractAmendmentInput = {
    effectiveOn,
    ruleIds,
    amountCents: mode === 'value' ? value : null,
    readjustmentPercent: mode === 'percent' ? pct : null,
    anchorDay: anchorDay === '' ? null : anchorDay,
    categoryId,
    accountId,
    documentId: documentId || null,
    notes,
  };
  const ready =
    Boolean(effectiveOn) &&
    ruleIds.length > 0 &&
    ((mode === 'value' && Boolean(value)) ||
      (mode === 'percent' && Boolean(pct)) ||
      anchorDay !== '' ||
      Boolean(categoryId) ||
      Boolean(accountId));
  const { preview, error } = usePreview<AmendmentPreview>(`/api/contracts/${contract.id}/amendments`, body, ready);
  const nameOf = (ruleId: string) => contract.obligations.find((o) => o.id === ruleId)?.description ?? '—';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(
      () => api.post<ContractActionResult<AmendmentPreview>>(`/api/contracts/${contract.id}/amendments`, body),
      (r) => A.applied(r.preview.affected.length + r.preview.cardFrom.length),
    );
    if (result?.contract) onSaved(result.contract);
  }

  const amendmentDocs = contract.documents.filter((d) => d.kind === 'amendment' && !d.archivedAt);
  const changes = preview ? preview.affected.length + preview.cardFrom.length : 0;
  return (
    <Modal open title={A.title} onClose={onClose} wide>
      <form onSubmit={submit} data-testid="amendment-form">
        <div className="modal-body">
          <p className="hint mb-3">{A.sub}</p>
          <div className="form-grid cols-2">
            <Field label={A.effectiveOn}>
              <input
                className="field"
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
                aria-label={A.effectiveOn}
              />
            </Field>
            <Field label={A.document}>
              <select className="field" value={documentId} onChange={(e) => setDocumentId(e.target.value)} aria-label={A.document}>
                <option value="">{A.documentNone}</option>
                {amendmentDocs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset className="span-all" aria-label={A.obligations}>
              <span className="label">{A.obligations}</span>
              <div className="grid gap-1">
                {contract.obligations.map((o) => (
                  <label key={o.id} className="check" data-testid="amendment-obligation">
                    <input
                      type="checkbox"
                      checked={ruleIds.includes(o.id)}
                      onChange={(e) => setRuleIds((ids) => (e.target.checked ? [...ids, o.id] : ids.filter((x) => x !== o.id)))}
                      aria-label={o.description}
                    />{' '}
                    {o.description}{' '}
                    <span className="text-faint text-xs">
                      · {C.obligation.kinds[o.kind]} · {calendarText(o)} · {formatAccounting(o.amountCents)}
                    </span>
                  </label>
                ))}
              </div>
              {ruleIds.length === 0 && <p className="hint">{A.chooseObligation}</p>}
            </fieldset>
            <Field label={A.valueMode}>
              <select className="field" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label={A.valueMode}>
                <option value="keep">{A.keepValue}</option>
                <option value="value">{A.newValue}</option>
                <option value="percent">{A.readjust}</option>
              </select>
            </Field>
            {mode === 'value' && (
              <Field label={A.newValue}>
                <MoneyInput value={value} onChange={setValue} ariaLabel={A.newValue} />
              </Field>
            )}
            {mode === 'percent' && (
              <Field label={A.readjust}>
                <input
                  className="field field-mono"
                  inputMode="decimal"
                  value={percent}
                  placeholder="0"
                  onChange={(e) => setPercent(e.target.value)}
                  aria-label={A.readjust}
                />
              </Field>
            )}
            {mode === 'keep' && <span />}
            <Field label={A.anchorDay}>
              <input
                className="field"
                type="number"
                min={1}
                max={31}
                placeholder={A.keep}
                value={anchorDay}
                onChange={(e) => setAnchorDay(e.target.value ? Math.min(31, Math.max(1, Number(e.target.value))) : '')}
                aria-label={A.anchorDay}
              />
            </Field>
            <Field label={A.account} hint={accountCaixa ? undefined : A.accountMixed}>
              <AccountSelect accounts={accountOptions} value={accountId} onChange={setAccountId} label={A.account} empty={A.keep} />
            </Field>
            <Field label={A.category} className="span-all">
              <CategorySelect
                kind={kindOf(contract.direction)}
                caixaId={contract.caixaId}
                value={categoryId}
                onChange={setCategoryId}
                allowEmpty={A.keep}
                ariaLabel={A.category}
              />
            </Field>
            <Field label={C.fields.notes} className="span-all">
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={C.fields.notes} />
            </Field>
          </div>
          {preview && (
            <div className="well mt-3" data-testid="amendment-preview">
              <p className="font-medium">
                {A.previewTitle}: {A.affected(preview.affected.length)}
                {preview.skipped.length > 0 && ` · ${A.skipped(preview.skipped.length)}`}
              </p>
              {changes === 0 && <p className="hint">{A.nothingAffected}</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {preview.cardFrom.map((row) => (
                  <li key={`card-${row.ruleId}`}>
                    {nameOf(row.ruleId)} · {A.cardFrom(row.fromOccurrence, formatAccounting(row.afterCents))}{' '}
                    <span className="text-faint">({formatAccounting(row.beforeCents)})</span>
                  </li>
                ))}
                {preview.affected.slice(0, 36).map((row) => (
                  <li key={`${row.ruleId}-${row.occurrence}`} className="mono">
                    {nameOf(row.ruleId)} {A.occurrence(row.occurrence)} · {formatAccounting(row.before.amountCents)} →{' '}
                    {formatAccounting(row.after.amountCents)} · {formatDate(row.before.dueDate)} → {formatDate(row.after.dueDate)}
                  </li>
                ))}
                {preview.skipped.map((row) => (
                  <li key={`skip-${row.ruleId}-${row.occurrence}`} className="mono text-faint">
                    {nameOf(row.ruleId)} {A.occurrence(row.occurrence)} · {formatDate(row.dueDate)} · {A.skipReasons[row.reason]}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !preview || changes === 0} data-testid="amendment-submit">
            {A.apply}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- rescisão ---------------- */

/**
 * Rescindir (spec 034): encerra as obrigações na data; a última ocorrência de
 * cada uma vem com o proporcional sugerido (editável) e a multa é um título
 * avulso opcional, com a conta prevista.
 */
export function TerminationModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const R = C.termination;
  const options = useObligationOptions(contract.entityId);
  const penaltyAccounts = options.accounts.filter((a) => a.caixaId === contract.caixaId);
  const [terminatedOn, setTerminatedOn] = useState(todayIso() < contract.startsOn ? contract.startsOn : todayIso());
  const [lastAmounts, setLastAmounts] = useState<Record<string, number | null>>({});
  const [withPenalty, setWithPenalty] = useState(Boolean(contract.terminationPenaltyCents));
  const [penaltyDirection, setPenaltyDirection] = useState<'receivable' | 'payable'>(contract.direction);
  const [penaltyCents, setPenaltyCents] = useState<number | null>(contract.terminationPenaltyCents);
  const [penaltyDue, setPenaltyDue] = useState(addDays(todayIso(), 10));
  const [penaltyCategory, setPenaltyCategory] = useState<string | null>(null);
  const [penaltyAccount, setPenaltyAccount] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();

  const { preview, error } = usePreview<TerminationPreview>(
    `/api/contracts/${contract.id}/terminate`,
    { terminatedOn },
    Boolean(terminatedOn),
  );

  // A última ocorrência de cada obrigação vem com o proporcional sugerido.
  const suggestionKey = JSON.stringify(preview?.last.map((l) => [l.titleId, l.proratedCents, l.settled]) ?? []);
  useEffect(() => {
    const next: Record<string, number | null> = {};
    for (const l of preview?.last ?? []) if (!l.settled) next[l.titleId] = l.proratedCents;
    setLastAmounts(next);
  }, [suggestionKey]);

  const body: ContractTerminationInput = {
    terminatedOn,
    lastAmounts: (preview?.last ?? [])
      .filter((l) => !l.settled && lastAmounts[l.titleId] && lastAmounts[l.titleId] !== l.amountCents)
      .map((l) => ({ titleId: l.titleId, amountCents: lastAmounts[l.titleId]! })),
    penalty:
      withPenalty && penaltyCents && penaltyCategory
        ? {
            direction: penaltyDirection,
            amountCents: penaltyCents,
            dueDate: penaltyDue,
            categoryId: penaltyCategory,
            description: R.penaltyDescription(contract.name),
            accountId: penaltyAccount,
          }
        : null,
    notes,
  };
  const nameOf = (ruleId: string) => contract.obligations.find((o) => o.id === ruleId)?.description ?? '—';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(
      () => api.post<ContractActionResult<TerminationPreview>>(`/api/contracts/${contract.id}/terminate`, body),
      R.done,
    );
    if (result?.contract) onSaved(result.contract);
  }

  return (
    <Modal open title={R.title} onClose={onClose} wide>
      <form onSubmit={submit} data-testid="termination-form">
        <div className="modal-body">
          <p className="hint mb-3">{R.sub}</p>
          <div className="form-grid cols-2">
            <Field label={R.terminatedOn}>
              <input
                className="field"
                type="date"
                value={terminatedOn}
                onChange={(e) => setTerminatedOn(e.target.value)}
                aria-label={R.terminatedOn}
              />
            </Field>
            <span />
            {preview && preview.last.length > 0 && (
              <fieldset className="span-all" aria-label={R.lastOccurrence}>
                <span className="label">{R.lastOccurrence}</span>
                <p className="hint !mt-0 mb-2">{R.lastHint}</p>
                <div className="form-grid cols-2">
                  {preview.last.map((l) => (
                    <Field
                      key={l.titleId}
                      label={`${nameOf(l.ruleId)} · ${formatMonth(l.competenceDate)} (${formatAccounting(l.amountCents)})`}
                      hint={l.settled ? R.lastSettled : R.prorated(formatAccounting(l.proratedCents))}
                    >
                      <MoneyInput
                        value={l.settled ? l.amountCents : (lastAmounts[l.titleId] ?? null)}
                        onChange={(v) => setLastAmounts((m) => ({ ...m, [l.titleId]: v }))}
                        ariaLabel={`${R.lastOccurrence} ${nameOf(l.ruleId)}`}
                      />
                    </Field>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="check span-all">
              <input type="checkbox" checked={withPenalty} onChange={(e) => setWithPenalty(e.target.checked)} aria-label={R.penalty} />{' '}
              {R.penalty}
              {contract.terminationPenaltyText && <span className="hint !mt-0"> · {contract.terminationPenaltyText}</span>}
            </label>
            {withPenalty && (
              <>
                <Field label={R.penaltyDirection}>
                  <select
                    className="field"
                    value={penaltyDirection}
                    onChange={(e) => {
                      setPenaltyDirection(e.target.value as 'receivable' | 'payable');
                      setPenaltyCategory(null);
                    }}
                    aria-label={R.penaltyDirection}
                  >
                    <option value="receivable">{R.penaltyDirections.receivable}</option>
                    <option value="payable">{R.penaltyDirections.payable}</option>
                  </select>
                </Field>
                <Field label={t.common.amount}>
                  <MoneyInput value={penaltyCents} onChange={setPenaltyCents} ariaLabel={t.common.amount} />
                </Field>
                <Field label={C.columns.due}>
                  <input
                    className="field"
                    type="date"
                    value={penaltyDue}
                    onChange={(e) => setPenaltyDue(e.target.value)}
                    aria-label={C.columns.due}
                  />
                </Field>
                <Field label={C.fields.category}>
                  <CategorySelect
                    kind={kindOf(penaltyDirection)}
                    caixaId={contract.caixaId}
                    value={penaltyCategory}
                    onChange={setPenaltyCategory}
                    ariaLabel={C.fields.category}
                  />
                </Field>
                <Field label={R.penaltyAccount} className="span-all">
                  <AccountSelect
                    accounts={penaltyAccounts}
                    value={penaltyAccount}
                    onChange={setPenaltyAccount}
                    label={R.penaltyAccount}
                    empty={C.payment.plannedNone}
                  />
                </Field>
              </>
            )}
            <Field label={C.fields.notes} className="span-all">
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={C.fields.notes} />
            </Field>
          </div>
          {preview && (
            <div className="well mt-3 text-sm" data-testid="termination-preview">
              <p>{R.willCancel(preview.canceled.length)}</p>
              {preview.blockedClosed.length > 0 && <p className="text-warn">{R.closedBlocked(preview.blockedClosed.length)}</p>}
              {preview.keptSettled > 0 && <p className="hint">{R.keptSettled(preview.keptSettled)}</p>}
              {preview.cardRules > 0 && <p className="hint">{R.cardRules(preview.cardRules)}</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {preview.canceled.slice(0, 36).map((row) => (
                  <li key={row.titleId} className="mono">
                    {nameOf(row.ruleId)} · {formatMonth(row.competenceDate)} · {formatAccounting(row.amountCents)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={busy || !preview || (withPenalty && !body.penalty)}
            data-testid="termination-submit"
          >
            {R.apply}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- renovação ---------------- */

/** Renovar (spec 034): nova data de fim (ou sem fim); as obrigações vão junto. */
export function RenewalModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const R = C.renewal;
  // Sugestão: o mesmo prazo da vigência atual, emendado no fim dela.
  const suggested = contract.endsOn
    ? cycleEnd(addDays(contract.endsOn, 1), termMonths(contract.cycles[0]?.startsOn ?? contract.startsOn, contract.endsOn))
    : '';
  const [endsOn, setEndsOn] = useState(suggested);
  const [indeterminate, setIndeterminate] = useState(false);
  const { run, busy } = useAction();
  const body: ContractRenewalInput = { endsOn: indeterminate ? null : endsOn || null };
  const ready = indeterminate || Boolean(endsOn);
  const { preview, error } = usePreview<RenewalPreview>(`/api/contracts/${contract.id}/renew`, body, ready && Boolean(contract.endsOn));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<ContractActionResult<RenewalPreview>>(`/api/contracts/${contract.id}/renew`, body), R.done);
    if (result?.contract) onSaved(result.contract);
  }

  return (
    <Modal open title={R.title} onClose={onClose}>
      <form onSubmit={submit} data-testid="renewal-form">
        <div className="modal-body">
          <p className="hint mb-3">{R.sub}</p>
          <p className="mb-3 text-sm">
            {R.currentTerm(C.termRange(formatDate(contract.startsOn), contract.endsOn ? formatDate(contract.endsOn) : null))}
          </p>
          {!contract.endsOn && <p className="notice info mb-3">{R.indeterminateBlocked}</p>}
          <div className="form-grid">
            <Field label={R.endsOn}>
              <input
                className="field"
                type="date"
                value={indeterminate ? '' : endsOn}
                disabled={indeterminate}
                min={contract.endsOn ? addDays(contract.endsOn, 1) : undefined}
                onChange={(e) => setEndsOn(e.target.value)}
                aria-label={R.endsOn}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={indeterminate}
                onChange={(e) => setIndeterminate(e.target.checked)}
                aria-label={R.indeterminate}
              />{' '}
              {R.indeterminate}
            </label>
          </div>
          {preview && (
            <div className="well mt-3 text-sm" data-testid="renewal-preview">
              <p className="font-medium">{C.termRange(formatDate(preview.startsOn), preview.endsOn ? formatDate(preview.endsOn) : null)}</p>
              <p className="hint">{R.rules(preview.rules.length)}</p>
              <ul className="mt-2 space-y-1 text-xs">
                {preview.rules.map((r) => (
                  <li key={r.ruleId}>
                    {r.description} <Badge tone="outline">{C.obligation.kinds[r.kind]}</Badge> ·{' '}
                    {r.endsOn ? formatDate(r.endsOn) : t.title.endSeriesNoEnd}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !preview} data-testid="renewal-submit">
            {R.approve}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
