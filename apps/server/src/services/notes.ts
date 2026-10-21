import type { Executor } from '@moneyflow/db';
import {
  DEFAULT_REMINDER_SOUND,
  DEFAULT_RING_SECONDS,
  describeReminder,
  NOTE_REMINDER_DEFAULTS,
  type NoteBadge,
  type NoteCalendarDay,
  type NoteDto,
  type NoteKind,
  type NoteKindCounts,
  type NoteListItem,
  type NotePage,
  type NoteReminderDto,
  type NoteReminderValues,
  type NoteRepeat,
  type NoteScope,
  normalizeReminder,
  noteBadge,
  type noteCalendarQuery,
  type noteCreateInput,
  type noteListQuery,
  type noteUpdateObject,
  type ReminderFiringDto,
  type ReminderFiringList,
  type ReminderSettingsDto,
  type reminderFiringsQuery,
  type reminderSettingsInput,
  t,
  todayIso,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Access } from '../authz/access';
import type { ServiceContext } from '../context';
import { badRequest, notFound, unprocessable } from '../errors';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Anotações e lembretes (spec 035). A visibilidade e a edição ficam no Access
 * (assertReadNote/assertWriteNote: o admin vê e edita tudo; os demais veem as
 * próprias e as globais e editam só as próprias). A nota e o lembrete são
 * gravados na mesma transação (o banco confere no COMMIT que o lembrete é de
 * uma nota reminder e que a data da nota é o início). O próximo disparo é do
 * banco; os disparos são do worker (note-worker.ts) e sempre do autor.
 */

type NoteRow = {
  id: string;
  kind: NoteKind;
  scope: NoteScope;
  title: string;
  body: string | null;
  note_date: string;
  object_type: 'entity';
  object_id: string;
  object_name: string | null;
  object_archived: boolean | null;
  author_id: string;
  author_username: string;
  archived_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  has_reminder: boolean;
  time_of_day: string | null;
  repeat: NoteRepeat | null;
  every_n_days: number | null;
  month_day: number | null;
  starts_on: string | null;
  ends_on: string | null;
  sound: string | null;
  ring_seconds: number | null;
  send_telegram: boolean | null;
  is_active: boolean | null;
  next_fire_at: unknown;
};

const NOTE_COLUMNS = sql`
  n.id, n.kind, n.scope, n.title, n.note_date::text AS note_date, n.object_type, n.object_id,
  e.name AS object_name, (e.archived_at IS NOT NULL) AS object_archived,
  n.author_id, u.username AS author_username, n.archived_at, n.created_at, n.updated_at,
  (r.note_id IS NOT NULL) AS has_reminder, to_char(r.time_of_day, 'HH24:MI') AS time_of_day, r.repeat,
  r.every_n_days::int AS every_n_days, r.month_day::int AS month_day, r.starts_on::text AS starts_on,
  r.ends_on::text AS ends_on, r.sound, r.ring_seconds::int AS ring_seconds, r.send_telegram, r.is_active, r.next_fire_at`;

const NOTE_FROM = sql`
  FROM notes n
  JOIN users u ON u.id = n.author_id
  LEFT JOIN entities e ON e.id = n.entity_id
  LEFT JOIN note_reminders r ON r.note_id = n.id`;

/** Condição de visibilidade da nota `n` para o usuário (o admin vê todas). */
export const noteVisible = (access: Access, alias = 'n'): SQL => {
  const visibleTo = access.noteVisibleTo();
  const n = sql.raw(alias);
  return visibleTo === null ? sql`true` : sql`(${n}.author_id = ${visibleTo}::uuid OR ${n}.scope = 'global')`;
};

function reminderValues(row: NoteRow): NoteReminderValues | null {
  if (!row.has_reminder) return null;
  return {
    timeOfDay: row.time_of_day!,
    repeat: row.repeat!,
    everyNDays: row.every_n_days,
    monthDay: row.month_day,
    startsOn: row.starts_on!,
    endsOn: row.ends_on,
    sound: row.sound,
    ringSeconds: row.ring_seconds,
    sendTelegram: Boolean(row.send_telegram),
    isActive: Boolean(row.is_active),
  };
}

function reminderDto(row: NoteRow): NoteReminderDto | null {
  const values = reminderValues(row);
  if (!values) return null;
  return { ...values, nextFireAt: iso(row.next_fire_at), description: describeReminder(values) };
}

function baseDto(access: Access, row: NoteRow): Omit<NoteDto, 'body'> {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    title: row.title,
    noteDate: row.note_date,
    object: { type: row.object_type, id: row.object_id, name: row.object_name ?? '', archived: Boolean(row.object_archived) },
    authorId: row.author_id,
    authorUsername: row.author_username,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    canEdit: access.canWriteNote({ authorId: row.author_id, scope: row.scope }),
    reminder: reminderDto(row),
  };
}

async function loadNote(db: Executor, id: string): Promise<NoteRow | null> {
  const result = await db.execute<NoteRow>(sql`SELECT ${NOTE_COLUMNS}, n.body ${NOTE_FROM} WHERE n.id = ${id}`);
  return result.rows[0] ?? null;
}

/** A nota que o usuário lê (404 para as que ele não vê). */
async function readableNote(ctx: ServiceContext, id: string): Promise<NoteRow> {
  const row = await loadNote(ctx.db, id);
  if (!row) throw notFound(t.notes.errors.notFound);
  ctx.access.assertReadNote({ authorId: row.author_id, scope: row.scope });
  return row;
}

export async function getNote(ctx: ServiceContext, id: string): Promise<NoteDto> {
  const row = await readableNote(ctx, id);
  return { ...baseDto(ctx.access, row), body: row.body };
}

/* ---------------- listagem ---------------- */

const encodeCursor = (day: string, id: string) => Buffer.from(`${day}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { day: string; id: string } {
  const [day, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!day || !id || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest(t.notes.errors.invalidCursor);
  return { day, id };
}

const textArray = (values: readonly string[]) => sql`${`{${values.join(',')}}`}::text[]`;

/**
 * A tabela de anotações. Com período, uma linha por ocorrência (note_occurrences:
 * o lembrete em cada dia em que ocorre); sem período, uma por anotação na data
 * dela. Paginação por cursor (dia, id), na ordem pedida.
 */
export async function listNotes(ctx: ServiceContext, q: z.output<typeof noteListQuery>): Promise<NotePage> {
  const me = ctx.access.actor.id;
  if (q.authorId && q.authorId !== me && !ctx.access.isAdmin) throw unprocessable(t.notes.errors.authorFilterAdmin, 'author_filter_admin');
  const where: SQL[] = [noteVisible(ctx.access), q.archived ? sql`n.archived_at IS NOT NULL` : sql`n.archived_at IS NULL`];
  if (q.kinds.length > 0) where.push(sql`n.kind = ANY (${textArray(q.kinds)})`);
  if (q.entityId) where.push(sql`n.entity_id = ${q.entityId}::uuid`);
  if (q.scope === 'mine') where.push(sql`n.author_id = ${me}::uuid`);
  if (q.scope === 'global') where.push(sql`n.scope = 'global'`);
  if (q.authorId) where.push(sql`n.author_id = ${q.authorId}::uuid`);
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(n.title ILIKE ${like} OR n.body ILIKE ${like})`);
  }
  const desc = q.order === 'desc';
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.push(
      desc ? sql`(o.occurs_on, n.id) < (${c.day}::date, ${c.id}::uuid)` : sql`(o.occurs_on, n.id) > (${c.day}::date, ${c.id}::uuid)`,
    );
  }
  const source =
    q.from && q.to
      ? sql`SELECT note_id, occurs_on FROM note_occurrences(${q.from}::date, ${q.to}::date, ${ctx.access.noteVisibleTo()}::uuid,
                                                          ${q.entityId ?? null}::uuid, ${q.archived})`
      : sql`SELECT id AS note_id, note_date AS occurs_on FROM notes`;
  const order = desc ? sql`o.occurs_on DESC, n.id DESC` : sql`o.occurs_on, n.id`;
  const result = await ctx.db.execute<NoteRow & { occurs_on: string; body_excerpt: string | null }>(sql`
    SELECT ${NOTE_COLUMNS}, o.occurs_on::text AS occurs_on, left(n.body, 300) AS body_excerpt
      FROM (${source}) o
      JOIN notes n ON n.id = o.note_id
      JOIN users u ON u.id = n.author_id
      LEFT JOIN entities e ON e.id = n.entity_id
      LEFT JOIN note_reminders r ON r.note_id = n.id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ${order}
     LIMIT ${q.limit + 1}`);
  const rows = result.rows.slice(0, q.limit);
  const items: NoteListItem[] = rows.map((row) => ({
    ...baseDto(ctx.access, row),
    occursOn: row.occurs_on,
    bodyExcerpt: row.body_excerpt,
  }));
  const last = rows.at(-1);
  return { items, nextCursor: result.rows.length > q.limit && last ? encodeCursor(last.occurs_on, last.id) : null };
}

/** As anotações de uma entidade (a aba da entidade): os mesmos filtros, presos a ela. */
export async function listEntityNotes(ctx: ServiceContext, entityId: string, q: z.output<typeof noteListQuery>): Promise<NotePage> {
  const found = await ctx.db.execute(sql`SELECT 1 FROM entities WHERE id = ${entityId}`);
  if (found.rows.length === 0) throw notFound(t.notes.errors.entityNotFound);
  return listNotes(ctx, { ...q, entityId });
}

/** Bolinhas do calendário: por dia, quantas anotações visíveis de cada tipo (lembretes expandidos). */
export async function noteCalendar(ctx: ServiceContext, q: z.output<typeof noteCalendarQuery>): Promise<NoteCalendarDay[]> {
  const result = await ctx.db.execute<{ day: string; kind: NoteKind; notes: number }>(sql`
    SELECT day::text AS day, kind, notes
      FROM note_calendar(${q.from}::date, ${q.to}::date, ${ctx.access.noteVisibleTo()}::uuid, ${q.entityId ?? null}::uuid)`);
  const kinds = new Set(q.kinds);
  const days = new Map<string, NoteKindCounts>();
  for (const row of result.rows) {
    if (kinds.size > 0 && !kinds.has(row.kind)) continue;
    const counts = days.get(row.day) ?? {};
    counts[row.kind] = Number(row.notes);
    days.set(row.day, counts);
  }
  return [...days].map(([day, counts]) => ({ day, counts }));
}

/**
 * Selo da entidade (listagem de entidades): contagens por tipo das anotações
 * visíveis e não arquivadas, como JSON {kind: n} na linha da entidade `alias`.
 */
export const noteCountsSql = (access: Access, alias = 'e'): SQL =>
  sql`(SELECT json_object_agg(x.kind, x.n) FROM (
        SELECT nb.kind, count(*)::int AS n FROM notes nb
         WHERE nb.entity_id = ${sql.raw(alias)}.id AND nb.archived_at IS NULL AND ${noteVisible(access, 'nb')}
         GROUP BY nb.kind) x)`;

export const badgeFromCounts = (counts: unknown): NoteBadge | null =>
  counts && typeof counts === 'object' ? noteBadge(counts as NoteKindCounts) : null;

/* ---------------- escrita ---------------- */

async function assertObject(ctx: ServiceContext, objectType: 'entity', objectId: string) {
  if (objectType !== 'entity') throw unprocessable(t.notes.errors.entityNotFound);
  const found = await ctx.db.execute(sql`SELECT 1 FROM entities WHERE id = ${objectId}`);
  if (found.rows.length === 0) throw unprocessable(t.notes.errors.entityNotFound, 'note_object_not_found');
}

function checkedReminder(values: NoteReminderValues): NoteReminderValues {
  const { value, problems } = normalizeReminder(values);
  if (problems.length > 0) throw unprocessable(problems[0]!, 'invalid_reminder');
  return value;
}

const defined = <T extends object>(value: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

const reminderColumns = (r: NoteReminderValues) => sql`
  ${r.timeOfDay}::time, ${r.repeat}, ${r.everyNDays}::smallint, ${r.monthDay}::smallint, ${r.startsOn}::date, ${r.endsOn}::date,
  ${r.sound}, ${r.ringSeconds}::smallint, ${r.sendTelegram}, ${r.isActive}`;

export async function createNote(ctx: ServiceContext, input: z.output<typeof noteCreateInput>): Promise<NoteDto> {
  if (input.kind !== 'reminder' && input.reminder) throw unprocessable(t.notes.errors.reminderOnlyForReminder, 'invalid_reminder');
  await assertObject(ctx, input.objectType, input.objectId);
  const reminder =
    input.kind === 'reminder'
      ? checkedReminder({
          ...NOTE_REMINDER_DEFAULTS,
          ...defined(input.reminder),
          startsOn: input.reminder?.startsOn ?? input.noteDate ?? todayIso(),
        } as NoteReminderValues)
      : null;
  const noteDate = reminder?.startsOn ?? input.noteDate ?? todayIso();
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO notes (author_id, kind, scope, title, body, note_date, object_type, object_id)
      VALUES (${ctx.access.actor.id}, ${input.kind}, ${input.scope}, ${input.title}, ${input.body}, ${noteDate}::date,
              ${input.objectType}, ${input.objectId})
      RETURNING id`);
    const noteId = result.rows[0]!.id;
    if (reminder) {
      await tx.execute(sql`
        INSERT INTO note_reminders (note_id, time_of_day, repeat, every_n_days, month_day, starts_on, ends_on, sound, ring_seconds,
                                    send_telegram, is_active)
        VALUES (${noteId}, ${reminderColumns(reminder)})`);
    }
    return noteId;
  });
  return getNote(ctx, id);
}

/**
 * Edita a nota (só o autor e o admin). Trocar o tipo para reminder cria o
 * lembrete (com os campos pedidos ou os padrões); trocar de reminder para
 * outro tipo o remove (os disparos somem junto). No lembrete, a data da nota
 * é o início: mudar uma muda a outra.
 */
export async function updateNote(ctx: ServiceContext, id: string, input: z.output<typeof noteUpdateObject>): Promise<NoteDto> {
  const current = await readableNote(ctx, id);
  ctx.access.assertWriteNote({ authorId: current.author_id, scope: current.scope });
  const kind = input.kind ?? current.kind;
  if (kind !== 'reminder' && input.reminder) throw unprocessable(t.notes.errors.reminderOnlyForReminder, 'invalid_reminder');
  const objectType = input.objectType ?? current.object_type;
  const objectId = input.objectId ?? current.object_id;
  if (input.objectType !== undefined || input.objectId !== undefined) await assertObject(ctx, objectType, objectId);

  const before = reminderValues(current);
  let reminder: NoteReminderValues | null = null;
  let noteDate = input.noteDate ?? current.note_date;
  if (kind === 'reminder') {
    const base: NoteReminderValues = before ?? { ...NOTE_REMINDER_DEFAULTS, startsOn: noteDate };
    reminder = checkedReminder({
      ...base,
      ...defined(input.reminder),
      startsOn: input.reminder?.startsOn ?? input.noteDate ?? base.startsOn,
    });
    noteDate = reminder.startsOn;
  }

  const sets: SQL[] = [];
  if (input.kind !== undefined && input.kind !== current.kind) sets.push(sql`kind = ${input.kind}`);
  if (input.title !== undefined) sets.push(sql`title = ${input.title}`);
  if (input.body !== undefined) sets.push(sql`body = ${input.body}`);
  if (input.scope !== undefined) sets.push(sql`scope = ${input.scope}`);
  if (input.objectType !== undefined || input.objectId !== undefined) {
    sets.push(sql`object_type = ${objectType}`, sql`object_id = ${objectId}::uuid`);
  }
  if (noteDate !== current.note_date) sets.push(sql`note_date = ${noteDate}::date`);
  const reminderChanged = reminder !== null && JSON.stringify(reminder) !== JSON.stringify(before);

  if (sets.length > 0 || reminderChanged || (before && !reminder)) {
    await withTx(ctx, async (tx) => {
      if (sets.length > 0) await tx.execute(sql`UPDATE notes SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
      if (before && !reminder) {
        await tx.execute(sql`DELETE FROM note_reminders WHERE note_id = ${id}`);
      } else if (reminder && !before) {
        await tx.execute(sql`
          INSERT INTO note_reminders (note_id, time_of_day, repeat, every_n_days, month_day, starts_on, ends_on, sound, ring_seconds,
                                      send_telegram, is_active)
          VALUES (${id}, ${reminderColumns(reminder)})`);
      } else if (reminder && reminderChanged) {
        await tx.execute(sql`
          UPDATE note_reminders
             SET (time_of_day, repeat, every_n_days, month_day, starts_on, ends_on, sound, ring_seconds, send_telegram, is_active)
               = (${reminderColumns(reminder)})
           WHERE note_id = ${id}`);
      }
    });
  }
  return getNote(ctx, id);
}

/** Arquivar (a "exclusão": sai do calendário e da tabela; o lembrete para) ou desarquivar. */
export async function archiveNote(ctx: ServiceContext, id: string, archived: boolean): Promise<NoteDto> {
  const current = await readableNote(ctx, id);
  ctx.access.assertWriteNote({ authorId: current.author_id, scope: current.scope });
  if (Boolean(current.archived_at) !== archived) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE notes SET archived_at = ${archived ? sql`now()` : sql`NULL`} WHERE id = ${id}`));
  }
  return getNote(ctx, id);
}

/* ---------------- disparos (log de lembretes) ---------------- */

type FiringRow = {
  id: string;
  note_id: string;
  title: string;
  kind: NoteKind;
  object_type: 'entity';
  object_id: string;
  object_name: string | null;
  object_archived: boolean | null;
  scheduled_for: unknown;
  fired_at: unknown;
  last_fired_at: unknown;
  read_at: unknown;
  snoozed_until: unknown;
  snooze_count: number;
  sound: string;
  ring_seconds: number;
  should_ring: boolean;
};

const FIRING_SELECT = sql`
  SELECT f.id, f.note_id, n.title, n.kind, n.object_type, n.object_id, e.name AS object_name,
         (e.archived_at IS NOT NULL) AS object_archived, f.scheduled_for, f.fired_at, f.last_fired_at, f.read_at,
         f.snoozed_until, f.snooze_count, coalesce(r.sound, s.sound, ${DEFAULT_REMINDER_SOUND}) AS sound,
         coalesce(r.ring_seconds, s.ring_seconds, ${DEFAULT_RING_SECONDS})::int AS ring_seconds,
         (f.read_at IS NULL AND f.snoozed_until IS NULL AND n.archived_at IS NULL
          AND f.last_fired_at > now() - interval '10 minutes') AS should_ring
    FROM note_reminder_firings f
    JOIN notes n ON n.id = f.note_id
    JOIN note_reminders r ON r.note_id = f.note_id
    LEFT JOIN entities e ON e.id = n.entity_id
    LEFT JOIN user_reminder_settings s ON s.user_id = f.user_id`;

function firingDto(row: FiringRow): ReminderFiringDto {
  return {
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    kind: row.kind,
    object: { type: row.object_type, id: row.object_id, name: row.object_name ?? '', archived: Boolean(row.object_archived) },
    scheduledFor: iso(row.scheduled_for)!,
    firedAt: iso(row.fired_at)!,
    lastFiredAt: iso(row.last_fired_at)!,
    readAt: iso(row.read_at),
    snoozedUntil: iso(row.snoozed_until),
    snoozeCount: Number(row.snooze_count),
    sound: row.sound,
    ringSeconds: Number(row.ring_seconds),
    shouldRing: Boolean(row.should_ring),
  };
}

/**
 * Log de lembretes do próprio usuário (o ícone do alarme e a sondagem): os não
 * lidos primeiro, depois os recentes. `shouldRing` diz o que tocar agora.
 */
export async function listFirings(ctx: ServiceContext, q: z.output<typeof reminderFiringsQuery>): Promise<ReminderFiringList> {
  const me = ctx.access.actor.id;
  const [items, meta] = await Promise.all([
    ctx.db.execute<FiringRow>(sql`
      ${FIRING_SELECT}
       WHERE f.user_id = ${me} ${q.unread ? sql`AND f.read_at IS NULL` : sql``}
       ORDER BY (f.read_at IS NULL) DESC, f.last_fired_at DESC, f.id DESC
       LIMIT ${q.limit}`),
    ctx.db.execute<{ unread: number; now: unknown }>(sql`
      SELECT (SELECT count(*)::int FROM note_reminder_firings WHERE user_id = ${me} AND read_at IS NULL) AS unread, now() AS now`),
  ]);
  return { unread: Number(meta.rows[0]?.unread ?? 0), serverTime: iso(meta.rows[0]?.now)!, items: items.rows.map(firingDto) };
}

async function getFiring(ctx: ServiceContext, id: string): Promise<ReminderFiringDto> {
  const result = await ctx.db.execute<FiringRow>(sql`${FIRING_SELECT} WHERE f.id = ${id} AND f.user_id = ${ctx.access.actor.id}`);
  const row = result.rows[0];
  if (!row) throw notFound(t.notes.errors.firingNotFound);
  return firingDto(row);
}

/** As notificações do sino dos disparos (dedup note_reminder:<disparo>:<adiamentos>) também ficam lidas. */
const readBell = (userId: string, firingIds: SQL) => sql`
  UPDATE notifications SET read_at = now()
   WHERE user_id = ${userId} AND kind = 'note_reminder' AND read_at IS NULL AND (data ->> 'firingId')::uuid = ANY (${firingIds})`;

/** Dispensar: para o som e marca como lido (o adiamento, se havia, cai). */
export async function dismissFiring(ctx: ServiceContext, id: string): Promise<ReminderFiringDto> {
  await getFiring(ctx, id);
  const me = ctx.access.actor.id;
  await withTx(ctx, async (tx) => {
    await tx.execute(sql`
      UPDATE note_reminder_firings SET read_at = coalesce(read_at, now()), snoozed_until = NULL
       WHERE id = ${id} AND user_id = ${me}`);
    await tx.execute(readBell(me, sql`ARRAY[${id}::uuid]`));
  });
  return getFiring(ctx, id);
}

/** Adiar: o worker dispara de novo daqui a `minutes` (o mesmo registro, com o contador). Fica não lido até lá. */
export async function snoozeFiring(ctx: ServiceContext, id: string, minutes: number): Promise<ReminderFiringDto> {
  await getFiring(ctx, id);
  await withTx(ctx, (tx) =>
    tx.execute(sql`
      UPDATE note_reminder_firings SET read_at = NULL, snoozed_until = now() + make_interval(mins => ${minutes}::int)
       WHERE id = ${id} AND user_id = ${ctx.access.actor.id}`),
  );
  return getFiring(ctx, id);
}

/** Marcar como lidos os disparos pedidos ou, sem eles, todos os não lidos do usuário. */
export async function markFiringsRead(ctx: ServiceContext, ids?: string[]): Promise<{ updated: number }> {
  const me = ctx.access.actor.id;
  const filter = ids && ids.length > 0 ? sql`AND id = ANY (${sql`${`{${ids.join(',')}}`}::uuid[]`})` : sql``;
  return withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE note_reminder_firings SET read_at = now(), snoozed_until = NULL
       WHERE user_id = ${me} AND read_at IS NULL ${filter}
       RETURNING id`);
    const updated = result.rows.map((r) => r.id);
    if (updated.length > 0) await tx.execute(readBell(me, sql`${`{${updated.join(',')}}`}::uuid[]`));
    return { updated: updated.length };
  });
}

/* ---------------- preferências (Minha conta → Lembretes) ---------------- */

export async function getReminderSettings(ctx: ServiceContext): Promise<ReminderSettingsDto> {
  const me = ctx.access.actor.id;
  const result = await ctx.db.execute<{ sound: string | null; ring_seconds: number | null; telegram: boolean }>(sql`
    SELECT s.sound, s.ring_seconds::int AS ring_seconds,
           EXISTS (SELECT 1 FROM message_destinations d
                    WHERE d.owner_user_id = ${me} AND d.channel = 'telegram' AND d.is_active AND d.archived_at IS NULL) AS telegram
      FROM (SELECT 1) one LEFT JOIN user_reminder_settings s ON s.user_id = ${me}`);
  const row = result.rows[0];
  const sound = row?.sound ?? null;
  return {
    sound,
    ringSeconds: Number(row?.ring_seconds ?? DEFAULT_RING_SECONDS),
    effectiveSound: sound ?? DEFAULT_REMINDER_SOUND,
    hasPersonalTelegram: Boolean(row?.telegram),
  };
}

export async function putReminderSettings(
  ctx: ServiceContext,
  input: z.output<typeof reminderSettingsInput>,
): Promise<ReminderSettingsDto> {
  await withTx(ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO user_reminder_settings (user_id, sound, ring_seconds)
      VALUES (${ctx.access.actor.id}, ${input.sound}, ${input.ringSeconds})
      ON CONFLICT (user_id) DO UPDATE SET sound = EXCLUDED.sound, ring_seconds = EXCLUDED.ring_seconds`),
  );
  return getReminderSettings(ctx);
}
