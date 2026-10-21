import { z } from 'zod';
import {
  CONTRACT_DOCUMENT_KINDS,
  CONTRACT_MARKDOWN_MAX_BYTES,
  CONTRACT_STATUSES,
  OBLIGATION_KINDS,
  READJUSTMENT_INDEXES,
} from '../contracts';
import { ptBR } from '../i18n/pt-BR';
import { FREQUENCIES } from '../recurrence';
import { id, isoDate, nonNegativeCents, optionalText, positiveCents, queryBool, requiredText } from './common';

/* Entradas dos contratos (specs 020 e 034) e das séries com conta, cartão e ajustes. */

const E = ptBR.contracts.errors;
const DIRECTIONS = ['receivable', 'payable'] as const;

function percent(max: number) {
  return z
    .number()
    .min(0)
    .max(max)
    .nullish()
    .transform((v) => (v === undefined || v === null || v === 0 ? null : Math.round(v * 10000) / 10000));
}

/**
 * Ajustes de reconhecimento do pagamento da série (spec 034): só servem para
 * reconhecer o valor pago no extrato. A tolerância tem o teto de 10% do valor,
 * conferido no servidor.
 */
export const seriesTermsFields = {
  matchWindowDays: z.number().int().min(0).max(45),
  lateFeePercent: percent(20),
  interestMonthPercent: percent(10),
  earlyDiscountPercent: percent(50),
  toleranceCents: nonNegativeCents,
  autoSettle: z.boolean(),
};

const termsWithDefaults = {
  ...seriesTermsFields,
  matchWindowDays: seriesTermsFields.matchWindowDays.default(15),
  toleranceCents: seriesTermsFields.toleranceCents.default(0),
  autoSettle: seriesTermsFields.autoSettle.default(false),
};

/**
 * Uma obrigação: a série numa conta (corrente, poupança ou cofre; títulos com
 * a conta prevista) ou a cobrança esperada num cartão (sem títulos). Calendário
 * pela primeira data (o dia âncora sai dela), fim = o da vigência por padrão.
 */
export const obligationFields = z.object({
  kind: z.enum(OBLIGATION_KINDS).default('account'),
  description: requiredText(200),
  amountCents: positiveCents,
  frequency: z.enum(FREQUENCIES).default('monthly'),
  intervalCount: z.number().int().min(1).max(366).default(1),
  /** Vencimento (ou data esperada da cobrança) da primeira ocorrência. */
  firstDueDate: isoDate,
  /** Competência da primeira ocorrência (série na conta); omitida = o mês do primeiro vencimento. */
  firstCompetenceDate: isoDate.nullish().transform((v) => v ?? null),
  /** Fim da série; omitido = o fim da vigência do contrato (null = sem fim). */
  endsOn: isoDate.nullish(),
  /** Categoria; omitida = a do contrato. */
  categoryId: id.nullish().transform((v) => v ?? null),
  /** Conta (série na conta): define a caixa da série. */
  accountId: id.nullish().transform((v) => v ?? null),
  /** Cartão e a caixa pagadora (cobrança no cartão; pagadora omitida = a padrão do cartão). */
  cardCaixaId: id.nullish().transform((v) => v ?? null),
  payerCaixaId: id.nullish().transform((v) => v ?? null),
  ...termsWithDefaults,
});

const obligationRefine = (value: { kind: string; accountId: string | null; cardCaixaId: string | null }, ctx: z.RefinementCtx) => {
  if (value.kind === 'account' && !value.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: E.obligationAccount });
  if (value.kind === 'card' && !value.cardCaixaId) ctx.addIssue({ code: 'custom', path: ['cardCaixaId'], message: E.obligationCard });
};

export const obligationInput = obligationFields.superRefine(obligationRefine);

/**
 * Série nova fora do formulário do título (POST /api/series): uma obrigação
 * ligada a um contrato ou solta (aí com a entidade e, na conta, a direção).
 */
export const seriesCreateInput = obligationFields
  .extend({
    contractId: id.nullish().transform((v) => v ?? null),
    entityId: id.nullish().transform((v) => v ?? null),
    direction: z
      .enum(DIRECTIONS)
      .nullish()
      .transform((v) => v ?? null),
  })
  .superRefine((value, ctx) => {
    obligationRefine(value, ctx);
    if (!value.contractId && !value.entityId) ctx.addIssue({ code: 'custom', path: ['entityId'], message: E.seriesEntity });
    if (!value.contractId && !value.categoryId) ctx.addIssue({ code: 'custom', path: ['categoryId'], message: E.seriesCategory });
  });

/**
 * Edição da série (PATCH /api/series/:id): os ajustes valem na hora; o resto
 * é "esta e as próximas" a partir de `effectiveOn` (padrão: hoje) — as
 * ocorrências em aberto sem baixa mudam; na cobrança no cartão, o valor
 * esperado muda dali em diante. `contractId` liga (ou, com null, desliga) a série.
 */
export const seriesUpdateInput = z
  .object({
    ...seriesTermsFields,
    contractId: id.nullable(),
    effectiveOn: isoDate,
    description: requiredText(200),
    amountCents: positiveCents,
    anchorDay: z.number().int().min(1).max(31),
    categoryId: id,
    accountId: id,
    payerCaixaId: id,
  })
  .partial();

/** Séries de uma caixa ou de um contrato; `unlinked` = as soltas (para ligar a um contrato). */
export const seriesListQuery = z.object({
  caixaId: id.optional(),
  contractId: id.optional(),
  entityId: id.optional(),
  unlinked: queryBool,
});

/** Configuração livre do contrato (muda a qualquer momento, inclusive vigente). */
const settings = {
  name: requiredText(200),
  contractNumber: optionalText(60),
  notes: optionalText(4000),
  autoRenew: z.boolean(),
  noticeDays: z.number().int().min(0).max(365),
  readjustmentIndex: z.enum(READJUSTMENT_INDEXES),
  readjustmentBaseDate: isoDate.nullish().transform((v) => v ?? null),
  terminationPenaltyText: optionalText(2000),
  terminationPenaltyCents: positiveCents.nullish().transform((v) => v ?? null),
};

const termRefine = (value: { startsOn?: string; endsOn?: string | null }, ctx: z.RefinementCtx) => {
  if (value.startsOn && value.endsOn && value.endsOn < value.startsOn)
    ctx.addIssue({ code: 'custom', path: ['endsOn'], message: E.endsBeforeStart });
};

/** Campos do cadastro (sem as checagens cruzadas, que entram no contractCreateInput). */
export const contractCreateFields = z.object({
  caixaId: id,
  entityId: id,
  direction: z.enum(DIRECTIONS),
  categoryId: id,
  ...settings,
  autoRenew: settings.autoRenew.default(false),
  noticeDays: settings.noticeDays.default(30),
  readjustmentIndex: settings.readjustmentIndex.default('none'),
  /** Vigência: início e fim (null = indeterminado). */
  startsOn: isoDate,
  endsOn: isoDate.nullish().transform((v) => v ?? null),
  /** Caixa do espelho: omitido = caixa principal da entidade (se houver); null = sem espelho. */
  mirrorCaixaId: id.nullish(),
  /** As obrigações (séries) do contrato; com obrigações o contrato nasce vigente. */
  obligations: z.array(obligationInput).max(20).default([]),
  /** Ativar já na criação; omitido = ativa quando há obrigações. Rascunho não tem obrigações. */
  activate: z.boolean().optional(),
});

export const contractCreateInput = contractCreateFields.superRefine((value, ctx) => {
  termRefine(value, ctx);
  if (value.activate === false && value.obligations.length > 0)
    ctx.addIssue({ code: 'custom', path: ['obligations'], message: E.draftObligations });
});

/** Edição: a vigência muda no rascunho (vigente, por renovar ou rescindir). */
export const contractUpdateInput = z
  .object({
    entityId: id,
    categoryId: id,
    mirrorCaixaId: id.nullable(),
    ...settings,
    startsOn: isoDate,
    endsOn: isoDate.nullable(),
  })
  .partial()
  .superRefine(termRefine);

/** Pagamentos do contrato (spec 033): uma vigência ou todas. */
export const contractPaymentsQuery = z.object({ cycleId: id.optional() });

export const CONTRACT_LIST_STATUSES = [...CONTRACT_STATUSES, 'current'] as const;

export const contractListQuery = z.object({
  caixaId: id.optional(),
  entityId: id.optional(),
  direction: z.enum(DIRECTIONS).optional(),
  /** `current` = vigente. */
  status: z.enum(CONTRACT_LIST_STATUSES).optional(),
  /** A vigência termina nos próximos N dias. */
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  q: z.string().trim().max(200).optional(),
  archived: queryBool,
  limit: z.coerce.number().int().min(1).max(500).default(300),
});

export const dryRunQuery = z.object({ dryRun: queryBool });

/** Ligar uma série existente ao contrato (ela passa a ser obrigação dele). */
export const contractLinkSeriesInput = z.object({ ruleId: id });

/**
 * Aditivo: o documento, a data de efeito e o que muda nas obrigações
 * escolhidas, aplicado como "esta e as próximas" a partir da primeira
 * ocorrência em aberto na data de efeito.
 */
export const contractAmendmentInput = z
  .object({
    effectiveOn: isoDate,
    ruleIds: z.array(id).min(1).max(20),
    /** Novo valor por ocorrência, ou o reajuste em % sobre o valor atual de cada obrigação. */
    amountCents: positiveCents.nullish().transform((v) => v ?? null),
    readjustmentPercent: z
      .number()
      .min(-100)
      .max(1000)
      .nullish()
      .transform((v) => (v === undefined || v === null || v === 0 ? null : v)),
    anchorDay: z
      .number()
      .int()
      .min(1)
      .max(31)
      .nullish()
      .transform((v) => v ?? null),
    categoryId: id.nullish().transform((v) => v ?? null),
    accountId: id.nullish().transform((v) => v ?? null),
    documentId: id.nullish().transform((v) => v ?? null),
    notes: optionalText(2000),
  })
  .superRefine((value, ctx) => {
    if (value.amountCents && value.readjustmentPercent)
      ctx.addIssue({ code: 'custom', path: ['readjustmentPercent'], message: E.amendmentValueEither });
    if (!value.amountCents && !value.readjustmentPercent && value.anchorDay === null && !value.categoryId && !value.accountId)
      ctx.addIssue({ code: 'custom', path: ['effectiveOn'], message: E.amendmentNothing });
  });

/** Rescisão: data de encerramento, o valor da última ocorrência (proporcional) e o título avulso de multa. */
export const contractTerminationInput = z.object({
  terminatedOn: isoDate,
  /** Novo valor da última ocorrência de cada obrigação (a que cobre a data); omitidas = mantêm. */
  lastAmounts: z
    .array(z.object({ titleId: id, amountCents: positiveCents }))
    .max(20)
    .default([]),
  penalty: z
    .object({
      direction: z.enum(DIRECTIONS),
      amountCents: positiveCents,
      dueDate: isoDate,
      categoryId: id,
      description: optionalText(300),
      /** Conta prevista da multa (da caixa do contrato). */
      accountId: id.nullish().transform((v) => v ?? null),
    })
    .nullish()
    .transform((v) => v ?? null),
  notes: optionalText(2000),
});

/** Renovar: estende a vigência (e o fim das obrigações) até a nova data, ou sem fim. */
export const contractRenewalInput = z.object({ endsOn: isoDate.nullable() });

/* ---------------- documentos ---------------- */

const documentKind = z.enum(CONTRACT_DOCUMENT_KINDS);

/** Upload cru (PDF ou .md): metadados na query. */
export const contractDocumentUploadQuery = z.object({
  kind: documentKind.default('contract'),
  title: z.string().trim().max(200).optional(),
  fileName: z.string().trim().min(1).max(255),
  documentDate: isoDate.optional(),
  description: z.string().trim().max(2000).optional(),
});

const markdown = z
  .string()
  .max(CONTRACT_MARKDOWN_MAX_BYTES)
  .refine((v) => new TextEncoder().encode(v).length <= CONTRACT_MARKDOWN_MAX_BYTES, E.markdownTooLarge);

/** Markdown novo (em branco ou escrito no editor). */
export const contractMarkdownCreateInput = z.object({
  kind: documentKind.default('contract'),
  title: requiredText(200),
  documentDate: isoDate.nullish().transform((v) => v ?? null),
  description: optionalText(2000),
  content: markdown.default(''),
  note: optionalText(500),
});

export const contractDocumentUpdateInput = z
  .object({
    kind: documentKind,
    title: requiredText(200),
    documentDate: isoDate.nullable(),
    description: optionalText(2000),
  })
  .partial();

export const contractVersionCreateInput = z.object({ content: markdown, note: optionalText(500) });

/** Leitura do PDF por IA: a caixa (o titular define a direção). */
export const contractReadingQuery = z.object({
  caixaId: id.optional(),
  fileName: z.string().trim().min(1).max(255).default('contrato.pdf'),
});

export const contractPanelQuery = z.object({
  caixas: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(id).max(200)),
});

export type ContractCreateInput = z.input<typeof contractCreateInput>;
export type ObligationInput = z.input<typeof obligationInput>;
export type SeriesCreateInput = z.input<typeof seriesCreateInput>;
export type SeriesUpdateInput = z.input<typeof seriesUpdateInput>;
export type ContractUpdateInput = z.input<typeof contractUpdateInput>;
export type ContractAmendmentInput = z.input<typeof contractAmendmentInput>;
export type ContractTerminationInput = z.input<typeof contractTerminationInput>;
export type ContractRenewalInput = z.input<typeof contractRenewalInput>;
export type ContractMarkdownCreateInput = z.input<typeof contractMarkdownCreateInput>;
