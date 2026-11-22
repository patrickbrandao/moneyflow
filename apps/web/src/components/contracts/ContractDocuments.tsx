import {
  CONTRACT_DOCUMENT_KINDS,
  type ContractDetail,
  type ContractDocumentDto,
  type ContractDocumentKind,
  type ContractMarkdownCreateInput,
  formatDate,
  localDateOf,
  t,
} from '@moneyflow/shared';
import { FilePlus, FileUp } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/hooks';
import { upload } from '../../lib/upload';
import { RowButton } from '../a11y';
import { FormError, ModalActions } from '../forms';
import { Badge, Button, EmptyRow, Field, Modal } from '../ui';

const C = t.contracts;

/** Documentos do contrato: a lista, o envio (PDF ou markdown) e o markdown novo. */
export function ContractDocuments({
  contract,
  canWrite,
  onOpen,
  onNewMarkdown,
  onChanged,
}: {
  contract: ContractDetail;
  canWrite: boolean;
  onOpen: (id: string) => void;
  onNewMarkdown: () => void;
  onChanged: () => void;
}) {
  const D = C.documents;
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ContractDocumentKind>('contract');
  const { run, busy } = useAction();

  async function send(file: File) {
    const doc = await run(() => upload<ContractDocumentDto>(`/api/contracts/${contract.id}/documents`, file, { kind }), D.uploaded);
    if (doc) {
      onChanged();
      onOpen(doc.id);
    }
  }

  return (
    <div>
      {canWrite && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            className="field field-auto"
            value={kind}
            onChange={(e) => setKind(e.target.value as ContractDocumentKind)}
            aria-label={D.kind}
          >
            {CONTRACT_DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {D.kinds[k]}
              </option>
            ))}
          </select>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf,.md,.markdown,text/markdown"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void send(file);
            }}
          />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => input.current?.click()} title={D.uploadHint}>
            <FileUp /> {D.upload}
          </Button>
          <Button size="sm" variant="ghost" onClick={onNewMarkdown}>
            <FilePlus /> {D.newMarkdown}
          </Button>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{D.docTitle}</th>
              <th>{D.kind}</th>
              <th>{D.documentDate}</th>
              <th>{D.versions}</th>
            </tr>
          </thead>
          <tbody>
            {contract.documents.length === 0 && <EmptyRow colSpan={4}>{D.empty}</EmptyRow>}
            {contract.documents.map((doc) => (
              // A linha abre pelo clique; pelo teclado, o título é o botão (tarefa 114).
              <tr key={doc.id} className="cursor-pointer" onClick={() => onOpen(doc.id)}>
                <td>
                  <RowButton onClick={() => onOpen(doc.id)}>{doc.title}</RowButton>
                  <span className="row-sub">{doc.format === 'pdf' ? (doc.fileName ?? D.formats.pdf) : D.formats.markdown}</span>
                </td>
                <td>
                  <Badge tone="outline">{D.kinds[doc.kind]}</Badge>
                </td>
                <td className="mono text-xs">{doc.documentDate ? formatDate(doc.documentDate) : '—'}</td>
                <td className="text-xs">
                  {doc.format === 'pdf' ? (
                    <Badge tone="info">{D.formats.pdf}</Badge>
                  ) : doc.currentVersion ? (
                    D.editedAt(doc.currentVersion, doc.lastEditedAt ? formatDate(localDateOf(doc.lastEditedAt)) : '')
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function NewMarkdownModal({
  contractId,
  onClose,
  onCreated,
}: {
  contractId: string;
  onClose: () => void;
  onCreated: (doc: ContractDocumentDto) => void;
}) {
  const D = C.documents;
  const [kind, setKind] = useState<ContractDocumentKind>('contract');
  const [title, setTitle] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError(D.docTitle);
    const body: ContractMarkdownCreateInput = { kind, title, documentDate: documentDate || null, content: '' };
    const doc = await run(() => api.post<ContractDocumentDto>(`/api/contracts/${contractId}/documents/markdown`, body), D.saved);
    if (doc) onCreated(doc);
  }

  return (
    <Modal open title={D.newMarkdown} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid cols-2">
            <Field label={D.docTitle} className="span-all">
              <input
                className="field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                aria-label={D.docTitle}
                autoFocus
              />
            </Field>
            <Field label={D.kind}>
              <select className="field" value={kind} onChange={(e) => setKind(e.target.value as ContractDocumentKind)} aria-label={D.kind}>
                {CONTRACT_DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {D.kinds[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={D.documentDate}>
              <input
                className="field"
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
                aria-label={D.documentDate}
              />
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={busy}>
            {t.common.create}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
