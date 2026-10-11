import { type BackupKind, type ImportReport, t } from '@moneyflow/shared';
import { FileUp, FlaskConical, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAction } from '../../lib/hooks';
import { upload } from '../../lib/upload';
import { Button, cx, useConfirm } from '../ui';
import { ImportReportView } from './ImportReportView';

const b = t.backup;

/** Área de escolher arquivo (clique ou arrastar). */
export function FilePicker({
  file,
  onPick,
  accept,
  label,
}: {
  file: File | null;
  onPick: (file: File) => void;
  accept: string;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx('rec-drop', over && 'is-over')}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') input.current?.click();
      }}
      role="button"
      tabIndex={0}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const chosen = e.dataTransfer.files?.[0];
        if (chosen) onPick(chosen);
      }}
    >
      <FileUp />
      <span>{file ? <strong>{file.name}</strong> : label}</span>
      {file && <span className="hint">{(file.size / 1024 / 1024).toFixed(2)} MB</span>}
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={accept}
        aria-label={label}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) onPick(chosen);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** Importação com merge: escolher o arquivo, simular (nada é gravado) ou importar, e ver o relatório. */
export function ImportBox({ kind, hint, onImported }: { kind: BackupKind; hint: string; onImported?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [mode, setMode] = useState<'simulate' | 'import' | null>(null);
  const { run, busy } = useAction();
  const confirm = useConfirm();

  async function go(dryRun: boolean) {
    if (!file) return;
    if (!dryRun && !(await confirm({ title: b.confirmImport, description: b.confirmImportHint, confirmLabel: b.import }))) return;
    setMode(dryRun ? 'simulate' : 'import');
    const result = await run(
      () =>
        upload<ImportReport>(`/api/backup/import/${kind}`, new File([file], file.name, { type: file.type || 'application/octet-stream' }), {
          dryRun: dryRun ? 1 : undefined,
        }),
      dryRun ? b.simulationDone : b.importDone,
    );
    setMode(null);
    if (result) {
      setReport(result);
      if (!dryRun) onImported?.();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-dim">{hint}</p>
      <p className="notice info">{b.mergeRule}</p>
      <FilePicker
        file={file}
        accept=".json,.zip,application/json,application/zip"
        label={b.chooseFile}
        onPick={(chosen) => {
          setFile(chosen);
          setReport(null);
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={!file || busy} onClick={() => void go(true)}>
          <FlaskConical /> {mode === 'simulate' ? b.simulating : b.simulate}
        </Button>
        <Button disabled={!file || busy} onClick={() => void go(false)}>
          <Upload /> {mode === 'import' ? b.importing : b.import}
        </Button>
      </div>
      {report && <ImportReportView report={report} />}
    </div>
  );
}
