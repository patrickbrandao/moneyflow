import {
  type AmendmentPreview,
  type ContractActionResult,
  type ContractAmendmentInput,
  type ContractDetail,
  formatAccounting,
  formatDate,
  parsePercent,
  t,
  todayIso,
} from '@moneyflow/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { calendarText, kindOf } from '../series/series-text';
import { Button, Field, Modal } from '../ui';
import { usePreview } from './contract-preview';
import { AccountSelect, useObligationOptions } from './obligation-options';

const C = t.contracts;

/** Faixa do reajuste do aditivo (a mesma do `contractAmendmentInput`). */
const READJUST_MIN = -100;
const READJUST_MAX = 1000;

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

  // "2%", "2,5" e "-3" valem; o que não for número vira erro na tela, não "sem reajuste" (tarefa 181).
  const parsedPct = parsePercent(percent, READJUST_MAX, READJUST_MIN);
  const pct = parsedPct.value;
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
    if (!preview) return;
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
              <Field label={A.readjust} hint={parsedPct.error ? <span className="text-danger">{parsedPct.error}</span> : undefined}>
                <input
                  className="field field-mono"
                  inputMode="decimal"
                  value={percent}
                  placeholder="0"
                  onChange={(e) => setPercent(e.target.value)}
                  aria-label={A.readjust}
                  aria-invalid={parsedPct.error ? true : undefined}
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
