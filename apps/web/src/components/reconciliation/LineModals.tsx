import {
  type CaixaSummary,
  type CardOverview,
  formatBRL,
  formatDate,
  type MatchCandidateRow,
  type StatementLineRow,
  t,
} from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError, Money } from '../domain';
import { CategorySelect, type EntityOption, EntityPicker, FormError, ModalActions } from '../forms';
import { MirrorFields, mirrorPayload, useMirrorChoice } from '../titles/MirrorFields';
import { Badge, Button, Field, Modal } from '../ui';

const s = t.statements;

/** Categoria da linha: receita se entra (+), despesa se sai (−) ou se é cartão. */
export const lineCategoryKind = (line: StatementLineRow, isCard: boolean): 'income' | 'expense' =>
  isCard || line.amountCents < 0 ? 'expense' : 'income';

function LineHeader({ line }: { line: StatementLineRow }) {
  return (
    <div className="well mb-3">
      <span className="row-title">{line.description}</span>
      <span className="row-sub">{s.lineInfo(formatDate(line.postedOn), formatBRL(line.amountCents))}</span>
    </div>
  );
}

/** Casar à mão: escolhe um movimento, título ou item de fatura de mesmo valor. */
export function MatchModal({ line, onClose, onDone }: { line: StatementLineRow; onClose: () => void; onDone: () => void }) {
  const candidates = useApi<MatchCandidateRow[]>(`/api/statement-lines/${line.id}/candidates`);
  const [chosen, setChosen] = useState<MatchCandidateRow | null>(null);
  const { run, busy } = useAction();

  async function submit() {
    if (!chosen) return;
    const key = chosen.kind === 'movement' ? 'movementId' : chosen.kind === 'title' ? 'titleId' : 'cardInvoiceItemId';
    if (await run(() => api.post(`/api/statement-lines/${line.id}/match`, { [key]: chosen.id }), s.matched)) onDone();
  }

  return (
    <Modal open title={s.matchTitle} onClose={onClose} wide>
      <div className="modal-body">
        <LineHeader line={line} />
        <span className="label">{s.candidates}</span>
        {candidates.error && <LoadError error={candidates.error} onRetry={() => void candidates.reload()} />}
        {candidates.loading && !candidates.data && <p className="text-[13px] text-muted">{t.common.loading}</p>}
        {candidates.data?.length === 0 && <p className="notice info">{s.noCandidates}</p>}
        <div className="rec-cands" role="radiogroup" aria-label={s.candidates}>
          {candidates.data?.map((c) => (
            <label key={`${c.kind}-${c.id}`} className="rec-radio">
              <input type="radio" name="candidate" checked={chosen?.id === c.id} onChange={() => setChosen(c)} />
              <span className="mono w-[84px] text-xs">{formatDate(c.date)}</span>
              <span className="min-w-0 flex-1">
                <span className="row-title">{c.description}</span>
                <span className="row-sub">
                  {s.targetKinds[c.kind]}
                  {c.entityName ? ` · ${c.entityName}` : ''}
                </span>
              </span>
              {c.score !== null && (
                <Badge mono title={s.score}>
                  {c.score}
                </Badge>
              )}
              <Money cents={c.amountCents} signed />
            </label>
          ))}
        </div>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button onClick={() => void submit()} disabled={!chosen || busy}>
          {s.match}
        </Button>
      </ModalActions>
    </Modal>
  );
}

/**
 * Desfazer a conciliação de uma linha cujo lançamento nasceu dela (spec 009):
 * excluir junto o lançamento (o padrão) ou só desfazer a conciliação.
 */
export function UnmatchModal({ line, onClose, onDone }: { line: StatementLineRow; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const entry = line.createdEntry ?? 'adjustment';

  async function submit(deleteEntry: boolean) {
    const ok = await run(
      () => api.post(`/api/statement-lines/${line.id}/unmatch`, { deleteEntry }),
      deleteEntry ? s.unmatchedDeleted : s.unmatched,
    );
    if (ok) onDone();
  }

  return (
    <Modal open title={s.unmatchTitle} onClose={onClose}>
      <div className="modal-body">
        <LineHeader line={line} />
        <p className="notice warn">{s.unmatchCreated(s.createdEntries[entry] ?? '')}</p>
        <p className="text-[13px] text-muted">{s.unmatchDeleteHint[entry]}</p>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button variant="ghost" onClick={() => void submit(false)} disabled={busy}>
          {s.unmatchKeep}
        </Button>
        <Button variant="danger" onClick={() => void submit(true)} disabled={busy} autoFocus>
          {s.unmatchAndDelete}
        </Button>
      </ModalActions>
    </Modal>
  );
}

type Mode = 'adjustment' | 'title' | 'purchase';

/** Lançar uma linha nova (ou só classificar, com `classifyOnly`). */
export function CreateModal({
  line,
  isCard,
  caixaId,
  card,
  classifyOnly,
  onClose,
  onDone,
}: {
  line: StatementLineRow;
  isCard: boolean;
  caixaId: string;
  card: CardOverview | null;
  classifyOnly?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>(isCard ? 'purchase' : 'title');
  const [entity, setEntity] = useState<EntityOption | null>(line.entityId ? { id: line.entityId, name: line.entityName ?? '' } : null);
  const [categoryId, setCategoryId] = useState<string | null>(line.categoryId);
  const [description, setDescription] = useState(line.description);
  const [payer, setPayer] = useState('');
  const [learnRule, setLearnRule] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const caixas = useApi<CaixaSummary[]>(isCard && !classifyOnly ? '/api/caixas' : null);
  const kind = lineCategoryKind(line, isCard);
  const suggested = line.classificationSource && line.classificationSource !== 'user' ? s.bySource[line.classificationSource] : null;
  const entityUnchanged = entity?.id === line.entityId;
  const categoryUnchanged = categoryId === line.categoryId;
  const needsBoth = classifyOnly ? false : mode !== 'adjustment';
  // Título já baixado: espelho como num título novo (spec 006).
  const asTitle = !classifyOnly && mode === 'title';
  const direction = line.amountCents < 0 ? 'payable' : 'receivable';
  const mirror = useMirrorChoice(entity?.id ?? null, caixaId, asTitle);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (needsBoth && (!entity || !categoryId)) return setError(s.entityRequired);
    const ok = classifyOnly
      ? await run(() => api.patch(`/api/statement-lines/${line.id}`, { entityId: entity?.id ?? null, categoryId, learnRule }), s.classified)
      : await run(
          () =>
            api.post(`/api/statement-lines/${line.id}/create`, {
              mode,
              entityId: entity?.id ?? null,
              categoryId,
              description: description.trim() || undefined,
              payerCaixaId: mode === 'purchase' && payer ? payer : undefined,
              ...(asTitle ? mirrorPayload(mirror) : {}),
              learnRule,
            }),
          s.created,
        );
    if (ok) onDone();
  }

  const modes: Mode[] = isCard ? ['purchase'] : ['title', 'adjustment'];

  return (
    <Modal open title={classifyOnly ? s.classifyTitle : s.createTitle} onClose={onClose}>
      <form onSubmit={submit}>
        <LineHeader line={line} />
        <div className="form-grid">
          {!classifyOnly && (
            <div>
              <span className="label">{s.mode}</span>
              <div className="segmented" role="group" aria-label={s.mode}>
                {modes.map((m) => (
                  <button key={m} type="button" className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                    {s.modes[m]}
                  </button>
                ))}
              </div>
              <span className="hint">{s.modeHints[mode]}</span>
            </div>
          )}
          <Field label={s.entity} hint={entityUnchanged && entity && suggested ? suggested : undefined}>
            <EntityPicker value={entity} onChange={setEntity} ariaLabel={s.entity} />
          </Field>
          <Field label={s.category} hint={categoryUnchanged && categoryId && suggested ? suggested : undefined}>
            <CategorySelect
              kind={kind}
              caixaId={caixaId}
              value={categoryId}
              onChange={setCategoryId}
              allowEmpty={t.common.none}
              ariaLabel={s.category}
            />
          </Field>
          {!classifyOnly && (
            <Field label={t.common.description}>
              <input className="field" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          )}
          {asTitle && <MirrorFields mirror={mirror} direction={direction} />}
          {!classifyOnly && mode === 'purchase' && (
            <Field label={s.payer}>
              <select className="field" value={payer} onChange={(e) => setPayer(e.target.value)} aria-label={s.payer}>
                <option value="">{s.payerDefault(card?.settings.defaultPayerName ?? '—')}</option>
                {caixas.data
                  ?.filter((c) => c.kind === 'general' && !c.archivedAt)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <label className="check">
            <input type="checkbox" checked={learnRule} onChange={(e) => setLearnRule(e.target.checked)} /> {s.learnRule}
          </label>
          <span className="hint -mt-2">{s.learnRuleHint}</span>
        </div>
        <FormError>{error}</FormError>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : classifyOnly ? t.common.save : s.create}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
