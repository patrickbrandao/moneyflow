import type { Database } from '@moneyflow/db';
import { importLink, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import { emitAgentEvent } from './message-worker';

/*
 * Aviso "espera sua aprovação" dos fluxos autônomos (spec 029): quando a
 * execução de uma tarefa agendada ou da conciliação com IA para em
 * awaiting_confirmation, o worker cria a notificação ai_awaiting_approval
 * (sino) e enfileira o evento para os destinos que o assinam. A chave do
 * evento é a última confirmação pendente: a mesma espera avisada de novo
 * (retomada, outra réplica) não duplica.
 */
export async function notifyAwaitingApproval(db: Database, config: Config, runId: string) {
  const result = await db.execute<{
    user_id: string;
    conversation_id: string;
    purpose: string;
    screen_context: Record<string, unknown> | null;
    pending: number;
    last_confirmation: string | null;
    task_name: string | null;
  }>(sql`
    SELECT r.user_id, r.conversation_id, c.purpose, c.screen_context,
           (SELECT count(*)::int FROM ai_tool_confirmations k WHERE k.run_id = r.id AND k.status = 'pending') AS pending,
           (SELECT max(k.id::text) FROM ai_tool_confirmations k WHERE k.run_id = r.id AND k.status = 'pending') AS last_confirmation,
           (SELECT t.name FROM ai_scheduled_task_runs x JOIN ai_scheduled_tasks t ON t.id = x.task_id
             WHERE x.run_id = r.id LIMIT 1) AS task_name
      FROM ai_runs r JOIN ai_conversations c ON c.id = r.conversation_id
     WHERE r.id = ${runId}`);
  const row = result.rows[0];
  if (!row || Number(row.pending) === 0) return { queued: 0 };

  let title = t.agents.tasks.awaitingTitle(row.task_name ?? '');
  let link = `/?conversation=${row.conversation_id}`;
  let caixaId: string | null = null;
  const importId = typeof row.screen_context?.importId === 'string' ? row.screen_context.importId : null;
  if (row.purpose === 'reconcile_statement' && importId) {
    const imp = await db.execute<{
      id: string;
      file_name: string;
      caixa_id: string;
      financial_account_id: string | null;
      card_caixa_id: string | null;
    }>(sql`
      SELECT i.id, a.file_name, coalesce(fa.caixa_id, i.card_caixa_id) AS caixa_id, i.financial_account_id, i.card_caixa_id
        FROM statement_imports i
        JOIN attachments a ON a.id = i.attachment_id
        LEFT JOIN financial_accounts fa ON fa.id = i.financial_account_id
       WHERE i.id = ${importId}`);
    const found = imp.rows[0];
    if (found) {
      title = t.agents.tasks.reconcileAwaitingTitle(found.file_name);
      caixaId = found.caixa_id;
      link = importLink({
        id: found.id,
        caixaId: found.caixa_id,
        financialAccountId: found.financial_account_id,
        cardCaixaId: found.card_caixa_id,
      });
    }
  }
  return emitAgentEvent(db, {
    kind: 'ai_awaiting_approval',
    userId: row.user_id,
    agentRunId: runId,
    eventKey: `run:${runId}:awaiting:${row.last_confirmation}`,
    title,
    text: t.agents.tasks.awaitingBody(Number(row.pending)),
    link,
    caixaId,
    config,
  });
}
