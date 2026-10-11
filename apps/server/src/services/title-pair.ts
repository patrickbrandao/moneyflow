import { type Executor, titles } from '@moneyflow/db';
import type { MirrorStatus } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';

/*
 * Inserção de um título e, se houver, do espelho (spec 006), na mesma
 * transação: os dois ids saem antes do INSERT (uuidv7() do banco), e as FKs e
 * a checagem do espelho são deferidas para o COMMIT (docs/016).
 */

export type TitleFields = {
  caixaId: string;
  direction: 'payable' | 'receivable';
  entityId: string;
  categoryId: string;
  description: string;
  competenceDate: string;
  dueDate: string;
  amountCents: number;
  notes: string | null;
  origin: 'manual' | 'recurrence' | 'card_invoice';
  recurrenceRuleId: string | null;
  occurrence: number | null;
  /** Entrada do título (spec 010): só no lado original, menos a NF-e, que vale para o par. */
  boletoBarcode?: string | null;
  pixPayload?: string | null;
  nfeDocumentId?: string | null;
  /** origin = card_invoice: a fatura, nos dois lados (spec 007). */
  cardInvoiceId?: string | null;
};

export type MirrorPlan = {
  caixaId: string;
  /** Titular da caixa do título original (a contraparte vista do espelho). */
  entityId: string;
  categoryId: string;
  description?: string;
  status: MirrorStatus;
};

export async function newIds(tx: Executor, count: number): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`SELECT uuidv7() AS id FROM generate_series(1, ${count})`);
  return result.rows.map((r) => r.id);
}

export const opposite = (direction: 'payable' | 'receivable') => (direction === 'payable' ? 'receivable' : 'payable');

export async function insertTitlePair(
  tx: Executor,
  fields: TitleFields,
  mirror: MirrorPlan | null,
): Promise<{ id: string; mirrorId: string | null }> {
  const [id, mirrorId] = await newIds(tx, mirror ? 2 : 1);
  await tx.insert(titles).values({
    id: id!,
    ...fields,
    counterpartyCaixaId: mirror?.caixaId ?? null,
    mirrorTitleId: mirror ? mirrorId! : null,
  });
  if (mirror) {
    await tx.insert(titles).values({
      id: mirrorId!,
      caixaId: mirror.caixaId,
      direction: opposite(fields.direction),
      entityId: mirror.entityId,
      categoryId: mirror.categoryId,
      description: mirror.description ?? fields.description,
      competenceDate: fields.competenceDate,
      dueDate: fields.dueDate,
      amountCents: fields.amountCents,
      notes: null,
      origin: fields.origin,
      recurrenceRuleId: fields.recurrenceRuleId,
      occurrence: fields.occurrence,
      nfeDocumentId: fields.nfeDocumentId ?? null,
      cardInvoiceId: fields.cardInvoiceId ?? null,
      counterpartyCaixaId: fields.caixaId,
      mirrorTitleId: id!,
      mirrorStatus: mirror.status,
    });
  }
  return { id: id!, mirrorId: mirror ? mirrorId! : null };
}
