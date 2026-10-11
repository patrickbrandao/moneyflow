import { relations } from 'drizzle-orm/relations';
import {
  users,
  sessions,
  entities,
  entityContacts,
  entityAddresses,
  entityBankAccounts,
  entityPixKeys,
  entityLinks,
  caixas,
  caixaMembers,
  financialAccounts,
  caixaHiddenCategories,
  categories,
  settlements,
  titles,
  transfers,
  attachments,
  titleAttachments,
  movements,
  settlementAttachments,
  movementAttachments,
  entityAttachments,
  nfeDocuments,
  nfeItems,
  cardInvoices,
  cardPurchases,
  cardInvoiceItems,
  recurrenceRules,
  cardPurchaseAttachments,
  statementCsvMappings,
  statementImports,
  classificationRules,
  statementLines,
  periodClosings,
} from './schema';

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  caixaMembers: many(caixaMembers),
  attachments: many(attachments),
  statementImports: many(statementImports),
  classificationRules: many(classificationRules),
  periodClosings: many(periodClosings),
}));

export const entityContactsRelations = relations(entityContacts, ({ one }) => ({
  entity: one(entities, {
    fields: [entityContacts.entityId],
    references: [entities.id],
  }),
}));

export const entitiesRelations = relations(entities, ({ many }) => ({
  entityContacts: many(entityContacts),
  entityAddresses: many(entityAddresses),
  entityBankAccounts: many(entityBankAccounts),
  entityPixKeys: many(entityPixKeys),
  entityLinks_entityId: many(entityLinks, {
    relationName: 'entityLinks_entityId_entities_id',
  }),
  entityLinks_relatedEntityId: many(entityLinks, {
    relationName: 'entityLinks_relatedEntityId_entities_id',
  }),
  caixas: many(caixas),
  movements: many(movements),
  entityAttachments: many(entityAttachments),
  nfeDocuments_issuerEntityId: many(nfeDocuments, {
    relationName: 'nfeDocuments_issuerEntityId_entities_id',
  }),
  nfeDocuments_recipientEntityId: many(nfeDocuments, {
    relationName: 'nfeDocuments_recipientEntityId_entities_id',
  }),
  cardPurchases: many(cardPurchases),
  titles: many(titles),
  classificationRules: many(classificationRules),
  statementLines: many(statementLines),
}));

export const entityAddressesRelations = relations(entityAddresses, ({ one }) => ({
  entity: one(entities, {
    fields: [entityAddresses.entityId],
    references: [entities.id],
  }),
}));

export const entityBankAccountsRelations = relations(entityBankAccounts, ({ one }) => ({
  entity: one(entities, {
    fields: [entityBankAccounts.entityId],
    references: [entities.id],
  }),
}));

export const entityPixKeysRelations = relations(entityPixKeys, ({ one }) => ({
  entity: one(entities, {
    fields: [entityPixKeys.entityId],
    references: [entities.id],
  }),
}));

export const entityLinksRelations = relations(entityLinks, ({ one }) => ({
  entity_entityId: one(entities, {
    fields: [entityLinks.entityId],
    references: [entities.id],
    relationName: 'entityLinks_entityId_entities_id',
  }),
  entity_relatedEntityId: one(entities, {
    fields: [entityLinks.relatedEntityId],
    references: [entities.id],
    relationName: 'entityLinks_relatedEntityId_entities_id',
  }),
}));

export const caixasRelations = relations(caixas, ({ one, many }) => ({
  caixa: one(caixas, {
    fields: [caixas.defaultPayerCaixaId],
    references: [caixas.id],
    relationName: 'caixas_defaultPayerCaixaId_caixas_id',
  }),
  caixas: many(caixas, {
    relationName: 'caixas_defaultPayerCaixaId_caixas_id',
  }),
  entity: one(entities, {
    fields: [caixas.holderEntityId],
    references: [entities.id],
  }),
  caixaMembers: many(caixaMembers),
  financialAccounts: many(financialAccounts),
  caixaHiddenCategories: many(caixaHiddenCategories),
  cardInvoices: many(cardInvoices),
  cardPurchases_cardCaixaId: many(cardPurchases, {
    relationName: 'cardPurchases_cardCaixaId_caixas_id',
  }),
  cardPurchases_payerCaixaId: many(cardPurchases, {
    relationName: 'cardPurchases_payerCaixaId_caixas_id',
  }),
  cardInvoiceItems: many(cardInvoiceItems),
  titles_caixaId: many(titles, {
    relationName: 'titles_caixaId_caixas_id',
  }),
  titles_counterpartyCaixaId: many(titles, {
    relationName: 'titles_counterpartyCaixaId_caixas_id',
  }),
  statementCsvMappings: many(statementCsvMappings),
  statementImports: many(statementImports),
  classificationRules: many(classificationRules),
  statementLines: many(statementLines),
  periodClosings: many(periodClosings),
}));

export const caixaMembersRelations = relations(caixaMembers, ({ one }) => ({
  caixa: one(caixas, {
    fields: [caixaMembers.caixaId],
    references: [caixas.id],
  }),
  user: one(users, {
    fields: [caixaMembers.userId],
    references: [users.id],
  }),
}));

export const financialAccountsRelations = relations(financialAccounts, ({ one, many }) => ({
  caixa: one(caixas, {
    fields: [financialAccounts.caixaId],
    references: [caixas.id],
  }),
  settlements: many(settlements),
  transfers_fromAccountId: many(transfers, {
    relationName: 'transfers_fromAccountId_financialAccounts_id',
  }),
  transfers_toAccountId: many(transfers, {
    relationName: 'transfers_toAccountId_financialAccounts_id',
  }),
  movements: many(movements),
  statementCsvMappings: many(statementCsvMappings),
  statementImports: many(statementImports),
  statementLines: many(statementLines),
}));

export const caixaHiddenCategoriesRelations = relations(caixaHiddenCategories, ({ one }) => ({
  caixa: one(caixas, {
    fields: [caixaHiddenCategories.caixaId],
    references: [caixas.id],
  }),
  category: one(categories, {
    fields: [caixaHiddenCategories.categoryId],
    references: [categories.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  caixaHiddenCategories: many(caixaHiddenCategories),
  category: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'categories_parentId_categories_id',
  }),
  categories: many(categories, {
    relationName: 'categories_parentId_categories_id',
  }),
  movements: many(movements),
  cardPurchases: many(cardPurchases),
  titles: many(titles),
  classificationRules: many(classificationRules),
  statementLines: many(statementLines),
}));

export const settlementsRelations = relations(settlements, ({ one, many }) => ({
  financialAccount: one(financialAccounts, {
    fields: [settlements.financialAccountId],
    references: [financialAccounts.id],
  }),
  settlement: one(settlements, {
    fields: [settlements.mirrorSettlementId],
    references: [settlements.id],
    relationName: 'settlements_mirrorSettlementId_settlements_id',
  }),
  settlements: many(settlements, {
    relationName: 'settlements_mirrorSettlementId_settlements_id',
  }),
  title: one(titles, {
    fields: [settlements.titleId],
    references: [titles.id],
  }),
  transfers: many(transfers),
  movements: many(movements),
  settlementAttachments: many(settlementAttachments),
}));

export const titlesRelations = relations(titles, ({ one, many }) => ({
  settlements: many(settlements),
  titleAttachments: many(titleAttachments),
  caixa_caixaId: one(caixas, {
    fields: [titles.caixaId],
    references: [caixas.id],
    relationName: 'titles_caixaId_caixas_id',
  }),
  cardInvoice: one(cardInvoices, {
    fields: [titles.cardInvoiceId],
    references: [cardInvoices.id],
  }),
  category: one(categories, {
    fields: [titles.categoryId],
    references: [categories.id],
  }),
  caixa_counterpartyCaixaId: one(caixas, {
    fields: [titles.counterpartyCaixaId],
    references: [caixas.id],
    relationName: 'titles_counterpartyCaixaId_caixas_id',
  }),
  entity: one(entities, {
    fields: [titles.entityId],
    references: [entities.id],
  }),
  title: one(titles, {
    fields: [titles.mirrorTitleId],
    references: [titles.id],
    relationName: 'titles_mirrorTitleId_titles_id',
  }),
  titles: many(titles, {
    relationName: 'titles_mirrorTitleId_titles_id',
  }),
  nfeDocument: one(nfeDocuments, {
    fields: [titles.nfeDocumentId],
    references: [nfeDocuments.id],
  }),
  recurrenceRule: one(recurrenceRules, {
    fields: [titles.recurrenceRuleId],
    references: [recurrenceRules.id],
  }),
  statementLines: many(statementLines),
}));

export const transfersRelations = relations(transfers, ({ one, many }) => ({
  financialAccount_fromAccountId: one(financialAccounts, {
    fields: [transfers.fromAccountId],
    references: [financialAccounts.id],
    relationName: 'transfers_fromAccountId_financialAccounts_id',
  }),
  settlement: one(settlements, {
    fields: [transfers.settlementId],
    references: [settlements.id],
  }),
  financialAccount_toAccountId: one(financialAccounts, {
    fields: [transfers.toAccountId],
    references: [financialAccounts.id],
    relationName: 'transfers_toAccountId_financialAccounts_id',
  }),
  movements: many(movements),
}));

export const titleAttachmentsRelations = relations(titleAttachments, ({ one }) => ({
  attachment: one(attachments, {
    fields: [titleAttachments.attachmentId],
    references: [attachments.id],
  }),
  title: one(titles, {
    fields: [titleAttachments.titleId],
    references: [titles.id],
  }),
}));

export const attachmentsRelations = relations(attachments, ({ one, many }) => ({
  titleAttachments: many(titleAttachments),
  user: one(users, {
    fields: [attachments.uploadedByUserId],
    references: [users.id],
  }),
  settlementAttachments: many(settlementAttachments),
  movementAttachments: many(movementAttachments),
  entityAttachments: many(entityAttachments),
  nfeDocuments: many(nfeDocuments),
  cardPurchaseAttachments: many(cardPurchaseAttachments),
  statementImports: many(statementImports),
}));

export const movementsRelations = relations(movements, ({ one, many }) => ({
  category: one(categories, {
    fields: [movements.categoryId],
    references: [categories.id],
  }),
  entity: one(entities, {
    fields: [movements.entityId],
    references: [entities.id],
  }),
  financialAccount: one(financialAccounts, {
    fields: [movements.financialAccountId],
    references: [financialAccounts.id],
  }),
  settlement: one(settlements, {
    fields: [movements.settlementId],
    references: [settlements.id],
  }),
  transfer: one(transfers, {
    fields: [movements.transferId],
    references: [transfers.id],
  }),
  movementAttachments: many(movementAttachments),
  statementLines: many(statementLines),
}));

export const settlementAttachmentsRelations = relations(settlementAttachments, ({ one }) => ({
  attachment: one(attachments, {
    fields: [settlementAttachments.attachmentId],
    references: [attachments.id],
  }),
  settlement: one(settlements, {
    fields: [settlementAttachments.settlementId],
    references: [settlements.id],
  }),
}));

export const movementAttachmentsRelations = relations(movementAttachments, ({ one }) => ({
  attachment: one(attachments, {
    fields: [movementAttachments.attachmentId],
    references: [attachments.id],
  }),
  movement: one(movements, {
    fields: [movementAttachments.movementId],
    references: [movements.id],
  }),
}));

export const entityAttachmentsRelations = relations(entityAttachments, ({ one }) => ({
  attachment: one(attachments, {
    fields: [entityAttachments.attachmentId],
    references: [attachments.id],
  }),
  entity: one(entities, {
    fields: [entityAttachments.entityId],
    references: [entities.id],
  }),
}));

export const nfeDocumentsRelations = relations(nfeDocuments, ({ one, many }) => ({
  entity_issuerEntityId: one(entities, {
    fields: [nfeDocuments.issuerEntityId],
    references: [entities.id],
    relationName: 'nfeDocuments_issuerEntityId_entities_id',
  }),
  entity_recipientEntityId: one(entities, {
    fields: [nfeDocuments.recipientEntityId],
    references: [entities.id],
    relationName: 'nfeDocuments_recipientEntityId_entities_id',
  }),
  attachment: one(attachments, {
    fields: [nfeDocuments.xmlAttachmentId],
    references: [attachments.id],
  }),
  nfeItems: many(nfeItems),
  titles: many(titles),
}));

export const nfeItemsRelations = relations(nfeItems, ({ one }) => ({
  nfeDocument: one(nfeDocuments, {
    fields: [nfeItems.nfeDocumentId],
    references: [nfeDocuments.id],
  }),
}));

export const cardInvoicesRelations = relations(cardInvoices, ({ one, many }) => ({
  caixa: one(caixas, {
    fields: [cardInvoices.cardCaixaId],
    references: [caixas.id],
  }),
  cardInvoiceItems_cardInvoiceId: many(cardInvoiceItems, {
    relationName: 'cardInvoiceItems_cardInvoiceId_cardInvoices_id',
  }),
  cardInvoiceItems_carriedFromInvoiceId: many(cardInvoiceItems, {
    relationName: 'cardInvoiceItems_carriedFromInvoiceId_cardInvoices_id',
  }),
  titles: many(titles),
  statementImports: many(statementImports),
}));

export const cardPurchasesRelations = relations(cardPurchases, ({ one, many }) => ({
  caixa_cardCaixaId: one(caixas, {
    fields: [cardPurchases.cardCaixaId],
    references: [caixas.id],
    relationName: 'cardPurchases_cardCaixaId_caixas_id',
  }),
  category: one(categories, {
    fields: [cardPurchases.categoryId],
    references: [categories.id],
  }),
  entity: one(entities, {
    fields: [cardPurchases.entityId],
    references: [entities.id],
  }),
  caixa_payerCaixaId: one(caixas, {
    fields: [cardPurchases.payerCaixaId],
    references: [caixas.id],
    relationName: 'cardPurchases_payerCaixaId_caixas_id',
  }),
  cardPurchase: one(cardPurchases, {
    fields: [cardPurchases.refundedPurchaseId],
    references: [cardPurchases.id],
    relationName: 'cardPurchases_refundedPurchaseId_cardPurchases_id',
  }),
  cardPurchases: many(cardPurchases, {
    relationName: 'cardPurchases_refundedPurchaseId_cardPurchases_id',
  }),
  cardInvoiceItems: many(cardInvoiceItems),
  cardPurchaseAttachments: many(cardPurchaseAttachments),
}));

export const cardInvoiceItemsRelations = relations(cardInvoiceItems, ({ one, many }) => ({
  cardInvoice_cardInvoiceId: one(cardInvoices, {
    fields: [cardInvoiceItems.cardInvoiceId],
    references: [cardInvoices.id],
    relationName: 'cardInvoiceItems_cardInvoiceId_cardInvoices_id',
  }),
  cardPurchase: one(cardPurchases, {
    fields: [cardInvoiceItems.cardPurchaseId],
    references: [cardPurchases.id],
  }),
  cardInvoice_carriedFromInvoiceId: one(cardInvoices, {
    fields: [cardInvoiceItems.carriedFromInvoiceId],
    references: [cardInvoices.id],
    relationName: 'cardInvoiceItems_carriedFromInvoiceId_cardInvoices_id',
  }),
  caixa: one(caixas, {
    fields: [cardInvoiceItems.payerCaixaId],
    references: [caixas.id],
  }),
  statementLines: many(statementLines),
}));

export const recurrenceRulesRelations = relations(recurrenceRules, ({ many }) => ({
  titles: many(titles),
}));

export const cardPurchaseAttachmentsRelations = relations(cardPurchaseAttachments, ({ one }) => ({
  attachment: one(attachments, {
    fields: [cardPurchaseAttachments.attachmentId],
    references: [attachments.id],
  }),
  cardPurchase: one(cardPurchases, {
    fields: [cardPurchaseAttachments.cardPurchaseId],
    references: [cardPurchases.id],
  }),
}));

export const statementCsvMappingsRelations = relations(statementCsvMappings, ({ one, many }) => ({
  caixa: one(caixas, {
    fields: [statementCsvMappings.cardCaixaId],
    references: [caixas.id],
  }),
  financialAccount: one(financialAccounts, {
    fields: [statementCsvMappings.financialAccountId],
    references: [financialAccounts.id],
  }),
  statementImports: many(statementImports),
}));

export const statementImportsRelations = relations(statementImports, ({ one, many }) => ({
  attachment: one(attachments, {
    fields: [statementImports.attachmentId],
    references: [attachments.id],
  }),
  caixa: one(caixas, {
    fields: [statementImports.cardCaixaId],
    references: [caixas.id],
  }),
  cardInvoice: one(cardInvoices, {
    fields: [statementImports.cardInvoiceId],
    references: [cardInvoices.id],
  }),
  statementCsvMapping: one(statementCsvMappings, {
    fields: [statementImports.csvMappingId],
    references: [statementCsvMappings.id],
  }),
  financialAccount: one(financialAccounts, {
    fields: [statementImports.financialAccountId],
    references: [financialAccounts.id],
  }),
  user: one(users, {
    fields: [statementImports.importedByUserId],
    references: [users.id],
  }),
  statementLines: many(statementLines),
}));

export const classificationRulesRelations = relations(classificationRules, ({ one, many }) => ({
  caixa: one(caixas, {
    fields: [classificationRules.caixaId],
    references: [caixas.id],
  }),
  category: one(categories, {
    fields: [classificationRules.categoryId],
    references: [categories.id],
  }),
  user: one(users, {
    fields: [classificationRules.createdByUserId],
    references: [users.id],
  }),
  statementLine: one(statementLines, {
    fields: [classificationRules.createdFromLineId],
    references: [statementLines.id],
    relationName: 'classificationRules_createdFromLineId_statementLines_id',
  }),
  entity: one(entities, {
    fields: [classificationRules.entityId],
    references: [entities.id],
  }),
  statementLines: many(statementLines, {
    relationName: 'statementLines_classificationRuleId_classificationRules_id',
  }),
}));

export const statementLinesRelations = relations(statementLines, ({ one, many }) => ({
  classificationRules: many(classificationRules, {
    relationName: 'classificationRules_createdFromLineId_statementLines_id',
  }),
  caixa: one(caixas, {
    fields: [statementLines.cardCaixaId],
    references: [caixas.id],
  }),
  cardInvoiceItem: one(cardInvoiceItems, {
    fields: [statementLines.cardInvoiceItemId],
    references: [cardInvoiceItems.id],
  }),
  category: one(categories, {
    fields: [statementLines.categoryId],
    references: [categories.id],
  }),
  classificationRule: one(classificationRules, {
    fields: [statementLines.classificationRuleId],
    references: [classificationRules.id],
    relationName: 'statementLines_classificationRuleId_classificationRules_id',
  }),
  entity: one(entities, {
    fields: [statementLines.entityId],
    references: [entities.id],
  }),
  financialAccount: one(financialAccounts, {
    fields: [statementLines.financialAccountId],
    references: [financialAccounts.id],
  }),
  movement: one(movements, {
    fields: [statementLines.movementId],
    references: [movements.id],
  }),
  statementImport: one(statementImports, {
    fields: [statementLines.statementImportId],
    references: [statementImports.id],
  }),
  title: one(titles, {
    fields: [statementLines.titleId],
    references: [titles.id],
  }),
}));

export const periodClosingsRelations = relations(periodClosings, ({ one }) => ({
  caixa: one(caixas, {
    fields: [periodClosings.caixaId],
    references: [caixas.id],
  }),
  user: one(users, {
    fields: [periodClosings.closedByUserId],
    references: [users.id],
  }),
}));
