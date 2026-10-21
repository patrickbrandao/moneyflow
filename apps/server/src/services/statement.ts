import {
  type AccountCategoryEntry,
  type AccountSummary,
  type AccountSummaryCategory,
  type AccountSummaryMonth,
  type accountCategoryEntriesQuery,
  type accountSummaryQuery,
  addDays,
  type Statement,
  type StatementRow,
  type statementQuery,
  todayIso,
} from '@moneyflow/shared';
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

/**
 * Linhas por categoria do resumo da conta, pelo regime de caixa (as mesmas regras de
 * report_category_totals, só com os movimentos desta conta): baixas pela categoria do título e
 * avulsos pela deles (sem categoria, o tipo vem do sinal). Base da pizza e da lista de cada fatia.
 */
function categoryLines(accountId: string, from: string, to: string) {
  return sql`
      SELECT c.kind, coalesce(c.parent_id, c.id) AS group_category_id, c.id AS category_id, m.id AS movement_id,
             CASE c.kind WHEN 'expense' THEN -m.amount_cents ELSE m.amount_cents END AS amount_cents
        FROM movements m
        JOIN settlements s ON s.id = m.settlement_id
        JOIN titles t ON t.id = s.title_id
        JOIN categories c ON c.id = t.category_id
       WHERE m.kind = 'settlement'
         AND m.financial_account_id = ${accountId}
         AND m.occurred_on BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT x.kind, coalesce(c.parent_id, c.id), c.id, m.id,
             CASE x.kind WHEN 'expense' THEN -m.amount_cents ELSE m.amount_cents END
        FROM movements m
        LEFT JOIN categories c ON c.id = m.category_id
        CROSS JOIN LATERAL (SELECT coalesce(c.kind, CASE WHEN m.amount_cents > 0 THEN 'income' ELSE 'expense' END) AS kind) x
       WHERE m.kind = 'adjustment'
         AND m.financial_account_id = ${accountId}
         AND m.occurred_on BETWEEN ${from}::date AND ${to}::date`;
}

/**
 * Resumo da conta (spec 004): entradas e saídas por mês (transferências à parte) com o saldo ao fim
 * de cada mês, despesa e receita por categoria pelo regime de caixa (as mesmas regras de
 * report_category_totals, só com os movimentos desta conta) e a situação da conciliação.
 */
export async function accountSummary(
  ctx: ServiceContext,
  accountId: string,
  query: z.output<typeof accountSummaryQuery>,
): Promise<AccountSummary> {
  const account = await getAccount(ctx, accountId);
  const summary = (await listAccounts(ctx, { caixaId: account.caixaId, archived: true })).find((a) => a.id === accountId)!;
  const { from, to } = query;
  const today = todayIso();

  const monthly = await ctx.db.execute(sql`
    WITH months AS (
      SELECT g::date AS month
        FROM generate_series(date_trunc('month', ${from}::date), date_trunc('month', ${to}::date), interval '1 month') g
    ), totals AS (
      SELECT date_trunc('month', m.occurred_on)::date AS month,
             coalesce(sum(m.amount_cents) FILTER (WHERE m.kind <> 'transfer' AND m.amount_cents > 0), 0) AS inflow_cents,
             coalesce(-sum(m.amount_cents) FILTER (WHERE m.kind <> 'transfer' AND m.amount_cents < 0), 0) AS outflow_cents,
             coalesce(sum(m.amount_cents) FILTER (WHERE m.kind = 'transfer' AND m.amount_cents > 0), 0) AS transfer_in_cents,
             coalesce(-sum(m.amount_cents) FILTER (WHERE m.kind = 'transfer' AND m.amount_cents < 0), 0) AS transfer_out_cents
        FROM movements m
       WHERE m.financial_account_id = ${accountId}
         AND m.occurred_on BETWEEN ${from}::date AND ${to}::date
       GROUP BY 1
    )
    SELECT mo.month,
           coalesce(t.inflow_cents, 0)::bigint AS inflow_cents,
           coalesce(t.outflow_cents, 0)::bigint AS outflow_cents,
           coalesce(t.transfer_in_cents, 0)::bigint AS transfer_in_cents,
           coalesce(t.transfer_out_cents, 0)::bigint AS transfer_out_cents,
           CASE WHEN mo.month <= ${today}::date
                THEN financial_account_balance_at(${accountId}::uuid, (mo.month + interval '1 month' - interval '1 day')::date)
           END AS closing_cents
      FROM months mo
      LEFT JOIN totals t ON t.month = mo.month
     ORDER BY mo.month`);

  const categories = await ctx.db.execute(sql`
    WITH lines AS (${categoryLines(accountId, from, to)})
    SELECT l.kind, l.group_category_id, g.name AS group_name, g.color_slot AS group_color_slot,
           l.category_id, c.name AS category_name, c.color_slot,
           sum(l.amount_cents)::bigint AS amount_cents, count(*)::int AS entries
      FROM lines l
      LEFT JOIN categories g ON g.id = l.group_category_id
      LEFT JOIN categories c ON c.id = l.category_id
     GROUP BY l.kind, l.group_category_id, g.name, g.color_slot, l.category_id, c.name, c.color_slot
     ORDER BY l.kind, amount_cents DESC`);

  let reconciliation: AccountSummary['reconciliation'] = null;
  if (account.kind === 'checking' || account.kind === 'savings') {
    const result = await ctx.db.execute<NonNullable<AccountSummary['reconciliation']>>(sql`
      SELECT (SELECT count(*) FROM statement_imports i WHERE i.financial_account_id = ${accountId})::int AS imports,
             (SELECT i.id FROM statement_imports i WHERE i.financial_account_id = ${accountId}
               ORDER BY i.period_end DESC, i.created_at DESC LIMIT 1) AS "lastImportId",
             (SELECT max(i.period_end) FROM statement_imports i WHERE i.financial_account_id = ${accountId}) AS "lastPeriodEnd",
             count(*) FILTER (WHERE l.status = 'new')::int AS "newLines",
             count(*) FILTER (WHERE l.status = 'suggested')::int AS "suggestedLines"
        FROM statement_lines l
       WHERE l.financial_account_id = ${accountId}`);
    reconciliation = result.rows[0]!;
  }

  return {
    account: summary,
    from,
    to,
    months: monthly.rows.map((row) => camel<AccountSummaryMonth>(row)),
    categories: categories.rows.map((row) => camel<AccountSummaryCategory>(row)),
    reconciliation,
  };
}

/** Lançamentos de uma fatia da pizza do resumo (spec 004): as linhas que somam os grupos pedidos, por data. */
export async function accountCategoryEntries(
  ctx: ServiceContext,
  accountId: string,
  query: z.output<typeof accountCategoryEntriesQuery>,
): Promise<AccountCategoryEntry[]> {
  await getAccount(ctx, accountId);
  const { from, to, kind, groups } = query;
  const ids = groups.filter((g) => g !== 'none');
  const withNone = groups.includes('none');
  const result = await ctx.db.execute(sql`
    WITH lines AS (${categoryLines(accountId, from, to)})
    SELECT l.movement_id, m.occurred_on, l.amount_cents::bigint AS amount_cents, m.kind AS movement_kind, m.description,
           t.id AS title_id, t.description AS title_description, t.direction AS title_direction,
           en.name AS entity_name, l.group_category_id, l.category_id, c.name AS category_name
      FROM lines l
      JOIN movements m ON m.id = l.movement_id
      LEFT JOIN settlements s ON s.id = m.settlement_id
      LEFT JOIN titles t ON t.id = s.title_id
      LEFT JOIN entities en ON en.id = coalesce(m.entity_id, t.entity_id)
      LEFT JOIN categories c ON c.id = l.category_id
     WHERE l.kind = ${kind}
       AND (${
         ids.length > 0
           ? sql`l.group_category_id IN (${sql.join(
               ids.map((g) => sql`${g}::uuid`),
               sql`, `,
             )})`
           : sql`false`
       }
            ${withNone ? sql`OR l.group_category_id IS NULL` : sql``})
     ORDER BY m.occurred_on DESC, m.created_at DESC, m.id`);
  return result.rows.map((row) => camel<AccountCategoryEntry>(row));
}
