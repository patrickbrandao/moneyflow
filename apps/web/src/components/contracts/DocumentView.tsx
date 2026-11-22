import {
  type ContractDocumentDto,
  type ContractDocumentVersionContent,
  type ContractDocumentVersionDto,
  formatDate,
  formatDateTime,
  t,
} from '@moneyflow/shared';
import { Archive, ArrowLeft, Code, Eye, History, PencilLine, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '../../agents/Markdown';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { attachmentUrl } from '../../lib/upload';
import { LineDiff } from '../diff/LineDiff';
import { VersionCompare, type VersionItem } from '../diff/VersionCompare';
import { LoadError } from '../domain';
import { Badge, Button, Tabs, useConfirm } from '../ui';
import { PdfViewer } from './PdfViewer';

const D = t.contracts.documents;

/** Um documento do contrato: PDF (visualizador) ou markdown (renderizado, raw, edição com prévia, versões e diff). */
export function DocumentView({
  documentId,
  canWrite,
  onBack,
  onChanged,
  onOpen,
}: {
  documentId: string;
  canWrite: boolean;
  onBack: () => void;
  onChanged: () => void;
  onOpen: (documentId: string) => void;
}) {
  const doc = useApi<ContractDocumentDto>(`/api/contract-documents/${documentId}`);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const data = doc.data;

  async function archive() {
    if (!data) return;
    if (!(await confirm({ title: D.archiveConfirm(data.title), confirmLabel: t.common.archive, danger: true }))) return;
    const saved = await run(() => api.del<ContractDocumentDto>(`/api/contract-documents/${data.id}`), D.archived);
    if (saved) {
      onChanged();
      onBack();
    }
  }

  async function convert() {
    if (!data) return;
    const created = await run(() => api.post<ContractDocumentDto>(`/api/contract-documents/${data.id}/convert`), D.converted);
    if (created) {
      onChanged();
      onOpen(created.id);
    }
  }

  if (doc.error) return <LoadError error={doc.error} onRetry={() => void doc.reload()} />;
  if (!data) return <p className="hint">{t.common.loading}</p>;
  return (
    <section className="contract-doc">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft /> {t.contracts.documents.title}
        </Button>
        <h2 className="!mb-0 min-w-0 truncate text-base font-semibold">{data.title}</h2>
        <Badge tone="outline">{D.kinds[data.kind]}</Badge>
        <Badge tone="info">{D.formats[data.format]}</Badge>
        {data.documentDate && <span className="mono text-xs text-muted">{formatDate(data.documentDate)}</span>}
        {data.archivedAt && <Badge>{t.common.archived}</Badge>}
        <span className="ml-auto flex gap-2">
          {canWrite && data.format === 'pdf' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void convert()}>
              <Sparkles /> {busy ? D.converting : D.convert}
            </Button>
          )}
          {canWrite && !data.archivedAt && (
            <Button size="sm" variant="ghost" onClick={() => void archive()}>
              <Archive /> {t.common.archive}
            </Button>
          )}
        </span>
      </div>
      {data.description && <p className="hint mb-3">{data.description}</p>}
      {data.format === 'pdf' && data.attachmentId ? (
        <PdfViewer url={attachmentUrl(data.attachmentId, true)} downloadUrl={attachmentUrl(data.attachmentId)} />
      ) : (
        <MarkdownDocument doc={data} canWrite={canWrite && !data.archivedAt} onSaved={() => void doc.reload().then(onChanged)} />
      )}
    </section>
  );
}

type View = 'rendered' | 'raw' | 'edit' | 'versions';

function MarkdownDocument({ doc, canWrite, onSaved }: { doc: ContractDocumentDto; canWrite: boolean; onSaved: () => void }) {
  const [view, setView] = useState<View>('rendered');
  const current = useApi<ContractDocumentVersionContent>(
    doc.currentVersionId ? `/api/contract-documents/${doc.id}/versions/${doc.currentVersionId}` : null,
  );
  const content = current.data?.content ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const dirty = draft !== null && draft !== content;

  // Saída com alterações não salvas: o navegador pergunta.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  function switchView(next: View) {
    if (view === 'edit' && dirty && !window.confirm(D.leaveUnsaved)) return;
    if (next === 'edit') setDraft(content);
    else setDraft(null);
    setView(next);
  }

  async function save() {
    if (draft === null) return;
    const result = await run(
      () => api.post<{ version: number }>(`/api/contract-documents/${doc.id}/versions`, { content: draft, note }),
      (r) => D.versionSaved(r.version),
    );
    if (result) {
      setNote('');
      setDraft(null);
      setView('rendered');
      onSaved();
    }
  }

  const tabs = [
    { key: 'rendered', label: D.views.rendered, icon: <Eye /> },
    { key: 'raw', label: D.views.raw, icon: <Code /> },
    ...(canWrite ? [{ key: 'edit', label: D.views.edit, icon: <PencilLine /> }] : []),
    { key: 'versions', label: `${D.versions} (${doc.versionCount})`, icon: <History /> },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={view} onChange={(key) => switchView(key as View)} items={tabs} />
        {doc.currentVersion && (
          <span className="text-xs text-muted">
            {D.editedAt(doc.currentVersion, doc.lastEditedAt ? formatDateTime(doc.lastEditedAt) : '')}
            {current.data?.authorKind === 'agent' && ` · ${D.authorAgent}`}
          </span>
        )}
      </div>
      {current.error && <LoadError error={current.error} onRetry={() => void current.reload()} />}
      {view === 'rendered' && (
        <div className="panel contract-md">
          <Markdown text={content} />
        </div>
      )}
      {view === 'raw' && <pre className="panel contract-raw">{content}</pre>}
      {view === 'edit' && draft !== null && (
        <div>
          <div className="md-editor">
            <textarea
              className="field"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={D.editorPlaceholder}
              aria-label={D.views.edit}
              spellCheck
            />
            <div className="panel contract-md" role="group" aria-label={D.preview}>
              <Markdown text={draft} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className="field flex-1"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder={D.versionNotePlaceholder}
              aria-label={D.versionNote}
            />
            <Button disabled={busy || !dirty} onClick={() => void save()}>
              {D.saveVersion}
            </Button>
          </div>
        </div>
      )}
      {view === 'versions' && <Versions doc={doc} canWrite={canWrite} onRestored={onSaved} />}
    </div>
  );
}

function Versions({ doc, canWrite, onRestored }: { doc: ContractDocumentDto; canWrite: boolean; onRestored: () => void }) {
  const list = useApi<ContractDocumentVersionDto[]>(`/api/contract-documents/${doc.id}/versions`);
  const { run } = useAction();
  const confirm = useConfirm();
  const items: VersionItem[] = (list.data ?? []).map((v) => ({
    id: v.id,
    version: v.version,
    current: v.id === doc.currentVersionId,
    title: (
      <>
        v{v.version} {v.id === doc.currentVersionId && <Badge tone="ok">{D.current}</Badge>}
      </>
    ),
    sub: `${formatDateTime(v.createdAt)} · ${v.authorKind === 'agent' ? D.authorAgent : (v.authorName ?? '—')}${v.note ? ` · ${v.note}` : ''}`,
  }));

  async function restore(item: VersionItem): Promise<boolean> {
    if (!(await confirm({ title: `${D.restoreVersion} (v${item.version})?`, confirmLabel: D.restoreVersion }))) return false;
    const result = await run(
      () => api.post<{ version: number }>(`/api/contract-documents/${doc.id}/versions/${item.id}/restore`),
      (r) => D.restoredVersion(item.version, r.version),
    );
    if (!result) return false;
    await list.reload();
    onRestored();
    return true;
  }

  return (
    <VersionCompare
      items={items}
      name={`doc-${doc.id}`}
      labels={{ compareA: D.compareA, compareB: D.compareB, restore: D.restoreVersion, compare: D.compare, compareHint: D.compare }}
      canRestore={canWrite}
      onRestore={restore}
      renderContent={(id) => <VersionContent documentId={doc.id} versionId={id} />}
      renderDiff={(left, right) => <VersionDiff documentId={doc.id} leftId={left} rightId={right} />}
      className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]"
    />
  );
}

function VersionContent({ documentId, versionId }: { documentId: string; versionId: string }) {
  const version = useApi<ContractDocumentVersionContent>(`/api/contract-documents/${documentId}/versions/${versionId}`);
  if (!version.data) return <p className="hint">{t.common.loading}</p>;
  return <pre className="panel contract-raw">{version.data.content}</pre>;
}

function VersionDiff({ documentId, leftId, rightId }: { documentId: string; leftId: string; rightId: string }) {
  const a = useApi<ContractDocumentVersionContent>(`/api/contract-documents/${documentId}/versions/${leftId}`);
  const b = useApi<ContractDocumentVersionContent>(`/api/contract-documents/${documentId}/versions/${rightId}`);
  if (!a.data || !b.data) return <p className="hint">{t.common.loading}</p>;
  return <LineDiff before={a.data.content} after={b.data.content} title={D.diffTitle(a.data.version, b.data.version)} noDiff={D.noDiff} />;
}
