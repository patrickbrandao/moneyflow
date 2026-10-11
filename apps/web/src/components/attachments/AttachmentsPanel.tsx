import { type AttachmentRow, type AttachmentTarget, formatDateTime, t } from '@moneyflow/shared';
import { Download, ExternalLink, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { type DragEvent, type MutableRefObject, useEffect, useRef, useState } from 'react';
import '../../styles/attachments.css';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { attachmentUrl, upload } from '../../lib/upload';
import { useToast } from '../Toast';
import { Button, cx, Modal, Skel, useConfirm } from '../ui';

/** Limite do servidor (20 MB); avisado antes de enviar. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

/**
 * Anexos de um registro (título, baixa, movimento, compra do cartão,
 * entidade): lista, abrir/baixar, remover e enviar por botão ou arrastando.
 * `compact` é a forma de uma linha (nomes como links + "Anexar").
 * `pickerRef` deixa quem usa abrir o seletor de arquivo (comando da paleta).
 */
export function AttachmentsPanel({
  target,
  targetId,
  canWrite,
  compact,
  onCountChange,
  pickerRef,
}: {
  target: AttachmentTarget;
  targetId: string;
  canWrite: boolean;
  compact?: boolean;
  onCountChange?: (count: number) => void;
  pickerRef?: MutableRefObject<(() => void) | null>;
}) {
  const { data, error, reload } = useApi<AttachmentRow[]>(`/api/attachments?target=${target}&targetId=${targetId}`);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const { run } = useAction();

  const count = data?.length;
  const onCount = useRef(onCountChange);
  onCount.current = onCountChange;
  useEffect(() => {
    if (count !== undefined) onCount.current?.(count);
  }, [count]);

  useEffect(() => {
    if (!pickerRef) return;
    pickerRef.current = () => input.current?.click();
    return () => {
      pickerRef.current = null;
    };
  }, [pickerRef]);

  async function send(files: FileList | File[]) {
    const list = Array.from(files);
    const ok = list.filter((file) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(t.attachments.tooLarge(file.name));
        return false;
      }
      return true;
    });
    if (ok.length === 0) return;
    setUploading(true);
    let sent = 0;
    for (const file of ok) {
      const row = await run(() => upload<AttachmentRow>('/api/attachments', file, { target, targetId }));
      if (row) sent += 1;
    }
    setUploading(false);
    if (sent > 0) {
      toast.success(t.attachments.uploaded(sent));
      void reload();
    }
  }

  async function remove(row: AttachmentRow) {
    const yes = await confirm({
      title: t.attachments.removeConfirm(row.fileName),
      description: t.attachments.removeHint,
      confirmLabel: t.common.remove,
      danger: true,
    });
    if (!yes) return;
    if (await run(() => api.del(`/api/attachments/${row.id}`, { target, targetId }), t.attachments.removed)) void reload();
  }

  const dropProps = canWrite
    ? {
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          void send(event.dataTransfer.files);
        },
      }
    : {};

  const fileInput = (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      aria-label={t.attachments.attach}
      onChange={(event) => {
        if (event.target.files?.length) void send(event.target.files);
        event.target.value = '';
      }}
    />
  );

  if (compact) {
    return (
      <div className={cx('att-compact att-panel', dragging && 'dragging')} {...dropProps}>
        {fileInput}
        {data?.map((row) => (
          <span key={row.id} className="inline-flex items-center gap-1">
            <a
              href={attachmentUrl(row.id, true)}
              target="_blank"
              rel="noreferrer"
              title={`${row.fileName} · ${formatBytes(row.sizeBytes)}`}
            >
              <Paperclip />
              <span>{row.fileName}</span>
            </a>
            {canWrite && (
              <button type="button" className="row-action danger" title={t.attachments.remove} onClick={() => void remove(row)}>
                <Trash2 />
              </button>
            )}
          </span>
        ))}
        {canWrite && (
          <button type="button" className="att-add" onClick={() => input.current?.click()} disabled={uploading}>
            <Paperclip /> {uploading ? t.attachments.uploading : t.attachments.attachShort}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={cx('att-panel', dragging && 'dragging')} {...dropProps}>
      {fileInput}
      {error && <p className="notice danger">{error.message}</p>}
      {!data && !error && <Skel h={36} />}
      {data && data.length === 0 && <p className="text-[13px] text-faint">{t.attachments.empty}</p>}
      {data && data.length > 0 && (
        <div className="item-list">
          {data.map((row) => (
            <div key={row.id} className="item att-row">
              <FileText className="att-icon" />
              <div className="min-w-0 grow">
                <a className="att-name link block" href={attachmentUrl(row.id, true)} target="_blank" rel="noreferrer" title={row.fileName}>
                  {row.fileName}
                </a>
                <div className="att-meta">
                  {formatBytes(row.sizeBytes)} · {formatDateTime(row.createdAt)}
                  {row.uploadedBy ? ` · ${t.attachments.by(row.uploadedBy)}` : ''}
                </div>
              </div>
              <span className="row-actions">
                <a className="row-action" href={attachmentUrl(row.id, true)} target="_blank" rel="noreferrer" title={t.attachments.open}>
                  <ExternalLink />
                </a>
                <a className="row-action" href={attachmentUrl(row.id)} download={row.fileName} title={t.attachments.download}>
                  <Download />
                </a>
                {canWrite && (
                  <button type="button" className="row-action danger" title={t.attachments.remove} onClick={() => void remove(row)}>
                    <Trash2 />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {canWrite && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="ghost" onClick={() => input.current?.click()} disabled={uploading}>
            <Upload /> {uploading ? t.attachments.uploading : t.attachments.attach}
          </Button>
          <span className="text-[12px] text-faint">{t.attachments.dropHint}</span>
        </div>
      )}
      {dragging && <div className="att-drop">{t.attachments.dropHere}</div>}
    </div>
  );
}

/** O painel de anexos numa janela (movimentos do extrato, compras). */
export function AttachmentsModal({
  target,
  targetId,
  canWrite,
  title,
  onClose,
}: {
  target: AttachmentTarget;
  targetId: string;
  canWrite: boolean;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Modal open title={title ?? t.attachments.title} onClose={onClose} wide>
      <div className="modal-body">
        <AttachmentsPanel target={target} targetId={targetId} canWrite={canWrite} />
      </div>
      <div className="actions">
        <Button variant="ghost" onClick={onClose}>
          {t.common.close}
        </Button>
      </div>
    </Modal>
  );
}
