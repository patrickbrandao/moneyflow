import type { CategoryTotalLine, EntityTotalLine } from './types';

/*
 * Montagem dos relatórios a partir das linhas do banco (spec 014): árvore
 * grupo → subcategoria mês a mês, variação, ranking e totais por entidade.
 * Puro, usado pela tela e pela exportação.
 *
 * Escopo: `caixaId` = só as linhas daquela caixa (inclusive as internas, que
 * são despesa/receita reais dela); null = consolidado das caixas pedidas,
 * descartando as linhas is_internal (o que só circula entre elas).
 */

export type ReportScope = { caixaId: string | null };

const inScope = <T extends { caixaId: string; isInternal: boolean }>(line: T, scope: ReportScope) =>
  scope.caixaId === null ? !line.isInternal : line.caixaId === scope.caixaId;

export type CategoryRow = {
  key: string;
  categoryId: string | null;
  name: string | null;
  colorSlot: number | null;
  byMonth: number[];
  total: number;
  /** Variação do último mês contra o anterior (fração; null sem base). */
  variation: number | null;
  /** Fração do total do tipo. */
  share: number;
  children: CategoryRow[];
};

export type CategoryTree = { months: string[]; rows: CategoryRow[]; byMonth: number[]; total: number; variation: number | null };

/** Variação relativa de `prev` para `last` (null quando prev = 0). */
export function variation(prev: number, last: number): number | null {
  if (prev === 0) return null;
  return (last - prev) / Math.abs(prev);
}

const lastVariation = (byMonth: number[]) =>
  byMonth.length < 2 ? null : variation(byMonth[byMonth.length - 2]!, byMonth[byMonth.length - 1]!);

export function buildCategoryTree(
  lines: CategoryTotalLine[],
  months: string[],
  kind: 'income' | 'expense',
  scope: ReportScope,
): CategoryTree {
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const groups = new Map<string, CategoryRow & { childMap: Map<string, CategoryRow> }>();
  const empty = () => months.map(() => 0);

  for (const line of lines) {
    if (line.kind !== kind || !inScope(line, scope)) continue;
    const index = monthIndex.get(line.month);
    if (index === undefined) continue;
    const groupKey = line.groupCategoryId ?? 'none';
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        categoryId: line.groupCategoryId,
        name: line.groupName,
        colorSlot: line.groupColorSlot,
        byMonth: empty(),
        total: 0,
        variation: null,
        share: 0,
        children: [],
        childMap: new Map(),
      };
      groups.set(groupKey, group);
    }
    group.byMonth[index]! += line.amountCents;
    group.total += line.amountCents;
    const childKey = line.categoryId ?? 'none';
    // A própria categoria-grupo usada direto vira a linha "(o grupo)" entre as filhas.
    let child = group.childMap.get(childKey);
    if (!child) {
      child = {
        key: `${groupKey}:${childKey}`,
        categoryId: line.categoryId,
        name: line.categoryName,
        colorSlot: line.colorSlot ?? line.groupColorSlot,
        byMonth: empty(),
        total: 0,
        variation: null,
        share: 0,
        children: [],
      };
      group.childMap.set(childKey, child);
    }
    child.byMonth[index]! += line.amountCents;
    child.total += line.amountCents;
  }

  const byMonth = empty();
  let total = 0;
  for (const group of groups.values()) {
    group.byMonth.forEach((value, i) => {
      byMonth[i]! += value;
    });
    total += group.total;
  }
  const rows: CategoryRow[] = [...groups.values()]
    .map(({ childMap, ...group }) => ({
      ...group,
      variation: lastVariation(group.byMonth),
      share: total ? group.total / total : 0,
      children: [...childMap.values()]
        .map((child) => ({ ...child, variation: lastVariation(child.byMonth), share: total ? child.total / total : 0 }))
        .sort((a, b) => b.total - a.total || (a.name ?? '').localeCompare(b.name ?? '')),
    }))
    .sort((a, b) => b.total - a.total || (a.name ?? '').localeCompare(b.name ?? ''));
  return { months, rows, byMonth, total, variation: lastVariation(byMonth) };
}

/** Ranking: subcategorias (folhas) de maior total no período. */
export function rankCategories(tree: CategoryTree, limit = 10): (CategoryRow & { groupName: string | null })[] {
  return tree.rows
    .flatMap((group) => group.children.map((child) => ({ ...child, groupName: group.name })))
    .filter((row) => row.total !== 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** Meses ('YYYY-MM-01') de `from` a `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 200) break;
  }
  return out;
}

export type EntityTrail = {
  caixaId: string;
  caixaName: string;
  cardCaixaId: string | null;
  cardName: string | null;
  source: EntityTotalLine['source'];
  outflowCents: number;
  inflowCents: number;
  entries: number;
};

export type EntityRow = {
  entityId: string;
  entityName: string;
  outflowCents: number;
  inflowCents: number;
  netCents: number;
  entries: number;
  trail: EntityTrail[];
};

/** Totais por entidade com o rastreio (caixa pagadora → cartão → recebedor final). */
export function buildEntityRows(lines: EntityTotalLine[], scope: ReportScope): EntityRow[] {
  const rows = new Map<string, EntityRow>();
  for (const line of lines) {
    if (!inScope(line, scope)) continue;
    let row = rows.get(line.entityId);
    if (!row) {
      row = { entityId: line.entityId, entityName: line.entityName, outflowCents: 0, inflowCents: 0, netCents: 0, entries: 0, trail: [] };
      rows.set(line.entityId, row);
    }
    row.outflowCents += line.outflowCents;
    row.inflowCents += line.inflowCents;
    row.netCents = row.inflowCents - row.outflowCents;
    row.entries += line.entries;
    const trail = row.trail.find((x) => x.caixaId === line.caixaId && x.cardCaixaId === line.cardCaixaId && x.source === line.source);
    if (trail) {
      trail.outflowCents += line.outflowCents;
      trail.inflowCents += line.inflowCents;
      trail.entries += line.entries;
    } else {
      row.trail.push({
        caixaId: line.caixaId,
        caixaName: line.caixaName,
        cardCaixaId: line.cardCaixaId,
        cardName: line.cardName,
        source: line.source,
        outflowCents: line.outflowCents,
        inflowCents: line.inflowCents,
        entries: line.entries,
      });
    }
  }
  for (const row of rows.values()) row.trail.sort((a, b) => b.outflowCents + b.inflowCents - (a.outflowCents + a.inflowCents));
  return [...rows.values()].sort(
    (a, b) => b.outflowCents + b.inflowCents - (a.outflowCents + a.inflowCents) || a.entityName.localeCompare(b.entityName),
  );
}
