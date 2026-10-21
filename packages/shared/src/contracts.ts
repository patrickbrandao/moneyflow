import { addDays, addMonths, dayOfMonth, daysInMonth, diffDays, toIso } from './dates';
import { type Frequency, monthsStep } from './recurrence';

/*
 * Contratos (specs 020 e 034): o contrato é o documento e o vínculo; as
 * obrigações são séries recorrentes comuns (spec 005). Aqui ficam as contas
 * puras (sem banco) da vigência, da rescisão e do reajuste, usadas pela API,
 * pelo front e pelos testes.
 */

export const CONTRACT_DIRECTIONS = ['receivable', 'payable'] as const;
export const CONTRACT_STATUSES = ['draft', 'active', 'ended', 'terminated'] as const;
/** Periodicidade dos ciclos de parcelas de antes da F20 (histórico) e da leitura do PDF por IA. */
export const CONTRACT_PERIODICITIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'single'] as const;
export const READJUSTMENT_INDEXES = ['none', 'ipca', 'igpm', 'inpc', 'other'] as const;
export const CONTRACT_DOCUMENT_KINDS = ['contract', 'amendment', 'renewal', 'termination', 'proposal', 'other'] as const;
export const CONTRACT_DOCUMENT_FORMATS = ['pdf', 'markdown'] as const;
/** Onde a obrigação vive: uma conta (série de títulos) ou um cartão (cobrança esperada). */
export const OBLIGATION_KINDS = ['account', 'card'] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type ContractPeriodicity = (typeof CONTRACT_PERIODICITIES)[number];
export type ReadjustmentIndex = (typeof READJUSTMENT_INDEXES)[number];
export type ContractDocumentKind = (typeof CONTRACT_DOCUMENT_KINDS)[number];
export type ContractDocumentFormat = (typeof CONTRACT_DOCUMENT_FORMATS)[number];
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

/** Markdown enviado ou salvo: até 1 MB em UTF-8. */
export const CONTRACT_MARKDOWN_MAX_BYTES = 1024 * 1024;

/** Calendário de uma série para a periodicidade lida do PDF (mensal 1, trimestral 3, semestral 6 meses, anual). */
export function periodicityCalendar(periodicity: ContractPeriodicity): { frequency: Frequency; intervalCount: number } | null {
  switch (periodicity) {
    case 'monthly':
      return { frequency: 'monthly', intervalCount: 1 };
    case 'quarterly':
      return { frequency: 'monthly', intervalCount: 3 };
    case 'semiannual':
      return { frequency: 'monthly', intervalCount: 6 };
    case 'annual':
      return { frequency: 'yearly', intervalCount: 1 };
    default:
      return null;
  }
}

/**
 * Fim de uma vigência: dia anterior ao mesmo dia do mês, `meses` depois
 * (01/03/2025 + 12 → 28/02/2026). Se esse dia não existe no mês final, vai
 * até o último dia dele (31/01 + 1 → 28/02; a seguinte começa em 01/03).
 */
export function cycleEnd(startsOn: string, months: number): string {
  const same = addMonths(startsOn, months);
  return dayOfMonth(same) < dayOfMonth(startsOn) ? same : addDays(same, -1);
}

/**
 * Duração em meses inteiros de uma vigência (início ao fim, inclusive), para
 * a renovação automática repetir o prazo; no mínimo 1.
 */
export function termMonths(startsOn: string, endsOn: string): number {
  const next = addDays(endsOn, 1);
  const months = (Number(next.slice(0, 4)) - Number(startsOn.slice(0, 4))) * 12 + Number(next.slice(5, 7)) - Number(startsOn.slice(5, 7));
  return Math.max(1, dayOfMonth(next) < dayOfMonth(startsOn) ? months - 1 : months);
}

/** Fim do período coberto pela ocorrência que começa em `competenceDate` (o dia antes da próxima competência). */
export function occurrencePeriodEnd(competenceDate: string, rule: { frequency: Frequency; intervalCount: number }): string {
  if (rule.frequency === 'weekly') return addDays(competenceDate, 7 * rule.intervalCount - 1);
  return addDays(addMonths(competenceDate, monthsStep(rule)), -1);
}

/** Valor proporcional da ocorrência até a data de encerramento (inclusive), arredondado ao centavo. */
export function proratedAmount(amountCents: number, competenceDate: string, periodEnd: string, endOn: string): number {
  if (endOn < competenceDate) return 0;
  if (endOn >= periodEnd) return amountCents;
  const total = diffDays(competenceDate, periodEnd) + 1;
  const covered = diffDays(competenceDate, endOn) + 1;
  return Math.round((amountCents * covered) / total);
}

/** Reajuste em % sobre um valor (5.000,00 × 1,045 = 5.225,00). */
export const readjustedTotal = (amountCents: number, percent: number) => Math.round(amountCents * (1 + percent / 100));

/** Último dia para pedir a não renovação ou a rescisão: fim − aviso prévio. */
export const noticeDeadline = (endsOn: string, noticeDays: number) => addDays(endsOn, -noticeDays);

/**
 * Data-base do reajuste no ano de `today` (a informada, ou o aniversário do
 * contrato): devolve a data se ela cai depois do início do contrato.
 */
export function readjustmentDateIn(year: number, contractStart: string, baseDate: string | null): string | null {
  const base = baseDate ?? contractStart;
  const month = Number(base.slice(5, 7));
  const day = Math.min(dayOfMonth(base), daysInMonth(year, month));
  const date = toIso(year, month, day);
  return date > contractStart ? date : null;
}

/** Sufixo " · n/N" das parcelas geradas antes da F20: a ocorrência nova da série não o repete. */
export const stripInstallmentSuffix = (description: string) => description.replace(/\s+·\s+\d+\/\d+\s*$/, '');

/** Rótulo do contrato num título (avisos e listas); n/N só nas parcelas antigas. */
export const contractInstallmentLabel = (name: string, n: number | null, total: number | null) =>
  n && total ? `${name} (${n}/${total})` : name;

/** Contrato termina dentro de `days` dias a partir de hoje (inclusive)? */
export const endsWithin = (endsOn: string, today: string, days: number) => endsOn >= today && diffDays(today, endsOn) <= days;
