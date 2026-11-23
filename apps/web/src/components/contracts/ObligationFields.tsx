import {
  type ContractDirection,
  FREQUENCIES,
  type Frequency,
  type ObligationInput,
  type ObligationKind,
  type SeriesTermsDraft,
  seriesTermsDraft,
  seriesTermsFromDraft,
  t,
  todayIso,
} from '@moneyflow/shared';
import { Trash2 } from 'lucide-react';
import { CategorySelect, MoneyInput } from '../forms';
import { SeriesTermsFields } from '../series/SeriesTermsFields';
import { kindOf } from '../series/series-text';
import { Button, Field } from '../ui';
import { AccountSelect, type ObligationOptions, useObligationOptions } from './obligation-options';

/*
 * Uma obrigação nova do contrato (spec 034): a série numa conta (corrente,
 * poupança ou cofre; as ocorrências são títulos na caixa da conta) ou a
 * cobrança esperada no cartão. O rascunho, a validação, o corpo da API, os
 * campos e a lista editável do cadastro do contrato.
 */

const O = t.contracts.obligation;

export type ObligationDraft = {
  key: string;
  kind: ObligationKind;
  description: string;
  amountCents: number | null;
  frequency: Frequency;
  intervalCount: number;
  firstDueDate: string;
  firstCompetenceDate: string;
  endsOn: string;
  categoryId: string | null;
  accountId: string | null;
  cardCaixaId: string | null;
  payerCaixaId: string | null;
  terms: SeriesTermsDraft;
};

let draftSeq = 0;

export function newObligationDraft(partial: Partial<ObligationDraft> = {}): ObligationDraft {
  draftSeq += 1;
  return {
    key: `o${draftSeq}`,
    kind: 'account',
    description: '',
    amountCents: null,
    frequency: 'monthly',
    intervalCount: 1,
    firstDueDate: todayIso(),
    firstCompetenceDate: '',
    endsOn: '',
    categoryId: null,
    accountId: null,
    cardCaixaId: null,
    payerCaixaId: null,
    terms: seriesTermsDraft(),
    ...partial,
  };
}

/** Erro local de uma obrigação (null = pronta). */
export function obligationProblem(d: ObligationDraft, direction: ContractDirection): string | null {
  if (!d.description.trim()) return O.needDescription;
  if (!d.amountCents || d.amountCents <= 0) return O.needAmount;
  if (d.kind === 'account' && !d.accountId) return t.contracts.errors.obligationAccount;
  if (d.kind === 'card' && direction !== 'payable') return O.cardPayableOnly;
  if (d.kind === 'card' && !d.cardCaixaId) return t.contracts.errors.obligationCard;
  return seriesTermsFromDraft(d.terms).error;
}

/** Corpo da API: o fim omitido = o fim da vigência; a categoria omitida = a do contrato. */
export function obligationInputOf(d: ObligationDraft): ObligationInput {
  const account = d.kind === 'account';
  // Os ajustes inválidos já pararam em `obligationProblem`.
  const { terms } = seriesTermsFromDraft(d.terms);
  return {
    kind: d.kind,
    description: d.description.trim(),
    amountCents: d.amountCents ?? 0,
    frequency: d.frequency,
    intervalCount: d.intervalCount,
    firstDueDate: d.firstDueDate,
    ...(account && d.firstCompetenceDate ? { firstCompetenceDate: d.firstCompetenceDate } : {}),
    ...(d.endsOn ? { endsOn: d.endsOn } : {}),
    categoryId: d.categoryId,
    accountId: account ? d.accountId : null,
    cardCaixaId: account ? null : d.cardCaixaId,
    payerCaixaId: account ? null : d.payerCaixaId,
    ...terms,
  };
}

/** Os campos de uma obrigação (tipo, descrição, valor, calendário, conta ou cartão e os ajustes). */
export function ObligationFields({
  value,
  onChange,
  direction,
  caixaId,
  options,
  defaultCategoryName,
}: {
  value: ObligationDraft;
  onChange: (next: ObligationDraft) => void;
  direction: ContractDirection;
  /** Caixa do contrato (para as categorias ocultas). */
  caixaId: string;
  options: ObligationOptions;
  defaultCategoryName?: string | null;
}) {
  const set = <K extends keyof ObligationDraft>(key: K, v: ObligationDraft[K]) => onChange({ ...value, [key]: v });
  const account = value.kind === 'account';
  const unit = O[value.frequency] as string;
  return (
    <div className="form-grid cols-2">
      <Field label={O.title} hint={O.kindHint} className="span-all">
        <div className="segmented" role="group" aria-label={O.title}>
          {(['account', 'card'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={value.kind === k ? 'active' : ''}
              disabled={k === 'card' && direction !== 'payable'}
              title={k === 'card' && direction !== 'payable' ? O.cardPayableOnly : undefined}
              onClick={() => set('kind', k)}
              data-testid={`obligation-kind-${k}`}
            >
              {O.kinds[k]}
            </button>
          ))}
        </div>
      </Field>
      <Field label={O.description} className="span-all">
        <input
          className="field"
          value={value.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={200}
          aria-label={O.description}
          data-testid="obligation-description"
        />
      </Field>
      <Field label={O.amount}>
        <MoneyInput value={value.amountCents} onChange={(v) => set('amountCents', v)} ariaLabel={O.amount} />
      </Field>
      <Field label={O.category}>
        <CategorySelect
          kind={kindOf(direction)}
          caixaId={caixaId}
          value={value.categoryId}
          onChange={(v) => set('categoryId', v)}
          allowEmpty={defaultCategoryName ? `${O.categoryDefault} (${defaultCategoryName})` : O.categoryDefault}
          ariaLabel={O.category}
        />
      </Field>
      <Field label={O.frequency}>
        <select
          className="field"
          value={value.frequency}
          onChange={(e) => set('frequency', e.target.value as Frequency)}
          aria-label={O.frequency}
        >
          {FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {t.title.frequencies[f]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${O.interval} (${unit})`}>
        <input
          className="field"
          type="number"
          min={1}
          max={366}
          value={value.intervalCount}
          onChange={(e) => set('intervalCount', Math.max(1, Number(e.target.value) || 1))}
          aria-label={O.interval}
        />
      </Field>
      <Field label={account ? O.firstDue : O.firstCharge}>
        <input
          className="field"
          type="date"
          value={value.firstDueDate}
          onChange={(e) => set('firstDueDate', e.target.value)}
          required
          aria-label={account ? O.firstDue : O.firstCharge}
        />
      </Field>
      {account ? (
        <Field label={O.firstCompetence} hint={O.firstCompetenceHint}>
          <input
            className="field"
            type="date"
            value={value.firstCompetenceDate}
            onChange={(e) => set('firstCompetenceDate', e.target.value)}
            aria-label={O.firstCompetence}
          />
        </Field>
      ) : (
        <span />
      )}
      <Field label={O.endsOn} hint={O.endsOnHint}>
        <input className="field" type="date" value={value.endsOn} onChange={(e) => set('endsOn', e.target.value)} aria-label={O.endsOn} />
      </Field>
      {account ? (
        <Field label={O.account} hint={options.accounts.length === 0 && !options.loading ? O.noAccounts : O.accountHint}>
          <AccountSelect
            accounts={options.accounts}
            value={value.accountId}
            onChange={(v) => set('accountId', v)}
            label={O.account}
            testId="obligation-account"
          />
        </Field>
      ) : (
        <>
          <Field label={O.card} hint={options.cards.length === 0 && !options.loading ? O.noCards : undefined}>
            <select
              className="field"
              value={value.cardCaixaId ?? ''}
              onChange={(e) => set('cardCaixaId', e.target.value || null)}
              aria-label={O.card}
              data-testid="obligation-card"
            >
              <option value="">—</option>
              {options.cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.cardLast4 ? ` · ${c.cardLast4}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={O.payer}>
            <select
              className="field"
              value={value.payerCaixaId ?? ''}
              onChange={(e) => set('payerCaixaId', e.target.value || null)}
              aria-label={O.payer}
            >
              <option value="">{O.payerDefault}</option>
              {options.payers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <SeriesTermsFields value={value.terms} onChange={(terms) => set('terms', terms)} testId="obligation-terms" />
    </div>
  );
}

/** Lista editável de obrigações (cadastro do contrato). */
export function ObligationsEditor({
  items,
  onChange,
  direction,
  caixaId,
  counterpartyId,
  defaultCategoryName,
}: {
  items: ObligationDraft[];
  onChange: (items: ObligationDraft[]) => void;
  direction: ContractDirection;
  caixaId: string;
  counterpartyId: string | null;
  defaultCategoryName?: string | null;
}) {
  const options = useObligationOptions(counterpartyId);
  return (
    <section className="span-all" aria-label={t.contracts.fields.obligations} data-testid="contract-obligations-editor">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="label !mb-0">{t.contracts.fields.obligations}</span>
        <Button size="sm" variant="ghost" onClick={() => onChange([...items, newObligationDraft()])} data-testid="obligation-add">
          {t.contracts.actions.addObligation}
        </Button>
      </div>
      {items.length === 0 && <p className="hint !mt-0">{t.contracts.noObligations}</p>}
      <div className="grid gap-3">
        {items.map((item, i) => (
          <fieldset key={item.key} className="well" data-testid="obligation-row" aria-label={`${O.title} ${i + 1}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <legend className="text-sm font-semibold">
                {O.title} {i + 1}
              </legend>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => onChange(items.filter((x) => x.key !== item.key))}
                aria-label={`${O.remove} ${i + 1}`}
                data-testid="obligation-remove"
              >
                <Trash2 /> {O.remove}
              </Button>
            </div>
            <ObligationFields
              value={item}
              onChange={(next) => onChange(items.map((x) => (x.key === item.key ? next : x)))}
              direction={direction}
              caixaId={caixaId}
              options={options}
              defaultCategoryName={defaultCategoryName}
            />
          </fieldset>
        ))}
      </div>
    </section>
  );
}
