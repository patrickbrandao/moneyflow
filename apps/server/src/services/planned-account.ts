import type { Executor } from '@moneyflow/db';
import type { PlannedAccount } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound } from '../errors';

/*
 * Conta prevista dos títulos (spec 033): onde o pagamento sai (ou o
 * recebimento entra). O contrato a preenche nas parcelas; vale em qualquer
 * título. Conta de outra caixa (em que o usuário escreve) pede a conta de
 * passagem, da caixa do título; o banco confere tipo e caixas.
 */

/** Conta prevista do título `x` (spec 033), com os nomes; precisa de PLANNED_JOINS. */
export const PLANNED_SELECT = sql`x.planned_account_id, pa.name AS planned_account_name, pa.caixa_id AS planned_account_caixa_id,
  x.planned_transit_account_id, pt.name AS planned_transit_account_name, x.planned_account_custom`;
export const PLANNED_JOINS = sql`LEFT JOIN financial_accounts pa ON pa.id = x.planned_account_id
  LEFT JOIN financial_accounts pt ON pt.id = x.planned_transit_account_id`;

export function plannedOf(r: Record<string, unknown>): PlannedAccount {
  return {
    plannedAccountId: (r.plannedAccountId as string | null) ?? null,
    plannedAccountName: (r.plannedAccountName as string | null) ?? null,
    plannedAccountCaixaId: (r.plannedAccountCaixaId as string | null) ?? null,
    plannedTransitAccountId: (r.plannedTransitAccountId as string | null) ?? null,
    plannedTransitAccountName: (r.plannedTransitAccountName as string | null) ?? null,
    plannedAccountCustom: Boolean(r.plannedAccountCustom),
  };
}

/**
 * Normaliza a conta prevista pedida para um título da caixa `caixaId`: na
 * mesma caixa, sem passagem; de outra caixa, exige escrita lá (a passagem, se
 * faltar, o banco recusa com titles_planned_transit_account_check).
 */
export async function resolvePlannedAccount(
  ctx: ServiceContext,
  tx: Executor,
  caixaId: string,
  accountId: string | null,
  transitId: string | null,
): Promise<{ plannedAccountId: string | null; plannedTransitAccountId: string | null }> {
  if (!accountId) return { plannedAccountId: null, plannedTransitAccountId: null };
  const found = await tx.execute<{ caixa_id: string }>(sql`SELECT caixa_id FROM financial_accounts WHERE id = ${accountId}`);
  const account = found.rows[0];
  if (!account) throw notFound();
  if (account.caixa_id === caixaId) return { plannedAccountId: accountId, plannedTransitAccountId: null };
  ctx.access.assertWrite(account.caixa_id);
  return { plannedAccountId: accountId, plannedTransitAccountId: transitId };
}
