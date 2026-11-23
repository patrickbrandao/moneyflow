import { type SeriesDto, type SeriesUpdateInput, seriesTermsDraft, seriesTermsFromDraft, t, todayIso } from '@moneyflow/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { AccountSelect, useObligationOptions } from '../contracts/obligation-options';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { Button, Field, Modal } from '../ui';
import { SeriesTermsFields } from './SeriesTermsFields';
import { calendarText, kindOf } from './series-text';

const O = t.contracts.obligation;

/**
 * Edição da série (PATCH /api/series/:id): os ajustes valem na hora; descrição,
 * valor, dia, categoria e conta (ou pagadora, no cartão) mudam "esta e as
 * próximas" a partir da data de efeito. Só o que mudou vai no corpo.
 */
export function SeriesEditModal({ series, onClose, onSaved }: { series: SeriesDto; onClose: () => void; onSaved: (s: SeriesDto) => void }) {
  const account = series.kind === 'account';
  const options = useObligationOptions(series.entityId);
  const caixaAccounts = options.accounts.filter((a) => a.caixaId === series.caixaId || a.id === series.accountId);
  const [effectiveOn, setEffectiveOn] = useState(todayIso());
  const [description, setDescription] = useState(series.description);
  const [amountCents, setAmountCents] = useState<number | null>(series.amountCents);
  const [anchorDay, setAnchorDay] = useState(series.anchorDay);
  const [categoryId, setCategoryId] = useState<string | null>(series.categoryId);
  const [accountId, setAccountId] = useState<string | null>(series.accountId);
  const [payerCaixaId, setPayerCaixaId] = useState<string | null>(series.payerCaixaId);
  const [terms, setTerms] = useState(() => seriesTermsDraft(series.terms));
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!description.trim()) return setError(O.needDescription);
    if (!amountCents) return setError(O.needAmount);
    const parsed = seriesTermsFromDraft(terms);
    if (parsed.error) return setError(parsed.error);
    setError(null);
    const body: SeriesUpdateInput = { ...parsed.terms };
    let changed = false;
    const put = <K extends keyof SeriesUpdateInput>(key: K, v: SeriesUpdateInput[K]) => {
      body[key] = v;
      changed = true;
    };
    if (description.trim() !== series.description) put('description', description.trim());
    if (amountCents !== series.amountCents) put('amountCents', amountCents);
    if (account && anchorDay !== series.anchorDay && series.frequency !== 'weekly') put('anchorDay', anchorDay);
    if (categoryId && categoryId !== series.categoryId) put('categoryId', categoryId);
    if (account && accountId && accountId !== series.accountId) put('accountId', accountId);
    if (!account && payerCaixaId && payerCaixaId !== series.payerCaixaId) put('payerCaixaId', payerCaixaId);
    if (changed) body.effectiveOn = effectiveOn;
    const saved = await run(() => api.patch<SeriesDto>(`/api/series/${series.id}`, body), O.saved);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={O.edit} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} data-testid="series-edit-form">
        <div className="modal-body">
          <p className="hint mb-3">
            {series.contractName ? `${t.contracts.contract}: ${series.contractName} · ` : ''}
            {calendarText(series)} · {series.entityName}
          </p>
          <div className="form-grid cols-2">
            <Field label={O.effectiveOn} hint={O.effectiveHint} className="span-all">
              <input
                className="field"
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
                required
                aria-label={O.effectiveOn}
              />
            </Field>
            <Field label={O.description} className="span-all">
              <input
                className="field"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                aria-label={O.description}
              />
            </Field>
            <Field label={O.amount}>
              <MoneyInput value={amountCents} onChange={setAmountCents} ariaLabel={O.amount} />
            </Field>
            {/* A cobrança no cartão não muda de dia (tarefa 137): encerra-se e cria-se outra. */}
            {account && series.frequency !== 'weekly' ? (
              <Field label={O.anchorDay}>
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={31}
                  value={anchorDay}
                  onChange={(e) => setAnchorDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                  aria-label={O.anchorDay}
                />
              </Field>
            ) : (
              <span />
            )}
            <Field label={O.category}>
              <CategorySelect
                kind={kindOf(series.direction)}
                caixaId={series.caixaId}
                value={categoryId}
                onChange={setCategoryId}
                ariaLabel={O.category}
              />
            </Field>
            {account ? (
              <Field label={O.account} hint={O.accountOfCaixa(series.caixaName)}>
                <AccountSelect
                  accounts={caixaAccounts}
                  value={accountId}
                  onChange={setAccountId}
                  label={O.account}
                  empty={t.contracts.payment.plannedNone}
                  testId="series-account"
                />
              </Field>
            ) : (
              <Field label={O.payer}>
                <select
                  className="field"
                  value={payerCaixaId ?? ''}
                  onChange={(e) => setPayerCaixaId(e.target.value || null)}
                  aria-label={O.payer}
                >
                  {!series.payerCaixaId && <option value="">{O.payerDefault}</option>}
                  {series.payerCaixaId && !options.payers.some((c) => c.id === series.payerCaixaId) && (
                    <option value={series.payerCaixaId}>{series.payerCaixaName ?? '—'}</option>
                  )}
                  {options.payers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <SeriesTermsFields value={terms} onChange={setTerms} />
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy} data-testid="series-edit-submit">
            {busy ? t.common.saving : t.common.save}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
