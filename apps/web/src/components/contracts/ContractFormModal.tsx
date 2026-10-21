import {
  addMonths,
  type CaixaSummary,
  type ContractCreateInput,
  type ContractDetail,
  type ContractReadingDto,
  type ContractUpdateInput,
  cycleEnd,
  dayOfMonth,
  daysInMonth,
  type EntityDetail,
  periodicityCalendar,
  READJUSTMENT_INDEXES,
  type ReadjustmentIndex,
  t,
  todayIso,
  toIso,
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
import { newObligationDraft, type ObligationDraft, ObligationsEditor, obligationInputOf, obligationProblem } from './ObligationFormModal';

type Direction = 'receivable' | 'payable';
const kindOf = (direction: Direction) => (direction === 'payable' ? 'expense' : 'income');
const F = t.contracts.fields;

/** Primeiro vencimento pelo dia lido do PDF: no mês do início, ou no seguinte se o dia já passou. */
function firstDueFrom(startsOn: string, dueDay: number): string {
  const year = Number(startsOn.slice(0, 4));
  const month = Number(startsOn.slice(5, 7));
  const inMonth = toIso(year, month, Math.min(dueDay, daysInMonth(year, month)));
  if (dueDay >= dayOfMonth(startsOn)) return inMonth;
  const next = addMonths(toIso(year, month, 1), 1);
  const ny = Number(next.slice(0, 4));
  const nm = Number(next.slice(5, 7));
  return toIso(ny, nm, Math.min(dueDay, daysInMonth(ny, nm)));
}

/**
 * Cadastro e edição do contrato (spec 034): o documento e o vínculo — caixa,
 * contraparte, direção, categoria padrão, vigência (fim opcional) e a
 * configuração de avisos e reajuste — e, no cadastro, as obrigações (séries
 * numa conta ou cobranças no cartão). Editar muda só os dados do contrato; a
 * vigência muda no rascunho (vigente: por renovar ou rescindir). "Ler PDF com
 * IA" pré-preenche o formulário com uma obrigação sugerida.
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
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const writable = (caixas.data ?? []).filter((c) => c.kind === 'general' && !c.archivedAt && canWriteCaixa(user, c.id));

  const [caixaId, setCaixaId] = useState<string>(contract?.caixaId ?? defaultCaixaId ?? '');
  const [direction, setDirection] = useState<Direction>(contract?.direction ?? 'receivable');
  const [entity, setEntity] = useState<EntityOption | null>(contract ? { id: contract.entityId, name: contract.entityName } : null);
  const [categoryId, setCategoryId] = useState<string | null>(contract?.categoryId ?? null);
  const [name, setName] = useState(contract?.name ?? '');
  const [contractNumber, setContractNumber] = useState(contract?.contractNumber ?? '');
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [startsOn, setStartsOn] = useState(contract?.startsOn ?? todayIso().slice(0, 8).concat('01'));
  const [endsOn, setEndsOn] = useState(contract ? (contract.endsOn ?? '') : '');
  const [indeterminate, setIndeterminate] = useState(contract ? contract.endsOn === null : false);
  const [autoRenew, setAutoRenew] = useState(contract?.autoRenew ?? false);
  const [noticeDays, setNoticeDays] = useState(contract?.noticeDays ?? 30);
  const [readjustmentIndex, setReadjustmentIndex] = useState<ReadjustmentIndex>(contract?.readjustmentIndex ?? 'none');
  const [readjustmentBaseDate, setReadjustmentBaseDate] = useState(contract?.readjustmentBaseDate ?? '');
  const [penaltyText, setPenaltyText] = useState(contract?.terminationPenaltyText ?? '');
  const [penaltyCents, setPenaltyCents] = useState<number | null>(contract?.terminationPenaltyCents ?? null);
  const [obligations, setObligations] = useState<ObligationDraft[]>(() => (editing ? [] : [newObligationDraft()]));

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

  async function readPdf(file: File) {
    setReading('busy');
    setError(null);
    try {
      const data = await upload<ContractReadingDto>('/api/contracts/document', file, { caixaId: caixaId || undefined });
      if (data.entityId && data.entityName) setEntity({ id: data.entityId, name: data.entityName, document: data.document });
      if (data.direction) setDirection(data.direction);
      if (data.name) setName(data.name);
      if (data.contractNumber) setContractNumber(data.contractNumber);
      const start = data.startsOn ?? startsOn;
      if (data.startsOn) setStartsOn(data.startsOn);
      if (data.durationMonths) {
        setEndsOn(cycleEnd(start, data.durationMonths));
        setIndeterminate(false);
      }
      if (data.autoRenew !== null) setAutoRenew(data.autoRenew);
      if (data.noticeDays !== null) setNoticeDays(data.noticeDays);
      if (data.readjustmentIndex) setReadjustmentIndex(data.readjustmentIndex);
      if (data.readjustmentBaseDate) setReadjustmentBaseDate(data.readjustmentBaseDate);
      if (data.terminationPenaltyText) setPenaltyText(data.terminationPenaltyText);
      // Uma obrigação sugerida (parcela única não vira série).
      const calendar = data.periodicity ? periodicityCalendar(data.periodicity) : { frequency: 'monthly' as const, intervalCount: 1 };
      if (calendar) {
        const perYear = calendar.frequency === 'yearly' ? 1 / calendar.intervalCount : 12 / calendar.intervalCount;
        const count = data.durationMonths ? Math.max(1, Math.round((data.durationMonths * perYear) / 12)) : null;
        const amount = data.installmentCents ?? (data.totalCents && count ? Math.round(data.totalCents / count) : null);
        setObligations([
          newObligationDraft({
            description: data.name ?? name,
            amountCents: amount,
            frequency: calendar.frequency,
            intervalCount: calendar.intervalCount,
            firstDueDate: data.dueDay ? firstDueFrom(start, data.dueDay) : start,
            kind: 'account',
          }),
        ]);
      } else setObligations([]);
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

  async function submit(event: FormEvent, activate: boolean) {
    event.preventDefault();
    if (!entity) return setError(t.contracts.chooseEntity);
    if (!categoryId) return setError(t.contracts.chooseCategory);
    if (!caixaId) return setError(t.contracts.chooseCaixa);
    const end = indeterminate ? null : endsOn || null;
    if (draft && end && end < startsOn) return setError(t.contracts.errors.endsBeforeStart);
    if (!editing && activate) {
      for (const o of obligations) {
        const problem = obligationProblem(o, direction);
        if (problem) return setError(problem);
      }
    }
    setError(null);
    const settings = {
      name,
      contractNumber,
      notes,
      autoRenew,
      noticeDays,
      readjustmentIndex,
      readjustmentBaseDate: readjustmentBaseDate || null,
      terminationPenaltyText: penaltyText,
      terminationPenaltyCents: penaltyCents,
    };
    const mirror = held && held.length > 0 ? mirrorCaixaId : null;
    if (contract) {
      const body: ContractUpdateInput = draft
        ? { ...settings, entityId: entity.id, categoryId, mirrorCaixaId: mirror, startsOn, endsOn: end }
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
      startsOn,
      endsOn: end,
      mirrorCaixaId: mirror,
      obligations: activate ? obligations.map(obligationInputOf) : [],
      activate,
    };
    const saved = await run(() => api.post<ContractDetail>('/api/contracts', body), activate ? t.contracts.activated : t.contracts.created);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={editing ? t.contracts.editContract : t.contracts.newContract} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e, !editing)} data-testid="contract-form">
        <div className="modal-body">
          {!editing && (
            <div className="well mb-4 flex items-center justify-between gap-3">
              <span className="hint !mt-0">{reading === 'done' ? t.contracts.readingDone : t.contracts.fromPdfHint}</span>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                data-testid="contract-pdf-input"
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
                          // Cobrança no cartão só em contrato que eu pago; categorias mudam de tipo.
                          setObligations((items) =>
                            items.map((o) => ({ ...o, categoryId: null, kind: d === 'payable' ? o.kind : 'account' })),
                          );
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

            <fieldset className="span-all form-grid cols-2" disabled={!draft} aria-label={F.term}>
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
              <Field label={F.endsOn} hint={F.endsOnHint}>
                <input
                  className="field"
                  type="date"
                  value={indeterminate ? '' : endsOn}
                  disabled={indeterminate}
                  min={startsOn}
                  onChange={(e) => setEndsOn(e.target.value)}
                  aria-label={F.endsOn}
                />
              </Field>
              <label className="check span-all">
                <input
                  type="checkbox"
                  checked={indeterminate}
                  onChange={(e) => setIndeterminate(e.target.checked)}
                  aria-label={F.indeterminate}
                />{' '}
                {F.indeterminate}
              </label>
            </fieldset>

            <label className="check span-all">
              <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} aria-label={F.autoRenew} />{' '}
              {F.autoRenew}
              <span className="hint !mt-0 block">{F.autoRenewHint}</span>
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

            {!editing && caixaId && (
              <ObligationsEditor
                items={obligations}
                onChange={setObligations}
                direction={direction}
                caixaId={caixaId}
                counterpartyId={entity?.id ?? null}
              />
            )}
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
              {obligations.length === 0 && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={(e) => void submit(e as unknown as FormEvent, false)}
                  data-testid="contract-save-draft"
                >
                  {t.contracts.actions.saveDraft}
                </Button>
              )}
              <Button type="submit" disabled={busy} data-testid="contract-create">
                {busy ? t.common.saving : t.contracts.actions.create}
              </Button>
            </>
          )}
        </ModalActions>
      </form>
    </Modal>
  );
}
