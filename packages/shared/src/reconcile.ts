/*
 * Casamento assistido de linhas de extrato (spec 009): valor exato, data ±3
 * dias e semelhança de descrição/entidade. Puro, sem acesso ao banco.
 */
import { diffDays } from './dates';
import { isValidCnpj, normalizeDocument } from './documents';

export type MatchLine = { postedOn: string; amountCents: number; description: string };

export type MatchCandidate = {
  /** card_charge: a ocorrência esperada de uma cobrança recorrente no cartão (spec 034), id = `<série>:<n>`. */
  kind: 'movement' | 'title' | 'card_item' | 'card_charge';
  id: string;
  date: string;
  /** Mesmo sinal, do ponto de vista do titular, que o da linha. */
  amountCents: number;
  description: string;
  entityName?: string | null;
  /** Ocorrência de série (specs 033 e 034): achada pela regra de reconhecimento da série, com a repartição da baixa. */
  series?: SeriesCandidateInfo;
};

/** A ocorrência de uma série como candidato de uma linha (specs 033 e 034). */
export type SeriesCandidateInfo = {
  ruleId: string;
  /** Contrato de que a série é obrigação, se for. */
  contractId: string | null;
  contractName: string | null;
  occurrence: number | null;
  /** Total de ocorrências (parcelamento) ou, nas parcelas antigas de contrato, o N do ciclo. */
  occurrencesTotal: number | null;
  dueDate: string;
  /** A conta prevista da ocorrência é a conta da linha (no cartão, sempre). */
  sameAccount: boolean;
  /** A série baixa sem confirmação (auto_settle). */
  autoSettle: boolean;
  split: SettlementSplit;
};

/**
 * `autoSettle`: a linha pode virar conciliada com a baixa sem confirmação
 * (specs 033 e 034): um único candidato, ocorrência de série com auto_settle,
 * na conta prevista, valor exato ou com encargos/desconto (nunca parcial nem só pela tolerância).
 */
export type MatchResult = { candidate: MatchCandidate; score: number; status: 'matched' | 'suggested'; autoSettle?: boolean };

export const MATCH_MAX_DAYS = 3;

/**
 * CNPJ (numérico ou alfanumérico), com ou sem pontuação, como token isolado:
 * 12.ABC.345/01DE-35, 12abc34501de35, 12.345.678/0001-95.
 */
const CNPJ_TOKEN = /(?<![0-9A-Za-z])[0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}\.?[0-9A-Za-z]{3}\/?[0-9A-Za-z]{4}-?[0-9]{2}(?![0-9A-Za-z])/g;

/**
 * Minúsculas, sem acentos e pontuação, sem CNPJ (numérico ou alfanumérico, com
 * DV válido), números longos (≥ 4 dígitos) nem datas dd/mm, espaços colapsados.
 * Usada no casamento e nas regras de classificação; o dedup das linhas usa
 * normalizeDescriptionForDedup, que não pode mudar.
 */
export function normalizeDescription(text: string): string {
  const withoutCnpj = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(CNPJ_TOKEN, (token) => (isValidCnpj(normalizeDocument(token)) ? ' ' : token));
  return normalizeDescriptionForDedup(withoutCnpj);
}

/**
 * Normalização CONGELADA do dedup_hash das linhas sem FITID (spec 009): mudar
 * esta função muda o hash das linhas já importadas e o reimport duplicaria.
 * Minúsculas, sem acentos e pontuação, sem números longos (≥ 4 dígitos) nem
 * datas dd/mm, espaços colapsados.
 */
export function normalizeDescriptionForDedup(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens com pelo menos 3 letras. */
const tokens = (text: string) =>
  normalizeDescription(text)
    .split(' ')
    .filter((t) => (t.match(/[a-z]/g)?.length ?? 0) >= 3);

/** Fração dos tokens de `a` (≥ 3 letras) presentes em `b`. 0 quando `a` não tem tokens. */
export function descriptionSimilarity(a: string, b: string): number {
  const ta = [...new Set(tokens(a))];
  if (!ta.length) return 0;
  const tb = new Set(normalizeDescription(b).split(' '));
  return ta.filter((t) => tb.has(t)).length / ta.length;
}

function candidateSimilarity(line: MatchLine, candidate: MatchCandidate): number {
  return descriptionSimilarity(line.description, `${candidate.description} ${candidate.entityName ?? ''}`);
}

/** null se o valor não for exatamente igual ou a data distar mais de 3 dias; senão 0–100. Ocorrência de série: seriesScore. */
export function scoreCandidate(line: MatchLine, candidate: MatchCandidate): number | null {
  if (candidate.series) return seriesScore(line, candidate);
  if (line.amountCents !== candidate.amountCents) return null;
  const days = Math.abs(diffDays(line.postedOn, candidate.date));
  if (days > MATCH_MAX_DAYS) return null;
  const score = 60 - 10 * days + 40 * candidateSimilarity(line, candidate);
  return Math.max(0, Math.min(100, Math.round(score)));
}

const KIND_ORDER: Record<MatchCandidate['kind'], number> = { movement: 0, card_item: 1, title: 2, card_charge: 3 };

/**
 * Melhor candidato para a linha, ou null. Título e cobrança esperada são
 * sempre 'suggested' (a ocorrência de série com auto_settle volta com
 * `autoSettle`). As ocorrências de série passam antes pelo desempate de
 * pickSeriesOccurrences.
 */
export function pickMatch(line: MatchLine, candidates: MatchCandidate[], used?: Set<string>): MatchResult | null {
  // A mesma ocorrência pode vir pela regra da série e pela de sempre (valor exato, ±3 dias): fica a da série.
  const seriesIds = new Set(candidates.filter((c) => c.series).map((c) => c.id));
  const free = pickSeriesOccurrences(
    line,
    candidates.filter((c) => !used?.has(c.id) && (c.series || c.kind !== 'title' || !seriesIds.has(c.id))),
  );
  const scored = free
    .map((candidate) => ({ candidate, score: scoreCandidate(line, candidate), days: Math.abs(diffDays(line.postedOn, candidate.date)) }))
    .filter((s): s is { candidate: MatchCandidate; score: number; days: number } => s.score !== null);
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score || a.days - b.days || KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind]);
  const best = scored[0]!;
  const sameKind = scored.filter((s) => s.candidate.kind === best.candidate.kind).length;
  const matched =
    (best.candidate.kind === 'movement' || best.candidate.kind === 'card_item') &&
    sameKind === 1 &&
    (best.days === 0 || candidateSimilarity(line, best.candidate) >= 0.5);
  const info = best.candidate.series;
  const autoSettle = scored.length === 1 && !!info && info.autoSettle && info.sameAccount && AUTO_SETTLE_KINDS.has(info.split.kind);
  return { candidate: best.candidate, score: best.score, status: matched ? 'matched' : 'suggested', ...(autoSettle ? { autoSettle } : {}) };
}

/* ---------------- reconhecimento pela série (specs 033 e 034) ---------------- */

/**
 * Ajustes de reconhecimento da série: só servem para reconhecer o valor pago
 * no extrato (nada é lançado por eles). Sem ajustes, a série casa no mesmo mês
 * ou na janela com valor exato.
 */
export type RecognitionTerms = {
  /** Multa por atraso (%) sobre o valor da ocorrência, uma vez. */
  lateFeePercent: number | null;
  /** Juros de mora (% ao mês) sobre o saldo, pró-rata por dia (mês = 30 dias). */
  interestMonthPercent: number | null;
  /** Desconto por pontualidade (%) sobre o saldo, até o vencimento. */
  earlyDiscountPercent: number | null;
  toleranceCents: number;
  matchWindowDays: number;
};

/** Ajustes da série com o "baixar sem confirmação". */
export type SeriesTerms = RecognitionTerms & { autoSettle: boolean };

/** Ajustes padrão de uma série nova (janela 15 dias, sem encargos). */
export const DEFAULT_SERIES_TERMS: SeriesTerms = {
  lateFeePercent: null,
  interestMonthPercent: null,
  earlyDiscountPercent: null,
  toleranceCents: 0,
  matchWindowDays: 15,
  autoSettle: false,
};

export type OccurrenceForMatch = {
  dueDate: string;
  /** Valor da ocorrência (a base da multa). */
  amountCents: number;
  /** Saldo em aberto. */
  openCents: number;
};

/** Como o valor pago bateu com a ocorrência. */
export type SplitKind = 'exact' | 'charges' | 'discount' | 'tolerance' | 'partial';

/** Repartição da baixa a partir da linha: principal + multa + juros − desconto = o valor da linha. */
export type SettlementSplit = {
  kind: SplitKind;
  amountCents: number;
  fineCents: number;
  interestCents: number;
  discountCents: number;
  /** Data da linha − vencimento: + atraso, − adiantamento, 0 no dia. */
  days: number;
};

const AUTO_SETTLE_KINDS = new Set<SplitKind>(['exact', 'charges', 'discount']);

/** Teto da tolerância: 10% do valor da ocorrência. */
export const toleranceCap = (amountCents: number) => Math.floor(amountCents / 10);

/** A data cai na janela da ocorrência: o mesmo mês do vencimento ou até `matchWindowDays` dias dele. */
export function inSeriesWindow(postedOn: string, dueDate: string, matchWindowDays: number): boolean {
  return postedOn.slice(0, 7) === dueDate.slice(0, 7) || Math.abs(diffDays(dueDate, postedOn)) <= matchWindowDays;
}

/** Encargos máximos (multa e juros) e desconto máximo na data. */
export function seriesCharges(occ: OccurrenceForMatch, terms: RecognitionTerms, postedOn: string) {
  const days = diffDays(occ.dueDate, postedOn);
  const late = days > 0;
  const maxFine = late && terms.lateFeePercent ? Math.round((occ.amountCents * terms.lateFeePercent) / 100) : 0;
  const maxInterest = late && terms.interestMonthPercent ? Math.round((occ.openCents * terms.interestMonthPercent * days) / 100 / 30) : 0;
  const maxDiscount = !late && terms.earlyDiscountPercent ? Math.round((occ.openCents * terms.earlyDiscountPercent) / 100) : 0;
  return { days, maxFine, maxInterest, maxDiscount };
}

/**
 * Repartição do valor pago (absoluto) sobre a ocorrência, ou null se ele não
 * bate: exato; com encargos (depois do vencimento, até saldo + multa + juros +
 * tolerância: o excedente vai para a multa até o máximo e o resto para os
 * juros); com desconto (até o vencimento, a partir de saldo − desconto −
 * tolerância); dentro da tolerância em qualquer data; ou parcial (menor que o
 * saldo). Não confere a janela (inSeriesWindow).
 */
export function splitSettlement(
  paidCents: number,
  occ: OccurrenceForMatch,
  terms: RecognitionTerms,
  postedOn: string,
): SettlementSplit | null {
  const open = occ.openCents;
  if (paidCents <= 0 || open <= 0) return null;
  const { days, maxFine, maxInterest, maxDiscount } = seriesCharges(occ, terms, postedOn);
  const tolerance = Math.min(Math.max(terms.toleranceCents, 0), toleranceCap(occ.amountCents));
  const base = { amountCents: open, fineCents: 0, interestCents: 0, discountCents: 0, days };
  if (paidCents === open) return { ...base, kind: 'exact' };
  if (paidCents > open) {
    const extra = paidCents - open;
    if (extra > maxFine + maxInterest + tolerance) return null;
    const fineCents = Math.min(extra, maxFine);
    return { ...base, kind: extra <= maxFine + maxInterest ? 'charges' : 'tolerance', fineCents, interestCents: extra - fineCents };
  }
  const missing = open - paidCents;
  if (missing <= maxDiscount + tolerance) {
    return { ...base, kind: missing <= maxDiscount ? 'discount' : 'tolerance', discountCents: missing };
  }
  return { ...base, kind: 'partial', amountCents: paidCents };
}

/** Uma ocorrência em aberto (ou parcial) de série para a regra de reconhecimento. */
export type SeriesOccurrenceRow = OccurrenceForMatch & {
  titleId: string;
  ruleId: string;
  contractId: string | null;
  contractName: string | null;
  occurrence: number | null;
  occurrencesTotal: number | null;
  description: string;
  entityName: string | null;
  plannedAccountId: string | null;
  terms: SeriesTerms;
};

/**
 * A ocorrência como candidato da linha, ou null: na janela da série e com o
 * valor batendo (splitSettlement). `accountId` é a conta da linha.
 */
export function seriesMatch(line: MatchLine & { accountId: string | null }, occ: SeriesOccurrenceRow): MatchCandidate | null {
  if (!inSeriesWindow(line.postedOn, occ.dueDate, occ.terms.matchWindowDays)) return null;
  const split = splitSettlement(Math.abs(line.amountCents), occ, occ.terms, line.postedOn);
  if (!split) return null;
  return {
    kind: 'title',
    id: occ.titleId,
    date: occ.dueDate,
    amountCents: line.amountCents,
    description: occ.description,
    entityName: occ.entityName,
    series: {
      ruleId: occ.ruleId,
      contractId: occ.contractId,
      contractName: occ.contractName,
      occurrence: occ.occurrence,
      occurrencesTotal: occ.occurrencesTotal,
      dueDate: occ.dueDate,
      sameAccount: !!line.accountId && occ.plannedAccountId === line.accountId,
      autoSettle: occ.terms.autoSettle,
      split,
    },
  };
}

/** Uma ocorrência esperada de cobrança no cartão (spec 034), ainda sem compra ligada. */
export type CardChargeOccurrence = {
  ruleId: string;
  occurrence: number;
  dueDate: string;
  /** Valor esperado da ocorrência. */
  amountCents: number;
  description: string;
  entityName: string | null;
  contractId: string | null;
  contractName: string | null;
  terms: SeriesTerms;
};

/**
 * A ocorrência esperada como candidato da linha da fatura, ou null: a mesma
 * regra, sem encargos (só valor exato ou a tolerância) e nunca parcial.
 */
export function cardChargeMatch(line: MatchLine, occ: CardChargeOccurrence): MatchCandidate | null {
  if (line.amountCents >= 0) return null;
  if (!inSeriesWindow(line.postedOn, occ.dueDate, occ.terms.matchWindowDays)) return null;
  const terms: RecognitionTerms = { ...occ.terms, lateFeePercent: null, interestMonthPercent: null, earlyDiscountPercent: null };
  const split = splitSettlement(
    Math.abs(line.amountCents),
    { dueDate: occ.dueDate, amountCents: occ.amountCents, openCents: occ.amountCents },
    terms,
    line.postedOn,
  );
  if (!split || split.kind === 'partial') return null;
  return {
    kind: 'card_charge',
    id: `${occ.ruleId}:${occ.occurrence}`,
    date: occ.dueDate,
    amountCents: line.amountCents,
    description: occ.description,
    entityName: occ.entityName,
    series: {
      ruleId: occ.ruleId,
      contractId: occ.contractId,
      contractName: occ.contractName,
      occurrence: occ.occurrence,
      occurrencesTotal: null,
      dueDate: occ.dueDate,
      sameAccount: true,
      autoSettle: occ.terms.autoSettle,
      split: { ...split, amountCents: Math.abs(line.amountCents), fineCents: 0, interestCents: 0, discountCents: 0 },
    },
  };
}

/**
 * Desempate das ocorrências de uma mesma série (o aluguel igual todo mês):
 * fica uma por série. Primeiro as que batem sem ser parcial; entre elas, a do
 * mesmo mês da linha e, sem ela (já paga), a mais antiga em aberto (o atraso
 * paga a mais velha antes). A parcial só entra quando nenhuma outra da série
 * bate, a mais próxima do mês da linha. Os demais candidatos passam como estão.
 */
export function pickSeriesOccurrences(line: MatchLine, candidates: MatchCandidate[]): MatchCandidate[] {
  const byRule = new Map<string, MatchCandidate[]>();
  const rest: MatchCandidate[] = [];
  for (const c of candidates) {
    if (!c.series) {
      rest.push(c);
      continue;
    }
    const list = byRule.get(c.series.ruleId) ?? [];
    list.push(c);
    byRule.set(c.series.ruleId, list);
  }
  const month = line.postedOn.slice(0, 7);
  const chosen: MatchCandidate[] = [];
  for (const list of byRule.values()) {
    const full = list.filter((c) => c.series!.split.kind !== 'partial');
    const pool = full.length ? full : list;
    const byDue = [...pool].sort((a, b) => a.series!.dueDate.localeCompare(b.series!.dueDate));
    const sameMonth = byDue.find((c) => c.series!.dueDate.slice(0, 7) === month);
    if (full.length) chosen.push(sameMonth ?? byDue[0]!);
    else
      chosen.push(
        sameMonth ??
          [...byDue].sort(
            (a, b) => Math.abs(diffDays(a.series!.dueDate, line.postedOn)) - Math.abs(diffDays(b.series!.dueDate, line.postedOn)),
          )[0]!,
      );
  }
  return [...rest, ...chosen];
}

/**
 * Pontuação da ocorrência de série (0–100): proximidade do vencimento (o
 * mesmo mês conta como perto), descrição/entidade e o bônus da conta prevista
 * igual à da linha; a parcial perde pontos.
 */
function seriesScore(line: MatchLine, candidate: MatchCandidate): number {
  const info = candidate.series!;
  const days = Math.abs(info.split.days);
  const near = line.postedOn.slice(0, 7) === info.dueDate.slice(0, 7) ? Math.min(days, 10) : days;
  let score = 60 - 2 * near + 30 * candidateSimilarity(line, candidate);
  if (info.sameAccount) score += 10;
  if (info.split.kind === 'partial') score -= 20;
  return Math.max(1, Math.min(100, Math.round(score)));
}
