import { z } from 'zod';
import { ptBR } from '../i18n/pt-BR';
import { cents, id, idListQuery, isoDate, nonNegativeCents, optionalText, positiveCents, queryBool, requiredText } from './common';

/*
 * Entradas da fase 2 (operação): cartão (spec 007), extratos e conciliação
 * (009), anexos, auditoria e fechamento (008), entrada de títulos (010) e
 * calendário (012).
 */

const E = ptBR.errors;

/** 1º dia do mês ('YYYY-MM-01'); aceita 'YYYY-MM'. */
export const monthStart = z
  .string()
  .trim()
  .transform((v) => (/^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v))
  .refine((v) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(v), E.invalidMonth);

/* ---------------- cartão ---------------- */

export const CHARGE_KINDS = ['interest', 'iof', 'fine', 'fee', 'other'] as const;

export const cardPurchaseInput = z
  .object({
    entityId: id,
    categoryId: id,
    /** Omitida: a pagadora padrão do cartão. */
    payerCaixaId: id.nullish(),
    purchasedOn: isoDate,
    description: requiredText(300),
    /** Valor total (todas as parcelas registradas). */
    amountCents: positiveCents,
    installmentsTotal: z.number().int().min(1).max(99).default(1),
    /** > 1 ao começar a usar o app no meio de um parcelamento. */
    firstInstallment: z.number().int().min(1).max(99).default(1),
    notes: optionalText(),
  })
  .refine((v) => v.firstInstallment <= v.installmentsTotal, { path: ['firstInstallment'], message: E.validation })
  .refine((v) => v.amountCents >= v.installmentsTotal - v.firstInstallment + 1, { path: ['amountCents'], message: E.invalidAmount });

export const cardPurchaseUpdateInput = z.object({
  description: requiredText(300).optional(),
  notes: optionalText().optional(),
  categoryId: id.optional(),
  entityId: id.optional(),
  payerCaixaId: id.optional(),
});

export const cardRefundInput = z.object({
  amountCents: positiveCents,
  refundedOn: isoDate,
  description: optionalText(300),
});

export const cardChargeInput = z.object({
  chargeKind: z.enum(CHARGE_KINDS),
  amountCents: positiveCents,
  categoryId: id,
  payerCaixaId: id.nullish(),
  chargedOn: isoDate,
  description: optionalText(300),
});

export const cardPurchaseListQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  payerCaixaId: id.optional(),
  q: z.string().trim().max(200).optional(),
  kind: z.enum(['purchase', 'refund', 'charge']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

export const invoiceCloseInput = z.object({
  /** Categoria do título "a pagar" por caixa pagadora (omitida: escolhida automaticamente). */
  payerCategoryIds: z.record(z.string(), id).default({}),
  /** Categoria do título "a receber" no cartão (omitida: automática). */
  cardCategoryId: id.nullish(),
});

export const invoiceUpdateInput = z.object({
  closingDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  notes: optionalText().optional(),
});

const chargeLine = z.object({
  chargeKind: z.enum(CHARGE_KINDS),
  amountCents: positiveCents,
  categoryId: id,
  description: optionalText(300),
});

/** Pagamento de fatura fechada: total (valor = aberto) ou parcial (o resto rola, com encargos). */
export const invoicePaymentInput = z.object({
  payerCaixaId: id,
  settledOn: isoDate,
  /** 0 = nada pago (o título é cancelado e tudo rola). */
  amountCents: nonNegativeCents,
  financialAccountId: id.nullish().transform((v) => v ?? null),
  /** Conta de outra caixa que paga de fato (gera transferência). */
  sourceAccountId: id.nullish(),
  charges: z.array(chargeLine).max(10).default([]),
  notes: optionalText(),
});

/** Pagamento antecipado (fatura aberta). */
export const invoiceAdvanceInput = z.object({
  payerCaixaId: id,
  settledOn: isoDate,
  amountCents: positiveCents,
  financialAccountId: id,
  categoryId: id.nullish(),
  notes: optionalText(),
});

/* ---------------- extratos e conciliação ---------------- */

export const csvColumnRef = z.union([z.number().int().min(0).max(500), z.string().trim().min(1).max(120)]);

export const csvMappingColumns = z
  .object({
    date: csvColumnRef,
    description: csvColumnRef,
    amount: csvColumnRef.optional(),
    debit: csvColumnRef.optional(),
    credit: csvColumnRef.optional(),
    fitid: csvColumnRef.optional(),
    balance: csvColumnRef.optional(),
    document: csvColumnRef.optional(),
  })
  .refine((v) => v.amount !== undefined || (v.debit !== undefined && v.credit !== undefined), {
    path: ['amount'],
    message: E.csvAmountColumn,
  });

export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export const CSV_ENCODINGS = ['utf-8', 'latin1', 'windows-1252'] as const;

export const csvMappingInput = z.object({
  financialAccountId: id.nullish(),
  cardCaixaId: id.nullish(),
  name: requiredText(80),
  delimiter: z.enum(CSV_DELIMITERS).default(';'),
  encoding: z.enum(CSV_ENCODINGS).default('utf-8'),
  hasHeader: z.boolean().default(true),
  skipRows: z.number().int().min(0).max(100).default(0),
  dateFormat: requiredText(20).default('dd/MM/yyyy'),
  decimalSeparator: z.enum([',', '.']).default(','),
  columns: csvMappingColumns,
  isDefault: z.boolean().default(false),
});

export const csvMappingUpdateInput = z.object({
  name: requiredText(80).optional(),
  delimiter: z.enum(CSV_DELIMITERS).optional(),
  encoding: z.enum(CSV_ENCODINGS).optional(),
  hasHeader: z.boolean().optional(),
  skipRows: z.number().int().min(0).max(100).optional(),
  dateFormat: requiredText(20).optional(),
  decimalSeparator: z.enum([',', '.']).optional(),
  columns: csvMappingColumns.optional(),
  isDefault: z.boolean().optional(),
});

export const statementTargetQuery = z
  .object({ accountId: id.optional(), cardCaixaId: id.optional() })
  .refine((v) => (v.accountId ? 1 : 0) + (v.cardCaixaId ? 1 : 0) === 1, { message: E.statementTarget });

/** Busca por descrição nas linhas dos lotes de uma conta ou cartão (spec 009); `importIds` vazio = todos os lotes. */
export const statementLineSearchQuery = z
  .object({
    accountId: id.optional(),
    cardCaixaId: id.optional(),
    q: z.string().trim().min(2).max(200),
    importIds: idListQuery(200),
  })
  .refine((v) => (v.accountId ? 1 : 0) + (v.cardCaixaId ? 1 : 0) === 1, { message: E.statementTarget });

/** Aplicar as regras de classificação às linhas novas de todas as contas da caixa (spec 009). */
export const applyRulesInput = z.object({ caixaId: id });

/** Query do upload do extrato (o corpo é o arquivo). */
export const statementImportQuery = z
  .object({
    accountId: id.optional(),
    cardCaixaId: id.optional(),
    fileName: requiredText(255),
    mappingId: id.optional(),
    cardInvoiceId: id.optional(),
    bankBalanceCents: z.coerce.number().int().safe().optional(),
    bankBalanceOn: isoDate.optional(),
  })
  .refine((v) => (v.accountId ? 1 : 0) + (v.cardCaixaId ? 1 : 0) === 1, { message: E.statementTarget })
  .refine((v) => (v.bankBalanceCents === undefined) === (v.bankBalanceOn === undefined), {
    path: ['bankBalanceOn'],
    message: E.validation,
  });

export const LINE_STATUSES = ['matched', 'suggested', 'new', 'ignored'] as const;

export const lineIdsInput = z.object({ lineIds: z.array(id).min(1).max(1000) });

export const lineMatchInput = z
  .object({ movementId: id.optional(), titleId: id.optional(), cardInvoiceItemId: id.optional() })
  .refine((v) => [v.movementId, v.titleId, v.cardInvoiceItemId].filter(Boolean).length === 1, { message: E.validation });

export const LINE_CREATE_MODES = ['adjustment', 'title', 'purchase'] as const;

export const lineCreateInput = z.object({
  /** adjustment = movimento avulso; title = título já baixado; purchase = compra no cartão (import de fatura). */
  mode: z.enum(LINE_CREATE_MODES),
  entityId: id.nullish().transform((v) => v ?? null),
  categoryId: id.nullish().transform((v) => v ?? null),
  description: optionalText(300),
  /** purchase: caixa pagadora da compra; omitida = a pagadora padrão do cartão. */
  payerCaixaId: id.nullish(),
  /**
   * title: caixa do espelho, como em titleCreateInput (spec 006). Omitida = a
   * caixa principal da entidade (se houver); null = sem espelho.
   */
  mirrorCaixaId: id.nullish(),
  /** title: categoria do lado espelho; omitida = escolhida automaticamente. */
  mirrorCategoryId: id.nullish(),
  /** Aprende a regra descrição → entidade/categoria (spec 009). */
  learnRule: z.boolean().default(true),
});

export const lineClassifyInput = z.object({
  entityId: id.nullish().transform((v) => v ?? null),
  categoryId: id.nullish().transform((v) => v ?? null),
  learnRule: z.boolean().default(false),
});

export const MATCH_KINDS = ['contains', 'starts_with', 'exact', 'regex'] as const;

export const classificationRuleInput = z
  .object({
    caixaId: id.nullish().transform((v) => v ?? null),
    matchKind: z.enum(MATCH_KINDS).default('contains'),
    pattern: requiredText(200),
    direction: z
      .enum(['in', 'out'])
      .nullish()
      .transform((v) => v ?? null),
    entityId: id.nullish().transform((v) => v ?? null),
    categoryId: id.nullish().transform((v) => v ?? null),
    priority: z.number().int().min(0).max(1000).default(100),
  })
  .refine((v) => v.entityId || v.categoryId, { path: ['entityId'], message: E.ruleTarget })
  .refine((v) => !v.categoryId || v.direction, { path: ['direction'], message: E.ruleDirection });

export const classificationRuleUpdateInput = z.object({
  matchKind: z.enum(MATCH_KINDS).optional(),
  pattern: requiredText(200).optional(),
  direction: z.enum(['in', 'out']).nullish(),
  entityId: id.nullish(),
  categoryId: id.nullish(),
  priority: z.number().int().min(0).max(1000).optional(),
});

export const ruleListQuery = z.object({ caixaId: id.optional(), archived: queryBool });

/* ---------------- anexos ---------------- */

export const ATTACHMENT_TARGETS = ['title', 'settlement', 'movement', 'card_purchase', 'entity'] as const;

export const attachmentTargetQuery = z.object({ target: z.enum(ATTACHMENT_TARGETS), targetId: id });
export const attachmentUploadQuery = attachmentTargetQuery.extend({ fileName: requiredText(255) });

/* ---------------- auditoria e fechamento ---------------- */

export const AUDIT_TABLES = [
  'entities',
  'caixas',
  'caixa_members',
  'financial_accounts',
  'categories',
  'titles',
  'settlements',
  'movements',
  'transfers',
  'card_invoices',
  'card_purchases',
  'card_invoice_items',
  'statement_imports',
  'statement_lines',
  'classification_rules',
  'attachments',
  'period_closings',
  'users',
] as const;

export const auditRecordQuery = z.object({ table: z.string().trim().min(1).max(63), recordId: id });

export const auditListQuery = z.object({
  table: z.string().trim().max(63).optional(),
  userId: id.optional(),
  actorKind: z.enum(['human', 'agent', 'system']).optional(),
  recordId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Paginação: created_at/id do último item da página anterior. */
  before: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const periodClosingInput = z.object({
  month: monthStart,
  notes: optionalText(500),
  /** Fecha mesmo com linhas de extrato do mês ainda não conciliadas. */
  force: z.boolean().default(false),
});

/* ---------------- entrada de títulos ---------------- */

export const pixEntryInput = z.object({
  payload: z.string().trim().min(1).max(512),
  /** Cria a entidade recebedora (com a chave PIX) quando não houver uma. */
  createEntity: z.boolean().default(false),
});

export const nfeEntryQuery = z.object({ fileName: requiredText(255).default('nfe.xml') });

/* ---------------- calendário ---------------- */

export const calendarQuery = z.object({
  from: isoDate,
  to: isoDate,
  /** Lista separada por vírgula; omitida = todas as caixas legíveis. */
  caixaIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(id).max(200)),
});

export const balancesQuery = z
  .object({ from: isoDate, to: isoDate, caixaId: id.optional(), accountId: id.optional() })
  .refine((v) => (v.caixaId ? 1 : 0) + (v.accountId ? 1 : 0) === 1, { message: E.validation });

export type CardPurchaseInput = z.input<typeof cardPurchaseInput>;
export type CardRefundInput = z.input<typeof cardRefundInput>;
export type CardChargeInput = z.input<typeof cardChargeInput>;
export type InvoicePaymentInput = z.input<typeof invoicePaymentInput>;
export type InvoiceAdvanceInput = z.input<typeof invoiceAdvanceInput>;
export type CsvMappingInput = z.input<typeof csvMappingInput>;
export type LineCreateInput = z.input<typeof lineCreateInput>;
export type ClassificationRuleInput = z.input<typeof classificationRuleInput>;
export type PeriodClosingInput = z.input<typeof periodClosingInput>;

/** Valor assinado com zero proibido (movimento avulso, linhas). */
export const nonZeroCents = cents.refine((v) => v !== 0, E.invalidAmount);
