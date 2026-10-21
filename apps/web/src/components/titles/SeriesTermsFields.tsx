import { DEFAULT_SERIES_TERMS, formatAccounting, type SeriesTerms, t } from '@moneyflow/shared';
import { MoneyInput } from '../forms';
import { Field } from '../ui';

/*
 * Ajustes de reconhecimento do pagamento de uma série (spec 034): janela,
 * multa, juros, desconto, tolerância e "baixar sem confirmação". Só servem para
 * a conciliação reconhecer o valor pago; nada é lançado por eles.
 */

const P = t.contracts.payment;
const PL = t.contracts.planned;

/** Estado do formulário: os percentuais como texto (vazio = sem). */
export type SeriesTermsDraft = {
  matchWindowDays: number;
  lateFee: string;
  interest: string;
  discount: string;
  toleranceCents: number | null;
  autoSettle: boolean;
};

export function termsDraft(terms: SeriesTerms = DEFAULT_SERIES_TERMS): SeriesTermsDraft {
  return {
    matchWindowDays: terms.matchWindowDays,
    lateFee: terms.lateFeePercent?.toString() ?? '',
    interest: terms.interestMonthPercent?.toString() ?? '',
    discount: terms.earlyDiscountPercent?.toString() ?? '',
    toleranceCents: terms.toleranceCents,
    autoSettle: terms.autoSettle,
  };
}

const percentOf = (text: string) => {
  if (text.trim() === '') return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
};

export function termsFromDraft(draft: SeriesTermsDraft): SeriesTerms {
  return {
    matchWindowDays: draft.matchWindowDays,
    lateFeePercent: percentOf(draft.lateFee),
    interestMonthPercent: percentOf(draft.interest),
    earlyDiscountPercent: percentOf(draft.discount),
    toleranceCents: draft.toleranceCents ?? 0,
    autoSettle: draft.autoSettle,
  };
}

/** Resumo de uma linha dos ajustes (gaveta do título, lista das obrigações). */
export function termsSummary(terms: SeriesTerms): string {
  const S = PL.termsShort;
  const parts = [
    terms.lateFeePercent ? S.lateFee(terms.lateFeePercent) : '',
    terms.interestMonthPercent ? S.interest(terms.interestMonthPercent) : '',
    terms.earlyDiscountPercent ? S.discount(terms.earlyDiscountPercent) : '',
    terms.toleranceCents ? S.tolerance(formatAccounting(terms.toleranceCents)) : '',
    terms.autoSettle ? S.autoSettle : '',
  ].filter(Boolean);
  if (parts.length === 0 && terms.matchWindowDays === DEFAULT_SERIES_TERMS.matchWindowDays) return PL.termsNone;
  return [...parts, S.window(terms.matchWindowDays)].join(' · ');
}

/** Os ajustes recolhidos num <details>, abertos se já houver algum ajuste. */
export function SeriesTermsFields({
  value,
  onChange,
  className = 'span-all',
}: {
  value: SeriesTermsDraft;
  onChange: (next: SeriesTermsDraft) => void;
  className?: string;
}) {
  const set = (patch: Partial<SeriesTermsDraft>) => onChange({ ...value, ...patch });
  const touched =
    value.lateFee !== '' || value.interest !== '' || value.discount !== '' || Boolean(value.toleranceCents) || value.autoSettle;
  return (
    <details className={className} open={touched || undefined} data-testid="series-terms">
      <summary className="cursor-pointer text-[13px] text-muted">{PL.terms}</summary>
      <p className="hint mt-1">{PL.termsHint}</p>
      <div className="form-grid cols-3 mt-2">
        <Field label={P.window} hint={P.windowHint}>
          <input
            className="field"
            type="number"
            min={0}
            max={45}
            value={value.matchWindowDays}
            onChange={(e) => set({ matchWindowDays: Math.max(0, Math.min(45, Number(e.target.value) || 0)) })}
            aria-label={P.window}
          />
        </Field>
        <Field label={P.lateFee}>
          <input
            className="field"
            type="number"
            min={0}
            max={20}
            step="0.01"
            value={value.lateFee}
            onChange={(e) => set({ lateFee: e.target.value })}
            aria-label={P.lateFee}
          />
        </Field>
        <Field label={P.interest}>
          <input
            className="field"
            type="number"
            min={0}
            max={10}
            step="0.01"
            value={value.interest}
            onChange={(e) => set({ interest: e.target.value })}
            aria-label={P.interest}
          />
        </Field>
        <Field label={P.discount}>
          <input
            className="field"
            type="number"
            min={0}
            max={50}
            step="0.01"
            value={value.discount}
            onChange={(e) => set({ discount: e.target.value })}
            aria-label={P.discount}
          />
        </Field>
        <Field label={P.tolerance} hint={P.toleranceHint}>
          <MoneyInput value={value.toleranceCents} onChange={(v) => set({ toleranceCents: v })} ariaLabel={P.tolerance} />
        </Field>
        <label className="check self-end" title={P.autoSettleHint}>
          <input type="checkbox" checked={value.autoSettle} onChange={(e) => set({ autoSettle: e.target.checked })} />
          {P.autoSettle}
        </label>
      </div>
    </details>
  );
}
