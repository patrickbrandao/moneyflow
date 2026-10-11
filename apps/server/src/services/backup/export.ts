import { createWriteStream } from 'node:fs';
import type { Executor, Tx } from '@moneyflow/db';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupFile,
  type BackupKind,
  type BackupResource,
  type BackupRow,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import { strToU8, Zip, ZipDeflate } from 'fflate';
import type { ServiceContext } from '../../context';
import {
  type Catalog,
  EXCLUDED_TABLES,
  exportColumns,
  fullTables,
  loadCatalog,
  RESOURCE_TABLES,
  SECRET_READERS,
  uuidArray,
} from './catalog';

/*
 * Exportação (spec 019). Lê numa transação REPEATABLE READ somente leitura
 * (um retrato consistente do banco) e devolve as linhas como o banco as
 * serializa (row_to_json: bigint como número, bytea em hex, datas ISO), o que
 * a importação devolve ao banco com json_populate_record sem perda de tipo.
 * Os segredos saem só pelas funções admin_* do banco, com o admin da sessão
 * como ator.
 */

const BATCH = 500;

export async function schemaVersion(db: Executor): Promise<string | null> {
  const result = await db.execute<{ v: string | null }>(sql`SELECT app_schema_version() AS v`);
  return result.rows[0]?.v ?? null;
}

const columnList = (columns: string[]) =>
  sql.join(
    columns.map((c) => sql.identifier(c)),
    sql`, `,
  );

/** Linhas de uma tabela (todas, ou só os ids pedidos), com os segredos quando `withSecrets`. */
async function fetchRows(
  tx: Tx,
  catalog: Catalog,
  table: string,
  actorId: string,
  options: { ids?: string[]; withSecrets: boolean; after?: string; limit?: number },
): Promise<BackupRow[]> {
  const meta = catalog.get(table);
  if (!meta) return [];
  const where: SQL[] = [];
  if (options.ids) where.push(sql`id = ANY(${uuidArray(options.ids)})`);
  if (options.after) where.push(sql`id > ${options.after}::uuid`);
  const result = await tx.execute<{ j: string }>(sql`
    SELECT row_to_json(backup_row)::text AS j
      FROM (SELECT ${columnList(exportColumns(meta))} FROM ${sql.identifier(table)}
             ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
             ORDER BY id ${options.limit ? sql`LIMIT ${options.limit}` : sql``}) backup_row`);
  const rows = result.rows.map((r) => JSON.parse(r.j) as BackupRow);
  const secret = SECRET_READERS[table];
  if (options.withSecrets && secret && rows.length > 0) {
    const values = await tx.execute<{ id: string; s: unknown }>(sql`
      SELECT id::text AS id, ${sql.raw(secret.fn)}(id, ${actorId}::uuid) AS s
        FROM ${sql.identifier(table)} WHERE id = ANY(${uuidArray(rows.map((r) => r.id as string))})`);
    const byId = new Map(values.rows.map((v) => [v.id, v.s]));
    for (const row of rows) row[secret.column] = byId.get(row.id as string) ?? null;
  }
  return rows;
}

function header(ctx: ServiceContext, kind: BackupKind, version: string | null) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    kind,
    schemaVersion: version,
    exportedAt: new Date().toISOString(),
    exportedBy: ctx.access.actor.username,
  } as const;
}

const readOnly = <T>(ctx: ServiceContext, fn: (tx: Tx) => Promise<T>) =>
  ctx.db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' });

/** Um recurso, com as referências externas (sem segredos) para casar registros na importação. */
export async function exportResource(ctx: ServiceContext, resource: BackupResource): Promise<BackupFile> {
  ctx.access.assertAdmin();
  const catalog = await loadCatalog(ctx.db);
  const actorId = ctx.access.actor.id;
  return readOnly(ctx, async (tx) => {
    const included = RESOURCE_TABLES[resource].filter((table) => catalog.has(table));
    const tables: Record<string, BackupRow[]> = {};
    for (const table of included) tables[table] = await fetchRows(tx, catalog, table, actorId, { withSecrets: true });

    // Referências: registros fora do recurso apontados pelas FKs (fecho transitivo raso).
    const references: Record<string, BackupRow[]> = {};
    const seen = new Set<string>();
    let frontier: [string, BackupRow[]][] = Object.entries(tables);
    for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
      const wanted = new Map<string, Set<string>>();
      for (const [table, rows] of frontier) {
        for (const fk of catalog.get(table)?.fks ?? []) {
          if (included.includes(fk.parent) || EXCLUDED_TABLES.has(fk.parent)) continue;
          for (const row of rows) {
            const id = row[fk.refColumn];
            if (typeof id !== 'string' || seen.has(`${fk.parent}:${id}`)) continue;
            seen.add(`${fk.parent}:${id}`);
            if (!wanted.has(fk.parent)) wanted.set(fk.parent, new Set());
            wanted.get(fk.parent)!.add(id);
          }
        }
      }
      frontier = [];
      for (const [table, ids] of wanted) {
        const rows = await fetchRows(tx, catalog, table, actorId, { ids: [...ids], withSecrets: false });
        references[table] = [...(references[table] ?? []), ...rows];
        frontier.push([table, rows]);
      }
    }
    return { ...header(ctx, resource, await schemaVersion(tx)), tables, references };
  });
}

/**
 * O conteúdo completo num .zip com `moneyflow.json`, escrito em `path` aos
 * pedaços (tabela por tabela, em lotes), sem montar o JSON inteiro na memória.
 */
export async function exportFullZip(ctx: ServiceContext, path: string): Promise<void> {
  ctx.access.assertAdmin();
  const catalog = await loadCatalog(ctx.db);
  const actorId = ctx.access.actor.id;
  const out = createWriteStream(path, { mode: 0o600 });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  let zipError: Error | null = null;
  const zip = new Zip((error, data, final) => {
    if (error) {
      zipError = error;
      out.destroy(error);
      return;
    }
    out.write(data);
    if (final) out.end();
  });
  const entry = new ZipDeflate('moneyflow.json', { level: 6 });
  zip.add(entry);
  const push = (text: string) => entry.push(strToU8(text), false);

  try {
    await readOnly(ctx, async (tx) => {
      const head = header(ctx, 'full', await schemaVersion(tx));
      push(`${JSON.stringify(head).slice(0, -1)},"tables":{`);
      let firstTable = true;
      for (const table of fullTables(catalog)) {
        push(`${firstTable ? '' : ','}${JSON.stringify(table)}:[`);
        firstTable = false;
        let after: string | undefined;
        let firstRow = true;
        for (;;) {
          const rows = await fetchRows(tx, catalog, table, actorId, { withSecrets: true, after, limit: BATCH });
          for (const row of rows) {
            push(`${firstRow ? '' : ','}${JSON.stringify(row)}`);
            firstRow = false;
          }
          if (rows.length < BATCH) break;
          after = rows[rows.length - 1]!.id as string;
        }
        push(']');
      }
      push('}}');
    });
    entry.push(new Uint8Array(0), true);
    zip.end();
  } catch (error) {
    zip.terminate();
    out.destroy();
    throw error;
  }
  await finished;
  if (zipError) throw zipError;
}
