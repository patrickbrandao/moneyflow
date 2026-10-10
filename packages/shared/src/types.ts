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

export type EntitySummary = {
  id: string;
  kind: EntityKind;
  name: string;
  tradeName: string | null;
  document: string | null;
  archivedAt: string | null;
  primaryPix: { keyType: string; keyValue: string } | null;
  caixaCount: number;
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
};

export type MemberRow = { id: string; userId: string; username: string; email: string; isActive: boolean; role: CaixaRole };

export type CaixaDetail = CaixaSummary & { accounts: AccountRow[]; canWrite: boolean };

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
  origin: 'manual' | 'recurrence' | 'card_invoice';
  recurrenceRuleId: string | null;
  occurrence: number | null;
  installmentsTotal: number | null;
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
