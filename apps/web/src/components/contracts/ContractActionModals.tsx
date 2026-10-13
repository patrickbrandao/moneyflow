import {
  type AmendmentPreview,
  addDays,
  CONTRACT_PERIODICITIES,
  type ContractActionResult,
  type ContractAmendmentInput,
  type ContractDetail,
  type ContractPeriodicity,
  type ContractRenewalInput,
  type ContractTerminationInput,
  formatBRL,
  formatDate,
  formatMonth,
  installmentsCount,
  type RenewalPreview,
  readjustedTotal,
  splitTotal,
  type TerminationPreview,
  t,
  todayIso,
} from '@moneyflow/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { Money } from '../domain';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { Badge, Button, Field, Modal } from '../ui';

const kindOf = (direction: 'receivable' | 'payable') => (direction === 'payable' ? 'expense' : 'income');

/** Pede a prévia (dryRun) sempre que o corpo muda; erros de validação viram mensagem. */
function usePreview<P>(path: string, body: unknown, enabled: boolean) {
  const [preview, setPreview] = useState<P | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!enabled) {
      setPreview(null);
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

/* ---------------- aditivo ---------------- */

export function AmendmentModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const A = t.contracts.amendment;
  const cycle = contract.currentCycle;
  const [effectiveOn, setEffectiveOn] = useState(todayIso() < (cycle?.startsOn ?? '') ? cycle!.startsOn : todayIso());
  const [mode, setMode] = useState<'keep' | 'installment' | 'remaining'>('installment');
  const [value, setValue] = useState<number | null>(null);
  const [dueDay, setDueDay] = useState<number | ''>('');
  const [dueMonthOffset, setDueMonthOffset] = useState<number | ''>('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();

  const body: ContractAmendmentInput = {
    effectiveOn,
    installmentCents: mode === 'installment' ? value : null,
    remainingTotalCents: mode === 'remaining' ? value : null,
    dueDay: dueDay === '' ? null : dueDay,
    dueMonthOffset: dueMonthOffset === '' ? null : dueMonthOffset,
    categoryId,
    documentId: documentId || null,
    notes,
  };
  const ready =
    Boolean(effectiveOn) && (mode === 'keep' || Boolean(value) || dueDay !== '' || dueMonthOffset !== '' || Boolean(categoryId));
  const { preview, error } = usePreview<AmendmentPreview>(`/api/contracts/${contract.id}/amendments`, body, ready);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(
      () => api.post<ContractActionResult<AmendmentPreview>>(`/api/contracts/${contract.id}/amendments`, body),
      (r) => A.applied(r.preview.affected.length),
    );
    if (result?.contract) onSaved(result.contract);
  }

  const amendmentDocs = contract.documents.filter((d) => d.kind === 'amendment');
  return (
    <Modal open title={A.title} onClose={onClose} wide>
      <form onSubmit={submit}>
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
            <Field label={A.valueMode}>
              <select className="field" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label={A.valueMode}>
                <option value="keep">{A.keepValue}</option>
                <option value="installment">{A.perInstallment}</option>
                <option value="remaining">{A.remainingTotal}</option>
              </select>
            </Field>
            {mode !== 'keep' && (
              <Field label={mode === 'installment' ? A.perInstallment : A.remainingTotal}>
                <MoneyInput value={value} onChange={setValue} ariaLabel={mode === 'installment' ? A.perInstallment : A.remainingTotal} />
              </Field>
            )}
            <Field label={t.contracts.fields.dueDay}>
              <input
                className="field"
                type="number"
                min={1}
                max={31}
                placeholder={String(cycle?.dueDay ?? '')}
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value ? Number(e.target.value) : '')}
                aria-label={t.contracts.fields.dueDay}
              />
            </Field>
            <Field label={t.contracts.fields.dueMonthOffset}>
              <select
                className="field"
                value={dueMonthOffset}
                onChange={(e) => setDueMonthOffset(e.target.value === '' ? '' : Number(e.target.value))}
                aria-label={t.contracts.fields.dueMonthOffset}
              >
                <option value="">{`— ${t.contracts.offsets[cycle?.dueMonthOffset ?? 0]}`}</option>
                {t.contracts.offsets.map((label, i) => (
                  <option key={label} value={i}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.contracts.fields.category}>
              <CategorySelect
                kind={kindOf(contract.direction)}
                caixaId={contract.caixaId}
                value={categoryId}
                onChange={setCategoryId}
                allowEmpty={`— ${contract.categoryName}`}
                ariaLabel={t.contracts.fields.category}
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
            <Field label={t.contracts.fields.notes} className="span-all">
              <textarea
                className="field"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-label={t.contracts.fields.notes}
              />
            </Field>
          </div>
          {preview && (
            <div className="well mt-3">
              <p className="font-medium">
                {A.previewTitle}: {A.affected(preview.affected.length)}
                {preview.skipped.length > 0 && ` · ${A.skipped(preview.skipped.length)}`}
              </p>
              {preview.affected.length === 0 && <p className="hint">{A.nothingAffected}</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {preview.affected.slice(0, 24).map((row) => (
                  <li key={row.titleId} className="mono">
                    {formatMonth(row.competenceDate)} · {formatBRL(row.before.amountCents)} → {formatBRL(row.after.amountCents)} ·{' '}
                    {formatDate(row.before.dueDate)} → {formatDate(row.after.dueDate)}
                  </li>
                ))}
                {preview.skipped.map((row) => (
                  <li key={row.titleId} className="mono text-faint">
                    {formatMonth(row.competenceDate)} · {A.skipReasons[row.reason]}
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
          <Button type="submit" disabled={busy || !preview || preview.affected.length === 0}>
            {A.apply}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- rescisão ---------------- */

export function TerminationModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const R = t.contracts.termination;
  const [terminatedOn, setTerminatedOn] = useState(todayIso());
  const [currentCents, setCurrentCents] = useState<number | null>(null);
  const [withPenalty, setWithPenalty] = useState(Boolean(contract.terminationPenaltyCents));
  const [penaltyDirection, setPenaltyDirection] = useState<'receivable' | 'payable'>(contract.direction);
  const [penaltyCents, setPenaltyCents] = useState<number | null>(contract.terminationPenaltyCents);
  const [penaltyDue, setPenaltyDue] = useState(addDays(todayIso(), 10));
  const [penaltyCategory, setPenaltyCategory] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();

  const body: ContractTerminationInput = {
    terminatedOn,
    currentInstallmentCents: currentCents,
    penalty:
      withPenalty && penaltyCents && penaltyCategory
        ? { direction: penaltyDirection, amountCents: penaltyCents, dueDate: penaltyDue, categoryId: penaltyCategory }
        : null,
    notes,
  };
  const { preview, error } = usePreview<TerminationPreview>(
    `/api/contracts/${contract.id}/terminate`,
    { terminatedOn },
    Boolean(terminatedOn),
  );

  // A parcela do mês da rescisão vem com o proporcional sugerido.
  const suggested = preview?.current && !preview.current.settled ? preview.current.proratedCents : null;
  useEffect(() => {
    setCurrentCents(suggested);
  }, [suggested]);

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
      <form onSubmit={submit}>
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
            {preview?.current && !preview.current.settled && (
              <Field
                label={`${R.currentInstallment} (${formatMonth(preview.current.competenceDate)})`}
                hint={R.prorated(formatBRL(preview.current.proratedCents))}
              >
                <MoneyInput value={currentCents} onChange={setCurrentCents} ariaLabel={R.currentInstallment} />
              </Field>
            )}
            <label className="check span-all">
              <input type="checkbox" checked={withPenalty} onChange={(e) => setWithPenalty(e.target.checked)} /> {R.penalty}
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
                <Field label={t.contracts.columns.due}>
                  <input
                    className="field"
                    type="date"
                    value={penaltyDue}
                    onChange={(e) => setPenaltyDue(e.target.value)}
                    aria-label={t.contracts.columns.due}
                  />
                </Field>
                <Field label={t.contracts.fields.category}>
                  <CategorySelect
                    kind={kindOf(penaltyDirection)}
                    caixaId={contract.caixaId}
                    value={penaltyCategory}
                    onChange={setPenaltyCategory}
                    ariaLabel={t.contracts.fields.category}
                  />
                </Field>
              </>
            )}
            <Field label={t.contracts.fields.notes} className="span-all">
              <textarea
                className="field"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-label={t.contracts.fields.notes}
              />
            </Field>
          </div>
          {preview && (
            <div className="well mt-3 text-sm">
              <p>{R.willCancel(preview.canceled.length)}</p>
              {preview.blockedClosed.length > 0 && <p className="text-warn">{R.closedBlocked(preview.blockedClosed.length)}</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {preview.canceled.slice(0, 24).map((row) => (
                  <li key={row.titleId} className="mono">
                    {formatMonth(row.competenceDate)} · {formatBRL(row.amountCents)}
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
          <Button type="submit" variant="danger" disabled={busy || !preview || (withPenalty && !body.penalty)}>
            {R.apply}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- renovação ---------------- */

export function RenewalModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const R = t.contracts.renewal;
  const last = contract.cycles[0] ?? null;
  const [durationMonths, setDurationMonths] = useState(last?.durationMonths ?? 12);
  const [periodicity, setPeriodicity] = useState<ContractPeriodicity>(last?.periodicity ?? 'monthly');
  const [percent, setPercent] = useState<string>('');
  const [totalCents, setTotalCents] = useState<number | null>(last?.totalCents ?? null);
  const [dueDay, setDueDay] = useState(last?.dueDay ?? 10);
  const [dueMonthOffset, setDueMonthOffset] = useState(last?.dueMonthOffset ?? 0);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();

  const pct = percent.trim() ? Number(percent.replace(',', '.')) : null;
  // Reajuste em %: calcula o novo total a partir do total do ciclo atual.
  useEffect(() => {
    if (pct !== null && Number.isFinite(pct) && last) setTotalCents(readjustedTotal(last.totalCents, pct));
  }, [pct, last]);

  const count = installmentsCount(durationMonths, periodicity);
  const body: ContractRenewalInput = {
    durationMonths,
    periodicity,
    totalCents: totalCents ?? 0,
    readjustmentPercent: pct !== null && Number.isFinite(pct) ? pct : null,
    dueDay,
    dueMonthOffset,
    categoryId,
    notes,
  };
  const { preview, error } = usePreview<RenewalPreview>(`/api/contracts/${contract.id}/renew`, body, Boolean(totalCents && count));
  const split = totalCents && count ? splitTotal(totalCents, count) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(
      () => api.post<ContractActionResult<RenewalPreview>>(`/api/contracts/${contract.id}/renew`, body),
      (r) => R.approved(r.preview.installments.length),
    );
    if (result?.contract) onSaved(result.contract);
  }

  return (
    <Modal open title={R.formTitle} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="hint mb-3">{R.formSub}</p>
          <div className="form-grid cols-2">
            <Field label={t.contracts.fields.durationMonths}>
              <input
                className="field"
                type="number"
                min={1}
                max={120}
                value={durationMonths}
                onChange={(e) => setDurationMonths(Number(e.target.value))}
                aria-label={t.contracts.fields.durationMonths}
              />
            </Field>
            <Field label={t.contracts.fields.periodicity}>
              <select
                className="field"
                value={periodicity}
                onChange={(e) => setPeriodicity(e.target.value as ContractPeriodicity)}
                aria-label={t.contracts.fields.periodicity}
              >
                {CONTRACT_PERIODICITIES.map((p) => (
                  <option key={p} value={p}>
                    {t.contracts.periodicities[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={R.readjustment} hint={R.readjustmentHint}>
              <input
                className="field field-mono"
                inputMode="decimal"
                value={percent}
                placeholder="0"
                onChange={(e) => setPercent(e.target.value)}
                aria-label={R.readjustment}
              />
            </Field>
            <Field
              label={t.contracts.fields.totalCents}
              hint={
                split && count
                  ? t.contracts.splitPreview(formatBRL(split[0]!), formatBRL(split[1] ?? split[0]!), count)
                  : t.contracts.durationNotMultiple
              }
            >
              <MoneyInput value={totalCents} onChange={setTotalCents} ariaLabel={t.contracts.fields.totalCents} />
            </Field>
            <Field label={t.contracts.fields.dueDay}>
              <input
                className="field"
                type="number"
                min={1}
                max={31}
                value={dueDay}
                onChange={(e) => setDueDay(Number(e.target.value))}
                aria-label={t.contracts.fields.dueDay}
              />
            </Field>
            <Field label={t.contracts.fields.dueMonthOffset}>
              <select
                className="field"
                value={dueMonthOffset}
                onChange={(e) => setDueMonthOffset(Number(e.target.value))}
                aria-label={t.contracts.fields.dueMonthOffset}
              >
                {t.contracts.offsets.map((label, i) => (
                  <option key={label} value={i}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.contracts.fields.category} className="span-all">
              <CategorySelect
                kind={kindOf(contract.direction)}
                caixaId={contract.caixaId}
                value={categoryId}
                onChange={setCategoryId}
                allowEmpty={`— ${contract.categoryName}`}
                ariaLabel={t.contracts.fields.category}
              />
            </Field>
            <Field label={t.contracts.fields.notes} className="span-all">
              <textarea
                className="field"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-label={t.contracts.fields.notes}
              />
            </Field>
          </div>
          {preview && (
            <div className="well mt-3 text-sm">
              <p className="font-medium">{R.newCycle(formatDate(preview.startsOn), formatDate(preview.endsOn))}</p>
              <p className="hint">
                {t.contracts.installmentsSummary(preview.installments.length, t.contracts.periodicities[periodicity]!)} ·{' '}
                <Money cents={preview.installments.reduce((acc, i) => acc + i.amountCents, 0)} />
              </p>
              {preview.closedMonths.length > 0 && (
                <p className="notice warn mt-2">{t.contracts.errors.closedMonth(formatMonth(preview.closedMonths[0]!))}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {preview.installments.slice(0, 24).map((i) => (
                  <Badge key={i.installment} tone="outline" mono>
                    {formatMonth(i.competenceDate)} · {formatDate(i.dueDate)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !preview || preview.closedMonths.length > 0}>
            {R.approve}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
