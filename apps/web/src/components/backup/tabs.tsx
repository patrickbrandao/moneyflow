import { type BackupResource, type BackupStatus, DUMP_RESTORE_CONFIRMATION, type DumpRestoreResult, t } from '@moneyflow/shared';
import { DatabaseBackup, Download, FileJson, History, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { downloadFile } from '../../lib/download';
import { useAction } from '../../lib/hooks';
import { upload } from '../../lib/upload';
import { Badge, Button, Field, Panel, useConfirm } from '../ui';
import { FilePicker, ImportBox } from './shared';

const b = t.backup;
/** Recursos cujo arquivo leva segredos (senha, chave de API, hash dos tokens). */
const WITH_SECRETS = new Set<BackupResource>(['users', 'ai-providers']);

/** Uma tela de recurso: exportar o JSON e importar com merge. */
export function ResourceTab({ resource }: { resource: BackupResource }) {
  const info = b.resources[resource]!;
  const { run, busy } = useAction();
  return (
    <div className="flex flex-col gap-4">
      <Panel title={b.exportTitle} icon={<Download />}>
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-dim">{info.exportHint}</p>
          {WITH_SECRETS.has(resource) && (
            <div className="alert warn">
              <ShieldAlert />
              <span>{b.secretWarning}</span>
            </div>
          )}
          <div className="flex justify-end">
            <Button
              disabled={busy}
              onClick={() => void run(() => downloadFile(`/api/backup/export/${resource}`, `moneyflow-${resource}.json`), b.exported)}
            >
              <FileJson /> {busy ? b.exporting : b.exportJson}
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title={b.importTitle} icon={<History />}>
        <ImportBox kind={resource} hint={info.importHint} />
      </Panel>
    </div>
  );
}

/** Backup: dump do PostgreSQL e JSON completo, os dois em .zip. */
export function BackupTab({ status }: { status: BackupStatus | undefined }) {
  const dump = useAction();
  const json = useAction();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title={b.backup.dumpTitle}
        icon={<DatabaseBackup />}
        actions={status?.pgDumpVersion && <Badge mono>{b.backup.pgDump(status.pgDumpVersion)}</Badge>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-dim">{b.backup.dumpHint}</p>
          <div className="alert warn">
            <ShieldAlert />
            <span>{b.secretWarning}</span>
          </div>
          {status && !status.dumpAvailable && <p className="notice danger">{status.dumpUnavailableReason ?? b.errors.dumpUnavailable}</p>}
          <div className="flex justify-end">
            <Button
              disabled={!status?.dumpAvailable || dump.busy}
              onClick={() => void dump.run(() => downloadFile('/api/backup/dump', 'moneyflow-dump.zip'), b.exported)}
            >
              <Download /> {dump.busy ? b.backup.dumpRunning : b.backup.dumpButton}
            </Button>
          </div>
        </div>
      </Panel>
      <Panel
        title={b.backup.jsonTitle}
        icon={<FileJson />}
        actions={status?.schemaVersion && <Badge mono>{b.backup.schema(status.schemaVersion)}</Badge>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-dim">{b.backup.jsonHint}</p>
          <p className="notice info">{b.backup.excluded}</p>
          <div className="alert warn">
            <ShieldAlert />
            <span>{b.secretWarning}</span>
          </div>
          <div className="flex justify-end">
            <Button
              disabled={json.busy}
              onClick={() => void json.run(() => downloadFile('/api/backup/full', 'moneyflow-completo.zip'), b.exported)}
            >
              <Download /> {json.busy ? b.backup.jsonRunning : b.backup.jsonButton}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** Restauração: dump do PostgreSQL (destrutiva) e importação do JSON completo com merge. */
export function RestoreTab({ status }: { status: BackupStatus | undefined }) {
  const [file, setFile] = useState<File | null>(null);
  const [typed, setTyped] = useState('');
  const { run, busy } = useAction();
  const confirm = useConfirm();

  async function restore() {
    if (!file || typed !== DUMP_RESTORE_CONFIRMATION) return;
    const ok = await confirm({
      title: b.restore.confirmTitle,
      description: b.restore.confirmBody,
      confirmLabel: b.restore.restoreButton,
      danger: true,
    });
    if (!ok) return;
    const result = await run(
      () =>
        upload<DumpRestoreResult>('/api/backup/restore-dump', new File([file], file.name, { type: 'application/zip' }), {
          confirm: DUMP_RESTORE_CONFIRMATION,
        }),
      b.restore.restored,
    );
    if (result) {
      // As sessões agora são as do backup: volta para o login.
      setTimeout(() => window.location.assign('/'), 1500);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={b.restore.dumpTitle} icon={<DatabaseBackup />}>
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-dim">{b.restore.dumpHint}</p>
          <p className="notice danger">{b.restore.dumpWarning}</p>
          {status && !status.dumpAvailable && <p className="notice danger">{status.dumpUnavailableReason ?? b.errors.dumpUnavailable}</p>}
          <FilePicker file={file} accept=".zip,.dump,application/zip" label={b.chooseDump} onPick={setFile} />
          <Field label={b.restore.typeToConfirm(DUMP_RESTORE_CONFIRMATION)}>
            <input
              className="field mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={DUMP_RESTORE_CONFIRMATION}
              autoComplete="off"
              spellCheck={false}
              disabled={!status?.dumpAvailable}
            />
          </Field>
          <div className="flex justify-end">
            <Button
              variant="danger"
              disabled={!status?.dumpAvailable || !file || typed !== DUMP_RESTORE_CONFIRMATION || busy}
              onClick={() => void restore()}
            >
              <DatabaseBackup /> {busy ? b.restore.restoring : b.restore.restoreButton}
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title={b.restore.jsonTitle} icon={<FileJson />}>
        <ImportBox kind="full" hint={b.restore.jsonHint} />
      </Panel>
    </div>
  );
}
