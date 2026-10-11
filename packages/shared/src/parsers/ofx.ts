/*
 * Extratos OFX (spec 009): OFX 1.x (SGML, tags sem fechamento) e 2.x (XML),
 * de conta corrente (STMTRS) e de cartão de crédito (CCSTMTRS).
 */
import { isIsoDate } from '../dates';
import { decodeXmlEntities, findAll, findFirst, type XmlNode } from './xml';

export type OfxTransaction = {
  fitid: string | null;
  /** 'YYYY-MM-DD'. */
  postedOn: string;
  /** Assinado como no arquivo (débito negativo). */
  amountCents: number;
  type: string | null;
  name: string | null;
  memo: string | null;
  checkNum: string | null;
  /** NAME e MEMO combinados sem repetição, espaços colapsados. */
  description: string;
};

export type OfxStatement = {
  kind: 'bank' | 'creditcard';
  bankId: string | null;
  accountId: string | null;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  ledgerBalance: { amountCents: number; date: string } | null;
  transactions: OfxTransaction[];
};

function tryDecoder(label: string, bytes: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodifica um arquivo de extrato (OFX, CSV, XML). Com BOM UTF-8 usa UTF-8.
 * Senão, se os bytes forem UTF-8 válido, usa UTF-8 (há bancos que declaram
 * CHARSET:1252 e mandam UTF-8); caso contrário usa o charset declarado no
 * cabeçalho OFX 1.x (CHARSET/ENCODING) ou no XML (encoding=), e por fim windows-1252.
 */
export function decodeStatementFile(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  const utf8 = tryDecoder('utf-8', bytes, true);
  if (utf8 !== null) return utf8;

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  let label = 'windows-1252';
  const xmlEncoding = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  const charset = /^\s*CHARSET\s*:\s*([^\s<]+)/im.exec(head);
  if (xmlEncoding) label = xmlEncoding[1]!;
  else if (charset && /^\d+$/.test(charset[1]!)) label = `windows-${charset[1]}`;
  else if (charset && !/^none$/i.test(charset[1]!)) label = charset[1]!;
  if (/^utf-?8$/i.test(label)) label = 'windows-1252';
  return tryDecoder(label, bytes, false) ?? new TextDecoder('windows-1252').decode(bytes);
}

/**
 * Árvore a partir do corpo OFX (SGML ou XML). Uma tag seguida de texto é
 * folha (fechada implicitamente); uma tag seguida de outra tag é agregado,
 * fechado pelo </TAG> correspondente.
 */
function parseOfxTree(body: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<([^>]*)>([^<]*)/g;
  for (const m of body.matchAll(re)) {
    const tag = m[1]!.trim();
    const text = m[2]!;
    if (!tag || tag.startsWith('?') || tag.startsWith('!')) continue;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim().toUpperCase();
      const idx = stack.map((n) => n.name).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const name = (selfClosing ? tag.slice(0, -1) : tag).split(/\s/)[0]!.toUpperCase();
    const node: XmlNode = { name, attrs: {}, children: [], text: '' };
    stack[stack.length - 1]!.children.push(node);
    if (text.trim()) node.text = decodeXmlEntities(text.trim());
    else if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Data OFX 'YYYYMMDD[HHMMSS[.XXX]][[-3:BRT]]' → 'YYYY-MM-DD' (ou null). */
export function parseOfxDate(value: string | null | undefined): string | null {
  const m = /^\s*(\d{4})(\d{2})(\d{2})/.exec(value ?? '');
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) ? iso : null;
}

/** Valor OFX ('-10.50', '-10,50', '+1234.5') → centavos (ou null). */
export function parseOfxAmount(value: string | null | undefined): number | null {
  let s = (value ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Object.is(cents, -0) ? 0 : cents;
}

const collapse = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Combina NAME e MEMO sem repetir o que um já contém do outro. */
function combineDescription(name: string | null, memo: string | null): string {
  const a = collapse(name);
  const b = collapse(memo);
  if (!a) return b;
  if (!b) return a;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la.includes(lb)) return a;
  if (lb.includes(la)) return b;
  return `${a} ${b}`;
}

const leafText = (node: XmlNode | null | undefined, name: string): string | null => {
  const value = findFirst(node, name)?.text.trim();
  return value ? value : null;
};

export function parseOfx(text: string): OfxStatement {
  const start = text.search(/<OFX[\s>]/i);
  if (start < 0) throw new Error('Arquivo OFX inválido: não encontrei a tag <OFX>.');
  const tree = parseOfxTree(text.slice(start));

  const ccStmt = findFirst(tree, 'CCSTMTRS');
  const bankStmt = findFirst(tree, 'STMTRS');
  const stmt = ccStmt ?? bankStmt;
  const tranList = findFirst(tree, 'BANKTRANLIST');
  const trnNodes = findAll(tree, 'STMTTRN');
  if (!trnNodes.length && !tranList && !ccStmt) {
    throw new Error('Arquivo OFX sem transações (faltam STMTTRN e BANKTRANLIST).');
  }

  const account = findFirst(stmt ?? tree, ccStmt ? 'CCACCTFROM' : 'BANKACCTFROM') ?? findFirst(tree, 'BANKACCTFROM');
  const ledger = findFirst(stmt ?? tree, 'LEDGERBAL');
  const ledgerAmount = parseOfxAmount(leafText(ledger, 'BALAMT'));
  const ledgerDate = parseOfxDate(leafText(ledger, 'DTASOF'));

  const transactions: OfxTransaction[] = [];
  for (const [index, node] of trnNodes.entries()) {
    const postedOn = parseOfxDate(leafText(node, 'DTPOSTED')) ?? parseOfxDate(leafText(node, 'DTUSER'));
    const amountCents = parseOfxAmount(leafText(node, 'TRNAMT'));
    if (!postedOn) throw new Error(`Transação ${index + 1} do OFX sem data válida (DTPOSTED).`);
    if (amountCents === null) throw new Error(`Transação ${index + 1} do OFX sem valor válido (TRNAMT).`);
    const name = leafText(node, 'NAME') ?? leafText(node, 'PAYEE');
    const memo = leafText(node, 'MEMO');
    transactions.push({
      fitid: leafText(node, 'FITID'),
      postedOn,
      amountCents,
      type: leafText(node, 'TRNTYPE'),
      name,
      memo,
      checkNum: leafText(node, 'CHECKNUM'),
      description: combineDescription(name, memo),
    });
  }

  return {
    kind: ccStmt ? 'creditcard' : 'bank',
    bankId: leafText(account, 'BANKID'),
    accountId: leafText(account, 'ACCTID'),
    currency: leafText(stmt ?? tree, 'CURDEF'),
    periodStart: parseOfxDate(leafText(tranList, 'DTSTART')),
    periodEnd: parseOfxDate(leafText(tranList, 'DTEND')),
    ledgerBalance: ledgerAmount !== null && ledgerDate ? { amountCents: ledgerAmount, date: ledgerDate } : null,
    transactions,
  };
}
