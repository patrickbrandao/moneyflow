import { ptBR } from './i18n/pt-BR';
import { formatAccounting } from './money';
import { DEFAULT_SERIES_TERMS, type SeriesTerms } from './reconcile';

/*
 * Ajustes de reconhecimento do pagamento de uma série (spec 034) no
 * formulário: um só rascunho, uma só leitura dos percentuais e um só resumo,
 * usados no contrato (obrigação nova e edição da série), no título (série nova)
 * e na gaveta do título (tarefa 181).
 */

/** Tetos dos ajustes: os mesmos do schema (`seriesTermsFields`) e das CHECKs do banco. */
export const SERIES_TERMS_LIMITS = {
  matchWindowDays: 45,
  lateFeePercent: 20,
  interestMonthPercent: 10,
  earlyDiscountPercent: 50,
} as const;

/** Rascunho do formulário: os percentuais como texto (vazio = sem). */
export type SeriesTermsDraft = {
  matchWindowDays: number;
  lateFee: string;
  interest: string;
  discount: string;
  toleranceCents: number | null;
  autoSettle: boolean;
};

/** Os campos percentuais do rascunho. */
export type SeriesTermsPercentField = 'lateFee' | 'interest' | 'discount';

const PERCENT_LIMIT: Record<SeriesTermsPercentField, number> = {
  lateFee: SERIES_TERMS_LIMITS.lateFeePercent,
  interest: SERIES_TERMS_LIMITS.interestMonthPercent,
  discount: SERIES_TERMS_LIMITS.earlyDiscountPercent,
};

/** Percentual no formato do Brasil: 2,5 (sem zeros à direita). */
export function formatPercentNumber(value: number): string {
  return String(Math.round(value * 10000) / 10000).replace('.', ',');
}

export function seriesTermsDraft(terms: SeriesTerms = DEFAULT_SERIES_TERMS): SeriesTermsDraft {
  const text = (v: number | null) => (v === null || v === undefined ? '' : formatPercentNumber(v));
  return {
    matchWindowDays: terms.matchWindowDays,
    lateFee: text(terms.lateFeePercent),
    interest: text(terms.interestMonthPercent),
    discount: text(terms.earlyDiscountPercent),
    toleranceCents: terms.toleranceCents,
    autoSettle: terms.autoSettle,
  };
}

/**
 * Lê um percentual digitado. Aceita "2", "2,5", "2.5", "2%" e espaços (e o
 * sinal de menos quando `min` é negativo, como no reajuste do aditivo); vazio
 * ou zero = sem. Fora do número ou da faixa devolve o erro: nunca vira "sem"
 * calado (tarefa 181).
 */
export function parsePercent(text: string, max: number, min = 0): { value: number | null; error: null } | { value: null; error: string } {
  const P = ptBR.contracts.payment;
  const clean = text.replace(/\s+/g, '').replace(/%$/, '').replace('−', '-');
  if (clean === '') return { value: null, error: null };
  const pattern = min < 0 ? /^-?\d+([.,]\d+)?$/ : /^\d+([.,]\d+)?$/;
  if (!pattern.test(clean)) return { value: null, error: P.percentInvalid };
  const value = Number(clean.replace(',', '.'));
  if (!Number.isFinite(value)) return { value: null, error: P.percentInvalid };
  if (value > max || value < min)
    return {
      value: null,
      error: min < 0 ? P.percentRange(formatPercentNumber(min), formatPercentNumber(max)) : P.percentMax(formatPercentNumber(max)),
    };
  return { value: value === 0 ? null : value, error: null };
}

/** Erro de um campo percentual do rascunho (null = válido). */
export function seriesTermsFieldError(draft: SeriesTermsDraft, field: SeriesTermsPercentField): string | null {
  return parsePercent(draft[field], PERCENT_LIMIT[field]).error;
}

const FIELD_LABEL: Record<SeriesTermsPercentField, string> = {
  lateFee: ptBR.contracts.payment.lateFee,
  interest: ptBR.contracts.payment.interest,
  discount: ptBR.contracts.payment.discount,
};

/**
 * O rascunho como os ajustes da API, ou o primeiro erro ("Multa por atraso
 * (%): informe um número…") para o formulário mostrar e não enviar.
 */
export function seriesTermsFromDraft(draft: SeriesTermsDraft): { terms: SeriesTerms; error: null } | { terms: null; error: string } {
  const values = {} as Record<SeriesTermsPercentField, number | null>;
  for (const field of ['lateFee', 'interest', 'discount'] as const) {
    const parsed = parsePercent(draft[field], PERCENT_LIMIT[field]);
    if (parsed.error) return { terms: null, error: `${FIELD_LABEL[field]}: ${parsed.error}` };
    values[field] = parsed.value;
  }
  const window = Math.trunc(draft.matchWindowDays);
  if (!Number.isFinite(window) || window < 0 || window > SERIES_TERMS_LIMITS.matchWindowDays)
    return {
      terms: null,
      error: `${ptBR.contracts.payment.window}: ${ptBR.contracts.payment.windowMax(SERIES_TERMS_LIMITS.matchWindowDays)}`,
    };
  return {
    terms: {
      matchWindowDays: window,
      lateFeePercent: values.lateFee,
      interestMonthPercent: values.interest,
      earlyDiscountPercent: values.discount,
      toleranceCents: draft.toleranceCents ?? 0,
      autoSettle: draft.autoSettle,
    },
    error: null,
  };
}

/** Algum ajuste além do padrão (o editor abre já expandido). */
export function seriesTermsTouched(draft: SeriesTermsDraft): boolean {
  return (
    draft.lateFee.trim() !== '' ||
    draft.interest.trim() !== '' ||
    draft.discount.trim() !== '' ||
    Boolean(draft.toleranceCents) ||
    draft.autoSettle ||
    draft.matchWindowDays !== DEFAULT_SERIES_TERMS.matchWindowDays
  );
}

/** Resumo de uma linha dos ajustes ("multa 2% · juros 1% a.m. · janela 15 d"), o mesmo no contrato e no título. */
export function seriesTermsSummary(terms: SeriesTerms): string {
  const S = ptBR.contracts.planned.termsShort;
  const parts = [
    terms.lateFeePercent ? S.lateFee(formatPercentNumber(terms.lateFeePercent)) : '',
    terms.interestMonthPercent ? S.interest(formatPercentNumber(terms.interestMonthPercent)) : '',
    terms.earlyDiscountPercent ? S.discount(formatPercentNumber(terms.earlyDiscountPercent)) : '',
    terms.toleranceCents ? S.tolerance(formatAccounting(terms.toleranceCents)) : '',
    terms.autoSettle ? S.autoSettle : '',
  ].filter(Boolean);
  if (parts.length === 0 && terms.matchWindowDays === DEFAULT_SERIES_TERMS.matchWindowDays) return ptBR.contracts.planned.termsNone;
  return [...parts, S.window(terms.matchWindowDays)].join(' · ');
}
