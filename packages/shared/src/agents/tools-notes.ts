import { z } from 'zod';
import { NOTE_KINDS, NOTE_LIST_SCOPES, noteCreateInput, noteUpdateObject } from '../notes';
import { id } from '../schemas/common';
import { date, define, limit } from './tool-def';

/*
 * Tools das anotações e dos lembretes (spec 035, categoria Anotações), sobre o
 * mesmo serviço da API, com o Access do usuário: ele lê as próprias e as
 * globais (o admin, todas) e edita as próprias (o admin, todas). Os disparos
 * são sempre do próprio usuário. Não entram sozinhas em kit nenhum; ficam no /mcp.
 */

const kinds = z.array(z.enum(NOTE_KINDS)).max(NOTE_KINDS.length).optional().describe('Tipos (omitido = todos).');

export const NOTE_TOOLS = [
  define({
    name: 'list_notes',
    category: 'notes',
    title: 'Listar anotações',
    description:
      'Anotações visíveis ao usuário (as próprias e as globais; o admin vê todas), com os filtros da tabela: período (from e to juntos: cada ocorrência no período vira uma linha, o lembrete em cada dia em que ocorre; sem período, uma linha por anotação na data dela), tipos, entidade, escopo (mine = as minhas, global = as globais), autor (só admin), texto no título e no corpo e arquivadas (só elas). Use com entityId para citar as anotações de uma entidade. Paginação por cursor (nextCursor).',
    kind: 'read',
    input: z.object({
      from: date.optional(),
      to: date.optional(),
      kinds,
      entityId: id.optional().describe('Entidade das anotações.'),
      scope: z.enum(NOTE_LIST_SCOPES).default('all'),
      authorId: id.optional().describe('Só admin: anotações de um autor.'),
      q: z.string().trim().max(200).optional().describe('Texto no título ou no corpo.'),
      archived: z.boolean().default(false).describe('true = só as arquivadas.'),
      cursor: z.string().max(200).optional(),
      limit: limit(200, 50),
    }),
  }),
  define({
    name: 'get_note',
    category: 'notes',
    title: 'Ver anotação',
    description: 'Uma anotação com o corpo em markdown, a entidade, o autor, o escopo e, no lembrete, a repetição e o próximo disparo.',
    kind: 'read',
    input: z.object({ noteId: id }),
  }),
  define({
    name: 'note_calendar',
    category: 'notes',
    title: 'Calendário de anotações',
    description:
      'Quantas anotações visíveis (não arquivadas) de cada tipo ocorrem em cada dia do intervalo (até 1100 dias), com os lembretes expandidos em cada ocorrência.',
    kind: 'read',
    input: z.object({ from: date, to: date, entityId: id.optional(), kinds }),
  }),
  define({
    name: 'list_reminder_firings',
    category: 'notes',
    title: 'Disparos de lembrete',
    description:
      'Log dos lembretes do próprio usuário: os disparos (não lidos primeiro), com o horário previsto, o real, lido, adiado e quantas vezes.',
    kind: 'read',
    input: z.object({ unreadOnly: z.boolean().default(false), limit: limit(200, 50) }),
  }),
  define({
    name: 'create_note',
    category: 'notes',
    title: 'Criar anotação',
    description:
      'Cria uma anotação presa a uma entidade (objectType entity, objectId = id da entidade): tipo, título, corpo em markdown, data (padrão hoje) e escopo (private padrão, global = todos veem). No tipo reminder, o lembrete (horário HH:MM, repetição once/daily/every_n_days/monthly_day, início = a data, fim, som, segundos, Telegram, ativo) alarma só o autor.',
    kind: 'write',
    input: noteCreateInput,
  }),
  define({
    name: 'update_note',
    category: 'notes',
    title: 'Editar anotação',
    description:
      'Muda os campos informados de uma anotação (só o autor ou o admin). Trocar o tipo para reminder cria o lembrete (com os campos de reminder ou os padrões); trocar de reminder para outro tipo remove o lembrete. No lembrete, a data da anotação é o início.',
    kind: 'write',
    input: noteUpdateObject.extend({ noteId: id }),
  }),
  define({
    name: 'archive_note',
    category: 'notes',
    title: 'Arquivar anotação',
    description:
      'Arquiva (archived true, a "exclusão": sai do calendário e da tabela e o lembrete para) ou desarquiva (false) uma anotação. Só o autor ou o admin.',
    kind: 'write',
    destructive: true,
    input: z.object({ noteId: id, archived: z.boolean().default(true) }),
  }),
  define({
    name: 'snooze_reminder',
    category: 'notes',
    title: 'Adiar lembrete',
    description:
      'Adia um disparo de lembrete do usuário (firingId, de list_reminder_firings) por alguns minutos (1 a 1440): ele toca de novo nessa hora. O próximo disparo da recorrência não muda.',
    kind: 'write',
    input: z.object({ firingId: id, minutes: z.number().int().min(1).max(1440) }),
  }),
  define({
    name: 'mark_reminders_read',
    category: 'notes',
    title: 'Marcar lembretes como lidos',
    description:
      'Marca como lidos os disparos informados (firingIds) ou, sem eles, todos os não lidos do usuário; os adiados deixam de tocar.',
    kind: 'write',
    input: z.object({ firingIds: z.array(id).min(1).max(500).optional() }),
  }),
] as const;
