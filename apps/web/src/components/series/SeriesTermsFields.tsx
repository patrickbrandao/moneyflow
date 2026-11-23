import {
  SERIES_TERMS_LIMITS,
  type SeriesTermsDraft,
  type SeriesTermsPercentField,
  seriesTermsFieldError,
  seriesTermsTouched,
  t,
} from '@moneyflow/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { MoneyInput } from '../forms';
import { Field } from '../ui';

/*
 * O editor único dos ajustes de reconhecimento do pagamento de uma série
 * (spec 034, tarefa 181): janela, multa, juros, desconto, tolerância e "baixar
 * sem confirmação". Usado na obrigação nova do contrato, na edição da série e
 * na série nova do título. Só servem para a conciliação reconhecer o valor
 * pago; nada é lançado por eles. O rascunho, a leitura dos percentuais (que
 * aceita "2%" e "2,5" e mostra o erro em vez de descartar) e o resumo ficam no
 * shared (`series-terms.ts`).
 */

const P = t.contracts.payment;
const PL = t.contracts.planned;

function PercentField({
  draft,
  field,
  label,
  onChange,
}: {
  draft: SeriesTermsDraft;
  field: SeriesTermsPercentField;
  label: string;
  onChange: (text: string) => void;
}) {
  const error = seriesTermsFieldError(draft, field);
  return (
    <Field label={label} hint={error ? <span className="text-danger">{error}</span> : undefined}>
      <input
        className="field field-mono"
        inputMode="decimal"
        value={draft[field]}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        aria-invalid={error ? true : undefined}
      />
    </Field>
  );
}

/** Os ajustes recolhidos atrás de um botão, abertos se a série já tiver algum. */
export function SeriesTermsFields({
  value,
  onChange,
  className = 'span-all',
  testId = 'series-terms',
}: {
  value: SeriesTermsDraft;
  onChange: (next: SeriesTermsDraft) => void;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(() => seriesTermsTouched(value));
  const panel = useId();
  const set = (patch: Partial<SeriesTermsDraft>) => onChange({ ...value, ...patch });
  return (
    <div className={className} data-testid={testId}>
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown /> : <ChevronRight />} {PL.terms}
      </button>
      {open && (
        <div id={panel} className="form-grid cols-2 mt-2">
          <p className="hint span-all !mt-0">{PL.termsHint}</p>
          <Field label={P.window} hint={P.windowHint}>
            <input
              className="field"
              type="number"
              min={0}
              max={SERIES_TERMS_LIMITS.matchWindowDays}
              value={value.matchWindowDays}
              onChange={(e) =>
                set({
                  matchWindowDays: Math.max(0, Math.min(SERIES_TERMS_LIMITS.matchWindowDays, Math.trunc(Number(e.target.value)) || 0)),
                })
              }
              aria-label={P.window}
            />
          </Field>
          <Field label={P.tolerance} hint={P.toleranceHint}>
            <MoneyInput value={value.toleranceCents} onChange={(v) => set({ toleranceCents: v })} ariaLabel={P.tolerance} />
          </Field>
          <PercentField draft={value} field="lateFee" label={P.lateFee} onChange={(lateFee) => set({ lateFee })} />
          <PercentField draft={value} field="interest" label={P.interest} onChange={(interest) => set({ interest })} />
          <PercentField draft={value} field="discount" label={P.discount} onChange={(discount) => set({ discount })} />
          <label className="check span-all">
            <input
              type="checkbox"
              checked={value.autoSettle}
              onChange={(e) => set({ autoSettle: e.target.checked })}
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
