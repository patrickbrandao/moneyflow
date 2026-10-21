import { DEFAULT_REMINDER_SOUND, type ReminderSettingsDto, t } from '@moneyflow/shared';
import { AlarmClock, Volume2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError } from '../domain';
import { previewSound, soundName, useSounds } from '../notes/sounds';
import { Button, Field, Panel } from '../ui';

const U = t.notes.ui;

/** Minha conta → Lembretes (spec 035): som padrão (com "Ouvir") e os segundos padrão do loop. */
export function ReminderSettingsPanel() {
  const settings = useApi<ReminderSettingsDto>('/api/account/reminder-settings');
  const sounds = useSounds();
  const [sound, setSound] = useState('');
  const [seconds, setSeconds] = useState('');
  const { run, busy } = useAction();

  useEffect(() => {
    if (!settings.data) return;
    setSound(settings.data.sound ?? '');
    setSeconds(String(settings.data.ringSeconds));
  }, [settings.data]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () => api.put<ReminderSettingsDto>('/api/account/reminder-settings', { sound: sound || null, ringSeconds: Number(seconds) }),
      U.settingsSaved,
    );
    if (saved) settings.setData(saved);
  }

  return (
    <Panel title={U.settingsTitle} icon={<AlarmClock />}>
      <p className="panel-hint">{U.settingsHint}</p>
      {settings.error ? (
        <LoadError error={settings.error} onRetry={() => void settings.reload()} />
      ) : (
        <form onSubmit={submit} className="form-grid mt-3" data-testid="account-reminders">
          <div className="form-grid cols-2">
            <Field label={t.notes.fields.sound}>
              <span className="flex gap-2">
                <select className="field" value={sound} onChange={(e) => setSound(e.target.value)} disabled={!settings.data}>
                  <option value="">{U.systemDefault(soundName(DEFAULT_REMINDER_SOUND))}</option>
                  {sounds.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <Button variant="ghost" onClick={() => previewSound(sound || DEFAULT_REMINDER_SOUND)}>
                  <Volume2 /> {U.listen}
                </Button>
              </span>
            </Field>
            <Field label={t.notes.fields.ringSeconds}>
              <input
                type="number"
                className="field"
                min={5}
                max={600}
                required
                value={seconds}
                onChange={(e) => setSeconds(e.target.value)}
                disabled={!settings.data}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !settings.data}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
