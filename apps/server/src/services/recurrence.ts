import { type Database, type Executor, recurrenceRules, titles } from '@moneyflow/db';
import {
  addMonths,
  type Frequency,
  MATERIALIZE_MONTHS,
  occurrenceCompetenceDate,
  occurrenceDueDate,
  pendingOccurrences,
  type RecurrenceRule,
  todayIso,
} from '@moneyflow/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { insertTitlePair, type MirrorPlan } from './title-pair';

/*
 * Materialização das séries (spec 005): o modelo de cada novo título é a
 * ocorrência mais recente da série (lado original, sem mirror_status); o
 * espelho, se houver, segue o modelo do espelho dessa ocorrência. Cria até
 * 12 meses à frente. Usado na criação do título e pelo worker.
 */

export const materializeHorizon = (today = todayIso()) => addMonths(today, MATERIALIZE_MONTHS);

export function toRule(row: typeof recurrenceRules.$inferSelect): RecurrenceRule {
  return {
    frequency: row.frequency as Frequency,
    intervalCount: row.intervalCount,
    anchorDay: row.anchorDay,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    installmentsTotal: row.installmentsTotal,
  };
}

/** Cria as ocorrências que faltam até o horizonte; devolve quantas criou. */
export async function materializeRule(tx: Executor, ruleId: string, horizon = materializeHorizon()): Promise<number> {
  const [ruleRow] = await tx.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
  if (!ruleRow) return 0;
  const [template] = await tx
    .select()
    .from(titles)
    .where(and(eq(titles.recurrenceRuleId, ruleId), isNull(titles.mirrorStatus)))
    .orderBy(desc(titles.occurrence))
    .limit(1);
  if (!template || template.occurrence === null) return 0;
  const rule = toRule(ruleRow);
  const mirrorTemplate = template.mirrorTitleId
    ? (await tx.select().from(titles).where(eq(titles.id, template.mirrorTitleId)))[0]
    : undefined;

  const pending = pendingOccurrences(rule, template.occurrence, horizon);
  for (const n of pending) {
    const mirror: MirrorPlan | null = mirrorTemplate
      ? {
          caixaId: mirrorTemplate.caixaId,
          entityId: mirrorTemplate.entityId,
          categoryId: mirrorTemplate.categoryId,
          description: mirrorTemplate.description,
          status: mirrorTemplate.mirrorStatus === 'accepted' ? 'accepted' : 'pending',
        }
      : null;
    await insertTitlePair(
      tx,
      {
        caixaId: template.caixaId,
        direction: template.direction as 'payable' | 'receivable',
        entityId: template.entityId,
        categoryId: template.categoryId,
        description: template.description,
        competenceDate: occurrenceCompetenceDate(rule, { occurrence: template.occurrence, competenceDate: template.competenceDate }, n),
        dueDate: occurrenceDueDate(rule, n),
        amountCents: template.amountCents,
        notes: template.notes,
        origin: 'recurrence',
        recurrenceRuleId: ruleId,
        occurrence: n,
      },
      mirror,
    );
  }
  return pending.length;
}

/**
 * Passada do worker por todas as séries. Cada série roda na própria transação
 * com advisory lock por série (pg_try_advisory_xact_lock): dois workers (ou a
 * API e o worker) nunca materializam a mesma série ao mesmo tempo.
 */
export async function materializeAll(
  db: Database,
  horizon = materializeHorizon(),
): Promise<{ rules: number; created: number; skipped: number; failed: number }> {
  const rules = await db.execute<{ id: string }>(sql`
    SELECT r.id FROM recurrence_rules r
     WHERE EXISTS (SELECT 1 FROM titles t WHERE t.recurrence_rule_id = r.id)
     ORDER BY r.id`);
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const { id } of rules.rows) {
    // Uma série com erro (ex.: competência num mês fechado) não impede as outras.
    try {
      await db.transaction(async (tx) => {
        const lock = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${MATERIALIZE_LOCK}, hashtext(${id})) AS ok`);
        if (!lock.rows[0]?.ok) {
          skipped += 1;
          return;
        }
        created += await materializeRule(tx, id, horizon);
      });
    } catch {
      failed += 1;
    }
  }
  return { rules: rules.rows.length, created, skipped, failed };
}

/** Primeira chave do advisory lock das séries (constante arbitrária do MoneyFlow). */
export const MATERIALIZE_LOCK = 7_310_001;
