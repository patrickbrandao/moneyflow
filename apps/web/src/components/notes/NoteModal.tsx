import {
  DEFAULT_RING_SECONDS,
  describeReminder,
  formatDateTime,
  NOTE_KIND_ORDER,
  NOTE_REMINDER_DEFAULTS,
  NOTE_REPEATS,
  type NoteDto,
  type NoteKind,
  type NoteReminderValues,
  type NoteRepeat,
  type NoteScope,
  normalizeReminder,
  type ReminderSettingsDto,
  t,
} from '@moneyflow/shared';
import { Archive, ArchiveRestore, Code, Eye, Volume2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Markdown } from '../../agents/Markdown';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { LoadError } from '../domain';
import { type EntityOption, EntityPicker, FormError, ModalActions } from '../forms';
import { Button, cx, Field, Modal, Skel, Tabs } from '../ui';
import { NoteKindDot } from './kinds';
import { previewSound, soundName, useSounds } from './sounds';

/*
 * A janela da anotação (spec 035): guias Anotação (tipo, título, entidade,
 * data, corpo em markdown bruto/renderizado), Lembrete (só no tipo lembrete)
 * e Escopo (privada/global, autor e datas). Somente leitura sem canEdit.
 * No lembrete, o início da vigência é a própria data da anotação.
 */

const U = t.notes.ui;
const FL = t.notes.fields;

type Reminder = Omit<NoteReminderValues, 'startsOn'>;
type Form = {
  kind: NoteKind;
  title: string;
  body: string;
  noteDate: string;
  entity: EntityOption | null;
  scope: NoteScope;
  reminder: Reminder;
};

const fromNote = (note: NoteDto): Form => ({
  kind: note.kind,
  title: note.title,
  body: note.body ?? '',
  noteDate: note.noteDate,
  entity: { id: note.object.id, name: note.object.name },
  scope: note.scope,
  reminder: note.reminder
    ? {
        timeOfDay: note.reminder.timeOfDay.slice(0, 5),
        repeat: note.reminder.repeat,
        everyNDays: note.reminder.everyNDays,
        monthDay: note.reminder.monthDay,
        endsOn: note.reminder.endsOn,
        sound: note.reminder.sound,
        ringSeconds: note.reminder.ringSeconds,
        sendTelegram: note.reminder.sendTelegram,
        isActive: note.reminder.isActive,
      }
    : { ...NOTE_REMINDER_DEFAULTS },
});

export function NoteModal({
  noteId,
  defaults,
  onClose,
  onSaved,
  onChanged,
}: {
  noteId: string | null;
  defaults: { noteDate: string; entity: EntityOption | null };
  onClose: () => void;
  onSaved: (note: NoteDto) => void;
  onChanged?: () => void;
}) {
  const existing = useApi<NoteDto>(noteId ? `/api/notes/${noteId}` : null);
  const settings = useApi<ReminderSettingsDto>('/api/account/reminder-settings');
  const note = noteId ? existing.data : undefined;
  const [form, setForm] = useState<Form | null>(
    noteId
      ? null
      : {
          kind: 'info',
          title: '',
          body: '',
          noteDate: defaults.noteDate,
          entity: defaults.entity,
          scope: 'private',
          reminder: { ...NOTE_REMINDER_DEFAULTS },
        },
  );
  const [tab, setTab] = useState<'note' | 'reminder' | 'scope'>('note');
  const [bodyView, setBodyView] = useState<'raw' | 'rendered'>(noteId ? 'rendered' : 'raw');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const sounds = useSounds();

  useEffect(() => {
    if (note) setForm(fromNote(note));
  }, [note]);

  const readOnly = Boolean(note && (!note.canEdit || note.archivedAt));
  const title = noteId ? (note?.title ?? U.editTitle) : t.notes.newNote;

  if (noteId && existing.error) {
    return (
      <Modal open title={U.editTitle} onClose={onClose}>
        <LoadError error={existing.error} onRetry={() => void existing.reload()} />
      </Modal>
    );
  }
  if (!form) {
    return (
      <Modal open title={U.editTitle} onClose={onClose} wide>
        <Skel h={220} />
      </Modal>
    );
  }

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setReminder = (patch: Partial<Reminder>) => setForm((f) => (f ? { ...f, reminder: { ...f.reminder, ...patch } } : f));
  const r = form.reminder;
  const { value: reminderValue, problems } = normalizeReminder({ ...r, startsOn: form.noteDate });
  const isReminder = form.kind === 'reminder';
  const description = describeReminder(reminderValue);
  const defaultSound = settings.data?.effectiveSound ?? null;
  const defaultSeconds = settings.data?.ringSeconds ?? DEFAULT_RING_SECONDS;
  const hasTelegram = settings.data?.hasPersonalTelegram ?? false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (readOnly || !form) return;
    if (!form.entity) {
      setError(U.entityRequired);
      setTab('note');
      return;
    }
    if (isReminder && problems.length > 0) {
      setError(problems.join(' '));
      setTab('reminder');
      return;
    }
    setError(null);
    const payload = {
      kind: form.kind,
      title: form.title,
      body: form.body,
      noteDate: form.noteDate,
      objectType: 'entity' as const,
      objectId: form.entity.id,
      scope: form.scope,
      ...(isReminder ? { reminder: { ...reminderValue } } : {}),
    };
    const result = await run(
      () => (noteId ? api.patch<NoteDto>(`/api/notes/${noteId}`, payload) : api.post<NoteDto>('/api/notes', payload)),
      noteId ? U.saved : U.created,
    );
    if (result) onSaved(result);
  }

  async function toggleArchive() {
    if (!note) return;
    const archive = !note.archivedAt;
    const result = await run(
      () => api.post<NoteDto>(`/api/notes/${note.id}/${archive ? 'archive' : 'unarchive'}`),
      archive ? U.archived : U.unarchived,
    );
    if (result) {
      existing.setData(result);
      onChanged?.();
    }
  }

  const tabs = [
    { key: 'note', label: U.tabs.note },
    ...(isReminder ? [{ key: 'reminder', label: U.tabs.reminder }] : []),
    { key: 'scope', label: U.tabs.scope },
  ];
  const currentTab = tab === 'reminder' && !isReminder ? 'note' : tab;

  return (
    <Modal open title={title} onClose={onClose} wide>
      <form onSubmit={submit} className="note-form">
        {note && !note.canEdit && <p className="notice info mb-3">{U.readOnly}</p>}
        {note?.archivedAt && <p className="notice mb-3">{U.archivedNotice}</p>}
        <Tabs items={tabs} value={currentTab} onChange={(key) => setTab(key as typeof tab)} />
        <fieldset disabled={readOnly} className="form-grid note-fieldset">
          {currentTab === 'note' && (
            <>
              <div>
                <span className="label">{FL.kind}</span>
                <div className="note-chips" role="radiogroup" aria-label={FL.kind}>
                  {NOTE_KIND_ORDER.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={form.kind === kind}
                      className={cx('note-chip', form.kind === kind && 'active')}
                      onClick={() => set({ kind })}
                      disabled={readOnly}
                    >
                      <NoteKindDot kind={kind} />
                      {t.notes.kinds[kind]}
                    </button>
                  ))}
                </div>
              </div>
              <Field label={FL.title}>
                <input
                  className="field"
                  value={form.title}
                  maxLength={120}
                  required
                  autoFocus={!noteId}
                  onChange={(e) => set({ title: e.target.value })}
                />
              </Field>
              <div className="form-grid cols-2">
                <div>
                  <span className="label">{FL.entity}</span>
                  {readOnly ? (
                    <input className="field" value={form.entity?.name ?? ''} readOnly aria-label={FL.entity} />
                  ) : (
                    <EntityPicker value={form.entity} onChange={(entity) => set({ entity })} ariaLabel={FL.entity} />
                  )}
                </div>
                <Field label={isReminder ? FL.startsOn : FL.noteDate} hint={isReminder ? U.startsOnHint : undefined}>
                  <input type="date" className="field" value={form.noteDate} required onChange={(e) => set({ noteDate: e.target.value })} />
                </Field>
              </div>
            </>
          )}

          {currentTab === 'reminder' && isReminder && (
            <>
              <p className="notice info" data-testid="reminder-description">
                {U.reminderSummary}: {description}
              </p>
              <div className="form-grid cols-2">
                <Field label={FL.timeOfDay}>
                  <input
                    type="time"
                    className="field"
                    value={r.timeOfDay}
                    required
                    onChange={(e) => setReminder({ timeOfDay: e.target.value })}
                  />
                </Field>
                <Field label={FL.repeat}>
                  <select className="field" value={r.repeat} onChange={(e) => setReminder({ repeat: e.target.value as NoteRepeat })}>
                    {NOTE_REPEATS.map((repeat) => (
                      <option key={repeat} value={repeat}>
                        {t.notes.repeats[repeat]}
                      </option>
                    ))}
                  </select>
                </Field>
                {r.repeat === 'every_n_days' && (
                  <Field label={FL.everyNDays}>
                    <input
                      type="number"
                      className="field"
                      min={2}
                      max={365}
                      value={r.everyNDays ?? ''}
                      onChange={(e) => setReminder({ everyNDays: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                )}
                {r.repeat === 'monthly_day' && (
                  <Field label={FL.monthDay}>
                    <input
                      type="number"
                      className="field"
                      min={1}
                      max={31}
                      value={r.monthDay ?? ''}
                      onChange={(e) => setReminder({ monthDay: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                )}
                <Field label={FL.startsOn} hint={U.startsOnHint}>
                  <input type="date" className="field" value={form.noteDate} required onChange={(e) => set({ noteDate: e.target.value })} />
                </Field>
                {r.repeat !== 'once' && (
                  <Field label={`${FL.endsOn} (${t.common.optional})`}>
                    <input
                      type="date"
                      className="field"
                      value={r.endsOn ?? ''}
                      min={form.noteDate}
                      onChange={(e) => setReminder({ endsOn: e.target.value || null })}
                    />
                  </Field>
                )}
                <Field label={FL.sound}>
                  <span className="flex gap-2">
                    <select className="field" value={r.sound ?? ''} onChange={(e) => setReminder({ sound: e.target.value || null })}>
                      <option value="">{U.soundDefault(soundName(defaultSound))}</option>
                      {sounds.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <Button variant="ghost" onClick={() => previewSound(r.sound ?? defaultSound)}>
                      <Volume2 /> {U.listen}
                    </Button>
                  </span>
                </Field>
                <Field label={FL.ringSeconds} hint={U.secondsDefault(defaultSeconds)}>
                  <input
                    type="number"
                    className="field"
                    min={5}
                    max={600}
                    placeholder={U.secondsPlaceholder}
                    value={r.ringSeconds ?? ''}
                    onChange={(e) => setReminder({ ringSeconds: e.target.value ? Number(e.target.value) : null })}
                  />
                </Field>
              </div>
              <div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={r.sendTelegram}
                    disabled={!hasTelegram && !r.sendTelegram}
                    onChange={(e) => setReminder({ sendTelegram: e.target.checked })}
                  />{' '}
                  {FL.sendTelegram}
                </label>
                {!hasTelegram && <span className="hint">{U.telegramDisabled}</span>}
              </div>
              <div>
                <label className="check">
                  <input type="checkbox" checked={r.isActive} onChange={(e) => setReminder({ isActive: e.target.checked })} /> {FL.isActive}
                </label>
                <span className="hint">{U.activeHint}</span>
              </div>
            </>
          )}

          {currentTab === 'scope' && (
            <>
              <div className="note-scope" role="radiogroup" aria-label={FL.scope}>
                {(['private', 'global'] as const).map((scope) => (
                  <label key={scope} className={cx('note-scope-opt', form.scope === scope && 'active')}>
                    <input type="radio" name="note-scope" checked={form.scope === scope} onChange={() => set({ scope })} />
                    <span>
                      <span className="block font-medium text-ink">{t.notes.scopes[scope]}</span>
                      <span className="hint">{scope === 'private' ? U.scopePrivateHint : U.scopeGlobalHint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {note && (
                <dl className="kv">
                  <dt>{FL.author}</dt>
                  <dd>@{note.authorUsername}</dd>
                  <dt>{U.createdAt}</dt>
                  <dd>{formatDateTime(note.createdAt)}</dd>
                  <dt>{U.updatedAt}</dt>
                  <dd>{formatDateTime(note.updatedAt)}</dd>
                </dl>
              )}
            </>
          )}
        </fieldset>
        {currentTab === 'note' && (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="label">{FL.body}</span>
              <div className="segmented" role="group" aria-label={FL.body}>
                <button
                  type="button"
                  className={cx(bodyView === 'raw' && 'active')}
                  aria-pressed={bodyView === 'raw'}
                  onClick={() => setBodyView('raw')}
                >
                  <Code aria-hidden /> {U.bodyRaw}
                </button>
                <button
                  type="button"
                  className={cx(bodyView === 'rendered' && 'active')}
                  aria-pressed={bodyView === 'rendered'}
                  onClick={() => setBodyView('rendered')}
                >
                  <Eye aria-hidden /> {U.bodyRendered}
                </button>
              </div>
            </div>
            {bodyView === 'raw' ? (
              readOnly ? (
                <pre className="note-raw">{form.body || U.bodyEmpty}</pre>
              ) : (
                <textarea
                  className="field note-body"
                  value={form.body}
                  rows={8}
                  placeholder={U.bodyPlaceholder}
                  aria-label={FL.body}
                  onChange={(e) => set({ body: e.target.value })}
                />
              )
            ) : (
              <div className="note-rendered contract-md">
                {form.body.trim() ? <Markdown text={form.body} /> : <p className="text-faint">{U.bodyEmpty}</p>}
              </div>
            )}
          </div>
        )}
        <FormError>{error}</FormError>
        <ModalActions>
          {note?.canEdit && (
            <Button variant="quiet" className="mr-auto" onClick={() => void toggleArchive()} disabled={busy}>
              {note.archivedAt ? <ArchiveRestore /> : <Archive />} {note.archivedAt ? U.unarchive : U.archive}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {readOnly ? t.common.close : t.common.cancel}
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={busy || !form.title.trim()}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          )}
        </ModalActions>
      </form>
    </Modal>
  );
}
