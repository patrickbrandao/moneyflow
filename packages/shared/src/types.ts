/* Respostas da API (DTOs). Datas de negócio em 'YYYY-MM-DD'; instantes em ISO; dinheiro em centavos. */

export type GlobalRole = 'admin' | 'user';
export type CaixaRole = 'editor' | 'viewer';
/** Papel efetivo do usuário numa caixa (admin global vê e escreve em todas). */
export type EffectiveRole = 'admin' | CaixaRole;

export type ApiError = { error: { code: string; message: string; details?: { path: string; message: string }[] } };

export type Membership = { caixaId: string; caixaName: string; role: CaixaRole };

export type Me = {
  id: string;
  username: string;
  email: string;
  role: GlobalRole;
  isActive: boolean;
  /** Pode criar/editar entidades e caixas (admin ou editor de alguma caixa). */
  canEditRegistry: boolean;
  memberships: Membership[];
};

export type UserRow = {
  id: string;
  username: string;
  email: string;
  role: GlobalRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  memberships: Membership[];
};

export type { EntityKind } from './documents';

import type { EntityKind } from './documents';
import type { LINE_CREATED_ENTRIES } from './schemas/operation';
import type { SupersedeOutcome } from './supersede';

/** Tag de entidade como aparece na entidade (chip): `archived` = tag arquivada (esmaecida). */
export type EntityTagRef = { id: string; name: string; colorSlot: number; archived: boolean };

/** Tag do catálogo global (spec 003), com quantas entidades a usam. */
export type EntityTag = {
  id: string;
  name: string;
  colorSlot: number;
  archivedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type EntitySummary = {
  id: string;
  kind: EntityKind;
  name: string;
  tradeName: string | null;
  document: string | null;
  archivedAt: string | null;
  primaryPix: { keyType: string; keyValue: string } | null;
  caixaCount: number;
  /** Favorita global (spec 003). */
  isFavorite: boolean;
  /** Tags (as ativas primeiro, por nome). */
  tags: EntityTagRef[];
};

export type EntityContact = { id: string; kind: 'phone' | 'email' | 'other'; value: string; label: string | null; isPrimary: boolean };
export type EntityAddress = {
  id: string;
  label: string | null;
  postalCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
};
export type EntityBankAccount = {
  id: string;
  bankCode: string | null;
  ispb: string | null;
  branch: string | null;
  accountNumber: string;
  accountType: 'checking' | 'savings' | 'payment' | 'salary';
  holderName: string | null;
  label: string | null;
};
export type EntityPixKey = {
  id: string;
  keyType: 'cpf' | 'cnpj' | 'email' | 'phone' | 'evp';
  keyValue: string;
  bankCode: string | null;
  ispb: string | null;
  label: string | null;
  isPrimary: boolean;
};
export type EntityLink = {
  id: string;
  /** 'out' = esta entidade <kind> a outra; 'in' = a outra <kind> esta. */
  direction: 'out' | 'in';
  kind: 'partner_of' | 'responsible_for' | 'spouse_of' | 'other';
  otherEntityId: string;
  otherEntityName: string;
  notes: string | null;
};

export type EntityDetail = EntitySummary & {
  birthDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  contacts: EntityContact[];
  addresses: EntityAddress[];
  bankAccounts: EntityBankAccount[];
  pixKeys: EntityPixKey[];
  links: EntityLink[];
  caixas: { id: string; name: string; isPrimary: boolean; archivedAt: string | null; visible: boolean }[];
};

export type CnpjLookup = {
  document: string;
  name: string;
  tradeName: string | null;
  email: string | null;
  phone: string | null;
  /** Situação cadastral na Receita ("Ativa", "Inapta", "Baixada"…), se o provedor informar. */
  registrationStatus: string | null;
  /** Provedor que respondeu: CNPJ Aberto (com CNPJ_ABERTO_ENABLED) ou BrasilAPI. */
  source: 'cnpjaberto' | 'brasilapi';
  address: Omit<EntityAddress, 'id' | 'label'> | null;
};

export type CepLookup = Omit<EntityAddress, 'id' | 'label' | 'number'>;

export type CaixaSummary = {
  id: string;
  name: string;
  kind: 'general' | 'credit_card';
  holderEntityId: string;
  holderName: string;
  isPrimary: boolean;
  description: string | null;
  archivedAt: string | null;
  /** Cartão: 4 últimos dígitos (null em caixa geral). */
  cardLast4: string | null;
  myRole: EffectiveRole;
  balanceCents: number;
  payableOpenCents: number;
  receivableOpenCents: number;
  overdueCount: number;
  overdueCents: number;
};

export type AccountKind = 'checking' | 'cash' | 'savings';

export type AccountRow = {
  id: string;
  caixaId: string;
  caixaName: string;
  kind: AccountKind;
  name: string;
  bankCode: string | null;
  ispb: string | null;
  branch: string | null;
  accountNumber: string | null;
  openingBalanceCents: number;
  openingDate: string;
  archivedAt: string | null;
  balanceCents: number;
  canWrite: boolean;
  /** "Conciliar com IA ao importar" (spec 029). */
  aiAutoReconcile: boolean;
};

export type MemberRow = { id: string; userId: string; username: string; email: string; isActive: boolean; role: CaixaRole };

/** Atributos da caixa de cartão (spec 007). */
export type CardSettings = {
  defaultPayerCaixaId: string;
  defaultPayerName: string;
  creditLimitCents: number;
  closingDay: number;
  dueDay: number;
  cardLast4: string;
  /** "Conciliar com IA ao importar" (spec 029). */
  aiAutoReconcile: boolean;
};

export type CaixaDetail = CaixaSummary & { accounts: AccountRow[]; canWrite: boolean; card: CardSettings | null };

export type CategoryNode = {
  id: string;
  kind: 'income' | 'expense';
  parentId: string | null;
  name: string;
  colorSlot: number | null;
  icon: string | null;
  archivedAt: string | null;
  hidden: boolean;
  children: CategoryNode[];
};

export type TitleStatus = 'open' | 'partial' | 'paid' | 'canceled';
export type MirrorStatus = 'pending' | 'accepted' | 'disputed';

export type TitleRow = {
  id: string;
  caixaId: string;
  caixaName: string;
  direction: 'payable' | 'receivable';
  status: TitleStatus;
  entityId: string;
  entityName: string;
  categoryId: string;
  categoryName: string;
  categoryColorSlot: number | null;
  description: string;
  competenceDate: string;
  dueDate: string;
  amountCents: number;
  settledCents: number;
  openCents: number;
  origin: 'manual' | 'recurrence' | 'card_invoice' | 'contract';
  recurrenceRuleId: string | null;
  occurrence: number | null;
  installmentsTotal: number | null;
  /** origin = contract (spec 020): o contrato e a parcela n/N (n nulo = título extra, como a multa). */
  contractId: string | null;
  contractName: string | null;
  contractInstallment: number | null;
  contractInstallmentsCount: number | null;
  counterpartyCaixaId: string | null;
  counterpartyCaixaName: string | null;
  mirrorTitleId: string | null;
  /** Só no lado espelho (o criado na caixa da contraparte). */
  mirrorStatus: MirrorStatus | null;
  /** Situação do par: a do lado espelho, esteja ele aqui ou lá. */
  pairMirrorStatus: MirrorStatus | null;
  notes: string | null;
  archivedAt: string | null;
  overdue: boolean;
  pendingAccountCount: number;
  /** origin = card_invoice: a fatura (a pagadora navega para as compras). */
  cardInvoiceId: string | null;
  boletoBarcode: string | null;
  pixPayload: string | null;
  nfeDocumentId: string | null;
  attachmentCount: number;
};

export type SettlementRow = {
  id: string;
  titleId: string;
  settledOn: string;
  amountCents: number;
  interestCents: number;
  fineCents: number;
  discountCents: number;
  cashCents: number;
  financialAccountId: string | null;
  financialAccountName: string | null;
  mirrorSettlementId: string | null;
  transferId: string | null;
  transferOtherAccountName: string | null;
  notes: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  createdAt: string;
};

export type RecurrenceRuleDto = {
  id: string;
  frequency: 'weekly' | 'monthly' | 'yearly';
  intervalCount: number;
  anchorDay: number;
  startsOn: string;
  endsOn: string | null;
  installmentsTotal: number | null;
};

/** Uma ocorrência da série afetada pelo encerramento (lado original). */
export type SeriesOccurrence = { id: string; occurrence: number; dueDate: string; amountCents: number; status: TitleStatus };

/** Prévia/resultado de "Encerrar série" (spec 005). */
export type SeriesEndPreview = {
  ruleId: string;
  currentEndsOn: string | null;
  endsOn: string | null;
  /** Em aberto depois da nova data: passam a canceladas (com o espelho). */
  toCancel: SeriesOccurrence[];
  /** Canceladas depois do fim anterior que voltam a valer (estender). */
  toReopen: SeriesOccurrence[];
  /** Com baixa depois da nova data: impedem o encerramento até serem estornadas. */
  blocked: SeriesOccurrence[];
};

export type SeriesEndResult = SeriesEndPreview & { created: number; title: TitleDetail };

export type TitleDetail = TitleRow & {
  canWrite: boolean;
  settlements: SettlementRow[];
  rule: RecurrenceRuleDto | null;
  mirror: {
    id: string;
    caixaId: string;
    caixaName: string;
    canRead: boolean;
    canWrite: boolean;
    mirrorStatus: MirrorStatus | null;
    categoryName: string;
    status: TitleStatus;
  } | null;
};

export type TransferRow = {
  id: string;
  fromAccountId: string;
  fromAccountName: string;
  fromCaixaId: string;
  fromCaixaName: string;
  toAccountId: string;
  toAccountName: string;
  toCaixaId: string;
  toCaixaName: string;
  amountCents: number;
  transferredOn: string;
  description: string | null;
  notes: string | null;
  settlementId: string | null;
  createdAt: string;
};

export type StatementRow = {
  id: string;
  occurredOn: string;
  amountCents: number;
  balanceCents: number;
  kind: 'settlement' | 'transfer' | 'adjustment';
  description: string | null;
  entityName: string | null;
  categoryName: string | null;
  titleId: string | null;
  titleDescription: string | null;
  settlementId: string | null;
  isReversal: boolean;
  transferId: string | null;
  counterpartAccountName: string | null;
  counterpartCaixaName: string | null;
};

export type Statement = {
  account: AccountRow;
  from: string | null;
  to: string | null;
  openingCents: number;
  closingCents: number;
  rows: StatementRow[];
};

/** Resumo da conta (spec 004): série mensal, categorias pelo regime de caixa e situação da conciliação. */
export type AccountSummaryMonth = {
  /** 'YYYY-MM-01'. */
  month: string;
  /** Baixas e avulsos que entraram (sem transferências). */
  inflowCents: number;
  /** Baixas e avulsos que saíram, positivo (sem transferências). */
  outflowCents: number;
  transferInCents: number;
  /** Positivo. */
  transferOutCents: number;
  /** Saldo ao fim do mês (ou hoje, no mês corrente); null antes da abertura da conta. */
  closingCents: number | null;
};

export type AccountSummaryCategory = {
  kind: 'income' | 'expense';
  groupCategoryId: string | null;
  groupName: string | null;
  groupColorSlot: number | null;
  categoryId: string | null;
  categoryName: string | null;
  colorSlot: number | null;
  /** Positivo = despesa em expense, receita em income; estornos subtraem. */
  amountCents: number;
  entries: number;
};

export type AccountSummary = {
  account: AccountRow;
  from: string;
  to: string;
  months: AccountSummaryMonth[];
  categories: AccountSummaryCategory[];
  /** Só conta corrente e poupança concilia extrato; null nas demais. */
  reconciliation: {
    imports: number;
    lastImportId: string | null;
    lastPeriodEnd: string | null;
    newLines: number;
    suggestedLines: number;
  } | null;
};

export type Overview = {
  totals: { balanceCents: number; payableOpenCents: number; receivableOpenCents: number; overdueCents: number };
  caixas: CaixaSummary[];
  overdue: TitleRow[];
  upcoming: TitleRow[];
  pendingMirrors: TitleRow[];
  pendingAccounts: TitleRow[];
};

export type SearchHit = { kind: 'entity' | 'caixa' | 'title'; id: string; label: string; sub: string; to: string };

/** DELETE que arquiva quando há vínculos (spec 008). */
export type DeleteResult = { deleted: boolean; archived: boolean };

/* ---------------- fase 2: cartão (spec 007) ---------------- */

/** carried_over: fechada sem nada a pagar nela, mas com saldo devedor rolado para a fatura seguinte. */
export type InvoiceStatus = 'open' | 'closed' | 'carried_over' | 'paid';

export type InvoiceSummary = {
  id: string;
  cardCaixaId: string;
  referenceMonth: string;
  closingDate: string;
  dueDate: string;
  closedAt: string | null;
  totalCents: number;
  billedCents: number;
  settledCents: number;
  openCents: number;
  carriedOutCents: number;
  status: InvoiceStatus;
  /** Aberta com a data de fechamento já passada: sugerir o fechamento. */
  closeSuggested: boolean;
};

export type InvoicePayerTotal = {
  payerCaixaId: string;
  payerCaixaName: string;
  itemsCents: number;
  billedCents: number;
  settledCents: number;
  openCents: number;
  carriedOutCents: number;
  /** Título "a pagar" da pagadora nesta fatura (se houver e for legível). */
  payerTitleId: string | null;
  canReadPayer: boolean;
  canWritePayer: boolean;
};

export type InvoiceLine = {
  itemId: string;
  itemKind: 'installment' | 'carryover';
  payerCaixaId: string;
  payerCaixaName: string;
  amountCents: number;
  installmentNumber: number | null;
  installmentsTotal: number | null;
  purchaseId: string | null;
  purchaseKind: 'purchase' | 'refund' | 'charge' | null;
  chargeKind: string | null;
  refundedPurchaseId: string | null;
  entityId: string | null;
  entityName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorSlot: number | null;
  purchasedOn: string | null;
  description: string;
  carriedFromInvoiceId: string | null;
  carriedFromMonth: string | null;
  reconciled: boolean;
};

export type InvoiceDetail = InvoiceSummary & {
  cardName: string;
  issuerName: string;
  canWrite: boolean;
  payers: InvoicePayerTotal[];
  lines: InvoiceLine[];
  /** Pagadora filtrada (quem só lê a pagadora vê só as compras dela). */
  payerCaixaId: string | null;
  titles: TitleRow[];
};

export type CardOverview = {
  caixaId: string;
  name: string;
  settings: CardSettings;
  issuerEntityId: string;
  issuerName: string;
  creditLimitCents: number;
  usedCents: number;
  availableCents: number;
  canWrite: boolean;
  openInvoice: InvoiceSummary | null;
  invoices: InvoiceSummary[];
  /** Comprometido por fatura futura (parcelas lançadas), para o gráfico do limite. */
  committed: { referenceMonth: string; amountCents: number }[];
};

export type CardPurchaseRow = {
  id: string;
  cardCaixaId: string;
  kind: 'purchase' | 'refund' | 'charge';
  chargeKind: string | null;
  payerCaixaId: string;
  payerCaixaName: string;
  entityId: string;
  entityName: string;
  categoryId: string;
  categoryName: string;
  categoryColorSlot: number | null;
  purchasedOn: string;
  description: string;
  amountCents: number;
  installmentsTotal: number;
  firstInstallment: number;
  refundedPurchaseId: string | null;
  refundedCents: number;
  notes: string | null;
  attachmentCount: number;
  /** Todas as parcelas em faturas abertas (pode editar/excluir). */
  editable: boolean;
};

export type CardPurchaseDetail = CardPurchaseRow & {
  items: {
    id: string;
    invoiceId: string;
    referenceMonth: string;
    installmentNumber: number;
    amountCents: number;
    invoiceClosed: boolean;
  }[];
  refunds: CardPurchaseRow[];
  canWrite: boolean;
};

/* ---------------- extratos e conciliação (spec 009) ---------------- */

export type LineStatus = 'matched' | 'suggested' | 'new' | 'ignored' | 'superseded';
export type LineCreatedEntry = (typeof LINE_CREATED_ENTRIES)[number];

export type StatementImportSummary = {
  id: string;
  financialAccountId: string | null;
  accountName: string | null;
  cardCaixaId: string | null;
  cardInvoiceId: string | null;
  caixaId: string;
  format: 'ofx' | 'csv';
  fileName: string;
  attachmentId: string;
  periodStart: string;
  periodEnd: string;
  bankBalanceOn: string | null;
  bankBalanceCents: number | null;
  appBalanceCents: number | null;
  differenceCents: number | null;
  /** Divergência nascida desde o lote anterior com saldo (a acumulada menos a dele); null no primeiro ou sem saldo (spec 009). */
  intervalDifferenceCents: number | null;
  /** Abertura da conta: depois do início do período, o saldo do app não cobre o começo do extrato. */
  accountOpeningDate: string | null;
  lineCount: number;
  matchedLines: number;
  suggestedLines: number;
  newLines: number;
  ignoredLines: number;
  importedBy: string | null;
  createdAt: string;
  /** Extrato parcial do mês (spec 031): fora da deduplicação, na divergência só até ser substituído. */
  provisional: boolean;
  /** O lote que substituiu este provisório; substituído = somente leitura e fora da divergência. */
  supersededBy: { id: string; fileName: string; at: string } | null;
  /** Os provisórios que este lote substituiu. */
  supersedes: { id: string; fileName: string }[];
  /** Sobras pendentes dos provisórios que este lote substituiu (linhas conciliadas sem par). */
  supersedePending: number;
};

export type StatementLineRow = {
  id: string;
  /** Lote da linha (a busca por descrição junta linhas de vários lotes). */
  importId: string;
  lineNumber: number;
  postedOn: string;
  amountCents: number;
  description: string;
  fitid: string | null;
  status: LineStatus;
  movementId: string | null;
  titleId: string | null;
  cardInvoiceItemId: string | null;
  /** O lançamento conciliado nasceu desta linha (spec 009): "desfazer e excluir" o tira junto. */
  createdEntry: LineCreatedEntry | null;
  /** Resumo do par (conciliado ou sugerido). */
  target: {
    kind: 'movement' | 'title' | 'card_item';
    date: string;
    description: string;
    amountCents: number;
    entityName: string | null;
  } | null;
  entityId: string | null;
  entityName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorSlot: number | null;
  classificationSource: 'rule' | 'agent' | 'user' | null;
  classificationRuleId: string | null;
  /** Lote substituído (spec 031): o que aconteceu com a linha e a linha do consolidado que ficou no lugar. */
  supersedeOutcome: SupersedeOutcome | null;
  supersededByLineId: string | null;
  /** Sobra pendente: o par sugerido pela IA, esperando aprovação. */
  supersedeSuggestion: { lineId: string; reason: string | null; postedOn: string; description: string } | null;
};

/** Uma linha no resultado da troca do provisório (spec 031). */
export type SupersedeItem = {
  provisionalLineId: string;
  consolidatedLineId: string | null;
  postedOn: string;
  amountCents: number;
  description: string;
  /** Pendente: no_pair (sem par) ou consolidated_taken (a linha do consolidado já está conciliada ou ignorada). */
  reason?: 'no_pair' | 'consolidated_taken';
};

/** Resultado (ou prévia, com dryRun) da troca dos provisórios pelo consolidado (spec 031). */
export type SupersedeResult = {
  consolidatedImportId: string;
  provisionalImportIds: string[];
  dryRun: boolean;
  transferred: SupersedeItem[];
  paired: SupersedeItem[];
  dropped: SupersedeItem[];
  pending: SupersedeItem[];
  /** Linhas do consolidado sem par: seguem a conciliação normal. */
  consolidatedLeftover: { id: string; postedOn: string; amountCents: number; description: string }[];
};

/** Resultado do lote de decisões sobre as sobras (spec 031). */
export type SupersedeResolveResult = { done: number; failed: { lineId: string; message: string }[] };

/** Resultado do "Aplicar regras" (spec 009): linhas novas cuja classificação mudou. */
export type ApplyRulesResult = { updated: number };

export type StatementImportDetail = StatementImportSummary & {
  canWrite: boolean;
  lines: StatementLineRow[];
  /** Quantas linhas do arquivo já existiam (dedup) no momento do import. */
  skippedDuplicates?: number;
  /** Só na resposta do import de um OFX com várias contas: as contas do arquivo que ficaram de fora (spec 009). */
  ofxLeftOut?: string[];
  /** Só na resposta do import: a sugestão do agente dos fluxos enfileirada para as linhas novas (a tela acompanha a execução). */
  aiSuggestion?: { queued: boolean; runId: string | null; lines: number; skippedReason?: string } | null;
  /** Só na resposta do import (spec 031): a troca dos provisórios feita na mesma transação. */
  superseded?: SupersedeResult;
  /** Só na resposta do import sem a troca: provisórios ativos da conta sobrepostos ao período (a tela oferece a troca). */
  provisionalOverlap?: { id: string; fileName: string; periodStart: string; periodEnd: string }[];
  /** Só na resposta do import, com "Conciliar com IA ao importar" ligado (spec 029): a conciliação enfileirada. */
  aiReconcile?: {
    queued: boolean;
    runId: string | null;
    conversationId: string | null;
    lines: number;
    skippedReason?: string;
    recipes?: number;
  } | null;
};

/** Resumo de um extrato do OFX; `position` (1, 2, …) é a ordem no arquivo, o `ofxStatement` do import. */
export type OfxInspectStatement = {
  position: number;
  kind: 'bank' | 'creditcard';
  bankId: string | null;
  branchId: string | null;
  accountId: string | null;
  accountType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  ledgerBalance: { amountCents: number; date: string } | null;
  count: number;
  sample: { postedOn: string; amountCents: number; description: string; fitid: string | null }[];
};

export type StatementInspect = {
  format: 'ofx' | 'csv';
  encoding: string;
  /**
   * O extrato escolhido (ou o palpite, ou o primeiro) e, em `statements`, todos
   * os do arquivo. Com mais de um (spec 009), `selected` é o que casa com a
   * conta de destino (null = o usuário escolhe) e `suggested` o palpite pelo tipo.
   */
  ofx: (OfxInspectStatement & { statements: OfxInspectStatement[]; selected: number | null; suggested: number | null }) | null;
  csv: { delimiter: string; rows: string[][] } | null;
};

export type MatchCandidateRow = {
  kind: 'movement' | 'title' | 'card_item';
  id: string;
  date: string;
  amountCents: number;
  description: string;
  entityName: string | null;
  score: number | null;
};

export type CsvMappingRow = {
  id: string;
  financialAccountId: string | null;
  cardCaixaId: string | null;
  name: string;
  delimiter: string;
  encoding: string;
  hasHeader: boolean;
  skipRows: number;
  dateFormat: string;
  decimalSeparator: string;
  columns: Record<string, string | number>;
  isDefault: boolean;
};

export type ClassificationRuleRow = {
  id: string;
  caixaId: string | null;
  caixaName: string | null;
  matchKind: 'contains' | 'starts_with' | 'exact' | 'regex';
  pattern: string;
  direction: 'in' | 'out' | null;
  entityId: string | null;
  entityName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorSlot: number | null;
  priority: number;
  origin: 'manual' | 'correction' | 'agent';
  usageCount: number;
  lastUsedAt: string | null;
  archivedAt: string | null;
  canWrite: boolean;
};

/* ---------------- anexos ---------------- */

export type AttachmentTarget = 'title' | 'settlement' | 'movement' | 'card_purchase' | 'entity';

export type AttachmentRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  createdAt: string;
};

/* ---------------- auditoria e fechamento (spec 008) ---------------- */

export type AuditEntry = {
  id: string;
  tableName: string;
  recordId: string;
  action: 'insert' | 'update' | 'delete';
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  changedColumns: string[] | null;
  userId: string | null;
  username: string | null;
  actorKind: 'human' | 'agent' | 'system';
  agentRunId: string | null;
  transactionId: number;
  createdAt: string;
};

export type PeriodClosingRow = {
  id: string;
  caixaId: string;
  month: string;
  closedByUserId: string | null;
  closedBy: string | null;
  notes: string | null;
  createdAt: string;
};

export type ClosingsOverview = {
  closings: PeriodClosingRow[];
  /** Linhas de extrato não conciliadas (new/suggested) por mês, nas contas da caixa. */
  unreconciled: { month: string; lines: number }[];
  canWrite: boolean;
  canReopen: boolean;
};

/* ---------------- entrada de títulos (spec 010) ---------------- */

export type PixEntryResult = {
  payload: string;
  pixKey: string | null;
  pixKeyType: string | null;
  merchantName: string | null;
  merchantCity: string | null;
  amountCents: number | null;
  txid: string | null;
  description: string | null;
  entity: { id: string; name: string; document: string | null } | null;
  createdEntity: boolean;
};

export type NfeEntryResult = {
  nfeDocumentId: string;
  accessKey: string;
  number: number;
  series: number;
  issuedAt: string;
  totalCents: number;
  issuer: { entityId: string; name: string; document: string; created: boolean };
  recipient: { entityId: string | null; name: string | null; document: string | null } | null;
  duplicates: { number: string | null; dueDate: string | null; amountCents: number }[];
  itemCount: number;
  attachmentId: string | null;
  alreadyImported: boolean;
};

export type NfeDetail = {
  id: string;
  accessKey: string;
  number: number;
  series: number;
  issuedAt: string;
  totalCents: number;
  issuerEntityId: string;
  issuerName: string;
  recipientEntityId: string | null;
  recipientName: string | null;
  xmlAttachmentId: string | null;
  items: {
    itemNumber: number;
    productCode: string | null;
    description: string;
    ncm: string | null;
    cfop: string | null;
    unit: string | null;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }[];
};

/* ---------------- calendário (spec 012) ---------------- */

export type CalendarStatus = 'paid' | 'overdue' | 'payable' | 'receivable';

export type CalendarItem = {
  key: string;
  itemKind: 'title' | 'card_invoice';
  titleId: string | null;
  cardInvoiceId: string | null;
  caixaId: string;
  caixaName: string;
  counterpartyCaixaId: string | null;
  direction: 'payable' | 'receivable';
  dueDate: string;
  referenceMonth: string | null;
  description: string;
  entityId: string | null;
  entityName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColorSlot: number | null;
  amountCents: number;
  openCents: number;
  status: string;
  calendarStatus: CalendarStatus;
  canWrite: boolean;
  /** Pode arrastar para outro dia (título, com escrita; no lado espelho, também na caixa do original). */
  canReschedule: boolean;
  isMirrorSide: boolean;
  /** Lado do espelho (original/mirror) e o status do aceite, de calendar_items. */
  mirrorSide: 'original' | 'mirror' | null;
  mirrorStatus: string | null;
};

/**
 * Saldo por dia (fim do dia): realized = contas (movimentos até o dia, inclusive os já lançados no futuro);
 * scheduled = saldo aberto ACUMULADO dos títulos e faturas abertas até o dia, a partir de hoje (vencidos entram
 * hoje; antes de hoje é 0); projected = realized + scheduled.
 */
export type DailyBalance = { day: string; realizedCents: number | null; scheduledCents: number; projectedCents: number | null };

/* ======================================================================
 * Fase 3: relatórios, canvas de fluxo, mensagens e notificações.
 * ====================================================================== */

/** Regime dos relatórios (spec 008): competência (padrão) ou caixa. */
export type ReportBasis = 'competence' | 'cash';

/** Caixa citada num relatório (nome e tipo para a interface). */
export type ReportCaixa = { id: string; name: string; kind: 'general' | 'credit_card' };

/** Uma linha de report_category_totals com os nomes resolvidos. */
export type CategoryTotalLine = {
  month: string;
  caixaId: string;
  cardCaixaId: string | null;
  kind: 'income' | 'expense';
  groupCategoryId: string | null;
  groupName: string | null;
  groupColorSlot: number | null;
  categoryId: string | null;
  categoryName: string | null;
  colorSlot: number | null;
  source: 'title' | 'card_purchase' | 'settlement' | 'card_invoice_payment' | 'adjustment';
  isInternal: boolean;
  amountCents: number;
  entries: number;
};

export type CategoryReportData = {
  basis: ReportBasis;
  from: string;
  to: string;
  /** Meses do período ('YYYY-MM-01'), em ordem. */
  months: string[];
  caixas: ReportCaixa[];
  lines: CategoryTotalLine[];
  /** Filtro por entidade aplicado (null = sem filtro): quantas entidades casaram. */
  entityFilter: ReportEntityFilter | null;
};

/** Resultado do filtro por entidade (tags e favoritas) num relatório. */
export type ReportEntityFilter = { entityCount: number };

/** Uma linha de report_entity_totals com os nomes resolvidos. */
export type EntityTotalLine = {
  entityId: string;
  entityName: string;
  caixaId: string;
  caixaName: string;
  cardCaixaId: string | null;
  cardName: string | null;
  source: 'title' | 'card_purchase' | 'settlement' | 'card_invoice_payment' | 'adjustment';
  isInternal: boolean;
  outflowCents: number;
  inflowCents: number;
  entries: number;
};

export type EntityReportData = {
  basis: ReportBasis;
  from: string;
  to: string;
  caixas: ReportCaixa[];
  lines: EntityTotalLine[];
  entityFilter: ReportEntityFilter | null;
};

/** Uma linha de report_cash_projection (caixa, ou conta quando financialAccountId não é nulo). */
export type ProjectionLine = {
  caixaId: string;
  caixaName: string;
  financialAccountId: string | null;
  accountName: string | null;
  horizonDays: number;
  until: string;
  balanceTodayCents: number;
  scheduledMovementsCents: number;
  overdueReceivableCents: number;
  overduePayableCents: number;
  receivableCents: number;
  payableCents: number;
  projectedCents: number;
};

export type ProjectionReportData = {
  today: string;
  horizons: number[];
  lines: ProjectionLine[];
  entityFilter: ReportEntityFilter | null;
};

/* ---------------- canvas de fluxo (spec 014) ---------------- */

export type FlowNodeKind = 'caixa' | 'entity';
export type FlowEdgeKind = 'payment' | 'receipt' | 'transfer' | 'card_invoice' | 'card_purchase';

export type FlowNodeDto = {
  kind: FlowNodeKind;
  id: string;
  name: string;
  caixaKind: 'general' | 'credit_card' | null;
  entityKind: 'person' | 'company' | null;
  holderEntityId: string | null;
  balanceCents: number | null;
  cardUsedCents: number | null;
  cardLimitCents: number | null;
  mainCategoryId: string | null;
  mainGroupCategoryId: string | null;
  mainGroupName: string | null;
  mainGroupColorSlot: number | null;
  realizedInCents: number;
  realizedOutCents: number;
  forecastInCents: number;
  forecastOutCents: number;
  /** Nós de entidade: tags e favorita (o filtro do canvas é do navegador). Caixas: [] e false. */
  tagIds: string[];
  isFavorite: boolean;
};

export type FlowEdgeDto = {
  sourceKind: FlowNodeKind;
  sourceId: string;
  targetKind: FlowNodeKind;
  targetId: string;
  edgeKind: FlowEdgeKind;
  payerCaixaId: string | null;
  realizedCents: number;
  forecastCents: number;
  lines: number;
};

export type CanvasNodeKind = 'caixa' | 'entity' | 'category_group';
export type CanvasPosition = { nodeKind: CanvasNodeKind; nodeId: string; x: number; y: number };

export type FlowGraphData = {
  from: string;
  to: string;
  caixaIds: string[];
  nodes: FlowNodeDto[];
  edges: FlowEdgeDto[];
  positions: CanvasPosition[];
};

/** Uma linha da gaveta (flow_graph_lines), com rótulo e link para o registro. */
export type FlowLineDto = {
  sourceKind: FlowNodeKind;
  sourceId: string;
  sourceName: string;
  targetKind: FlowNodeKind;
  targetId: string;
  targetName: string;
  edgeKind: FlowEdgeKind;
  payerCaixaId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  colorSlot: number | null;
  refKind: 'settlement' | 'title' | 'card_invoice' | 'card_purchase' | 'transfer' | 'movement';
  refId: string;
  description: string;
  occurredOn: string;
  realizedCents: number;
  forecastCents: number;
  /** Caminho relativo do console para abrir o registro (nulo se o usuário não lê a caixa dele). */
  link: string | null;
};

/* ---------------- mensagens (spec 013) ---------------- */

export type MessageEventKind =
  | 'due_reminder'
  | 'overdue'
  | 'daily_summary'
  | 'weekly_summary'
  | 'invoice_closed'
  | 'card_limit'
  | 'reconciliation_divergence'
  | 'agent_completed'
  | 'agent_message'
  | 'contract_notice_deadline'
  | 'contract_ending'
  | 'contract_renewal_pending'
  | 'contract_readjustment'
  | 'ai_budget_alert'
  | 'ai_awaiting_approval';

export type DestinationOwnerKind = 'user' | 'caixa' | 'global';

/** Destino de mensagens. O bot token NUNCA vem na resposta: só botId (a parte pública). */
export type MessageDestinationDto = {
  id: string;
  channel: 'telegram';
  name: string;
  ownerKind: DestinationOwnerKind;
  ownerUserId: string | null;
  ownerUsername: string | null;
  ownerCaixaId: string | null;
  ownerCaixaName: string | null;
  botId: string | null;
  chatId: string | null;
  isActive: boolean;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  canManage: boolean;
  subscriptions: number;
  lastSentAt: string | null;
  failedCount: number;
  /** "Receber mensagens" (spec 029): o webhook está ligado e este agente responde. */
  inboundEnabled: boolean;
  inboundAgentId: string | null;
  inboundAgentName: string | null;
  /** Chats pareados ativos neste destino. */
  pairedChats: number;
};

/** Se dá para ligar a entrada do Telegram: exige uma URL pública HTTPS (app_settings telegram.public_base_url ou PUBLIC_BASE_URL). */
export type TelegramInboundConfigDto = {
  publicBaseUrl: string | null;
  source: 'setting' | 'env' | null;
  available: boolean;
};

export type MessageSubscriptionDto = {
  id: string;
  destinationId: string;
  eventKind: MessageEventKind;
  params: Record<string, unknown>;
  isActive: boolean;
  caixaIds: string[];
};

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'canceled';

export type OutboxMessageDto = {
  id: string;
  destinationId: string;
  destinationName: string;
  eventKind: MessageEventKind | 'test';
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  sentAt: string | null;
  lastError: string | null;
  text: string;
  caixaId: string | null;
  createdAt: string;
  canManage: boolean;
};

export type TestSendResult = { messageId: string; status: OutboxStatus; error: string | null };

/* ---------------- notificações (sino) ---------------- */

export type NotificationKind =
  | 'contract_notice_deadline'
  | 'contract_ending'
  | 'contract_renewal_pending'
  | 'contract_readjustment'
  | 'agent_completed'
  | 'agent_message'
  | 'ai_budget_alert'
  | 'ai_awaiting_approval'
  | 'mirror_pending'
  | 'mirror_disputed'
  | 'invoice_closed'
  | 'due_reminder'
  | 'overdue'
  | 'card_limit'
  | 'reconciliation_divergence'
  | 'message_failed'
  | 'system';

export type NotificationDto = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  caixaId: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = { unread: number; items: NotificationDto[] };

/* ---------------- contratos (spec 020) ---------------- */

export type ContractDirection = 'receivable' | 'payable';

export type ContractCycleBrief = {
  id: string;
  seq: number;
  startsOn: string;
  endsOn: string;
  durationMonths: number;
  periodicity: import('./contracts').ContractPeriodicity;
  installmentsCount: number;
  totalCents: number;
  dueDay: number;
  dueMonthOffset: number;
  readjustmentPercent: number | null;
};

export type ContractRow = {
  id: string;
  caixaId: string;
  caixaName: string;
  entityId: string;
  entityName: string;
  direction: ContractDirection;
  name: string;
  contractNumber: string | null;
  categoryId: string;
  categoryName: string;
  categoryColorSlot: number | null;
  status: import('./contracts').ContractStatus;
  autoRenew: boolean;
  currentCycle: ContractCycleBrief | null;
  nextInstallment: { titleId: string; dueDate: string; amountCents: number; installment: number; total: number } | null;
  openTask: { id: string; dueOn: string; overdue: boolean } | null;
  terminatedOn: string | null;
  archivedAt: string | null;
  canWrite: boolean;
};

export type ContractInstallmentDto = {
  titleId: string;
  caixaId: string;
  direction: ContractDirection;
  installment: number | null;
  description: string;
  competenceDate: string;
  dueDate: string;
  amountCents: number;
  settledCents: number;
  openCents: number;
  status: TitleStatus;
  overdue: boolean;
  archived: boolean;
};

export type ContractTotals = {
  contractedCents: number;
  settledCents: number;
  openCents: number;
  overdueCents: number;
  canceledCents: number;
};

export type ContractCycleDto = ContractCycleBrief & { installments: ContractInstallmentDto[]; totals: ContractTotals };

export type ContractDocumentDto = {
  id: string;
  kind: import('./contracts').ContractDocumentKind;
  format: import('./contracts').ContractDocumentFormat;
  title: string;
  description: string | null;
  documentDate: string | null;
  attachmentId: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  currentVersionId: string | null;
  currentVersion: number | null;
  versionCount: number;
  lastEditedAt: string | null;
  sourceDocumentId: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type ContractDocumentVersionDto = {
  id: string;
  documentId: string;
  version: number;
  note: string | null;
  authorKind: 'human' | 'agent';
  authorName: string | null;
  aiRunId: string | null;
  restoredFromVersion: number | null;
  sizeBytes: number;
  createdAt: string;
};

export type ContractDocumentVersionContent = ContractDocumentVersionDto & { content: string };

export type ContractAmendmentDto = {
  id: string;
  cycleSeq: number;
  effectiveOn: string;
  documentId: string | null;
  documentTitle: string | null;
  changes: { before: Record<string, unknown>; after: Record<string, unknown> };
  affectedCount: number;
  skippedCount: number;
  notes: string | null;
  createdAt: string;
  createdByName: string | null;
};

export type RenewalTaskDto = {
  id: string;
  cycleId: string;
  cycleSeq: number;
  status: 'open' | 'approved' | 'declined';
  openedOn: string;
  dueOn: string;
  overdue: boolean;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNotes: string | null;
  newCycleId: string | null;
};

export type ContractDetail = ContractRow & {
  counterpartyCaixaId: string | null;
  counterpartyCaixaName: string | null;
  notes: string | null;
  noticeDays: number;
  renewalLeadDays: number;
  reminderEveryDays: number;
  readjustmentIndex: import('./contracts').ReadjustmentIndex;
  readjustmentBaseDate: string | null;
  terminationPenaltyText: string | null;
  terminationPenaltyCents: number | null;
  terminationNotes: string | null;
  createdAt: string;
  /** Último dia do aviso prévio do ciclo atual. */
  noticeDeadline: string | null;
  /** Próxima data-base de reajuste (índice ≠ nenhum). */
  nextReadjustment: string | null;
  /** Leitura pela parcela espelhada (somente leitura). */
  viaMirror: boolean;
  cycles: ContractCycleDto[];
  extraTitles: ContractInstallmentDto[];
  documents: ContractDocumentDto[];
  amendments: ContractAmendmentDto[];
  renewalTasks: RenewalTaskDto[];
};

export type AmendmentPreview = {
  cycleId: string;
  affected: {
    titleId: string;
    installment: number;
    competenceDate: string;
    before: { amountCents: number; dueDate: string };
    after: { amountCents: number; dueDate: string };
  }[];
  skipped: { titleId: string; installment: number; competenceDate: string; reason: 'settled' | 'closed_month' | 'canceled' }[];
  changes: { before: Record<string, unknown>; after: Record<string, unknown> };
};

export type TerminationPreview = {
  terminatedOn: string;
  canceled: { titleId: string; installment: number; competenceDate: string; amountCents: number }[];
  current: {
    titleId: string;
    installment: number;
    competenceDate: string;
    periodEnd: string;
    amountCents: number;
    proratedCents: number;
    settled: boolean;
  } | null;
  blockedClosed: { titleId: string; installment: number; competenceDate: string }[];
  keptSettled: number;
};

export type RenewalPreview = {
  startsOn: string;
  endsOn: string;
  installments: import('./contracts').ScheduledInstallment[];
  closedMonths: string[];
};

export type ContractActionResult<P> = { preview: P; contract: ContractDetail | null };

export type RecurringPanelDto = {
  months: { month: string; receivableCents: number; payableCents: number; netCents: number }[];
  renewSoon: ContractRow[];
  pendingRenewals: ContractRow[];
};

export type ContractReadingDto = {
  entityId: string | null;
  entityName: string | null;
  document: string | null;
  direction: ContractDirection | null;
  name: string | null;
  contractNumber: string | null;
  startsOn: string | null;
  durationMonths: number | null;
  totalCents: number | null;
  installmentCents: number | null;
  periodicity: import('./contracts').ContractPeriodicity | null;
  dueDay: number | null;
  autoRenew: boolean | null;
  noticeDays: number | null;
  readjustmentIndex: import('./contracts').ReadjustmentIndex | null;
  readjustmentBaseDate: string | null;
  terminationPenaltyText: string | null;
  conversationId: string | null;
};
