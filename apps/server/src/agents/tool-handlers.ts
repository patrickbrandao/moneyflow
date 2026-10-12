import {
  type AgentToolInput,
  type AgentToolName,
  diffRows,
  formatDate,
  type PreviewField,
  type PreviewRow,
  type ToolPreview,
  t,
  todayIso,
} from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../context';
import { forbidden, notFound, unprocessable } from '../errors';
import * as caixas from '../services/caixas';
import { calendarItems } from '../services/calendar';
import * as cards from '../services/cards';
import { categoryTree } from '../services/categories';
import * as entities from '../services/entities';
import { flowGraph } from '../services/flow';
import { emitAgentEvent } from '../services/message-worker';
import { listDestinations, sendAgentMessage } from '../services/messages';
import { search } from '../services/overview';
import * as rec from '../services/reconciliation';
import * as reports from '../services/reports';
import { createSettlement } from '../services/settlements';
import { accountStatement } from '../services/statement';
import * as statements from '../services/statements';
import * as titles from '../services/titles';
import * as transfers from '../services/transfers';
import { semanticSearch } from './search';

/*
 * Execução das tools internas (definidas em @moneyflow/shared, AGENT_TOOLS)
 * reaproveitando os serviços e a autorização da API: o ctx é o do usuário que
 * acionou o agente (actorKind agent + agentRunId; no /mcp, sem execução).
 * Escritas têm `preview`: o diff legível do cartão "Aplicar?", calculado
 * antes de executar (também valida a permissão, para não pedir confirmação
 * de algo que vai falhar).
 */

export type ToolCallMeta = { toolUseId: string; runId: string | null };

type Handler<N extends AgentToolName> = {
  run: (ctx: ServiceContext, input: AgentToolInput<N>, meta: ToolCallMeta) => Promise<unknown>;
  preview?: (ctx: ServiceContext, input: AgentToolInput<N>) => Promise<ToolPreview>;
};

type Handlers = { [N in AgentToolName]: Handler<N> };

/* ---------------- nomes para as prévias (respeitando a permissão) ---------------- */

async function nameOf(ctx: ServiceContext, kind: 'entity' | 'caixa' | 'category' | 'account', id: string | null | undefined) {
  if (!id) return null;
  if (kind === 'entity') {
    const r = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM entities WHERE id = ${id}`);
    return r.rows[0]?.name ?? id;
  }
  if (kind === 'category') {
    const r = await ctx.db.execute<{ name: string; kind: string }>(sql`SELECT name, kind FROM categories WHERE id = ${id}`);
    return r.rows[0]?.name ?? id;
  }
  if (kind === 'caixa') {
    if (!ctx.access.canRead(id)) return id;
    const r = await ctx.db.execute<{ name: string }>(sql`SELECT name FROM caixas WHERE id = ${id}`);
    return r.rows[0]?.name ?? id;
  }
  const r = await ctx.db.execute<{ name: string; caixa_id: string; caixa_name: string }>(
    sql`SELECT a.name, a.caixa_id, c.name AS caixa_name FROM financial_accounts a JOIN caixas c ON c.id = a.caixa_id WHERE a.id = ${id}`,
  );
  const row = r.rows[0];
  if (!row || !ctx.access.canRead(row.caixa_id)) return id;
  return `${row.name} (${row.caixa_name})`;
}

const named = (ctx: ServiceContext, kind: 'entity' | 'caixa' | 'category' | 'account') => async (value: unknown) =>
  (await nameOf(ctx, kind, value as string)) ?? '';

/** Troca ids por nomes antes do diff (os campos de nome viram texto). */
async function withNames(
  ctx: ServiceContext,
  values: Record<string, unknown>,
  map: Record<string, 'entity' | 'caixa' | 'category' | 'account'>,
) {
  const out = { ...values };
  for (const [key, kind] of Object.entries(map)) {
    if (out[key] !== undefined && out[key] !== null) out[key] = await named(ctx, kind)(out[key]);
  }
  return out;
}

const DIRECTION_LABEL = (v: unknown) => (v === 'payable' ? 'A pagar' : v === 'receivable' ? 'A receber' : String(v));

const TITLE_FIELDS: PreviewField[] = [
  { key: 'caixaId', label: 'Caixa' },
  { key: 'direction', label: 'Tipo', format: DIRECTION_LABEL },
  { key: 'entityId', label: 'Entidade' },
  { key: 'categoryId', label: 'Categoria' },
  { key: 'description', label: 'Descrição' },
  { key: 'competenceDate', label: 'Competência', format: 'date' },
  { key: 'dueDate', label: 'Vencimento', format: 'date' },
  { key: 'amountCents', label: 'Valor', format: 'money' },
  { key: 'notes', label: 'Observações' },
];

const ENTITY_FIELDS: PreviewField[] = [
  { key: 'kind', label: 'Tipo', format: (v) => (v === 'company' ? 'Empresa' : 'Pessoa') },
  { key: 'name', label: 'Nome' },
  { key: 'tradeName', label: 'Nome fantasia' },
  { key: 'document', label: 'Documento' },
  { key: 'birthDate', label: 'Nascimento', format: 'date' },
  { key: 'notes', label: 'Observações' },
];

async function lineCaixa(ctx: ServiceContext, lineId: string) {
  const r = await ctx.db.execute<{ caixa_id: string; description: string; amount_cents: number; posted_on: string }>(sql`
    SELECT coalesce(a.caixa_id, l.card_caixa_id) AS caixa_id, l.description, l.amount_cents, l.posted_on
      FROM statement_lines l LEFT JOIN financial_accounts a ON a.id = l.financial_account_id WHERE l.id = ${lineId}`);
  const row = r.rows[0];
  if (!row) throw notFound();
  ctx.access.assertWrite(row.caixa_id);
  return row;
}

const lineLabel = (l: { description: string; amount_cents: number; posted_on: string }) =>
  `${l.posted_on} · ${l.description} · ${(l.amount_cents / 100).toFixed(2).replace('.', ',')}`;

/* ---------------- handlers ---------------- */

export const TOOL_HANDLERS: Handlers = {
  search_records: { run: (ctx, i) => search(ctx, i.query, i.limit) },
  semantic_search: { run: (ctx, i) => semanticSearch(ctx, i.query, i.types ?? null, i.limit) },
  list_caixas: { run: (ctx, i) => caixas.listCaixas(ctx, { archived: i.archived }) },
  get_caixa: { run: (ctx, i) => caixas.getCaixa(ctx, i.caixaId) },
  list_accounts: { run: (ctx, i) => caixas.listAccounts(ctx, { caixaId: i.caixaId }) },
  get_account_statement: { run: (ctx, i) => accountStatement(ctx, i.accountId, { from: i.from, to: i.to }) },
  list_entities: { run: (ctx, i) => entities.listEntities(ctx, { q: i.q, kind: i.kind, archived: false, limit: i.limit }) },
  get_entity: { run: (ctx, i) => entities.getEntity(ctx, i.entityId) },
  list_categories: { run: (ctx, i) => categoryTree(ctx, { kind: i.kind }) },
  list_titles: {
    run: (ctx, i) =>
      titles.listTitles(ctx, {
        caixaId: i.caixaId,
        direction: i.direction,
        status: i.status,
        from: i.from,
        to: i.to,
        q: i.q,
        entityId: i.entityId,
        archived: false,
        limit: i.limit,
      }),
  },
  get_title: { run: (ctx, i) => titles.getTitle(ctx, i.titleId) },
  list_transfers: { run: (ctx, i) => transfers.listTransfers(ctx, { caixaId: i.caixaId, from: i.from, to: i.to, limit: i.limit }) },
  get_card: { run: (ctx, i) => cards.cardOverview(ctx, i.cardId) },
  get_invoice: { run: (ctx, i) => cards.getInvoice(ctx, i.invoiceId) },
  list_card_purchases: { run: (ctx, i) => cards.listPurchases(ctx, i.cardId, { from: i.from, to: i.to, q: i.q, limit: i.limit }) },
  calendar: { run: (ctx, i) => calendarItems(ctx, { from: i.from, to: i.to, caixaIds: i.caixaIds ?? [] }) },
  report_categories: {
    run: (ctx, i) => reports.categoryReport(ctx, { from: i.from, to: i.to, basis: i.basis, caixaIds: i.caixaIds ?? [] }),
  },
  report_entities: {
    run: (ctx, i) => reports.entityReport(ctx, { from: i.from, to: i.to, basis: i.basis, caixaIds: i.caixaIds ?? [] }),
  },
  report_projection: {
    run: (ctx, i) => reports.projectionReport(ctx, { caixaIds: i.caixaIds ?? [], horizons: i.horizons ?? [30, 60, 90] }),
  },
  flow_graph: { run: (ctx, i) => flowGraph(ctx, { from: i.from, to: i.to, caixaIds: i.caixaIds ?? [] }) },
  list_statement_imports: { run: (ctx, i) => statements.listImports(ctx, { accountId: i.accountId, cardCaixaId: i.cardCaixaId }) },
  get_statement_import: { run: (ctx, i) => statements.getImport(ctx, i.importId) },
  list_message_destinations: {
    run: async (ctx) =>
      (await listDestinations(ctx))
        .filter((d) => d.isActive && !d.archivedAt)
        .map((d) => ({ id: d.id, name: d.name, ownerKind: d.ownerKind, canManage: d.canManage })),
  },

  /* ---------------- escrita ---------------- */
  create_entity: {
    preview: async (ctx, i) => {
      ctx.access.assertRegistryWrite();
      return { title: 'Criar entidade', summary: i.name, action: 'create', rows: diffRows(ENTITY_FIELDS, i) };
    },
    run: (ctx, i) => entities.createEntity(ctx, i),
  },
  update_entity: {
    preview: async (ctx, i) => {
      ctx.access.assertRegistryWrite();
      const before = await entities.getEntity(ctx, i.entityId);
      return {
        title: 'Editar entidade',
        summary: before.name,
        action: 'update',
        rows: diffRows(ENTITY_FIELDS, i.changes as Record<string, unknown>, before as unknown as Record<string, unknown>),
      };
    },
    run: (ctx, i) => entities.updateEntity(ctx, i.entityId, i.changes),
  },
  add_pix_key: {
    preview: async (ctx, i) => {
      ctx.access.assertRegistryWrite();
      const entity = await nameOf(ctx, 'entity', i.entityId);
      return {
        title: 'Adicionar chave PIX',
        summary: entity ?? '',
        action: 'create',
        rows: diffRows(
          [
            { key: 'keyType', label: 'Tipo da chave' },
            { key: 'keyValue', label: 'Chave' },
            { key: 'label', label: 'Rótulo' },
            { key: 'isPrimary', label: 'Principal', format: 'bool' },
          ],
          i.pixKey,
        ),
      };
    },
    run: (ctx, i) => entities.addPixKey(ctx, i.entityId, i.pixKey),
  },
  create_title: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.caixaId);
      const values = await withNames(ctx, i, { caixaId: 'caixa', entityId: 'entity', categoryId: 'category' });
      const rows = diffRows(TITLE_FIELDS, values);
      const warnings: string[] = [];
      if (i.series?.kind === 'installments') {
        rows.push({ label: 'Parcelas', after: `${i.series.count}× de ${(i.amountCents / 100).toFixed(2).replace('.', ',')}` });
      } else if (i.series?.kind === 'recurrence') {
        rows.push({ label: 'Recorrência', after: `${i.series.frequency}${i.series.endsOn ? ` até ${i.series.endsOn}` : ''}` });
      }
      if (i.mirrorCaixaId === null) rows.push({ label: 'Espelho', after: 'Sem espelho' });
      else if (i.mirrorCaixaId) rows.push({ label: 'Espelho em', after: (await nameOf(ctx, 'caixa', i.mirrorCaixaId)) ?? '' });
      else warnings.push('Se a entidade tiver uma caixa principal, o título é espelhado nela.');
      return {
        title: i.direction === 'payable' ? 'Criar conta a pagar' : 'Criar conta a receber',
        summary: `${i.description} · ${(i.amountCents / 100).toFixed(2).replace('.', ',')}`,
        action: 'create',
        rows,
        warnings,
      };
    },
    run: (ctx, i) => titles.createTitle(ctx, i),
  },
  update_title: {
    preview: async (ctx, i) => {
      const before = await titles.getTitle(ctx, i.titleId);
      if (!before.canWrite) throw forbidden(t.errors.readOnly);
      const after = await withNames(ctx, i.changes as Record<string, unknown>, { entityId: 'entity', categoryId: 'category' });
      const old = await withNames(ctx, before as unknown as Record<string, unknown>, { entityId: 'entity', categoryId: 'category' });
      return { title: 'Editar título', summary: before.description, action: 'update', rows: diffRows(TITLE_FIELDS, after, old) };
    },
    run: (ctx, i) => titles.updateTitle(ctx, i.titleId, i.changes),
  },
  end_series: {
    preview: async (ctx, i) => {
      const title = await titles.getTitle(ctx, i.titleId);
      const plan = await titles.previewSeriesEnd(ctx, i.titleId, i.endsOn);
      if (plan.blocked.length > 0) {
        const list = plan.blocked.map((o) => `#${o.occurrence} ${formatDate(o.dueDate)}`).join(', ');
        throw unprocessable(t.errors.seriesEndBlocked(list), 'series_end_blocked');
      }
      const listed = (items: typeof plan.toCancel) => items.map((o) => `#${o.occurrence} ${formatDate(o.dueDate)}`).join(', ') || null;
      const rows: PreviewRow[] = [
        {
          label: 'Termina em',
          before: plan.currentEndsOn ? formatDate(plan.currentEndsOn) : 'Sem fim',
          after: plan.endsOn ? formatDate(plan.endsOn) : 'Sem fim',
        },
      ];
      if (plan.toCancel.length) rows.push({ label: 'Canceladas', after: listed(plan.toCancel) });
      if (plan.toReopen.length) rows.push({ label: 'Reabertas', after: listed(plan.toReopen) });
      return {
        title: 'Encerrar série',
        summary: `${title.description} (${title.entityName})`,
        action: plan.toCancel.length ? 'delete' : 'update',
        rows,
        warnings: title.mirrorTitleId && plan.toCancel.length ? ['O espelho de cada ocorrência também é cancelado.'] : [],
      };
    },
    run: (ctx, i) => titles.endSeries(ctx, i.titleId, i.endsOn),
  },
  settle_title: {
    preview: async (ctx, i) => {
      const title = await titles.getTitle(ctx, i.titleId);
      if (!title.canWrite) throw forbidden(t.errors.readOnly);
      const s = i.settlement;
      const values = await withNames(ctx, s as unknown as Record<string, unknown>, {
        financialAccountId: 'account',
        sourceAccountId: 'account',
        mirrorAccountId: 'account',
      });
      return {
        title: title.direction === 'payable' ? 'Registrar pagamento' : 'Registrar recebimento',
        summary: `${title.description} (${title.entityName})`,
        action: 'create',
        rows: [
          { label: 'Em aberto', after: (title.openCents / 100).toFixed(2).replace('.', ',') },
          ...diffRows(
            [
              { key: 'settledOn', label: 'Data', format: 'date' },
              { key: 'amountCents', label: 'Valor', format: 'money' },
              { key: 'interestCents', label: 'Juros', format: 'money' },
              { key: 'fineCents', label: 'Multa', format: 'money' },
              { key: 'discountCents', label: 'Desconto', format: 'money' },
              { key: 'financialAccountId', label: 'Conta' },
              { key: 'sourceAccountId', label: 'Paga pela conta' },
              { key: 'mirrorAccountId', label: 'Conta do espelho' },
              { key: 'notes', label: 'Observações' },
            ],
            values,
          ).filter((row) => row.after !== 'R$ 0,00'),
        ],
        warnings: s.financialAccountId === null ? ['Sem conta: a baixa fica com "conta a definir".'] : [],
      };
    },
    run: (ctx, i) => createSettlement(ctx, i.titleId, i.settlement),
  },
  create_transfer: {
    preview: async (ctx, i) => {
      const from = await caixas.getAccount(ctx, i.fromAccountId);
      ctx.access.assertWrite(from.caixaId);
      await caixas.getAccount(ctx, i.toAccountId);
      const values = await withNames(ctx, i, { fromAccountId: 'account', toAccountId: 'account' });
      return {
        title: 'Criar transferência',
        summary: `${values.fromAccountId} → ${values.toAccountId}`,
        action: 'create',
        rows: diffRows(
          [
            { key: 'fromAccountId', label: 'De' },
            { key: 'toAccountId', label: 'Para' },
            { key: 'amountCents', label: 'Valor', format: 'money' },
            { key: 'transferredOn', label: 'Data', format: 'date' },
            { key: 'description', label: 'Descrição' },
          ],
          values,
        ),
      };
    },
    run: (ctx, i) => transfers.createTransfer(ctx, i),
  },
  create_card_purchase: {
    preview: async (ctx, i) => {
      ctx.access.assertWrite(i.cardId);
      const p = i.purchase;
      const values = await withNames(ctx, { ...p, cardId: i.cardId } as Record<string, unknown>, {
        cardId: 'caixa',
        entityId: 'entity',
        categoryId: 'category',
        payerCaixaId: 'caixa',
      });
      return {
        title: 'Lançar compra no cartão',
        summary: `${p.description} · ${(p.amountCents / 100).toFixed(2).replace('.', ',')}`,
        action: 'create',
        rows: diffRows(
          [
            { key: 'cardId', label: 'Cartão' },
            { key: 'entityId', label: 'Recebedor' },
            { key: 'categoryId', label: 'Categoria' },
            { key: 'payerCaixaId', label: 'Caixa pagadora' },
            { key: 'purchasedOn', label: 'Data da compra', format: 'date' },
            { key: 'description', label: 'Descrição' },
            { key: 'amountCents', label: 'Valor total', format: 'money' },
            { key: 'installmentsTotal', label: 'Parcelas' },
          ],
          values,
        ),
      };
    },
    run: (ctx, i) => cards.createPurchase(ctx, i.cardId, i.purchase),
  },
  match_statement_line: {
    preview: async (ctx, i) => {
      const line = await lineCaixa(ctx, i.lineId);
      const target = i.titleId
        ? `título ${i.titleId}`
        : i.movementId
          ? `movimento ${i.movementId}`
          : `item de fatura ${i.cardInvoiceItemId}`;
      return {
        title: 'Conciliar linha do extrato',
        summary: lineLabel(line),
        action: 'update',
        rows: [{ label: 'Casar com', after: target }],
      };
    },
    run: (ctx, i) => rec.matchLine(ctx, i.lineId, { movementId: i.movementId, titleId: i.titleId, cardInvoiceItemId: i.cardInvoiceItemId }),
  },
  confirm_statement_lines: {
    preview: async (ctx, i) => {
      const rows = [];
      for (const lineId of i.lineIds.slice(0, 50)) rows.push({ label: 'Linha', after: lineLabel(await lineCaixa(ctx, lineId)) });
      return { title: 'Confirmar conciliações sugeridas', summary: `${i.lineIds.length} linha(s)`, action: 'update', rows };
    },
    run: (ctx, i) => rec.confirmLines(ctx, i.lineIds),
  },
  create_from_statement_line: {
    preview: async (ctx, i) => {
      const line = await lineCaixa(ctx, i.lineId);
      const values = await withNames(ctx, i as Record<string, unknown>, { entityId: 'entity', categoryId: 'category' });
      const modes: Record<string, string> = { adjustment: 'Movimento avulso', title: 'Título já baixado', purchase: 'Compra no cartão' };
      return {
        title: 'Lançar a partir da linha do extrato',
        summary: lineLabel(line),
        action: 'create',
        rows: diffRows(
          [
            { key: 'mode', label: 'Lançamento', format: (v) => modes[String(v)] ?? String(v) },
            { key: 'entityId', label: 'Entidade' },
            { key: 'categoryId', label: 'Categoria' },
            { key: 'description', label: 'Descrição' },
            { key: 'learnRule', label: 'Aprender regra', format: 'bool' },
          ],
          values,
        ),
      };
    },
    run: (ctx, i) =>
      rec.createFromLine(ctx, i.lineId, {
        mode: i.mode,
        entityId: i.entityId ?? null,
        categoryId: i.categoryId ?? null,
        description: i.description ?? null,
        payerCaixaId: null,
        learnRule: i.learnRule,
      }),
  },
  classify_statement_lines: {
    preview: async (ctx, i) => {
      const rows = [];
      for (const s of i.suggestions.slice(0, 50)) {
        const line = await lineCaixa(ctx, s.lineId);
        const names = [await nameOf(ctx, 'entity', s.entityId), await nameOf(ctx, 'category', s.categoryId)].filter(Boolean).join(' · ');
        rows.push({ label: lineLabel(line), after: names || '—' });
      }
      return {
        title: 'Sugerir classificação',
        summary: `${i.suggestions.length} linha(s), pendentes de aprovação`,
        action: 'update',
        rows,
      };
    },
    run: (ctx, i) => rec.suggestClassifications(ctx, i.suggestions),
  },
  apply_classification_suggestions: {
    preview: async (ctx, i) => {
      const rows = [];
      for (const lineId of i.lineIds.slice(0, 50)) rows.push({ label: 'Linha', after: lineLabel(await lineCaixa(ctx, lineId)) });
      return {
        title: i.decision === 'approve' ? 'Aprovar sugestões de classificação' : 'Descartar sugestões de classificação',
        summary: `${i.lineIds.length} linha(s)`,
        action: 'update',
        rows,
      };
    },
    run: (ctx, i) => rec.decideSuggestions(ctx, i.lineIds, i.decision),
  },
  send_telegram_message: {
    preview: async (ctx, i) => {
      const destination = (await listDestinations(ctx)).find((d) => d.id === i.destinationId);
      if (!destination) throw notFound();
      if (!destination.canManage) throw forbidden();
      return { title: 'Enviar mensagem', summary: destination.name, action: 'send', rows: [{ label: 'Texto', after: i.text }] };
    },
    run: (ctx, i, meta) => sendAgentMessage(ctx, i.destinationId, i.text, `agent_tool:${meta.runId ?? 'mcp'}:${meta.toolUseId}`),
  },
  notify_user: {
    run: async (ctx, i, meta) => {
      const link = i.link?.startsWith('/') ? i.link : null;
      const result = await emitAgentEvent(ctx.db, {
        kind: 'agent_message',
        userId: ctx.access.actor.id,
        agentRunId: meta.runId ?? `mcp-${meta.toolUseId}`,
        title: i.title,
        text: i.text,
        link,
        config: ctx.config,
      });
      return { notified: true, queued: result.queued, date: todayIso() };
    },
  },
};
