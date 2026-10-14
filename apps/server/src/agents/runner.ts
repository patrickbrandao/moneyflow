import { type Database, userColumns, users } from '@moneyflow/db';
import {
  type AgentParams,
  type AssistantBlock,
  balanceToolUses,
  blocksText,
  type NeutralMessage,
  type ToolResultBlock,
  t,
} from '@moneyflow/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { type Actor, loadAccess } from '../authz/access';
import type { Config } from '../config';
import type { ServiceContext } from '../context';
import { findPgError } from '../errors';
import { applyFlowResult, FLOW_PURPOSES, type FlowPurpose } from './flows';
import { createLlmClient, type LlmClient, LlmError, type LlmResponse } from './llm';
import { assemblePrompt, loadPromptInputs } from './prompt';
import { RunAttachments } from './run-attachments';
import {
  appendEvent,
  insertMessage,
  loadConfirmations,
  loadMessages,
  loadRun,
  pendingToolUses,
  type RunRow,
  runDto,
  toNeutral,
} from './store';
import { RunTools, toolErrorMessage } from './tools-runtime';

/*
 * Loop do agente no worker (spec 011, guia do DBA em docs/016):
 *  - a execução chega reservada (ai_run_claim, status running, lock_token);
 *  - transações curtas: nada fica aberto durante a chamada ao modelo;
 *  - heartbeat a cada poucos segundos (renova a reserva e descobre o pedido de
 *    cancelamento; perder a reserva = parar sem gravar mais nada);
 *  - eventos de streaming em ai_run_events (NOTIFY → SSE da API);
 *  - tools em ask no kit do agente (spec 021) e as escritas de MCP viram ai_tool_confirmations e a execução
 *    passa a awaiting_confirmation; decididas, ela volta à fila e este mesmo
 *    loop retoma executando as aprovadas e devolvendo a recusa das rejeitadas;
 *  - escritas de negócio com o ator agent + app.agent_run_id (ServiceContext).
 */

export type WorkerDeps = { db: Database; config: Config; log: FastifyBaseLogger };
export type ClaimedRun = RunRow & { lock_token: string };

const HEARTBEAT_MS = 3_000;
const DEFAULT_MAX_ITERATIONS = 20;
const FLUSH_MS = 120;

class LockLost extends Error {}
class Canceled extends Error {}

type AgentRow = {
  id: string;
  name: string;
  system_prompt: string;
  params: AgentParams;
};

type ConversationRow = {
  id: string;
  title: string | null;
  title_source: 'auto' | 'user';
  screen_context: Record<string, unknown> | null;
  purpose: string;
};

export async function processRun(deps: WorkerDeps, claimed: ClaimedRun): Promise<void> {
  const { db, log } = deps;
  const runId = claimed.id;
  const token = claimed.lock_token;
  const abort = new AbortController();
  let canceled = false;
  let lost = false;

  const beat = async () => {
    try {
      const result = await db.execute<{ cancel: boolean }>(sql`SELECT ai_run_heartbeat(${runId}::uuid, ${token}::uuid) AS cancel`);
      if (result.rows[0]?.cancel && !canceled) {
        canceled = true;
        abort.abort(new Canceled());
      }
    } catch (error) {
      if (findPgError(error)?.code === '23514') {
        lost = true;
        abort.abort(new LockLost());
      } else log.warn({ err: error, runId }, 'agente: heartbeat falhou');
    }
  };
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  const checkpoint = async () => {
    await beat();
    if (lost) throw new LockLost();
    if (canceled) throw new Canceled();
  };

  let tools: RunTools | null = null;
  try {
    const loaded = await loadContext(db, claimed);
    const { agent, conversation, actor } = loaded;
    const purpose = FLOW_PURPOSES.includes(conversation.purpose as FlowPurpose) ? (conversation.purpose as FlowPurpose) : null;
    const access = await loadAccess(db, actor);
    const ctx: ServiceContext = { db, config: deps.config, access, actorKind: 'agent', agentRunId: runId };

    const creds = await db.execute<{ kind: 'anthropic' | 'openai'; base_url: string | null; api_key: string | null; model: string }>(
      sql`SELECT kind, base_url, api_key, model FROM ai_run_provider_credentials(${runId}::uuid)`,
    );
    const cred = creds.rows[0]!;
    const flags = await db.execute<{ log_bodies: boolean; prompt_cache_enabled: boolean; thinking_enabled: boolean }>(
      sql`SELECT log_bodies, prompt_cache_enabled, thinking_enabled FROM ai_providers WHERE id = ${claimed.provider_id}`,
    );
    const flag = flags.rows[0];
    // Cada chamada vira uma requisição registrada (spec 023), com as tentativas do invólucro; o banco completa os vínculos pela execução.
    // Cache de prompt e raciocínio seguem os interruptores do provedor (spec 024).
    const llm = createLlmClient(
      {
        kind: cred.kind,
        baseUrl: cred.base_url,
        apiKey: cred.api_key,
        promptCache: flag?.prompt_cache_enabled ?? true,
        thinking: flag?.thinking_enabled ?? true,
      },
      {
        db,
        runId,
        logBodies: Boolean(flag?.log_bodies),
        maxAttempts: deps.config.aiRequestMaxAttempts,
        backoffMs: deps.config.aiRequestBackoffMs,
        log,
      },
    );

    // Tools internas pelo kit do agente (spec 021); fluxos (leitura de documento, sugestões de classificação) rodam sem tools.
    tools = await RunTools.forAgent(
      db,
      agent.id,
      async (serverId) => {
        const r = await db.execute<{ headers: Record<string, string> }>(
          sql`SELECT ai_run_mcp_headers(${runId}::uuid, ${serverId}::uuid) AS headers`,
        );
        return r.rows[0]?.headers ?? {};
      },
      { internal: !purpose, mcp: !purpose, isAdmin: actor.role === 'admin' },
    );

    // Instruções do usuário, contexto automático e instructions dos MCP: montados uma vez por execução (spec 022).
    const promptInputs = await loadPromptInputs(db, access, agent, purpose);

    // Imagens e PDFs pela visão do agente: direta, por descrição ou pela camada de texto (spec 024).
    const attachments = new RunAttachments(deps, {
      runId,
      conversationId: conversation.id,
      agentId: agent.id,
      userId: actor.id,
      textProviderId: claimed.provider_id,
      signal: abort.signal,
    });

    await appendEvent(db, runId, { type: 'status', status: 'running' });
    const maxIterations = purpose ? 1 : (agent.params.max_tool_iterations ?? DEFAULT_MAX_ITERATIONS);

    for (;;) {
      await checkpoint();
      // O kit vale na próxima chamada: relido a cada volta (lista e modos), sem reabrir as sessões MCP.
      await tools.refreshInternal(db);
      const rows = await loadMessages(db, conversation.id);
      const pending = pendingToolUses(rows);
      if (pending.length > 0) {
        const outcome = await resolvePending(ctx, tools, runId, token, conversation.id, pending);
        if (outcome === 'awaiting') return;
        continue;
      }
      const iterations = rows.filter((m) => m.role === 'assistant' && m.run_id === runId).length;
      if (iterations >= maxIterations) {
        if (purpose) break;
        await finish(db, runId, token, 'failed', t.agents.errors.maxIterations);
        return;
      }

      const system = assemblePrompt(promptInputs, { purpose, screen: conversation.screen_context });
      const history = balanceToolUses(toNeutral(rows));
      // MCP no modo user: bloco do papel user no início do histórico enviado, nunca gravado em ai_messages.
      const messages: NeutralMessage[] = system.mcpUserBlock
        ? [{ role: 'user', content: [{ type: 'text', text: system.mcpUserBlock }] }, ...history]
        : history;
      await attachments.prepare(messages);
      if (lost) throw new LockLost();
      const response = await callModel(db, llm, runId, {
        model: claimed.model,
        system: system.stable,
        systemUser: system.user,
        systemVolatile: system.volatile,
        messages,
        tools: tools.list,
        params: agent.params,
        loadAttachment: attachments.load,
        signal: abort.signal,
        operation: 'chat',
        purpose: purpose ?? 'chat',
      });
      if (lost) throw new LockLost();

      const content: AssistantBlock[] = response.content.length > 0 ? response.content : [{ type: 'text', text: '' }];
      await db.transaction(async (tx) => {
        const message = await insertMessage(tx, conversation.id, 'assistant', content, runId);
        await tx.execute(sql`
          INSERT INTO ai_usage (run_id, message_id, purpose, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, request_id)
          VALUES (${runId}, ${message.id}, ${purpose ?? 'chat'}, ${response.usage.inputTokens}, ${response.usage.outputTokens},
                  ${response.usage.cacheWriteTokens}, ${response.usage.cacheReadTokens}, ${response.requestId})`);
        await appendEvent(tx, runId, { type: 'message', message: { ...messageOut(message), usage: [] } });
        const run = await loadRun(tx, runId);
        if (run) await appendEvent(tx, runId, { type: 'usage', run: runDto(run) });
      });

      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stopReason !== 'tool_use') {
        if (response.stopReason === 'refusal') {
          await finish(db, runId, token, 'failed', t.agents.errors.providerError('o modelo recusou a solicitação'));
          return;
        }
        if (toolUses.length > 0) {
          // Pedido de tool truncado (max_tokens): fecha os tool_use com erro para manter o histórico válido.
          await insertToolResults(
            db,
            runId,
            conversation.id,
            toolUses.map((b) => ({
              type: 'tool_result',
              tool_use_id: (b as { id: string }).id,
              content: t.agents.errors.toolInvalidInput('resposta truncada'),
              is_error: true,
            })),
          );
        }
        break;
      }
    }

    if (purpose) {
      const rows = await loadMessages(db, conversation.id);
      const last = [...rows].reverse().find((m) => m.role === 'assistant' && m.run_id === runId);
      await applyFlowResult(ctx, purpose, conversation.screen_context ?? {}, last ? blocksText(last.content) : '');
    } else if (conversation.title === null && conversation.title_source === 'auto') {
      await autoTitle(db, llm, runId, conversation.id, claimed.model).catch((error) =>
        log.warn({ err: error, runId }, 'agente: título automático falhou'),
      );
    }
    await finish(db, runId, token, 'completed', null);
  } catch (error) {
    if (error instanceof LockLost || lost) {
      log.warn({ runId }, 'agente: reserva perdida; parando sem gravar');
      return;
    }
    if (error instanceof Canceled || canceled || ((error as { name?: string })?.name === 'AbortError' && canceled)) {
      await cancelOpenToolUses(db, runId, claimed.conversation_id).catch(() => {});
      await finish(db, runId, token, 'canceled', null).catch(() => {});
      return;
    }
    const message = error instanceof LlmError ? t.agents.errors.providerError(error.message) : toolErrorMessage(error) || t.errors.generic;
    log.error({ err: error, runId }, 'agente: execução falhou');
    if (error instanceof LlmError && error.retryable && claimed.attempts < claimed.max_attempts) {
      // Volta à fila para nova tentativa (a reserva conta as tentativas).
      await db
        .execute(sql`UPDATE ai_runs SET status = 'queued' WHERE id = ${runId} AND status = 'running' AND lock_token = ${token}::uuid`)
        .catch(() => {});
      await appendEvent(db, runId, { type: 'error', message }).catch(() => {});
      return;
    }
    await finish(db, runId, token, 'failed', message.slice(0, 4000)).catch((e) =>
      log.error({ err: e, runId }, 'agente: falha ao encerrar'),
    );
  } finally {
    clearInterval(timer);
    await tools?.close();
  }
}

function messageOut(m: Awaited<ReturnType<typeof insertMessage>>) {
  return {
    id: m.id,
    seq: Number(m.seq),
    role: m.role,
    content: m.content,
    runId: m.run_id,
    createdAt: new Date(m.created_at).toISOString(),
  };
}

async function loadContext(db: Database, run: RunRow) {
  const agentResult = await db.execute<AgentRow>(sql`
    SELECT id, name, system_prompt, params FROM ai_agents WHERE id = ${run.agent_id}`);
  const conversationResult = await db.execute<ConversationRow>(
    sql`SELECT id, title, title_source, screen_context, purpose FROM ai_conversations WHERE id = ${run.conversation_id}`,
  );
  const [user] = await db.select(userColumns).from(users).where(eq(users.id, run.user_id));
  if (!user?.isActive) throw new Error('usuário da execução inativo');
  return {
    agent: agentResult.rows[0]!,
    conversation: conversationResult.rows[0]!,
    actor: { id: user.id, username: user.username, email: user.email, role: user.role as Actor['role'], isActive: user.isActive } as Actor,
  };
}

/** Chama o modelo com streaming: deltas de texto viram eventos (agrupados a cada ~120 ms). */
async function callModel(db: Database, llm: LlmClient, runId: string, request: Parameters<LlmClient['chat']>[0]): Promise<LlmResponse> {
  let text = '';
  let thinking = '';
  let flushing: Promise<unknown> = Promise.resolve();
  const flush = () => {
    const pendingText = text;
    const pendingThinking = thinking;
    text = '';
    thinking = '';
    flushing = flushing.then(async () => {
      if (pendingThinking) await appendEvent(db, runId, { type: 'thinking_delta', text: pendingThinking });
      if (pendingText) await appendEvent(db, runId, { type: 'text_delta', text: pendingText });
    });
  };
  const timer = setInterval(flush, FLUSH_MS);
  try {
    return await llm.chat({
      ...request,
      onText: (delta) => {
        text += delta;
      },
      onThinking: (delta) => {
        thinking += delta;
      },
    });
  } finally {
    clearInterval(timer);
    flush();
    await flushing.catch(() => {});
  }
}

async function insertToolResults(db: Database, runId: string, conversationId: string, results: ToolResultBlock[]) {
  await db.transaction(async (tx) => {
    const message = await insertMessage(tx, conversationId, 'tool', results, runId);
    await appendEvent(tx, runId, { type: 'message', message: { ...messageOut(message), usage: [] } });
  });
}

/**
 * Resolve os tool_use pendentes: pede confirmação do que precisa (e para) ou
 * executa tudo na ordem (aprovadas, recusadas viram erro para o modelo).
 */
async function resolvePending(
  ctx: ServiceContext,
  tools: RunTools,
  runId: string,
  token: string,
  conversationId: string,
  pending: { id: string; name: string; input: Record<string, unknown> }[],
): Promise<'awaiting' | 'done'> {
  const db = ctx.db;
  const confirmations = new Map((await loadConfirmations(db, runId)).map((c) => [c.toolUseId, c]));
  const preErrors = new Map<string, string>();
  const toConfirm: { use: (typeof pending)[number]; preview: unknown }[] = [];

  for (const use of pending) {
    const tool = tools.resolve(use.name);
    if (!tool) continue;
    if ('__invalid_json' in use.input) {
      preErrors.set(use.id, t.agents.errors.toolInvalidInput('JSON inválido'));
      continue;
    }
    if (!tools.requiresConfirmation(tool) || confirmations.has(use.id)) continue;
    try {
      toConfirm.push({ use, preview: await tools.preview(ctx, tool, use.input) });
    } catch (error) {
      preErrors.set(use.id, toolErrorMessage(error));
    }
  }

  if (toConfirm.length > 0 || [...confirmations.values()].some((c) => c.status === 'pending')) {
    const ok = await db.transaction(async (tx) => {
      for (const { use, preview } of toConfirm) {
        await tx.execute(sql`
          INSERT INTO ai_tool_confirmations (run_id, tool_use_id, tool_name, input, preview)
          VALUES (${runId}, ${use.id}, ${use.name}, ${JSON.stringify(use.input)}::jsonb, ${JSON.stringify(preview)}::jsonb)
          ON CONFLICT (run_id, tool_use_id) DO NOTHING`);
      }
      const moved = await tx.execute(sql`
        UPDATE ai_runs SET status = 'awaiting_confirmation'
         WHERE id = ${runId} AND status = 'running' AND lock_token = ${token}::uuid RETURNING id`);
      if (moved.rows.length === 0) return false;
      await appendEvent(tx, runId, { type: 'confirmation', confirmations: await loadConfirmations(tx, runId, true) });
      await appendEvent(tx, runId, { type: 'status', status: 'awaiting_confirmation' });
      return true;
    });
    if (!ok) throw new LockLost();
    return 'awaiting';
  }

  // Escritas sem confirmação que já tinham começado antes de uma queda não são repetidas.
  const started = await db.execute<{ tool_use_id: string }>(sql`
    SELECT payload ->> 'toolUseId' AS tool_use_id FROM ai_run_events WHERE run_id = ${runId} AND event_type = 'tool_start'`);
  const alreadyStarted = new Set(started.rows.map((r) => r.tool_use_id));

  const results: ToolResultBlock[] = [];
  for (const use of pending) {
    const tool = tools.resolve(use.name);
    const confirmation = confirmations.get(use.id);
    let outcome: { content: string; isError: boolean; summary: string };
    if (!tool) outcome = errorOutcome(t.agents.errors.toolUnknown(use.name));
    else if (preErrors.has(use.id)) outcome = errorOutcome(preErrors.get(use.id)!);
    else if (confirmation && confirmation.status === 'rejected')
      outcome = errorOutcome(t.agents.errors.confirmationRejected(confirmation.reason));
    else if (confirmation && confirmation.status === 'expired') outcome = errorOutcome(t.agents.errors.confirmationExpired);
    else if (!confirmation && tool.write && alreadyStarted.has(use.id))
      outcome = errorOutcome('A execução foi interrompida durante esta ação; confira o resultado antes de repetir.');
    else {
      await appendEvent(db, runId, { type: 'tool_start', toolUseId: use.id, name: use.name, title: tool.title });
      outcome = await tools.execute(ctx, tool, use.input, { toolUseId: use.id, runId });
    }
    await appendEvent(db, runId, {
      type: 'tool_result',
      toolUseId: use.id,
      name: use.name,
      isError: outcome.isError,
      summary: outcome.summary,
    });
    results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
  }
  await insertToolResults(db, runId, conversationId, results);
  return 'done';
}

const errorOutcome = (message: string) => ({ content: message, isError: true, summary: message.slice(0, 200) });

/** Fecha os tool_use pendentes com "cancelado" (o histórico fica válido para a próxima mensagem). */
export async function cancelOpenToolUses(db: Database | ServiceContext['db'], runId: string, conversationId: string) {
  const rows = await loadMessages(db, conversationId);
  const pending = pendingToolUses(rows);
  if (pending.length === 0) return;
  const last = [...rows].reverse().find((m) => m.role === 'assistant');
  if (!last || last.run_id !== runId) return;
  await insertMessage(
    db,
    conversationId,
    'tool',
    pending.map((use) => ({ type: 'tool_result', tool_use_id: use.id, content: t.agents.errors.canceled, is_error: true })),
    runId,
  );
}

async function finish(db: Database, runId: string, token: string, status: 'completed' | 'failed' | 'canceled', error: string | null) {
  await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE ai_runs SET status = ${status}, error = ${error}
       WHERE id = ${runId} AND status = 'running' AND lock_token = ${token}::uuid RETURNING id`);
    if (updated.rows.length === 0) return;
    await appendEvent(tx, runId, { type: 'done', status, error });
  });
}

/** Título automático (purpose title) a partir do começo da conversa. */
async function autoTitle(db: Database, llm: LlmClient, runId: string, conversationId: string, model: string) {
  const rows = await loadMessages(db, conversationId);
  const firstUser = rows.find((m) => m.role === 'user');
  const firstAnswer = rows.find((m) => m.role === 'assistant' && blocksText(m.content).trim());
  const question = firstUser ? blocksText(firstUser.content).slice(0, 2000) : '';
  if (!question.trim()) return;
  const response = await llm.chat({
    model,
    system:
      'Gere um título curto (no máximo 6 palavras, em português, sem aspas nem ponto final) que resuma o assunto da conversa. Responda só com o título.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Usuário: ${question}\n\nAssistente: ${firstAnswer ? blocksText(firstAnswer.content).slice(0, 1000) : ''}`,
          },
        ],
      },
    ],
    tools: [],
    params: { max_tokens: 1024, reasoning_effort: 'low' },
    loadAttachment: async () => null,
    operation: 'title',
    purpose: 'title',
  });
  await db.execute(sql`
    INSERT INTO ai_usage (run_id, purpose, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, request_id)
    VALUES (${runId}, 'title', ${response.usage.inputTokens}, ${response.usage.outputTokens}, ${response.usage.cacheWriteTokens},
            ${response.usage.cacheReadTokens}, ${response.requestId})`);
  const title = blocksText(response.content)
    .replace(/["'«»“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .slice(0, 120);
  if (!title) return;
  const updated = await db.execute(sql`
    UPDATE ai_conversations SET title = ${title} WHERE id = ${conversationId} AND title IS NULL AND title_source = 'auto' RETURNING id`);
  if (updated.rows.length > 0) await appendEvent(db, runId, { type: 'title', title });
}
