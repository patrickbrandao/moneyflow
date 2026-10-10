export const UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;

export type Uf = (typeof UFS)[number];

/** CEP normalizado: 8 dígitos. Devolve null se não tiver 8 dígitos. */
export function normalizeCep(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

export function formatCep(cep: string | null | undefined): string {
  if (!cep) return '';
  return /^[0-9]{8}$/.test(cep) ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
}

/** UF em maiúsculas, ou null se não for uma sigla válida. */
export function normalizeUf(value: string): Uf | null {
  const uf = value.trim().toUpperCase();
  return (UFS as readonly string[]).includes(uf) ? (uf as Uf) : null;
}
