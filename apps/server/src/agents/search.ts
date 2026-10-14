import { normalizeDocument, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { type EmbeddingCredentials, embeddingSourceTotal, embedQuery, vectorLiteral } from './embeddings';
import { inferenceCredentials } from './inferences';

/*
 * Busca por significado da tool semantic_search (spec 024): com o par
 * (provedor, modelo) de embeddings do agente que a chamou,
 * ai_embeddings_search (sempre só com as caixas que o usuário lê, e cada
 * objeto é revalidado). Enquanto o índice do par não está completo, usa o que
 * já existe e completa com trigramas, avisando "índice em construção". Sem
 * embeddings (agente sem a inferência, ou a busca fora de um agente, como o
 * /mcp), semelhança de texto (pg_trgm) e, nas entidades, o prefixo do
 * documento (CPF/CNPJ, inclusive alfanumérico), que vale pontuação 1 para não
 * ficar abaixo dos trigramas.
 */

export type SearchType = 'entity' | 'title' | 'card_purchase' | 'statement_line';
export type SemanticHit = { type: SearchType; id: string; caixaId: string | null; text: string; score: number };

const ALL: SearchType[] = ['entity', 'title', 'card_purchase', 'statement_line'];

async function readableCaixas(ctx: ServiceContext): Promise<string[]> {
  const readable = ctx.access.readableCaixaIds();
  if (readable !== 'all') return readable;
  const result = await ctx.db.execute<{ id: string }>(sql`SELECT id FROM caixas`);
  return result.rows.map((r) => r.id);
}

const uuidArray = (ids: string[]) => `{${ids.join(',')}}`;

/** Par de embeddings do agente da execução (null fora de um agente ou sem a inferência). */
async function agentEmbeddings(ctx: ServiceContext): Promise<{ agentId: string; creds: EmbeddingCredentials } | null> {
  if (!ctx.agentRunId) return null;
  const run = await ctx.db.execute<{ agent_id: string }>(sql`SELECT agent_id FROM ai_runs WHERE id = ${ctx.agentRunId}`);
  const agentId = run.rows[0]?.agent_id;
  if (!agentId) return null;
  const creds = await inferenceCredentials(ctx.db, agentId, 'embeddings', ctx.access.actor.id);
  if (!creds?.model) return null;
  return {
    agentId,
    creds: {
      ...creds,
      model: creds.model,
      maxAttempts: ctx.config.aiRequestMaxAttempts,
      backoffMs: ctx.config.aiRequestBackoffMs,
    },
  };
}

/** O índice do par está completo: registrado, sem fila e com todos os registros que a busca enxerga. */
async function indexComplete(ctx: ServiceContext, creds: EmbeddingCredentials): Promise<boolean> {
  const stats = await ctx.db.execute<{ indexed: number; pending: number }>(sql`
    SELECT indexed, pending FROM ai_embedding_index_stats WHERE provider_id = ${creds.providerId} AND model = ${creds.model}`);
  const row = stats.rows[0];
  if (!row || Number(row.pending) > 0) return false;
  return Number(row.indexed) >= (await embeddingSourceTotal(ctx.db));
}

export async function semanticSearch(ctx: ServiceContext, query: string, types: SearchType[] | null, limit: number) {
  const wanted = types?.length ? types : ALL;
  const caixaIds = await readableCaixas(ctx);
  const pair = await agentEmbeddings(ctx);
  if (pair) {
    const { creds } = pair;
    const complete = await indexComplete(ctx, creds);
    const vector = await embedQuery(ctx.db, creds, query, ctx.access.actor.id, pair.agentId);
    const result = await ctx.db.execute<{
      object_type: SearchType;
      object_id: string;
      caixa_id: string | null;
      source_text: string;
      distance: number;
    }>(
      sql`SELECT * FROM ai_embeddings_search(${vectorLiteral(vector)}::vector, ${creds.providerId}::uuid, ${creds.model},
                                              ${uuidArray(caixaIds)}::uuid[], ${`{${wanted.join(',')}}`}::text[], ${limit})`,
    );
    const hits: SemanticHit[] = result.rows
      .filter((r) => r.caixa_id === null || ctx.access.canRead(r.caixa_id))
      .map((r) => ({ type: r.object_type, id: r.object_id, caixaId: r.caixa_id, text: r.source_text, score: 1 - Number(r.distance) }));
    if (complete) return { mode: 'embeddings' as const, hits };
    // Índice em construção: o que já existe, completado pelos trigramas (sem repetir).
    const seen = new Set(hits.map((h) => `${h.type}:${h.id}`));
    const extra = (await trigramSearch(ctx, query, wanted, caixaIds, limit)).filter((h) => !seen.has(`${h.type}:${h.id}`));
    return {
      mode: 'embeddings' as const,
      building: true,
      notice: t.agents.search.indexBuilding,
      hits: [...hits, ...extra].slice(0, limit),
    };
  }
  return { mode: 'trigram' as const, hits: await trigramSearch(ctx, query, wanted, caixaIds, limit) };
}

async function trigramSearch(
  ctx: ServiceContext,
  query: string,
  wanted: SearchType[],
  caixaIds: string[],
  limit: number,
): Promise<SemanticHit[]> {
  const caixaList = uuidArray(caixaIds);
  // Prefixo do documento, como na listagem de entidades (entities_document_prefix_idx); só com algum dígito,
  // para uma palavra comum não casar com o início de um CNPJ alfanumérico.
  const doc = normalizeDocument(query);
  const docPrefix = doc.length >= 3 && /[0-9]/.test(doc) ? `${doc}%` : null;
  const parts = [];
  if (wanted.includes('entity'))
    parts.push(sql`SELECT 'entity' AS type, e.id, NULL::uuid AS caixa_id, concat_ws(' · ', e.name, e.trade_name, e.document) AS text,
                          ${docPrefix ? sql`CASE WHEN e.document LIKE ${docPrefix} THEN 1 ELSE ` : sql``}
                          greatest(similarity(e.name, ${query}), similarity(coalesce(e.trade_name, ''), ${query}))
                          ${docPrefix ? sql`END` : sql``} AS score
                     FROM entities e WHERE e.archived_at IS NULL AND (e.name % ${query} OR e.name ILIKE ${`%${query}%`}
                       OR e.trade_name ILIKE ${`%${query}%`}
                       ${docPrefix ? sql`OR e.document LIKE ${docPrefix}` : sql``})`);
  if (wanted.includes('title'))
    parts.push(sql`SELECT 'title', t.id, t.caixa_id, concat_ws(' · ', t.description, t.due_date::text, (t.amount_cents / 100.0)::text),
                          similarity(t.description, ${query})
                     FROM titles t WHERE t.archived_at IS NULL AND t.caixa_id = ANY (${caixaList}::uuid[])
                      AND (t.description % ${query} OR t.description ILIKE ${`%${query}%`})`);
  if (wanted.includes('card_purchase'))
    parts.push(sql`SELECT 'card_purchase', p.id, p.card_caixa_id, concat_ws(' · ', p.description, p.purchased_on::text,
                          (p.amount_cents / 100.0)::text), similarity(p.description, ${query})
                     FROM card_purchases p WHERE p.card_caixa_id = ANY (${caixaList}::uuid[])
                      AND (p.description % ${query} OR p.description ILIKE ${`%${query}%`})`);
  if (wanted.includes('statement_line'))
    parts.push(sql`SELECT 'statement_line', l.id, coalesce(a.caixa_id, l.card_caixa_id), concat_ws(' · ', l.description, l.posted_on::text,
                          (l.amount_cents / 100.0)::text), similarity(l.description, ${query})
                     FROM statement_lines l LEFT JOIN financial_accounts a ON a.id = l.financial_account_id
                    WHERE coalesce(a.caixa_id, l.card_caixa_id) = ANY (${caixaList}::uuid[])
                      AND (l.description % ${query} OR l.description ILIKE ${`%${query}%`})`);
  if (parts.length === 0) return [];
  const result = await ctx.db.execute<{ type: SearchType; id: string; caixa_id: string | null; text: string; score: number }>(
    sql`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) x ORDER BY 5 DESC LIMIT ${limit}`,
  );
  return result.rows.map((r) => ({ type: r.type, id: r.id, caixaId: r.caixa_id, text: r.text, score: Number(r.score) }));
}
