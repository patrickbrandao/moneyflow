import { z } from 'zod';
import { normalizeCep, normalizeUf } from '../address';
import { addDays } from '../dates';
import { isValidDocument, normalizeDocument } from '../documents';
import { ptBR } from '../i18n/pt-BR';
import { isValidPixKey, normalizePixKey, PIX_KEY_TYPES } from '../pix';
import { FREQUENCIES } from '../recurrence';
import { cents, entityFilterFields, id, isoDate, nonNegativeCents, optionalText, positiveCents, queryBool, requiredText } from './common';
import { seriesTermsFields } from './contracts';

export * from './common';
export * from './contracts';
export * from './operation';
export * from './vision';

const E = ptBR.errors;

/* ---------------- auth ---------------- */

export const loginInput = z.object({
  login: z.string().trim().min(1, ptBR.auth.required),
  password: z.string().min(1, ptBR.auth.required),
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(200),
});

/* ---------------- usuários ---------------- */

export const GLOBAL_ROLES = ['admin', 'user'] as const;
export const CAIXA_ROLES = ['editor', 'viewer'] as const;

const username = z
  .string()
  .trim()
  .regex(/^[^@\s]{3,64}$/, ptBR.errors.validation);

export const userCreateInput = z.object({
  username,
  email: z.email().trim().max(254),
  password: z.string().min(6).max(200),
  role: z.enum(GLOBAL_ROLES).default('user'),
  isActive: z.boolean().default(true),
});

export const userUpdateInput = z.object({
  username: username.optional(),
  email: z.email().trim().max(254).optional(),
  password: z.string().min(6).max(200).optional(),
  role: z.enum(GLOBAL_ROLES).optional(),
  isActive: z.boolean().optional(),
});

export const membershipInput = z.object({ caixaId: id, role: z.enum(CAIXA_ROLES) });
export const membershipsSetInput = z.object({ memberships: z.array(membershipInput).max(500) });
export const memberInput = z.object({ userId: id, role: z.enum(CAIXA_ROLES) });
export const memberUpdateInput = z.object({ role: z.enum(CAIXA_ROLES) });

/* ---------------- entidades ---------------- */

export const ENTITY_KINDS = ['person', 'company'] as const;

const entityTagIds = z
  .array(id)
  .max(200)
  .transform((ids) => [...new Set(ids.map((v) => v.toLowerCase()))]);

const documentField = z
  .string()
  .nullish()
  .transform((value) => (value ? normalizeDocument(value) : null));

export const entityCreateInput = z
  .object({
    kind: z.enum(ENTITY_KINDS),
    name: requiredText(200),
    tradeName: optionalText(200),
    document: documentField,
    birthDate: isoDate.nullish().transform((v) => v ?? null),
    notes: optionalText(),
    /** Tags ativas da entidade (spec 003). */
    tagIds: entityTagIds.default([]),
    isFavorite: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.document && !isValidDocument(value.kind, value.document)) {
      ctx.addIssue({ code: 'custom', path: ['document'], message: value.kind === 'person' ? E.invalidCpf : E.invalidCnpj });
    }
    if (value.kind === 'person' && value.tradeName) ctx.addIssue({ code: 'custom', path: ['tradeName'], message: E.validation });
    if (value.kind === 'company' && value.birthDate) ctx.addIssue({ code: 'custom', path: ['birthDate'], message: E.validation });
  });

export const entityUpdateInput = z.object({
  name: requiredText(200).optional(),
  tradeName: optionalText(200).optional(),
  document: documentField.optional(),
  birthDate: isoDate.nullish(),
  notes: optionalText().optional(),
  /** Substitui o conjunto inteiro de tags. */
  tagIds: entityTagIds.optional(),
  isFavorite: z.boolean().optional(),
});

export const entityListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(ENTITY_KINDS).optional(),
  archived: queryBool,
  ...entityFilterFields,
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/* ---------------- tags de entidade (spec 003) ---------------- */

export const entityTagCreateInput = z.object({
  name: requiredText(40),
  colorSlot: z.number().int().min(1).max(12),
});

export const entityTagUpdateInput = z.object({
  name: requiredText(40).optional(),
  colorSlot: z.number().int().min(1).max(12).optional(),
});

export const entityTagListQuery = z.object({ archived: queryBool });

export const CONTACT_KINDS = ['phone', 'email', 'other'] as const;
export const contactInput = z.object({
  kind: z.enum(CONTACT_KINDS),
  value: requiredText(200),
  label: optionalText(100),
  isPrimary: z.boolean().default(false),
});

export const addressInput = z.object({
  label: optionalText(100),
  postalCode: z
    .string()
    .nullish()
    .transform((v, ctx) => {
      if (!v?.trim()) return null;
      const cep = normalizeCep(v);
      if (!cep) ctx.addIssue({ code: 'custom', message: E.invalidCep });
      return cep;
    }),
  street: optionalText(200),
  number: optionalText(30),
  complement: optionalText(100),
  district: optionalText(100),
  city: requiredText(100),
  state: z.string().transform((v, ctx) => {
    const uf = normalizeUf(v);
    if (!uf) ctx.addIssue({ code: 'custom', message: E.invalidUf });
    return uf ?? v;
  }),
});

export const BANK_ACCOUNT_TYPES = ['checking', 'savings', 'payment', 'salary'] as const;
const digitsOrNull = (pattern: RegExp) =>
  z
    .string()
    .nullish()
    .transform((v) => (v?.trim() ? v.trim().toUpperCase() : null))
    .refine((v) => v === null || pattern.test(v), E.validation);

export const bankAccountInput = z
  .object({
    bankCode: digitsOrNull(/^[0-9]{3}$/),
    ispb: digitsOrNull(/^[0-9]{8}$/),
    branch: digitsOrNull(/^[0-9]{1,6}(-[0-9A-Z])?$/),
    accountNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{1,20}(-[0-9A-Z])?$/, E.validation),
    accountType: z.enum(BANK_ACCOUNT_TYPES),
    holderName: optionalText(200),
    label: optionalText(100),
  })
  .refine((v) => v.bankCode || v.ispb, { path: ['bankCode'], message: ptBR.entity.bank });

export const pixKeyInput = z
  .object({
    keyType: z.enum(PIX_KEY_TYPES),
    keyValue: z.string().trim().min(1),
    bankCode: digitsOrNull(/^[0-9]{3}$/),
    ispb: digitsOrNull(/^[0-9]{8}$/),
    label: optionalText(100),
    isPrimary: z.boolean().default(false),
  })
  .transform((v) => ({ ...v, keyValue: normalizePixKey(v.keyType, v.keyValue) }))
  .refine((v) => isValidPixKey(v.keyType, v.keyValue), { path: ['keyValue'], message: E.invalidPix });

export const LINK_KINDS = ['partner_of', 'responsible_for', 'spouse_of', 'other'] as const;
export const linkInput = z.object({
  relatedEntityId: id,
  kind: z.enum(LINK_KINDS),
  notes: optionalText(),
});

/* ---------------- caixas e contas ---------------- */

export const CAIXA_KINDS = ['general', 'credit_card'] as const;

/** Campos do cartão (caixa credit_card, spec 007). */
const cardFields = {
  defaultPayerCaixaId: id,
  creditLimitCents: nonNegativeCents,
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  cardLast4: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, E.validation),
};

export const caixaCreateInput = z
  .object({
    name: requiredText(120),
    kind: z.enum(CAIXA_KINDS).default('general'),
    holderEntityId: id,
    isPrimary: z.boolean().default(false),
    description: optionalText(),
    defaultPayerCaixaId: cardFields.defaultPayerCaixaId.nullish(),
    creditLimitCents: cardFields.creditLimitCents.nullish(),
    closingDay: cardFields.closingDay.nullish(),
    dueDay: cardFields.dueDay.nullish(),
    cardLast4: cardFields.cardLast4.nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'credit_card') return;
    for (const key of ['defaultPayerCaixaId', 'creditLimitCents', 'closingDay', 'dueDay', 'cardLast4'] as const) {
      if (value[key] === null || value[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: E.cardFieldsRequired });
    }
  });

export const caixaUpdateInput = z.object({
  name: requiredText(120).optional(),
  holderEntityId: id.optional(),
  isPrimary: z.boolean().optional(),
  description: optionalText().optional(),
  defaultPayerCaixaId: cardFields.defaultPayerCaixaId.optional(),
  creditLimitCents: cardFields.creditLimitCents.optional(),
  closingDay: cardFields.closingDay.optional(),
  dueDay: cardFields.dueDay.optional(),
  cardLast4: cardFields.cardLast4.optional(),
  /** "Conciliar com IA ao importar" do cartão (spec 029). */
  aiAutoReconcile: z.boolean().optional(),
});

export const ACCOUNT_KINDS = ['checking', 'cash', 'savings'] as const;
export const accountCreateInput = z.object({
  kind: z.enum(ACCOUNT_KINDS),
  name: requiredText(120),
  bankCode: digitsOrNull(/^[0-9]{3}$/),
  ispb: digitsOrNull(/^[0-9]{8}$/),
  branch: digitsOrNull(/^[0-9]{1,6}(-[0-9A-Z])?$/),
  accountNumber: digitsOrNull(/^[0-9]{1,20}(-[0-9A-Z])?$/),
  openingBalanceCents: cents.default(0),
  openingDate: isoDate,
});

export const accountUpdateInput = z.object({
  name: requiredText(120).optional(),
  bankCode: digitsOrNull(/^[0-9]{3}$/).optional(),
  ispb: digitsOrNull(/^[0-9]{8}$/).optional(),
  branch: digitsOrNull(/^[0-9]{1,6}(-[0-9A-Z])?$/).optional(),
  accountNumber: digitsOrNull(/^[0-9]{1,20}(-[0-9A-Z])?$/).optional(),
  openingBalanceCents: cents.optional(),
  openingDate: isoDate.optional(),
  /** "Conciliar com IA ao importar" (spec 029): só conta corrente e poupança. */
  aiAutoReconcile: z.boolean().optional(),
});

export const adjustmentInput = z.object({
  occurredOn: isoDate,
  amountCents: cents.refine((v) => v !== 0, E.invalidAmount),
  description: requiredText(200),
  categoryId: id.nullish().transform((v) => v ?? null),
  entityId: id.nullish().transform((v) => v ?? null),
  notes: optionalText(),
});

export const statementQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

/** Resumo da conta (spec 004): período em meses fechados, até 36. */
export const accountSummaryQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.to >= q.from, { message: E.invalidPeriod, path: ['to'] })
  .refine((q) => q.to <= addDays(q.from, 1100), { message: E.invalidPeriod, path: ['to'] });

/**
 * Lançamentos de uma fatia da pizza do resumo da conta: os grupos de categoria (id do grupo ou
 * `none`, sem categoria; vários quando a fatia é "Outras") de um tipo, no mesmo período.
 */
export const accountCategoryEntriesQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    kind: z.enum(['income', 'expense']),
    groups: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(
        z
          .array(z.union([id, z.literal('none')]))
          .min(1)
          .max(1000),
      ),
  })
  .refine((q) => q.to >= q.from, { message: E.invalidPeriod, path: ['to'] })
  .refine((q) => q.to <= addDays(q.from, 1100), { message: E.invalidPeriod, path: ['to'] });

export const hiddenCategoriesInput = z.object({ categoryIds: z.array(id).max(1000) });

/* ---------------- categorias ---------------- */

export const CATEGORY_KINDS = ['income', 'expense'] as const;
const colorSlot = z.number().int().min(1).max(12).nullish();
const icon = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v), E.validation);

export const categoryCreateInput = z.object({
  kind: z.enum(CATEGORY_KINDS),
  parentId: id.nullish().transform((v) => v ?? null),
  name: requiredText(80),
  colorSlot: colorSlot.transform((v) => v ?? null),
  icon,
});

export const categoryUpdateInput = z.object({
  name: requiredText(80).optional(),
  parentId: id.nullish(),
  colorSlot,
  icon: icon.optional(),
});

/* ---------------- títulos ---------------- */

export const DIRECTIONS = ['payable', 'receivable'] as const;
export const TITLE_STATUSES = ['open', 'partial', 'paid', 'canceled'] as const;
export const TITLE_FILTERS = ['open', 'partial', 'paid', 'canceled', 'overdue', 'unpaid', 'pending_acceptance', 'pending_account'] as const;

export const seriesInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('installments'),
    count: z.number().int().min(2).max(999),
    frequency: z.enum(FREQUENCIES).default('monthly'),
    intervalCount: z.number().int().min(1).max(366).default(1),
  }),
  z.object({
    kind: z.literal('recurrence'),
    frequency: z.enum(FREQUENCIES),
    intervalCount: z.number().int().min(1).max(366).default(1),
    endsOn: isoDate.nullish().transform((v) => v ?? null),
  }),
]);

export const titleCreateInput = z.object({
  caixaId: id,
  direction: z.enum(DIRECTIONS),
  entityId: id,
  categoryId: id,
  description: requiredText(300),
  competenceDate: isoDate,
  dueDate: isoDate,
  /** No parcelado, o valor de CADA parcela. */
  amountCents: positiveCents,
  notes: optionalText(),
  /**
   * Caixa do espelho: omitido = caixa principal da entidade (se houver);
   * null = sem espelho; um id = essa caixa (titular precisa ser a entidade).
   */
  mirrorCaixaId: id.nullish(),
  /** Categoria do lado espelho (tipo oposto). Omitida: escolhida automaticamente. */
  mirrorCategoryId: id.nullish(),
  series: seriesInput.nullish(),
  /** Conta prevista (spec 034): conta da caixa do título (corrente, poupança ou cofre); na série, vai para cada ocorrência. */
  plannedAccountId: id.nullish().transform((v) => v ?? null),
  /** Ajustes de reconhecimento da série (spec 034); omitidos = os padrões (janela 15 dias, sem encargos). */
  seriesTerms: z.object(seriesTermsFields).partial().nullish(),
  /** Boleto: linha digitável (47/48) ou código de barras (44); gravado como o código de 44 dígitos. */
  boletoBarcode: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null)),
  /** PIX copia-e-cola (BR Code) completo. */
  pixPayload: z
    .string()
    .trim()
    .max(512)
    .nullish()
    .transform((v) => (v ? v : null)),
  /** NF-e importada (title-entry/nfe). */
  nfeDocumentId: id.nullish().transform((v) => v ?? null),
});

export const SCOPES = ['this', 'following'] as const;

export const titleUpdateInput = z.object({
  entityId: id.optional(),
  categoryId: id.optional(),
  description: requiredText(300).optional(),
  competenceDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  amountCents: positiveCents.optional(),
  notes: optionalText().optional(),
  boletoBarcode: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .optional(),
  pixPayload: z
    .string()
    .trim()
    .max(512)
    .nullish()
    .transform((v) => (v ? v : null))
    .optional(),
  /**
   * Conta prevista (specs 033 e 034): conta da caixa do título (corrente,
   * poupança ou cofre). Em "só esta", a ocorrência fica com conta própria; em
   * "esta e as próximas", as seguintes em aberto mudam junto.
   */
  plannedAccountId: id.nullable().optional(),
  scope: z.enum(SCOPES).default('this'),
});

export const titleListQuery = z.object({
  caixaId: id.optional(),
  direction: z.enum(DIRECTIONS).optional(),
  status: z.enum(TITLE_FILTERS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional(),
  entityId: id.optional(),
  /** Ocorrências previstas numa conta (spec 034: os previstos no Extrato da conta). */
  plannedAccountId: id.optional(),
  archived: queryBool,
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

export const titleDeleteQuery = z.object({ scope: z.enum(SCOPES).default('this') });
/**
 * Encerrar (ou estender) uma série recorrente: novo "Termina em". Ocorrências
 * em aberto que vencem depois são canceladas; null = sem fim (reabre as que o
 * encerramento anterior cancelou).
 */
export const seriesEndInput = z.object({ endsOn: isoDate.nullable() });
/** Prévia do encerramento: endsOn omitido = sem fim. */
export const seriesEndQuery = z.object({ endsOn: isoDate.optional() });
export const mirrorAcceptInput = z.object({ categoryId: id.optional() });
export const mirrorDisputeInput = z.object({ reason: optionalText(500) });

/* ---------------- baixas ---------------- */

export const settlementCreateInput = z
  .object({
    settledOn: isoDate,
    amountCents: positiveCents,
    interestCents: nonNegativeCents.default(0),
    fineCents: nonNegativeCents.default(0),
    discountCents: nonNegativeCents.default(0),
    /** Conta da caixa do título; null = "conta a definir". */
    financialAccountId: id.nullable(),
    /** Conta de OUTRA caixa que paga/recebe de fato: gera a transferência. */
    sourceAccountId: id.nullish(),
    /** Conta da perna do espelho (se houver e se o usuário puder escrever lá). */
    mirrorAccountId: id.nullish(),
    notes: optionalText(),
  })
  .refine((v) => v.discountCents <= v.amountCents + v.interestCents + v.fineCents, {
    path: ['discountCents'],
    message: E.invalidAmount,
  });

export const settlementAccountInput = z.object({ financialAccountId: id });
export const settlementReverseInput = z.object({
  reason: requiredText(500),
  reversedOn: isoDate.optional(),
  undoTransfer: z.boolean().default(true),
});

/* ---------------- transferências ---------------- */

export const transferCreateInput = z
  .object({
    fromAccountId: id,
    toAccountId: id,
    amountCents: positiveCents,
    transferredOn: isoDate,
    description: optionalText(200),
    notes: optionalText(),
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, { path: ['toAccountId'], message: E.validation });

export const transferListQuery = z.object({
  caixaId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

export type LoginInput = z.infer<typeof loginInput>;
export type UserCreateInput = z.input<typeof userCreateInput>;
export type UserUpdateInput = z.input<typeof userUpdateInput>;
export type EntityCreateInput = z.input<typeof entityCreateInput>;
export type EntityUpdateInput = z.input<typeof entityUpdateInput>;
export type EntityListQuery = z.input<typeof entityListQuery>;
export type EntityTagCreateInput = z.input<typeof entityTagCreateInput>;
export type EntityTagUpdateInput = z.input<typeof entityTagUpdateInput>;
export type ContactInput = z.input<typeof contactInput>;
export type AddressInput = z.input<typeof addressInput>;
export type BankAccountInput = z.input<typeof bankAccountInput>;
export type PixKeyInput = z.input<typeof pixKeyInput>;
export type LinkInput = z.input<typeof linkInput>;
export type CaixaCreateInput = z.input<typeof caixaCreateInput>;
export type CaixaUpdateInput = z.input<typeof caixaUpdateInput>;
export type AccountCreateInput = z.input<typeof accountCreateInput>;
export type AccountUpdateInput = z.input<typeof accountUpdateInput>;
export type AdjustmentInput = z.input<typeof adjustmentInput>;
export type CategoryCreateInput = z.input<typeof categoryCreateInput>;
export type CategoryUpdateInput = z.input<typeof categoryUpdateInput>;
export type SeriesInput = z.input<typeof seriesInput>;
export type TitleCreateInput = z.input<typeof titleCreateInput>;
export type TitleUpdateInput = z.input<typeof titleUpdateInput>;
export type TitleListQuery = z.input<typeof titleListQuery>;
export type SeriesEndInput = z.input<typeof seriesEndInput>;
export type SettlementCreateInput = z.input<typeof settlementCreateInput>;
export type SettlementReverseInput = z.input<typeof settlementReverseInput>;
export type TransferCreateInput = z.input<typeof transferCreateInput>;
