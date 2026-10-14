import { AUDIO_RATE_STORAGE_KEY, AUDIO_RATES, formatDuration, t } from '@moneyflow/shared';
import { AlertTriangle, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cx } from '../components/ui';

const u = t.agentsUi.media;

/*
 * Player de áudio do chat (spec 025): play/pausa, barra de progresso (clicar e
 * arrastar), tempo atual e total e as velocidades 0.5x–3x, lembradas no
 * navegador (moneyflow:audio-rate) para os próximos áudios. Um áudio tocando
 * pausa o que tocava antes. Toca um arquivo ou vários trechos em sequência
 * (o áudio gerado de uma mensagem longa), como se fossem um só.
 */

/* ---------------- velocidade lembrada ---------------- */

const rateListeners = new Set<() => void>();

function readRate(): number {
  try {
    const raw = Number(localStorage.getItem(AUDIO_RATE_STORAGE_KEY));
    return (AUDIO_RATES as readonly number[]).includes(raw) ? raw : 1;
  } catch {
    return 1;
  }
}

let currentRate = typeof window === 'undefined' ? 1 : readRate();

function setRate(rate: number) {
  currentRate = rate;
  try {
    localStorage.setItem(AUDIO_RATE_STORAGE_KEY, String(rate));
  } catch {
    // sem storage: vale só nesta aba
  }
  for (const listener of rateListeners) listener();
}

function useAudioRate(): number {
  return useSyncExternalStore(
    (listener) => {
      rateListeners.add(listener);
      return () => rateListeners.delete(listener);
    },
    () => currentRate,
    () => 1,
  );
}

/* ---------------- um tocando por vez ---------------- */

let playingNow: HTMLAudioElement | null = null;

function claimPlayback(el: HTMLAudioElement) {
  if (playingNow && playingNow !== el && !playingNow.paused) playingNow.pause();
  playingNow = el;
}

/* ---------------- player ---------------- */

export type AudioPlayerProps = {
  /** Um arquivo ou os trechos, tocados em sequência. */
  src: string | string[];
  /** Duração conhecida (o WebM gravado pelo navegador não informa a dele). */
  durationMs?: number | null;
  label?: string;
  autoPlay?: boolean;
  className?: string;
  testId?: string;
};

const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function AudioPlayer({ src, durationMs, label, autoPlay, className, testId = 'audio-player' }: AudioPlayerProps) {
  const sources = useMemo(() => (Array.isArray(src) ? src : [src]), [src]);
  const key = sources.join('|');
  const audio = useRef<HTMLAudioElement>(null);
  const rate = useAudioRate();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [durations, setDurations] = useState<number[]>([]);
  const [error, setError] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const resume = useRef(Boolean(autoPlay));
  const pendingSeek = useRef<number | null>(null);

  // Duração de cada trecho (metadados), para a barra cobrir todos.
  useEffect(() => {
    setIndex(0);
    setTime(0);
    setError(false);
    if (sources.length === 1) {
      setDurations([]);
      return;
    }
    const probes = sources.map((url, i) => {
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => setDurations((list) => Object.assign([...list], { [i]: finite(probe.duration) }));
      probe.src = url;
      return probe;
    });
    return () => {
      for (const probe of probes) probe.src = '';
    };
  }, [key]);

  const fallback = sources.length === 1 && durationMs ? durationMs / 1000 : 0;
  const lengths = sources.map((_, i) => durations[i] ?? 0);
  const total = sources.length === 1 ? finite(lengths[0] ?? 0) || fallback : lengths.reduce((a, b) => a + b, 0);
  const offset = lengths.slice(0, index).reduce((a, b) => a + b, 0);
  const position = scrub ?? offset + time;

  // A velocidade escolhida vale para todos os players.
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  // Pausa ao desmontar (fechar a janela, trocar de conversa).
  useEffect(() => {
    const el = audio.current;
    return () => {
      el?.pause();
      if (playingNow === el) playingNow = null;
    };
  }, []);

  // Trecho novo carregado: continua tocando e aplica a busca pendente.
  const onLoaded = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    el.playbackRate = currentRate;
    if (sources.length === 1) setDurations([finite(el.duration)]);
    else if (finite(el.duration)) setDurations((list) => Object.assign([...list], { [index]: finite(el.duration) }));
    if (pendingSeek.current !== null) {
      el.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
    if (resume.current) {
      resume.current = false;
      void el.play().catch(() => setPlaying(false));
    }
  }, [index, sources.length]);

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      el.playbackRate = currentRate;
      void el.play().catch(() => setError(true));
    } else el.pause();
  }

  function seek(seconds: number) {
    const el = audio.current;
    if (!el) return;
    const target = Math.max(0, Math.min(seconds, total || seconds));
    if (sources.length === 1) {
      el.currentTime = target;
      setTime(target);
      return;
    }
    // Acha o trecho da posição pedida.
    let acc = 0;
    let part = sources.length - 1;
    for (let i = 0; i < sources.length; i += 1) {
      if (target < acc + (lengths[i] ?? 0) || i === sources.length - 1) {
        part = i;
        break;
      }
      acc += lengths[i] ?? 0;
    }
    const within = Math.max(0, target - acc);
    if (part === index) {
      el.currentTime = within;
      setTime(within);
    } else {
      pendingSeek.current = within;
      resume.current = !el.paused;
      setIndex(part);
      setTime(within);
    }
  }

  function onEnded() {
    if (index < sources.length - 1) {
      resume.current = true;
      setIndex(index + 1);
      setTime(0);
      return;
    }
    setPlaying(false);
    setIndex(0);
    setTime(0);
    if (audio.current) audio.current.currentTime = 0;
  }

  return (
    <div
      className={cx('audio-player', className)}
      data-testid={testId}
      data-playing={playing ? 'true' : 'false'}
      data-rate={rate}
      role="group"
      aria-label={label}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: áudio de conversa; a transcrição aparece logo abaixo */}
      <audio
        ref={audio}
        src={sources[index]}
        preload="metadata"
        onLoadedMetadata={onLoaded}
        onDurationChange={(e) => sources.length === 1 && finite(e.currentTarget.duration) && setDurations([e.currentTarget.duration])}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={(e) => {
          claimPlayback(e.currentTarget);
          setPlaying(true);
          setError(false);
        }}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        onError={() => setError(true)}
      />
      <button
        type="button"
        className="audio-btn"
        onClick={toggle}
        aria-label={playing ? u.pause : u.play}
        title={playing ? u.pause : u.play}
        data-testid="audio-toggle"
      >
        {playing ? <Pause /> : <Play />}
      </button>
      <input
        type="range"
        className="audio-seek"
        min={0}
        max={total || 1}
        step={0.01}
        value={Math.min(position, total || 1)}
        disabled={!total}
        aria-label={u.seek}
        aria-valuetext={`${formatDuration(position * 1000)} / ${formatDuration(total * 1000)}`}
        onChange={(e) => setScrub(Number(e.target.value))}
        onPointerUp={() => {
          if (scrub !== null) seek(scrub);
          setScrub(null);
        }}
        onKeyUp={() => {
          if (scrub !== null) seek(scrub);
          setScrub(null);
        }}
        onBlur={() => setScrub(null)}
        style={{ ['--audio-pct' as string]: `${total ? Math.min(100, (position / total) * 100) : 0}%` }}
      />
      <span className="audio-time mono" data-testid="audio-time">
        {formatDuration(position * 1000)} / {formatDuration(total * 1000)}
      </span>
      <select
        className="audio-rate"
        value={String(rate)}
        onChange={(e) => setRate(Number(e.target.value))}
        aria-label={u.speed}
        title={u.speed}
        data-testid="audio-rate"
      >
        {AUDIO_RATES.map((r) => (
          <option key={r} value={String(r)}>
            {u.speedOption(r)}
          </option>
        ))}
      </select>
      {error && (
        <span className="audio-error" title={u.audioError} role="img" aria-label={u.audioError}>
          <AlertTriangle />
        </span>
      )}
    </div>
  );
}
