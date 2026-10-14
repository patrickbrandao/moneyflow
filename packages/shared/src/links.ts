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

/** Detalhe do contrato (spec 020); `tab` abre uma aba (ex.: renewal). */
export const contractLink = (id: string, tab?: string) => `/contracts/${id}${tab ? `?tab=${tab}` : ''}`;

/** Detalhe da fatura do cartão; `payer` filtra as compras de uma pagadora (navegação a partir do título dela). */
export const invoiceLink = (invoiceId: string, payerCaixaId?: string | null) =>
  `/card-invoices/${invoiceId}${payerCaixaId ? `?payer=${payerCaixaId}` : ''}`;

export const purchaseLink = (cardCaixaId: string, purchaseId: string) => `${caixaTab(cardCaixaId, 'purchases')}?purchase=${purchaseId}`;

export const statementLink = (caixaId: string, accountId: string) => `${caixaTab(caixaId, 'statement')}?account=${accountId}`;

export const reconciliationLink = (caixaId: string, accountId: string, importId?: string) =>
  `${caixaTab(caixaId, 'reconciliation')}?account=${accountId}${importId ? `&import=${importId}` : ''}`;

/** Lote de extrato importado: a conciliação da conta ou o import da fatura do cartão. */
export const importLink = (imp: { id: string; caixaId: string; financialAccountId: string | null; cardCaixaId: string | null }) =>
  imp.financialAccountId
    ? reconciliationLink(imp.caixaId, imp.financialAccountId, imp.id)
    : `${caixaTab(imp.cardCaixaId ?? imp.caixaId, 'import')}?import=${imp.id}`;

export const transfersLink = (caixaId?: string) => `/transfers${caixaId ? `?caixa=${caixaId}` : ''}`;
