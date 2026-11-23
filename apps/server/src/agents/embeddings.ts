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
 * needs_reindex quando o texto muda; (2) calcula os vetores pendentes; (3)
 * marca o índice completo ou não (ai_embedding_index_mark, tarefa 161), que é
 * o que a busca lê para avisar "índice em construção".
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

/**
 * Até onde cada par já leu os textos-fonte de cada tipo: o cursor (updated_at, object_id) do último registro lido
 * (em memória: um worker que reinicia relê tudo, sem custo).
 */
export type IndexState = { since: Map<string, { at: string; id: string }> };

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/**
 * Janela relida a cada passada que alcança o fim (tarefa 094): updated_at é o início da transação, não o COMMIT, e
 * uma importação longa confirmada depois de o cursor passar pelo carimbo dela ficaria para trás. Reler é barato: o
 * upsert só grava o texto que mudou.
 */
const LATE_COMMIT_WINDOW = '10 minutes';

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

const sourceKey = (pair: EmbeddingPair, type: string) => `${pair.providerId}|${pair.model}|${type}`;

/**
 * Grava os textos-fonte alterados desde a última passada do par (até `batch` por tipo). Pagina pela chave composta
 * (updated_at, object_id), porque uma transação grava milhares de linhas com o mesmo carimbo (tarefa 094); alcançado
 * o fim, o cursor volta à janela de COMMIT tardio. `reachedEnd`: todo tipo leu menos que o lote (contadas as linhas
 * lidas, não só as gravadas, que ficam em 0 quando nada mudou), então a passada alcançou o fim das fontes (tarefa 161).
 */
export async function syncEmbeddingSources(
  db: Database,
  pair: EmbeddingPair,
  state: IndexState,
  batch = 500,
): Promise<{ upserted: number; reachedEnd: boolean }> {
  let upserted = 0;
  let reachedEnd = true;
  for (const [type, source] of Object.entries(SOURCES)) {
    const key = sourceKey(pair, type);
    const since = state.since.get(key) ?? { at: '-infinity', id: ZERO_UUID };
    const result = await db.execute<{ last_at: string | null; last_id: string | null; read: number; n: number; rewind: string }>(sql`
      WITH src AS (SELECT * FROM (${source}) s
                    WHERE (s.updated_at, s.object_id) > (${since.at}::timestamptz, ${since.id}::uuid) AND btrim(s.source_text) <> ''
                    ORDER BY s.updated_at, s.object_id LIMIT ${batch}),
           last AS (SELECT updated_at, object_id FROM src ORDER BY updated_at DESC, object_id DESC LIMIT 1),
           up AS (
             INSERT INTO ai_embeddings (object_type, object_id, caixa_id, provider_id, model, source_text)
             SELECT object_type, object_id, caixa_id, ${pair.providerId}::uuid, ${pair.model}, left(source_text, 32000) FROM src
             ON CONFLICT (object_type, object_id, provider_id, model) DO UPDATE
               SET source_text = EXCLUDED.source_text, caixa_id = EXCLUDED.caixa_id
               WHERE ai_embeddings.source_text IS DISTINCT FROM EXCLUDED.source_text
                  OR ai_embeddings.caixa_id IS DISTINCT FROM EXCLUDED.caixa_id
             RETURNING 1)
      SELECT (SELECT updated_at::text FROM last) AS last_at, (SELECT object_id::text FROM last) AS last_id,
             (SELECT count(*)::int FROM src) AS read, (SELECT count(*)::int FROM up) AS n,
             least(coalesce((SELECT updated_at FROM last), ${since.at}::timestamptz),
                   now() - ${LATE_COMMIT_WINDOW}::interval)::text AS rewind`);
    const row = result.rows[0];
    if (row && row.read >= batch && row.last_at && row.last_id) state.since.set(key, { at: row.last_at, id: row.last_id });
    else if (row) state.since.set(key, { at: row.rewind, id: ZERO_UUID });
    if (!row || row.read >= batch) reachedEnd = false;
    upserted += row?.n ?? 0;
  }
  return { upserted, reachedEnd };
}

/**
 * Marca o índice do par (tarefa 161): `true` grava o fim de uma passada completa (o banco só aceita sem vetor na
 * fila, `needs_reindex`), `false` limpa. A busca lê só a marca (`ai_embedding_index_ready`), sem contar as fontes.
 */
export async function markEmbeddingIndex(db: Executor, pair: EmbeddingPair, complete: boolean): Promise<boolean> {
  const result = await db.execute<{ done: boolean }>(
    sql`SELECT ai_embedding_index_mark(${pair.providerId}::uuid, ${pair.model}, ${complete}) AS done`,
  );
  return Boolean(result.rows[0]?.done);
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
 * os demais: o erro volta na lista. Ao fim de cada par, a marca do índice
 * (tarefa 161): completo quando a passada alcançou o fim das fontes e não
 * sobrou vetor na fila; incompleto (ou com erro), desmarcado. Na primeira
 * passada do processo para o par (sem cursor), desmarca antes: o worker não
 * sabe o que mudou enquanto estava parado, e só marca quando a releitura
 * alcançar o fim.
 */
export async function indexEmbeddings(
  db: Database,
  config: Pick<Config, 'aiRequestMaxAttempts' | 'aiRequestBackoffMs'>,
  state: IndexState,
  opts: { sourceBatch?: number } = {},
): Promise<{ pairs: number; sources: number; embedded: number; errors: { pair: EmbeddingPair; error: unknown }[] }> {
  const pairs = await touchEmbeddingIndexes(db);
  let sources = 0;
  let embedded = 0;
  const errors: { pair: EmbeddingPair; error: unknown }[] = [];
  for (const pair of pairs) {
    try {
      const creds = await embeddingCredentials(db, pair, config);
      if (!creds) continue;
      const fresh = !Object.keys(SOURCES).some((type) => state.since.has(sourceKey(pair, type)));
      if (fresh) await markEmbeddingIndex(db, pair, false);
      const synced = await syncEmbeddingSources(db, pair, state, opts.sourceBatch);
      sources += synced.upserted;
      embedded += await embedPending(db, creds);
      // Com a fila não vazia, o banco grava nulo mesmo com true.
      await markEmbeddingIndex(db, pair, synced.reachedEnd);
    } catch (error) {
      errors.push({ pair, error });
      await markEmbeddingIndex(db, pair, false).catch(() => {});
    }
  }
  return { pairs: pairs.length, sources, embedded, errors };
}
