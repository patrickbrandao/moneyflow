/** Rotas do domínio, num lugar só. */
export const caixaTab = (caixaId: string, tab: 'payables' | 'receivables' | 'accounts' | 'statement' | 'members') =>
  `/caixas/${caixaId}/${tab}`;

export const titleLink = (title: { id: string; caixaId: string; direction: 'payable' | 'receivable' }) =>
  `${caixaTab(title.caixaId, title.direction === 'payable' ? 'payables' : 'receivables')}?title=${title.id}`;

export const entityLink = (id: string) => `/entities/${id}`;
