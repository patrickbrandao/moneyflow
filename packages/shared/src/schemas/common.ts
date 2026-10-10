import { z } from 'zod';
import { isIsoDate } from '../dates';
import { ptBR } from '../i18n/pt-BR';

export const id = z.uuid();
export const isoDate = z.string().refine(isIsoDate, ptBR.errors.invalidDate);
export const cents = z.number().int().safe();
export const positiveCents = cents.positive();
export const nonNegativeCents = cents.nonnegative();

/** Texto obrigatório (aparado). */
export const requiredText = (max = 500) => z.string().trim().min(1).max(max);

/** Texto opcional: '' e espaços viram null. */
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/** Booleanos de query string ('1', 'true'). */
export const queryBool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === '1' || value === 'true');
