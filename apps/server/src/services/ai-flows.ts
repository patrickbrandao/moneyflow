import type { Executor } from '@moneyflow/db';
import {
  type AiRunDto,
  blocksText,
  type ClassificationSuggestResult,
  type DocumentReadingDto,
  formatBRL,
  isIsoDate,
  normalizeDocument,
  parseBoleto,
  type ReconcileAiStartResult,
  type ReconcileAiStateDto,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { extractJson } from '../agents/flows';
import { loadConfirmations, loadMessages, loadRun, RUN_COLUMNS, type RunRow, runDto } from '../agents/store';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { assertCanStartRun } from './ai-budgets';
import { assertUpload, storeAttachment } from './attachments';
import { updateAccount, updateCaixa } from './caixas';
import { assertReadsImages, createConversation, sendMessage } from './conversations';
import { enqueueImportRecipes, importBusy, insertReconcileSession, lockImport, recipeNameOf, startNextRecipe } from './reconcile-recipes';
import { getImport } from './statements';
import { withTx } from './tx';

/*
 * IA nos fluxos (specs 009, 010, 011): cada uso abre uma conversa arquivada
 * (marcada em ai_conversations.purpose, fora da lista de conversas) com o
 * "agente dos fluxos" — o marcado em /admin/ai ou o primeiro ativo — e enfileira
 * uma execução normal no worker (credenciais pelo banco, uso e custo medidos,
 * auditoria como agente).
 */

/**
 * Agente dos fluxos: o marcado em /admin/ai (ai_agents.use_for_flows), se ele e o
 * provedor estiverem ativos; senão o primeiro ativo com provedor ativo (uma
 * instalação nova funciona sem configurar nada).
 */
export async function flowAgentId(ctx: ServiceContext): Promise<string | null> {
  const result = await ctx.db.execute<{ id: string }>(sql`
    SELECT a.id FROM ai_agents a JOIN ai_providers p ON p.id = a.provider_id
     WHERE a.is_active AND a.archived_at IS NULL AND p.is_active AND p.archived_at IS NULL
     ORDER BY a.use_for_flows DESC, a.created_at, a.id LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

export async function waitRun(db: Executor, runId: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await loadRun(db, runId);
    if (!run) return null;
    if (['completed', 'failed', 'canceled'].includes(run.status)) return run;
    if (Date.now() > until) return run;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

const digits = (value: unknown) => (typeof value === 'string' ? value.replace(/\D/g, '') : '');
const text = (value: unknown, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** Leitura de PDF/imagem (boleto, nota, comprovante) para pré-preencher o título (spec 010). */
export async function readDocumentWithAi(
  ctx: ServiceContext,
  file: { name: string; mime: string; content: Buffer },
): Promise<DocumentReadingDto> {
  const agentId = await flowAgentId(ctx);
  if (!agentId) throw new AppError(501, 'document_reader_unavailable', t.errors.documentReaderUnavailable);
  // Imagem com um agente dos fluxos sem visão: recusada antes de abrir a conversa (spec 024).
  await assertReadsImages(ctx.db, agentId, [file.mime]);
  // Orçamento e limite por minuto (spec 028): a leitura devolve o erro antes de abrir a conversa.
  await assertCanStartRun(ctx, agentId, true);
  const content = assertUpload(file.content);
  const conversation = await createConversation(
    ctx,
    { agentId, title: t.agents.flows.documentConversation(file.name).slice(0, 200) },
    { purpose: 'document_reading', screenContext: { fileName: file.name }, archived: true },
  );
  const attachmentId = await withTx(ctx, (tx) => storeAttachment(tx, ctx, { name: file.name, mime: file.mime, content }));
  const sent = await sendMessage(ctx, conversation.id, {
    text: 'Leia o documento anexo e devolva o JSON pedido.',
    attachmentIds: [attachmentId],
  });
  const run = await waitRun(ctx.db, sent.run.id, ctx.config.aiDocumentTimeoutMs);
  if (run?.status !== 'completed') {
    throw new AppError(422, 'document_unreadable', run?.status === 'failed' && run.error ? run.error : t.agents.errors.documentUnreadable);
  }
  const messages = await loadMessages(ctx.db, conversation.id);
  const answer = [...messages].reverse().find((m) => m.role === 'assistant');
  const data = (extractJson(answer ? blocksText(answer.content) : '') ?? {}) as Record<string, unknown>;

  const reading: DocumentReadingDto = {
    kind: ['boleto', 'invoice', 'receipt'].includes(String(data.kind)) ? (data.kind as DocumentReadingDto['kind']) : 'unknown',
    entityName: text(data.entityName, 200),
    document: digits(data.document) ? normalizeDocument(String(data.document)) : null,
    amountCents: Number.isInteger(data.amountCents) && (data.amountCents as number) > 0 ? (data.amountCents as number) : null,
    dueDate: typeof data.dueDate === 'string' && isIsoDate(data.dueDate) ? data.dueDate : null,
    boletoLine: digits(data.boletoLine).length >= 44 ? digits(data.boletoLine) : null,
    pixPayload: text(data.pixPayload, 512),
    description: text(data.description, 300),
    entityId: null,
    conversationId: conversation.id,
  };
  // A linha digitável manda no valor e no vencimento quando é válida.
  if (reading.boletoLine) {
    const boleto = parseBoleto(reading.boletoLine);
    if (boleto.ok) {
      reading.amountCents = boleto.amountCents ?? reading.amountCents;
      reading.dueDate = boleto.dueDate ?? reading.dueDate;
    } else reading.boletoLine = null;
  }
  if (reading.document) {
    const entity = await ctx.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM entities WHERE document = ${reading.document} AND archived_at IS NULL LIMIT 1`,
    );
    if (entity.rows[0]) {
      reading.entityId = entity.rows[0].id;
      reading.entityName = reading.entityName ?? entity.rows[0].name;
    }
  }
  return reading;
}

/**
 * Sugestões do agente para as linhas novas sem classificação de um import
 * (spec 009): enfileira a execução; as sugestões chegam como "sugerido pelo
 * agente" e esperam a aprovação em lote. `auto` (logo após importar) não falha.
 */
export async function suggestImportClassifications(
  ctx: ServiceContext,
  importId: string,
  opts: { auto?: boolean } = {},
): Promise<ClassificationSuggestResult> {
  const detail = await getImport(ctx, importId);
  if (!detail.canWrite) {
    if (opts.auto) return { queued: false, runId: null, lines: 0 };
    ctx.access.assertWrite(detail.caixaId);
  }
  const lines = detail.lines.filter((l) => l.status === 'new' && l.classificationSource === null).slice(0, 150);
  if (lines.length === 0) return { queued: false, runId: null, lines: 0 };
  const agentId = await flowAgentId(ctx);
  if (!agentId) {
    if (opts.auto) return { queued: false, runId: null, lines: lines.length };
    throw new AppError(501, 'ai_unavailable', t.agents.errors.providerMissing);
  }

  // Orçamento atingido ou limite por minuto (spec 028): logo após importar, a sugestão é pulada (o aviso é o ai_budget_alert).
  try {
    await assertCanStartRun(ctx, agentId, true);
  } catch (error) {
    if (opts.auto && error instanceof AppError && error.status === 429) {
      return { queued: false, runId: null, lines: lines.length, skippedReason: error.message };
    }
    throw error;
  }

  const lineIds = lines.map((l) => l.id);
  const candidates = await ctx.db.execute<{ line_id: string; entity_id: string; name: string }>(sql`
    SELECT l.id AS line_id, e.id AS entity_id, e.name
      FROM statement_lines l
      CROSS JOIN LATERAL (
        SELECT x.id, x.name FROM entities x WHERE x.archived_at IS NULL
         ORDER BY greatest(word_similarity(x.name, l.description), word_similarity(coalesce(x.trade_name, ''), l.description)) DESC
         LIMIT 5) e
     WHERE l.id = ANY (${`{${lineIds.join(',')}}`}::uuid[])`);
  const categories = await ctx.db.execute<{ id: string; name: string; kind: string }>(
    sql`SELECT id, name, kind FROM categories WHERE archived_at IS NULL ORDER BY kind, name`,
  );
  const isCard = Boolean(detail.cardCaixaId);
  const payload = {
    lines: lines.map((l) => ({
      lineId: l.id,
      date: l.postedOn,
      amount: formatBRL(l.amountCents),
      description: l.description,
      categoryKind: isCard || l.amountCents < 0 ? 'expense' : 'income',
      entityCandidates: candidates.rows.filter((c) => c.line_id === l.id).map((c) => ({ id: c.entity_id, name: c.name })),
    })),
    categories: categories.rows,
  };
  const conversation = await createConversation(
    ctx,
    { agentId, title: t.agents.flows.classifyConversation(detail.fileName).slice(0, 200) },
    { purpose: 'classify_lines', screenContext: { importId, lineIds }, archived: true },
  );
  const sent = await sendMessage(ctx, conversation.id, {
    text: `Sugira a classificação destas linhas do extrato ${detail.fileName}:\n${JSON.stringify(payload)}`,
    attachmentIds: [],
  });
  return { queued: true, runId: sent.run.id, lines: lines.length };
}

/* ---------------- conciliação completa com IA (spec 029) ---------------- */

/** A conversa de conciliação mais recente do lote (purpose reconcile_statement, screen_context.importId). */
async function reconcileConversation(db: Executor, importId: string) {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id FROM ai_conversations
     WHERE purpose = 'reconcile_statement' AND screen_context ->> 'importId' = ${importId}
     ORDER BY created_at DESC, id DESC LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** "Conciliar com IA ao importar" da conta ou do cartão do lote. */
async function autoReconcileOf(db: Executor, detail: { financialAccountId: string | null; cardCaixaId: string | null }) {
  const result = detail.financialAccountId
    ? await db.execute<{ on: boolean }>(sql`SELECT ai_auto_reconcile AS on FROM financial_accounts WHERE id = ${detail.financialAccountId}`)
    : await db.execute<{ on: boolean }>(sql`SELECT ai_auto_reconcile AS on FROM caixas WHERE id = ${detail.cardCaixaId}`);
  return Boolean(result.rows[0]?.on);
}

/** O lote importado deve ser conciliado pela IA (interruptor da conta ou do cartão)? */
export async function autoReconcileEnabled(ctx: ServiceContext, importId: string) {
  const detail = await getImport(ctx, importId);
  return autoReconcileOf(ctx.db, detail);
}

/**
 * Conciliação completa do lote pelo agente dos fluxos (spec 029): uma conversa
 * reconcile_statement, como quem importou (ou clicou), com as tools internas do
 * kit do agente; as tools em ask viram o lote de aprovações da tela. `auto`
 * (logo após importar) não falha: devolve o motivo de não ter enfileirado.
 */
export async function reconcileImportWithAi(
  ctx: ServiceContext,
  importId: string,
  opts: { auto?: boolean } = {},
): Promise<ReconcileAiStartResult> {
  const detail = await getImport(ctx, importId);
  const none = (lines: number, skippedReason?: string): ReconcileAiStartResult => ({
    queued: false,
    runId: null,
    conversationId: null,
    lines,
    ...(skippedReason ? { skippedReason } : {}),
  });
  if (!detail.canWrite) {
    if (opts.auto) return none(0);
    ctx.access.assertWrite(detail.caixaId);
  }
  const lines = detail.lines.filter((l) => l.status === 'new' || l.status === 'suggested').length;
  if (lines === 0) {
    if (opts.auto) return none(0);
    throw new AppError(422, 'nothing_to_reconcile', t.agents.reconcile.noLines);
  }
  // Ao importar com receitas "rodar ao importar" da conta/cartão (spec 030): a fila delas, em vez da conciliação genérica.
  if (opts.auto) {
    const recipes = await enqueueImportRecipes(ctx, importId);
    if (recipes > 0) {
      await startNextRecipe(ctx.db, ctx.config, importId);
      const started = await ctx.db.execute<{ run_id: string | null; conversation_id: string | null }>(sql`
        SELECT run_id, conversation_id FROM ai_reconcile_recipe_runs
         WHERE import_id = ${importId} AND trigger_kind = 'import' AND run_id IS NOT NULL
         ORDER BY position, id LIMIT 1`);
      const first = started.rows[0];
      return { queued: true, runId: first?.run_id ?? null, conversationId: first?.conversation_id ?? null, lines, recipes };
    }
  }
  const agentId = await flowAgentId(ctx);
  if (!agentId) {
    if (opts.auto) return none(lines, t.agents.reconcile.noAgent);
    throw new AppError(501, 'ai_unavailable', t.agents.reconcile.noAgent);
  }
  if (await importBusy(ctx.db, importId)) {
    if (opts.auto) {
      const previous = await reconcileConversation(ctx.db, importId);
      const active = previous
        ? await ctx.db.execute<{ id: string }>(sql`
            SELECT id FROM ai_runs WHERE conversation_id = ${previous} AND status IN ('queued', 'running', 'awaiting_confirmation')`)
        : { rows: [] };
      return { queued: false, runId: active.rows[0]?.id ?? null, conversationId: previous, lines };
    }
    throw new AppError(409, 'run_active', t.agents.errors.runActive);
  }
  try {
    await assertCanStartRun(ctx, agentId, true);
  } catch (error) {
    if (opts.auto && error instanceof AppError && error.status === 429) return none(lines, error.message);
    throw error;
  }
  // A checagem (lock do lote + ai_reconcile_import_busy) e a criação da execução na mesma transação (spec 030).
  const created = await withTx(ctx, async (tx) => {
    if (await lockImport(tx, importId)) return null;
    return insertReconcileSession(tx, {
      userId: ctx.access.actor.id,
      agentId,
      title: t.agents.flows.reconcileConversation(detail.fileName),
      screenContext: { importId },
      text: t.agents.flows.reconcileMessage(detail.fileName, importId, lines),
    });
  });
  if (!created) {
    if (opts.auto) return none(lines);
    throw new AppError(409, 'run_active', t.agents.errors.runActive);
  }
  return { queued: true, runId: created.runId, conversationId: created.conversationId, lines };
}

/** O estado da conciliação com IA do lote: interruptor, agente dos fluxos, execução e as ações propostas. */
export async function reconcileAiState(ctx: ServiceContext, importId: string): Promise<ReconcileAiStateDto> {
  const detail = await getImport(ctx, importId);
  const agentId = await flowAgentId(ctx);
  const agent = agentId
    ? (
        await ctx.db.execute<{ id: string; name: string; has_kit: boolean }>(
          sql`SELECT id, name, tool_kit_id IS NOT NULL AS has_kit FROM ai_agents WHERE id = ${agentId}`,
        )
      ).rows[0]
    : undefined;
  const conversationId = await reconcileConversation(ctx.db, importId);
  let run: AiRunDto | null = null;
  let userId: string | null = null;
  if (conversationId) {
    const latest = await ctx.db.execute<RunRow>(sql`
      SELECT ${RUN_COLUMNS} FROM ai_runs r WHERE r.conversation_id = ${conversationId} ORDER BY r.created_at DESC, r.id DESC LIMIT 1`);
    const row = latest.rows[0];
    if (row) {
      run = runDto(row);
      userId = row.user_id;
    }
  }
  const screen = conversationId
    ? (
        await ctx.db.execute<{ screen_context: Record<string, unknown> | null }>(
          sql`SELECT screen_context FROM ai_conversations WHERE id = ${conversationId}`,
        )
      ).rows[0]?.screen_context
    : null;
  return {
    autoEnabled: await autoReconcileOf(ctx.db, detail),
    recipeName: await recipeNameOf(ctx.db, screen),
    agent: agent ? { id: agent.id, name: agent.name, hasKit: Boolean(agent.has_kit) } : null,
    conversationId,
    run,
    confirmations: run?.status === 'awaiting_confirmation' ? await loadConfirmations(ctx.db, run.id, true) : [],
    canDecide: userId === ctx.access.actor.id,
  };
}

/** Liga ou desliga "Conciliar com IA ao importar" na conta ou no cartão do lote (quem escreve na caixa). */
export async function setReconcileAuto(ctx: ServiceContext, importId: string, enabled: boolean) {
  const detail = await getImport(ctx, importId);
  if (detail.financialAccountId) await updateAccount(ctx, detail.financialAccountId, { aiAutoReconcile: enabled });
  else await updateCaixa(ctx, detail.cardCaixaId!, { aiAutoReconcile: enabled });
  return reconcileAiState(ctx, importId);
}
