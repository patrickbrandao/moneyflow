import type { Executor, Tx } from '@moneyflow/db';
import {
  type CardChargeOccurrence,
  type CardChargeSuggestion,
  type Frequency,
  occurrenceDueDate,
  occurrenceWithinRule,
  type RecurrenceRule,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { notFound, unprocessable } from '../errors';
import { insertPurchase, loadCard } from './card-core';
import { uuidArray } from './reports';
import { TERMS_SQL, termsOf } from './series-core';
import { camel } from './util';

/*
 * Cobranças recorrentes esperadas no cartão (spec 034): as ocorrências são
 * calculadas pelo calendário da série (não há títulos); a compra que atende
 * uma ocorrência fica ligada a ela (card_purchases.recurrence_rule_id e
 * occurrence, com o contrato da série). Usado pela conciliação da fatura, pela
 * compra lançada à mão e pelo aviso da cobrança não feita.
 */

type ChargeRule = RecurrenceRule & {
  id: string;
  frequency: Frequency;
  description: string;
  entityName: string | null;
  contractId: string | null;
  contractName: string | null;
  baseCents: number;
  steps: { from: number; cents: number }[];
  terms: CardChargeOccurrence['terms'];
};

async function chargeRules(db: Executor, cardCaixaId: string): Promise<ChargeRule[]> {
  const result = await db.execute(sql`
    SELECT r.id, r.frequency, r.interval_count, r.anchor_day, r.starts_on, r.ends_on, r.installments_total, ${TERMS_SQL},
           g.description, e.name AS entity_name, r.contract_id, k.name AS contract_name, g.amount_cents AS base_cents,
           coalesce((SELECT json_agg(json_build_object('from', a.from_occurrence, 'cents', a.amount_cents) ORDER BY a.from_occurrence)
                       FROM card_recurring_charge_amounts a WHERE a.recurrence_rule_id = r.id), '[]'::json) AS steps
      FROM recurrence_rules r
      JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
      LEFT JOIN entities e ON e.id = g.entity_id
      LEFT JOIN contracts k ON k.id = r.contract_id
     WHERE r.caixa_id = ${cardCaixaId}`);
  return result.rows.map((raw) => {
    const r = camel<Record<string, unknown>>(raw);
    return {
      id: String(r.id),
      frequency: r.frequency as Frequency,
      intervalCount: Number(r.intervalCount),
      anchorDay: Number(r.anchorDay),
      startsOn: String(r.startsOn),
      endsOn: (r.endsOn as string | null) ?? null,
      installmentsTotal: r.installmentsTotal === null ? null : Number(r.installmentsTotal),
      description: String(r.description),
      entityName: (r.entityName as string | null) ?? null,
      contractId: (r.contractId as string | null) ?? null,
      contractName: (r.contractName as string | null) ?? null,
      baseCents: Number(r.baseCents),
      steps: (r.steps as { from: number; cents: number | string }[]).map((s) => ({ from: Number(s.from), cents: Number(s.cents) })),
      terms: termsOf(raw as Parameters<typeof termsOf>[0]),
    };
  });
}

/** Valor esperado da ocorrência n (o último degrau com from ≤ n, senão o valor da cobrança). */
const amountAt = (rule: ChargeRule, n: number) => [...rule.steps].reverse().find((s) => s.from <= n)?.cents ?? rule.baseCents;

/**
 * Ocorrências esperadas das cobranças de um cartão com vencimento entre `from`
 * e `to`, ainda sem compra ligada (não estornada por inteiro).
 */
export async function expectedCardOccurrences(
  db: Executor,
  cardCaixaId: string,
  from: string,
  to: string,
): Promise<CardChargeOccurrence[]> {
  const rules = await chargeRules(db, cardCaixaId);
  if (rules.length === 0) return [];
  const charged = await db.execute<{ recurrence_rule_id: string; occurrence: number }>(sql`
    SELECT p.recurrence_rule_id, p.occurrence FROM card_purchases p
     WHERE p.recurrence_rule_id = ANY (${uuidArray(rules.map((r) => r.id))}) AND p.kind = 'purchase'
       AND p.amount_cents > coalesce((SELECT sum(x.amount_cents) FROM card_purchases x WHERE x.refunded_purchase_id = p.id), 0)`);
  const taken = new Set(charged.rows.map((r) => `${r.recurrence_rule_id}:${Number(r.occurrence)}`));
  const out: CardChargeOccurrence[] = [];
  for (const rule of rules) {
    for (let n = 1; n <= 5000; n += 1) {
      if (!occurrenceWithinRule(rule, n)) break;
      const dueDate = occurrenceDueDate(rule, n);
      if (dueDate > to) break;
      if (dueDate < from || taken.has(`${rule.id}:${n}`)) continue;
      out.push({
        ruleId: rule.id,
        occurrence: n,
        dueDate,
        amountCents: amountAt(rule, n),
        description: rule.description,
        entityName: rule.entityName,
        contractId: rule.contractId,
        contractName: rule.contractName,
        terms: rule.terms,
      });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export const toSuggestion = (occ: CardChargeOccurrence): CardChargeSuggestion => ({
  ruleId: occ.ruleId,
  occurrence: occ.occurrence,
  dueDate: occ.dueDate,
  expectedCents: occ.amountCents,
  description: occ.description,
  entityName: occ.entityName,
  contractId: occ.contractId,
  contractName: occ.contractName,
  autoSettle: occ.terms.autoSettle,
});

/** A série de cobrança de um cartão e a ocorrência pedida (que precisa existir no calendário). */
export async function chargeTarget(db: Executor, cardCaixaId: string, ruleId: string, occurrence: number) {
  const result = await db.execute(sql`
    SELECT r.id, r.caixa_id, r.contract_id, r.frequency, r.interval_count, r.anchor_day, r.starts_on, r.ends_on, r.installments_total,
           g.payer_caixa_id, g.entity_id, g.category_id, g.description
      FROM recurrence_rules r JOIN card_recurring_charges g ON g.recurrence_rule_id = r.id
     WHERE r.id = ${ruleId}`);
  const raw = result.rows[0];
  if (!raw) throw notFound();
  const r = camel<Record<string, unknown>>(raw);
  if (r.caixaId !== cardCaixaId) throw notFound();
  const rule: RecurrenceRule = {
    frequency: r.frequency as Frequency,
    intervalCount: Number(r.intervalCount),
    anchorDay: Number(r.anchorDay),
    startsOn: String(r.startsOn),
    endsOn: (r.endsOn as string | null) ?? null,
    installmentsTotal: r.installmentsTotal === null ? null : Number(r.installmentsTotal),
  };
  if (!occurrenceWithinRule(rule, occurrence)) throw unprocessable(t.contracts.errors.chargeNotExpected);
  return {
    ruleId,
    occurrence,
    contractId: (r.contractId as string | null) ?? null,
    payerCaixaId: String(r.payerCaixaId),
    entityId: String(r.entityId),
    categoryId: String(r.categoryId),
    description: String(r.description),
    dueDate: occurrenceDueDate(rule, occurrence),
  };
}

/**
 * A compra à vista que atende a ocorrência (numa transação aberta): na caixa
 * pagadora da cobrança, com o recebedor, a categoria e a descrição dela,
 * ligada à série, à ocorrência e ao contrato. Devolve a compra e o item da fatura.
 */
export async function insertChargePurchase(
  ctx: ServiceContext,
  tx: Tx,
  input: { cardCaixaId: string; ruleId: string; occurrence: number; purchasedOn: string; amountCents: number },
): Promise<{ id: string; itemId: string }> {
  ctx.access.assertWrite(input.cardCaixaId);
  const target = await chargeTarget(tx, input.cardCaixaId, input.ruleId, input.occurrence);
  const card = await loadCard(tx, input.cardCaixaId, true);
  const created = await insertPurchase(tx, card, {
    kind: 'purchase',
    payerCaixaId: target.payerCaixaId,
    entityId: target.entityId,
    categoryId: target.categoryId,
    purchasedOn: input.purchasedOn,
    description: target.description,
    amountCents: input.amountCents,
    installmentsTotal: 1,
    firstInstallment: 1,
    contractId: target.contractId,
    recurrenceRuleId: target.ruleId,
    occurrence: target.occurrence,
  });
  return { id: created.id, itemId: created.itemIds[0]! };
}
