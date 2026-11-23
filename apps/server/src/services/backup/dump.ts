import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pg } from '@moneyflow/db';
import { type BackupStatus, type DumpRestoreResult, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { strFromU8, strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { Config } from '../../config';
import type { ServiceContext } from '../../context';
import { AppError, unprocessable } from '../../errors';
import { resetCatalog } from './catalog';
import { schemaVersion } from './export';
import { withBackupLock } from './lock';
import { backupUnzipLimit, UnzipTooLarge, unzipLimited } from './unzip';

/*
 * Dump e restauração do PostgreSQL (spec 019). Rodam com a conexão do DONO do
 * banco (DATABASE_OWNER_URL), nunca com moneyflow_app: o dump precisa ler os
 * segredos e a restauração recria o schema. As credenciais vão por variáveis
 * de ambiente do processo filho (PGPASSWORD…), nunca na linha de comando.
 *
 * A restauração (tarefa 054) gera o SQL com `pg_restore --clean --if-exists
 * --no-owner` a partir de uma lista SEM as extensões (o dono não é superusuário
 * e não apaga nem recria a `vector`; elas já existem no banco) e o roda num
 * `psql --single-transaction` que chama antes `restore_reset_default_privileges()`:
 * as tabelas recriadas recebem só os GRANTs do dump (sem isso, os privilégios
 * padrão da 0001 davam ao moneyflow_app a tabela inteira, inclusive
 * users.password), e os privilégios padrão voltam pelas entradas DEFAULT ACL do
 * próprio dump. Tudo numa transação: se algo falhar, nada muda. Funciona também
 * com um superusuário na DATABASE_OWNER_URL (só um aviso no log). Exige a mesma
 * versão de schema (o dump recria exatamente os objetos que existem hoje).
 */

export const DUMP_FILE = 'moneyflow.dump';
const MANIFEST_FILE = 'manifest.json';
const DUMP_FORMAT = 'moneyflow-dump';

type Run = { code: number; stdout: string; stderr: string };
/** Logger da requisição (só o stderr dos utilitários vai para o log; nunca credenciais). */
export type BackupLog = { error: (obj: object, msg: string) => void; warn?: (obj: object, msg: string) => void };

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

/**
 * `producer | consumer`: a saída de um processo vai para a entrada do outro. Devolve os dois resultados
 * (só o stderr de cada um; o stdout do consumidor é descartado). Um consumidor que sai antes (erro do
 * psql) fecha o pipe e o produtor termina com EPIPE — o código dele não é 0, e o erro real fica no
 * stderr do consumidor.
 */
function pipeRun(
  producer: { command: string; args: string[] },
  consumer: { command: string; args: string[] },
  env: NodeJS.ProcessEnv,
  through?: Transform,
): Promise<{ producer: Run; consumer: Run }> {
  return new Promise((resolve, reject) => {
    const from = spawn(producer.command, producer.args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const to = spawn(consumer.command, consumer.args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
    const results: { producer?: Run; consumer?: Run } = {};
    const errs = { producer: '', consumer: '' };
    const collect = (which: 'producer' | 'consumer') => (chunk: Buffer) => {
      if (errs[which].length < 64 * 1024) errs[which] += chunk.toString('utf8');
    };
    from.stderr.on('data', collect('producer'));
    to.stderr.on('data', collect('consumer'));
    // EPIPE quando o psql para antes: o erro que importa é o dele.
    to.stdin.on('error', () => {});
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      from.kill();
      to.kill();
      reject(error);
    };
    from.on('error', fail);
    to.on('error', fail);
    if (through) {
      through.on('error', fail);
      from.stdout.pipe(through).pipe(to.stdin);
    } else {
      from.stdout.pipe(to.stdin);
    }
    const done = () => {
      if (!failed && results.producer && results.consumer) resolve(results as { producer: Run; consumer: Run });
    };
    from.on('close', (code) => {
      results.producer = { code: code ?? 1, stdout: '', stderr: errs.producer };
      done();
    });
    to.on('close', (code) => {
      results.consumer = { code: code ?? 1, stdout: '', stderr: errs.consumer };
      // Com a passagem no meio, o produtor não vê o pipe fechar: sem ler a saída dele, ficaria bloqueado na escrita.
      // Fechar a ponta de leitura dá a ele o EPIPE, como no pipe direto.
      if (through && !results.producer) {
        from.stdout.unpipe();
        from.stdout.destroy();
      }
      done();
    });
  });
}

const LOCK_TIMEOUT_OFF = Buffer.from('\nSET lock_timeout = 0;\n');
/** Até onde procurar o SET no começo do SQL (o cabeçalho tem poucas centenas de bytes). */
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * O prazo da espera por lock na restauração (tarefa 102). O SQL que o `pg_restore -f -` gera começa com
 * `SET lock_timeout = 0;`, que vence o `PGOPTIONS`: esta passagem troca essa linha do cabeçalho por
 * `SET lock_timeout = '<ms>ms';`. Uma restauração que espera um lock (uma transação longa da API ou do
 * worker) falha no prazo, com a transação desfeita, em vez de enfileirar atrás dela as consultas da
 * aplicação. O resto do SQL passa sem mudança; sem a linha no começo, passa inteiro (o `PGOPTIONS` vale).
 */
export function restoreLockTimeout(ms: number): Transform {
  const replacement = Buffer.from(`\nSET lock_timeout = '${Math.max(1, Math.round(ms))}ms';\n`);
  let head: Buffer | null = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!head) return done(null, chunk);
      head = Buffer.concat([head, chunk]);
      const at = head.indexOf(LOCK_TIMEOUT_OFF);
      if (at >= 0) {
        const out = Buffer.concat([head.subarray(0, at), replacement, head.subarray(at + LOCK_TIMEOUT_OFF.length)]);
        head = null;
        return done(null, out);
      }
      if (head.length > HEADER_SCAN_BYTES) {
        const out = head;
        head = null;
        return done(null, out);
      }
      done();
    },
    flush(done) {
      const out = head;
      head = null;
      done(null, out && out.length > 0 ? out : undefined);
    },
  });
}

/** Entradas da lista do pg_restore que tocam as extensões (o dono não as apaga nem recria). */
const EXTENSION_ENTRY = /^\d+; \d+ \d+ (EXTENSION|COMMENT - EXTENSION) /;

/** A lista do dump (`pg_restore -l`) sem as extensões, para o `-L` da restauração. */
async function restoreList(config: Config, dumpPath: string): Promise<string> {
  const out = await run(pgBin(config, 'pg_restore'), ['--list', dumpPath], { PATH: process.env.PATH }, { stdoutLimit: 16 * 1024 * 1024 });
  if (out.code !== 0) throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  return out.stdout
    .split('\n')
    .filter((line) => !EXTENSION_ENTRY.test(line))
    .join('\n');
}

/** A conexão do dono é superusuário? (Só para o aviso: a restauração funciona do mesmo jeito.) */
async function ownerIsSuperuser(url: string): Promise<boolean | null> {
  const client = new pg.Client({ connectionString: url, application_name: 'moneyflow-backup' });
  try {
    await client.connect();
    const result = await client.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    return result.rows[0]?.rolsuper ?? null;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
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
    else {
      // A restauração roda o SQL do pg_restore no psql (tarefa 054).
      const psql = await run(pgBin(config, 'psql'), ['--version'], { PATH: process.env.PATH }).catch(() => null);
      result = psql?.code === 0 ? { version, error: null } : { version, error: t.backup.errors.noPsql };
    }
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

async function assertAvailable(config: Config) {
  const availability = await dumpAvailability(config);
  if (availability.error) throw unprocessable(`${t.backup.errors.dumpUnavailable} (${availability.error})`, 'dump_unavailable');
  return availability.version!;
}

/** Gera o dump (formato custom do pg_dump) e o grava em `zipPath` com um manifest. */
export async function createDumpZip(ctx: ServiceContext, zipPath: string, log: BackupLog): Promise<void> {
  ctx.access.assertAdmin();
  // A trava antes de tudo (tarefa 172): com outra operação em andamento, 409 na hora.
  await withBackupLock(ctx.db, async () => {
    const version = await assertAvailable(ctx.config);
    const dir = await mkdtemp(join(tmpdir(), 'moneyflow-dump-'));
    try {
      const dumpPath = join(dir, DUMP_FILE);
      const out = await run(
        pgBin(ctx.config, 'pg_dump'),
        [
          '--format=custom',
          '--compress=6',
          // Requisições ao provedor (spec 023): só a estrutura; os dados trazem conversas e dados financeiros.
          '--exclude-table-data=public.ai_requests',
          '--exclude-table-data=public.ai_request_attempts',
          '--file',
          dumpPath,
        ],
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
export function extractDump(
  body: unknown,
  maxUnzippedBytes: number,
): { dump: Uint8Array; manifest: { schemaVersion?: string | null; exportedAt?: string } | null } {
  if (!Buffer.isBuffer(body) || body.length < 5) throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  if (body.subarray(0, 5).toString('latin1') === 'PGDMP') return { dump: body, manifest: null };
  if (body[0] !== 0x50 || body[1] !== 0x4b) throw unprocessable(t.backup.errors.invalidDump, 'invalid_dump');
  let entries: Record<string, Uint8Array>;
  // Só a primeira entrada de cada nome conta para o resultado, mas todas as aceitas somam no teto (tarefa 055).
  try {
    entries = unzipLimited(body, (name) => name.endsWith(DUMP_FILE) || name.endsWith(MANIFEST_FILE), maxUnzippedBytes);
  } catch (error) {
    if (error instanceof UnzipTooLarge) throw error;
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
  const started = Date.now();
  // A trava antes de tudo (tarefa 172): com uma importação ou exportação em andamento, 409 na hora.
  return withBackupLock(ctx.db, async () => {
    await assertAvailable(ctx.config);
    const { dump, manifest } = extractDump(body, backupUnzipLimit(ctx.config));
    const dir = await mkdtemp(join(tmpdir(), 'moneyflow-restore-'));
    try {
      const dumpPath = join(dir, DUMP_FILE);
      await writeFile(dumpPath, dump, { mode: 0o600 });
      const current = await schemaVersion(ctx.db);
      const fromDump = await dumpSchemaVersion(ctx.config, dumpPath);
      if ((fromDump ?? '') !== (current ?? '')) {
        throw unprocessable(t.backup.errors.schemaMismatch(fromDump ?? '?', current ?? '?'), 'schema_mismatch');
      }
      const ownerUrl = ctx.config.ownerDatabaseUrl!;
      if ((await ownerIsSuperuser(ownerUrl)) === true) {
        (log.warn ?? log.error)(
          {},
          'restauração: a DATABASE_OWNER_URL é superusuário do Postgres; use um papel dono sem SUPERUSER (moneyflow_owner, docs/016)',
        );
      }
      const listPath = join(dir, 'restore.list');
      await writeFile(listPath, await restoreList(ctx.config, dumpPath), { mode: 0o600 });
      // A espera por lock com o prazo do pool (DB_LOCK_TIMEOUT_MS): o PGOPTIONS vale para o começo da sessão do psql,
      // e o SET do cabeçalho do SQL, que o zeraria, é trocado no caminho (restoreLockTimeout).
      const lockMs = ctx.config.dbTimeouts.lockTimeoutMs;
      const env: NodeJS.ProcessEnv = { ...pgEnv(ownerUrl), PGOPTIONS: `-c lock_timeout=${lockMs}ms` };
      // pg_restore só gera o SQL (sem conexão); o psql o roda numa transação, zerando antes os privilégios padrão.
      const out = await pipeRun(
        { command: pgBin(ctx.config, 'pg_restore'), args: ['--clean', '--if-exists', '--no-owner', '-L', listPath, '-f', '-', dumpPath] },
        {
          command: pgBin(ctx.config, 'psql'),
          args: ['-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT restore_reset_default_privileges()', '-f', '-'],
        },
        env,
        restoreLockTimeout(lockMs),
      );
      if (out.producer.code !== 0 || out.consumer.code !== 0) {
        const stderr = [out.consumer.stderr, out.producer.stderr].filter(Boolean).join('\n');
        const detail = stderr
          .split('\n')
          .filter((line) => /error|erro/i.test(line))
          .slice(0, 3)
          .join(' ')
          .slice(0, 500);
        log.error({ psql: out.consumer.code, pgRestore: out.producer.code, stderr: stderr.slice(0, 4000) }, 'restauração do dump falhou');
        throw unprocessable(t.backup.errors.restoreFailed(detail || stderr.slice(0, 300)), 'restore_failed');
      }
      resetCatalog();
      // O dump não traz as requisições: o uso que apontava para elas fica sem o vínculo (FK NOT VALID, spec 023).
      await ctx.db
        .execute(sql`SELECT ai_usage_unlink_missing_requests()`)
        .catch((error) => log.error({ err: error }, 'restauração: falha ao anular os vínculos de requisições'));
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
