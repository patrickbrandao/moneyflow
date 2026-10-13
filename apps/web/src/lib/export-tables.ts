import {
  type CardPurchaseRow,
  type ContractRow,
  type EntitySummary,
  type ExportTable,
  exportFileName,
  formatDate,
  formatDocument,
  type Statement,
  type TitleRow,
  t,
  todayIso,
} from '@moneyflow/shared';

/*
 * As listagens principais como ExportTable (CSV/PDF): títulos, extrato,
 * compras do cartão e entidades. As telas buscam as linhas com os filtros
 * atuais e o limite máximo da API e chamam estas funções.
 */

const periodLine = (from?: string | null, to?: string | null) =>
  from || to ? `${t.reports.from} ${from ? formatDate(from) : '…'} ${t.reports.to.toLowerCase()} ${to ? formatDate(to) : '…'}` : null;

const titleStatus = (row: TitleRow) =>
  row.overdue && row.status !== 'paid' && row.status !== 'canceled' ? t.title.statuses.overdue : t.title.statuses[row.status];

export function titlesTable(
  rows: TitleRow[],
  meta: { caixaName: string; direction: 'payable' | 'receivable'; filter: string; from?: string; to?: string },
): ExportTable {
  const label = meta.direction === 'payable' ? 'Títulos a pagar' : 'Títulos a receber';
  return {
    fileName: exportFileName(label, meta.caixaName, todayIso()),
    title: `${label} · ${meta.caixaName}`,
    subtitle: [meta.filter, periodLine(meta.from, meta.to)].filter((x): x is string => Boolean(x)),
    columns: [
      { key: 'due', label: t.title.due, type: 'date' },
      { key: 'competence', label: 'Competência', type: 'date' },
      { key: 'description', label: t.common.description },
      { key: 'entity', label: 'Entidade' },
      { key: 'category', label: t.title.category },
      { key: 'amount', label: t.title.amount, type: 'money' },
      { key: 'open', label: t.title.open, type: 'money' },
      { key: 'status', label: t.common.status },
    ],
    rows: rows.map((r) => ({
      due: r.dueDate,
      competence: r.competenceDate,
      description: r.description,
      entity: r.entityName,
      category: r.categoryName,
      amount: r.amountCents,
      open: r.openCents,
      status: titleStatus(r),
    })),
  };
}

export function statementTable(statement: Statement, caixaName: string): ExportTable {
  const rows = statement.rows.map((r) => ({
    date: r.occurredOn,
    description: r.titleDescription ?? r.description ?? (r.transferId ? `Transferência ${r.counterpartAccountName ?? ''}`.trim() : ''),
    entity: r.entityName ?? r.counterpartCaixaName ?? '',
    category: r.categoryName ?? '',
    amount: r.amountCents,
    balance: r.balanceCents,
  }));
  return {
    fileName: exportFileName('Extrato', caixaName, statement.account.name, todayIso()),
    title: `Extrato · ${statement.account.name} (${caixaName})`,
    subtitle: [periodLine(statement.from, statement.to)].filter((x): x is string => Boolean(x)),
    columns: [
      { key: 'date', label: 'Data', type: 'date' },
      { key: 'description', label: t.common.description },
      { key: 'entity', label: 'Entidade / contraparte' },
      { key: 'category', label: t.title.category },
      { key: 'amount', label: 'Valor', type: 'money' },
      { key: 'balance', label: 'Saldo', type: 'money' },
    ],
    rows: [
      { description: t.statement.opening, balance: statement.openingCents },
      ...rows,
      { description: t.statement.closing, balance: statement.closingCents },
    ],
    boldRows: [0, rows.length + 1],
  };
}

export function purchasesTable(rows: CardPurchaseRow[], cardName: string): ExportTable {
  return {
    fileName: exportFileName('Compras', cardName, todayIso()),
    title: `Compras · ${cardName}`,
    columns: [
      { key: 'date', label: 'Data', type: 'date' },
      { key: 'kind', label: 'Tipo' },
      { key: 'description', label: t.common.description },
      { key: 'entity', label: 'Recebedor' },
      { key: 'category', label: t.title.category },
      { key: 'payer', label: 'Pagadora' },
      { key: 'installments', label: 'Parcelas', type: 'int' },
      { key: 'amount', label: 'Valor', type: 'money' },
    ],
    rows: rows.map((r) => ({
      date: r.purchasedOn,
      kind:
        r.kind === 'charge' && r.chargeKind
          ? (t.card.chargeKinds[r.chargeKind] ?? t.card.purchaseKinds.charge)
          : t.card.purchaseKinds[r.kind],
      description: r.description,
      entity: r.entityName,
      category: r.categoryName,
      payer: r.payerCaixaName,
      installments: r.installmentsTotal,
      amount: r.kind === 'refund' ? -r.amountCents : r.amountCents,
    })),
  };
}

export function entitiesTable(rows: EntitySummary[]): ExportTable {
  return {
    fileName: exportFileName('Entidades', todayIso()),
    title: t.nav.entities,
    columns: [
      { key: 'name', label: t.common.name },
      { key: 'tradeName', label: 'Nome fantasia' },
      { key: 'kind', label: 'Tipo' },
      { key: 'document', label: 'CPF/CNPJ' },
      { key: 'pix', label: 'PIX principal' },
      { key: 'caixas', label: t.nav.caixas, type: 'int' },
      { key: 'archived', label: t.common.archived },
    ],
    rows: rows.map((r) => ({
      name: r.name,
      tradeName: r.tradeName ?? '',
      kind: r.kind === 'company' ? 'Empresa' : 'Pessoa',
      document: r.document ? formatDocument(r.document) : '',
      pix: r.primaryPix?.keyValue ?? '',
      caixas: r.caixaCount,
      archived: r.archivedAt ? t.common.yes : '',
    })),
  };
}

/** Contratos (spec 020): a lista com os filtros da tela. */
export function contractsTable(rows: ContractRow[], filter: string): ExportTable {
  const C = t.contracts.columns;
  return {
    fileName: exportFileName('Contratos', todayIso()),
    title: t.contracts.title,
    subtitle: filter ? [filter] : [],
    columns: [
      { key: 'name', label: C.name },
      { key: 'number', label: t.contracts.fields.contractNumber },
      { key: 'entity', label: C.entity },
      { key: 'caixa', label: C.caixa },
      { key: 'direction', label: C.direction },
      { key: 'starts', label: t.contracts.fields.startsOn, type: 'date' },
      { key: 'ends', label: t.contracts.fields.endsOn, type: 'date' },
      { key: 'value', label: C.value, type: 'money' },
      { key: 'nextDue', label: C.next, type: 'date' },
      { key: 'nextAmount', label: t.contracts.fields.installmentCents, type: 'money' },
      { key: 'status', label: C.status },
    ],
    rows: rows.map((r) => ({
      name: r.name,
      number: r.contractNumber,
      entity: r.entityName,
      caixa: r.caixaName,
      direction: t.contracts.directionsShort[r.direction],
      starts: r.currentCycle?.startsOn ?? null,
      ends: r.currentCycle?.endsOn ?? null,
      value: r.currentCycle?.totalCents ?? null,
      nextDue: r.nextInstallment?.dueDate ?? null,
      nextAmount: r.nextInstallment?.amountCents ?? null,
      status: t.contracts.statuses[r.status],
    })),
  };
}
