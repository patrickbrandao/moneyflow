import type { Database, Executor, Tx } from '@moneyflow/db';
import {
  type AgentTaskDto,
  type AgentTaskRunDto,
  type AgentTaskSchedule,
  type agentTaskCreateInput,
  type agentTaskListQuery,
  type agentTaskUpdateInput,
  formatDateTime,
  t,
} from '@moneyflow/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { appendEvent, insertMessage } from '../agents/store';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { AppError, findPgError, forbidden, notFound, translateDbError, unprocessable } from '../errors';
import { assertRunRate, exceededBudget } from './ai-budgets';
import { withTx } from './tx';
import { iso } from './util';

/*
 * Tarefas agendadas dos agentes (spec 029). O dono cria as próprias (Minha
 * conta) e o admin as de qualquer um (/admin/ai); a tarefa roda como o dono.
 * A agenda e o próximo disparo são do banco (ai_schedule_next_run, trigger);
 * o worker reserva os disparos vencidos com ai_scheduled_task_claim e o
 * "Rodar agora" usa ai_scheduled_task_run_now. Em ambos, na MESMA transação
 * da reserva, a sessão própria (purpose scheduled_task, arquivada: fora do fio
 * do chat), a mensagem com a instrução e a execução são criadas e ligadas ao
 * disparo; se não der para começar (orçamento de fluxos, limite por minuto,
 * agente sem provedor), o disparo fica skipped/failed com o motivo.
 */

type TaskRow = {
  id: string;
  user_id: string;
  username: string;
  agent_id: string;
  agent_name: string;
  agent_color_slot: number;
  name: string;
  instruction: string;
  schedule: AgentTaskSchedule;
  is_active: boolean;
  next_run_at: unknown;
  last_run_at: unknown;
  created_by_user_id: string | null;
  created_by_username: string | null;
  created_at: unknown;
  updated_at: unknown;
  last_run: RunJson | null;
};

type RunJson = {
  id: string;
  task_id: string;
  scheduled_for: string;
  trigger_kind: 'schedule' | 'manual';
  status: AgentTaskRunDto['status'];
  skip_reason: string | null;
  conversation_id: string | null;
  run_id: string | null;
  run_status: AgentTaskRunDto['runStatus'];
  run_error: string | null;
  created_at: string;
};

const RUN_JSON = sql`json_build_object('id', x.id, 'task_id', x.task_id, 'scheduled_for', x.scheduled_for, 'trigger_kind', x.trigger_kind,
  'status', x.status, 'skip_reason', x.skip_reason, 'conversation_id', x.conversation_id, 'run_id', x.run_id, 'run_status', r.status,
  'run_error', r.error, 'created_at', x.created_at)`;

const TASK_SELECT = sql`
  SELECT k.id, k.user_id, u.username, k.agent_id, a.name AS agent_name, a.color_slot AS agent_color_slot, k.name, k.instruction,
         k.schedule, k.is_active, k.next_run_at, k.last_run_at, k.created_by_user_id, cb.username AS created_by_username,
         k.created_at, k.updated_at,
         (SELECT ${RUN_JSON} FROM ai_scheduled_task_runs x LEFT JOIN ai_runs r ON r.id = x.run_id
           WHERE x.task_id = k.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_run
    FROM ai_scheduled_tasks k
    JOIN users u ON u.id = k.user_id
    JOIN ai_agents a ON a.id = k.agent_id
    LEFT JOIN users cb ON cb.id = k.created_by_user_id`;

function runDto(r: RunJson): AgentTaskRunDto {
  return {
    id: r.id,
    taskId: r.task_id,
    scheduledFor: iso(r.scheduled_for)!,
    triggerKind: r.trigger_kind,
    status: r.status,
    skipReason: r.skip_reason,
    conversationId: r.conversation_id,
    runId: r.run_id,
    runStatus: r.run_status ?? null,
    runError: r.run_error ?? null,
    createdAt: iso(r.created_at)!,
  };
}

function taskDto(r: TaskRow): AgentTaskDto {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentColorSlot: Number(r.agent_color_slot),
    name: r.name,
    instruction: r.instruction,
    schedule: r.schedule,
    isActive: r.is_active,
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
    createdByUserId: r.created_by_user_id,
    createdByUsername: r.created_by_username,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    lastRun: r.last_run ? runDto(r.last_run) : null,
  };
}

async function taskRows(db: Executor, where: SQL): Promise<TaskRow[]> {
  const result = await db.execute<TaskRow>(sql`${TASK_SELECT} WHERE ${where} ORDER BY lower(k.name), k.created_at, k.id`);
  return result.rows;
}

/** A tarefa: do próprio usuário ou, para o admin, de qualquer um (404 para os demais). */
async function loadTask(ctx: ServiceContext, id: string): Promise<TaskRow> {
  const [row] = await taskRows(ctx.db, sql`k.id = ${id}`);
  if (!row || (row.user_id !== ctx.access.actor.id && !ctx.access.isAdmin)) throw notFound(t.agents.tasks.notFound);
  return row;
}

/** As suas; o admin pede as de um usuário (userId) ou de todos ('all'). */
export async function listTasks(ctx: ServiceContext, q: z.output<typeof agentTaskListQuery> = {}): Promise<AgentTaskDto[]> {
  const me = ctx.access.actor.id;
  if (q.userId && q.userId !== me) ctx.access.assertAdmin();
  const owner = q.userId === 'all' ? null : (q.userId ?? me);
  const rows = await taskRows(ctx.db, owner ? sql`k.user_id = ${owner}` : sql`true`);
  return rows.map(taskDto);
}

export async function getTask(ctx: ServiceContext, id: string): Promise<AgentTaskDto> {
  return taskDto(await loadTask(ctx, id));
}

async function assertAgentActive(db: Executor, agentId: string) {
  const result = await db.execute<{ ok: boolean }>(
    sql`SELECT (is_active AND archived_at IS NULL) AS ok FROM ai_agents WHERE id = ${agentId}`,
  );
  const row = result.rows[0];
  if (!row) throw notFound(t.agents.errors.agentNotFound);
  if (!row.ok) throw unprocessable(t.agents.tasks.agentRequired, 'agent_inactive');
}

export async function createTask(ctx: ServiceContext, input: z.output<typeof agentTaskCreateInput>): Promise<AgentTaskDto> {
  const owner = input.userId ?? ctx.access.actor.id;
  if (owner !== ctx.access.actor.id && !ctx.access.isAdmin) throw forbidden(t.agents.tasks.foreignAgentTask);
  await assertAgentActive(ctx.db, input.agentId);
  const id = await withTx(ctx, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO ai_scheduled_tasks (user_id, agent_id, name, instruction, schedule, is_active, created_by_user_id)
      VALUES (${owner}, ${input.agentId}, ${input.name}, ${input.instruction}, ${JSON.stringify(input.schedule)}::jsonb, ${input.isActive},
              ${ctx.access.actor.id})
      RETURNING id`);
    return result.rows[0]!.id;
  });
  return getTask(ctx, id);
}

export async function updateTask(ctx: ServiceContext, id: string, input: z.output<typeof agentTaskUpdateInput>): Promise<AgentTaskDto> {
  const current = await loadTask(ctx, id);
  if (input.agentId && input.agentId !== current.agent_id) await assertAgentActive(ctx.db, input.agentId);
  const sets: SQL[] = [];
  if (input.agentId !== undefined) sets.push(sql`agent_id = ${input.agentId}`);
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.instruction !== undefined) sets.push(sql`instruction = ${input.instruction}`);
  if (input.schedule !== undefined) sets.push(sql`schedule = ${JSON.stringify(input.schedule)}::jsonb`);
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (sets.length > 0) {
    await withTx(ctx, (tx) => tx.execute(sql`UPDATE ai_scheduled_tasks SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`));
  }
  return getTask(ctx, id);
}

/** Exclui a tarefa e o histórico de disparos (as sessões ficam, com o histórico de mensagens). */
export async function deleteTask(ctx: ServiceContext, id: string) {
  await loadTask(ctx, id);
  await withTx(ctx, (tx) => tx.execute(sql`DELETE FROM ai_scheduled_tasks WHERE id = ${id}`));
  return { deleted: true, archived: false };
}

export async function listTaskRuns(ctx: ServiceContext, id: string, limit = 50): Promise<AgentTaskRunDto[]> {
  await loadTask(ctx, id);
  const result = await ctx.db.execute<{ j: RunJson }>(sql`
    SELECT ${RUN_JSON} AS j FROM ai_scheduled_task_runs x LEFT JOIN ai_runs r ON r.id = x.run_id
     WHERE x.task_id = ${id} ORDER BY x.created_at DESC, x.id DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
  return result.rows.map((row) => runDto(row.j));
}

/* ---------------- disparo ---------------- */

type ClaimRow = {
  task_run_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  task_name: string;
  instruction: string;
  scheduled_for: unknown;
  trigger_kind: 'schedule' | 'manual';
  status: 'started' | 'skipped';
  skip_reason: string | null;
};

async function closeTaskRun(tx: Executor, taskRunId: string, status: 'skipped' | 'failed', reason: string) {
  await tx.execute(sql`
    UPDATE ai_scheduled_task_runs SET status = ${status}, skip_reason = ${reason.slice(0, 500)}
     WHERE id = ${taskRunId} AND status = 'started' AND run_id IS NULL`);
}

/**
 * Começa um disparo reservado (started) dentro da transação da reserva: confere
 * o limite por minuto e o orçamento dos fluxos do dono e, num savepoint, cria a
 * sessão, a mensagem e a execução e as liga ao disparo. Falhou = o disparo
 * fica skipped (limite, orçamento) ou failed (o erro), sem desfazer a reserva.
 */
async function startClaimed(tx: Tx, config: Config, row: ClaimRow): Promise<'started' | 'skipped' | 'failed'> {
  if (row.status !== 'started') return 'skipped';
  const owner = await tx.execute<{ id: string; role: 'admin' | 'user' }>(sql`SELECT id, role FROM users WHERE id = ${row.user_id}`);
  const actor = owner.rows[0];
  if (!actor) {
    await closeTaskRun(tx, row.task_run_id, 'skipped', 'user_inactive');
    return 'skipped';
  }
  try {
    await assertRunRate(tx, config, row.user_id, true);
  } catch (error) {
    if (error instanceof AppError && error.status === 429) {
      await closeTaskRun(tx, row.task_run_id, 'skipped', 'rate_limited');
      return 'skipped';
    }
    throw error;
  }
  if (await exceededBudget(tx, actor, row.agent_id, true)) {
    await closeTaskRun(tx, row.task_run_id, 'skipped', 'budget_exceeded');
    return 'skipped';
  }
  try {
    await tx.transaction(async (sp) => {
      const title = t.agents.flows.taskConversation(row.task_name, formatDateTime(iso(row.scheduled_for)!)).slice(0, 200);
      const conversation = await sp.execute<{ id: string }>(sql`
        INSERT INTO ai_conversations (user_id, agent_id, title, title_source, archived_at, purpose)
        VALUES (${row.user_id}, ${row.agent_id}, ${title}, 'user', now(), 'scheduled_task')
        RETURNING id`);
      const conversationId = conversation.rows[0]!.id;
      const message = await insertMessage(sp, conversationId, 'user', [{ type: 'text', text: row.instruction }], null);
      const run = await sp.execute<{ id: string }>(sql`
        INSERT INTO ai_runs (conversation_id, user_id, agent_id, trigger_message_id)
        VALUES (${conversationId}, ${row.user_id}, ${row.agent_id}, ${message.id})
        RETURNING id`);
      const runId = run.rows[0]!.id;
      await appendEvent(sp, runId, { type: 'status', status: 'queued' });
      await sp.execute(sql`
        UPDATE ai_scheduled_task_runs SET conversation_id = ${conversationId}, run_id = ${runId} WHERE id = ${row.task_run_id}`);
    });
    return 'started';
  } catch (error) {
    const reason = translateDbError(error)?.message ?? (error instanceof Error ? error.message : String(error));
    await closeTaskRun(tx, row.task_run_id, 'failed', reason || t.errors.generic);
    return 'failed';
  }
}

/** Ator da transação do worker: o dono da tarefa (o banco não audita os disparos; nada sai como system). */
async function setOwner(tx: Executor, userId: string) {
  await tx.execute(sql`
    SELECT set_config('app.user_id', ${userId}, true), set_config('app.actor_kind', 'human', true),
           set_config('app.agent_run_id', '', true)`);
}

/**
 * Passada do laço das tarefas (worker): reserva uma tarefa vencida por vez
 * (SKIP LOCKED: vários workers não repetem) e começa o disparo na mesma
 * transação, até não sobrar vencida (ou `max` por passada).
 */
export async function tasksTick(db: Database, config: Config, log?: FastifyBaseLogger, max = 50) {
  const counts = { started: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < max; i += 1) {
    const outcome = await db.transaction(async (tx) => {
      const claimed = await tx.execute<ClaimRow>(sql`SELECT * FROM ai_scheduled_task_claim(1, interval '6 hours')`);
      const row = claimed.rows[0];
      if (!row) return null;
      await setOwner(tx, row.user_id);
      const result = await startClaimed(tx, config, row);
      if (result !== 'started') log?.info({ taskId: row.task_id, status: result, reason: row.skip_reason }, 'tarefas: disparo não começou');
      return result;
    });
    if (!outcome) break;
    counts[outcome] += 1;
  }
  return counts;
}

/** "Rodar agora": o dono ou o admin; vale para a tarefa desligada e não muda o próximo disparo. */
export async function runTaskNow(ctx: ServiceContext, id: string): Promise<AgentTaskRunDto> {
  await loadTask(ctx, id);
  const taskRunId = await withTx(ctx, async (tx) => {
    let claimed: ClaimRow | undefined;
    try {
      const result = await tx.execute<ClaimRow>(sql`SELECT * FROM ai_scheduled_task_run_now(${id}::uuid)`);
      claimed = result.rows[0];
    } catch (error) {
      if (findPgError(error)?.code === 'P0002') throw notFound(t.agents.tasks.notFound);
      throw error;
    }
    if (!claimed) throw notFound(t.agents.tasks.notFound);
    await startClaimed(tx, ctx.config, claimed);
    return claimed.task_run_id;
  });
  const result = await ctx.db.execute<{ j: RunJson }>(sql`
    SELECT ${RUN_JSON} AS j FROM ai_scheduled_task_runs x LEFT JOIN ai_runs r ON r.id = x.run_id WHERE x.id = ${taskRunId}`);
  return runDto(result.rows[0]!.j);
}
