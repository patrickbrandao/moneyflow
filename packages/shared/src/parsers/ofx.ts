/*
 * Extratos OFX (spec 009): OFX 1.x (SGML, tags sem fechamento) e 2.x (XML),
 * de conta corrente (STMTRS) e de cartão de crédito (CCSTMTRS). Um arquivo
 * pode trazer vários extratos (o Santander manda conta corrente e poupança
 * juntas): cada um tem conta, saldo, período e transações próprios.
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
  branchId: string | null;
  accountId: string | null;
  /** ACCTTYPE do BANKACCTFROM (CHECKING, SAVINGS, MONEYMRKT, CREDITLINE); null no cartão. */
  accountType: string | null;
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

/** Os extratos do arquivo (STMTRS e CCSTMTRS) na ordem em que aparecem. */
function statementNodes(tree: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      if (child.name === 'STMTRS' || child.name === 'CCSTMTRS') out.push(child);
      else walk(child);
    }
  };
  walk(tree);
  return out;
}

function readTransactions(trnNodes: XmlNode[]): OfxTransaction[] {
  return trnNodes.map((node, index) => {
    const postedOn = parseOfxDate(leafText(node, 'DTPOSTED')) ?? parseOfxDate(leafText(node, 'DTUSER'));
    const amountCents = parseOfxAmount(leafText(node, 'TRNAMT'));
    if (!postedOn) throw new Error(`Transação ${index + 1} do OFX sem data válida (DTPOSTED).`);
    if (amountCents === null) throw new Error(`Transação ${index + 1} do OFX sem valor válido (TRNAMT).`);
    const name = leafText(node, 'NAME') ?? leafText(node, 'PAYEE');
    const memo = leafText(node, 'MEMO');
    return {
      fitid: leafText(node, 'FITID'),
      postedOn,
      amountCents,
      type: leafText(node, 'TRNTYPE'),
      name,
      memo,
      checkNum: leafText(node, 'CHECKNUM'),
      description: combineDescription(name, memo),
    };
  });
}

/**
 * Lê um extrato. As transações vêm só do BANKTRANLIST dele (nunca de outro
 * extrato do mesmo arquivo); sem STMTRS/CCSTMTRS, o arquivo inteiro vale como um.
 */
function readStatement(stmt: XmlNode, kind: OfxStatement['kind']): OfxStatement {
  const tranList = findFirst(stmt, 'BANKTRANLIST');
  const account = findFirst(stmt, kind === 'creditcard' ? 'CCACCTFROM' : 'BANKACCTFROM') ?? findFirst(stmt, 'BANKACCTFROM');
  const ledger = findFirst(stmt, 'LEDGERBAL');
  const ledgerAmount = parseOfxAmount(leafText(ledger, 'BALAMT'));
  const ledgerDate = parseOfxDate(leafText(ledger, 'DTASOF'));
  return {
    kind,
    bankId: leafText(account, 'BANKID'),
    branchId: leafText(account, 'BRANCHID'),
    accountId: leafText(account, 'ACCTID'),
    accountType: kind === 'bank' ? (leafText(account, 'ACCTTYPE')?.toUpperCase() ?? null) : null,
    currency: leafText(stmt, 'CURDEF'),
    periodStart: parseOfxDate(leafText(tranList, 'DTSTART')),
    periodEnd: parseOfxDate(leafText(tranList, 'DTEND')),
    ledgerBalance: ledgerAmount !== null && ledgerDate ? { amountCents: ledgerAmount, date: ledgerDate } : null,
    transactions: readTransactions(findAll(tranList ?? stmt, 'STMTTRN')),
  };
}

/** Todos os extratos do arquivo, cada um com as suas transações (spec 009). */
export function parseOfxStatements(text: string): OfxStatement[] {
  const start = text.search(/<OFX[\s>]/i);
  if (start < 0) throw new Error('Arquivo OFX inválido: não encontrei a tag <OFX>.');
  const tree = parseOfxTree(text.slice(start));

  const nodes = statementNodes(tree);
  const hasTransactions = (node: XmlNode) =>
    node.name === 'CCSTMTRS' || !!findFirst(node, 'BANKTRANLIST') || findAll(node, 'STMTTRN').length > 0;
  if (!(nodes.length ? nodes : [tree]).some(hasTransactions)) {
    throw new Error('Arquivo OFX sem transações (faltam STMTTRN e BANKTRANLIST).');
  }
  if (!nodes.length) return [readStatement(tree, 'bank')];
  return nodes.map((node) => readStatement(node, node.name === 'CCSTMTRS' ? 'creditcard' : 'bank'));
}

/** O extrato principal do arquivo: o primeiro de cartão, senão o primeiro. Arquivos com várias contas: veja `pickOfxStatement`. */
export function parseOfx(text: string): OfxStatement {
  const statements = parseOfxStatements(text);
  return statements.find((st) => st.kind === 'creditcard') ?? statements[0]!;
}

/** A conta de destino da importação, para escolher o extrato num arquivo com várias contas. */
export type OfxTargetAccount = {
  kind: 'checking' | 'savings' | 'creditcard';
  bankCode?: string | null;
  branch?: string | null;
  accountNumber?: string | null;
};

const digits = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '').replace(/^0+/, '');

/** Número igual, com ou sem o dígito verificador, ou um contido no fim do outro (agência na frente). */
function sameNumber(a: string, b: string): boolean {
  const variants = (x: string) => [x, x.slice(0, -1)].filter((v) => v.length >= 4);
  return variants(a).some((x) =>
    variants(b).some((y) => x === y || (Math.min(x.length, y.length) >= 5 && (x.endsWith(y) || y.endsWith(x)))),
  );
}

/** O extrato é da conta: o número casa e banco e agência, quando os dois lados trazem, não contradizem. */
export function ofxStatementMatches(st: OfxStatement, target: OfxTargetAccount): boolean {
  const own = digits(target.accountNumber);
  const file = digits(st.accountId);
  if (!own || !file || !sameNumber(own, file)) return false;
  if (st.bankId && target.bankCode && digits(st.bankId) !== digits(target.bankCode)) return false;
  const ownBranch = digits(target.branch);
  const fileBranch = digits(st.branchId);
  if (ownBranch && fileBranch && !ownBranch.startsWith(fileBranch) && !fileBranch.startsWith(ownBranch)) return false;
  return true;
}

const SAVINGS_TYPES = new Set(['SAVINGS']);

export type OfxStatementPick = {
  /** Índice do extrato a importar, ou null quando o usuário precisa escolher. */
  index: number | null;
  /** Palpite pelo tipo de conta (ACCTTYPE), para pré-selecionar na escolha. */
  suggested: number | null;
};

/**
 * Escolhe o extrato de um arquivo com várias contas (spec 009): só os do tipo
 * do destino (banco ou cartão); entre eles, o único cuja conta casa com a de
 * destino (banco/agência/conta). Sem um único casamento, devolve null e o
 * palpite pelo tipo (corrente × poupança), e quem importa pergunta ao usuário.
 */
export function pickOfxStatement(statements: OfxStatement[], target: OfxTargetAccount): OfxStatementPick {
  if (statements.length === 1) return { index: 0, suggested: 0 };
  const wanted = target.kind === 'creditcard' ? 'creditcard' : 'bank';
  const sameKind = statements.flatMap((st, i) => (st.kind === wanted ? [i] : []));
  const candidates = sameKind.length ? sameKind : statements.map((_, i) => i);
  if (candidates.length === 1) return { index: candidates[0]!, suggested: candidates[0]! };
  const matching = candidates.filter((i) => ofxStatementMatches(statements[i]!, target));
  if (matching.length === 1) return { index: matching[0]!, suggested: matching[0]! };
  const byType = (matching.length ? matching : candidates).filter(
    (i) => target.kind !== 'creditcard' && SAVINGS_TYPES.has(statements[i]!.accountType ?? '') === (target.kind === 'savings'),
  );
  return { index: null, suggested: byType.length === 1 ? byType[0]! : null };
}
