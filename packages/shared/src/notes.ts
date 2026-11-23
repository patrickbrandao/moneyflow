import { formatDate } from './dates';
import { notesStrings } from './i18n/areas/notes';

/*
 * Anotações e lembretes (spec 035, F21): tipos, escopos, repetições e sons, as
 * entradas da API (e das tools), os DTOs e a repetição em texto ("todo dia 10
 * às 09:00"). Sem banco: a API, o worker e o console importam daqui. As
 * entradas Zod ficam em `notes-input.ts` (tarefa 128): o alarme do console
 * usa só as constantes daqui, sem levar o Zod para o arquivo principal.
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

/** Escopo da listagem: mine = as minhas (privadas e globais); global = as globais (de qualquer autor). */
export const NOTE_LIST_SCOPES = ['all', 'mine', 'global'] as const;
export type NoteListScope = (typeof NOTE_LIST_SCOPES)[number];

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
