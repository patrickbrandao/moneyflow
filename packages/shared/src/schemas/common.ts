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

/* ---------------- filtro por entidade (tags e favoritas, spec 003/014) ---------------- */

export const ENTITY_TAG_MODES = ['any', 'all'] as const;
export type EntityTagMode = (typeof ENTITY_TAG_MODES)[number];

/** Lista de ids na query, separada por vírgula (ou já como array, nas tools). */
export const idListQuery = (max: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v : v ? v.split(',') : []).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(id).max(max));

/**
 * Filtro de entidades por tags (Qualquer uma = OU; Todas = E) e favoritas, o
 * mesmo na listagem, nos relatórios e no canvas. Sem tags e sem favoritas, não filtra.
 */
export const entityFilterFields = {
  tagIds: idListQuery(50),
  tagMode: z.enum(ENTITY_TAG_MODES).default('any'),
  favorites: queryBool,
};

export type EntityFilter = { tagIds: string[]; tagMode: EntityTagMode; favorites: boolean };
