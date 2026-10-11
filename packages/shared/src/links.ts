/*
 * Rotas do console, num lugar só: o front monta os links e a API/worker
 * gravam caminhos relativos (notificações, gaveta do canvas, mensagens).
 */
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

export const purchaseLink = (cardCaixaId: string, purchaseId: string) => `${caixaTab(cardCaixaId, 'purchases')}?purchase=${purchaseId}`;

export const statementLink = (caixaId: string, accountId: string) => `${caixaTab(caixaId, 'statement')}?account=${accountId}`;

export const reconciliationLink = (caixaId: string, accountId: string, importId?: string) =>
  `${caixaTab(caixaId, 'reconciliation')}?account=${accountId}${importId ? `&import=${importId}` : ''}`;

export const transfersLink = (caixaId?: string) => `/transfers${caixaId ? `?caixa=${caixaId}` : ''}`;
