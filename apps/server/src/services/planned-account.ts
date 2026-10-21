import type { Executor } from '@moneyflow/db';
import { type PlannedAccount, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { notFound, unprocessable } from '../errors';

/*
 * Conta prevista dos títulos (specs 033 e 034): a conta da caixa do título
 * (corrente, poupança ou cofre) onde o pagamento sai ou o recebimento entra. A
 * série a copia para cada ocorrência; a conciliação procura a ocorrência por
 * ela. O banco confere a caixa (titles_planned_account_check).
 */

/** Conta prevista do título `x`, com o nome e o tipo; precisa de PLANNED_JOINS. */
export const PLANNED_SELECT = sql`x.planned_account_id, pa.name AS planned_account_name, pa.kind AS planned_account_kind,
  x.planned_account_custom`;
export const PLANNED_JOINS = sql`LEFT JOIN financial_accounts pa ON pa.id = x.planned_account_id`;

export function plannedOf(r: Record<string, unknown>): PlannedAccount {
  return {
    plannedAccountId: (r.plannedAccountId as string | null) ?? null,
    plannedAccountName: (r.plannedAccountName as string | null) ?? null,
    plannedAccountKind: (r.plannedAccountKind as PlannedAccount['plannedAccountKind']) ?? null,
    plannedAccountCustom: Boolean(r.plannedAccountCustom),
  };
}

/** Confere que a conta pedida é da caixa do título (null = sem conta prevista). */
export async function assertPlannedAccount(tx: Executor, caixaId: string, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const found = await tx.execute<{ caixa_id: string }>(sql`SELECT caixa_id FROM financial_accounts WHERE id = ${accountId}`);
  const account = found.rows[0];
  if (!account) throw notFound();
  if (account.caixa_id !== caixaId) throw unprocessable(t.contracts.errors.plannedAccountCaixa, 'titles_planned_account_check');
  return accountId;
}
