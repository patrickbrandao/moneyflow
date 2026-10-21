import { z } from 'zod';
import { formatDate } from './dates';
import { notesStrings } from './i18n/areas/notes';
import { id, isoDate, optionalText, queryBool, requiredText } from './schemas/common';

/*
 * Anotações e lembretes (spec 035, F21): tipos, escopos, repetições e sons, as
 * entradas da API (e das tools), os DTOs e a repetição em texto ("todo dia 10
 * às 09:00"). Sem banco: a API, o worker e o console importam daqui.
 */

const N = notesStrings;

/** Tipos, na ordem de gravidade usada no selo da entidade (o primeiro é o mais grave). */
export const NOTE_KINDS = ['severe', 'bad', 'info', 'good', 'reminder'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Ordem de exibição dos tipos (chips, legenda): informação, boa, ruim, grave, lembrete. */
export const NOTE_KIND_ORDER: readonly NoteKind[] = ['info', 'good', 'bad', 'severe', 'reminder'];

/** Gravidade do tipo para o selo: 0 = mais grave (severe > bad > info > good > reminder). */
export const noteKindRank = (kind: NoteKind) => NOTE_KINDS.indexOf(kind);

export const NOTE_SCOPES = ['private', 'global'] as const;
export type NoteScope = (typeof NOTE_SCOPES)[number];

/** Objetos a que uma anotação se prende (hoje só a entidade). */
export const NOTE_OBJECT_TYPES = ['entity'] as const;
export type NoteObjectType = (typeof NOTE_OBJECT_TYPES)[number];

export const NOTE_REPEATS = ['once', 'daily', 'every_n_days', 'monthly_day'] as const;
export type NoteRepeat = (typeof NOTE_REPEATS)[number];

/**
 * Sons da primeira entrega (chaves do manifest em apps/web/public/sounds). O
 * banco guarda só a chave; uma chave que sumiu do manifest cai no padrão.
 * A validação da API confere o formato da chave (como o banco), não esta
 * lista: um som novo é só o arquivo e a linha no manifest.
 */
export const REMINDER_SOUNDS = ['bell', 'beep', 'chime', 'digital'] as const;
export type ReminderSound = (typeof REMINDER_SOUNDS)[number];
export const DEFAULT_REMINDER_SOUND: ReminderSound = 'bell';
export const DEFAULT_RING_SECONDS = 30;
/** Adiar pela interface (os botões); a API aceita de 1 a 1440 minutos. */
export const SNOOZE_PRESETS = [5, 10, 30] as const;
/** O som só toca para disparos (ou re-disparos) dos últimos 10 minutos. */
export const NOTE_RING_WINDOW_MS = 10 * 60 * 1000;
/** Período máximo do calendário e da listagem expandida (o do banco). */
export const NOTE_MAX_PERIOD_DAYS = 1100;

const E = N.errors;

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

/** Lembrete completo (depois de juntar a edição com o que está gravado). */
export type NoteReminderValues = {
  timeOfDay: string;
  repeat: NoteRepeat;
  everyNDays: number | null;
  monthDay: number | null;
  startsOn: string;
  endsOn: string | null;
  sound: string | null;
  ringSeconds: number | null;
  sendTelegram: boolean;
  isActive: boolean;
};

export const NOTE_REMINDER_DEFAULTS: Omit<NoteReminderValues, 'startsOn'> = {
  timeOfDay: '09:00',
  repeat: 'once',
  everyNDays: null,
  monthDay: null,
  endsOn: null,
  sound: null,
  ringSeconds: null,
  sendTelegram: false,
  isActive: true,
};

/**
 * Normaliza o lembrete: o campo que não é da repetição escolhida fica nulo
 * (trocar de every_n_days para daily limpa o X) e devolve os problemas
 * (pt-BR) do que falta ou não combina. Vazio = válido.
 */
export function normalizeReminder(values: NoteReminderValues): { value: NoteReminderValues; problems: string[] } {
  const value: NoteReminderValues = {
    ...values,
    everyNDays: values.repeat === 'every_n_days' ? values.everyNDays : null,
    monthDay: values.repeat === 'monthly_day' ? values.monthDay : null,
    endsOn: values.repeat === 'once' ? null : values.endsOn,
  };
  const problems: string[] = [];
  if (value.repeat === 'every_n_days' && value.everyNDays === null) problems.push(E.everyNDaysRequired);
  if (value.repeat === 'monthly_day' && value.monthDay === null) problems.push(E.monthDayRequired);
  if (value.endsOn && value.endsOn < value.startsOn) problems.push(E.endsBeforeStart);
  return { value, problems };
}

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

/** Escopo da listagem: mine = as minhas (privadas e globais); global = as globais (de qualquer autor). */
export const NOTE_LIST_SCOPES = ['all', 'mine', 'global'] as const;
export type NoteListScope = (typeof NOTE_LIST_SCOPES)[number];

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

/* ---------------- DTOs ---------------- */

export type NoteReminderDto = NoteReminderValues & {
  /** Próximo disparo (ISO), mantido pelo banco; nulo = pausado, arquivada ou sem ocorrência futura. */
  nextFireAt: string | null;
  /** A repetição em texto ("todo dia 10 às 09:00"). */
  description: string;
};

export type NoteObjectRef = { type: NoteObjectType; id: string; name: string; archived: boolean };

export type NoteDto = {
  id: string;
  kind: NoteKind;
  scope: NoteScope;
  title: string;
  body: string | null;
  noteDate: string;
  object: NoteObjectRef;
  authorId: string;
  authorUsername: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** O usuário edita (autor ou admin). */
  canEdit: boolean;
  reminder: NoteReminderDto | null;
};

/** Linha da tabela: a anotação numa ocorrência (o lembrete se repete em cada dia em que ocorre). */
export type NoteListItem = Omit<NoteDto, 'body'> & {
  occursOn: string;
  /** Início do corpo (até 300 caracteres), sem o markdown inteiro. */
  bodyExcerpt: string | null;
};

export type NotePage = { items: NoteListItem[]; nextCursor: string | null };

export type NoteKindCounts = Partial<Record<NoteKind, number>>;

/** Bolinhas de um dia do calendário: quantas anotações de cada tipo. */
export type NoteCalendarDay = { day: string; counts: NoteKindCounts };

/** Selo da entidade: o tipo mais grave visível (não arquivadas) e as contagens. */
export type NoteBadge = { kind: NoteKind; counts: NoteKindCounts; total: number };

export type ReminderFiringDto = {
  id: string;
  noteId: string;
  title: string;
  kind: NoteKind;
  object: NoteObjectRef | null;
  /** Horário previsto (a ocorrência). */
  scheduledFor: string;
  /** Primeiro disparo (o horário real). */
  firedAt: string;
  /** Último toque: o disparo ou o re-disparo de um adiamento. */
  lastFiredAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  snoozeCount: number;
  /** Som e segundos efetivos (do lembrete ou o padrão do usuário). */
  sound: string;
  ringSeconds: number;
  /** Deve tocar agora: não lido, não adiado e com o último toque nos últimos 10 minutos. */
  shouldRing: boolean;
};

export type ReminderFiringList = {
  /** Disparos não lidos (o contador do ícone). */
  unread: number;
  /** Hora do servidor (o front compara com lastFiredAt sem depender do relógio local). */
  serverTime: string;
  items: ReminderFiringDto[];
};

export type ReminderSettingsDto = {
  /** Som escolhido (nulo = o padrão do sistema). */
  sound: string | null;
  ringSeconds: number;
  /** Som efetivo (o escolhido ou o padrão do sistema). */
  effectiveSound: string;
  /** O usuário tem um destino Telegram pessoal ativo ("Enviar também no Telegram"). */
  hasPersonalTelegram: boolean;
};

/* ---------------- texto ---------------- */

/** A repetição do lembrete em texto: "todo dia 10 às 09:00", "a cada 3 dias às 08:30 até 31/12/2026". */
export function describeReminder(
  r: Pick<NoteReminderValues, 'repeat' | 'timeOfDay' | 'everyNDays' | 'monthDay' | 'startsOn' | 'endsOn'> & { isActive?: boolean },
): string {
  const D = N.describe;
  const time = r.timeOfDay.slice(0, 5);
  let text: string;
  switch (r.repeat) {
    case 'once':
      text = D.once(formatDate(r.startsOn), time);
      break;
    case 'daily':
      text = D.daily(time);
      break;
    case 'every_n_days':
      text = D.everyNDays(r.everyNDays ?? 0, time);
      break;
    case 'monthly_day':
      text = D.monthlyDay(r.monthDay ?? 0, time);
      break;
  }
  if (r.repeat !== 'once' && r.endsOn) text += D.until(formatDate(r.endsOn));
  if (r.isActive === false) text += D.paused;
  return text;
}

/** Selo a partir das contagens por tipo (nulo sem nenhuma). */
export function noteBadge(counts: NoteKindCounts): NoteBadge | null {
  const kinds = NOTE_KINDS.filter((kind) => (counts[kind] ?? 0) > 0);
  if (kinds.length === 0) return null;
  return { kind: kinds[0]!, counts, total: kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0) };
}
