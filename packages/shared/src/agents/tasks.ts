import { z } from 'zod';
import { id } from '../schemas/common';
import type { AiRunDto, AiRunStatus, ToolConfirmationDto } from './types';

/*
 * Fluxos autônomos (spec 029): a agenda das tarefas agendadas (o mesmo
 * formato de ai_schedule_valid no banco), as entradas da API e das tools, os
 * DTOs das tarefas, do Telegram de entrada e da conciliação com IA, e o texto
 * da agenda ("toda segunda às 08:00"). Sem banco: a API e o console importam daqui.
 */

const hhmm = z
  .string()
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Horário inválido (use HH:MM).')
  .describe('Horário HH:MM no fuso de São Paulo.');

export const AGENT_TASK_SCHEDULE_KINDS = ['daily', 'weekly', 'monthly'] as const;

export type AgentTaskSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] }
  | { kind: 'monthly'; time: string; day: number | 'last' };

/**
 * Agenda de uma tarefa: plana para o modelo (kind, time, weekdays, day) e
 * normalizada para o formato do banco (só as chaves do tipo).
 */
export const agentTaskSchedule = z
  .object({
    kind: z.enum(AGENT_TASK_SCHEDULE_KINDS).describe('daily = todo dia; weekly = nos dias da semana; monthly = num dia do mês.'),
    time: hhmm,
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .optional()
      .describe('Só no weekly: dias ISO (1 = segunda … 7 = domingo).'),
    day: z
      .union([z.number().int().min(1).max(31), z.literal('last')])
      .optional()
      .describe('Só no monthly: dia 1–31 (mês sem o dia = último dia) ou "last" (último dia do mês).'),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'weekly' && !v.weekdays?.length)
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Escolha os dias da semana.' });
    if (v.weekdays && new Set(v.weekdays).size !== v.weekdays.length)
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Dias da semana repetidos.' });
    if (v.kind === 'monthly' && v.day === undefined) ctx.addIssue({ code: 'custom', path: ['day'], message: 'Escolha o dia do mês.' });
  })
  .transform((v): AgentTaskSchedule => {
    if (v.kind === 'weekly') return { kind: 'weekly', time: v.time, weekdays: [...new Set(v.weekdays!)].sort((a, b) => a - b) };
    if (v.kind === 'monthly') return { kind: 'monthly', time: v.time, day: v.day! };
    return { kind: 'daily', time: v.time };
  });

/** No máximo 20 tarefas ativas por usuário (o banco garante: ai_scheduled_tasks_active_limit_check). */
export const AGENT_TASK_ACTIVE_LIMIT = 20;

export const agentTaskCreateInput = z.object({
  /** Dono (só o admin escolhe outro usuário; sem ele, quem cria). */
  userId: id.nullish().describe('Dono da tarefa (só administrador cria para outro usuário; omita para você).'),
  agentId: id.describe('Agente que executa a tarefa.'),
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(20_000).describe('Texto enviado ao agente como mensagem do usuário a cada disparo.'),
  schedule: agentTaskSchedule,
  isActive: z.boolean().default(true),
});

export const agentTaskUpdateInput = z.object({
  agentId: id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  instruction: z.string().trim().min(1).max(20_000).optional(),
  schedule: agentTaskSchedule.optional(),
  isActive: z.boolean().optional(),
});

export const agentTaskListQuery = z.object({
  /** Admin: as de um usuário ou "all". */
  userId: z.union([id, z.literal('all')]).optional(),
});

export type AgentTaskRunStatus = 'started' | 'skipped' | 'failed';

export type AgentTaskRunDto = {
  id: string;
  taskId: string;
  scheduledFor: string;
  triggerKind: 'schedule' | 'manual';
  status: AgentTaskRunStatus;
  skipReason: string | null;
  conversationId: string | null;
  runId: string | null;
  runStatus: AiRunStatus | null;
  runError: string | null;
  createdAt: string;
};

export type AgentTaskDto = {
  id: string;
  userId: string;
  username: string;
  agentId: string;
  agentName: string;
  agentColorSlot: number;
  name: string;
  instruction: string;
  schedule: AgentTaskSchedule;
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdByUserId: string | null;
  createdByUsername: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: AgentTaskRunDto | null;
};

export type AgentTaskRunNowResult = { run: AgentTaskRunDto };

const WEEKDAYS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

const joinList = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`);

/** A agenda em texto: "todo dia às 08:00", "toda segunda e quarta às 08:00", "todo dia 10 às 08:00". */
export function scheduleText(schedule: AgentTaskSchedule): string {
  if (schedule.kind === 'daily') return `todo dia às ${schedule.time}`;
  if (schedule.kind === 'weekly') {
    const days = [...schedule.weekdays].sort((a, b) => a - b);
    if (days.length === 7) return `todo dia às ${schedule.time}`;
    if (days.join(',') === '1,2,3,4,5') return `de segunda a sexta às ${schedule.time}`;
    const names = days.map((d) => WEEKDAYS[d - 1]!);
    // "toda segunda", "todo sábado": o gênero do primeiro dia da lista.
    return `${days[0]! >= 6 ? 'todo' : 'toda'} ${joinList(names)} às ${schedule.time}`;
  }
  if (schedule.day === 'last') return `todo último dia do mês às ${schedule.time}`;
  return `todo dia ${schedule.day} às ${schedule.time}`;
}

/** Motivo de um disparo pulado ou que falhou, para a tela e para as tools. */
export function taskSkipReasonText(reason: string | null): string {
  switch (reason) {
    case null:
      return '';
    case 'missed_window':
      return 'Pulado: atraso acima de 6 h (o worker estava parado).';
    case 'previous_run_active':
      return 'Pulado: execução anterior em andamento.';
    case 'user_inactive':
      return 'Pulado: o dono da tarefa está inativo.';
    case 'agent_inactive':
      return 'Pulado: o agente está inativo ou arquivado.';
    case 'budget_exceeded':
      return 'Pulado: orçamento de IA atingido.';
    case 'rate_limited':
      return 'Pulado: limite de execuções por minuto.';
    default:
      return reason;
  }
}

/* ---------------- Telegram de entrada (spec 029) ---------------- */

export const telegramPairingInput = z.object({ destinationId: id });
export const telegramLinksQuery = z.object({ all: z.enum(['true', 'false']).optional() });

/** Destino com "Receber mensagens" ligado que o usuário pode usar para parear. */
export type TelegramInboundDestinationDto = {
  id: string;
  name: string;
  botId: string | null;
  ownerKind: 'user' | 'caixa' | 'global';
  agentId: string | null;
  agentName: string | null;
};

export type TelegramLinkDto = {
  id: string;
  destinationId: string;
  destinationName: string;
  userId: string;
  username: string;
  chatId: string;
  telegramUsername: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type TelegramAccountDto = { destinations: TelegramInboundDestinationDto[]; links: TelegramLinkDto[] };

export type TelegramPairingCodeDto = {
  code: string;
  expiresAt: string;
  destinationId: string;
  destinationName: string;
  botId: string | null;
};

/* ---------------- conciliação com IA (spec 029) ---------------- */

export const reconcileAiAutoInput = z.object({ enabled: z.boolean() });

export type ReconcileAiStateDto = {
  /** "Conciliar com IA ao importar" da conta ou do cartão do lote. */
  autoEnabled: boolean;
  /** Agente dos fluxos (null = nenhum agente utilizável) e se ele tem kit (sem kit: lança sem pedir aprovação). */
  agent: { id: string; name: string; hasKit: boolean } | null;
  conversationId: string | null;
  run: AiRunDto | null;
  /** Confirmações pendentes da execução (as ações que o agente propõe). */
  confirmations: ToolConfirmationDto[];
  /** Quem decide é quem disparou a execução. */
  canDecide: boolean;
};

export type ReconcileAiStartResult = {
  queued: boolean;
  runId: string | null;
  conversationId: string | null;
  lines: number;
  skippedReason?: string;
};
