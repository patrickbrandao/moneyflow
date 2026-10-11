/** Rotas do domínio, num lugar só. */
export type CaixaTab =
  | 'payables'
  | 'receivables'
  | 'accounts'
  | 'statement'
  | 'reconciliation'
  | 'closing'
  | 'members'
  // caixa de cartão (spec 007)
  | 'invoice'
  | 'invoices'
  | 'purchases'
  | 'limit'
  | 'import';

export const caixaTab = (caixaId: string, tab: CaixaTab) => `/caixas/${caixaId}/${tab}`;

export const titleLink = (title: { id: string; caixaId: string; direction: 'payable' | 'receivable' }) =>
  `${caixaTab(title.caixaId, title.direction === 'payable' ? 'payables' : 'receivables')}?title=${title.id}`;

export const entityLink = (id: string) => `/entities/${id}`;

/** Detalhe da fatura do cartão; `payer` filtra as compras de uma pagadora (navegação a partir do título dela). */
export const invoiceLink = (invoiceId: string, payerCaixaId?: string | null) =>
  `/card-invoices/${invoiceId}${payerCaixaId ? `?payer=${payerCaixaId}` : ''}`;
