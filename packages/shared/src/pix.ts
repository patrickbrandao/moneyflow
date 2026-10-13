import { formatDocument, isValidCnpj, isValidCpf, normalizeDocument } from './documents';

export const PIX_KEY_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'evp'] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EVP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+55[1-9]{2}[0-9]{8,9}$/;

/**
 * Normaliza a chave como o banco a grava (CHECK entity_pix_keys_key_value_check):
 * cpf 11 dígitos; cnpj 14 [0-9A-Z]; email minúsculo; telefone +55DDDNÚMERO;
 * EVP UUID minúsculo com hífens.
 */
export function normalizePixKey(type: PixKeyType, raw: string): string {
  const value = raw.trim();
  switch (type) {
    case 'cpf':
    case 'cnpj':
      return normalizeDocument(value);
    case 'email':
      return value.toLowerCase();
    case 'phone': {
      let digits = value.replace(/\D/g, '');
      if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
      if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
      return `+55${digits}`;
    }
    case 'evp':
      return value.toLowerCase();
  }
}

/** Valida a chave JÁ normalizada. */
export function isValidPixKey(type: PixKeyType, value: string): boolean {
  switch (type) {
    case 'cpf':
      return isValidCpf(value);
    case 'cnpj':
      return isValidCnpj(value);
    case 'email':
      return value === value.toLowerCase() && value.length <= 77 && EMAIL.test(value);
    case 'phone':
      return PHONE.test(value);
    case 'evp':
      return EVP.test(value);
  }
}

/** Adivinha o tipo de uma chave colada (ajuda do formulário). */
export function guessPixKeyType(raw: string): PixKeyType | null {
  const value = raw.trim();
  if (EVP.test(value.toLowerCase())) return 'evp';
  if (value.includes('@')) return 'email';
  if (value.startsWith('+')) return 'phone';
  const doc = normalizeDocument(value);
  if (doc.length === 11 && isValidCpf(doc)) return 'cpf';
  if (doc.length === 14 && isValidCnpj(doc)) return 'cnpj';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return 'phone';
  return null;
}

/** Exibição amigável da chave normalizada (CPF/CNPJ como o documento, inclusive o CNPJ alfanumérico). */
export function formatPixKey(type: PixKeyType, value: string): string {
  if (type === 'cpf' && isValidCpf(value)) return formatDocument(value);
  if (type === 'cnpj' && isValidCnpj(value)) return formatDocument(value);
  if (type === 'phone' && PHONE.test(value)) {
    const ddd = value.slice(3, 5);
    const num = value.slice(5);
    return `+55 (${ddd}) ${num.length === 9 ? `${num.slice(0, 5)}-${num.slice(5)}` : `${num.slice(0, 4)}-${num.slice(4)}`}`;
  }
  return value;
}
