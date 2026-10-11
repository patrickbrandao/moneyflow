import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_RESOURCES, type BackupKind, type BackupResource, DUMP_RESTORE_CONFIRMATION, isBackupKind, t } from '@moneyflow/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError, notFound, unprocessable } from '../errors';
import type { Req } from '../http';
import { backupStatus, createDumpZip, restoreDump } from '../services/backup/dump';
import { exportFullZip, exportResource } from '../services/backup/export';
import { importBackup, parseBackupUpload } from '../services/backup/import';
import { contentDisposition } from './attachments';

/** Carimbo do nome do arquivo, no fuso de São Paulo (AAAAMMDD-HHMM). */
function stamp() {
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

/** Gera um arquivo temporário com `produce` e o devolve como download, apagando-o no fim. */
async function sendTempFile(reply: FastifyReply, fileName: string, produce: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'moneyflow-backup-'));
  const path = join(dir, fileName);
  try {
    await produce(path);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const stream = createReadStream(path);
  stream.on('close', () => void rm(dir, { recursive: true, force: true }));
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', contentDisposition(fileName))
    .header('cache-control', 'no-store')
    .send(stream);
}

/**
 * Backup e restauração (spec 019, só admin). Os uploads chegam crus (.json ou
 * .zip) com um limite próprio, maior que o dos anexos: este plugin tem os seus
 * parsers de corpo.
 */
export async function backupRoutes(app: FastifyInstance) {
  const limit = app.config.backupMaxUploadBytes;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: limit }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (request) => {
    request.ctx.access.assertAdmin();
  });
  app.setErrorHandler((error, _request, reply) => {
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({ error: { code: 'too_large', message: t.backup.errors.tooLarge } });
    }
    throw error;
  });

  app.get('/api/backup/status', (request) => backupStatus(request.ctx));

  app.get('/api/backup/export/:resource', async (request: Req, reply) => {
    const resource = request.params.resource as BackupResource;
    if (!(BACKUP_RESOURCES as readonly string[]).includes(resource)) throw notFound();
    const file = await exportResource(request.ctx, resource);
    request.log.info({ resource, by: request.ctx.access.actor.username }, 'backup: exportação de recurso');
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', contentDisposition(`moneyflow-${resource}-${stamp()}.json`))
      .header('cache-control', 'no-store')
      .send(JSON.stringify(file, null, 2));
  });

  app.get('/api/backup/full', async (request: Req, reply) => {
    request.log.info({ by: request.ctx.access.actor.username }, 'backup: exportação completa');
    return sendTempFile(reply, `moneyflow-completo-${stamp()}.zip`, (path) => exportFullZip(request.ctx, path));
  });

  app.get('/api/backup/dump', async (request: Req, reply) => {
    request.log.info({ by: request.ctx.access.actor.username }, 'backup: dump do banco');
    return sendTempFile(reply, `moneyflow-dump-${stamp()}.zip`, (path) => createDumpZip(request.ctx, path, request.log));
  });

  app.post('/api/backup/import/:kind', async (request: Req) => {
    const kind = request.params.kind as BackupKind;
    if (!isBackupKind(kind)) throw notFound();
    const dryRun = request.query.dryRun === '1' || request.query.dryRun === 'true';
    const file = parseBackupUpload(request.body);
    const report = await importBackup(request.ctx, file, kind, dryRun);
    request.log.info(
      { kind, dryRun, by: request.ctx.access.actor.username, issues: report.issueCount },
      dryRun ? 'backup: simulação de importação' : 'backup: importação',
    );
    return report;
  });

  app.post('/api/backup/restore-dump', async (request: Req) => {
    if (request.query.confirm !== DUMP_RESTORE_CONFIRMATION) throw unprocessable(t.backup.errors.confirmation, 'confirmation');
    if (!Buffer.isBuffer(request.body)) throw new AppError(400, 'bad_request', t.backup.errors.invalidDump);
    request.log.warn({ by: request.ctx.access.actor.username }, 'backup: restauração do dump');
    return restoreDump(request.ctx, request.body, request.log);
  });
}
