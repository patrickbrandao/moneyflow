import {
  buildCategoryTree,
  type CategoryReportData,
  type CategoryRow,
  type CategoryTree,
  type ExportTable,
  exportFileName,
  formatAccounting,
  formatMonth,
  rankCategories,
  t,
} from '@moneyflow/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { CategoryLabel, negClass } from '../domain';
import { Badge, cx, EmptyState, Panel } from '../ui';
import { RankBars, type Series, StackedBars } from './charts';

/** Quantos grupos o gráfico mostra em separado (o resto vira "Outras"). */
const CHART_GROUPS = 7;

export const pct = (value: number | null) =>
  value === null
    ? '—'
    : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100)
        .toFixed(1)
        .replace('.', ',')}%`;

function chartSeries(tree: CategoryTree): Series[] {
  const top = tree.rows
    .slice(0, CHART_GROUPS)
    .map((r) => ({ key: r.key, label: r.name ?? t.reports.noCategory, colorSlot: r.colorSlot, values: r.byMonth }));
  const rest = tree.rows.slice(CHART_GROUPS);
  if (rest.length > 0) {
    top.push({
      key: 'rest',
      label: t.flow.otherGroup,
      colorSlot: null,
      values: tree.months.map((_, i) => rest.reduce((acc, r) => acc + (r.byMonth[i] ?? 0), 0)),
    });
  }
  return top;
}

/** Despesa ou receita por categoria: gráfico mês a mês, ranking e a árvore grupo → subcategoria. */
export function CategoryReport({ data, kind, scope }: { data: CategoryReportData; kind: 'income' | 'expense'; scope: string | null }) {
  const tree = useMemo(() => buildCategoryTree(data.lines, data.months, kind, { caixaId: scope }), [data, kind, scope]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allOpen = tree.rows.length > 0 && tree.rows.every((r) => open.has(r.key));

  if (tree.rows.length === 0) return <EmptyState title={t.reports.empty} description={t.reports.basisHint[data.basis]} />;

  const ranking = rankCategories(tree, 10);
  return (
    <div className="grid gap-4">
      <div className="report-grid">
        <Panel title={t.reports.months}>
          <StackedBars months={tree.months} series={chartSeries(tree)} label={t.reports.months} />
        </Panel>
        <Panel title={t.reports.ranking}>
          <p className="panel-hint">{t.reports.rankingSub}</p>
          <RankBars
            rows={ranking.map((r) => ({
              key: r.key,
              label: r.name ?? t.reports.noCategory,
              sub: r.groupName && r.groupName !== r.name ? r.groupName : null,
              colorSlot: r.colorSlot,
              value: r.total,
              share: r.share,
            }))}
          />
        </Panel>
      </div>

      <div className="table-wrap report-table">
        <table className="data">
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  className="row-action"
                  onClick={() => setOpen(allOpen ? new Set() : new Set(tree.rows.map((r) => r.key)))}
                  title={allOpen ? t.reports.collapseAll : t.reports.expandAll}
                  aria-label={allOpen ? t.reports.collapseAll : t.reports.expandAll}
                >
                  {allOpen ? <ChevronDown /> : <ChevronRight />}
                </button>{' '}
                {t.reports.category}
              </th>
              {tree.months.map((m) => (
                <th key={m} className="num">
                  {formatMonth(m)}
                </th>
              ))}
              <th className="num">{t.reports.total}</th>
              <th className="num" title={t.reports.variationHint}>
                {t.reports.variation}
              </th>
              <th className="num">{t.reports.share}</th>
            </tr>
          </thead>
          <tbody>
            {tree.rows.map((group) => (
              <Fragment key={group.key}>
                <Row row={group} level={0} open={open.has(group.key)} onToggle={() => toggle(group.key)} kind={kind} />
                {open.has(group.key) && group.children.map((child) => <Row key={child.key} row={child} level={1} kind={kind} />)}
              </Fragment>
            ))}
            <tr className="report-total">
              <td>{t.reports.totalLine}</td>
              {tree.byMonth.map((v, i) => (
                <td key={tree.months[i]} className={cx('num money', negClass(v))}>
                  {formatAccounting(v)}
                </td>
              ))}
              <td className={cx('num money', negClass(tree.total))}>{formatAccounting(tree.total)}</td>
              <td className="num">
                <Variation value={tree.variation} kind={kind} />
              </td>
              <td className="num">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Variação: em despesa, subir é ruim (vermelho); em receita, bom. */
function Variation({ value, kind }: { value: number | null; kind: 'income' | 'expense' }) {
  if (value === null) return <span className="text-faint">—</span>;
  const good = kind === 'income' ? value > 0 : value < 0;
  return <span className={cx('money', value === 0 ? '' : good ? 'in' : 'out')}>{pct(value)}</span>;
}

function Row({
  row,
  level,
  open,
  onToggle,
  kind,
}: {
  row: CategoryRow;
  level: 0 | 1;
  open?: boolean;
  onToggle?: () => void;
  kind: 'income' | 'expense';
}) {
  return (
    <tr className={cx(level === 0 ? 'report-group' : 'report-child', onToggle && 'cursor-pointer')} onClick={onToggle}>
      <td>
        <span className="inline-flex items-center gap-1" style={{ paddingLeft: level * 22 }}>
          {onToggle && <span className="report-caret">{open ? <ChevronDown /> : <ChevronRight />}</span>}
          <CategoryLabel name={row.name ?? t.reports.noCategory} slot={row.colorSlot} />
          {level === 0 && row.children.length > 1 && <Badge tone="outline">{row.children.length}</Badge>}
        </span>
      </td>
      {row.byMonth.map((v, i) => (
        <td key={i} className={cx('num money', v === 0 && 'muted', negClass(v))}>
          {v === 0 ? '—' : formatAccounting(v)}
        </td>
      ))}
      <td className={cx('num money', negClass(row.total))}>{formatAccounting(row.total)}</td>
      <td className="num">
        <Variation value={row.variation} kind={kind} />
      </td>
      <td className="num">{(row.share * 100).toFixed(1).replace('.', ',')}%</td>
    </tr>
  );
}

/** A árvore como tabela de exportação (grupos em negrito, subcategorias recuadas). */
export function categoryExport(
  data: CategoryReportData,
  kind: 'income' | 'expense',
  scope: string | null,
  subtitle: string[],
): ExportTable {
  const tree = buildCategoryTree(data.lines, data.months, kind, { caixaId: scope });
  const rows: ExportTable['rows'] = [];
  const bold: number[] = [];
  const line = (r: CategoryRow, name: string) => ({
    category: name,
    ...Object.fromEntries(tree.months.map((m, i) => [m, r.byMonth[i] ?? 0])),
    total: r.total,
    variation: r.variation === null ? null : r.variation * 100,
    share: r.share * 100,
  });
  for (const group of tree.rows) {
    bold.push(rows.length);
    rows.push(line(group, group.name ?? t.reports.noCategory));
    for (const child of group.children) rows.push(line(child, `   ${child.name ?? t.reports.noCategory}`));
  }
  bold.push(rows.length);
  rows.push({
    category: t.reports.totalLine,
    ...Object.fromEntries(tree.months.map((m, i) => [m, tree.byMonth[i] ?? 0])),
    total: tree.total,
    variation: tree.variation === null ? null : tree.variation * 100,
    share: 100,
  });
  const title = `${kind === 'expense' ? t.reports.expense : t.reports.income} ${t.reports.tabs.categories!.toLowerCase()}`;
  return {
    fileName: exportFileName(title, data.from, data.to),
    title,
    subtitle,
    columns: [
      { key: 'category', label: t.reports.category },
      ...tree.months.map((m) => ({ key: m, label: formatMonth(m), type: 'money' as const })),
      { key: 'total', label: t.reports.total, type: 'money' },
      { key: 'variation', label: t.reports.variation, type: 'percent' },
      { key: 'share', label: t.reports.share, type: 'percent' },
    ],
    rows,
    boldRows: bold,
  };
}
