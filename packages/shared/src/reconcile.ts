/*
 * Casamento assistido de linhas de extrato (spec 009): valor exato, data ±3
 * dias e semelhança de descrição/entidade. Puro, sem acesso ao banco.
 */
import { diffDays } from './dates';
import { isValidCnpj, normalizeDocument } from './documents';

export type MatchLine = { postedOn: string; amountCents: number; description: string };

export type MatchCandidate = {
  kind: 'movement' | 'title' | 'card_item';
  id: string;
  date: string;
  /** Mesmo sinal, do ponto de vista do titular, que o da linha. */
  amountCents: number;
  description: string;
  entityName?: string | null;
  /** Parcela de contrato (spec 033): achada pela regra do contrato, com a repartição da baixa. */
  contract?: ContractCandidateInfo;
};

/** A parcela de contrato como candidato de uma linha (spec 033). */
export type ContractCandidateInfo = {
  contractId: string;
  contractName: string;
  installment: number | null;
  installmentsCount: number | null;
  dueDate: string;
  /** A conta prevista da parcela é a conta da linha. */
  sameAccount: boolean;
  /** O contrato baixa sem confirmação (auto_settle). */
  autoSettle: boolean;
  split: SettlementSplit;
};

/**
 * `autoSettle`: a linha pode virar conciliada com a baixa sem confirmação
 * (spec 033): um único candidato, parcela de contrato com auto_settle, na conta
 * prevista, valor exato ou com encargos/desconto (nunca parcial nem só pela tolerância).
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

/** null se o valor não for exatamente igual ou a data distar mais de 3 dias; senão 0–100. Parcela de contrato: contractScore. */
export function scoreCandidate(line: MatchLine, candidate: MatchCandidate): number | null {
  if (candidate.contract) return contractScore(line, candidate);
  if (line.amountCents !== candidate.amountCents) return null;
  const days = Math.abs(diffDays(line.postedOn, candidate.date));
  if (days > MATCH_MAX_DAYS) return null;
  const score = 60 - 10 * days + 40 * candidateSimilarity(line, candidate);
  return Math.max(0, Math.min(100, Math.round(score)));
}

const KIND_ORDER: Record<MatchCandidate['kind'], number> = { movement: 0, card_item: 1, title: 2 };

/**
 * Melhor candidato para a linha, ou null. Título é sempre 'suggested' (a
 * parcela de contrato com auto_settle volta com `autoSettle`). As parcelas de
 * contrato passam antes pelo desempate de pickContractInstallments.
 */
export function pickMatch(line: MatchLine, candidates: MatchCandidate[], used?: Set<string>): MatchResult | null {
  // A mesma parcela pode vir pela regra do contrato e pela de sempre (valor exato, ±3 dias): fica a do contrato.
  const contractIds = new Set(candidates.filter((c) => c.contract).map((c) => c.id));
  const free = pickContractInstallments(
    line,
    candidates.filter((c) => !used?.has(c.id) && (c.contract || c.kind !== 'title' || !contractIds.has(c.id))),
  );
  const scored = free
    .map((candidate) => ({ candidate, score: scoreCandidate(line, candidate), days: Math.abs(diffDays(line.postedOn, candidate.date)) }))
    .filter((s): s is { candidate: MatchCandidate; score: number; days: number } => s.score !== null);
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score || a.days - b.days || KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind]);
  const best = scored[0]!;
  const sameKind = scored.filter((s) => s.candidate.kind === best.candidate.kind).length;
  const matched =
    best.candidate.kind !== 'title' && sameKind === 1 && (best.days === 0 || candidateSimilarity(line, best.candidate) >= 0.5);
  const info = best.candidate.contract;
  const autoSettle = scored.length === 1 && !!info && info.autoSettle && info.sameAccount && AUTO_SETTLE_KINDS.has(info.split.kind);
  return { candidate: best.candidate, score: best.score, status: matched ? 'matched' : 'suggested', ...(autoSettle ? { autoSettle } : {}) };
}

/* ---------------- parcelas de contrato (spec 033) ---------------- */

/** Encargos e janela do contrato, só para reconhecer o valor pago (nada é lançado por eles). */
export type ContractTerms = {
  /** Multa por atraso (%) sobre o valor da parcela, uma vez. */
  lateFeePercent: number | null;
  /** Juros de mora (% ao mês) sobre o saldo, pró-rata por dia (mês = 30 dias). */
  interestMonthPercent: number | null;
  /** Desconto por pontualidade (%) sobre o saldo, até o vencimento. */
  earlyDiscountPercent: number | null;
  toleranceCents: number;
  matchWindowDays: number;
};

export type InstallmentForMatch = {
  dueDate: string;
  /** Valor da parcela (a base da multa). */
  amountCents: number;
  /** Saldo em aberto. */
  openCents: number;
};

/** Como o valor pago bateu com a parcela. */
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

/** Teto da tolerância (spec 033): 10% da parcela. */
export const toleranceCap = (installmentCents: number) => Math.floor(installmentCents / 10);

/** A data cai na janela da parcela: o mesmo mês do vencimento ou até `matchWindowDays` dias dele. */
export function inContractWindow(postedOn: string, dueDate: string, matchWindowDays: number): boolean {
  return postedOn.slice(0, 7) === dueDate.slice(0, 7) || Math.abs(diffDays(dueDate, postedOn)) <= matchWindowDays;
}

/** Encargos máximos (multa e juros) e desconto máximo na data. */
export function contractCharges(inst: InstallmentForMatch, terms: ContractTerms, postedOn: string) {
  const days = diffDays(inst.dueDate, postedOn);
  const late = days > 0;
  const maxFine = late && terms.lateFeePercent ? Math.round((inst.amountCents * terms.lateFeePercent) / 100) : 0;
  const maxInterest = late && terms.interestMonthPercent ? Math.round((inst.openCents * terms.interestMonthPercent * days) / 100 / 30) : 0;
  const maxDiscount = !late && terms.earlyDiscountPercent ? Math.round((inst.openCents * terms.earlyDiscountPercent) / 100) : 0;
  return { days, maxFine, maxInterest, maxDiscount };
}

/**
 * Repartição do valor pago (absoluto) sobre a parcela, ou null se ele não bate
 * (spec 033): exato; com encargos (depois do vencimento, até saldo + multa +
 * juros + tolerância: o excedente vai para a multa até o máximo e o resto para
 * os juros); com desconto (até o vencimento, a partir de saldo − desconto −
 * tolerância); dentro da tolerância em qualquer data; ou parcial (menor que o
 * saldo). Não confere a janela (inContractWindow).
 */
export function splitSettlement(
  paidCents: number,
  inst: InstallmentForMatch,
  terms: ContractTerms,
  postedOn: string,
): SettlementSplit | null {
  const open = inst.openCents;
  if (paidCents <= 0 || open <= 0) return null;
  const { days, maxFine, maxInterest, maxDiscount } = contractCharges(inst, terms, postedOn);
  const tolerance = Math.min(Math.max(terms.toleranceCents, 0), toleranceCap(inst.amountCents));
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

/** Uma parcela em aberto (ou parcial) para a regra de candidato do contrato. */
export type ContractInstallmentRow = InstallmentForMatch & {
  titleId: string;
  contractId: string;
  contractName: string;
  installment: number | null;
  installmentsCount: number | null;
  description: string;
  entityName: string | null;
  plannedAccountId: string | null;
  autoSettle: boolean;
  terms: ContractTerms;
};

/**
 * A parcela como candidato da linha, ou null (spec 033): na janela do contrato
 * e com o valor batendo (splitSettlement). `accountId` é a conta da linha.
 */
export function contractMatch(line: MatchLine & { accountId: string | null }, inst: ContractInstallmentRow): MatchCandidate | null {
  if (!inContractWindow(line.postedOn, inst.dueDate, inst.terms.matchWindowDays)) return null;
  const split = splitSettlement(Math.abs(line.amountCents), inst, inst.terms, line.postedOn);
  if (!split) return null;
  return {
    kind: 'title',
    id: inst.titleId,
    date: inst.dueDate,
    amountCents: line.amountCents,
    description: inst.description,
    entityName: inst.entityName,
    contract: {
      contractId: inst.contractId,
      contractName: inst.contractName,
      installment: inst.installment,
      installmentsCount: inst.installmentsCount,
      dueDate: inst.dueDate,
      sameAccount: !!line.accountId && inst.plannedAccountId === line.accountId,
      autoSettle: inst.autoSettle,
      split,
    },
  };
}

/**
 * Desempate das parcelas de um mesmo contrato (spec 033): fica uma por
 * contrato. Primeiro as que batem sem ser parcial; entre elas, a do mesmo mês
 * da linha e, sem ela (já paga), a mais antiga em aberto (o atraso paga a mais
 * velha antes). A parcial só entra quando nenhuma outra do contrato bate, a
 * mais próxima do mês da linha. Os demais candidatos passam como estão.
 */
export function pickContractInstallments(line: MatchLine, candidates: MatchCandidate[]): MatchCandidate[] {
  const byContract = new Map<string, MatchCandidate[]>();
  const rest: MatchCandidate[] = [];
  for (const c of candidates) {
    if (!c.contract) {
      rest.push(c);
      continue;
    }
    const list = byContract.get(c.contract.contractId) ?? [];
    list.push(c);
    byContract.set(c.contract.contractId, list);
  }
  const month = line.postedOn.slice(0, 7);
  const chosen: MatchCandidate[] = [];
  for (const list of byContract.values()) {
    const full = list.filter((c) => c.contract!.split.kind !== 'partial');
    const pool = full.length ? full : list;
    const byDue = [...pool].sort((a, b) => a.contract!.dueDate.localeCompare(b.contract!.dueDate));
    const sameMonth = byDue.find((c) => c.contract!.dueDate.slice(0, 7) === month);
    if (full.length) chosen.push(sameMonth ?? byDue[0]!);
    else
      chosen.push(
        sameMonth ??
          [...byDue].sort(
            (a, b) => Math.abs(diffDays(a.contract!.dueDate, line.postedOn)) - Math.abs(diffDays(b.contract!.dueDate, line.postedOn)),
          )[0]!,
      );
  }
  return [...rest, ...chosen];
}

/**
 * Pontuação da parcela de contrato (0–100): proximidade do vencimento (o mesmo
 * mês conta como perto), descrição/entidade e o bônus da conta prevista igual
 * à da linha; a parcial perde pontos.
 */
function contractScore(line: MatchLine, candidate: MatchCandidate): number {
  const info = candidate.contract!;
  const days = Math.abs(info.split.days);
  const near = line.postedOn.slice(0, 7) === info.dueDate.slice(0, 7) ? Math.min(days, 10) : days;
  let score = 60 - 2 * near + 30 * candidateSimilarity(line, candidate);
  if (info.sameAccount) score += 10;
  if (info.split.kind === 'partial') score -= 20;
  return Math.max(1, Math.min(100, Math.round(score)));
}
