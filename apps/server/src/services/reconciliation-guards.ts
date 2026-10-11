import type { Executor } from '@moneyflow/db';
import { t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { unprocessable } from '../errors';

/*
 * Regras da conciliação (spec 009) que afetam a F1: movimento conciliado com
 * uma linha de extrato não é apagado (desfaça a conciliação antes), e a
 * sugestão que aponta para um título/movimento é removida antes de apagá-lo
 * (a FK de statement_lines barraria com 23503).
 */

const uuidList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function assertNotReconciled(tx: Executor, movementIds: string[]) {
  if (movementIds.length === 0) return;
  const result = await tx.execute(
    sql`SELECT 1 FROM statement_lines WHERE status = 'matched' AND movement_id IN (${uuidList(movementIds)}) LIMIT 1`,
  );
  if (result.rows.length > 0) throw unprocessable(t.errors.movementReconciled, 'movement_reconciled');
}

/** Linhas sugeridas para estes títulos/movimentos voltam a "nova". */
export async function clearStatementSuggestions(tx: Executor, refs: { movementIds?: string[]; titleIds?: string[] }) {
  const conditions = [];
  if (refs.movementIds?.length) conditions.push(sql`movement_id IN (${uuidList(refs.movementIds)})`);
  if (refs.titleIds?.length) conditions.push(sql`title_id IN (${uuidList(refs.titleIds)})`);
  if (conditions.length === 0) return;
  await tx.execute(sql`
    UPDATE statement_lines SET status = 'new', movement_id = NULL, title_id = NULL
     WHERE status = 'suggested' AND (${sql.join(conditions, sql` OR `)})`);
}

/** Movimentos de transferências (para checar antes de excluí-las). */
export async function transferMovementIds(tx: Executor, transferIds: string[]): Promise<string[]> {
  if (transferIds.length === 0) return [];
  const result = await tx.execute<{ id: string }>(sql`SELECT id FROM movements WHERE transfer_id IN (${uuidList(transferIds)})`);
  return result.rows.map((r) => r.id);
}
