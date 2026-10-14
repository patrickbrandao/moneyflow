import {
  type AiBlock,
  type AiMessageDto,
  type ChatAttachmentDto,
  formatDateTime,
  formatFileSize,
  isAudioMime,
  isImageMime,
  type PreviewRow,
  type ToolConfirmationDto,
  type ToolResultBlock,
  type ToolUseBlock,
  t,
} from '@moneyflow/shared';
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCheck,
  ChevronRight,
  CircleSlash,
  Download,
  KeyRound,
  Loader2,
  Paperclip,
  SendHorizontal,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MAX_ATTACHMENT_BYTES } from '../components/attachments/AttachmentsPanel';
import { LoadError } from '../components/domain';
import { useToast } from '../components/Toast';
import { Badge, Button, cx, Skel } from '../components/ui';
import { attachmentUrl } from '../lib/upload';
import { useAgents } from './AgentsProvider';
import { AttachmentPreview, MediaProvider, SpeechButton, TranscriptionBadge } from './AttachmentPreview';
import { RecordButton, RecorderPanel, useAudioRecorder } from './AudioRecorder';
import { agentColor, toolLabel, usageLine } from './format';
import { Markdown } from './Markdown';
import { hasRecord, readRecord, recordMarkdown } from './records';
import { type ConversationState, type LiveTool, type PaneDetail, type PaneTarget, useConversation } from './useConversation';

const u = t.agentsUi;

export type PaneHeaderInfo = {
  detail: PaneDetail | null;
  state: ConversationState;
};

/**
 * O miolo de uma sessão (janela flutuante ou painel): cabeçalho fornecido por
 * quem embrulha, mensagens, confirmações, composer e rodapé de uso. A sessão
 * finalizada e a de outro usuário ficam em somente leitura (spec 026).
 */
export function ConversationPane({ target, header }: { target: PaneTarget; header: (info: PaneHeaderInfo) => ReactNode }) {
  const state = useConversation(target);
  const { detail, error } = state;
  // Sessão de um fluxo (tarefa agendada, conciliação, spec 029): sem composer, mas o dono aprova as ações pendentes.
  const flow = Boolean(detail?.conversation && detail.conversation.purpose !== 'chat');
  const finished = Boolean(detail?.conversation?.archivedAt) && !flow;
  const readOnly = (detail?.readOnly ?? false) || finished || flow;
  const canDecide = !(detail?.readOnly ?? false) && !finished;
  const agentInactive = target.kind === 'agent' && state.agent !== null && !state.agent.isActive;
  // Modo áudio (spec 025): por janela, só com texto→áudio no agente.
  const audioMode = Boolean(useAgents().state.windows.find((w) => w.id === target.windowId)?.audioMode && detail?.media.speech);
  const images = useMemo(() => {
    const list: { id: string; fileName: string }[] = [];
    const meta = new Map(detail?.attachments.map((a) => [a.id, a]) ?? []);
    for (const message of detail?.messages ?? []) {
      if (message.role !== 'user') continue;
      for (const block of message.content) {
        if (block.type !== 'attachment') continue;
        const mime = meta.get(block.attachment_id)?.mimeType ?? block.mime_type ?? '';
        if (isImageMime(mime) && !list.some((i) => i.id === block.attachment_id))
          list.push({ id: block.attachment_id, fileName: block.file_name ?? block.attachment_id });
      }
    }
    return list;
  }, [detail?.messages, detail?.attachments]);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle | null>(null);

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (readOnly || !detail) return;
    if (hasRecord(event) || event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!dragging) setDragging(true);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (readOnly || !detail) return;
    const record = readRecord(event);
    if (record) {
      event.preventDefault();
      composer.current?.insert(recordMarkdown(record));
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) {
      event.preventDefault();
      for (const file of files) composer.current?.attachFile(file);
    }
  }

  return (
    <div
      className={cx('agent-pane', dragging && 'is-drop')}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {header({ detail, state })}
      {error ? (
        <div className="agent-scroll">
          <LoadError error={error} onRetry={() => void state.reload()} />
        </div>
      ) : !detail ? (
        <div className="agent-scroll">
          <Skel h={48} className="mb-3" />
          <Skel h={80} className="mb-3" />
          <Skel h={36} />
        </div>
      ) : (
        <>
          {detail.readOnly ? (
            <div className="agent-readonly">{u.window.readOnly}</div>
          ) : finished ? (
            <div className="agent-readonly" data-testid="agent-finished-notice">
              {u.window.finished}
            </div>
          ) : flow ? (
            <div className="agent-readonly" data-testid="agent-flow-notice">
              {u.window.flowSession}
            </div>
          ) : agentInactive ? (
            <div className="agent-readonly">{u.window.agentInactive}</div>
          ) : null}
          <MediaProvider
            conversationId={state.conversationId ?? ''}
            readOnly={readOnly}
            transcribes={detail.media.transcription}
            attachments={detail.attachments}
            images={images}
          >
            <Messages state={state} detail={detail} audioMode={audioMode} />
            {canDecide && <Confirmations state={state} detail={detail} />}
            {!readOnly && !agentInactive && <Composer ref={composer} state={state} transcribes={detail.media.transcription} />}
          </MediaProvider>
          <Footer state={state} detail={detail} />
        </>
      )}
      {dragging && <div className="agent-drop-hint">{u.chat.dropHint}</div>}
    </div>
  );
}

/* ---------------- mensagens ---------------- */

type ToolOutcome = { content: string; isError: boolean };

function Messages({ state, detail, audioMode }: { state: ConversationState; detail: PaneDetail; audioMode: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const results = useMemo(() => {
    const map = new Map<string, ToolOutcome>();
    for (const message of detail.messages) {
      if (message.role !== 'tool') continue;
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          const b = block as ToolResultBlock;
          map.set(b.tool_use_id, {
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            isError: Boolean(b.is_error),
          });
        }
      }
    }
    return map;
  }, [detail.messages]);
  const confirmationsByTool = useMemo(() => new Map(detail.confirmations.map((c) => [c.toolUseId, c])), [detail.confirmations]);
  const visible = detail.messages.filter((m) => m.role !== 'tool');

  // Rola para o fim quando chega conteúdo, se quem lê já estava no fim.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={scroller}
      className="agent-scroll"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {visible.length === 0 && !state.busy && (
        <div className="agent-empty">
          <p>{u.chat.empty}</p>
          {/* Segredos (spec 027): nunca no texto livre; o agente pede no cartão de aprovação. */}
          <p className="agent-composer-note" data-testid="agent-secrets-notice">
            <KeyRound /> {u.chat.secretsNotice}
          </p>
        </div>
      )}
      {visible.map((message) => (
        <MessageView
          key={message.id}
          message={message}
          results={results}
          confirmations={confirmationsByTool}
          liveTools={state.liveTools}
          active={state.busy}
          audioMode={audioMode}
        />
      ))}
      {state.busy && (state.liveThinking || state.liveText) && (
        <div className="agent-msg assistant" data-testid="agent-message-assistant" data-live="true">
          {state.liveThinking && <Thinking text={state.liveThinking} live />}
          {state.liveText && <Markdown text={state.liveText} />}
        </div>
      )}
      {state.busy && (
        <div className="agent-working">
          <Loader2 className="spin" />
          {state.reconnecting
            ? u.chat.reconnecting
            : state.run?.status === 'queued'
              ? u.chat.queued
              : state.run?.status === 'awaiting_confirmation'
                ? u.tool.awaiting
                : state.run?.cancelRequested
                  ? u.chat.stopping
                  : u.chat.working}
        </div>
      )}
      {state.streamError && !state.busy && (
        <div className="notice danger mt-2 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 flex-none" />
          <span className="flex-1">{state.streamError}</span>
          <button type="button" className="row-action" aria-label={t.common.close} onClick={state.clearStreamError}>
            <X />
          </button>
        </div>
      )}
    </div>
  );
}

function MessageView({
  message,
  results,
  confirmations,
  liveTools,
  active,
  audioMode,
}: {
  message: AiMessageDto;
  results: Map<string, ToolOutcome>;
  confirmations: Map<string, ToolConfirmationDto>;
  liveTools: Record<string, LiveTool>;
  active: boolean;
  audioMode: boolean;
}) {
  const hasText = message.content.some((b) => b.type === 'text' && b.text.trim() !== '');
  if (message.role === 'user') {
    return (
      <div className="agent-msg user" data-testid="agent-message-user">
        {message.content.map((block, index) => (
          <UserBlock key={index} block={block} />
        ))}
        <span className="agent-time">
          {audioMode && hasText && <SpeechButton messageId={message.id} />}
          {formatDateTime(message.createdAt)}
        </span>
      </div>
    );
  }
  return (
    <div className="agent-msg assistant" {...(hasText ? { 'data-testid': 'agent-message-assistant' } : {})}>
      {audioMode && hasText && !active && <SpeechButton messageId={message.id} />}
      {message.content.map((block, index) => {
        switch (block.type) {
          case 'text':
            return block.text.trim() ? <Markdown key={index} text={block.text} /> : null;
          case 'thinking':
            return block.thinking.trim() ? <Thinking key={index} text={block.thinking} /> : null;
          case 'redacted_thinking':
            return (
              <p key={index} className="agent-redacted">
                <Brain /> {u.chat.redactedThinking}
              </p>
            );
          case 'tool_use':
            return (
              <ToolView
                key={index}
                block={block}
                outcome={results.get(block.id)}
                confirmation={confirmations.get(block.id)}
                live={liveTools[block.id]}
                active={active}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function UserBlock({ block }: { block: AiBlock }) {
  if (block.type === 'text') return block.text.trim() ? <Markdown text={block.text} /> : null;
  if (block.type === 'attachment') return <AttachmentPreview block={block} />;
  return null;
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  return (
    <details className="agent-thinking">
      <summary>
        <ChevronRight className="chev" />
        <Brain /> {live ? u.chat.thinkingLive : u.chat.thinking}
      </summary>
      <div className="agent-thinking-body">{text}</div>
    </details>
  );
}

type ToolStatus = 'running' | 'ok' | 'error' | 'awaiting' | 'rejected' | 'pending';

function ToolView({
  block,
  outcome,
  confirmation,
  live,
  active,
}: {
  block: ToolUseBlock;
  outcome?: ToolOutcome;
  confirmation?: ToolConfirmationDto;
  live?: LiveTool;
  active: boolean;
}) {
  let status: ToolStatus;
  if (outcome) status = outcome.isError ? (confirmation?.status === 'rejected' ? 'rejected' : 'error') : 'ok';
  else if (confirmation?.status === 'pending') status = 'awaiting';
  else if (confirmation?.status === 'rejected') status = 'rejected';
  else if (live) status = live.status;
  else status = active ? 'running' : 'pending';

  const icon =
    status === 'running' ? (
      <Loader2 className="spin" />
    ) : status === 'ok' ? (
      <Check />
    ) : status === 'error' ? (
      <AlertTriangle />
    ) : status === 'rejected' ? (
      <CircleSlash />
    ) : (
      <Wrench />
    );
  const result = outcome?.content ?? '';
  const file = toolFile(outcome);
  return (
    <details className={cx('agent-tool', `is-${status}`)} data-testid="agent-tool" data-status={status} data-tool={block.name}>
      <summary>
        <ChevronRight className="chev" />
        <span className="agent-tool-ic">{icon}</span>
        <span className="agent-tool-name">{toolLabel(block.name, live?.title)}</span>
        <span className="agent-tool-status">{u.tool[status]}</span>
      </summary>
      <div className="agent-tool-body">
        {live?.summary && <p className="agent-tool-summary">{live.summary}</p>}
        <span className="label">{u.tool.input}</span>
        <pre>{JSON.stringify(block.input, null, 2)}</pre>
        {outcome && (
          <>
            <span className="label">{u.tool.result}</span>
            <pre>{result.length > 6000 ? `${result.slice(0, 6000)}…` : result}</pre>
          </>
        )}
      </div>
      {file && (
        <a className="agent-tool-file" href={attachmentUrl(file.attachmentId)} download={file.fileName} data-testid="agent-tool-file">
          <Download /> {u.tool.file(file.fileName, formatFileSize(file.sizeBytes))}
        </a>
      )}
    </details>
  );
}

type ToolFile = { attachmentId: string; fileName: string; sizeBytes: number };

/** Arquivo gerado pela tool (spec 027): o resultado traz só id, nome e tamanho. */
function toolFile(outcome?: ToolOutcome): ToolFile | null {
  if (!outcome || outcome.isError || !outcome.content.includes('"attachmentId"')) return null;
  try {
    const file = (JSON.parse(outcome.content) as { file?: ToolFile }).file;
    return file && typeof file.attachmentId === 'string' ? file : null;
  } catch {
    return null;
  }
}

/* ---------------- confirmações ("Aplicar?") ---------------- */

function Confirmations({ state, detail }: { state: ConversationState; detail: PaneDetail }) {
  const pending = detail.confirmations.filter((c) => c.status === 'pending');
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<string | 'all' | null>(null);
  const [reason, setReason] = useState('');
  // Segredos digitados (spec 027): só na memória do cartão; vão na decisão e são descartados.
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({});
  const toast = useToast();
  if (pending.length === 0) return null;

  const missingSecret = (c: ToolConfirmationDto) =>
    (c.preview?.secretFields ?? []).some((f) => f.required && !secrets[c.id]?.[f.key]?.trim());
  const setSecret = (id: string, key: string, value: string) => setSecrets((all) => ({ ...all, [id]: { ...all[id], [key]: value } }));

  async function decide(decision: 'approved' | 'rejected', ids?: string[], why?: string) {
    setBusy(true);
    try {
      const targets = ids ?? pending.map((c) => c.id);
      const typed = Object.fromEntries(targets.filter((id) => secrets[id]).map((id) => [id, secrets[id]!]));
      await state.decide(decision, ids, why, decision === 'approved' ? typed : undefined);
      setSecrets((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !targets.includes(id))));
      setRejecting(null);
      setReason('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const rejectForm = (ids?: string[]) => (
    <form
      className="agent-reject"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void decide('rejected', ids, reason.trim() || undefined);
      }}
    >
      <input
        className="field field-sm"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={u.confirm.reasonPlaceholder}
        aria-label={u.confirm.reason}
        maxLength={2000}
        autoFocus
      />
      <Button size="sm" variant="danger" type="submit" disabled={busy}>
        {u.confirm.confirmReject}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setRejecting(null)}>
        {t.common.cancel}
      </Button>
    </form>
  );

  return (
    <div className="agent-confirm" data-testid="agent-confirmation">
      <div className="agent-confirm-head">
        <span>{pending.length > 1 ? u.confirm.titleMany(pending.length) : u.confirm.title}</span>
        {pending.length > 1 && rejecting !== 'all' && (
          <span className="flex gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting('all')}>
              {u.confirm.rejectAll}
            </Button>
            <Button
              size="sm"
              disabled={busy || pending.some(missingSecret)}
              onClick={() => void decide('approved')}
              data-testid="agent-approve-all"
            >
              <CheckCheck /> {u.confirm.approveAll}
            </Button>
          </span>
        )}
      </div>
      {rejecting === 'all' && rejectForm()}
      <div className="agent-confirm-list">
        {pending.map((c) => (
          <div key={c.id} className="agent-confirm-item">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="agent-confirm-title">
                  {c.preview && <Badge tone="accent">{u.confirm.actions[c.preview.action] ?? c.preview.action}</Badge>}
                  <span>{c.preview?.title ?? toolLabel(c.toolName)}</span>
                </div>
                {c.preview?.summary && <p className="agent-confirm-summary">{c.preview.summary}</p>}
              </div>
            </div>
            {c.preview ? <PreviewRows rows={c.preview.rows} /> : <p className="hint">{u.confirm.noPreview}</p>}
            {c.preview?.warnings?.map((warning) => (
              <p key={warning} className="notice warn mt-2 text-[12px]">
                {warning}
              </p>
            ))}
            {c.preview?.secretFields && c.preview.secretFields.length > 0 && (
              <fieldset className="agent-secrets" data-testid="agent-secrets">
                <legend>
                  <KeyRound /> {u.confirm.secretsTitle}
                </legend>
                {c.preview.secretFields.map((field) => (
                  <label key={field.key} className="agent-secret">
                    <span>
                      {field.label}
                      {field.required && <em> · {u.confirm.secretRequired}</em>}
                    </span>
                    <input
                      type="password"
                      className="field field-sm"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={secrets[c.id]?.[field.key] ?? ''}
                      onChange={(e) => setSecret(c.id, field.key, e.target.value)}
                      aria-label={field.label}
                      data-testid="agent-secret-input"
                    />
                    {field.hint && <span className="hint">{field.hint}</span>}
                  </label>
                ))}
                <p className="hint">{u.confirm.secretsHint}</p>
              </fieldset>
            )}
            {rejecting === c.id ? (
              rejectForm([c.id])
            ) : (
              <div className="agent-confirm-actions">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(c.id)}>
                  {u.confirm.reject}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || missingSecret(c)}
                  onClick={() => void decide('approved', [c.id])}
                  data-testid="agent-approve"
                >
                  <Check /> {u.confirm.approve}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PreviewRows({ rows }: { rows: PreviewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="agent-diff">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className="contents">
          <dt>{row.label}</dt>
          <dd>
            {row.before !== undefined && (
              <>
                <span className="before">{row.before ?? '—'}</span>
                <span className="arrow">→</span>
              </>
            )}
            <span className="after">{row.after ?? '—'}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------- composer ---------------- */

type ComposerHandle = { insert: (text: string) => void; attachFile: (file: File) => void };

/** Duração de um arquivo de áudio pelo navegador (metadados), até 3 s; null se não souber. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const done = (value: number | null) => {
      clearTimeout(timer);
      el.src = '';
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 3000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

function Composer({ state, ref, transcribes }: { state: ConversationState; ref: Ref<ComposerHandle>; transcribes: boolean }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachmentDto[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const disabled = state.busy || sending;

  const attachFile = useCallback(
    async (file: File, knownDurationMs?: number) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(u.chat.attachmentTooLarge);
        return;
      }
      setUploading((n) => n + 1);
      try {
        const durationMs = knownDurationMs ?? (isAudioMime(file.type) ? await probeDuration(file) : null);
        const row = await state.attach(file, durationMs);
        setAttachments((list) => [...list, row]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [state.attach, toast],
  );

  const insert = useCallback((snippet: string) => {
    const el = area.current;
    setText((current) => {
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const before = current.slice(0, start);
      const pad = before && !/\s$/.test(before) ? ' ' : '';
      const next = `${before}${pad}${snippet} ${current.slice(end)}`;
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        const caret = before.length + pad.length + snippet.length + 1;
        el.setSelectionRange(caret, caret);
      });
      return next;
    });
  }, []);

  useImperativeHandle(ref, () => ({ insert, attachFile: (file) => void attachFile(file) }), [insert, attachFile]);

  // Gravação pelo microfone (spec 025): só com áudio→texto no agente; o áudio vira um anexo como os outros.
  const recorder = useAudioRecorder(useCallback((file: File, durationMs: number) => void attachFile(file, durationMs), [attachFile]));

  // Cresce com o texto até um limite (e recalcula quando a largura muda: painel, redimensionar).
  const fit = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);
  useLayoutEffect(fit, [text]);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  async function submit() {
    if (disabled || uploading > 0) return;
    const body = text.trim();
    if (!body && attachments.length === 0) return;
    setSending(true);
    try {
      await state.send(
        body,
        attachments.map((a) => a.id),
      );
      setText('');
      setAttachments([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="agent-composer">
      {transcribes && <RecorderPanel recorder={recorder} />}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="agent-chips">
          {attachments.map((a) => (
            <span key={a.id} className="agent-chip" data-testid="composer-attachment">
              <Paperclip /> <span className="truncate">{a.fileName}</span>
              {isAudioMime(a.mimeType) && <TranscriptionBadge attachmentId={a.id} initial={a.transcription} />}
              <button
                type="button"
                aria-label={u.chat.removeAttachment(a.fileName)}
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                <X />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="agent-chip muted">
              <Loader2 className="spin" /> {u.chat.uploading}
            </span>
          )}
        </div>
      )}
      <div className="agent-input">
        <textarea
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={state.busy ? u.chat.placeholderBusy : u.chat.placeholder}
          aria-label={u.chat.composer}
          title={u.chat.secretsNotice}
          disabled={disabled}
          data-testid="agent-composer"
        />
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          aria-label={u.chat.attach}
          onChange={(event) => {
            for (const file of event.target.files ?? []) void attachFile(file);
            event.target.value = '';
          }}
        />
        <div className="agent-input-actions">
          <button
            type="button"
            className="icon-btn"
            title={u.chat.attach}
            aria-label={u.chat.attach}
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <Paperclip />
          </button>
          {transcribes && <RecordButton recorder={recorder} disabled={disabled} />}
          {state.busy ? (
            <button
              type="button"
              className="icon-btn agent-stop"
              title={u.chat.stop}
              aria-label={u.chat.stop}
              onClick={() => void state.cancel().catch((e: Error) => toast.error(e.message))}
              disabled={state.run?.cancelRequested}
              data-testid="agent-stop"
            >
              <Square />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn agent-send"
              title={u.chat.send}
              aria-label={u.chat.send}
              disabled={disabled || uploading > 0 || (!text.trim() && attachments.length === 0)}
              onClick={() => void submit()}
              data-testid="agent-send"
            >
              <SendHorizontal />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- rodapé ---------------- */

function Footer({ state, detail }: { state: ConversationState; detail: PaneDetail }) {
  const run = state.run;
  return (
    <div className="agent-foot">
      <span className="truncate">{usageLine(detail.usage)}</span>
      {run && state.busy && run.inputTokens + run.outputTokens > 0 && (
        <span className="agent-foot-run">
          +{' '}
          {usageLine([
            {
              currency: run.costCurrency,
              calls: 0,
              inputTokens: run.inputTokens,
              outputTokens: run.outputTokens,
              cacheReadTokens: run.cacheReadTokens,
              cacheWriteTokens: run.cacheWriteTokens,
              costMicros: run.costCurrency ? run.costMicros : null,
              hasUnpriced: !run.costCurrency,
            },
          ])}{' '}
          {u.usage.runNow}
        </span>
      )}
    </div>
  );
}

/** Ponto com a cor do agente. */
export function AgentDot({ slot }: { slot: number | null | undefined }) {
  return <span className="agent-dot" style={{ background: agentColor(slot) }} aria-hidden />;
}
