import { DEFAULT_REMINDER_SOUND, REMINDER_SOUNDS, t } from '@moneyflow/shared';
import { useEffect, useState } from 'react';

/*
 * Sons dos lembretes (spec 035): apps/web/public/sounds/manifest.json lista
 * chave, nome e arquivo. Um som novo é o arquivo e a linha no manifest; uma
 * chave que sumiu cai no padrão. "Ouvir" toca uma vez; o alarme toca em loop
 * (ReminderAlarm).
 */

export type SoundEntry = { key: string; name: string; file: string; license?: string };
type Manifest = { default?: string; sounds: SoundEntry[] };

/** Antes do manifest chegar (ou se ele falhar): os sons da primeira entrega. */
const FALLBACK: Manifest = {
  default: DEFAULT_REMINDER_SOUND,
  sounds: REMINDER_SOUNDS.map((key) => ({ key, name: t.notes.sounds[key] ?? key, file: `${key}.wav` })),
};

let manifest: Manifest = FALLBACK;
let loading: Promise<Manifest> | null = null;

export function loadSoundManifest(): Promise<Manifest> {
  loading ??= fetch('/sounds/manifest.json')
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : FALLBACK))
    .then((m) => {
      manifest = Array.isArray(m.sounds) && m.sounds.length > 0 ? m : FALLBACK;
      return manifest;
    })
    .catch(() => FALLBACK);
  return loading;
}

/** A lista de sons (o manifest, quando chegar). */
export function useSounds(): SoundEntry[] {
  const [sounds, setSounds] = useState(manifest.sounds);
  useEffect(() => {
    let alive = true;
    void loadSoundManifest().then((m) => alive && setSounds(m.sounds));
    return () => {
      alive = false;
    };
  }, []);
  return sounds;
}

/** O som da chave; ausente no manifest = o padrão. */
export function resolveSound(key: string | null | undefined): SoundEntry {
  const list = manifest.sounds;
  return (
    list.find((s) => s.key === key) ??
    list.find((s) => s.key === (manifest.default ?? DEFAULT_REMINDER_SOUND)) ??
    list[0] ??
    FALLBACK.sounds[0]!
  );
}

export const soundUrl = (key: string | null | undefined) => `/sounds/${resolveSound(key).file}`;
export const soundName = (key: string | null | undefined) => resolveSound(key).name;

let preview: HTMLAudioElement | null = null;

/** "Ouvir": toca o som uma vez (para o anterior). */
export function previewSound(key: string | null | undefined) {
  preview?.pause();
  void loadSoundManifest().then(() => {
    preview = new Audio(soundUrl(key));
    void preview.play().catch(() => null);
  });
}
