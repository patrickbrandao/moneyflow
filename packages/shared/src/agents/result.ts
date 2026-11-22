import { ptBR } from '../i18n/pt-BR';

/*
 * Resultado de uma tool para o modelo (tarefa 101): no máximo MAX_RESULT_CHARS
 * caracteres, sem quebrar o JSON. Uma lista grande é cortada por item inteiro
 * (a maior lista do objeto, ou a própria lista), com `truncated` dizendo
 * quantos itens ficaram de fora e como pedir o resto; o texto solto (o de um
 * servidor MCP externo) é cortado com a contagem do que faltou.
 */

export const MAX_RESULT_CHARS = 60_000;

export type ResultTruncation = { field: string | null; shown: number; total: number; omitted: number; hint: string };

const size = (value: unknown) => JSON.stringify(value ?? null).length;

/** O maior n (0..list.length) com build(n) cabendo em max; build é crescente em n. */
function largestFitting(count: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Texto do resultado para o modelo: JSON compacto que cabe em `max`, cortado por item quando preciso. */
export function fitResult(value: unknown, max = MAX_RESULT_CHARS): string {
  const R = ptBR.agents.result;
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}… ${R.textCut(value.length - max, value.length)}` : value;
  }
  const text = JSON.stringify(value ?? null);
  if (text.length <= max) return text;

  const truncation = (field: string | null, shown: number, total: number): ResultTruncation => ({
    field,
    shown,
    total,
    omitted: total - shown,
    hint: R.hint,
  });

  if (Array.isArray(value)) {
    const build = (n: number) => ({ items: value.slice(0, n), truncated: truncation(null, n, value.length) });
    const n = largestFitting(value.length, (k) => size(build(k)) <= max);
    if (n > 0 || size(build(0)) <= max) return JSON.stringify(build(n));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // A maior lista do objeto (rows, items, lines…) é a que corta; o resto (totais, saldo) fica inteiro.
    const lists = Object.entries(record)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .sort((a, b) => size(b[1]) - size(a[1]));
    const biggest = lists[0];
    if (biggest) {
      const [field, list] = biggest;
      const build = (n: number) => ({ ...record, [field]: list.slice(0, n), truncated: truncation(field, n, list.length) });
      const n = largestFitting(list.length, (k) => size(build(k)) <= max);
      if (size(build(n)) <= max) return JSON.stringify(build(n));
    }
  }
  // Sem lista que resolva (um item só já passa do limite): um JSON válido com o começo do texto.
  const preview = text.slice(0, Math.max(0, max - 400));
  return JSON.stringify({ truncated: { field: null, shown: 0, total: 0, omitted: 0, hint: R.hint }, preview });
}
