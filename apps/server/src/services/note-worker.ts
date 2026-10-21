import type { Database } from '@moneyflow/db';
import { formatDateTime, noteReminderMessage, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import { createNotifications } from './notifications';
import { iso } from './util';

/*
 * Disparo dos lembretes (spec 035), no laço de mensagens do worker (a cada
 * MESSAGE_INTERVAL_MS, antes do consumo da outbox). Numa transação curta,
 * note_reminder_claim reserva os lembretes vencidos (SKIP LOCKED: vários
 * workers não repetem; os perdidos com o worker parado viram UM disparo) e os
 * adiados vencidos (o mesmo registro toca de novo); para cada disparo, na
 * mesma transação, a notificação do sino do autor e, com "Enviar também no
 * Telegram", a mensagem na outbox para os destinos Telegram pessoais ativos
 * dele. As duas com a dedup note_reminder:<disparo>:<adiamentos>. O front
 * descobre o disparo pela sondagem de /api/note-reminders/firings (shouldRing).
 */

type ClaimRow = {
  firing_id: string;
  note_id: string;
  user_id: string;
  title: string;
  send_telegram: boolean;
  scheduled_for: unknown;
  snooze_count: number;
  is_snooze_refire: boolean;
  entity_name: string | null;
  body: string | null;
};

const BATCH = 100;

export const noteReminderDedup = (firingId: string, snoozeCount: number) => `note_reminder:${firingId}:${snoozeCount}`;

export async function noteRemindersTick(db: Database, config: Config, rounds = 10) {
  let fired = 0;
  let queued = 0;
  for (let round = 0; round < rounds; round += 1) {
    const result = await db.transaction(async (tx) => {
      const claimed = await tx.execute<ClaimRow>(sql`
        SELECT c.firing_id, c.note_id, c.user_id, c.title, c.send_telegram, c.scheduled_for, c.snooze_count, c.is_snooze_refire,
               e.name AS entity_name, n.body
          FROM note_reminder_claim(${BATCH}) c
          JOIN notes n ON n.id = c.note_id
          LEFT JOIN entities e ON e.id = n.entity_id`);
      const rows = claimed.rows;
      if (rows.length === 0) return { claimed: 0, queued: 0 };
      const when = (row: ClaimRow) => formatDateTime(iso(row.scheduled_for));
      await createNotifications(
        tx,
        rows.map((row) => ({
          userId: row.user_id,
          kind: 'note_reminder' as const,
          title: t.notes.firing.notificationTitle(row.title),
          body: t.notes.firing.notificationBody(when(row), row.entity_name),
          link: `/notes?note=${row.note_id}`,
          data: { firingId: row.firing_id, noteId: row.note_id, snoozeCount: Number(row.snooze_count) },
          dedupKey: noteReminderDedup(row.firing_id, Number(row.snooze_count)),
        })),
      );
      let enqueued = 0;
      const telegram = rows.filter((row) => row.send_telegram);
      if (telegram.length > 0) {
        const authors = [...new Set(telegram.map((row) => row.user_id))];
        const destinations = await tx.execute<{ id: string; owner_user_id: string }>(sql`
          SELECT id, owner_user_id FROM message_destinations
           WHERE owner_user_id = ANY (${`{${authors.join(',')}}`}::uuid[]) AND channel = 'telegram' AND is_active AND archived_at IS NULL`);
        for (const row of telegram) {
          const payload = noteReminderMessage({
            title: row.title,
            entity: row.entity_name,
            when: when(row),
            body: row.body,
            url: config.publicUrl ? `${config.publicUrl}/notes?note=${row.note_id}` : null,
          });
          for (const destination of destinations.rows.filter((d) => d.owner_user_id === row.user_id)) {
            const inserted = await tx.execute(sql`
              INSERT INTO message_outbox (destination_id, event_kind, dedup_key, user_id, payload)
              VALUES (${destination.id}, 'note_reminder', ${noteReminderDedup(row.firing_id, Number(row.snooze_count))}, ${row.user_id},
                      ${JSON.stringify(payload)}::jsonb)
              ON CONFLICT (destination_id, dedup_key) DO NOTHING RETURNING id`);
            enqueued += inserted.rows.length;
          }
        }
      }
      return { claimed: rows.length, queued: enqueued };
    });
    fired += result.claimed;
    queued += result.queued;
    if (result.claimed < BATCH) break;
  }
  return { reminders: fired, reminderMessages: queued };
}
