import {
  FREQUENCIES,
  formatCents,
  type SeriesInput,
  type TitleCreateInput,
  type TitleDetail,
  type TitleUpdateInput,
  t,
  todayIso,
} from '@moneyflow/shared';
import { type FormEvent, useCallback, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { type EntryPatch, EntrySources } from '../entry/EntrySources';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal } from '../ui';
import { MirrorFields, mirrorPayload, useMirrorChoice } from './MirrorFields';

type Direction = 'payable' | 'receivable';
type SeriesKind = 'none' | 'installments' | 'recurrence';
type Frequency = (typeof FREQUENCIES)[number];

const kindOf = (direction: Direction) => (direction === 'payable' ? 'expense' : 'income');

/**
 * Novo título (com espelho, parcelas e recorrência) ou edição de um existente.
 * O espelho (spec 006): se a entidade é titular de caixas, a principal dela vem
 * pré-selecionada como caixa da contraparte; dá para trocar ou dispensar.
 */
export function TitleFormModal({
  caixaId,
  direction,
  title,
  onClose,
  onSaved,
}: {
  caixaId: string;
  direction: Direction;
  title?: TitleDetail | null;
  onClose: () => void;
  onSaved: (title: TitleDetail) => void;
}) {
  const editing = Boolean(title);
  const today = todayIso();
  const [entity, setEntity] = useState<EntityOption | null>(title ? { id: title.entityId, name: title.entityName } : null);
  const [description, setDescription] = useState(title?.description ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(title?.categoryId ?? null);
  const [amount, setAmount] = useState<number | null>(title?.amountCents ?? null);
  const [dueDate, setDueDate] = useState(title?.dueDate ?? today);
  const [competenceDate, setCompetenceDate] = useState(title?.competenceDate ?? today);
  const [competenceTouched, setCompetenceTouched] = useState(editing);
  const competenceTouchedRef = useRef(competenceTouched);
  competenceTouchedRef.current = competenceTouched;
  const [notes, setNotes] = useState(title?.notes ?? '');
  const [scope, setScope] = useState<'this' | 'following'>('this');

  const [seriesKind, setSeriesKind] = useState<SeriesKind>('none');
  const [count, setCount] = useState(2);
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [intervalCount, setIntervalCount] = useState(1);
  const [endsOn, setEndsOn] = useState('');

  const mirror = useMirrorChoice(entity?.id ?? null, caixaId, !editing);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  // Entrada (spec 010): boleto, PIX e NF-e vinculados ao título.
  const [boletoBarcode, setBoletoBarcode] = useState<string | null>(title?.boletoBarcode ?? null);
  const [pixPayload, setPixPayload] = useState<string | null>(title?.pixPayload ?? null);
  const [nfeDocumentId, setNfeDocumentId] = useState<string | null>(null);
  /** Título de fatura de cartão: valor e vencimento mudam pela fatura. */
  const invoiceLocked = Boolean(title?.cardInvoiceId);
  const entityLocked = Boolean(title?.mirrorTitleId);

  const applyEntry = useCallback(
    (patch: EntryPatch) => {
      if (patch.boletoBarcode !== undefined) setBoletoBarcode(patch.boletoBarcode);
      if (patch.pixPayload !== undefined) setPixPayload(patch.pixPayload);
      if (patch.nfeDocumentId !== undefined) setNfeDocumentId(patch.nfeDocumentId);
      if (patch.entity && !entityLocked) setEntity(patch.entity);
      if (patch.amountCents) setAmount(patch.amountCents);
      if (patch.description) {
        const text = patch.description;
        setDescription((current) => (current.trim() ? current : text));
      }
      if (patch.dueDate) {
        setDueDate(patch.dueDate);
        if (!competenceTouchedRef.current) setCompetenceDate(patch.dueDate);
      }
      if (patch.competenceDate) {
        setCompetenceDate(patch.competenceDate);
        setCompetenceTouched(true);
      }
      if (patch.installments) {
        setSeriesKind('installments');
        setCount(patch.installments.count);
        setFrequency('monthly');
        setIntervalCount(1);
        setAmount(patch.installments.amountCents);
      }
    },
    [entityLocked],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!entity) return setError('Escolha a entidade.');
    if (!categoryId) return setError('Escolha a categoria.');
    if (!amount || amount <= 0) return setError(t.errors.invalidAmount);
    setError(null);

    if (title) {
      const body: TitleUpdateInput = {
        description,
        categoryId,
        ...(invoiceLocked ? {} : { amountCents: amount, dueDate, boletoBarcode, pixPayload }),
        competenceDate,
        notes,
        scope,
        ...(title.mirrorTitleId ? {} : { entityId: entity.id }),
      };
      const saved = await run(() => api.patch<TitleDetail>(`/api/titles/${title.id}`, body), 'Título atualizado.');
      if (saved) onSaved(saved);
      return;
    }

    let series: SeriesInput | null = null;
    if (seriesKind === 'installments') series = { kind: 'installments', count, frequency, intervalCount };
    if (seriesKind === 'recurrence') series = { kind: 'recurrence', frequency, intervalCount, endsOn: endsOn || null };
    const body: TitleCreateInput = {
      caixaId,
      direction,
      entityId: entity.id,
      categoryId,
      description,
      competenceDate,
      dueDate,
      amountCents: amount,
      notes,
      ...mirrorPayload(mirror),
      series,
      boletoBarcode,
      pixPayload,
      nfeDocumentId,
    };
    const saved = await run(() => api.post<TitleDetail>('/api/titles', body), 'Título criado.');
    if (saved) onSaved(saved);
  }

  const label = direction === 'payable' ? t.title.payee : t.title.payer;
  const heading = editing ? 'Editar título' : direction === 'payable' ? t.palette.newPayable : t.palette.newReceivable;

  return (
    <Modal open title={heading} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid cols-2">
            {invoiceLocked ? (
              <p className="notice info span-all">{t.entry.cardInvoiceHint}</p>
            ) : (
              <EntrySources
                direction={direction}
                allowNfe={!editing}
                initial={{ boletoBarcode: title?.boletoBarcode, pixPayload: title?.pixPayload }}
                onApply={applyEntry}
              />
            )}
            <Field label={label} className="span-all">
              {title?.mirrorTitleId ? (
                <input className="field" value={entity?.name ?? ''} readOnly title={t.errors.mirrorEntityLocked} />
              ) : (
                <EntityPicker value={entity} onChange={setEntity} autoFocus={!editing} ariaLabel={label} />
              )}
            </Field>
            <Field label={t.common.description} className="span-all">
              <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={300} />
            </Field>
            <Field label={t.title.category}>
              <CategorySelect
                kind={kindOf(direction)}
                caixaId={caixaId}
                value={categoryId}
                onChange={setCategoryId}
                ariaLabel={t.title.category}
              />
            </Field>
            <Field label={seriesKind === 'installments' ? t.title.installmentAmount : t.title.amount}>
              {invoiceLocked ? (
                <input className="field field-mono" value={formatCents(amount ?? 0)} readOnly aria-label={t.title.amount} />
              ) : (
                <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.title.amount} />
              )}
            </Field>
            <Field label={t.title.due}>
              <input
                type="date"
                className="field"
                value={dueDate}
                required
                readOnly={invoiceLocked}
                aria-label={t.title.due}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  if (!competenceTouched) setCompetenceDate(e.target.value);
                }}
              />
            </Field>
            <Field label={t.title.competence} hint="Mês a que a despesa ou receita pertence.">
              <input
                type="date"
                className="field"
                value={competenceDate}
                required
                onChange={(e) => {
                  setCompetenceDate(e.target.value);
                  setCompetenceTouched(true);
                }}
              />
            </Field>

            {!editing && <MirrorFields mirror={mirror} direction={direction} />}

            {!editing && (
              <Field label={t.title.series} className="span-all">
                <div className="segmented" role="group" aria-label={t.title.series}>
                  {(
                    [
                      ['none', t.title.seriesNone],
                      ['installments', t.title.seriesInstallments],
                      ['recurrence', t.title.seriesRecurrence],
                    ] as const
                  ).map(([key, text]) => (
                    <button key={key} type="button" className={seriesKind === key ? 'active' : ''} onClick={() => setSeriesKind(key)}>
                      {text}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {!editing && seriesKind !== 'none' && (
              <div className="form-grid cols-3 span-all">
                {seriesKind === 'installments' && (
                  <Field label={t.title.installments}>
                    <input
                      type="number"
                      className="field"
                      min={2}
                      max={999}
                      value={count}
                      onChange={(e) => setCount(Number(e.target.value))}
                    />
                  </Field>
                )}
                <Field label={t.title.frequency}>
                  <select className="field" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                    {FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {t.title.frequencies[f]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t.title.every}>
                  <input
                    type="number"
                    className="field"
                    min={1}
                    max={366}
                    value={intervalCount}
                    onChange={(e) => setIntervalCount(Number(e.target.value))}
                  />
                </Field>
                {seriesKind === 'recurrence' && (
                  <Field label={t.title.endsOn} hint="Vazio = sem fim (o sistema mantém 12 meses à frente).">
                    <input type="date" className="field" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
                  </Field>
                )}
              </div>
            )}

            {editing && title?.recurrenceRuleId && (
              <Field label="Aplicar a" className="span-all">
                <div className="segmented" role="group">
                  <button type="button" className={scope === 'this' ? 'active' : ''} onClick={() => setScope('this')}>
                    {t.title.scopeThis}
                  </button>
                  <button type="button" className={scope === 'following' ? 'active' : ''} onClick={() => setScope('following')}>
                    {t.title.scopeFollowing}
                  </button>
                </div>
              </Field>
            )}

            <Field label={t.common.notes} className="span-all">
              <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
