import { formatDateTime, type ReminderFiringDto, type ReminderFiringList, SNOOZE_PRESETS, t } from '@moneyflow/shared';
import { AlarmClock, CheckCheck, NotebookPen, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { readStored, writeStored } from '../../lib/storage';
import { cx, EmptyState, useClickOutside, usePolling } from '../ui';
import { NoteKindDot } from './kinds';
import { loadSoundManifest, soundUrl } from './sounds';

/*
 * O alarme dos lembretes (spec 035), no topo entre o tema e os agentes.
 *
 * - Sondagem de GET /api/note-reminders/firings: a aba líder a cada 20 s
 *   (mesmo em segundo plano, para tocar), as outras a cada 30 s com a aba
 *   visível e ao focar; a líder repassa a lista às outras pelo BroadcastChannel.
 * - Uma aba toca: a líder, eleita pelo Web Locks (sem Web Locks ou sem
 *   BroadcastChannel, cada aba é líder dela mesma e toca).
 * - Disparo com shouldRing ainda não tocado (chave id + último toque, guardada
 *   no localStorage para outra aba líder não repetir): o som em loop pelos
 *   segundos do disparo e o popover aberto. Dispensar e adiar (em qualquer aba)
 *   recarregam todas; o som para quando nenhum disparo tocando continua com
 *   shouldRing. "Parar o som" deixa o disparo não lido.
 * - Autoplay recusado: o ícone pisca com "Clique para ativar o som do alarme"
 *   em todas as abas; o próximo clique (em qualquer uma) toca ali.
 */

const CHANNEL = 'moneyflow:reminders';
const LOCK = 'moneyflow:reminder-leader';
const RUNG_KEY = 'reminders:rung';
const LEADER_POLL_MS = 20_000;
const FOLLOWER_POLL_MS = 30_000;

type Ring = { ids: string[]; sound: string; endsAt: number; blocked: boolean };
type Message =
  | { type: 'list'; data: ReminderFiringList }
  | { type: 'changed' }
  | { type: 'ring'; ring: Ring; player: string | null }
  | { type: 'stop' };

const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());
const ringKey = (f: ReminderFiringDto) => `${f.id}:${f.lastFiredAt}`;

/** A aba líder (a que sonda em segundo plano e toca), pelo Web Locks. */
function useLeader(): boolean {
  const supported = typeof navigator !== 'undefined' && 'locks' in navigator && typeof BroadcastChannel !== 'undefined';
  const [leader, setLeader] = useState(!supported);
  useEffect(() => {
    if (!supported) return;
    let release: (() => void) | null = null;
    let cancelled = false;
    const abort = new AbortController();
    navigator.locks
      .request(LOCK, { signal: abort.signal }, () => {
        if (cancelled) return;
        setLeader(true);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => null);
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
      setLeader(false);
    };
  }, [supported]);
  return leader;
}

export function ReminderAlarm() {
  const [data, setData] = useState<ReminderFiringList | null>(null);
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState<Ring | null>(null);
  const leader = useLeader();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const ringRef = useRef<Ring | null>(null);
  ringRef.current = ring;
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const post = useCallback((message: Message) => {
    try {
      channel.current?.postMessage(message);
    } catch {
      /* canal fechado */
    }
  }, []);

  const load = useCallback(async () => {
    const list = await api.get<ReminderFiringList>('/api/note-reminders/firings', { limit: 30 }).catch(() => null);
    if (list) {
      setData(list);
      post({ type: 'list', data: list });
    }
  }, [post]);

  const stopAudio = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
  }, []);

  /** Toca o som do alarme nesta aba; recusado pelo navegador, marca o aviso de autoplay em todas. */
  const playHere = useCallback(
    (next: Ring) => {
      stopAudio();
      void loadSoundManifest().then(() => {
        if (ringRef.current?.endsAt !== next.endsAt) return;
        const el = new Audio(soundUrl(next.sound));
        el.loop = true;
        audio.current = el;
        el.play().then(
          () => {
            const playing = { ...next, blocked: false };
            setRing(playing);
            post({ type: 'ring', ring: playing, player: TAB_ID });
          },
          () => {
            if (audio.current === el) audio.current = null;
            const blocked = { ...next, blocked: true };
            setRing(blocked);
            post({ type: 'ring', ring: blocked, player: null });
          },
        );
      });
    },
    [post, stopAudio],
  );

  const stop = useCallback(
    (broadcast = true) => {
      stopAudio();
      setRing(null);
      if (broadcast) post({ type: 'stop' });
    },
    [post, stopAudio],
  );

  // O canal entre as abas.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(CHANNEL);
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message.type === 'list') setData(message.data);
      else if (message.type === 'changed') void load();
      else if (message.type === 'stop') {
        stopAudio();
        setRing(null);
      } else if (message.type === 'ring') {
        // Outra aba tocou (ou ficou bloqueada): esta para o som dela.
        if (message.player !== TAB_ID) stopAudio();
        setRing(message.ring);
      }
    };
    return () => {
      bc.close();
      channel.current = null;
    };
  }, [load, stopAudio]);

  // Sondagem: a líder sempre (inclusive em segundo plano), as outras com a aba visível.
  useEffect(() => {
    if (!leader) return;
    void load();
    const timer = setInterval(() => void load(), LEADER_POLL_MS);
    return () => clearInterval(timer);
  }, [leader, load]);
  usePolling(load, FOLLOWER_POLL_MS, !leader);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // A líder toca os disparos novos com shouldRing.
  useEffect(() => {
    if (!leader || !data) return;
    const rung = new Set(readStored<string[]>(RUNG_KEY, []));
    const fresh = data.items.filter((f) => f.shouldRing && !rung.has(ringKey(f)));
    if (fresh.length === 0) return;
    writeStored(RUNG_KEY, [...fresh.map(ringKey), ...rung].slice(0, 200));
    const first = fresh[0]!;
    const ids = [...new Set([...(ringRef.current?.ids ?? []), ...fresh.map((f) => f.id)])];
    const next: Ring = { ids, sound: first.sound, endsAt: Date.now() + first.ringSeconds * 1000, blocked: false };
    setRing(next);
    ringRef.current = next;
    setOpen(true);
    playHere(next);
  }, [data, leader, playHere]);

  // Para quando nenhum disparo tocando continua com shouldRing (dispensado ou adiado em qualquer aba).
  useEffect(() => {
    if (!ring || !data) return;
    const still = ring.ids.filter((id) => data.items.find((f) => f.id === id)?.shouldRing);
    if (still.length === 0) stop(false);
    else if (still.length !== ring.ids.length) setRing({ ...ring, ids: still });
  }, [data, ring, stop]);

  // O tempo de toque acaba (cada aba pelo mesmo endsAt).
  useEffect(() => {
    if (!ring) return;
    const timer = setTimeout(() => stop(false), Math.max(0, ring.endsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [ring, stop]);

  // Autoplay bloqueado: o próximo clique nesta aba libera e toca aqui.
  useEffect(() => {
    if (!ring?.blocked) return;
    const unlock = () => {
      const current = ringRef.current;
      if (current?.blocked && current.endsAt > Date.now()) playHere({ ...current, blocked: false });
    };
    document.addEventListener('pointerdown', unlock, { capture: true, once: true });
    return () => document.removeEventListener('pointerdown', unlock, { capture: true });
  }, [ring?.blocked, playHere]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  async function act(fn: () => Promise<unknown>) {
    await fn().catch(() => null);
    await load();
    post({ type: 'changed' });
  }
  const dismiss = (f: ReminderFiringDto) => act(() => api.post(`/api/note-reminders/firings/${f.id}/dismiss`));
  const snooze = (f: ReminderFiringDto, minutes: number) => act(() => api.post(`/api/note-reminders/firings/${f.id}/snooze`, { minutes }));
  const readAll = () => act(() => api.post('/api/note-reminders/firings/read-all', {}));

  function openNote(f: ReminderFiringDto) {
    close();
    navigate(`/notes?note=${f.noteId}`);
  }

  const unread = data?.unread ?? 0;
  const A = t.notes.alarm;
  const ringing = ring !== null;
  const label = ring?.blocked ? A.unlock : A.label(unread);
  return (
    <div ref={ref} className="menu-anchor">
      <button
        type="button"
        className={cx('icon-btn bell-btn alarm-btn', ringing && 'ringing', ring?.blocked && 'blocked')}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={label}
        aria-label={label}
        data-testid="reminder-alarm"
      >
        <AlarmClock />
        {unread > 0 && <span className="n">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {ring?.blocked && (
        <span className="alarm-unlock" role="status">
          {A.unlock}
        </span>
      )}
      {open && (
        <div className="notif alarm-pop" role="dialog" aria-label={A.title}>
          <div className="nh">
            <span className="inline-flex items-center gap-2">
              {A.title}
              {ringing && !ring.blocked && <span className="alarm-live">{A.ringing}</span>}
            </span>
            <span className="inline-flex items-center gap-1">
              {ringing && (
                <button type="button" className="notif-readall" onClick={() => stop()}>
                  <VolumeX /> {A.stopSound}
                </button>
              )}
              {unread > 0 && (
                <button type="button" className="notif-readall" onClick={() => void readAll()}>
                  <CheckCheck /> {A.markAllRead}
                </button>
              )}
            </span>
          </div>
          <div className="nb">
            {data && data.items.length === 0 && <EmptyState icon={<AlarmClock />} title={A.empty} description={A.emptyHint} />}
            {data?.items.map((f) => (
              <div
                key={f.id}
                className={cx('ni alarm-item', !f.readAt && 'unread', ring?.ids.includes(f.id) && 'is-ringing')}
                data-firing={f.id}
              >
                <NoteKindDot kind={f.kind} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <button type="button" className="alarm-title" onClick={() => openNote(f)}>
                    {f.title}
                  </button>
                  {f.object && <span className="notif-body">{f.object.name}</span>}
                  <span className="w">
                    {A.scheduled(formatDateTime(f.scheduledFor))}
                    {f.snoozedUntil && !f.readAt && ` · ${A.snoozedUntil(formatDateTime(f.snoozedUntil))}`}
                    {f.snoozeCount > 0 && ` · ${t.notes.firing.snoozed(f.snoozeCount)}`}
                  </span>
                  {!f.readAt && (
                    <span className="alarm-actions">
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => void dismiss(f)}>
                        {A.dismiss}
                      </button>
                      {SNOOZE_PRESETS.map((m) => (
                        <button key={m} type="button" className="btn btn-quiet btn-sm" onClick={() => void snooze(f, m)}>
                          {A.snooze(m)}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
                {!f.readAt && <span className="notif-dot" aria-hidden />}
              </div>
            ))}
          </div>
          <div className="alarm-foot">
            <Link to="/notes" className="notif-readall" onClick={close}>
              <NotebookPen /> {A.openNotes}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
