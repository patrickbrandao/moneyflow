import { addDays, type Statement, type StatementRow, type statementQuery } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServiceContext } from '../context';
import { getAccount, listAccounts } from './caixas';
import { camel } from './util';

/** Extrato da conta: movimentos do período com saldo corrente (saldo inicial + movimentos). */
export async function accountStatement(ctx: ServiceContext, accountId: string, query: z.output<typeof statementQuery>): Promise<Statement> {
  const account = await getAccount(ctx, accountId);
  const summary = (await listAccounts(ctx, { caixaId: account.caixaId, archived: true })).find((a) => a.id === accountId)!;

  // Saldo ao fim do dia anterior ao período (NULL antes da abertura = saldo inicial).
  let openingCents = account.openingBalanceCents;
  if (query.from) {
    const result = await ctx.db.execute<{ balance: number | null }>(
      sql`SELECT financial_account_balance_at(${accountId}::uuid, ${addDays(query.from, -1)}::date) AS balance`,
    );
    openingCents = result.rows[0]?.balance ?? account.openingBalanceCents;
  }

  const result = await ctx.db.execute(sql`
    SELECT m.id, m.occurred_on, m.amount_cents, m.kind, m.description, en.name AS entity_name, cat.name AS category_name,
           s.title_id, t.description AS title_description, m.settlement_id,
           (m.settlement_id IS NOT NULL AND sign(m.amount_cents) <> CASE t.direction WHEN 'payable' THEN -1 ELSE 1 END) AS is_reversal,
           m.transfer_id, oa.name AS counterpart_account_name, oc.name AS counterpart_caixa_name,
           (${openingCents}::bigint + sum(m.amount_cents) OVER (ORDER BY m.occurred_on, m.created_at, m.id))::bigint AS balance_cents
      FROM movements m
      LEFT JOIN settlements s ON s.id = m.settlement_id
      LEFT JOIN titles t ON t.id = s.title_id
      LEFT JOIN entities en ON en.id = coalesce(m.entity_id, t.entity_id)
      LEFT JOIN categories cat ON cat.id = coalesce(m.category_id, t.category_id)
      LEFT JOIN movements om ON om.transfer_id = m.transfer_id AND om.id <> m.id
      LEFT JOIN financial_accounts oa ON oa.id = om.financial_account_id
      LEFT JOIN caixas oc ON oc.id = oa.caixa_id
     WHERE m.financial_account_id = ${accountId}
       ${query.from ? sql`AND m.occurred_on >= ${query.from}::date` : sql``}
       ${query.to ? sql`AND m.occurred_on <= ${query.to}::date` : sql``}
     ORDER BY m.occurred_on, m.created_at, m.id`);
  const rows = result.rows.map((row) => camel<StatementRow>(row));
  return {
    account: summary,
    from: query.from ?? null,
    to: query.to ?? null,
    openingCents,
    closingCents: rows.at(-1)?.balanceCents ?? openingCents,
    rows,
  };
}
