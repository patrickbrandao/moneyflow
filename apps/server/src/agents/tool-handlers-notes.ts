import {
  diffRows,
  formatDate,
  formatDateTime,
  NOTE_REMINDER_DEFAULTS,
  type NOTE_TOOLS,
  type NoteDto,
  type PreviewField,
  type PreviewRow,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { notFound } from '../errors';
import * as notes from '../services/notes';
import { iso } from '../services/util';
import { type Handlers, nameOf } from './tool-helpers';

/*
 * Tools das anotações e dos lembretes (spec 035, categoria Anotações) sobre o
 * serviço notes.ts: o Access do usuário decide o que ele vê (as próprias e as
 * globais; o admin, todas) e o que edita (as próprias; o admin, todas); os
 * disparos são sempre do próprio usuário. As prévias leem a nota pelo mesmo
 * serviço (404/403 antes do cartão).
 */

type NoteToolName = (typeof NOTE_TOOLS)[number]['name'];

const N = t.notes;
const F = N.fields;

const NOTE_FIELDS: PreviewField[] = [
  { key: 'kind', label: F.kind, format: (v) => N.kinds[String(v)] ?? String(v) },
  { key: 'title', label: F.title },
  { key: 'entity', label: F.entity },
  { key: 'noteDate', label: F.noteDate, format: 'date' },
  { key: 'scope', label: F.scope, format: (v) => N.scopes[String(v)] ?? String(v) },
  { key: 'body', label: F.body, format: (v) => (String(v).length > 200 ? `${String(v).slice(0, 200)}…` : String(v)) },
  { key: 'repeatText', label: F.repeat },
  { key: 'sound', label: F.sound, format: (v) => N.sounds[String(v)] ?? String(v) },
  { key: 'ringSeconds', label: F.ringSeconds },
  { key: 'sendTelegram', label: F.sendTelegram, format: 'bool' },
  { key: 'isActive', label: F.isActive, format: 'bool' },
];

/** Valores da nota para o diff (nomes no lugar dos ids). */
function noteValues(note: Pick<NoteDto, 'kind' | 'title' | 'body' | 'noteDate' | 'scope' | 'object' | 'reminder'>) {
  return {
    kind: note.kind,
    title: note.title,
    entity: note.object.name,
    noteDate: note.noteDate,
    scope: note.scope,
    body: note.body,
    repeatText: note.reminder?.description ?? null,
    sound: note.reminder?.sound ?? null,
    ringSeconds: note.reminder?.ringSeconds ?? null,
    sendTelegram: note.reminder ? note.reminder.sendTelegram : null,
    isActive: note.reminder ? note.reminder.isActive : null,
  };
}

const firingLabel = (f: { title: string; scheduledFor: string }) => `${f.title} · ${formatDateTime(f.scheduledFor)}`;

export const NOTE_HANDLERS: Handlers<NoteToolName> = {
  list_notes: {
    run: (ctx, i) =>
      notes.listNotes(ctx, {
        from: i.from,
        to: i.to,
        kinds: i.kinds ?? [],
        entityId: i.entityId,
        scope: i.scope,
        authorId: i.authorId,
        q: i.q,
        archived: i.archived,
        order: 'desc',
        cursor: i.cursor,
        limit: i.limit,
      }),
  },
  get_note: { run: (ctx, i) => notes.getNote(ctx, i.noteId) },
  note_calendar: { run: (ctx, i) => notes.noteCalendar(ctx, { from: i.from, to: i.to, entityId: i.entityId, kinds: i.kinds ?? [] }) },
  list_reminder_firings: { run: (ctx, i) => notes.listFirings(ctx, { unread: i.unreadOnly, limit: i.limit }) },

  create_note: {
    preview: async (ctx, i) => {
      const entity = await nameOf(ctx, 'entity', i.objectId);
      const reminder = i.kind === 'reminder' ? { ...NOTE_REMINDER_DEFAULTS, ...i.reminder } : null;
      const startsOn = reminder ? (i.reminder?.startsOn ?? i.noteDate ?? null) : null;
      const after = {
        kind: i.kind,
        title: i.title,
        entity,
        noteDate: startsOn ?? i.noteDate ?? null,
        scope: i.scope,
        body: i.body,
        repeatText: reminder
          ? `${N.repeats[reminder.repeat]} · ${reminder.timeOfDay}${startsOn ? ` · ${formatDate(startsOn)}` : ''}`
          : null,
        sound: reminder?.sound ?? null,
        ringSeconds: reminder?.ringSeconds ?? null,
        sendTelegram: reminder ? reminder.sendTelegram : null,
        isActive: reminder ? reminder.isActive : null,
      };
      return {
        title: N.preview.create,
        summary: i.title,
        action: 'create',
        rows: diffRows(NOTE_FIELDS, after),
        warnings: i.scope === 'global' ? [N.preview.globalWarning] : [],
      };
    },
    run: (ctx, i) => notes.createNote(ctx, i),
  },

  update_note: {
    preview: async (ctx, i) => {
      const { noteId, ...patch } = i;
      const current = await notes.getNote(ctx, noteId);
      ctx.access.assertWriteNote({ authorId: current.authorId, scope: current.scope });
      const before = noteValues(current);
      const kind = patch.kind ?? current.kind;
      const after: Record<string, unknown> = {
        kind: patch.kind,
        title: patch.title,
        body: patch.body,
        scope: patch.scope,
        noteDate: patch.reminder?.startsOn ?? patch.noteDate,
        entity: patch.objectId ? await nameOf(ctx, 'entity', patch.objectId) : undefined,
      };
      if (kind === 'reminder' && patch.reminder) {
        const merged = { ...(current.reminder ?? NOTE_REMINDER_DEFAULTS), ...patch.reminder };
        after.repeatText = `${N.repeats[merged.repeat]} · ${merged.timeOfDay}`;
        if (patch.reminder.sound !== undefined) after.sound = patch.reminder.sound;
        if (patch.reminder.ringSeconds !== undefined) after.ringSeconds = patch.reminder.ringSeconds;
        if (patch.reminder.sendTelegram !== undefined) after.sendTelegram = patch.reminder.sendTelegram;
        if (patch.reminder.isActive !== undefined) after.isActive = patch.reminder.isActive;
      }
      const rows: PreviewRow[] = diffRows(NOTE_FIELDS, after, before);
      const warnings: string[] = [];
      if (current.kind === 'reminder' && kind !== 'reminder') warnings.push(N.preview.reminderRemoved);
      if (patch.scope === 'global' && current.scope !== 'global') warnings.push(N.preview.globalWarning);
      return { title: N.preview.update, summary: current.title, action: 'update', rows, warnings };
    },
    run: (ctx, i) => {
      const { noteId, ...patch } = i;
      return notes.updateNote(ctx, noteId, patch);
    },
  },

  archive_note: {
    preview: async (ctx, i) => {
      const current = await notes.getNote(ctx, i.noteId);
      ctx.access.assertWriteNote({ authorId: current.authorId, scope: current.scope });
      return {
        title: i.archived ? N.preview.archive : N.preview.unarchive,
        summary: current.title,
        action: i.archived ? 'delete' : 'update',
        rows: [
          { label: F.kind, after: N.kinds[current.kind] ?? current.kind },
          { label: F.entity, after: current.object.name },
          { label: F.archived, before: current.archivedAt ? 'Sim' : 'Não', after: i.archived ? 'Sim' : 'Não' },
        ],
      };
    },
    run: (ctx, i) => notes.archiveNote(ctx, i.noteId, i.archived),
  },

  snooze_reminder: {
    preview: async (ctx, i) => {
      const list = await ctx.db.execute<{ title: string; scheduled_for: string }>(sql`
        SELECT n.title, f.scheduled_for FROM note_reminder_firings f JOIN notes n ON n.id = f.note_id
         WHERE f.id = ${i.firingId} AND f.user_id = ${ctx.access.actor.id}`);
      const row = list.rows[0];
      if (!row) throw notFound(N.errors.firingNotFound);
      return {
        title: N.preview.snooze,
        summary: firingLabel({ title: row.title, scheduledFor: iso(row.scheduled_for)! }),
        action: 'update',
        rows: [{ label: N.preview.snooze, after: N.preview.snoozeFor(i.minutes) }],
      };
    },
    run: (ctx, i) => notes.snoozeFiring(ctx, i.firingId, i.minutes),
  },

  mark_reminders_read: {
    preview: async (ctx, i) => {
      const unread = await notes.listFirings(ctx, { unread: true, limit: 200 });
      const targets = i.firingIds ? unread.items.filter((f) => i.firingIds!.includes(f.id)) : unread.items;
      return {
        title: N.preview.markRead,
        summary: i.firingIds ? N.preview.markReadCount(targets.length) : N.preview.markReadAll,
        action: 'update',
        rows: targets.slice(0, 20).map((f) => ({ label: f.title, after: formatDateTime(f.scheduledFor) })),
      };
    },
    run: (ctx, i) => notes.markFiringsRead(ctx, i.firingIds),
  },
};
