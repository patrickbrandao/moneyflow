import { z } from 'zod';
import { notesStrings } from './i18n/areas/notes';
import { DEFAULT_RING_SECONDS, NOTE_KINDS, NOTE_LIST_SCOPES, NOTE_OBJECT_TYPES, NOTE_REPEATS, NOTE_SCOPES, REMINDER_SOUNDS } from './notes';
import { id, isoDate, optionalText, queryBool, requiredText } from './schemas/common';

/*
 * Entradas da API e das tools das anotações e lembretes (spec 035), separadas
 * de `notes.ts` (tarefa 128): quem só precisa das constantes e dos DTOs (o
 * alarme na casca do console) não carrega o Zod.
 */

const E = notesStrings.errors;

export const soundKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'Som inválido.')
  .describe(`Chave do som (${REMINDER_SOUNDS.join(', ')}).`);

export const ringSeconds = z.number().int().min(5).max(600).describe('Segundos do loop do som (5 a 600).');

const hhmm = z
  .string()
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Horário inválido (use HH:MM).')
  .describe('Horário HH:MM no fuso de São Paulo.');

/** Campos do lembrete (todos opcionais na edição). */
const reminderFields = {
  timeOfDay: hhmm,
  repeat: z
    .enum(NOTE_REPEATS)
    .describe(
      'once = uma vez (no início); daily; every_n_days (com everyNDays); monthly_day (com monthDay; último dia nos meses sem ele).',
    ),
  everyNDays: z.number().int().min(2).max(365).nullable().describe('Só em every_n_days: X de "a cada X dias" (2 a 365).'),
  monthDay: z.number().int().min(1).max(31).nullable().describe('Só em monthly_day: o dia do mês (1 a 31).'),
  startsOn: isoDate.describe('Início da vigência (AAAA-MM-DD); é também a data da anotação. Omitido = a data da anotação ou hoje.'),
  endsOn: isoDate.nullable().describe('Fim da vigência (opcional; nunca no once).'),
  sound: soundKey.nullable().describe('Som (nulo = o padrão do usuário).'),
  ringSeconds: ringSeconds.nullable().describe('Segundos de toque (nulo = o padrão do usuário).'),
  sendTelegram: z.boolean().describe('Enviar também pelo destino Telegram pessoal do autor.'),
  isActive: z.boolean().describe('false pausa os disparos sem arquivar.'),
};

export const noteReminderInput = z.object({
  timeOfDay: reminderFields.timeOfDay.default('09:00'),
  repeat: reminderFields.repeat.default('once'),
  everyNDays: reminderFields.everyNDays.optional(),
  monthDay: reminderFields.monthDay.optional(),
  startsOn: reminderFields.startsOn.optional(),
  endsOn: reminderFields.endsOn.optional(),
  sound: reminderFields.sound.optional(),
  ringSeconds: reminderFields.ringSeconds.optional(),
  sendTelegram: reminderFields.sendTelegram.default(false),
  isActive: reminderFields.isActive.default(true),
});

export const noteReminderPatch = z.object({
  timeOfDay: reminderFields.timeOfDay.optional(),
  repeat: reminderFields.repeat.optional(),
  everyNDays: reminderFields.everyNDays.optional(),
  monthDay: reminderFields.monthDay.optional(),
  startsOn: reminderFields.startsOn.optional(),
  endsOn: reminderFields.endsOn.optional(),
  sound: reminderFields.sound.optional(),
  ringSeconds: reminderFields.ringSeconds.optional(),
  sendTelegram: reminderFields.sendTelegram.optional(),
  isActive: reminderFields.isActive.optional(),
});

const noteFields = {
  kind: z.enum(NOTE_KINDS).describe('info = informação; good = nota boa; bad = nota ruim; severe = nota grave; reminder = lembrete.'),
  title: requiredText(120).describe('Título curto (até 120 caracteres).'),
  body: optionalText(100_000).describe('Corpo em markdown (opcional).'),
  noteDate: isoDate.describe('Data da anotação no calendário (AAAA-MM-DD; padrão hoje). No lembrete é o início.'),
  objectType: z.enum(NOTE_OBJECT_TYPES).describe('Tipo do objeto (hoje só entity).'),
  objectId: id.describe('Id do objeto (a entidade).'),
  scope: z.enum(NOTE_SCOPES).describe('private = só o autor (e o admin) vê; global = todos veem (só o autor e o admin editam).'),
};

export const noteCreateInput = z
  .object({
    kind: noteFields.kind,
    title: noteFields.title,
    body: noteFields.body,
    noteDate: noteFields.noteDate.optional(),
    objectType: noteFields.objectType.default('entity'),
    objectId: noteFields.objectId,
    scope: noteFields.scope.default('private'),
    reminder: noteReminderInput.optional().describe('Só no tipo reminder: horário, repetição, vigência, som, Telegram e ativo.'),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'reminder' && value.reminder) {
      ctx.addIssue({ code: 'custom', path: ['reminder'], message: E.reminderOnlyForReminder });
    }
  });

/** Campos da edição, sem a checagem cruzada (as tools estendem com o noteId). */
export const noteUpdateObject = z.object({
  kind: noteFields.kind.optional(),
  title: noteFields.title.optional(),
  body: noteFields.body.optional(),
  noteDate: noteFields.noteDate.optional(),
  objectType: noteFields.objectType.optional(),
  objectId: noteFields.objectId.optional(),
  scope: noteFields.scope.optional(),
  reminder: noteReminderPatch
    .optional()
    .describe(
      'Campos do lembrete a mudar (só no tipo reminder). Trocar o tipo para reminder cria o lembrete; trocar para outro tipo o remove.',
    ),
});

export const noteUpdateInput = noteUpdateObject.superRefine((value, ctx) => {
  if (value.kind !== undefined && value.kind !== 'reminder' && value.reminder) {
    ctx.addIssue({ code: 'custom', path: ['reminder'], message: E.reminderOnlyForReminder });
  }
});

/** Lista de tipos na query (separada por vírgula) ou já como array (tools). */
const kindList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v : v ? v.split(',') : []).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(NOTE_KINDS)).max(NOTE_KINDS.length));

/**
 * Filtros da tabela de anotações. Com `from` e `to`, cada ocorrência no período
 * é uma linha (o lembrete aparece em cada dia em que ocorre); sem período, uma
 * linha por anotação (na data dela). `archived` = só as arquivadas.
 */
export const noteListQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    kinds: kindList,
    entityId: id.optional(),
    scope: z.enum(NOTE_LIST_SCOPES).default('all'),
    authorId: id.optional(),
    q: z.string().trim().max(200).optional(),
    archived: queryBool,
    order: z.enum(['asc', 'desc']).default('desc'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), { path: ['to'], message: 'Informe o início e o fim do período.' })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { path: ['to'], message: 'Período inválido.' });

export const noteCalendarQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    entityId: id.optional(),
    kinds: kindList,
  })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'Período inválido.' });

export const reminderFiringsQuery = z.object({
  unread: queryBool,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const reminderSnoozeInput = z.object({
  minutes: z.number().int().min(1).max(1440).describe('Minutos (1 a 1440; os botões: 5, 10, 30).'),
});

/** Marcar como lidos: os disparos pedidos ou, sem a lista, todos os não lidos. */
export const reminderReadInput = z.object({ firingIds: z.array(id).min(1).max(500).optional() });

export const reminderSettingsInput = z.object({
  sound: soundKey.nullable().describe('Som padrão (nulo = o do sistema).'),
  ringSeconds: ringSeconds.default(DEFAULT_RING_SECONDS),
});

export type NoteCreateInput = z.input<typeof noteCreateInput>;
export type NoteUpdateInput = z.input<typeof noteUpdateInput>;
export type NoteReminderInput = z.input<typeof noteReminderInput>;
export type NoteListQuery = z.input<typeof noteListQuery>;
export type NoteCalendarQuery = z.input<typeof noteCalendarQuery>;
export type ReminderSettingsInput = z.input<typeof reminderSettingsInput>;
