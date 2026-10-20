import { formatBRL, formatDate, type PreviewRow, type SUPERSEDE_TOOLS, type SupersedeResult, t } from '@moneyflow/shared';
import { sql } from 'drizzle-orm';
import { unprocessable } from '../errors';
import * as supersede from '../services/statement-supersede';
import { assertNotSuperseded, getImport } from '../services/statements';
import type { Handlers } from './tool-helpers';

/*
 * Tools do lote provisório e da troca pelo consolidado (spec 031, categoria
 * Conciliação), sobre o serviço (o Access decide: escrita na caixa da conta).
 * A prévia da troca é a própria operação com dryRun.
 */

type SupersedeToolName = (typeof SUPERSEDE_TOOLS)[number]['name'];

/** As contagens do resultado da troca, para a prévia (também a do import_statement). */
export function supersedeRows(result: SupersedeResult): PreviewRow[] {
  const S = t.statements.supersede;
  return [
    { label: S.transferred, after: String(result.transferred.length) },
    { label: S.paired, after: String(result.paired.length) },
    { label: S.dropped, after: String(result.dropped.length) },
    { label: S.pending, after: String(result.pending.length) },
    { label: S.consolidatedLeftover, after: String(result.consolidatedLeftover.length) },
  ];
}

const lineLabel = (l: { postedOn: string; amountCents: number; description: string }) =>
  `${formatDate(l.postedOn)} · ${formatBRL(l.amountCents)} · ${l.description}`;

export const SUPERSEDE_HANDLERS: Handlers<SupersedeToolName> = {
  set_statement_import_provisional: {
    preview: async (ctx, i) => {
      const lot = await getImport(ctx, i.importId, false);
      ctx.access.assertWrite(lot.caixaId);
      assertNotSuperseded(lot);
      if (!lot.financialAccountId) throw unprocessable(t.errors.statementProvisionalAccountOnly, 'statement_provisional_account_only');
      return {
        title: i.provisional ? 'Marcar lote como provisório' : 'Desmarcar lote provisório',
        summary: lot.fileName,
        action: 'update',
        rows: [
          { label: 'Conta', after: lot.accountName ?? '' },
          { label: 'Período', after: `${formatDate(lot.periodStart)} a ${formatDate(lot.periodEnd)}` },
          { label: 'Provisório', before: lot.provisional ? 'Sim' : 'Não', after: i.provisional ? 'Sim' : 'Não' },
        ],
      };
    },
    run: async (ctx, i) => {
      const { lines: _lines, ...lot } = await supersede.setProvisional(ctx, i.importId, i.provisional);
      return lot;
    },
  },
  supersede_statement_import: {
    preview: async (ctx, i) => {
      const lot = await getImport(ctx, i.importId, false);
      const result = await supersede.supersedeImports(ctx, i.importId, { provisionalImportIds: i.provisionalImportIds, dryRun: true });
      const names = await ctx.db.execute<{ file_name: string }>(sql`
        SELECT f.file_name FROM statement_imports s JOIN attachments f ON f.id = s.attachment_id
         WHERE s.id = ANY (${`{${result.provisionalImportIds.join(',')}}`}::uuid[]) ORDER BY s.period_start`);
      return {
        title: 'Substituir o provisório pelo consolidado',
        summary: lot.fileName,
        action: 'update',
        rows: [
          { label: 'Consolidado', after: lot.fileName },
          { label: 'Provisório(s)', after: names.rows.map((r) => r.file_name).join(', ') },
          ...supersedeRows(result),
        ],
        warnings: result.pending.length
          ? [t.statements.supersede.pendingWarning(result.pending.length), ...result.pending.slice(0, 10).map(lineLabel)]
          : [],
      };
    },
    run: (ctx, i) => supersede.supersedeImports(ctx, i.importId, { provisionalImportIds: i.provisionalImportIds }),
  },
  resolve_superseded_lines: {
    preview: async (ctx, i) => {
      const lot = await getImport(ctx, i.importId, false);
      ctx.access.assertWrite(lot.caixaId);
      const lines = await supersede.listSupersededLines(ctx, i.importId, 'pending');
      const byId = new Map(lines.map((l) => [l.id, l]));
      const S = t.statements.supersede;
      const rows: PreviewRow[] = i.items.map((item) => {
        const line = byId.get(item.lineId);
        const label = line ? lineLabel(line) : item.lineId;
        const entry = line?.target ? `${line.target.description}${line.target.entityName ? ` (${line.target.entityName})` : ''}` : null;
        return { label, before: entry, after: S.actions[item.action] ?? item.action };
      });
      const deletes = i.items.filter((item) => item.action === 'delete_entry').length;
      return {
        title: 'Decidir as sobras do provisório',
        summary: lot.fileName,
        action: deletes ? 'delete' : 'update',
        rows,
        warnings: deletes ? [S.deleteWarning(deletes)] : [],
      };
    },
    run: (ctx, i) => supersede.resolveSupersededLines(ctx, i.importId, i.items),
  },
};
