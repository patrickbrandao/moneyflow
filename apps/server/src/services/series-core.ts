import type { Executor } from '@moneyflow/db';
import { formatBRL, type RecurrenceRuleDto, type SeriesTerms, t, toleranceCap } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { unprocessable } from '../errors';

/*
 * O básico das séries (specs 005 e 034) usado pelos títulos, pelas
 * obrigações dos contratos e pela conciliação: os ajustes de reconhecimento do
 * pagamento guardados na série e o DTO da regra.
 */

type TermsRow = {
  match_window_days: number | string;
  late_fee_percent: number | string | null;
  interest_month_percent: number | string | null;
  early_discount_percent: number | string | null;
  tolerance_cents: number | string;
  auto_settle: boolean;
};

const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));

/** Os ajustes de uma linha de recurrence_rules (colunas em snake_case). */
export const termsOf = (row: TermsRow): SeriesTerms => ({
  matchWindowDays: Number(row.match_window_days),
  lateFeePercent: num(row.late_fee_percent),
  interestMonthPercent: num(row.interest_month_percent),
  earlyDiscountPercent: num(row.early_discount_percent),
  toleranceCents: Number(row.tolerance_cents),
  autoSettle: Boolean(row.auto_settle),
});

/** Colunas dos ajustes da série `r`, para os SELECTs (termsOf lê o resultado). */
export const TERMS_SQL = sql`r.match_window_days, r.late_fee_percent, r.interest_month_percent, r.early_discount_percent,
  r.tolerance_cents, r.auto_settle`;

const pct = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : String(v));

/** Os ajustes pedidos como colunas do Drizzle (os omitidos ficam de fora: valem os padrões do banco). */
export function termsColumns(terms: Partial<SeriesTerms>) {
  const out: {
    matchWindowDays?: number;
    lateFeePercent?: string | null;
    interestMonthPercent?: string | null;
    earlyDiscountPercent?: string | null;
    toleranceCents?: number;
    autoSettle?: boolean;
  } = {};
  if (terms.matchWindowDays !== undefined) out.matchWindowDays = terms.matchWindowDays;
  if (terms.lateFeePercent !== undefined) out.lateFeePercent = pct(terms.lateFeePercent);
  if (terms.interestMonthPercent !== undefined) out.interestMonthPercent = pct(terms.interestMonthPercent);
  if (terms.earlyDiscountPercent !== undefined) out.earlyDiscountPercent = pct(terms.earlyDiscountPercent);
  if (terms.toleranceCents !== undefined) out.toleranceCents = terms.toleranceCents;
  if (terms.autoSettle !== undefined) out.autoSettle = terms.autoSettle;
  return out;
}

/** Teto da tolerância (spec 034): 10% do valor da ocorrência. O banco só confere que não é negativa. */
export function assertTolerance(toleranceCents: number | undefined | null, amountCents: number) {
  if (!toleranceCents) return;
  const cap = toleranceCap(amountCents);
  if (toleranceCents > cap) throw unprocessable(t.contracts.errors.toleranceCap(formatBRL(cap)), 'recurrence_rules_tolerance_cents_check');
}

/** A regra com o contrato e os ajustes, para o detalhe do título. */
export async function ruleDto(db: Executor, ruleId: string): Promise<RecurrenceRuleDto | null> {
  const result = await db.execute<
    TermsRow & {
      id: string;
      frequency: RecurrenceRuleDto['frequency'];
      interval_count: number;
      anchor_day: number;
      starts_on: string;
      ends_on: string | null;
      installments_total: number | null;
      caixa_id: string;
      contract_id: string | null;
      contract_name: string | null;
    }
  >(sql`
    SELECT r.id, r.frequency, r.interval_count, r.anchor_day, r.starts_on, r.ends_on, r.installments_total, r.caixa_id,
           r.contract_id, k.name AS contract_name, ${TERMS_SQL}
      FROM recurrence_rules r LEFT JOIN contracts k ON k.id = r.contract_id
     WHERE r.id = ${ruleId}`);
  const r = result.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    frequency: r.frequency,
    intervalCount: Number(r.interval_count),
    anchorDay: Number(r.anchor_day),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    installmentsTotal: r.installments_total === null ? null : Number(r.installments_total),
    caixaId: r.caixa_id,
    contractId: r.contract_id,
    contractName: r.contract_name,
    terms: termsOf(r),
  };
}
