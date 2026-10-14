import { randomUUID } from 'node:crypto';
import type { Tx } from '@moneyflow/db';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupFile,
  type BackupKind,
  type BackupRow,
  type ImportIssue,
  type ImportItemStatus,
  type ImportReport,
  type ImportTableSummary,
  isBackupKind,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import type { ServiceContext } from '../../context';
import { AppError, findPgError, translateDbError, unprocessable } from '../../errors';
import { withTx } from '../tx';
import {
  type Catalog,
  COMPOSITE_KEYS,
  DEFERRED_CLUSTER,
  EXCLUDED_TABLES,
  type ForeignKeyMeta,
  insertColumns,
  LAST_TABLES,
  loadCatalog,
  NATURAL_KEYS,
  OWNED_BY,
  RESOURCE_TABLES,
  rowLabel,
  tableLabel,
  uuidArray,
} from './catalog';
import { schemaVersion } from './export';

/*
 * Importação com merge (spec 019). Regras:
 * - Os ids do arquivo são preservados. Um registro cujo id já existe, ou que
 *   bate com um cadastrado por chave natural (NATURAL_KEYS), é "já cadastrado":
 *   fica o atual, e as referências do arquivo passam a apontar para ele.
 * - Filhos de um dono já cadastrado (OWNED_BY) não entram.
 * - Os registros entram em ordem de dependência (por linha, não por tabela).
 *   Quem depende de algo que não entrou também não entra, com o motivo — a
 *   não ser que a FK seja ON DELETE SET NULL: aí a referência é anulada.
 * - Cada registro entra num savepoint: o que o banco recusar (unicidade, regra,
 *   mês fechado…) é desfeito sozinho e aparece no relatório. Registros ligados
 *   por checagens no COMMIT (DEFERRED_CLUSTER: espelho, baixas, movimentos,
 *   transferências, faturas) entram juntos e as checagens rodam antes de
 *   liberar o savepoint (SET CONSTRAINTS ALL IMMEDIATE).
 * - Estados que o banco só aceita por transição (baixa estornada, título
 *   cancelado, fatura fechada) são reproduzidos: insere no estado inicial e
 *   atualiza depois.
 * - Simulação: tudo igual, e a transação é desfeita no fim.
 */

const MAX_ISSUES = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NodeStatus = 'pending' | 'planned' | 'missing' | ImportItemStatus;

type Node = {
  key: string;
  table: string;
  id: string;
  data: BackupRow;
  ref: boolean;
  label: string;
  order: number;
  status: NodeStatus;
  target: string;
  reason?: string;
  /** Pais (FK não adiável) presentes no arquivo. */
  deps: Node[];
  unit?: Unit;
  translated?: BackupRow;
};

type Unit = { nodes: Node[]; deps: Set<Unit>; dependents: Set<Unit>; rank: number; first: number; last: boolean; cluster: boolean };

class DryRunRollback extends Error {}

/** Lê o arquivo enviado (.json ou .zip com um .json dentro) e valida o cabeçalho. */
export function parseBackupUpload(body: unknown): BackupFile {
  if (!Buffer.isBuffer(body) || body.length === 0) throw unprocessable(t.backup.errors.invalidFile, 'invalid_backup');
  let text: string;
  if (body[0] === 0x50 && body[1] === 0x4b) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(body.buffer, body.byteOffset, body.length), {
        filter: (file) => file.name.toLowerCase().endsWith('.json'),
      });
    } catch {
      throw unprocessable(t.backup.errors.invalidFile, 'invalid_backup');
    }
    const name = Object.keys(entries).find((n) => n.endsWith('moneyflow.json')) ?? Object.keys(entries)[0];
    if (!name) throw unprocessable(t.backup.errors.invalidFile, 'invalid_backup');
    text = strFromU8(entries[name]!);
  } else {
    text = body.toString('utf8');
  }
  let file: Partial<BackupFile>;
  try {
    file = JSON.parse(text.replace(/^﻿/, '')) as Partial<BackupFile>;
  } catch {
    throw unprocessable(t.backup.errors.invalidFile, 'invalid_backup');
  }
  if (!file || file.format !== BACKUP_FORMAT || typeof file.tables !== 'object' || !file.tables || !isBackupKind(String(file.kind))) {
    throw unprocessable(t.backup.errors.invalidFile, 'invalid_backup');
  }
  if (Number(file.version) > BACKUP_FORMAT_VERSION) throw unprocessable(t.backup.errors.newerFormat, 'invalid_backup');
  for (const rows of [...Object.values(file.tables), ...Object.values(file.references ?? {})]) {
    if (!Array.isArray(rows)) throw unprocessable(t.backup.errors.invalidFile, 'invalid_backup');
  }
  return file as BackupFile;
}

/** Profundidade de cada tabela no grafo de FKs (pais antes dos filhos; ciclos são cortados). */
function tableRanks(catalog: Catalog): Map<string, number> {
  const rank = new Map<string, number>([...catalog.keys()].map((name) => [name, 0]));
  for (let pass = 0; pass < catalog.size; pass += 1) {
    let changed = false;
    for (const table of catalog.values()) {
      for (const fk of table.fks) {
        if (fk.deferrable || fk.parent === table.name) continue;
        const candidate = Math.min((rank.get(fk.parent) ?? 0) + 1, catalog.size);
        if (candidate > (rank.get(table.name) ?? 0)) {
          rank.set(table.name, candidate);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const table of LAST_TABLES) rank.set(table, catalog.size + 1);
  return rank;
}

/** Fila de prioridade mínima (Kahn com desempate estável). */
class Heap<T> {
  private items: T[] = [];
  constructor(private less: (a: T, b: T) => boolean) {}
  get size() {
    return this.items.length;
  }
  push(item: T) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

/** Ordem topológica genérica; devolve também os que sobraram (ciclo). */
function topoSort<T>(items: T[], depsOf: (item: T) => Iterable<T>, less: (a: T, b: T) => boolean): { order: T[]; rest: T[] } {
  const indegree = new Map<T, number>();
  const dependents = new Map<T, T[]>();
  const set = new Set(items);
  for (const item of items) {
    let n = 0;
    for (const dep of depsOf(item)) {
      if (!set.has(dep) || dep === item) continue;
      n += 1;
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(item);
    }
    indegree.set(item, n);
  }
  const heap = new Heap<T>(less);
  for (const item of items) if (indegree.get(item) === 0) heap.push(item);
  const order: T[] = [];
  while (heap.size > 0) {
    const item = heap.pop()!;
    order.push(item);
    for (const next of dependents.get(item) ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) heap.push(next);
    }
  }
  const done = new Set(order);
  return { order, rest: items.filter((item) => !done.has(item)) };
}

const FLOW_PURPOSES = new Set(['document_reading', 'classify_lines', 'contract_reading', 'contract_markdown']);

/**
 * Ajustes de linhas do arquivo antes do merge:
 * - ai_agents: a marca "agente dos fluxos" (use_for_flows) só entra se o banco
 *   ainda não tem um agente marcado; senão o agente entra sem a marca, em vez
 *   de virar conflito (só um marcado por vez).
 * - ai_conversations: um arquivo anterior à coluna `purpose` marcava as
 *   conversas dos fluxos em screen_context.purpose; a finalidade vem de lá.
 */
function normalizeRow(table: string, data: BackupRow, state: { flowAgentTaken: boolean }): BackupRow {
  if (table === 'ai_agents' && data.use_for_flows === true && state.flowAgentTaken) {
    return { ...data, use_for_flows: false };
  }
  if (table === 'ai_conversations' && data.purpose === undefined) {
    const screen = data.screen_context as Record<string, unknown> | null | undefined;
    const legacy = screen && typeof screen === 'object' ? screen.purpose : undefined;
    if (typeof legacy === 'string' && FLOW_PURPOSES.has(legacy)) {
      const { purpose: _purpose, ...rest } = screen!;
      return { ...data, purpose: legacy, screen_context: Object.keys(rest).length > 0 ? rest : null };
    }
  }
  return data;
}

/** Estados que só se alcançam por transição: insere no estado inicial e atualiza depois. */
function replay(table: string, data: BackupRow): { insert: BackupRow; post: BackupRow | null } {
  if (table === 'titles') {
    return { insert: { ...data, status: 'open' }, post: data.status === 'canceled' ? { status: 'canceled' } : null };
  }
  if (table === 'settlements' && data.reversed_at) {
    return {
      insert: { ...data, reversed_at: null, reversal_reason: null },
      post: { reversed_at: data.reversed_at, reversal_reason: data.reversal_reason ?? null },
    };
  }
  if (table === 'card_invoices' && data.closed_at) {
    return { insert: { ...data, closed_at: null }, post: { closed_at: data.closed_at } };
  }
  // Tag arquivada: o banco recusa ligá-la a uma entidade; entra ativa e é arquivada no fim (LATE_POST).
  if (table === 'entity_tags' && data.archived_at) {
    return { insert: { ...data, archived_at: null }, post: { archived_at: data.archived_at } };
  }
  return { insert: data, post: null };
}

/** Tabelas cujo passo "depois" (replay) roda no fim da importação, depois de todos os registros. */
const LATE_POST = new Set(['entity_tags']);

/** Colunas da tabela que são FK (uuid); as demais colunas de uma chave composta são texto. */
const fkColumns = (catalog: Catalog, table: string) => new Set(catalog.get(table)?.fks.map((fk) => fk.refColumn) ?? []);

/** Identificador da linha no arquivo: o id, ou a chave composta (`a|b`) nas tabelas sem id. */
function rowKey(table: string, data: BackupRow, uuidColumns: Set<string>): string {
  const composite = COMPOSITE_KEYS[table];
  if (!composite) return typeof data.id === 'string' ? data.id.toLowerCase() : '';
  const valid = composite.every((column) => {
    const v = data[column];
    return typeof v === 'string' && v !== '' && !v.includes('|') && (!uuidColumns.has(column) || UUID.test(v));
  });
  return valid
    ? composite.map((column) => (uuidColumns.has(column) ? String(data[column]).toLowerCase() : String(data[column]))).join('|')
    : '';
}

/**
 * Arquivo anterior ao kit de ferramentas (spec 021): o agente trazia
 * enabled_tools e require_write_confirmation. Com a mesma regra da migration
 * 0038 (retrato da v0.1.7 em ai_legacy_tool_registry()), o agente novo ganha o
 * kit "Kit – <nome>" no próprio arquivo — ninguém ganha nem perde poder —, ou
 * fica sem kit (lista nula e sem confirmação). Agentes que já existem aqui
 * (mesmo id ou nome) ficam como estão, então não ganham kit.
 */
async function legacyAgentKits(ctx: ServiceContext, file: BackupFile): Promise<BackupFile> {
  const agents = file.tables.ai_agents ?? [];
  const legacy = agents.filter(
    (row) => row && typeof row === 'object' && !('tool_kit_id' in row) && ('enabled_tools' in row || 'require_write_confirmation' in row),
  );
  if (legacy.length === 0) return file;
  const registry = await ctx.db.execute<{ tool_name: string; kind: string; confirm: string }>(
    sql`SELECT tool_name, kind, confirm FROM ai_legacy_tool_registry()`,
  );
  const known = await ctx.db.execute<{ id: string; name: string }>(sql`SELECT id::text AS id, lower(name) AS name FROM ai_agents`);
  const knownIds = new Set(known.rows.map((r) => r.id));
  const knownNames = new Set(known.rows.map((r) => r.name));
  const kits: BackupRow[] = [];
  const kitTools: BackupRow[] = [];
  const rows = agents.map((row) => {
    if (!legacy.includes(row)) return row;
    const { enabled_tools: enabled, require_write_confirmation: flag, ...rest } = row;
    const list = Array.isArray(enabled) ? new Set(enabled.map(String)) : null;
    const confirmWrites = flag !== false;
    const name = typeof rest.name === 'string' ? rest.name : '';
    const exists = (typeof rest.id === 'string' && knownIds.has(rest.id.toLowerCase())) || knownNames.has(name.toLowerCase());
    if (exists || (list === null && !confirmWrites)) return { ...rest, tool_kit_id: null };
    const kitId = randomUUID();
    kits.push({ id: kitId, name: `Kit – ${name}`.slice(0, 120), description: null, created_by_user_id: null });
    for (const tool of registry.rows) {
      if (list && !list.has(tool.tool_name)) continue;
      const ask = tool.confirm === 'always' || (confirmWrites && tool.kind === 'write' && tool.confirm !== 'never');
      kitTools.push({ kit_id: kitId, tool_name: tool.tool_name, mode: ask ? 'ask' : 'allow' });
    }
    return { ...rest, tool_kit_id: kitId };
  });
  return {
    ...file,
    tables: {
      ...file.tables,
      ai_agents: rows,
      ai_tool_kits: [...(file.tables.ai_tool_kits ?? []), ...kits],
      ai_tool_kit_tools: [...(file.tables.ai_tool_kit_tools ?? []), ...kitTools],
    },
  };
}

function describe(error: unknown): string {
  const translated = translateDbError(error);
  if (translated) return t.backup.reasons.db(translated.message);
  const pg = findPgError(error);
  return t.backup.reasons.db(pg?.message ?? (error as Error).message ?? t.errors.generic);
}

export async function importBackup(ctx: ServiceContext, uploaded: BackupFile, kind: BackupKind, dryRun: boolean): Promise<ImportReport> {
  ctx.access.assertAdmin();
  const started = Date.now();
  const file = kind === 'full' ? await legacyAgentKits(ctx, uploaded) : uploaded;
  const catalog = await loadCatalog(ctx.db);
  const ranks = tableRanks(catalog);

  // Tabelas importadas e tabelas só de referência.
  const wanted = kind === 'full' ? [...catalog.keys()].filter((name) => !EXCLUDED_TABLES.has(name)) : RESOURCE_TABLES[kind];
  const included = new Set(wanted.filter((name) => catalog.has(name) && (file.tables[name]?.length ?? 0) > 0));
  if (included.size === 0) throw unprocessable(t.backup.errors.emptyFile, 'empty_backup');
  const ignoredTables = Object.keys(file.tables).filter((name) => !catalog.has(name) || (kind === 'full' && EXCLUDED_TABLES.has(name)));

  const flowAgent = await ctx.db.execute<{ taken: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM ai_agents WHERE use_for_flows) AS taken`);
  const normalizeState = { flowAgentTaken: Boolean(flowAgent.rows[0]?.taken) };

  const nodes = new Map<string, Node>();
  const invalid: Node[] = [];
  const addRows = (table: string, rows: BackupRow[], ref: boolean) => {
    if (!catalog.has(table) || EXCLUDED_TABLES.has(table)) return;
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const data = ref ? raw : normalizeRow(table, raw, normalizeState);
      const id = rowKey(table, data, fkColumns(catalog, table));
      const node: Node = {
        key: `${table}:${id}`,
        table,
        id,
        data,
        ref,
        label: rowLabel(data),
        order: 0,
        status: 'pending',
        target: id,
        deps: [],
      };
      if (!id || (!COMPOSITE_KEYS[table] && !UUID.test(id))) {
        if (!ref) invalid.push({ ...node, status: 'failed', reason: t.backup.reasons.noId });
        continue;
      }
      const current = nodes.get(node.key);
      if (current && (!current.ref || ref)) continue;
      nodes.set(node.key, node);
    }
  };
  for (const table of included) addRows(table, file.tables[table]!, false);
  for (const [table, rows] of Object.entries(file.tables)) if (!included.has(table)) addRows(table, rows, true);
  for (const [table, rows] of Object.entries(file.references ?? {})) addRows(table, rows, true);

  const all = [...nodes.values()].sort((a, b) => ranks.get(a.table)! - ranks.get(b.table)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  all.forEach((node, index) => {
    node.order = index;
  });
  for (const node of all) {
    for (const fk of catalog.get(node.table)!.fks) {
      const value = node.data[fk.refColumn];
      if (fk.deferrable || typeof value !== 'string') continue;
      const parent = nodes.get(`${fk.parent}:${value.toLowerCase()}`);
      if (parent && parent !== node) node.deps.push(parent);
    }
  }

  // Unidades: os registros do cluster adiável ligados entre si formam uma só.
  const root = new Map<Node, Node>();
  const find = (node: Node): Node => {
    let r = node;
    while (root.get(r) && root.get(r) !== r) r = root.get(r)!;
    root.set(node, r);
    return r;
  };
  for (const node of all) {
    if (node.ref || !DEFERRED_CLUSTER.has(node.table)) continue;
    root.set(node, root.get(node) ?? node);
    for (const fk of catalog.get(node.table)!.fks) {
      const value = node.data[fk.refColumn];
      if (!DEFERRED_CLUSTER.has(fk.parent) || typeof value !== 'string') continue;
      const parent = nodes.get(`${fk.parent}:${value.toLowerCase()}`);
      if (!parent || parent.ref) continue;
      root.set(parent, root.get(parent) ?? parent);
      root.set(find(node), find(parent));
    }
  }
  const unitOf = new Map<Node, Unit>();
  const units: Unit[] = [];
  for (const node of all) {
    const key = root.has(node) ? find(node) : node;
    let unit = unitOf.get(key);
    if (!unit) {
      unit = {
        nodes: [],
        deps: new Set(),
        dependents: new Set(),
        rank: ranks.get(node.table)!,
        first: node.order,
        last: LAST_TABLES.has(node.table),
        cluster: root.has(node),
      };
      unitOf.set(key, unit);
      units.push(unit);
    }
    unit.nodes.push(node);
    node.unit = unit;
  }
  for (const unit of units) for (const node of unit.nodes) for (const dep of node.deps) if (dep.unit !== unit) unit.deps.add(dep.unit!);

  const lessUnit = (a: Unit, b: Unit) => (a.last !== b.last ? !a.last : a.rank !== b.rank ? a.rank < b.rank : a.first < b.first);
  const sorted = topoSort(units, (u) => u.deps, lessUnit);
  for (const unit of sorted.rest) {
    for (const node of unit.nodes) {
      node.status = node.ref ? 'missing' : 'failed';
      node.reason = t.backup.reasons.cycle;
    }
  }

  let sourceVersion: string | null = file.schemaVersion ?? null;
  let currentVersion: string | null = null;

  const run = async (tx: Tx) => {
    const locked = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext('moneyflow:backup')) AS ok`);
    if (!locked.rows[0]?.ok) throw new AppError(409, 'backup_busy', t.backup.errors.busy);
    currentVersion = await schemaVersion(tx);

    // Ids do arquivo que já existem no banco, por tabela.
    const existing = new Set<string>();
    const byTable = new Map<string, string[]>();
    for (const node of all) {
      if (!byTable.has(node.table)) byTable.set(node.table, []);
      byTable.get(node.table)!.push(node.id);
    }
    for (const [table, ids] of byTable) {
      if (COMPOSITE_KEYS[table]) continue;
      for (let i = 0; i < ids.length; i += 5000) {
        const found = await tx.execute<{ id: string }>(
          sql`SELECT id::text AS id FROM ${sql.identifier(table)} WHERE id = ANY(${uuidArray(ids.slice(i, i + 5000))})`,
        );
        for (const row of found.rows) existing.add(`${table}:${row.id}`);
      }
    }
    const inDb = new Map<string, boolean>();
    const existsInDb = async (table: string, id: string) => {
      if (COMPOSITE_KEYS[table]) return false;
      const key = `${table}:${id}`;
      if (existing.has(key)) return true;
      if (!inDb.has(key)) {
        const found = UUID.test(id)
          ? await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`)
          : { rows: [] as unknown[] };
        inDb.set(key, found.rows.length > 0);
      }
      return inDb.get(key)!;
    };

    /** Traduz as FKs do registro para os ids deste banco; erro = dependência que não se resolve. */
    const translate = async (node: Node): Promise<{ data: BackupRow; error?: string }> => {
      const data: BackupRow = COMPOSITE_KEYS[node.table] ? { ...node.data } : { ...node.data, id: node.id };
      for (const fk of catalog.get(node.table)!.fks) {
        const raw = node.data[fk.refColumn];
        if (typeof raw !== 'string') continue;
        const value = raw.toLowerCase();
        const parent = nodes.get(`${fk.parent}:${value}`);
        let unresolved: string | null = null;
        if (parent) {
          if (parent.status === 'imported' || parent.status === 'existing' || parent.status === 'planned')
            data[fk.refColumn] = parent.target;
          else if (parent.status === 'pending' && parent.unit === node.unit) data[fk.refColumn] = parent.id;
          else if (parent.status === 'missing' || parent.ref)
            unresolved = t.backup.reasons.dependsMissing(tableLabel(fk.parent).toLowerCase(), parent.label);
          else unresolved = t.backup.reasons.dependsFailed(tableLabel(fk.parent).toLowerCase(), parent.label);
        } else if (!(await existsInDb(fk.parent, value))) {
          unresolved = t.backup.reasons.dependsMissing(tableLabel(fk.parent).toLowerCase(), value.slice(0, 8));
        }
        if (!unresolved) continue;
        if (isSoft(fk)) for (const column of fk.nullableColumns) data[column] = null;
        else return { data, error: unresolved };
      }
      return { data };
    };

    const naturalMatch = async (node: Node, data: BackupRow): Promise<{ id: string; key: string } | null> => {
      for (const key of NATURAL_KEYS[node.table] ?? []) {
        const parts = key.map((spec) => ({
          column: spec.replace(/^(lower:|\?)/, ''),
          lower: spec.startsWith('lower:'),
          required: spec.startsWith('?'),
        }));
        if (parts.some((p) => p.required && (data[p.column] === null || data[p.column] === undefined))) continue;
        const conditions = parts.map((p) =>
          p.lower
            ? sql`lower(t.${sql.identifier(p.column)}::text) = lower(r.${sql.identifier(p.column)}::text)`
            : sql`t.${sql.identifier(p.column)} IS NOT DISTINCT FROM r.${sql.identifier(p.column)}`,
        );
        const found = await tx.execute<{ id: string }>(sql`
          SELECT t.id::text AS id
            FROM ${sql.identifier(node.table)} t, json_populate_record(NULL::${sql.identifier(node.table)}, ${JSON.stringify(data)}::json) r
           WHERE ${sql.join(conditions, sql` AND `)} LIMIT 1`);
        const id = found.rows[0]?.id;
        if (id) return { id, key: parts[parts.length - 1]!.column };
      }
      return null;
    };

    /** Linha de tabela sem id que já existe (mesma chave composta, com as FKs traduzidas). */
    const compositeExists = async (table: string, data: BackupRow) => {
      const composite = COMPOSITE_KEYS[table];
      if (!composite) return false;
      const uuids = fkColumns(catalog, table);
      const conditions = composite.map((column) =>
        uuids.has(column)
          ? sql`${sql.identifier(column)} = ${String(data[column])}::uuid`
          : sql`${sql.identifier(column)} = ${String(data[column])}`,
      );
      const found = await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.join(conditions, sql` AND `)}`);
      return found.rows.length > 0;
    };

    const ownerPreexisted = (node: Node, column: string) => {
      const raw = node.data[column];
      if (typeof raw !== 'string') return false;
      const fk = catalog.get(node.table)!.fks.find((f) => f.refColumn === column);
      const parent = fk ? nodes.get(`${fk.parent}:${raw.toLowerCase()}`) : undefined;
      if (!parent) return true; // está no banco (a tradução já confirmou)
      return parent.status === 'existing' || parent.status === 'skipped';
    };

    const insertRow = async (table: string, data: BackupRow) => {
      const allowed = insertColumns(catalog.get(table)!);
      const columns = Object.keys(data).filter((c) => allowed.has(c));
      const list = sql.join(
        columns.map((c) => sql.identifier(c)),
        sql`, `,
      );
      await tx.execute(sql`
        INSERT INTO ${sql.identifier(table)} (${list})
        SELECT ${list} FROM json_populate_record(NULL::${sql.identifier(table)}, ${JSON.stringify(data)}::json)`);
    };
    const updateRow = async (table: string, id: string, data: BackupRow) => {
      const columns = Object.keys(data);
      const list = sql.join(
        columns.map((c) => sql.identifier(c)),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${sql.identifier(table)} SET (${list}) = (
          SELECT ${list} FROM json_populate_record(NULL::${sql.identifier(table)}, ${JSON.stringify(data)}::json))
         WHERE id = ${id}::uuid`);
    };

    const late: { node: Node; data: BackupRow }[] = [];

    const processUnit = async (unit: Unit) => {
      const members = topoSort(
        unit.nodes,
        (n) => n.deps,
        (a, b) => a.order < b.order,
      ).order;
      if (members.length < unit.nodes.length) {
        for (const node of unit.nodes) Object.assign(node, { status: node.ref ? 'missing' : 'failed', reason: t.backup.reasons.cycle });
        return;
      }
      // 1. Resolve cada membro: tradução das FKs, já cadastrado, dono já cadastrado.
      let failure: { node: Node; reason: string } | null = null;
      for (const node of members) {
        const { data, error } = await translate(node);
        if (!error && (await compositeExists(node.table, data))) {
          Object.assign(node, { status: 'existing', target: node.id, reason: t.backup.reasons.existsId });
          continue;
        }
        if (await existsInDb(node.table, node.id)) {
          Object.assign(node, { status: 'existing', target: node.id, reason: t.backup.reasons.existsId });
          continue;
        }
        const match = error ? null : await naturalMatch(node, data);
        if (match) {
          const keyLabel = t.backup.keyLabels[match.key] ?? match.key;
          Object.assign(node, { status: 'existing', target: match.id, reason: t.backup.reasons.existsKey(keyLabel) });
          continue;
        }
        if (node.ref) {
          Object.assign(node, { status: 'missing' });
          continue;
        }
        if (error) {
          failure = { node, reason: error };
          break;
        }
        const owners = OWNED_BY[node.table];
        if (owners?.every((column) => ownerPreexisted(node, column))) {
          const fk = catalog.get(node.table)!.fks.find((f) => f.refColumn === owners[0]);
          Object.assign(node, { status: 'skipped', reason: t.backup.reasons.owned(tableLabel(fk?.parent ?? node.table).toLowerCase()) });
          continue;
        }
        node.translated = data;
        node.status = 'planned';
        node.target = node.id;
      }
      const planned = members.filter((n) => n.status === 'planned');
      if (failure) {
        failure.node.status = 'failed';
        failure.node.reason = failure.reason;
        for (const node of planned) Object.assign(node, { status: 'failed', reason: t.backup.reasons.linked(failure.reason) });
        return;
      }
      if (planned.length === 0) return;

      // 2. Passos (inserir e, nos estados por transição, atualizar depois) em ordem.
      type Step = { node: Node; kind: 'insert' | 'post'; data: BackupRow; deps: Step[]; order: number };
      const steps: Step[] = [];
      const insertOf = new Map<Node, Step>();
      const postOf = new Map<Node, Step>();
      for (const node of planned) {
        const { insert, post } = replay(node.table, node.translated!);
        const ins: Step = { node, kind: 'insert', data: insert, deps: [], order: node.order * 2 };
        insertOf.set(node, ins);
        steps.push(ins);
        if (post && LATE_POST.has(node.table)) late.push({ node, data: post });
        else if (post) {
          const step: Step = { node, kind: 'post', data: post, deps: [ins], order: node.order * 2 + 1 };
          postOf.set(node, step);
          steps.push(step);
        }
      }
      const plannedById = (table: string, id: unknown) =>
        typeof id === 'string' ? planned.find((n) => n.table === table && n.id === id.toLowerCase()) : undefined;
      for (const node of planned) {
        const ins = insertOf.get(node)!;
        for (const dep of node.deps) if (insertOf.has(dep)) ins.deps.push(insertOf.get(dep)!);
        const data = node.data;
        if (node.table === 'settlements') {
          // Uma baixa estornada antes de outra ser criada sai do saldo antes dela.
          for (const other of planned) {
            if (other.table !== 'settlements' || other === node || other.data.title_id !== data.title_id) continue;
            const reversal = postOf.get(other);
            if (reversal && String(other.data.reversed_at) <= String(data.created_at)) ins.deps.push(reversal);
          }
        }
        if (node.table === 'card_invoice_items' && data.carried_from_invoice_id) {
          const source = plannedById('card_invoices', data.carried_from_invoice_id);
          if (source && postOf.has(source)) ins.deps.push(postOf.get(source)!);
        }
      }
      for (const [node, post] of postOf) {
        if (node.table === 'titles') {
          for (const s of planned)
            if (s.table === 'settlements' && s.data.title_id === node.data.id) post.deps.push(postOf.get(s) ?? insertOf.get(s)!);
        }
        if (node.table === 'card_invoices') {
          for (const item of planned)
            if (item.table === 'card_invoice_items' && item.data.card_invoice_id === node.data.id) post.deps.push(insertOf.get(item)!);
        }
      }
      const stepOrder = topoSort(
        steps,
        (s) => s.deps,
        (a, b) => a.order < b.order,
      );
      if (stepOrder.rest.length > 0) {
        for (const node of planned) Object.assign(node, { status: 'failed', reason: t.backup.reasons.cycle });
        return;
      }

      // 3. Grava num savepoint; no cluster, as checagens do COMMIT rodam aqui.
      await tx.execute(sql`SAVEPOINT backup_unit`);
      let current: Step | null = null;
      try {
        for (const step of stepOrder.order) {
          current = step;
          if (step.kind === 'insert') await insertRow(step.node.table, step.data);
          else await updateRow(step.node.table, step.node.id, step.data);
        }
        current = null;
        if (unit.cluster) {
          await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        }
        await tx.execute(sql`RELEASE SAVEPOINT backup_unit`);
        for (const node of planned) node.status = 'imported';
      } catch (error) {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT backup_unit`);
        await tx.execute(sql`RELEASE SAVEPOINT backup_unit`);
        if (unit.cluster) await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const reason = describe(error);
        const culprit: Node | null = (current as Step | null)?.node ?? null;
        for (const node of planned) {
          node.status = 'failed';
          node.reason = !culprit || node === culprit || planned.length === 1 ? reason : t.backup.reasons.linked(reason);
        }
      }
    };

    for (const unit of sorted.order) await processUnit(unit);

    // Passos tardios (tag arquivada): depois de todas as ligações.
    for (const { node, data } of late) {
      if (node.status !== 'imported') continue;
      await tx.execute(sql`SAVEPOINT backup_late`);
      try {
        await updateRow(node.table, node.id, data);
        await tx.execute(sql`RELEASE SAVEPOINT backup_late`);
      } catch (error) {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT backup_late`);
        await tx.execute(sql`RELEASE SAVEPOINT backup_late`);
        Object.assign(node, { status: 'failed', reason: describe(error) });
      }
    }
    if (dryRun) throw new DryRunRollback();
  };

  try {
    await withTx(ctx, run);
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  // Relatório (só das tabelas importadas).
  const summary = new Map<string, ImportTableSummary>();
  const issues: ImportIssue[] = [];
  const statusRank: Record<string, number> = { failed: 0, skipped: 1, existing: 2 };
  for (const node of [...invalid, ...all.filter((n) => !n.ref)]) {
    let row = summary.get(node.table);
    if (!row) {
      row = { table: node.table, total: 0, imported: 0, existing: 0, skipped: 0, failed: 0 };
      summary.set(node.table, row);
    }
    row.total += 1;
    const status: ImportItemStatus =
      node.status === 'imported' || node.status === 'existing' || node.status === 'skipped' ? node.status : 'failed';
    row[status] += 1;
    if (status !== 'imported') {
      issues.push({ table: node.table, id: node.id, label: node.label, status, reason: node.reason ?? t.errors.generic });
    }
  }
  issues.sort((a, b) => statusRank[a.status]! - statusRank[b.status]! || ranks.get(a.table)! - ranks.get(b.table)!);
  sourceVersion ??= null;
  return {
    kind,
    dryRun,
    sourceSchemaVersion: sourceVersion,
    schemaVersion: currentVersion,
    summary: [...summary.values()].sort((a, b) => ranks.get(a.table)! - ranks.get(b.table)!),
    issues: issues.slice(0, MAX_ISSUES),
    issueCount: issues.length,
    truncated: issues.length > MAX_ISSUES,
    ignoredTables,
    durationMs: Date.now() - started,
  };
}

/** FK "fraca" (ON DELETE SET NULL): sem o pai, a referência é anulada em vez de barrar o registro. */
const isSoft = (fk: ForeignKeyMeta) => fk.onDelete === 'n' && fk.nullableColumns.includes(fk.refColumn);
