import { normalizeDocument } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { embeddingCredentials, embedQuery, vectorLiteral } from './embeddings';

/*
 * Busca por significado da tool semantic_search: com provedor de embeddings,
 * ai_embeddings_search (sempre só com as caixas que o usuário lê, e cada
 * objeto é revalidado); sem ele, semelhança de texto (pg_trgm) e, nas
 * entidades, o prefixo do documento (CPF/CNPJ, inclusive alfanumérico), que
 * vale pontuação 1 para não ficar abaixo dos trigramas.
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

export async function semanticSearch(ctx: ServiceContext, query: string, types: SearchType[] | null, limit: number) {
  const wanted = types?.length ? types : ALL;
  const caixaIds = await readableCaixas(ctx);
  const creds = await embeddingCredentials(ctx.db);
  if (creds) {
    const vector = await embedQuery(ctx.db, creds, query, ctx.access.actor.id);
    const result = await ctx.db.execute<{
      object_type: SearchType;
      object_id: string;
      caixa_id: string | null;
      source_text: string;
      distance: number;
    }>(
      sql`SELECT * FROM ai_embeddings_search(${vectorLiteral(vector)}::vector, ${creds.model}, ${uuidArray(caixaIds)}::uuid[],
                                              ${`{${wanted.join(',')}}`}::text[], ${limit})`,
    );
    const hits: SemanticHit[] = result.rows
      .filter((r) => r.caixa_id === null || ctx.access.canRead(r.caixa_id))
      .map((r) => ({ type: r.object_type, id: r.object_id, caixaId: r.caixa_id, text: r.source_text, score: 1 - Number(r.distance) }));
    return { mode: 'embeddings' as const, hits };
  }

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
  if (parts.length === 0) return { mode: 'trigram' as const, hits: [] };
  const result = await ctx.db.execute<{ type: SearchType; id: string; caixa_id: string | null; text: string; score: number }>(
    sql`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) x ORDER BY 5 DESC LIMIT ${limit}`,
  );
  return {
    mode: 'trigram' as const,
    hits: result.rows.map((r) => ({ type: r.type, id: r.id, caixaId: r.caixa_id, text: r.text, score: Number(r.score) })),
  };
}
