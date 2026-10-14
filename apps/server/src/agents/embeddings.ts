import type { Database, Executor } from '@moneyflow/db';
import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import { findPgError } from '../errors';
import { embed, type LlmCredentials, type RequestLogBase } from './llm';

/*
 * Embeddings (pgvector, 1536 dimensões) para a busca semântica dos agentes.
 * Um índice por par (provedor, modelo) em uso por algum agente ativo (spec
 * 024): o worker registra os pares (ai_embedding_indexes_touch) antes de
 * gravar, indexa cada um e purga os parados há mais de 7 dias
 * (ai_embedding_indexes_purge). A busca usa o par do agente que a chamou.
 *
 * Indexação de um par: (1) grava/atualiza o texto-fonte dos objetos
 * (entidades, títulos, compras de cartão, linhas de extrato) — o banco marca
 * needs_reindex quando o texto muda; (2) calcula os vetores pendentes.
 */

export type EmbeddingPair = { providerId: string; model: string };

export type EmbeddingCredentials = LlmCredentials & {
  providerId: string;
  model: string;
  /** Registro das requisições (spec 023): log_bodies do provedor e as tentativas da configuração. */
  logBodies: boolean;
  maxAttempts?: number;
  backoffMs?: number;
};

/**
 * Credenciais de um par (worker). null se o provedor deixou de estar ativo ou
 * perdeu a flag (42501) ou não existe (P0002): o par fica parado até a purga.
 */
export async function embeddingCredentials(
  db: Executor,
  pair: EmbeddingPair,
  config?: Pick<Config, 'aiRequestMaxAttempts' | 'aiRequestBackoffMs'>,
): Promise<EmbeddingCredentials | null> {
  let row: { provider_id: string; kind: 'openai'; base_url: string | null; api_key: string | null } | undefined;
  try {
    const result = await db.execute<NonNullable<typeof row>>(
      sql`SELECT provider_id, kind, base_url, api_key FROM ai_embedding_credentials(${pair.providerId}::uuid)`,
    );
    row = result.rows[0];
  } catch (error) {
    const code = findPgError(error)?.code;
    if (code === '42501' || code === 'P0002') return null;
    throw error;
  }
  if (!row) return null;
  const logging = await db.execute<{ log_bodies: boolean }>(sql`SELECT log_bodies FROM ai_providers WHERE id = ${pair.providerId}`);
  return {
    providerId: row.provider_id,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: pair.model,
    logBodies: Boolean(logging.rows[0]?.log_bodies),
    maxAttempts: config?.aiRequestMaxAttempts,
    backoffMs: config?.aiRequestBackoffMs,
  };
}

/** Atribuição das requisições de embeddings (usuário e agente opcionais). */
function requestLog(db: Executor, creds: EmbeddingCredentials, userId: string | null, agentId: string | null = null): RequestLogBase {
  return {
    db,
    providerId: creds.providerId,
    userId,
    agentId,
    logBodies: creds.logBodies,
    maxAttempts: creds.maxAttempts,
    backoffMs: creds.backoffMs,
  };
}

export const vectorLiteral = (vector: number[]) => `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;

/** Registra o uso de uma chamada de embeddings (usuário e agente opcionais). */
export async function recordEmbeddingUsage(
  db: Executor,
  creds: EmbeddingCredentials,
  tokens: number,
  userId: string | null,
  requestId: string | null = null,
  agentId: string | null = null,
) {
  await db.execute(sql`
    INSERT INTO ai_usage (provider_id, model, purpose, user_id, agent_id, input_tokens, request_id)
    VALUES (${creds.providerId}, ${creds.model}, 'embedding', ${userId}, ${agentId}, ${tokens}, ${requestId})`);
}

/** Vetor de uma consulta (busca), com o uso atribuído ao usuário e ao agente. */
export async function embedQuery(db: Executor, creds: EmbeddingCredentials, text: string, userId: string, agentId: string | null = null) {
  const { vectors, tokens, requestId } = await embed(creds, creds.model, [text.slice(0, 8000)], requestLog(db, creds, userId, agentId));
  await recordEmbeddingUsage(db, creds, tokens, userId, requestId, agentId);
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

/** Quantos registros a busca enxerga (o "total" do progresso de cada índice). */
export async function embeddingSourceTotal(db: Executor): Promise<number> {
  const parts = Object.values(SOURCES).map((source) => sql`(SELECT count(*) FROM (${source}) s WHERE btrim(s.source_text) <> '')`);
  const result = await db.execute<{ n: string }>(sql`SELECT (${sql.join(parts, sql` + `)})::bigint AS n`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Até onde cada par já leu os textos-fonte de cada tipo (em memória: um worker que reinicia relê tudo, sem custo). */
export type IndexState = { since: Map<string, string> };

/** Pares em uso (registrados com last_in_use_at = agora); rode antes de gravar vetores de um par novo. */
export async function touchEmbeddingIndexes(db: Executor): Promise<EmbeddingPair[]> {
  const result = await db.execute<{ provider_id: string; model: string }>(sql`SELECT provider_id, model FROM ai_embedding_indexes_touch()`);
  return result.rows.map((r) => ({ providerId: r.provider_id, model: r.model }));
}

/** Apaga os pares parados há mais de `idle` com os vetores (devolve quantos vetores saíram). */
export async function purgeEmbeddingIndexes(db: Executor, idle = '7 days'): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`SELECT ai_embedding_indexes_purge(${idle}::interval) AS n`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Grava os textos-fonte alterados desde a última passada do par (até `batch` por tipo). */
export async function syncEmbeddingSources(db: Database, pair: EmbeddingPair, state: IndexState, batch = 500) {
  let upserted = 0;
  for (const [type, source] of Object.entries(SOURCES)) {
    const key = `${pair.providerId}|${pair.model}|${type}`;
    const since = state.since.get(key) ?? '-infinity';
    const result = await db.execute<{ max: string | null; n: number }>(sql`
      WITH src AS (SELECT * FROM (${source}) s WHERE s.updated_at > ${since}::timestamptz AND btrim(s.source_text) <> ''
                    ORDER BY s.updated_at LIMIT ${batch}),
           up AS (
             INSERT INTO ai_embeddings (object_type, object_id, caixa_id, provider_id, model, source_text)
             SELECT object_type, object_id, caixa_id, ${pair.providerId}::uuid, ${pair.model}, left(source_text, 32000) FROM src
             ON CONFLICT (object_type, object_id, provider_id, model) DO UPDATE
               SET source_text = EXCLUDED.source_text, caixa_id = EXCLUDED.caixa_id
               WHERE ai_embeddings.source_text IS DISTINCT FROM EXCLUDED.source_text
                  OR ai_embeddings.caixa_id IS DISTINCT FROM EXCLUDED.caixa_id
             RETURNING 1)
      SELECT (SELECT max(updated_at)::text FROM src) AS max, (SELECT count(*)::int FROM up) AS n`);
    const row = result.rows[0];
    if (row?.max) state.since.set(key, row.max);
    upserted += row?.n ?? 0;
  }
  return upserted;
}

/** Calcula os vetores pendentes (needs_reindex) do par. */
export async function embedPending(db: Database, creds: EmbeddingCredentials, batch = 64, rounds = 5) {
  let embedded = 0;
  for (let round = 0; round < rounds; round += 1) {
    const pending = await db.execute<{ id: string; source_text: string; source_hash: string }>(sql`
      SELECT id, source_text, source_hash FROM ai_embeddings
       WHERE needs_reindex AND provider_id = ${creds.providerId} AND model = ${creds.model} ORDER BY updated_at LIMIT ${batch}`);
    if (pending.rows.length === 0) break;
    const { vectors, tokens, requestId } = await embed(
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

/**
 * Um ciclo de indexação (worker): registra os pares em uso e indexa cada um.
 * Um par com problema (provedor fora, modelo com outra dimensão) não segura
 * os demais: o erro volta na lista.
 */
export async function indexEmbeddings(
  db: Database,
  config: Pick<Config, 'aiRequestMaxAttempts' | 'aiRequestBackoffMs'>,
  state: IndexState,
): Promise<{ pairs: number; sources: number; embedded: number; errors: { pair: EmbeddingPair; error: unknown }[] }> {
  const pairs = await touchEmbeddingIndexes(db);
  let sources = 0;
  let embedded = 0;
  const errors: { pair: EmbeddingPair; error: unknown }[] = [];
  for (const pair of pairs) {
    try {
      const creds = await embeddingCredentials(db, pair, config);
      if (!creds) continue;
      sources += await syncEmbeddingSources(db, pair, state);
      embedded += await embedPending(db, creds);
    } catch (error) {
      errors.push({ pair, error });
    }
  }
  return { pairs: pairs.length, sources, embedded, errors };
}
