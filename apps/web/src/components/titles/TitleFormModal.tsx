import {
  type EntityDetail,
  FREQUENCIES,
  type SeriesInput,
  type TitleCreateInput,
  type TitleDetail,
  type TitleUpdateInput,
  t,
  todayIso,
} from '@moneyflow/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { canWriteCaixa } from '../../lib/access';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction } from '../../lib/hooks';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal } from '../ui';

type Direction = 'payable' | 'receivable';
type SeriesKind = 'none' | 'installments' | 'recurrence';
type Frequency = (typeof FREQUENCIES)[number];

const kindOf = (direction: Direction) => (direction === 'payable' ? 'expense' : 'income');
const opposite = (direction: Direction): Direction => (direction === 'payable' ? 'receivable' : 'payable');

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
  const user = useUser();
  const editing = Boolean(title);
  const today = todayIso();
  const [entity, setEntity] = useState<EntityOption | null>(title ? { id: title.entityId, name: title.entityName } : null);
  const [description, setDescription] = useState(title?.description ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(title?.categoryId ?? null);
  const [amount, setAmount] = useState<number | null>(title?.amountCents ?? null);
  const [dueDate, setDueDate] = useState(title?.dueDate ?? today);
  const [competenceDate, setCompetenceDate] = useState(title?.competenceDate ?? today);
  const [competenceTouched, setCompetenceTouched] = useState(editing);
  const [notes, setNotes] = useState(title?.notes ?? '');
  const [scope, setScope] = useState<'this' | 'following'>('this');

  const [seriesKind, setSeriesKind] = useState<SeriesKind>('none');
  const [count, setCount] = useState(2);
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [intervalCount, setIntervalCount] = useState(1);
  const [endsOn, setEndsOn] = useState('');

  // Caixas de que a entidade é titular (para o espelho).
  const [held, setHeld] = useState<EntityDetail['caixas'] | null>(null);
  const [mirrorCaixaId, setMirrorCaixaId] = useState<string | null>(null);
  const [mirrorCategoryId, setMirrorCategoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    if (editing || !entity) {
      setHeld(null);
      setMirrorCaixaId(null);
      return;
    }
    let cancelled = false;
    api
      .get<EntityDetail>(`/api/entities/${entity.id}`)
      .then((detail) => {
        if (cancelled) return;
        const options = detail.caixas.filter((c) => !c.archivedAt && c.id !== caixaId);
        setHeld(options);
        const primary = options.find((c) => c.isPrimary);
        setMirrorCaixaId(primary?.id ?? null);
        setMirrorCategoryId(null);
      })
      .catch(() => setHeld([]));
    return () => {
      cancelled = true;
    };
  }, [entity, editing, caixaId]);

  const mirrorWritable = mirrorCaixaId ? canWriteCaixa(user, mirrorCaixaId) : false;

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
        amountCents: amount,
        dueDate,
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
      mirrorCaixaId: held && held.length > 0 ? mirrorCaixaId : null,
      mirrorCategoryId: mirrorCaixaId && mirrorWritable ? mirrorCategoryId : null,
      series,
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
              <MoneyInput value={amount} onChange={setAmount} ariaLabel={t.title.amount} />
            </Field>
            <Field label={t.title.due}>
              <input
                type="date"
                className="field"
                value={dueDate}
                required
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

            {!editing && held && held.length > 0 && (
              <>
                <Field label={t.title.mirrorCaixa} hint={mirrorCaixaId && !mirrorWritable ? t.title.mirrorPendingHint : undefined}>
                  <select className="field" value={mirrorCaixaId ?? ''} onChange={(e) => setMirrorCaixaId(e.target.value || null)}>
                    <option value="">{t.title.mirrorNone}</option>
                    {held.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.isPrimary ? ` (${t.common.primary.toLowerCase()})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                {mirrorCaixaId && mirrorWritable ? (
                  <Field label={t.title.mirrorCategory}>
                    <CategorySelect
                      kind={kindOf(opposite(direction))}
                      caixaId={mirrorCaixaId}
                      value={mirrorCategoryId}
                      onChange={setMirrorCategoryId}
                      allowEmpty="Automática"
                      ariaLabel={t.title.mirrorCategory}
                    />
                  </Field>
                ) : (
                  <div />
                )}
              </>
            )}

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
