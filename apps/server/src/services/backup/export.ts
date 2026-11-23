import { once } from 'node:events';
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
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { ServiceContext } from '../../context';
import {
  type Catalog,
  EXCLUDED_TABLES,
  exportColumns,
  fullTables,
  keyColumns,
  loadCatalog,
  RESOURCE_TABLES,
  ROW_FILTERS,
  SECRET_READERS,
  uuidArray,
} from './catalog';
import { withBackupLock } from './lock';

/*
 * Exportação (spec 019). Lê numa transação REPEATABLE READ somente leitura
 * (um retrato consistente do banco) e devolve as linhas como o banco as
 * serializa (row_to_json: bigint como número, bytea em hex, datas ISO), o que
 * a importação devolve ao banco com json_populate_record sem perda de tipo.
 * Os segredos saem só pelas funções admin_* do banco, com o admin da sessão
 * como ator.
 *
 * No JSON completo (tarefa 077), o conteúdo dos anexos não vai no JSON: cada um
 * é uma entrada própria do .zip (`attachments/<id>`, binário cru), lida e
 * escrita uma por vez, e a linha leva `content_entry`. As tabelas saem em lotes
 * pela chave, de até 500 linhas e cerca de `BATCH_BYTES` por consulta.
 */

/** Linhas por consulta, no máximo (o lote menor serve aos testes da paginação). */
const BATCH = 500;
/** Primeiro lote de cada tabela: os seguintes se ajustam ao tamanho médio das linhas. */
const FIRST_BATCH = 50;
/** Texto por consulta, aproximado: o lote seguinte se ajusta para ficar perto disso. */
const BATCH_BYTES = 16 * 1024 * 1024;
/** Prefixo das entradas do .zip com o conteúdo dos anexos. */
export const ATTACHMENT_ENTRY_PREFIX = 'attachments/';
/** Pedaço do anexo empurrado de cada vez para o zip (o disco dita o ritmo). */
const BLOB_CHUNK = 1024 * 1024;

/** Carimbo do nome do arquivo, no fuso de São Paulo (AAAAMMDD-HHMM). */
export function backupStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`;
}

export async function schemaVersion(db: Executor): Promise<string | null> {
  const result = await db.execute<{ v: string | null }>(sql`SELECT app_schema_version() AS v`);
  return result.rows[0]?.v ?? null;
}

const columnList = (columns: string[]) =>
  sql.join(
    columns.map((c) => sql.identifier(c)),
    sql`, `,
  );

type FetchOptions = { ids?: string[]; withSecrets: boolean; after?: BackupRow; limit?: number; omit?: string[] };

/** Linhas de uma tabela (todas, ou só os ids pedidos), com os segredos quando `withSecrets`. */
async function fetchRows(tx: Tx, catalog: Catalog, table: string, actorId: string, options: FetchOptions): Promise<BackupRow[]> {
  return (await fetchRowsSized(tx, catalog, table, actorId, options)).rows;
}

/** As linhas e o tamanho do texto lido (para ajustar o lote seguinte). */
async function fetchRowsSized(
  tx: Tx,
  catalog: Catalog,
  table: string,
  actorId: string,
  options: FetchOptions,
): Promise<{ rows: BackupRow[]; bytes: number }> {
  const meta = catalog.get(table);
  if (!meta) return { rows: [], bytes: 0 };
  const keys = keyColumns(table);
  const where: SQL[] = [];
  if (ROW_FILTERS[table]) where.push(ROW_FILTERS[table]);
  if (options.ids) where.push(sql`id = ANY(${uuidArray(options.ids)})`);
  if (options.after) {
    // Paginação pela chave (id, ou a chave composta como tupla), cada parte no tipo da coluna (tarefa 173): o
    // `smallint` dos degraus compara como número, na ordem do ORDER BY. O tipo vem do pg_catalog.
    const after = options.after;
    const typeOf = (column: string) => meta.columns.find((c) => c.name === column)?.type ?? 'text';
    where.push(
      sql`(${columnList(keys)}) > (${sql.join(
        keys.map((k) => sql`${String(after[k])}::${sql.raw(typeOf(k))}`),
        sql`, `,
      )})`,
    );
  }
  const omit = new Set(options.omit ?? []);
  const columns = exportColumns(meta).filter((c) => !omit.has(c));
  const result = await tx.execute<{ j: string }>(sql`
    SELECT row_to_json(backup_row)::text AS j
      FROM (SELECT ${columnList(columns)} FROM ${sql.identifier(table)}
             ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
             ORDER BY ${columnList(keys)} ${options.limit ? sql`LIMIT ${options.limit}` : sql``}) backup_row`);
  let bytes = 0;
  const rows = result.rows.map((r) => {
    bytes += r.j.length;
    return JSON.parse(r.j) as BackupRow;
  });
  const secrets = options.withSecrets && rows.length > 0 ? (SECRET_READERS[table] ?? []) : [];
  for (const secret of secrets) {
    const values = await tx.execute<{ id: string; s: unknown }>(sql`
      SELECT id::text AS id, ${sql.raw(secret.fn)}(id, ${actorId}::uuid) AS s
        FROM ${sql.identifier(table)} WHERE id = ANY(${uuidArray(rows.map((r) => r.id as string))})`);
    const byId = new Map(values.rows.map((v) => [v.id, v.s]));
    for (const row of rows) row[secret.column] = byId.get(row.id as string) ?? null;
  }
  return { rows, bytes };
}

/**
 * Uma tabela inteira em lotes pela chave, com os segredos (JSON completo). O
 * lote tem no máximo `maxRows` linhas e se ajusta ao tamanho médio delas para
 * ficar perto de `BATCH_BYTES` (tarefa 077): uma tabela de documentos de 1 MB
 * não lê 500 de uma vez.
 */
export async function* tableBatches(
  tx: Tx,
  catalog: Catalog,
  table: string,
  actorId: string,
  options: { maxRows?: number; omit?: string[] } = {},
): AsyncGenerator<BackupRow[]> {
  const maxRows = options.maxRows ?? BATCH;
  let limit = Math.min(FIRST_BATCH, maxRows);
  let after: BackupRow | undefined;
  for (;;) {
    const { rows, bytes } = await fetchRowsSized(tx, catalog, table, actorId, { withSecrets: true, after, limit, omit: options.omit });
    if (rows.length > 0) yield rows;
    if (rows.length < limit) return;
    after = rows[rows.length - 1]!;
    limit = Math.max(1, Math.min(maxRows, Math.floor(BATCH_BYTES / Math.max(1, bytes / rows.length))));
  }
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
 * pedaços (tabela por tabela, em lotes), sem montar o JSON inteiro na memória;
 * depois, o conteúdo de cada anexo numa entrada própria (tarefa 077). O disco
 * dita o ritmo da leitura, e uma falha de escrita (disco cheio) interrompe a
 * leitura e volta como erro desta chamada, nunca como rejeição solta (tarefa
 * 113). Uma operação de backup por vez (tarefa 172).
 */
export async function exportFullZip(ctx: ServiceContext, path: string, options: { maxRows?: number } = {}): Promise<void> {
  ctx.access.assertAdmin();
  await withBackupLock(ctx.db, () => writeFullZip(ctx, path, options.maxRows));
}

async function writeFullZip(ctx: ServiceContext, path: string, maxRows: number | undefined): Promise<void> {
  const catalog = await loadCatalog(ctx.db);
  const actorId = ctx.access.actor.id;
  const out = createWriteStream(path, { mode: 0o600 });
  let writeError: Error | null = null;
  out.on('error', (error) => {
    writeError ??= error;
  });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  // Tratada aqui: o `await finished` lá embaixo continua rejeitando, mas uma falha no meio da leitura não vira
  // rejeição sem handler (que derrubaria o processo).
  finished.catch(() => {});
  const zip = new Zip((error, data, final) => {
    if (error) {
      writeError ??= error;
      out.destroy(error);
      return;
    }
    if (writeError) return;
    out.write(data);
    if (final) out.end();
  });
  /** Para a leitura assim que a escrita falhar, e espera o disco quando o buffer do arquivo enche. */
  const drain = async () => {
    if (writeError) throw writeError;
    if (out.writableNeedDrain) await once(out, 'drain');
    if (writeError) throw writeError;
  };
  const entry = new ZipDeflate('moneyflow.json', { level: 6 });
  zip.add(entry);
  const push = (text: string) => entry.push(strToU8(text), false);

  try {
    await readOnly(ctx, async (tx) => {
      const head = header(ctx, 'full', await schemaVersion(tx));
      push(`${JSON.stringify(head).slice(0, -1)},"tables":{`);
      const attachmentIds: string[] = [];
      let firstTable = true;
      for (const table of fullTables(catalog)) {
        push(`${firstTable ? '' : ','}${JSON.stringify(table)}:[`);
        firstTable = false;
        let firstRow = true;
        const blobs = table === 'attachments';
        for await (const rows of tableBatches(tx, catalog, table, actorId, { maxRows, omit: blobs ? ['content'] : [] })) {
          for (const row of rows) {
            if (blobs) {
              attachmentIds.push(row.id as string);
              row.content_entry = `${ATTACHMENT_ENTRY_PREFIX}${row.id}`;
            }
            push(`${firstRow ? '' : ','}${JSON.stringify(row)}`);
            firstRow = false;
          }
          await drain();
        }
        push(']');
      }
      push('}}');
      entry.push(new Uint8Array(0), true);
      await drain();

      // O conteúdo dos anexos, um por vez, no mesmo retrato.
      for (const id of attachmentIds) {
        const found = await tx.execute<{ content: Buffer }>(sql`SELECT content FROM attachments WHERE id = ${id}::uuid`);
        const content = found.rows[0]?.content;
        if (!content) continue;
        const file = new ZipPassThrough(`${ATTACHMENT_ENTRY_PREFIX}${id}`);
        zip.add(file);
        for (let at = 0; at < content.length; at += BLOB_CHUNK) {
          file.push(content.subarray(at, at + BLOB_CHUNK), at + BLOB_CHUNK >= content.length);
          await drain();
        }
      }
    });
    zip.end();
  } catch (error) {
    zip.terminate();
    out.destroy();
    throw error;
  }
  await finished;
  if (writeError) throw writeError;
}
