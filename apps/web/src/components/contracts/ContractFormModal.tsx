import {
  type CaixaSummary,
  CONTRACT_PERIODICITIES,
  type ContractCreateInput,
  type ContractDetail,
  type ContractPeriodicity,
  type ContractReadingDto,
  type ContractUpdateInput,
  cycleEnd,
  type EntityDetail,
  formatBRL,
  formatDate,
  installmentsCount,
  READJUSTMENT_INDEXES,
  type ReadjustmentIndex,
  splitTotal,
  t,
  todayIso,
} from '@moneyflow/shared';
import { FileUp, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { canWriteCaixa } from '../../lib/access';
import { ApiError, api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { upload } from '../../lib/upload';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal } from '../ui';

type Direction = 'receivable' | 'payable';
const kindOf = (direction: Direction) => (direction === 'payable' ? 'expense' : 'income');
const F = t.contracts.fields;

/**
 * Cadastro e edição do contrato (spec 020). Rascunho: tudo editável. Vigente:
 * só nome, número, anotações e a configuração de renovação, avisos e reajuste
 * (valor, vencimento e categoria mudam por aditivo; prazo e periodicidade, na
 * renovação). "Ler PDF com IA" pré-preenche o formulário para revisão.
 */
export function ContractFormModal({
  contract,
  defaultCaixaId,
  onClose,
  onSaved,
}: {
  contract?: ContractDetail | null;
  defaultCaixaId?: string | null;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const user = useUser();
  const editing = Boolean(contract);
  const draft = !contract || contract.status === 'draft';
  const cycle = contract?.cycles.find((c) => c.seq === 1) ?? null;
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const writable = (caixas.data ?? []).filter((c) => c.kind === 'general' && !c.archivedAt && canWriteCaixa(user, c.id));

  const [caixaId, setCaixaId] = useState<string>(contract?.caixaId ?? defaultCaixaId ?? '');
  const [direction, setDirection] = useState<Direction>(contract?.direction ?? 'receivable');
  const [entity, setEntity] = useState<EntityOption | null>(contract ? { id: contract.entityId, name: contract.entityName } : null);
  const [categoryId, setCategoryId] = useState<string | null>(contract?.categoryId ?? null);
  const [name, setName] = useState(contract?.name ?? '');
  const [contractNumber, setContractNumber] = useState(contract?.contractNumber ?? '');
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [startsOn, setStartsOn] = useState(cycle?.startsOn ?? todayIso().slice(0, 8).concat('01'));
  const [durationMonths, setDurationMonths] = useState(cycle?.durationMonths ?? 12);
  const [periodicity, setPeriodicity] = useState<ContractPeriodicity>(cycle?.periodicity ?? 'monthly');
  const [valueMode, setValueMode] = useState<'total' | 'installment'>('total');
  const [amount, setAmount] = useState<number | null>(cycle?.totalCents ?? null);
  const [dueDay, setDueDay] = useState(cycle?.dueDay ?? 10);
  const [dueMonthOffset, setDueMonthOffset] = useState(cycle?.dueMonthOffset ?? 0);
  const [autoRenew, setAutoRenew] = useState(contract?.autoRenew ?? false);
  const [noticeDays, setNoticeDays] = useState(contract?.noticeDays ?? 30);
  const [renewalLeadDays, setRenewalLeadDays] = useState(contract?.renewalLeadDays ?? 60);
  const [reminderEveryDays, setReminderEveryDays] = useState(contract?.reminderEveryDays ?? 7);
  const [readjustmentIndex, setReadjustmentIndex] = useState<ReadjustmentIndex>(contract?.readjustmentIndex ?? 'none');
  const [readjustmentBaseDate, setReadjustmentBaseDate] = useState(contract?.readjustmentBaseDate ?? '');
  const [penaltyText, setPenaltyText] = useState(contract?.terminationPenaltyText ?? '');
  const [penaltyCents, setPenaltyCents] = useState<number | null>(contract?.terminationPenaltyCents ?? null);

  const [held, setHeld] = useState<EntityDetail['caixas'] | null>(null);
  const [mirrorCaixaId, setMirrorCaixaId] = useState<string | null>(contract?.counterpartyCaixaId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<'idle' | 'busy' | 'done'>('idle');
  const fileInput = useRef<HTMLInputElement>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    if (!caixaId && writable[0]) setCaixaId(writable[0].id);
  }, [caixaId, writable]);

  // Caixas de que a contraparte é titular (espelho, spec 006).
  const entityId = entity?.id;
  const touchedMirror = useRef(editing);
  useEffect(() => {
    if (!entityId || !draft) {
      setHeld(null);
      return;
    }
    let cancelled = false;
    api
      .get<EntityDetail>(`/api/entities/${entityId}`)
      .then((detail) => {
        if (cancelled) return;
        const options = detail.caixas.filter((c) => !c.archivedAt && c.id !== caixaId);
        setHeld(options);
        if (!touchedMirror.current) setMirrorCaixaId(options.find((c) => c.isPrimary)?.id ?? null);
      })
      .catch(() => setHeld([]));
    return () => {
      cancelled = true;
    };
  }, [entityId, caixaId, draft]);

  const count = installmentsCount(durationMonths, periodicity);
  const totalCents = amount && count ? (valueMode === 'total' ? amount : amount * count) : null;
  const split = totalCents && count ? splitTotal(totalCents, count) : null;

  async function readPdf(file: File) {
    setReading('busy');
    setError(null);
    try {
      const data = await upload<ContractReadingDto>('/api/contracts/document', file, { caixaId: caixaId || undefined });
      if (data.entityId && data.entityName) setEntity({ id: data.entityId, name: data.entityName, document: data.document });
      if (data.direction) setDirection(data.direction);
      if (data.name) setName(data.name);
      if (data.contractNumber) setContractNumber(data.contractNumber);
      if (data.startsOn) setStartsOn(data.startsOn);
      if (data.durationMonths) setDurationMonths(data.durationMonths);
      if (data.periodicity) setPeriodicity(data.periodicity);
      if (data.totalCents) {
        setValueMode('total');
        setAmount(data.totalCents);
      } else if (data.installmentCents) {
        setValueMode('installment');
        setAmount(data.installmentCents);
      }
      if (data.dueDay) setDueDay(data.dueDay);
      if (data.autoRenew !== null) setAutoRenew(data.autoRenew);
      if (data.noticeDays !== null) setNoticeDays(data.noticeDays);
      if (data.readjustmentIndex) setReadjustmentIndex(data.readjustmentIndex);
      if (data.readjustmentBaseDate) setReadjustmentBaseDate(data.readjustmentBaseDate);
      if (data.terminationPenaltyText) setPenaltyText(data.terminationPenaltyText);
      if (!data.entityId && data.entityName)
        setError(t.contracts.readingEntityMissing(`${data.entityName}${data.document ? ` (${data.document})` : ''}`));
      setReading('done');
    } catch (err) {
      setReading('idle');
      setError(
        err instanceof ApiError && err.status === 501 ? t.contracts.readingUnavailable : err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function submit(event: FormEvent, activate = false) {
    event.preventDefault();
    if (!entity) return setError(t.contracts.chooseEntity);
    if (!categoryId) return setError(t.contracts.chooseCategory);
    if (!caixaId) return setError(t.contracts.chooseCaixa);
    if (draft && (!totalCents || !count)) return setError(count ? t.errors.invalidAmount : t.contracts.durationNotMultiple);
    setError(null);
    const settings = {
      name,
      contractNumber,
      notes,
      autoRenew,
      noticeDays,
      renewalLeadDays,
      reminderEveryDays,
      readjustmentIndex,
      readjustmentBaseDate: readjustmentBaseDate || null,
      terminationPenaltyText: penaltyText,
      terminationPenaltyCents: penaltyCents,
    };
    const terms = { startsOn, durationMonths, periodicity, totalCents: totalCents!, dueDay, dueMonthOffset };
    if (contract) {
      const body: ContractUpdateInput = draft
        ? { ...settings, ...terms, entityId: entity.id, categoryId, mirrorCaixaId: held && held.length > 0 ? mirrorCaixaId : null }
        : settings;
      const saved = await run(() => api.patch<ContractDetail>(`/api/contracts/${contract.id}`, body), t.contracts.saved);
      if (saved) onSaved(saved);
      return;
    }
    const body: ContractCreateInput = {
      caixaId,
      direction,
      entityId: entity.id,
      categoryId,
      ...settings,
      ...terms,
      mirrorCaixaId: held && held.length > 0 ? mirrorCaixaId : null,
      activate,
    };
    const saved = await run(
      () => api.post<ContractDetail>('/api/contracts', body),
      (c) => (activate ? t.contracts.activated(c.cycles[0]?.installments.length ?? 0) : t.contracts.created),
    );
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={editing ? t.contracts.editContract : t.contracts.newContract} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-body">
          {!editing && (
            <div className="well mb-4 flex items-center justify-between gap-3">
              <span className="hint !mt-0">{reading === 'done' ? t.contracts.readingDone : t.contracts.fromPdfHint}</span>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void readPdf(file);
                }}
              />
              <Button size="sm" variant="ghost" disabled={reading === 'busy'} onClick={() => fileInput.current?.click()}>
                {reading === 'busy' ? <FileUp /> : <Sparkles />} {reading === 'busy' ? t.contracts.readingPdf : t.contracts.fromPdf}
              </Button>
            </div>
          )}
          {!draft && <p className="notice info mb-3">{t.contracts.lockedActive}</p>}
          <div className="form-grid cols-2">
            {!editing && (
              <>
                <Field label={F.caixa}>
                  <select className="field" value={caixaId} onChange={(e) => setCaixaId(e.target.value)} aria-label={F.caixa}>
                    {writable.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={F.direction}>
                  <div className="segmented" role="group" aria-label={F.direction}>
                    {(['receivable', 'payable'] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        className={direction === d ? 'active' : ''}
                        onClick={() => {
                          setDirection(d);
                          setCategoryId(null);
                        }}
                      >
                        {t.contracts.directions[d]}
                      </button>
                    ))}
                  </div>
                </Field>
              </>
            )}
            <Field label={F.entity} className="span-all">
              {draft ? (
                <EntityPicker value={entity} onChange={setEntity} ariaLabel={F.entity} />
              ) : (
                <input className="field" value={entity?.name ?? ''} readOnly aria-label={F.entity} />
              )}
            </Field>
            {draft && held && held.length > 0 && (
              <Field label={F.mirrorCaixa} className="span-all">
                <select
                  className="field"
                  value={mirrorCaixaId ?? ''}
                  onChange={(e) => {
                    touchedMirror.current = true;
                    setMirrorCaixaId(e.target.value || null);
                  }}
                  aria-label={F.mirrorCaixa}
                >
                  <option value="">{F.mirrorNone}</option>
                  {held.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={F.name} className="span-all">
              <input
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
                aria-label={F.name}
              />
            </Field>
            <Field label={F.contractNumber}>
              <input
                className="field"
                value={contractNumber}
                onChange={(e) => setContractNumber(e.target.value)}
                maxLength={60}
                aria-label={F.contractNumber}
              />
            </Field>
            <Field label={F.category} hint={F.categoryHint}>
              {draft ? (
                <CategorySelect
                  kind={kindOf(direction)}
                  caixaId={caixaId}
                  value={categoryId}
                  onChange={setCategoryId}
                  ariaLabel={F.category}
                />
              ) : (
                <input className="field" value={contract?.categoryName ?? ''} readOnly aria-label={F.category} />
              )}
            </Field>

            <fieldset className="span-all form-grid cols-2" disabled={!draft}>
              <Field label={F.startsOn}>
                <input
                  className="field"
                  type="date"
                  value={startsOn}
                  onChange={(e) => setStartsOn(e.target.value)}
                  required
                  aria-label={F.startsOn}
                />
              </Field>
              <Field
                label={F.durationMonths}
                hint={count && startsOn ? `${F.endsOn}: ${formatDate(cycleEnd(startsOn, durationMonths))}` : undefined}
              >
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={120}
                  value={durationMonths}
                  onChange={(e) => setDurationMonths(Number(e.target.value))}
                  aria-label={F.durationMonths}
                />
              </Field>
              <Field label={F.periodicity}>
                <select
                  className="field"
                  value={periodicity}
                  onChange={(e) => setPeriodicity(e.target.value as ContractPeriodicity)}
                  aria-label={F.periodicity}
                >
                  {CONTRACT_PERIODICITIES.map((p) => (
                    <option key={p} value={p}>
                      {t.contracts.periodicities[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={valueMode === 'total' ? F.totalCents : F.installmentCents}
                hint={
                  !count
                    ? t.contracts.durationNotMultiple
                    : split
                      ? `${t.contracts.installmentsSummary(count, t.contracts.periodicities[periodicity]!)} · ${t.contracts.splitPreview(formatBRL(split[0]!), formatBRL(split[1] ?? split[0]!), count)}`
                      : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <MoneyInput value={amount} onChange={setAmount} ariaLabel={F.totalCents} />
                  <select
                    className="field field-auto"
                    value={valueMode}
                    onChange={(e) => setValueMode(e.target.value as 'total' | 'installment')}
                    aria-label={t.contracts.valueModeLabel}
                  >
                    <option value="total">{t.contracts.valueModes.total}</option>
                    <option value="installment">{t.contracts.valueModes.installment}</option>
                  </select>
                </div>
              </Field>
              <Field label={F.dueDay}>
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={31}
                  value={dueDay}
                  onChange={(e) => setDueDay(Number(e.target.value))}
                  aria-label={F.dueDay}
                />
              </Field>
              <Field label={F.dueMonthOffset}>
                <select
                  className="field"
                  value={dueMonthOffset}
                  onChange={(e) => setDueMonthOffset(Number(e.target.value))}
                  aria-label={F.dueMonthOffset}
                >
                  {t.contracts.offsets.map((label, i) => (
                    <option key={label} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </fieldset>

            <label className="check span-all">
              <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} /> {F.autoRenew}
            </label>
            <Field label={F.noticeDays} hint={F.noticeDaysHint}>
              <input
                className="field"
                type="number"
                min={0}
                max={365}
                value={noticeDays}
                onChange={(e) => setNoticeDays(Number(e.target.value))}
                aria-label={F.noticeDays}
              />
            </Field>
            <Field label={F.renewalLeadDays}>
              <input
                className="field"
                type="number"
                min={1}
                max={365}
                value={renewalLeadDays}
                onChange={(e) => setRenewalLeadDays(Number(e.target.value))}
                aria-label={F.renewalLeadDays}
              />
            </Field>
            <Field label={F.reminderEveryDays}>
              <input
                className="field"
                type="number"
                min={1}
                max={30}
                value={reminderEveryDays}
                onChange={(e) => setReminderEveryDays(Number(e.target.value))}
                aria-label={F.reminderEveryDays}
              />
            </Field>
            <Field label={F.readjustmentIndex}>
              <select
                className="field"
                value={readjustmentIndex}
                onChange={(e) => setReadjustmentIndex(e.target.value as ReadjustmentIndex)}
                aria-label={F.readjustmentIndex}
              >
                {READJUSTMENT_INDEXES.map((i) => (
                  <option key={i} value={i}>
                    {t.contracts.indexes[i]}
                  </option>
                ))}
              </select>
            </Field>
            {readjustmentIndex !== 'none' && (
              <Field label={F.readjustmentBaseDate} hint={F.readjustmentBaseDateHint} className="span-all">
                <input
                  className="field"
                  type="date"
                  value={readjustmentBaseDate}
                  onChange={(e) => setReadjustmentBaseDate(e.target.value)}
                  aria-label={F.readjustmentBaseDate}
                />
              </Field>
            )}
            <Field label={F.terminationPenaltyText}>
              <input
                className="field"
                value={penaltyText}
                onChange={(e) => setPenaltyText(e.target.value)}
                maxLength={2000}
                aria-label={F.terminationPenaltyText}
              />
            </Field>
            <Field label={F.terminationPenaltyCents}>
              <MoneyInput value={penaltyCents} onChange={setPenaltyCents} ariaLabel={F.terminationPenaltyCents} />
            </Field>
            <Field label={F.notes} className="span-all">
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={F.notes} />
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          {editing ? (
            <Button type="submit" disabled={busy}>
              {busy ? t.common.saving : t.contracts.actions.save}
            </Button>
          ) : (
            <>
              <Button type="submit" variant="ghost" disabled={busy}>
                {t.contracts.actions.saveDraft}
              </Button>
              <Button disabled={busy} onClick={(e) => void submit(e as unknown as FormEvent, true)}>
                {busy ? t.common.saving : t.contracts.actions.saveAndActivate}
              </Button>
            </>
          )}
        </ModalActions>
      </form>
    </Modal>
  );
}
