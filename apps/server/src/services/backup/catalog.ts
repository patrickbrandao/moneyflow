import type { Executor } from '@moneyflow/db';
import { type BackupResource, t } from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';

/*
 * Catálogo do banco para o backup (spec 019): tabelas, colunas e FKs lidos do
 * pg_catalog, com os privilégios do papel da aplicação. Exportação e
 * importação são genéricas sobre esse catálogo; o que é específico do domínio
 * (recursos, chaves naturais, filhos "do dono", segredos) fica nas tabelas
 * de configuração abaixo.
 */

export type ColumnMeta = { name: string; generated: boolean; notNull: boolean; canSelect: boolean; canInsert: boolean };

export type ForeignKeyMeta = {
  table: string;
  parent: string;
  columns: string[];
  parentColumns: string[];
  deferrable: boolean;
  /** ON DELETE: a (no action), r (restrict), c (cascade), n (set null), d (set default). */
  onDelete: string;
  /** A coluna do filho que aponta para `parent.id`. */
  refColumn: string;
  /** Colunas do filho que podem ficar nulas (anuladas quando a referência "fraca" não se resolve). */
  nullableColumns: string[];
};

export type TableMeta = { name: string; columns: ColumnMeta[]; fks: ForeignKeyMeta[] };
export type Catalog = Map<string, TableMeta>;

/** Estado operacional, histórico interno ou recalculável: nunca exportado nem importado. */
export const EXCLUDED_TABLES = new Set([
  'schema_migrations',
  'sessions',
  'audit_log',
  'message_outbox',
  'notifications',
  'ai_runs',
  'ai_run_events',
  'ai_tool_confirmations',
  'ai_embeddings',
  // Requisições ao provedor (spec 023): operacionais, com conversas e dados financeiros.
  'ai_requests',
  'ai_request_attempts',
  // Cache dos anexos (descrição, texto do PDF, transcrição, áudio gerado) e os índices de embeddings (spec 024).
  'ai_attachment_derivatives',
  'ai_embedding_indexes',
  // Fluxos autônomos (spec 029): o histórico dos disparos é operacional (como ai_runs); os códigos de pareamento são
  // de uso único e curtos (só o hash, sem leitor); a dedup do webhook é estado (sem id, já fica fora do catálogo).
  'ai_scheduled_task_runs',
  'telegram_pairing_codes',
  'telegram_updates_seen',
]);

/**
 * Linhas que ficam fora do backup: o áudio gerado de uma mensagem (spec 024)
 * pertence ao derivado, que é cache e não vai; sem outro vínculo, não vai também.
 */
export const ROW_FILTERS: Record<string, SQL> = {
  attachments: sql`(NOT EXISTS (SELECT 1 FROM ai_attachment_derivatives d WHERE d.result_attachment_id = attachments.id)
                    OR EXISTS (SELECT 1 FROM attachment_links l
                                WHERE l.attachment_id = attachments.id AND l.target_kind <> 'ai_message_speech'))`,
};

/** Tabelas de cada recurso exportável (a primeira é a principal). */
export const RESOURCE_TABLES: Record<BackupResource, string[]> = {
  categories: ['categories'],
  entities: [
    'entities',
    'entity_contacts',
    'entity_addresses',
    'entity_bank_accounts',
    'entity_pix_keys',
    'entity_links',
    'entity_tags',
    'entity_tag_links',
  ],
  caixas: ['caixas', 'financial_accounts', 'caixa_members', 'caixa_hidden_categories'],
  'ai-providers': ['ai_providers', 'ai_model_prices'],
  users: ['users', 'caixa_members', 'user_api_tokens', 'user_ai_settings'],
};

/**
 * Segredos que o papel da aplicação não lê: cada um sai por uma função do
 * banco que exige um admin ativo como ator (docs/016).
 */
export const SECRET_READERS: Record<string, { column: string; fn: string }[]> = {
  users: [{ column: 'password', fn: 'admin_reveal_password' }],
  ai_providers: [{ column: 'api_key', fn: 'admin_ai_provider_api_key' }],
  mcp_servers: [{ column: 'secret_headers', fn: 'admin_mcp_server_headers' }],
  // O destino do Telegram tem dois: o token do bot e o hash do segredo do webhook (spec 029).
  message_destinations: [
    { column: 'bot_token', fn: 'admin_message_destination_token' },
    { column: 'webhook_secret_hash', fn: 'admin_message_destination_webhook_secret' },
  ],
  user_api_tokens: [{ column: 'token_hash', fn: 'admin_api_token_hash' }],
};

/**
 * Chaves naturais dos registros que outros referenciam: um registro do arquivo
 * que bate com um cadastrado (por uma dessas chaves) é "o mesmo" — fica o
 * cadastrado e as referências do arquivo passam a apontar para ele.
 * `lower:` compara sem maiúsculas; `?` pula a chave quando a coluna é nula.
 */
export const NATURAL_KEYS: Record<string, string[][]> = {
  users: [['username'], ['email']],
  categories: [['kind', 'parent_id', 'lower:name']],
  entities: [['?document']],
  entity_tags: [['lower:name']],
  ai_providers: [['lower:name']],
  ai_agents: [['lower:name']],
  // O agente aponta para o kit pelo nome (spec 021).
  ai_tool_kits: [['lower:name']],
  mcp_servers: [['lower:name']],
  message_destinations: [['owner_user_id', 'owner_caixa_id', 'lower:name']],
  ai_model_prices: [['provider_id', 'model', 'valid_from']],
  nfe_documents: [['access_key']],
  caixa_members: [['user_id', 'caixa_id']],
  caixa_hidden_categories: [['caixa_id', 'category_id']],
  // Criado pelo banco ao inserir a mensagem (blocos `attachment`): a linha do arquivo casa com ele.
  ai_message_attachments: [['message_id', 'attachment_id']],
};

/**
 * Filhos que pertencem a um dono: se todos os donos já estavam cadastrados, o
 * filho do arquivo não entra ("permanece o que já está cadastrado").
 */
export const OWNED_BY: Record<string, string[]> = {
  entity_contacts: ['entity_id'],
  entity_addresses: ['entity_id'],
  entity_bank_accounts: ['entity_id'],
  entity_pix_keys: ['entity_id'],
  entity_links: ['entity_id', 'related_entity_id'],
  entity_tag_links: ['entity_id'],
  ai_model_prices: ['provider_id'],
  ai_tool_kit_tools: ['kit_id'],
  // Agente já cadastrado fica com o histórico dele (spec 022) e com as inferências dele (spec 024).
  ai_agent_prompt_versions: ['agent_id'],
  ai_agent_inferences: ['agent_id'],
  agent_mcp_servers: ['agent_id', 'mcp_server_id'],
  message_subscriptions: ['destination_id'],
  message_subscription_caixas: ['subscription_id'],
  caixa_members: ['user_id', 'caixa_id'],
  caixa_hidden_categories: ['caixa_id'],
  user_api_tokens: ['user_id'],
  user_ai_settings: ['user_id'],
  canvas_node_positions: ['user_id'],
};

/**
 * Tabelas com checagens no COMMIT (espelho, pernas da baixa, movimentos,
 * transferências, faturas): registros ligados entre si entram juntos, num
 * savepoint, e as checagens rodam antes de liberá-lo.
 */
export const DEFERRED_CLUSTER = new Set([
  'titles',
  'settlements',
  'movements',
  'transfers',
  'card_invoices',
  'card_invoice_items',
  'card_purchases',
  // Contratos (spec 020): status ⇄ tarefa aberta, ciclos contíguos, documento ⇄ versão atual e parcelas.
  'contracts',
  'contract_cycles',
  'contract_renewal_tasks',
  'contract_documents',
  'contract_document_versions',
  // Prompt do agente (spec 022): a versão 1 sai no COMMIT se o agente não tem versão; o agente e as versões do arquivo
  // entram juntos, senão o SET CONSTRAINTS de outra unidade criaria a versão 1 antes e a do arquivo seria recusada.
  'ai_agents',
  'ai_agent_prompt_versions',
]);

/**
 * Tabelas sem coluna `id` (chave primária composta): a linha é identificada
 * pelas colunas da chave (no relatório, `a|b`), e "já cadastrado" = mesma chave
 * depois de traduzir as FKs. As colunas que são FK levam uuid; as demais, texto
 * (o nome da tool no kit).
 */
export const COMPOSITE_KEYS: Record<string, string[]> = {
  entity_tag_links: ['entity_id', 'tag_id'],
  ai_tool_kit_tools: ['kit_id', 'tool_name'],
  // Uma linha por usuário (spec 022): a chave é o próprio user_id.
  user_ai_settings: ['user_id'],
  // Configurações do sistema (spec 023): a chave é o texto `area.nome`.
  app_settings: ['key'],
  // Provedor por inferência do agente (spec 024): a capacidade é texto.
  ai_agent_inferences: ['agent_id', 'capability'],
};

/** Colunas que identificam a linha (id ou a chave composta). */
export const keyColumns = (table: string) => COMPOSITE_KEYS[table] ?? ['id'];

/** Tabelas importadas por último (o fechamento de mês bloquearia os lançamentos do próprio arquivo). */
export const LAST_TABLES = new Set(['period_closings']);

let cached: Catalog | null = null;

/** Esquece o catálogo (depois de uma restauração do dump). */
export function resetCatalog() {
  cached = null;
}

export async function loadCatalog(db: Executor): Promise<Catalog> {
  if (cached) return cached;
  const columns = await db.execute<{
    table_name: string;
    column_name: string;
    generated: boolean;
    not_null: boolean;
    can_select: boolean;
    can_insert: boolean;
  }>(sql`
    SELECT c.relname AS table_name, a.attname AS column_name, a.attgenerated <> '' AS generated, a.attnotnull AS not_null,
           has_column_privilege(c.oid, a.attnum, 'SELECT') AS can_select,
           has_column_privilege(c.oid, a.attnum, 'INSERT') AS can_insert
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     ORDER BY c.relname, a.attnum`);
  const fks = await db.execute<{
    table_name: string;
    parent: string;
    deferrable: boolean;
    on_delete: string;
    columns: string[];
    parent_columns: string[];
  }>(sql`
    SELECT con.conrelid::regclass::text AS table_name, con.confrelid::regclass::text AS parent,
           con.condeferrable AS deferrable, con.confdeltype::text AS on_delete,
           ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS columns,
           ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) AS parent_columns
      FROM pg_constraint con
     WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`);

  const catalog: Catalog = new Map();
  for (const row of columns.rows) {
    let table = catalog.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: [], fks: [] };
      catalog.set(row.table_name, table);
    }
    table.columns.push({
      name: row.column_name,
      generated: row.generated,
      notNull: row.not_null,
      canSelect: row.can_select,
      canInsert: row.can_insert,
    });
  }
  for (const row of fks.rows) {
    const table = catalog.get(row.table_name);
    const idIndex = row.parent_columns.indexOf('id');
    if (!table || idIndex === -1) continue;
    table.fks.push({
      table: row.table_name,
      parent: row.parent,
      columns: row.columns,
      parentColumns: row.parent_columns,
      deferrable: row.deferrable,
      onDelete: row.on_delete,
      refColumn: row.columns[idIndex]!,
      nullableColumns: row.columns.filter((name) => !table.columns.find((c) => c.name === name)?.notNull),
    });
  }
  // Só tabelas com `id` (ou com a chave composta declarada) entram no backup.
  for (const [name, table] of catalog) {
    if (!table.columns.some((c) => c.name === 'id') && !COMPOSITE_KEYS[name]) catalog.delete(name);
  }
  cached = catalog;
  return catalog;
}

/** Lista de uuids como um único parâmetro uuid[] (o Drizzle expandiria um array JS em vários). */
export const uuidArray = (ids: string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** Tabelas que entram no JSON completo. */
export const fullTables = (catalog: Catalog) => [...catalog.keys()].filter((name) => !EXCLUDED_TABLES.has(name)).sort();

/** Colunas exportadas: legíveis e não geradas (os segredos entram pelas funções de SECRET_READERS). */
export const exportColumns = (table: TableMeta) => table.columns.filter((c) => c.canSelect && !c.generated).map((c) => c.name);

/** Colunas que o papel da aplicação pode inserir. */
export const insertColumns = (table: TableMeta) => new Set(table.columns.filter((c) => c.canInsert && !c.generated).map((c) => c.name));

/** Nome da tabela em pt-BR para a interface. */
export const tableLabel = (table: string) => t.audit.tables[table] ?? t.backup.tables[table] ?? table;

const LABEL_COLUMNS = [
  'name',
  'username',
  'title',
  'description',
  'tool_name',
  'key_value',
  'key',
  'value',
  'model',
  'pattern',
  'file_name',
  'account_number',
  'event_kind',
  'access_key',
  'reference_month',
  'month',
  'street',
  'node_id',
  'role',
];

/** Rótulo legível de uma linha do arquivo (para o relatório). */
export function rowLabel(row: Record<string, unknown>): string {
  for (const column of LABEL_COLUMNS) {
    const value = row[column];
    if (typeof value === 'string' && value.trim()) return value.length > 80 ? `${value.slice(0, 77)}…` : value;
    if (typeof value === 'number') return String(value);
  }
  if (typeof row.id === 'string') return row.id.slice(0, 8);
  // Ligação sem id (entity_tag_links): os inícios das chaves.
  const keys = Object.entries(row).filter(([column, value]) => column.endsWith('_id') && typeof value === 'string');
  return keys.length > 0 ? keys.map(([, value]) => String(value).slice(0, 8)).join(' · ') : '?';
}
