/*
 * Boleto: linha digitável (bancária 47 dígitos, convênio/arrecadação 48) e
 * código de barras (44). A validação do código de barras segue exatamente a
 * função is_valid_boleto_barcode do banco (database/migrations/0012_title_entry.sql).
 */
import { addDays, diffDays, todayIso } from './dates';

export type BoletoResult =
  | {
      ok: true;
      kind: 'bank' | 'utility';
      /** Código de barras (44 dígitos). */
      barcode: string;
      /** Linha digitável formatada para exibição. */
      digitableLine: string;
      bankCode: string | null;
      amountCents: number | null;
      /** Vencimento 'YYYY-MM-DD'. */
      dueDate: string | null;
    }
  | { ok: false; error: string };

const digitsOf = (s: string) => Array.from(s, (c) => Number(c));

/** Módulo 10 (pesos 2,1 a partir da direita, somando os algarismos do produto). */
export function boletoMod10(body: string): number {
  let sum = 0;
  let weight = 2;
  for (const d of digitsOf(body).reverse()) {
    const p = d * weight;
    sum += Math.floor(p / 10) + (p % 10);
    weight = 3 - weight;
  }
  return (10 - (sum % 10)) % 10;
}

function mod11Sum(body: string): number {
  let sum = 0;
  let weight = 2;
  for (const d of digitsOf(body).reverse()) {
    sum += d * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  return sum;
}

/** DV geral do código de barras bancário (0, 10 e 11 viram 1). */
function bankBarcodeDv(barcode: string): number {
  const body = barcode.slice(0, 4) + barcode.slice(5);
  const dv = 11 - (mod11Sum(body) % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** Módulo 11 do convênio (resto 0 ou 1 → 0). */
function utilityMod11(body: string): number {
  const r = mod11Sum(body) % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

/** DV de um bloco/código de convênio conforme o 3º dígito (6/7 → mod 10; 8/9 → mod 11). */
function utilityDv(reference: string, body: string): number | null {
  if (reference === '6' || reference === '7') return boletoMod10(body);
  if (reference === '8' || reference === '9') return utilityMod11(body);
  return null;
}

/** Mesma regra de is_valid_boleto_barcode: 44 dígitos já normalizados. */
export function isValidBoletoBarcode(code: string): boolean {
  if (!/^[0-9]{44}$/.test(code)) return false;
  if (code[0] !== '8') return bankBarcodeDv(code) === Number(code[4]);
  const dv = utilityDv(code[2]!, code.slice(0, 3) + code.slice(4));
  return dv !== null && dv === Number(code[3]);
}

/** Linha digitável (47 ou 48 dígitos, com ou sem formatação) → código de barras (44). Não valida DVs. */
export function digitableLineToBarcode(line: string): string | null {
  const d = line.replace(/\D/g, '');
  if (d.length === 47) {
    return d.slice(0, 4) + d.slice(32, 33) + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  }
  if (d.length === 48) {
    return d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47);
  }
  return null;
}

/** Código de barras (44) → linha digitável (47 ou 48 dígitos, sem formatação), com os DVs dos campos calculados. */
export function barcodeToDigitableDigits(barcode: string): string | null {
  if (!/^[0-9]{44}$/.test(barcode)) return null;
  if (barcode[0] === '8') {
    let out = '';
    for (let i = 0; i < 4; i += 1) {
      const block = barcode.slice(i * 11, i * 11 + 11);
      const dv = utilityDv(barcode[2]!, block);
      if (dv === null) return null;
      out += block + String(dv);
    }
    return out;
  }
  const f1 = barcode.slice(0, 4) + barcode.slice(19, 24);
  const f2 = barcode.slice(24, 34);
  const f3 = barcode.slice(34, 44);
  return `${f1}${boletoMod10(f1)}${f2}${boletoMod10(f2)}${f3}${boletoMod10(f3)}${barcode[4]}${barcode.slice(5, 19)}`;
}

/** Formata a linha digitável (47 ou 48 dígitos) para exibição. */
export function formatDigitableLine(line: string): string {
  const d = line.replace(/\D/g, '');
  if (d.length === 47) {
    return `${d.slice(0, 5)}.${d.slice(5, 10)} ${d.slice(10, 15)}.${d.slice(15, 21)} ${d.slice(21, 26)}.${d.slice(26, 32)} ${d[32]} ${d.slice(33)}`;
  }
  if (d.length === 48) {
    return [0, 1, 2, 3].map((i) => `${d.slice(i * 12, i * 12 + 11)}-${d[i * 12 + 11]}`).join(' ');
  }
  return line;
}

/** Código de barras (44) → linha digitável formatada. */
export function barcodeToDigitableLine(barcode: string): string | null {
  const digits = barcodeToDigitableDigits(barcode);
  return digits ? formatDigitableLine(digits) : null;
}

const FACTOR_BASE = '1997-10-07';
/** O fator de vencimento recomeça em 1000 a cada 9000 dias (1000 = 2025-02-22). */
const FACTOR_CYCLE = 9000;

/** Data de vencimento a partir do fator, escolhendo o ciclo mais próximo de `today`. */
export function dueDateFromFactor(factor: number, today: string = todayIso()): string | null {
  if (!Number.isInteger(factor) || factor <= 0) return null;
  let best: string | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= 4; k += 1) {
    if (k > 0 && factor < 1000) break;
    const candidate = addDays(FACTOR_BASE, factor + k * FACTOR_CYCLE);
    const diff = Math.abs(diffDays(today, candidate));
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

/** Interpreta linha digitável (47/48) ou código de barras (44), aceitando espaços, pontos e hífens. */
export function parseBoleto(input: string, today?: string): BoletoResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Informe a linha digitável ou o código de barras.' };
  if (/[^0-9\s.-]/.test(raw)) return { ok: false, error: 'A linha digitável deve conter só números.' };
  const d = raw.replace(/\D/g, '');

  let barcode: string;
  if (d.length === 44) {
    barcode = d;
  } else if (d.length === 47) {
    if (d[0] === '8') return { ok: false, error: 'Linha digitável de convênio deve ter 48 dígitos.' };
    const fields: [string, string][] = [
      [d.slice(0, 9), d[9]!],
      [d.slice(10, 20), d[20]!],
      [d.slice(21, 31), d[31]!],
    ];
    for (const [index, [body, dv]] of fields.entries()) {
      if (boletoMod10(body) !== Number(dv)) return { ok: false, error: `Dígito verificador do campo ${index + 1} inválido.` };
    }
    barcode = digitableLineToBarcode(d)!;
  } else if (d.length === 48) {
    if (d[0] !== '8') return { ok: false, error: 'Linha digitável de convênio deve começar com 8.' };
    for (let i = 0; i < 4; i += 1) {
      const dv = utilityDv(d[2]!, d.slice(i * 12, i * 12 + 11));
      if (dv === null) return { ok: false, error: 'Identificador de valor do convênio inválido.' };
      if (dv !== Number(d[i * 12 + 11])) return { ok: false, error: `Dígito verificador do bloco ${i + 1} inválido.` };
    }
    barcode = digitableLineToBarcode(d)!;
  } else {
    return { ok: false, error: 'Tamanho inválido: use 47 dígitos (bancário), 48 (convênio) ou 44 (código de barras).' };
  }

  if (!isValidBoletoBarcode(barcode)) return { ok: false, error: 'Dígito verificador geral do boleto inválido.' };
  const digitableLine = barcodeToDigitableLine(barcode)!;

  if (barcode[0] === '8') {
    const effective = barcode[2] === '6' || barcode[2] === '8';
    const amount = Number(barcode.slice(4, 15));
    return {
      ok: true,
      kind: 'utility',
      barcode,
      digitableLine,
      bankCode: null,
      amountCents: effective && amount > 0 ? amount : null,
      dueDate: null,
    };
  }

  const amount = Number(barcode.slice(9, 19));
  return {
    ok: true,
    kind: 'bank',
    barcode,
    digitableLine,
    bankCode: barcode.slice(0, 3),
    amountCents: amount > 0 ? amount : null,
    dueDate: dueDateFromFactor(Number(barcode.slice(5, 9)), today ?? todayIso()),
  };
}
