import { formatDate } from './dates';

/*
 * Exportação de relatórios e listagens (spec 014). Uma tabela neutra
 * (ExportTable) vira CSV aqui e PDF no front (jsPDF, carregado sob demanda).
 *
 * CSV no padrão do Excel pt-BR: separador ';', fim de linha CRLF, UTF-8 com
 * BOM (o arquivo; toCsv devolve o texto sem BOM), dinheiro como '1234,56'
 * (sem milhar, vírgula decimal), datas 'dd/mm/aaaa'. Texto que começa com
 * = + - @ (ou tab/CR) ganha um apóstrofo na frente, contra injeção de fórmula.
 */

export type ExportColumnType = 'text' | 'money' | 'date' | 'int' | 'percent';

export type ExportColumn = { key: string; label: string; type?: ExportColumnType };

export type ExportCell = string | number | null | undefined;

export type ExportTable = {
  /** Nome do arquivo sem extensão. */
  fileName: string;
  title: string;
  /** Filtros e período, uma linha cada (cabeçalho do PDF). */
  subtitle?: string[];
  columns: ExportColumn[];
  rows: Record<string, ExportCell>[];
  /** Linhas de destaque (ex.: totais), desenhadas em negrito no PDF. */
  boldRows?: number[];
  /**
   * Linhas antes do cabeçalho do CSV (ex.: o filtro de entidades de um
   * relatório, spec 014); no PDF elas entram no subtítulo.
   */
  preamble?: string[];
};

export const CSV_BOM = '\uFEFF';

/** Centavos → '1234,56' (sinal só no negativo). */
export function centsToCsv(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${negative ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Formata a célula conforme o tipo da coluna (para CSV e PDF; no PDF, dinheiro no formato contábil). */
export function formatCell(value: ExportCell, type: ExportColumnType = 'text', target: 'csv' | 'display' = 'csv'): string {
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'money': {
      const cents = Number(value);
      if (!Number.isFinite(cents)) return '';
      if (target === 'csv') return centsToCsv(cents);
      const text = centsToCsv(Math.abs(cents)).replace(/\B(?=(\d{3})+(?!\d),)/g, '.');
      return cents < 0 ? `(R$ ${text})` : `R$ ${text}`;
    }
    case 'date':
      return formatDate(String(value));
    case 'int':
      return String(Math.trunc(Number(value)));
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? `${n.toFixed(1).replace('.', ',')}%` : '';
    }
    default:
      return String(value);
  }
}

const NEEDS_QUOTES = /[";\r\n]|^\s|\s$/;
const FORMULA = /^[=+\-@\t\r]/;

/** Uma célula CSV: aspas quando preciso (aspas internas dobradas) e proteção contra fórmula em texto. */
export function csvField(text: string, isText: boolean): string {
  let value = text;
  if (isText && FORMULA.test(value)) value = `'${value}`;
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A tabela como CSV (sem BOM; some CSV_BOM ao gravar o arquivo). */
export function toCsv(table: Pick<ExportTable, 'columns' | 'rows' | 'preamble'>): string {
  const pre = (table.preamble ?? []).map((line) => csvField(line, true));
  const head = table.columns.map((c) => csvField(c.label, true)).join(';');
  const body = table.rows.map((row) =>
    table.columns.map((c) => csvField(formatCell(row[c.key], c.type, 'csv'), (c.type ?? 'text') === 'text')).join(';'),
  );
  return `${[...pre, head, ...body].join('\r\n')}\r\n`;
}

/** Nome de arquivo seguro: sem acento, minúsculo, com hífens. */
export function exportFileName(...parts: string[]): string {
  return parts
    .join('-')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
