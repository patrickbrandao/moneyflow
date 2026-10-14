import { z } from 'zod';
import {
  CONTRACT_DOCUMENT_KINDS,
  CONTRACT_MARKDOWN_MAX_BYTES,
  CONTRACT_MAX_DUE_OFFSET,
  CONTRACT_MAX_MONTHS,
  CONTRACT_PERIODICITIES,
  CONTRACT_STATUSES,
  installmentsCount,
  READJUSTMENT_INDEXES,
} from '../contracts';
import { ptBR } from '../i18n/pt-BR';
import { id, isoDate, optionalText, positiveCents, queryBool, requiredText } from './common';

/* Entradas dos contratos (spec 020). */

const E = ptBR.contracts.errors;
const DIRECTIONS = ['receivable', 'payable'] as const;

const durationMonths = z.number().int().min(1).max(CONTRACT_MAX_MONTHS);
const dueDay = z.number().int().min(1).max(31);
const dueMonthOffset = z.number().int().min(0).max(CONTRACT_MAX_DUE_OFFSET);
const periodicity = z.enum(CONTRACT_PERIODICITIES);

export const durationFitsPeriod = (
  value: { durationMonths?: number; periodicity?: (typeof CONTRACT_PERIODICITIES)[number] },
  ctx: z.RefinementCtx,
) => {
  if (value.durationMonths === undefined || value.periodicity === undefined) return;
  if (installmentsCount(value.durationMonths, value.periodicity) === null)
    ctx.addIssue({ code: 'custom', path: ['durationMonths'], message: E.durationNotMultiple });
};

/** Configuração livre (muda a qualquer momento, inclusive vigente). */
const settings = {
  name: requiredText(200),
  contractNumber: optionalText(60),
  notes: optionalText(4000),
  autoRenew: z.boolean(),
  noticeDays: z.number().int().min(0).max(365),
  renewalLeadDays: z.number().int().min(1).max(365),
  reminderEveryDays: z.number().int().min(1).max(30),
  readjustmentIndex: z.enum(READJUSTMENT_INDEXES),
  readjustmentBaseDate: isoDate.nullish().transform((v) => v ?? null),
  terminationPenaltyText: optionalText(2000),
  terminationPenaltyCents: positiveCents.nullish().transform((v) => v ?? null),
};

/** Condições do ciclo (rascunho; vigente só por aditivo ou renovação). */
const terms = {
  startsOn: isoDate,
  durationMonths,
  periodicity,
  totalCents: positiveCents,
  dueDay,
  dueMonthOffset,
};

/** Campos do cadastro (sem a checagem duração × periodicidade, que entra no contractCreateInput). */
export const contractCreateFields = z.object({
  caixaId: id,
  entityId: id,
  direction: z.enum(DIRECTIONS),
  categoryId: id,
  ...settings,
  autoRenew: settings.autoRenew.default(false),
  noticeDays: settings.noticeDays.default(30),
  renewalLeadDays: settings.renewalLeadDays.default(60),
  reminderEveryDays: settings.reminderEveryDays.default(7),
  readjustmentIndex: settings.readjustmentIndex.default('none'),
  ...terms,
  /** Caixa do espelho: omitido = caixa principal da entidade (se houver); null = sem espelho. */
  mirrorCaixaId: id.nullish(),
  /** Ativar já na criação (gera as parcelas). */
  activate: z.boolean().default(false),
});

export const contractCreateInput = contractCreateFields.superRefine(durationFitsPeriod);

export const contractUpdateInput = z
  .object({
    entityId: id,
    categoryId: id,
    mirrorCaixaId: id.nullable(),
    ...settings,
    ...terms,
  })
  .partial()
  .superRefine(durationFitsPeriod);

export const CONTRACT_LIST_STATUSES = [...CONTRACT_STATUSES, 'current'] as const;

export const contractListQuery = z.object({
  caixaId: id.optional(),
  entityId: id.optional(),
  direction: z.enum(DIRECTIONS).optional(),
  /** `current` = vigente ou com renovação pendente. */
  status: z.enum(CONTRACT_LIST_STATUSES).optional(),
  /** Termina (fim do ciclo atual) ou tem renovação nos próximos N dias. */
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  q: z.string().trim().max(200).optional(),
  archived: queryBool,
  limit: z.coerce.number().int().min(1).max(500).default(300),
});

export const dryRunQuery = z.object({ dryRun: queryBool });

/** Aditivo: o que muda a partir da data de efeito (pelo menos uma coisa). */
export const contractAmendmentInput = z
  .object({
    effectiveOn: isoDate,
    installmentCents: positiveCents.nullish().transform((v) => v ?? null),
    remainingTotalCents: positiveCents.nullish().transform((v) => v ?? null),
    dueDay: dueDay.nullish().transform((v) => v ?? null),
    dueMonthOffset: dueMonthOffset.nullish().transform((v) => v ?? null),
    categoryId: id.nullish().transform((v) => v ?? null),
    documentId: id.nullish().transform((v) => v ?? null),
    notes: optionalText(2000),
  })
  .superRefine((value, ctx) => {
    if (value.installmentCents && value.remainingTotalCents)
      ctx.addIssue({ code: 'custom', path: ['remainingTotalCents'], message: E.amendmentValueEither });
    if (
      !value.installmentCents &&
      !value.remainingTotalCents &&
      value.dueDay === null &&
      value.dueMonthOffset === null &&
      value.categoryId === null
    )
      ctx.addIssue({ code: 'custom', path: ['effectiveOn'], message: E.amendmentNothing });
  });

/** Rescisão: data de encerramento, ajuste da parcela do mês e o título extra de multa. */
export const contractTerminationInput = z.object({
  terminatedOn: isoDate,
  /** Novo valor da parcela que cobre a data (proporcional); omitido = mantém. */
  currentInstallmentCents: positiveCents.nullish().transform((v) => v ?? null),
  penalty: z
    .object({
      direction: z.enum(DIRECTIONS),
      amountCents: positiveCents,
      dueDate: isoDate,
      categoryId: id,
      description: optionalText(300),
    })
    .nullish()
    .transform((v) => v ?? null),
  notes: optionalText(2000),
});

/** Renovação (aprovar a tarefa ou "Renovar" manual): o próximo ciclo. */
export const contractRenewalInput = z
  .object({
    durationMonths,
    periodicity,
    totalCents: positiveCents,
    readjustmentPercent: z
      .number()
      .min(-100)
      .max(1000)
      .nullish()
      .transform((v) => v ?? null),
    dueDay,
    dueMonthOffset,
    categoryId: id.nullish().transform((v) => v ?? null),
    notes: optionalText(2000),
  })
  .superRefine(durationFitsPeriod);

export const contractDeclineInput = z.object({ notes: optionalText(2000) });

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
export type ContractUpdateInput = z.input<typeof contractUpdateInput>;
export type ContractAmendmentInput = z.input<typeof contractAmendmentInput>;
export type ContractTerminationInput = z.input<typeof contractTerminationInput>;
export type ContractRenewalInput = z.input<typeof contractRenewalInput>;
export type ContractMarkdownCreateInput = z.input<typeof contractMarkdownCreateInput>;
