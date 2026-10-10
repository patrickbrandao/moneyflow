/*
 * CPF e CNPJ (numérico e alfanumérico). Mesmo algoritmo das funções
 * is_valid_cpf / is_valid_cnpj do banco (database/migrations/0001_base.sql):
 * os validadores recebem o valor JÁ NORMALIZADO.
 */

/** Só dígitos e letras maiúsculas (remove pontos, barra, traço e espaços). */
export function normalizeDocument(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function isValidCpf(cpf: string): boolean {
  if (!/^[0-9]{11}$/.test(cpf) || cpf === cpf[0]!.repeat(11)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(cpf[i]) * (len + 1 - i);
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Valor do caractere no CNPJ alfanumérico: código ASCII − 48 (0–9 → 0–9, A → 17…). */
const charValue = (ch: string) => ch.charCodeAt(0) - 48;

function cnpjDigit(base: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += charValue(base[i]!) * weights[i]!;
  return sum % 11 < 2 ? 0 : 11 - (sum % 11);
}

export function isValidCnpj(cnpj: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj) || cnpj === cnpj[0]!.repeat(14)) return false;
  return cnpjDigit(cnpj, W1) === Number(cnpj[12]) && cnpjDigit(cnpj, W2) === Number(cnpj[13]);
}

/** Calcula os dois dígitos verificadores de uma base de 12 caracteres (útil em testes e geradores). */
export function cnpjCheckDigits(base12: string): string {
  const first = cnpjDigit(base12, W1);
  const second = cnpjDigit(`${base12}${first}`, W2);
  return `${first}${second}`;
}

export function cpfCheckDigits(base9: string): string {
  const calc = (s: string) => {
    let sum = 0;
    for (let i = 0; i < s.length; i += 1) sum += Number(s[i]) * (s.length + 1 - i);
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  const first = calc(base9);
  return `${first}${calc(`${base9}${first}`)}`;
}

export type EntityKind = 'person' | 'company';

/** Valida conforme o tipo da entidade (valor já normalizado). */
export function isValidDocument(kind: EntityKind, document: string): boolean {
  return kind === 'person' ? isValidCpf(document) : isValidCnpj(document);
}

export function formatCpf(cpf: string): string {
  return /^[0-9]{11}$/.test(cpf) ? `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}` : cpf;
}

export function formatCnpj(cnpj: string): string {
  return /^[0-9A-Z]{14}$/.test(cnpj)
    ? `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`
    : cnpj;
}

/** Formata CPF (11) ou CNPJ (14) pelo tamanho. */
export function formatDocument(document: string | null | undefined): string {
  if (!document) return '';
  return document.length === 11 ? formatCpf(document) : formatCnpj(document);
}
