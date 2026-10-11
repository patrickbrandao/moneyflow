import type { SearchHit } from '@moneyflow/shared';
import { Building2, FileText, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';

/*
 * Fontes de busca da paleta (⌘K). Uma única chamada a /api/search devolve
 * entidades, caixas e títulos visíveis para quem está logado; cada tipo vira
 * um grupo. A paleta descarta respostas atrasadas sozinha.
 */

export type SearchResult = {
  id: string;
  label: string;
  /** Texto em mono à direita (documento, caixa, vencimento). */
  sub?: string;
  to: string;
  icon?: ReactNode;
};

export type SearchSource = {
  id: string;
  heading: string;
  icon: ReactNode;
  /** Mínimo de letras para a fonte responder (0 = sempre). */
  minChars: number;
  search: (query: string, limit: number) => Promise<SearchResult[]>;
};

// As três fontes compartilham a mesma resposta para o mesmo texto.
let last: { q: string; hits: Promise<SearchHit[]> } | null = null;
function hits(q: string): Promise<SearchHit[]> {
  if (last?.q !== q) last = { q, hits: api.get<SearchHit[]>('/api/search', { q }) };
  return last.hits;
}

const source = (id: SearchHit['kind'], heading: string, icon: ReactNode): SearchSource => ({
  id,
  heading,
  icon,
  minChars: 2,
  search: async (query, limit) =>
    (await hits(query))
      .filter((hit) => hit.kind === id)
      .slice(0, limit)
      .map((hit) => ({ id: hit.id, label: hit.label, sub: hit.sub, to: hit.to })),
});

export const SEARCH_SOURCES: SearchSource[] = [
  source('entity', 'Entidades', <Building2 />),
  source('caixa', 'Caixas', <Wallet />),
  source('title', 'Títulos', <FileText />),
];
