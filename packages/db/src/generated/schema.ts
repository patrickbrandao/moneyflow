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
  },
  (table) => [
    index('titles_caixa_id_competence_date_idx').using(
      'btree',
      table.caixaId.asc().nullsLast().op('uuid_ops'),
      table.competenceDate.asc().nullsLast().op('uuid_ops'),
    ),
    index('titles_caixa_id_due_date_idx').using(
      'btree',
      table.caixaId.asc().nullsLast().op('uuid_ops'),
      table.dueDate.asc().nullsLast().op('date_ops'),
    ),
    index('titles_caixa_id_status_due_date_idx').using(
      'btree',
      table.caixaId.asc().nullsLast().op('text_ops'),
      table.status.asc().nullsLast().op('text_ops'),
      table.dueDate.asc().nullsLast().op('uuid_ops'),
    ),
    index('titles_category_id_idx').using('btree', table.categoryId.asc().nullsLast().op('uuid_ops')),
    index('titles_counterparty_caixa_id_idx').using('btree', table.counterpartyCaixaId.asc().nullsLast().op('uuid_ops')),
    index('titles_due_date_idx')
      .using('btree', table.dueDate.asc().nullsLast().op('date_ops'))
      .where(sql`(status = ANY (ARRAY['open'::text, 'partial'::text]))`),
    index('titles_entity_id_idx').using('btree', table.entityId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('titles_mirror_title_id_key').using('btree', table.mirrorTitleId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('titles_recurrence_occurrence_key').using(
      'btree',
      table.recurrenceRuleId.asc().nullsLast().op('int2_ops'),
      table.caixaId.asc().nullsLast().op('int2_ops'),
      table.occurrence.asc().nullsLast().op('int2_ops'),
    ),
    foreignKey({
      columns: [table.caixaId],
      foreignColumns: [caixas.id],
      name: 'titles_caixa_id_fkey',
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
      columns: [table.recurrenceRuleId],
      foreignColumns: [recurrenceRules.id],
      name: 'titles_recurrence_rule_id_fkey',
    }),
    check('titles_amount_cents_check', sql`amount_cents > 0`),
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
    check(
      'titles_recurrence_check',
      sql`((recurrence_rule_id IS NULL) = (occurrence IS NULL)) AND ((origin = 'recurrence'::text) = (recurrence_rule_id IS NOT NULL))`,
    ),
    check('titles_status_check', sql`status = ANY (ARRAY['open'::text, 'partial'::text, 'paid'::text, 'canceled'::text])`),
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
