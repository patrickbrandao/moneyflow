import {
  noteCalendarQuery,
  noteCreateInput,
  noteListQuery,
  noteUpdateInput,
  reminderFiringsQuery,
  reminderReadInput,
  reminderSettingsInput,
  reminderSnoozeInput,
} from '@moneyflow/shared';
import type { FastifyInstance } from 'fastify';
import { param, parse, type Req } from '../http';
import * as notes from '../services/notes';

/* Anotações e lembretes (spec 035): a visibilidade e a edição são do Access, no serviço. */
export async function noteRoutes(app: FastifyInstance) {
  const id = (r: Req) => param(r, 'id');

  app.get('/api/notes', (r: Req) => notes.listNotes(r.ctx, parse(noteListQuery, r.query)));
  app.post('/api/notes', (r: Req) => notes.createNote(r.ctx, parse(noteCreateInput, r.body)));
  app.get('/api/notes/calendar', (r: Req) => notes.noteCalendar(r.ctx, parse(noteCalendarQuery, r.query)));
  app.get('/api/notes/:id', (r: Req) => notes.getNote(r.ctx, id(r)));
  app.patch('/api/notes/:id', (r: Req) => notes.updateNote(r.ctx, id(r), parse(noteUpdateInput, r.body)));
  app.post('/api/notes/:id/archive', (r: Req) => notes.archiveNote(r.ctx, id(r), true));
  app.post('/api/notes/:id/unarchive', (r: Req) => notes.archiveNote(r.ctx, id(r), false));
  app.get('/api/entities/:id/notes', (r: Req) => notes.listEntityNotes(r.ctx, id(r), parse(noteListQuery, r.query)));

  // Log de lembretes do próprio usuário (o ícone do alarme sonda esta rota).
  app.get('/api/note-reminders/firings', (r: Req) => notes.listFirings(r.ctx, parse(reminderFiringsQuery, r.query)));
  app.post('/api/note-reminders/firings/read-all', (r: Req) => notes.markFiringsRead(r.ctx, parse(reminderReadInput, r.body).firingIds));
  app.post('/api/note-reminders/firings/:id/dismiss', (r: Req) => notes.dismissFiring(r.ctx, id(r)));
  app.post('/api/note-reminders/firings/:id/snooze', (r: Req) =>
    notes.snoozeFiring(r.ctx, id(r), parse(reminderSnoozeInput, r.body).minutes),
  );

  // Minha conta → Lembretes: som e segundos padrão.
  app.get('/api/account/reminder-settings', (r: Req) => notes.getReminderSettings(r.ctx));
  app.put('/api/account/reminder-settings', (r: Req) => notes.putReminderSettings(r.ctx, parse(reminderSettingsInput, r.body)));
}
