import type { Database, Executor } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import { embedTexts, type LlmCredentials, type RequestLogBase } from './llm';

/*
 * Embeddings (pgvector, 1536 dimensões) para a busca semântica dos agentes.
 * Só com um provedor de embeddings ativo (ai_embedding_credentials, 0/1
 * linha); sem ele a indexação é pulada e a busca cai para trigram.
 *
 * Indexação no worker: (1) grava/atualiza o texto-fonte dos objetos
 * (entidades, títulos, compras de cartão, linhas de extrato) — o banco marca
 * needs_reindex quando o texto muda; (2) calcula os vetores pendentes.
 */

export type EmbeddingCredentials = LlmCredentials & {
  providerId: string;
  model: string;
  /** Registro das requisições (spec 023): log_bodies do provedor e as tentativas da configuração. */
  logBodies: boolean;
  maxAttempts?: number;
  backoffMs?: number;
};

export async function embeddingCredentials(
  db: Executor,
  config?: Pick<Config, 'aiRequestMaxAttempts' | 'aiRequestBackoffMs'>,
): Promise<EmbeddingCredentials | null> {
  const result = await db.execute<{
    provider_id: string;
    kind: 'openai';
    base_url: string | null;
    api_key: string | null;
    embedding_model: string;
    log_bodies: boolean | null;
  }>(sql`
    SELECT c.provider_id, c.kind, c.base_url, c.api_key, c.embedding_model, p.log_bodies
      FROM ai_embedding_credentials() c LEFT JOIN ai_providers p ON p.id = c.provider_id`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    providerId: row.provider_id,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.embedding_model,
    logBodies: Boolean(row.log_bodies),
    maxAttempts: config?.aiRequestMaxAttempts,
    backoffMs: config?.aiRequestBackoffMs,
  };
}

/** Atribuição das requisições de embeddings (sem agente; usuário opcional). */
function requestLog(db: Executor, creds: EmbeddingCredentials, userId: string | null): RequestLogBase {
  return {
    db,
    providerId: creds.providerId,
    userId,
    logBodies: creds.logBodies,
    maxAttempts: creds.maxAttempts,
    backoffMs: creds.backoffMs,
  };
}

export const vectorLiteral = (vector: number[]) => `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;

/** Registra o uso de uma chamada de embeddings (sem agente; usuário opcional). */
export async function recordEmbeddingUsage(
  db: Executor,
  creds: EmbeddingCredentials,
  tokens: number,
  userId: string | null,
  requestId: string | null = null,
) {
  await db.execute(sql`
    INSERT INTO ai_usage (provider_id, model, purpose, user_id, input_tokens, request_id)
    VALUES (${creds.providerId}, ${creds.model}, 'embedding', ${userId}, ${tokens}, ${requestId})`);
}

/** Vetor de uma consulta (busca), com o uso atribuído ao usuário. */
export async function embedQuery(db: Executor, creds: EmbeddingCredentials, text: string, userId: string) {
  const { vectors, tokens, requestId } = await embedTexts(creds, creds.model, [text.slice(0, 8000)], requestLog(db, creds, userId));
  await recordEmbeddingUsage(db, creds, tokens, userId, requestId);
  return vectors[0]!;
}

/** Textos-fonte de cada tipo: o que a busca semântica "enxerga" do objeto. */
const SOURCES = {
  entity: sql`
    SELECT 'entity' AS object_type, e.id AS object_id, NULL::uuid AS caixa_id,
           concat_ws(' · ', e.name, e.trade_name, e.document, e.notes) AS source_text, e.updated_at
      FROM entities e WHERE e.archived_at IS NULL`,
  title: sql`
    SELECT 'title' AS object_type, t.id AS object_id, t.caixa_id,
           concat_ws(' · ', CASE t.direction WHEN 'payable' THEN 'a pagar' ELSE 'a receber' END, t.description, e.name,
                     c.name, t.due_date::text, (t.amount_cents / 100.0)::text, t.notes) AS source_text, t.updated_at
      FROM titles t JOIN entities e ON e.id = t.entity_id JOIN categories c ON c.id = t.category_id
     WHERE t.archived_at IS NULL`,
  card_purchase: sql`
    SELECT 'card_purchase' AS object_type, p.id AS object_id, p.card_caixa_id AS caixa_id,
           concat_ws(' · ', 'compra no cartão', p.description, e.name, c.name, p.purchased_on::text,
                     (p.amount_cents / 100.0)::text) AS source_text, p.updated_at
      FROM card_purchases p JOIN entities e ON e.id = p.entity_id JOIN categories c ON c.id = p.category_id`,
  statement_line: sql`
    SELECT 'statement_line' AS object_type, l.id AS object_id, coalesce(a.caixa_id, l.card_caixa_id) AS caixa_id,
           concat_ws(' · ', 'linha de extrato', l.description, l.posted_on::text, (l.amount_cents / 100.0)::text) AS source_text,
           l.updated_at
      FROM statement_lines l LEFT JOIN financial_accounts a ON a.id = l.financial_account_id`,
} as const;

export type IndexState = { since: Map<string, string> };

/** Grava os textos-fonte alterados desde a última passada (até `batch` por tipo). */
export async function syncEmbeddingSources(db: Database, model: string, state: IndexState, batch = 500) {
  let upserted = 0;
  for (const [type, source] of Object.entries(SOURCES)) {
    const since = state.since.get(type) ?? '-infinity';
    const result = await db.execute<{ max: string | null; n: number }>(sql`
      WITH src AS (SELECT * FROM (${source}) s WHERE s.updated_at > ${since}::timestamptz AND btrim(s.source_text) <> ''
                    ORDER BY s.updated_at LIMIT ${batch}),
           up AS (
             INSERT INTO ai_embeddings (object_type, object_id, caixa_id, model, source_text)
             SELECT object_type, object_id, caixa_id, ${model}, left(source_text, 32000) FROM src
             ON CONFLICT (object_type, object_id, model) DO UPDATE
               SET source_text = EXCLUDED.source_text, caixa_id = EXCLUDED.caixa_id
               WHERE ai_embeddings.source_text IS DISTINCT FROM EXCLUDED.source_text
                  OR ai_embeddings.caixa_id IS DISTINCT FROM EXCLUDED.caixa_id
             RETURNING 1)
      SELECT (SELECT max(updated_at)::text FROM src) AS max, (SELECT count(*)::int FROM up) AS n`);
    const row = result.rows[0];
    if (row?.max) state.since.set(type, row.max);
    upserted += row?.n ?? 0;
  }
  return upserted;
}

/** Calcula os vetores pendentes (needs_reindex) do modelo ativo. */
export async function embedPending(db: Database, creds: EmbeddingCredentials, batch = 64, rounds = 5) {
  let embedded = 0;
  for (let round = 0; round < rounds; round += 1) {
    const pending = await db.execute<{ id: string; source_text: string; source_hash: string }>(sql`
      SELECT id, source_text, source_hash FROM ai_embeddings
       WHERE needs_reindex AND model = ${creds.model} ORDER BY updated_at LIMIT ${batch}`);
    if (pending.rows.length === 0) break;
    const { vectors, tokens, requestId } = await embedTexts(
      creds,
      creds.model,
      pending.rows.map((r) => r.source_text.slice(0, 8000)),
      requestLog(db, creds, null),
    );
    await recordEmbeddingUsage(db, creds, tokens, null, requestId);
    for (const [index, row] of pending.rows.entries()) {
      const vector = vectors[index];
      if (vector?.length !== 1536) continue;
      await db.execute(sql`SELECT ai_embedding_store(${row.id}::uuid, ${row.source_hash}, ${vectorLiteral(vector)}::vector)`);
      embedded += 1;
    }
  }
  return embedded;
}
