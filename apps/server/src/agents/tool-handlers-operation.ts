import {
  cycleSchedule,
  diffLines,
  diffRows,
  diffStats,
  formatBRL,
  formatDate,
  installmentsCount,
  type OPERATION_TOOLS,
  type PreviewField,
  type PreviewRow,
  parseBoleto,
  parseNfeXml,
  t,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { forbidden, notFound, unprocessable } from '../errors';
import { assertAttachTarget, linkExistingAttachment } from '../services/attachments';
import * as caixas from '../services/caixas';
import * as cards from '../services/cards';
import * as categories from '../services/categories';
import * as documents from '../services/contract-documents';
import * as contracts from '../services/contracts';
import * as rec from '../services/reconciliation';
import * as statements from '../services/statements';
import { nfeEntry, pixEntry, readDocument } from '../services/title-entry';
import * as titles from '../services/titles';
import * as transfers from '../services/transfers';
import { supersedeRows } from './tool-handlers-supersede';
import { type Handlers, nameOf, toolAttachment, withNames } from './tool-helpers';

/*
 * Executores do lote F13a (spec 027): Contratos, Importação a partir de
 * anexo, Cartão, Caixas e contas, Títulos e Categorias e regras. Cada tool
 * roda sobre o mesmo serviço da rota da API (com Access); a prévia confere a
 * permissão e as regras que fariam a ação falhar antes de pedir aprovação.
 */

type OperationToolName = (typeof OPERATION_TOOLS)[number]['name'];

const DIRECTION = (v: unknown) => t.contracts.directionsShort[String(v)] ?? String(v);
const PERIODICITY = (v: unknown) => t.contracts.periodicities[String(v)] ?? String(v);
const listed = (items: string[], max = 12) =>
  items.length > max ? `${items.slice(0, max).join(', ')} e mais ${items.length - max}` : items.join(', ') || '—';

/* ---------------- contratos ---------------- */

const CONTRACT_FIELDS: PreviewField[] = [
  { key: 'caixaId', label: 'Caixa' },
  { key: 'direction', label: 'Tipo', format: DIRECTION },
  { key: 'entityId', label: 'Entidade' },
  { key: 'categoryId', label: 'Categoria' },
  { key: 'name', label: 'Nome' },
  { key: 'contractNumber', label: 'Número' },
  { key: 'startsOn', label: 'Início', format: 'date' },
  { key: 'durationMonths', label: 'Duração (meses)' },
  { key: 'periodicity', label: 'Periodicidade', format: PERIODICITY },
  { key: 'totalCents', label: 'Valor total do ciclo', format: 'money' },
  { key: 'dueDay', label: 'Dia de vencimento' },
  { key: 'dueMonthOffset', label: 'Vencimento (meses depois)' },
  { key: 'autoRenew', label: 'Renovação automática', format: 'bool' },
  { key: 'noticeDays', label: 'Aviso prévio (dias)' },
  { key: 'readjustmentIndex', label: 'Reajuste', format: (v) => t.contracts.indexes[String(v)] ?? String(v) },
  { key: 'readjustmentBaseDate', label: 'Data-base do reajuste', format: 'date' },
  { key: 'terminationPenaltyText', label: 'Multa rescisória' },
  { key: 'terminationPenaltyCents', label: 'Multa (valor)', format: 'money' },
  { key: 'notes', label: 'Observações' },
];

async function writableContract(ctx: ServiceContext, contractId: string) {
  const contract = await contracts.getContract(ctx, contractId);
  if (!contract.canWrite) throw forbidden(t.errors.readOnly);
  return contract;
}

/** Valores atuais do contrato e do ciclo atual, no formato dos campos (antes do diff). */
function contractValues(contract: Awaited<ReturnType<typeof contracts.getContract>>): Record<string, unknown> {
  const cycle = contract.cycles.at(-1) ?? contract.currentCycle;
  return {
    ...contract,
    startsOn: cycle?.startsOn,
    durationMonths: cycle?.durationMonths,
    periodicity: cycle?.periodicity,
    totalCents: cycle?.totalCents,
    dueDay: cycle?.dueDay,
    dueMonthOffset: cycle?.dueMonthOffset,
  };
}

/* ---------------- títulos ---------------- */

async function writableTitle(ctx: ServiceContext, titleId: string) {
  const title = await titles.getTitle(ctx, titleId);
  if (!title.canWrite) throw forbidden(t.errors.readOnly);
  return title;
}

const titleLabel = (title: { description: string; entityName: string; amountCents: number; dueDate: string }) =>
  `${title.description} (${title.entityName}) · ${formatBRL(title.amountCents)} · venc. ${formatDate(title.dueDate)}`;

/* ---------------- caixas ---------------- */

const CAIXA_FIELDS: PreviewField[] = [
  { key: 'name', label: 'Nome' },
  { key: 'kind', label: 'Tipo', format: (v) => (v === 'credit_card' ? 'Cartão de crédito' : 'Geral') },
  { key: 'holderEntityId', label: 'Titular' },
  { key: 'isPrimary', label: 'Principal do titular', format: 'bool' },
  { key: 'description', label: 'Descrição' },
  { key: 'defaultPayerCaixaId', label: 'Pagadora padrão' },
  { key: 'creditLimitCents', label: 'Limite', format: 'money' },
  { key: 'closingDay', label: 'Dia de fechamento' },
  { key: 'dueDay', label: 'Dia de vencimento' },
  { key: 'cardLast4', label: 'Final do cartão' },
];

const ACCOUNT_KIND = (v: unknown) =>
  ({ checking: 'Conta corrente', cash: 'Cofre', savings: 'Poupança/investimento' })[String(v)] ?? String(v);

const ACCOUNT_FIELDS: PreviewField[] = [
  { key: 'kind', label: 'Tipo', format: ACCOUNT_KIND },
  { key: 'name', label: 'Nome' },
  { key: 'bankCode', label: 'Banco' },
  { key: 'ispb', label: 'ISPB' },
  { key: 'branch', label: 'Agência' },
  { key: 'accountNumber', label: 'Conta' },
  { key: 'openingBalanceCents', label: 'Saldo de abertura', format: 'money' },
  { key: 'openingDate', label: 'Data de abertura', format: 'date' },
];

async function writableAccount(ctx: ServiceContext, accountId: string) {
  const account = await caixas.getAccount(ctx, accountId);
  ctx.access.assertWrite(account.caixaId);
  return account;
}

/* ---------------- categorias e regras ---------------- */

const CATEGORY_FIELDS: PreviewField[] = [
  { key: 'kind', label: 'Tipo', format: (v) => (v === 'income' ? 'Receita' : 'Despesa') },
  { key: 'parentId', label: 'Grupo' },
  { key: 'name', label: 'Nome' },
  { key: 'colorSlot', label: 'Cor (1–12)' },
  { key: 'icon', label: 'Ícone' },
];

const MATCH_KIND = (v: unknown) =>
  ({ contains: 'Contém', starts_with: 'Começa com', exact: 'Igual a', regex: 'Expressão regular' })[String(v)] ?? String(v);

const RULE_FIELDS: PreviewField[] = [
  { key: 'caixaId', label: 'Caixa' },
  { key: 'matchKind', label: 'Tipo do padrão', format: MATCH_KIND },
  { key: 'pattern', label: 'Padrão' },
  { key: 'direction', label: 'Direção', format: (v) => (v === 'in' ? 'Entrada' : v === 'out' ? 'Saída' : String(v)) },
  { key: 'entityId', label: 'Entidade' },
  { key: 'categoryId', label: 'Categoria' },
  { key: 'priority', label: 'Prioridade' },
];

/** Regra que o usuário pode alterar (a mesma checagem do serviço: caixa com escrita; global só o admin). */
async function writableRule(ctx: ServiceContext, ruleId: string) {
  const result = await ctx.db.execute<{
    caixa_id: string | null;
    match_kind: string;
    pattern: string;
    direction: string | null;
    entity_id: string | null;
    category_id: string | null;
    priority: number;
    archived_at: string | null;
  }>(sql`
    SELECT caixa_id, match_kind, pattern, direction, entity_id, category_id, priority, archived_at
      FROM classification_rules WHERE id = ${ruleId}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  if (row.caixa_id) ctx.access.assertWrite(row.caixa_id);
  else if (!ctx.access.isAdmin) throw forbidden();
  return {
    caixaId: row.caixa_id,
    matchKind: row.match_kind,
    pattern: row.pattern,
    direction: row.direction,
    entityId: row.entity_id,
    categoryId: row.category_id,
    priority: row.priority,
    archivedAt: row.archived_at,
  };
}

/* ---------------- importação ---------------- */

const fileLabel = (file: { fileName: string; sizeBytes: number }) =>
  `${file.fileName} (${file.sizeBytes < 1024 ? `${file.sizeBytes} B` : `${Math.ceil(file.sizeBytes / 1024)} KB`})`;

/** Pagamento de boleto ou PIX copia-e-cola: o PIX começa pelo cabeçalho do BR Code. */
const lotBalance = (cents: number | null, on: string | null) =>
  cents === null || on === null ? '—' : `${formatBRL(cents)} em ${formatDate(on)}`;
const isPixPayload = (code: string) => /^000201/.test(code.trim());

/* ---------------- handlers ---------------- */

export const OPERATION_HANDLERS: Handlers<OperationToolName> = {
  /* ---- contratos ---- */
  list_contracts: { run: (ctx, i) => contracts.listContracts(ctx, i) },
  get_contract: { run: (ctx, i) => contracts.getContract(ctx, i.contractId) },
  create_contract: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.caixaId);
      const values = await withNames(ctx, i, { caixaId: 'caixa', entityId: 'entity', categoryId: 'category' });
      const rows = diffRows(CONTRACT_FIELDS, values);
      const count = installmentsCount(i.durationMonths, i.periodicity);
      if (count) rows.push({ label: 'Parcelas', after: `${count} (${PERIODICITY(i.periodicity).toLowerCase()})` });
      if (i.mirrorCaixaId === null) rows.push({ label: 'Espelho', after: 'Sem espelho' });
      else if (i.mirrorCaixaId) rows.push({ label: 'Espelho em', after: (await nameOf(ctx, 'caixa', i.mirrorCaixaId)) ?? '' });
      return {
        title: 'Criar contrato',
        summary: `${i.name} · ${formatBRL(i.totalCents)}`,
        action: 'create',
        rows,
        warnings: ['Fica em rascunho: nenhuma parcela é gerada até activate_contract.'],
      };
    },
    run: (ctx, i) => contracts.createContract(ctx, { ...i, activate: false }),
  },
  update_contract: {
    preview: async (ctx, i) => {
      const before = await writableContract(ctx, i.contractId);
      const old = await withNames(ctx, contractValues(before), { entityId: 'entity', categoryId: 'category' });
      const after = await withNames(ctx, i.changes as Record<string, unknown>, { entityId: 'entity', categoryId: 'category' });
      const rows = diffRows(CONTRACT_FIELDS, after, old);
      const locked = ['startsOn', 'durationMonths', 'periodicity', 'totalCents', 'dueDay', 'dueMonthOffset', 'entityId', 'categoryId'];
      if (before.status !== 'draft' && rows.some((row) => CONTRACT_FIELDS.some((f) => f.label === row.label && locked.includes(f.key))))
        throw unprocessable(t.contracts.lockedActive, 'contract_locked');
      if (i.changes.mirrorCaixaId !== undefined) {
        rows.push({
          label: 'Espelho',
          before: before.counterpartyCaixaName ?? 'Sem espelho',
          after: i.changes.mirrorCaixaId ? ((await nameOf(ctx, 'caixa', i.changes.mirrorCaixaId)) ?? '') : 'Sem espelho',
        });
      }
      return { title: 'Editar contrato', summary: before.name, action: 'update', rows };
    },
    run: (ctx, i) => contracts.updateContract(ctx, i.contractId, i.changes),
  },
  activate_contract: {
    preview: async (ctx, i) => {
      const contract = await writableContract(ctx, i.contractId);
      if (contract.status !== 'draft') throw unprocessable(t.contracts.errors.alreadyActive, 'contract_not_draft');
      const cycle = contract.cycles[0];
      if (!cycle) throw notFound();
      const schedule = cycleSchedule({
        startsOn: cycle.startsOn,
        durationMonths: cycle.durationMonths,
        periodicity: cycle.periodicity,
        totalCents: cycle.totalCents,
        dueDay: cycle.dueDay,
        dueMonthOffset: cycle.dueMonthOffset,
      });
      const rows: PreviewRow[] = [{ label: 'Situação', before: 'Rascunho', after: 'Vigente' }];
      for (const s of schedule.slice(0, 24))
        rows.push({
          label: `Parcela ${s.installment}/${schedule.length}`,
          after: `${formatBRL(s.amountCents)} · venc. ${formatDate(s.dueDate)}`,
        });
      return {
        title: 'Ativar contrato',
        summary: `${contract.name} (${contract.entityName})`,
        action: 'create',
        rows,
        warnings: [
          ...(schedule.length > 24 ? [`E mais ${schedule.length - 24} parcela(s).`] : []),
          ...(contract.counterpartyCaixaId ? [`Cada parcela é espelhada em ${contract.counterpartyCaixaName}.`] : []),
        ],
      };
    },
    run: (ctx, i) => contracts.activateContract(ctx, i.contractId),
  },
  add_contract_amendment: {
    preview: async (ctx, i) => {
      const contract = await writableContract(ctx, i.contractId);
      const { preview } = await contracts.amendContract(ctx, i.contractId, i.amendment, true);
      const rows: PreviewRow[] = [{ label: 'Efeito a partir de', after: formatDate(i.amendment.effectiveOn) }];
      for (const a of preview.affected.slice(0, 24)) {
        rows.push({
          label: `Parcela ${a.installment}`,
          before: `${formatBRL(a.before.amountCents)} · venc. ${formatDate(a.before.dueDate)}`,
          after: `${formatBRL(a.after.amountCents)} · venc. ${formatDate(a.after.dueDate)}`,
        });
      }
      if (i.amendment.categoryId) rows.push({ label: 'Categoria', after: (await nameOf(ctx, 'category', i.amendment.categoryId)) ?? '' });
      if (i.amendment.notes) rows.push({ label: 'Observações', after: i.amendment.notes });
      return {
        title: 'Registrar aditivo',
        summary: contract.name,
        action: 'update',
        rows,
        warnings: [
          ...(preview.affected.length > 24 ? [`E mais ${preview.affected.length - 24} parcela(s) alteradas.`] : []),
          ...(preview.skipped.length > 0
            ? [`${preview.skipped.length} parcela(s) ficam como estão (paga, mês fechado ou cancelada).`]
            : []),
        ],
      };
    },
    run: (ctx, i) => contracts.amendContract(ctx, i.contractId, i.amendment, false),
  },
  terminate_contract: {
    preview: async (ctx, i) => {
      const contract = await writableContract(ctx, i.contractId);
      const { preview } = await contracts.terminateContract(ctx, i.contractId, i.termination, true);
      const rows: PreviewRow[] = [
        { label: 'Situação', before: t.contracts.statuses[contract.status] ?? contract.status, after: 'Rescindido' },
        { label: 'Encerramento', after: formatDate(preview.terminatedOn) },
      ];
      if (preview.canceled.length > 0)
        rows.push({
          label: 'Parcelas canceladas',
          after: listed(preview.canceled.map((c) => `#${c.installment} ${formatBRL(c.amountCents)}`)),
        });
      if (preview.current) {
        const next = i.termination.currentInstallmentCents ?? preview.current.amountCents;
        rows.push({
          label: `Parcela ${preview.current.installment} (cobre a data)`,
          before: formatBRL(preview.current.amountCents),
          after: `${formatBRL(next)} (proporcional sugerido: ${formatBRL(preview.current.proratedCents)})`,
        });
      }
      if (i.termination.penalty)
        rows.push({
          label: 'Multa',
          after: `${DIRECTION(i.termination.penalty.direction)} · ${formatBRL(i.termination.penalty.amountCents)} · venc. ${formatDate(i.termination.penalty.dueDate)}`,
        });
      return {
        title: 'Rescindir contrato',
        summary: `${contract.name} (${contract.entityName})`,
        action: 'delete',
        rows,
        warnings: [
          ...(preview.keptSettled > 0 ? [`${preview.keptSettled} parcela(s) paga(s) ficam como estão.`] : []),
          ...(preview.blockedClosed.length > 0 ? [`${preview.blockedClosed.length} parcela(s) em mês fechado não são canceladas.`] : []),
          'A rescisão não volta atrás.',
        ],
      };
    },
    run: (ctx, i) => contracts.terminateContract(ctx, i.contractId, i.termination, false),
  },
  decide_contract_renewal: {
    preview: async (ctx, i) => {
      const contract = await writableContract(ctx, i.contractId);
      if (i.decision === 'decline') {
        if (!contract.renewalTasks.some((task) => task.status === 'open'))
          throw unprocessable(t.contracts.errors.noTaskOpen, 'no_task_open');
        return {
          title: 'Recusar renovação',
          summary: contract.name,
          action: 'update',
          rows: [
            { label: 'Renovação', before: 'Pendente', after: 'Recusada' },
            ...(i.notes ? [{ label: 'Observações', after: i.notes }] : []),
          ],
          warnings: ['O contrato termina no fim do ciclo atual.'],
        };
      }
      const renewal = i.renewal!;
      const { preview } = await contracts.renewContract(ctx, i.contractId, renewal, true);
      const rows: PreviewRow[] = [
        { label: 'Novo ciclo', after: `${formatDate(preview.startsOn)} a ${formatDate(preview.endsOn)}` },
        { label: 'Valor total', after: formatBRL(renewal.totalCents) },
        { label: 'Periodicidade', after: PERIODICITY(renewal.periodicity) },
      ];
      for (const s of preview.installments.slice(0, 24))
        rows.push({
          label: `Parcela ${s.installment}/${preview.installments.length}`,
          after: `${formatBRL(s.amountCents)} · venc. ${formatDate(s.dueDate)}`,
        });
      return {
        title: 'Aprovar renovação',
        summary: contract.name,
        action: 'create',
        rows,
        warnings: preview.closedMonths.length > 0 ? [`Meses fechados no período: ${preview.closedMonths.join(', ')}.`] : [],
      };
    },
    run: async (ctx, i) => {
      if (i.decision === 'decline') return contracts.declineRenewal(ctx, i.contractId, { notes: i.notes });
      return contracts.renewContract(ctx, i.contractId, { ...i.renewal!, notes: i.renewal!.notes ?? i.notes }, false);
    },
  },
  get_contract_document: {
    run: async (ctx, i) => {
      const document = await documents.getContractDocument(ctx, i.documentId);
      if (document.format !== 'markdown') {
        if (i.versionId) throw unprocessable(t.contracts.errors.notMarkdown, 'not_markdown');
        return { document, content: null };
      }
      const versionId = i.versionId ?? document.currentVersionId;
      const version = versionId ? await documents.getVersion(ctx, i.documentId, versionId) : null;
      return { document, versions: await documents.listVersions(ctx, i.documentId), version };
    },
  },
  save_contract_markdown: {
    preview: async (ctx, i) => {
      if (i.documentId) {
        const doc = await documents.writableContractDocument(ctx, i.documentId);
        if (doc.format !== 'markdown') throw unprocessable(t.contracts.errors.notMarkdown, 'not_markdown');
        if (doc.content === i.content) throw unprocessable(t.contracts.documents.noChanges, 'no_changes');
        const stats = diffStats(diffLines(doc.content ?? '', i.content));
        return {
          title: 'Salvar nova versão do markdown',
          summary: doc.title,
          action: 'update',
          rows: [
            { label: 'Versão', before: String(doc.currentVersion ?? '—'), after: String((doc.currentVersion ?? 0) + 1) },
            { label: 'Linhas', after: `+${stats.added} / −${stats.removed}` },
            ...(i.note ? [{ label: 'Nota', after: i.note }] : []),
          ],
          warnings: ['As versões anteriores ficam no histórico.'],
        };
      }
      const contract = await writableContract(ctx, i.contractId!);
      return {
        title: 'Criar documento markdown',
        summary: `${i.title} · ${contract.name}`,
        action: 'create',
        rows: [
          { label: 'Tipo', after: t.contracts.documents.kinds[i.kind] ?? i.kind },
          { label: 'Linhas', after: String(i.content.split('\n').length) },
          ...(i.note ? [{ label: 'Nota', after: i.note }] : []),
        ],
      };
    },
    run: async (ctx, i) => {
      if (i.documentId) return documents.saveVersion(ctx, i.documentId, { content: i.content, note: i.note });
      return documents.createMarkdownDocument(ctx, i.contractId!, {
        kind: i.kind,
        title: i.title!,
        documentDate: null,
        description: null,
        content: i.content,
        note: i.note,
      });
    },
  },
  convert_contract_pdf: {
    preview: async (ctx, i) => {
      const doc = await documents.writableContractDocument(ctx, i.documentId);
      if (doc.format !== 'pdf' || !doc.attachmentId) throw unprocessable(t.contracts.errors.notPdf, 'not_pdf');
      return {
        title: 'Converter PDF em markdown',
        summary: doc.title,
        action: 'create',
        rows: [
          { label: 'PDF', after: doc.fileName ?? doc.title },
          { label: 'Resultado', after: 'Documento markdown novo (versão 1), ligado ao PDF' },
        ],
        warnings: ['A conversão usa o agente dos fluxos (IA) e pode levar até alguns minutos.'],
      };
    },
    run: (ctx, i) => documents.convertPdfToMarkdown(ctx, i.documentId),
  },

  /* ---- importação ---- */
  import_statement: {
    preview: async (ctx, i) => {
      const file = await toolAttachment(ctx, i.attachmentId);
      const info = await statements.previewStatementImport(ctx, i, file.content, {
        mappingId: i.mappingId,
        inline: i.csvMapping,
        ofxStatement: i.ofxStatement,
        provisional: i.provisional,
        supersede: i.supersedeImportIds,
      });
      const where = i.accountId ? await nameOf(ctx, 'account', i.accountId) : await nameOf(ctx, 'caixa', i.cardCaixaId);
      if (info.fresh === 0) throw unprocessable(t.errors.statementAllDuplicated, 'statement_duplicated');
      const rows: PreviewRow[] = [
        { label: 'Arquivo', after: fileLabel(file) },
        { label: i.accountId ? 'Conta' : 'Cartão', after: where ?? '' },
        { label: 'Formato', after: info.format.toUpperCase() },
        {
          label: 'Período',
          after: `${info.periodStart ? formatDate(info.periodStart) : '—'} a ${info.periodEnd ? formatDate(info.periodEnd) : '—'}`,
        },
        { label: 'Linhas novas', after: String(info.fresh) },
        { label: 'Entradas', after: formatBRL(info.inCents) },
        { label: 'Saídas', after: formatBRL(info.outCents) },
      ];
      if (i.csvMapping) rows.push({ label: 'Mapeamento CSV (salvo)', after: i.csvMapping.name });
      if (info.provisional) rows.push({ label: 'Lote', after: 'Provisório (extrato parcial do mês)' });
      if (info.superseded) rows.push(...supersedeRows(info.superseded));
      return {
        title: 'Importar extrato',
        summary: file.fileName,
        action: 'create',
        rows,
        warnings: [
          ...(info.duplicated > 0 ? [`${info.duplicated} linha(s) já importada(s) ficam de fora.`] : []),
          ...(info.ofxLeftOut.length ? [t.statements.ofxLeftOut(info.ofxLeftOut.join(', '))] : []),
          ...(!info.superseded && info.provisionalOverlap.length
            ? [t.statements.supersede.overlapWarning(info.provisionalOverlap.map((p) => `${p.fileName} (${p.id})`).join(', '))]
            : []),
        ],
      };
    },
    run: async (ctx, i) => {
      const file = await toolAttachment(ctx, i.attachmentId);
      let mappingId = i.mappingId;
      if (i.csvMapping) {
        const mapping = await rec.createMapping(ctx, {
          ...i.csvMapping,
          financialAccountId: i.accountId ?? null,
          cardCaixaId: i.cardCaixaId ?? null,
        });
        mappingId = mapping.id;
      }
      const detail = await statements.importStatement(
        ctx,
        {
          accountId: i.accountId,
          cardCaixaId: i.cardCaixaId,
          cardInvoiceId: i.cardInvoiceId,
          fileName: file.fileName,
          mappingId,
          bankBalanceCents: i.bankBalanceCents,
          bankBalanceOn: i.bankBalanceOn,
          ofxStatement: i.ofxStatement,
          provisional: Boolean(i.provisional),
          supersede: i.supersedeImportIds ?? [],
        },
        { mime: file.mime, content: file.content },
      );
      return detail;
    },
  },
  set_statement_import_balance: {
    preview: async (ctx, i) => {
      const lot = await statements.getImport(ctx, i.importId, false);
      ctx.access.assertWrite(lot.caixaId);
      if (!lot.financialAccountId) throw unprocessable(t.errors.statementBalanceAccountOnly, 'statement_balance_account_only');
      const after =
        i.mode === 'set'
          ? lotBalance(i.bankBalanceCents ?? null, i.bankBalanceOn ?? null)
          : i.mode === 'clear'
            ? '—'
            : 'o saldo do arquivo';
      return {
        title: 'Saldo do banco do lote',
        summary: lot.fileName,
        action: 'update',
        rows: [
          { label: 'Conta', after: lot.accountName ?? '' },
          {
            label: 'Período',
            after: `${lot.periodStart ? formatDate(lot.periodStart) : '—'} a ${lot.periodEnd ? formatDate(lot.periodEnd) : '—'}`,
          },
          { label: 'Saldo do banco', before: lotBalance(lot.bankBalanceCents, lot.bankBalanceOn), after },
        ],
        warnings: i.mode === 'clear' ? ['O lote fica sem comparação de saldo.'] : [],
      };
    },
    run: async (ctx, i) => {
      const input = i.mode === 'set' ? { mode: 'set' as const, amountCents: i.bankBalanceCents!, on: i.bankBalanceOn! } : { mode: i.mode };
      const { lines: _lines, ...lot } = await statements.setImportBankBalance(ctx, i.importId, input);
      return lot;
    },
  },
  import_nfe: {
    preview: async (ctx, i) => {
      ctx.access.assertRegistryWrite();
      const file = await toolAttachment(ctx, i.attachmentId);
      let nfe: ReturnType<typeof parseNfeXml>;
      try {
        nfe = parseNfeXml(file.content.toString('utf8'));
      } catch (error) {
        throw unprocessable(`${t.errors.nfeInvalid} ${error instanceof Error ? error.message : ''}`.trim(), 'nfe_invalid');
      }
      const known = await ctx.db.execute(sql`SELECT 1 FROM nfe_documents WHERE access_key = ${nfe.accessKey}`);
      const issuer = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM entities WHERE document = ${nfe.issuer.document}`);
      const rows: PreviewRow[] = [
        { label: 'Arquivo', after: fileLabel(file) },
        { label: 'NF-e', after: `nº ${nfe.number} série ${nfe.series} · ${formatDate(nfe.issuedAt.slice(0, 10))}` },
        { label: 'Emitente', after: `${nfe.issuer.name} (${issuer.rows[0] ? 'já cadastrado' : 'novo cadastro'})` },
        { label: 'Valor', after: formatBRL(nfe.totalCents) },
        { label: 'Itens', after: String(nfe.items.length) },
      ];
      if (nfe.duplicates.length > 0)
        rows.push({
          label: 'Duplicatas',
          after: listed(nfe.duplicates.map((d) => `${formatBRL(d.amountCents)}${d.dueDate ? ` em ${formatDate(d.dueDate)}` : ''}`)),
        });
      return {
        title: 'Importar NF-e',
        summary: `${nfe.issuer.name} · ${formatBRL(nfe.totalCents)}`,
        action: 'create',
        rows,
        warnings: [
          ...(known.rows.length > 0 ? ['Esta NF-e já foi importada: nada é gravado de novo.'] : []),
          'O título não é criado aqui: use create_title com o nfeDocumentId devolvido.',
        ],
      };
    },
    run: async (ctx, i) => {
      const file = await toolAttachment(ctx, i.attachmentId);
      const result = await nfeEntry(ctx, { name: file.fileName, mime: file.mime, content: file.content });
      const due = result.duplicates.find((d) => d.dueDate)?.dueDate ?? result.issuedAt.slice(0, 10);
      return {
        ...result,
        suggestedTitle: {
          direction: 'payable',
          entityId: result.issuer.entityId,
          description: `NF-e ${result.number} — ${result.issuer.name}`.slice(0, 300),
          competenceDate: result.issuedAt.slice(0, 10),
          dueDate: due,
          amountCents: result.totalCents,
          nfeDocumentId: result.nfeDocumentId,
        },
      };
    },
  },
  read_document: {
    run: async (ctx, i) => {
      const file = await toolAttachment(ctx, i.attachmentId);
      return readDocument(ctx, { name: file.fileName, mime: file.mime, content: file.content });
    },
  },
  parse_payment_code: {
    run: async (ctx, i) => {
      if (isPixPayload(i.code)) return { kind: 'pix', ...(await pixEntry(ctx, { payload: i.code, createEntity: false })) };
      const boleto = parseBoleto(i.code);
      if (!boleto.ok) throw unprocessable(boleto.error, 'boleto_invalid');
      const { kind: boletoKind, ok: _ok, ...data } = boleto;
      return { kind: 'boleto', boletoKind, ...data };
    },
  },
  attach_file: {
    preview: async (ctx, i) => {
      const file = await toolAttachment(ctx, i.attachmentId);
      let target: string;
      if (i.target === 'contract') {
        const contract = await writableContract(ctx, i.targetId);
        target = `Contrato ${contract.name}`;
      } else {
        await assertAttachTarget(ctx, i.target, i.targetId);
        target = await attachTargetLabel(ctx, i.target, i.targetId);
      }
      return {
        title: 'Anexar arquivo',
        summary: file.fileName,
        action: 'create',
        rows: [
          { label: 'Arquivo', after: fileLabel(file) },
          { label: 'Anexar a', after: target },
          ...(i.target === 'contract' ? [{ label: 'Documento', after: `${t.contracts.documents.kinds[i.kind] ?? i.kind}` }] : []),
        ],
      };
    },
    run: async (ctx, i) => {
      const file = await toolAttachment(ctx, i.attachmentId);
      if (i.target === 'contract') {
        return documents.uploadContractDocument(
          ctx,
          i.targetId,
          { kind: i.kind, title: i.title, fileName: file.fileName },
          { mime: file.mime, content: file.content },
        );
      }
      return linkExistingAttachment(ctx, file.id, { target: i.target, targetId: i.targetId });
    },
  },

  /* ---- cartão ---- */
  close_invoice: {
    preview: async (ctx, i) => {
      const invoice = await cards.getInvoice(ctx, i.invoiceId);
      if (!invoice.canWrite) throw forbidden(t.errors.readOnly);
      if (invoice.closedAt) throw unprocessable(t.errors.invoiceClosed, 'invoice_closed');
      const rows: PreviewRow[] = [
        { label: 'Situação', before: 'Aberta', after: 'Fechada' },
        { label: 'Fechamento', after: formatDate(invoice.closingDate) },
        { label: 'Vencimento', after: formatDate(invoice.dueDate) },
      ];
      for (const payer of invoice.payers) rows.push({ label: `A pagar por ${payer.payerCaixaName}`, after: formatBRL(payer.itemsCents) });
      return {
        title: 'Fechar fatura',
        summary: `${invoice.cardName} · ${invoice.referenceMonth.slice(5, 7)}/${invoice.referenceMonth.slice(0, 4)}`,
        action: 'update',
        rows,
        warnings: invoice.payers.some((p) => !p.canWritePayer)
          ? ['Nas pagadoras em que o usuário não edita, o título fica aguardando aceite.']
          : [],
      };
    },
    run: (ctx, i) => cards.closeInvoice(ctx, i.invoiceId, { payerCategoryIds: i.payerCategoryIds, cardCategoryId: i.cardCategoryId }),
  },
  pay_invoice: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.payerCaixaId);
      const invoice = await cards.getInvoice(ctx, i.invoiceId, i.payerCaixaId);
      const payer = invoice.payers.find((p) => p.payerCaixaId === i.payerCaixaId);
      const account = i.financialAccountId ? await nameOf(ctx, 'account', i.financialAccountId) : 'Conta a definir';
      const rows: PreviewRow[] = [
        { label: 'Pagadora', after: payer?.payerCaixaName ?? ((await nameOf(ctx, 'caixa', i.payerCaixaId)) || '') },
        { label: 'Data', after: formatDate(i.settledOn) },
        { label: 'Conta', after: account },
      ];
      if (i.sourceAccountId) rows.push({ label: 'Paga pela conta', after: (await nameOf(ctx, 'account', i.sourceAccountId)) ?? '' });
      const month = `${invoice.referenceMonth.slice(5, 7)}/${invoice.referenceMonth.slice(0, 4)}`;
      if (!invoice.closedAt) {
        if (i.amountCents <= 0 || !i.financialAccountId)
          throw unprocessable(t.agents.errors.invoiceAdvanceFields, 'invoice_advance_fields');
        if (i.charges.length > 0) throw unprocessable(t.agents.errors.invoiceAdvanceCharges, 'invoice_advance_charges');
        rows.push({ label: 'Pagamento antecipado', after: formatBRL(i.amountCents) });
        return { title: 'Pagar fatura (antecipado)', summary: `${invoice.cardName} · ${month}`, action: 'create', rows };
      }
      const open = payer?.openCents ?? 0;
      if (open <= 0) throw unprocessable(t.errors.invoiceNoOpenBalance, 'invoice_no_open_balance');
      if (i.amountCents > open) throw unprocessable(t.errors.invoicePaymentTooHigh, 'invoice_payment_too_high');
      rows.push({ label: 'Em aberto', after: formatBRL(open) }, { label: 'Pago agora', after: formatBRL(i.amountCents) });
      const warnings: string[] = [];
      if (i.amountCents < open) {
        rows.push({ label: 'Rola para a próxima fatura', after: formatBRL(open - i.amountCents) });
        warnings.push(
          i.amountCents === 0 ? 'Nada é pago: o título da fatura é cancelado e tudo rola.' : 'Pagamento parcial: o restante rola.',
        );
      }
      for (const charge of i.charges)
        rows.push({
          label: `Encargo: ${t.card.chargeKinds[charge.chargeKind] ?? charge.chargeKind}`,
          after: formatBRL(charge.amountCents),
        });
      return { title: 'Pagar fatura', summary: `${invoice.cardName} · ${month}`, action: 'create', rows, warnings };
    },
    run: async (ctx, i) => {
      const invoice = await cards.getInvoice(ctx, i.invoiceId, i.payerCaixaId);
      if (!invoice.closedAt) {
        if (i.amountCents <= 0 || !i.financialAccountId)
          throw unprocessable(t.agents.errors.invoiceAdvanceFields, 'invoice_advance_fields');
        if (i.charges.length > 0) throw unprocessable(t.agents.errors.invoiceAdvanceCharges, 'invoice_advance_charges');
        return cards.advanceInvoice(ctx, i.invoiceId, {
          payerCaixaId: i.payerCaixaId,
          settledOn: i.settledOn,
          amountCents: i.amountCents,
          financialAccountId: i.financialAccountId,
          categoryId: i.categoryId,
          notes: i.notes,
        });
      }
      return cards.payInvoice(ctx, i.invoiceId, {
        payerCaixaId: i.payerCaixaId,
        settledOn: i.settledOn,
        amountCents: i.amountCents,
        financialAccountId: i.financialAccountId ?? null,
        sourceAccountId: i.sourceAccountId,
        charges: i.charges,
        notes: i.notes,
      });
    },
  },
  reopen_invoice: {
    preview: async (ctx, i) => {
      const invoice = await cards.getInvoice(ctx, i.invoiceId);
      if (!invoice.canWrite) throw forbidden(t.errors.readOnly);
      if (!invoice.closedAt) throw unprocessable(t.errors.invoiceNotClosed, 'invoice_open');
      if (invoice.settledCents > 0) throw unprocessable(t.errors.invoiceHasPayments, 'invoice_has_payments');
      return {
        title: 'Reabrir fatura',
        summary: `${invoice.cardName} · ${invoice.referenceMonth.slice(5, 7)}/${invoice.referenceMonth.slice(0, 4)}`,
        action: 'delete',
        rows: [
          { label: 'Situação', before: t.card.invoiceStatuses[invoice.status] ?? invoice.status, after: 'Aberta' },
          { label: 'Títulos da fatura', before: String(invoice.titles.length), after: '—' },
        ],
        warnings: ['Os títulos da fatura nas pagadoras e no cartão são desfeitos; a fatura volta a receber compras.'],
      };
    },
    run: (ctx, i) => cards.reopenInvoice(ctx, i.invoiceId),
  },
  create_card_charge: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.cardId);
      const c = i.charge;
      return {
        title: 'Lançar encargo do cartão',
        summary: `${t.card.chargeKinds[c.chargeKind] ?? c.chargeKind} · ${formatBRL(c.amountCents)}`,
        action: 'create',
        rows: [
          { label: 'Cartão', after: (await nameOf(ctx, 'caixa', i.cardId)) ?? '' },
          { label: 'Tipo', after: t.card.chargeKinds[c.chargeKind] ?? c.chargeKind },
          { label: 'Valor', after: formatBRL(c.amountCents) },
          { label: 'Data', after: formatDate(c.chargedOn) },
          { label: 'Categoria', after: (await nameOf(ctx, 'category', c.categoryId)) ?? '' },
          ...(c.payerCaixaId ? [{ label: 'Caixa pagadora', after: (await nameOf(ctx, 'caixa', c.payerCaixaId)) ?? '' }] : []),
          ...(c.description ? [{ label: 'Descrição', after: c.description }] : []),
        ],
      };
    },
    run: (ctx, i) => cards.createCharge(ctx, i.cardId, i.charge),
  },
  refund_card_purchase: {
    preview: async (ctx, i) => {
      const purchase = await cards.getPurchase(ctx, i.purchaseId);
      if (!purchase.canWrite) throw forbidden(t.errors.readOnly);
      if (purchase.kind === 'refund') throw unprocessable(t.errors.refundOfRefund);
      const left = purchase.amountCents - purchase.refundedCents;
      if (i.refund.amountCents > left) throw unprocessable(t.errors.refundTooHigh);
      return {
        title: 'Estornar compra do cartão',
        summary: `${purchase.description} (${purchase.entityName})`,
        action: 'create',
        rows: [
          { label: 'Compra', after: `${formatBRL(purchase.amountCents)} em ${formatDate(purchase.purchasedOn)}` },
          { label: 'Ainda não estornado', before: formatBRL(left), after: formatBRL(left - i.refund.amountCents) },
          { label: 'Estorno', after: `${formatBRL(i.refund.amountCents)} em ${formatDate(i.refund.refundedOn)}` },
        ],
      };
    },
    run: (ctx, i) => cards.refundPurchase(ctx, i.purchaseId, i.refund),
  },

  /* ---- caixas e contas ---- */
  create_caixa: {
    preview: async (ctx, i) => {
      ctx.access.assertRegistryWrite();
      if (i.kind === 'credit_card' && i.defaultPayerCaixaId) ctx.access.assertRead(i.defaultPayerCaixaId);
      const values = await withNames(ctx, i, { holderEntityId: 'entity', defaultPayerCaixaId: 'caixa' });
      return {
        title: i.kind === 'credit_card' ? 'Criar cartão de crédito' : 'Criar caixa',
        summary: i.name,
        action: 'create',
        rows: diffRows(CAIXA_FIELDS, values),
        warnings: ctx.access.isAdmin ? [] : ['Quem cria vira editor da caixa nova.'],
      };
    },
    run: (ctx, i) => caixas.createCaixa(ctx, i),
  },
  update_caixa: {
    preview: async (ctx, i) => {
      const before = await caixas.getCaixa(ctx, i.caixaId);
      if (!before.canWrite) throw forbidden(t.errors.readOnly);
      const old = await withNames(
        ctx,
        { ...before, ...(before.card ?? {}), creditLimitCents: before.card?.creditLimitCents } as Record<string, unknown>,
        { holderEntityId: 'entity', defaultPayerCaixaId: 'caixa' },
      );
      const after = await withNames(ctx, i.changes as Record<string, unknown>, { holderEntityId: 'entity', defaultPayerCaixaId: 'caixa' });
      return { title: 'Editar caixa', summary: before.name, action: 'update', rows: diffRows(CAIXA_FIELDS, after, old) };
    },
    run: (ctx, i) => caixas.updateCaixa(ctx, i.caixaId, i.changes),
  },
  archive_caixa: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const caixa = await caixas.getCaixa(ctx, i.caixaId);
      if (caixa.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar caixa',
        summary: caixa.name,
        action: 'delete',
        rows: [
          { label: 'Titular', after: caixa.holderName },
          { label: 'Saldo', after: formatBRL(caixa.balanceCents) },
          { label: 'Contas', after: String(caixa.accounts.length) },
        ],
        warnings: ['Sem nenhum lançamento, conta ou fechamento, a caixa é excluída em vez de arquivada.'],
      };
    },
    run: (ctx, i) => caixas.deleteCaixa(ctx, i.caixaId),
  },
  create_account: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.caixaId);
      return {
        title: 'Criar conta financeira',
        summary: `${i.account.name} · ${(await nameOf(ctx, 'caixa', i.caixaId)) ?? ''}`,
        action: 'create',
        rows: diffRows(ACCOUNT_FIELDS, i.account),
      };
    },
    run: (ctx, i) => caixas.createAccount(ctx, i.caixaId, i.account),
  },
  update_account: {
    preview: async (ctx, i) => {
      const before = await writableAccount(ctx, i.accountId);
      return {
        title: 'Editar conta financeira',
        summary: before.name,
        action: 'update',
        rows: diffRows(ACCOUNT_FIELDS, i.changes as Record<string, unknown>, before as unknown as Record<string, unknown>),
      };
    },
    run: (ctx, i) => caixas.updateAccount(ctx, i.accountId, i.changes),
  },
  archive_account: {
    preview: async (ctx, i) => {
      const account = await writableAccount(ctx, i.accountId);
      if (account.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar conta financeira',
        summary: (await nameOf(ctx, 'account', i.accountId)) ?? account.name,
        action: 'delete',
        rows: [{ label: 'Tipo', after: ACCOUNT_KIND(account.kind) }],
        warnings: ['Sem nenhum movimento, a conta é excluída em vez de arquivada.'],
      };
    },
    run: (ctx, i) => caixas.deleteAccount(ctx, i.accountId),
  },
  create_adjustment: {
    preview: async (ctx, i) => {
      await writableAccount(ctx, i.accountId);
      const a = i.adjustment;
      return {
        title: 'Lançar movimento avulso',
        summary: `${a.description} · ${formatBRL(a.amountCents)}`,
        action: 'create',
        rows: [
          { label: 'Conta', after: (await nameOf(ctx, 'account', i.accountId)) ?? '' },
          { label: 'Data', after: formatDate(a.occurredOn) },
          { label: a.amountCents > 0 ? 'Entrada' : 'Saída', after: formatBRL(Math.abs(a.amountCents)) },
          { label: 'Descrição', after: a.description },
          ...(a.categoryId ? [{ label: 'Categoria', after: (await nameOf(ctx, 'category', a.categoryId)) ?? '' }] : []),
          ...(a.entityId ? [{ label: 'Entidade', after: (await nameOf(ctx, 'entity', a.entityId)) ?? '' }] : []),
          ...(a.notes ? [{ label: 'Observações', after: a.notes }] : []),
        ],
      };
    },
    run: (ctx, i) => caixas.addAdjustment(ctx, i.accountId, i.adjustment),
  },
  delete_adjustment: {
    preview: async (ctx, i) => {
      const r = await ctx.db.execute<{
        financial_account_id: string;
        kind: string;
        occurred_on: string;
        amount_cents: number;
        description: string | null;
        entity_id: string | null;
        category_id: string | null;
      }>(sql`
        SELECT financial_account_id, kind, occurred_on, amount_cents, description, entity_id, category_id
          FROM movements WHERE id = ${i.movementId}`);
      const movement = r.rows[0];
      if (movement?.kind !== 'adjustment') throw notFound();
      await writableAccount(ctx, movement.financial_account_id);
      const lines = await ctx.db.execute<{ status: string }>(
        sql`SELECT status FROM statement_lines WHERE movement_id = ${i.movementId} AND status IN ('matched', 'suggested')`,
      );
      if (lines.rows.some((l) => l.status === 'matched')) throw unprocessable(t.errors.movementReconciled, 'movement_reconciled');
      const amount = Number(movement.amount_cents);
      return {
        title: 'Excluir movimento avulso',
        summary: `${movement.description ?? '—'} · ${formatBRL(amount)}`,
        action: 'delete',
        rows: [
          { label: 'Conta', before: (await nameOf(ctx, 'account', movement.financial_account_id)) ?? '', after: '—' },
          { label: 'Data', before: formatDate(movement.occurred_on), after: '—' },
          { label: amount > 0 ? 'Entrada' : 'Saída', before: formatBRL(Math.abs(amount)), after: '—' },
          ...(movement.category_id
            ? [{ label: 'Categoria', before: (await nameOf(ctx, 'category', movement.category_id)) ?? '', after: '—' }]
            : []),
          ...(movement.entity_id
            ? [{ label: 'Entidade', before: (await nameOf(ctx, 'entity', movement.entity_id)) ?? '', after: '—' }]
            : []),
        ],
        warnings: [
          'O movimento sai do extrato e do saldo da conta.',
          ...(lines.rows.length > 0 ? ['A linha do extrato com este movimento sugerido volta a nova.'] : []),
        ],
      };
    },
    run: async (ctx, i) => {
      await caixas.deleteAdjustment(ctx, i.movementId);
      return { deleted: true };
    },
  },

  /* ---- títulos ---- */
  cancel_title: {
    preview: async (ctx, i) => {
      const title = await writableTitle(ctx, i.titleId);
      if (title.status === 'canceled') throw unprocessable(t.agents.errors.titleAlreadyCanceled, 'title_canceled');
      return {
        title: 'Cancelar título',
        summary: titleLabel(title),
        action: 'update',
        rows: [{ label: 'Situação', before: t.title.statuses[title.status] ?? title.status, after: 'Cancelado' }],
        warnings: [
          ...(title.mirror ? [`O espelho em ${title.mirror.caixaName} também é cancelado.`] : []),
          ...(title.settlements.some((s) => !s.reversedAt) ? ['As baixas já feitas continuam (estorne com reverse_settlement).'] : []),
        ],
      };
    },
    run: (ctx, i) => titles.cancelTitle(ctx, i.titleId),
  },
  archive_title: {
    preview: async (ctx, i) => {
      const title = await writableTitle(ctx, i.titleId);
      if (title.cardInvoiceId) throw unprocessable(t.errors.cardInvoiceTitleLocked);
      if (title.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar título',
        summary: titleLabel(title),
        action: 'update',
        rows: [{ label: 'Arquivado', before: 'Não', after: 'Sim' }],
        warnings: title.mirror ? [`O espelho em ${title.mirror.caixaName} também é arquivado.`] : [],
      };
    },
    run: (ctx, i) => titles.archiveTitle(ctx, i.titleId),
  },
  delete_title: {
    preview: async (ctx, i) => {
      const title = await writableTitle(ctx, i.titleId);
      if (title.cardInvoiceId) throw unprocessable(t.errors.cardInvoiceTitleLocked);
      const series = Boolean(title.recurrenceRuleId && title.occurrence);
      const warnings: string[] = [];
      let outcome = 'Excluído';
      if (series && i.scope === 'following') {
        outcome = 'Série encerrada a partir desta ocorrência';
      } else if (series) {
        outcome = 'Arquivado (a ocorrência da série não é recriada)';
      } else if (title.settlements.length > 0) {
        outcome = 'Arquivado (tem baixas)';
      }
      if (title.mirror) warnings.push(`O espelho em ${title.mirror.caixaName} vai junto.`);
      return {
        title: 'Excluir título',
        summary: titleLabel(title),
        action: 'delete',
        rows: [{ label: 'Resultado', before: t.title.statuses[title.status] ?? title.status, after: outcome }],
        warnings,
      };
    },
    run: (ctx, i) => titles.deleteTitle(ctx, i.titleId, i.scope),
  },
  accept_mirror: {
    preview: async (ctx, i) => {
      const title = await writableTitle(ctx, i.titleId);
      if (title.mirrorStatus !== 'pending' && title.mirrorStatus !== 'disputed') throw unprocessable(t.errors.mirrorNotPending);
      return {
        title: 'Aceitar espelho',
        summary: titleLabel(title),
        action: 'update',
        rows: [
          { label: 'Espelho', before: t.title.mirrorStatuses[title.mirrorStatus] ?? title.mirrorStatus, after: 'Aceito' },
          ...(i.categoryId
            ? [{ label: 'Categoria', before: title.categoryName, after: (await nameOf(ctx, 'category', i.categoryId)) ?? '' }]
            : []),
        ],
      };
    },
    run: (ctx, i) => titles.acceptMirror(ctx, i.titleId, { categoryId: i.categoryId }),
  },
  dispute_mirror: {
    preview: async (ctx, i) => {
      const title = await writableTitle(ctx, i.titleId);
      if (title.mirrorStatus === null || title.mirrorStatus === 'disputed') throw unprocessable(t.errors.mirrorNotPending);
      return {
        title: 'Contestar espelho',
        summary: titleLabel(title),
        action: 'update',
        rows: [
          { label: 'Espelho', before: t.title.mirrorStatuses[title.mirrorStatus] ?? title.mirrorStatus, after: 'Contestado' },
          ...(i.reason ? [{ label: 'Motivo', after: i.reason }] : []),
        ],
      };
    },
    run: (ctx, i) => titles.disputeMirror(ctx, i.titleId, { reason: i.reason }),
  },
  delete_transfer: {
    preview: async (ctx, i) => {
      const transfer = await transfers.getTransfer(ctx, i.transferId);
      ctx.access.assertWrite(transfer.fromCaixaId);
      ctx.access.assertWrite(transfer.toCaixaId);
      if (transfer.settlementId) throw unprocessable(t.errors.transferFromSettlement);
      return {
        title: 'Excluir transferência',
        summary: `${transfer.fromAccountName} → ${transfer.toAccountName} · ${formatBRL(transfer.amountCents)}`,
        action: 'delete',
        rows: [
          { label: 'Data', before: formatDate(transfer.transferredOn), after: '—' },
          { label: 'Valor', before: formatBRL(transfer.amountCents), after: '—' },
          ...(transfer.description ? [{ label: 'Descrição', before: transfer.description, after: '—' }] : []),
        ],
        warnings: ['Os dois movimentos saem dos extratos das contas.'],
      };
    },
    run: async (ctx, i) => {
      await transfers.deleteTransfer(ctx, i.transferId);
      return { deleted: true, archived: false };
    },
  },

  /* ---- categorias e regras ---- */
  create_category: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const values = await withNames(ctx, i, { parentId: 'category' });
      return { title: 'Criar categoria', summary: i.name, action: 'create', rows: diffRows(CATEGORY_FIELDS, values) };
    },
    run: (ctx, i) => categories.createCategory(ctx, i),
  },
  update_category: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const before = await categoryRow(ctx, i.categoryId);
      const old = await withNames(ctx, before, { parentId: 'category' });
      const after = await withNames(ctx, i.changes as Record<string, unknown>, { parentId: 'category' });
      return { title: 'Editar categoria', summary: before.name, action: 'update', rows: diffRows(CATEGORY_FIELDS, after, old) };
    },
    run: (ctx, i) => categories.updateCategory(ctx, i.categoryId, i.changes),
  },
  archive_category: {
    preview: async (ctx, i) => {
      ctx.access.assertAdmin();
      const category = await categoryRow(ctx, i.categoryId);
      if (category.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar categoria',
        summary: category.name,
        action: 'delete',
        rows: [{ label: 'Tipo', after: category.kind === 'income' ? 'Receita' : 'Despesa' }],
        warnings: [
          ...(category.parentId === null ? ['Arquivar o grupo arquiva as subcategorias.'] : []),
          'Sem nenhum uso, a categoria é excluída em vez de arquivada.',
        ],
      };
    },
    run: (ctx, i) => categories.deleteCategory(ctx, i.categoryId),
  },
  list_classification_rules: { run: (ctx, i) => rec.listRules(ctx, { caixaId: i.caixaId, archived: i.archived }) },
  create_classification_rule: {
    preview: async (ctx, i) => {
      if (i.caixaId) ctx.access.assertWrite(i.caixaId);
      else ctx.access.assertAdmin();
      const values = await withNames(ctx, i, { caixaId: 'caixa', entityId: 'entity', categoryId: 'category' });
      const rows = diffRows(RULE_FIELDS, values);
      if (!i.caixaId) rows.unshift({ label: 'Alcance', after: 'Global (todas as caixas)' });
      return { title: 'Criar regra de classificação', summary: i.pattern, action: 'create', rows };
    },
    run: (ctx, i) => rec.createRule(ctx, i),
  },
  update_classification_rule: {
    preview: async (ctx, i) => {
      const before = await writableRule(ctx, i.ruleId);
      const map = { caixaId: 'caixa', entityId: 'entity', categoryId: 'category' } as const;
      const rows = diffRows(
        RULE_FIELDS,
        await withNames(ctx, i.changes as Record<string, unknown>, map),
        await withNames(ctx, before, map),
      );
      return { title: 'Editar regra de classificação', summary: before.pattern, action: 'update', rows };
    },
    run: (ctx, i) => rec.updateRule(ctx, i.ruleId, i.changes),
  },
  archive_classification_rule: {
    preview: async (ctx, i) => {
      const rule = await writableRule(ctx, i.ruleId);
      if (rule.archivedAt) throw unprocessable(t.agents.errors.alreadyArchived, 'already_archived');
      return {
        title: 'Arquivar regra de classificação',
        summary: rule.pattern,
        action: 'delete',
        rows: [
          { label: 'Padrão', before: `${MATCH_KIND(rule.matchKind)} "${rule.pattern}"`, after: '—' },
          { label: 'Alcance', after: rule.caixaId ? ((await nameOf(ctx, 'caixa', rule.caixaId)) ?? '') : 'Global' },
        ],
        warnings: ['As linhas já classificadas pela regra guardam o histórico.'],
      };
    },
    run: (ctx, i) => rec.archiveRule(ctx, i.ruleId),
  },
};

/** Categoria do plano (prévias de edição e arquivamento). */
async function categoryRow(ctx: ServiceContext, categoryId: string) {
  const result = await ctx.db.execute<{
    kind: string;
    parent_id: string | null;
    name: string;
    color_slot: number | null;
    icon: string | null;
    archived_at: string | null;
  }>(sql`SELECT kind, parent_id, name, color_slot, icon, archived_at FROM categories WHERE id = ${categoryId}`);
  const row = result.rows[0];
  if (!row) throw notFound();
  return {
    kind: row.kind,
    parentId: row.parent_id,
    name: row.name,
    colorSlot: row.color_slot,
    icon: row.icon,
    archivedAt: row.archived_at,
  };
}

/** Texto do registro que recebe o anexo (prévia do attach_file). */
async function attachTargetLabel(ctx: ServiceContext, target: string, targetId: string): Promise<string> {
  if (target === 'title') return `Título ${titleLabel(await titles.getTitle(ctx, targetId))}`;
  if (target === 'entity') return `Entidade ${(await nameOf(ctx, 'entity', targetId)) ?? targetId}`;
  if (target === 'card_purchase') {
    const purchase = await cards.getPurchase(ctx, targetId);
    return `Compra ${purchase.description} · ${formatBRL(purchase.amountCents)}`;
  }
  if (target === 'settlement') {
    const r = await ctx.db.execute<{ description: string; settled_on: string; amount_cents: number }>(sql`
      SELECT t.description, s.settled_on, s.amount_cents FROM settlements s JOIN titles t ON t.id = s.title_id WHERE s.id = ${targetId}`);
    const row = r.rows[0];
    return row ? `Baixa de ${row.description} · ${formatDate(row.settled_on)} · ${formatBRL(Number(row.amount_cents))}` : targetId;
  }
  const r = await ctx.db.execute<{ description: string | null; occurred_on: string; amount_cents: number }>(
    sql`SELECT description, occurred_on, amount_cents FROM movements WHERE id = ${targetId}`,
  );
  const row = r.rows[0];
  return row ? `Movimento ${row.description ?? '—'} · ${formatDate(row.occurred_on)} · ${formatBRL(Number(row.amount_cents))}` : targetId;
}
