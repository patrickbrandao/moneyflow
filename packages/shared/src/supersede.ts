/*
 * Troca do lote provisório pelo consolidado (spec 031): o casamento fixo das
 * linhas. Puro, sem acesso ao banco.
 */
import { normalizeDescription } from './reconcile';

export type SupersedeLine = { id: string; postedOn: string; amountCents: number; description: string };

/** Desfecho de uma linha do provisório substituído (statement_lines.supersede_outcome). */
export const SUPERSEDE_OUTCOMES = ['transferred', 'paired', 'dropped', 'pending', 'kept', 'entry_deleted'] as const;
export type SupersedeOutcome = (typeof SUPERSEDE_OUTCOMES)[number];

/** Decisão sobre uma sobra pendente: casar com uma linha do consolidado, manter ou excluir o lançamento. */
export const SUPERSEDE_RESOLVE_ACTIONS = ['pair', 'keep', 'delete_entry'] as const;
export type SupersedeResolveAction = (typeof SUPERSEDE_RESOLVE_ACTIONS)[number];

/** Data máxima, em dias, entre as linhas de um par sugerido pela IA. */
export const SUPERSEDE_SUGGESTION_MAX_DAYS = 7;

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/**
 * Pares (linha do provisório → linha do consolidado) pela regra fixa da spec 031:
 * 1. data e valor exatos, quando o par (data, valor) aparece uma vez em cada lado;
 * 2. nos grupos (data, valor) que sobraram, a descrição normalizada idêntica, de
 *    novo só com correspondência única.
 * O resto (data deslocada, descrição diferente, repetição sem desempate) fica sem par.
 */
export function pairSupersedeLines(provisional: SupersedeLine[], consolidated: SupersedeLine[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const dayAmount = (l: SupersedeLine) => `${l.postedOn}|${l.amountCents}`;
  const provGroups = groupBy(provisional, dayAmount);
  const consGroups = groupBy(consolidated, dayAmount);
  for (const [key, provs] of provGroups) {
    const cons = consGroups.get(key);
    if (!cons) continue;
    if (provs.length === 1 && cons.length === 1) {
      pairs.set(provs[0]!.id, cons[0]!.id);
      continue;
    }
    const provByText = groupBy(provs, (l) => normalizeDescription(l.description));
    const consByText = groupBy(cons, (l) => normalizeDescription(l.description));
    for (const [text, p] of provByText) {
      const c = consByText.get(text);
      if (p.length === 1 && c?.length === 1) pairs.set(p[0]!.id, c[0]!.id);
    }
  }
  return pairs;
}

/** Períodos (datas AAAA-MM-DD inclusivas) que se cruzam. */
export const periodsOverlap = (a: { periodStart: string; periodEnd: string }, b: { periodStart: string; periodEnd: string }) =>
  a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd;
