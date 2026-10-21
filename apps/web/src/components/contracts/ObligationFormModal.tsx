import {
  type AccountRow,
  type CaixaSummary,
  type ContractDetail,
  type ContractDirection,
  DEFAULT_SERIES_TERMS,
  FREQUENCIES,
  type Frequency,
  formatAccounting,
  formatDate,
  type ObligationInput,
  type ObligationKind,
  type SeriesDto,
  type SeriesEndPreview,
  type SeriesOccurrence,
  type SeriesTerms,
  type SeriesUpdateInput,
  t,
  todayIso,
} from '@moneyflow/shared';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { canWriteCaixa } from '../../lib/access';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { CategorySelect, FormError, ModalActions, MoneyInput } from '../forms';
import { Badge, Button, Field, Modal } from '../ui';

/*
 * Obrigações do contrato (spec 034): séries numa conta (corrente, poupança ou
 * cofre; as ocorrências são títulos na caixa da conta) ou cobranças esperadas
 * no cartão. Aqui ficam o editor de uma obrigação (usado no cadastro do
 * contrato e no "Adicionar obrigação"), a edição de uma série existente
 * (`SeriesEditModal`, também usada na gaveta do título), o "Ligar série
 * existente" e o "Encerrar ou estender" pela regra.
 */

const O = t.contracts.obligation;
const P = t.contracts.payment;
const kindOf = (direction: ContractDirection) => (direction === 'payable' ? 'expense' : 'income');

/* ---------------- ajustes de reconhecimento ---------------- */

/** Ajustes no formulário: percentuais como texto (vazio = sem). */
export type TermsDraft = {
  matchWindowDays: number;
  lateFee: string;
  interest: string;
  discount: string;
  toleranceCents: number | null;
  autoSettle: boolean;
};

const pctText = (v: number | null) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const pctOf = (text: string) => {
  if (text.trim() === '') return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export const termsDraftOf = (terms: SeriesTerms = DEFAULT_SERIES_TERMS): TermsDraft => ({
  matchWindowDays: terms.matchWindowDays,
  lateFee: pctText(terms.lateFeePercent),
  interest: pctText(terms.interestMonthPercent),
  discount: pctText(terms.earlyDiscountPercent),
  toleranceCents: terms.toleranceCents,
  autoSettle: terms.autoSettle,
});

export const termsBody = (d: TermsDraft): SeriesTerms => ({
  matchWindowDays: d.matchWindowDays,
  lateFeePercent: pctOf(d.lateFee),
  interestMonthPercent: pctOf(d.interest),
  earlyDiscountPercent: pctOf(d.discount),
  toleranceCents: d.toleranceCents ?? 0,
  autoSettle: d.autoSettle,
});

/** Resumo legível dos ajustes ("multa 2% · juros 1% a.m. · janela 15 d"). */
export function termsText(terms: SeriesTerms): string {
  const parts = [
    terms.lateFeePercent ? `${P.lateFee}: ${pctText(terms.lateFeePercent)}` : null,
    terms.interestMonthPercent ? `${P.interest}: ${pctText(terms.interestMonthPercent)}` : null,
    terms.earlyDiscountPercent ? `${P.discount}: ${pctText(terms.earlyDiscountPercent)}` : null,
    terms.toleranceCents ? O.termsTolerance(formatAccounting(terms.toleranceCents)) : null,
  ].filter(Boolean);
  if (parts.length === 0) return `${O.termsDefault(terms.matchWindowDays)}${terms.autoSettle ? ` · ${O.termsAuto}` : ''}`;
  return [...parts, O.termsWindow(terms.matchWindowDays), terms.autoSettle ? O.termsAuto : null].filter(Boolean).join(' · ');
}

/** Calendário legível da série ("Todo mês · dia 10", "A cada 3 mês(es) · dia 5"). */
export function calendarText(series: Pick<SeriesDto, 'frequency' | 'intervalCount' | 'anchorDay' | 'startsOn'>): string {
  const unit = O[series.frequency] as string;
  const every = series.intervalCount === 1 ? O.everyOne[series.frequency]! : O.everyN(series.intervalCount, unit);
  const day = series.frequency === 'weekly' ? O.dayOfWeek(formatDate(series.startsOn)) : O.dayOfMonth(series.anchorDay);
  return O.summary(every, day);
}

/** Campos dos ajustes, recolhidos por padrão. */
export function TermsFields({
  value,
  onChange,
  open: initialOpen = false,
}: {
  value: TermsDraft;
  onChange: (next: TermsDraft) => void;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const set = <K extends keyof TermsDraft>(key: K, v: TermsDraft[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="span-all" data-testid="obligation-terms">
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown /> : <ChevronRight />} {O.adjustments}
      </button>
      {open && (
        <div className="form-grid cols-2 mt-2">
          <p className="hint span-all !mt-0">{O.adjustmentsHint}</p>
          <Field label={P.window} hint={P.windowHint}>
            <input
              className="field"
              type="number"
              min={0}
              max={45}
              value={value.matchWindowDays}
              onChange={(e) => set('matchWindowDays', Number(e.target.value))}
              aria-label={P.window}
            />
          </Field>
          <Field label={P.tolerance} hint={P.toleranceHint}>
            <MoneyInput value={value.toleranceCents} onChange={(v) => set('toleranceCents', v)} ariaLabel={P.tolerance} />
          </Field>
          <Field label={P.lateFee}>
            <input
              className="field field-mono"
              inputMode="decimal"
              value={value.lateFee}
              onChange={(e) => set('lateFee', e.target.value)}
              aria-label={P.lateFee}
            />
          </Field>
          <Field label={P.interest}>
            <input
              className="field field-mono"
              inputMode="decimal"
              value={value.interest}
              onChange={(e) => set('interest', e.target.value)}
              aria-label={P.interest}
            />
          </Field>
          <Field label={P.discount}>
            <input
              className="field field-mono"
              inputMode="decimal"
              value={value.discount}
              onChange={(e) => set('discount', e.target.value)}
              aria-label={P.discount}
            />
          </Field>
          <label className="check span-all">
            <input
              type="checkbox"
              checked={value.autoSettle}
              onChange={(e) => set('autoSettle', e.target.checked)}
              aria-label={P.autoSettle}
            />{' '}
            {P.autoSettle}
            <span className="hint !mt-0 block">{P.autoSettleHint}</span>
          </label>
        </div>
      )}
    </div>
  );
}

/* ---------------- contas, cartões e pagadoras ---------------- */

export type ObligationOptions = {
  caixas: CaixaSummary[];
  /** Corrente, poupança e cofre em que o usuário escreve, fora das caixas da contraparte. */
  accounts: AccountRow[];
  cards: CaixaSummary[];
  payers: CaixaSummary[];
  loading: boolean;
};

const MONEY_KINDS = new Set(['checking', 'savings', 'cash']);

export function useObligationOptions(counterpartyId: string | null | undefined): ObligationOptions {
  const user = useUser();
  const caixas = useApi<CaixaSummary[]>('/api/caixas');
  const accounts = useApi<AccountRow[]>('/api/accounts?writable=1');
  return useMemo(() => {
    const all = caixas.data ?? [];
    const holderOf = new Map(all.map((c) => [c.id, c.holderEntityId]));
    return {
      caixas: all,
      accounts: (accounts.data ?? []).filter(
        (a) => MONEY_KINDS.has(a.kind) && !a.archivedAt && a.canWrite && (!counterpartyId || holderOf.get(a.caixaId) !== counterpartyId),
      ),
      cards: all.filter((c) => c.kind === 'credit_card' && !c.archivedAt && canWriteCaixa(user, c.id)),
      payers: all.filter((c) => c.kind === 'general' && !c.archivedAt && canWriteCaixa(user, c.id)),
      loading: caixas.loading || accounts.loading,
    };
  }, [caixas.data, caixas.loading, accounts.data, accounts.loading, counterpartyId, user]);
}

/** Seletor de conta agrupado por caixa. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  label,
  empty = '—',
  testId,
}: {
  accounts: AccountRow[];
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  empty?: string;
  testId?: string;
}) {
  const groups = [...new Set(accounts.map((a) => a.caixaName))];
  return (
    <select
      className="field"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={label}
      data-testid={testId}
    >
      <option value="">{empty}</option>
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {accounts
            .filter((a) => a.caixaName === group)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {t.caixa.accountKinds[a.kind] ?? a.kind}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

/* ---------------- editor de uma obrigação nova ---------------- */

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
  terms: TermsDraft;
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
    terms: termsDraftOf(),
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
  return null;
}

/** Corpo da API: o fim omitido = o fim da vigência; a categoria omitida = a do contrato. */
export function obligationInputOf(d: ObligationDraft): ObligationInput {
  const account = d.kind === 'account';
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
    ...termsBody(d.terms),
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
      <TermsFields value={value.terms} onChange={(terms) => set('terms', terms)} />
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

/* ---------------- adicionar obrigação a um contrato vigente ---------------- */

export function ObligationFormModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const options = useObligationOptions(contract.entityId);
  const [draft, setDraft] = useState(() => newObligationDraft({ description: contract.name }));
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = obligationProblem(draft, contract.direction);
    if (problem) return setError(problem);
    setError(null);
    const saved = await run(() => api.post<ContractDetail>(`/api/contracts/${contract.id}/obligations`, obligationInputOf(draft)), O.added);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={O.newTitle} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} data-testid="obligation-form">
        <div className="modal-body">
          <ObligationFields
            value={draft}
            onChange={setDraft}
            direction={contract.direction}
            caixaId={contract.caixaId}
            options={options}
            defaultCategoryName={contract.categoryName}
          />
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy} data-testid="obligation-submit">
            {busy ? t.common.saving : t.contracts.actions.addObligation}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- editar uma série existente ---------------- */

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
  const [terms, setTerms] = useState(() => termsDraftOf(series.terms));
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!description.trim()) return setError(O.needDescription);
    if (!amountCents) return setError(O.needAmount);
    setError(null);
    const body: SeriesUpdateInput = { ...termsBody(terms) };
    let changed = false;
    const put = <K extends keyof SeriesUpdateInput>(key: K, v: SeriesUpdateInput[K]) => {
      body[key] = v;
      changed = true;
    };
    if (description.trim() !== series.description) put('description', description.trim());
    if (amountCents !== series.amountCents) put('amountCents', amountCents);
    if (anchorDay !== series.anchorDay && series.frequency !== 'weekly') put('anchorDay', anchorDay);
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
            {series.frequency !== 'weekly' ? (
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
            <TermsFields value={terms} onChange={setTerms} />
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

/* ---------------- ligar série existente ---------------- */

export function LinkSeriesModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: ContractDetail;
  onClose: () => void;
  onSaved: (contract: ContractDetail) => void;
}) {
  const list = useApi<SeriesDto[]>(`/api/series?entityId=${contract.entityId}&unlinked=1`);
  const rows = (list.data ?? []).filter((s) => s.direction === contract.direction && s.installmentsTotal === null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ruleId) return;
    const saved = await run(() => api.post<ContractDetail>(`/api/contracts/${contract.id}/obligations/link`, { ruleId }), O.linked);
    if (saved) onSaved(saved);
  }

  return (
    <Modal open title={O.linkTitle} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} data-testid="link-series-form">
        <div className="modal-body">
          <p className="hint mb-3">{O.linkHint}</p>
          {list.data && rows.length === 0 && <p className="hint">{O.linkNone}</p>}
          {!list.data && <p className="hint">{t.common.loading}</p>}
          <ul className="item-list" role="radiogroup" aria-label={O.linkTitle}>
            {rows.map((s) => (
              <li key={s.id} className="item">
                <label className="check grow min-w-0" data-testid="link-series-option">
                  <input type="radio" name="link-series" checked={ruleId === s.id} onChange={() => setRuleId(s.id)} />
                  <span className="min-w-0">
                    <span className="row-title">{s.description}</span>
                    <span className="row-sub">
                      {s.kind === 'account' ? (s.accountName ?? s.caixaName) : s.caixaName} · {calendarText(s)} ·{' '}
                      {formatAccounting(s.amountCents)}
                    </span>
                  </span>
                </label>
                <Badge tone="outline">{O.kinds[s.kind]}</Badge>
              </li>
            ))}
          </ul>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy || !ruleId} data-testid="link-series-submit">
            {t.contracts.actions.linkSeries}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------- encerrar ou estender pela regra ---------------- */

const occurrenceList = (items: SeriesOccurrence[]) => items.map((o) => `#${o.occurrence} ${formatDate(o.dueDate)}`).join(', ');

/** "Encerrar ou estender" a série pela regra (vale também para a cobrança no cartão). */
export function SeriesRuleEndModal({
  series,
  onClose,
  onSaved,
}: {
  series: SeriesDto;
  onClose: () => void;
  onSaved: (s: SeriesDto) => void;
}) {
  const [noEnd, setNoEnd] = useState(false);
  const [endsOn, setEndsOn] = useState(series.endsOn ?? todayIso());
  const target = noEnd ? null : endsOn || null;
  const ready = noEnd || Boolean(endsOn);
  const { data: preview, error } = useApi<SeriesEndPreview>(
    ready ? `/api/series/${series.id}/end${target ? `?endsOn=${target}` : ''}` : null,
  );
  const { run, busy } = useAction();

  async function submit() {
    const result = await run(
      () => api.post<SeriesEndPreview & { created: number; series: SeriesDto }>(`/api/series/${series.id}/end`, { endsOn: target }),
      (r) => O.endDone(r.toCancel.length, r.toReopen.length),
    );
    if (result) onSaved(result.series);
  }

  const blocked = preview?.blocked ?? [];
  const nothing = preview && preview.toCancel.length === 0 && preview.toReopen.length === 0;
  return (
    <Modal open title={`${t.title.endSeriesTitle} · ${series.description}`} onClose={onClose}>
      <div data-testid="series-end-form">
        <p className="text-[13px] text-muted">{t.title.endSeriesHint}</p>
        <div className="form-grid mt-3">
          <Field label={t.title.endSeriesKeepUntil}>
            <input
              type="date"
              className="field"
              value={endsOn}
              disabled={noEnd}
              onChange={(e) => setEndsOn(e.target.value)}
              aria-label={t.title.endSeriesKeepUntil}
            />
          </Field>
          <label className="check span-all">
            <input type="checkbox" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} /> {t.title.endSeriesNoEnd}
          </label>
        </div>
        <p className="mt-3 text-[13px] text-muted">
          {t.title.endsOn}: {series.endsOn ? formatDate(series.endsOn) : t.title.endSeriesNoEnd}
        </p>
        <div className="mt-3 grid gap-2 text-[13px]">
          {error && <div className="alert warn">{error.message}</div>}
          {preview && preview.toCancel.length > 0 && (
            <div>
              <strong className="text-ink">{t.title.endSeriesCancelCount(preview.toCancel.length)}</strong>
              <div className="text-muted">{occurrenceList(preview.toCancel)}</div>
            </div>
          )}
          {preview && preview.toReopen.length > 0 && (
            <div>
              <strong className="text-ink">{t.title.endSeriesReopenCount(preview.toReopen.length)}</strong>
              <div className="text-muted">{occurrenceList(preview.toReopen)}</div>
            </div>
          )}
          {blocked.length > 0 && (
            <div className="alert warn">
              <span>
                {t.title.endSeriesBlocked} {occurrenceList(blocked)}
              </span>
            </div>
          )}
          {nothing && blocked.length === 0 && <p className="text-faint">{t.title.endSeriesNothing}</p>}
        </div>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button
          variant={preview && preview.toCancel.length > 0 ? 'danger' : 'primary'}
          disabled={busy || !preview || blocked.length > 0}
          onClick={() => void submit()}
          data-testid="series-end-submit"
        >
          {t.title.endSeriesApply}
        </Button>
      </ModalActions>
    </Modal>
  );
}
