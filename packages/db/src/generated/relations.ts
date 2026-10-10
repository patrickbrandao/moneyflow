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
  titles,
  recurrenceRules,
  settlements,
  transfers,
  movements,
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
  titles: many(titles),
  movements: many(movements),
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
  titles_caixaId: many(titles, {
    relationName: 'titles_caixaId_caixas_id',
  }),
  titles_counterpartyCaixaId: many(titles, {
    relationName: 'titles_counterpartyCaixaId_caixas_id',
  }),
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
  titles: many(titles),
  movements: many(movements),
}));

export const titlesRelations = relations(titles, ({ one, many }) => ({
  caixa_caixaId: one(caixas, {
    fields: [titles.caixaId],
    references: [caixas.id],
    relationName: 'titles_caixaId_caixas_id',
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
  recurrenceRule: one(recurrenceRules, {
    fields: [titles.recurrenceRuleId],
    references: [recurrenceRules.id],
  }),
  settlements: many(settlements),
}));

export const recurrenceRulesRelations = relations(recurrenceRules, ({ many }) => ({
  titles: many(titles),
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

export const movementsRelations = relations(movements, ({ one }) => ({
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
}));
