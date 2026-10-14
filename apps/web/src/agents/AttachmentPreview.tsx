import {
  type AttachmentBlock,
  type AttachmentDerivativeDto,
  type ChatAttachmentDto,
  isAudioMime,
  isImageMime,
  isMarkdownMime,
  isPdfMime,
  type MessageSpeechDto,
  TRANSCRIPTION_COLLAPSE_LINES,
  type TranscriptionDto,
  t,
} from '@moneyflow/shared';
import { AlertTriangle, Download, FileText, Loader2, Paperclip, Play, RotateCcw } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatBytes } from '../components/attachments/AttachmentsPanel';
import { loadPdf, PdfViewer } from '../components/contracts/PdfViewer';
import { useToast } from '../components/Toast';
import { cx } from '../components/ui';
import { api } from '../lib/api';
import { attachmentUrl } from '../lib/upload';
import { AudioPlayer } from './AudioPlayer';
import { ImageLightbox, type LightboxImage, MediaDialog } from './ImageLightbox';
import { MarkdownDocument } from './Markdown';

const u = t.agentsUi.media;

/*
 * Prévias dos anexos do chat (spec 025): imagem (miniatura e ampliada com
 * navegação), PDF (1ª página, páginas e o visualizador pdf.js dos contratos),
 * markdown (início do texto; renderizado/bruto e baixar), áudio (o player com
 * a transcrição embaixo) e, para o resto, o chip de download. O admin lendo a
 * conversa de outro usuário vê e toca tudo (somente leitura: sem "tentar de
 * novo").
 */

type MediaState = {
  conversationId: string;
  readOnly: boolean;
  /** O agente converte áudio em texto (sem isso, o áudio fica "sem transcrição"). */
  transcribes: boolean;
  attachments: Map<string, ChatAttachmentDto>;
  images: LightboxImage[];
  openImage: (id: string) => void;
};

const MediaContext = createContext<MediaState | null>(null);

export function MediaProvider({
  conversationId,
  readOnly,
  transcribes,
  attachments,
  images,
  children,
}: Omit<MediaState, 'openImage' | 'attachments'> & { attachments: ChatAttachmentDto[]; children: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null);
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const openImage = useCallback(
    (id: string) => {
      const index = images.findIndex((image) => image.id === id);
      setOpen(index === -1 ? null : index);
    },
    [images],
  );
  const close = useCallback(() => setOpen(null), []);
  return (
    <MediaContext.Provider value={{ conversationId, readOnly, transcribes, attachments: byId, images, openImage }}>
      {children}
      {open !== null && <ImageLightbox images={images} index={open} onIndex={setOpen} onClose={close} />}
    </MediaContext.Provider>
  );
}

const useMedia = () => useContext(MediaContext);

/* ---------------- transcrição ---------------- */

const POLL_MS = 1500;
const active = (status: TranscriptionDto['status'] | undefined) => status === 'pending' || status === 'running';

/** A transcrição de um áudio, acompanhada enquanto está na fila (GET /api/attachments/:id/derivatives). */
export function useTranscription(attachmentId: string, initial: TranscriptionDto | null) {
  const [value, setValue] = useState<TranscriptionDto | null>(initial);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setValue(initial);
  }, [initial]);

  const refresh = useCallback(async () => {
    const list = await api.get<AttachmentDerivativeDto[]>(`/api/attachments/${attachmentId}/derivatives`);
    const latest = list.find((d) => d.kind === 'transcription');
    if (!alive.current || !latest) return;
    setValue({
      id: latest.id,
      status: latest.status,
      text: latest.content,
      error: latest.error,
      model: latest.model ?? '',
      updatedAt: latest.updatedAt,
    });
  }, [attachmentId]);

  const polling = active(value?.status);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refresh().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  const retry = useCallback(async () => {
    const next = await api.post<TranscriptionDto>(`/api/attachments/${attachmentId}/transcribe`);
    if (alive.current) setValue(next);
  }, [attachmentId]);

  return { transcription: value, retry };
}

/** Situação curta da transcrição (chip do compositor). */
export function TranscriptionBadge({ attachmentId, initial }: { attachmentId: string; initial: TranscriptionDto | null }) {
  const { transcription } = useTranscription(attachmentId, initial);
  if (!transcription) return null;
  if (active(transcription.status)) {
    return (
      <span className="agent-chip-status" data-testid="transcription-status" data-status={transcription.status}>
        <Loader2 className="spin" /> {u.transcribing}
      </span>
    );
  }
  if (transcription.status === 'failed') {
    return (
      <span className="agent-chip-status danger" data-testid="transcription-status" data-status="failed">
        <AlertTriangle /> {u.transcriptionFailed}
      </span>
    );
  }
  return <span className="sr-only" data-testid="transcription-status" data-status="done" />;
}

function TranscriptionView({ attachmentId, initial }: { attachmentId: string; initial: TranscriptionDto | null }) {
  const media = useMedia();
  const toast = useToast();
  const { transcription, retry } = useTranscription(attachmentId, initial);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  const text = transcription?.status === 'done' ? transcription.text?.trim() || u.emptyTranscription : null;

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  if (!transcription) {
    if (media?.transcribes) return null;
    return (
      <p className="agent-transcript muted" data-testid="transcription" data-status="none">
        {u.noTranscription}
      </p>
    );
  }
  if (active(transcription.status)) {
    return (
      <p className="agent-transcript muted" data-testid="transcription" data-status={transcription.status}>
        <Loader2 className="spin" /> {u.transcribing}
      </p>
    );
  }
  if (transcription.status === 'failed') {
    return (
      <div className="agent-transcript failed" data-testid="transcription" data-status="failed">
        <AlertTriangle /> <span>{u.transcriptionFailed}</span>
        {!media?.readOnly && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              retry()
                .catch((error: Error) => toast.error(error.message))
                .finally(() => setRetrying(false));
            }}
            data-testid="transcription-retry"
          >
            <RotateCcw /> {u.retry}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="agent-transcript" data-testid="transcription" data-status="done">
      <p
        ref={body}
        className={cx('agent-transcript-text', !expanded && 'clamped')}
        style={{ ['--clamp' as string]: TRANSCRIPTION_COLLAPSE_LINES }}
        aria-label={u.transcription}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button type="button" className="agent-transcript-more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? u.showLess : u.showMore}
        </button>
      )}
    </div>
  );
}

/* ---------------- prévias ---------------- */

function DownloadChip({ id, name }: { id: string; name: string }) {
  return (
    <a className="agent-chip" href={attachmentUrl(id)} title={t.agentsUi.chat.download}>
      <Paperclip /> <span className="truncate">{name}</span>
    </a>
  );
}

function ImageThumb({ id, name }: { id: string; name: string }) {
  const media = useMedia();
  return (
    <button
      type="button"
      className="agent-thumb"
      onClick={() => media?.openImage(id)}
      aria-label={u.openImage(name)}
      title={name}
      data-testid="image-thumb"
    >
      <img src={attachmentUrl(id, true)} alt={name} loading="lazy" />
    </button>
  );
}

/** Miniatura da 1ª página (pdf.js sob demanda). */
function PdfThumb({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;
    loadPdf(url)
      .then(async (doc) => {
        destroy = () => doc.destroy();
        if (cancelled || !canvas.current) return;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (72 / base.width) * ratio });
        const el = canvas.current;
        if (!el) return;
        el.width = viewport.width;
        el.height = viewport.height;
        const context = el.getContext('2d');
        if (context) await page.render({ canvasContext: context, viewport, canvas: el }).promise;
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [url]);
  return failed ? <FileText className="agent-doc-icon" /> : <canvas ref={canvas} className="agent-pdf-thumb" aria-hidden />;
}

function PdfCard({ meta }: { meta: { id: string; fileName: string; pageCount: number | null; sizeBytes?: number } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="agent-doc"
        onClick={() => setOpen(true)}
        aria-label={u.openPdf(meta.fileName)}
        data-testid="pdf-card"
      >
        <PdfThumb url={attachmentUrl(meta.id, true)} />
        <span className="agent-doc-info">
          <span className="agent-doc-name">{meta.fileName}</span>
          <span className="agent-doc-meta">
            {u.pdf}
            {meta.pageCount ? ` · ${u.pages(meta.pageCount)}` : ''}
            {meta.sizeBytes ? ` · ${formatBytes(meta.sizeBytes)}` : ''}
          </span>
        </span>
      </button>
      {open && (
        <MediaDialog title={meta.fileName} onClose={() => setOpen(false)} wide testId="pdf-dialog">
          <PdfViewer url={attachmentUrl(meta.id, true)} downloadUrl={attachmentUrl(meta.id)} />
        </MediaDialog>
      )}
    </>
  );
}

/** Texto de um anexo (markdown), uma vez por anexo. */
const textCache = new Map<string, Promise<string>>();
function loadText(id: string) {
  let pending = textCache.get(id);
  if (!pending) {
    pending = fetch(attachmentUrl(id, true), { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    });
    pending.catch(() => textCache.delete(id));
    textCache.set(id, pending);
  }
  return pending;
}

function MarkdownCard({ id, name }: { id: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadText(id)
      .then((value) => !cancelled && setText(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);
  const excerpt = text
    ?.replace(/[#>*_`|[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return (
    <>
      <button
        type="button"
        className="agent-doc"
        onClick={() => setOpen(true)}
        aria-label={u.openMarkdown(name)}
        data-testid="markdown-card"
      >
        <FileText className="agent-doc-icon" />
        <span className="agent-doc-info">
          <span className="agent-doc-name">{name}</span>
          <span className="agent-doc-excerpt">{failed ? u.markdownError : (excerpt ?? u.markdownLoading)}</span>
        </span>
      </button>
      {open && (
        <MediaDialog
          title={name}
          onClose={() => setOpen(false)}
          wide
          testId="markdown-dialog"
          actions={
            <a className="btn btn-ghost btn-sm" href={attachmentUrl(id)}>
              <Download /> {u.download}
            </a>
          }
        >
          {failed ? (
            <p className="notice warn">{u.markdownError}</p>
          ) : text === null ? (
            <Loader2 className="spin" />
          ) : (
            <MarkdownDocument text={text} />
          )}
        </MediaDialog>
      )}
    </>
  );
}

function AudioAttachment({ id, name, meta }: { id: string; name: string; meta: ChatAttachmentDto | undefined }) {
  return (
    <div className="agent-audio" data-testid="audio-attachment">
      <div className="agent-audio-head">
        <span className="truncate" title={name}>
          {name}
        </span>
        <a className="row-action" href={attachmentUrl(id)} title={u.download} aria-label={u.download}>
          <Download />
        </a>
      </div>
      <AudioPlayer src={attachmentUrl(id, true)} durationMs={meta?.durationMs} label={name} />
      <TranscriptionView attachmentId={id} initial={meta?.transcription ?? null} />
    </div>
  );
}

/** A prévia de um bloco de anexo de mensagem, pelo tipo do arquivo. */
export function AttachmentPreview({ block }: { block: AttachmentBlock }) {
  const media = useMedia();
  const meta = media?.attachments.get(block.attachment_id);
  const mime = meta?.mimeType ?? block.mime_type ?? '';
  const name = meta?.fileName ?? block.file_name ?? block.attachment_id;
  if (isImageMime(mime)) return <ImageThumb id={block.attachment_id} name={name} />;
  if (isPdfMime(mime))
    return <PdfCard meta={{ id: block.attachment_id, fileName: name, pageCount: meta?.pageCount ?? null, sizeBytes: meta?.sizeBytes }} />;
  if (isMarkdownMime(mime) || /\.md$/i.test(name)) return <MarkdownCard id={block.attachment_id} name={name} />;
  if (isAudioMime(mime)) return <AudioAttachment id={block.attachment_id} name={name} meta={meta} />;
  return <DownloadChip id={block.attachment_id} name={name} />;
}

/* ---------------- modo áudio ---------------- */

/** Play de uma mensagem de texto: gera o áudio sob demanda (uma vez; o servidor guarda) e toca no player. */
export function SpeechButton({ messageId }: { messageId: string }) {
  const media = useMedia();
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'loading' | MessageSpeechDto>('idle');
  if (!media) return null;
  if (typeof state === 'object') {
    return (
      <AudioPlayer
        src={state.parts.map((p) => attachmentUrl(p.attachmentId, true))}
        autoPlay
        label={u.listen}
        className="agent-speech"
        testId="speech-player"
      />
    );
  }
  return (
    <button
      type="button"
      className="agent-listen"
      disabled={state === 'loading'}
      onClick={() => {
        setState('loading');
        api
          .post<MessageSpeechDto>(`/api/conversations/${media.conversationId}/messages/${messageId}/speech`)
          .then(setState)
          .catch((error: Error) => {
            setState('idle');
            toast.error(error.message);
          });
      }}
      title={state === 'loading' ? u.generating : u.listen}
      aria-label={state === 'loading' ? u.generating : u.listen}
      data-testid="agent-listen"
    >
      {state === 'loading' ? <Loader2 className="spin" /> : <Play />}
    </button>
  );
}
