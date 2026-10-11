import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BackupStatus, type DumpRestoreResult, t } from '@moneyflow/shared';
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { Config } from '../../config';
import type { ServiceContext } from '../../context';
import { AppError, unprocessable } from '../../errors';
import { resetCatalog } from './catalog';
import { schemaVersion } from './export';

/*
 * Dump e restauração do PostgreSQL (spec 019). Rodam com a conexão do DONO do
 * banco (DATABASE_OWNER_URL), nunca com moneyflow_app: o dump precisa ler os
 * segredos e a restauração recria o schema. As credenciais vão por variáveis
 * de ambiente do processo filho (PGPASSWORD…), nunca na linha de comando.
 *
 * A restauração usa `pg_restore --clean --if-exists --single-transaction`:
 * apaga e recria todos os objetos do dump numa transação só — se algo falhar,
 * nada muda. Exige a mesma versão de schema (o dump recria exatamente os
 * objetos que existem hoje).
 */

export const DUMP_FILE = 'moneyflow.dump';
const MANIFEST_FILE = 'manifest.json';
const DUMP_FORMAT = 'moneyflow-dump';

type Run = { code: number; stdout: string; stderr: string };
/** Logger da requisição (só o stderr dos utilitários vai para o log; nunca credenciais). */
export type BackupLog = { error: (obj: object, msg: string) => void };

function pgBin(config: Config, name: string) {
  return config.pgBinDir ? join(config.pgBinDir, name) : name;
}

/** Variáveis libpq a partir da URL do dono (a senha não vai para a linha de comando). */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    PGAPPNAME: 'moneyflow-backup',
    PGCONNECT_TIMEOUT: '10',
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, options: { stdoutLimit?: number } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const limit = options.stdoutLimit ?? 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

let pgDumpVersion: { checked: number; version: string | null; error: string | null } | null = null;

/** Disponibilidade do dump: conexão do dono configurada e pg_dump 18+. */
export async function dumpAvailability(config: Config): Promise<{ version: string | null; error: string | null }> {
  if (!config.ownerDatabaseUrl) return { version: null, error: t.backup.errors.noOwnerUrl };
  if (pgDumpVersion && Date.now() - pgDumpVersion.checked < 60_000) return pgDumpVersion;
  let result: { version: string | null; error: string | null };
  try {
    const out = await run(pgBin(config, 'pg_dump'), ['--version'], { PATH: process.env.PATH });
    const version = /(\d+)(?:\.(\d+))?/.exec(out.stdout)?.[0] ?? null;
    if (out.code !== 0 || !version) result = { version: null, error: t.backup.errors.noPgDump };
    else if (Number(version.split('.')[0]) < 18) result = { version, error: t.backup.errors.oldPgDump(version) };
    else result = { version, error: null };
  } catch {
    result = { version: null, error: t.backup.errors.noPgDump };
  }
  pgDumpVersion = { checked: Date.now(), ...result };
  return result;
}

export async function backupStatus(ctx: ServiceContext): Promise<BackupStatus> {
  ctx.access.assertAdmin();
  const availability = await dumpAvailability(ctx.config);
  return {
    schemaVersion: await schemaVersion(ctx.db),
    dumpAvailable: availability.error === null,
    dumpUnavailableReason: availability.error,
    pgDumpVersion: availability.version,
    maxUploadBytes: ctx.config.backupMaxUploadBytes,
  };
}

let busy = false;

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new AppError(409, 'backup_busy', t.backup.errors.busy);
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

async function assertAvailable(config: Config) {
  const availability = await dumpAvailability(config);
  if (availability.error) throw unprocessable(`${t.backup.errors.dumpUnavailable} (${availability.error})`, 'dump_unavailable');
  return availability.version!;
}

/** Gera o dump (formato custom do pg_dump) e o grava em `zipPath` com um manifest. */
export async function createDumpZip(ctx: ServiceContext, zipPath: string, log: BackupLog): Promise<void> {
  ctx.access.assertAdmin();
  const version = await assertAvailable(ctx.config);
  await exclusive(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moneyflow-dump-'));
    try {
      const dumpPath = join(dir, DUMP_FILE);
      const out = await run(
        pgBin(ctx.config, 'pg_dump'),
        ['--format=custom', '--compress=6', '--file', dumpPath],
        pgEnv(ctx.config.ownerDatabaseUrl!),
      );
      if (out.code !== 0) {
        log.error({ stderr: out.stderr.slice(0, 2000) }, 'pg_dump falhou');
        throw new AppError(500, 'dump_failed', t.backup.errors.dumpFailed);
      }
      const manifest = {
        format: DUMP_FORMAT,
        version: 1,
        schemaVersion: await schemaVersion(ctx.db),
        exportedAt: new Date().toISOString(),
        exportedBy: ctx.access.actor.username,
        pgDumpVersion: version,
      };
      await writeZip(zipPath, manifest, dumpPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** .zip com o manifest e o dump (já comprimido pelo pg_dump: entra sem recompressão), aos pedaços. */
function writeZip(zipPath: string, manifest: object, dumpPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath, { mode: 0o600 });
    const input = createReadStream(dumpPath);
    out.on('finish', resolve);
    out.on('error', reject);
    input.on('error', reject);
    const zip = new Zip((error, data, final) => {
      if (error) return out.destroy(error);
      // Contrapressão: o disco dita o ritmo da leitura do dump.
      if (!out.write(data)) {
        input.pause();
        out.once('drain', () => input.resume());
      }
      if (final) out.end();
    });
    const head = new ZipDeflate(MANIFEST_FILE, { level: 6 });
    zip.add(head);
    head.push(strToU8(JSON.stringify(manifest, null, 2)), true);
    const body = new ZipPassThrough(DUMP_FILE);
    zip.add(body);
    input.on('data', (chunk) => body.push(new Uint8Array(chunk as Buffer), false));
    input.on('end', () => {
      body.push(new Uint8Array(0), true);
      zip.end();
    });
  });
}

/** Extrai o dump do upload: o .zip do "Gerar dump" ou o arquivo custom do pg_dump direto. */
function extractDump(body: unknown): { dump: Uint8Array; manifest: { schemaVersion?: string | null; exportedAt?: string } | null } {
  if (!Buffer.isBuffer(body) || body.length < 5) throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  if (body.subarray(0, 5).toString('latin1') === 'PGDMP') return { dump: body, manifest: null };
  if (body[0] !== 0x50 || body[1] !== 0x4b) throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(body.buffer, body.byteOffset, body.length), {
      filter: (file) => file.name.endsWith(DUMP_FILE) || file.name.endsWith(MANIFEST_FILE),
    });
  } catch {
    throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  }
  const dumpName = Object.keys(entries).find((n) => n.endsWith(DUMP_FILE));
  const dump = dumpName ? entries[dumpName]! : null;
  if (!dump || strFromU8(dump.subarray(0, 5)) !== 'PGDMP') throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  const manifestName = Object.keys(entries).find((n) => n.endsWith(MANIFEST_FILE));
  let manifest = null;
  try {
    manifest = manifestName ? JSON.parse(strFromU8(entries[manifestName]!)) : null;
  } catch {
    manifest = null;
  }
  return { dump, manifest };
}

/** Versão do schema gravada no dump (dados de schema_migrations), sem restaurar nada. */
async function dumpSchemaVersion(config: Config, dumpPath: string): Promise<string | null> {
  const out = await run(
    pgBin(config, 'pg_restore'),
    ['--data-only', '--table=schema_migrations', '--file=-', dumpPath],
    { PATH: process.env.PATH },
    {
      stdoutLimit: 256 * 1024,
    },
  );
  if (out.code !== 0) throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  const lines = out.stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith('COPY ') && line.includes('schema_migrations'));
  if (start === -1) return null;
  const versions: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === '\\.') break;
    if (line.trim()) versions.push(line.split('\t')[0]!.trim());
  }
  return versions.sort().at(-1) ?? null;
}

/** Restaura o banco inteiro a partir do dump (destrói o conteúdo atual). */
export async function restoreDump(ctx: ServiceContext, body: unknown, log: BackupLog): Promise<DumpRestoreResult> {
  ctx.access.assertAdmin();
  await assertAvailable(ctx.config);
  const started = Date.now();
  const { dump, manifest } = extractDump(body);
  return exclusive(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moneyflow-restore-'));
    try {
      const dumpPath = join(dir, DUMP_FILE);
      await writeFile(dumpPath, dump, { mode: 0o600 });
      const current = await schemaVersion(ctx.db);
      const fromDump = await dumpSchemaVersion(ctx.config, dumpPath);
      if ((fromDump ?? '') !== (current ?? '')) {
        throw unprocessable(t.backup.errors.schemaMismatch(fromDump ?? '?', current ?? '?'), 'schema_mismatch');
      }
      const env: NodeJS.ProcessEnv = { ...pgEnv(ctx.config.ownerDatabaseUrl!), PGOPTIONS: '-c lock_timeout=30s' };
      const out = await run(
        pgBin(ctx.config, 'pg_restore'),
        ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', `--dbname=${env.PGDATABASE}`, dumpPath],
        env,
      );
      if (out.code !== 0) {
        const detail = out.stderr
          .split('\n')
          .filter((line) => /error|erro/i.test(line))
          .slice(0, 3)
          .join(' ')
          .slice(0, 500);
        log.error({ stderr: out.stderr.slice(0, 4000) }, 'pg_restore falhou');
        throw unprocessable(t.backup.errors.restoreFailed(detail || out.stderr.slice(0, 300)), 'restore_failed');
      }
      resetCatalog();
      return {
        restored: true as const,
        schemaVersion: fromDump,
        exportedAt: typeof manifest?.exportedAt === 'string' ? manifest.exportedAt : null,
        durationMs: Date.now() - started,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
