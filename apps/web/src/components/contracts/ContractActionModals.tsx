import {
  addDays,
  type ContractActionResult,
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
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { kindOf } from '../series/series-text';
import { Badge, Button, Field, Modal } from '../ui';
import { usePreview } from './contract-preview';
import { AccountSelect, useObligationOptions } from './obligation-options';

const C = t.contracts;

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
  // Competência da multa: sem escolha, a data da rescisão (mês fechado é recusado na prévia).
  const [penaltyCompetence, setPenaltyCompetence] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();

  const penalty: ContractTerminationInput['penalty'] =
    withPenalty && penaltyCents && penaltyCategory
      ? {
          direction: penaltyDirection,
          amountCents: penaltyCents,
          dueDate: penaltyDue,
          categoryId: penaltyCategory,
          description: R.penaltyDescription(contract.name),
          accountId: penaltyAccount,
          competenceDate: penaltyCompetence,
        }
      : null;
  const { preview, error } = usePreview<TerminationPreview>(
    `/api/contracts/${contract.id}/terminate`,
    { terminatedOn, penalty },
    Boolean(terminatedOn),
  );

  // A última ocorrência de cada obrigação vem com o proporcional sugerido (a com baixa ou em mês fechado não muda).
  const fixed = (l: TerminationPreview['last'][number]) => l.settled || l.closed;
  const suggestionKey = JSON.stringify(preview?.last.map((l) => [l.titleId, l.proratedCents, fixed(l)]) ?? []);
  useEffect(() => {
    const next: Record<string, number | null> = {};
    for (const l of preview?.last ?? []) if (!fixed(l)) next[l.titleId] = l.proratedCents;
    setLastAmounts(next);
  }, [suggestionKey]);

  const body: ContractTerminationInput = {
    terminatedOn,
    lastAmounts: (preview?.last ?? [])
      .filter((l) => !fixed(l) && lastAmounts[l.titleId] && lastAmounts[l.titleId] !== l.amountCents)
      .map((l) => ({ titleId: l.titleId, amountCents: lastAmounts[l.titleId]! })),
    penalty,
    notes,
  };
  const nameOf = (ruleId: string) => contract.obligations.find((o) => o.id === ruleId)?.description ?? '—';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
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
                      hint={l.settled ? R.lastSettled : l.closed ? R.lastClosed : R.prorated(formatAccounting(l.proratedCents))}
                    >
                      <MoneyInput
                        value={fixed(l) ? l.amountCents : (lastAmounts[l.titleId] ?? null)}
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
                <Field label={R.penaltyCompetence}>
                  <input
                    className="field"
                    type="date"
                    value={penaltyCompetence ?? terminatedOn}
                    onChange={(e) => setPenaltyCompetence(e.target.value || null)}
                    aria-label={R.penaltyCompetence}
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
    if (!preview) return;
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
