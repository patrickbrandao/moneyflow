import { formatDuration, RECORDING_MAX_MS, RECORDING_WARN_MS, t } from '@moneyflow/shared';
import { AlertTriangle, Check, Mic, RotateCcw, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui';
import { AudioPlayer } from './AudioPlayer';

const u = t.agentsUi.media;

/*
 * Gravação pelo microfone (spec 025): MediaRecorder em WebM/Opus (ou MP4/AAC
 * no Safari), até 10 minutos — o cronômetro avisa aos 9 e para sozinho aos
 * 10. Antes de anexar dá para ouvir, descartar e gravar de novo. Sem
 * permissão, a mensagem explica como liberar o microfone. O áudio vira um
 * anexo como qualquer outro (o mesmo upload), com a duração medida aqui.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'review'; file: File; url: string; durationMs: number; limit: boolean }
  | { kind: 'error'; message: string };

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

const extension = (mime: string) => (mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm');

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function useAudioRecorder(onReady: (file: File, durationMs: number) => void) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitHit = useRef(false);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  }, []);

  const clearReview = useCallback(() => {
    setPhase((p) => {
      if (p.kind === 'review') URL.revokeObjectURL(p.url);
      return { kind: 'idle' };
    });
  }, []);

  const stop = useCallback(() => {
    const rec = recorder.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const start = useCallback(async () => {
    clearReview();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhase({ kind: 'error', message: u.micUnavailable });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setPhase({ kind: 'error', message: u.recorderUnsupported });
      return;
    }
    setPhase({ kind: 'starting' });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      setPhase({
        kind: 'error',
        message: name === 'NotAllowedError' || name === 'SecurityError' ? u.micDenied : u.micUnavailable,
      });
      return;
    }
    stream.current = media;
    const mime = pickMime();
    const rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const startedAt = performance.now();
    limitHit.current = false;
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    rec.onstop = () => {
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      release();
      const type = (rec.mimeType || mime || 'audio/webm').split(';')[0]!.replace('video/', 'audio/');
      const blob = new Blob(chunks, { type });
      const file = new File([blob], `${u.recordingName(stamp())}.${extension(type)}`, { type });
      setPhase({ kind: 'review', file, url: URL.createObjectURL(blob), durationMs, limit: limitHit.current });
    };
    recorder.current = rec;
    rec.start(1000);
    setElapsed(0);
    setPhase({ kind: 'recording', startedAt });
    timer.current = setInterval(() => {
      const now = performance.now() - startedAt;
      setElapsed(now);
      if (now >= RECORDING_MAX_MS && rec.state === 'recording') {
        limitHit.current = true;
        rec.stop();
      }
    }, 250);
  }, [clearReview, release]);

  const use = useCallback(() => {
    if (phase.kind !== 'review') return;
    onReady(phase.file, phase.durationMs);
    URL.revokeObjectURL(phase.url);
    setPhase({ kind: 'idle' });
  }, [phase, onReady]);

  // Fechar a janela no meio da gravação solta o microfone.
  useEffect(
    () => () => {
      const rec = recorder.current;
      if (rec && rec.state !== 'inactive') {
        rec.onstop = null;
        rec.stop();
      }
      release();
    },
    [release],
  );

  return { phase, elapsed, start, stop, discard: clearReview, use, dismiss: clearReview };
}

export type AudioRecorderState = ReturnType<typeof useAudioRecorder>;

/** Botão do microfone no compositor (gravar / parar). */
export function RecordButton({ recorder, disabled }: { recorder: AudioRecorderState; disabled?: boolean }) {
  const recording = recorder.phase.kind === 'recording';
  return (
    <button
      type="button"
      className={recording ? 'icon-btn agent-rec-on' : 'icon-btn'}
      title={recording ? u.stopRecording : u.record}
      aria-label={recording ? u.stopRecording : u.record}
      aria-pressed={recording}
      disabled={disabled || recorder.phase.kind === 'starting' || recorder.phase.kind === 'review'}
      onClick={() => (recording ? recorder.stop() : void recorder.start())}
      data-testid="agent-record"
    >
      {recording ? <Square /> : <Mic />}
    </button>
  );
}

/** Faixa acima do compositor: cronômetro, revisão (ouvir, descartar, regravar, anexar) ou o erro do microfone. */
export function RecorderPanel({ recorder }: { recorder: AudioRecorderState }) {
  const { phase, elapsed } = recorder;
  if (phase.kind === 'idle' || phase.kind === 'starting') return null;
  if (phase.kind === 'error') {
    return (
      <div className="agent-rec notice warn" role="alert" data-testid="agent-record-error">
        <AlertTriangle className="size-4 flex-none" />
        <span className="flex-1">{phase.message}</span>
        <button type="button" className="row-action" aria-label={t.common.close} onClick={recorder.dismiss}>
          <X />
        </button>
      </div>
    );
  }
  if (phase.kind === 'recording') {
    const warn = elapsed >= RECORDING_WARN_MS;
    return (
      <div className="agent-rec" data-testid="agent-recording">
        <span className="agent-rec-dot" aria-hidden />
        <span className="mono">
          {u.recording} {formatDuration(elapsed)} / {formatDuration(RECORDING_MAX_MS)}
        </span>
        {warn && (
          <span className="agent-rec-warn" role="status">
            {u.recordingWarn}
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={recorder.stop} data-testid="agent-record-stop">
          <Square /> {u.stopRecording}
        </Button>
      </div>
    );
  }
  return (
    <div className="agent-rec review" data-testid="agent-record-review">
      {phase.limit && <p className="agent-rec-warn w-full">{u.recordingLimit}</p>}
      <AudioPlayer src={phase.url} durationMs={phase.durationMs} label={phase.file.name} testId="agent-record-player" />
      <div className="agent-rec-actions">
        <Button size="sm" variant="ghost" onClick={recorder.discard} data-testid="agent-record-discard">
          <Trash2 /> {u.discard}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void recorder.start()} data-testid="agent-record-again">
          <RotateCcw /> {u.rerecord}
        </Button>
        <Button size="sm" onClick={recorder.use} data-testid="agent-record-use">
          <Check /> {u.useRecording}
        </Button>
      </div>
    </div>
  );
}
