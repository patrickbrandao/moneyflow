/*
 * Casamento assistido de linhas de extrato (spec 009): valor exato, data ±3
 * dias e semelhança de descrição/entidade. Puro, sem acesso ao banco.
 */
import { diffDays } from './dates';

export type MatchLine = { postedOn: string; amountCents: number; description: string };

export type MatchCandidate = {
  kind: 'movement' | 'title' | 'card_item';
  id: string;
  date: string;
  /** Mesmo sinal, do ponto de vista do titular, que o da linha. */
  amountCents: number;
  description: string;
  entityName?: string | null;
};

export type MatchResult = { candidate: MatchCandidate; score: number; status: 'matched' | 'suggested' };

export const MATCH_MAX_DAYS = 3;

/** Minúsculas, sem acentos e pontuação, sem números longos (≥ 4 dígitos) nem datas dd/mm, espaços colapsados. */
export function normalizeDescription(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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

/** null se o valor não for exatamente igual ou a data distar mais de 3 dias; senão 0–100. */
export function scoreCandidate(line: MatchLine, candidate: MatchCandidate): number | null {
  if (line.amountCents !== candidate.amountCents) return null;
  const days = Math.abs(diffDays(line.postedOn, candidate.date));
  if (days > MATCH_MAX_DAYS) return null;
  const score = 60 - 10 * days + 40 * candidateSimilarity(line, candidate);
  return Math.max(0, Math.min(100, Math.round(score)));
}

const KIND_ORDER: Record<MatchCandidate['kind'], number> = { movement: 0, card_item: 1, title: 2 };

/** Melhor candidato para a linha, ou null. Título é sempre 'suggested'. */
export function pickMatch(line: MatchLine, candidates: MatchCandidate[], used?: Set<string>): MatchResult | null {
  const scored = candidates
    .filter((c) => !used?.has(c.id))
    .map((candidate) => ({ candidate, score: scoreCandidate(line, candidate), days: Math.abs(diffDays(line.postedOn, candidate.date)) }))
    .filter((s): s is { candidate: MatchCandidate; score: number; days: number } => s.score !== null);
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score || a.days - b.days || KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind]);
  const best = scored[0]!;
  const sameKind = scored.filter((s) => s.candidate.kind === best.candidate.kind).length;
  const matched =
    best.candidate.kind !== 'title' && sameKind === 1 && (best.days === 0 || candidateSimilarity(line, best.candidate) >= 0.5);
  return { candidate: best.candidate, score: best.score, status: matched ? 'matched' : 'suggested' };
}
