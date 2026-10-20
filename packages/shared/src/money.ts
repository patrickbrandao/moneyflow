/*
 * Dinheiro: só BRL, sempre em centavos inteiros. Formatação pt-BR:
 * "R$ 1.234,56" (com espaço inseparável, como o Intl produz).
 */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const plain = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatBRL(cents: number): string {
  return brl.format(cents / 100);
}

/** Sem o símbolo: "1.234,56". */
export function formatCents(cents: number): string {
  return plain.format(cents / 100);
}

/**
 * Formato contábil das telas e relatórios: negativo entre parênteses, sem o sinal
 * ("(R$ 10,00)"); zero e positivo como `formatBRL`.
 */
export function formatAccounting(cents: number): string {
  return cents < 0 ? `(${formatBRL(Math.abs(cents))})` : formatBRL(cents);
}

/** Com sinal explícito para movimentos: "+R$ 10,00" / "−R$ 10,00". */
export function formatSignedBRL(cents: number): string {
  if (cents === 0) return formatBRL(0);
  return `${cents > 0 ? '+' : '−'}${formatBRL(Math.abs(cents))}`;
}

/**
 * Lê um valor digitado em pt-BR ("1.234,56", "1234,5", "R$ 10", "10.50") e
 * devolve centavos, ou null se não for um número. Aceita sinal negativo.
 */
export function parseBRL(input: string): number | null {
  let text = input
    .trim()
    .replace(/R\$\s?/i, '')
    .replace(/\s/g, '')
    .replace('−', '-');
  if (!text) return null;
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  if (text.includes(',')) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    // "1.234" = mil duzentos e trinta e quatro
    text = text.replace(/\./g, '');
  }
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [int, frac = ''] = text.split('.');
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}
