/*
 * Extratos CSV (spec 009): leitura RFC 4180 e aplicação do mapeamento de
 * colunas salvo por conta.
 */
import { isIsoDate } from '../dates';

export type CsvDelimiter = ',' | ';' | '\t' | '|';

/** RFC 4180: aspas, aspas duplicadas, quebras CRLF/LF (também dentro de aspas). Linhas vazias são ignoradas. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
    } else if (src.startsWith(delimiter, i)) {
      row.push(field);
      field = '';
      i += delimiter.length - 1;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
    } else field += c;
    i += 1;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * Escolhe o separador mais consistente nas primeiras linhas (fora de aspas).
 * Linhas de preâmbulo sem o separador (ex.: "Extrato conta…") não contam: vale
 * a contagem mais frequente entre as linhas que o têm.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 30);
  const candidates: CsvDelimiter[] = [';', ',', '\t', '|'];
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const d of candidates) {
    const counts = lines.map((l) => l.replace(/"[^"]*"/g, '').split(d).length - 1).filter((n) => n > 0);
    if (counts.length === 0) continue;
    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    const [mode, consistent] = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    const score = consistent * 1000 + mode;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export type CsvColumnRef = string | number;

export type CsvMapping = {
  hasHeader: boolean;
  skipRows: number;
  dateFormat: string;
  decimalSeparator: ',' | '.';
  columns: {
    date: CsvColumnRef;
    description: CsvColumnRef;
    amount?: CsvColumnRef;
    debit?: CsvColumnRef;
    credit?: CsvColumnRef;
    fitid?: CsvColumnRef;
    balance?: CsvColumnRef;
    document?: CsvColumnRef;
  };
};

export type CsvLine = {
  /** Linha 1-based no arquivo (contando as linhas não vazias). */
  row: number;
  postedOn: string;
  amountCents: number;
  description: string;
  fitid: string | null;
  balanceCents: number | null;
  raw: Record<string, string>;
};

/** Valor em texto → centavos. Aceita R$, milhar, parênteses (negativo) e sufixo D/C (débito negativo). */
export function parseAmount(text: string, decimalSeparator: ',' | '.' = ','): number | null {
  let s = text.trim().replace(/ /g, ' ');
  if (!s) return null;
  let negative = false;
  const suffix = /\s*([DC])$/i.exec(s);
  if (suffix) {
    if (suffix[1]!.toUpperCase() === 'D') negative = true;
    s = s.slice(0, suffix.index).trim();
  }
  if (/^\(.*\)$/.test(s)) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/^R\$/i, '');
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  const thousands = decimalSeparator === ',' ? '.' : ',';
  // Tolerância: "1234.56" num arquivo de vírgula decimal (e vice-versa) é o separador trocado, não milhar.
  if (new RegExp(`^\\d+\\${thousands}\\d{1,2}$`).test(s)) s = s.replace(thousands, decimalSeparator);
  const pattern =
    decimalSeparator === ',' ? /^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$|^,\d{1,2}$/ : /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$|^\.\d{1,2}$/;
  if (!pattern.test(s)) return null;
  const [int = '', frac = ''] = s.split(thousands).join('').split(decimalSeparator);
  const cents = Number(int || '0') * 100 + Number(frac.padEnd(2, '0'));
  return negative && cents !== 0 ? -cents : cents;
}

const DATE_TOKENS: Record<string, string> = { dd: '(\\d{1,2})', MM: '(\\d{1,2})', yyyy: '(\\d{4})', yy: '(\\d{2})' };

/**
 * Data no formato dado (dd/MM/yyyy, dd/MM/yy, yyyy-MM-dd, MM/dd/yyyy, dd-MM-yyyy, dd.MM.yyyy, yyyyMMdd...)
 * → 'YYYY-MM-DD'. Hora depois de espaço (ou 'T') é ignorada.
 */
export function parseDateWithFormat(text: string, format: string): string | null {
  const value = text.trim().split(/[\sT]/)[0] ?? '';
  const order: string[] = [];
  const compact = !/[^a-zA-Z]/.test(format);
  let source = '';
  let rest = format;
  while (rest) {
    const token = ['yyyy', 'yy', 'dd', 'MM'].find((t) => rest.startsWith(t));
    if (token) {
      order.push(token);
      source += compact ? `(\\d{${token.length}})` : DATE_TOKENS[token];
      rest = rest.slice(token.length);
    } else {
      source += rest[0]!.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      rest = rest.slice(1);
    }
  }
  const m = new RegExp(`^${source}$`).exec(value);
  if (!m) return null;
  let year = 0;
  let month = 0;
  let day = 0;
  order.forEach((token, idx) => {
    const n = Number(m[idx + 1]);
    if (token === 'dd') day = n;
    else if (token === 'MM') month = n;
    else if (token === 'yyyy') year = n;
    else year = n + 2000;
  });
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** Normaliza nome de coluna: aparado, minúsculo, sem acentos. */
const normalizeHeader = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function applyCsvMapping(
  rows: string[][],
  mapping: CsvMapping,
): { headers: string[] | null; lines: CsvLine[]; errors: { row: number; message: string }[] } {
  const errors: { row: number; message: string }[] = [];
  const lines: CsvLine[] = [];
  let index = Math.max(0, mapping.skipRows);
  let headers: string[] | null = null;
  if (mapping.hasHeader) {
    headers = (rows[index] ?? []).map((h) => h.trim());
    index += 1;
  }
  const normalizedHeaders = headers?.map(normalizeHeader) ?? null;

  const resolve = (ref: CsvColumnRef | undefined, label: string): number | null => {
    if (ref === undefined || ref === '') return null;
    if (typeof ref === 'number') return ref;
    if (/^\d+$/.test(ref) && !normalizedHeaders) return Number(ref);
    const idx = normalizedHeaders?.indexOf(normalizeHeader(ref)) ?? -1;
    if (idx < 0) throw new Error(`Coluna "${ref}" (${label}) não encontrada no cabeçalho.`);
    return idx;
  };
  const cols = {
    date: resolve(mapping.columns.date, 'data'),
    description: resolve(mapping.columns.description, 'descrição'),
    amount: resolve(mapping.columns.amount, 'valor'),
    debit: resolve(mapping.columns.debit, 'débito'),
    credit: resolve(mapping.columns.credit, 'crédito'),
    fitid: resolve(mapping.columns.fitid, 'identificador'),
    balance: resolve(mapping.columns.balance, 'saldo'),
  };
  if (cols.amount === null && cols.debit === null && cols.credit === null) {
    throw new Error('Mapeie a coluna de valor ou as colunas de débito e crédito.');
  }

  const cell = (r: string[], i: number | null) => (i === null ? '' : (r[i] ?? '').trim());

  for (; index < rows.length; index += 1) {
    const r = rows[index]!;
    const rowNumber = index + 1;
    const raw: Record<string, string> = {};
    r.forEach((v, i) => {
      raw[headers?.[i] || String(i)] = v;
    });

    const postedOn = parseDateWithFormat(cell(r, cols.date), mapping.dateFormat);
    if (!postedOn) {
      errors.push({ row: rowNumber, message: `data inválida: "${cell(r, cols.date)}"` });
      continue;
    }

    let amountCents: number | null;
    if (cols.amount !== null) {
      amountCents = parseAmount(cell(r, cols.amount), mapping.decimalSeparator);
    } else {
      const debitText = cell(r, cols.debit);
      const creditText = cell(r, cols.credit);
      const debit = debitText ? parseAmount(debitText, mapping.decimalSeparator) : 0;
      const credit = creditText ? parseAmount(creditText, mapping.decimalSeparator) : 0;
      amountCents = debit === null || credit === null || (!debitText && !creditText) ? null : credit - Math.abs(debit);
    }
    if (amountCents === null) {
      errors.push({ row: rowNumber, message: 'valor inválido' });
      continue;
    }
    if (amountCents === 0) {
      errors.push({ row: rowNumber, message: 'valor zero' });
      continue;
    }

    const balanceText = cell(r, cols.balance);
    lines.push({
      row: rowNumber,
      postedOn,
      amountCents,
      description: cell(r, cols.description).replace(/\s+/g, ' '),
      fitid: cell(r, cols.fitid) || null,
      balanceCents: balanceText ? parseAmount(balanceText, mapping.decimalSeparator) : null,
      raw,
    });
  }
  return { headers, lines, errors };
}
