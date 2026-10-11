import { bytea } from '../bytea';
import { citext } from '../citext';
import {
  pgTable,
  index,
  foreignKey,
  check,
  text,
  uuid,
  timestamp,
  inet,
  unique,
  boolean,
  date,
  uniqueIndex,
  bigint,
  smallint,
  integer,
  numeric,
  jsonb,
  pgView,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    ip: inet(),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('sessions_expires_at_idx').using('btree', table.expiresAt.asc().nullsLast().op('timestamptz_ops')),
    index('sessions_user_id_idx').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'sessions_user_id_fkey',
    }).onDelete('cascade'),
    check('sessions_expires_at_check', sql`expires_at > created_at`),
    check('sessions_id_check', sql`(length(id) >= 32) AND (length(id) <= 128)`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    username: citext('username').notNull(),
    email: citext('email').notNull(),
    password: text().notNull(),
    role: text().default('user').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    unique('users_email_key').on(table.email),
    unique('users_username_key').on(table.username),
    check(
      'users_email_format_check',
      sql`(email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::citext) AND (length((email)::text) <= 254)`,
    ),
    check('users_password_check', sql`password <> ''::text`),
    check('users_role_check', sql`role = ANY (ARRAY['admin'::text, 'user'::text])`),
    check('users_username_format_check', sql`username ~ '^[^@[:space:]]{3,64}$'::citext`),
  ],
);

export const entities = pgTable(
  'entities',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    kind: text().notNull(),
    name: text().notNull(),
    tradeName: text('trade_name'),
    document: text(),
    birthDate: date('birth_date'),
    notes: text(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('entities_name_trgm_idx').using('gin', table.name.asc().nullsLast().op('gin_trgm_ops')),
    index('entities_trade_name_trgm_idx').using('gin', table.tradeName.asc().nullsLast().op('gin_trgm_ops')),
    unique('entities_document_key').on(table.document),
    check('entities_birth_date_check', sql`(birth_date IS NULL) OR (kind = 'person'::text)`),
    check(
      'entities_document_check',
      sql`(document IS NULL) OR ((kind = 'person'::text) AND is_valid_cpf(document)) OR ((kind = 'company'::text) AND is_valid_cnpj(document))`,
    ),
    check('entities_kind_check', sql`kind = ANY (ARRAY['person'::text, 'company'::text])`),
    check('entities_name_check', sql`btrim(name) <> ''::text`),
    check('entities_trade_name_check', sql`(trade_name IS NULL) OR ((kind = 'company'::text) AND (btrim(trade_name) <> ''::text))`),
  ],
);

export const entityContacts = pgTable(
  'entity_contacts',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: text().notNull(),
    value: text().notNull(),
    label: text(),
    isPrimary: boolean('is_primary').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('entity_contacts_primary_key')
      .using('btree', table.entityId.asc().nullsLast().op('text_ops'), table.kind.asc().nullsLast().op('uuid_ops'))
      .where(sql`is_primary`),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'entity_contacts_entity_id_fkey',
    }).onDelete('cascade'),
    unique('entity_contacts_value_key').on(table.entityId, table.kind, table.value),
    check('entity_contacts_kind_check', sql`kind = ANY (ARRAY['phone'::text, 'email'::text, 'other'::text])`),
    check(
      'entity_contacts_value_check',
      sql`(btrim(value) <> ''::text) AND ((kind <> 'email'::text) OR (value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text))`,
    ),
  ],
);

export const entityAddresses = pgTable(
  'entity_addresses',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    entityId: uuid('entity_id').notNull(),
    label: text(),
    postalCode: text('postal_code'),
    street: text(),
    number: text(),
    complement: text(),
    district: text(),
    city: text().notNull(),
    state: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('entity_addresses_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'entity_addresses_entity_id_fkey',
    }).onDelete('cascade'),
    check('entity_addresses_city_check', sql`btrim(city) <> ''::text`),
    check('entity_addresses_postal_code_check', sql`postal_code ~ '^[0-9]{8}$'::text`),
    check(
      'entity_addresses_state_check',
      sql`state = ANY (ARRAY['AC'::text, 'AL'::text, 'AP'::text, 'AM'::text, 'BA'::text, 'CE'::text, 'DF'::text, 'ES'::text, 'GO'::text, 'MA'::text, 'MT'::text, 'MS'::text, 'MG'::text, 'PA'::text, 'PB'::text, 'PR'::text, 'PE'::text, 'PI'::text, 'RJ'::text, 'RN'::text, 'RS'::text, 'RO'::text, 'RR'::text, 'SC'::text, 'SP'::text, 'SE'::text, 'TO'::text])`,
    ),
  ],
);

export const entityBankAccounts = pgTable(
  'entity_bank_accounts',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    entityId: uuid('entity_id').notNull(),
    bankCode: text('bank_code'),
    ispb: text(),
    branch: text(),
    accountNumber: text('account_number').notNull(),
    accountType: text('account_type').notNull(),
    holderName: text('holder_name'),
    label: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('entity_bank_accounts_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'entity_bank_accounts_entity_id_fkey',
    }).onDelete('cascade'),
    check('entity_bank_accounts_account_number_check', sql`account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'::text`),
    check(
      'entity_bank_accounts_account_type_check',
      sql`account_type = ANY (ARRAY['checking'::text, 'savings'::text, 'payment'::text, 'salary'::text])`,
    ),
    check('entity_bank_accounts_bank_check', sql`(bank_code IS NOT NULL) OR (ispb IS NOT NULL)`),
    check('entity_bank_accounts_bank_code_check', sql`bank_code ~ '^[0-9]{3}$'::text`),
    check('entity_bank_accounts_branch_check', sql`branch ~ '^[0-9]{1,6}(-[0-9A-Z])?$'::text`),
    check('entity_bank_accounts_ispb_check', sql`ispb ~ '^[0-9]{8}$'::text`),
  ],
);

export const entityPixKeys = pgTable(
  'entity_pix_keys',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    entityId: uuid('entity_id').notNull(),
    keyType: text('key_type').notNull(),
    keyValue: text('key_value').notNull(),
    bankCode: text('bank_code'),
    ispb: text(),
    label: text(),
    isPrimary: boolean('is_primary').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('entity_pix_keys_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('entity_pix_keys_primary_key').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')).where(sql`is_primary`),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'entity_pix_keys_entity_id_fkey',
    }).onDelete('cascade'),
    unique('entity_pix_keys_key_value_key').on(table.keyType, table.keyValue),
    check('entity_pix_keys_bank_code_check', sql`bank_code ~ '^[0-9]{3}$'::text`),
    check('entity_pix_keys_ispb_check', sql`ispb ~ '^[0-9]{8}$'::text`),
    check(
      'entity_pix_keys_key_type_check',
      sql`key_type = ANY (ARRAY['cpf'::text, 'cnpj'::text, 'email'::text, 'phone'::text, 'evp'::text])`,
    ),
    check(
      'entity_pix_keys_key_value_check',
      sql`CHECK (
CASE key_type
    WHEN 'cpf'::text THEN is_valid_cpf(key_value)
    WHEN 'cnpj'::text THEN is_valid_cnpj(key_value)
    WHEN 'email'::text THEN ((key_value = lower(key_value)) AND (length(key_value) <= 77) AND (key_value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text))
    WHEN 'phone'::text THEN (key_value ~ '^\+55[1-9]{2}[0-9]{8,9}$'::text)
    WHEN 'evp'::text THEN (key_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)
    ELSE NULL::boolean
END)`,
    ),
  ],
);

export const entityLinks = pgTable(
  'entity_links',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    entityId: uuid('entity_id').notNull(),
    relatedEntityId: uuid('related_entity_id').notNull(),
    kind: text().notNull(),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('entity_links_related_entity_id_idx').using('btree', table.relatedEntityId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('entity_links_spouse_key')
      .using('btree', sql`LEAST(entity_id, related_entity_id)`, sql`GREATEST(entity_id, related_entity_id)`)
      .where(sql`(kind = 'spouse_of'::text)`),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'entity_links_entity_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.relatedEntityId],
      foreignColumns: [entities.id],
      name: 'entity_links_related_entity_id_fkey',
    }).onDelete('cascade'),
    unique('entity_links_key').on(table.entityId, table.kind, table.relatedEntityId),
    check(
      'entity_links_kind_check',
      sql`kind = ANY (ARRAY['partner_of'::text, 'responsible_for'::text, 'spouse_of'::text, 'other'::text])`,
    ),
    check('entity_links_self_check', sql`entity_id <> related_entity_id`),
  ],
);

export const caixas = pgTable(
  'caixas',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    holderEntityId: uuid('holder_entity_id').notNull(),
    isPrimary: boolean('is_primary').default(false).notNull(),
    description: text(),
    defaultPayerCaixaId: uuid('default_payer_caixa_id'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    creditLimitCents: bigint('credit_limit_cents', { mode: 'number' }),
    closingDay: smallint('closing_day'),
    dueDay: smallint('due_day'),
    cardLast4: text('card_last4'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('caixas_default_payer_caixa_id_idx').using('btree', table.defaultPayerCaixaId.asc().nullsLast().op('uuid_ops')),
    index('caixas_holder_entity_id_idx').using('btree', table.holderEntityId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('caixas_holder_primary_key').using('btree', table.holderEntityId.asc().nullsLast().op('uuid_ops')).where(sql`is_primary`),
    foreignKey({
      columns: [table.defaultPayerCaixaId],
      foreignColumns: [table.id],
      name: 'caixas_default_payer_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.holderEntityId],
      foreignColumns: [entities.id],
      name: 'caixas_holder_entity_id_fkey',
    }),
    check(
      'caixas_card_fields_check',
      sql`CHECK (
CASE kind
    WHEN 'general'::text THEN ((default_payer_caixa_id IS NULL) AND (credit_limit_cents IS NULL) AND (closing_day IS NULL) AND (due_day IS NULL) AND (card_last4 IS NULL))
    WHEN 'credit_card'::text THEN ((default_payer_caixa_id IS NOT NULL) AND (credit_limit_cents IS NOT NULL) AND (closing_day IS NOT NULL) AND (due_day IS NOT NULL) AND (card_last4 IS NOT NULL))
    ELSE NULL::boolean
END)`,
    ),
    check('caixas_card_last4_check', sql`card_last4 ~ '^[0-9]{4}$'::text`),
    check('caixas_closing_day_check', sql`(closing_day >= 1) AND (closing_day <= 31)`),
    check('caixas_credit_limit_cents_check', sql`credit_limit_cents >= 0`),
    check('caixas_default_payer_self_check', sql`default_payer_caixa_id <> id`),
    check('caixas_due_day_check', sql`(due_day >= 1) AND (due_day <= 31)`),
    check('caixas_kind_check', sql`kind = ANY (ARRAY['general'::text, 'credit_card'::text])`),
    check('caixas_name_check', sql`btrim(name) <> ''::text`),
    check('caixas_primary_active_check', sql`NOT (is_primary AND (archived_at IS NOT NULL))`),
  ],
);

export const caixaMembers = pgTable(
  'caixa_members',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    role: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('caixa_members_caixa_id_idx').using('btree', table.caixaId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'caixa_members_caixa_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'caixa_members_user_id_fkey',
    }).onDelete('cascade'),
    unique('caixa_members_user_caixa_key').on(table.caixaId, table.userId),
    check('caixa_members_role_check', sql`role = ANY (ARRAY['editor'::text, 'viewer'::text])`),
  ],
);

export const financialAccounts = pgTable(
  'financial_accounts',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    caixaId: uuid('caixa_id').notNull(),
    kind: text().notNull(),
    name: text().notNull(),
    bankCode: text('bank_code'),
    ispb: text(),
    branch: text(),
    accountNumber: text('account_number'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }).default(0).notNull(),
    openingDate: date('opening_date').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('financial_accounts_caixa_id_idx').using('btree', table.caixaId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'financial_accounts_caixa_id_fkey',
    }),
    check('financial_accounts_account_number_check', sql`account_number ~ '^[0-9]{1,20}(-[0-9A-Z])?$'::text`),
    check('financial_accounts_bank_code_check', sql`bank_code ~ '^[0-9]{3}$'::text`),
    check(
      'financial_accounts_bank_fields_check',
      sql`(kind = ANY (ARRAY['checking'::text, 'savings'::text])) OR ((bank_code IS NULL) AND (ispb IS NULL) AND (branch IS NULL) AND (account_number IS NULL))`,
    ),
    check('financial_accounts_branch_check', sql`branch ~ '^[0-9]{1,6}(-[0-9A-Z])?$'::text`),
    check('financial_accounts_cash_balance_check', sql`(kind <> 'cash'::text) OR (opening_balance_cents >= 0)`),
    check('financial_accounts_ispb_check', sql`ispb ~ '^[0-9]{8}$'::text`),
    check('financial_accounts_kind_check', sql`kind = ANY (ARRAY['checking'::text, 'cash'::text, 'savings'::text])`),
    check('financial_accounts_name_check', sql`btrim(name) <> ''::text`),
  ],
);

export const caixaHiddenCategories = pgTable(
  'caixa_hidden_categories',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    caixaId: uuid('caixa_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('caixa_hidden_categories_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'caixa_hidden_categories_caixa_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: 'caixa_hidden_categories_category_id_fkey',
    }).onDelete('cascade'),
    unique('caixa_hidden_categories_key').on(table.caixaId, table.categoryId),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    kind: text().notNull(),
    parentId: uuid('parent_id'),
    name: text().notNull(),
    icon: text(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    colorSlot: smallint('color_slot'),
  },
  (table) => [
    index('categories_parent_id_idx').using('btree', table.parentId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('categories_sibling_name_key').using('btree', sql`kind`, sql`parent_id`, sql`lower(name)`),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: 'categories_parent_id_fkey',
    }),
    check('categories_color_slot_check', sql`(color_slot >= 1) AND (color_slot <= 12)`),
    check('categories_icon_check', sql`icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text`),
    check('categories_kind_check', sql`kind = ANY (ARRAY['income'::text, 'expense'::text])`),
    check('categories_name_check', sql`(btrim(name) <> ''::text) AND (name = btrim(name))`),
    check('categories_parent_self_check', sql`parent_id <> id`),
  ],
);

export const recurrenceRules = pgTable(
  'recurrence_rules',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    frequency: text().notNull(),
    intervalCount: smallint('interval_count').default(1).notNull(),
    anchorDay: smallint('anchor_day').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    installmentsTotal: smallint('installments_total'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'recurrence_rules_anchor_day_check',
      sql`CHECK (
CASE frequency
    WHEN 'weekly'::text THEN ((anchor_day >= 1) AND (anchor_day <= 7))
    ELSE ((anchor_day >= 1) AND (anchor_day <= 31))
END)`,
    ),
    check('recurrence_rules_end_check', sql`(ends_on IS NULL) OR (installments_total IS NULL)`),
    check('recurrence_rules_ends_on_check', sql`ends_on >= starts_on`),
    check('recurrence_rules_frequency_check', sql`frequency = ANY (ARRAY['weekly'::text, 'monthly'::text, 'yearly'::text])`),
    check('recurrence_rules_installments_total_check', sql`(installments_total >= 2) AND (installments_total <= 999)`),
    check('recurrence_rules_interval_count_check', sql`(interval_count >= 1) AND (interval_count <= 366)`),
  ],
);

export const settlements = pgTable(
  'settlements',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    titleId: uuid('title_id').notNull(),
    settledOn: date('settled_on').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    interestCents: bigint('interest_cents', { mode: 'number' }).default(0).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fineCents: bigint('fine_cents', { mode: 'number' }).default(0).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    discountCents: bigint('discount_cents', { mode: 'number' }).default(0).notNull(),
    financialAccountId: uuid('financial_account_id'),
    mirrorSettlementId: uuid('mirror_settlement_id'),
    notes: text(),
    reversedAt: timestamp('reversed_at', { withTimezone: true, mode: 'string' }),
    reversalReason: text('reversal_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('settlements_financial_account_id_idx').using('btree', table.financialAccountId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('settlements_mirror_settlement_id_key').using('btree', table.mirrorSettlementId.asc().nullsLast().op('uuid_ops')),
    index('settlements_settled_on_idx').using('btree', table.settledOn.asc().nullsLast().op('date_ops')),
    index('settlements_title_id_idx').using('btree', table.titleId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.financialAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'settlements_financial_account_id_fkey',
    }),
    foreignKey({
      columns: [table.mirrorSettlementId],
      foreignColumns: [table.id],
      name: 'settlements_mirror_settlement_id_fkey',
    }),
    foreignKey({
      columns: [table.titleId],
      foreignColumns: [titles.id],
      name: 'settlements_title_id_fkey',
    }),
    check('settlements_amount_cents_check', sql`amount_cents > 0`),
    check('settlements_charges_check', sql`(interest_cents >= 0) AND (fine_cents >= 0) AND (discount_cents >= 0)`),
    check('settlements_discount_check', sql`discount_cents <= ((amount_cents + interest_cents) + fine_cents)`),
    check('settlements_mirror_self_check', sql`mirror_settlement_id <> id`),
    check('settlements_reversal_check', sql`((reversed_at IS NULL) = (reversal_reason IS NULL)) AND (btrim(reversal_reason) <> ''::text)`),
  ],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    fromAccountId: uuid('from_account_id').notNull(),
    toAccountId: uuid('to_account_id').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    transferredOn: date('transferred_on').notNull(),
    description: text(),
    settlementId: uuid('settlement_id'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('transfers_from_account_id_idx').using('btree', table.fromAccountId.asc().nullsLast().op('uuid_ops')),
    index('transfers_to_account_id_idx').using('btree', table.toAccountId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.fromAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'transfers_from_account_id_fkey',
    }),
    foreignKey({
      columns: [table.settlementId],
      foreignColumns: [settlements.id],
      name: 'transfers_settlement_id_fkey',
    }),
    foreignKey({
      columns: [table.toAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'transfers_to_account_id_fkey',
    }),
    unique('transfers_settlement_id_key').on(table.settlementId),
    check('transfers_accounts_check', sql`from_account_id <> to_account_id`),
    check('transfers_amount_cents_check', sql`amount_cents > 0`),
  ],
);

export const titleAttachments = pgTable(
  'title_attachments',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    titleId: uuid('title_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('title_attachments_attachment_id_idx').using('btree', table.attachmentId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
      name: 'title_attachments_attachment_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.titleId],
      foreignColumns: [titles.id],
      name: 'title_attachments_title_id_fkey',
    }).onDelete('cascade'),
    unique('title_attachments_key').on(table.attachmentId, table.titleId),
  ],
);

export const movements = pgTable(
  'movements',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    financialAccountId: uuid('financial_account_id').notNull(),
    occurredOn: date('occurred_on').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    kind: text().notNull(),
    settlementId: uuid('settlement_id'),
    transferId: uuid('transfer_id'),
    description: text(),
    entityId: uuid('entity_id'),
    categoryId: uuid('category_id'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('movements_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    index('movements_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    index('movements_financial_account_id_occurred_on_idx').using(
      'btree',
      table.financialAccountId.asc().nullsLast().op('uuid_ops'),
      table.occurredOn.asc().nullsLast().op('uuid_ops'),
    ),
    index('movements_settlement_id_idx').using('btree', table.settlementId.asc().nullsLast().op('uuid_ops')),
    index('movements_transfer_id_idx').using('btree', table.transferId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: 'movements_category_id_fkey',
    }),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'movements_entity_id_fkey',
    }),
    foreignKey({
      columns: [table.financialAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'movements_financial_account_id_fkey',
    }),
    foreignKey({
      columns: [table.settlementId],
      foreignColumns: [settlements.id],
      name: 'movements_settlement_id_fkey',
    }),
    foreignKey({
      columns: [table.transferId],
      foreignColumns: [transfers.id],
      name: 'movements_transfer_id_fkey',
    }).onDelete('cascade'),
    check('movements_amount_cents_check', sql`amount_cents <> 0`),
    check('movements_kind_check', sql`kind = ANY (ARRAY['settlement'::text, 'transfer'::text, 'adjustment'::text])`),
    check(
      'movements_kind_links_check',
      sql`CHECK (
CASE kind
    WHEN 'settlement'::text THEN ((settlement_id IS NOT NULL) AND (transfer_id IS NULL) AND (category_id IS NULL))
    WHEN 'transfer'::text THEN ((transfer_id IS NOT NULL) AND (settlement_id IS NULL) AND (category_id IS NULL))
    WHEN 'adjustment'::text THEN ((settlement_id IS NULL) AND (transfer_id IS NULL))
    ELSE NULL::boolean
END)`,
    ),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    content: bytea('content').notNull(),
    sizeBytes: integer('size_bytes').notNull().generatedAlwaysAs(sql`octet_length(content)`),
    sha256: text().notNull().generatedAlwaysAs(sql`encode(sha256(content), 'hex'::text)`),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('attachments_sha256_idx').using('btree', table.sha256.asc().nullsLast().op('text_ops')),
    index('attachments_uploaded_by_user_id_idx').using('btree', table.uploadedByUserId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.uploadedByUserId],
      foreignColumns: [users.id],
      name: 'attachments_uploaded_by_user_id_fkey',
    }).onDelete('set null'),
    check(
      'attachments_file_name_check',
      sql`(btrim(file_name) <> ''::text) AND (length(file_name) <= 255) AND (file_name !~ '[/\\[:cntrl:]]'::text)`,
    ),
    check(
      'attachments_mime_type_check',
      sql`(mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'::text) AND (length(mime_type) <= 127)`,
    ),
    check('attachments_size_check', sql`(octet_length(content) >= 1) AND (octet_length(content) <= 20971520)`),
  ],
);

export const settlementAttachments = pgTable(
  'settlement_attachments',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    settlementId: uuid('settlement_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('settlement_attachments_attachment_id_idx').using('btree', table.attachmentId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
      name: 'settlement_attachments_attachment_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.settlementId],
      foreignColumns: [settlements.id],
      name: 'settlement_attachments_settlement_id_fkey',
    }).onDelete('cascade'),
    unique('settlement_attachments_key').on(table.attachmentId, table.settlementId),
  ],
);

export const movementAttachments = pgTable(
  'movement_attachments',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    movementId: uuid('movement_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('movement_attachments_attachment_id_idx').using('btree', table.attachmentId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
      name: 'movement_attachments_attachment_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.movementId],
      foreignColumns: [movements.id],
      name: 'movement_attachments_movement_id_fkey',
    }).onDelete('cascade'),
    unique('movement_attachments_key').on(table.attachmentId, table.movementId),
  ],
);

export const entityAttachments = pgTable(
  'entity_attachments',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    entityId: uuid('entity_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('entity_attachments_attachment_id_idx').using('btree', table.attachmentId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
      name: 'entity_attachments_attachment_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'entity_attachments_entity_id_fkey',
    }).onDelete('cascade'),
    unique('entity_attachments_key').on(table.attachmentId, table.entityId),
  ],
);

export const nfeDocuments = pgTable(
  'nfe_documents',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    accessKey: text('access_key').notNull(),
    issuerEntityId: uuid('issuer_entity_id').notNull(),
    recipientEntityId: uuid('recipient_entity_id'),
    number: integer().notNull(),
    series: smallint().notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    xmlAttachmentId: uuid('xml_attachment_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('nfe_documents_issuer_entity_id_idx').using('btree', table.issuerEntityId.asc().nullsLast().op('uuid_ops')),
    index('nfe_documents_recipient_entity_id_idx').using('btree', table.recipientEntityId.asc().nullsLast().op('uuid_ops')),
    index('nfe_documents_xml_attachment_id_idx').using('btree', table.xmlAttachmentId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.issuerEntityId],
      foreignColumns: [entities.id],
      name: 'nfe_documents_issuer_entity_id_fkey',
    }),
    foreignKey({
      columns: [table.recipientEntityId],
      foreignColumns: [entities.id],
      name: 'nfe_documents_recipient_entity_id_fkey',
    }),
    foreignKey({
      columns: [table.xmlAttachmentId],
      foreignColumns: [attachments.id],
      name: 'nfe_documents_xml_attachment_id_fkey',
    }),
    unique('nfe_documents_access_key_key').on(table.accessKey),
    check('nfe_documents_access_key_check', sql`CHECK (is_valid_nfe_access_key(access_key`),
    check('nfe_documents_number_check', sql`(number >= 1) AND (number <= 999999999)`),
    check('nfe_documents_parties_check', sql`recipient_entity_id <> issuer_entity_id`),
    check('nfe_documents_series_check', sql`(series >= 0) AND (series <= 999)`),
    check('nfe_documents_total_cents_check', sql`total_cents >= 0`),
  ],
);

export const nfeItems = pgTable(
  'nfe_items',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    nfeDocumentId: uuid('nfe_document_id').notNull(),
    itemNumber: smallint('item_number').notNull(),
    productCode: text('product_code'),
    description: text().notNull(),
    ncm: text(),
    cfop: text(),
    unit: text(),
    quantity: numeric({ precision: 15, scale: 4 }).notNull(),
    unitPriceCents: numeric('unit_price_cents', { precision: 23, scale: 8 }).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.nfeDocumentId],
      foreignColumns: [nfeDocuments.id],
      name: 'nfe_items_nfe_document_id_fkey',
    }).onDelete('cascade'),
    unique('nfe_items_item_number_key').on(table.itemNumber, table.nfeDocumentId),
    check('nfe_items_amounts_check', sql`(unit_price_cents >= (0)::numeric) AND (total_cents >= 0)`),
    check('nfe_items_cfop_check', sql`cfop ~ '^[1-7][0-9]{3}$'::text`),
    check('nfe_items_description_check', sql`btrim(description) <> ''::text`),
    check('nfe_items_item_number_check', sql`(item_number >= 1) AND (item_number <= 990)`),
    check('nfe_items_ncm_check', sql`ncm ~ '^[0-9]{2}([0-9]{6})?$'::text`),
    check('nfe_items_quantity_check', sql`quantity > (0)::numeric`),
  ],
);

export const cardInvoices = pgTable(
  'card_invoices',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    cardCaixaId: uuid('card_caixa_id').notNull(),
    referenceMonth: date('reference_month').notNull(),
    closingDate: date('closing_date').notNull(),
    dueDate: date('due_date').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('card_invoices_due_date_idx').using('btree', table.dueDate.asc().nullsLast().op('date_ops')),
    foreignKey({
      columns: [table.cardCaixaId],
      foreignColumns: [caixas.id],
      name: 'card_invoices_card_caixa_id_fkey',
    }),
    unique('card_invoices_card_month_key').on(table.cardCaixaId, table.referenceMonth),
    check('card_invoices_dates_check', sql`due_date >= closing_date`),
    check(
      'card_invoices_reference_month_check',
      sql`reference_month = (date_trunc('month'::text, (reference_month)::timestamp with time zone))::date`,
    ),
  ],
);

export const cardPurchases = pgTable(
  'card_purchases',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    cardCaixaId: uuid('card_caixa_id').notNull(),
    kind: text().default('purchase').notNull(),
    chargeKind: text('charge_kind'),
    payerCaixaId: uuid('payer_caixa_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    purchasedOn: date('purchased_on').notNull(),
    description: text().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    installmentsTotal: smallint('installments_total').default(1).notNull(),
    firstInstallment: smallint('first_installment').default(1).notNull(),
    refundedPurchaseId: uuid('refunded_purchase_id'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('card_purchases_card_caixa_id_purchased_on_idx').using(
      'btree',
      table.cardCaixaId.asc().nullsLast().op('uuid_ops'),
      table.purchasedOn.asc().nullsLast().op('date_ops'),
    ),
    index('card_purchases_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    index('card_purchases_description_trgm_idx').using('gin', table.description.asc().nullsLast().op('gin_trgm_ops')),
    index('card_purchases_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    index('card_purchases_payer_caixa_id_idx').using('btree', table.payerCaixaId.asc().nullsLast().op('uuid_ops')),
    index('card_purchases_refunded_purchase_id_idx').using('btree', table.refundedPurchaseId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.cardCaixaId],
      foreignColumns: [caixas.id],
      name: 'card_purchases_card_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: 'card_purchases_category_id_fkey',
    }),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'card_purchases_entity_id_fkey',
    }),
    foreignKey({
      columns: [table.payerCaixaId],
      foreignColumns: [caixas.id],
      name: 'card_purchases_payer_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.refundedPurchaseId],
      foreignColumns: [table.id],
      name: 'card_purchases_refunded_purchase_id_fkey',
    }),
    check('card_purchases_amount_cents_check', sql`amount_cents > 0`),
    check(
      'card_purchases_charge_kind_check',
      sql`charge_kind = ANY (ARRAY['interest'::text, 'iof'::text, 'fine'::text, 'fee'::text, 'other'::text])`,
    ),
    check('card_purchases_description_check', sql`btrim(description) <> ''::text`),
    check(
      'card_purchases_installments_check',
      sql`((installments_total >= 1) AND (installments_total <= 99)) AND ((first_installment >= 1) AND (first_installment <= installments_total))`,
    ),
    check('card_purchases_kind_check', sql`kind = ANY (ARRAY['purchase'::text, 'refund'::text, 'charge'::text])`),
    check(
      'card_purchases_kind_links_check',
      sql`((kind = 'refund'::text) = (refunded_purchase_id IS NOT NULL)) AND ((kind = 'charge'::text) = (charge_kind IS NOT NULL))`,
    ),
    check('card_purchases_refund_self_check', sql`refunded_purchase_id <> id`),
  ],
);

export const cardInvoiceItems = pgTable(
  'card_invoice_items',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    cardInvoiceId: uuid('card_invoice_id').notNull(),
    kind: text().default('installment').notNull(),
    cardPurchaseId: uuid('card_purchase_id'),
    installmentNumber: smallint('installment_number'),
    carriedFromInvoiceId: uuid('carried_from_invoice_id'),
    payerCaixaId: uuid('payer_caixa_id').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('card_invoice_items_card_invoice_id_payer_idx').using(
      'btree',
      table.cardInvoiceId.asc().nullsLast().op('uuid_ops'),
      table.payerCaixaId.asc().nullsLast().op('uuid_ops'),
    ),
    index('card_invoice_items_payer_caixa_id_idx').using('btree', table.payerCaixaId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.cardInvoiceId],
      foreignColumns: [cardInvoices.id],
      name: 'card_invoice_items_card_invoice_id_fkey',
    }),
    foreignKey({
      columns: [table.cardPurchaseId],
      foreignColumns: [cardPurchases.id],
      name: 'card_invoice_items_card_purchase_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.carriedFromInvoiceId],
      foreignColumns: [cardInvoices.id],
      name: 'card_invoice_items_carried_from_invoice_id_fkey',
    }),
    foreignKey({
      columns: [table.payerCaixaId],
      foreignColumns: [caixas.id],
      name: 'card_invoice_items_payer_caixa_id_fkey',
    }),
    unique('card_invoice_items_carryover_key').on(table.carriedFromInvoiceId, table.payerCaixaId),
    unique('card_invoice_items_purchase_installment_key').on(table.cardPurchaseId, table.installmentNumber),
    check('card_invoice_items_amount_cents_check', sql`amount_cents <> 0`),
    check('card_invoice_items_carried_self_check', sql`carried_from_invoice_id <> card_invoice_id`),
    check('card_invoice_items_installment_number_check', sql`(installment_number >= 1) AND (installment_number <= 99)`),
    check('card_invoice_items_kind_check', sql`kind = ANY (ARRAY['installment'::text, 'carryover'::text])`),
    check(
      'card_invoice_items_kind_links_check',
      sql`CHECK (
CASE kind
    WHEN 'installment'::text THEN ((card_purchase_id IS NOT NULL) AND (installment_number IS NOT NULL) AND (carried_from_invoice_id IS NULL))
    WHEN 'carryover'::text THEN ((carried_from_invoice_id IS NOT NULL) AND (card_purchase_id IS NULL) AND (installment_number IS NULL))
    ELSE NULL::boolean
END)`,
    ),
  ],
);

export const titles = pgTable(
  'titles',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    caixaId: uuid('caixa_id').notNull(),
    direction: text().notNull(),
    entityId: uuid('entity_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    description: text().notNull(),
    competenceDate: date('competence_date').notNull(),
    dueDate: date('due_date').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    status: text().default('open').notNull(),
    origin: text().default('manual').notNull(),
    recurrenceRuleId: uuid('recurrence_rule_id'),
    occurrence: smallint(),
    counterpartyCaixaId: uuid('counterparty_caixa_id'),
    mirrorTitleId: uuid('mirror_title_id'),
    mirrorStatus: text('mirror_status'),
    notes: text(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    boletoBarcode: text('boleto_barcode'),
    pixPayload: text('pix_payload'),
    nfeDocumentId: uuid('nfe_document_id'),
    cardInvoiceId: uuid('card_invoice_id'),
  },
  (table) => [
    uniqueIndex('titles_caixa_boleto_barcode_key')
      .using('btree', table.caixaId.asc().nullsLast().op('text_ops'), table.boletoBarcode.asc().nullsLast().op('text_ops'))
      .where(sql`((boleto_barcode IS NOT NULL) AND (status <> 'canceled'::text))`),
    index('titles_caixa_id_competence_date_idx').using(
      'btree',
      table.caixaId.asc().nullsLast().op('date_ops'),
      table.competenceDate.asc().nullsLast().op('uuid_ops'),
    ),
    index('titles_caixa_id_due_date_idx').using(
      'btree',
      table.caixaId.asc().nullsLast().op('uuid_ops'),
      table.dueDate.asc().nullsLast().op('uuid_ops'),
    ),
    index('titles_caixa_id_status_due_date_idx').using(
      'btree',
      table.caixaId.asc().nullsLast().op('uuid_ops'),
      table.status.asc().nullsLast().op('text_ops'),
      table.dueDate.asc().nullsLast().op('text_ops'),
    ),
    index('titles_card_invoice_id_idx').using('btree', table.cardInvoiceId.asc().nullsLast().op('uuid_ops')),
    index('titles_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    index('titles_counterparty_caixa_id_idx').using('btree', table.counterpartyCaixaId.asc().nullsLast().op('uuid_ops')),
    index('titles_due_date_idx')
      .using('btree', table.dueDate.asc().nullsLast().op('date_ops'))
      .where(sql`(status = ANY (ARRAY['open'::text, 'partial'::text]))`),
    index('titles_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('titles_mirror_title_id_key').using('btree', table.mirrorTitleId.asc().nullsLast().op('uuid_ops')),
    index('titles_nfe_document_id_idx').using('btree', table.nfeDocumentId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('titles_recurrence_occurrence_key').using(
      'btree',
      table.recurrenceRuleId.asc().nullsLast().op('uuid_ops'),
      table.caixaId.asc().nullsLast().op('uuid_ops'),
      table.occurrence.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'titles_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.cardInvoiceId],
      foreignColumns: [cardInvoices.id],
      name: 'titles_card_invoice_id_fkey',
    }),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: 'titles_category_id_fkey',
    }),
    foreignKey({
      columns: [table.counterpartyCaixaId],
      foreignColumns: [caixas.id],
      name: 'titles_counterparty_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'titles_entity_id_fkey',
    }),
    foreignKey({
      columns: [table.mirrorTitleId],
      foreignColumns: [table.id],
      name: 'titles_mirror_title_id_fkey',
    }),
    foreignKey({
      columns: [table.nfeDocumentId],
      foreignColumns: [nfeDocuments.id],
      name: 'titles_nfe_document_id_fkey',
    }),
    foreignKey({
      columns: [table.recurrenceRuleId],
      foreignColumns: [recurrenceRules.id],
      name: 'titles_recurrence_rule_id_fkey',
    }),
    check('titles_amount_cents_check', sql`amount_cents > 0`),
    check('titles_boleto_barcode_check', sql`CHECK (is_valid_boleto_barcode(boleto_barcode`),
    check(
      'titles_card_invoice_check',
      sql`((origin = 'card_invoice'::text) = (card_invoice_id IS NOT NULL)) AND ((card_invoice_id IS NULL) OR (counterparty_caixa_id IS NOT NULL))`,
    ),
    check('titles_counterparty_caixa_check', sql`counterparty_caixa_id <> caixa_id`),
    check('titles_description_check', sql`btrim(description) <> ''::text`),
    check('titles_direction_check', sql`direction = ANY (ARRAY['payable'::text, 'receivable'::text])`),
    check(
      'titles_mirror_fields_check',
      sql`((counterparty_caixa_id IS NULL) = (mirror_title_id IS NULL)) AND ((mirror_status IS NULL) OR (mirror_title_id IS NOT NULL))`,
    ),
    check('titles_mirror_self_check', sql`mirror_title_id <> id`),
    check('titles_mirror_status_check', sql`mirror_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'disputed'::text])`),
    check('titles_occurrence_check', sql`occurrence >= 1`),
    check('titles_origin_check', sql`origin = ANY (ARRAY['manual'::text, 'recurrence'::text, 'card_invoice'::text])`),
    check('titles_pix_payload_check', sql`CHECK (is_valid_brcode(pix_payload`),
    check(
      'titles_recurrence_check',
      sql`((recurrence_rule_id IS NULL) = (occurrence IS NULL)) AND ((origin = 'recurrence'::text) = (recurrence_rule_id IS NOT NULL))`,
    ),
    check('titles_status_check', sql`status = ANY (ARRAY['open'::text, 'partial'::text, 'paid'::text, 'canceled'::text])`),
  ],
);

export const cardPurchaseAttachments = pgTable(
  'card_purchase_attachments',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    cardPurchaseId: uuid('card_purchase_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('card_purchase_attachments_attachment_id_idx').using('btree', table.attachmentId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
      name: 'card_purchase_attachments_attachment_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.cardPurchaseId],
      foreignColumns: [cardPurchases.id],
      name: 'card_purchase_attachments_card_purchase_id_fkey',
    }).onDelete('cascade'),
    unique('card_purchase_attachments_key').on(table.attachmentId, table.cardPurchaseId),
  ],
);

export const statementCsvMappings = pgTable(
  'statement_csv_mappings',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    financialAccountId: uuid('financial_account_id'),
    cardCaixaId: uuid('card_caixa_id'),
    name: text().notNull(),
    delimiter: text().default(';').notNull(),
    encoding: text().default('utf-8').notNull(),
    hasHeader: boolean('has_header').default(true).notNull(),
    skipRows: smallint('skip_rows').default(0).notNull(),
    dateFormat: text('date_format').default('dd/MM/yyyy').notNull(),
    decimalSeparator: text('decimal_separator').default(',').notNull(),
    columns: jsonb().notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('statement_csv_mappings_card_caixa_id_idx').using('btree', table.cardCaixaId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('statement_csv_mappings_default_key')
      .using('btree', table.financialAccountId.asc().nullsLast().op('uuid_ops'), table.cardCaixaId.asc().nullsLast().op('uuid_ops'))
      .where(sql`is_default`),
    uniqueIndex('statement_csv_mappings_name_key').using('btree', sql`financial_account_id`, sql`card_caixa_id`, sql`lower(name)`),
    foreignKey({
      columns: [table.cardCaixaId],
      foreignColumns: [caixas.id],
      name: 'statement_csv_mappings_card_caixa_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.financialAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'statement_csv_mappings_financial_account_id_fkey',
    }).onDelete('cascade'),
    check(
      'statement_csv_mappings_columns_check',
      sql`(jsonb_typeof(columns) = 'object'::text) AND (columns ? 'date'::text) AND (columns ? 'description'::text) AND ((columns ? 'amount'::text) OR ((columns ? 'debit'::text) AND (columns ? 'credit'::text)))`,
    ),
    check('statement_csv_mappings_date_format_check', sql`btrim(date_format) <> ''::text`),
    check('statement_csv_mappings_decimal_separator_check', sql`decimal_separator = ANY (ARRAY[','::text, '.'::text])`),
    check('statement_csv_mappings_delimiter_check', sql`delimiter = ANY (ARRAY[','::text, ';'::text, '	'::text, '|'::text])`),
    check('statement_csv_mappings_encoding_check', sql`encoding = ANY (ARRAY['utf-8'::text, 'latin1'::text, 'windows-1252'::text])`),
    check('statement_csv_mappings_name_check', sql`btrim(name) <> ''::text`),
    check('statement_csv_mappings_skip_rows_check', sql`(skip_rows >= 0) AND (skip_rows <= 100)`),
    check('statement_csv_mappings_target_check', sql`num_nonnulls(financial_account_id, card_caixa_id) = 1`),
  ],
);

export const statementImports = pgTable(
  'statement_imports',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    financialAccountId: uuid('financial_account_id'),
    cardCaixaId: uuid('card_caixa_id'),
    cardInvoiceId: uuid('card_invoice_id'),
    format: text().notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    csvMappingId: uuid('csv_mapping_id'),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    bankBalanceCents: bigint('bank_balance_cents', { mode: 'number' }),
    bankBalanceOn: date('bank_balance_on'),
    importedByUserId: uuid('imported_by_user_id'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('statement_imports_attachment_id_idx').using('btree', table.attachmentId.asc().nullsLast().op('uuid_ops')),
    index('statement_imports_card_caixa_id_idx').using(
      'btree',
      table.cardCaixaId.asc().nullsLast().op('date_ops'),
      table.periodStart.asc().nullsLast().op('date_ops'),
    ),
    index('statement_imports_card_invoice_id_idx').using('btree', table.cardInvoiceId.asc().nullsLast().op('uuid_ops')),
    index('statement_imports_csv_mapping_id_idx').using('btree', table.csvMappingId.asc().nullsLast().op('uuid_ops')),
    index('statement_imports_financial_account_id_idx').using(
      'btree',
      table.financialAccountId.asc().nullsLast().op('uuid_ops'),
      table.periodStart.asc().nullsLast().op('uuid_ops'),
    ),
    index('statement_imports_imported_by_user_id_idx').using('btree', table.importedByUserId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachments.id],
      name: 'statement_imports_attachment_id_fkey',
    }),
    foreignKey({
      columns: [table.cardCaixaId],
      foreignColumns: [caixas.id],
      name: 'statement_imports_card_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.cardInvoiceId],
      foreignColumns: [cardInvoices.id],
      name: 'statement_imports_card_invoice_id_fkey',
    }),
    foreignKey({
      columns: [table.csvMappingId],
      foreignColumns: [statementCsvMappings.id],
      name: 'statement_imports_csv_mapping_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.financialAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'statement_imports_financial_account_id_fkey',
    }),
    foreignKey({
      columns: [table.importedByUserId],
      foreignColumns: [users.id],
      name: 'statement_imports_imported_by_user_id_fkey',
    }).onDelete('set null'),
    check('statement_imports_bank_balance_check', sql`(bank_balance_cents IS NULL) = (bank_balance_on IS NULL)`),
    check('statement_imports_csv_mapping_check', sql`(format = 'csv'::text) OR (csv_mapping_id IS NULL)`),
    check('statement_imports_format_check', sql`format = ANY (ARRAY['ofx'::text, 'csv'::text])`),
    check('statement_imports_period_check', sql`period_end >= period_start`),
    check(
      'statement_imports_target_check',
      sql`(num_nonnulls(financial_account_id, card_caixa_id) = 1) AND ((card_invoice_id IS NULL) OR (card_caixa_id IS NOT NULL))`,
    ),
  ],
);

export const classificationRules = pgTable(
  'classification_rules',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    caixaId: uuid('caixa_id'),
    matchKind: text('match_kind').default('contains').notNull(),
    pattern: text().notNull(),
    direction: text(),
    entityId: uuid('entity_id'),
    categoryId: uuid('category_id'),
    priority: smallint().default(100).notNull(),
    origin: text().default('manual').notNull(),
    createdFromLineId: uuid('created_from_line_id'),
    createdByUserId: uuid('created_by_user_id'),
    usageCount: integer('usage_count').default(0).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('classification_rules_caixa_id_idx').using('btree', table.caixaId.asc().nullsLast().op('uuid_ops')),
    index('classification_rules_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    index('classification_rules_created_by_user_id_idx').using('btree', table.createdByUserId.asc().nullsLast().op('uuid_ops')),
    index('classification_rules_created_from_line_id_idx').using('btree', table.createdFromLineId.asc().nullsLast().op('uuid_ops')),
    index('classification_rules_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('classification_rules_pattern_key')
      .using('btree', sql`caixa_id`, sql`match_kind`, sql`lower(pattern)`, sql`direction`)
      .where(sql`(archived_at IS NULL)`),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'classification_rules_caixa_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: 'classification_rules_category_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: 'classification_rules_created_by_user_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'classification_rules_entity_id_fkey',
    }).onDelete('cascade'),
    check('classification_rules_direction_check', sql`direction = ANY (ARRAY['in'::text, 'out'::text])`),
    check(
      'classification_rules_match_kind_check',
      sql`match_kind = ANY (ARRAY['contains'::text, 'starts_with'::text, 'exact'::text, 'regex'::text])`,
    ),
    check('classification_rules_origin_check', sql`origin = ANY (ARRAY['manual'::text, 'correction'::text, 'agent'::text])`),
    check('classification_rules_pattern_check', sql`(btrim(pattern) <> ''::text) AND (length(pattern) <= 200)`),
    check('classification_rules_priority_check', sql`(priority >= 0) AND (priority <= 1000)`),
    check(
      'classification_rules_target_check',
      sql`(num_nonnulls(entity_id, category_id) >= 1) AND ((category_id IS NULL) OR (direction IS NOT NULL))`,
    ),
    check('classification_rules_usage_count_check', sql`usage_count >= 0`),
  ],
);

export const statementLines = pgTable(
  'statement_lines',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    statementImportId: uuid('statement_import_id').notNull(),
    financialAccountId: uuid('financial_account_id'),
    cardCaixaId: uuid('card_caixa_id'),
    lineNumber: integer('line_number').notNull(),
    postedOn: date('posted_on').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text().notNull(),
    fitid: text(),
    dedupHash: text('dedup_hash').notNull(),
    status: text().default('new').notNull(),
    movementId: uuid('movement_id'),
    titleId: uuid('title_id'),
    cardInvoiceItemId: uuid('card_invoice_item_id'),
    entityId: uuid('entity_id'),
    categoryId: uuid('category_id'),
    classificationRuleId: uuid('classification_rule_id'),
    classificationSource: text('classification_source'),
    raw: jsonb(),
    matchedAt: timestamp('matched_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('statement_lines_account_dedup_key')
      .using('btree', table.financialAccountId.asc().nullsLast().op('text_ops'), table.dedupHash.asc().nullsLast().op('uuid_ops'))
      .where(sql`(financial_account_id IS NOT NULL)`),
    index('statement_lines_card_caixa_id_posted_on_idx').using(
      'btree',
      table.cardCaixaId.asc().nullsLast().op('uuid_ops'),
      table.postedOn.asc().nullsLast().op('uuid_ops'),
    ),
    uniqueIndex('statement_lines_card_dedup_key')
      .using('btree', table.cardCaixaId.asc().nullsLast().op('text_ops'), table.dedupHash.asc().nullsLast().op('uuid_ops'))
      .where(sql`(card_caixa_id IS NOT NULL)`),
    index('statement_lines_card_invoice_item_id_idx').using('btree', table.cardInvoiceItemId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('statement_lines_card_item_matched_key')
      .using('btree', table.cardInvoiceItemId.asc().nullsLast().op('uuid_ops'))
      .where(sql`(status = 'matched'::text)`),
    index('statement_lines_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    index('statement_lines_classification_rule_id_idx').using('btree', table.classificationRuleId.asc().nullsLast().op('uuid_ops')),
    index('statement_lines_description_trgm_idx').using('gin', table.description.asc().nullsLast().op('gin_trgm_ops')),
    index('statement_lines_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    index('statement_lines_financial_account_id_posted_on_idx').using(
      'btree',
      table.financialAccountId.asc().nullsLast().op('date_ops'),
      table.postedOn.asc().nullsLast().op('date_ops'),
    ),
    index('statement_lines_movement_id_idx').using('btree', table.movementId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('statement_lines_movement_matched_key')
      .using('btree', table.movementId.asc().nullsLast().op('uuid_ops'))
      .where(sql`(status = 'matched'::text)`),
    index('statement_lines_status_idx').using(
      'btree',
      table.statementImportId.asc().nullsLast().op('uuid_ops'),
      table.status.asc().nullsLast().op('uuid_ops'),
    ),
    index('statement_lines_title_id_idx').using('btree', table.titleId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.cardCaixaId],
      foreignColumns: [caixas.id],
      name: 'statement_lines_card_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.cardInvoiceItemId],
      foreignColumns: [cardInvoiceItems.id],
      name: 'statement_lines_card_invoice_item_id_fkey',
    }),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: 'statement_lines_category_id_fkey',
    }),
    foreignKey({
      columns: [table.classificationRuleId],
      foreignColumns: [classificationRules.id],
      name: 'statement_lines_classification_rule_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.entityId],
      foreignColumns: [entities.id],
      name: 'statement_lines_entity_id_fkey',
    }),
    foreignKey({
      columns: [table.financialAccountId],
      foreignColumns: [financialAccounts.id],
      name: 'statement_lines_financial_account_id_fkey',
    }),
    foreignKey({
      columns: [table.movementId],
      foreignColumns: [movements.id],
      name: 'statement_lines_movement_id_fkey',
    }),
    foreignKey({
      columns: [table.statementImportId],
      foreignColumns: [statementImports.id],
      name: 'statement_lines_statement_import_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.titleId],
      foreignColumns: [titles.id],
      name: 'statement_lines_title_id_fkey',
    }),
    unique('statement_lines_line_number_key').on(table.lineNumber, table.statementImportId),
    check('statement_lines_amount_cents_check', sql`amount_cents <> 0`),
    check(
      'statement_lines_classification_source_check',
      sql`(classification_source = ANY (ARRAY['rule'::text, 'agent'::text, 'user'::text])) AND ((classification_rule_id IS NULL) OR (NOT (classification_source IS DISTINCT FROM 'rule'::text)))`,
    ),
    check('statement_lines_dedup_hash_check', sql`(btrim(dedup_hash) <> ''::text) AND (length(dedup_hash) <= 200)`),
    check('statement_lines_line_number_check', sql`line_number >= 1`),
    check(
      'statement_lines_links_check',
      sql`((movement_id IS NULL) OR (financial_account_id IS NOT NULL)) AND ((title_id IS NULL) OR (financial_account_id IS NOT NULL)) AND ((card_invoice_item_id IS NULL) OR (card_caixa_id IS NOT NULL)) AND
CASE status
    WHEN 'matched'::text THEN ((num_nonnulls(movement_id, card_invoice_item_id) = 1) AND (title_id IS NULL))
    WHEN 'suggested'::text THEN (num_nonnulls(movement_id, title_id, card_invoice_item_id) = 1)
    ELSE (num_nonnulls(movement_id, title_id, card_invoice_item_id) = 0)
END AND ((status = 'matched'::text) = (matched_at IS NOT NULL))`,
    ),
    check('statement_lines_raw_check', sql`jsonb_typeof(raw) = 'object'::text`),
    check('statement_lines_status_check', sql`status = ANY (ARRAY['matched'::text, 'suggested'::text, 'new'::text, 'ignored'::text])`),
    check('statement_lines_target_check', sql`num_nonnulls(financial_account_id, card_caixa_id) = 1`),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    tableName: text('table_name').notNull(),
    recordId: uuid('record_id').notNull(),
    action: text().notNull(),
    oldData: jsonb('old_data'),
    newData: jsonb('new_data'),
    changedColumns: text('changed_columns').array(),
    userId: uuid('user_id'),
    actorKind: text('actor_kind').notNull(),
    agentRunId: text('agent_run_id'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    transactionId: bigint('transaction_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('audit_log_created_at_idx').using('btree', table.createdAt.asc().nullsLast().op('timestamptz_ops')),
    index('audit_log_record_idx').using(
      'btree',
      table.tableName.asc().nullsLast().op('uuid_ops'),
      table.recordId.asc().nullsLast().op('timestamptz_ops'),
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('audit_log_transaction_id_idx').using('btree', table.transactionId.asc().nullsLast().op('int8_ops')),
    index('audit_log_user_id_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    check('audit_log_action_check', sql`action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])`),
    check('audit_log_actor_kind_check', sql`actor_kind = ANY (ARRAY['human'::text, 'agent'::text, 'system'::text])`),
    check(
      'audit_log_data_check',
      sql`CHECK (
CASE action
    WHEN 'insert'::text THEN ((old_data IS NULL) AND (new_data IS NOT NULL))
    WHEN 'update'::text THEN ((old_data IS NOT NULL) AND (new_data IS NOT NULL))
    WHEN 'delete'::text THEN ((old_data IS NOT NULL) AND (new_data IS NULL))
    ELSE NULL::boolean
END)`,
    ),
  ],
);

export const periodClosings = pgTable(
  'period_closings',
  {
    id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
    caixaId: uuid('caixa_id').notNull(),
    month: date().notNull(),
    closedByUserId: uuid('closed_by_user_id'),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('period_closings_closed_by_user_id_idx').using('btree', table.closedByUserId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'period_closings_caixa_id_fkey',
    }),
    foreignKey({
      columns: [table.closedByUserId],
      foreignColumns: [users.id],
      name: 'period_closings_closed_by_user_id_fkey',
    }).onDelete('set null'),
    unique('period_closings_caixa_month_key').on(table.caixaId, table.month),
    check('period_closings_month_check', sql`month = (date_trunc('month'::text, (month)::timestamp with time zone))::date`),
  ],
);
export const titleBalances = pgView('title_balances', {
  titleId: uuid('title_id'),
  caixaId: uuid('caixa_id'),
  direction: text(),
  status: text(),
  entityId: uuid('entity_id'),
  categoryId: uuid('category_id'),
  description: text(),
  competenceDate: date('competence_date'),
  dueDate: date('due_date'),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  amountCents: bigint('amount_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  settledCents: bigint('settled_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  openCents: bigint('open_cents', { mode: 'number' }),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT t.id AS title_id, t.caixa_id, t.direction, t.status, t.entity_id, t.category_id, t.description, t.competence_date, t.due_date, t.amount_cents, COALESCE(s.settled_cents, 0::numeric)::bigint AS settled_cents, CASE WHEN t.status = 'canceled'::text THEN 0::numeric ELSE t.amount_cents::numeric - COALESCE(s.settled_cents, 0::numeric) END::bigint AS open_cents, t.archived_at FROM titles t LEFT JOIN LATERAL ( SELECT sum(x.amount_cents) AS settled_cents FROM settlements x WHERE x.title_id = t.id AND x.reversed_at IS NULL) s ON true`,
  );

export const financialAccountBalances = pgView('financial_account_balances', {
  financialAccountId: uuid('financial_account_id'),
  caixaId: uuid('caixa_id'),
  openingDate: date('opening_date'),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  movementsCents: bigint('movements_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  balanceCents: bigint('balance_cents', { mode: 'number' }),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT a.id AS financial_account_id, a.caixa_id, a.opening_date, a.opening_balance_cents, COALESCE(m.movements_cents, 0::numeric)::bigint AS movements_cents, (a.opening_balance_cents::numeric + COALESCE(m.movements_cents, 0::numeric))::bigint AS balance_cents, a.archived_at FROM financial_accounts a LEFT JOIN LATERAL ( SELECT sum(x.amount_cents) AS movements_cents FROM movements x WHERE x.financial_account_id = a.id) m ON true`,
  );

export const cardInvoicePayerTotals = pgView('card_invoice_payer_totals', {
  cardInvoiceId: uuid('card_invoice_id'),
  cardCaixaId: uuid('card_caixa_id'),
  referenceMonth: date('reference_month'),
  dueDate: date('due_date'),
  payerCaixaId: uuid('payer_caixa_id'),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  itemsCents: bigint('items_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  billedCents: bigint('billed_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  settledCents: bigint('settled_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  openCents: bigint('open_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  carriedOutCents: bigint('carried_out_cents', { mode: 'number' }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT v.id AS card_invoice_id, v.card_caixa_id, v.reference_month, v.due_date, p.payer_caixa_id, COALESCE(it.items_cents, 0::numeric)::bigint AS items_cents, COALESCE(tt.billed_cents, 0::numeric)::bigint AS billed_cents, COALESCE(tt.settled_cents, 0::numeric)::bigint AS settled_cents, COALESCE(tt.open_cents, 0::numeric)::bigint AS open_cents, COALESCE(co.carried_out_cents, 0::numeric)::bigint AS carried_out_cents FROM card_invoices v JOIN LATERAL ( SELECT i.payer_caixa_id FROM card_invoice_items i WHERE i.card_invoice_id = v.id UNION SELECT t.counterparty_caixa_id FROM titles t WHERE t.card_invoice_id = v.id AND t.caixa_id = v.card_caixa_id) p ON true LEFT JOIN LATERAL ( SELECT sum(i.amount_cents) AS items_cents FROM card_invoice_items i WHERE i.card_invoice_id = v.id AND i.payer_caixa_id = p.payer_caixa_id) it ON true LEFT JOIN LATERAL ( SELECT sum(b.amount_cents) FILTER (WHERE b.status <> 'canceled'::text) AS billed_cents, sum(b.settled_cents) AS settled_cents, sum(b.open_cents) AS open_cents FROM title_balances b JOIN titles t ON t.id = b.title_id WHERE t.card_invoice_id = v.id AND t.caixa_id = v.card_caixa_id AND t.counterparty_caixa_id = p.payer_caixa_id) tt ON true LEFT JOIN LATERAL ( SELECT sum(i.amount_cents) AS carried_out_cents FROM card_invoice_items i WHERE i.carried_from_invoice_id = v.id AND i.payer_caixa_id = p.payer_caixa_id) co ON true`,
  );

export const cardInvoiceSummaries = pgView('card_invoice_summaries', {
  cardInvoiceId: uuid('card_invoice_id'),
  cardCaixaId: uuid('card_caixa_id'),
  referenceMonth: date('reference_month'),
  closingDate: date('closing_date'),
  dueDate: date('due_date'),
  closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  totalCents: bigint('total_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  billedCents: bigint('billed_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  settledCents: bigint('settled_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  openCents: bigint('open_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  carriedOutCents: bigint('carried_out_cents', { mode: 'number' }),
  status: text(),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT v.id AS card_invoice_id, v.card_caixa_id, v.reference_month, v.closing_date, v.due_date, v.closed_at, COALESCE(s.items_cents, 0::numeric)::bigint AS total_cents, COALESCE(s.billed_cents, 0::numeric)::bigint AS billed_cents, COALESCE(s.settled_cents, 0::numeric)::bigint AS settled_cents, COALESCE(s.open_cents, 0::numeric)::bigint AS open_cents, COALESCE(s.carried_out_cents, 0::numeric)::bigint AS carried_out_cents, CASE WHEN v.closed_at IS NULL THEN 'open'::text WHEN COALESCE(s.open_cents, 0::numeric) = 0::numeric AND COALESCE(s.carried_out_cents, 0::numeric) <= 0::numeric THEN 'paid'::text ELSE 'closed'::text END AS status FROM card_invoices v LEFT JOIN LATERAL ( SELECT sum(x.items_cents) AS items_cents, sum(x.billed_cents) AS billed_cents, sum(x.settled_cents) AS settled_cents, sum(x.open_cents) AS open_cents, sum(x.carried_out_cents) AS carried_out_cents FROM card_invoice_payer_totals x WHERE x.card_invoice_id = v.id) s ON true`,
  );

export const cardInvoiceLines = pgView('card_invoice_lines', {
  cardInvoiceItemId: uuid('card_invoice_item_id'),
  cardInvoiceId: uuid('card_invoice_id'),
  cardCaixaId: uuid('card_caixa_id'),
  referenceMonth: date('reference_month'),
  payerCaixaId: uuid('payer_caixa_id'),
  itemKind: text('item_kind'),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  amountCents: bigint('amount_cents', { mode: 'number' }),
  installmentNumber: smallint('installment_number'),
  installmentsTotal: smallint('installments_total'),
  cardPurchaseId: uuid('card_purchase_id'),
  purchaseKind: text('purchase_kind'),
  chargeKind: text('charge_kind'),
  refundedPurchaseId: uuid('refunded_purchase_id'),
  entityId: uuid('entity_id'),
  categoryId: uuid('category_id'),
  purchasedOn: date('purchased_on'),
  description: text(),
  carriedFromInvoiceId: uuid('carried_from_invoice_id'),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT i.id AS card_invoice_item_id, i.card_invoice_id, v.card_caixa_id, v.reference_month, i.payer_caixa_id, i.kind AS item_kind, i.amount_cents, i.installment_number, p.installments_total, i.card_purchase_id, p.kind AS purchase_kind, p.charge_kind, p.refunded_purchase_id, p.entity_id, p.category_id, p.purchased_on, COALESCE(p.description, i.description) AS description, i.carried_from_invoice_id FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id LEFT JOIN card_purchases p ON p.id = i.card_purchase_id`,
  );

export const cardLimits = pgView('card_limits', {
  cardCaixaId: uuid('card_caixa_id'),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  creditLimitCents: bigint('credit_limit_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  usedCents: bigint('used_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  availableCents: bigint('available_cents', { mode: 'number' }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT c.id AS card_caixa_id, c.credit_limit_cents, (COALESCE(it.items_cents, 0::numeric) - COALESCE(st.paid_cents, 0::numeric))::bigint AS used_cents, (c.credit_limit_cents::numeric - COALESCE(it.items_cents, 0::numeric) + COALESCE(st.paid_cents, 0::numeric))::bigint AS available_cents FROM caixas c LEFT JOIN LATERAL ( SELECT sum(i.amount_cents) AS items_cents FROM card_invoice_items i JOIN card_invoices v ON v.id = i.card_invoice_id WHERE v.card_caixa_id = c.id AND i.kind = 'installment'::text) it ON true LEFT JOIN LATERAL ( SELECT sum(s.amount_cents) AS paid_cents FROM settlements s JOIN titles t ON t.id = s.title_id WHERE t.caixa_id = c.id AND t.card_invoice_id IS NOT NULL AND s.reversed_at IS NULL) st ON true WHERE c.kind = 'credit_card'::text`,
  );

export const statementImportBalances = pgView('statement_import_balances', {
  statementImportId: uuid('statement_import_id'),
  financialAccountId: uuid('financial_account_id'),
  cardCaixaId: uuid('card_caixa_id'),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  bankBalanceOn: date('bank_balance_on'),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  bankBalanceCents: bigint('bank_balance_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  appBalanceCents: bigint('app_balance_cents', { mode: 'number' }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  differenceCents: bigint('difference_cents', { mode: 'number' }),
  lines: integer(),
  matchedLines: integer('matched_lines'),
  suggestedLines: integer('suggested_lines'),
  newLines: integer('new_lines'),
  ignoredLines: integer('ignored_lines'),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT i.id AS statement_import_id, i.financial_account_id, i.card_caixa_id, i.period_start, i.period_end, i.bank_balance_on, i.bank_balance_cents, CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL THEN financial_account_balance_at(i.financial_account_id, i.bank_balance_on) ELSE NULL::bigint END AS app_balance_cents, CASE WHEN i.financial_account_id IS NOT NULL AND i.bank_balance_on IS NOT NULL THEN i.bank_balance_cents - financial_account_balance_at(i.financial_account_id, i.bank_balance_on) ELSE NULL::bigint END AS difference_cents, COALESCE(c.lines, 0::bigint)::integer AS lines, COALESCE(c.matched, 0::bigint)::integer AS matched_lines, COALESCE(c.suggested, 0::bigint)::integer AS suggested_lines, COALESCE(c.new, 0::bigint)::integer AS new_lines, COALESCE(c.ignored, 0::bigint)::integer AS ignored_lines FROM statement_imports i LEFT JOIN LATERAL ( SELECT count(*) AS lines, count(*) FILTER (WHERE l.status = 'matched'::text) AS matched, count(*) FILTER (WHERE l.status = 'suggested'::text) AS suggested, count(*) FILTER (WHERE l.status = 'new'::text) AS new, count(*) FILTER (WHERE l.status = 'ignored'::text) AS ignored FROM statement_lines l WHERE l.statement_import_id = i.id) c ON true`,
  );

export const attachmentLinks = pgView('attachment_links', {
  attachmentId: uuid('attachment_id'),
  targetKind: text('target_kind'),
  targetId: uuid('target_id'),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT title_attachments.attachment_id, 'title'::text AS target_kind, title_attachments.title_id AS target_id FROM title_attachments UNION ALL SELECT settlement_attachments.attachment_id, 'settlement'::text AS target_kind, settlement_attachments.settlement_id AS target_id FROM settlement_attachments UNION ALL SELECT movement_attachments.attachment_id, 'movement'::text AS target_kind, movement_attachments.movement_id AS target_id FROM movement_attachments UNION ALL SELECT entity_attachments.attachment_id, 'entity'::text AS target_kind, entity_attachments.entity_id AS target_id FROM entity_attachments UNION ALL SELECT nfe_documents.xml_attachment_id AS attachment_id, 'nfe_document'::text AS target_kind, nfe_documents.id AS target_id FROM nfe_documents WHERE nfe_documents.xml_attachment_id IS NOT NULL UNION ALL SELECT card_purchase_attachments.attachment_id, 'card_purchase'::text AS target_kind, card_purchase_attachments.card_purchase_id AS target_id FROM card_purchase_attachments UNION ALL SELECT statement_imports.attachment_id, 'statement_import'::text AS target_kind, statement_imports.id AS target_id FROM statement_imports`,
  );
